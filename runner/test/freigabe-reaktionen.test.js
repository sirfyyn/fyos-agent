/**
 * Tests der Reaktions-Chips an der Matrix-Freigabemeldung (freigabe-reaktionen.js). Matrix (Sender und Lauscher) ist eine Attrappe:
 * nichts wird gesendet, nichts gelesen. Geprüft: Chips je Risiko, Zuordnung Ereignis-Id ↔ Freigabe über einen Neustart, jede Regel
 * (✅ nur low/medium nicht zerstörerisch, ❌ immer, ⏳ später, fremdes Konto, falsche Meldung, doppelt, schon entschieden, entfernt),
 * Standard aus, Zähler ohne Inhalte.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { neueFreigabe } from '../src/documents.js';
import { FreigabeMeldung, konfigNormalisieren, matrixKanal, nachrichtBauen } from '../src/freigabe-meldung.js';
import { FreigabeReaktionen, chipsFuer } from '../src/freigabe-reaktionen.js';

const T0 = Date.UTC(2026, 6, 15, 10, 0, 0); // 12:00 Berlin, keine Ruhezeit
const MIN = 60_000;
const MAX = '@max:matrix.fyos.local';
const still = { info() {}, warn() {} };

const freigabe = (id, extra = {}) => ({
  ...neueFreigabe({ id, conversationId: 1, aktion: `Aktion ${id}`, risiko: 'low', kontext: 'Kontext', ...extra }),
  erstellt: T0 - 10 * MIN,
});

function speicherMem() {
  const d = { freigabemeldung: {}, freigabereaktionen: {} };
  return { d, lesen: async () => JSON.parse(JSON.stringify(d)), aendern: async (fn) => void fn(d) };
}

/** Matrix-Attrappe: Sender (senden, reagieren, bearbeiten, zurueckziehen, antworten) und Lauscher-Puffer (reaktionenLesen). */
function matrixStub() {
  let zaehler = 0;
  const k = {
    name: 'matrix',
    befehl: true,
    chips: true,
    kontextMax: 600,
    gesendet: [],
    reaktionen: [], // [eventId, emoji]
    bearbeitet: [], // [eventId, text]
    zurueckgezogen: [],
    antworten_: [],
    puffer: [],
    lesen: { ok: true },
    async senden(n) {
      k.gesendet.push(n);
      return { ok: true, eventId: `$m${k.gesendet.length}` };
    },
    async reagieren(eid, emoji) {
      k.reaktionen.push([eid, emoji]);
      return { ok: true, eventId: `$c${++zaehler}` };
    },
    async bearbeiten(eid, text) {
      k.bearbeitet.push([eid, text]);
      return { ok: true };
    },
    async zurueckziehen(eid) {
      k.zurueckgezogen.push(eid);
      return { ok: true };
    },
    async antworten(text, bezug) {
      k.antworten_.push([text, bezug]);
      return { ok: true };
    },
    async reaktionenLesen(seit) {
      if (!k.lesen.ok) return { ok: false, grund: 'Lauscher nicht erreichbar' };
      return { ok: true, naechste: k.puffer.length ? k.puffer.at(-1).n : 0, ereignisse: k.puffer.filter((e) => e.n > seit) };
    },
    /** Besitzer reagiert (landet im Lauscher-Puffer). */
    reagiert(key, ziel, { id, sender = MAX } = {}) {
      const n = k.puffer.length + 1;
      k.puffer.push({ n, typ: 'reaktion', id: id ?? `$r${n}`, ziel, key, sender, ts: T0 });
      return id ?? `$r${n}`;
    },
    entfernt(ziel) {
      const n = k.puffer.length + 1;
      k.puffer.push({ n, typ: 'entfernt', id: `$x${n}`, ziel, key: null, sender: MAX, ts: T0 });
    },
  };
  return k;
}

