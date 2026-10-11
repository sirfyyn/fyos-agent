English: [README.en.md](README.en.md)

# fyos-agent

Die Grundlage der Distribution **FYOS — For Your Own Sake**: das Agentenverhalten als
OpenClaw-Mod, ohne persönliche Inhalte. Kein Quell-Fork: ein Bild auf dem Upstream-Bild von
OpenClaw (per Digest festgenagelt), versionsgebundene Patches, Verhaltens-Plugins,
Workspace-Vorlagen, Verhaltensvertrag und Skills.

## Schichten

```text
fyos.yaml ──► fyos_agent/render.py ──► workspace/{AGENTS,SOUL,IDENTITY,USER}.md  (+ BOOTSTRAP.md bei der Ersteinrichtung)
                                       openclaw.json  (Gateway-Konfiguration)
openclaw/   Dockerfile, einstieg.sh, patches/ (Hash-geprüfte Eingriffe in das Upstream-Bild)
plugins/    fyos-prioritaet, fyos-freigabe-chat, fyos-meldebudget, fyos-kontext-edit,
            fyos-speed-router, fyos-bruecke, fyos-ersteinrichtung   (Image: /opt/fyos/<id>)
vertrag/    Verhaltensvertrag (Markdown) + betriebskonzept.yaml + freigabe_vertrag.json
workspace/  *.md.tmpl   config/openclaw.json5.tmpl   Vorlagen mit {{platzhaltern}}
skills/     betriebskonzept, freigabe  (OpenClaw-Skills, SKILL.md; im Bild /opt/fyos/skills, skills.load.extraDirs)
tools/      sauber.py (Sauberkeitsprüfung, siehe .sauber/)
```

Das Verhalten steht in drei Formen, die einander nicht widersprechen dürfen: Prosa
(`vertrag/`), Anweisung an das Modell (`workspace/`) und Durchsetzung unter dem Modell
(`plugins/`). Die Grenze liegt unter dem Modell, nicht in einem Prompt.

## Schnellstart

```sh
# 1. Konfiguration anlegen
cp fyos.example.yaml fyos.yaml          # Name, Besitzer, Sprache, Grenzen, Fähigkeiten anpassen

# 2. Bild bauen (aus der Repo-Wurzel)
docker build -f openclaw/Dockerfile -t fyos-agent .

# 3. Starten (Gateway auf 18789; die Shell reicht /agent unverändert durch)
docker run --rm -p 18789:18789 \
  -v "$PWD/fyos.yaml:/etc/fyos/fyos.yaml:ro" \
  -e FYOS_MODELL_BASIS_URL=http://modell:8080/v1 \
  -e FYOS_MODELL_NAME=mein-modell \
  -e FYOS_MODELL_SCHLUESSEL=geheim \
  -e FYOS_HUB_URL=http://hub:8080/mcp/ \
  -e OPENCLAW_GATEWAY_TOKEN="$(openssl rand -hex 24)" \
  fyos-agent
```

Startzeile im Bild: `ENTRYPOINT tini -- /opt/fyos/einstieg.sh`, `CMD openclaw gateway --bind lan --port 18789`.
`einstieg.sh` rendert beim Start die Vorlagen nach `~/.openclaw` (Workspace-Dateien und
`openclaw.json`; eine vorhandene Konfiguration wird als `openclaw.json.vorher` gesichert,
`FYOS_KONFIG_BEHALTEN=1` lässt sie unberührt) und reicht dann an den Upstream-Einstieg weiter.
AGENTS.md und SOUL.md schreibt jeder Start neu; USER.md und IDENTITY.md nur, solange sie noch so aussehen,
wie der Start sie zuletzt schrieb (siehe „Ersteinrichtung als Gespräch“).

