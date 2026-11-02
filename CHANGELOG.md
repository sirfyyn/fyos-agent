# Changelog

All notable changes to fyos-agent are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/). Numbers in parentheses are pull request numbers.

fyos-agent is the agent of the FYOS distribution: the runner on pi-durable (`runner/`). The repo carries the same version
number as its sister repo `fyos-os` and is released with the same tag. The `fyos-os` installer pulls the `runner` image
with that tag.

## [0.3.0] – 2026-11-02

### Added

- **English by default.** The runner speaks English to people and in its own prompt sections when `pi_durable.sprache`
  is `en` (environment `FYOS_RUNNER_SPRACHE`). The image, the local mode and the example configuration set `en`; German
  stays available with `de`. Covered: web interface, API errors, approval notices (Matrix, ntfy), terminal client, the
  runner's role and tool rules, descriptions of its own tools. Tool names are unchanged.
- **Approvals follow the configured owner.** Who grants an approval comes from `itsm.besitzer` (distribution: `besitzer`)
  instead of a fixed name, so approvals given in the `fyos-os` ticket app take effect.

### Changed

- `runner/README.md` is now English; the German version is `runner/README.de.md`.
- This changelog and the top-level README are English.

## [0.2.1] – 2026-11-02

### Removed

- **OpenClaw is gone entirely.** The OpenClaw mod (`openclaw/`, `plugins/`, `workspace/`, `fyos_agent/`, `config/`,
  `vertrag/`, `skills/`, `fyos.example.yaml`) and the `fyos-agent/openclaw` image are removed. The runner replaces it
  completely; only the `fyos-agent/runner` image is built.

### Migration

If you still use OpenClaw from 0.2.0 or earlier, follow the migration in the 0.2.0 section. Chat channels through
OpenClaw (Telegram, WhatsApp) no longer exist; the runner can send approval notices itself via Matrix or ntfy
(`pi_durable.freigabe_meldung.kanaele`).

## [0.2.0] – 2026-11-02

### Added

- **The runner is the agent.** `runner/` holds the durable FYOS runner on pi-durable (Node ≥ 22.19, package
  `fyos-agent`). Conversations, tool calls and approvals live in one SQLite file and survive restarts. Two modes: local
  (desktop, without hub and ssh) and full (server, with hub tools, schedule, work loop, memory). Guide:
  `runner/README.md`, template: `runner/beispiele/agent-runner.beispiel.json`.
- **Local runner for the FYOS shell.** `runner/lokal/` is the start program following the shell's contract;
  `runner/scripts/runner-lokal-buendel.mjs` builds a bundle with its own Node.
- **Terminal client** `fyos-agent` (`runner/scripts/fyos-agent.mjs`).

### Changed

- Machines the agent may reach over ssh are listed only in the configuration (`pi_durable.nodes`); the code ships none.

### Deprecated

- **OpenClaw mod** (`openclaw/`, `plugins/`, `workspace/`, `fyos_agent/`). Still works in 0.2.x and is no longer
  developed. Removed in 0.2.1 at the earliest.

### Migrating from OpenClaw

1. Install the runner: `cd runner && npm ci --omit=dev`.
2. Carry over from `fyos.yaml`: model address and name to `pi_durable.model` (`baseUrl`, `default`), the hub address to
   `hub`, the hub token as a file to `hub_token_datei`.
3. Create a token for the interface (`openssl rand -hex 32 > ~/.fyos/runner/token`) and start
   `node src/index.js --config agent-runner.json`.
4. OpenClaw conversation histories are not carried over; the memory in the hub stays.
5. Stop the OpenClaw container only once the runner shows up in the hub as an agent.

## [0.1.3] – 2026-10-22

No changes to the agent itself. The number follows the FYOS version because the installer pulls the `openclaw` image
with the tag of its own version.

## [0.1.2] – 2026-10-22

No changes to the agent itself. The number follows the FYOS version because the installer pulls the `openclaw` image
with the tag of its own version.

## [0.1.1] – 2026-10-11

### Added

- **WhatsApp as a third channel** next to Matrix and Telegram. Turn it on in `fyos.yaml` under `kanaele`, build the image
  with `--build-arg FYOS_KANAELE=whatsapp` (or `matrix,whatsapp`) and pair the account once by QR code. Only the owner's
  direct messages count. Approval requests also arrive via WhatsApp, and a text reply decides them. With
  `whatsapp.eigene_nummer` the agent runs on your own number (notes to yourself); a separate number for the agent is
  better (#5).
- **Urgent notice to the owner.** The bridge offers `fyos.kanal.mitteilen`: the agent sends something important over the
  first ready channel (Telegram, WhatsApp or Matrix). The channels' state (only on or off, never the address) is part of
  the bridge status (#6).
- **Bridge 0.2.0** (`fyos-bruecke`): the hub can wake the agent (`fyos.wecken`) and write a message into a ticket's
  session (`fyos.vorgang.senden`). Each ticket has its own session; events carry the ticket number. Plus read-only
  queries for memory search, sessions, heartbeat, progress card, agents and tools. The agent's id is in the configuration
  (`agentId`) or in `FYOS_AGENT` (#7).
- **Memory with vector search.** The agent uses the same embedding service as the hub (`FYOS_EMBED_URL`). Without one it
  searches the text and says so. "Active memory" (a sub-agent searches before every answer) can be switched on and is off
  by default (#9).
- **Skill `zusagen`.** What the owner asks for later ("remind me", "if X, then Y") becomes a ticket with its own trigger
  (time, event or follow-up). For multi-step work the agent keeps a progress card per ticket (#10).
- **Mouth and ear.** Speech output and speech input each go through an OpenAI-compatible service. Both are optional and
  stay off without an address (`mund` and `ohr` in `fyos.yaml`, keys only in the environment) (#11).

### Changed

- Ticket numbers in the bridge accept the short id (`WB-1a2b3c4d`) as well as `INC-1234` (#8).
- The Gitea CI runs daily on a schedule against the newest packages, even without a new commit; each commit gets exactly
  one run (branches through the pull request, `main` through the push) (#3, #4).

## [0.1.0] – 2026-10-10

First release.

### Added

- OpenClaw as the agent with behaviour plugins: approvals in chat, context edit, notice budget, priority, speed switch and
  first-time setup as a conversation in which the agent gets to know its owner.
- Matrix and Telegram as chat channels (off by default, only the owner's direct messages).
- The bridge `fyos-bruecke` couples the agent to the FYOS hub (workboard, skills, cron, usage and events without
  content).
- Templates and a renderer that produce the configuration, the workspace and the contracts from `fyos.yaml`.
- The `openclaw` image with version-bound fixes, extra plugins without a fork, and publishing tools (`tools/sauber.py`).

### Changed

- Apache-2.0 license and an English README (#1).
- GitHub workflows for tests and images; the NOTICE names OpenClaw (#2).
