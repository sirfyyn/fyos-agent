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
  EIGENE, ERLAUBT, RPC_PFAD, VORGABEN, agentAusSchluessel, cronEreignis, erzeugeLaeufe, erzeugeRpcHandler,
  erzeugeSender, erzeugeWarteschlange, erzeugeWerkzeuge, fehlerText, huellenZiel, hubZiel, idTeil, leseSkill,
  modellEreignis, registerBruecke, signatur, sitzungsEreignis, sitzungsHash, skillEreignis, vorschlagEreignis,
  werkzeugEreignis,
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
                       agent: 'main', sitzung: sitzungsHash('agent:main:matrix:raum'), kanal: 'matrix'});
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
    assert.ok(/^(workboard\.(boards\.(list|upsert)|cards\.(list|create|update|move|comment|archive))|skills\.status|cron\.(list|runs|status)|usage\.(cost|status)|health)$/.test(m), m);
  }
  assert.deepEqual([...EIGENE].sort(), ['fyos.bruecke.status', 'fyos.skill.lesen']);
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
  for (const schluessel of [...Object.keys(VORGABEN), 'hubUrl']) {
    assert.ok(schluessel in manifest.configSchema.properties, schluessel);
  }
});
