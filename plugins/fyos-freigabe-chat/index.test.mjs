/**
 * Der Hook — und sein Riegel.
 *
 * Was hier zaehlt, ist nicht die Verdrahtung, sondern ob der Riegel greift. Ein Hook,
 * der auf `senderIsOwner` prueft, sieht in jedem Glueckstest gruen aus; ob er
 * tatsaechlich NEIN sagen kann, zeigt nur der Fall, in dem das Feld fehlt.
 *
 * Dieselbe Haltung wie `test_rueckfrage_haelt_an.py`: der Test bewacht die WIRKUNG.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FYOS_VORGAENGE_URL = 'http://vorgaenge.test/api';
import {registerFreigabeChat, koennte_entscheidung_sein} from './hook.mjs';

/** Ein API-Ersatz, der den Hook einfaengt und ein Board-Attrappchen liefert. */
function harness(board = {}, loggerFehler = [], config = {}) {
  let hook;
  const api = {
    on(name, fn) {
      if (name === 'before_agent_reply') hook = fn;
    },
    logger: {error: (m) => loggerFehler.push(m)},
  };
  registerFreigabeChat(api, {board, ...config});
  return (event, ctx) => hook(event, ctx);
}

const OWNER = {requester: {senderIsOwner: true}};
const FREMDE = {requester: {senderIsOwner: false}};
const OHNE = {requester: {}};
const KEIN_KONTEXT = {};

/** Ein Board, das nur mitschreibt. */
function boardAttrappe() {
  const aufrufe = {kommentiert: [], status: []};
  return {
    aufrufe,
    async offene_freigaben() {
      return [{id: 'CHG-3702', waiting_for: 'besitzer'}];
    },
    async kommentiere(t, text) {
      aufrufe.kommentiert.push([t, text]);
      return {ok: true};
    },
    async setze_status(t, s) {
      aufrufe.status.push([t, s]);
      return {ok: true};
    },
    async behandle(text) {
      // Vereinfachung fuer den Hook-Test: die Regel selbst prueft entscheidung.test.mjs.
      aufrufe.kommentiert.push(['CHG-3702', text]);
      return {gehandelt: true, ticket: 'CHG-3702', art: 'genehmigen', text: 'Freigegeben: CHG-3702.'};
    },
  };
}

test('der Besitzer mit einem klaren Ja bekommt eine Antwort ohne Modellaufruf', async () => {
  const board = boardAttrappe();
  const hook = harness(board);
  const r = await hook({cleanedBody: 'genehmigt'}, OWNER);
  assert.equal(r?.handled, true);
  assert.match(r.reply.text, /CHG-3702/);
});

test('ein FREMDER Absender handelt nicht — auch bei „genehmigt"', async () => {
  // DER Test. Ohne diese Eigenschaft koennte jeder, der dem Gateway schreibt,
  // einen Vorgang freigeben.
  const board = boardAttrappe();
  const hook = harness(board);
  const r = await hook({cleanedBody: 'genehmigt'}, FREMDE);
  assert.equal(r, undefined);
  assert.deepEqual(board.aufrufe.kommentiert, []);
  assert.deepEqual(board.aufrufe.status, []);
});

test('ein FEHLENDES senderIsOwner handelt nicht', async () => {
  // Die Doku: „Missing fields are unproven, not false assurances; fail closed."
  const board = boardAttrappe();
  const hook = harness(board);
  assert.equal(await hook({cleanedBody: 'genehmigt'}, OHNE), undefined);
  assert.equal(await hook({cleanedBody: 'genehmigt'}, KEIN_KONTEXT), undefined);
  assert.deepEqual(board.aufrufe.kommentiert, []);
});

test('ohne Entscheidungswort wird nicht einmal das Board gefragt', async () => {
  const board = boardAttrappe();
  let gefragt = 0;
  board.offene_freigaben = async () => {
    gefragt += 1;
    return [{id: 'CHG-1'}];
  };
  const hook = harness(board);
  const r = await hook({cleanedBody: 'erzaehl mir bitte etwas ueber den cluster'}, OWNER);
  assert.equal(r, undefined);
  assert.equal(gefragt, 0, 'jeder Satz darf keine Board-Abfrage kosten');
});

test('ein Board-Ausfall kippt den Chat nicht', async () => {
  const fehler = [];
  const hook = harness(
    {
      async behandle() {
        throw new Error('connect ECONNREFUSED');
      },
    },
    fehler,
  );
  const r = await hook({cleanedBody: 'genehmigt'}, OWNER);
  assert.equal(r, undefined, 'kein handled — der Turn laeuft normal weiter');
  assert.equal(fehler.length, 1, 'der Fehlschlag ist sichtbar');
  assert.match(fehler[0], /ECONNREFUSED/);
});

/**
 * Der Hook mit dem ECHTEN Board-Modul; nur das Netz ist ersetzt. So laeuft die ganze
 * Kette wie im Gateway: Riegel -> Vor-Filter -> Regel -> Vorgangswahl -> PATCH.
 * Gibt den Hook und die Liste der Aufrufe zurueck; `fertig()` stellt `fetch` wieder her.
 */
