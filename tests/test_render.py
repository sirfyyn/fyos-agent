"""Tests fuer den Vorlagen-Renderer und die mitgelieferten Vertragsdateien."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest
import yaml

WURZEL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WURZEL))

from fyos_agent import json5lite, render  # noqa: E402

ENV = {
    "FYOS_MODELL_BASIS_URL": "http://modell:8080/v1",
    "FYOS_MODELL_NAME": "mein-modell",
    "FYOS_HUB_URL": "http://hub:8080/mcp/",
    "FYOS_MATRIX_HOMESERVER": "http://matrix:8008",
    "FYOS_MATRIX_BENUTZER": "@agent:matrix.example.com",
}


def rendere(tmp_path: Path, konfig: Path | None = WURZEL / "fyos.example.yaml") -> Path:
    ctx = render.lade_konfig(konfig)
    render.rendere(WURZEL, ctx, tmp_path, env=ENV)
    return tmp_path


def test_beispiel_rendert_ohne_platzhalter(tmp_path):
    ziel = rendere(tmp_path)
    dateien = [ziel / "workspace" / n for n in render.WORKSPACE_DATEIEN] + [ziel / "openclaw.json5"]
    for datei in dateien:
        text = datei.read_text(encoding="utf-8")
        assert text.strip(), datei
        assert "{{" not in text, datei


def test_workspace_enthaelt_werte(tmp_path):
    ziel = rendere(tmp_path)
    agents = (ziel / "workspace" / "AGENTS.md").read_text(encoding="utf-8")
    assert "# Fy " in agents and "Alex" in agents
    assert "- Löschen und nicht umkehrbare Datenänderungen" in agents
    assert "Vorgangs-Dienst" not in agents  # vorgaenge: false
    assert "fyos_conversation_status" in agents
    # Die Statusmeldung nennt die genaue Form (09.10.: das Modell schickte `status` statt `state`)
    assert '`{"state": "completed"}`' in agents
    identity =(ziel / "workspace" / "IDENTITY.md").read_text(encoding="utf-8")
    assert "- Name: Fy" in identity
    assert "Deutsch" in (ziel / "workspace" / "USER.md").read_text(encoding="utf-8")


def test_flaechen_oeffnet_der_agent_ueber_die_shell(tmp_path):
    """„Öffne den Notizzettel“: das App-Werkzeug allein öffnet kein Fenster, shell.befehl schon."""
    agents = (rendere(tmp_path) / "workspace" / "AGENTS.md").read_text(encoding="utf-8")
    assert '`{"aktion":"oeffnen","flaeche":"app:beispiel_app__zeigen"}`' in agents
    assert "Sag „offen“ erst, wenn\n`shell.befehl` angenommen ist" in agents
    assert "shell.befehl" in (WURZEL / "vertrag" / "werkzeugentdeckung.md").read_text(encoding="utf-8")


def test_vorgaenge_abschnitt_ist_optional(tmp_path):
    konfig = tmp_path / "fyos.yaml"
    konfig.write_text("faehigkeiten:\n  vorgaenge: true\n", encoding="utf-8")
    ziel = rendere(tmp_path / "ziel", konfig)
    agents = (ziel / "workspace" / "AGENTS.md").read_text(encoding="utf-8")
    assert "Vorgangs-Dienst ist die gemeinsame Arbeitsakte" in agents
    assert "Board `fyos` spiegelt die offenen Vorgänge" in agents
    cfg = json5lite.lade((ziel / "openclaw.json5").read_text(encoding="utf-8"))
    assert cfg["plugins"]["entries"]["fyos-freigabe-chat"]["enabled"] is True


def test_json5_hat_pflichtschluessel(tmp_path):
    ziel = rendere(tmp_path)
    cfg = json5lite.lade((ziel / "openclaw.json5").read_text(encoding="utf-8"))
    assert cfg["meta"]["lastTouchedVersion"]
    gw = cfg["gateway"]
    assert gw["port"] == 18789 and gw["mode"] == "local" and gw["bind"] == "lan"
    assert gw["auth"] == {"mode": "token", "token": "${OPENCLAW_GATEWAY_TOKEN}"}
    assert gw["controlUi"]["basePath"] == "/agent"
    assert gw["trustedProxies"] == ["127.0.0.1/32"]
    anbieter = cfg["models"]["providers"]["modell"]
    assert anbieter["baseUrl"] == ENV["FYOS_MODELL_BASIS_URL"]
    assert anbieter["apiKey"] == "${FYOS_MODELL_SCHLUESSEL}"
    assert anbieter["api"] == "openai-completions"
    assert anbieter["models"][0]["id"] == "mein-modell"
    agent = cfg["agents"]["entries"]["main"]
    assert agent["model"] == "modell/mein-modell"
    assert "exec" not in agent["tools"]  # Shell standardmaessig aus
    assert cfg["agents"]["defaults"]["heartbeat"] == {"every": "0m"}
    assert cfg["tools"]["loopDetection"] == {"enabled": True}
    hub = cfg["mcp"]["servers"]["hub"]
    assert hub["url"] == ENV["FYOS_HUB_URL"] and hub["transport"] == "streamable-http"
    pfade = cfg["plugins"]["load"]["paths"]
    assert pfade and all(p.startswith("/opt/fyos/fyos-") for p in pfade)
    assert cfg["plugins"]["entries"]["fyos-meldebudget"]["config"]["tagesbudget"] == 5
    assert cfg["plugins"]["entries"]["fyos-freigabe-chat"]["enabled"] is False
    assert "channels" not in cfg  # Matrix aus


def test_kopplung_ist_vorgabe(tmp_path):
    ziel = rendere(tmp_path)
    cfg = json5lite.lade((ziel / "openclaw.json5").read_text(encoding="utf-8"))
    eintraege = cfg["plugins"]["entries"]
    bruecke = eintraege["fyos-bruecke"]
    assert bruecke["enabled"] is True
    # Die Brücke sieht keine Inhalte und ändert keinen Prompt.
    assert bruecke["hooks"] == {"allowConversationAccess": False, "allowPromptInjection": False}
    # Hub-Adresse aus FYOS_HUB_URL; die Kennung des Agenten steht in der Konfiguration (Wecken, Sitzung je Vorgang).
    assert bruecke["config"] == {"agentId": "main"}
    assert eintraege["workboard"] == {"enabled": True}
    assert "/opt/fyos/fyos-bruecke" in cfg["plugins"]["load"]["paths"]
    erlaubt = set(cfg["agents"]["entries"]["main"]["tools"]["alsoAllow"])
    assert {"workboard_list", "workboard_read", "workboard_create", "workboard_comment", "workboard_move"} <= erlaubt
    assert not {"workboard_claim", "workboard_dispatch", "workboard_complete", "workboard_reassign"} & erlaubt
    assert cfg["skills"]["load"]["extraDirs"] == ["/opt/fyos/skills"]
    assert "Das Workboard (`workboard_*`)" in (ziel / "workspace" / "AGENTS.md").read_text(encoding="utf-8")


def test_kopplung_abschaltbar(tmp_path):
    konfig = tmp_path / "fyos.yaml"
    konfig.write_text("kopplung: {aktiv: false, workboard: false, hub_url: 'http://hub.example.com:8080'}\n",
                      encoding="utf-8")
    ziel = rendere(tmp_path / "ziel", konfig)
    cfg = json5lite.lade((ziel / "openclaw.json5").read_text(encoding="utf-8"))
    bruecke = cfg["plugins"]["entries"]["fyos-bruecke"]
    assert bruecke["enabled"] is False
    assert bruecke["config"] == {"agentId": "main", "hubUrl": "http://hub.example.com:8080"}
    assert "workboard" not in cfg["plugins"]["entries"]
    assert not any(t.startswith("workboard_") for t in cfg["agents"]["entries"]["main"]["tools"]["alsoAllow"])
    # Die Skills aus fyos-agent hängen nicht an der Kopplung: AGENTS.md verweist immer auf sie.
    assert cfg["skills"]["load"]["extraDirs"] == ["/opt/fyos/skills"]
    assert "Workboard" not in (ziel / "workspace" / "AGENTS.md").read_text(encoding="utf-8")


def _gedaechtnis(tmp_path: Path, yaml_text: str = "", env: dict[str, str] | None = None) -> dict:
    konfig = tmp_path / "fyos.yaml"
    konfig.write_text(yaml_text or "{}\n", encoding="utf-8")
    ctx = render.lade_konfig(konfig, env=env or {})
    render.rendere(WURZEL, ctx, tmp_path / "ziel", env=ENV)
    text = (tmp_path / "ziel" / "openclaw.json5").read_text(encoding="utf-8")
    assert "{{" not in text
    return json5lite.lade(text)


def test_gedaechtnis_ohne_embedding_dienst_sucht_ausdruecklich_nur_im_text(tmp_path):
    cfg = _gedaechtnis(tmp_path)
    assert cfg["memory"] == {"search": {"provider": "none"}}
    assert cfg["plugins"]["entries"]["active-memory"]["enabled"] is False


def test_gedaechtnis_nimmt_den_embedding_dienst_des_hubs(tmp_path):
    env = {"FYOS_EMBED_URL": "http://embed:8081/", "FYOS_EMBED_MODEL": "bge-m3"}
    such = _gedaechtnis(tmp_path, env=env)["memory"]["search"]
    assert such["provider"] == "openai-compatible" and such["model"] == "bge-m3"
    assert such["remote"] == {"baseUrl": "http://embed:8081/v1/", "apiKey": "ohne-schluessel"}


def test_gedaechtnis_schluessel_bleibt_in_der_umgebung(tmp_path):
    env = {"FYOS_EMBED_URL": "https://api.example.com/v1", "FYOS_EMBED_KEY": "sk-geheim"}
    cfg = _gedaechtnis(tmp_path, env=env)
    such = cfg["memory"]["search"]
    assert such["remote"] == {"baseUrl": "https://api.example.com/v1/", "apiKey": "${FYOS_EMBED_KEY}"}
    assert such["model"] == "embedding"
    assert "sk-geheim" not in (tmp_path / "ziel" / "openclaw.json5").read_text(encoding="utf-8")


def test_gedaechtnis_yaml_geht_vor_umgebung(tmp_path):
    cfg = _gedaechtnis(tmp_path, "gedaechtnis: {embedder_url: 'http://eigen:9000', modell: klein}\n",
                       {"FYOS_EMBED_URL": "http://hub-embed:8081", "FYOS_EMBED_MODEL": "gross"})
    such = cfg["memory"]["search"]
    assert such["remote"]["baseUrl"] == "http://eigen:9000/v1/" and such["model"] == "klein"


@pytest.mark.parametrize("adresse", ["embed:8081", "ftp://embed", "http://", "file:///etc/passwd"])
def test_gedaechtnis_unbrauchbare_adresse_bleibt_beim_text(tmp_path, adresse, capsys):
    cfg = _gedaechtnis(tmp_path, env={"FYOS_EMBED_URL": adresse})
    assert cfg["memory"]["search"] == {"provider": "none"}
    assert "keine http(s)-Adresse" in capsys.readouterr().err


def test_aktives_gedaechtnis_ist_schaltbar(tmp_path):
    cfg = _gedaechtnis(tmp_path, "gedaechtnis: {aktives_gedaechtnis: true}\nagent: {id: wache}\n")
    eintrag = cfg["plugins"]["entries"]["active-memory"]
    assert eintrag["enabled"] is True
    assert eintrag["config"]["agents"] == ["wache"] and eintrag["config"]["allowedChatTypes"] == ["direct"]


def test_mund_und_ohr_sind_ohne_adresse_aus(tmp_path):
    cfg = _gedaechtnis(tmp_path)
    assert cfg["tts"] == {"auto": "off"} and "media" not in cfg["tools"]


def test_mund_nimmt_den_dienst_aus_der_umgebung(tmp_path):
    cfg = _gedaechtnis(tmp_path, env={"FYOS_MUND_URL": "http://mund:8880/", "FYOS_MUND_MODEL": "kokoro",
                                      "FYOS_MUND_VOICE": "af_heart"})
    assert cfg["tts"]["enabled"] is True and cfg["tts"]["auto"] == "inbound" and cfg["tts"]["provider"] == "openai"
    assert cfg["tts"]["providers"]["openai"] == {"baseUrl": "http://mund:8880/v1", "model": "kokoro",
                                                 "voice": "af_heart", "apiKey": "ohne-schluessel"}


def test_mund_yaml_geht_vor_umgebung_und_schluessel_bleibt_aussen(tmp_path):
    cfg = _gedaechtnis(tmp_path, "mund: {url: 'https://mund.example/v1', stimme: nova, automatisch: always}\n",
                       {"FYOS_MUND_URL": "http://anders:1", "FYOS_MUND_KEY": "sk-geheim"})
    anbieter = cfg["tts"]["providers"]["openai"]
    assert cfg["tts"]["auto"] == "always" and anbieter["baseUrl"] == "https://mund.example/v1"
    assert anbieter["voice"] == "nova" and anbieter["model"] == "tts-1" and anbieter["apiKey"] == "${FYOS_MUND_KEY}"
    assert "sk-geheim" not in (tmp_path / "ziel" / "openclaw.json5").read_text(encoding="utf-8")


def test_mund_unbekannte_betriebsart_und_unbrauchbare_adresse(tmp_path, capsys):
    cfg = _gedaechtnis(tmp_path, "mund: {url: 'http://mund:1', automatisch: manchmal}\n", {"FYOS_OHR_URL": "ftp://ohr"})
    assert cfg["tts"]["auto"] == "inbound" and "media" not in cfg["tools"]
    fehler = capsys.readouterr().err
    assert "unbekannt" in fehler and "keine http(s)-Adresse" in fehler


def test_ohr_wird_zum_audio_modell_der_medien(tmp_path):
    cfg = _gedaechtnis(tmp_path, env={"FYOS_OHR_URL": "http://ohr:8000", "FYOS_OHR_KEY": "sk-geheim"})
    medien = cfg["tools"]["media"]
    assert medien["audio"] == {"enabled": True}
    (modell,) = medien["models"]
    assert modell["capabilities"] == ["audio"] and modell["baseUrl"] == "http://ohr:8000/v1"
    assert modell["model"] == "whisper-1" and modell["request"]["auth"]["token"] == "${FYOS_OHR_KEY}"
    assert "sk-geheim" not in (tmp_path / "ziel" / "openclaw.json5").read_text(encoding="utf-8")


def test_fortschrittskarte_und_zusagen(tmp_path):
    ziel = rendere(tmp_path)
    cfg = json5lite.lade((ziel / "openclaw.json5").read_text(encoding="utf-8"))
    erlaubt = set(cfg["agents"]["entries"]["main"]["tools"]["alsoAllow"])
    assert {"progress_card", "intent"} <= erlaubt
    agents = (ziel / "workspace" / "AGENTS.md").read_text(encoding="utf-8")
    assert "Skill `zusagen`" in agents and "`progress_card`" in agents
    skill = (WURZEL / "skills" / "zusagen" / "SKILL.md").read_text(encoding="utf-8")
    kopf = yaml.safe_load(skill.split("---")[1])
    assert kopf["name"] == "zusagen" and "Zusage" in kopf["description"]
    assert "{{" not in skill, "Skills werden nicht gerendert"
    for baustein in ("workboard_create", "intent", "openclaw.auftrag_vorlage", "ausdrücklichen Wunsch"):
        assert baustein in skill


def test_skill_verweise_liegen_im_bild():
    """Jeder Skill, den AGENTS.md nennt, liegt unter skills/ (im Bild /opt/fyos/skills, skills.load.extraDirs)."""
    text = (WURZEL / "workspace" / "AGENTS.md.tmpl").read_text(encoding="utf-8")
    genannt = set(re.findall(r"Skill `([a-z0-9-]+)`", text))
    vorhanden = {p.name for p in (WURZEL / "skills").iterdir() if (p / "SKILL.md").is_file()}
    assert genannt and genannt <= vorhanden


def test_matrix_und_shell_schalter(tmp_path):
    konfig = tmp_path / "fyos.yaml"
    konfig.write_text(
        "kanaele: {matrix: true}\nfaehigkeiten: {shell: true}\n"
        "besitzer: {name: Alex, matrix_id: '@alex:matrix.example.com'}\n"
        "gateway: {oeffentliche_url: 'https://fyos.example.com'}\n",
        encoding="utf-8",
    )
    ziel = rendere(tmp_path / "ziel", konfig)
    cfg = json5lite.lade((ziel / "openclaw.json5").read_text(encoding="utf-8"))
    assert cfg["channels"]["matrix"]["dm"]["allowFrom"] == ["@alex:matrix.example.com"]
    assert cfg["commands"]["ownerAllowFrom"] == ["matrix:@alex:matrix.example.com"]
    assert cfg["gateway"]["publicOrigin"] == "https://fyos.example.com"
    assert cfg["gateway"]["controlUi"]["allowedOrigins"] == ["https://fyos.example.com"]
    assert cfg["agents"]["entries"]["main"]["tools"]["exec"] == {"security": "full", "ask": "off"}


# ── Telegram als zweiter Kanal ────────────────────────────────────────────

TELEGRAM_TOKEN = "123456:fake-token_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"
TELEGRAM_ENV = {**ENV, "OPENCLAW_TELEGRAM_TOKEN": TELEGRAM_TOKEN, "FYOS_APPROVER_TELEGRAM_ID": "424242424"}


def _kanaele(tmp_path: Path, kanaele: str, matrix_id: str = "", env: dict[str, str] = TELEGRAM_ENV):
    """Rendert mit `kanaele: <kanaele>` und gibt (Konfiguration, Rohtext) zurück."""
    konfig = tmp_path / "fyos.yaml"
    konfig.write_text(f"kanaele: {kanaele}\nbesitzer: {{name: Alex, matrix_id: '{matrix_id}'}}\n", encoding="utf-8")
    ctx = render.lade_konfig(konfig, env=env)
    render.rendere(WURZEL, ctx, tmp_path / "ziel", env=env)
    text = (tmp_path / "ziel" / "openclaw.json5").read_text(encoding="utf-8")
    return json5lite.lade(text), text


def test_telegram_ist_vorgabe_aus_und_aendert_nichts(tmp_path):
    cfg = json5lite.lade((rendere(tmp_path) / "openclaw.json5").read_text(encoding="utf-8"))
    assert not {"channels", "bindings", "approvals"} & set(cfg)
    assert "telegram" not in cfg["plugins"]["entries"]
    assert "ownerAllowFrom" not in cfg["commands"]
    assert render.VORGABEN["kanaele"]["telegram"] is False


def test_telegram_nur_direktnachrichten_des_besitzers(tmp_path):
    cfg, text = _kanaele(tmp_path, "{telegram: true}")
    assert cfg["channels"] == {"telegram": {
        "enabled": True,
        "botToken": "${OPENCLAW_TELEGRAM_TOKEN}",
        "dmPolicy": "allowlist",
        "allowFrom": ["424242424"],
        "groupPolicy": "disabled",
        "configWrites": False,
        "capabilities": {"inlineButtons": "dm"},
    }}
    # Mit agents.ownership "explicit" braucht der Kanal eine Bindung, sonst bleibt er ohne Agenten.
    assert cfg["bindings"] == [{"agentId": "main", "match": {"channel": "telegram", "accountId": "default"}}]
    # Der Besitzer ist in Telegram Besitzer des Gesprächs: so greift die Freigabe per Text (fyos-freigabe-chat).
    assert cfg["commands"]["ownerAllowFrom"] == ["telegram:424242424"]
    assert cfg["approvals"]["plugin"]["targets"] == [{"channel": "telegram", "to": "424242424"}]
    assert cfg["plugins"]["entries"]["telegram"] == {"enabled": True}
    assert "matrix" not in cfg["plugins"]["entries"]
    # Das Token steht nie in der Konfiguration, nur der Verweis auf die Umgebung.
    assert TELEGRAM_TOKEN not in text


def test_telegram_neben_matrix(tmp_path):
    cfg, _ = _kanaele(tmp_path, "{matrix: true, telegram: true}", matrix_id="@alex:matrix.example.com")
    assert set(cfg["channels"]) == {"matrix", "telegram"}
    assert [b["match"]["channel"] for b in cfg["bindings"]] == ["matrix", "telegram"]
    assert cfg["commands"]["ownerAllowFrom"] == ["matrix:@alex:matrix.example.com", "telegram:424242424"]
    assert cfg["approvals"]["plugin"]["targets"] == [
        {"channel": "matrix", "to": "@alex:matrix.example.com"},
        {"channel": "telegram", "to": "424242424"},
    ]
    assert {k: v for k, v in cfg["plugins"]["entries"].items() if k in ("matrix", "telegram")} == {
        "matrix": {"enabled": True}, "telegram": {"enabled": True}}


def test_matrix_allein_bleibt_wie_zuvor(tmp_path):
    cfg, _ = _kanaele(tmp_path, "{matrix: true}", matrix_id="@alex:matrix.example.com")
    assert set(cfg["channels"]) == {"matrix"}
    assert cfg["bindings"] == [{"agentId": "main", "match": {"channel": "matrix", "accountId": "default"}}]
    assert cfg["commands"]["ownerAllowFrom"] == ["matrix:@alex:matrix.example.com"]
    assert cfg["approvals"]["plugin"]["targets"] == [{"channel": "matrix", "to": "@alex:matrix.example.com"}]
    assert "telegram" not in cfg["plugins"]["entries"]


def test_telegram_ohne_matrix_id_braucht_keine_matrix_angaben(tmp_path):
    # Telegram allein: weder Matrix-Umgebung noch matrix_id nötig.
    umgebung = {k: v for k, v in TELEGRAM_ENV.items() if not k.startswith("FYOS_MATRIX_")}
    cfg, _ = _kanaele(tmp_path, "{telegram: true}", env=umgebung)
    assert set(cfg["channels"]) == {"telegram"}


@pytest.mark.parametrize("aenderung, meldung", [
    ({"OPENCLAW_TELEGRAM_TOKEN": ""}, "OPENCLAW_TELEGRAM_TOKEN fehlt"),
    ({"OPENCLAW_TELEGRAM_TOKEN": "kein token"}, "Form eines Bot-Tokens"),
    ({"OPENCLAW_TELEGRAM_TOKEN": TELEGRAM_TOKEN + "\n"}, "Form eines Bot-Tokens"),
    ({"OPENCLAW_TELEGRAM_TOKEN": '"' + TELEGRAM_TOKEN + '"'}, "Form eines Bot-Tokens"),
    ({"FYOS_APPROVER_TELEGRAM_ID": ""}, "FYOS_APPROVER_TELEGRAM_ID fehlt"),
    ({"FYOS_APPROVER_TELEGRAM_ID": "@alex"}, "numerische Telegram-ID"),
    ({"FYOS_APPROVER_TELEGRAM_ID": "-1001234567890"}, "numerische Telegram-ID"),
    ({"FYOS_APPROVER_TELEGRAM_ID": "0"}, "numerische Telegram-ID"),
    ({"FYOS_APPROVER_TELEGRAM_ID": "4242 4242"}, "numerische Telegram-ID"),
    ({"FYOS_APPROVER_TELEGRAM_ID": "12345678901234567"}, "numerische Telegram-ID"),
])
def test_telegram_ohne_brauchbares_token_oder_id_bricht_ab(tmp_path, aenderung, meldung):
    konfig = tmp_path / "fyos.yaml"
    konfig.write_text("kanaele: {telegram: true}\n", encoding="utf-8")
    with pytest.raises(render.RenderFehler, match=meldung) as fehler:
        render.lade_konfig(konfig, env={**TELEGRAM_ENV, **aenderung})
    assert TELEGRAM_TOKEN not in str(fehler.value)  # die Meldung nennt die Variable, nie den Wert


def test_cli_meldet_fehlendes_telegram_token(tmp_path, monkeypatch, capsys):
    konfig = tmp_path / "fyos.yaml"
    konfig.write_text("kanaele: {telegram: true}\n", encoding="utf-8")
    for k, v in TELEGRAM_ENV.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("OPENCLAW_TELEGRAM_TOKEN")
    assert render.main(["--config", str(konfig), "--ziel", str(tmp_path / "ziel")]) == 1
    assert "OPENCLAW_TELEGRAM_TOKEN fehlt" in capsys.readouterr().err


# ── WhatsApp als dritter Kanal ────────────────────────────────────────────

WHATSAPP_NUMMER = "+4915100000000"
WHATSAPP_ENV = {**ENV, "FYOS_APPROVER_WHATSAPP_NUMBER": WHATSAPP_NUMMER}


def test_whatsapp_ist_vorgabe_aus_und_aendert_nichts(tmp_path):
    cfg = json5lite.lade((rendere(tmp_path) / "openclaw.json5").read_text(encoding="utf-8"))
    assert not {"channels", "bindings", "approvals"} & set(cfg)
    assert "whatsapp" not in cfg["plugins"]["entries"]
    assert render.VORGABEN["kanaele"]["whatsapp"] is False


def test_whatsapp_nur_direktnachrichten_des_besitzers(tmp_path):
    cfg, text = _kanaele(tmp_path, "{whatsapp: true}", env=WHATSAPP_ENV)
    assert cfg["channels"] == {"whatsapp": {
        "enabled": True,
        "dmPolicy": "allowlist",
        "allowFrom": [WHATSAPP_NUMMER],
        "groupPolicy": "disabled",
        "selfChatMode": False,
        "configWrites": False,
        "pluginHooks": {"messageReceived": False},
    }}
    assert cfg["bindings"] == [{"agentId": "main", "match": {"channel": "whatsapp", "accountId": "default"}}]
    # Der Besitzer ist in WhatsApp Besitzer des Gesprächs: so greift die Freigabe per Text (fyos-freigabe-chat).
    assert cfg["commands"]["ownerAllowFrom"] == [f"whatsapp:{WHATSAPP_NUMMER}"]
    assert cfg["approvals"]["plugin"]["targets"] == [{"channel": "whatsapp", "to": WHATSAPP_NUMMER}]
    assert cfg["plugins"]["entries"]["whatsapp"] == {"enabled": True}
    assert not {"matrix", "telegram"} & set(cfg["plugins"]["entries"])
    # Die Nummer kommt nur aus der Umgebung und steht nie in einer Datei des Repos (hier: die Vorlagen).
    assert WHATSAPP_NUMMER not in (WURZEL / "config" / "openclaw.json5.tmpl").read_text(encoding="utf-8")
    assert WHATSAPP_NUMMER in text  # nur als Wert von allowFrom/targets, aus der Umgebung gerendert


def test_whatsapp_eigene_nummer_schaltet_selbstgespraech_ein(tmp_path):
    konfig = tmp_path / "fyos.yaml"
    konfig.write_text("kanaele: {whatsapp: true}\nwhatsapp: {eigene_nummer: true}\n", encoding="utf-8")
    ctx = render.lade_konfig(konfig, env=WHATSAPP_ENV)
    render.rendere(WURZEL, ctx, tmp_path / "ziel", env=WHATSAPP_ENV)
    cfg = json5lite.lade((tmp_path / "ziel" / "openclaw.json5").read_text(encoding="utf-8"))
    assert cfg["channels"]["whatsapp"]["selfChatMode"] is True
    assert cfg["channels"]["whatsapp"]["allowFrom"] == [WHATSAPP_NUMMER]  # weiterhin nur der Besitzer


def test_alle_drei_kanaele_zusammen(tmp_path):
    env = {**TELEGRAM_ENV, **WHATSAPP_ENV}
    cfg, _ = _kanaele(tmp_path, "{matrix: true, telegram: true, whatsapp: true}",
                      matrix_id="@alex:matrix.example.com", env=env)
    assert set(cfg["channels"]) == {"matrix", "telegram", "whatsapp"}
    assert [b["match"]["channel"] for b in cfg["bindings"]] == ["matrix", "telegram", "whatsapp"]
    assert cfg["commands"]["ownerAllowFrom"] == [
        "matrix:@alex:matrix.example.com", "telegram:424242424", f"whatsapp:{WHATSAPP_NUMMER}"]
    assert [t["channel"] for t in cfg["approvals"]["plugin"]["targets"]] == ["matrix", "telegram", "whatsapp"]
    assert {k for k in cfg["plugins"]["entries"] if k in ("matrix", "telegram", "whatsapp")} == {
        "matrix", "telegram", "whatsapp"}


def test_telegram_allein_bleibt_wie_zuvor_mit_whatsapp_im_code(tmp_path):
    cfg, _ = _kanaele(tmp_path, "{telegram: true}")
    assert set(cfg["channels"]) == {"telegram"}
    assert "whatsapp" not in cfg["plugins"]["entries"]


@pytest.mark.parametrize("nummer, meldung", [
    ("", "FYOS_APPROVER_WHATSAPP_NUMBER fehlt"),
    ("4915100000000", "internationalen Format"),            # ohne +
    ("015100000000", "internationalen Format"),             # nationale Schreibweise
    ("+49 151 00000000", "internationalen Format"),         # Leerzeichen
    ("+49-151-00000000", "internationalen Format"),
    ("+0123456789", "internationalen Format"),              # Ländervorwahl nie 0
    ("+49151", "internationalen Format"),                   # zu kurz
    ("+4915100000000000000", "internationalen Format"),     # zu lang
    ("+4915100000000\n", "internationalen Format"),
    ("Alex", "internationalen Format"),                     # Name statt Nummer
])
def test_whatsapp_ohne_brauchbare_nummer_bricht_ab(tmp_path, nummer, meldung):
    konfig = tmp_path / "fyos.yaml"
    konfig.write_text("kanaele: {whatsapp: true}\n", encoding="utf-8")
    with pytest.raises(render.RenderFehler, match=meldung) as fehler:
        render.lade_konfig(konfig, env={**WHATSAPP_ENV, "FYOS_APPROVER_WHATSAPP_NUMBER": nummer})
    if nummer:
        assert nummer.strip() not in str(fehler.value)  # die Meldung nennt die Variable, nie den Wert


def test_cli_meldet_fehlende_whatsapp_nummer(tmp_path, monkeypatch, capsys):
    konfig = tmp_path / "fyos.yaml"
    konfig.write_text("kanaele: {whatsapp: true}\n", encoding="utf-8")
    for k, v in ENV.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("FYOS_APPROVER_WHATSAPP_NUMBER", raising=False)
    assert render.main(["--config", str(konfig), "--ziel", str(tmp_path / "ziel")]) == 1
    assert "FYOS_APPROVER_WHATSAPP_NUMBER fehlt" in capsys.readouterr().err


def test_dockerfile_installiert_whatsapp_festgenagelt_wie_matrix():
    dockerfile = (WURZEL / "openclaw" / "Dockerfile").read_text(encoding="utf-8")
    assert re.search(r"\*,matrix,\*\)[^;]*@openclaw/matrix@2026\.9\.7", dockerfile)
    assert re.search(r"\*,whatsapp,\*\)[^;]*@openclaw/whatsapp@2026\.9\.7", dockerfile)
    # Ein Kopiervorgang nach allen Installationen: matrix und whatsapp teilen sich ~/.openclaw/npm.
    assert dockerfile.count("cp -a /home/node/.openclaw/npm/.") == 1


def test_fehlende_umgebung_ist_ein_fehler(tmp_path):
    ctx = render.lade_konfig(WURZEL / "fyos.example.yaml")
    with pytest.raises(render.RenderFehler):
        render.rendere(WURZEL, ctx, tmp_path, env={})


def test_vorlagensprache():
    ctx = {"a": {"liste": ["x", "y"], "an": True, "aus": False}}
    f = render.rendere_text
    assert f("{{a.liste}}", ctx, {}) == "- x\n- y"
    assert f("{{#each a.liste}}[{{.}}]{{/each}}", ctx, {}) == "[x][y]"
    assert f("{{#if a.an}}ja{{/if}}{{#unless a.aus}}nein{{/unless}}", ctx, {}) == "janein"
    assert f("{{fehlt|vorgabe}}", ctx, {}) == "vorgabe"
    assert f("{{json a.liste}}", ctx, {}) == '["x", "y"]'
    assert f("{{env.X}}", ctx, {"X": "1"}) == "1"
    with pytest.raises(render.RenderFehler):
        f("{{fehlt}}", ctx, {})
    with pytest.raises(render.RenderFehler):
        f("{{#if a.an}}offen", ctx, {})


def test_cli(tmp_path, monkeypatch):
    for k, v in ENV.items():
        monkeypatch.setenv(k, v)
    code = render.main(["--config", str(WURZEL / "fyos.example.yaml"), "--ziel", str(tmp_path)])
    assert code == 0
    assert (tmp_path / "openclaw.json5").exists()


def test_beispielkonfig_ist_gueltig_und_vollstaendig():
    beispiel = yaml.safe_load((WURZEL / "fyos.example.yaml").read_text(encoding="utf-8"))
    for schluessel in ("agent", "besitzer", "sprache", "grenzen", "faehigkeiten"):
        assert schluessel in beispiel
    # Alles, was die Vorgaben kennen, darf das Beispiel ueberschreiben, nichts Unbekanntes.
    assert set(beispiel) <= set(render.VORGABEN)


def test_plugins_stimmen_mit_den_ordnern_ueberein():
    ordner = {p.name for p in (WURZEL / "plugins").iterdir() if p.is_dir()}
    assert ordner == set(render.PLUGIN_IDS)
    for pid in ordner:
        manifest = json.loads((WURZEL / "plugins" / pid / "openclaw.plugin.json").read_text(encoding="utf-8"))
        assert manifest["id"] == pid


def test_freigabe_vertrag_ist_identisch():
    a = (WURZEL / "vertrag" / "freigabe_vertrag.json").read_bytes()
    b = (WURZEL / "plugins" / "fyos-freigabe-chat" / "freigabe_vertrag.json").read_bytes()
    assert a == b
    assert re.compile(json.loads(a)["kennung"]["form"]).match("CHG-12")


def test_betriebskonzept_pruefstuecke():
    regeln = yaml.safe_load((WURZEL / "vertrag" / "betriebskonzept.yaml").read_text(encoding="utf-8"))
    muster = [re.compile(m, re.I) for r in regeln["schwer"] for m in r["muster"]]
    for text in regeln["klein_beispiele"]:
        assert not any(m.search(text) for m in muster), f"sollte klein sein: {text}"
    for text in regeln["schwer_beispiele"]:
        assert any(m.search(text) for m in muster), f"sollte schwer sein: {text}"


# ── Zusatz-Plugins ohne Fork ──────────────────────────────────────────────


def _zusatz(wurzel: Path, ordner: str, pid: str | None = None) -> Path:
    d = wurzel / ordner
    d.mkdir(parents=True)
    (d / "openclaw.plugin.json").write_text(json.dumps({"id": ordner if pid is None else pid}), encoding="utf-8")
    (d / "index.mjs").write_text("export default {};\n", encoding="utf-8")
    return d


def test_zusatz_plugins_werden_geladen_ohne_rechte(tmp_path):
    extra = tmp_path / "extra"
    _zusatz(extra, "mein-zaehler")
    _zusatz(extra, "mein-filter")
    (extra / "kein-plugin").mkdir()
    konfig = tmp_path / "fyos.yaml"
    konfig.write_text(
        "zusatz_plugins:\n"
        "  mein-filter: {rechte: {gespraech: true}, config: {grenze: 3}}\n"
        "  fehlt-noch: {aktiv: true}\n",
        encoding="utf-8",
    )
    ctx = render.lade_konfig(konfig, zusatz=extra)
    render.rendere(WURZEL, ctx, tmp_path / "aus", env=ENV)
    cfg = json5lite.lade((tmp_path / "aus" / "openclaw.json5").read_text(encoding="utf-8"))
    pfade = cfg["plugins"]["load"]["paths"]
    assert pfade[-2:] == [str(extra / "mein-filter"), str(extra / "mein-zaehler")]
    eintraege = cfg["plugins"]["entries"]
    assert eintraege["mein-zaehler"] == {
        "enabled": True, "hooks": {"allowConversationAccess": False, "allowPromptInjection": False}}
    assert eintraege["mein-filter"]["hooks"]["allowConversationAccess"] is True
    assert eintraege["mein-filter"]["hooks"]["allowPromptInjection"] is False
    assert eintraege["mein-filter"]["config"] == {"grenze": 3}
    assert "fehlt-noch" not in eintraege


def test_ohne_zusatzordner_bleibt_alles_wie_es_ist(tmp_path):
    ctx = render.lade_konfig(None, zusatz=tmp_path / "gibtsnicht")
    assert ctx["zusatz_eintraege"] == []
    assert ctx["plugin_pfade"] == [f"/opt/fyos/{p}" for p in render.PLUGIN_IDS]


@pytest.mark.parametrize("ordner, pid", [("fyos-meldebudget", None), ("x", "Gross"), ("leer", "")])
def test_zusatz_plugin_mit_falscher_id_bricht_ab(tmp_path, ordner, pid):
    _zusatz(tmp_path, ordner, pid)
    with pytest.raises(render.RenderFehler):
        render.lade_konfig(None, zusatz=tmp_path)


def test_zusatz_plugin_doppelt_oder_kaputt_bricht_ab(tmp_path):
    _zusatz(tmp_path / "a", "eins", "gleich")
    _zusatz(tmp_path / "a", "zwei", "gleich")
    with pytest.raises(render.RenderFehler, match="gibt es schon"):
        render.lade_konfig(None, zusatz=tmp_path / "a")
    kaputt = tmp_path / "b" / "kaputt"
    kaputt.mkdir(parents=True)
    (kaputt / "openclaw.plugin.json").write_text("{nicht json", encoding="utf-8")
    with pytest.raises(render.RenderFehler, match="kein gueltiges Manifest"):
        render.lade_konfig(None, zusatz=tmp_path / "b")


def test_zusatzordner_aus_der_umgebung(tmp_path, monkeypatch):
    _zusatz(tmp_path, "aus-umgebung")
    monkeypatch.setenv(render.ZUSATZ_UMGEBUNG, str(tmp_path))
    assert render.lade_konfig(None)["plugin_pfade"][-1] == str(tmp_path / "aus-umgebung")


def test_oeffentliche_adresse_aus_der_umgebung_wird_erlaubter_ursprung(tmp_path, monkeypatch):
    # Ohne sie lehnt das Gateway die Control UI im Fenster der Shell ab („origin not allowed").
    monkeypatch.setenv(render.OEFFENTLICH_UMGEBUNG, "https://fyos.example.org/os/")
    ctx = render.lade_konfig(None)
    assert ctx["gateway"]["oeffentliche_url"] == "https://fyos.example.org"
    assert ctx["gateway"]["alle_urspruenge"] == ["https://fyos.example.org"]
    konfig = json5lite.lade((rendere(tmp_path, None) / "openclaw.json5").read_text(encoding="utf-8"))
    assert konfig["gateway"]["controlUi"]["allowedOrigins"] == ["https://fyos.example.org"]
    assert konfig["gateway"]["publicOrigin"] == "https://fyos.example.org"


def test_eigene_oeffentliche_adresse_geht_vor(tmp_path, monkeypatch):
    monkeypatch.setenv(render.OEFFENTLICH_UMGEBUNG, "https://umgebung.example.org")
    konfig = tmp_path / "fyos.yaml"
    konfig.write_text(yaml.safe_dump({"gateway": {"oeffentliche_url": "https://eigen.example.org"}}), encoding="utf-8")
    assert render.lade_konfig(konfig)["gateway"]["alle_urspruenge"] == ["https://eigen.example.org"]


@pytest.mark.parametrize("wert", ["", "fyos.example.org", "ftp://fyos.example.org", "http://fyos.lan:kaputt"])
def test_ohne_brauchbare_oeffentliche_adresse_keine_urspruenge(monkeypatch, wert):
    monkeypatch.setenv(render.OEFFENTLICH_UMGEBUNG, wert)
    gw = render.lade_konfig(None)["gateway"]
    assert gw["alle_urspruenge"] == [] and gw["oeffentlicher_ursprung"] == ""


@pytest.mark.parametrize("url,erwartet", [
    ("HTTPS://FYOS.Example.org:443/os/", "https://fyos.example.org"),
    ("http://localhost:80", "http://localhost"),
    ("http://nutzer:geheim@192.0.2.10:8080/", "http://192.0.2.10:8080"),
    ("http://[::1]:8080", "http://[::1]:8080"),
])
def test_ursprung_wie_der_browser_ihn_schickt(url, erwartet):
    # Das Gateway vergleicht die Allowlist nur kleingeschrieben mit dem Origin-Kopf des Browsers.
    assert render.ursprung(url) == erwartet


@pytest.mark.parametrize("url,public", [
    ("https://fyos.example.org", "https://fyos.example.org"),
    ("http://localhost:8080", "http://localhost:8080"),
    ("http://127.0.0.1:8080", "http://127.0.0.1:8080"),
    ("http://[::1]:8080", "http://[::1]:8080"),
    ("http://fyos.lan:8080", ""),
    ("http://192.0.2.10:8080", ""),
])
def test_public_origin_nur_wo_openclaw_ihn_annimmt(tmp_path, monkeypatch, url, public):
    # gateway.publicOrigin: https, http nur auf Loopback, sonst bricht der Start am Konfig-Schema ab.
    # Der Ursprung bleibt trotzdem erlaubt, damit die Control UI im Fenster der Shell laeuft.
    monkeypatch.setenv(render.OEFFENTLICH_UMGEBUNG, url)
    konfig = json5lite.lade((rendere(tmp_path, None) / "openclaw.json5").read_text(encoding="utf-8"))
    assert konfig["gateway"].get("publicOrigin", "") == public
    assert konfig["gateway"]["controlUi"]["allowedOrigins"] == [render.ursprung(url)]


def test_erlaubte_urspruenge_normalisiert_ohne_doppelte(monkeypatch, tmp_path):
    monkeypatch.setenv(render.OEFFENTLICH_UMGEBUNG, "https://fyos.example.org")
    konfig = tmp_path / "fyos.yaml"
    konfig.write_text(yaml.safe_dump({"gateway": {"erlaubte_urspruenge": [
        "https://FYOS.example.org/", "http://fyos.lan:8080", "*"]}}), encoding="utf-8")
    assert render.lade_konfig(konfig)["gateway"]["alle_urspruenge"] == [
        "https://fyos.example.org", "http://fyos.lan:8080", "*"]
