Deutsch: [README.de.md](README.de.md)

# fyos-agent

The agent of the distribution **FYOS — For Your Own Sake**: a durable runner on
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable). Conversations, tool calls and approvals live in
one SQLite file and survive every restart. The runner talks to an OpenAI-compatible model, takes its tools from the
FYOS hub (MCP) and asks for approval before every writing step.

| Folder | Contents |
|---|---|
| [`runner/`](runner/README.md) | the runner: source, web UI, tests, template, Dockerfile (image `fyos-agent/runner`) |
| `runner/lokal/` | start program of the local mode for the FYOS shell |
| `tools/` | `sauber.py` (cleanliness check, see `.sauber/`) |

Guide, quick start and environment: [`runner/README.md`](runner/README.md). Most people set the agent up with the
installer from the sister repo `fyos-os` (`fyos-install`), which pulls the image with the tag of its own version. Both
repos carry the same version number.

Up to 0.2.0 this repo also contained an OpenClaw mod; since 0.2.1 the runner is the only agent ([CHANGELOG](CHANGELOG.md)).

License: Apache-2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)).
