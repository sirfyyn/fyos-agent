import assert from 'node:assert/strict';
import test from 'node:test';
import {Readable} from 'node:stream';
import {
  erstelle_fanout_handler, matrix_text, normalisiere_anfrage, sende_matrix_anfrage, sende_telegram_nachricht,
  telegram_text, token_stimmt,
} from './fanout.mjs';
import {ReaktionsSpeicher} from './matrix-reaktionen.mjs';

test('Fanout formatiert Ticket, Details und die drei Antwortwege', () => {
  const text = matrix_text(normalisiere_anfrage({ticket: 'chg-42', titel: 'Push nach main', beschreibung: 'Commit abc', severity: 'high'}));
  assert.match(text, /CHG-42/);
  assert.match(text, /Commit abc/);
  assert.match(text, /✅/);
  assert.match(text, /➕/);
  assert.match(text, /genehmigt CHG-42/);
  assert.match(text, /abgelehnt CHG-42/);
});

test('Fanout zeigt bei Aktionsfreigaben nur den Entscheidungsbrief, nicht den technischen Anhang', () => {
  const beschreibung = [
    '<!-- fyos-aktionsfreigabe-sicht:v1 -->',
    '## Ausstehende Aktionsfreigabe',
    '- Wer: Agent',
    '- Was: `git.push`',
    '- Wo: `gitea`',
    '- Warum / Umfang: getesteten Patch pushen',
    '- Erwartete Wirkung: nur dieser Push.',
    '<!-- /fyos-aktionsfreigabe-sicht:v1 -->',
    '## Technischer Anhang',
    'git push origin main --force und Digest geheim',
  ].join('\n');
  const text = matrix_text(normalisiere_anfrage({ticket: 'CHG-42', titel: 'Push erlauben', beschreibung}));
  assert.match(text, /Wer: Agent/);
  assert.match(text, /Erwartete Wirkung/);
  assert.match(text, /Technische Details, Diff und Logs: Vorgang CHG-42/);
  assert.doesNotMatch(text, /--force/);
  assert.doesNotMatch(text, /Digest geheim/);
});

test('Fanout nimmt weder formlose noch fremde Kennungen an', () => {
  assert.throws(() => normalisiere_anfrage({ticket: 'anything', titel: 'x'}));
  assert.throws(() => normalisiere_anfrage({ticket: 'CHG-1', titel: ''}));
});

test('Relay-Token vergleicht fail-closed', () => {
  assert.equal(token_stimmt('gleich', 'gleich'), true);
  assert.equal(token_stimmt('gleich', 'anders'), false);
  assert.equal(token_stimmt('', ''), false);
});

test('Cleanroom-Relay liefert die Matrix-Sicht, ohne Node- oder Executorzugriff', async () => {
  const rufe = [];
  const handler = erstelle_fanout_handler({
    relayToken: 'relay', homeserver: 'http://matrix', accessToken: 'token', botUserId: '@agent:matrix', approverId: '@besitzer:matrix',
    // Wenn dieser Wert genutzt wuerde, waere die Scope-Grenze erneut umgangen.
    runtime: {nodes: {list: async () => { throw new Error('darf nicht aufgerufen werden'); }}},
    fetchImpl: async (url, init = {}) => {
      rufe.push({url, init});
      if (url.includes('account_data/m.direct')) return new Response(JSON.stringify({'@besitzer:matrix': ['!raum:matrix']}));
      return new Response(JSON.stringify({event_id: '$event'}));
    },
  });
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ticket: 'CHG-1', titel: 'x'}))]), {method: 'POST', headers: {'x-fyos-freigabe-relay': 'relay'}});
  const res = {statusCode: 0, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = value; }};
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {ok: true, ticket: 'CHG-1', room_id: '!raum:matrix', event_id: '$event'});
  assert.equal(rufe.length, 5, 'eine Matrix-Nachricht plus drei Reaktionen');
});

