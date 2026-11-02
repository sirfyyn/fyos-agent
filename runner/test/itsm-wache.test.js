/**
 * Tests der ITSM-Wache: Ereignisse mit der richtigen Klasse, kein Doppeln (auch nach Neustart und
 * gegen die echte Warteschlange), Fehler im Hub beenden die Wache nicht. Kein Netz.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxProvider } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { konfigurationLaden } from '../src/config.js';
import { Wartend } from '../src/documents.js';
import { Ingress } from '../src/ingress.js';
import { ItsmWache, itsmEreignisse } from '../src/itsm-wache.js';
import { Runner } from '../src/runner.js';
import { wachenLesen } from '../src/wachen-zustand.js';

const tmp = mkdtempSync(join(tmpdir(), 'itsm-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const leererHub = {
  aufrufen: async () => ({ ok: true, result: {} }),
  melden: async () => ({ ok: true }),
  bereicheMelden: async () => ({ ok: true }),
  gesundheit: async () => ({ ok: true }),
  suchen: async () => [],
  schema: async () => ({}),
  eingangLesen: async (nach) => ({ eintraege: [], letzte: nach }),
};

function konfig(name) {
  return konfigurationLaden(
    {
      hub: 'http://hub.test',
      agent: 'persona',
      arbeitsbereiche: { standard: { pfad: tmp, titel: 'Test' } },
      pi_durable: {
        storage: join(tmp, name, 'fyos.sqlite'),
        security: { token: 'test-token-test-token-test-token-00' },
        proactive: { enabled: false },
        egress: { enabled: false },
        browser: { enabled: false },
        desktop: { enabled: false },
      },
    },
    {},
  );
}

async function runnerStarten(cfg) {
  const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: [{ id: 'hausmodell' }, { id: 'hausmodell-max' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runner = new Runner(cfg, { models, hub: leererHub });
  await runner.start();
  return runner;
}

/** Ein Hub mit Vorgängen, die der Test verändern kann. */
function itsmHub({ vorgaenge = {}, wartend = [], liegt = [] } = {}) {
  const hub = {
    vorgaenge,
    wartend,
    liegt,
    kaputt: new Set(),
    aufrufe: [],
    async aufrufen(werkzeug, argumente) {
      hub.aufrufe.push({ werkzeug, argumente });
      if (hub.kaputt.has(werkzeug)) throw new Error(`${werkzeug} nicht erreichbar`);
      if (werkzeug === 'itsm.wartend') return { ok: true, result: { tickets: hub.wartend } };
      if (werkzeug === 'denken.liegt') return { ok: true, result: { liste: hub.liegt } };
      if (werkzeug === 'itsm.vorgang') {
        const v = hub.vorgaenge[argumente.id];
        return v ? { ok: true, result: v } : { ok: false, fehler: 'kein Vorgang' };
      }
      return { ok: false, fehler: `unbekannt: ${werkzeug}` };
    },
  };
  return hub;
}

const still = { info() {}, warn() {} };

function vorgang(id, status, verlauf = [], extra = {}) {
  return { id, titel: `Titel ${id}`, status, verlauf, ...extra };
}

test('itsmEreignisse: der erste Blick erzeugt nur den Stand', () => {
  const v = vorgang('VOR-1', 'waiting_approval', [{ ts: '2026-10-24T08:00:00Z', ereignis: 'comment', wer: 'max', text: 'alt' }]);
  const { ereignisse, stand } = itsmEreignisse({}, v, Date.now());
  assert.deepEqual(ereignisse, []);
  assert.equal(stand.status, 'waiting_approval');
  assert.equal(stand.ts, '2026-10-24T08:00:00Z');
});

