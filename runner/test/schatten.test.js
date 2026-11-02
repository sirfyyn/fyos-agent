/**
 * Schatten-Rekorder: Zug, Schatten stimmt / weicht ab / Fehler / Timeout, Budget, Ruhe und Spielmodus, Redaktion, Pfade, Wahrheit.
 * Die Schattenmodelle sind Attrappen; ein Netz gibt es hier nicht (der Bolt-Adapter hat eine eigene Datei).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { SchattenRekorder, redigiert, zugKennung } from '../src/schatten.js';
import { schattenKonfig } from '../src/schatten-konfig.js';

const tmp = mkdtempSync(join(tmpdir(), 'schatten-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let nr = 0;
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
async function bis(fn, { ms = 3000, was = 'Bedingung' } = {}) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    if (await fn()) return;
    await warte(10);
  }
  throw new Error(`Zeit abgelaufen: ${was}`);
}

const ANTWORT_TOOL = (name, argumente) => ({
  werkzeug: { name, argumente, argumente_roh: JSON.stringify(argumente) },
  text: '',
  erstes_token_ms: 100,
  gesamt_ms: 300,
  tokens: { ein: 900, aus: 30 },
});

function attrappe(name = 'bolt', fn = async () => ANTWORT_TOOL('hub_aufrufen', { werkzeug: 'x' })) {
  const a = {
    name,
    art: 'attrappe',
    an: true,
    budget: 100,
    aufrufe: [],
    version: () => ({ modell: 'ersatzdenker', quant: 'Q3_K_XL', systemkopf: 'kopf1' }),
    async anfrage(zug, opt) {
      a.aufrufe.push(zug);
      return fn(zug, opt);
    },
  };
  return a;
}

function bau({ adapter = [attrappe()], konfig = {}, ...rest } = {}) {
  const ordner = join(tmp, `lauf-${(nr += 1)}`);
  const rek = new SchattenRekorder({
    konfig: { an: true, ordner, warte_ms: 0, wache_ms: 10, frist_s: 2, adapter: { bolt: { an: true, budget_stunde: 100 }, 'sprache-agent': { an: true }, schnellweg: { an: true } }, ...konfig },
    adapter,
    log: () => {},
    ...rest,
  });
  return { rek, ordner };
}

/** Ein Live-Zug von Anfang bis Ende. */
function zug(rek, ein, { tool, text = '', eingang = 'Wie ist der Stand?', quelle = 'chat', klasse = 'max', ende = true } = {}) {
  rek.beginne({ ein, quelle, klasse, bezug: null, eingang, text: `Eingang von chat.\n\n${eingang}`, system: 'Du bist Persona.', werkzeuge: [{ name: 'hub_aufrufen', description: 'x', parameters: { type: 'object' } }] });
  if (tool) rek.werkzeug(ein, tool.name, tool.args);
  if (text) rek.text(ein, text);
  if (ende) rek.ende(ein);
}

const leer = (rek) => !rek.laeuft && rek.warteschlange.length === 0;
async function fertig(rek) {
  await bis(() => leer(rek), { was: 'Warteschlange leer' });
}
function zeilen(ordner, name = 'bolt') {
  const dateien = existsSync(ordner) ? readdirSync(ordner).filter((n) => n.startsWith(`${name}-`)) : [];
  return dateien.flatMap((n) => readFileSync(join(ordner, n), 'utf8').trim().split('\n').filter(Boolean).map((z) => JSON.parse(z)));
}