function aufbau({ freigaben: liste, an = true, speicher = speicherMem(), kanal = matrixStub() } = {}) {
  const uhr = { t: T0 };
  const konfig = konfigNormalisieren({ kanaele: ['matrix'], matrix: { reaktionen: { an } } });
  const aufrufe = [];
  const entscheiden = async (id, o) => {
    aufrufe.push([id, o]);
    const f = liste.find((x) => x.id === id);
    if (!f) throw new Error('Freigabe nicht gefunden');
    if (f.status !== 'offen') throw new Error(`Freigabe ist bereits ${f.status}`);
    f.status = o.entscheidung;
    f.entschiedenVon = o.von;
  };
  const verdeckt = new Set(); // für die Meldung unsichtbar (damit jede Freigabe einzeln gemeldet wird, nicht gebündelt)
  const bau = (kn = kanal) => {
    const w = new FreigabeMeldung({ konfig, kanaele: [kn], freigaben: async () => liste.filter((f) => !verdeckt.has(f.id)), speicher, log: still, jetzt: () => uhr.t });
    w.reaktionen = new FreigabeReaktionen({
      konfig,
      kanal: kn,
      freigaben: async () => liste,
      entscheiden,
      zurueckstellen: (id, bis) => w.zurueckstellen(id, bis),
      speicher,
      log: still,
      jetzt: () => uhr.t,
    });
    return w;
  };
  return { uhr, speicher, kanal, liste, aufrufe, bau, verdeckt, w: bau() };
}

/** Meldet nur die Freigabe `id` (einzeln) und gibt die Ereignis-Id der Meldung zurück. */
async function melden(a, id) {
  a.verdeckt.clear();
  for (const f of a.liste) if (f.id !== id) a.verdeckt.add(f.id);
  await a.w.pruefen();
  a.verdeckt.clear();
  const i = a.kanal.gesendet.findIndex((n) => n.bezug.includes(id));
  assert.ok(i >= 0, `Meldung zu ${id} fehlt`);
  return `$m${i + 1}`;
}

const zaehler = (a) => a.w.reaktionen.zustand();

test('Chips je Risiko: low/medium nicht zerstörerisch bekommt ✅ ❌ ⏳, hoch oder zerstörerisch nur ❌ ⏳ mit Hinweis in der Meldung', async () => {
  assert.deepEqual(chipsFuer(freigabe('a', { risiko: 'low' })), ['✅', '❌', '⏳']);
  assert.deepEqual(chipsFuer(freigabe('a', { risiko: 'medium' })), ['✅', '❌', '⏳']);
  assert.deepEqual(chipsFuer(freigabe('a', { risiko: 'high' })), ['❌', '⏳']);
  assert.deepEqual(chipsFuer(freigabe('a', { risiko: 'low', zerstoererisch: true })), ['❌', '⏳']);

  const a = aufbau({ freigaben: [freigabe('f1'), freigabe('f2', { risiko: 'high' })] });
  const m1 = await melden(a, 'f1');
  const m2 = await melden(a, 'f2');
  assert.deepEqual(a.kanal.reaktionen.filter(([e]) => e === m1).map(([, x]) => x), ['✅', '❌', '⏳']);
  assert.deepEqual(a.kanal.reaktionen.filter(([e]) => e === m2).map(([, x]) => x), ['❌', '⏳']);
  const text = (id) => a.kanal.gesendet.find((n) => n.bezug.includes(id)).text;
  assert.match(text('f1'), /✅ erlauben, ❌ ablehnen, ⏳ später/);
  assert.match(text('f2'), /Erlauben nur in der App \(Halten\)/);
  assert.doesNotMatch(text('f2'), /✅ erlauben/);
  assert.equal(zaehler(a).gesetzt, 5);
});

test('Standard aus: keine Chips, kein Reaktions-Hinweis, nichts wird abgeholt', async () => {
  assert.equal(konfigNormalisieren({ kanaele: ['matrix'] }).matrix.reaktionen.an, false);
  const kanal = matrixStub();
  kanal.chips = false;
  const a = aufbau({ freigaben: [freigabe('f1')], an: false, kanal });
  a.w.reaktionen = null; // wie ausKonfig bei an=false
  await a.w.pruefen();
  assert.deepEqual(kanal.reaktionen, []);
  assert.doesNotMatch(kanal.gesendet[0].text, /Reaktion/);
  assert.match(kanal.gesendet[0].text, /Eine Antwort auf diese Nachricht entscheidet nichts/);
  assert.deepEqual(a.w.zustand().reaktionen, { an: false });
});

