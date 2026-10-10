"""Rendert die Workspace-Vorlagen und die Gateway-Konfiguration aus `fyos.yaml`.

Aufruf:
    python3 -m fyos_agent.render --config fyos.yaml --ziel /pfad/ziel [--vorlagen WURZEL]
                                 [--zustand ZUSTANDSVERZEICHNIS [--konfig-bleibt]]

Ergebnis im Zielordner:
    workspace/AGENTS.md  SOUL.md  IDENTITY.md  USER.md  (und BOOTSTRAP.md, solange die Ersteinrichtung offen ist)
    openclaw.json5

Mit --zustand (das Zustandsverzeichnis von OpenClaw, im Bild ~/.openclaw) entscheidet der Renderer, ob die
Ersteinrichtung als Gespräch offen ist, und schreibt die Workspace-Dateien dorthin (siehe einrichtung.py).
Ohne --zustand bleibt es beim Rendern in den Zielordner.

Vorlagensprache (bewusst klein, nur Standardbibliothek + PyYAML):
    {{pfad.zum.wert}}          Wert einsetzen; Listen werden zu "- punkt"-Zeilen
    {{pfad|Vorgabetext}}       Vorgabe, wenn der Wert fehlt oder leer ist
    {{env.NAME}}               Umgebungsvariable (fehlt sie, bricht das Rendern ab)
    {{env.NAME|vorgabe}}       Umgebungsvariable mit Vorgabe
    {{json pfad}}              Wert als JSON (fuer die Konfiguration)
    {{#if pfad}}..{{/if}}      Block nur bei wahrem Wert; {{#unless pfad}}..{{/unless}} umgekehrt
    {{#each pfad}}..{{/each}}  Block je Listenelement; darin {{.}} fuer das Element

Unbekannte Pfade ohne Vorgabe sind ein Fehler: lieber laut scheitern als leer rendern.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlsplit

import yaml

from . import einrichtung, json5lite

WURZEL = Path(__file__).resolve().parent.parent

WORKSPACE_DATEIEN = ("AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md")

# Verhaltens-Plugins im Bild unter /opt/fyos/<id> (siehe openclaw/Dockerfile).
PLUGIN_IDS = ("fyos-prioritaet", "fyos-freigabe-chat", "fyos-meldebudget",
              "fyos-kontext-edit", "fyos-speed-router", "fyos-bruecke", "fyos-ersteinrichtung")

# Zusaetzliche Verhaltens-Plugins ohne Fork: jeder Unterordner mit openclaw.plugin.json wird geladen.
ZUSATZ_UMGEBUNG = "FYOS_AGENT_PLUGINS"
ZUSATZ_VORGABE = "/opt/fyos-extra"
#: Öffentliche Adresse der Installation, dieselbe wie für Hub und Shell; Vorgabe für gateway.oeffentliche_url
OEFFENTLICH_UMGEBUNG = "FYOS_OEFFENTLICH_URL"
_STANDARD_PORTS = {"http": 80, "https": 443}
#: gateway.publicOrigin nimmt OpenClaw nur als https an, http nur für diese Hosts (sonst scheitert der Start)
_HTTP_LOOPBACK = {"localhost", "127.0.0.1", "::1"}
_PLUGIN_ID = re.compile(r"[a-z0-9][a-z0-9-]{1,62}")
#: Telegram: Bot-Token von BotFather und numerische Telegram-ID des Besitzers kommen nur aus der Umgebung
#: (Namen wie bei Matrix: OPENCLAW_MATRIX_TOKEN, FYOS_APPROVER_MATRIX_ID)
TELEGRAM_TOKEN_UMGEBUNG = "OPENCLAW_TELEGRAM_TOKEN"
TELEGRAM_BESITZER_UMGEBUNG = "FYOS_APPROVER_TELEGRAM_ID"
_TELEGRAM_TOKEN = re.compile(r"\d+:[A-Za-z0-9_-]+")
#: Nutzer-IDs sind positive Zahlen; Gruppen und Kanäle haben negative IDs und kommen nicht in Frage.
_TELEGRAM_ID = re.compile(r"[1-9]\d{0,15}")

VORGABEN: dict[str, Any] = {
    "agent": {
        "id": "main",
        "name": "Fy",
        "wesen": "ruhig, präzise, direkt und zugewandt",
        "rolle": "Persönlicher Agent für FYOS",
    },
    "besitzer": {"name": "Besitzer", "matrix_id": ""},
    "sprache": "Deutsch",
    "sprache_code": "de",
    "zeitzone": "Europe/Berlin",
    "grenzen": {
        "schwer": [
            "Neue Fähigkeit oder spürbar anderes Verhalten des Agenten",
            "Löschen und nicht umkehrbare Datenänderungen",
            "Geld, Zahlungen, neue Konten bei Fremddiensten",
            "Systemeinstellungen, Netz, Firewall, Anmeldungs-Richtlinien",
            "Anmeldedaten, Tokens, Schlüssel",
            "Kernel, Treiber, Firmware, Major-Updates",
            "Etwas veröffentlichen",
            "Neue Hardware",
            "Privatsphäre-relevante Änderungen (z. B. Kameras auf Personen)",
        ],
    },
    # ersteinrichtung: beim allerersten Start interviewt der Agent den Besitzer (siehe einrichtung.py)
    "faehigkeiten": {"vorgaenge": False, "shell": False, "browser": False, "ersteinrichtung": True},
    "meldebudget": {"tagesbudget": 5, "ruhe_von": "22:00", "ruhe_bis": "07:00",
                    "antwort_fenster_minuten": 10, "buendel_minuten": 5},
    "modell": {"kontext": 131072, "max_tokens": 16384, "denken": False, "bilder": False,
               "zeitlimit_s": 900},
    "kanaele": {"matrix": False, "telegram": False},
    "gateway": {"oeffentliche_url": "", "erlaubte_urspruenge": [],
                "vertrauenswuerdige_proxys": ["127.0.0.1/32"]},
    "kontext_edit": {"aktiv": False},
    "tempo_router": {"aktiv": False, "ziel_modell": "", "max_zeichen": 240},
    "prioritaet": {"agenten": ["main"]},
    # Kopplung an den Hub (fyos-bruecke; leere hub_url = FYOS_HUB_URL ohne /mcp) und das Workboard als
    # gemeinsame Arbeitsliste (fyos-os: docs/KOPPLUNG-OPENCLAW.md)
    "kopplung": {"aktiv": True, "hub_url": "", "workboard": True},
    # Einstellungen fuer Zusatz-Plugins, je Plugin-ID: {aktiv, rechte: {gespraech, prompt}, config}
    "zusatz_plugins": {},
}


class RenderFehler(Exception):
    pass


def tief_mischen(basis: Mapping[str, Any], oben: Mapping[str, Any]) -> dict[str, Any]:
    aus = copy.deepcopy(dict(basis))
    for k, v in (oben or {}).items():
        if isinstance(v, Mapping) and isinstance(aus.get(k), Mapping):
            aus[k] = tief_mischen(aus[k], v)
        else:
            aus[k] = copy.deepcopy(v)
    return aus


def zusatz_plugins(ordner: Path, einstellungen: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Findet Zusatz-Plugins unter `ordner` und baut ihre Eintraege fuer `plugins.entries`.

    Ohne Einstellung ist ein gefundenes Plugin an, aber ohne Einblick ins Gespraech und ohne Prompt-Recht.
    Beides muss der Betreiber in fyos.yaml ausdruecklich geben (zusatz_plugins.<id>.rechte).
    """
    if not ordner.is_dir():
        return []
    gefunden: list[dict[str, Any]] = []
    for d in sorted(p for p in ordner.iterdir() if p.is_dir()):
        manifest = d / "openclaw.plugin.json"
        if not manifest.is_file():
            continue
        try:
            pid = str(json.loads(manifest.read_text(encoding="utf-8")).get("id") or "")
        except (ValueError, AttributeError) as fehler:
            raise RenderFehler(f"{manifest}: kein gueltiges Manifest ({fehler})") from fehler
        if not _PLUGIN_ID.fullmatch(pid):
            raise RenderFehler(f"{manifest}: 'id' fehlt oder ist ungueltig (Kleinbuchstaben, Ziffern, '-')")
        if pid in PLUGIN_IDS or any(z["id"] == pid for z in gefunden):
            raise RenderFehler(f"{manifest}: Plugin-ID '{pid}' gibt es schon")
        e = einstellungen.get(pid) or {}
        if not isinstance(e, Mapping):
            raise RenderFehler(f"zusatz_plugins.{pid} muss ein Mapping sein")
        rechte = e.get("rechte") or {}
        eintrag: dict[str, Any] = {
            "enabled": bool(e.get("aktiv", True)),
            "hooks": {"allowConversationAccess": bool(rechte.get("gespraech", False)),
                      "allowPromptInjection": bool(rechte.get("prompt", False))},
        }
        if e.get("config"):
            eintrag["config"] = e["config"]
        gefunden.append({"id": pid, "pfad": str(d), "eintrag": eintrag})
    for pid in sorted(set(einstellungen) - {z["id"] for z in gefunden}):
        print(f"fyos-render: zusatz_plugins.{pid} eingestellt, aber unter {ordner} nicht gefunden", file=sys.stderr)
    return gefunden


