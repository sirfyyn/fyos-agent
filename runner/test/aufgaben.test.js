/**
 * Hub-Aufgaben im Runner (MCP Tasks, docs/current/MCP-TASKS.md): Hub-Client gegen einen Attrappen-Server, Wächter und
 * Werkzeuge mit Faux-Modell und Attrappen-Hub, Neustart-Festigkeit. Kein echter Hub, kein Hauptserver, kein Hausmodell.
 *
 *   node --test --test-timeout=120000 "test/aufgaben.test.js"
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT as CTX } from '@earendil-works/chord/context';
import { konfigurationLaden } from '../src/config.js';
import { HubAufgaben, neueHubAufgabe } from '../src/documents.js';
import { Hub, HubFehler } from '../src/hub.js';
import { Runner } from '../src/runner.js';
import { AufgabenWaechter, abstand, eingangsText, FEHLER_GRENZE_MS } from '../src/aufgaben.js';

const warten = async (bedingung, ms = 15000) => {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    const wert = await bedingung();
    if (wert) return wert;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('Zeit abgelaufen');
};

const aufraeumen = [];
after(() => {
  for (const d of aufraeumen) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'fyos-aufgaben-'));
  aufraeumen.push(d);
  return d;
};

describe('Hub-Client', () => {
  /** Ein Attrappen-Hub über echtes HTTP: merkt sich die Körper, antwortet nach Skript. */
  async function attrappe(handler) {
    const gesehen = [];
    const server = createServer((req, res) => {
      let roh = '';
      req.on('data', (c) => (roh += c));
      req.on('end', () => {
        const body = roh ? JSON.parse(roh) : null;
        gesehen.push({ pfad: req.url, body });
        const [status, antwort] = handler(req.url, body);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(antwort));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const hub = new Hub({ url: `http://127.0.0.1:${server.address().port}` });
    return { hub, gesehen, ende: () => new Promise((r) => server.close(r)) };
  }

  test('ohne aufgabe erklärt der Runner die Erweiterung nicht', async () => {
    const a = await attrappe(() => [200, { ok: true, result: { x: 1 } }]);
    const r = await a.hub.aufrufen('echo.say', {});
    assert.equal(r.ok, true);
    assert.deepEqual(r.result, { x: 1 });
    assert.equal('aufgabe' in a.gesehen[0].body, false);
    await a.ende();
  });

  test('mit aufgabe erklärt er sie und erkennt resultType task', async () => {
    const task = { ok: true, resultType: 'task', taskId: 'T1', status: 'working', ttlMs: 3600000, pollIntervalMs: 2000 };
    const a = await attrappe(() => [202, task]);
    const r = await a.hub.aufrufen('medien.bild', { prompt: 'x' }, { aufgabe: true });
    assert.equal(a.gesehen[0].body.aufgabe, true);
    assert.equal(r.ok, true);
    assert.equal(r.aufgabe.taskId, 'T1');
    assert.equal(r.aufgabe.pollIntervalMs, 2000);
    assert.equal('result' in r, false);
    await a.ende();
  });

  test('mit aufgabe, aber nicht Task-fähig: das Ergebnis kommt wie gewohnt', async () => {
    const a = await attrappe(() => [200, { ok: true, result: { schnell: true } }]);
    const r = await a.hub.aufrufen('echo.say', {}, { aufgabe: true });
    assert.deepEqual(r.result, { schnell: true });
    assert.equal(r.aufgabe, undefined);
    await a.ende();
  });

  test('Stand, Abbruch, Antworten gehen an die Aufgaben-Routen; 404 ist ein HubFehler mit status', async () => {
    const a = await attrappe((pfad) =>
      pfad.endsWith('/get') ? [200, { ok: true, resultType: 'complete', taskId: 'T1', status: 'working' }] : pfad.endsWith('/nein') ? [404, {}] : [200, { ok: true }],
    );
    const s = await a.hub.aufgabeStand('T1');
    assert.equal(s.status, 'working');
    assert.equal('ok' in s, false);
    await a.hub.aufgabeAbbrechen('T1');
    await a.hub.aufgabeAntworten('T1', { k: { action: 'accept' } });
    assert.deepEqual(
      a.gesehen.map((g) => g.pfad),
      ['/hub/aufgaben/get', '/hub/aufgaben/cancel', '/hub/aufgaben/update'],
    );
    assert.deepEqual(a.gesehen[2].body, { taskId: 'T1', inputResponses: { k: { action: 'accept' } } });
    await a.ende();

    const b = await attrappe(() => [404, { ok: false, error: 'Aufgabe nicht gefunden' }]);
    await assert.rejects(b.hub.aufgabeStand('X'), (e) => e instanceof HubFehler && e.status === 404);
    await b.ende();
  });
});

describe('eingangsText', () => {
  const e = { taskId: 'T1', werkzeug: 'medien.bild' };
  test('fertig, Werkzeugfehler, failed, cancelled, input_required, verloren', () => {
    assert.match(eingangsText(e, { status: 'completed', result: { ok: true, result: { datei: 'a.png' } } }), /fertig[\s\S]*a\.png/);
    assert.match(eingangsText(e, { status: 'completed', result: { ok: false, error: 'GPU belegt' } }), /meldet aber einen Fehler: GPU belegt/);
    assert.match(eingangsText(e, { status: 'failed', error: { message: 'Hub neu gestartet' } }), /fehlgeschlagen: Hub neu gestartet/);
    assert.match(eingangsText(e, { status: 'cancelled' }), /abgebrochen/);
    const t = eingangsText(e, {
      status: 'input_required',
      inputRequests: { ok: { method: 'elicitation/create', params: { message: 'Weiter?', requestedSchema: { type: 'object' } } } },
    });
    assert.match(t, /- ok: Weiter\?/);
    assert.match(t, /hub_aufgabe\(aktion: "antworten", taskId: "T1"/);
    assert.match(eingangsText(e, { status: 'verloren', grund: 'weg' }), /verloren: weg[\s\S]*ungewiss/);
  });
  test('Abfrageabstand bleibt zwischen 1 und 30 s', () => {
    assert.equal(abstand(10), 1000);
    assert.equal(abstand(2000), 2000);
    assert.equal(abstand(10 ** 7), 30000);
    assert.equal(abstand(undefined), 2000);
  });
});

/** Ein Hub, der nur Aufgaben kennt; `plan` bestimmt, was `aufgabeStand` je Aufruf liefert. */
class AttrappenHub extends Hub {
  constructor(plan = {}) {
    super({ url: 'http://attrappe.invalid' });
    this.plan = plan; // taskId -> Funktion (n) => Antwort | Error
    this.aufrufe = [];
    this.abfragen = {};
  }
  async scope() {
    return 'WRITE';
  }
  async bereicheMelden() {}
  async gesundheit() {
    return { ok: true };
  }
  async aufrufen(tool, argumente, opt = {}) {
    this.aufrufe.push({ tool, argumente, aufgabe: !!opt.aufgabe });
    if (opt.aufgabe) {
      return { ok: true, aufgabe: { taskId: 'T1', status: 'working', ttlMs: 3600000, pollIntervalMs: 1000 } };
    }
    return { ok: true, result: { sync: true } };
  }
  async aufgabeStand(taskId) {
    this.abfragen[taskId] = (this.abfragen[taskId] ?? 0) + 1;
    const r = this.plan[taskId](this.abfragen[taskId]);
    if (r instanceof Error) throw r;
    return r;
  }
}

function neuerRunner(verz, hub, faux) {
  const cfg = konfigurationLaden(
    {
      pi_durable: {
        storage: join(verz, 'fyos.sqlite'),
        proactive: { enabled: false },
        egress: { enabled: false },
        browser: { enabled: false },
        desktop: { enabled: false },
      },
    },
    {},
  );
  const models = createModels();
  models.setProvider(faux.provider);
  return { cfg, runner: new Runner(cfg, { models, hub, speicherDatei: cfg.pi_durable.storage }) };
}

const fauxRhea = () => fauxProvider({ provider: 'hausmodell', models: [{ id: 'hausmodell' }, { id: 'hausmodell-max' }] });

const eintraege = async (runner) => {
  const a = await runner.ansicht(runner.root.id);
  return a.entries ?? [];
};
const art = (e) => e.kind ?? e.type;

describe('Runner mit Faux-Modell und Attrappen-Hub', () => {
  test('hub_aufrufen aufgabe=true beendet den Zug, der Wächter stellt das Ergebnis als Eingang zu — einmal, auch nach Neustart', async () => {
    const verz = tmp();
    const hub = new AttrappenHub({
      T1: (n) =>
        n < 2
          ? { status: 'working', pollIntervalMs: 1000 }
          : { status: 'completed', result: { ok: true, result: { datei: '2026-10-25/abc.png' } }, pollIntervalMs: 1000 },
    });
    const faux = fauxRhea();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('hub_aufrufen', { werkzeug: 'medien.bild', argumente: { prompt: 'Hund' }, aufgabe: true }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Das Bild wird erzeugt; ich melde mich, wenn es fertig ist.'),
      fauxAssistantMessage('Das Bild liegt unter 2026-10-25/abc.png.'),
    ]);
    let { runner } = neuerRunner(verz, hub, faux);
    await runner.start();
    await runner.sende(runner.root.id, 'Mach ein Bild von einem Hund.');

    // Der Zug endet mit dem Vermerk im Dokument, ohne dass der Hub je ein Ergebnis geliefert hat.
    const doc = await warten(async () => {
      const d = await runner.harness.snapshot(HubAufgaben, CTX);
      return d?.eintraege?.T1 ? d : null;
    });
    assert.deepEqual(hub.aufrufe, [{ tool: 'medien.bild', argumente: { prompt: 'Hund' }, aufgabe: true }]);
    assert.equal(doc.eintraege.T1.conversationId, runner.root.id);
    assert.equal(doc.eintraege.T1.zugestellt, false);
    await warten(() => faux.state.callCount >= 2);
    assert.equal(hub.abfragen.T1 ?? 0, 0, 'der Zug hat nicht gepollt');

    // Neustart mitten in der Aufgabe: Runner zu, wieder auf — der Vermerk ist noch da.
    await runner.close();
    ({ runner } = neuerRunner(verz, hub, faux));
    await runner.start();
    const nach = await runner.harness.snapshot(HubAufgaben, CTX);
    assert.equal(nach.eintraege.T1.zugestellt, false);

    let jetzt = Date.now();
    const waechter = new AufgabenWaechter({ runner, hub, cfg: runner.cfg, jetzt: () => jetzt });
    jetzt += 1500;
    await waechter.tick(); // 1. Abfrage: working
    assert.equal(hub.abfragen.T1, 1);
    assert.equal((await runner.harness.snapshot(HubAufgaben, CTX)).eintraege.T1.zugestellt, false);
    jetzt += 1500;
    await waechter.tick(); // 2. Abfrage: completed -> Eingang
    const zugestellt = (await runner.harness.snapshot(HubAufgaben, CTX)).eintraege.T1;
    assert.equal(zugestellt.zugestellt, true);
    assert.equal(zugestellt.status, 'completed');

    // Das Modell hat den Eingang bekommen und geantwortet (dritte Antwort des Faux-Modells).
    await warten(() => faux.state.callCount >= 3);
    const kinds = (await eintraege(runner)).map(art);
    assert.ok(kinds.includes('fyos.aufgabe'), `Eingang fehlt: ${kinds.join(',')}`);
    const eingang = (await eintraege(runner)).find((e) => art(e) === 'fyos.aufgabe');
    assert.equal(eingang.data.bezug, 'T1');
    assert.match(eingang.data.text, /abc\.png/);

    // Noch ein Durchgang: nichts mehr abzufragen, nichts doppelt zuzustellen.
    jetzt += 60_000;
    assert.equal(await waechter.tick(), 0);
    assert.equal(hub.abfragen.T1, 2);
    assert.equal((await eintraege(runner)).filter((e) => art(e) === 'fyos.aufgabe').length, 1);
    await runner.close();
  });

  test('ohne aufgabe=true bleibt hub_aufrufen synchron', async () => {
    const verz = tmp();
    const hub = new AttrappenHub({});
    const faux = fauxRhea();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('hub_aufrufen', { werkzeug: 'medien.bild', argumente: {} }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('fertig'),
    ]);
    const { runner } = neuerRunner(verz, hub, faux);
    await runner.start();
    await runner.sende(runner.root.id, 'bild');
    await warten(() => faux.state.callCount >= 2);
    assert.deepEqual(hub.aufrufe, [{ tool: 'medien.bild', argumente: {}, aufgabe: false }]);
    const d = await runner.harness.snapshot(HubAufgaben, CTX);
    assert.deepEqual(Object.keys(d.eintraege), []);
    await runner.close();
  });

  test('Hub-Fehler halten den Wächter nicht an; nach 20 Minuten gilt die Aufgabe als verloren (einmal gemeldet)', async () => {
    const verz = tmp();
    let weg = true;
    const hub = new AttrappenHub({
      T9: () => (weg ? new HubFehler('Hub nicht erreichbar', { art: 'netz' }) : { status: 'working', pollIntervalMs: 1000 }),
    });
    const faux = fauxRhea();
    faux.setResponses([fauxAssistantMessage('Aufgabe ist verloren gemeldet worden.')]);
    const { runner } = neuerRunner(verz, hub, faux);
    await runner.start();
    let jetzt = 1_000_000;
    await runner.harness.commit(async (tx) => {
      const doc = await tx.doc(HubAufgaben);
      doc.eintraege.T9 = neueHubAufgabe({ taskId: 'T9', werkzeug: 'medien.bild', conversationId: runner.root.id }, jetzt);
    }, CTX);
    const fehler = [];
    const w = new AufgabenWaechter({ runner, hub, cfg: runner.cfg, jetzt: () => jetzt, onFehler: (e) => fehler.push(e.message) });

    for (let i = 0; i < 5; i += 1) {
      jetzt += 40_000;
      await w.tick(); // wirft nie
    }
    let e9 = (await runner.harness.snapshot(HubAufgaben, CTX)).eintraege.T9;
    assert.equal(e9.zugestellt, false);
    assert.ok(e9.fehler >= 3 && e9.letzterFehler.includes('Hub nicht erreichbar'));
    assert.equal(fehler.length, 1, 'der Fehler wird nicht bei jeder Abfrage gemeldet');

    // Der Hub ist wieder da: die Fehlerzähler setzen sich zurück.
    weg = false;
    jetzt += 40_000;
    await w.tick();
    e9 = (await runner.harness.snapshot(HubAufgaben, CTX)).eintraege.T9;
    assert.equal(e9.fehler, 0);

    // Dauerhaft weg: nach der Grenze verloren.
    weg = true;
    for (let i = 0; i < 3; i += 1) {
      jetzt += 40_000;
      await w.tick();
    }
    jetzt += FEHLER_GRENZE_MS + 60_000;
    await w.tick();
    jetzt += FEHLER_GRENZE_MS + 60_000;
    await w.tick();
    e9 = (await runner.harness.snapshot(HubAufgaben, CTX)).eintraege.T9;
    assert.equal(e9.zugestellt, true);
    assert.equal(e9.status, 'verloren');
    await warten(async () => (await eintraege(runner)).some((x) => art(x) === 'fyos.aufgabe' && x.data.status === 'verloren'));
    await runner.close();
  });

  test('unbekannte Aufgabe (404) wird einmal als verloren zugestellt; input_required einmal je Schlüsselsatz', async () => {
    const verz = tmp();
    const hub = new AttrappenHub({
      T2: () => new HubFehler('Aufgabe nicht gefunden', { status: 404 }),
      T3: (n) => ({
        status: n < 4 ? 'input_required' : 'completed',
        inputRequests: n < 4 ? { ok: { method: 'elicitation/create', params: { message: 'Weiter?' } } } : undefined,
        result: { ok: true, result: { fertig: true } },
        pollIntervalMs: 1000,
      }),
    });
    const faux = fauxRhea();
    faux.setResponses([fauxAssistantMessage('a'), fauxAssistantMessage('b'), fauxAssistantMessage('c')]);
    const { runner } = neuerRunner(verz, hub, faux);
    await runner.start();
    let jetzt = 5_000_000;
    await runner.harness.commit(async (tx) => {
      const doc = await tx.doc(HubAufgaben);
      doc.eintraege.T2 = neueHubAufgabe({ taskId: 'T2', werkzeug: 'x.y', conversationId: runner.root.id }, jetzt);
      doc.eintraege.T3 = neueHubAufgabe({ taskId: 'T3', werkzeug: 'x.z', conversationId: runner.root.id }, jetzt);
    }, CTX);
    const w = new AufgabenWaechter({ runner, hub, cfg: runner.cfg, jetzt: () => jetzt, onFehler: () => {} });
    for (let i = 0; i < 5; i += 1) {
      jetzt += 2000;
      await w.tick();
    }
    const d = (await runner.harness.snapshot(HubAufgaben, CTX)).eintraege;
    assert.equal(d.T2.zugestellt, true);
    assert.equal(d.T2.status, 'verloren');
    assert.equal(d.T3.zugestellt, true);
    assert.equal(hub.abfragen.T2, 1, 'eine zugestellte Aufgabe wird nicht mehr abgefragt');
    await warten(async () => (await eintraege(runner)).filter((x) => art(x) === 'fyos.aufgabe').length >= 3);
    const stati = (await eintraege(runner)).filter((x) => art(x) === 'fyos.aufgabe').map((x) => `${x.data.bezug}:${x.data.status}`).sort();
    assert.deepEqual(stati, ['T2:verloren', 'T3:completed', 'T3:input_required']);
    await runner.close();
  });
});
