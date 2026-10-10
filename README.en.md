Deutsch: [README.md](README.md)

# fyos-agent

The foundation of the distribution **FYOS — For Your Own Sake**: the agent behaviour as an
OpenClaw mod, without personal content. Not a source fork: an image on top of OpenClaw's
upstream image (pinned by digest), version-bound patches, behaviour plugins,
workspace templates, behaviour contract and skills.

## Layers

```text
fyos.yaml ──► fyos_agent/render.py ──► workspace/{AGENTS,SOUL,IDENTITY,USER}.md  (+ BOOTSTRAP.md during first-time setup)
                                       openclaw.json  (gateway configuration)
openclaw/   Dockerfile, einstieg.sh, patches/ (hash-checked interventions in the upstream image)
plugins/    fyos-prioritaet, fyos-freigabe-chat, fyos-meldebudget, fyos-kontext-edit,
            fyos-speed-router, fyos-bruecke, fyos-ersteinrichtung   (image: /opt/fyos/<id>)
vertrag/    behaviour contract (Markdown) + betriebskonzept.yaml + freigabe_vertrag.json
workspace/  *.md.tmpl   config/openclaw.json5.tmpl   templates with {{placeholders}}
skills/     betriebskonzept, freigabe  (OpenClaw skills, SKILL.md; in the image /opt/fyos/skills, skills.load.extraDirs)
tools/      sauber.py (cleanliness check, see .sauber/)
```

The behaviour exists in three forms that must not contradict one another: prose
(`vertrag/`), instructions to the model (`workspace/`) and enforcement beneath the model
(`plugins/`). The boundary lies beneath the model, not in a prompt.

## Quick start

```sh
# 1. Create the configuration
cp fyos.example.yaml fyos.yaml          # adjust name, owner, language, limits, capabilities

# 2. Build the image (from the repo root)
docker build -f openclaw/Dockerfile -t fyos-agent .

# 3. Start (gateway on 18789; the shell passes /agent through unchanged)
docker run --rm -p 18789:18789 \
  -v "$PWD/fyos.yaml:/etc/fyos/fyos.yaml:ro" \
  -e FYOS_MODELL_BASIS_URL=http://modell:8080/v1 \
  -e FYOS_MODELL_NAME=mein-modell \
  -e FYOS_MODELL_SCHLUESSEL=geheim \
  -e FYOS_HUB_URL=http://hub:8080/mcp/ \
  -e OPENCLAW_GATEWAY_TOKEN="$(openssl rand -hex 24)" \
  fyos-agent
```

Start line in the image: `ENTRYPOINT tini -- /opt/fyos/einstieg.sh`, `CMD openclaw gateway --bind lan --port 18789`.
On start, `einstieg.sh` renders the templates into `~/.openclaw` (workspace files and
`openclaw.json`; an existing configuration is backed up as `openclaw.json.vorher`,
`FYOS_KONFIG_BEHALTEN=1` leaves it untouched) and then hands over to the upstream entrypoint.
Every start rewrites AGENTS.md and SOUL.md; USER.md and IDENTITY.md only as long as they still look
the way the start last wrote them (see "First-time setup as a conversation").

| Environment | Meaning |
|---|---|
| `FYOS_CONFIG` | Path to `fyos.yaml` (default `/etc/fyos/fyos.yaml`; without the file the defaults apply) |
| `FYOS_MODELL_BASIS_URL`, `FYOS_MODELL_NAME`, `FYOS_MODELL_SCHLUESSEL` | Model as an OpenAI-compatible provider (see section "Model") |
| `FYOS_HUB_URL` | MCP endpoint of the hub; without `/mcp` also the target of the events from `fyos-bruecke` |
| `OPENCLAW_GATEWAY_TOKEN` | Login to the gateway (token); also signs the events sent to the hub |
| `FYOS_OEFFENTLICH_URL` | Public address of the installation (as for hub and shell); without `gateway.oeffentliche_url` in `fyos.yaml` the allowed origin of the Control UI |
| `FYOS_VORGAENGE_URL` | optional: ticket service for `fyos-freigabe-chat` |
| `FYOS_MATRIX_HOMESERVER`, `FYOS_MATRIX_BENUTZER`, `OPENCLAW_MATRIX_TOKEN`, `FYOS_APPROVER_MATRIX_ID` | optional: Matrix channel (`kanaele.matrix: true`; build the image with `--build-arg FYOS_KANAELE=matrix`) |
| `OPENCLAW_TELEGRAM_TOKEN`, `FYOS_APPROVER_TELEGRAM_ID` | optional: Telegram channel (`kanaele.telegram: true`; bot token and numeric owner ID, see section "Telegram"; already part of the base image, no build argument) |