function hook_mit_echtem_board(offene) {
  const aufrufe = [];
  const echtesFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt = {}) => {
    aufrufe.push({
      methode: opt.method || 'GET',
      pfad: String(url).replace(/^https?:\/\/[^/]+/, ''),
      koerper: opt.body ? JSON.parse(opt.body) : null,
    });
    return {ok: true, status: 200, text: async () => JSON.stringify({tickets: offene})};
  };
  let hook;
  const api = {
    on(name, fn) {
      if (name === 'before_agent_reply') hook = fn;
    },
    logger: {error: () => {}},
  };
  registerFreigabeChat(api, {});
  return {hook, aufrufe, fertig: () => { globalThis.fetch = echtesFetch; }};
}

test('der Review-Befund vom Hook bis zum Board: vier Fragen genehmigen NICHTS', async () => {
  // Bei genau einer offenen Freigabe genehmigten diese vier Nachrichten (Review nach
  // INC-3893). Hier laufen sie durch den echten Hook — mit Riegel und Vor-Filter, weil
  // alle vier den Vor-Filter passieren — und duerfen keinen PATCH ausloesen.
  const {hook, aufrufe, fertig} = hook_mit_echtem_board([{id: 'CHG-12', waiting_for: 'besitzer'}]);
  try {
    for (const text of ['ok, was ist das?', 'passt das so?', 'ist CHG-12 schon freigegeben?', 'ja aber warum']) {
      assert.equal(koennte_entscheidung_sein(text), true, `${text} erreicht das Board (der Filter ist weit)`);
      const r = await hook({cleanedBody: text}, OWNER);
      assert.equal(r?.handled, true, `${text}: der Besitzer bekommt eine Antwort ohne Modellaufruf`);
      assert.match(r.reply.text, /nichts freigegeben/, `${text}: die Antwort sagt, dass nichts freigegeben wurde`);
      assert.match(r.reply.text, /bleibt offen/, text);
    }
    assert.equal(aufrufe.filter((a) => a.methode === 'PATCH').length, 0, 'KEIN Statuswechsel, nie');
    // Als Gegenprobe: ein klares Ja am selben Aufbau wirkt weiterhin.
    const ja = await hook({cleanedBody: 'genehmigt'}, OWNER);
    assert.equal(ja?.handled, true);
    const patch = aufrufe.find((a) => a.methode === 'PATCH');
    assert.equal(patch.koerper.status, 'in_progress');
    assert.match(patch.pfad, /\/tickets\/CHG-12$/);
  } finally {
    fertig();
  }
});

test('ein fremder Absender genehmigt auch mit dem eindeutigsten Ja nichts — der Riegel bleibt', async () => {
  // Die strengere Regel ersetzt den Riegel nicht: ohne `senderIsOwner === true` wird
  // das Board nicht einmal gefragt.
  const {hook, aufrufe, fertig} = hook_mit_echtem_board([{id: 'CHG-12', waiting_for: 'besitzer'}]);
  try {
    assert.equal(await hook({cleanedBody: 'genehmigt CHG-12'}, FREMDE), undefined);
    assert.deepEqual(aufrufe, [], 'kein einziger Aufruf');
  } finally {
    fertig();
  }
});

test('der Vor-Filter laesst Entscheidungsworte durch', () => {
  for (const t of ['genehmigt', 'ja', 'nein', 'abgelehnt', 'CHG-3702 genehmigt', 'CHG-3702']) {
    assert.equal(koennte_entscheidung_sein(t), true, `${t} sollte durchkommen`);
  }
});

test('➕ faengt die naechste Matrix-Nachricht als Kommentar ohne Modellturn', async () => {
  const board = boardAttrappe();
  const reaktionsspeicher = {zusatz_fuer: () => ({ticket: 'CHG-3702'}), loesche_zusatz: async () => {}};
  const hook = harness(board, [], {reaktionsspeicher, approverId: '@besitzer:matrix.example.com'});
  const r = await hook({cleanedBody: 'Bitte nur nach Feierabend.',}, {...OWNER, sessionKey: 'agent:main:matrix:default:direct:@besitzer:matrix.example.com'});
  assert.equal(r?.handled, true);
  assert.match(r.reply.text, /CHG-3702/);
  assert.deepEqual(board.aufrufe.kommentiert.at(-1), ['CHG-3702', 'Bitte nur nach Feierabend.']);
  assert.deepEqual(board.aufrufe.status, []);
});

test('der Vor-Filter ist WEIT — die enge Regel steht in entscheidung.mjs', () => {
  // Der Marker steht am ANFANG. „passt so" kommt durch, „das passt so" nicht — die
  // kurze Antwort ist der haeufige Fall, ein Satz darueber ist unklar. Wer den Filter
  // weiter macht, riskiert, dass er fuer jeden Satz das Board fragt.
  assert.equal(koennte_entscheidung_sein('passt so'), true);
  assert.equal(koennte_entscheidung_sein('das passt so'), false);
  assert.equal(koennte_entscheidung_sein('genau'), false);
});

test('der Vor-Filter laesst kein Geschwaetz durch', () => {
  for (const t of ['', '   ', 'erzaehl mir was', 'wie geht es dir']) {
    assert.equal(koennte_entscheidung_sein(t), false, `${t} sollte nicht durchkommen`);
  }
});

test('ein langer Aufsatz ist keine Entscheidung', () => {
  // Ein Absatz ueber Freigaben ist keine Freigabe.
  const lang = `${'x'.repeat(80)} genehmigt`;
  assert.equal(koennte_entscheidung_sein(lang), false);
});
