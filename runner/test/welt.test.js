import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FEHLT, Weltmodell, auszug, pfadHolen, weltAbleiten, weltblock } from '../src/welt.js';

const MIN = 60_000;

function stubHub(antworten) {
  const aufrufe = [];
  return {
    aufrufe,
    async aufrufen(werkzeug, argumente, opt) {
      aufrufe.push({ werkzeug, argumente, opt });
      const a = antworten[werkzeug];
      if (a instanceof Error) throw a;
      if (typeof a === 'function') return a();
      return a ?? { ok: false, fehler: 'unbekannt' };
    },
  };
}

function modell(antworten, extra = {}) {
  const ordner = mkdtempSync(join(tmpdir(), 'welt-'));
  let jetzt = extra.jetzt ?? 1_000_000_000_000;
  const hub = stubHub(antworten);
  const cfg = {
    pi_durable: { storage: join(ordner, 'fyos.sqlite') },
    welt: {
      quellen: extra.quellen ?? {
        augen: { werkzeug: 'augen.zustand', felder: ['erreichbar', 'satz'] },
        cluster: { werkzeug: 'cluster.lage', felder: ['satz'] },
      },
      ...(extra.welt ?? {}),
    },
  };
  const w = new Weltmodell({ cfg, hub, log: () => {}, jetzt: () => jetzt, fakten: extra.fakten });
  return { w, hub, ordner, zeit: (ms) => (jetzt += ms), datei: join(ordner, 'welt.json') };
}

test('pfadHolen schreitet durch Hüllen und endet auf deren Wert', () => {
  const welt = { spielmodus: { wert: true, t: 1, quelle: 'runner' }, quellen: { a: { ok: true, wert: { x: [5, 6] } } } };
  assert.equal(pfadHolen(welt, 'spielmodus'), true);
  assert.equal(pfadHolen(welt, 'quellen.a.wert.x.1'), 6);
  assert.equal(pfadHolen({ g: { wert: { n: 3 }, t: 1, quelle: 'runner' } }, 'g.n'), 3);
  assert.equal(pfadHolen(welt, 'quellen.b'), FEHLT);
});

test('auszug behält nur genannte Felder, kürzt Großes und rät nichts', () => {
  const erg = { satz: 'ok', vermutung: { bereich: 'Küche', sicherheit: 0.8 }, extra: 'x'.repeat(5000) };
  assert.deepEqual(auszug(erg, ['satz', 'vermutung.bereich', 'fehlt']), { satz: 'ok', vermutung: { bereich: 'Küche' } });
  assert.equal(auszug({ a: 1 }, []).a, 1);
  assert.deepEqual(auszug({ satz: 'kurz', roh: 'y'.repeat(3000) }, null), { satz: 'kurz' });
  assert.ok(auszug({ roh: 'y'.repeat(3000) }, null).vorschau.length <= 600);
  assert.ok(auszug({ x: 'z'.repeat(2000) }, ['x']).x.length <= 600);
});

test('Weltbild aus Stub-Quellen: Zeit, Quelle, Fakten des Runners und welt.json', async () => {
  const { w, hub, datei } = modell(
    {
      'augen.zustand': { ok: true, result: { erreichbar: true, satz: 'Alle Kameras da', roh: 'verworfen' } },
      'cluster.lage': { ok: true, result: { satz: 'Cluster ruhig' } },
    },
    { fakten: () => ({ spielmodus: false }) },
  );
  const bild = await w.schlagen();
  assert.equal(bild.v, 1);
  assert.equal(bild.herzschlag, 1);
  assert.deepEqual(bild.quellen.augen.wert, { erreichbar: true, satz: 'Alle Kameras da' });
  assert.equal(bild.quellen.augen.ok, true);
  assert.equal(bild.quellen.augen.quelle, 'hub:augen.zustand');
  assert.equal(typeof bild.quellen.augen.t, 'number');
  assert.deepEqual(bild.spielmodus, { wert: false, t: bild.t, quelle: 'runner' });
  assert.equal(hub.aufrufe[0].opt.ansicht, 'voll');
  const auf = JSON.parse(readFileSync(datei, 'utf8'));
  assert.equal(auf.quellen.cluster.wert.satz, 'Cluster ruhig');
  assert.equal(w.zustand().quellen_ok, 2);
});

