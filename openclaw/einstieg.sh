#!/bin/sh
# Einstieg des fyos-agent-Bildes: rendert Workspace und Gateway-Konfiguration aus fyos.yaml
# und startet danach das Upstream-Gateway.
#
# Umgebung:
#   FYOS_CONFIG              Pfad zu fyos.yaml (Vorgabe /etc/fyos/fyos.yaml; fehlt sie, gelten die Vorgaben)
#   FYOS_MODELL_BASIS_URL    OpenAI-kompatible Basis-URL des Modells (Pflicht)
#   FYOS_MODELL_NAME         Modellname (Pflicht)
#   FYOS_MODELL_SCHLUESSEL   API-Schluessel, wird nie auf Platte geschrieben (vom Gateway gelesen)
#   FYOS_HUB_URL             MCP-Endpunkt des Hubs, z. B. http://hub:8080/mcp/ (Pflicht; ohne /mcp auch Ziel von fyos-bruecke)
#   OPENCLAW_GATEWAY_TOKEN   Gateway-Token (Pflicht fuer die Anmeldung der Shell; signiert die Ereignisse an den Hub)
#   FYOS_KONFIG_BEHALTEN=1   vorhandene openclaw.json nicht ueberschreiben (die Ersteinrichtung bleibt dann zu)
#   FYOS_UPSTREAM_ENTRYPOINT Einstieg des Upstream-Bildes (Vorgabe docker-entrypoint.mjs)
#   FYOS_AGENT_PLUGINS       Ordner mit Zusatz-Plugins (Vorgabe /opt/fyos-extra)
set -eu

STATE="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"
CONFIG="${FYOS_CONFIG:-/etc/fyos/fyos.yaml}"
VORLAGEN="${FYOS_VORLAGEN:-/opt/fyos/vorlagen}"
ZIEL="$(mktemp -d)"

mkdir -p "$STATE/workspace"

# Beim Bau installierte Kanal-Plugins (FYOS_KANAELE) liegen unter /opt/openclaw-npm. Das
# Zustandsverzeichnis ist zur Laufzeit meist ein Volume und verdeckt den Stand aus dem Bild,
# deshalb bei jedem Start nachziehen.
if [ -n "$(ls -A /opt/openclaw-npm 2>/dev/null)" ]; then
  mkdir -p "$STATE/npm"
  cp -a /opt/openclaw-npm/. "$STATE/npm/"
fi

# Zusatz-Plugins ohne Fork (FYOS_AGENT_PLUGINS, Vorgabe /opt/fyos-extra): jeder Unterordner mit
# openclaw.plugin.json. `openclaw/plugin-sdk/...` muss aufloesbar sein wie bei den eingebauten Plugins.
EXTRA="${FYOS_AGENT_PLUGINS:-/opt/fyos-extra}"
export FYOS_AGENT_PLUGINS="$EXTRA"
for d in "$EXTRA"/*/; do
  [ -f "${d}openclaw.plugin.json" ] || continue
  [ -e "${d}node_modules/openclaw" ] && continue
  if ! { mkdir -p "${d}node_modules" && ln -s /app "${d}node_modules/openclaw"; } 2>/dev/null; then
    echo "einstieg: ${d} braucht node_modules/openclaw -> /app (Ordner schreibbar machen oder im Bild anlegen)" >&2
  fi
done

# Bleibt die vorhandene Konfiguration, kennt sie das Werkzeug der Ersteinrichtung nicht: dann bleibt sie zu.
KONFIG_BLEIBT=""
if [ "${FYOS_KONFIG_BEHALTEN:-0}" = "1" ] && [ -s "$STATE/openclaw.json" ]; then
  KONFIG_BLEIBT="--konfig-bleibt"
fi

# Der Renderer schreibt auch die Workspace-Dateien nach $STATE/workspace (siehe fyos_agent/einrichtung.py):
#  - AGENTS.md und SOUL.md gehoeren der Konfiguration: jeder Start schreibt sie neu.
#  - USER.md und IDENTITY.md ebenso, solange sie so aussehen wie zuletzt geschrieben; was der Agent in der
#    Ersteinrichtung eintrug oder jemand von Hand aenderte, bleibt stehen.
#  - BOOTSTRAP.md (das Kennenlern-Gespraech) gibt es nur beim allerersten Start einer frischen Installation;
#    sonst wird es entfernt, denn ein Einrichtungs-Gespraech wuerde die gerenderte Identitaet uebersteuern.
if [ -f "$CONFIG" ]; then
  PYTHONPATH=/opt/fyos python3 -m fyos_agent.render --config "$CONFIG" --ziel "$ZIEL" --vorlagen "$VORLAGEN" \
    --zustand "$STATE" $KONFIG_BLEIBT
else
  echo "einstieg: keine Konfiguration unter $CONFIG, es gelten die Vorgaben" >&2
  PYTHONPATH=/opt/fyos python3 -m fyos_agent.render --ziel "$ZIEL" --vorlagen "$VORLAGEN" \
    --zustand "$STATE" $KONFIG_BLEIBT
fi

if [ -n "$KONFIG_BLEIBT" ]; then
  echo "einstieg: vorhandene openclaw.json bleibt (FYOS_KONFIG_BEHALTEN=1)" >&2
else
  if [ -s "$STATE/openclaw.json" ]; then
    cp "$STATE/openclaw.json" "$STATE/openclaw.json.vorher"
  fi
  cp "$ZIEL/openclaw.json5" "$STATE/openclaw.json"
  chmod 600 "$STATE/openclaw.json"
fi
rm -rf "$ZIEL"

# Das Upstream-Bild startet das Gateway ueber seinen Einstieg (fuehrt vorher `openclaw doctor --fix`
# aus) mit dem Befehl aus CMD: openclaw gateway --bind lan --port 18789
UPSTREAM="${FYOS_UPSTREAM_ENTRYPOINT:-docker-entrypoint.mjs}"
if command -v "$UPSTREAM" >/dev/null 2>&1; then
  exec "$UPSTREAM" "$@"
fi
echo "einstieg: Upstream-Einstieg $UPSTREAM nicht gefunden, starte den Befehl direkt" >&2
exec "$@"
