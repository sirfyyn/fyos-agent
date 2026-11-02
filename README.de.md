[![FLE Link: run an agent next to your model](https://flelink.run/media/banner-agent.jpg)](https://flelink.run)

English: [README.md](README.md)

# fyos-agent

Der Agent der Distribution **FYOS — For Your Own Sake**: ein dauerhafter Runner auf
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable). Gespräche, Werkzeugaufrufe und Freigaben stehen
in einer SQLite-Datei und überleben jeden Neustart. Der Runner spricht ein OpenAI-kompatibles Modell an, holt Werkzeuge
aus dem FYOS-Hub (MCP) und fragt vor jedem schreibenden Schritt nach einer Freigabe.

| Ordner | Inhalt |
|---|---|
| [`runner/`](runner/README.de.md) | der Runner: Quelle, Weboberfläche, Tests, Vorlage, Dockerfile (Bild `fyos-agent/runner`) |
| `runner/lokal/` | Startprogramm des lokalen Modus für die FYOS-Hülle |
| `tools/` | `sauber.py` (Sauberkeitsprüfung, siehe `.sauber/`) |

Anleitung, Schnellstart und Umgebung: [`runner/README.de.md`](runner/README.de.md). Eingerichtet wird der Agent meist über den
Installer aus dem Schwester-Repo `fyos-os` (`fyos-install`), der das Bild mit dem Tag seiner Version zieht. Beide Repos
tragen dieselbe Versionsnummer.

Bis 0.2.0 enthielt dieses Repo zusätzlich einen OpenClaw-Mod; seit 0.2.1 ist der Runner der einzige Agent
([CHANGELOG](CHANGELOG.md)).

Lizenz: Apache-2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)).
