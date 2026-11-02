/**
 * Der Aufruferkopf `X-FYOS-Aufrufer` (src/aufrufer.js): jede Anfrage an Hausmodell/Katy trägt, wer fragt, damit das Tor feste Slots
 * je Aufrufer führen kann. Geprüft:
 *  - reine Bestimmung der Art (alle Werte, unbekannt → persona-haupt);
 *  - ein echter HTTP-Endpunkt (Attrappe) sieht den Header, und der Prompt (Body) ist mit und ohne Header derselbe;
 *  - im echten Runner: Hauptgespräch, Arbeitsschleife, Lauf (Kindgespräch), Sprachgespräch.
 * Der Zusammenfasser wird am Systemprompt erkannt; ein Wächtertest liest den Text aus pi-durable, damit eine Änderung dort auffällt.
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { stream, streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import {
  AUFRUFER_KOPF,
  MARKE,
  aufruferAusAufgabe,
  aufruferVon,
  bestimmeAufrufer,
  markiere,
  mitAufruferKopf,
} from '../src/aufrufer.js';
import { konfigurationLaden } from '../src/config.js';
import { eingabeInhalt } from '../src/ingress.js';
import { praefixHuelle } from '../src/praefix.js';
import { Runner } from '../src/runner.js';

const CTX = BACKGROUND_CONTEXT;
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
async function bis(fn, { ms = 40000, was = 'Bedingung' } = {}) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    const wert = await fn();
    if (wert) return wert;
    await warte(100);
  }
  throw new Error(`Zeit abgelaufen: ${was}`);
}

const tmp = mkdtempSync(join(tmpdir(), 'pidurable-aufrufer-'));
mkdirSync(join(tmp, 'kontext'), { recursive: true });
process.env.FYOS_KONTEXT_DIR = join(tmp, 'kontext');
after(() => rmSync(tmp, { recursive: true, force: true }));

const nutzer = (text) => ({ role: 'user', content: text, timestamp: 1 });
const kopf = { role: 'system', content: 'Du bist Persona.', timestamp: 0 };

test('bestimmeAufrufer: alle Werte, Unbekanntes ist persona-haupt', () => {
  const msgs = [kopf, nutzer('Eingang von matrix (max) · Bezug t-1.\n\nHallo')];
  assert.equal(bestimmeAufrufer({ meta: null, messages: msgs }), 'persona-haupt');
  assert.equal(bestimmeAufrufer({ meta: { art: 'root' }, messages: msgs }), 'persona-haupt');
  assert.equal(bestimmeAufrufer({ meta: { art: 'mensch' }, messages: msgs }), 'persona-haupt');
  assert.equal(bestimmeAufrufer({ meta: undefined, messages: [] }), 'persona-haupt');
  assert.equal(bestimmeAufrufer({ meta: { art: 'sprache' }, messages: msgs }), 'sprache');
  assert.equal(bestimmeAufrufer({ meta: { aufrufer: 'persona-kind:lauf' }, messages: msgs }), 'persona-kind:lauf');
  assert.equal(bestimmeAufrufer({ meta: { aufrufer: 'nachtwerkstatt:dreaming' }, messages: msgs }), 'nachtwerkstatt:dreaming');
  const arbeit = [kopf, nutzer('Eingang von zeitplan · Bezug arbeit-VOR-12. Hintergrundnachricht.\n\nBring ihn zu einem Ergebnis.')];
  assert.equal(bestimmeAufrufer({ meta: { art: 'root' }, messages: arbeit }), 'arbeit');
  // Maßgeblich ist die letzte Nutzernachricht: danach wieder Besitzer.
  assert.equal(bestimmeAufrufer({ meta: { art: 'root' }, messages: [...arbeit, nutzer('Eingang von matrix (max) · Bezug t-2.\n\nStopp')] }), 'persona-haupt');
  // Werkzeugergebnisse dazwischen ändern nichts.
  const mitErgebnis = [...arbeit, { role: 'assistant', content: [], timestamp: 2 }, { role: 'toolResult', content: [], timestamp: 3 }];
  assert.equal(bestimmeAufrufer({ meta: { art: 'root' }, messages: mitErgebnis }), 'arbeit');
  const zf = [{ role: 'system', content: 'You are a context summarization assistant. Your task is to read a conversation…', timestamp: 0 }, nutzer('<conversation>…</conversation>')];
  assert.equal(bestimmeAufrufer({ meta: { art: 'root' }, messages: zf }), 'zusammenfasser');
});

test('aufruferAusAufgabe: Läufe, Pilot, Schmieden', () => {
  assert.equal(aufruferAusAufgabe({ kind: 'fyos.lauf', input: {} }), 'persona-kind:lauf');
  assert.equal(aufruferAusAufgabe({ kind: 'fyos.harness2-pilot', input: {} }), 'persona-kind:harness2');
  assert.equal(aufruferAusAufgabe({ kind: 'fyos.harness2-pilot', input: { nachtgate: true } }), 'nachtwerkstatt:skillsmith');
  for (const s of ['dreaming', 'skillsmith', 'nodesmith']) assert.equal(aufruferAusAufgabe({ kind: `fyos.nachtwerkstatt.${s}` }), `nachtwerkstatt:${s}`);
  assert.equal(aufruferAusAufgabe({ kind: 'fyos.nachtwerkstatt' }), null, 'die Nacht selbst hat kein Kindgespräch');
  assert.equal(aufruferAusAufgabe({ kind: 'pi.compaction' }), null);
});

test('Wächter: pi-durable nennt den Zusammenfasser weiter mit diesem Satz', () => {
  const datei = fileURLToPath(new URL('../node_modules/@earendil-works/pi-durable/dist/harness/compaction.js', import.meta.url));
  assert.match(readFileSync(datei, 'utf8'), /SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant/);
});

test('markiere und aufruferVon: Marke an einer Kopie der ersten Nachricht, ohne Marke persona-haupt', () => {
  const orig = [kopf, nutzer('x')];
  const m = markiere(orig, 'persona-kind:lauf');
  assert.notEqual(m[0], orig[0]);
  assert.equal(orig[0][MARKE], undefined, 'das Original bleibt unberührt');
  assert.equal(aufruferVon({ messages: m }), 'persona-kind:lauf');
  assert.equal(aufruferVon({ messages: orig }), 'persona-haupt');
  assert.equal(aufruferVon({ messages: [{ role: 'system', content: [{ type: 'text', text: 'You are a context summarization assistant.' }] }] }), 'zusammenfasser');
  assert.equal(aufruferVon(undefined), 'persona-haupt');
  assert.deepEqual(markiere([], 'a'), []);
  // Die Marke ist keine Eigenschaft, die im Prompt oder in JSON landet.
  assert.ok(!JSON.stringify(m).includes('persona-kind'));
});

test('mitAufruferKopf: ergänzt, behält fremde Köpfe, überschreibt einen gesetzten nicht', () => {
  assert.deepEqual(mitAufruferKopf(undefined, 'persona-haupt'), { headers: { [AUFRUFER_KOPF]: 'persona-haupt' } });
  assert.deepEqual(mitAufruferKopf({ maxTokens: 5, headers: { 'X-A': '1' } }, 'sprache'), { maxTokens: 5, headers: { 'X-A': '1', [AUFRUFER_KOPF]: 'sprache' } });
  const gesetzt = { headers: { 'x-fyos-aufrufer': 'schnellweg' } };
  assert.equal(mitAufruferKopf(gesetzt, 'persona-haupt'), gesetzt);
});

/** Ein echter HTTP-Endpunkt, der Header und Body festhält und eine kurze Antwort streamt. */
async function attrappe() {
  const gesehen = [];
  const server = createServer((req, res) => {
    const teile = [];
    req.on('data', (c) => teile.push(c));
    req.on('end', () => {
      gesehen.push({ headers: req.headers, body: Buffer.concat(teile).toString('utf8') });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, fin = null) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'katy', choices: [{ index: 0, delta, finish_reason: fin }] })}\n\n`;
      res.write(chunk({ role: 'assistant', content: 'ok' }));
      res.write(chunk({}, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { gesehen, url: `http://127.0.0.1:${server.address().port}/v1`, zu: () => new Promise((r) => server.close(r)) };
}