def ursprung(url: str) -> str:
    """Origin einer Adresse, wie ihn der Browser schickt: Schema und Host klein, ohne Standardport, Pfad und
    Zugangsdaten. Das Gateway vergleicht seine Allowlist nur kleingeschrieben mit diesem Wert.
    Keine vollständige http(s)-Adresse → leer."""
    try:
        teile = urlsplit(url.strip())
        port = teile.port
    except ValueError:
        return ""
    host = teile.hostname or ""
    if teile.scheme not in _STANDARD_PORTS or not host:
        return ""
    if ":" in host:
        host = f"[{host}]"
    return f"{teile.scheme}://{host}" + (f":{port}" if port and port != _STANDARD_PORTS[teile.scheme] else "")


def oeffentlicher_ursprung(url: str) -> str:
    """Wert für gateway.publicOrigin: nur, wo OpenClaw ihn annimmt (https; http nur auf localhost/Loopback).
    Eine LAN-Adresse wie http://fyos.lan:8080 bleibt erlaubter Ursprung, wird aber nicht publicOrigin."""
    o = ursprung(url)
    teile = urlsplit(o)
    return o if o and (teile.scheme == "https" or teile.hostname in _HTTP_LOOPBACK) else ""


def telegram_besitzer(env: Mapping[str, str]) -> str:
    """Numerische Telegram-ID des Besitzers aus der Umgebung; prüft auch, ob ein Bot-Token da ist.

    Beide Werte stehen nur in der Umgebung. Fehlermeldungen nennen den Namen der Variable, nie ihren Wert.
    """
    token = env.get(TELEGRAM_TOKEN_UMGEBUNG, "")
    if not token:
        raise RenderFehler(f"kanaele.telegram ist an, aber {TELEGRAM_TOKEN_UMGEBUNG} fehlt "
                           "(Bot-Token von @BotFather, siehe README, Abschnitt Telegram)")
    if not _TELEGRAM_TOKEN.fullmatch(token):
        raise RenderFehler(f"{TELEGRAM_TOKEN_UMGEBUNG} hat nicht die Form eines Bot-Tokens "
                           "(<Zahl>:<Zeichen>, ohne Leerzeichen, Zeilenumbruch oder Anführungszeichen)")
    besitzer = env.get(TELEGRAM_BESITZER_UMGEBUNG, "")
    if not besitzer:
        raise RenderFehler(f"kanaele.telegram ist an, aber {TELEGRAM_BESITZER_UMGEBUNG} fehlt "
                           "(numerische Telegram-ID des Besitzers, siehe README, Abschnitt Telegram)")
    if not _TELEGRAM_ID.fullmatch(besitzer):
        raise RenderFehler(f"{TELEGRAM_BESITZER_UMGEBUNG} muss die numerische Telegram-ID des Besitzers sein "
                           "(nur Ziffern; kein Benutzername, keine Telefonnummer, keine Gruppen- oder Kanal-ID)")
    return besitzer


