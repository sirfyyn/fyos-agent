# fyos-agent: Mod auf das Upstream-Bild von OpenClaw. Kein Quell-Fork.
# Bauen aus der Repo-Wurzel:  docker build -f openclaw/Dockerfile -t fyos-agent .
#
# Das Basisbild ist per Digest festgenagelt (OpenClaw 2026.9.7). Ein neuer Digest braucht
# neue Patch-Hashes (siehe README, Abschnitt „Upstream-Update“).
FROM ghcr.io/openclaw/openclaw@sha256:0da12cd49983fcb5e4915fd3135ce7a33d82f93649b1df6964946d2c1d1dbcfc
USER root

# Versionsgebundene Korrekturen. Jede prueft den Hash der Upstream-Datei vor und nach dem
# Eingriff; ein Upstream-Drift laesst den Bau fehlschlagen statt unscharf zu patchen.
#  1. Fallback-Text nach einem abgeschlossenen Werkzeuglauf (Upstream: englischer Standardtext).
#  2. Historische Terminal-Marker einer Neustart-Wiederaufnahme frieren spaetere Direkt-Eingaben nicht mehr ein.
# Der zweite Patch ist gegen die Ausgabe des ersten geplant; die Reihenfolge ist Teil des Vertrags.
COPY openclaw/patches/ /opt/fyos/openclaw-patches/
RUN node /opt/fyos/openclaw-patches/apply-settled-finalization-fallback.mjs /app \
    && node /opt/fyos/openclaw-patches/apply-stale-terminal-fence-fix.mjs /app

# Der Renderer braucht Python mit PyYAML.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 python3-yaml \
    && rm -rf /var/lib/apt/lists/*

# Zusaetzliche Kanaele, kommagetrennt (heute: matrix, whatsapp). Standard: keiner.
#   docker build --build-arg FYOS_KANAELE=matrix,whatsapp -f openclaw/Dockerfile .
# Aktiv wird ein Kanal erst, wenn fyos.yaml ihn unter kanaele setzt. Telegram steckt im Basisbild von
# OpenClaw (Paket @openclaw/telegram, "included in OpenClaw") und braucht deshalb kein Build-Argument.
# WhatsApp laeuft als Zusatzpaket (@openclaw/whatsapp, bringt Baileys mit) und wird wie Matrix auf die
# Basisversion festgenagelt. Alle Pakete landen im selben Ordner ~/.openclaw/npm und werden danach einmal kopiert.
# Der Ordner entsteht als root und gehoert dann node: unter /opt darf node nichts anlegen.
ARG FYOS_KANAELE=""
RUN mkdir -p /opt/openclaw-npm && chown node:node /opt/openclaw-npm
USER node
RUN case ",${FYOS_KANAELE}," in *,matrix,*) \
         openclaw plugins install @openclaw/matrix@2026.9.7 ;; \
       esac \
    && case ",${FYOS_KANAELE}," in *,whatsapp,*) \
         openclaw plugins install @openclaw/whatsapp@2026.9.7 ;; \
       esac \
    && if [ -d /home/node/.openclaw/npm ]; then cp -a /home/node/.openclaw/npm/. /opt/openclaw-npm/; fi

USER root
# Verhaltens-Plugins unter /opt/fyos/<id>. `openclaw/plugin-sdk/...` muss aufloesbar sein,
# sonst laedt das Gateway das Plugin nicht; dafuer der Symlink auf /app.
COPY plugins/ /opt/fyos/
RUN for d in /opt/fyos/fyos-*/; do \
      mkdir -p "$d/node_modules" && ln -s /app "$d/node_modules/openclaw"; \
    done \
    && find /opt/fyos -name '*.test.mjs' -delete \
    && mkdir -p /opt/fyos-extra && chown node:node /opt/fyos-extra
# Zusatz-Plugins ohne Fork: abgeleitetes Bild mit  COPY --chown=node:node mein-plugin/ /opt/fyos-extra/mein-plugin/
# oder ein Volume auf /opt/fyos-extra. Der Einstieg traegt jeden Ordner mit openclaw.plugin.json ein.

# Renderer, Vorlagen, Vertrag, Skills und Einstieg.
COPY fyos_agent/ /opt/fyos/fyos_agent/
COPY workspace/ /opt/fyos/vorlagen/workspace/
COPY config/ /opt/fyos/vorlagen/config/
COPY vertrag/ /opt/fyos/vertrag/
COPY skills/ /opt/fyos/skills/
COPY fyos.example.yaml /etc/fyos/fyos.example.yaml
COPY openclaw/einstieg.sh /opt/fyos/einstieg.sh
RUN chmod 0755 /opt/fyos/einstieg.sh

USER node
ENV FYOS_CONFIG=/etc/fyos/fyos.yaml
EXPOSE 18789
# Der Upstream-Einstieg ist tini; unser Einstieg rendert und reicht dann an den
# Upstream-Einstieg weiter. CMD ist die Startzeile des Gateways (Port 18789 im Container-Netz,
# die Shell reicht /agent unveraendert durch).
ENTRYPOINT ["tini", "--", "/opt/fyos/einstieg.sh"]
CMD ["openclaw", "gateway", "--bind", "lan", "--port", "18789"]