test('itsmEreignisse: Besitzer-Kommentar, Freigabe, Ablehnung und fremde Wechsel', () => {
  const alt = { id: 'VOR-2', status: 'waiting_approval', ts: '2026-10-24T08:00:00Z' };
  const kommentar = { ts: '2026-10-24T09:00:00Z', ereignis: 'comment', wer: 'max', text: '  Bitte so.  ' };
  const fremd = { ts: '2026-10-24T09:01:00Z', ereignis: 'comment', wer: 'katie', text: 'Hallo' };

  const wechsel = (status, wer) => ({
    ts: '2026-10-24T09:05:00Z',
    ereignis: 'updated',
    wer,
    text: `Status waiting_approval→${status}`,
  });

  let r = itsmEreignisse(alt, vorgang('VOR-2', 'in_progress', [kommentar, fremd, wechsel('in_progress', 'max')]), Date.now());
  assert.deepEqual(
    r.ereignisse.map((e) => [e.id, e.klasse, e.von, e.quelle, e.bezug]),
    [
      ['itsm:VOR-2:kommentar:2026-10-24T09:00:00Z', 'max', 'max', 'itsm', 'VOR-2'],
      ['itsm:VOR-2:erteilt:2026-10-24T09:05:00Z', 'max', 'max', 'itsm', 'VOR-2'],
    ],
  );
  assert.equal(r.ereignisse[0].text, 'Besitzer hat am Vorgang VOR-2 „Titel VOR-2“ kommentiert:\nBitte so.');
  assert.match(r.ereignisse[1].text, /^Besitzer hat die Freigabe am Vorgang VOR-2 „Titel VOR-2“ erteilt \(waiting_approval → in_progress\)\. Führe genau den beantragten Schritt aus/);

  r = itsmEreignisse(alt, vorgang('VOR-2', 'triage', [wechsel('triage', 'max')]), Date.now());
  assert.equal(r.ereignisse[0].id, 'itsm:VOR-2:abgelehnt:2026-10-24T09:05:00Z');
  assert.match(r.ereignisse[0].text, /abgelehnt \(→ triage\)/);

  r = itsmEreignisse(alt, vorgang('VOR-2', 'closed', [wechsel('closed', 'max')]), Date.now());
  assert.equal(r.ereignisse[0].id, 'itsm:VOR-2:beendet:2026-10-24T09:05:00Z');

  // Wechsel durch einen anderen Akteur ist keine Freigabe von Besitzer: weckt nichts.
  r = itsmEreignisse(alt, vorgang('VOR-2', 'in_progress', [wechsel('in_progress', 'persona')]), Date.now());
  assert.deepEqual(r.ereignisse, []);
});

test('itsmEreignisse: Wiedervorlage genau einmal, nur bis resolved/closed', () => {
  const faellig = '2026-10-24T10:00:00Z';
  const jetzt = Date.parse('2026-10-24T11:00:00Z');
  const alt = { id: 'VOR-3', status: 'in_progress', ts: '' };
  let r = itsmEreignisse(alt, vorgang('VOR-3', 'in_progress', [], { wiedervorlage: faellig }), jetzt);
  assert.equal(r.ereignisse.length, 1);
  assert.equal(r.ereignisse[0].klasse, 'hintergrund');
  assert.equal(r.ereignisse[0].von, 'itsm');
  assert.equal(r.ereignisse[0].id, `itsm:VOR-3:wiedervorlage:${faellig}`);
  assert.equal(r.stand.wiedervorlage_gemeldet, faellig);

  r = itsmEreignisse(r.stand, vorgang('VOR-3', 'in_progress', [], { wiedervorlage: faellig }), jetzt);
  assert.deepEqual(r.ereignisse, []);

  // Noch nicht fällig, und erledigte Vorgänge melden nichts.
  r = itsmEreignisse(alt, vorgang('VOR-3', 'in_progress', [], { wiedervorlage: '2026-10-25T10:00:00Z' }), jetzt);
  assert.deepEqual(r.ereignisse, []);
  r = itsmEreignisse(alt, vorgang('VOR-3', 'resolved', [], { wiedervorlage: faellig }), jetzt);
  assert.deepEqual(r.ereignisse, []);
  // Eine Zeit ohne Zeitzone gilt als UTC.
  r = itsmEreignisse(alt, vorgang('VOR-3', 'in_progress', [], { wiedervorlage: '2026-10-24T10:00:00' }), jetzt);
  assert.equal(r.ereignisse.length, 1);
});

