/**
 * Reine Auswertung des Schatten-Rekorders: Quoten, Wilson, Perzentile, Vergleich, Tor.
 * Die Beispieldatei wird auch von scripts/ops/test_schatten_bericht.py ausgewertet; beide müssen dieselben Zahlen liefern.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { aktion, argumenteForm, auswerten, istDeutsch, kanonisch, perzentil, quote, torUrteil, vergleiche, wilson, zeilenAusText } from '../src/schatten-auswertung.js';
import { torKonfig } from '../src/schatten-konfig.js';

const nahe = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const BEISPIEL = new URL('./fixtures/schatten-beispiel.jsonl', import.meta.url);

test('Wilson-Intervall: bekannte Werte, Ränder, leere Menge', () => {
  const [lo, hi] = wilson(9, 10);
  nahe(lo, 0.5958, 1e-3);
  nahe(hi, 0.9821, 1e-3);
  const [l0, h0] = wilson(0, 10);
  assert.equal(l0, 0);
  assert.ok(h0 > 0.2 && h0 < 0.35);
  assert.equal(wilson(0, 0), null);
  assert.deepEqual(quote(0, 0), { k: 0, n: 0, rate: null, wilson: null });
  nahe(quote(1, 4).rate, 0.25);
});

test('Perzentile nach dem nächsten Rang', () => {
  assert.equal(perzentil([], 0.5), null);
  assert.equal(perzentil([5], 0.95), 5);
  assert.equal(perzentil([4, 1, 3, 2], 0.5), 2);
  assert.equal(perzentil([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(perzentil([1, NaN, 3], 0.5), 1);
});

test('Form und Hash der Argumente: Schlüssel und Typen, nie Werte; Reihenfolge egal', () => {
  assert.deepEqual(argumenteForm({ b: 'geheim', a: { n: 1, l: [true] } }), { a: { l: ['boolean'], n: 'number' }, b: 'string' });
  assert.equal(kanonisch({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  const a = aktion({ name: 'x', argumente: { b: 1, a: 2 } });
  const b = aktion({ name: 'x', argumente: { a: 2, b: 1 } });
  assert.equal(a.args_hash, b.args_hash);
  assert.notEqual(a.args_hash, aktion({ name: 'x', argumente: { a: 2, b: 3 } }).args_hash);
  assert.equal(aktion({ name: 'x', argumente: undefined, argumente_roh: '{kaputt' }).json_gueltig, false);
  assert.equal(aktion({ name: 'x', argumente: [1] }).json_gueltig, false, 'ein Array ist kein Argumentobjekt');
  assert.equal(aktion({ text: '  ' }).art, 'nichts');
});

test('Deutsch-Heuristik', () => {
  assert.equal(istDeutsch('Das ist nicht erledigt, ich habe es nicht getan.'), true);
  assert.equal(istDeutsch('I did it and you can see the result with this tool.'), false);
  assert.equal(istDeutsch(''), true);
});

test('Vergleich: Werkzeug, Argumente, exakt, Falsch-Auslösung in beide Richtungen', () => {
  const t = (name, args) => aktion({ name, argumente: args });
  const text = aktion({ text: 'Es ist ruhig und das ist gut.' });
  assert.deepEqual(vergleiche(t('a', { x: 1 }), t('a', { x: 1 })), { werkzeug: true, argumente: true, exakt: true, json_gueltig: true, deutsch: null, falsch: null });
  assert.deepEqual(vergleiche(t('a', { x: 1 }), t('a', { x: 2 })), { werkzeug: true, argumente: false, exakt: false, json_gueltig: true, deutsch: null, falsch: null });
  assert.deepEqual(vergleiche(t('a', {}), t('b', {})), { werkzeug: false, argumente: null, exakt: false, json_gueltig: true, deutsch: null, falsch: null });
  assert.equal(vergleiche(text, t('a', {})).falsch, 'schatten-ruft');
  assert.equal(vergleiche(t('a', {}), text).falsch, 'live-ruft');
  const tt = vergleiche(text, text);
  assert.deepEqual([tt.werkzeug, tt.exakt, tt.falsch, tt.deutsch], [true, true, null, true]);
});

test('Beispieldatei: dieselben Zahlen wie in test_schatten_bericht.py', () => {
  const zeilen = zeilenAusText(readFileSync(BEISPIEL, 'utf8'));
  assert.equal(zeilen.length, 18);
  const erg = auswerten(zeilen, { tor: torKonfig({ min_zuege: 10 }) });
  assert.equal(erg.wahrheiten, 4);
  assert.deepEqual(Object.keys(erg.adapter), ['bolt', 'schnellweg']);
  const a = erg.adapter.bolt;
  assert.deepEqual([a.versuche, a.zuege, a.fehler, a.timeouts], [10, 8, 1, 1]);
  assert.deepEqual(a.uebersprungen, { spielmodus: 1, budget: 1 });
  nahe(a.abdeckung.rate, 10 / 12);
  nahe(a.fehlerquote.rate, 0.2);
  assert.deepEqual([a.werkzeug.k, a.werkzeug.n], [5, 8]);
  nahe(a.werkzeug.rate, 0.625);
  assert.deepEqual([a.argumente.k, a.argumente.n], [2, 4]);
  assert.deepEqual([a.exakt.k, a.exakt.n], [3, 8]);
  assert.deepEqual([a.falsch.gesamt.k, a.falsch.schatten_ruft, a.falsch.live_ruft], [2, 1, 1]);
  assert.deepEqual([a.json.k, a.json.n], [5, 6]);
  assert.deepEqual([a.deutsch.k, a.deutsch.n], [1, 2]);
  assert.deepEqual(a.latenz, { erstes_token_p50: 210, erstes_token_p95: 400, gesamt_p50: 850, gesamt_p95: 1200 });
  assert.deepEqual(a.tokens, { ein: 8000, aus: 400 });
  assert.deepEqual(a.versionen.map((v) => [v.systemkopf, v.zuege]), [['aaaa', 6], ['bbbb', 4]]);
  assert.deepEqual(
    [a.wahrheit.mit_urteil, a.wahrheit.bekannt, a.wahrheit.live_schlecht, a.wahrheit.live_treffer.k, a.wahrheit.schatten_treffer.k],
    [4, 3, 1, 2, 2],
  );
  assert.deepEqual(Object.keys(a.tage), ['2026-10-24', '2026-10-25']);
  assert.deepEqual([a.tage['2026-10-24'].versuche, a.tage['2026-10-24'].zuege], [6, 5]);
  nahe(a.tage['2026-10-24'].werkzeug, 0.6);
  nahe(a.tage['2026-10-24'].falsch, 0.2);
  nahe(a.tage['2026-10-25'].werkzeug, 2 / 3);
  nahe(a.tage['2026-10-25'].fehlerquote, 0.25);
  assert.equal(a.tage['2026-10-25'].gesamt_p50, 850);
  assert.equal(a.tor.bereit, 'nein');
  assert.ok(a.tor.gruende.some((g) => g.startsWith('werkzeug')));
  assert.ok(a.tor.gruende.some((g) => g.startsWith('falsch')));
  assert.ok(a.tor.gruende.some((g) => g.startsWith('fehler')));
  // Mit der Vorgabe (100 Züge) fehlen Daten.
  assert.equal(auswerten(zeilen, { tor: torKonfig({}) }).adapter.bolt.tor.bereit, 'zu wenig Daten');
  assert.equal(erg.adapter.schnellweg.tor.bereit, 'zu wenig Daten');
  assert.equal(erg.adapter.schnellweg.versuche, 0);
});

/** Eine ok-Zeile; `treffer` bestimmt, ob der Schatten dasselbe Werkzeug ruft. */
function zeile(i, { treffer = true, falsch = null, ms = 500, status = 'ok' } = {}) {
  const live = { art: 'werkzeug', name: 'hub_aufrufen', args_form: {}, args_hash: 'h' };
  const sch = treffer ? live : { art: 'werkzeug', name: 'hub_schema', args_form: {}, args_hash: 'h' };
  return {
    t: 1000 + i,
    tag: '2026-10-25',
    art: 'zug',
    adapter: 'bolt',
    ein: `e${i}`,
    live,
    schatten: status === 'ok' ? { ...sch, json_gueltig: true, deutsch: null } : null,
    uebereinstimmung: status === 'ok' ? { werkzeug: treffer, argumente: treffer ? true : null, exakt: treffer, json_gueltig: true, deutsch: null, falsch } : null,
    latenz: { erstes_token_ms: 100, gesamt_ms: ms },
    tokens: { ein: 1, aus: 1 },
    status,
    version: { modell: 'm', quant: 'q', systemkopf: 'k' },
  };
}
const viele = (n, f) => Array.from({ length: n }, (_, i) => zeile(i, f(i)));

