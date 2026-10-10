/**
 * Die Chat-Antwort ist eine Freigabe — aber nur, wenn sie eine IST.
 *
 * der Besitzer, 2026-09-18: „also sage ich ihr im chat so wie dir hier jetzt auch:
 * genehmigt, reicht das als genehmigung aus."
 *
 * Dieser Test prueft die REGEL, nicht die Verdrahtung. Der gefaehrliche Ausgang
 * ist die Genehmigung: sie laesst eine Handlung laufen. Deshalb muss die Auswahl
 * nein sagen koennen — und tut sie das nicht, faellt es hier auf, nicht im
 * Betrieb. Dieselbe Haltung wie `test_rueckfrage_haelt_an.py` auf der
 * Python-Seite: der Test bewacht die WIRKUNG, nicht die Implementierung.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {entscheide, waehle_vorgang, antwort_text, woerter} from './entscheidung.mjs';

test('das klare Ja genehmigt', () => {
  for (const text of [
    'genehmigt',
    'Genehmigt.',
    'ich genehmige das',
    'freigegeben',
    'einverstanden',
    'erteilt',
    'vollfreigabe',
  ]) {
    assert.equal(entscheide(text).art, 'genehmigen', `${text} sollte genehmigen`);
  }
});

test('das kurze Ja genehmigt — als ganze Antwort', () => {
  for (const text of ['ja', 'Ja!', 'ok', 'okay', 'go', 'passt']) {
    assert.equal(entscheide(text).art, 'genehmigen', `${text} sollte genehmigen`);
  }
});

test('ein Satz mit „ja" ist KEINE Entscheidung', () => {
  // DER Fall: „ja, aber wo steht das?" ist eine Frage, keine Freigabe.
  const r = entscheide('ja, aber wo steht das denn genau im manifest');
  assert.equal(r.art, 'keine');
});

test('ein Nein lehnt ab', () => {
  for (const text of ['abgelehnt', 'nein', 'stop', 'ablehnen bitte']) {
    assert.equal(entscheide(text).art, 'ablehnen', `${text} sollte ablehnen`);
  }
});

test('ein Nein schlaegt ein Ja', () => {
  // „nein, nicht genehmigen" darf nie als Genehmigung durchgehen — und es IST ein
  // eindeutiges Nein: das Ja darin ist verneint („nicht genehmigen").
  assert.equal(entscheide('nein, das nicht genehmigen').art, 'ablehnen');
  assert.equal(entscheide('nein, nicht genehmigen').art, 'ablehnen');
  assert.equal(entscheide('abgelehnt, nicht freigegeben').art, 'ablehnen');
});

test('ein verneintes Ja ist KEINE Genehmigung', () => {
  // „nicht genehmigt" ist weder Ja noch Nein — es fehlt etwas. Fail-closed: es
  // passiert nichts, und der Besitzer kann erneut antworten.
  for (const text of ['nicht genehmigt', 'keine Freigabe', 'ohne Zustimmung']) {
    assert.equal(entscheide(text).art, 'keine', `${text} darf NICHT genehmigen`);
  }
});

test('Fragen und Kommentare entscheiden nicht', () => {
  for (const text of ['wo steht das?', 'spaeter', 'was passiert wenn nicht?', 'interessant']) {
    assert.equal(entscheide(text).art, 'keine', `${text} ist keine Entscheidung`);
  }
});

// ── Der Review-Befund nach INC-3893 ───────────────────────────────────────────
//
// Die Regel las Fragen als Zustimmung: ein starkes Ja zaehlte an jeder Stelle des
// Satzes, ein kurzes Ja bei bis zu vier Woertern, und ein Fragezeichen oder Fragewort
// wurde nie beachtet. Bei genau einer offenen Freigabe wurde sie damit erteilt —
// „ok, was ist das?", „passt das so?", „ist CHG-12 schon freigegeben?", „ja aber warum".
//
// Die Tests darunter bewachen die WIRKUNG: nie genehmigen, wenn der Besitzer gefragt, etwas
// eingeschraenkt oder sich widersprochen hat. Was NICHT sicher ein Ja ist, ist keins.

/** Die vier Faelle aus dem Review — wortgleich. */
const REVIEW_BEFUND = ['ok, was ist das?', 'passt das so?', 'ist CHG-12 schon freigegeben?', 'ja aber warum'];

