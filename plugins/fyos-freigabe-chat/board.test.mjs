/**
 * board.mjs — die Verdrahtung. Ohne diesen Test ist nur die Regel bewiesen.
 *
 * Der gefaehrliche Fehler liegt hier und nicht in `entscheidung.mjs`: eine richtige
 * Entscheidung am FALSCHEN Vorgang. Und: ein Statuswechsel ohne Kommentar waere eine
 * Entscheidung ohne Herkunft.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FYOS_VORGAENGE_URL = 'http://vorgaenge.test/api';

/** Ersetzt `fetch` und schreibt jeden Aufruf mit. */
function fang(antworten = {}) {
  const aufrufe = [];
  globalThis.fetch = async (url, opt = {}) => {
    const pfad = String(url).replace(/^https?:\/\/[^/]+/, '');
    aufrufe.push({pfad, methode: opt.method || 'GET', koerper: opt.body ? JSON.parse(opt.body) : null});
    // Der Pfad traegt den Praefix `/api/` — die Schluessel der Attrappe nicht.
    const kurz = pfad.replace(/^\/api/, '');
    const passend = Object.entries(antworten).find(([k]) => kurz.startsWith(k));
    const daten = passend ? passend[1] : {ok: true};
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(daten),
    };
  };
  return aufrufe;
}

// Eine Instanz genuegt: `board.mjs` liest die URL beim Laden, und die Tests
// unterscheiden sich im `fetch`-Attrappen, nicht im Modul.
const board = () => import('./board.mjs');

test('eine Genehmigung setzt in_progress und leert waiting_for', async () => {
  const aufrufe = fang({'/tickets?': {tickets: [{id: 'CHG-3702'}]}});
  const b = await board();
  const r = await b.behandle('genehmigt');

  assert.equal(r.gehandelt, true);
  assert.equal(r.ticket, 'CHG-3702');
  const patch = aufrufe.find((a) => a.methode === 'PATCH');
  assert.equal(patch.koerper.status, 'in_progress');
  assert.equal(patch.koerper.waiting_for, '', 'die Wartemarke faellt mit dem Status');
  assert.equal(patch.koerper.actor, 'besitzer', "die Entscheidung erscheint unter des Besitzers Namen");
  assert.equal(
    patch.koerper.expected_status,
    'waiting_approval',
    'eine spaetere Sicht darf die erste Entscheidung nicht ueberschreiben',
  );
});

test('eine Ablehnung geht nach triage, nicht nach closed', async () => {
  // `closed` ist des Besitzers Sache am Board. Eine abgelehnte Handlung heisst nicht, dass
  // die Sache erledigt ist (dieselbe Regel wie in dem Dienst).
  const aufrufe = fang({'/tickets?': {tickets: [{id: 'CHG-3702'}]}});
  const b = await board();
  await b.behandle('abgelehnt');
  const patch = aufrufe.find((a) => a.methode === 'PATCH');
  assert.equal(patch.koerper.status, 'triage');
});

test('der Kommentar kommt VOR dem Statuswechsel', async () => {
  // Scheitert der Statuswechsel, liegt die Begruendung trotzdem in der Akte.
  const aufrufe = fang({'/tickets?': {tickets: [{id: 'CHG-3702'}]}});
  const b = await board();
  await b.behandle('genehmigt');
  const kommentar = aufrufe.findIndex((a) => a.pfad.includes('/comments'));
  const patch = aufrufe.findIndex((a) => a.methode === 'PATCH');
  assert.ok(kommentar >= 0 && kommentar < patch, 'Kommentar zuerst');
});

test('ein Kommentar ohne Entscheidungswort aendert KEINEN Status', async () => {
  const aufrufe = fang({'/tickets?': {tickets: [{id: 'CHG-3702'}]}});
  const b = await board();
  const r = await b.behandle('wo steht das?');
  assert.equal(r.gehandelt, true, 'der Kommentar wird geschrieben');
  assert.equal(r.art, 'keine');
  assert.equal(aufrufe.find((a) => a.methode === 'PATCH'), undefined, 'kein Statuswechsel');
  assert.ok(aufrufe.some((a) => a.pfad.includes('/comments')));
});