def lade_konfig(pfad: Path | None, zusatz: Path | None = None,
                env: Mapping[str, str] | None = None, zustand: Path | None = None,
                konfig_bleibt: bool = False) -> dict[str, Any]:
    """`zusatz`: Ordner der Zusatz-Plugins (Vorgabe $FYOS_AGENT_PLUGINS oder /opt/fyos-extra).
    `env`: Umgebung (Vorgabe os.environ); daraus kommen die öffentliche Adresse, der Zusatz-Ordner und die
    Telegram-Angaben.
    `zustand`: Zustandsverzeichnis von OpenClaw; daraus ergibt sich, ob die Ersteinrichtung offen ist (ohne Angabe
    entscheidet allein der Schalter faehigkeiten.ersteinrichtung). `konfig_bleibt`: die vorhandene
    Gateway-Konfiguration wird nicht ersetzt, die Ersteinrichtung bleibt dann zu."""
    env = os.environ if env is None else env
    nutzer: dict[str, Any] = {}
    if pfad is not None:
        roh = yaml.safe_load(Path(pfad).read_text(encoding="utf-8"))
        if roh is not None and not isinstance(roh, dict):
            raise RenderFehler("fyos.yaml muss ein Mapping sein")
        nutzer = roh or {}
    ctx = tief_mischen(VORGABEN, nutzer)
    # Abgeleitete Werte. Wer im Gespräch als Besitzer gilt (commands.ownerAllowFrom), steht je Kanal als
    # "<kanal>:<id>"; Telegram gilt nur, wenn der Kanal an ist, und seine ID kommt ausschließlich aus der Umgebung.
    kanaele = ctx["kanaele"]
    owner_ids: list[str] = []
    mid = str(ctx["besitzer"].get("matrix_id") or "")
    if mid:
        owner_ids.append(f"matrix:{mid}")
    if kanaele.get("telegram"):
        ctx["besitzer"]["telegram_id"] = telegram_besitzer(env)
        owner_ids.append(f"telegram:{ctx['besitzer']['telegram_id']}")
    ctx["besitzer"]["owner_ids"] = owner_ids
    # Die Vorlagensprache kennt kein "oder": ein Kanal ist an, wenn irgendeiner an ist.
    ctx["kanaele_aktiv"] = bool(kanaele.get("matrix") or kanaele.get("telegram"))
    # Ersteinrichtung als Gespräch: offen nur bei frischer Installation (einrichtung.entscheide). Kennt die
    # Konfiguration den Namen des Besitzers nicht (Vorgabe), gehört er zu den Fragen.
    entscheidung = einrichtung.entscheide(zustand, bool(ctx["faehigkeiten"].get("ersteinrichtung")), konfig_bleibt)
    ctx["ersteinrichtung"] = {
        "offen": entscheidung.offen,
        "grund": entscheidung.grund,
        "name_bekannt": str(ctx["besitzer"].get("name") or "") not in ("", VORGABEN["besitzer"]["name"]),
    }
    gw = ctx["gateway"]
    # Ohne eigene Angabe gilt die öffentliche Adresse der Installation ($FYOS_OEFFENTLICH_URL): von dort öffnet
    # der Browser die Control UI im Fenster der Shell, und das Gateway lässt nur erlaubte Ursprünge herein.
    roh = str(gw.get("oeffentliche_url") or env.get(OEFFENTLICH_UMGEBUNG) or "").strip()
    gw["oeffentliche_url"] = ursprung(roh)
    if roh and not gw["oeffentliche_url"]:
        print(f"fyos-render: öffentliche Adresse {roh!r} ist keine http(s)-Adresse und bleibt unberücksichtigt",
              file=sys.stderr)
    gw["oeffentlicher_ursprung"] = oeffentlicher_ursprung(roh)
    urspruenge = ([gw["oeffentliche_url"]] if gw["oeffentliche_url"] else []) + [
        ursprung(u) or str(u) for u in gw.get("erlaubte_urspruenge") or []]
    gw["alle_urspruenge"] = list(dict.fromkeys(urspruenge))
    if zusatz is None:
        zusatz = Path(env.get(ZUSATZ_UMGEBUNG) or ZUSATZ_VORGABE)
    extra = zusatz_plugins(zusatz, ctx.get("zusatz_plugins") or {})
    ctx["plugin_pfade"] = [f"/opt/fyos/{p}" for p in PLUGIN_IDS] + [z["pfad"] for z in extra]
    # Fertige JSON-Zeilen fuer plugins.entries (die Vorlagensprache kennt keine Schluessel aus Daten).
    ctx["zusatz_eintraege"] = [f"{json.dumps(z['id'])}: {json.dumps(z['eintrag'], ensure_ascii=False)},"
                               for z in extra]
    return ctx


