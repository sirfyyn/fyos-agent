"""Tests fuer die Ersteinrichtung als Gespraech: Entscheidung, Zustand, Workspace-Dateien und Vorlagen."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

WURZEL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WURZEL))

from fyos_agent import einrichtung, json5lite, render  # noqa: E402

ENV = {
    "FYOS_MODELL_BASIS_URL": "http://modell:8080/v1",
    "FYOS_MODELL_NAME": "mein-modell",
    "FYOS_HUB_URL": "http://hub:8080/mcp/",
}
BEISPIEL = WURZEL / "fyos.example.yaml"


class Installation:
    """Ein Zustandsverzeichnis, in dem man Starts nacheinander durchspielt (wie einstieg.sh sie ausfuehrt)."""

    def __init__(self, tmp_path: Path):
        self.state = tmp_path / "state"
        self.ziel = tmp_path / "ziel"
        self.workspace = self.state / "workspace"
        self.meldungen: list[str] = []
        self.ctx: dict = {}

    def start(self, konfig: Path | None = BEISPIEL, konfig_bleibt: bool = False) -> dict:
        self.meldungen.clear()
        self.ctx = render.lade_konfig(konfig, env=ENV, zustand=self.state, konfig_bleibt=konfig_bleibt)
        render.rendere(WURZEL, self.ctx, self.ziel, env=ENV)
        e = self.ctx["ersteinrichtung"]
        einrichtung.installiere(self.ziel, self.state, einrichtung.Entscheidung(e["offen"], e["grund"]),
                                meldung=self.meldungen.append)
        return self.ctx

    def lies(self, name: str) -> str:
        return (self.workspace / name).read_text(encoding="utf-8")

    def zustand(self) -> dict:
        return json.loads((self.state / einrichtung.ZUSTAND_DATEI).read_text(encoding="utf-8"))

    def konfig(self) -> dict:
        return json5lite.lade((self.ziel / "openclaw.json5").read_text(encoding="utf-8"))

    def wie_das_werkzeug(self, name: str = "Luna") -> None:
        """Was `fyos_ersteinrichtung` tut: USER.md und IDENTITY.md schreiben, BOOTSTRAP.md zuletzt loeschen."""
        (self.workspace / "USER.md").write_text("# Sam\n\n## Steckbrief\n- Anrede: Sam\n", encoding="utf-8")
        (self.workspace / "IDENTITY.md").write_text(f"# {name}\n- Name: {name}\n", encoding="utf-8")
        (self.workspace / "BOOTSTRAP.md").unlink()


@pytest.fixture
def inst(tmp_path):
    return Installation(tmp_path)


def yaml_datei(tmp_path: Path, text: str) -> Path:
    datei = tmp_path / "fyos.yaml"
    datei.write_text(text, encoding="utf-8")
    return datei


# ── Eine frische Installation fuehrt das Gespraech ────────────────────────


def test_frische_installation_oeffnet_die_einrichtung(inst):
    ctx = inst.start()
    assert ctx["ersteinrichtung"]["offen"] is True and ctx["ersteinrichtung"]["grund"] == "frische Installation"
    assert sorted(p.name for p in inst.workspace.iterdir()) == ["AGENTS.md", "BOOTSTRAP.md", "IDENTITY.md", "SOUL.md", "USER.md"]
    zustand = inst.zustand()
    assert zustand["ersteinrichtung"] == "offen"
    assert set(zustand["dateien"]) == {"USER.md", "IDENTITY.md", "BOOTSTRAP.md"}
    assert zustand["dateien"]["BOOTSTRAP.md"] == einrichtung.sha256(inst.workspace / "BOOTSTRAP.md")

    cfg = inst.konfig()
    # OpenClaw darf die Einrichtung nicht von sich aus als erledigt vermerken und BOOTSTRAP.md loeschen.
    assert cfg["agents"]["defaults"]["skipBootstrap"] is True
    assert cfg["plugins"]["entries"]["fyos-ersteinrichtung"] == {
        "enabled": True, "hooks": {"allowConversationAccess": False, "allowPromptInjection": False}}
    assert "/opt/fyos/fyos-ersteinrichtung" in cfg["plugins"]["load"]["paths"]
    assert "fyos*" in cfg["agents"]["entries"]["main"]["tools"]["alsoAllow"], "das Werkzeug fyos_* muss erlaubt sein"

    agents = inst.lies("AGENTS.md")
    assert "Steht BOOTSTRAP.md im Kontext, ist die Ersteinrichtung offen" in agents
    assert "Eine Begrüßung braucht weder" not in agents, "die Begrüßung ist hier der Anfang der Einrichtung"


def test_bootstrap_nennt_das_werkzeug_und_alle_fragen(inst):
    inst.start()
    text = inst.lies("BOOTSTRAP.md")
    assert "{{" not in text
    for angabe in ("fyos_ersteinrichtung", "`anrede`", "`sprache`", "`zeitzone`", "`agentenname`", "`zweck`", "`grenzen`",
                   "Europe/Berlin", "Alex", "Fy", "Deutsch"):
        assert angabe in text, angabe
    assert len(re.findall(r"^   \d\. ", text, re.M)) == 6, "sechs Fragen"


def test_bootstrap_fragt_nach_dem_namen_nur_wenn_die_konfiguration_ihn_nicht_kennt(tmp_path, inst):
    inst.start()
    assert "(Vorschlag: Alex)" in inst.lies("BOOTSTRAP.md")
    ohne_name = Installation(tmp_path / "zweite")
    ohne_name.start(None)
    text = ohne_name.lies("BOOTSTRAP.md")
    assert "Wie soll ich dich ansprechen?\n" in text and "Vorschlag: Besitzer" not in text


def test_vorlagen_und_werkzeug_sprechen_dieselbe_sprache():
    """BOOTSTRAP.md, USER.md und das Plugin muessen sich auf dieselben Namen stuetzen."""
    vorlage = (WURZEL / "workspace" / "BOOTSTRAP.md.tmpl").read_text(encoding="utf-8")
    plugin = (WURZEL / "plugins" / "fyos-ersteinrichtung" / "plugin.mjs").read_text(encoding="utf-8")
    manifest = json.loads((WURZEL / "plugins" / "fyos-ersteinrichtung" / "openclaw.plugin.json").read_text(encoding="utf-8"))
    (werkzeug,) = manifest["contracts"]["tools"]
    assert f"`{werkzeug}`" in vorlage
    for parameter in ("anrede", "sprache", "zeitzone", "agentenname", "zweck", "grenzen"):
        assert f"`{parameter}`" in vorlage and f"{parameter}:" in plugin, parameter
    # Das Werkzeug ersetzt den Abschnitt "## Steckbrief" in USER.md und die Zeile "- Name:" in IDENTITY.md.
    assert re.search(r"^## Steckbrief$", (WURZEL / "workspace" / "USER.md.tmpl").read_text(encoding="utf-8"), re.M)
    assert re.search(r"^- Name: ", (WURZEL / "workspace" / "IDENTITY.md.tmpl").read_text(encoding="utf-8"), re.M)


def test_neustart_vor_dem_gespraech_bleibt_offen(tmp_path, inst):
    inst.start()
    erster = inst.zustand()
    konfig = yaml_datei(tmp_path, "besitzer: {name: Robin}\nagent: {name: Pia}\n")
    ctx = inst.start(konfig)
    assert ctx["ersteinrichtung"]["offen"] is True
    zweiter = inst.zustand()
    assert zweiter["seit"] == erster["seit"] and zweiter["ersteinrichtung"] == "offen"
    assert (inst.workspace / "BOOTSTRAP.md").exists()
    # Solange das Gespraech aussteht, gehoeren USER.md und IDENTITY.md noch der Konfiguration.
    assert "# Robin" in inst.lies("USER.md") and "- Name: Pia" in inst.lies("IDENTITY.md")
    assert "Robin" in inst.lies("BOOTSTRAP.md") and inst.meldungen == []


# ── Der Abschluss bleibt, die Einrichtung kommt nie wieder ─────────────────


def test_abschluss_bleibt_erhalten_und_schliesst_die_einrichtung(inst):
    inst.start()
    inst.wie_das_werkzeug()
    ctx = inst.start()
    assert ctx["ersteinrichtung"] == {"offen": False, "grund": "abgeschlossen", "name_bekannt": True}
    assert inst.lies("USER.md").startswith("# Sam") and inst.lies("IDENTITY.md") == "# Luna\n- Name: Luna\n"
    assert not (inst.workspace / "BOOTSTRAP.md").exists()
    zustand = inst.zustand()
    assert zustand["ersteinrichtung"] == "geschlossen" and zustand["dateien"] == {
        "USER.md": einrichtung.GESCHUETZT, "IDENTITY.md": einrichtung.GESCHUETZT}
    assert len(inst.meldungen) == 2 and all("bleibt unberührt" in m for m in inst.meldungen)

    cfg = inst.konfig()
    assert "skipBootstrap" not in cfg["agents"]["defaults"], "danach darf OpenClaw seine Einrichtung wieder selbst vermerken"
    assert cfg["plugins"]["entries"]["fyos-ersteinrichtung"]["enabled"] is False
    assert "Eine Begrüßung braucht weder\nErsteinrichtung" in inst.lies("AGENTS.md")


def test_spaetere_starts_bleiben_still_und_geschlossen(tmp_path, inst):
    inst.start()
    inst.wie_das_werkzeug()
    inst.start()
    # AGENTS.md und SOUL.md gehoeren weiter der Konfiguration, USER.md und IDENTITY.md nicht mehr.
    konfig = yaml_datei(tmp_path, "agent: {name: Neuer Name}\nbesitzer: {name: Anders}\n")
    ctx = inst.start(konfig)
    assert ctx["ersteinrichtung"]["offen"] is False
    assert inst.meldungen == []
    assert "# Neuer Name" in inst.lies("AGENTS.md") and "Neuer Name" in inst.lies("SOUL.md")
    assert inst.lies("IDENTITY.md") == "# Luna\n- Name: Luna\n" and inst.lies("USER.md").startswith("# Sam")
    assert not (inst.workspace / "BOOTSTRAP.md").exists()


def test_geschlossen_bleibt_geschlossen_auch_wenn_bootstrap_wieder_auftaucht(inst):
    inst.start()
    inst.wie_das_werkzeug()
    inst.start()
    (inst.workspace / "BOOTSTRAP.md").write_text("# von irgendwoher\n", encoding="utf-8")
    ctx = inst.start()
    assert ctx["ersteinrichtung"]["offen"] is False
    assert not (inst.workspace / "BOOTSTRAP.md").exists()
    (restlos,) = list(inst.workspace.glob("BOOTSTRAP.vor-fyos.*.md"))
    assert restlos.read_text(encoding="utf-8") == "# von irgendwoher\n"
    assert any("verschoben" in m for m in inst.meldungen)


def test_unterbrochener_abschluss_schliesst_ebenfalls(inst):
    """USER.md ist schon geschrieben, BOOTSTRAP.md noch da: der naechste Start schliesst und raeumt die eigene Datei weg."""
    inst.start()
    (inst.workspace / "USER.md").write_text("# Sam\n", encoding="utf-8")
    ctx = inst.start()
    assert ctx["ersteinrichtung"]["offen"] is False and "USER.md" in ctx["ersteinrichtung"]["grund"]
    assert not (inst.workspace / "BOOTSTRAP.md").exists()
    assert not list(inst.workspace.glob("BOOTSTRAP.vor-fyos.*.md")), "die eigene Datei wird gelöscht, nicht aufbewahrt"
    assert inst.lies("USER.md") == "# Sam\n"


def test_von_hand_geaenderte_dateien_bleiben_auch_ohne_einrichtung(tmp_path, inst):
    (inst.workspace).mkdir(parents=True)
    (inst.workspace / "USER.md").write_text("alt\n", encoding="utf-8")
    ctx = inst.start()
    assert ctx["ersteinrichtung"] == {"offen": False, "grund": "bestehende Installation", "name_bekannt": True}
    assert inst.lies("USER.md").startswith("# Alex"), "ohne Vermerk gilt wie bisher: die Konfiguration schreibt"
    (inst.workspace / "IDENTITY.md").write_text("# Eigener Name\n- Name: Eigener Name\n", encoding="utf-8")
    inst.start()
    assert inst.lies("IDENTITY.md") == "# Eigener Name\n- Name: Eigener Name\n"
    assert any("IDENTITY.md" in m and "bleibt unberührt" in m for m in inst.meldungen)
    # Wer die Datei loescht, bekommt die Fassung der Konfiguration zurueck.
    (inst.workspace / "IDENTITY.md").unlink()
    inst.start()
    assert "- Name: Fy" in inst.lies("IDENTITY.md")
    assert inst.zustand()["dateien"]["IDENTITY.md"] == einrichtung.sha256(inst.workspace / "IDENTITY.md")


# ── Wo die Einrichtung nicht aufgeht ──────────────────────────────────────


def test_bestehende_installation_bleibt_zu(inst):
    inst.workspace.mkdir(parents=True)
    (inst.workspace / "USER.md").write_text("# Alter Besitzer\n", encoding="utf-8")
    (inst.workspace / "BOOTSTRAP.md").write_text("# Einrichtung von OpenClaw\n", encoding="utf-8")
    ctx = inst.start()
    assert ctx["ersteinrichtung"]["offen"] is False and ctx["ersteinrichtung"]["grund"] == "bestehende Installation"
    assert inst.zustand()["ersteinrichtung"] == "geschlossen"
    cfg = inst.konfig()
    assert "skipBootstrap" not in cfg["agents"]["defaults"]
    assert cfg["plugins"]["entries"]["fyos-ersteinrichtung"]["enabled"] is False
    assert "Eine Begrüßung braucht weder\nErsteinrichtung" in inst.lies("AGENTS.md")
    # Ein fremdes BOOTSTRAP.md uebersteuerte die gerenderte Identitaet: es wird wie bisher zur Seite gelegt.
    assert not (inst.workspace / "BOOTSTRAP.md").exists() and len(list(inst.workspace.glob("BOOTSTRAP.vor-fyos.*.md"))) == 1


def test_schalter_aus_haelt_die_einrichtung_zu_und_bleibt_aus(tmp_path, inst):
    aus = yaml_datei(tmp_path, "faehigkeiten: {ersteinrichtung: false}\n")
    ctx = inst.start(aus)
    assert ctx["ersteinrichtung"]["offen"] is False and "faehigkeiten.ersteinrichtung" in ctx["ersteinrichtung"]["grund"]
    assert not (inst.workspace / "BOOTSTRAP.md").exists()
    assert "skipBootstrap" not in inst.konfig()["agents"]["defaults"]
    assert "geht den Angaben in dieser Datei vor" not in inst.lies("AGENTS.md")
    # Spaeter einschalten oeffnet nichts mehr: die Installation ist laengst eingerichtet.
    ctx = inst.start(BEISPIEL)
    assert ctx["ersteinrichtung"]["offen"] is False
    assert "geht den Angaben in dieser Datei vor" in inst.lies("AGENTS.md")


def test_vorhandene_konfiguration_haelt_die_einrichtung_zu(inst):
    ctx = inst.start(konfig_bleibt=True)
    assert ctx["ersteinrichtung"]["offen"] is False and "FYOS_KONFIG_BEHALTEN" in ctx["ersteinrichtung"]["grund"]
    assert not (inst.workspace / "BOOTSTRAP.md").exists()


@pytest.mark.parametrize("inhalt", ["{kaputt", json.dumps({"ersteinrichtung": "vielleicht"}), json.dumps(["offen"])])
def test_unbrauchbarer_zustand_gilt_als_fehlend(inst, inhalt):
    inst.state.mkdir(parents=True)
    (inst.state / einrichtung.ZUSTAND_DATEI).write_text(inhalt, encoding="utf-8")
    ctx = inst.start()
    assert ctx["ersteinrichtung"]["offen"] is True, "kein Zustand, kein USER.md: frisch"
    assert inst.zustand()["ersteinrichtung"] == "offen"
    assert any("unbrauchbar" in m for m in inst.meldungen)
    # Mit vorhandenem USER.md waere es eine bestehende Installation.
    (inst.state / einrichtung.ZUSTAND_DATEI).write_text(inhalt, encoding="utf-8")
    assert inst.start()["ersteinrichtung"] == {"offen": False, "grund": "bestehende Installation", "name_bekannt": True}


# ── Rendern ohne Zustandsverzeichnis und Kommandozeile ─────────────────────


def test_ohne_zustandsverzeichnis_entscheidet_der_schalter(tmp_path):
    ctx = render.lade_konfig(BEISPIEL, env=ENV)
    assert ctx["ersteinrichtung"]["offen"] is True
    render.rendere(WURZEL, ctx, tmp_path / "an", env=ENV)
    assert (tmp_path / "an" / "workspace" / "BOOTSTRAP.md").exists()
    aus = render.lade_konfig(yaml_datei(tmp_path, "faehigkeiten: {ersteinrichtung: false}\n"), env=ENV)
    assert aus["ersteinrichtung"]["offen"] is False
    render.rendere(WURZEL, aus, tmp_path / "aus", env=ENV)
    assert not (tmp_path / "aus" / "workspace" / "BOOTSTRAP.md").exists()
    assert not (tmp_path / "aus" / "workspace" / "USER.md").read_text(encoding="utf-8").startswith("{{")


def test_cli_schreibt_workspace_und_zustand(tmp_path, monkeypatch, capsys):
    for k, v in ENV.items():
        monkeypatch.setenv(k, v)
    state = tmp_path / "state"
    code = render.main(["--config", str(BEISPIEL), "--ziel", str(tmp_path / "ziel"), "--zustand", str(state)])
    assert code == 0
    assert "ersteinrichtung: offen (frische Installation)" in capsys.readouterr().out
    assert (state / "workspace" / "BOOTSTRAP.md").exists() and (state / einrichtung.ZUSTAND_DATEI).exists()
    # Ohne --zustand bleibt der Zustand unberuehrt, es wird nur gerendert.
    leer = tmp_path / "leer"
    assert render.main(["--config", str(BEISPIEL), "--ziel", str(tmp_path / "ziel2")]) == 0
    assert not leer.exists() and not (tmp_path / "ziel2" / einrichtung.ZUSTAND_DATEI).exists()


def test_cli_konfig_bleibt(tmp_path, monkeypatch, capsys):
    for k, v in ENV.items():
        monkeypatch.setenv(k, v)
    state = tmp_path / "state"
    code = render.main(["--config", str(BEISPIEL), "--ziel", str(tmp_path / "ziel"), "--zustand", str(state), "--konfig-bleibt"])
    assert code == 0 and "ersteinrichtung: geschlossen" in capsys.readouterr().out
    assert not (state / "workspace" / "BOOTSTRAP.md").exists()


def test_zustandsdatei_ist_ein_einfaches_json(inst):
    inst.start()
    zustand = inst.zustand()
    assert set(zustand) == {"version", "ersteinrichtung", "grund", "seit", "dateien"}
    assert not list(inst.state.glob("*.tmp")), "keine vorläufigen Dateien"
    assert not list(inst.workspace.glob("*.tmp"))


def test_vorrang_von_user_und_identity_steht_in_agents_md(inst):
    inst.start()
    agents = inst.lies("AGENTS.md")
    assert "Was in USER.md oder IDENTITY.md zu Name, Anrede, Sprache und Zeitzone steht, geht den Angaben in dieser Datei vor." in agents
    assert "lockern die Grenzen unten nie" in agents