Render only, without Docker:

```sh
FYOS_MODELL_BASIS_URL=http://modell:8080/v1 FYOS_MODELL_NAME=m FYOS_HUB_URL=http://hub:8080/mcp/ \
  python3 -m fyos_agent.render --config fyos.example.yaml --ziel /tmp/fyos-ziel
```

Gateway behind the FYOS shell: nginx passes `/agent` and `/agent/*` on unchanged (without
prefix stripping, with WebSocket upgrade) to `http://agent:18789`. For this the configuration contains
`gateway.controlUi.basePath = "/agent"`, login by token (`OPENCLAW_GATEWAY_TOKEN`).
The shell strips all origin headers (`Forwarded`, `X-Real-IP`, `X-Forwarded-*`): the gateway
sees the shell as the sender and demands login as it does for any remote device. It believes forwarding
headers only from a front proxy listed under `gateway.vertrauenswuerdige_proxys`, and even then only if
that proxy overwrites them instead of appending; otherwise it answers with 403 `proxy_attribution_required`. The embedding
in the shell's window is allowed by the shell's nginx (OpenClaw itself forbids it). The browser origin must be
allowed: `gateway.oeffentliche_url`, without it `FYOS_OEFFENTLICH_URL`, otherwise the
Control UI reports "origin not allowed". By itself, OpenClaw only lets in `*.local`, `*.ts.net` and private
addresses with the same host. The renderer writes the address into the allowlist the way the
browser sends the origin (lowercase, without path and default port). It sets it as `gateway.publicOrigin`
only for `https` or for `http` on localhost/loopback, because OpenClaw's configuration check rejects
any other http address and the gateway does not start. A LAN address such as `http://fyos.lan:8080`
therefore remains an allowed origin, but without `publicOrigin`.

## Model

