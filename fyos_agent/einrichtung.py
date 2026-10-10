"""Ersteinrichtung als Gespräch: Entscheidung, Zustand und Workspace-Dateien.

Beim allerersten Start einer Installation führt der Agent ein kurzes Kennenlern-Gespräch (BOOTSTRAP.md) und trägt
mit dem Werkzeug `fyos_ersteinrichtung` (plugins/fyos-ersteinrichtung) USER.md und IDENTITY.md ein. Danach endet
das Ritual und kommt nie wieder. Dieses Modul entscheidet bei jedem Start, ob die Einrichtung offen ist, und
schreibt die Workspace-Dateien so, dass nichts verloren geht, was der Agent oder der Betreiber dort geändert hat.

Der Zustand liegt neben der Konfiguration von OpenClaw (`<state>/fyos-agent-zustand.json`):

    ersteinrichtung   "offen" oder "geschlossen"; geschlossen bleibt geschlossen
    grund             warum, in Worten (Meldung beim Start)
    dateien           SHA-256 der zuletzt von uns geschriebenen Fassung von USER.md, IDENTITY.md, BOOTSTRAP.md

Regeln:
    offen             frische Installation (kein Zustand, kein USER.md) bei eingeschaltetem Schalter.
                      Bleibt offen, solange BOOTSTRAP.md da ist und USER.md/IDENTITY.md unverändert sind.
    geschlossen       Schalter aus, bestehende Installation (USER.md ohne Zustand: OpenClaw hat die Einrichtung dort
                      längst als erledigt vermerkt), BOOTSTRAP.md verschwunden oder USER.md/IDENTITY.md geändert.
    AGENTS.md, SOUL.md   gehören der Konfiguration: jeder Start schreibt sie neu.
    USER.md, IDENTITY.md  werden nur überschrieben, solange sie noch so aussehen wie von uns geschrieben. Was der
                      Agent im Gespräch eintrug oder der Betreiber von Hand änderte, bleibt stehen.
    BOOTSTRAP.md      nur bei offener Einrichtung; sonst wird die eigene Fassung gelöscht, eine fremde (etwa von
                      OpenClaw selbst angelegte) zur Seite gelegt, weil sie die gerenderte Identität übersteuern würde.

Die Einrichtung gibt es einmal je Zustandsverzeichnis. OpenClaw vermerkt nach dem ersten Start ohne `skipBootstrap`
in seiner eigenen Datenbank, dass die Einrichtung dieses Workspaces erledigt ist, und zeigt BOOTSTRAP.md danach nicht
mehr an. Wer sie wiederholen will, legt ein frisches Zustandsverzeichnis an; Dateien zu löschen genügt nicht.

Warum `skipBootstrap` bei offener Einrichtung: Ohne diesen Schlüssel vermerkt OpenClaw die Einrichtung beim ersten Lauf
von sich aus als erledigt (sobald SOUL.md, IDENTITY.md oder USER.md von seinen Vorlagen abweichen, und das tun die
gerenderten) und löscht BOOTSTRAP.md. Mit `skipBootstrap: true` legt es nichts an und vermerkt nichts; offen ist die
Einrichtung dann genau so lange, wie BOOTSTRAP.md im Workspace liegt.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

ZUSTAND_DATEI = "fyos-agent-zustand.json"
BOOTSTRAP = "BOOTSTRAP.md"
#: Gehören der Konfiguration: jeder Start schreibt sie neu.
KONFIG_DATEIEN = ("AGENTS.md", "SOUL.md")
#: Werden vom Agenten (Ersteinrichtung) oder vom Betreiber gepflegt und nur überschrieben, solange sie unverändert sind.
GESCHUETZTE_DATEIEN = ("USER.md", "IDENTITY.md")
#: Vermerk im Zustand: die Datei gehört nicht mehr der Konfiguration.
GESCHUETZT = "geschuetzt"
OFFEN = "offen"
GESCHLOSSEN = "geschlossen"


@dataclass(frozen=True)
class Entscheidung:
    offen: bool
    grund: str


def _stderr(text: str) -> None:
    print(text, file=sys.stderr)


def sha256(pfad: Path) -> str | None:
    """SHA-256 des Dateiinhalts; None, wenn es die Datei nicht gibt."""
    try:
        return hashlib.sha256(pfad.read_bytes()).hexdigest()
    except FileNotFoundError:
        return None


def lese_zustand(state: Path, meldung: Callable[[str], None] = _stderr) -> dict[str, Any] | None:
    """Der gespeicherte Zustand, oder None (fehlt oder unbrauchbar: dann gilt die Installation als ohne Zustand)."""
    datei = state / ZUSTAND_DATEI
    try:
        roh = json.loads(datei.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (ValueError, UnicodeDecodeError):
        roh = None
    if not isinstance(roh, dict) or roh.get("ersteinrichtung") not in (OFFEN, GESCHLOSSEN):
        meldung(f"einstieg: {datei} ist unbrauchbar und wird ignoriert")
        return None
    if not isinstance(roh.get("dateien"), dict):
        roh["dateien"] = {}
    return roh


def schreibe_zustand(state: Path, zustand: dict[str, Any]) -> None:
    state.mkdir(parents=True, exist_ok=True)
    ziel = state / ZUSTAND_DATEI
    vorlaeufig = state / f"{ZUSTAND_DATEI}.tmp"
    vorlaeufig.write_text(json.dumps(zustand, indent=2, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(vorlaeufig, ziel)


def entscheide(state: Path | None, schalter: bool, konfig_bleibt: bool = False,
               meldung: Callable[[str], None] = _stderr) -> Entscheidung:
    """Ist die Ersteinrichtung bei diesem Start offen? Liest nur, schreibt nichts.

    `state` ist das Zustandsverzeichnis von OpenClaw; ohne es (reines Rendern) entscheidet allein der Schalter.
    `konfig_bleibt`: die vorhandene Gateway-Konfiguration bleibt unberührt (FYOS_KONFIG_BEHALTEN) und kennt das
    Werkzeug der Einrichtung nicht.
    """
    if state is None:
        return Entscheidung(schalter, "ohne Zustandsverzeichnis")
    alt = lese_zustand(state, meldung)
    if alt is not None and alt["ersteinrichtung"] == GESCHLOSSEN:
        return Entscheidung(False, str(alt.get("grund") or "abgeschlossen"))
    if not schalter:
        return Entscheidung(False, "Schalter faehigkeiten.ersteinrichtung aus")
    if konfig_bleibt:
        return Entscheidung(False, "vorhandene Konfiguration bleibt (FYOS_KONFIG_BEHALTEN)")
    workspace = state / "workspace"
    if alt is None:
        if (workspace / "USER.md").exists():
            return Entscheidung(False, "bestehende Installation")
        return Entscheidung(True, "frische Installation")
    if not (workspace / BOOTSTRAP).exists():
        return Entscheidung(False, "abgeschlossen")
    for name in GESCHUETZTE_DATEIEN:
        letzter = alt["dateien"].get(name)
        if letzter and letzter != GESCHUETZT and sha256(workspace / name) != letzter:
            return Entscheidung(False, f"{name} wurde geändert")
    return Entscheidung(True, str(alt.get("grund") or "frische Installation"))


def _schreibe(ziel: Path, daten: bytes) -> None:
    vorlaeufig = ziel.with_name(f"{ziel.name}.tmp")
    vorlaeufig.write_bytes(daten)
    os.replace(vorlaeufig, ziel)


def _kopiere(quelle: Path, ziel: Path) -> None:
    _schreibe(ziel, quelle.read_bytes())


def installiere(gerendert: Path, state: Path, entscheidung: Entscheidung,
                meldung: Callable[[str], None] = _stderr) -> None:
    """Schreibt die gerenderten Workspace-Dateien (`gerendert`/workspace) nach `state`/workspace und danach den Zustand.

    Der Zustand kommt zuletzt: bricht etwas vorher ab, entscheidet der nächste Start aus dem, was auf der Platte liegt.
    """
    workspace = state / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    quelle = gerendert / "workspace"
    alt = lese_zustand(state, meldung) or {}
    hashes: dict[str, str] = dict(alt.get("dateien") or {})

    for name in KONFIG_DATEIEN:
        _kopiere(quelle / name, workspace / name)

    for name in GESCHUETZTE_DATEIEN:
        datei = workspace / name
        vorhanden = sha256(datei)
        letzter = hashes.get(name)
        if vorhanden is not None and letzter is not None and (letzter == GESCHUETZT or vorhanden != letzter):
            if letzter != GESCHUETZT:
                meldung(f"einstieg: {name} wurde seit dem letzten Rendern geändert und bleibt unberührt "
                        "(zum Zurücksetzen die Datei löschen)")
            hashes[name] = GESCHUETZT
            continue
        _kopiere(quelle / name, datei)
        hashes[name] = sha256(datei) or ""

    bootstrap = workspace / BOOTSTRAP
    if entscheidung.offen:
        _kopiere(quelle / BOOTSTRAP, bootstrap)
        hashes[BOOTSTRAP] = sha256(bootstrap) or ""
    else:
        vorhanden = sha256(bootstrap)
        if vorhanden is not None:
            if vorhanden == hashes.get(BOOTSTRAP):
                bootstrap.unlink()
            else:
                zur_seite = workspace / f"BOOTSTRAP.vor-fyos.{int(time.time())}.md"
                bootstrap.rename(zur_seite)
                meldung(f"einstieg: fremdes {BOOTSTRAP} nach {zur_seite.name} verschoben")
        hashes.pop(BOOTSTRAP, None)

    status = OFFEN if entscheidung.offen else GESCHLOSSEN
    seit = alt.get("seit") if (alt.get("ersteinrichtung") == status and alt.get("grund") == entscheidung.grund) else None
    schreibe_zustand(state, {
        "version": 1,
        "ersteinrichtung": status,
        "grund": entscheidung.grund,
        "seit": seit or datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "dateien": hashes,
    })
