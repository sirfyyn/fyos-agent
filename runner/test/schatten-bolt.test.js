/**
 * Bolt-Adapter gegen einen Attrappe-Endpunkt (OpenAI-kompatibel, Strom und JSON), Steuerkanal (/zustand.schatten, Wahrheit, Bericht)
 * und der Beobachter im Ausgang mit einem Faux-Modell: die Live-Aktion kommt aus dem echten Zug.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { konfigurationLaden } from '../src/config.js';
import { Egress } from '../src/egress.js';
import { Runner } from '../src/runner.js';
import { SchattenRekorder, baueAdapter, openaiAdapter, zugKontext } from '../src/schatten.js';
import { adapterKonfig, schattenKonfig } from '../src/schatten-konfig.js';
import { erstelleSteuerkanal } from '../src/steuerkanal.js';

const tmp = mkdtempSync(join(tmpdir(), 'schatten-bolt-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const SCHLUESSEL = 'testkey-ABCDEF123456';
const schluesselDatei = join(tmp, 'api.key');
writeFileSync(schluesselDatei, `${SCHLUESSEL}\n`);
chmodSync(schluesselDatei, 0o600);
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
async function bis(fn, { ms = 5000, was = 'Bedingung' } = {}) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    if (await fn()) return;
    await warte(20);
  }
  throw new Error(`Zeit abgelaufen: ${was}`);
}

// --- Attrappe-Endpunkt -----------------------------------------------------------------------------------------------

const anfragen = [];
let modus = 'sse-tool';
const server = http.createServer((req, res) => {
  const stuecke = [];
  req.on('data', (c) => stuecke.push(c));
  req.on('end', () => {
    const body = stuecke.length ? JSON.parse(Buffer.concat(stuecke).toString('utf8')) : null;
    anfragen.push({ pfad: req.url, auth: req.headers.authorization ?? null, body });
    if (req.headers.authorization !== `Bearer ${SCHLUESSEL}`) {
      res.writeHead(401).end('{"error":"kein Schlüssel"}');
      return;
    }
    if (modus === '500') {
      res.writeHead(500).end(`Fehler mit ${body.messages.at(-1).content}`);
      return;
    }
    if (modus === 'json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'Das ist nicht nötig.', tool_calls: [] } }], usage: { prompt_tokens: 50, completion_tokens: 6 } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const sse = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (modus === 'sse-tool') {
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'hub_aufrufen', arguments: '{"werkzeug":' } }] } }] });
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"vorgaenge.zeigen"}' } }] } }] });
      sse({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'hub_suchen', arguments: '{}' } }] } }] });
    } else if (modus === 'sse-kaputt') {
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'hub_aufrufen', arguments: '{"werkzeug": ' } }] } }] });
    } else {
      sse({ choices: [{ delta: { content: 'Es ist ' } }] });
      sse({ choices: [{ delta: { content: 'alles ruhig, das ist gut.' } }] });
    }
    sse({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 20 } });
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());
const url = `http://127.0.0.1:${server.address().port}`;

let nr = 0;
function bolt(extra = {}) {
  const ordner = join(tmp, `o${(nr += 1)}`);
  const konfig = schattenKonfig({
    an: true,
    ordner,
    warte_ms: 0,
    wache_ms: 20,
    frist_s: 5,
    adapter: { bolt: { an: true, url, schluessel_datei: schluesselDatei, modell: 'ersatzdenker', quant: 'Q3_K_XL', ...extra } },
  });
  return { konfig, ordner, rek: new SchattenRekorder({ konfig, adapter: baueAdapter(konfig), log: () => {} }) };
}
const werkzeuge = [
  { name: 'hub_aufrufen', description: 'ruft auf', parameters: { type: 'object', properties: { werkzeug: { type: 'string' } } } },
  { name: 'hub_suchen', description: 'sucht', parameters: { type: 'object' } },
];
function lauf(rek, ein, live = { name: 'hub_aufrufen', args: { werkzeug: 'vorgaenge.zeigen' } }) {
  rek.beginne({ ein, quelle: 'chat', klasse: 'max', eingang: 'Zeig mir die Vorgänge', text: 'Eingang von chat.\n\nZeig mir die Vorgänge', system: 'Du bist Persona.', werkzeuge });
  if (live) rek.werkzeug(ein, live.name, live.args);
  else rek.text(ein, 'Es ist ruhig.');
  rek.ende(ein);
}
const fertig = (rek) => bis(() => !rek.laeuft && rek.warteschlange.length === 0, { was: 'Schattenzug fertig' });
const zeilen = (ordner) => readdirSync(ordner).filter((n) => n.startsWith('bolt-')).flatMap((n) => readFileSync(join(ordner, n), 'utf8').trim().split('\n').map((z) => JSON.parse(z)));
const alles = (ordner) => readdirSync(ordner).map((n) => readFileSync(join(ordner, n), 'utf8')).join('\n');

test('Bolt: Werkzeugschemata, tool_choice auto, Schlüssel nur im Kopf, erster Aufruf aufgezeichnet, nichts ausgeführt', async () => {
  modus = 'sse-tool';
  anfragen.length = 0;
  const { rek, ordner } = bolt();
  lauf(rek, 'b1');
  await fertig(rek);
  assert.equal(anfragen.length, 1);
  const a = anfragen[0];
  assert.equal(a.pfad, '/v1/chat/completions');
  assert.equal(a.auth, `Bearer ${SCHLUESSEL}`);
  assert.equal(a.body.model, 'ersatzdenker');
  assert.equal(a.body.tool_choice, 'auto');
  assert.equal(a.body.stream, true);
  assert.deepEqual(a.body.tools.map((t) => [t.type, t.function.name]), [['function', 'hub_aufrufen'], ['function', 'hub_suchen']]);
  assert.deepEqual(a.body.messages.map((m) => m.role), ['system', 'user']);
  assert.match(a.body.messages[1].content, /Zeig mir die Vorgänge/);
  const [z] = zeilen(ordner);
  assert.equal(z.status, 'ok');
  assert.equal(z.schatten.name, 'hub_aufrufen', 'nur der erste Aufruf, nicht hub_suchen');
  assert.deepEqual(z.schatten.args_form, { werkzeug: 'string' });
  assert.equal(z.uebereinstimmung.exakt, true);
  assert.deepEqual(z.tokens, { ein: 900, aus: 20 });
  assert.equal(typeof z.latenz.erstes_token_ms, 'number');
  assert.equal(typeof z.latenz.gesamt_ms, 'number');
  assert.deepEqual([z.version.modell, z.version.quant], ['ersatzdenker', 'Q3_K_XL']);
  assert.match(z.version.systemkopf, /^[0-9a-f]{16}$/);
  // Der Schlüssel steht nirgends: weder in den Zeilen noch im Zustand noch im Bericht.
  for (const text of [alles(ordner), JSON.stringify(rek.zustand()), JSON.stringify(rek.bericht())]) assert.ok(!text.includes(SCHLUESSEL));
});

test('Bolt: Textantwort im Strom und als JSON; Deutsch erkannt; ungültiges JSON der Argumente gezählt', async () => {
  anfragen.length = 0;
  const { rek, ordner } = bolt();
  modus = 'sse-text';
  lauf(rek, 't1', null);
  await fertig(rek);
  modus = 'json';
  lauf(rek, 't2', null);
  await fertig(rek);
  modus = 'sse-kaputt';
  lauf(rek, 't3');
  await fertig(rek);
  const [t1, t2, t3] = zeilen(ordner);
  assert.equal(t1.schatten.art, 'text');
  assert.equal(t1.uebereinstimmung.werkzeug, true);
  assert.equal(t1.uebereinstimmung.deutsch, true);
  assert.equal(t1.schatten.text, 'Es ist alles ruhig, das ist gut.');
  assert.equal(t2.schatten.art, 'text');
  assert.deepEqual(t2.tokens, { ein: 50, aus: 6 });
  assert.equal(t3.schatten.art, 'werkzeug');
  assert.equal(t3.uebereinstimmung.json_gueltig, false);
  assert.equal(t3.uebereinstimmung.exakt, false);
});

test('Bolt: HTTP-Fehler, falscher oder fehlender Schlüssel, Schlüsseldatei fehlt, Endpunkt nicht erreichbar', async () => {
  modus = '500';
  const a = bolt();
  lauf(a.rek, 'e1');
  await fertig(a.rek);
  const [e1] = zeilen(a.ordner);
  assert.equal(e1.status, 'fehler');
  assert.equal(e1.fehler, 'HTTP 500', 'der Rumpf der Antwort wird nicht übernommen');

  const falsch = join(tmp, 'falsch.key');
  writeFileSync(falsch, 'anderer-schluessel');
  const b = bolt({ schluessel_datei: falsch });
  lauf(b.rek, 'e2');
  await fertig(b.rek);
  assert.equal(zeilen(b.ordner)[0].fehler, 'HTTP 401');
  assert.ok(!alles(b.ordner).includes('anderer-schluessel'));

  const c = bolt({ schluessel_datei: join(tmp, 'gibt-es-nicht.key') });
  lauf(c.rek, 'e3');
  await fertig(c.rek);
  assert.equal(zeilen(c.ordner)[0].fehler, 'Schlüsseldatei nicht lesbar');

  const d = bolt({ url: 'http://127.0.0.1:1' });
  lauf(d.rek, 'e4');
  await fertig(d.rek);
  assert.equal(zeilen(d.ordner)[0].status, 'fehler');
});

test('Bolt: ohne Endpunkt oder Modell überspringt der Adapter („nicht-konfiguriert“); der Schlüssel taucht in Netzfehlern nicht auf', async () => {
  const leer = openaiAdapter('sprache-agent', adapterKonfig('sprache-agent', { an: true }));
  assert.deepEqual(await leer.anfrage({ text: 'x', werkzeuge: [] }), { uebersprungen: 'nicht-konfiguriert' });
  const ak = adapterKonfig('bolt', { an: true, url, modell: 'm', schluessel_datei: schluesselDatei });
  const mit = openaiAdapter('bolt', ak, {
    fetchImpl: async () => {
      throw new Error(`connect ECONNREFUSED mit ${SCHLUESSEL}`);
    },
  });
  await assert.rejects(mit.anfrage({ text: 'x', werkzeuge: [] }), (f) => !f.message.includes(SCHLUESSEL) && /\[Schlüssel\]/.test(f.message));
});

test('Zeitüberschreitung gegen einen hängenden Endpunkt: Status timeout, Verbindung abgebrochen', async () => {
  const haengt = http.createServer(() => {});
  await new Promise((r) => haengt.listen(0, '127.0.0.1', r));
  const { rek, ordner } = bolt({ url: `http://127.0.0.1:${haengt.address().port}` });
  rek.konfig.frist_s = 0.2;
  lauf(rek, 'h1');
  await fertig(rek);
  haengt.closeAllConnections?.();
  haengt.close();
  assert.equal(zeilen(ordner)[0].status, 'timeout');
});

// --- Steuerkanal ---------------------------------------------------------------------------------------------------------

function http1(port, methode, pfad, body) {
  return new Promise((fertig2, scheitern) => {
    const req = http.request({ host: '127.0.0.1', port, method: methode, path: pfad, agent: false }, (res) => {
      const s = [];
      res.on('data', (c) => s.push(c));
      res.on('end', () => fertig2({ status: res.statusCode, nutz: JSON.parse(Buffer.concat(s).toString('utf8')) }));
    });
    req.on('error', scheitern);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

test('Steuerkanal: /zustand.schatten ohne Inhalte, Wahrheit setzen, Bericht lesen; ohne Rekorder null und 400', async () => {
  modus = 'sse-tool';
  const { rek, ordner } = bolt();
  lauf(rek, 'k1');
  await fertig(rek);
  const runner = { harness: { snapshot: async () => undefined }, root: { id: 'w1' }, geschlossen: false, gespraeche: async () => [] };
  const kanal = erstelleSteuerkanal({ cfg: { agent: 'persona', steuer: { host: '127.0.0.1', port: 0 } }, runner, schatten: rek, log: () => {} });
  const { port } = await kanal.starten();
  const ohne = erstelleSteuerkanal({ cfg: { agent: 'persona', steuer: { host: '127.0.0.1', port: 0 } }, runner, log: () => {} });
  const { port: portOhne } = await ohne.starten();
  try {
    const z = (await http1(port, 'GET', '/zustand')).nutz;
    assert.equal(z.schatten.an, true);
    assert.equal(z.schatten.adapter.bolt.ok, 1);
    assert.doesNotMatch(JSON.stringify(z.schatten), /Zeig mir|vorgaenge|testkey/);
    const w = await http1(port, 'POST', '/schatten/wahrheit', { ein: 'k1', urteil: 'gut' });
    assert.deepEqual([w.status, w.nutz.ok], [200, true]);
    assert.equal((await http1(port, 'POST', '/schatten/wahrheit', { ein: 'k1', urteil: 'prima' })).status, 400);
    assert.equal((await http1(port, 'POST', '/schatten/wahrheit', { urteil: 'gut' })).status, 400);
    const b = await http1(port, 'GET', '/schatten/bericht?tage=1');
    assert.equal(b.status, 200);
    assert.equal(b.nutz.adapter.bolt.zuege, 1);
    assert.equal(b.nutz.adapter.bolt.wahrheit.bekannt, 1);
    assert.equal(b.nutz.adapter.bolt.tor.bereit, 'zu wenig Daten');
    assert.ok(readdirSync(ordner).some((n) => n.startsWith('wahrheit-')));
    assert.equal((await http1(portOhne, 'GET', '/zustand')).nutz.schatten, null);
    assert.equal((await http1(portOhne, 'GET', '/schatten/bericht')).status, 400);
    assert.equal((await http1(portOhne, 'POST', '/schatten/wahrheit', { ein: 'x', urteil: 'gut' })).status, 400);
  } finally {
    await kanal.beenden();
    await ohne.beenden();
  }
});

// --- Ausgang: die Live-Aktion kommt aus dem echten Zug --------------------------------------------------------------

test('Ausgang meldet dem Beobachter erste Werkzeugwahl, Text und Zugende; zugKontext liefert Schemata', async () => {
  const dir = join(tmp, 'egress');
  mkdirSync(dir);
  const cfg = konfigurationLaden(
    {
      hub: 'http://hub.test',
      arbeitsbereiche: { standard: { pfad: dir, titel: 'Test' } },
      pi_durable: {
        storage: join(dir, 'fyos.sqlite'),
        security: { token: 'test-token-test-token-test-token-00' },
        egress: { enabled: true, flushMs: 100 },
        browser: { enabled: false },
        desktop: { enabled: false },
        schatten: { an: true, ordner: join(dir, 'sch') },
      },
    },
    {},
  );
  assert.equal(cfg.pi_durable.schatten.an, true);
  const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: [{ id: 'hausmodell' }, { id: 'hausmodell-max' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const hub = { melden: async () => ({ ok: true }), bereicheMelden: async () => ({ ok: true }), gesundheit: async () => ({ ok: true }), aufrufen: async () => ({ ok: true, result: {} }) };
  const runner = new Runner(cfg, { models, hub });
  await runner.start();
  const egress = new Egress({ cfg, harness: runner.harness, hub, onFehler: () => {} });
  const ereignisse = [];
  egress.beobachter = {
    werkzeug: (ein, name, args) => ereignisse.push(['werkzeug', ein, name, args]),
    text: (ein, delta) => ereignisse.push(['text', ein, delta]),
    ende: (ein, verlauf) => verlauf().then((v) => ereignisse.push(['ende', ein, v])),
  };
  await egress.start();
  try {
    const kontext = await zugKontext(runner, runner.root.id, BACKGROUND_CONTEXT);
    assert.ok(kontext.werkzeuge.some((t) => t.name === 'zustand_lesen' && t.parameters));
    assert.ok(kontext.system.includes('Dieses Gespräch heißt'), 'der Systemkopf kommt aus den Anweisungen des Gesprächs');

    faux.setResponses([fauxAssistantMessage(fauxToolCall('zustand_lesen', {}), { stopReason: 'toolUse' }), fauxAssistantMessage('Der Zustand ist leer, das ist gut.')]);
    const conv = await runner.harness.conversation(runner.root.id, BACKGROUND_CONTEXT);
    await conv.submit(
      {
        type: 'input',
        content: 'Eingang von chat.\n\nLies den Zustand.',
        whenBusy: 'followUp',
        requestId: 'eingang:chat:e-1',
        entry: { kind: 'fyos.eingang', data: { quelle: 'chat', von: 'max', klasse: 'max', stromId: 'chat:e-1', text: 'Lies den Zustand.' } },
      },
      BACKGROUND_CONTEXT,
    );
    await bis(() => ereignisse.some((e) => e[0] === 'ende'), { ms: 15000, was: 'Zugende gemeldet' });
    // Das Zugende bringt den gespeicherten Verlauf: erste Werkzeugwahl und Text seit dem Eingang (zuverlässig auch bei schnellen Aufrufen).
    const ende = ereignisse.filter((e) => e[0] === 'ende');
    assert.equal(ende.length, 1);
    assert.equal(ende[0][1], 'chat:e-1');
    assert.deepEqual(ende[0][2], { werkzeug: { name: 'zustand_lesen', args: {} }, text: 'Der Zustand ist leer, das ist gut.' });
    // Was während des Zugs beobachtet wurde, gehört demselben Zug (bei sehr schnellem Ablauf kann es fehlen).
    assert.ok(ereignisse.filter((e) => e[0] !== 'ende').every((e) => e[1] === 'chat:e-1'));
  } finally {
    await egress.stop();
    await runner.close().catch(() => {});
  }
});