test('✅ bei niedrigem Risiko erteilt über den App-Weg (von matrix-reaktion), bestätigt, markiert die Meldung und zieht die Chips zurück', async () => {
  const a = aufbau({ freigaben: [freigabe('f1')] });
  const m = await melden(a, 'f1');
  a.kanal.reagiert('✅', m);
  await a.w.reaktionen.pruefen();
  assert.equal(a.aufrufe.length, 1);
  assert.equal(a.aufrufe[0][0], 'f1');
  assert.equal(a.aufrufe[0][1].entscheidung, 'erteilt');
  assert.equal(a.aufrufe[0][1].von, 'matrix-reaktion');
  assert.match(a.aufrufe[0][1].notiz, /Matrix-Reaktion ✅/);
  assert.match(a.kanal.antworten_[0][0], /Freigabe f1 erteilt per ✅/);
  assert.equal(a.kanal.bearbeitet.length, 1);
  assert.match(a.kanal.bearbeitet[0][1], /Erledigt: erteilt per ✅/);
  assert.equal(a.kanal.zurueckgezogen.length, 3);
  const z = zaehler(a);
  assert.equal(z.angenommen, 1);
  assert.equal(z.ignoriert, 0);
});

test('❌ lehnt immer ab, auch bei hohem Risiko; 👍 und 👎 zählen wie ✅ und ❌', async () => {
  const a = aufbau({ freigaben: [freigabe('f1', { risiko: 'high' }), freigabe('f2'), freigabe('f3')] });
  const m1 = await melden(a, 'f1');
  const m2 = await melden(a, 'f2');
  const m3 = await melden(a, 'f3');
  a.kanal.reagiert('❌', m1);
  a.kanal.reagiert('👍', m2);
  a.kanal.reagiert('👎', m3);
  await a.w.reaktionen.pruefen();
  const nach = Object.fromEntries(a.aufrufe.map(([id, o]) => [id, o.entscheidung]));
  assert.deepEqual(nach, { f1: 'abgelehnt', f2: 'erteilt', f3: 'abgelehnt' });
  assert.equal(zaehler(a).abgelehnt, 2);
  assert.equal(zaehler(a).angenommen, 1);
});

test('✅ bei hohem Risiko oder zerstörerisch: keine Wirkung, ein Hinweis je Meldung, Freigabe bleibt offen', async () => {
  const a = aufbau({ freigaben: [freigabe('f1', { risiko: 'high' }), freigabe('f2', { zerstoererisch: true })] });
  const m1 = await melden(a, 'f1');
  const m2 = await melden(a, 'f2');
  a.kanal.reagiert('✅', m1);
  a.kanal.reagiert('👍', m1);
  a.kanal.reagiert('✅', m2);
  await a.w.reaktionen.pruefen();
  assert.deepEqual(a.aufrufe, []);
  assert.deepEqual(a.liste.map((f) => f.status), ['offen', 'offen']);
  assert.equal(a.kanal.antworten_.length, 2); // je Meldung ein Hinweis, nicht je Reaktion
  assert.match(a.kanal.antworten_[0][0], /Erlauben nur in der App \(Halten\)/);
  assert.equal(zaehler(a).verweigert, 3);
  assert.equal(a.kanal.zurueckgezogen.length, 0); // die Meldung bleibt in Kraft
});

test('fremdes Konto, falsche Meldung, anderes Emoji: ignoriert und gezählt, nichts entschieden', async () => {
  const a = aufbau({ freigaben: [freigabe('f1')] });
  const m = await melden(a, 'f1');
  a.kanal.reagiert('✅', m, { sender: '@syl:matrix.fyos.local' });
  a.kanal.reagiert('✅', '$irgendeine-andere-nachricht');
  a.kanal.reagiert('🔥', m);
  await a.w.reaktionen.pruefen();
  assert.deepEqual(a.aufrufe, []);
  assert.equal(zaehler(a).ignoriert, 3);
  assert.equal(a.liste[0].status, 'offen');
});