test('Ausfall einer Quelle: zuletzt Bekanntes bleibt, AUSGEFALLEN mit Grund und Zeit, nichts geraten', async () => {
  let ok = true;
  const { w, zeit } = modell({
    'augen.zustand': () => (ok ? { ok: true, result: { erreichbar: true, satz: 'da' } } : { ok: false, fehler: 'Hub 502' }),
    'cluster.lage': { ok: true, result: { satz: 'ruhig' } },
  });
  await w.schlagen();
  zeit(5 * MIN);
  ok = false;
  const erster = await w.schlagen();
  const q = erster.quellen.augen;
  assert.equal(q.ok, false);
  assert.equal(q.fehler, 'Hub 502');
  assert.equal(q.wert.satz, 'da');
  assert.ok(q.ausfall_seit > q.t);
  zeit(2 * MIN);
  const zweiter = await w.schlagen();
  assert.equal(zweiter.quellen.augen.ausfall_seit, q.ausfall_seit, 'der erste Fehlschlag bleibt der Beginn');
  assert.equal(zweiter.quellen.cluster.ok, true);
  const block = weltblock(zweiter, zweiter.t);
  assert.match(block, /augen: AUSGEFALLEN seit 2 min \(Hub 502\); zuletzt bekannt \(7 min\): erreichbar=true; da/);
  assert.match(block, /cluster \(0 s\): ruhig/);
  assert.equal(weltAbleiten(zweiter, zweiter.t).quellen.augen.stumm_min, 7);
  assert.equal(weltAbleiten(zweiter, zweiter.t).quellen.cluster.stumm_min, 0);
});

test('eine Quelle, die nie antwortete, steht als AUSGEFALLEN mit „nichts bekannt“; vor dem ersten Versuch „noch nicht abgefragt“', async () => {
  const { w } = modell({ 'augen.zustand': new Error('Zeitüberschreitung'), 'cluster.lage': { ok: true, result: { satz: 'x' } } });
  assert.match(w.weltblock(), /augen: noch nicht abgefragt/);
  await w.schlagen();
  assert.match(w.weltblock(), /augen: AUSGEFALLEN seit 0 s \(Zeitüberschreitung\); nichts bekannt/);
});

test('Neustart übernimmt Bekanntes mit altem Zeitstempel, nicht als frisch', async () => {
  const eins = modell({ 'augen.zustand': { ok: true, result: { erreichbar: true, satz: 'da' } }, 'cluster.lage': { ok: true, result: { satz: 'x' } } });
  const altes = await eins.w.schlagen();
  const cfg = { pi_durable: { storage: join(eins.ordner, 'fyos.sqlite') }, welt: { quellen: { augen: { werkzeug: 'augen.zustand', felder: ['satz'] } } } };
  const zwei = new Weltmodell({ cfg, hub: stubHub({}), log: () => {}, jetzt: () => altes.t + 10 * MIN });
  const q = zwei.welt().quellen.augen;
  assert.equal(q.ok, false);
  assert.equal(q.t, altes.quellen.augen.t);
  assert.equal(q.fehler, 'seit dem Neustart noch nicht abgefragt');
  assert.equal(q.wert.satz, 'da');
});

test('Block-Kürzung: höchstens block_max, kurze Zeilen bleiben ganz, lange teilen den Rest', () => {
  const jetzt = 1_000_000_000_000;
  const quelle = (satz) => ({ ok: true, t: jetzt, versuch_t: jetzt, wert: { satz } });
  const welt = {
    spielmodus: { wert: true, t: jetzt, quelle: 'runner' },
    quellen: { kurz: quelle('ja'), lang1: quelle('a'.repeat(900)), lang2: quelle('b'.repeat(900)) },
  };
  const block = weltblock(welt, jetzt, 400);
  assert.ok(block.length <= 400, `Länge ${block.length}`);
  assert.match(block, /Spielmodus: AN \(Hauptserver gehört dem Spiel\)/);
  assert.match(block, /kurz \(0 s\): ja/);
  assert.match(block, /lang1 \(0 s\): a+…/);
  assert.match(block, /lang2 \(0 s\): b+…/);
  assert.equal(weltblock(null, jetzt), '');
  assert.equal(weltblock({ quellen: {} }, jetzt), '');
});