test('Konfiguration: alles aus, Kopf höchstens 300 Zeichen, Adapter mit Vorgaben, idempotent', () => {
  const k = schattenKonfig({});
  assert.equal(k.an, false);
  assert.deepEqual(Object.keys(k.adapter).sort(), ['bolt', 'schnellweg', 'sprache-agent']);
  for (const a of Object.values(k.adapter)) assert.equal(a.an, false);
  assert.equal(k.adapter.bolt.url, 'http://127.0.0.1:18500');
  assert.equal(k.adapter.bolt.schluessel_datei, '/var/lib/fyos-ersatzdenker/api.key');
  assert.equal(k.adapter.schnellweg.art, 'attrappe');
  assert.equal(k.ordner, '/var/lib/fyos-agent/schatten');
  assert.equal(schattenKonfig({ kopf_zeichen: 5000 }).kopf_zeichen, 300);
  assert.equal(schattenKonfig({ adapter: { bolt: { an: 'ja', budget_stunde: 'x' } } }).adapter.bolt.budget_stunde, 30);
  assert.equal(schattenKonfig({ adapter: { bolt: { an: 'ja' } } }).adapter.bolt.an, true);
  assert.deepEqual(schattenKonfig(k), k);
  assert.equal(schattenKonfig({ adapter: { neu: { an: true } } }).adapter.neu.an, true);
});

test('aus ist aus: weder Rekorder noch Adapter rufen etwas auf', async () => {
  const a = attrappe();
  const { rek, ordner } = bau({ adapter: [a], konfig: { an: false } });
  zug(rek, 'e1', { tool: { name: 'hub_aufrufen', args: {} } });
  await warte(40);
  assert.equal(a.aufrufe.length, 0);
  assert.equal(existsSync(ordner), false);
  const b = attrappe();
  const zwei = bau({ adapter: [b], konfig: { adapter: { bolt: { an: false } } } });
  zug(zwei.rek, 'e1', { tool: { name: 'hub_aufrufen', args: {} } });
  await warte(40);
  assert.equal(b.aufrufe.length, 0);
  assert.equal(existsSync(zwei.ordner), false);
});

