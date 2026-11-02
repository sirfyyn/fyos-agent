Deutsch: [README.md](README.md)

# fyos-agent Runner

The FYOS agent from 0.2.0 on: a durable runner on
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable). Conversations, tool calls and approvals live
in one SQLite file and survive every restart. The runner talks to an OpenAI-compatible model, takes its tools from
the FYOS hub (MCP) and asks for approval before every writing step.

This folder is generated from the FYOS monorepo (`scripts/ops/release/agent_abzug.py`). Please change things there.

## Two modes

| Mode | Start | What runs |
|---|---|---|
| **Local** (desktop) | `lokal/runner-lokal` or `FYOS_RUNNER_LOKAL=1 node src/lokal.js` | Runner, conversations, tools, approvals, web UI. No hub, no machines over ssh, no browser. |
| **Full** (server) | `node src/index.js --config agent-runner.json` | Plus hub tools, schedule, work loop, memory, browser, approval notices. |

## Quick start (local)

```sh
npm ci --omit=dev
mkdir -p ~/.fyos/runner && openssl rand -hex 32 > ~/.fyos/runner/token
FYOS_RUNNER_DATEN="$HOME/.fyos/runner" \
FYOS_RUNNER_PORT=18438 \
FYOS_LOKAL_MODELL_URL=http://127.0.0.1:8081/v1 \
FYOS_LOKAL_MODELL_ID=my-model \
FYOS_RUNNER_TOKEN="$(cat ~/.fyos/runner/token)" \
node lokal/starten.mjs
```

The UI is then at `http://127.0.0.1:18438/` (sign in with the token). Terminal client: `node scripts/fyos-agent.mjs`.
`node scripts/runner-lokal-buendel.mjs` builds a bundle with its own Node for the FYOS shell.

## Full configuration

Template: `beispiele/agent-runner.beispiel.json`. Path via `--config` or `FYOS_RUNNER_CONFIG`. Without a token the
runner refuses to start, because it runs commands. Machines it may reach over ssh are listed only in
`pi_durable.nodes`; none are built in.

The built-in daily rhythm (`takt`: morning, evening, night, night workshop) is built for one particular routine; the
template turns it off with `"takt": {"an": false}`. Own entries go under `takt.eintraege`.

| Environment | Meaning |
|---|---|
| `FYOS_RUNNER_CONFIG` | Path to the configuration |
| `FYOS_RUNNER_TOKEN`, `FYOS_RUNNER_PORT`, `FYOS_RUNNER_HOST` | Sign-in and address of the UI |
| `FYOS_RUNNER_CONTAINER` | `1` in the image: binding to all addresses allowed, only with a token |
| `FYOS_RUNNER_LOKAL` | `1` turns on local mode |
| `FYOS_LOKAL_MODELL_URL`, `FYOS_LOKAL_MODELL_ID`, `FYOS_LOKAL_MODELL_KEY(_DATEI)` | Model in local mode |
| `FYOS_MODELL_BASIS_URL`, `FYOS_MODELL_NAME`, `FYOS_MODELL_SCHLUESSEL` | Model in full mode (same as the installer) |
| `FYOS_HUB_AGENT_TOKEN` | Token for the hub (otherwise `hub_token_datei`) |
| `FYOS_PROVIDER_KETTE` | Order of models when one fails |

## Check

```sh
npm ci && npm test
```

License: Apache-2.0.
