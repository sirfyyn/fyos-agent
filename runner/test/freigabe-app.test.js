/**
 * Freigaben vom Handy: die Entscheidung kommt über den Hub-Eingang, entschieden wird im Harness.
 * Und der Ausgang meldet den Zug (`ein:<Strom-ID>`), die offene Freigabe und ihr Ende.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { konfigurationLaden } from '../src/config.js';
import { Egress } from '../src/egress.js';
import { Freigaben, Wartend, neueFreigabe } from '../src/documents.js';
import { Ingress } from '../src/ingress.js';
import { Runner } from '../src/runner.js';

const CTX = BACKGROUND_CONTEXT;
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

const tmp = mkdtempSync(join(tmpdir(), 'pidurable-app-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

async function aufbau(name, antworten = 4) {
  const cfg = konfigurationLaden(
    {
      hub: 'http://hub.test',
      arbeitsbereiche: { standard: { pfad: tmp, titel: 'Test' } },
      spielmodus: [],
      pi_durable: {
        storage: join(tmp, name, 'fyos.sqlite'),
        security: { token: 'test-token-test-token-test-token-00' },
        proactive: { enabled: true, pollSeconds: 3 },
        egress: { enabled: true, flushMs: 100, erinnerungS: 1 },
        browser: { enabled: false },
        desktop: { enabled: false },
      },
    },
    {},
  );
  const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: [{ id: 'hausmodell' }, { id: 'hausmodell-max' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: antworten }, () => fauxAssistantMessage('ok')));
  const gemeldet = [];
  const hub = {
    melden: async (stueck) => {
      gemeldet.push(...stueck);
      return { ok: true };
    },
    aufrufen: async () => ({ ok: true, result: {} }),
    bereicheMelden: async () => ({ ok: true }),
    gesundheit: async () => ({ ok: true }),
    eingangLesen: async (nach) => {
      await warte(200);
      return { eintraege: [], letzte: nach };
    },
  };
  const runner = new Runner(cfg, { models, hub });
  await runner.start();
  const egress = new Egress({ cfg, harness: runner.harness, hub, onFehler: () => {} });
  await egress.start();
  const ingress = new Ingress({ cfg, runner, hub, spielmodus: runner.spielmodus, tor: { offen: true }, onFehler: () => {} });
  await ingress.start();
  const wurzel = runner.root.id;
  return { runner, egress, ingress, gemeldet, wurzel };
}

const offeneFreigabe = (runner, wurzel, id = 'fr-t1') =>
  runner.harness.commit(async (tx) => {
    const doc = await tx.doc(Freigaben);
    doc.eintraege[id] = neueFreigabe({ id, conversationId: wurzel, aktion: 'Branch löschen', risiko: 'high', werkzeug: 'bash', befehl: 'git branch -D alt' });
  }, CTX);

const entscheidung = (id, was, extra = {}) => ({
  id: `app:${id}:${was}`,
  quelle: 'web',
  von: 'app-freigabe',
  klasse: 'max',
  text: JSON.stringify({ id, entscheidung: was, notiz: 'vom Handy' }),
  ...extra,
});

test('eine Freigabe-Entscheidung der App wird im Harness angewendet und geht nicht an den Agenten', async () => {
  const { runner, egress, ingress, gemeldet, wurzel } = await aufbau('a');
  try {
    await offeneFreigabe(runner, wurzel);
    await ingress.einreihen(entscheidung('fr-t1', 'erteilt'));
    const doc = await bis(async () => {
      const d = await runner.harness.snapshot(Freigaben, CTX);
      return d.eintraege['fr-t1'].status === 'erteilt' ? d : null;
    }, { was: 'Freigabe erteilt' });
    assert.equal(doc.eintraege['fr-t1'].entschiedenVon, 'app');
    assert.equal(doc.eintraege['fr-t1'].notiz, 'vom Handy');
    await bis(async () => (await runner.harness.snapshot(Wartend, CTX)).eintraege.length === 0, { was: 'Warteschlange leer' });
    // Der Ausgang meldet das Ende der Freigabe.
    await bis(() => gemeldet.some((e) => e.typ === 'part.updated' && e.id === 'freigabe:fr-t1' && e.phase === 'finish'), { was: 'Freigabe-Ende im Ausgang' });
    const ende = gemeldet.find((e) => e.id === 'freigabe:fr-t1');
    assert.equal(ende.label, 'Freigabe erteilt');
  } finally {
    await ingress.stop();
    await egress.stop();
    await runner.close().catch(() => {});
  }
});

test('derselbe Text aus einer anderen Quelle oder von einem anderen Absender entscheidet nichts', async () => {
  const { runner, egress, ingress, wurzel } = await aufbau('b');
  try {
    await offeneFreigabe(runner, wurzel);
    await ingress.einreihen(entscheidung('fr-t1', 'erteilt', { id: 'x1', von: 'jemand-anders' }));
    await ingress.einreihen(entscheidung('fr-t1', 'erteilt', { id: 'x2', quelle: 'itsm', klasse: 'hintergrund' }));
    await bis(async () => (await runner.harness.snapshot(Wartend, CTX)).eintraege.length === 0, { was: 'beide verarbeitet' });
    assert.equal((await runner.harness.snapshot(Freigaben, CTX)).eintraege['fr-t1'].status, 'offen');
  } finally {
    await ingress.stop();
    await egress.stop();
    await runner.close().catch(() => {});
  }
});

test('eine unbekannte oder schon entschiedene Freigabe bringt den Eingang nicht ins Stocken', async () => {
  const { runner, egress, ingress, wurzel } = await aufbau('c');
  try {
    await offeneFreigabe(runner, wurzel);
    await ingress.einreihen(entscheidung('fr-gibt-es-nicht', 'erteilt'));
    await ingress.einreihen(entscheidung('fr-t1', 'abgelehnt'));
    await ingress.einreihen(entscheidung('fr-t1', 'erteilt', { id: 'app:fr-t1:nochmal' }));
    await bis(async () => (await runner.harness.snapshot(Wartend, CTX)).eintraege.length === 0, { was: 'alle verarbeitet' });
    assert.equal((await runner.harness.snapshot(Freigaben, CTX)).eintraege['fr-t1'].status, 'abgelehnt', 'die erste Entscheidung gilt');
  } finally {
    await ingress.stop();
    await egress.stop();
    await runner.close().catch(() => {});
  }
});

test('der Ausgang klammert den Zug mit ein:<Strom-ID> und erinnert an offene Freigaben', async () => {
  const { runner, egress, ingress, gemeldet, wurzel } = await aufbau('d');
  try {
    await offeneFreigabe(runner, wurzel);
    await ingress.einreihen({ id: '1792000000000-0', text: 'Hallo', quelle: 'web', von: 'max', klasse: 'max' });
    await bis(() => gemeldet.some((e) => e.id === 'ein:1792000000000-0' && e.phase === 'finish'), { was: 'Klammer zu' });
    const start = gemeldet.findIndex((e) => e.id === 'ein:1792000000000-0' && e.phase === 'start');
    const ende = gemeldet.findIndex((e) => e.id === 'ein:1792000000000-0' && e.phase === 'finish');
    const idle = gemeldet.findIndex((e) => e.typ === 'session.idle');
    assert.match(gemeldet[start].label, /web \(Besitzer\): Hallo/, 'die Klammer sagt, was hereinkam');
    assert.ok(start >= 0 && start < ende && ende < idle, 'Start, dann Ende, dann idle');
    assert.ok(gemeldet.slice(start, ende).some((e) => e.pt === 'text'), 'die Antwort liegt zwischen den Klammern');
    // Erinnerung: die offene Freigabe taucht wiederholt auf (erinnerungS = 1).
    await bis(() => gemeldet.filter((e) => e.typ === 'proposal' && e.id === 'fr-t1').length >= 2, { was: 'Erinnerung' });
    const p = gemeldet.find((e) => e.typ === 'proposal');
    assert.equal(p.aktion, 'Branch löschen');
    assert.equal(p.risiko, 'high');
  } finally {
    await ingress.stop();
    await egress.stop();
    await runner.close().catch(() => {});
  }
});