test('ungültige Relay-Nutzlast ist ein 400, kein Matrix-Zustellfehler', async () => {
  let fetches = 0;
  const handler = erstelle_fanout_handler({
    relayToken: 'relay', homeserver: 'http://matrix', accessToken: 'token', botUserId: '@agent:matrix', approverId: '@besitzer:matrix',
    fetchImpl: async () => { fetches += 1; throw new Error('darf nicht senden'); },
  });
  const req = Object.assign(Readable.from([Buffer.from('{}')]), {method: 'POST', headers: {'x-fyos-freigabe-relay': 'relay'}});
  const res = {statusCode: 0, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = value; }};
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(JSON.parse(res.body), {ok: false, error: 'ungueltige Freigabe-Nutzlast'});
  assert.equal(fetches, 0);
});

test('Beschluss folgt derselben Relay-Strecke, beendet die gespeicherte Matrix-Frage und sendet keine neuen Knöpfe', async () => {
  const rufe = [];
  const speicher = new ReaktionsSpeicher({jetzt: () => 10});
  await speicher.merke_prompt({eventId: '$frage', ticket: 'CHG-1', raum: '!raum:matrix'});
  const handler = erstelle_fanout_handler({
    relayToken: 'relay', homeserver: 'http://matrix', accessToken: 'token', botUserId: '@agent:matrix', approverId: '@besitzer:matrix',
    reaktionsspeicher: speicher,
    fetchImpl: async (url, init = {}) => {
      rufe.push({url, init});
      return new Response(JSON.stringify({event_id: '$beschluss'}));
    },
  });
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({event: 'aufgeloest', ticket: 'CHG-1', entscheidung: 'erteilt', ts: '2026-09-19T19:30:00Z'}))]), {method: 'POST', headers: {'x-fyos-freigabe-relay': 'relay'}});
  const res = {statusCode: 0, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = value; }};

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {ok: true, ticket: 'CHG-1', entscheidung: 'erteilt', raeume: 1});
  assert.equal(speicher.prompt('$frage'), null, 'eine späte Reaktion darf die entschiedene Frage nicht wieder öffnen');
  assert.equal(rufe.length, 1, 'nur eine Abschlussnachricht, keine drei Reaktions-Knöpfe');
  assert.match(JSON.parse(rufe[0].init.body).body, /Freigabe erteilt: CHG-1/);
});

test('bestehender Matrix-DM wird wiederverwendet und genau eine Nachricht gesendet', async () => {
  const rufe = [];
  const fetchImpl = async (url, init = {}) => {
    rufe.push({url, init});
    if (url.includes('account_data/m.direct')) return new Response(JSON.stringify({'@besitzer:matrix.example.com': ['!raum:matrix.example.com']}));
    return new Response(JSON.stringify({event_id: '$event'}));
  };
  const ergebnis = await sende_matrix_anfrage({ticket: 'CHG-1', titel: 'x', beschreibung: '', severity: '', ts: ''}, {
    homeserver: 'http://matrix', accessToken: 'geheim', botUserId: '@agent:matrix.example.com', approverId: '@besitzer:matrix.example.com', fetchImpl,
  });
  assert.deepEqual(ergebnis, {room_id: '!raum:matrix.example.com', event_id: '$event'});
  assert.equal(rufe.length, 5, 'Nachricht plus drei sichtbare Reaktions-Knoepfe');
  assert.match(rufe[1].url, /rooms\/!raum%3Amatrix\.example\.com\/send/);
  assert.equal(JSON.parse(rufe[2].init.body)['m.relates_to'].key, '✅');
  assert.equal(JSON.parse(rufe[4].init.body)['m.relates_to'].key, '➕');
});

// ── Telegram als zweiter Kanal ───────────────────────────────────────────────

