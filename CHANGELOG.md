# Änderungen

Alle nennenswerten Änderungen an fyos-agent stehen hier. Das Format folgt
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/), die Versionen folgen
[Semantic Versioning](https://semver.org/lang/de/). Die Zahlen in Klammern sind die Nummern der Pull Requests.

fyos-agent ist der Agent der Distribution FYOS: ab 0.2.0 der Runner auf pi-durable (`runner/`), davor OpenClaw mit Verhaltens-Plugins, Vorlagen und einem Vertrag. Das Repo
trägt dieselbe Versionsnummer wie das Schwester-Repo `fyos-os` und wird mit demselben Tag veröffentlicht. Der Installer
von `fyos-os` zieht die Bilder `runner` und `openclaw` mit diesem Tag. Das Plugin `fyos-bruecke` hat zusätzlich eine eigene Nummer
(0.2.0 in dieser Version).

## [0.2.0] – 2026-11-02

### Neu

- **Der Runner ist der Agent.** Unter `runner/` liegt der dauerhafte FYOS-Runner auf pi-durable (Node ≥ 22.19, Paket
  `fyos-agent`). Gespräche, Werkzeugaufrufe und Freigaben stehen in einer SQLite-Datei und überleben Neustarts. Zwei
  Betriebsarten: lokal (Desktop, ohne Hub und ssh) und voll (Server, mit Hub-Werkzeugen, Takt, Arbeitsschleife,
  Gedächtnis). Anleitung: `runner/README.md`, Vorlage: `runner/beispiele/agent-runner.beispiel.json`.
- **Lokaler Runner für die FYOS-Hülle.** `runner/lokal/` ist das Startprogramm nach dem Vertrag der Hülle,
  `runner/scripts/runner-lokal-buendel.mjs` baut ein Bündel mit eigenem Node.
- **Terminal-Client** `fyos-agent` (`runner/scripts/fyos-agent.mjs`).

### Geändert

- Rechner, auf die der Agent per ssh darf, stehen nur noch in der Konfiguration (`pi_durable.nodes`); der Code bringt
  keine mit.

### Veraltet

- **OpenClaw-Mod** (`openclaw/`, `plugins/`, `workspace/`, `fyos_agent/`). Bleibt in 0.2.x lauffähig und wird nicht
  weiterentwickelt. Entfernung frühestens in 0.3.0.

### Umstieg von OpenClaw

1. Runner installieren: `cd runner && npm ci --omit=dev`.
2. Aus `fyos.yaml` übernehmen: Modelladresse und -name nach `pi_durable.model` (`baseUrl`, `default`), Hub-Adresse nach
   `hub`, das Hub-Token als Datei nach `hub_token_datei`.
3. Ein Token für die Oberfläche anlegen (`openssl rand -hex 32 > ~/.fyos/runner/token`) und
   `node src/index.js --config agent-runner.json` starten.
4. Die Gesprächsverläufe von OpenClaw werden nicht übernommen; das Gedächtnis im Hub bleibt.
5. Den OpenClaw-Container erst stoppen, wenn der Runner im Hub als Agent gemeldet ist.

## [0.1.3] – 2026-10-22

Keine inhaltlichen Änderungen am Agenten. Die Nummer folgt der FYOS-Version, weil der Installer das Bild `openclaw`
mit dem Tag seiner eigenen Version zieht.

## [0.1.2] – 2026-10-22

Keine inhaltlichen Änderungen am Agenten. Die Nummer folgt der FYOS-Version, weil der Installer das Bild `openclaw`
mit dem Tag seiner eigenen Version zieht.

## [0.1.1] – 2026-10-11

Vorbereitet: Der Tag `v0.1.1` und die Veröffentlichung folgen nach dem Ablauf in `RELEASE.md` im Repo `fyos-os`.

### Neu

- **WhatsApp als dritter Kanal** neben Matrix und Telegram. Du schaltest ihn in `fyos.yaml` unter `kanaele` ein, baust
  das Bild mit `--build-arg FYOS_KANAELE=whatsapp` (oder `matrix,whatsapp`) und koppelst das Konto einmal per QR-Code.
  Es gelten nur Direktnachrichten des Besitzers. Freigabe-Anfragen kommen auch per WhatsApp, die Antwort als Text
  entscheidet sie. Mit
  `whatsapp.eigene_nummer` läuft der Agent auf der eigenen Nummer (Notizen an sich selbst), besser ist eine eigene
  Nummer für den Agenten (#5).
- **Dringende Mitteilung an den Besitzer.** Die Brücke bietet `fyos.kanal.mitteilen`: Der Agent schickt etwas Wichtiges
  über den ersten bereiten Kanal (Telegram, WhatsApp oder Matrix). Der Stand der Kanäle (nur an oder aus, nie die
  Adresse) steht im Status der Brücke (#6).
- **Brücke 0.2.0** (`fyos-bruecke`): Der Hub kann den Agenten wecken (`fyos.wecken`) und eine Nachricht in die
  Sitzung eines Vorgangs schreiben (`fyos.vorgang.senden`). Jeder Vorgang hat seine eigene Sitzung, Ereignisse tragen die
  Vorgangsnummer mit. Dazu kommen lesende Abfragen für Gedächtnissuche, Sitzungen, Herzschlag, Fortschrittskarte,
  Agenten und Werkzeuge. Die Kennung des Agenten steht in der Konfiguration (`agentId`) oder in `FYOS_AGENT` (#7).
- **Gedächtnis mit Vektorsuche.** Der Agent nutzt denselben Embedding-Dienst wie der Hub (`FYOS_EMBED_URL`). Ohne Dienst
  sucht er im Text und sagt das ausdrücklich. Das „aktive Gedächtnis“ (ein Teilagent sucht vor jeder Antwort) ist
  schaltbar und standardmäßig aus (#9).
- **Skill `zusagen`.** Was der Besitzer für später aufträgt („erinnere mich“, „wenn X, dann Y“), wird ein Vorgang mit
  eigenem Auslöser (Zeit, Ereignis oder Wiedervorlage). Dazu pflegt der Agent bei mehrstufiger Arbeit eine
  Fortschrittskarte je Vorgang (#10).
- **Mund und Ohr.** Sprachausgabe und Spracheingabe laufen über je einen OpenAI-kompatiblen Dienst. Beides ist optional;
  ohne Adresse bleibt es aus (`mund` und `ohr` in `fyos.yaml`, Schlüssel nur in der Umgebung) (#11).

### Geändert

- Vorgangsnummern in der Brücke erkennen neben `INC-1234` auch die Kurzkennung (`WB-1a2b3c4d`) (#8).
- Die Gitea-CI läuft täglich nach Zeitplan gegen die neuesten Pakete, auch ohne neuen Commit; je Commit gibt es genau
  einen Lauf (Zweige über den Pull Request, `main` über den Push) (#3, #4).

### Behoben

- Keine eigenständigen Fehlerkorrekturen in dieser Version.

## [0.1.0] – 2026-10-10

Erste Veröffentlichung.

### Neu

- OpenClaw als Agent mit Verhaltens-Plugins: Freigaben im Chat, Kontext-Edit, Meldebudget, Priorität, Tempo-Weiche und
  die Ersteinrichtung als Gespräch, in der der Agent den Besitzer beim ersten Mal kennenlernt.
- Matrix und Telegram als Chat-Kanäle (Vorgabe aus, nur Direktnachrichten des Besitzers).
- Die Brücke `fyos-bruecke` koppelt den Agenten an den FYOS-Hub (Workboard, Skills, Cron, Nutzung und Ereignisse ohne
  Inhalte).
- Vorlagen und Renderer, die aus `fyos.yaml` die Konfiguration, den Arbeitsordner und die Verträge erzeugen.
- Bild `openclaw` mit versionsgebundenen Korrekturen, Zusatz-Plugins ohne Fork und Werkzeugen für das Veröffentlichen
  (`tools/sauber.py`).

### Geändert

- Lizenz Apache-2.0 und englische README (#1).
- GitHub-Workflows für Tests und Bilder; die NOTICE nennt OpenClaw (#2).