test('doppelte Reaktion (gleiche Ereignis-Id, auch beim erneuten Abholen) wirkt einmal', async () => {
  const a = aufbau({ freigaben: [freigabe('f1')] });
  const m = await melden(a, 'f1');
  a.kanal.reagiert('✅', m, { id: '$r-doppelt' });
  await a.w.reaktionen.pruefen();
  // Der Lauscher liefert dieselbe Reaktion noch einmal (z. B. nach frischem Zählerstand): seit zurücksetzen.
  a.kanal.puffer = [{ n: 1, typ: 'reaktion', id: '$r-doppelt', ziel: m, key: '✅', sender: MAX, ts: T0 }];
  a.speicher.d.freigabereaktionen.seit = 0;
  await a.w.reaktionen.pruefen();
  assert.equal(a.aufrufe.length, 1);
});

test('schon in der App entschieden: die Reaktion tut nichts, die Meldung wird als erledigt markiert', async () => {
  const a = aufbau({ freigaben: [freigabe('f1')] });
  const m = await melden(a, 'f1');
  a.liste[0].status = 'abgelehnt';
  a.liste[0].entschiedenVon = 'app';
  a.kanal.reagiert('✅', m);
  await a.w.reaktionen.pruefen();
  assert.deepEqual(a.aufrufe, []);
  assert.equal(a.liste[0].status, 'abgelehnt');
  assert.match(a.kanal.bearbeitet[0][1], /Erledigt: abgelehnt \(app\)/);
  assert.equal(a.kanal.zurueckgezogen.length, 3);
});

test('⏳ später: die Freigabe bleibt offen, kein Verfall, die nächste Erinnerung rückt nach hinten', async () => {
  const a = aufbau({ freigaben: [freigabe('f1')] });
  const m = await melden(a, 'f1');
  const vorher = a.speicher.d.freigabemeldung.f1.zuletzt;
  a.kanal.reagiert('⏳', m);
  await a.w.reaktionen.pruefen();
  assert.deepEqual(a.aufrufe, []);
  assert.equal(a.liste[0].status, 'offen');
  assert.ok(a.speicher.d.freigabemeldung.f1.zuletzt > vorher);
  assert.equal(a.speicher.d.freigabemeldung.f1.zuletzt, T0 + 3600_000 - 900_000);
  assert.equal(zaehler(a).zurueckgestellt, 1);
  assert.equal(a.kanal.zurueckgezogen.length, 0); // Chips bleiben, man kann danach noch entscheiden
  // Danach entscheidet ein ✅ noch.
  a.kanal.reagiert('✅', m);
  await a.w.reaktionen.pruefen();
  assert.equal(a.liste[0].status, 'erteilt');
});

test('Reaktion vor dem Abholen wieder entfernt gilt nicht; Entfernung nach der Entscheidung ändert nichts', async () => {
  const a = aufbau({ freigaben: [freigabe('f1'), freigabe('f2')] });
  const m1 = await melden(a, 'f1');
  const m2 = await melden(a, 'f2');
  a.kanal.reagiert('✅', m1, { id: '$r-weg' });
  a.kanal.entfernt('$r-weg');
  await a.w.reaktionen.pruefen();
  assert.deepEqual(a.aufrufe, []);
  assert.equal(a.liste[0].status, 'offen');

  a.kanal.reagiert('✅', m2, { id: '$r-bleibt' });
  await a.w.reaktionen.pruefen();
  assert.equal(a.liste[1].status, 'erteilt');
  a.kanal.entfernt('$r-bleibt');
  await a.w.reaktionen.pruefen();
  assert.equal(a.liste[1].status, 'erteilt');
  assert.equal(a.aufrufe.length, 1);
  assert.ok(zaehler(a).ignoriert >= 2);
});