const TOKEN = '123456:fake-token_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
const telegram_ok = (id = 9) => new Response(JSON.stringify({ok: true, result: {message_id: id}}));
const relay_anfrage = (nutzlast) => Object.assign(
  Readable.from([Buffer.from(JSON.stringify(nutzlast))]), {method: 'POST', headers: {'x-fyos-freigabe-relay': 'relay'}});
const antwort_attrappe = () => ({
  statusCode: 0, headers: {}, body: '',
  setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = value; },
});
const matrix_optionen = {homeserver: 'http://matrix', accessToken: 'geheim', botUserId: '@agent:matrix', approverId: '@besitzer:matrix'};
const telegram_optionen = {telegramToken: TOKEN, telegramChatId: '424242424'};
/** Antwortet je nach Ziel wie Telegram oder Matrix; `ausfall` laesst einen Kanal scheitern. */
const kanal_attrappe = (rufe, ausfall = []) => async (url, init = {}) => {
  rufe.push({url, init});
  if (url.includes('api.telegram.org')) {
    if (ausfall.includes('telegram')) return new Response(JSON.stringify({ok: false, description: 'Forbidden: bot was blocked'}), {status: 403});
    return telegram_ok();
  }
  if (ausfall.includes('matrix')) return new Response('kaputt', {status: 500});
  if (url.includes('account_data/m.direct')) return new Response(JSON.stringify({'@besitzer:matrix': ['!raum:matrix']}));
  return new Response(JSON.stringify({event_id: '$event'}));
};