test('Wache: Ereignisse werden Eingänge, nichts doppelt, auch nicht nach Neustart', async () => {
  const cfg = konfig('wache');
  let runner = await runnerStarten(cfg);
  const hub = itsmHub({
    vorgaenge: { 'VOR-7': vorgang('VOR-7', 'waiting_approval', [{ ts: '2026-10-24T08:00:00Z', ereignis: 'created', wer: 'persona' }]) },
    wartend: [
      { id: 'VOR-7', zustaendig: 'persona' },
      { id: 'VOR-8', zustaendig: 'katie' }, // gehört einem anderen
    ],
  });
  const eingereiht = [];
  const bauen = () =>
    new ItsmWache({
      cfg: { agent: 'persona', itsm: { pruefen_s: 0.02 } },
      hub,
      harness: runner.harness,
      einreihen: async (e) => void eingereiht.push(e),
      log: still,
      jetzt: () => Date.parse('2026-10-24T12:00:00Z'),
    });
  try {
    let wache = bauen();
    assert.deepEqual(await wache.runde(), []); // erster Blick
    assert.deepEqual(wache.zustand().wartet_auf_max, ['VOR-7']);
    assert.ok(!hub.aufrufe.some((a) => a.werkzeug === 'itsm.vorgang' && a.argumente.id === 'VOR-8'));

    hub.vorgaenge['VOR-7'] = vorgang('VOR-7', 'in_progress', [
      { ts: '2026-10-24T08:00:00Z', ereignis: 'created', wer: 'persona' },
      { ts: '2026-10-24T09:00:00Z', ereignis: 'comment', wer: 'max', text: 'Los' },
      { ts: '2026-10-24T09:05:00Z', ereignis: 'updated', wer: 'max', text: 'waiting_approval→in_progress' },
    ]);
    const erste = await wache.runde();
    assert.deepEqual(
      erste.map((e) => [e.id, e.klasse]),
      [
        ['itsm:VOR-7:kommentar:2026-10-24T09:00:00Z', 'max'],
        ['itsm:VOR-7:erteilt:2026-10-24T09:05:00Z', 'max'],
      ],
    );
    assert.equal(eingereiht.length, 2);
    assert.deepEqual(await wache.runde(), [], 'derselbe Stand meldet nichts mehr');
    assert.equal(eingereiht.length, 2);
    assert.equal(wache.zustand().gemeldet, 2);

    // Neustart: neuer Runner auf derselben Datei, neue Wache; der Stand kommt aus dem Dokument.
    await runner.close().catch(() => {});
    runner = await runnerStarten(cfg);
    wache = bauen();
    assert.deepEqual(await wache.runde(), []);
    assert.equal(eingereiht.length, 2);
    const d = await wachenLesen(runner.harness);
    assert.equal(d.itsm.vorgaenge['VOR-7'].status, 'in_progress');
  } finally {
    await runner.close().catch(() => {});
  }
});