# ── Parser ────────────────────────────────────────────────────────────────

_TAG = re.compile(r"\{\{(.*?)\}\}", re.S)
_BLOCKZEILE = re.compile(r"^[ \t]*(\{\{[#/][^}]*\}\})[ \t]*\n", re.M)


def _parse(text: str) -> list[tuple]:
    text = _BLOCKZEILE.sub(r"\1", text)
    wurzel: list[tuple] = []
    stapel: list[tuple[str, str, list[tuple]]] = []
    aktuell = wurzel
    pos = 0
    for m in _TAG.finditer(text):
        if m.start() > pos:
            aktuell.append(("text", text[pos:m.start()]))
        pos = m.end()
        inhalt = m.group(1).strip()
        if inhalt.startswith("#"):
            art, _, ausdruck = inhalt[1:].partition(" ")
            if art not in ("if", "unless", "each") or not ausdruck.strip():
                raise RenderFehler(f"Unbekannter Block: {{{{{inhalt}}}}}")
            kinder: list[tuple] = []
            aktuell.append((art, ausdruck.strip(), kinder))
            stapel.append((art, ausdruck.strip(), aktuell))
            aktuell = kinder
        elif inhalt.startswith("/"):
            if not stapel or stapel[-1][0] != inhalt[1:].strip():
                raise RenderFehler(f"Schliessendes Tag ohne Gegenstueck: {{{{{inhalt}}}}}")
            aktuell = stapel.pop()[2]
        elif inhalt.startswith("json "):
            aktuell.append(("json", inhalt[5:].strip()))
        else:
            aktuell.append(("var", inhalt))
    if stapel:
        raise RenderFehler(f"Block nicht geschlossen: {stapel[-1][0]} {stapel[-1][1]}")
    if pos < len(text):
        aktuell.append(("text", text[pos:]))
    return wurzel


