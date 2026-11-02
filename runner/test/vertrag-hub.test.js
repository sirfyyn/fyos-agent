/**
 * Verträge des Runners gegen den ECHTEN Hub (25.10.2026, Entscheidungen 581/583: „nur gegen den echten“, keine Attrappen für den Vertrag).
 *
 * Anlass: Am 25.10. verwarf der Hub jedes Ereignis des Runners, weil der Ausgang `a`/`s` statt `agent`/`sitzung` sendete. Die Tests
 * nutzten einen Fake-Hub und merkten nichts. Diese Datei startet darum den echten Hub-Code (`mcp_hub.agent.agent_routen()` mit
 * `_agentenstrom`, `_agenteneingang`, `_arbeitsbereiche`; `test/hilfen/hub_echt.py`) und lässt den Runner über seine echte
 * `Hub`-Klasse per HTTP mit ihm sprechen. Nur der Speicher (Redis) ist im Prozess nachgebaut; er prüft nichts vom Vertrag.
 *
 * Verträge:
 *   1. Ausgang   POST /hub/agent/melden   jedes Ereignis des Egress besteht `_agentenstrom.eintrag` (Text, Reasoning, Werkzeug, Schritt,
 *                                         part.done, proposal, session.idle, error, usage, ui_request). Der Hub nimmt alle an, keines wird abgelehnt.
 *   2. Eingang   GET  /hub/agent/eingang  die Antwort des Hubs (`{eintraege, letzte}`) liest der Ingress richtig: Quelle, Klasse, Bezug,
 *                                         Schwere, Zeiger; ein Eintrag für einen anderen Agenten läuft nicht durch.
 *   3. Bereiche  POST /hub/agent/arbeitsbereiche  die Meldung des Runners besteht die Namensregel `^[a-z0-9_-]{1,40}$` des Hubs.
 *   4. Gegenprobe: die alten Kurzschlüssel `a`/`s` weist der echte Hub ab (die Suite hat Zähne).
 *
 * Die Beispielereignisse schreibt der Test nach `test/fixtures/hub-ereignisse.json`; `mcp_hub/tests/test_vertrag_runner.py` schickt
 * sie durch denselben Hub-Code, damit eine Hub-Änderung auch ohne Node-Lauf rot wird.
 *
 * Fehlt Python 3, Starlette/Uvicorn oder der Hub-Code, ÜBERSPRINGT die Datei ehrlich mit Grund (nie stilles Grün). Mit
 * `FYOS_VERTRAG_STRENG=1` wird aus dem Überspringen ein Fehler.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { konfigurationLaden } from '../src/config.js';
import { usageEreignis } from '../src/budget.js';
import { Egress } from '../src/egress.js';
import { Hub } from '../src/hub.js';
import { Ingress } from '../src/ingress.js';
import { Runner } from '../src/runner.js';
import { Laufzeit } from '../src/documents.js';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

const CTX = BACKGROUND_CONTEXT;
const HIER = fileURLToPath(new URL('.', import.meta.url));
const HELFER = join(HIER, 'hilfen', 'hub_echt.py');
const FIXTURE = join(HIER, 'fixtures', 'hub-ereignisse.json');
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
async function bis(fn, { ms = 20000, was = 'Bedingung' } = {}) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    const wert = await fn();
    if (wert) return wert;
    await warte(100);
  }
  throw new Error(`Zeit abgelaufen: ${was}`);
}

// --- den echten Hub starten (oder ehrlich überspringen) ---------------------------------------------------------------------

async function hubStarten() {
  return new Promise((fertig) => {
    let kind;
    try {
      kind = spawn(process.env.FYOS_PYTHON || 'python3', [HELFER], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (fehler) {
      return fertig({ grund: `Python 3 nicht startbar: ${fehler.message}` });
    }
    let aus = '';
    let stderr = '';
    const frist = setTimeout(() => {
      kind.kill();
      fertig({ grund: `Hub-Helfer meldete sich nicht innerhalb von 30 s. ${stderr.slice(-300)}` });
    }, 30_000);
    kind.on('error', (fehler) => {
      clearTimeout(frist);
      fertig({ grund: `Python 3 nicht startbar: ${fehler.message}` });
    });
    kind.stderr.on('data', (d) => (stderr += d));
    kind.stdout.on('data', (d) => {
      aus += d;
      const bereit = aus.match(/BEREIT (\d+)/);
      if (bereit) {
        clearTimeout(frist);
        fertig({ kind, url: `http://127.0.0.1:${bereit[1]}` });
      }
      const fehlt = aus.match(/FEHLT (.*)/);
      if (fehlt) {
        clearTimeout(frist);
        fertig({ grund: `echter Hub nicht ladbar (${fehlt[1]})` });
      }
    });
    kind.on('exit', (code) => {
      clearTimeout(frist);
      fertig({ grund: `Hub-Helfer endete mit ${code}. ${stderr.slice(-300)}` });
    });
  });
}

const hub = await hubStarten();
const streng = process.env.FYOS_VERTRAG_STRENG === '1';
if (hub.grund) {
  const text = `Vertragstests gegen den echten Hub ÜBERSPRUNGEN: ${hub.grund}`;
  console.error(`[vertrag-hub] ${text}`);
  if (streng) test('Vertragstests brauchen den echten Hub (FYOS_VERTRAG_STRENG=1)', () => assert.fail(text));
}
const skip = hub.grund ? `echter Hub nicht verfügbar: ${hub.grund}` : false;
after(() => hub.kind?.kill());

const tmp = mkdtempSync(join(tmpdir(), 'pidurable-vertrag-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const holen = async (pfad, init) => {
  const r = await fetch(hub.url + pfad, init);
  return { status: r.status, daten: await r.json() };
};
const strom = async () => (await holen('/_test/strom')).daten;

/** Ein Hub, der alles aufzeichnet, was der Runner sendet, und es dann wirklich an den echten Hub gibt. */
class AufzeichnenderHub extends Hub {
  constructor(opt) {
    super(opt);
    this.roh = [];
    this.fehler = [];
  }
  async melden(ereignisse, opt) {
    this.roh.push(...structuredClone(ereignisse));
    try {
      return await super.melden(ereignisse, opt);
    } catch (fehler) {
      this.fehler.push(fehler);
      throw fehler;
    }
  }
}