/** Die Zustimmungen, gegen die Fragen, Vorbehalte und Widersprueche geprueft werden. */
const ZUSTIMMUNGEN = [
  'ja', 'ok', 'okay', 'go', 'passt', 'mach', 'los', 'gerne',
  'genehmigt', 'freigegeben', 'einverstanden', 'erteilt', 'ja, mach', 'genehmigt CHG-12',
];

const FRAGEN = [
  'ist das freigegeben?',
  'kannst du das erklären',
  'kannst du das erklaeren',
  'ok aber was kostet das',
  'ist das freigegeben', // ohne Fragezeichen: das Verb steht vorn
  'passt das so',
  'ok wieso',
  'ja, wer macht das dann',
  'okay wann geht das los',
  'ja koennte das schiefgehen',
  'ja könnte das schiefgehen',
  'ok gibt es eine alternative',
  'ja, hast du das geprüft',
  'ok, ich habe eine frage',
  'ja weisst du ob das klappt',
];

const ZWEIDEUTIG = [
  'ja aber nur nach feierabend',
  'ok aber lieber morgen',
  'ja, warte kurz',
  'moment, ok',
  'ja lass mal',
  'ok, wenn du meinst',
  'ja aber nicht jetzt',
  'passt, nur nicht heute',
  'ja lieber nicht',
  'hmm ok',
  'ich denke das passt so',
  'ok dann los', // vorher: 3 Woerter = „kurzes Ja"
  'ok danke', // eine Kenntnisnahme, keine Freigabe
  'ja mach das',
  'ja das ist ok',
  'passt schon',
  'ja, bitte umsetzen',
  'genehmigt nach dem backup', // eine Bedingung, die kein Vorbehaltswort traegt
  'freigegeben, aber erst morgen',
  'nichts genehmigt',
];

test('die vier Fragen aus dem Review genehmigen NICHT', () => {
  for (const text of REVIEW_BEFUND) {
    const r = entscheide(text);
    assert.equal(r.art, 'keine', `${text} darf nicht entscheiden`);
    assert.equal(r.grund, 'frage', `${text} ist eine Frage`);
  }
});

test('weitere Fragen genehmigen nicht — mit und ohne Fragezeichen', () => {
  for (const text of FRAGEN) {
    assert.equal(entscheide(text).art, 'keine', `${text} ist eine Frage`);
  }
});

test('ein Fragezeichen entscheidet nie — an keiner Stelle, in keiner Form', () => {
  for (const zustimmung of ZUSTIMMUNGEN) {
    for (const zeichen of ['?', ' ?', '??', '?!', '？', ' ❓', ' ❔']) {
      assert.equal(entscheide(`${zustimmung}${zeichen}`).art, 'keine', `${zustimmung}${zeichen}`);
    }
    assert.equal(entscheide(`? ${zustimmung}`).art, 'keine', `? ${zustimmung}`);
    assert.equal(entscheide(`${zustimmung} ? ${zustimmung}`).art, 'keine', `${zustimmung} ? ${zustimmung}`);
  }
  // Auch ein Nein wird mit Fragezeichen keine Ablehnung.
  for (const text of ['nein?', 'abgelehnt?', 'stopp?', 'nein, wieso?']) {
    assert.equal(entscheide(text).art, 'keine', text);
  }
});

test('zweideutige Saetze entscheiden nicht', () => {
  for (const text of ZWEIDEUTIG) {
    assert.equal(entscheide(text).art, 'keine', `${text} ist keine eindeutige Zustimmung`);
  }
});

test('kein Vorbehalt, keine Verneinung und kein Nein steht je neben einem Ja, das genehmigt', () => {
  // Kombinatorisch statt Einzelfaelle: jedes Zustimmungswort mit jedem Bremswort, in
  // beiden Reihenfolgen. Wer die Liste der Zustimmungswoerter erweitert, muss hier
  // durch — ein neues „ok" neben einem „aber" genehmigt nie.
  const bremsen = [
    'aber', 'lieber', 'lass', 'warte', 'moment', 'nur', 'erst', 'wenn', 'spaeter',
    'nicht', 'kein', 'ohne', 'nie', 'nein', 'stopp', 'stop', 'abgelehnt',
  ];
  for (const ja of ZUSTIMMUNGEN) {
    for (const bremse of bremsen) {
      for (const text of [`${ja} ${bremse}`, `${bremse} ${ja}`, `${ja}, ${bremse} noch`]) {
        assert.notEqual(entscheide(text).art, 'genehmigen', `${text} darf NICHT genehmigen`);
      }
    }
  }
});