_FEHLT = object()


def _suche(ausdruck: str, ctx: Mapping[str, Any], item: Any, env: Mapping[str, str]) -> Any:
    ausdruck = ausdruck.strip()
    if ausdruck == ".":
        return item
    if ausdruck.startswith("env."):
        name = ausdruck[4:]
        return env[name] if name in env and env[name] != "" else _FEHLT
    wert: Any = ctx
    for teil in ausdruck.split("."):
        if isinstance(wert, Mapping) and teil in wert:
            wert = wert[teil]
        else:
            return _FEHLT
    return wert


def _text(wert: Any) -> str:
    if isinstance(wert, (list, tuple)):
        return "\n".join(f"- {_text(w)}" for w in wert)
    if wert is None:
        return ""
    if isinstance(wert, bool):
        return "ja" if wert else "nein"
    return str(wert)


def _wahr(wert: Any) -> bool:
    return wert is not _FEHLT and bool(wert)


def _render(knoten: list[tuple], ctx: Mapping[str, Any], item: Any, env: Mapping[str, str]) -> str:
    aus: list[str] = []
    for k in knoten:
        art = k[0]
        if art == "text":
            aus.append(k[1])
        elif art in ("var", "json"):
            ausdruck, _, vorgabe = k[1].partition("|")
            wert = _suche(ausdruck, ctx, item, env)
            if art == "json":
                leer = wert is _FEHLT or wert is None
            else:
                leer = wert is _FEHLT or wert in ("", None, [])
            if leer:
                if "|" not in k[1]:
                    raise RenderFehler(f"Platzhalter nicht gefuellt: {ausdruck.strip()}")
                wert = vorgabe
            aus.append(json.dumps(wert, ensure_ascii=False) if art == "json" else _text(wert))
        elif art in ("if", "unless"):
            wahr = _wahr(_suche(k[1], ctx, item, env))
            if wahr == (art == "if"):
                aus.append(_render(k[2], ctx, item, env))
        elif art == "each":
            liste = _suche(k[1], ctx, item, env)
            if liste is _FEHLT or not isinstance(liste, (list, tuple)):
                raise RenderFehler(f"#each braucht eine Liste: {k[1]}")
            for element in liste:
                aus.append(_render(k[2], ctx, element, env))
    return "".join(aus)


