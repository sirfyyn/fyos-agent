/**
 * Die Brücke zwischen Gateway und Hub.
 *
 * Bewacht wird die Wirkung: Inhalte verlassen das Gateway nie, die Signatur passt Byte für Byte zur Prüfung im Hub,
 * der Hub erreicht nur die Methoden der festen Liste, und ein stiller oder kaputter Hub stört das Gateway nicht.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {
  EIGENE, ERLAUBT, RPC_PFAD, VORGABEN, agentAusSchluessel, agentKennung, cronEreignis, erzeugeLaeufe, erzeugeRpcHandler,
  erzeugeSender, erzeugeWarteschlange, erzeugeWerkzeuge, fehlerText, huellenZiel, hubZiel, idTeil, kanalMitteilen,
  kanalStand, leseSkill, modellEreignis, registerBruecke, signatur, sitzungsEreignis, sitzungsHash, skillEreignis,
  vorgangAusSchluessel, vorgangSenden, vorgangsSchluessel, vorschlagEreignis, wecken, werkzeugEreignis,
} from './bruecke.mjs';

const uhr = () => 1_700_000_000_000;

// ── Signatur ────────────────────────────────────────────────────────────────────────────────

test('die Signatur gleicht der Prüfung im Hub (mcp_hub.plugins.openclaw.signatur)', () => {
  // Sollwert aus Python: signatur('geheim-test', '1700000000000', '{"ereignisse":[],"ü":1}'.encode())
  assert.equal(signatur('geheim-test', '1700000000000', '{"ereignisse":[],"ü":1}'),
               'sha256=173d8aef249da415cc074a03bd5378cfcd0e5db9cee058b3560a250bbd317b0c');
});

// ── Ereignisse ──────────────────────────────────────────────────────────────────────────────

test('ein Werkzeugaufruf wird zu Name, Dauer und Ergebnis, ohne Argumente und Ergebnis', () => {
  const e = werkzeugEreignis(
    {toolName: 'web_fetch', params: {url: 'GEHEIM-ARG'}, result: 'GEHEIM-ERGEBNIS', durationMs: 41.6, toolCallId: 't1'},
    {agentId: 'main', sessionKey: 'agent:main:matrix:raum', channelId: 'matrix'},
    {uhr},
  );
  assert.deepEqual(e, {art: 'werkzeug', zeit: uhr(), werkzeug: 'web_fetch', ok: true, dauer_ms: 42, fehler: undefined,
                       agent: 'main', sitzung: sitzungsHash('agent:main:matrix:raum'), vorgang: undefined,
                       kanal: 'matrix'});
  assert.ok(!JSON.stringify(e).includes('GEHEIM'));
  assert.ok(!JSON.stringify(e).includes('raum'), 'Sitzungsschlüssel nur gehasht');
  assert.equal(e.sitzung.length, 12);
});

test('ein gescheiterter Aufruf trägt nur Code und erste Zeile des Fehlers', () => {
  const e = werkzeugEreignis({toolName: 'read', error: {code: 'ENOENT', message: 'Datei fehlt\nZweite Zeile mit Inhalt'}},
                             {sessionKey: 'agent:main:main'}, {uhr});
  assert.equal(e.ok, false);
  assert.equal(e.fehler, 'ENOENT: Datei fehlt');
  assert.equal(e.agent, 'main', 'Agent aus dem Sitzungsschlüssel');
  assert.equal(fehlerText('a'.repeat(500)).length, 120);
});

test('Hub-Werkzeuge meldet die Brücke nicht (der Hub protokolliert sie selbst)', () => {
  assert.equal(werkzeugEreignis({toolName: 'hub__hub__call_tool'}, {}, {uhr}), null);
  assert.equal(werkzeugEreignis({toolName: 'mcp__hub__x'}, {}, {uhr}), null);
  assert.equal(werkzeugEreignis({}, {}, {uhr}), null);
  assert.ok(werkzeugEreignis({toolName: 'hubx'}, {}, {uhr}));
  assert.ok(werkzeugEreignis({toolName: 'hub__x'}, {}, {uhr, auslassen: []}));
});

// OpenClaw meldet bei der Hülle tool_call zuerst den inneren Aufruf, dann die Hülle (embedded runner, tool-search).
const innen = (name, huelle, n = 1) => ({toolName: name, toolCallId: `tool_call:${huelle}:${name}:${n}`, durationMs: 5});
const huelle = (id, ziel, mehr = {}) => ({toolName: 'tool_call', toolCallId: id, params: {id: ziel, args: {q: 'GEHEIM'}},
                                          durationMs: 9, ...mehr});

test('ein Werkzeug hinter der Hülle tool_call zählt einmal, unter seinem echten Namen', () => {
  const w = erzeugeWerkzeuge({uhr});
  const e = w.verarbeite(innen('wetter__vorhersage', 'call_1'), {agentId: 'main'});
  assert.equal(e.werkzeug, 'wetter__vorhersage');
  assert.equal(e.dauer_ms, 5);
  assert.equal(w.verarbeite(huelle('call_1', 'mcp:wetter:wetter__vorhersage'), {agentId: 'main'}), null, 'Hülle zählt nicht');
  // Hub-Werkzeug hinter der Hülle: der innere ist ausgelassen, die Hülle zählt trotzdem nicht.
  assert.equal(w.verarbeite(innen('hub__hub__health', 'call_2', 2), {}), null);
  assert.equal(w.verarbeite(huelle('call_2', 'mcp:hub:hub__hub__health'), {}), null);
  // Aufruf-IDs mit Zeichen, die OpenClaw bereinigt.
  assert.equal(idTeil('call_x|fc_y'), 'call_x_fc_y');
  assert.equal(idTeil('  '), 'call');
  assert.ok(w.verarbeite(innen('read', idTeil('call_x|fc_y'), 3), {}));
  assert.equal(w.verarbeite(huelle('call_x|fc_y', 'read'), {}), null);
});

test('ohne inneren Aufruf zählt die Hülle unter dem Namen aus params.id, nie mit Argumenten', () => {
  const w = erzeugeWerkzeuge({uhr});
  const e = w.verarbeite(huelle('call_3', 'mcp:wetter:wetter__vorhersage', {error: 'kaputt'}), {});
  assert.equal(e.werkzeug, 'wetter__vorhersage');
  assert.equal(e.ok, false);
  assert.equal(e.dauer_ms, 9);
  assert.ok(!JSON.stringify(e).includes('GEHEIM'));
  assert.equal(w.verarbeite(huelle('call_4', 'web_fetch'), {}).werkzeug, 'web_fetch', 'Name statt Katalog-ID');
  assert.equal(w.verarbeite(huelle('call_5', 'mcp:hub:hub__hub__health'), {}), null, 'Ziel ausgelassen');
  assert.equal(w.verarbeite({toolName: 'tool_call', toolCallId: 'call_6'}, {}).werkzeug, 'tool_call', 'ohne Ziel');
  // Kommt der innere erst nach der Hülle, zählt er nicht noch einmal.
  assert.equal(w.verarbeite(innen('wetter__vorhersage', 'call_3', 7), {}), null);
  assert.equal(huellenZiel({id: 'openclaw:core:exec'}), 'exec');
  assert.equal(huellenZiel({id: 'mcp::x'}), 'x');
  assert.equal(huellenZiel(null), '');
});

test('die Brücke merkt sich nur begrenzt viele Aufrufe', () => {
  const w = erzeugeWerkzeuge({uhr, max: 2});
  for (const n of [1, 2, 3]) w.verarbeite(innen('read', `c${n}`, n), {});
  assert.ok(w.verarbeite(huelle('c1', 'read'), {}), 'vergessen: die Hülle zählt wieder');
  assert.equal(w.verarbeite(huelle('c3', 'read'), {}), null);
});

test('Modell, Sitzung, Cron und Skills werden knapp übersetzt', () => {
  const m = modellEreignis({provider: 'modell', model: 'klein', outcome: 'error', durationMs: 900, errorCategory: 'timeout',
                            sessionKey: 'agent:main:main'}, {}, {uhr});
  assert.equal(m.ergebnis, 'error');
  assert.equal(m.fehlerart, 'timeout');
  assert.equal(m.anbieter, 'modell');
  assert.equal(modellEreignis({outcome: 'completed'}, {modelProviderId: 'p', modelId: 'm'}, {uhr}).modell, 'm');

  const beginn = sitzungsEreignis('beginn', {sessionKey: 'agent:main:main', resumedFrom: 'alt'}, {agentId: 'main'}, {uhr});
  assert.equal(beginn.phase, 'beginn');
  assert.equal(beginn.grund, 'fortgesetzt');
  const ende = sitzungsEreignis('ende', {sessionKey: 'agent:main:main', reason: 'idle', durationMs: 5000,
                                         messageCount: 12, sessionFile: '/pfad/geheim.jsonl'}, {}, {uhr});
  assert.equal(ende.grund, 'idle');
  assert.equal(ende.dauer_ms, 5000);
  assert.ok(!JSON.stringify(ende).includes('geheim'));

  const c = cronEreignis({action: 'finished', jobId: 'j1', job: {id: 'j1', name: 'Tagesstand', payload: {text: 'GEHEIM'}},
                          status: 'ok', durationMs: 1200, nextRunAtMs: 1_700_000_060_000, summary: 'GEHEIM'}, {uhr});
  assert.equal(c.name, 'Tagesstand');
  assert.equal(c.status, 'ok');
  assert.equal(c.naechster_ms, 1_700_000_060_000);
  assert.ok(!JSON.stringify(c).includes('GEHEIM'));

  assert.deepEqual(skillEreignis({action: 'updated', source: 'workspace', after: {name: 'wetter', skillFile: '/x'}}, {uhr}),
                   {art: 'skill', zeit: uhr(), aktion: 'updated', name: 'wetter', quelle: 'workspace'});
  assert.equal(vorschlagEreignis({action: 'created', proposal: {skillName: 'neu', status: 'pending'}}, {uhr}).name, 'neu');
});

test('Läufe: Start merken, beim ersten Ende melden, doppelte Enden zählen nicht', () => {
  let jetzt = 1000;
  const laeufe = erzeugeLaeufe({uhr: () => jetzt});
  assert.equal(laeufe.verarbeite({stream: 'lifecycle', runId: 'r1', sessionKey: 'agent:main:main', data: {phase: 'start'}}), null);
  jetzt = 3500;
  const ende = laeufe.verarbeite({stream: 'lifecycle', runId: 'r1', sessionKey: 'agent:main:main', data: {phase: 'end'}});
  assert.equal(ende.ok, true);
  assert.equal(ende.dauer_ms, 2500);
  assert.equal(ende.agent, 'main');
  assert.equal(laeufe.verarbeite({stream: 'lifecycle', runId: 'r1', data: {phase: 'error'}}), null);
  const fehler = laeufe.verarbeite({stream: 'lifecycle', runId: 'r2', data: {phase: 'error', error: 'timeout'}});
  assert.equal(fehler.ok, false);
  assert.equal(fehler.fehler, 'timeout');
  assert.equal(fehler.dauer_ms, undefined);
  assert.equal(laeufe.verarbeite({stream: 'assistant', runId: 'r3', data: {phase: 'end'}}), null);
  assert.equal(laeufe.offen, 0);
});

test('agentAusSchluessel liest nur die Form agent:<id>:…', () => {
  assert.equal(agentAusSchluessel('agent:main:matrix:x'), 'main');
  assert.equal(agentAusSchluessel('global'), '');
  assert.equal(agentAusSchluessel(undefined), '');
});

// ── Warteschlange und Lieferung ─────────────────────────────────────────────────────────────

test('volle Warteschlange: das älteste fällt heraus und wird gezählt', () => {
  const w = erzeugeWarteschlange(3);
  for (const n of [1, 2, 3, 4, 5]) w.rein({n});
  assert.equal(w.laenge, 3);
  assert.equal(w.verworfen, 2);
  const teil = w.nimm(2);
  assert.deepEqual(teil.map((e) => e.n), [3, 4]);
  w.rein({n: 6});
  w.rein({n: 7});
  w.zurueck(teil);
  assert.deepEqual(w.nimm(10).map((e) => e.n), [5, 6, 7]);
  assert.equal(w.verworfen, 4);
});

function fetchAttrappe(antworten = []) {
  const aufrufe = [];
  const fn = async (url, init) => {
    aufrufe.push({url, init});
    const status = antworten.length ? antworten.shift() : 200;
    if (status === 'netz') throw new Error('ECONNREFUSED');
    return {ok: status >= 200 && status < 300, status, text: async () => '{}'};
  };
  fn.aufrufe = aufrufe;
  return fn;
}

test('der Sender bündelt, signiert und meldet sich ohne Ereignisse als Lebenszeichen', async () => {
  let jetzt = 1_700_000_000_000;
  const w = erzeugeWarteschlange(100);
  const fetchImpl = fetchAttrappe();
  const sender = erzeugeSender({ziel: 'http://hub:8080/hub/openclaw/ereignisse', token: 'geheim-test', warteschlange: w,
                                kopf: () => ({version: 't'}), fetchImpl, uhr: () => jetzt, paketMax: 2,
                                lebenszeichenMs: 60000});
  for (const n of [1, 2, 3]) w.rein({art: 'hinweis', n});
  assert.equal(await sender.senden(), 'gesendet');
  const {url, init} = fetchImpl.aufrufe[0];
  assert.equal(url, 'http://hub:8080/hub/openclaw/ereignisse');
  assert.equal(init.headers['X-FYOS-Zeit'], String(jetzt));
  assert.equal(init.headers['X-FYOS-Signatur'], signatur('geheim-test', String(jetzt), init.body));
  assert.ok(!init.body.includes('geheim-test'), 'das Token geht nie hinaus');
  assert.deepEqual(JSON.parse(init.body).ereignisse.map((e) => e.n), [1, 2]);
  assert.equal(w.laenge, 1);
  assert.equal(await sender.senden(), 'gesendet');
  assert.equal(await sender.senden(), 'nichts', 'leer und gerade gemeldet');
  jetzt += 60000;
  assert.equal(await sender.senden(), 'gesendet', 'Lebenszeichen');
  assert.deepEqual(JSON.parse(fetchImpl.aufrufe[2].init.body).ereignisse, []);
  assert.equal(sender.stand.gesendet, 3);
});

test('Hub weg: Paket bleibt, Pause wächst; Hub lehnt ab: Paket fällt weg und wird gezählt', async () => {
  let jetzt = 0;
  const w = erzeugeWarteschlange(100);
  const fetchImpl = fetchAttrappe(['netz', 503, 401]);
  const sender = erzeugeSender({ziel: 'http://hub/hub/openclaw/ereignisse', token: '', warteschlange: w, kopf: () => ({}),
                                fetchImpl, uhr: () => jetzt});
  w.rein({art: 'hinweis'});
  assert.equal(await sender.senden(), 'fehler');
  assert.equal(w.laenge, 1, 'zurückgelegt');
  assert.equal(await sender.senden(), 'warten');
  jetzt += 2000;
  assert.equal(await sender.senden(), 'fehler');
  assert.equal(sender.stand.naechsterVersuch, jetzt + 4000, 'Pause verdoppelt');
  assert.equal(fetchImpl.aufrufe[1].init.headers['X-FYOS-Signatur'], undefined, 'ohne Token unsigniert');
  jetzt += 4000;
  assert.equal(await sender.senden(), 'fehler');
  assert.equal(w.laenge, 0, '401: verworfen');
  assert.equal(w.verworfen, 1);
  assert.equal(sender.stand.folge, 3);
});

test('nie zwei Lieferungen gleichzeitig', async () => {
  const w = erzeugeWarteschlange(10);
  let offen = 0;
  let hoechstens = 0;
  const fetchImpl = async () => {
    offen += 1;
    hoechstens = Math.max(hoechstens, offen);
    await new Promise((fertig) => setTimeout(fertig, 5));
    offen -= 1;
    return {ok: true, status: 200, text: async () => ''};
  };
  const sender = erzeugeSender({ziel: 'http://hub/x', warteschlange: w, kopf: () => ({}), fetchImpl});
  w.rein({art: 'hinweis'});
  await Promise.all([sender.senden(), sender.senden(), sender.senden()]);
  assert.equal(hoechstens, 1);
});

test('hubZiel: hubUrl gewinnt, sonst FYOS_HUB_URL ohne /mcp', () => {
  assert.equal(hubZiel({}, {FYOS_HUB_URL: 'http://hub:8080/mcp'}), 'http://hub:8080/hub/openclaw/ereignisse');
  assert.equal(hubZiel({}, {FYOS_HUB_URL: 'http://hub:8080/mcp/'}), 'http://hub:8080/hub/openclaw/ereignisse');
  assert.equal(hubZiel({}, {FYOS_HUB_URL: 'https://fyos.example.com/innen/mcp'}),
               'https://fyos.example.com/innen/hub/openclaw/ereignisse');
  assert.equal(hubZiel({hubUrl: 'http://anders:9000/'}, {FYOS_HUB_URL: 'http://hub:8080/mcp'}),
               'http://anders:9000/hub/openclaw/ereignisse');
  assert.equal(hubZiel({}, {}), '');
  assert.equal(hubZiel({hubUrl: 'ftp://x'}, {}), '');
  assert.equal(hubZiel({hubUrl: 'kein url'}, {}), '');
});

// ── Abfragen vom Hub ────────────────────────────────────────────────────────────────────────

function anfrage(methode, koerper) {
  const daten = koerper === undefined ? [] : [Buffer.from(typeof koerper === 'string' ? koerper : JSON.stringify(koerper))];
  return {method: methode, async *[Symbol.asyncIterator]() { yield* daten; }};
}

function antwortAttrappe() {
  return {
    statusCode: 0, koepfe: {}, text: '',
    setHeader(k, v) { this.koepfe[k.toLowerCase()] = v; },
    end(text) { this.text = text; },
    get json() { return JSON.parse(this.text); },
  };
}

function dispatchAttrappe(antworten = {}) {
  const aufrufe = [];
  const fn = async (methode, params) => {
    aufrufe.push({methode, params});
    if (methode in antworten) return antworten[methode];
    return {ok: true, payload: {methode}};
  };
  fn.aufrufe = aufrufe;
  return fn;
}

test('die Route reicht nur Methoden der Liste weiter und prüft die Anmeldung vorher nach', async () => {
  const dispatch = dispatchAttrappe();
  let geprueft = 0;
  const handler = erzeugeRpcHandler({dispatch, revalidate: async () => { geprueft += 1; }, status: () => ({ok: 1})});
  const res = antwortAttrappe();
  assert.equal(await handler(anfrage('POST', {id: 'a1', method: 'workboard.cards.list', params: {boardId: 'fyos'}}), res), true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json, {id: 'a1', ok: true, payload: {methode: 'workboard.cards.list'}});
  assert.deepEqual(dispatch.aufrufe, [{methode: 'workboard.cards.list', params: {boardId: 'fyos'}}]);
  assert.equal(geprueft, 1);
  assert.equal(res.koepfe['cache-control'], 'no-store');

  for (const verboten of ['cron.add', 'config.set', 'sessions.send', 'workboard.cards.dispatch', 'agent', 'exec']) {
    const r = antwortAttrappe();
    await handler(anfrage('POST', {method: verboten}), r);
    assert.equal(r.statusCode, 403, verboten);
    assert.equal(r.json.error.code, 'FORBIDDEN');
  }
  assert.equal(dispatch.aufrufe.length, 1, 'nichts Verbotenes erreicht das Gateway');
});

test('die Route lehnt falsche Anfragen ab', async () => {
  const handler = erzeugeRpcHandler({dispatch: dispatchAttrappe(), status: () => ({})});
  const get = antwortAttrappe();
  await handler(anfrage('GET'), get);
  assert.equal(get.statusCode, 405);
  assert.equal(get.koepfe.allow, 'POST');
  const kaputt = antwortAttrappe();
  await handler(anfrage('POST', '{nicht json'), kaputt);
  assert.equal(kaputt.statusCode, 400);
  const ohne = antwortAttrappe();
  await handler(anfrage('POST', {params: {}}), ohne);
  assert.equal(ohne.statusCode, 400);
  const gross = antwortAttrappe();
  await handler(anfrage('POST', {method: 'health', params: {x: 'y'.repeat(70 * 1024)}}), gross);
  assert.equal(gross.statusCode, 413);
});

test('Fehler des Gateways kommen mit passendem HTTP-Status zurück (Konflikt = 409)', async () => {
  const dispatch = dispatchAttrappe({
    'workboard.cards.move': {ok: false, error: {code: 'INVALID_REQUEST', message: 'workboard_conflict: card changed'}},
    'workboard.cards.update': {ok: false, error: {code: 'workboard_conflict', message: 'stale'}},
    'cron.list': {ok: false, error: {code: 'UNAVAILABLE', message: 'cron aus'}},
    health: undefined,
  });
  const handler = erzeugeRpcHandler({dispatch, status: () => ({})});
  const faelle = [['workboard.cards.move', 409], ['workboard.cards.update', 409], ['cron.list', 503], ['health', 503]];
  for (const [methode, soll] of faelle) {
    const r = antwortAttrappe();
    await handler(anfrage('POST', {method: methode}), r);
    assert.equal(r.statusCode, soll, methode);
    assert.equal(r.json.ok, false);
  }
  const wirft = erzeugeRpcHandler({dispatch: async () => { throw new Error('kaputt'); }, status: () => ({})});
  const r = antwortAttrappe();
  await wirft(anfrage('POST', {method: 'usage.cost'}), r);
  assert.equal(r.statusCode, 503);
});

test('fyos.skill.lesen liest nur Dateien, die OpenClaw als Skill listet', async () => {
  const dispatch = dispatchAttrappe({'skills.status': {ok: true, payload: {skills: [
    {name: 'wetter', filePath: '/skills/wetter/SKILL.md', source: 'workspace'},
  ]}}});
  const gelesen = [];
  const lesen = async (pfad) => { gelesen.push(pfad); return '# Wetter'; };
  const groesse = async () => ({size: 10});
  assert.deepEqual(await leseSkill('wetter', dispatch, {lesen, groesse}), {name: 'wetter', text: '# Wetter', quelle: 'workspace'});
  await assert.rejects(leseSkill('../../etc/passwd', dispatch, {lesen, groesse}), {status: 400});
  await assert.rejects(leseSkill('fehlt', dispatch, {lesen, groesse}), {status: 404});
  await assert.rejects(leseSkill('wetter', dispatch, {lesen, groesse: async () => ({size: 10 * 1024 * 1024})}), {status: 413});
  assert.deepEqual(gelesen, ['/skills/wetter/SKILL.md']);

  const handler = erzeugeRpcHandler({dispatch, status: () => ({}), skillLesen: (name) => leseSkill(name, dispatch, {lesen, groesse})});
  const r = antwortAttrappe();
  await handler(anfrage('POST', {method: 'fyos.skill.lesen', params: {name: 'fehlt'}}), r);
  assert.equal(r.statusCode, 404);
  assert.equal(r.json.error.code, 'NOT_FOUND');
});

test('die Liste enthält nur Lesen und Workboard-Pflege, keine Steuerung des Agenten', () => {
  for (const m of ERLAUBT) {
    assert.ok(/^(workboard\.(boards\.(list|upsert)|cards\.(list|create|update|move|comment|archive))|skills\.status|cron\.(list|runs|status)|usage\.(cost|status)|health|memory\.search|sessions\.(list|describe)|last-heartbeat|progressCard\.get|tools\.effective|doctor\.memory\.status|agents\.list|voicewake\.routing\.get|tts\.status)$/.test(m), m);
  }
  assert.deepEqual([...EIGENE].sort(), ['fyos.bruecke.status', 'fyos.kanal.mitteilen', 'fyos.skill.lesen',
                                        'fyos.vorgang.senden', 'fyos.wecken']);
});

test('die lesenden Methoden gehen durch die Route, Schreibendes bleibt zu', async () => {
  const dispatch = dispatchAttrappe();
  const handler = erzeugeRpcHandler({dispatch, status: () => ({})});
  for (const m of ['memory.search', 'sessions.list', 'sessions.describe', 'last-heartbeat', 'progressCard.get',
                   'tools.effective', 'doctor.memory.status', 'agents.list', 'voicewake.routing.get', 'tts.status']) {
    const r = antwortAttrappe();
    await handler(anfrage('POST', {method: m, params: {}}), r);
    assert.equal(r.statusCode, 200, m);
  }
  for (const verboten of ['sessions.delete', 'sessions.patch', 'chat.send', 'wake', 'progressCard.put', 'tts.enable',
                          'agents.create', 'doctor.memory.resetDreamDiary']) {
    const r = antwortAttrappe();
    await handler(anfrage('POST', {method: verboten, params: {}}), r);
    assert.equal(r.statusCode, 403, verboten);
  }
  assert.equal(dispatch.aufrufe.length, 10);
});

// ── Wecken und Vorgangssitzungen ────────────────────────────────────────────────────────────

test('agentKennung: Aufruf vor Konfiguration vor FYOS_AGENT vor main, ungültig wird abgelehnt', () => {
  assert.equal(agentKennung('', '', {}), 'main');
  assert.equal(agentKennung('', '', {FYOS_AGENT: 'wache'}), 'wache');
  assert.equal(agentKennung('', 'stand', {FYOS_AGENT: 'wache'}), 'stand');
  assert.equal(agentKennung('direkt', 'stand', {FYOS_AGENT: 'wache'}), 'direkt');
  assert.throws(() => agentKennung('a:b', '', {}), {status: 400});
  assert.throws(() => agentKennung('../x', '', {}), {status: 400});
});

test('Sitzungsschlüssel eines Vorgangs und seine Umkehrung', () => {
  assert.equal(vorgangsSchluessel('inc-1234', 'wache'), 'agent:wache:vorgang:INC-1234');
  assert.throws(() => vorgangsSchluessel('keine nummer', 'wache'), {status: 400});
  assert.throws(() => vorgangsSchluessel('', 'wache'), {status: 400});
  assert.deepEqual(vorgangAusSchluessel('agent:wache:vorgang:INC-1234'), {agent: 'wache', vorgang: 'INC-1234'});
  assert.deepEqual(vorgangAusSchluessel('agent:wache:vorgang:inc-1234'), {agent: 'wache', vorgang: 'INC-1234'});
  assert.equal(vorgangsSchluessel('wb-1a2b3c4d', 'wache'), 'agent:wache:vorgang:WB-1A2B3C4D');
  assert.deepEqual(vorgangAusSchluessel('agent:wache:vorgang:wb-1a2b3c4d'), {agent: 'wache', vorgang: 'WB-1A2B3C4D'});
  assert.throws(() => vorgangsSchluessel('INC-12345678901234567', 'wache'), {status: 400});
  assert.equal(vorgangAusSchluessel('agent:wache:main'), null);
  assert.equal(vorgangAusSchluessel('agent:wache:vorgang:nix'), null);
  assert.equal(vorgangAusSchluessel(undefined), null);
});

test('fyos.wecken: ein Vorgang weckt seine Sitzung, ohne Ziel die Hauptsitzung, nur über wake', async () => {
  const dispatch = dispatchAttrappe();
  const mit = await wecken({text: 'Neuer Kommentar', vorgang: 'INC-7'}, dispatch, {agent: 'wache'});
  assert.deepEqual(mit, {geweckt: true, modus: 'jetzt', agent: 'wache', sitzung: 'agent:wache:vorgang:INC-7'});
  assert.deepEqual(dispatch.aufrufe.at(-1), {methode: 'wake', params: {
    mode: 'now', text: 'Neuer Kommentar', agentId: 'wache', sessionKey: 'agent:wache:vorgang:INC-7'}});
  const ohne = await wecken({text: 'Los', modus: 'naechster'}, dispatch, {agent: 'wache'});
  assert.deepEqual(ohne, {geweckt: true, modus: 'naechster', agent: 'wache', sitzung: 'agent:wache:main'});
  assert.deepEqual(dispatch.aufrufe.at(-1), {methode: 'wake', params: {mode: 'next-heartbeat', text: 'Los', agentId: 'wache'}});
  await wecken({text: 'Los', sitzung: 'agent:wache:main'}, dispatch, {agent: 'wache'});
  assert.equal(dispatch.aufrufe.at(-1).params.sessionKey, 'agent:wache:main');
  await wecken({text: 'a\u0000b', sitzung: 'agent:wache:vorgang:INC-1', agent: 'andere'}, dispatch, {agent: 'wache'});
  assert.equal(dispatch.aufrufe.at(-1).params.text, 'a b');
  assert.equal(dispatch.aufrufe.at(-1).params.agentId, 'andere');
});

test('fyos.wecken weckt keine fremden Sitzungen und verlangt Text und gültigen Modus', async () => {
  const dispatch = dispatchAttrappe();
  for (const sitzung of ['agent:wache:telegram:direct:4711', 'agent:wache:cron:abc', 'main', 'agent:wache:vorgang:x']) {
    await assert.rejects(wecken({text: 'x', sitzung}, dispatch, {agent: 'wache'}), {status: 400}, sitzung);
  }
  await assert.rejects(wecken({text: '  '}, dispatch), {status: 400});
  await assert.rejects(wecken({}, dispatch), {status: 400});
  await assert.rejects(wecken({text: 'x', modus: 'sofort'}, dispatch), {status: 400});
  await assert.rejects(wecken({text: 'x', vorgang: 'zu kurz'}, dispatch), {status: 400});
  assert.equal(dispatch.aufrufe.length, 0, 'nichts erreicht das Gateway');
  const lang = await wecken({text: 'y'.repeat(9000), vorgang: 'INC-1'}, dispatch);
  assert.equal(dispatch.aufrufe[0].params.text.length, 4000);
  assert.equal(lang.agent, 'main');
});

test('fyos.wecken: ein Fehler des Gateways kommt mit passendem Status zurück', async () => {
  const dispatch = dispatchAttrappe({wake: {ok: false, error: {code: 'UNAVAILABLE', message: 'cron aus'}}});
  await assert.rejects(wecken({text: 'x'}, dispatch), {status: 503, rpcCode: 'UNAVAILABLE'});
  const ohneAntwort = dispatchAttrappe({wake: undefined});
  await assert.rejects(wecken({text: 'x'}, ohneAntwort), {status: 503});
});

test('fyos.vorgang.senden: Nachricht in die Vorgangssitzung, ohne Zustellung an einen Kanal', async () => {
  const dispatch = dispatchAttrappe({'chat.send': {ok: true, payload: {runId: 'r-1', status: 'started'}}});
  const antwort = await vorgangSenden({vorgang: 'inc-42', text: 'Berta hat kommentiert', schluessel: 'ev-1'}, dispatch,
                                      {agent: 'wache'});
  assert.deepEqual(antwort, {gesendet: true, agent: 'wache', sitzung: 'agent:wache:vorgang:INC-42', lauf: 'r-1',
                             status: 'started'});
  assert.deepEqual(dispatch.aufrufe[0], {methode: 'chat.send', params: {
    sessionKey: 'agent:wache:vorgang:INC-42', agentId: 'wache', message: 'Berta hat kommentiert', idempotencyKey: 'ev-1',
    deliver: false}});
  await vorgangSenden({vorgang: 'INC-42', text: 'x'}, dispatch, {agent: 'wache', neueId: () => 'zufall'});
  assert.equal(dispatch.aufrufe[1].params.idempotencyKey, 'fyos-zufall');
  await assert.rejects(vorgangSenden({vorgang: 'INC-42', text: 'x', schluessel: 'a b'}, dispatch), {status: 400});
  await assert.rejects(vorgangSenden({text: 'x'}, dispatch), {status: 400});
  await assert.rejects(vorgangSenden({vorgang: 'INC-42'}, dispatch), {status: 400});
  assert.equal(dispatch.aufrufe.length, 2);
});

test('die Route beantwortet fyos.wecken und fyos.vorgang.senden und meldet Fehler als HTTP-Status', async () => {
  const dispatch = dispatchAttrappe({'chat.send': {ok: true, payload: {runId: 'r-2', status: 'started'}}});
  const handler = erzeugeRpcHandler({dispatch, status: () => ({}), agent: 'wache'});
  const a = antwortAttrappe();
  await handler(anfrage('POST', {id: 'w1', method: 'fyos.wecken', params: {text: 'hallo', vorgang: 'INC-3'}}), a);
  assert.equal(a.statusCode, 200);
  assert.deepEqual(a.json, {id: 'w1', ok: true, payload: {geweckt: true, modus: 'jetzt', agent: 'wache',
                                                          sitzung: 'agent:wache:vorgang:INC-3'}});
  const b = antwortAttrappe();
  await handler(anfrage('POST', {method: 'fyos.vorgang.senden', params: {vorgang: 'INC-3', text: 'hallo'}}), b);
  assert.equal(b.statusCode, 200);
  assert.equal(b.json.payload.lauf, 'r-2');
  const c = antwortAttrappe();
  await handler(anfrage('POST', {method: 'fyos.wecken', params: {}}), c);
  assert.equal(c.statusCode, 400);
  assert.equal(c.json.error.code, 'INVALID_REQUEST');
  const d = antwortAttrappe();
  await handler(anfrage('POST', {method: 'fyos.wecken', params: {text: 'x', sitzung: 'agent:wache:telegram:direct:1'}}), d);
  assert.equal(d.statusCode, 400);
  assert.deepEqual(dispatch.aufrufe.map((x) => x.methode), ['wake', 'chat.send']);
});

test('Ereignisse zu Vorgangssitzungen tragen die Vorgangsnummer, sonst nichts aus dem Schlüssel', () => {
  const s = sitzungsEreignis('beginn', {sessionKey: 'agent:wache:vorgang:inc-5'}, {}, {uhr});
  assert.equal(s.vorgang, 'INC-5');
  assert.equal(s.agent, 'wache');
  assert.equal(sitzungsEreignis('beginn', {sessionKey: 'agent:wache:main'}, {}, {uhr}).vorgang, undefined);
  const laeufe = erzeugeLaeufe({uhr});
  laeufe.verarbeite({stream: 'lifecycle', runId: 'r', sessionKey: 'agent:wache:vorgang:inc-5', data: {phase: 'start'}});
  const lauf = laeufe.verarbeite({stream: 'lifecycle', runId: 'r', sessionKey: 'agent:wache:vorgang:inc-5', data: {phase: 'end'}});
  assert.equal(lauf.vorgang, 'INC-5');
  assert.ok(!JSON.stringify(lauf).includes('vorgang:inc-5'));
  assert.equal(modellEreignis({sessionKey: 'agent:wache:vorgang:inc-5'}, {}, {uhr}).vorgang, 'INC-5');
  assert.equal(werkzeugEreignis({toolName: 'read'}, {sessionKey: 'agent:wache:vorgang:inc-5'}, {uhr}).vorgang, 'INC-5');
});

// ── Kanäle: Stand und dringende Mitteilung ──────────────────────────────────────────────────

const KANAL_KONFIG = {channels: {telegram: {enabled: true}, whatsapp: {enabled: true}, matrix: {enabled: true}}};
const KANAL_UMGEBUNG = {
  OPENCLAW_GATEWAY_TOKEN: 'geheim-token', FYOS_APPROVER_TELEGRAM_ID: '4711',
  FYOS_APPROVER_WHATSAPP_NUMBER: '+4915100000000', FYOS_APPROVER_MATRIX_ID: '@besitzer:example.org',
};

function sendeAttrappe(antworten = {}) {
  const aufrufe = [];
  const fn = async (url, init) => {
    const koerper = JSON.parse(init.body);
    aufrufe.push({url, init, koerper});
    const soll = antworten[koerper.args.channel] ?? {status: 200, body: {ok: true}};
    return {ok: soll.status < 400, status: soll.status, json: async () => soll.body};
  };
  fn.aufrufe = aufrufe;
  return fn;
}

test('kanalStand nennt nur Namen und Wahrheitswerte, nie die Adresse des Besitzers', () => {
  const stand = kanalStand(
    {channels: {telegram: {enabled: true}, whatsapp: {enabled: true}}},
    {FYOS_APPROVER_TELEGRAM_ID: '4711'});
  assert.deepEqual(stand, {
    telegram: {an: true, ziel: true, bereit: true},
    whatsapp: {an: true, ziel: false, bereit: false},
    matrix: {an: false, ziel: false, bereit: false},
  });
  assert.ok(!JSON.stringify(stand).includes('4711'));
  assert.deepEqual(kanalStand({}, {}).telegram, {an: false, ziel: false, bereit: false});
});

test('eine Mitteilung geht über das Gateway an den ersten bereiten Kanal des Besitzers', async () => {
  const fetchImpl = sendeAttrappe();
  const antwort = await kanalMitteilen({text: 'Notfall: Platte voll'}, {config: KANAL_KONFIG, env: KANAL_UMGEBUNG, fetchImpl});
  assert.deepEqual(antwort, {gesendet: true, kanal: 'telegram', gescheitert: []});
  assert.equal(fetchImpl.aufrufe.length, 1);
  const {url, init, koerper} = fetchImpl.aufrufe[0];
  assert.equal(url, 'http://127.0.0.1:18789/tools/invoke');
  assert.equal(init.headers.Authorization, 'Bearer geheim-token');
  assert.deepEqual(koerper, {tool: 'message', args: {action: 'send', channel: 'telegram', target: '4711',
                                                      message: 'Notfall: Platte voll'}});
});

test('scheitert ein Kanal, kommt der nächste dran; das Token steht in keiner Antwort', async () => {
  const fetchImpl = sendeAttrappe({telegram: {status: 502, body: {ok: false, error: {message: 'Bearer geheim-token abgelehnt'}}}});
  const antwort = await kanalMitteilen({text: 'dringend'}, {config: KANAL_KONFIG, env: KANAL_UMGEBUNG, fetchImpl});
  assert.equal(antwort.kanal, 'whatsapp');
  assert.deepEqual(antwort.gescheitert.map((g) => g.kanal), ['telegram']);
  assert.ok(!JSON.stringify(antwort).includes('geheim-token'));
  assert.equal(fetchImpl.aufrufe[1].koerper.args.target, '+4915100000000');
});

test('ein gewünschter Kanal wird allein versucht, Matrix mit der Benutzerkennung', async () => {
  const fetchImpl = sendeAttrappe();
  const antwort = await kanalMitteilen({text: 'hallo', kanal: 'matrix'}, {config: KANAL_KONFIG, env: KANAL_UMGEBUNG, fetchImpl});
  assert.equal(antwort.kanal, 'matrix');
  assert.equal(fetchImpl.aufrufe.length, 1);
  assert.equal(fetchImpl.aufrufe[0].koerper.args.target, '@besitzer:example.org');
  await assert.rejects(kanalMitteilen({text: 'x', kanal: 'sms'}, {config: KANAL_KONFIG, env: KANAL_UMGEBUNG, fetchImpl}), {status: 400});
});

test('ohne Text, ohne Token oder ohne bereiten Kanal gibt es einen Fehler und keinen Aufruf', async () => {
  const fetchImpl = sendeAttrappe();
  await assert.rejects(kanalMitteilen({text: '  '}, {config: KANAL_KONFIG, env: KANAL_UMGEBUNG, fetchImpl}), {status: 400});
  await assert.rejects(kanalMitteilen({text: 'x'}, {config: KANAL_KONFIG, env: {...KANAL_UMGEBUNG, OPENCLAW_GATEWAY_TOKEN: ''}, fetchImpl}), {status: 503});
  await assert.rejects(kanalMitteilen({text: 'x'}, {config: {}, env: KANAL_UMGEBUNG, fetchImpl}), {status: 503});
  await assert.rejects(kanalMitteilen({text: 'x'}, {config: KANAL_KONFIG, env: {OPENCLAW_GATEWAY_TOKEN: 't'}, fetchImpl}), {status: 503});
  assert.equal(fetchImpl.aufrufe.length, 0);
});

test('scheitern alle Kanäle, meldet die Route 503 ohne Token und Adresse', async () => {
  const fetchImpl = async () => { throw new Error('verbindung geheim-token verloren'); };
  const handler = erzeugeRpcHandler({
    dispatch: dispatchAttrappe(), status: () => ({}),
    mitteilen: (params) => kanalMitteilen(params, {config: KANAL_KONFIG, env: KANAL_UMGEBUNG, fetchImpl}),
  });
  const r = antwortAttrappe();
  await handler(anfrage('POST', {method: 'fyos.kanal.mitteilen', params: {text: 'x'}}), r);
  assert.equal(r.statusCode, 503);
  assert.ok(!r.text.includes('geheim-token'));
  assert.ok(!r.text.includes('4711'));
  const ok = antwortAttrappe();
  const handler2 = erzeugeRpcHandler({dispatch: dispatchAttrappe(), status: () => ({}),
                                      mitteilen: (params) => kanalMitteilen(params, {config: KANAL_KONFIG, env: KANAL_UMGEBUNG, fetchImpl: sendeAttrappe()})});
  await handler2(anfrage('POST', {id: 'm1', method: 'fyos.kanal.mitteilen', params: {text: 'x'}}), ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json.payload.kanal, 'telegram');
  const ohne = antwortAttrappe();
  await erzeugeRpcHandler({dispatch: dispatchAttrappe(), status: () => ({})})(
    anfrage('POST', {method: 'fyos.kanal.mitteilen', params: {text: 'x'}}), ohne);
  assert.equal(ohne.statusCode, 503);
});

// ── Anmeldung im Gateway ────────────────────────────────────────────────────────────────────

function apiAttrappe(config = {}) {
  const hooks = {};
  const abos = [];
  const dienste = [];
  const methoden = {};
  const routen = [];
  const meldungen = [];
  const logger = {info: (m) => meldungen.push(m), warn: (m) => meldungen.push(m), debug() {}};
  const api = {
    pluginConfig: config, logger,
    config: {plugins: {entries: {'fyos-bruecke': {enabled: true}, 'fyos-speed-router': {enabled: false}}}},
    on(name, fn) { hooks[name] = fn; },
    agent: {events: {registerAgentEventSubscription(abo) { abos.push(abo); }}},
    registerService(dienst) { dienste.push(dienst); },
    registerGatewayMethod(name, fn, opt) { methoden[name] = {fn, opt}; },
    registerHttpRoute(route) { routen.push(route); },
  };
  return {api, hooks, abos, dienste, methoden, routen, meldungen};
}

test('registerBruecke meldet Hooks, Abo, Dienst, Methode und Route an', () => {
  const a = apiAttrappe();
  registerBruecke(a.api, {dispatch: dispatchAttrappe(), env: {FYOS_HUB_URL: 'http://hub:8080/mcp', OPENCLAW_GATEWAY_TOKEN: 't'},
                          fetch: fetchAttrappe(), uhr});
  assert.deepEqual(Object.keys(a.hooks).sort(), ['after_tool_call', 'cron_changed', 'model_call_ended', 'session_end',
                                                 'session_start', 'skill_changed', 'skill_proposal_changed']);
  assert.deepEqual(a.abos.map((x) => [x.id, x.streams]), [['laeufe', ['lifecycle']]]);
  assert.equal(a.dienste[0].id, 'fyos-bruecke');
  assert.equal(a.methoden['fyos.bruecke.status'].opt.scope, 'operator.read');
  assert.deepEqual(a.routen.map((r) => [r.path, r.auth, r.match]), [[RPC_PFAD, 'gateway', 'exact']]);
  // Kein Hook, der Gesprächsinhalt braucht (allowConversationAccess bleibt aus).
  for (const name of ['llm_input', 'llm_output', 'agent_end', 'before_agent_run', 'before_prompt_build', 'message_received']) {
    assert.ok(!(name in a.hooks), name);
  }
});

test('Ende zu Ende: Inhalte erreichen den Hub nie, der Kopf trägt Stand und Plugins', async () => {
  const a = apiAttrappe({intervallSekunden: 300});
  const fetchImpl = fetchAttrappe();
  const bruecke = registerBruecke(a.api, {dispatch: dispatchAttrappe(), fetch: fetchImpl, uhr,
                                          env: {FYOS_HUB_URL: 'http://hub:8080/mcp', OPENCLAW_GATEWAY_TOKEN: 'geheim-test',
                                                HOSTNAME: 'agent-0'}});
  a.hooks.after_tool_call({toolName: 'read', params: {path: '/home/GEHEIM'}, result: 'GEHEIM'},
                          {agentId: 'main', sessionKey: 'agent:main:GEHEIM'});
  a.hooks.after_tool_call({toolName: 'hub__hub__call_tool', params: {}}, {});
  a.hooks.after_tool_call(innen('hub__hub__health', 'c9'), {});
  a.hooks.after_tool_call(huelle('c9', 'mcp:hub:hub__hub__health'), {});
  a.hooks.model_call_ended({provider: 'modell', model: 'm', outcome: 'completed', durationMs: 10}, {});
  a.abos[0].handle({stream: 'lifecycle', runId: 'r1', data: {phase: 'end'}});
  a.hooks.cron_changed({action: 'finished', jobId: 'j', status: 'ok'});
  assert.equal(bruecke.warteschlange.laenge, 4, 'Hub-Werkzeug ausgelassen');

  await a.dienste[0].start({});
  try {
    await bruecke.sender.senden();
    const {url, init} = fetchImpl.aufrufe.at(-1);
    assert.equal(url, 'http://hub:8080/hub/openclaw/ereignisse');
    assert.ok(!init.body.includes('GEHEIM'));
    const koerper = JSON.parse(init.body);
    assert.deepEqual(koerper.ereignisse.map((e) => e.art).sort(), ['cron', 'hinweis', 'lauf', 'modell', 'werkzeug']);
    assert.equal(koerper.bruecke.instanz, 'agent-0');
    assert.deepEqual(koerper.bruecke.plugins, [{id: 'fyos-bruecke', an: true}, {id: 'fyos-speed-router', an: false}]);
    assert.deepEqual(Object.keys(koerper.bruecke.kanaele), ['telegram', 'whatsapp', 'matrix']);
    assert.equal(koerper.bruecke.kanaele.telegram.an, false);
    assert.equal(init.headers['X-FYOS-Signatur'], signatur('geheim-test', init.headers['X-FYOS-Zeit'], init.body));
    const stand = a.methoden['fyos.bruecke.status'].fn();
    assert.equal(stand.laeuft, true);
    assert.equal(stand.signiert, true);
    assert.equal(stand.warteschlange, 0);
    assert.ok(!JSON.stringify(stand).includes('geheim-test'));
  } finally {
    await a.dienste[0].stop({});
  }
  assert.equal(a.methoden['fyos.bruecke.status'].fn().laeuft, false);
});

test('ein kaputtes Ereignis kostet nur sich selbst, und ohne Hub-Adresse bleibt alles still', () => {
  const a = apiAttrappe();
  const bruecke = registerBruecke(a.api, {dispatch: dispatchAttrappe(), env: {}, fetch: fetchAttrappe(), uhr});
  assert.doesNotThrow(() => a.hooks.after_tool_call(null, null));
  assert.doesNotThrow(() => a.hooks.cron_changed(undefined));
  assert.equal(bruecke.ziel, '');
  a.dienste[0].start({});
  assert.equal(a.methoden['fyos.bruecke.status'].fn().laeuft, false, 'ohne Ziel kein Takt');
  assert.ok(a.meldungen.some((m) => m.includes('FYOS_HUB_URL')));
});

test('ohne dispatchGatewayMethod keine Route, ohne registerService der Start über gateway_start', () => {
  const a = apiAttrappe();
  delete a.api.registerService;
  registerBruecke(a.api, {env: {FYOS_HUB_URL: 'http://hub/mcp'}, fetch: fetchAttrappe(), uhr});
  assert.equal(a.routen.length, 0);
  assert.equal(typeof a.hooks.gateway_start, 'function');
  const halt = new AbortController();
  a.hooks.gateway_start({abortSignal: halt.signal});
  assert.equal(a.methoden['fyos.bruecke.status'].fn().laeuft, true);
  halt.abort();
  assert.equal(a.methoden['fyos.bruecke.status'].fn().laeuft, false);
});

test('Manifest: Dispatch-Vertrag gesetzt, jede Einstellung im Schema', () => {
  const manifest = JSON.parse(readFileSync(new URL('./openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.id, 'fyos-bruecke');
  assert.deepEqual(manifest.contracts.gatewayMethodDispatch, ['authenticated-request']);
  assert.equal(manifest.configSchema.additionalProperties, false);
  for (const schluessel of [...Object.keys(VORGABEN), 'hubUrl', 'agentId']) {
    assert.ok(schluessel in manifest.configSchema.properties, schluessel);
  }
});