| Umgebung | Bedeutung |
|---|---|
| `FYOS_CONFIG` | Pfad zu `fyos.yaml` (Vorgabe `/etc/fyos/fyos.yaml`; ohne Datei gelten die Vorgaben) |
| `FYOS_MODELL_BASIS_URL`, `FYOS_MODELL_NAME`, `FYOS_MODELL_SCHLUESSEL` | Modell als OpenAI-kompatibler Anbieter (siehe Abschnitt „Modell“) |
| `FYOS_HUB_URL` | MCP-Endpunkt des Hubs; ohne `/mcp` auch das Ziel der Ereignisse von `fyos-bruecke` |
| `OPENCLAW_GATEWAY_TOKEN` | Anmeldung am Gateway (Token); signiert auch die Ereignisse an den Hub |
| `FYOS_OEFFENTLICH_URL` | Öffentliche Adresse der Installation (wie für Hub und Shell); ohne `gateway.oeffentliche_url` in `fyos.yaml` der erlaubte Ursprung der Control UI |
| `FYOS_VORGAENGE_URL` | optional: Vorgangs-Dienst für `fyos-freigabe-chat` |
| `FYOS_EMBED_URL`, `FYOS_EMBED_MODEL`, `FYOS_EMBED_KEY` | optional: Embedding-Dienst für die Vektorsuche des Gedächtnisses (OpenAI-kompatibel, Adresse ohne `/v1`, dieselbe wie im Hub; `gedaechtnis.*` in `fyos.yaml` geht vor). Ohne ihn sucht der Agent ausdrücklich nur im Text (`memory.search.provider: none`) |
| `FYOS_MUND_URL`, `FYOS_MUND_MODEL`, `FYOS_MUND_VOICE`, `FYOS_MUND_KEY` | optional: Sprachausgabe über einen OpenAI-kompatiblen Dienst (`tts.providers.openai`, Adresse ohne `/v1`; `mund.*` in `fyos.yaml` geht vor). Ohne Adresse ist die Sprachausgabe aus |
| `FYOS_OHR_URL`, `FYOS_OHR_MODEL`, `FYOS_OHR_KEY` | optional: Spracheingabe über einen OpenAI-kompatiblen Dienst (`tools.media.models` mit Fähigkeit `audio`; `ohr.*` in `fyos.yaml` geht vor). Ohne Adresse bleibt die Voreinstellung von OpenClaw |
| `FYOS_MATRIX_HOMESERVER`, `FYOS_MATRIX_BENUTZER`, `OPENCLAW_MATRIX_TOKEN`, `FYOS_APPROVER_MATRIX_ID` | optional: Matrix-Kanal (`kanaele.matrix: true`; Bild mit `--build-arg FYOS_KANAELE=matrix` bauen) |
| `OPENCLAW_TELEGRAM_TOKEN`, `FYOS_APPROVER_TELEGRAM_ID` | optional: Telegram-Kanal (`kanaele.telegram: true`; Bot-Token und numerische Besitzer-ID, siehe Abschnitt „Telegram“; steckt schon im Basisbild, kein Build-Argument) |
| `FYOS_APPROVER_WHATSAPP_NUMBER` | optional: WhatsApp-Kanal (`kanaele.whatsapp: true`; Nummer des Besitzers im Format `+491701234567`, siehe Abschnitt „WhatsApp“; Bild mit `--build-arg FYOS_KANAELE=whatsapp` bauen, QR-Kopplung macht der Besitzer) |

Nur rendern, ohne Docker:

```sh
FYOS_MODELL_BASIS_URL=http://modell:8080/v1 FYOS_MODELL_NAME=m FYOS_HUB_URL=http://hub:8080/mcp/ \
  python3 -m fyos_agent.render --config fyos.example.yaml --ziel /tmp/fyos-ziel
```