// --- gemeinsamer Aufbau: ein Runner, ein Egress, ein Ingress, alle gegen den echten Hub -----------------------------------------

const BEREICHE = { standard: { pfad: tmp, titel: 'Standard' }, 'fyos-repo': { pfad: tmp, titel: 'FYOS Repo' }, web_2: { pfad: tmp, titel: 'Web 2' } };
let ctx = null;

async function aufbau() {
  if (ctx) return ctx;
  const cfg = konfigurationLaden(
    {
      hub: hub.url,
      arbeitsbereiche: BEREICHE,
      spielmodus: [],
      pi_durable: {
        storage: join(tmp, 'fyos.sqlite'),
        security: { token: 'test-token-test-token-test-token-00' },
        proactive: { enabled: true, pollSeconds: 2 },
        egress: { enabled: true, flushMs: 100, erinnerungS: 0 },
        browser: { enabled: false },
        desktop: { enabled: false },
      },
    },
    {},
  );
  const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: [{ id: 'hausmodell' }, { id: 'hausmodell-max' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const hubKlient = new AufzeichnenderHub({ url: hub.url, agent: cfg.agent });
  const runner = new Runner(cfg, { models, hub: hubKlient });
  await runner.start();
  const egress = new Egress({ cfg, harness: runner.harness, hub: hubKlient, onFehler: () => {} });
  await egress.start();
  const ingress = new Ingress({ cfg, runner, hub: hubKlient, spielmodus: runner.spielmodus, tor: { offen: true }, onFehler: () => {} });
  ctx = { cfg, faux, runner, egress, ingress, hubKlient, wurzel: runner.root.id };
  return ctx;
}

after(async () => {
  if (!ctx) return;
  await ctx.ingress.stop().catch(() => {});
  await ctx.egress.stop().catch(() => {});
  await ctx.runner.close().catch(() => {});
});

const idleZahl = (c) => c.hubKlient.roh.filter((e) => e.typ === 'session.idle').length;
async function zugAbwarten(c, vorher, was) {
  await bis(() => idleZahl(c) > vorher && c.egress.tiefe() === 0, { was }).catch((fehler) => {
    const letzte = c.hubKlient.roh.slice(-12).map((e) => [e.typ, e.pt, e.id, e.label, e.phase].filter(Boolean).join('/'));
    throw new Error(`${fehler.message}; idle ${idleZahl(c)} statt > ${vorher}, Puffer ${c.egress.tiefe()}, letzte Ablehnung des Hubs: ${c.hubKlient.fehler.at(-1)?.message ?? 'keine'}, zuletzt: ${letzte.join(' | ')}`);
  });
}

// --- 1. Ausgang -----------------------------------------------------------------------------------------------------------

test('Ausgang: jedes Ereignis des Runners besteht den echten Hub (Text, Denken, Werkzeug, Schritt, Freigabe, Ende, Fehler)', { skip }, async () => {
  const c = await aufbau();
  const { faux, runner, egress, hubKlient, wurzel } = c;

  // a) Denken, Werkzeug, Text
  faux.setResponses([
    fauxAssistantMessage([fauxThinking('Ich lese zuerst den Zustand.'), fauxToolCall('zustand_lesen', {}, { id: 'call_1' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Hauptantwort'),
  ]);
  let vorher = idleZahl(c);
  await runner.sende(wurzel, 'frage');
  await zugAbwarten(c, vorher, 'Zug a (Denken, Werkzeug, Text)');

  // b) Freigabe: Wunsch (proposal), danach die Entscheidung (Schritt freigabe:<id>)
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall(
        'freigabe_bitten',
        { aktion: 'Branch löschen', risiko: 'high', kontext: 'Aufräumen', werkzeug: 'bash', befehl: 'git branch -D alt' },
        { id: 'call_2' },
      ),
    ], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Ich warte auf die Freigabe.'),
  ]);
  vorher = idleZahl(c);
  await runner.sende(wurzel, 'bitte aufräumen');
  const wunsch = await bis(() => hubKlient.roh.find((e) => e.typ === 'proposal'), { was: 'proposal im Ausgang' });
  await zugAbwarten(c, vorher, 'Zug b (Freigabe-Wunsch)');
  await runner.entscheideFreigabe(wunsch.id, { entscheidung: 'erteilt', notiz: 'ok', von: 'test' });
  await bis(() => hubKlient.roh.some((e) => e.pt === 'step' && e.id === `freigabe:${wunsch.id}`), { was: 'Ende der Freigabe im Ausgang' });

  // c) Was ein Betrachter live sieht: Deltas von Text und Denken (das Faux-Modell streamt nicht, die Form ist die von pi-durable),
  //    ein fehlgeschlagener Zug (error) und das Verdichten (Schritt).
  await egress.verarbeite(wurzel, [
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'message_update', changes: [{ type: 'thinking_delta', delta: 'Ich überlege kurz.' }, { type: 'text_delta', delta: 'Teil eins. ' }] },
    { type: 'message_update', changes: [{ type: 'text_delta', delta: 'Teil zwei.' }] },
    { type: 'message_end', entry: { model: [] } },
    { type: 'task_failed', message: 'Werkzeug abgebrochen', kind: 'tool' },
    { type: 'compaction_start', taskId: 7 },
    { type: 'compaction_end', taskId: 7 },
  ]);

  // d) Bausteine, die über `meldeExtern` melden: Reflex-Meldung (ui_request) und Nutzung (usage)
  assert.equal(
    egress.meldeExtern(wurzel, {
      typ: 'ui_request',
      id: 'reflex:alarm-hoch:1',
      methode: 'notify',
      nutzlast: { message: 'Alarm hoch: Rauchmelder', notifyType: 'warning', reflex: 'alarm-hoch', schwere: 'hoch', ein: 'x' },
    }),
    true,
  );
  assert.equal(egress.meldeExtern(wurzel, usageEreignis({ cfg: c.cfg, modell: 'hausmodell', tokens: 1200, kosten: 0.0123 })), true);
  await bis(() => egress.tiefe() === 0, { was: 'Puffer leer' });
  await warte(300);

  // Ergebnis: der Hub hat nichts abgelehnt, und alles, was gesendet wurde, liegt im Strom des Hubs
  assert.deepEqual(hubKlient.fehler.map((f) => f.message), [], 'der echte Hub weist Ereignisse des Runners ab');
  assert.equal(egress.letzterFehler, null);
  assert.equal(egress.meldestrecke().verworfen, 0);
  const imStrom = (await strom())['fyos:agent'] ?? [];
  assert.equal(imStrom.length, hubKlient.roh.length, 'Anzahl im Hub-Strom = Anzahl gesendet');

  // Alle Arten, die der Runner kennt, kamen vor und wurden angenommen.
  const arten = new Set(imStrom.map((e) => (e.typ === 'part.updated' ? `part.updated/${e.pt}` : e.typ)));
  for (const erwartet of [
    'part.updated/text',
    'part.updated/reasoning',
    'part.updated/tool',
    'part.updated/step',
    'part.done',
    'proposal',
    'session.idle',
    'error',
    'usage',
    'ui_request',
  ]) {
    assert.ok(arten.has(erwartet), `Art fehlt im Ausgang: ${erwartet} (vorhanden: ${[...arten].join(', ')})`);
  }
  // Der Hub hat die Felder im Strom so geformt, wie es der Vertrag sagt: Agent und Sitzung als a/s, Sequenz je Sitzung lückenlos.
  assert.ok(imStrom.every((e) => e.a === c.cfg.agent && /^[A-Za-z0-9._:-]{1,64}$/.test(e.s) && e.v === '1'));
  const proSitzung = new Map();
  for (const e of hubKlient.roh) proSitzung.set(e.sitzung, [...(proSitzung.get(e.sitzung) ?? []), e.q]);
  for (const [s, qs] of proSitzung) assert.deepEqual(qs, qs.map((_, i) => i + 1), `Sequenz der Sitzung ${s} ist nicht lückenlos`);
  // Die Werkzeugfolge pending/running → completed ist angekommen, mit Namen.
  const werkzeug = imStrom.filter((e) => e.pt === 'tool' && e.id === 'call_1');
  assert.ok(werkzeug.some((e) => e.st === 'running' && e.wz === 'zustand_lesen'));
  assert.ok(werkzeug.some((e) => e.st === 'completed'));
  // Das Proposal trägt, was der Hub verlangt.
  const prop = imStrom.find((e) => e.typ === 'proposal');
  assert.equal(prop.risiko, 'high');
  assert.equal(prop.optionen, 'once,deny');

  // Sequenzstand im Harness: unter der Sitzungs-ID, nicht unter „undefined“ (Fehler `e.s`, gefunden von diesem Test).
  const lz = await runner.harness.snapshot(Laufzeit, CTX);
  assert.equal(lz.sequenzen.undefined, undefined, 'Sequenzstand liegt unter „undefined“');
  for (const [s, qs] of proSitzung) assert.equal(lz.sequenzen[s], qs.at(-1), `Sequenzstand der Sitzung ${s}`);

});

// --- 2. Eingang -----------------------------------------------------------------------------------------------------------

test('Eingang: die Antworten des echten Hubs liest der Ingress richtig (Quelle, Klasse, Bezug, Schwere, Zeiger)', { skip }, async () => {
  const c = await aufbau();
  const { faux, runner, ingress, hubKlient } = c;
  faux.setResponses([fauxAssistantMessage('eins'), fauxAssistantMessage('zwei'), fauxAssistantMessage('drei')]);
  const gesehen = [];
  const vorher = ingress.vorAusgabe;
  ingress.vorAusgabe = async (e) => {
    gesehen.push(e);
    return vorher ? vorher(e) : 'weiter';
  };
  await ingress.start();
  // Der Leser steht, sobald der Zeiger von `$` auf die Spitze des Stroms gerückt ist; alles danach kommt an.
  await bis(() => ingress.cursor !== '$', { was: 'Leser steht' });

  const werfe = (roh) => holen('/hub/agent/eingang', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(roh) });
  const a = await werfe({ quelle: 'web', text: 'Hallo vom Web', arbeitsbereich: 'standard' });
  const b = await werfe({ quelle: 'itsm', text: 'Vorgang aktualisiert', bezug: 'VOR-4870', von: 'itsm' });
  const d = await werfe({ quelle: 'alarm', text: 'Rauchmelder Flur', schwere: 'hoch' });
  const fremd = await werfe({ quelle: 'web', text: 'nicht für Persona', agent: 'anderer' });
  for (const r of [a, b, d, fremd]) assert.equal(r.status, 200, JSON.stringify(r.daten));
  assert.match(a.daten.id, /^\d+-\d+$/);

  await bis(() => gesehen.length >= 3, { was: 'drei Eingänge beim Ingress' });
  const nachId = (id) => gesehen.find((e) => e.stromId === id);
  assert.equal(nachId(a.daten.id).quelle, 'web');
  assert.equal(nachId(a.daten.id).klasse, 'max', 'Besitzer\' eigene Kanäle haben Vorfahrt');
  assert.equal(nachId(a.daten.id).arbeitsbereich, 'standard');
  assert.equal(nachId(b.daten.id).klasse, 'hintergrund');
  assert.equal(nachId(b.daten.id).bezug, 'VOR-4870');
  assert.equal(nachId(b.daten.id).von, 'itsm');
  assert.equal(nachId(d.daten.id).schwere, 'hoch');
  assert.equal(nachId(d.daten.id).klasse, 'hintergrund');
  assert.equal(nachId(fremd.daten.id), undefined, 'ein Eintrag für einen anderen Agenten läuft nicht durch');

  // Der Zeiger steht auf dem letzten Eintrag des Stroms (auch dem fremden), und der Lesefehler ist leer.
  await bis(async () => (await runner.harness.snapshot(Laufzeit, CTX)).letzteEingang === fremd.daten.id, { was: 'Zeiger auf der Spitze' });
  const lz = await runner.harness.snapshot(Laufzeit, CTX);
  assert.equal(lz.eingangFehler, null);
  assert.equal(lz.eingangGesehen, 3);
  // Bis hierher keine Ablehnung und kein Lesefehler bei der Meldung der Antworten.
  await bis(() => c.egress.tiefe() === 0, { was: 'Puffer leer' });
  assert.deepEqual(hubKlient.fehler.map((f) => f.message), []);
  // Die Zug-Klammer `ein:<Strom-ID>` ging als Schritt in den Ausgang, mit der Strom-ID des Hubs.
  await bis(() => hubKlient.roh.some((e) => e.id === `ein:${a.daten.id}` && e.phase === 'finish'), { was: 'Zug des Web-Eingangs beendet' }).catch((fehler) => {
    throw new Error(`${fehler.message}: ${JSON.stringify(hubKlient.roh.filter((e) => e.pt === 'step' || e.typ === 'error').map((e) => [e.id, e.label, e.phase, e.nachricht]))}`);
  });
});

// --- 3. Arbeitsbereiche ---------------------------------------------------------------------------------------------------

test('Bereiche: die Meldung des Runners besteht die Namensregel des Hubs, ohne Pfade', { skip }, async () => {
  const c = await aufbau();
  const gelesen = await bis(async () => {
    const r = await holen('/hub/agent/arbeitsbereiche?agent=persona');
    return r.daten.bereiche.length > 1 ? r : null;
  }, { was: 'gemeldete Arbeitsbereiche' });
  assert.equal(gelesen.status, 200);
  assert.deepEqual(gelesen.daten.bereiche.map((b) => b.name).sort(), Object.keys(BEREICHE).sort());
  assert.equal(gelesen.daten.bereiche[0].name, 'standard', '„standard“ steht vorn');
  assert.ok(gelesen.daten.bereiche.every((b) => /^[a-z0-9_-]{1,40}$/.test(b.name)));
  assert.ok(!JSON.stringify(gelesen.daten).includes(tmp), 'ein Pfad ist beim Hub gelandet');
  // Dieselbe Regel steht im Quelltext des Runners (config.js) wie im Hub; wer eine ändert, bricht diesen Test.
  assert.ok(readFileSync(join(HIER, '..', 'src', 'config.js'), 'utf8').includes('/^[a-z0-9_-]{1,40}$/'));
  assert.equal(c.cfg.agent, 'persona');
});

// --- 4. Gegenprobe --------------------------------------------------------------------------------------------------------

test('Gegenprobe: die Kurzschlüssel a/s vom 25.10. weist der echte Hub ab, ebenso ein Ereignis ohne Sequenz', { skip }, async () => {
  const post = (ereignis) =>
    holen('/hub/agent/melden', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ereignisse: [ereignis] }) });
  const alt = await post({ v: '1', typ: 'session.idle', a: 'persona', s: '1', q: 1, t: 1 });
  assert.equal(alt.status, 400);
  assert.match(alt.daten.error, /Agenten-ID unbrauchbar/);
  const ohneQ = await post({ typ: 'session.idle', agent: 'persona', sitzung: '1' });
  assert.equal(ohneQ.status, 400);
  const gut = await post({ typ: 'session.idle', agent: 'persona', sitzung: '1', q: 9, t: 1 });
  assert.equal(gut.status, 200);
});