test('ein Widerspruch entscheidet nichts', () => {
  // Vorher gewann das Nein (`nein_schlaegt_ja` -> `ablehnen`). Aber auch ein Nein setzt
  // den Status (`triage`, die Freigabe ist weg); wer sich widerspricht, hat weder das
  // eine noch das andere entschieden. Im Zweifel passiert nichts, und der Besitzer antwortet neu.
  for (const text of ['ja nein', 'nein ja', 'nein, doch genehmigt', 'ok stopp', 'genehmigt oder abgelehnt', 'ja ❌']) {
    const r = entscheide(text);
    assert.equal(r.art, 'keine', `${text} entscheidet nichts`);
    assert.equal(r.grund, 'widerspruch', text);
  }
});

test('ein Nein ist nur als GANZE Antwort eine Ablehnung', () => {
  for (const text of [
    'nein', 'Nein.', 'nein danke', 'Nein, danke!', 'nein, bitte nicht', 'stopp', 'stop', 'abgelehnt',
    'ablehnen bitte', 'nein, so nicht', 'nein CHG-12', 'abgelehnt CHG-12',
  ]) {
    assert.equal(entscheide(text).art, 'ablehnen', `${text} ist ein eindeutiges Nein`);
  }
  // Mit Beiwerk ist es ein Satz — und ein Aufschub oder eine Frage ist keine Ablehnung.
  for (const text of [
    'nein, morgen frueh', 'nein aber warte', 'nein spaeter', 'nein, wieso?', 'nicht abgelehnt',
    'nein, ich habe da noch eine anmerkung', 'nein, erst nach dem backup',
  ]) {
    assert.equal(entscheide(text).art, 'keine', `${text} ist kein eindeutiges Nein`);
  }
});

test('das Kommentar-Wort der Anfrage ist nie eine Entscheidung', () => {
  // fanout.mjs bietet der Besitzer drei Antworten an: `genehmigt CHG-…`, `abgelehnt CHG-…` und
  // `kommentar CHG-…: …`. Der dritte Weg darf nicht genehmigen, nur weil im Kommentar
  // „ok" steht.
  for (const text of ['kommentar CHG-123: ok', 'kommentar CHG-123: genehmigt', 'kommentar CHG-123: nein', 'Kommentar: ja']) {
    const r = entscheide(text);
    assert.equal(r.art, 'keine', text);
    assert.equal(r.grund, 'kommentar', text);
  }
});

test('eine eindeutige, alleinstehende Zustimmung genehmigt — auch kombiniert', () => {
  for (const text of [
    'ja', 'ok', 'okay', 'go', 'passt', 'mach', 'los', 'gerne', 'gern',
    'ja, mach', 'ok los', 'ja gerne', 'ja bitte', 'passt so', 'ja ja', 'okay, mach los',
    'genehmigt', 'freigegeben', 'erteilt', 'genehmigt, los', 'ja genehmigt',
    'ich genehmige das', 'genehmigt, danke', 'GENEHMIGT!', 'Ja.',
  ]) {
    assert.equal(entscheide(text).art, 'genehmigen', `${text} sollte genehmigen`);
  }
});

test('Emojis und Satzzeichen am Rand aendern nichts', () => {
  for (const text of ['👍 ja', 'ok 👍', '**ja**', '  ok  ', 'ja - mach', '"ja"', 'ja!!!', '(ok)', '— ja —']) {
    assert.equal(entscheide(text).art, 'genehmigen', `${text} sollte genehmigen`);
  }
  // Ein Emoji, das nein sagt, ist kein Rand: es widerspricht dem Ja.
  assert.equal(entscheide('ja 👎').art, 'keine');
});

