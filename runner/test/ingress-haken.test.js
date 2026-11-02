/**
 * Die Haken im Eingang: Weltblock hinter dem Text, Reflexe halten oder verwerfen, das zweite Tor,
 * der Zugbeginn und das Einreihen aus Bausteinen — gegen den echten Runner.
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
import { Wartend } from '../src/documents.js';
import { Ingress } from '../src/ingress.js';
import { istKleinLesend } from '../src/kleines-tor.js';
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

const tmp = mkdtempSync(join(tmpdir(), 'pidurable-haken-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

async function aufbau(name) {
  const cfg = konfigurationLaden(
    {
      hub: 'http://hub.test',
      arbeitsbereiche: { standard: { pfad: tmp, titel: 'Test' } },
      spielmodus: [],
      pi_durable: {
        storage: join(tmp, name, 'fyos.sqlite'),
        security: { token: 'test-token-test-token-test-token-00' },
        proactive: { enabled: true, pollSeconds: 3 },
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
  const gesehen = [];
  faux.setResponses(
    Array.from({ length: 6 }, () => (context) => {
      const letzte = [...context.messages].reverse().find((m) => m.role === 'user');
      gesehen.push(JSON.stringify(letzte?.content ?? ''));
      return fauxAssistantMessage('ok');
    }),
  );
  const hub = {
    aufrufen: async () => ({ ok: true, result: {} }),
    melden: async () => ({ ok: true }),
    bereicheMelden: async () => ({ ok: true }),
    gesundheit: async () => ({ ok: true }),
    suchen: async () => [],
    schema: async () => ({}),
    eingangLesen: async (nach) => {
      await warte(200);
      return { eintraege: [], letzte: nach };
    },
  };
  const runner = new Runner(cfg, { models, hub });
  await runner.start();
  const ingress = new Ingress({ cfg, runner, hub, spielmodus: runner.spielmodus, tor: { offen: true } });
  return { cfg, runner, ingress, gesehen };
}

test('einreihen ist idempotent, der Weltblock steht hinter dem Text, beiZug sieht Klasse und Bezug', async () => {
  const { runner, ingress, gesehen } = await aufbau('a');
  const zuege = [];
  ingress.promptZusatz = () => 'WELTBLOCK-X';
  ingress.beiZug = async (e) => zuege.push({ klasse: e.klasse, bezug: e.bezug, quelle: e.quelle });
  await ingress.start();
  try {
    const e = { id: 'takt:morgen:2026-10-25', text: 'Guten Morgen', quelle: 'zeitplan', bezug: 'takt-morgen-2026-10-25' };
    assert.equal(await ingress.einreihen(e), true);
    assert.equal(await ingress.einreihen(e), false, 'dieselbe ID wird nicht doppelt eingereiht');
    await bis(() => gesehen.length === 1, { was: 'Zug' });
    assert.match(gesehen[0], /Guten Morgen.*WELTBLOCK-X/, 'der Block steht hinter dem Text');
    assert.deepEqual(zuege, [{ klasse: 'hintergrund', bezug: 'takt-morgen-2026-10-25', quelle: 'zeitplan' }]);
    await bis(async () => (await runner.harness.snapshot(Wartend, CTX)).eintraege.length === 0, { was: 'Warteschlange leer' });
  } finally {
    await ingress.stop();
    await runner.close().catch(() => {});
  }
});

test('vorAusgabe: verwerfen entfernt den Eintrag, halten lässt ihn warten', async () => {
  const { runner, ingress, gesehen } = await aufbau('b');
  const urteile = { verwerfen: 'verwerfen', halten: 'halten' };
  ingress.vorAusgabe = async (e) => urteile[e.text] ?? 'weiter';
  await ingress.start();
  try {
    await ingress.einreihen({ id: 'v1', text: 'verwerfen', quelle: 'x' });
    await ingress.einreihen({ id: 'v2', text: 'halten', quelle: 'x' });
    await bis(async () => (await runner.harness.snapshot(Wartend, CTX)).eintraege.map((x) => x.stromId).join() === 'v2', { was: 'v1 verworfen, v2 wartet' });
    await warte(2500);
    assert.equal(gesehen.length, 0, 'weder verworfen noch gehalten geht an den Agenten');
    // Das Urteil wird weich: der gehaltene Eintrag läuft.
    urteile.halten = 'weiter';
    await bis(() => gesehen.length === 1, { was: 'gehaltener Eintrag läuft' });
  } finally {
    await ingress.stop();
    await runner.close().catch(() => {});
  }
});

test('zweites Tor: ein kleiner lesender Auftrag läuft bei geschlossenem Tor, ein anderer nicht', async () => {
  const { runner, ingress, gesehen } = await aufbau('c');
  ingress.tor = { offen: false };
  ingress.kleinesTor = (e) => istKleinLesend(e) && true;
  await ingress.start();
  try {
    await ingress.einreihen({ id: 'g1', text: 'Behoben: Disk 80 % auf hauptserver', quelle: 'alarm', klasse: 'hintergrund' });
    await ingress.einreihen({ id: 'g2', text: 'Neuer Alarm: Pod crasht', quelle: 'alarm', klasse: 'hintergrund' });
    await bis(() => gesehen.length === 1, { was: 'kleiner Auftrag läuft' });
    assert.match(gesehen[0], /Behoben/);
    await warte(2500);
    assert.equal(gesehen.length, 1, 'der andere bleibt hinter dem Tor');
    assert.equal((await runner.harness.snapshot(Wartend, CTX)).eintraege.map((x) => x.stromId).join(), 'g2');
  } finally {
    await ingress.stop();
    await runner.close().catch(() => {});
  }
});