test('im_block false lässt eine Quelle im Weltblock weg; aufzeichnen false nur aus Aufzeichnung und deren Block', async () => {
  const { w } = modell(
    {
      'os.lage': { ok: true, result: { satz: 'Safari offen' } },
      'anwesenheit.raeume': { ok: true, result: { satz: 'Küche belegt seit 5 min', belegt: ['kueche'] } },
      'cluster.lage': { ok: true, result: { satz: 'ruhig' } },
    },
    {
      quellen: {
        os: { werkzeug: 'os.lage', felder: ['satz'], aufzeichnen: false, im_block: false },
        raeume: { werkzeug: 'anwesenheit.raeume', felder: ['satz', 'belegt'], aufzeichnen: false, im_block: true },
        cluster: { werkzeug: 'cluster.lage', felder: ['satz'] },
      },
    },
  );
  const bild = await w.schlagen();
  const block = w.weltblock();
  assert.doesNotMatch(block, /^os/m);
  assert.match(block, /raeume \(0 s\): Küche belegt/);
  const fuer = w.fuerAufzeichnung(bild);
  assert.equal(fuer.quellen.raeume.wert, null);
  assert.equal(fuer.quellen.raeume.ausgelassen, true);
  assert.equal(fuer.quellen.cluster.wert.satz, 'ruhig');
  const fuerBlock = w.blockFuerAufzeichnung(block);
  assert.doesNotMatch(fuerBlock, /raeume/);
  assert.match(fuerBlock, /cluster \(0 s\)/);
});

test('Herzschlag ruft beiHerzschlag; ein Fehler dort hält ihn nicht an', async () => {
  const bilder = [];
  const ordner = mkdtempSync(join(tmpdir(), 'welt-'));
  const w = new Weltmodell({
    cfg: { pi_durable: { storage: join(ordner, 'x.sqlite') }, welt: { quellen: { c: { werkzeug: 'cluster.lage', felder: ['satz'] } } } },
    hub: stubHub({ 'cluster.lage': { ok: true, result: { satz: 'x' } } }),
    log: () => {},
    beiHerzschlag: (b) => {
      bilder.push(b);
      throw new Error('Reflex kaputt');
    },
  });
  await w.schlagen();
  await w.schlagen();
  assert.equal(bilder.length, 2);
  assert.equal(w.zustand().herzschlaege, 2);
});

test('welt: null schaltet aus; ohne Schlüssel gelten die Vorgaben; Pfad folgt cfg.welt.datei', () => {
  const aus = new Weltmodell({ cfg: { welt: null }, hub: stubHub({}), log: () => {} });
  assert.equal(aus.aktiv, false);
  assert.equal(aus.weltblock(), '');
  aus.start();
  aus.stop();
  const vorgabe = new Weltmodell({ cfg: { pi_durable: { storage: '/tmp/x/fyos.sqlite' } }, hub: stubHub({}), log: () => {} });
  assert.equal(vorgabe.datei, '/tmp/x/welt.json');
  assert.ok(Object.keys(vorgabe.welt().quellen).includes('raeume'));
  assert.equal(vorgabe.blockMax, 1500);
  const eigene = new Weltmodell({ cfg: { welt: { datei: '/tmp/y/welt.json', herzschlag_s: 0, quellen: {} } }, hub: stubHub({}), log: () => {} });
  assert.equal(eigene.datei, '/tmp/y/welt.json');
  assert.equal(eigene.herzschlag_s, 1, 'mindestens eine Sekunde, wie im RPC-Runner');
});

test('MCP-Mantel um das Ergebnis wird ausgepackt', async () => {
  const { w } = modell(
    { 'augen.zustand': { ok: true, result: { content: [{ type: 'text', text: '{"erreichbar":true,"satz":"da"}' }] } }, 'cluster.lage': { ok: true, result: { satz: 'x' } } },
  );
  const bild = await w.schlagen();
  assert.equal(bild.quellen.augen.wert.satz, 'da');
});

test('welt.json wird atomar ersetzt und ist lesbar nach Herzschlag', async () => {
  const { w, datei } = modell({ 'augen.zustand': { ok: true, result: { satz: 'a' } }, 'cluster.lage': { ok: true, result: { satz: 'b' } } });
  writeFileSync(datei, '{}');
  await w.schlagen();
  assert.equal(JSON.parse(readFileSync(datei, 'utf8')).herzschlag, 1);
});
