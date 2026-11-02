# Bild des Persona Runners als öffentlicher Agent `fyos-agent/runner` (Release 0.2). Im Monorepo gebaut nur zum Prüfen;
# Hauptserver startet den Runner weiter als Dienst (fyos-pi-durable.service).
#
#   docker build -t fyos-agent/runner .
#   docker run --rm -p 18438:18438 -e FYOS_RUNNER_TOKEN="$(openssl rand -hex 32)" \
#     -v "$PWD/agent-runner.json:/etc/fyos/agent-runner.json:ro" -v fyos-runner:/home/node/.fyos fyos-agent/runner
FROM node:22.20.0-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini git openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/fyos-agent
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts && npm cache clean --force
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY beispiele ./beispiele
# Zustand (SQLite, Token, Bilder) unter ~/.fyos: der Ordner muss im Bild dem Benutzer node gehören, sonst legt Docker ein
# benanntes Volume dort als root an und der Runner kann seine Datenbank nicht öffnen (Trockenlauf 02.11.2026).
RUN mkdir -p /home/node/.fyos && chown node:node /home/node/.fyos

USER node
# Im Container auf allen Adressen, aber nur mit Token (FYOS_RUNNER_TOKEN, mindestens 32 Zeichen; src/config.js bindungPruefen)
ENV FYOS_RUNNER_CONFIG=/etc/fyos/agent-runner.json FYOS_RUNNER_CONTAINER=1 FYOS_RUNNER_HOST=0.0.0.0
EXPOSE 18438
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
