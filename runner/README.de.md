English: [README.md](README.md)

# fyos-agent Runner

Der Agent von FYOS ab 0.2.0: ein dauerhafter Runner auf
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable). Gespräche, Werkzeugaufrufe und Freigaben
liegen in einer SQLite-Datei und überleben jeden Neustart. Der Runner spricht ein OpenAI-kompatibles Modell an,
holt Werkzeuge aus dem FYOS-Hub (MCP) und fragt vor jedem schreibenden Schritt nach einer Freigabe.

Der Ordner wird aus dem FYOS-Monorepo erzeugt (`scripts/ops/release/agent_abzug.py`). Änderungen bitte dort, nicht hier.

## Zwei Betriebsarten

| Art | Start | Was läuft |
|---|---|---|
| **Lokal** (Desktop) | `lokal/runner-lokal` oder `FYOS_RUNNER_LOKAL=1 node src/lokal.js` | Runner, Gespräche, Werkzeuge, Freigaben, Weboberfläche. Kein Hub, keine Rechner per ssh, kein Browser. |
| **Voll** (Server) | `node src/index.js --config agent-runner.json` | Dazu Hub-Werkzeuge, Takt, Arbeitsschleife, Gedächtnis, Browser, Freigabe-Meldungen. |

## Schnellstart (lokal)

```sh
npm ci --omit=dev
mkdir -p ~/.fyos/runner && openssl rand -hex 32 > ~/.fyos/runner/token
FYOS_RUNNER_DATEN="$HOME/.fyos/runner" \
FYOS_RUNNER_PORT=18438 \
FYOS_LOKAL_MODELL_URL=http://127.0.0.1:8081/v1 \
FYOS_LOKAL_MODELL_ID=mein-modell \
FYOS_RUNNER_TOKEN="$(cat ~/.fyos/runner/token)" \
node lokal/starten.mjs
```

Die Oberfläche steht danach unter `http://127.0.0.1:18438/` (Anmeldung mit dem Token). Der Terminal-Client:
`node scripts/fyos-agent.mjs`. Ein Bündel mit eigenem Node für die FYOS-Hülle baut `node scripts/runner-lokal-buendel.mjs`.

## Volle Konfiguration

Vorlage: `beispiele/agent-runner.beispiel.json`. Pfad per `--config` oder `FYOS_RUNNER_CONFIG`. Ohne Token startet der
Runner nicht, weil er Befehle ausführt. Rechner, auf die er per ssh darf, stehen nur in `pi_durable.nodes`; im Code
sind keine hinterlegt.

Der eingebaute Tagesrhythmus (`takt`: Morgen, Abend, Nacht, Nachtwerkstatt) ist für einen bestimmten Alltag gebaut; die
Vorlage schaltet ihn mit `"takt": {"an": false}` aus. Eigene Einträge stehen unter `takt.eintraege`.

## Sprache

`pi_durable.sprache` (`de` | `en`) legt die Sprache von allem fest, was ein Mensch liest (Weboberfläche, Fehler der API,
Freigabe-Meldungen über Matrix/ntfy, Terminal-Client), und die der eigenen Prompt-Abschnitte und Werkzeugbeschreibungen
des Runners. Werkzeugnamen bleiben in beiden Sprachen gleich (Vertrag mit dem Hub). Vorlage, Container-Bild
(`FYOS_RUNNER_SPRACHE=en`) und lokaler Modus sind englisch; ohne Einstellung bleibt der volle Modus deutsch. Start-Logs
sind deutsch.

| Umgebung | Bedeutung |
|---|---|
| `FYOS_RUNNER_CONFIG` | Pfad zur Konfiguration |
| `FYOS_RUNNER_TOKEN`, `FYOS_RUNNER_PORT`, `FYOS_RUNNER_HOST` | Anmeldung und Adresse der Oberfläche |
| `FYOS_RUNNER_CONTAINER` | `1` im Bild: Bindung an alle Adressen erlaubt, nur mit Token |
| `FYOS_RUNNER_LOKAL` | `1` schaltet den lokalen Modus ein |
| `FYOS_RUNNER_SPRACHE` | `de` oder `en`: Sprache der Texte und Prompts (vor `pi_durable.sprache`) |
| `FYOS_LOKAL_MODELL_URL`, `FYOS_LOKAL_MODELL_ID`, `FYOS_LOKAL_MODELL_KEY(_DATEI)` | Modell im lokalen Modus |
| `FYOS_MODELL_BASIS_URL`, `FYOS_MODELL_NAME`, `FYOS_MODELL_SCHLUESSEL` | Modell im vollen Modus (wie im Installer) |
| `FYOS_HUB_AGENT_TOKEN` | Token für den Hub (sonst `hub_token_datei`) |
| `FYOS_PROVIDER_KETTE` | Reihenfolge der Modelle, wenn eines ausfällt |

## Prüfen

```sh
npm ci && npm test
```

Lizenz: Apache-2.0.