test('Schatten stimmt: eine Zeile je Zug mit Übereinstimmung, Latenz, Tokens, Version und Pfad bolt-<Datum>.jsonl', async () => {
  const a = attrappe();
  const { rek, ordner } = bau({ adapter: [a] });
  zug(rek, 'chat:e1', { tool: { name: 'hub_aufrufen', args: { werkzeug: 'x' } } });
  await fertig(rek);
  const dateien = readdirSync(ordner);
  assert.equal(dateien.length, 1);
  assert.match(dateien[0], /^bolt-\d{4}-\d{2}-\d{2}\.jsonl$/);
  const [z] = zeilen(ordner);
  assert.equal(z.art, 'zug');
  assert.equal(z.ein, 'chat:e1');
  assert.equal(z.status, 'ok');
  assert.equal(z.live.name, 'hub_aufrufen');
  assert.deepEqual(z.live.args_form, { werkzeug: 'string' });
  assert.equal(z.schatten.name, 'hub_aufrufen');
  assert.deepEqual(z.uebereinstimmung, { werkzeug: true, argumente: true, exakt: true, json_gueltig: true, deutsch: null, falsch: null });
  assert.deepEqual(z.latenz, { erstes_token_ms: 100, gesamt_ms: 300 });
  assert.deepEqual(z.tokens, { ein: 900, aus: 30 });
  assert.deepEqual(z.version, { modell: 'ersatzdenker', quant: 'Q3_K_XL', systemkopf: 'kopf1' });
  assert.match(z.tag, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(typeof z.t, 'number');
  assert.equal(a.aufrufe[0].werkzeuge[0].name, 'hub_aufrufen', 'die Werkzeugschemata des Zugs gehen an den Schatten');
  assert.equal(a.aufrufe[0].system, 'Du bist Persona.');
});

test('Schatten weicht ab: anderes Werkzeug, andere Argumente, Werkzeug statt Text, Text statt Werkzeug', async () => {
  const antworten = [
    ANTWORT_TOOL('hub_schema', { werkzeug: 'x' }), // anderes Werkzeug
    ANTWORT_TOOL('hub_aufrufen', { werkzeug: 'y' }), // gleiches Werkzeug, andere Argumente
    ANTWORT_TOOL('hub_suchen', { suche: 'a' }), // Live ohne Werkzeug
    { werkzeug: null, text: 'Das habe ich nicht getan, es ist alles ruhig.', erstes_token_ms: 50, gesamt_ms: 100, tokens: {} }, // Live mit Werkzeug
  ];
  const a = attrappe('bolt', async () => antworten.shift());
  const { rek, ordner } = bau({ adapter: [a] });
  zug(rek, 'a1', { tool: { name: 'hub_aufrufen', args: { werkzeug: 'x' } } });
  zug(rek, 'a2', { tool: { name: 'hub_aufrufen', args: { werkzeug: 'x' } } });
  zug(rek, 'a3', { text: 'Es ist ruhig.' });
  zug(rek, 'a4', { tool: { name: 'hub_aufrufen', args: { werkzeug: 'x' } } });
  await fertig(rek);
  const [z1, z2, z3, z4] = zeilen(ordner);
  assert.equal(z1.uebereinstimmung.werkzeug, false);
  assert.equal(z1.uebereinstimmung.argumente, null);
  assert.equal(z1.uebereinstimmung.falsch, null);
  assert.deepEqual([z2.uebereinstimmung.werkzeug, z2.uebereinstimmung.argumente, z2.uebereinstimmung.exakt], [true, false, false]);
  assert.equal(z3.live.art, 'text');
  assert.equal(z3.uebereinstimmung.falsch, 'schatten-ruft');
  assert.equal(z4.schatten.art, 'text');
  assert.equal(z4.uebereinstimmung.falsch, 'live-ruft');
  assert.equal(z4.uebereinstimmung.deutsch, true);
});

test('ungültiges JSON in den Argumenten des Schattens wird gezählt, nicht ausgeführt', async () => {
  const a = attrappe('bolt', async () => ({ werkzeug: { name: 'hub_aufrufen', argumente: undefined, argumente_roh: '{"werkzeug": ' }, text: '', gesamt_ms: 10 }));
  const { rek, ordner } = bau({ adapter: [a] });
  zug(rek, 'j1', { tool: { name: 'hub_aufrufen', args: { werkzeug: 'x' } } });
  await fertig(rek);
  const [z] = zeilen(ordner);
  assert.equal(z.uebereinstimmung.json_gueltig, false);
  assert.equal(z.uebereinstimmung.argumente, false);
  assert.equal(z.schatten.args_form, null);
});

test('Fehler und Timeout: eine Zeile mit Status, Fehlertext geschwärzt; der Abbruch erreicht den Adapter', async () => {
  let signal;
  const aufrufe = [
    async () => {
      throw new Error('Verbindung abgelehnt, Bearer abcdefghijklmnopqrstuv');
    },
    async (_zug, opt) => {
      signal = opt.signal;
      return new Promise(() => {}); // antwortet nie
    },
  ];
  const a = attrappe('bolt', (z, opt) => aufrufe.shift()(z, opt));
  const { rek, ordner } = bau({ adapter: [a], konfig: { frist_s: 0.1 } });
  zug(rek, 'f1', { tool: { name: 'hub_aufrufen', args: {} } });
  zug(rek, 'f2', { tool: { name: 'hub_aufrufen', args: {} } });
  await fertig(rek);
  const [f, t] = zeilen(ordner);
  assert.equal(f.status, 'fehler');
  assert.match(f.fehler, /Verbindung abgelehnt/);
  assert.doesNotMatch(f.fehler, /abcdefghijklmnopqrstuv/);
  assert.equal(f.schatten, null);
  assert.equal(f.uebereinstimmung, null);
  assert.equal(t.status, 'timeout');
  assert.equal(signal.aborted, true);
  const zs = rek.zustand().adapter.bolt;
  assert.deepEqual([zs.ok, zs.fehler, zs.timeout], [0, 1, 1]);
});

test('Budget je Stunde: der Zug über der Grenze wird übersprungen und gezählt', async () => {
  const a = attrappe();
  const { rek, ordner } = bau({ adapter: [a], konfig: { adapter: { bolt: { an: true, budget_stunde: 2 } } } });
  for (const id of ['b1', 'b2', 'b3', 'b4']) zug(rek, id, { tool: { name: 'hub_aufrufen', args: { werkzeug: 'x' } } });
  await fertig(rek);
  assert.equal(a.aufrufe.length, 2);
  const z = zeilen(ordner);
  assert.deepEqual(z.map((x) => x.art), ['zug', 'zug', 'uebersprungen', 'uebersprungen']);
  assert.equal(z[2].grund, 'budget');
  assert.equal(rek.zustand().adapter.bolt.uebersprungen.budget, 2);
  assert.equal(rek.zustand().adapter.bolt.stunde_verbraucht, 2);
});

test('Sperren: Spielmodus, Ruhe (Funktion und Marke), GPU-Reserve; nichts wird gefragt', async () => {
  let spiel = true;
  const a = attrappe();
  const marke = join(tmp, `ruhe-${nr + 1}.sperre`);
  let frei = 100;
  const { rek, ordner } = bau({
    adapter: [a],
    konfig: { gpu_reserve_mib: 500, ruhe_sperre: [marke] },
    spielmodus: { an: () => spiel },
    ruhe: () => ruheFn,
    gpuFrei: async () => frei,
  });
  let ruheFn = false;
  zug(rek, 's1', { tool: { name: 'hub_aufrufen', args: {} } });
  await fertig(rek);
  spiel = false;
  ruheFn = true;
  zug(rek, 's2', { tool: { name: 'hub_aufrufen', args: {} } });
  await fertig(rek);
  ruheFn = false;
  writeFileSync(marke, '');
  zug(rek, 's3', { tool: { name: 'hub_aufrufen', args: {} } });
  await fertig(rek);
  rmSync(marke);
  zug(rek, 's4', { tool: { name: 'hub_aufrufen', args: {} } }); // GPU 100 < 500
  await fertig(rek);
  frei = null;
  zug(rek, 's5', { tool: { name: 'hub_aufrufen', args: {} } });
  await fertig(rek);
  assert.equal(a.aufrufe.length, 0);
  assert.deepEqual(zeilen(ordner).map((z) => z.grund), ['spielmodus', 'ruhe', 'ruhe', 'gpu-reserve', 'gpu-unbekannt']);
  frei = 4000;
  zug(rek, 's6', { tool: { name: 'hub_aufrufen', args: {} } });
  await fertig(rek);
  assert.equal(a.aufrufe.length, 1, 'mit Reserve, ohne Marke und ohne Spielmodus läuft er');
});

test('Spielmodus während des Schattenzugs bricht ihn ab', async () => {
  let spiel = false;
  let signal;
  const a = attrappe('bolt', async (_z, opt) => {
    signal = opt.signal;
    return new Promise(() => {});
  });
  const { rek, ordner } = bau({ adapter: [a], spielmodus: { an: () => spiel } });
  zug(rek, 'w1', { tool: { name: 'hub_aufrufen', args: {} } });
  await bis(() => a.aufrufe.length === 1, { was: 'Schattenzug läuft' });
  spiel = true;
  await fertig(rek);
  assert.equal(signal.aborted, true);
  const [z] = zeilen(ordner);
  assert.equal(z.art, 'uebersprungen');
  assert.equal(z.grund, 'abgebrochen-spielmodus');
});

test('nie vor und nie während des Live-Zugs; höchstens ein Schattenzug gleichzeitig', async () => {
  let gleichzeitig = 0;
  let max = 0;
  const a = attrappe('bolt', async () => {
    gleichzeitig += 1;
    max = Math.max(max, gleichzeitig);
    await warte(30);
    gleichzeitig -= 1;
    return ANTWORT_TOOL('hub_aufrufen', { werkzeug: 'x' });
  });
  const { rek } = bau({ adapter: [a] });
  zug(rek, 'l1', { tool: { name: 'hub_aufrufen', args: { werkzeug: 'x' } } });
  rek.beginne({ ein: 'l2', quelle: 'chat', klasse: 'max', eingang: 'zweiter', text: 'zweiter', system: '', werkzeuge: [] }); // zweiter Live-Zug offen
  await warte(80);
  assert.equal(a.aufrufe.length, 0, 'solange ein Live-Zug offen ist, fragt der Schatten nicht');
  rek.werkzeug('l2', 'hub_aufrufen', { werkzeug: 'x' });
  rek.ende('l2');
  await fertig(rek);
  assert.equal(a.aufrufe.length, 2);
  assert.equal(max, 1);
  // Vor dem Zugende wurde nie gefragt: der Aufruf kommt erst nach `ende`.
  const b = attrappe();
  const zwei = bau({ adapter: [b] });
  zug(zwei.rek, 'v1', { tool: { name: 'hub_aufrufen', args: {} }, ende: false });
  await warte(40);
  assert.equal(b.aufrufe.length, 0);
  zwei.rek.ende('v1');
  await fertig(zwei.rek);
  assert.equal(b.aufrufe.length, 1);
});

test('ein neuer Live-Zug bricht den laufenden Schattenzug ab', async () => {
  let signal;
  const a = attrappe('bolt', async (_z, opt) => {
    signal = opt.signal;
    return new Promise(() => {});
  });
  const { rek, ordner } = bau({ adapter: [a] });
  zug(rek, 'n1', { tool: { name: 'hub_aufrufen', args: {} } });
  await bis(() => a.aufrufe.length === 1);
  rek.beginne({ ein: 'n2', quelle: 'chat', klasse: 'max', eingang: 'neu', text: 'neu', system: '', werkzeuge: [] });
  await bis(() => leer(rek));
  assert.equal(signal.aborted, true);
  assert.equal(zeilen(ordner)[0].grund, 'abgebrochen-neuer-zug');
});

test('Redaktion: Kopf höchstens 300 Zeichen, Zugangsdaten geschwärzt, kein Volltext, Hashes statt Inhalt', async () => {
  const lang = `Bitte prüfe das. Das Passwort: geheim123 und token=ghp_ABCDEFGH12345678 stehen dabei. ${'x'.repeat(600)} ENDE-MARKE-NUR-IM-VOLLTEXT`; // sauber: ok (Testattrappe) gitleaks:allow
  const a = attrappe('bolt', async () => ({ werkzeug: null, text: `Das ist eine lange deutsche Antwort mit ${'y'.repeat(500)} SCHWANZ-MARKE`, gesamt_ms: 5, tokens: {} }));
  const { rek, ordner } = bau({ adapter: [a] });
  zug(rek, 'r1', { text: `Es ist ruhig, ${'z'.repeat(400)} LIVE-SCHWANZ`, eingang: lang });
  await fertig(rek);
  const roh = readFileSync(join(ordner, readdirSync(ordner)[0]), 'utf8');
  const [z] = zeilen(ordner);
  assert.ok(z.eingang.kopf.length <= 300);
  assert.doesNotMatch(roh, /geheim123|ghp_ABCDEFGH12345678|ENDE-MARKE-NUR-IM-VOLLTEXT|SCHWANZ-MARKE|LIVE-SCHWANZ/); // sauber: ok (Testattrappe)
  assert.match(z.eingang.kopf, /Bitte prüfe das/);
  assert.equal(z.eingang.zeichen, lang.length);
  assert.match(z.eingang.hash, /^[0-9a-f]{16}$/);
  assert.ok(z.schatten.text.length <= 120);
  assert.ok(z.live.text.length <= 120);
  assert.match(z.schatten.text_hash, /^[0-9a-f]{16}$/);
  // Mit kopf_zeichen 0 bleibt nur der Hash.
  const nur = bau({ adapter: [attrappe()], konfig: { kopf_zeichen: 0, antwort_zeichen: 0 } });
  zug(nur.rek, 'r2', { text: 'Hallo', eingang: 'Vertraulicher Satz' });
  await fertig(nur.rek);
  const [h] = zeilen(nur.ordner);
  assert.equal(h.eingang.kopf, '');
  assert.equal(h.live.text, '');
  assert.doesNotMatch(readFileSync(join(nur.ordner, readdirSync(nur.ordner)[0]), 'utf8'), /Vertraulicher/);
  assert.equal(redigiert('a  b\n c', 10), 'a b c');
  assert.equal(zugKennung('chat:eins/zwei!'), 'chat:einszwei');
});

test('Filter: Quellen und Klassen je Adapter; Zug ohne Live-Aktion wird übersprungen', async () => {
  const a = attrappe('bolt');
  const s = attrappe('sprache-agent');
  const { rek, ordner } = bau({ adapter: [a, s], konfig: { adapter: { bolt: { an: true }, 'sprache-agent': { an: true, quellen: ['stimme'] } } } });
  zug(rek, 'q1', { tool: { name: 'hub_aufrufen', args: {} }, quelle: 'chat' });
  zug(rek, 'q2', { tool: { name: 'hub_aufrufen', args: {} }, quelle: 'stimme' });
  zug(rek, 'q3', {});
  await fertig(rek);
  assert.deepEqual(a.aufrufe.map((x) => x.ein), ['q1', 'q2']);
  assert.deepEqual(s.aufrufe.map((x) => x.ein), ['q2']);
  assert.equal(zeilen(ordner).find((z) => z.ein === 'q3').grund, 'ohne-live-aktion');
});

test('Attrappen ohne Umsetzung überspringen mit „nicht-umgesetzt“; ein Sender macht daraus einen Adapter', async () => {
  const { baueAdapter } = await import('../src/schatten.js');
  const k = schattenKonfig({ an: true, ordner: join(tmp, 'attr'), warte_ms: 0, adapter: { schnellweg: { an: true } } });
  const rek = new SchattenRekorder({ konfig: k, adapter: baueAdapter(k), log: () => {} });
  zug(rek, 'x1', { tool: { name: 'hub_aufrufen', args: {} } });
  await fertig(rek);
  assert.equal(zeilen(k.ordner, 'schnellweg')[0].grund, 'nicht-umgesetzt');
  assert.equal(rek.zustand().adapter.bolt.an, false, 'Bolt ist ohne Schalter aus');
  const k2 = schattenKonfig({ an: true, ordner: join(tmp, 'attr2'), warte_ms: 0, adapter: { schnellweg: { an: true } } });
  const rek2 = new SchattenRekorder({ konfig: k2, adapter: baueAdapter(k2, { senders: { schnellweg: async () => ANTWORT_TOOL('hub_aufrufen', { werkzeug: 'x' }) } }), log: () => {} });
  zug(rek2, 'x2', { tool: { name: 'hub_aufrufen', args: { werkzeug: 'x' } } });
  await fertig(rek2);
  assert.equal(zeilen(k2.ordner, 'schnellweg')[0].uebereinstimmung.exakt, true);
});

test('Warteschlange: über queue_max fällt der älteste Zug heraus; veraltete verfallen', async () => {
  const a = attrappe();
  const { rek, ordner } = bau({ adapter: [a], konfig: { queue_max: 1, max_alter_s: 0.05 } });
  rek.beginne({ ein: 'offen', quelle: 'chat', klasse: 'max', eingang: 'offen', text: 'offen', system: '', werkzeuge: [] }); // blockiert die Bahn
  zug(rek, 'w1', { tool: { name: 'hub_aufrufen', args: {} } });
  zug(rek, 'w2', { tool: { name: 'hub_aufrufen', args: {} } });
  await bis(() => leer(rek));
  assert.equal(a.aufrufe.length, 0);
  assert.deepEqual(zeilen(ordner).map((z) => `${z.ein}:${z.grund}`), ['w1:warteschlange-voll', 'w2:veraltet']);
});

test('Tagesgrenze max_mb_tag: darüber wird nicht weitergeschrieben', async () => {
  const meldungen = [];
  const a = attrappe();
  const { rek, ordner } = bau({ adapter: [a], konfig: { max_mb_tag: 0.0008 }, log: (z) => meldungen.push(z) });
  rek.log = (z) => meldungen.push(z);
  for (let i = 0; i < 6; i += 1) zug(rek, `g${i}`, { tool: { name: 'hub_aufrufen', args: { werkzeug: 'x' } } });
  await fertig(rek);
  const n = zeilen(ordner).length;
  assert.ok(n > 0 && n < 6, `Zeilen ${n}`);
});

test('Wahrheit: Urteil an einem Zug, geprüfte Eingabe, Datei wahrheit-<Datum>.jsonl, Zählung im Bericht', async () => {
  const a = attrappe('bolt', async () => ANTWORT_TOOL('hub_schema', { werkzeug: 'x' }));
  const { rek, ordner } = bau({ adapter: [a] });
  zug(rek, 'm1', { tool: { name: 'hub_aufrufen', args: { werkzeug: 'x' } } });
  await fertig(rek);
  assert.throws(() => rek.wahrheit('', { urteil: 'gut' }), /Zug-Id/);
  assert.throws(() => rek.wahrheit('m1', { urteil: 'prima' }), /gut, schlecht oder korrektur/);
  assert.throws(() => rek.wahrheit('m1', { urteil: 'korrektur' }), /braucht werkzeug/);
  assert.deepEqual(rek.wahrheit('m1', { urteil: 'korrektur', werkzeug: 'hub_schema', quelle: 'daumen' }), { ok: true, ein: 'm1' });
  const w = zeilen(ordner, 'wahrheit');
  assert.equal(w.length, 1);
  assert.deepEqual([w[0].art, w[0].ein, w[0].urteil, w[0].wahr_werkzeug, w[0].quelle], ['wahrheit', 'm1', 'korrektur', 'hub_schema', 'daumen']);
  const b = rek.bericht({ tage: 1 });
  assert.equal(b.wahrheiten, 1);
  assert.equal(b.adapter.bolt.wahrheit.bekannt, 1);
  assert.equal(b.adapter.bolt.wahrheit.schatten_treffer.k, 1);
  assert.equal(b.adapter.bolt.wahrheit.live_treffer.k, 0);
  assert.equal(b.adapter.bolt.tor.bereit, 'zu wenig Daten');
});

test('Zustand: Zähler je Adapter, nie Inhalte', async () => {
  const a = attrappe();
  const { rek } = bau({ adapter: [a] });
  zug(rek, 'z1', { tool: { name: 'hub_aufrufen', args: { werkzeug: 'GEHEIMER-WERT' } }, eingang: 'Vertraulicher Eingang' });
  await fertig(rek);
  const z = rek.zustand();
  assert.equal(z.an, true);
  assert.equal(z.adapter.bolt.ok, 1);
  assert.equal(z.adapter.bolt.eingereiht, 1);
  assert.equal(z.warteschlange, 0);
  assert.equal(z.zeilen, 1);
  assert.doesNotMatch(JSON.stringify(z), /GEHEIMER|Vertraulicher/);
});

test('schliessen: laufender Schattenzug wird abgebrochen, nichts bleibt in der Warteschlange', async () => {
  let signal;
  const a = attrappe('bolt', async (_z, opt) => {
    signal = opt.signal;
    return new Promise(() => {});
  });
  const { rek } = bau({ adapter: [a] });
  zug(rek, 'c1', { tool: { name: 'hub_aufrufen', args: {} } });
  await bis(() => a.aufrufe.length === 1);
  rek.schliessen();
  await bis(() => leer(rek));
  assert.equal(signal.aborted, true);
  assert.equal(rek.warteschlange.length, 0);
});