test('Einreihen in die echte Warteschlange ist idempotent über die Id', async () => {
  const runner = await runnerStarten(konfig('ingress'));
  const cfg = konfig('ingress');
  const ingress = new Ingress({ cfg, runner, hub: leererHub });
  const hub = itsmHub({
    vorgaenge: { 'INC-5': vorgang('INC-5', 'in_progress', [{ ts: '2026-10-24T08:00:00Z', ereignis: 'created', wer: 'x' }]) },
    wartend: [{ id: 'INC-5', zustaendig: 'persona' }],
  });
  const wache = new ItsmWache({
    cfg: { agent: 'persona' },
    hub,
    harness: runner.harness,
    einreihen: (e) => ingress.einreihen(e),
    log: still,
  });
  try {
    await wache.runde();
    hub.vorgaenge['INC-5'] = vorgang('INC-5', 'in_progress', [
      { ts: '2026-10-24T08:00:00Z', ereignis: 'created', wer: 'x' },
      { ts: '2026-10-24T09:00:00Z', ereignis: 'comment', wer: 'max', text: 'Hallo' },
    ]);
    const e = (await wache.runde())[0];
    // Dasselbe Ereignis noch einmal anbieten (z. B. nach einem Absturz vor dem Sichern des Stands).
    assert.equal(await ingress.einreihen(e), false);
    const w = await runner.harness.snapshot(Wartend, BACKGROUND_CONTEXT);
    assert.equal(w.eintraege.length, 1);
    assert.equal(w.eintraege[0].stromId, 'itsm:INC-5:kommentar:2026-10-24T09:00:00Z');
    assert.equal(w.eintraege[0].klasse, 'max');
    assert.equal(w.eintraege[0].quelle, 'itsm');
    assert.equal(w.eintraege[0].von, 'max');
    assert.equal(w.eintraege[0].bezug, 'INC-5');
  } finally {
    await runner.close().catch(() => {});
  }
});

test('Bezug merken, Rückstand und Fehler: die Wache läuft weiter', async () => {
  const runner = await runnerStarten(konfig('fehler'));
  const hub = itsmHub({
    vorgaenge: {
      'PRB-9': vorgang('PRB-9', 'in_progress', [{ ts: '2026-10-24T08:00:00Z', ereignis: 'created', wer: 'x' }]),
      'WB-4': vorgang('WB-4', 'in_progress', [{ ts: '2026-10-24T08:00:00Z', ereignis: 'created', wer: 'x' }]),
    },
    liegt: [{ id: 'WB-4', grund: 'persona' }, { id: 'WB-5', grund: 'max' }, { id: 'kein-vorgang', grund: 'persona' }],
  });
  const eingereiht = [];
  const wache = new ItsmWache({
    cfg: { agent: 'persona', itsm: { pruefen_s: 0.02 } },
    hub,
    harness: runner.harness,
    einreihen: async (e) => void eingereiht.push(e),
    log: still,
  });
  try {
    wache.bezugMerken('PRB-9');
    wache.bezugMerken('Quatsch'); // kein Vorgangsname: ignoriert
    hub.kaputt.add('itsm.wartend');
    await wache.runde(); // wirft nicht
    assert.match(wache.zustand().fehler, /itsm\.wartend/);
    assert.equal(wache.zustand().vorgaenge, 2);
    const gelesen = hub.aufrufe.filter((a) => a.werkzeug === 'itsm.vorgang').map((a) => a.argumente.id);
    assert.deepEqual(gelesen.sort(), ['PRB-9', 'WB-4']);

    // Läuft die Schleife und ein Vorgang kommt zurück, ohne dass etwas abstürzt.
    hub.kaputt.add('itsm.vorgang');
    assert.equal(wache.start(), true);
    await new Promise((r) => setTimeout(r, 120));
    hub.kaputt.delete('itsm.vorgang');
    hub.vorgaenge['PRB-9'] = vorgang('PRB-9', 'in_progress', [
      { ts: '2026-10-24T08:00:00Z', ereignis: 'created', wer: 'x' },
      { ts: '2026-10-24T09:00:00Z', ereignis: 'comment', wer: 'max', text: 'Neu' },
    ]);
    const ende = Date.now() + 5000;
    while (!eingereiht.length && Date.now() < ende) await new Promise((r) => setTimeout(r, 25));
    await wache.stop();
    assert.equal(eingereiht.length, 1);
    assert.equal(eingereiht[0].klasse, 'max');
  } finally {
    await runner.close().catch(() => {});
  }
});

test('an/aus nach der Konfiguration', () => {
  const dummy = { hub: {}, harness: {}, einreihen: async () => {} };
  assert.equal(new ItsmWache({ cfg: {}, ...dummy }).an, true);
  assert.equal(new ItsmWache({ cfg: { itsm: { an: false } }, ...dummy }).an, false);
  assert.equal(new ItsmWache({ cfg: { itsm: { an: false } }, ...dummy }).start(), false);
});