test('Fragen mit Zustimmungswort aendern KEINEN Status — der Review-Befund bis zum PATCH', async () => {
  // Vorher genehmigten diese vier bei genau einer offenen Freigabe (`kurzes_ja`,
  // `klares_ja`): PATCH auf in_progress, der Lauf ging weiter. Jetzt: Kommentar und
  // Rueckfrage, der Status bleibt.
  for (const text of ['ok, was ist das?', 'passt das so?', 'ist CHG-12 schon freigegeben?', 'ja aber warum']) {
    const aufrufe = fang({'/tickets?': {tickets: [{id: 'CHG-12'}]}});
    const b = await board();
    const r = await b.behandle(text);

    assert.equal(r.gehandelt, true, `${text}: die Nachricht wird als Kommentar festgehalten`);
    assert.equal(r.art, 'keine', text);
    assert.equal(r.grund, 'frage', text);
    assert.equal(aufrufe.find((a) => a.methode === 'PATCH'), undefined, `${text}: KEIN Statuswechsel`);
    const kommentar = aufrufe.find((a) => a.pfad.endsWith('/tickets/CHG-12/comments'));
    assert.equal(kommentar.koerper.text, text, "des Besitzers Wortlaut steht in der Akte");
    assert.match(r.text, /nichts freigegeben/, `${text}: die Antwort sagt, dass nichts freigegeben wurde`);
  }
});

test('ein eingeschraenktes oder widerspruechliches Ja aendert KEINEN Status', async () => {
  for (const text of ['ja, aber nur nach Feierabend', 'nein, doch genehmigt', 'ok stopp', 'nichts genehmigt', 'ok dann los']) {
    const aufrufe = fang({'/tickets?': {tickets: [{id: 'CHG-12'}]}});
    const b = await board();
    const r = await b.behandle(text);
    assert.equal(r.art, 'keine', text);
    assert.equal(aufrufe.find((a) => a.methode === 'PATCH'), undefined, `${text}: KEIN Statuswechsel`);
    assert.match(r.text, /nichts freigegeben/, text);
  }
});

test('eindeutige kurze Antworten wirken wie bisher', async () => {
  const faelle = [
    ['ja', 'in_progress'],
    ['ok', 'in_progress'],
    ['ja, mach', 'in_progress'],
    ['genehmigt CHG-12', 'in_progress'],
    ['nein', 'triage'],
    ['nein danke', 'triage'],
    ['abgelehnt CHG-12', 'triage'],
  ];
  for (const [text, status] of faelle) {
    const aufrufe = fang({'/tickets?': {tickets: [{id: 'CHG-12'}]}});
    const b = await board();
    const r = await b.behandle(text);
    assert.equal(r.gehandelt, true, text);
    assert.equal(aufrufe.find((a) => a.methode === 'PATCH').koerper.status, status, text);
  }
});

test('`kommentar CHG-12: ok` ist ein Kommentar und keine Freigabe', async () => {
  // Der dritte Antwortweg aus der Anfrage (`kommentar CHG-…: …`). Vorher stand darin
  // „ok" als kurzes Ja — und der Kommentar genehmigte.
  const aufrufe = fang({'/tickets?': {tickets: [{id: 'CHG-12'}]}});
  const b = await board();
  const r = await b.behandle('kommentar CHG-12: ok');
  assert.equal(r.art, 'keine');
  assert.equal(r.grund, 'kommentar');
  assert.equal(aufrufe.find((a) => a.methode === 'PATCH'), undefined, 'kein Statuswechsel');
  assert.ok(aufrufe.some((a) => a.pfad.endsWith('/tickets/CHG-12/comments')), 'der Kommentar steht in der Akte');
  assert.doesNotMatch(r.text, /nichts freigegeben/, 'ein Kommentar braucht keine Rueckfrage');
});

