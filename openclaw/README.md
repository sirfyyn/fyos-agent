# openclaw/: Bild, Einstieg, Patches

Das Bild baut auf `ghcr.io/openclaw/openclaw@sha256:0da12cd49983fcb5e4915fd3135ce7a33d82f93649b1df6964946d2c1d1dbcfc`
(OpenClaw 2026.9.7) mit `@openclaw/matrix@2026.9.7` und `@openclaw/whatsapp@2026.9.7` (nur mit
`--build-arg FYOS_KANAELE=matrix`, `=whatsapp` oder `=matrix,whatsapp`). Telegram gehört zum Basisbild und braucht
keine Installation beim Bau; ein Kanal wird erst durch `kanaele.<name>` in `fyos.yaml` aktiv. Die Kopplung von
WhatsApp (QR-Code) liegt nach dem Start unter `~/.openclaw/credentials/whatsapp/` und muss auf einem Volume liegen.

## Patches (`patches/`)

Beide Eingriffe sind versionsgebunden und fail-closed: jedes Ziel wird vor dem Schreiben auf
den erwarteten SHA-256 geprüft, die Ersetzung muss genau einmal vorkommen, und das Ergebnis
muss dem erwarteten Hash entsprechen. Wird eine Datei nicht geschrieben, bevor alle Ziele
geprüft sind, bleibt das Bild nie halb gepatcht.

| Patch | Warum | Ziele |
|---|---|---|
| `settled-finalization-fallback` | Upstream fällt nach einem abgeschlossenen Werkzeuglauf bei einem zweiten Modell- oder Gatewayfehler auf einen englischen Standardtext zurück. Der Text benennt die Ursache ehrlich und stellt klar, dass kein erledigter Schritt wiederholt wurde. | `dist/embedded-agent-BVEibI5N.mjs`, `dist/package-update-activation-recovery.mjs` |
| `stale-terminal-fence-fix` | Ein historischer Terminal-Marker einer abgeschlossenen Neustart-Wiederaufnahme wurde wie ein lebendiger Zustellanspruch behandelt und blockierte spätere Direkt-Eingaben. Ohne Anspruch bleibt der Marker Herkunftsnachweis. | `dist/restart-recovery-receipt-C1LMd5lE.mjs`, `dist/package-update-activation-recovery.mjs` |

Reihenfolge: erst der Fallback-Patch, dann der Fence-Patch (der zweite ist gegen die Ausgabe
des ersten für die gemeinsame Datei geplant). Der Fallback-Text ist neutral formuliert und
fest, weil der erwartete Hash davon abhängt; ein anderer Text braucht einen neu geplanten
Hash in beiden Plänen.

## Einstieg (`einstieg.sh`)

Rendert Vorlagen aus `FYOS_CONFIG`, schreibt die Workspace-Dateien und `openclaw.json` nach
`~/.openclaw` und ruft dann den Upstream-Einstieg (`docker-entrypoint.mjs`, führt
`openclaw doctor --fix --non-interactive` aus) mit der Startzeile aus `CMD` auf:

    openclaw gateway --bind lan --port 18789

Die Workspace-Dateien schreibt der Renderer selbst (`--zustand ~/.openclaw`, siehe `fyos_agent/einrichtung.py`):
AGENTS.md und SOUL.md bei jedem Start neu; USER.md und IDENTITY.md nur, solange sie noch so aussehen, wie der
Start sie zuletzt schrieb; BOOTSTRAP.md (die Ersteinrichtung als Gespräch) nur beim allerersten Start einer
frischen Installation, sonst wird ein vorhandenes zur Seite gelegt (`BOOTSTRAP.vor-fyos.<zeit>.md`), weil es die
gerenderte Identität übersteuern würde. Der Zustand liegt in `~/.openclaw/fyos-agent-zustand.json`. Mit
`FYOS_KONFIG_BEHALTEN=1` und vorhandener `openclaw.json` bleibt die Ersteinrichtung zu.

Gegenüber einem Betrieb mit vorgeschaltetem TLS-Beifahrer (Gateway auf `loopback`) hört das
Gateway hier direkt im Container-Netz; die Shell (nginx) schaltet sich davor. Der Schutz
besteht aus dem Token (`OPENCLAW_GATEWAY_TOKEN`) und dem Netz: Port 18789 nicht nach außen
veröffentlichen.
