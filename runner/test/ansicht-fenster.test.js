/**
 * Belegt, was die Clients (Web-Oberfläche public/app.js, Desktop-Chat apps/fyos-agent/ui) vom Runner sehen:
 * `GET /api/gespraech/:id/ansicht` und der erste `snapshot` des Ereignisstroms liefern nur das AKTIVE Fenster
 * des Gesprächs (ab dem letzten Kopf-Marker `pi.reset` oder `pi.compaction`), nicht den ganzen Verlauf.
 * Nach `leeren` ist das Fenster bis auf den Marker leer; ein Client, der Marker nicht kennt, zeigt einen leeren Chat.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { konfigurationLaden } from '../src/config.js';
import { Runner } from '../src/runner.js';

const warte = (ms) => new Promise((r) => setTimeout(r, ms));
async function bis(fn, { ms = 15000, was = 'Bedingung' } = {}) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    try {
      const w = await fn();
      if (w) return w;
    } catch {
      /* weiter */
    }
    await warte(100);
  }
  throw new Error(`Zeit abgelaufen: ${was}`);
}

const tmp = mkdtempSync(join(tmpdir(), 'ansicht-fenster-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function baue() {
  const cfg = konfigurationLaden(
    {
      hub: 'http://hub.test',
      agent: 'persona',
      arbeitsbereiche: { standard: { pfad: tmp, titel: 'Test' } },
      pi_durable: {
        storage: join(tmp, 'fyos.sqlite'),
        security: { token: 'test-token-test-token-test-token-00' },
        proactive: { enabled: false },
        egress: { enabled: false },
        browser: { enabled: false },
        desktop: { enabled: false },
      },
    },
    {},
  );
  const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: [{ id: 'hausmodell' }, { id: 'hausmodell-max' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  return { cfg, faux, models };
}

const hub = {
  aufrufen: async () => ({ ok: true, result: {} }),
  melden: async () => ({ ok: true }),
  bereicheMelden: async () => ({ ok: true }),
  gesundheit: async () => ({ ok: true }),
  suchen: async () => [],
  schema: async () => ({}),
  async eingangLesen(nach) {
    await warte(150);
    return { eintraege: [], letzte: nach };
  },
};

const sichtbar = (entries) =>
  entries.flatMap((e) => e.model ?? []).filter((m) => m?.role === 'assistant' || m?.role === 'user').length;

test('Nach leeren zeigen ansicht und Snapshot nur den Kopf-Marker: alter Verlauf ist weg, der Marker hat keine Nachricht', async () => {
  const { cfg, faux, models } = baue();
  faux.setResponses([fauxAssistantMessage('Antwort eins'), fauxAssistantMessage('Antwort zwei')]);
  const runner = new Runner(cfg, { models, hub });
  await runner.start();
  try {
    const root = (await runner.gespraeche()).find((g) => g.art === 'root');
    await runner.sende(root.id, 'Frage eins');
    await bis(async () => sichtbar((await runner.ansicht(root.id)).entries) >= 2, { was: 'erste Antwort' });
    const vorher = await runner.ansicht(root.id);
    assert.ok(sichtbar(vorher.entries) >= 2);

    await runner.leeren(root.id);

    const nachher = await runner.ansicht(root.id);
    const arten = nachher.entries.map((e) => e.kind);
    assert.deepEqual(arten, ['pi.reset'], 'das aktive Fenster ist nur der Marker');
    assert.equal(sichtbar(nachher.entries), 0, 'keine Nachricht zum Zeichnen');

    const strom = await runner.watchConversation(root.id);
    try {
      assert.deepEqual(strom.snapshot.entries.map((e) => e.kind), ['pi.reset'], 'der Snapshot nach Reconnect ist ebenso leer');
    } finally {
      await strom.stop();
    }

    // Fix: mit voll bleibt der Verlauf vor dem Marker sichtbar, der Marker steht an seiner zeitlichen Stelle
    const voll = await runner.ansicht(root.id, { voll: true });
    assert.equal(voll.fenster, 'voll');
    assert.ok(sichtbar(voll.entries) >= 2, 'alter Verlauf bleibt sichtbar');
    assert.equal(voll.entries.at(-1).kind, 'pi.reset', 'der Marker steht am Ende, wo er geschah');
    const ids = voll.entries.map((e) => e.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'aufsteigend nach Id');

    const strom2 = await runner.watchConversation(root.id, { voll: true });
    try {
      assert.ok(sichtbar(strom2.snapshot.entries) >= 2, 'auch der Snapshot mit voll enthält den alten Verlauf');
      assert.equal(strom2.snapshot.fenster, 'voll');
    } finally {
      await strom2.stop();
    }
  } finally {
    await runner.close().catch(() => {});
  }
});