test('eine fremde Kennung schreibt nichts — auch nicht auf den einzigen offenen Vorgang', async () => {
  // Vorher: „CHG-99 genehmigt" fand keinen Treffer, und weil genau eine Freigabe offen war,
  // wurde CHG-12 freigegeben — ein Vorgang, den der Besitzer nicht genannt hat.
  const aufrufe = fang({'/tickets?': {tickets: [{id: 'CHG-12'}]}});
  const b = await board();
  const r = await b.behandle('CHG-99 genehmigt');
  assert.equal(r.gehandelt, false);
  assert.equal(r.grund, 'kennung_nicht_offen');
  assert.deepEqual(aufrufe.filter((a) => a.methode !== 'GET'), [], 'nichts geschrieben');
});

test('der Trockenlauf einer Frage schreibt nichts und zeigt die Rueckfrage', async () => {
  const aufrufe = fang({'/tickets?': {tickets: [{id: 'CHG-12'}]}});
  const b = await board();
  const r = await b.behandle('ok, was ist das?', {handeln: false});
  assert.equal(r.gehandelt, false);
  assert.match(r.text, /nichts freigegeben/);
  assert.deepEqual(aufrufe.filter((a) => a.methode !== 'GET'), []);
});

test('mehrere offene ohne Kennung handeln NICHT', async () => {
  const aufrufe = fang({'/tickets?': {tickets: [{id: 'CHG-1'}, {id: 'CHG-2'}]}});
  const b = await board();
  const r = await b.behandle('genehmigt');
  assert.equal(r.gehandelt, false);
  assert.equal(r.grund, 'mehrere_offen');
  assert.deepEqual(aufrufe.filter((a) => a.methode !== 'GET'), [], 'nichts geschrieben');
});

test('die genannte Kennung waehlt auch bei mehreren', async () => {
  const aufrufe = fang({'/tickets?': {tickets: [{id: 'CHG-1'}, {id: 'CHG-2'}]}});
  const b = await board();
  const r = await b.behandle('CHG-2 genehmigt');
  assert.equal(r.ticket, 'CHG-2');
  assert.match(aufrufe.find((a) => a.methode === 'PATCH').pfad, /\/tickets\/CHG-2$/);
});

test('keine offene Freigabe schreibt nichts', async () => {
  const aufrufe = fang({'/tickets?': {tickets: []}});
  const b = await board();
  const r = await b.behandle('genehmigt');
  assert.equal(r.gehandelt, false);
  assert.equal(r.grund, 'keine_offen');
  assert.deepEqual(aufrufe.filter((a) => a.methode !== 'GET'), []);
});

test('der Trockenlauf schreibt nichts, sagt aber was passieren wuerde', async () => {
  const aufrufe = fang({'/tickets?': {tickets: [{id: 'CHG-3702'}]}});
  const b = await board();
  const r = await b.behandle('genehmigt', {handeln: false});
  assert.equal(r.gehandelt, false);
  assert.match(r.text, /CHG-3702/);
  assert.deepEqual(aufrufe.filter((a) => a.methode !== 'GET'), []);
});

test('offene_freigaben liest das BOARD, nicht den Daemon-Speicher', async () => {
  // Die fachlichen Freigaben entstehen ueber `tor()` direkt im Board. Wer den
  // Daemon-Speicher liest, sieht nur die Exec-Freigaben aus OpenClaw — und keine
  // von des Agenten Fragen.
  const aufrufe = fang({'/tickets?': {tickets: [{id: 'VOR-3901', waiting_for: 'besitzer'}]}});
  const b = await board();
  const offen = await b.offene_freigaben();
  assert.equal(offen[0].id, 'VOR-3901');
  assert.match(aufrufe[0].pfad, /status=waiting_approval/);
});