test('echter HTTP-Endpunkt: der Header kommt an, der Body ist mit und ohne Marke derselbe', async () => {
  const a = await attrappe();
  try {
    const modell = {
      id: 'katy', name: 'Katy', api: 'openai-completions', provider: 'hausmodell', baseUrl: a.url, input: ['text'], reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262144, maxTokens: 1024,
    };
    const huelle = praefixHuelle({ stream, streamSimple });
    const frage = async (messages) => {
      const s = huelle.streamSimple(modell, { messages }, { apiKey: 'egal' });
      const ende = await s.result();
      assert.notEqual(ende.stopReason, 'error', ende.errorMessage);
    };
    const roh = [kopf, nutzer('Hallo')];
    await frage(roh); // ohne Marke
    await frage(markiere(roh, 'persona-kind:lauf'));
    await frage([{ role: 'system', content: 'You are a context summarization assistant. Lies.', timestamp: 0 }, nutzer('<conversation>x</conversation>')]);
    assert.equal(a.gesehen.length, 3);
    assert.equal(a.gesehen[0].headers['x-fyos-aufrufer'], 'persona-haupt');
    assert.equal(a.gesehen[1].headers['x-fyos-aufrufer'], 'persona-kind:lauf');
    assert.equal(a.gesehen[2].headers['x-fyos-aufrufer'], 'zusammenfasser');
    assert.equal(a.gesehen[0].body, a.gesehen[1].body, 'der Header ändert den Prompt nicht');
    assert.ok(!a.gesehen[1].body.includes('persona-kind'));
  } finally {
    await a.zu();
  }
});