The model comes via `FYOS_MODELL_BASIS_URL`, `FYOS_MODELL_NAME` and `FYOS_MODELL_SCHLUESSEL` as an
OpenAI-compatible provider: a server of your own or a cloud provider. Cloud models are connected only with the
provider's API key. Signing in with a subscription such as Claude Pro or Max is, according to Anthropic, <!-- sauber: ok -->
intended for Claude Code and other Anthropic apps of its own; third-party applications are to access Claude with an API key
(Claude Console or a supported cloud provider) and neither offer subscription sign-ins nor route
requests through subscription credentials (source: [Legal and compliance, section "Authentication and credential
use"](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)).

## Telegram

Telegram is a second channel next to Matrix and is already part of OpenClaw's base image: unlike
Matrix, the image needs no build argument. Default: off. With `kanaele.telegram: true` the renderer writes
a channel that accepts only direct messages from the owner: `dmPolicy: allowlist` with exactly the owner's
numeric ID (no pairing, nobody unlocks themselves), `groupPolicy: disabled` (the bot does not react in
any group) and `configWrites: false` (the channel may not change the configuration). Bot token and
owner ID are never in `fyos.yaml`, only in the environment; if one is missing or invalid, rendering
aborts with a message that names the variable and never its value. Matrix and Telegram can
be switched on individually or together.

Setup:

1. At [@BotFather](https://t.me/BotFather) create a bot with `/newbot` and copy the token. Setting
   `/setjoingroups` to "Disable" additionally means the bot cannot be invited to groups in the first place.
2. Set the token as `OPENCLAW_TELEGRAM_TOKEN`.
3. Find out the owner's numeric Telegram ID (the @name is not enough): write a message to the bot and, as long as the
   gateway is not yet polling the bot (the bot API allows only one poll at a time), call
   `curl "https://api.telegram.org/bot${OPENCLAW_TELEGRAM_TOKEN}/getUpdates"`. The ID is in the response under
   `message.from.id`.
4. Set the ID as `FYOS_APPROVER_TELEGRAM_ID` (digits only), enter `kanaele: {telegram: true}` in `fyos.yaml`
   and (re)start the gateway.
5. Write to the bot once: Telegram only lets a bot write to the owner after that.

Approvals also run through Telegram. Native approvals of the agent arrive as a message with buttons in the
direct message (`approvals.plugin.targets`, buttons only in direct messages). With `fyos-freigabe-chat`, a
request from the ticket service additionally goes to Telegram as a plain text message, and the owner's reply
(`genehmigt CHG-42`, `abgelehnt CHG-42`, `kommentar CHG-42: …`) decides as in Matrix without a model call; it
suffices if one channel delivers. The reaction buttons are a Matrix peculiarity and are missing in Telegram.

## First-time setup as a conversation

In the first conversation of a fresh installation, the agent gets to know the owner instead of everything having to be
in `fyos.yaml` beforehand: in a single message it asks a few questions (form of address or name, language,
time zone, what it is there for, additional limits, name of the agent), each with a suggestion from the
configuration, so that "fine as is" suffices. From the answers it fills USER.md and IDENTITY.md; after that the
ritual ends and does not repeat. If the owner starts right away with a task, it comes first; if they do not want to answer the
questions, the suggestions apply. Switch: `faehigkeiten.ersteinrichtung` (default `true`;
`false` lets USER.md and IDENTITY.md arise from `fyos.yaml` as before).

How it works:

- At start, the renderer (`fyos_agent/einrichtung.py`) decides whether the setup is open: only for a
  fresh installation (no state yet, no USER.md in the workspace) and with the switch on. An
  existing installation stays as it is; there OpenClaw long ago noted the setup as done.
  The state is in `~/.openclaw/fyos-agent-zustand.json`.
- Open means: `BOOTSTRAP.md` (the conversation) is in the workspace, `agents.defaults.skipBootstrap` is on (OpenClaw
  then neither creates its own starter files nor notes the setup as done itself and deletes the
  file) and the plugin `fyos-ersteinrichtung` is on. It provides the tool `fyos_ersteinrichtung`, because the
  agent otherwise has no write tool.
- The call writes USER.md (section "Steckbrief") and IDENTITY.md (name) and deletes `BOOTSTRAP.md` last.
  That ends the setup immediately, because it is open only as long as `BOOTSTRAP.md` exists. On the next
  start `skipBootstrap` is dropped and the plugin is off; none of it comes back.
- The start overwrites USER.md and IDENTITY.md only as long as they look the way it last wrote them (the
  state remembers the checksums). What the agent entered or someone changed by hand stays; whoever deletes the
  file gets the version from `fyos.yaml` back.
- With `FYOS_KONFIG_BEHALTEN=1` and an existing configuration the setup stays closed: that configuration does not know
  the plugin.
- The setup can only be repeated with a fresh state directory (new volume). OpenClaw
  notes in its database that it is done; deleting files does not reopen it.

Limits: The answers are in USER.md and IDENTITY.md. AGENTS.md and SOUL.md continue to name the names from
`fyos.yaml`; AGENTS.md tells the agent explicitly that USER.md and IDENTITY.md take precedence for name, form of address,
language and time zone, and that additional limits only add to the fixed ones and never loosen them. Quiet hours of the
notification budget (`zeitzone`) and the language of the interface (`sprache_code`) continue to follow `fyos.yaml`.

## Tests

```sh
python3 -m pytest tests -q                       # renderer, templates, contract files (PyYAML, pytest)
node --test plugins/*/*.test.mjs                 # plugin logic without a gateway
python3 tools/sauber.py .                        # no personal content
```

## Plugins

| Plugin | Purpose | Default |
|---|---|---|
| `fyos-prioritaet` | tool `fyos_conversation_status`, 15-minute run-on period, persistent state | on |
| `fyos-meldebudget` | at most N proactive messages per day, quiet hours, in the hook `message_sending` | on |
| `fyos-freigabe-chat` | the owner's chat/Matrix/Telegram reply decides an open approval, without a model call | on if `faehigkeiten.vorgaenge: true` and `FYOS_VORGAENGE_URL` is set |
| `fyos-kontext-edit` | experiment: the agent cleans up its own tool results | off |
| `fyos-speed-router` | optional: short small-talk turns go to a small model | off (needs `tempo_router.ziel_modell`) |
| `fyos-bruecke` | coupling to the hub: tool and model calls, runs, sessions, cron, skills sent to the hub as events without contents; route `/plugins/fyos-bruecke/v1/rpc` for workboard, skills, cron and usage (fixed list of methods) | on (`kopplung.aktiv`) |
| `fyos-ersteinrichtung` | tool `fyos_ersteinrichtung`: enters the answers of the first-time setup into USER.md and IDENTITY.md and ends it | on while the first-time setup is open (`faehigkeiten.ersteinrichtung`, fresh installation only) |

With `kopplung.workboard` (default on) the template switches on the bundled workboard and gives the agent
the tools to read, create, comment on and move cards (no worker protocol). The hub shows
the cards as tickets or mirrors an existing ticket service onto them; the contract is in
`fyos-os/docs/KOPPLUNG-OPENCLAW.md`.

The ticket service behind `fyos-freigabe-chat` is a small HTTP API
(`GET /tickets?status=waiting_approval`, `POST /tickets/{id}/comments`, `PATCH /tickets/{id}`),
described in `plugins/fyos-freigabe-chat/board.mjs`.

### Custom plugins without a fork

Every folder with `openclaw.plugin.json` under `/opt/fyos-extra` (or `$FYOS_AGENT_PLUGINS`) is loaded at
start: as a volume or in a derived image with
`COPY --chown=node:node mein-plugin/ /opt/fyos-extra/mein-plugin/`. The entrypoint links the SDK
(`node_modules/openclaw` → `/app`) and registers the plugin without access to the conversation and without
prompt permission; `zusatz_plugins.<id>.rechte` in `fyos.yaml` explicitly grants both. An ID
that already exists, or a broken manifest, makes rendering fail. In detail:
`fyos-os/docs/ERWEITERN.md`, §5.2.

### Later stage: loop runners

The runners for the work, exploration and memory loops are **not** part of this stage. They are
tightly bound to a ticket service, a Git hosting, specific hub tools
(candidate selection, test runs, classification) and the devices of an installation. A
general `plugins/fyos-schleifen/` will only come into being once the hub contract (tool names per
configuration, "owner active" signals) can be stated cleanly and independently of any installation. The
operating concept (`vertrag/betriebskonzept.yaml`) is already prepared for it.

## Upstream update

The base image is pinned by digest in `openclaw/Dockerfile`; the patches check the SHA-256 of the
upstream file before and after the intervention and abort the build on deviation.

1. Enter the new digest (`FROM ghcr.io/openclaw/openclaw@sha256:…`) and align the Matrix version
   (`@openclaw/matrix@<version>`).
2. From `/app/dist` of the **published image** (not from the npm tarball) re-determine the files of the
   plans: `openclaw/patches/settled-finalization-fallback.json` and
   `stale-terminal-fence-fix.json` (`targets[].file`, `before`, `after`, `replacement`). Hash:
   `sha256sum`. The second plan is planned against the output of the first (`before` of the
   shared file = `after` of the first).
3. If a bug has been fixed in the new upstream, remove the patch together with its entry in the Dockerfile
   instead of re-planning it.
4. Check whether the upstream entrypoint (`docker-entrypoint.mjs`) still runs `openclaw doctor --fix`
   and `CMD` still applies unchanged; build; hold `openclaw.json5.tmpl` against the new version
   (`meta.lastTouchedVersion`).

Status: OpenClaw 2026.9.7, base digest `sha256:0da12cd4…1dbcfc`.

Details on the patches: `openclaw/README.md`.

## License

FYOS Agent is licensed under the Apache License, Version 2.0 (SPDX identifier `Apache-2.0`).

Copyright 2026 sirfyyn and FYOS CONTRIBUTORS <!-- sauber: ok -->

The full license text is in [`LICENSE`](LICENSE), the copyright notice in [`NOTICE`](NOTICE).
