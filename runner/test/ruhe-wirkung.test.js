/**
 * Wirkung des Ruhe-Schalters im echten Runner (Faux-Modell, SQLite im Temp-Ordner, simulierter Hub):
 * Server (Token, `von`, Ereignis, 423), Takt, Eingang (Besitzer läuft weiter, `tief` hält an), Neustart,
 * Steuerkanal, Egress. Die Einheiten des Schalters selbst stehen in ruhe.test.js.
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
import { Freigaben, Wartend } from '../src/documents.js';
import { Egress } from '../src/egress.js';
import { Ingress } from '../src/ingress.js';
import { jobWerkzeuge } from '../src/jobs.js';
import { Ruhe } from '../src/ruhe.js';
import { Runner } from '../src/runner.js';
import { erstelleServer } from '../src/server.js';
import { Spielmodus } from '../src/spielmodus.js';
import { erstelleSteuerkanal } from '../src/steuerkanal.js';
import { Taktgeber } from '../src/takt.js';

const CTX = BACKGROUND_CONTEXT;
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
const stumm = () => {};
const TOKEN = 'test-token-test-token-test-token-00';
const HUB_TOKEN = 'hub-token-hub-token-hub-token-0000';

async function bis(fn, { ms = 15000, schritt = 100, was = 'Bedingung' } = {}) {
  const ende = Date.now() + ms;
  let letzter;
  while (Date.now() < ende) {
    try {
      const wert = await fn();
      if (wert) return wert;
    } catch (fehler) {
      letzter = fehler;
    }
    await warte(schritt);
  }
  throw new Error(`Zeit abgelaufen: ${was}${letzter ? ` (${letzter.message})` : ''}`);
}

const tmp = mkdtempSync(join(tmpdir(), 'ruhe-wirkung-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function baue(name, extra = {}, oben = {}) {
  const cfg = konfigurationLaden(
    {
      hub: 'http://hub.test',
      agent: 'persona',
      arbeitsbereiche: { standard: { pfad: tmp, titel: 'Test' } },
      pi_durable: {
        storage: join(tmp, name, 'fyos.sqlite'),
        security: { token: TOKEN, tokens: { hub: HUB_TOKEN } },
        proactive: { enabled: true, pollSeconds: 3 },
        egress: { enabled: false },
        browser: { enabled: false },
        desktop: { enabled: false },
        ...extra,
      },
      spielmodus: [],
      ...oben,
    },
    {},
  );
  const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: [{ id: 'hausmodell' }, { id: 'hausmodell-max' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  return { cfg, faux, models };
}

function fakeHub(eintraege = []) {
  let offen = [...eintraege];
  return {
    aufrufe: [],
    async aufrufen(werkzeug, argumente) {
      this.aufrufe.push({ werkzeug, argumente });
      return { ok: true, result: { darf: true, warum: 'frei' } };
    },
    melden: async () => ({ ok: true }),
    bereicheMelden: async () => ({ ok: true }),
    gesundheit: async () => ({ ok: true }),
    suchen: async () => [],
    schema: async () => ({}),
    async eingangLesen(nach) {
      if (offen.length) {
        const e = offen;
        offen = [];
        return { eintraege: e, letzte: e.at(-1).id };
      }
      await warte(150);
      return { eintraege: [], letzte: nach };
    },
  };
}

function mitProtokoll(faux, anzahl) {
  const gesehen = [];
  faux.setResponses(
    Array.from({ length: anzahl }, () => (context) => {
      const letzte = [...context.messages].reverse().find((m) => m.role === 'user');
      const text = JSON.stringify(letzte?.content ?? '');
      gesehen.push(text);
      return fauxAssistantMessage(`ok:${/hg\d|max\d/.exec(text)?.[0] ?? 'x'}`);
    }),
  );
  return gesehen;
}

async function serverStarten(runner, cfg) {
  const server = erstelleServer({ runner, cfg });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const basis = `http://127.0.0.1:${server.address().port}`;
  const post = (pfad, body, token = TOKEN) =>
    fetch(`${basis}${pfad}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  const get = (pfad, token = TOKEN) => fetch(`${basis}${pfad}`, { headers: { Authorization: `Bearer ${token}` } });
  return { server, basis, post, get, zu: () => new Promise((r) => server.close(r)) };
}

test('Server: Lesen und Schreiben brauchen den Token, `von` kommt aus dem Token, nicht aus dem Rumpf', async () => {
  const { cfg, models } = baue('server');
  const runner = new Runner(cfg, { models, hub: fakeHub() });
  await runner.start();
  const s = await serverStarten(runner, cfg);
  try {
    assert.equal((await fetch(`${s.basis}/api/ruhe`)).status, 401);
    assert.equal((await fetch(`${s.basis}/api/ruhe`, { method: 'POST', body: '{"an":true}' })).status, 401);
    assert.equal((await s.post('/api/ruhe', { an: true }, 'falsch')).status, 401);
    assert.equal(runner.ruhe.pausiert(), false, 'ohne Token ändert sich nichts');

    const aus = await (await s.get('/api/ruhe')).json();
    assert.equal(aus.ok, true);
    assert.equal(aus.ruhe.ruhe, false);
    assert.equal(aus.pausiert, false);
    assert.equal(aus.spielmodus, null);

    const an = await (await s.post('/api/ruhe', { an: true, grund: 'Feierabend', von: 'angreifer', stufe: 'normal' })).json();
    assert.equal(an.ok, true);
    assert.equal(an.ruhe.von, 'app', 'der Token nennt den Absender');
    assert.equal(an.ruhe.grund, 'Feierabend');
    assert.equal(an.pausiert, true);

    const vomHub = await (await s.post('/api/ruhe', { an: true, grund: 'vom Hub', von: 'app' }, HUB_TOKEN)).json();
    assert.equal(vomHub.ruhe.von, 'hub', 'weitere Token tragen ihren Namen');
    assert.equal((await s.get('/api/ruhe', HUB_TOKEN)).status, 200);

    // Health und Zustand tragen ruhe, pausiert, spielmodus.
    const health = await (await s.get('/api/health')).json();
    assert.equal(health.ruhe.ruhe, true);
    assert.equal(health.ruhe.von, 'hub');
    assert.equal(health.pausiert, true);
    assert.equal(health.spielmodus, null);
    const zustand = await (await s.get('/api/zustand')).json();
    assert.equal(zustand.pausiert, true);
    assert.equal(zustand.ruhe.quelle, 'schalter');
    assert.ok(zustand.zustand, 'der geteilte Zustand bleibt unverändert');

    // Falsche Eingaben: 400, nichts ändert sich.
    assert.equal((await s.post('/api/ruhe', {})).status, 400);
    assert.equal((await s.post('/api/ruhe', { an: true, stufe: 'laut' })).status, 400);
    assert.equal((await s.post('/api/ruhe', { an: true, bis: '2020-01-01T00:00:00Z' })).status, 400);
    assert.equal(runner.ruhe.zustand().grund, 'vom Hub');

    const weg = await (await s.post('/api/ruhe', { an: false })).json();
    assert.equal(weg.ruhe.ruhe, false);
    assert.equal(weg.ruhe.geweckt, true);
    assert.equal(weg.pausiert, false);
  } finally {
    await s.zu();
    await runner.close().catch(() => {});
  }
});

test('Server: Ereignis `ruhe` im Strom, Spielmodus geht vor, tiefe Ruhe antwortet 423', async () => {
  let marke = false;
  const { cfg, faux, models } = baue('strom');
  faux.setResponses([fauxAssistantMessage('Moin')]);
  const runner = new Runner(cfg, { models, hub: fakeHub() });
  runner.spielmodus.existiert = () => marke;
  runner.spielmodus.pfade = ['/x/spielmodus.kid'];
  await runner.start();
  const s = await serverStarten(runner, cfg);
  const root = (await runner.gespraeche()).find((g) => g.art === 'root');
  const ereignisse = [];
  const strom = await s.get('/api/strom');
  const leser = strom.body.getReader();
  const lesen = (async () => {
    const dek = new TextDecoder();
    let puffer = '';
    for (;;) {
      const { done, value } = await leser.read().catch(() => ({ done: true }));
      if (done) return;
      puffer += dek.decode(value, { stream: true });
      let i;
      while ((i = puffer.indexOf('\n\n')) >= 0) {
        const block = puffer.slice(0, i);
        puffer = puffer.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const daten = /^data: (.+)$/m.exec(block)?.[1];
        if (ev && daten) ereignisse.push([ev, JSON.parse(daten)]);
      }
    }
  })();
  try {
    const hallo = await bis(() => ereignisse.find(([e]) => e === 'hallo'), { was: 'hallo' });
    assert.equal(hallo[1].ruhe.ruhe, false, 'der Strom beginnt mit dem Stand');
    assert.equal(hallo[1].pausiert, false);

    await s.post('/api/ruhe', { an: true, stufe: 'tief', grund: 'Test' });
    const e1 = await bis(() => ereignisse.find(([e, d]) => e === 'ruhe' && d.ruhe.ruhe === true), { was: 'Ereignis ruhe an' });
    assert.equal(e1[1].art, 'an');
    assert.equal(e1[1].pausiert, true);
    assert.equal(e1[1].ruhe.stufe, 'tief');

    // Tief: Nachrichten an Persona werden mit 423 abgewiesen, Lesen geht weiter.
    const abgewiesen = await s.post(`/api/gespraech/${root.id}/nachricht`, { text: 'Hallo' });
    assert.equal(abgewiesen.status, 423);
    assert.equal((await s.get(`/api/gespraech/${root.id}`)).status, 200);

    // Normal: Besitzer' Nachricht wird bearbeitet.
    await s.post('/api/ruhe', { an: true, stufe: 'normal' });
    assert.equal((await s.post(`/api/gespraech/${root.id}/nachricht`, { text: 'Hallo' })).status, 200);

    // Der Spielmodus liegt davor: „aus“ weckt nicht, und der Wechsel der Marke kommt als Ereignis.
    marke = true;
    runner.ruhe.pruefen();
    await bis(() => ereignisse.find(([e, d]) => e === 'ruhe' && d.spielmodus === 'spielmodus.kid'), { was: 'Ereignis Spielmodus' });
    const aus = await (await s.post('/api/ruhe', { an: false })).json();
    assert.equal(aus.pausiert, true);
    assert.equal(aus.ruhe.geweckt, false);
    assert.match(aus.ruhe.hinweis, /Spielmodus/);
    marke = false;
    runner.ruhe.pruefen();
    const ende = await bis(() => ereignisse.filter(([e, d]) => e === 'ruhe' && d.pausiert === false).at(-1), { was: 'Ereignis Ende' });
    assert.equal(ende[1].ruhe.ruhe, false);
  } finally {
    await leser.cancel().catch(() => {});
    await lesen.catch(() => {});
    await s.zu();
    await runner.close().catch(() => {});
  }
});

test('sofort bricht den Zug im Hauptgespräch und laufende Läufe ab, ohne sofort nicht', async () => {
  const { cfg, models } = baue('sofort');
  const runner = new Runner(cfg, { models, hub: fakeHub() });
  await runner.start();
  const abgebrochen = [];
  runner.abbrechen = async (id) => abgebrochen.push(`g${id}`);
  runner.laeufe = async () => [
    { id: 5, status: 'laeuft' },
    { id: 6, status: 'abgeschlossen' },
  ];
  runner.laufAbbrechen = async (id) => abgebrochen.push(`l${id}`);
  try {
    await runner.ruheSetzen({ an: true }, 'app');
    assert.deepEqual(abgebrochen, [], 'Standard: läuft zu Ende');
    const r = await runner.ruheSetzen({ an: true, sofort: true }, 'app');
    assert.deepEqual(abgebrochen, [`g${runner.root.id}`, 'l5']);
    assert.deepEqual(r.angehalten, [`gespraech:${runner.root.id}`, 'lauf:5']);
    assert.equal(r.ruhe.sofort, true);
    abgebrochen.length = 0;
    await runner.ruheSetzen({ an: false, sofort: true }, 'app');
    assert.deepEqual(abgebrochen, [], '„aus“ bricht nichts ab');
  } finally {
    await runner.close().catch(() => {});
  }
});

test('Takt steht in Ruhe und im Spielmodus und löst danach wieder aus', async () => {
  const { cfg, models } = baue('takt');
  const runner = new Runner(cfg, { models, hub: fakeHub() });
  await runner.start();
  let t = Date.UTC(2026, 9, 24, 5, 31); // 24.10. 07:31 Berlin, ein Minute nach dem Morgen-Takt
  let marke = false;
  const spielmodus = new Spielmodus(['/x/spielmodus.kid'], { existiert: () => marke, lesen: () => { throw new Error('x'); }, log: stumm });
  const ruhe = new Ruhe({ spielmodus, log: stumm, jetzt: () => t });
  const hub = { aufrufe: [], aufrufen: async (w) => (hub.aufrufe.push(w), { ok: true, result: { darf: true, warum: 'frei' } }) };
  const eingereiht = [];
  const takt = new Taktgeber({
    cfg: { takt: { zone: 'Europe/Berlin', fragen_alle_s: 120, eintraege: [{ id: 'morgen', um: '07:30', fenster_min: 120, schleife: 'arbeit', art: 'melden', text: 'Morgen-Takt' }] } },
    hub,
    harness: runner.harness,
    einreihen: async (e) => void eingereiht.push(e),
    log: { info: stumm, warn: stumm },
    jetzt: () => t,
    ruhe,
  });
  try {
    ruhe.setzen({ an: true, grund: 'Feierabend', von: 'app' });
    assert.deepEqual(await takt.runde(), []);
    assert.equal(eingereiht.length, 0);
    assert.equal(hub.aufrufe.length, 0, 'in der Ruhe wird nicht einmal das Tor gefragt');
    assert.match(takt.zustand().eintraege[0].warum, /^Ruhe: Feierabend/);

    ruhe.setzen({ an: false, von: 'app' });
    marke = true;
    t += 3 * 60_000;
    assert.deepEqual(await takt.runde(), []);
    assert.match(takt.zustand().eintraege[0].warum, /Spielmodus/);
    assert.equal(eingereiht.length, 0);

    marke = false;
    t += 3 * 60_000;
    assert.equal((await takt.runde()).length, 1, 'nach der Ruhe kommt der Takt noch im Fenster');
    assert.equal(eingereiht.length, 1);
  } finally {
    await runner.close().catch(() => {});
  }
});

test('Eingang: Ruhe lässt Besitzer durch und hält Hintergrund, tief hält alles, danach läuft alles in Ordnung', async () => {
  const { cfg, faux, models } = baue('eingang');
  const gesehen = mitProtokoll(faux, 6);
  const hub = fakeHub([
    { id: '1-0', text: 'hg1', klasse: 'hintergrund', quelle: 'itsm' },
    { id: '2-0', text: 'max1', klasse: 'max', quelle: 'web' },
    { id: '3-0', text: JSON.stringify({ id: 'gibt-es-nicht', entscheidung: 'erteilt' }), klasse: 'max', quelle: 'web', von: 'app-freigabe' },
  ]);
  const runner = new Runner(cfg, { models, hub });
  await runner.start();
  runner.ruhe.setzen({ an: true, stufe: 'tief', von: 'app' });
  const fehler = [];
  const ingress = new Ingress({ cfg, runner, hub, spielmodus: new Spielmodus([]), tor: { offen: true }, onFehler: (f) => fehler.push(f.message) });
  await ingress.start();
  try {
    await bis(async () => (await runner.harness.snapshot(Wartend, CTX)).eintraege.length >= 2, { was: 'Eingänge angenommen' });
    // Die Freigabe-Entscheidung geht auch in der tiefen Ruhe durch (sie erreicht den Agenten nie) …
    await bis(async () => (await runner.harness.snapshot(Wartend, CTX)).eintraege.every((e) => e.stromId !== '3-0'), { was: 'Entscheidung angenommen' });
    assert.ok(fehler.some((m) => /Freigabe-Entscheidung/.test(m)), 'sie wurde angewendet (hier: unbekannte Id)');
    // … alles andere wartet, auch Besitzer.
    await warte(2500);
    assert.equal(gesehen.length, 0, 'tief: nichts geht an den Agenten');
    assert.equal((await runner.harness.snapshot(Wartend, CTX)).eintraege.length, 2);

    // Normale Ruhe: Besitzer läuft weiter, die Hintergrundarbeit bleibt liegen.
    runner.ruhe.setzen({ an: true, stufe: 'normal', von: 'app' });
    ingress.anstossen();
    await bis(() => gesehen.length === 1, { was: 'Besitzer bearbeitet' });
    assert.match(gesehen[0], /max1/);
    await warte(2500);
    assert.equal(gesehen.length, 1, 'der Hintergrund-Eintrag bleibt in der Ruhe liegen');
    assert.equal((await runner.harness.snapshot(Wartend, CTX)).eintraege.length, 1);
    // Eine neue Besitzer-Nachricht in der Ruhe geht vor dem liegenden Hintergrund durch.
    await ingress.einreihen({ id: 'm2', text: 'max2', klasse: 'max', quelle: 'web' });
    await bis(() => gesehen.length === 2, { was: 'zweite Besitzer-Nachricht' });
    assert.match(gesehen[1], /max2/);

    // Ruhe aus: der liegen gebliebene Eintrag läuft, nichts ging verloren.
    runner.ruhe.setzen({ an: false, von: 'app' });
    await bis(() => gesehen.length === 3, { was: 'Hintergrund nach der Ruhe' });
    assert.match(gesehen[2], /hg1/);
  } finally {
    await ingress.stop();
    await runner.close().catch(() => {});
  }
});

test('Hintergrundjobs starten in der Ruhe nicht (sperre des Schalters)', async () => {
  const ordner = mkdtempSync(join(tmp, 'jobs-'));
  const ruhe = new Ruhe({ log: stumm });
  const cfg = { arbeitsbereiche: { standard: { pfad: ordner } } };
  const env = { PATH: process.env.PATH, FYOS_HINTERGRUND_DIR: ordner, FYOS_HINTERGRUND_FRIST_MIN: '1', FYOS_HINTERGRUND_GNADE_S: '0' };
  const werkzeuge = jobWerkzeuge({ cfg, env, log: stumm, spielmodus: ruhe.sperre });
  const api = { memo: async (_k, v) => v };
  ruhe.setzen({ an: true, von: 'app' });
  await assert.rejects(werkzeuge[0].execute({ befehl: 'true' }, api, {}), /Ruhe an: es starten keine neuen Jobs/);
  ruhe.setzen({ an: false, von: 'app' });
  const ok = await werkzeuge[0].execute({ befehl: 'true' }, api, {});
  assert.match(ok.output[0].text, /Gestartet als j/, 'nach der Ruhe starten Jobs wieder');
});

test('Neustart: die Ruhe bleibt, samt Absender und Ende', async () => {
  const { cfg, models } = baue('neustart');
  let runner = new Runner(cfg, { models, hub: fakeHub() });
  await runner.start();
  const bisZeit = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  await runner.ruheSetzen({ an: true, bis: bisZeit, grund: 'bis heute Abend', stufe: 'normal' }, 'app');
  await runner.close().catch(() => {});

  runner = new Runner(cfg, { models, hub: fakeHub() });
  await runner.start();
  try {
    const z = runner.ruhe.zustand();
    assert.equal(z.ruhe, true);
    assert.equal(z.pausiert, true);
    assert.equal(z.von, 'app');
    assert.equal(z.grund, 'bis heute Abend');
    assert.equal(z.bis, bisZeit);
    assert.equal(runner.ruhe.eingang(), 'nurMax');
    assert.equal((await runner.health()).pausiert, true);
  } finally {
    await runner.close().catch(() => {});
  }
});

test('Steuerkanal: /zustand trägt die Ruhe, POST /ruhe schaltet mit von=steuer', async () => {
  const { cfg, models } = baue('steuer');
  const runner = new Runner(cfg, { models, hub: fakeHub() });
  await runner.start();
  const kanal = erstelleSteuerkanal({ cfg: { ...cfg, steuer: { host: '127.0.0.1', port: 0 } }, runner, log: stumm });
  const { port } = await kanal.starten();
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  try {
    assert.equal((await (await fetch(url('/zustand'))).json()).ruhe.ruhe, false);
    const an = await (await fetch(url('/ruhe'), { method: 'POST', body: JSON.stringify({ an: true, grund: 'Wartung', von: 'jemand' }) })).json();
    assert.equal(an.ok, true);
    assert.equal(an.ruhe.von, 'steuer');
    assert.equal((await (await fetch(url('/zustand'))).json()).ruhe.grund, 'Wartung');
    const falsch = await fetch(url('/ruhe'), { method: 'POST', body: JSON.stringify({ an: 'vielleicht' }) });
    assert.equal(falsch.status, 400);
    assert.match((await falsch.json()).error, /true oder false/);
    const aus = await (await fetch(url('/ruhe'), { method: 'POST', body: JSON.stringify({ an: false }) })).json();
    assert.equal(aus.ruhe.ruhe, false);
  } finally {
    await kanal.beenden();
    await runner.close().catch(() => {});
  }
});

test('Egress: Erinnerungen an Freigaben sind in der Ruhe gedämpft, hohes Risiko bleibt; Ruhe-Ereignis nur auf Wunsch', async () => {
  const gemeldet = [];
  const freigaben = {
    eintraege: {
      a: { id: 'a', status: 'offen', conversationId: 1, risiko: 'low', aktion: 'Kleines' },
      b: { id: 'b', status: 'offen', conversationId: 1, risiko: 'high', aktion: 'Großes', zerstoererisch: true },
    },
  };
  const harness = {
    snapshot: async (token) => (token === Freigaben ? freigaben : undefined),
    commit: async (fn) => fn({ doc: async () => ({ sequenzen: {} }) }),
  };
  const hub = { melden: async (stueck) => void gemeldet.push(...stueck) };
  const ruhe = new Ruhe({ log: stumm });
  const cfg = (extra = {}) => ({ agent: 'persona', pi_durable: { egress: { enabled: true, flushMs: 600, maxBuffer: 100, ...extra } } });

  const egress = new Egress({ cfg: cfg(), harness, hub, ruhe, onFehler: stumm });
  await egress.freigabenErinnern();
  assert.deepEqual(gemeldet.map((e) => e.id).sort(), ['a', 'b'], 'ohne Ruhe erinnert er an beide');

  gemeldet.length = 0;
  ruhe.setzen({ an: true, von: 'app' });
  await egress.freigabenErinnern();
  assert.deepEqual(gemeldet.map((e) => e.id), ['b'], 'in der Ruhe nur noch hohes Risiko');

  // Ruhe-Ereignis: ohne `ruheMelden` kein Ereignis (der Hub kennt den Typ vielleicht noch nicht).
  gemeldet.length = 0;
  egress.aktiv = true;
  assert.equal(egress.meldeRuhe(1, ruhe.zustand()), false);
  const an = new Egress({ cfg: cfg({ ruheMelden: true }), harness, hub, ruhe, onFehler: stumm });
  an.aktiv = true;
  assert.equal(an.meldeRuhe(1, ruhe.zustand()), true);
  await bis(() => gemeldet.length === 1, { was: 'Ereignis im Ausgang' });
  assert.equal(gemeldet[0].typ, 'ruhe');
  assert.equal(gemeldet[0].an, '1');
  assert.equal(gemeldet[0].pausiert, '1');
  assert.equal(gemeldet[0].von, 'app');
  assert.equal(gemeldet[0].agent, 'persona');
});