test('Telegram-Text nennt Ticket, Details und die Textantworten, aber keine Matrix-Knöpfe', () => {
  const text = telegram_text(normalisiere_anfrage({ticket: 'chg-42', titel: 'Push nach main', beschreibung: 'Commit abc', severity: 'high'}));
  assert.match(text, /Freigabe angefragt: CHG-42 · Dringlichkeit: high/);
  assert.match(text, /Commit abc/);
  assert.match(text, /genehmigt CHG-42 · abgelehnt CHG-42 · kommentar CHG-42/);
  assert.doesNotMatch(text, /✅|❌|➕|Reagiere/);
  assert.doesNotMatch(text, /`/, 'reiner Text, keine Formatierung');
});

test('Telegram zeigt bei Aktionsfreigaben nur den Entscheidungsbrief, nicht den technischen Anhang', () => {
  const beschreibung = [
    '<!-- fyos-aktionsfreigabe-sicht:v1 -->', '- Was: `git.push`', '- Erwartete Wirkung: nur dieser Push.',
    '<!-- /fyos-aktionsfreigabe-sicht:v1 -->', '## Technischer Anhang', 'git push origin main --force',
  ].join('\n');
  const text = telegram_text(normalisiere_anfrage({ticket: 'CHG-42', titel: 'Push erlauben', beschreibung}));
  assert.match(text, /Erwartete Wirkung/);
  assert.doesNotMatch(text, /--force/);
});

test('Telegram: eine Textnachricht an die Direktnachricht des Besitzers, das Token nur im Pfad der Adresse', async () => {
  const rufe = [];
  const ergebnis = await sende_telegram_nachricht('Hallo', {
    ...telegram_optionen, fetchImpl: async (url, init) => { rufe.push({url, init}); return telegram_ok(7); },
  });
  assert.deepEqual(ergebnis, {message_id: 7});
  assert.equal(rufe.length, 1);
  assert.equal(rufe[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(rufe[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(rufe[0].init.body), {chat_id: 424242424, text: 'Hallo', disable_web_page_preview: true});
  assert.ok(!rufe[0].init.body.includes(TOKEN));
});

test('Telegram kürzt zu lange Nachrichten unter das Limit der Bot-API', async () => {
  let gesendet = '';
  await sende_telegram_nachricht('x'.repeat(9000), {
    ...telegram_optionen, fetchImpl: async (_url, init) => { gesendet = JSON.parse(init.body).text; return telegram_ok(); },
  });
  assert.equal(gesendet.length, 4000);
});

test('Telegram: Fehlermeldungen nennen nie das Token', async () => {
  const abgelehnt = sende_telegram_nachricht('x', {
    ...telegram_optionen,
    fetchImpl: async () => new Response(JSON.stringify({ok: false, description: "Forbidden: bot can't initiate conversation with a user"}), {status: 403}),
  });
  await assert.rejects(abgelehnt, (fehler) => {
    assert.match(fehler.message, /Telegram HTTP 403: Forbidden/);
    assert.ok(!fehler.message.includes(TOKEN));
    return true;
  });
  // Ein Netz- oder Adressfehler kann die ganze Adresse im Text tragen, und die enthaelt das Token.
  const url_fehler = sende_telegram_nachricht('x', {
    ...telegram_optionen, fetchImpl: async (url) => { throw new TypeError(`Failed to parse URL from ${url}`); },
  });
  await assert.rejects(url_fehler, (fehler) => {
    assert.ok(!fehler.message.includes(TOKEN));
    assert.match(fehler.message, /\*\*\*/);
    return true;
  });
});

test('Telegram: unvollständige oder falsche Konfiguration stellt nichts zu', async () => {
  let fetches = 0;
  const fetchImpl = async () => { fetches += 1; return telegram_ok(); };
  await assert.rejects(sende_telegram_nachricht('x', {telegramToken: TOKEN, fetchImpl}), /unvollstaendig/);
  await assert.rejects(sende_telegram_nachricht('x', {telegramChatId: '424242424', fetchImpl}), /unvollstaendig/);
  await assert.rejects(sende_telegram_nachricht('x', {...telegram_optionen, telegramChatId: '-1001234567890', fetchImpl}), /keine Nutzer-ID/);
  await assert.rejects(sende_telegram_nachricht('x', {...telegram_optionen, telegramChatId: '@besitzer', fetchImpl}), /keine Nutzer-ID/);
  assert.equal(fetches, 0);
});

test('Relay nur mit Telegram: eine Textnachricht an Telegram, Matrix bleibt unberührt', async () => {
  const rufe = [];
  const handler = erstelle_fanout_handler({relayToken: 'relay', ...telegram_optionen, fetchImpl: kanal_attrappe(rufe)});
  const res = antwort_attrappe();
  await handler(relay_anfrage({ticket: 'CHG-1', titel: 'x'}), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {ok: true, ticket: 'CHG-1', telegram: {message_id: 9}});
  assert.equal(rufe.length, 1);
  assert.match(JSON.parse(rufe[0].init.body).text, /genehmigt CHG-1/);
});

test('Relay mit Matrix und Telegram stellt in beiden Kanälen zu und verbindet die Antwort', async () => {
  const rufe = [];
  const speicher = new ReaktionsSpeicher({jetzt: () => 10});
  const handler = erstelle_fanout_handler({
    relayToken: 'relay', ...matrix_optionen, ...telegram_optionen, reaktionsspeicher: speicher, fetchImpl: kanal_attrappe(rufe),
  });
  const res = antwort_attrappe();
  await handler(relay_anfrage({ticket: 'CHG-1', titel: 'x'}), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {ok: true, ticket: 'CHG-1', room_id: '!raum:matrix', event_id: '$event', telegram: {message_id: 9}});
  assert.equal(rufe.filter((r) => r.url.includes('api.telegram.org')).length, 1);
  assert.equal(rufe.filter((r) => !r.url.includes('api.telegram.org')).length, 5, 'Matrix wie bisher: Nachricht plus drei Reaktionen');
  assert.equal(speicher.prompt('$event')?.ticket, 'CHG-1', 'die Matrix-Frage bleibt für die Reaktionen gemerkt');
});

test('Relay: scheitert ein Kanal, genügt der andere; das Token landet nie im Log', async () => {
  for (const [ausfall, vorhanden, fehlt] of [['matrix', 'telegram', 'event_id'], ['telegram', 'event_id', 'telegram']]) {
    const logs = [];
    const handler = erstelle_fanout_handler({
      relayToken: 'relay', ...matrix_optionen, ...telegram_optionen,
      logger: {warn: (zeile) => logs.push(zeile)}, fetchImpl: kanal_attrappe([], [ausfall]),
    });
    const res = antwort_attrappe();
    await handler(relay_anfrage({ticket: 'CHG-1', titel: 'x'}), res);
    assert.equal(res.statusCode, 200, `${ausfall} faellt aus, der andere Kanal stellt zu`);
    assert.ok(vorhanden in JSON.parse(res.body));
    assert.ok(!(fehlt in JSON.parse(res.body)));
    assert.equal(logs.length, 1);
    assert.match(logs[0], new RegExp(`\\(${ausfall}\\)`));
    assert.ok(!logs.join('\n').includes(TOKEN));
  }
});

test('Relay: scheitern beide Kanäle, ist es ein 502', async () => {
  const logs = [];
  const handler = erstelle_fanout_handler({
    relayToken: 'relay', ...matrix_optionen, ...telegram_optionen,
    logger: {warn: (zeile) => logs.push(zeile)}, fetchImpl: kanal_attrappe([], ['matrix', 'telegram']),
  });
  const res = antwort_attrappe();
  await handler(relay_anfrage({ticket: 'CHG-1', titel: 'x'}), res);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(JSON.parse(res.body), {ok: false, error: 'Fanout nicht zugestellt'});
  assert.equal(logs.length, 2);
});

test('Relay ohne jeden Kanal bleibt der bisherige Fehler (502), auch nur mit Telegram-Token ohne Besitzer', async () => {
  let fetches = 0;
  const fetchImpl = async () => { fetches += 1; return telegram_ok(); };
  for (const optionen of [{}, {telegramToken: TOKEN}]) {
    const handler = erstelle_fanout_handler({relayToken: 'relay', ...optionen, fetchImpl});
    const res = antwort_attrappe();
    await handler(relay_anfrage({ticket: 'CHG-1', titel: 'x'}), res);
    assert.equal(res.statusCode, 502);
  }
  assert.equal(fetches, 0);
});

test('Beschluss geht auch an Telegram, ohne Knöpfe und ohne Matrix-Raum', async () => {
  const rufe = [];
  const handler = erstelle_fanout_handler({relayToken: 'relay', ...telegram_optionen, fetchImpl: kanal_attrappe(rufe)});
  const res = antwort_attrappe();
  await handler(relay_anfrage({event: 'aufgeloest', ticket: 'CHG-1', entscheidung: 'abgelehnt', ts: '2026-09-19T19:30:00Z'}), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {ok: true, ticket: 'CHG-1', entscheidung: 'abgelehnt', telegram: {message_id: 9}});
  assert.equal(rufe.length, 1);
  assert.match(JSON.parse(rufe[0].init.body).text, /Freigabe abgelehnt: CHG-1/);
});

test('Beschluss mit Matrix und Telegram: beide Kanäle, die gemerkte Matrix-Frage wird beendet', async () => {
  const rufe = [];
  const speicher = new ReaktionsSpeicher({jetzt: () => 10});
  await speicher.merke_prompt({eventId: '$frage', ticket: 'CHG-1', raum: '!raum:matrix'});
  const handler = erstelle_fanout_handler({
    relayToken: 'relay', ...matrix_optionen, ...telegram_optionen, reaktionsspeicher: speicher, fetchImpl: kanal_attrappe(rufe),
  });
  const res = antwort_attrappe();
  await handler(relay_anfrage({event: 'aufgeloest', ticket: 'CHG-1', entscheidung: 'erteilt', ts: ''}), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {ok: true, ticket: 'CHG-1', entscheidung: 'erteilt', raeume: 1, telegram: {message_id: 9}});
  assert.equal(speicher.prompt('$frage'), null);
  assert.equal(rufe.length, 2);
});