// ---------------------------------------------------------------------------------------------- im echten Runner

const hub = () => ({
  aufrufen: async () => ({ ok: true, result: {} }),
  melden: async () => ({ ok: true }),
  bereicheMelden: async () => ({ ok: true }),
  gesundheit: async () => ({ ok: true }),
  suchen: async () => [],
  schema: async () => ({}),
  eingangLesen: async (nach) => {
    await warte(150);
    return { eintraege: [], letzte: nach };
  },
});

function basis(aufrufe) {
  const bauen = (model, context, options) => {
    const s = createAssistantMessageEventStream();
    aufrufe.push({ context, kopf: options?.headers?.[AUFRUFER_KOPF] ?? null });
    queueMicrotask(() => {
      const m = fauxAssistantMessage('ok');
      s.push({ type: 'done', reason: 'stop', message: m });
      s.end(m);
    });
    return s;
  };
  return { stream: bauen, streamSimple: bauen };
}

async function start(name, extra = {}) {
  const cfg = konfigurationLaden(
    {
      hub: 'http://hub.test',
      arbeitsbereiche: { standard: { pfad: tmp, titel: 'Test' } },
      spielmodus: [join(tmp, `${name}.kid`)],
      ...extra,
      pi_durable: {
        storage: join(tmp, name, 'fyos.sqlite'),
        security: { token: 'test-token-test-token-test-token-00' },
        proactive: { enabled: true, pollSeconds: 3 },
        egress: { enabled: false },
        browser: { enabled: false },
        desktop: { enabled: false },
      },
    },
    {},
  );
  const aufrufe = [];
  const runner = new Runner(cfg, { basis: basis(aufrufe), hub: hub() });
  await runner.start();
  const root = (await runner.gespraeche()).find((g) => g.art === 'root');
  return { runner, root, aufrufe };
}

test('Runner: Hauptgespräch persona-haupt, Arbeitsschleife arbeit, Lauf persona-kind:lauf', async () => {
  const { runner, root, aufrufe } = await start('runner');
  try {
    await runner.sende(root.id, eingabeInhalt({ quelle: 'matrix', von: 'max', bezug: 't-1', klasse: 'max', text: 'Hallo' }, ''));
    await bis(() => aufrufe.length >= 1, { was: 'erste Anfrage' });
    await runner.harness.waitForIdle(CTX);
    assert.equal(aufrufe[0].kopf, 'persona-haupt');

    await runner.sende(root.id, eingabeInhalt({ quelle: 'zeitplan', von: 'zeitplan', bezug: 'arbeit-VOR-7', klasse: 'hintergrund', text: 'Bring VOR-7 zu einem Ergebnis.' }, ''));
    await bis(() => aufrufe.length >= 2, { was: 'zweite Anfrage' });
    await runner.harness.waitForIdle(CTX);
    assert.equal(aufrufe[1].kopf, 'arbeit');

    await runner.sende(root.id, eingabeInhalt({ quelle: 'matrix', von: 'max', bezug: 't-3', klasse: 'max', text: 'Danke' }, ''));
    await bis(() => aufrufe.length >= 3, { was: 'dritte Anfrage' });
    await runner.harness.waitForIdle(CTX);
    assert.equal(aufrufe[2].kopf, 'persona-haupt', 'nach der Arbeit wieder Besitzer');

    // Ein Lauf bekommt ein Kindgespräch; dessen Anfragen tragen persona-kind:lauf.
    await runner.root.commit((tx) => runner.laufAnlegen(tx, runner.Lauf, { titel: 'Test', auftrag: 'Tu es.', cwd: tmp, quelle: 'agent', elternId: runner.root.id }), CTX);
    await bis(() => aufrufe.length >= 4, { was: 'Anfrage des Laufs' });
    assert.equal(aufrufe[3].kopf, 'persona-kind:lauf');
    assert.match(JSON.stringify(aufrufe[3].context.messages), /Du bist ein FYOS-Lauf/);
  } finally {
    await runner.close().catch(() => {});
  }
});

test('Runner: das Sprachgespräch trägt sprache', async () => {
  const { runner, aufrufe } = await start('sprache', { sprache: { agent: { an: true }, sprechen: { quittungMs: 0 } } });
  try {
    const id = await runner.spracheAgent();
    await runner.sende(id, 'Wie spät ist es?', { kanal: 'sprache' });
    await bis(() => aufrufe.length >= 1, { was: 'Anfrage des Sprachgesprächs' });
    assert.equal(aufrufe[0].kopf, 'sprache');
  } finally {
    await runner.close().catch(() => {});
  }
});