test('eine Kennung ergaenzt die Zustimmung — sie ersetzt sie nicht', () => {
  for (const text of [
    'genehmigt CHG-12', 'CHG-12 genehmigt', 'chg-12 ok', 'ja CHG-12', 'ok, CHG-12',
    'ich genehmige CHG-12', 'CHG-12: freigegeben', '#CHG-12 genehmigt',
  ]) {
    assert.equal(entscheide(text).art, 'genehmigen', `${text} sollte genehmigen`);
  }
  for (const text of ['abgelehnt CHG-12', 'nein CHG-12']) {
    assert.equal(entscheide(text).art, 'ablehnen', `${text} sollte ablehnen`);
  }
  // Die Kennung allein, mit Frage, Verneinung, Bedingung oder in falscher Schreibweise:
  // nichts davon ist eine Freigabe.
  for (const text of [
    'CHG-12',
    'ist CHG-12 freigegeben',
    'ist CHG-12 schon freigegeben?',
    'CHG-12 genehmigt?',
    'CHG-12 nicht genehmigt',
    'genehmigt CHG-12 nach dem Backup',
    'CHG-12 genehmigt, aber nicht jetzt',
    'CHG 12 genehmigt',
    'CHG12 genehmigt',
  ]) {
    assert.equal(entscheide(text).art, 'keine', `${text} darf NICHT entscheiden`);
  }
});

test('zwei Kennungen sind zwei Vorgaenge — eine Entscheidung gilt genau einem', () => {
  const r = entscheide('CHG-12 und CHG-13 genehmigt');
  assert.equal(r.art, 'keine');
  assert.equal(r.grund, 'mehrere_kennungen');
  // Dieselbe Kennung zweimal ist eine Kennung.
  assert.equal(entscheide('genehmigt CHG-12, CHG-12 ok').art, 'genehmigen');
});

test('die Form der Kennung kommt aus dem VERTRAG', () => {
  // Der Vertrag verankert die Form (`^…$`). Entscheidung.mjs verweigert das Laden ohne —
  // ein offenes Muster machte jedes Wort zur Kennung und die Whitelist zum Sieb.
  assert.ok(KENNUNG_VERTRAG.form.startsWith('^') && KENNUNG_VERTRAG.form.endsWith('$'));
  for (const kennung of ['INC-1', 'PRB-22', 'CHG-333', 'VOR-4444']) {
    assert.equal(entscheide(`genehmigt ${kennung}`).art, 'genehmigen', kennung);
  }
  // Ausserhalb der Vertragsform: keine Kennung, also ein fremdes Wort, also keine Freigabe.
  for (const kennung of ['A-12', 'ABCDEFG-12', 'CHG-012', 'CHG-', 'CHG-x']) {
    assert.equal(entscheide(`genehmigt ${kennung}`).art, 'keine', kennung);
  }
});

test('Umlaute und ihre Umschrift gelten gleich', () => {
  for (const [mit, ohne] of [
    ['ja, könnte das klappen', 'ja, koennte das klappen'],
    ['ok, wofür ist das', 'ok, wofuer ist das'],
    ['ok, würdest du das prüfen', 'ok, wuerdest du das pruefen'],
  ]) {
    assert.deepEqual(entscheide(mit), entscheide(ohne));
    assert.equal(entscheide(mit).art, 'keine', mit);
  }
});