Gateway hinter der FYOS-Shell: nginx leitet `/agent` und `/agent/*` unverändert (ohne
Präfix-Strip, mit WebSocket-Upgrade) an `http://agent:18789`. Dafür steht in der Konfiguration
`gateway.controlUi.basePath = "/agent"`, Anmeldung per Token (`OPENCLAW_GATEWAY_TOKEN`).
Die Shell streicht dabei alle Herkunftsköpfe (`Forwarded`, `X-Real-IP`, `X-Forwarded-*`): das Gateway
sieht sie als Absender und verlangt die Anmeldung wie bei jedem entfernten Gerät. Weiterleitungs-Köpfe
glaubt es nur einem Vorsatz unter `gateway.vertrauenswuerdige_proxys`, und auch dem nur, wenn er sie
überschreibt statt anhängt; sonst antwortet es mit 403 `proxy_attribution_required`. Die Einbettung
im Fenster der Shell erlaubt deren nginx (OpenClaw selbst verbietet sie). Der Browser-Ursprung muss
erlaubt sein: `gateway.oeffentliche_url`, ohne Angabe `FYOS_OEFFENTLICH_URL`, sonst meldet die
Control UI „origin not allowed“. Von selbst lässt OpenClaw nur `*.local`, `*.ts.net` und private
Adressen mit gleichem Host herein. Der Renderer schreibt die Adresse so in die Allowlist, wie der
Browser den Origin schickt (klein, ohne Pfad und Standardport). Als `gateway.publicOrigin` setzt er sie
nur bei `https` oder `http` auf localhost/Loopback, denn jede andere http-Adresse lehnt OpenClaws
Konfigurationsprüfung ab und das Gateway startet nicht. Eine LAN-Adresse wie `http://fyos.lan:8080`
bleibt also erlaubter Ursprung, aber ohne `publicOrigin`.

## Modell

Das Modell kommt über `FYOS_MODELL_BASIS_URL`, `FYOS_MODELL_NAME` und `FYOS_MODELL_SCHLUESSEL` als
OpenAI-kompatibler Anbieter: ein eigener Server oder ein Cloud-Anbieter. Cloud-Modelle werden nur mit dem
API-Schlüssel des Anbieters angebunden. Die Anmeldung mit einem Abo wie Claude Pro oder Max ist laut Anthropic <!-- sauber: ok -->
für Claude Code und andere eigene Anthropic-Apps gedacht; Anwendungen Dritter sollen per API-Schlüssel
(Claude Console oder unterstützter Cloud-Anbieter) auf Claude zugreifen und weder Abo-Anmeldungen anbieten noch
Anfragen über Abo-Zugangsdaten leiten (Quelle: [Legal and compliance, Abschnitt „Authentication and credential
use“](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)).

## Telegram

Telegram ist ein zweiter Kanal neben Matrix und steckt schon im Basisbild von OpenClaw: anders als bei
Matrix braucht das Bild kein Build-Argument. Vorgabe: aus. Mit `kanaele.telegram: true` schreibt der Renderer
einen Kanal, der nur Direktnachrichten des Besitzers annimmt: `dmPolicy: allowlist` mit genau dessen
numerischer ID (kein Pairing, niemand schaltet sich selbst frei), `groupPolicy: disabled` (der Bot reagiert in
keiner Gruppe) und `configWrites: false` (der Kanal darf die Konfiguration nicht ändern). Bot-Token und
Besitzer-ID stehen nie in `fyos.yaml`, nur in der Umgebung; fehlt eine oder ist sie ungültig, bricht das
Rendern mit einer Meldung ab, die den Namen der Variable nennt und nie ihren Wert. Matrix und Telegram lassen
sich einzeln oder zusammen einschalten.

Einrichten:

1. Bei [@BotFather](https://t.me/BotFather) mit `/newbot` einen Bot anlegen und den Token kopieren. Mit
   `/setjoingroups` auf „Disable“ lässt sich der Bot außerdem gar nicht erst in Gruppen einladen.
2. Token als `OPENCLAW_TELEGRAM_TOKEN` setzen.
3. Die numerische Telegram-ID des Besitzers herausfinden (der @-Name genügt nicht): dem Bot eine Nachricht
   schreiben und, solange das Gateway den Bot noch nicht abfragt (die Bot-API erlaubt nur eine Abfrage
   gleichzeitig), `curl "https://api.telegram.org/bot${OPENCLAW_TELEGRAM_TOKEN}/getUpdates"` aufrufen. Die ID
   steht in der Antwort unter `message.from.id`.
4. Die ID als `FYOS_APPROVER_TELEGRAM_ID` setzen (nur Ziffern), in `fyos.yaml` `kanaele: {telegram: true}`
   eintragen und das Gateway (neu) starten.
5. Dem Bot einmal schreiben: Telegram lässt einen Bot erst dann dem Besitzer schreiben.

Freigaben laufen auch über Telegram. Native Freigaben des Agenten kommen als Nachricht mit Knöpfen in die
Direktnachricht (`approvals.plugin.targets`, Knöpfe nur in Direktnachrichten). Mit `fyos-freigabe-chat` geht eine
Anfrage des Vorgangs-Dienstes zusätzlich als reine Textnachricht an Telegram, und die Antwort des Besitzers
(`genehmigt CHG-42`, `abgelehnt CHG-42`, `kommentar CHG-42: …`) entscheidet wie in Matrix ohne Modellaufruf; es
genügt, wenn ein Kanal zustellt. Die Reaktions-Knöpfe sind eine Matrix-Eigenheit und fehlen in Telegram.

## WhatsApp

WhatsApp ist der dritte Kanal. OpenClaw koppelt sich als „verknüpftes Gerät“ (WhatsApp Web) per QR-Code; es gibt
weder ein Token noch einen Bot-Zugang. Das Paket `@openclaw/whatsapp` gehört nicht zum Basisbild und wird
wie Matrix beim Bau auf die Basisversion festgenagelt installiert: `--build-arg FYOS_KANAELE=whatsapp` (oder
`matrix,whatsapp`). Vorgabe: aus. Mit `kanaele.whatsapp: true` schreibt der Renderer einen Kanal, der nur
Direktnachrichten der Nummer des Besitzers annimmt: `dmPolicy: allowlist` mit genau dieser Nummer (kein
Pairing: wer sonst schreibt, wird verworfen und löst keine Kopplungsanfrage aus), `groupPolicy: disabled`,
`configWrites: false` und `pluginHooks.messageReceived: false` (andere Plugins sehen keine eingehenden Inhalte).
Die Nummer des Besitzers steht nie in `fyos.yaml`, nur in der Umgebung (`FYOS_APPROVER_WHATSAPP_NUMBER`, mit `+` und
Ländervorwahl, sonst bricht das Rendern mit einer Meldung ab, die den Namen der Variable nennt und nie ihren Wert).
Matrix, Telegram und WhatsApp lassen sich einzeln oder zusammen einschalten.

Einrichten:

1. Eine eigene Nummer für den Agenten besorgen (empfohlen: eine zweite SIM oder eSIM und WhatsApp darauf, getrennt
   vom privaten Konto). Wer den Agenten auf der privaten Nummer laufen lassen will, setzt zusätzlich
   `whatsapp: {eigene_nummer: true}`; dann gelten Nachrichten an sich selbst als Eingabe.
2. Das Bild mit `--build-arg FYOS_KANAELE=whatsapp` bauen. Das Zustandsverzeichnis `~/.openclaw` muss auf einem Volume
   liegen: die Kopplung steht danach unter `~/.openclaw/credentials/whatsapp/default/`.
3. Die Nummer des Besitzers als `FYOS_APPROVER_WHATSAPP_NUMBER` setzen (`+491701234567`-Schreibweise), in `fyos.yaml`
   `kanaele: {whatsapp: true}` eintragen und das Gateway (neu) starten.
4. **Die Kopplung macht der Besitzer selbst** (dazu braucht es das Telefon): im Container
   `openclaw channels login --channel whatsapp` aufrufen und den QR-Code in WhatsApp unter „Verknüpfte Geräte“
   scannen. Der Code läuft schnell ab; das Terminal muss den QR-Code lesbar zeigen. Prüfen mit
   `openclaw channels status --probe`.
5. Dem Agenten von der Besitzer-Nummer aus schreiben. Eine Nachricht vom Agenten an den Besitzer geht erst, wenn die
   Kopplung steht (das Gateway läuft und das Konto ist verknüpft); sonst schlägt das Senden sofort fehl.

Freigaben laufen auch über WhatsApp. Native Freigaben des Agenten kommen als Nachricht, die der Besitzer mit 👍
oder 👎 beantwortet (`approvals.plugin.targets`). Mit `fyos-freigabe-chat` geht eine Anfrage des Vorgangs-Dienstes
zusätzlich als reine Textnachricht an WhatsApp (über die Schnittstelle des Gateways im selben Container, angemeldet
mit `OPENCLAW_GATEWAY_TOKEN`; ohne gekoppelte Sitzung schlägt nur dieser Kanal fehl), und die Antwort des Besitzers
(`genehmigt CHG-42`, `abgelehnt CHG-42`, `kommentar CHG-42: …`) entscheidet wie in Matrix ohne Modellaufruf; es
genügt, wenn ein Kanal zustellt.

Weitere Kanäle, die OpenClaw selbst kann (Signal über signal-cli, Slack, Discord, iMessage, Microsoft Teams u. a.),
sind hier nicht vorbereitet; sie ließen sich auf demselben Weg ergänzen (Zusatzpaket beim Bau, `kanaele.<name>`,
Bindung, Besitzer-Allowlist).

## Ersteinrichtung als Gespräch

Beim ersten Gespräch einer frischen Installation lernt der Agent den Besitzer kennen, statt dass alles vorab in
`fyos.yaml` stehen muss: Er stellt in einer einzigen Nachricht ein paar Fragen (Anrede oder Name, Sprache,
Zeitzone, wofür er da sein soll, zusätzliche Grenzen, Name des Agenten), jede mit einem Vorschlag aus der
Konfiguration, sodass „passt so“ genügt. Aus den Antworten füllt er USER.md und IDENTITY.md; danach endet das
Ritual und wiederholt sich nicht. Beginnt der Besitzer gleich mit einer Aufgabe, kommt sie zuerst; will er die
Fragen nicht beantworten, gelten die Vorschläge. Schalter: `faehigkeiten.ersteinrichtung` (Vorgabe `true`;
`false` lässt USER.md und IDENTITY.md wie bisher aus `fyos.yaml` entstehen).

So läuft es:

- Beim Start entscheidet der Renderer (`fyos_agent/einrichtung.py`), ob die Einrichtung offen ist: nur bei einer
  frischen Installation (noch kein Zustand, kein USER.md im Workspace) und eingeschaltetem Schalter. Eine
  bestehende Installation bleibt, wie sie ist; dort hat OpenClaw die Einrichtung längst als erledigt vermerkt.
  Der Zustand steht in `~/.openclaw/fyos-agent-zustand.json`.
- Offen heißt: `BOOTSTRAP.md` (das Gespräch) liegt im Workspace, `agents.defaults.skipBootstrap` ist an (OpenClaw
  legt dann weder eigene Starterdateien an noch vermerkt es die Einrichtung selbst als erledigt und löscht die
  Datei) und das Plugin `fyos-ersteinrichtung` ist an. Es liefert das Werkzeug `fyos_ersteinrichtung`, denn der
  Agent hat sonst kein Schreibwerkzeug.
- Der Aufruf schreibt USER.md (Abschnitt „Steckbrief“) und IDENTITY.md (Name) und löscht `BOOTSTRAP.md` zuletzt.
  Damit ist die Einrichtung sofort beendet, denn offen ist sie nur, solange `BOOTSTRAP.md` da ist. Beim nächsten
  Start fällt `skipBootstrap` weg und das Plugin ist aus; nichts davon kommt wieder.
- USER.md und IDENTITY.md überschreibt der Start nur, solange sie so aussehen, wie er sie zuletzt schrieb (der
  Zustand merkt sich die Prüfsummen). Was der Agent eintrug oder jemand von Hand änderte, bleibt stehen; wer die
  Datei löscht, bekommt die Fassung aus `fyos.yaml` zurück.
- Mit `FYOS_KONFIG_BEHALTEN=1` und vorhandener Konfiguration bleibt die Einrichtung zu: Diese Konfiguration kennt
  das Plugin nicht.
- Wiederholen lässt sich die Einrichtung nur mit einem frischen Zustandsverzeichnis (neues Volume). OpenClaw
  vermerkt in seiner Datenbank, dass sie erledigt ist; Dateien zu löschen öffnet sie nicht wieder.

Grenzen: Die Antworten stehen in USER.md und IDENTITY.md. AGENTS.md und SOUL.md nennen weiter die Namen aus
`fyos.yaml`; AGENTS.md sagt dem Agenten ausdrücklich, dass USER.md und IDENTITY.md zu Name, Anrede, Sprache und
Zeitzone vorgehen und dass zusätzliche Grenzen nur hinzukommen, die festen nie lockern. Ruhezeiten des
Meldebudgets (`zeitzone`) und die Sprache der Oberfläche (`sprache_code`) folgen weiter `fyos.yaml`.

## Tests

```sh
python3 -m pytest tests -q                       # Renderer, Vorlagen, Vertragsdateien (PyYAML, pytest)
node --test plugins/*/*.test.mjs                 # Plugin-Logik ohne Gateway
python3 tools/sauber.py .                        # keine persönlichen Inhalte
```

## Plugins

| Plugin | Aufgabe | Standard |
|---|---|---|
| `fyos-prioritaet` | Werkzeug `fyos_conversation_status`, 15-Minuten-Nachlauf, dauerhafter Zustand | an |
| `fyos-meldebudget` | höchstens N proaktive Meldungen pro Tag, Ruhezeiten, im Hook `message_sending` | an |
| `fyos-freigabe-chat` | Chat-/Matrix-/Telegram-/WhatsApp-Antwort des Besitzers entscheidet eine offene Freigabe, ohne Modellaufruf | an, wenn `faehigkeiten.vorgaenge: true` und `FYOS_VORGAENGE_URL` gesetzt |
| `fyos-kontext-edit` | Experiment: Agent bereinigt eigene Werkzeugergebnisse | aus |
| `fyos-speed-router` | optional: kurze Plauderturns an ein kleines Modell | aus (braucht `tempo_router.ziel_modell`) |
| `fyos-bruecke` | Kopplung an den Hub: Werkzeug- und Modellaufrufe, Läufe, Sitzungen, Cron, Skills als Ereignisse ohne Inhalte an den Hub; Route `/plugins/fyos-bruecke/v1/rpc` für Workboard, Skills, Cron und Nutzung (feste Methodenliste) | an (`kopplung.aktiv`) |
| `fyos-ersteinrichtung` | Werkzeug `fyos_ersteinrichtung`: trägt die Antworten der Ersteinrichtung in USER.md und IDENTITY.md ein und beendet sie | an, solange die Ersteinrichtung offen ist (`faehigkeiten.ersteinrichtung`, nur frische Installation) |

Mit `kopplung.workboard` (Vorgabe an) schaltet die Vorlage das mitgelieferte Workboard ein und gibt dem Agenten
die Werkzeuge zum Lesen, Anlegen, Kommentieren und Verschieben von Karten (kein Worker-Protokoll). Der Hub zeigt
die Karten als Vorgänge oder spiegelt einen vorhandenen Vorgangs-Dienst darauf; der Vertrag steht in
`fyos-os/docs/KOPPLUNG-OPENCLAW.md`.

Der Vorgangs-Dienst hinter `fyos-freigabe-chat` ist eine kleine HTTP-API
(`GET /tickets?status=waiting_approval`, `POST /tickets/{id}/comments`, `PATCH /tickets/{id}`),
beschrieben in `plugins/fyos-freigabe-chat/board.mjs`.

### Eigene Plugins ohne Fork

Jeder Ordner mit `openclaw.plugin.json` unter `/opt/fyos-extra` (oder `$FYOS_AGENT_PLUGINS`) wird beim
Start geladen: als Volume oder im abgeleiteten Bild mit
`COPY --chown=node:node mein-plugin/ /opt/fyos-extra/mein-plugin/`. Der Einstieg verlinkt das SDK
(`node_modules/openclaw` → `/app`) und trägt das Plugin ohne Einblick ins Gespräch und ohne
Prompt-Recht ein; beides gibt `zusatz_plugins.<id>.rechte` in `fyos.yaml` ausdrücklich frei. Eine ID,
die es schon gibt, oder ein kaputtes Manifest lassen das Rendern scheitern. Ausführlich:
`fyos-os/docs/ERWEITERN.md`, §5.2.

### Spätere Stufe: Schleifen-Läufer

Die Läufer für Arbeits-, Erkunden- und Gedächtnisschleife sind **nicht** Teil dieser Stufe. Sie
sind eng an einen Vorgangs-Dienst, ein Git-Hosting, bestimmte Hub-Werkzeuge
(Kandidatenauswahl, Prüfläufe, Einstufung) und die Geräte einer Installation gebunden. Ein
allgemeiner `plugins/fyos-schleifen/` entsteht erst, wenn sich der Hub-Vertrag (Werkzeugnamen per
Konfiguration, Signale „Besitzer aktiv“) sauber und installationsunabhängig fassen lässt. Das
Betriebskonzept (`vertrag/betriebskonzept.yaml`) ist dafür schon vorbereitet.

## Upstream-Update

Das Basisbild steht per Digest in `openclaw/Dockerfile`; die Patches prüfen den SHA-256 der
Upstream-Datei vor und nach dem Eingriff und brechen den Bau bei Abweichung ab.

1. Neuen Digest eintragen (`FROM ghcr.io/openclaw/openclaw@sha256:…`) und die Matrix-Version
   (`@openclaw/matrix@<version>`) angleichen.
2. Aus `/app/dist` des **veröffentlichten Bildes** (nicht aus dem npm-Tarball) die Dateien der
   Pläne neu bestimmen: `openclaw/patches/settled-finalization-fallback.json` und
   `stale-terminal-fence-fix.json` (`targets[].file`, `before`, `after`, `replacement`). Hash:
   `sha256sum`. Der zweite Plan ist gegen die Ausgabe des ersten geplant (`before` der
   gemeinsamen Datei = `after` des ersten).
3. Ist ein Fehler im neuen Upstream behoben, den Patch samt Eintrag im Dockerfile entfernen
   statt neu zu planen.
4. Prüfen, ob der Upstream-Einstieg (`docker-entrypoint.mjs`) noch `openclaw doctor --fix`
   ausführt und `CMD` unverändert gilt; bauen; `openclaw.json5.tmpl` gegen die neue Version
   halten (`meta.lastTouchedVersion`).

Stand: OpenClaw 2026.9.7, Basis-Digest `sha256:0da12cd4…1dbcfc`.

Details zu den Patches: `openclaw/README.md`.

## Lizenz

FYOS Agent steht unter der Apache License, Version 2.0 (SPDX-Kennung `Apache-2.0`).

Copyright 2026 sirfyyn and FYOS CONTRIBUTORS <!-- sauber: ok -->

Der vollständige Lizenztext steht in [`LICENSE`](LICENSE), der Urheberhinweis in [`NOTICE`](NOTICE).