test('Neustart zwischen Meldung und Reaktion: die Zuordnung steht im Dokument, die Reaktion wirkt genau einmal', async () => {
  const a = aufbau({ freigaben: [freigabe('f1')] });
  const m = await melden(a, 'f1');
  assert.equal(a.speicher.d.freigabereaktionen.meldungen[m].freigabe, 'f1');
  const neu = a.bau(a.kanal); // neue Instanzen über demselben Speicher
  a.kanal.reagiert('✅', m);
  await neu.reaktionen.pruefen();
  await neu.reaktionen.pruefen();
  assert.equal(a.aufrufe.length, 1);
  assert.equal(a.liste[0].status, 'erteilt');
  assert.equal(neu.reaktionen.zustand().angenommen, 1);
});

test('Absturz zwischen Entscheidung und Merken: beim Wiederlesen ist die Freigabe nicht mehr offen, nichts wird doppelt entschieden', async () => {
  const a = aufbau({ freigaben: [freigabe('f1')] });
  const m = await melden(a, 'f1');
  a.kanal.reagiert('✅', m);
  await a.w.reaktionen.pruefen();
  a.speicher.d.freigabereaktionen.seit = 0; // als wäre die Position nicht gespeichert worden
  a.speicher.d.freigabereaktionen.gesehen = [];
  a.speicher.d.freigabereaktionen.meldungen[m].fertig = null;
  await a.w.reaktionen.pruefen();
  assert.equal(a.aufrufe.length, 1);
});

test('Lauscher nicht erreichbar: nichts wird entschieden, der Fehler steht im Zustand, danach läuft es weiter', async () => {
  const a = aufbau({ freigaben: [freigabe('f1')] });
  const m = await melden(a, 'f1');
  a.kanal.reagiert('✅', m);
  a.kanal.lesen = { ok: false };
  await a.w.reaktionen.pruefen();
  assert.deepEqual(a.aufrufe, []);
  assert.match(a.w.reaktionen.zustand().letzter_fehler, /Lauscher/);
  a.kanal.lesen = { ok: true };
  await a.w.reaktionen.pruefen();
  assert.equal(a.aufrufe.length, 1);
  assert.equal(a.w.reaktionen.zustand().letzter_fehler, null);
});

test('Fehler beim Entscheiden wird gezählt; "bereits entschieden" zählt als ignoriert', async () => {
  const a = aufbau({ freigaben: [freigabe('f1')] });
  const m = await melden(a, 'f1');
  const alt = a.w.reaktionen.entscheiden;
  a.w.reaktionen.entscheiden = async () => {
    throw new Error('Gespräch zur Freigabe nicht gefunden');
  };
  a.kanal.reagiert('✅', m);
  await a.w.reaktionen.pruefen();
  assert.equal(zaehler(a).fehler, 1);
  assert.equal(a.liste[0].status, 'offen');
  a.w.reaktionen.entscheiden = async () => {
    throw new Error('Freigabe ist bereits erteilt');
  };
  a.kanal.reagiert('✅', m);
  await a.w.reaktionen.pruefen();
  assert.equal(zaehler(a).ignoriert, 1);
  void alt;
});

test('Bündelmeldungen bekommen keine Chips; Zustand enthält nur Zähler (keine Ids, Texte, URLs)', async () => {
  const a = aufbau({ freigaben: [freigabe('f1'), freigabe('f2')] });
  await a.w.pruefen();
  assert.equal(a.kanal.gesendet.length, 1); // gebündelt
  assert.deepEqual(a.kanal.reaktionen, []);
  assert.doesNotMatch(a.kanal.gesendet[0].text, /✅ erlauben/);
  const einzel = aufbau({ freigaben: [freigabe('f9')] });
  const m = await melden(einzel, 'f9');
  einzel.kanal.reagiert('✅', m);
  await einzel.w.reaktionen.pruefen();
  const roh = JSON.stringify(einzel.w.zustand());
  assert.doesNotMatch(roh, /\$m1|f9|Aktion|127\.0\.0\.1|matrix\.fyos\.local/);
  assert.deepEqual(Object.keys(einzel.w.zustand().reaktionen).sort(), ['abgelehnt', 'an', 'angenommen', 'fehler', 'gesetzt', 'ignoriert', 'letzter_fehler', 'letzter_lauf', 'meldungen', 'offen', 'verweigert', 'zurueckgestellt']);
});