test('Zufallsprobe: genehmigt wird nur, was AUSSCHLIESSLICH aus Zustimmung besteht', () => {
  // Die Zustimmungswoerter stehen hier ein ZWEITES Mal — mit Absicht, als unabhaengige
  // Aussage der Regel. Wer der Regel ein Wort hinzufuegt, muss es hier bewusst auch tun;
  // ein Wort, das nur in der Regel steht, faellt an diesem Test auf.
  const STARK = ['genehmigt', 'genehmige', 'genehmigen', 'erteilt', 'erteile', 'erteilen', 'freigegeben', 'freigeben', 'vollfreigabe', 'vollfreigegeben', 'einverstanden'];
  const SCHWACH = ['ja', 'ok', 'okay', 'go', 'passt', 'mach', 'los', 'gerne', 'gern'];
  const BEIWERK = ['bitte', 'so'];
  const NUR_MIT_STARK = ['ich', 'das', 'es', 'dies', 'hiermit', 'danke'];
  const KENNUNGEN = ['CHG-12', 'inc-7'];
  const STOERER = [
    'aber', 'nicht', 'nein', 'warum', 'was', 'ist', 'kannst', 'wenn', 'nur', 'spaeter', 'kommentar', 'lieber',
    'stopp', 'wie', 'wer', 'wo', 'morgen', 'backup', 'dann', 'doch', 'oder', 'kein', 'ohne', 'nichts',
    'warte', 'moment', 'lass', 'könnte', 'gibt', 'abgelehnt', 'hmm', 'vielleicht', 'noch', 'schon', 'CHG-99', 'x', '1',
  ];
  const ZEICHEN = ['?', '!', ',', '.', '...', ' - ', ' — ', '👍', '❌', '✅', '？', '❓', ':', '"', '\n'];
  const KENNUNG = /^(inc|prb|chg|vor)-[1-9][0-9]*$/;

  // Fester Startwert: ein Fehler ist reproduzierbar.
  let zustand = 20260929;
  const zufall = () => (zustand = (zustand * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const wahl = (liste) => liste[Math.floor(zufall() * liste.length)];

  let genehmigt = 0;
  for (let i = 0; i < 30000; i += 1) {
    const teile = Array.from({length: 1 + Math.floor(zufall() * 7)}, () => {
      const p = zufall();
      if (p < 0.3) return wahl(SCHWACH);
      if (p < 0.45) return wahl(STARK);
      if (p < 0.52) return wahl(BEIWERK);
      if (p < 0.6) return wahl(NUR_MIT_STARK);
      if (p < 0.66) return wahl(KENNUNGEN);
      return p < 0.86 ? wahl(STOERER) : wahl(ZEICHEN);
    });
    const text = teile.join(zufall() < 0.5 ? ' ' : ', ');
    const w = woerter(text);
    const stark = w.some((t) => STARK.includes(t));
    const ja = stark || w.some((t) => SCHWACH.includes(t));
    const nur_zustimmung =
      w.length > 0 &&
      ja &&
      w.every((t) => STARK.includes(t) || SCHWACH.includes(t) || BEIWERK.includes(t) || KENNUNG.test(t) || (stark && NUR_MIT_STARK.includes(t))) &&
      new Set(w.filter((t) => KENNUNG.test(t))).size <= 1 &&
      !/[?？❓❔❌]/u.test(text);

    const art = entscheide(text).art;
    // Sicherheit: nie genehmigen, wenn irgendetwas ausser Zustimmung im Text steht.
    if (art === 'genehmigen') {
      genehmigt += 1;
      assert.ok(nur_zustimmung, `${JSON.stringify(text)} darf NICHT genehmigen`);
    }
    // Brauchbarkeit: was ausschliesslich aus Zustimmung besteht, genehmigt auch.
    if (nur_zustimmung) assert.equal(art, 'genehmigen', `${JSON.stringify(text)} ist eine eindeutige Zustimmung`);
  }
  assert.ok(genehmigt > 1000, 'die Probe hat genug echte Zustimmungen gesehen, um etwas zu beweisen');
});

test('entscheide liefert nur genehmigen, ablehnen oder keine — und nur die ersten zwei wirken', () => {
  // Wer hier einen neuen Wert einfuehrt, ohne den Aufrufer und den Vertrag mitzunehmen,
  // faellt auf: `board.behandle` setzt sonst einen Status auf `undefined`.
  const korpus = [
    ...REVIEW_BEFUND, ...FRAGEN, ...ZWEIDEUTIG, ...ZUSTIMMUNGEN, '', '   ', '👍', 'interessant',
    'nein', 'nein danke', 'nein, doch genehmigt', 'kommentar CHG-1: ok', 'CHG-1 CHG-2 ok',
  ];
  for (const text of korpus) {
    const {art, grund} = entscheide(text);
    assert.ok(['genehmigen', 'ablehnen', 'keine'].includes(art), `${text}: unbekannte Art ${art}`);
    assert.equal(typeof grund, 'string', `${text}: ohne Grund`);
    if (art === 'keine') assert.equal(zielstatus(art), null, `${text}: keine hat kein Ziel`);
    else assert.ok(zielstatus(art), `${text}: ${art} hat keinen Zielstatus im Vertrag`);
  }
});

test('leerer Text entscheidet nicht', () => {
  assert.equal(entscheide('').art, 'keine');
  assert.equal(entscheide(null).art, 'keine');
  assert.equal(entscheide('   ').art, 'keine');
});

test('der Grund ist nachvollziehbar', () => {
  assert.equal(entscheide('genehmigt').grund, 'klares_ja');
  assert.equal(entscheide('ok').grund, 'kurzes_ja');
  assert.equal(entscheide('nein').grund, 'ausdrueckliches_nein');
  assert.equal(entscheide('nicht genehmigt').grund, 'ja_ist_verneint');
  assert.equal(entscheide('wo steht das?').grund, 'frage');
  assert.equal(entscheide('ja, aber nur nach Feierabend').grund, 'vorbehalt');
  assert.equal(entscheide('interessant').grund, 'kein_entscheidungswort');
  // Vorher: `nein_schlaegt_ja` -> `ablehnen`. Ein Widerspruch ist kein Nein: auch eine
  // Ablehnung setzt den Status (`triage`) und darf nicht geraten werden — siehe
  // „ein Widerspruch entscheidet nichts".
  assert.equal(entscheide('nein, doch genehmigt').grund, 'widerspruch');
});

test('woerter zerlegt und normalisiert', () => {
  assert.deepEqual(woerter('Ja, bitte!'), ['ja', 'bitte']);
  assert.deepEqual(woerter('CHG-123 genehmigt'), ['chg-123', 'genehmigt']);
});

test('woerter: Bindestriche am Rand fallen weg, in der Kennung bleiben sie', () => {
  // Vorher wurde „ja - mach" zu [`ja`, `-`, `mach`] — das Wort `-` machte aus einem
  // klaren Ja einen Satz.
  assert.deepEqual(woerter('ja - mach'), ['ja', 'mach']);
  assert.deepEqual(woerter('--ja--'), ['ja']);
  assert.deepEqual(woerter('CHG-12-'), ['chg-12']);
  assert.deepEqual(woerter('#CHG-12,'), ['chg-12']);
  // Zerlegte Umlaute (u + Trema) werden zusammengesetzt, statt das Wort zu zerreissen.
  assert.deepEqual(woerter('könnte'), ['könnte']);
});

test('genau eine offene Freigabe wird ohne Kennung gewaehlt', () => {
  const r = waehle_vorgang([{id: 'CHG-1'}], 'genehmigt');
  assert.equal(r.ticket.id, 'CHG-1');
});

test('die genannte Kennung gewinnt auch bei mehreren', () => {
  const r = waehle_vorgang([{id: 'CHG-1'}, {id: 'CHG-2'}], 'CHG-2 genehmigt');
  assert.equal(r.ticket.id, 'CHG-2');
});

test('mehrere offene ohne Kennung handeln NICHT', () => {
  // Eine falsche Zuordnung waere die schlimmste Form: eine Freigabe, die auf einen
  // anderen Vorgang wirkt als den, den der Besitzer gelesen hat.
  const r = waehle_vorgang([{id: 'CHG-1'}, {id: 'CHG-2'}], 'genehmigt');
  assert.equal(r.fehler, 'mehrere_offen');
});

test('keine offene Freigabe ist kein Fehler, sondern ein Nein', () => {
  assert.equal(waehle_vorgang([], 'genehmigt').fehler, 'keine_offen');
});

test('zwei genannte Kennungen handeln NICHT', () => {
  const r = waehle_vorgang([{id: 'CHG-1'}, {id: 'CHG-2'}], 'CHG-1 und CHG-2 genehmigt');
  assert.equal(r.fehler, 'mehrere_genannt');
});

test('eine fremde Kennung wird NICHT auf den einzigen offenen Vorgang umgebogen', () => {
  // Vorher: „CHG-99 genehmigt" fand keinen Treffer, und weil genau eine Freigabe offen
  // war, galt das Ja fuer CHG-12 — ein Vorgang, den der Besitzer nicht genannt hat. Die
  // schlimmste Form der Fehlzuordnung.
  assert.equal(waehle_vorgang([{id: 'CHG-12'}], 'CHG-99 genehmigt').fehler, 'kennung_nicht_offen');
  assert.equal(waehle_vorgang([{id: 'CHG-12'}, {id: 'CHG-13'}], 'CHG-99 genehmigt').fehler, 'kennung_nicht_offen');
  // Eine offene UND eine fremde Kennung sind zwei genannte Vorgaenge.
  assert.equal(waehle_vorgang([{id: 'CHG-12'}], 'CHG-12 und CHG-99 genehmigt').fehler, 'mehrere_genannt');
  // Die eigene Kennung wird gross wie klein erkannt; ohne Kennung bleibt es beim Alten.
  assert.equal(waehle_vorgang([{id: 'CHG-12'}], 'genehmigt chg-12').ticket.id, 'CHG-12');
  assert.equal(waehle_vorgang([{id: 'CHG-12'}], 'genehmigt').ticket.id, 'CHG-12');
});

test('die Antwort nennt den Ausgang', () => {
  assert.match(antwort_text('CHG-1', 'genehmigen'), /in_progress/);
  assert.match(antwort_text('CHG-1', 'ablehnen'), /triage/);
  assert.match(antwort_text('CHG-1', 'keine'), /bleibt offen/);
  assert.match(antwort_text('', 'keine', 'mehrere_offen'), /Kennung/);
  assert.match(antwort_text('', 'keine', 'kennung_nicht_offen'), /keine offene Freigabe/);
});

test('die Rueckfrage sagt AUSDRUECKLICH, dass nichts freigegeben wurde', () => {
  // Sonst hielte der Besitzer sein „ok, aber …" fuer erteilt und wartete auf einen Lauf, der nie kommt.
  for (const grund of ['frage', 'vorbehalt', 'widerspruch', 'ja_ist_verneint', 'ja_nicht_eindeutig', 'nein_nicht_eindeutig']) {
    const text = antwort_text('CHG-1', 'keine', grund);
    assert.match(text, /nichts freigegeben/, grund);
    assert.match(text, /bleibt offen/, grund);
    assert.match(text, /genehmigt CHG-1/, `${grund}: nennt die Antwort, die gilt`);
    assert.match(text, /abgelehnt CHG-1/, grund);
  }
  // Ein blosser Kommentar braucht keine Rueckfrage.
  for (const grund of ['kommentar', 'kein_entscheidungswort', 'leere_nachricht', undefined]) {
    assert.doesNotMatch(antwort_text('CHG-1', 'keine', grund), /nichts freigegeben/, String(grund));
  }
});

test('die Entscheidungswerte kommen aus dem VERTRAG, nicht aus einer Kopie', () => {
  // Vorher stand hier eine eigene Kopie der Zieltabelle mit dem Kommentar
  // „Deckungsgleich mit dem Dienst". Zwei Wahrheiten ueber dieselbe Sache,
  // zusammengehalten von einem Kommentar — und die Namen drifteten bereits
  // (`freigeben` in Python, `genehmigen` in JS).
  //
  // Jetzt laeuft es ueber den Vertrag: derselbe `zielstatus`, den Python liest.
  assert.equal(typeof zielstatus, 'function', 'der Vertrag muss den Zielstatus liefern');
  assert.equal(zielstatus('genehmigen'), 'in_progress');
  assert.equal(zielstatus('ablehnen'), 'triage');
  assert.equal(zielstatus('keine'), null, 'keine Entscheidung -> die Frage bleibt offen');
  assert.equal(zielstatus('freigeben'), 'in_progress', 'der alte Python-Name wird uebersetzt');
  assert.equal(zielstatus('erfunden'), null, 'fail-closed bei unbekanntem Wort');
});

test('ENTSCHEIDUNGEN und der Vertrag koennen nicht auseinanderlaufen', () => {
  for (const [name, ziel] of Object.entries(ENTSCHEIDUNGEN)) {
    assert.equal(ziel, zielstatus(name), `${name} weicht vom Vertrag ab`);
  }
});

import {ENTSCHEIDUNGEN} from './entscheidung.mjs';
import {zielstatus, KENNUNG as KENNUNG_VERTRAG} from './vertrag.mjs';
