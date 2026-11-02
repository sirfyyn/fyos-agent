/**
 * Der Sprachkanal gegen den echten Runner (pi-durable + SQLite) mit Faux-Modell und Attrappen: Weg von der Äußerung über das
 * Gespräch bis zu den `sprechen`-Ereignissen, HTTP-Wege, SSE. Es wird nichts gesprochen, aufgenommen oder ins Netz geschickt.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { konfigurationLaden } from '../src/config.js';
import { Runner } from '../src/runner.js';
import { erstelleServer } from '../src/server.js';
import { Sprache } from '../src/sprache.js';

const CTX = BACKGROUND_CONTEXT;
void CTX;
const TOKEN = 'test-token-test-token-test-token-00';
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), 'sprache-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

async function bis(fn, { ms = 15000, schritt = 50, was = 'Bedingung' } = {}) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    const w = await fn();
    if (w) return w;
    await warte(schritt);
  }
  throw new Error(`Zeit abgelaufen: ${was}`);
}

const fakeHub = () => ({
  aufrufen: async () => ({ ok: true, result: {} }),
  melden: async () => ({ ok: true }),
  bereicheMelden: async () => ({ ok: true }),
  gesundheit: async () => ({ ok: true }),
  suchen: async () => [],
  schema: async () => ({}),
  eingangLesen: async (nach) => (await warte(150), { eintraege: [], letzte: nach }),
});

async function aufbauen(name) {
  const cfg = konfigurationLaden(
    {
      hub: 'http://hub.test',
      agent: 'persona',
      arbeitsbereiche: { standard: { pfad: tmp, titel: 'Test' } },
      sprache: { sprechen: { quittungMs: 0 } },
      pi_durable: {
        storage: join(tmp, name, 'fyos.sqlite'),
        security: { token: TOKEN },
        proactive: { enabled: false },
        egress: { enabled: false },
        browser: { enabled: false },
        desktop: { enabled: false },
      },
    },
    {},
  );
  const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: [{ id: 'hausmodell' }, { id: 'hausmodell-max' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runner = new Runner(cfg, { models, hub: fakeHub() });
  await runner.start();
  const sprache = new Sprache({ cfg, runner, log: () => {} });
  const server = erstelleServer({ runner, cfg, sprache });
  await new Promise((fertig) => server.listen(0, '127.0.0.1', fertig));
  const basis = `http://127.0.0.1:${server.address().port}`;
  const api = async (methode, pfad, body) => {
    const r = await fetch(basis + pfad, {
      method: methode,
      headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, daten: await r.json() };
  };
  const zu = async () => {
    await sprache.stop();
    await new Promise((f) => server.close(() => f()));
    await runner.close();
  };
  return { cfg, faux, runner, sprache, server, basis, api, zu };
}

test('Sprachkanal im echten Runner: Äußerung → Zug → sprechen-Ereignisse; Verlauf trägt Kanal, aber nicht das Profil', async () => {
  const t = await aufbauen('weg');
  try {
    const ev = [];
    t.sprache.beiEreignis((e) => ev.push(e));
    t.faux.setResponses([fauxAssistantMessage('Es ist halb drei. Hausmodell schläft noch, aber alles andere läuft.')]);

    assert.equal((await t.api('POST', '/api/sprache/aeusserung', { text: 'Wie spät?' })).status, 409, 'ohne Sitzung nicht');
    assert.equal((await t.api('POST', '/api/sprache/ausgabe', { client: 'iphone', route: 'airpods', geraet: 'Besitzer’ AirPods Pro' })).daten.airpods_aktiv, true);
    assert.equal((await t.api('POST', '/api/sprache/sitzung', { an: true, client: 'iphone', mikrofon: 'an' })).status, 200);
    const r = await t.api('POST', '/api/sprache/aeusserung', { text: 'Wie spät ist es?', client: 'iphone' });
    assert.equal(r.status, 200);
    assert.equal(r.daten.weg, 'modell');

    await bis(() => ev.some((e) => e.typ === 'sprechen.ende'), { was: 'sprechen.ende' });
    const gesprochen = ev.filter((e) => e.typ === 'sprechen').map((e) => e.text);
    assert.deepEqual(gesprochen, ['Es ist halb drei.', 'Hausmodell schläft noch, aber alles andere läuft.']);
    assert.ok(ev.filter((e) => e.typ === 'sprechen').every((e) => e.ziel === 'iphone' && e.zug === r.daten.zug));
    assert.equal(ev.at(-1).typ, 'sprechen.ende');
    assert.equal(ev.at(-1).vollstaendig, true);

    const ansicht = await t.runner.ansicht(t.runner.root.id);
    const mensch = ansicht.entries.find((e) => e.kind === 'fyos.mensch');
    assert.equal(mensch.data.text, 'Wie spät ist es?');
    assert.equal(mensch.data.kanal, 'sprache');
    const modellText = JSON.stringify(mensch.model);
    assert.match(modellText, /Kanal: Sprache/, 'das Modell bekommt das Sprachprofil');
    assert.doesNotMatch(JSON.stringify(mensch.data), /Kanal: Sprache/, 'der Eintrag nicht');

    const z = await t.api('GET', '/api/sprache');
    assert.equal(z.daten.sprache.zug.status, 'fertig');
    assert.equal(z.daten.sprache.ausgabe.airpods_aktiv, true);
  } finally {
    await t.zu();
  }
});

test('Ohne AirPods antwortet der echte Runner nur als Mitteilung', async () => {
  const t = await aufbauen('stumm');
  try {
    const ev = [];
    t.sprache.beiEreignis((e) => ev.push(e));
    t.faux.setResponses([fauxAssistantMessage('Das geht nur als Text.')]);
    await t.api('POST', '/api/sprache/ausgabe', { client: 'mac', route: 'andere', geraet: 'MacBook-Lautsprecher' });
    await t.api('POST', '/api/sprache/sitzung', { an: true, client: 'mac' });
    await t.api('POST', `/api/gespraech/${t.runner.root.id}/nachricht`, { text: 'Sag was', kanal: 'sprache', client: 'mac' });
    await bis(() => ev.some((e) => e.typ === 'mitteilung'), { was: 'Mitteilung' });
    assert.equal(ev.filter((e) => e.typ === 'sprechen').length, 0);
    assert.equal(ev.find((e) => e.typ === 'mitteilung').text, 'Das geht nur als Text.');
  } finally {
    await t.zu();
  }
});

test('HTTP: Fehler tragen ihren Status; SSE liefert hallo und Ereignisse, gefiltert nach Client', async () => {
  const t = await aufbauen('http');
  try {
    assert.equal((await t.api('POST', '/api/sprache/ausgabe', { route: 'lautsprecher' })).status, 400);
    assert.equal((await t.api('POST', '/api/sprache/nichts', {})).status, 404);
    assert.equal((await t.api('POST', '/api/sprache/entscheidung', { freigabeId: 'x', entscheidung: 'erteilt' })).status, 403);
    assert.equal((await t.api('POST', '/api/sprache/proaktiv', { text: '' })).status, 400);

    const ctl = new AbortController();
    const r = await fetch(`${t.basis}/api/sprache/ereignisse?client=iphone`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: ctl.signal });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/event-stream/);
    const leser = r.body.getReader();
    const dec = new TextDecoder();
    let text = '';
    const lesen = (async () => {
      for (;;) {
        const { value, done } = await leser.read().catch(() => ({ done: true }));
        if (done) return;
        text += dec.decode(value);
      }
    })();
    await bis(() => text.includes('event: hallo'), { was: 'hallo' });
    await t.api('POST', '/api/sprache/ausgabe', { client: 'iphone', route: 'airpods', geraet: 'AirPods' });
    await t.api('POST', '/api/sprache/sitzung', { an: true, client: 'iphone' });
    await bis(() => text.includes('event: sitzung'), { was: 'sitzung' });
    assert.match(text, /event: ausgabe\ndata: \{[^\n]*"airpods_aktiv":true/);
    assert.match(text, /\nid: \d+\n/);

    // Ein Ereignis für den Mac kommt beim iPhone nicht an; eines für das iPhone schon.
    t.sprache.ausgabeMelden({ client: 'mac', route: 'airpods', geraet: 'AirPods', aktiv_s: 0 });
    t.sprache.schnellweg = async () => ({ text: 'Gern.' });
    await t.api('POST', '/api/sprache/aeusserung', { text: 'Danke', client: 'mac' });
    await t.api('POST', '/api/sprache/aeusserung', { text: 'Danke noch mal', client: 'iphone' });
    await bis(() => /event: sprechen\n/.test(text), { was: 'sprechen' });
    const fuerIphone = [...text.matchAll(/event: sprechen\ndata: (\{[^\n]*\})/g)].map((m) => JSON.parse(m[1]));
    assert.ok(fuerIphone.length >= 1 && fuerIphone.every((e) => e.ziel === 'iphone'), JSON.stringify(fuerIphone.map((e) => e.ziel)));
    ctl.abort();
    await lesen;
  } finally {
    await t.zu();
  }
});
