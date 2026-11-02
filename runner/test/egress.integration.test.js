/**
 * Der Ausgang zum Hub: Worte des Agenten und Läufe erscheinen im Vertrag `fyos:agent`,
 * Sequenzen steigen je Sitzung, auch für die Kind-Gespräche der Läufe.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { konfigurationLaden } from '../src/config.js';
import { Egress } from '../src/egress.js';
import { Runner } from '../src/runner.js';

const warte = (ms) => new Promise((r) => setTimeout(r, ms));
async function bis(fn, { ms = 15000, was = 'Bedingung' } = {}) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    const wert = await fn();
    if (wert) return wert;
    await warte(100);
  }
  throw new Error(`Zeit abgelaufen: ${was}`);
}

const tmp = mkdtempSync(join(tmpdir(), 'pidurable-egress-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('Egress meldet Antworten des Hauptgesprächs und eines Laufs an den Hub', async () => {
  const cfg = konfigurationLaden(
    {
      hub: 'http://hub.test',
      arbeitsbereiche: { standard: { pfad: tmp, titel: 'Test' } },
      pi_durable: {
        storage: join(tmp, 'fyos.sqlite'),
        security: { token: 'test-token-test-token-test-token-00' },
        egress: { enabled: true, flushMs: 100 },
        browser: { enabled: false },
        desktop: { enabled: false },
      },
    },
    {},
  );
  const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: [{ id: 'hausmodell' }, { id: 'hausmodell-max' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const gemeldet = [];
  const hub = {
    melden: async (stueck) => {
      gemeldet.push(...stueck);
      return { ok: true };
    },
    bereicheMelden: async () => ({ ok: true }),
    gesundheit: async () => ({ ok: true }),
    aufrufen: async () => ({ ok: true, result: {} }),
  };
  const runner = new Runner(cfg, { models, hub });
  await runner.start();
  const egress = new Egress({ cfg, harness: runner.harness, hub, onFehler: () => {} });
  await egress.start();
  try {
    const root = (await runner.gespraeche()).find((g) => g.art === 'root');
    faux.setResponses([fauxAssistantMessage('Hauptantwort')]);
    await runner.sende(root.id, 'frage');
    await bis(() => gemeldet.some((e) => e.sitzung === String(root.id) && e.typ === 'session.idle'), { was: 'session.idle des Hauptgesprächs' });
    const teile = gemeldet.filter((e) => e.sitzung === String(root.id) && e.typ === 'part.updated' && e.pt === 'text');
    assert.ok(teile.map((e) => e.delta).join('').includes('Hauptantwort'));
    assert.ok(gemeldet.every((e) => e.v === '1' && e.agent === cfg.agent));

    // Ein Lauf bekommt ein Kind-Gespräch, das nicht im Register steht.
    faux.setResponses([fauxAssistantMessage('Laufantwort')]);
    const lauf = await runner.neuerLauf(root.id, { titel: 'Probe', auftrag: 'tu etwas' });
    await bis(async () => (await runner.lauf(lauf.id))?.outcome?.status === 'completed', { was: 'Lauf abgeschlossen' });
    await bis(() => gemeldet.some((e) => e.sitzung !== String(root.id) && e.typ === 'session.idle'), { was: 'session.idle des Lauf-Kindes' });
    const kind = (await runner.lauf(lauf.id)).kindId;
    const kindTeile = gemeldet.filter((e) => e.sitzung === String(kind) && e.pt === 'text').map((e) => e.delta).join('');
    assert.ok(kindTeile.includes('Laufantwort'));

    // Sequenzen steigen je Sitzung lückenlos von 1.
    for (const s of [root.id, kind]) {
      const qs = gemeldet.filter((e) => e.sitzung === String(s)).map((e) => e.q);
      assert.deepEqual(qs, qs.map((_, i) => i + 1));
    }

    // Vertrag mit dem echten Hub: jedes Ereignis muss `mcp_hub/plugins/_agentenstrom.py::eintrag` passieren (25.10.2026:
    // mit Kurzschlüsseln verwarf der Hub alles, ein Fake-Hub im Test merkte das nicht).
    const wurzel = fileURLToPath(new URL('../../../../', import.meta.url));
    const pruefer = 'import json,sys\nfrom mcp_hub.plugins._agentenstrom import eintrag\nfor e in json.load(sys.stdin):\n    eintrag(e)\n';
    const probe = spawnSync('python3', ['-c', 'import mcp_hub.plugins._agentenstrom'], { cwd: wurzel, encoding: 'utf8' });
    if (probe.status === 0) {
      const r = spawnSync('python3', ['-c', pruefer], { cwd: wurzel, input: JSON.stringify(gemeldet), encoding: 'utf8' });
      assert.equal(r.status, 0, `Hub weist ein Ereignis ab: ${r.stderr.slice(-400)}`);
    }
  } finally {
    await egress.stop();
    await runner.close().catch(() => {});
  }
});