test('nachrichtBauen: Reaktions-Hinweis nur mit chips, Bündel behält den alten Hinweis', () => {
  const kfg = konfigNormalisieren({ kanaele: ['matrix'] });
  const f = freigabe('f1');
  const mit = nachrichtBauen({ art: 'neu', liste: [f], kanal: { befehl: true, chips: true }, kfg, jetzt: T0 });
  const ohne = nachrichtBauen({ art: 'neu', liste: [f], kanal: { befehl: true }, kfg, jetzt: T0 });
  const buendel = nachrichtBauen({ art: 'neu', liste: [f, freigabe('f2')], kanal: { befehl: true, chips: true }, kfg, jetzt: T0 });
  assert.match(mit.text, /Entscheide mit einer Reaktion/);
  assert.match(ohne.text, /Entscheiden nur in der FYOS-App/);
  assert.match(buendel.text, /Entscheiden nur in der FYOS-App/);
});

test('matrixKanal: Reaktion, Bearbeitung, Rückzug und Antwort gehen an den Sender, Reaktionen werden beim Lauscher geholt', async () => {
  const aufrufe = [];
  const holen = async (url, opt = {}) => {
    aufrufe.push({ url, methode: opt.method ?? 'GET', body: opt.body ? JSON.parse(opt.body) : null });
    if (url.includes('/reaktionen')) return { status: 200, json: async () => ({ ok: true, naechste: 4, ereignisse: [{ n: 4 }] }) };
    return { status: 200, json: async () => ({ ok: true, event_id: '$neu' }) };
  };
  const kanal = matrixKanal({ url: 'http://sender.test:18436', raum: 'ops', reaktionen: { an: true, lauscherUrl: 'http://lauscher.test:18437' }, fetch: holen });
  assert.equal(kanal.chips, true);
  assert.deepEqual(await kanal.reagieren('$m1', '✅'), { ok: true, schatten: false, eventId: '$neu' });
  await kanal.bearbeiten('$m1', 'neu');
  await kanal.zurueckziehen('$c1');
  await kanal.antworten('erteilt', 'Freigabe f1');
  assert.deepEqual(aufrufe.map((x) => x.url), [
    'http://sender.test:18436/reagieren',
    'http://sender.test:18436/bearbeiten',
    'http://sender.test:18436/zurueckziehen',
    'http://sender.test:18436/senden',
  ]);
  assert.deepEqual(aufrufe[0].body, { event_id: '$m1', emoji: '✅', raum: 'ops' });
  assert.equal(aufrufe[3].body.dringend, true);
  const r = await kanal.reaktionenLesen(3);
  assert.equal(aufrufe.at(-1).url, 'http://lauscher.test:18437/reaktionen?seit=3');
  assert.deepEqual(r, { ok: true, naechste: 4, ereignisse: [{ n: 4 }] });
  const tot = matrixKanal({ fetch: async () => { throw new Error('refused'); } });
  assert.equal((await tot.reagieren('$m', '✅')).ok, false);
  assert.equal((await tot.reaktionenLesen(0)).ok, false);
});

test('ausKonfig: Reaktionen nur mit Matrix, an=true und Entscheidungsweg', () => {
  const w = (cfg, entscheiden) =>
    FreigabeMeldung.ausKonfig({ cfg: { pi_durable: { freigabe_meldung: cfg } }, harness: {}, env: {}, entscheiden, log: still, fetch: async () => ({}) });
  const f = async () => {};
  assert.equal(w({ kanaele: ['matrix'] }, f).reaktionen, null);
  assert.equal(w({ kanaele: ['matrix'], matrix: { reaktionen: { an: true } } }, undefined).reaktionen, null);
  assert.equal(w({ kanaele: [], matrix: { reaktionen: { an: true } } }, f).reaktionen, null);
  assert.ok(w({ kanaele: ['matrix'], matrix: { reaktionen: { an: true } } }, f).reaktionen instanceof FreigabeReaktionen);
});