test('Tor: zu wenig Daten, ja, nein; streng nimmt die Wilson-Grenze; Latenz-Schwelle; nie ohne Messwerte', () => {
  const tor = torKonfig({});
  assert.equal(tor.min_zuege, 100);
  assert.equal(tor.min_werkzeug, 0.9);
  assert.equal(tor.max_falsch, 0.03);
  const wenig = auswerten(viele(99, () => ({})), { tor }).adapter.bolt.tor;
  assert.equal(wenig.bereit, 'zu wenig Daten');
  assert.match(wenig.satz, /zu wenig Daten \(99 von 100/);
  // 100 Züge, 97 Treffer, kein Falsch (andere Werkzeuge beide Seiten) → ja
  const gut = auswerten(viele(100, (i) => ({ treffer: i >= 3 })), { tor }).adapter.bolt.tor;
  assert.equal(gut.bereit, 'ja');
  assert.equal(gut.satz, 'Schatten bereit für aktiv: ja');
  assert.deepEqual(gut.gruende, []);
  // 85 % Treffer → nein
  const schlecht = auswerten(viele(100, (i) => ({ treffer: i >= 15 })), { tor }).adapter.bolt.tor;
  assert.equal(schlecht.bereit, 'nein');
  // 96 % Treffer, aber 4 Falsch-Auslösungen (live-ruft) → nein wegen Falsch (4 % ≥ 3 %)
  const falsch = auswerten(viele(100, (i) => (i < 4 ? { treffer: false, falsch: 'live-ruft' } : {})), { tor }).adapter.bolt.tor;
  assert.equal(falsch.bereit, 'nein');
  assert.ok(falsch.gruende.some((g) => g.startsWith('falsch')));
  // streng: 97/100 hat untere Wilson-Grenze ≈ 0,915 (≥ 0,9 gehalten); 94/100 ≈ 0,876 (nicht gehalten) obwohl Punktwert 0,94 ≥ 0,9
  const mitte = auswerten(viele(100, (i) => ({ treffer: i >= 6 })), { tor });
  assert.equal(mitte.adapter.bolt.tor.bereit, 'ja');
  assert.equal(auswerten(viele(100, (i) => ({ treffer: i >= 6 })), { tor: torKonfig({ streng: true }) }).adapter.bolt.tor.bereit, 'nein');
  // Auch „0 Falsch“ braucht Züge: bei 100 liegt die obere Wilson-Grenze noch bei 3,7 % (> 3 %), bei 400 bei 0,95 %.
  assert.equal(auswerten(viele(100, (i) => ({ treffer: i >= 3 })), { tor: torKonfig({ streng: true }) }).adapter.bolt.tor.bereit, 'nein');
  assert.equal(auswerten(viele(400, (i) => ({ treffer: i >= 12 })), { tor: torKonfig({ streng: true }) }).adapter.bolt.tor.bereit, 'ja');
  // Fehler: 6 von 106 Versuchen scheitern → Fehlerquote 5,7 % > 5 %
  const mitFehlern = [...viele(100, () => ({})), ...Array.from({ length: 6 }, (_, i) => zeile(500 + i, { status: 'fehler' }))];
  assert.equal(auswerten(mitFehlern, { tor }).adapter.bolt.tor.bereit, 'nein');
  // Latenz p95 nur, wenn gesetzt
  const langsam = viele(100, (i) => ({ ms: i < 10 ? 9000 : 500 }));
  assert.equal(auswerten(langsam, { tor }).adapter.bolt.tor.bereit, 'ja');
  assert.equal(auswerten(langsam, { tor: torKonfig({ max_p95_ms: 2000 }) }).adapter.bolt.tor.bereit, 'nein');
  // NIE automatisch umschalten: das Urteil ist reine Rechnung, ohne Seiteneffekt (nur Daten rein, Daten raus).
  assert.equal(typeof torUrteil, 'function');
  assert.equal(torUrteil.length, 2);
});

test('Wahrheit: neueste Rückmeldung gewinnt; „schlecht“ ohne richtiges Werkzeug zählt nur Live-schlecht', () => {
  const z = [zeile(1, {}), zeile(2, { treffer: false })];
  const w = [
    { t: 5, art: 'wahrheit', ein: 'e1', urteil: 'schlecht' },
    { t: 9, art: 'wahrheit', ein: 'e1', urteil: 'gut' },
    { t: 7, art: 'wahrheit', ein: 'e2', urteil: 'korrektur', wahr_werkzeug: 'hub_schema' },
  ];
  const b = auswerten([...z, ...w], {}).adapter.bolt.wahrheit;
  assert.equal(b.mit_urteil, 2);
  assert.equal(b.live_schlecht, 0, 'e1 wurde später als „gut“ bestätigt');
  assert.equal(b.bekannt, 2);
  assert.equal(b.live_treffer.k, 1);
  assert.equal(b.schatten_treffer.k, 2);
});