def rendere_text(vorlage: str, ctx: Mapping[str, Any], env: Mapping[str, str] | None = None) -> str:
    env = os.environ if env is None else env
    ergebnis = _render(_parse(vorlage), ctx, None, env)
    if "{{" in ergebnis:
        raise RenderFehler("Nach dem Rendern bleiben Platzhalter uebrig")
    return ergebnis


def rendere(wurzel: Path, ctx: Mapping[str, Any], ziel: Path,
            env: Mapping[str, str] | None = None) -> list[Path]:
    geschrieben: list[Path] = []
    (ziel / "workspace").mkdir(parents=True, exist_ok=True)
    # BOOTSTRAP.md gibt es nur, solange die Ersteinrichtung offen ist.
    offen = bool((ctx.get("ersteinrichtung") or {}).get("offen"))
    for name in WORKSPACE_DATEIEN + ((einrichtung.BOOTSTRAP,) if offen else ()):
        quelle = wurzel / "workspace" / f"{name}.tmpl"
        datei = ziel / "workspace" / name
        datei.write_text(rendere_text(quelle.read_text(encoding="utf-8"), ctx, env), encoding="utf-8")
        geschrieben.append(datei)
    quelle = wurzel / "config" / "openclaw.json5.tmpl"
    text = rendere_text(quelle.read_text(encoding="utf-8"), ctx, env)
    try:
        json5lite.lade(text)
    except ValueError as fehler:
        raise RenderFehler(f"Gerenderte Konfiguration ist kein gueltiges JSON5: {fehler}") from fehler
    konfig = ziel / "openclaw.json5"
    konfig.write_text(text, encoding="utf-8")
    geschrieben.append(konfig)
    return geschrieben


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--config", default=os.environ.get("FYOS_CONFIG"),
                   help="Pfad zu fyos.yaml (Vorgabe: $FYOS_CONFIG; ohne Angabe gelten die Vorgaben)")
    p.add_argument("--ziel", required=True, help="Zielordner")
    p.add_argument("--vorlagen", default=str(WURZEL), help="Wurzel mit workspace/ und config/")
    p.add_argument("--zustand", help="Zustandsverzeichnis von OpenClaw (im Bild ~/.openclaw): entscheidet über die "
                   "Ersteinrichtung und nimmt die Workspace-Dateien auf")
    p.add_argument("--konfig-bleibt", action="store_true",
                   help="die vorhandene Gateway-Konfiguration bleibt unberührt (FYOS_KONFIG_BEHALTEN); "
                   "die Ersteinrichtung bleibt dann zu")
    a = p.parse_args(argv)
    try:
        zustand = Path(a.zustand) if a.zustand else None
        ctx = lade_konfig(Path(a.config) if a.config else None, zustand=zustand, konfig_bleibt=a.konfig_bleibt)
        for datei in rendere(Path(a.vorlagen), ctx, Path(a.ziel)):
            print(f"gerendert: {datei}")
        if zustand is not None:
            entscheidung = einrichtung.Entscheidung(ctx["ersteinrichtung"]["offen"], ctx["ersteinrichtung"]["grund"])
            einrichtung.installiere(Path(a.ziel), zustand, entscheidung)
            print(f"ersteinrichtung: {'offen' if entscheidung.offen else 'geschlossen'} ({entscheidung.grund})")
    except (RenderFehler, OSError, yaml.YAMLError) as fehler:
        print(f"fyos-render: {fehler}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