// --- Fixture --------------------------------------------------------------------------------------------------------------

/** Stabile Form: feste Zeit, Sitzungen und Kennungen nach Auftreten nummeriert, damit die Datei nur bei echter Änderung wechselt. */
export function normalisiere(roh) {
  const sitzungen = new Map();
  const alias = (karte, wert, vorn) => {
    if (!karte.has(wert)) karte.set(wert, `${vorn}${karte.size + 1}`);
    return karte.get(wert);
  };
  const fr = new Map();
  const strom = new Map();
  let text = JSON.stringify(roh);
  text = text.replace(/fr-[0-9a-f]{8}-[0-9a-f]{3}/g, (m) => alias(fr, m, 'fr-t'));
  text = text.replace(/\b\d{12,}-\d+\b/g, (m) => alias(strom, m, '1792270000000-'));
  const liste = JSON.parse(text).map((e) => ({ ...e, sitzung: alias(sitzungen, e.sitzung, 's'), t: 1792270000000 }));
  return liste.map((e, i) => ({ ...e, t: 1792270000000 + i }));
}

after(() => {
  if (ctx && ctx.hubKlient.roh.length > 0 && ctx.hubKlient.fehler.length === 0) fixtureSchreiben(ctx.hubKlient.roh);
});

function fixtureSchreiben(roh) {
  const neu = JSON.stringify(normalisiere(roh), null, 1) + '\n';
  const alt = existsSync(FIXTURE) ? readFileSync(FIXTURE, 'utf8') : null;
  if (alt !== neu) writeFileSync(FIXTURE, neu);
}
