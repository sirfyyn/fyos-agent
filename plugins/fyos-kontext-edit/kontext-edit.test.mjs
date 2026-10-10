import test from 'node:test';
import assert from 'node:assert/strict';
import {AUFTRAG, MARKE_GELOESCHT, MARKE_VERDICHTET, arm, auftragFaellig, bearbeite, ersatzPlan, markiere, neuerZustand} from './kern.mjs';
import {ENGINE_ID, WERKZEUG, registerKontextEdit} from './plugin.mjs';

const tr = (id, text) => ({role: 'toolResult', toolCallId: id, toolName: 'shell', content: [{type: 'text', text}], isError: false, timestamp: 1});
const verlauf = () => [
  {role: 'user', content: 'Hub prüfen', timestamp: 0},
  {role: 'assistant', content: [{type: 'toolCall', id: 'c1', name: 'shell', arguments: {befehl: 'kubectl get pods'}}]},
  tr('c1', 'x'.repeat(5000)),
  {role: 'assistant', content: [{type: 'toolCall', id: 'c2', name: 'shell', arguments: {befehl: 'kubectl logs'}}]},
  tr('c2', 'ERROR redis connection refused'),
];

const neuerZustandMit = () => { const z = neuerZustand(); markiere(verlauf(), z); return z; };

test('markiert Werkzeugergebnisse stabil über toolCallId und verändert die Eingabe nicht', () => {
  const z = neuerZustand();
  const v = verlauf();
  const a = markiere(v, z);
  assert.match(a[2].content[0].text, /^\[#w1\] x/);
  assert.match(a[4].content[0].text, /^\[#w2\] ERROR/);
  assert.equal(v[2].content[0].text[0], 'x');
  // gleiche Kennungen beim nächsten Zug, auch wenn ein neues Ergebnis dazukommt
  const b = markiere([...v, tr('c3', 'neu')], z);
  assert.match(b[2].content[0].text, /^\[#w1\]/);
  assert.match(b[5].content[0].text, /^\[#w3\] neu/);
});

test('bearbeite prüft Eingaben und merkt Edits vor; die Projektion wendet sie sofort an', () => {
  const z = neuerZustand();
  markiere(verlauf(), z);
  assert.equal(bearbeite(z, {aktion: 'weg', ziele: ['w1']}).ok, false);
  assert.equal(bearbeite(z, {aktion: 'ersetzen', ziele: ['w1']}).ok, false);
  assert.match(bearbeite(z, {aktion: 'loeschen', ziele: ['k9']}).text, /Keine bearbeitbare Kennung.*k9/);
  const teil = bearbeite(neuerZustandMit(), {aktion: 'loeschen', ziele: ['k1', 'w2']});
  assert.equal(teil.ok, true);
  assert.match(teil.text, /Gelöscht: #w2\..*Übersprungen.*k1/);
  assert.equal(bearbeite(z, {aktion: 'ersetzen', ziele: ['#w1', 'w2'], text: 'mcp-hub CrashLoop, redis fehlt'}).ok, true);
  const a = markiere(verlauf(), z);
  assert.equal(a[2].content[0].text, `[#w1] ${MARKE_VERDICHTET}mcp-hub CrashLoop, redis fehlt`);
  assert.equal(a[4].content[0].text, `[#w2] ${MARKE_VERDICHTET}siehe #w1`);
  assert.equal(a[2].toolCallId, 'c1');
});

test('ersatzPlan liefert entryIds für offene Edits und überspringt schon ersetzte Einträge', () => {
  const z = neuerZustand();
  markiere(verlauf(), z);
  bearbeite(z, {aktion: 'loeschen', ziele: ['w1']});
  const eintraege = verlauf().map((message, i) => ({entryId: `e${i}`, message}));
  const plan = ersatzPlan(eintraege, z);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].entryId, 'e2');
  assert.equal(plan[0].message.content[0].text, MARKE_GELOESCHT);
  assert.equal(plan[0].zeichenVorher, 5000);
  eintraege[2].message = plan[0].message;
  assert.equal(ersatzPlan(eintraege, z).length, 0);
});

test('Auftrag nur über der Schwelle, mit Unbearbeitetem, und erneut erst nach weiteren 10 % Budget', () => {
  const z = neuerZustand();
  assert.equal(auftragFaellig(z, 9000, 10000, 0.6), false);   // noch keine Werkzeugergebnisse
  markiere(verlauf(), z);
  assert.equal(auftragFaellig(z, 5000, 10000, 0.6), false);
  assert.equal(auftragFaellig(z, 6500, 10000, 0.6), true);
  assert.equal(auftragFaellig(z, 7000, 10000, 0.6), false);
  assert.equal(auftragFaellig(z, 7600, 10000, 0.6), true);
  assert.equal(auftragFaellig(z, 9000, 0, 0.6), false);
  assert.equal(auftragFaellig(z, 9000, 10000, 0), false);
  bearbeite(z, {aktion: 'loeschen', ziele: ['w1', 'w2']});
  assert.equal(auftragFaellig(z, 9900, 10000, 0.6), false);  // alles bearbeitet
});

test('arm ist deterministisch und respektiert Grenzen', () => {
  assert.equal(arm('agent:main:x', 0), 'kontrolle');
  assert.equal(arm('agent:main:x', 1), 'edit');
  assert.equal(arm(undefined, 1), 'kontrolle');
  assert.equal(arm('agent:main:x', 0.5), arm('agent:main:x', 0.5));
  const n = Array.from({length: 400}, (_, i) => arm(`s${i}`, 0.5)).filter((a) => a === 'edit').length;
  assert.ok(n > 150 && n < 250, `Anteil ${n}/400`);
});

function plugin(config, extra = {}) {
  const reg = {};
  const api = {
    pluginConfig: config, logger: {warn() {}},
    registerTool(factory, opts) { reg.tool = factory; reg.toolOpts = opts; },
    registerContextEngine(id, factory) { reg.engineId = id; reg.engine = factory({}); },
  };
  registerKontextEdit(api, {delegateCompactionToRuntime: async (p) => ({ok: true, compacted: true, delegiert: p}), ...extra});
  return reg;
}

test('aus: kein Werkzeug, Verlauf unverändert, Kompaktion delegiert', async () => {
  const r = plugin({});
  assert.equal(r.engineId, ENGINE_ID);
  assert.equal(r.toolOpts.name, WERKZEUG);
  assert.equal(r.tool({sessionKey: 'agent:main:a'}), null);
  const v = verlauf();
  const a = await r.engine.assemble({messages: v, sessionKey: 'agent:main:a'});
  assert.equal(a.messages, v);
  assert.equal(a.systemPromptAddition, undefined);
  assert.equal((await r.engine.compact({sessionKey: 'agent:main:a'})).compacted, true);
  assert.equal(r.engine.info.ownsCompaction, false);
});

test('Versuchsarm: Werkzeug, Markierung, maintain schreibt per rewriteTranscriptEntries', async () => {
  const gelesen = [];
  const r = plugin({aktiv: true, editAnteil: 1, auftragAb: 0.6}, {
    readVisibleSessionTranscriptMessageEntries: async (scope) => {
      gelesen.push(scope);
      return verlauf().map((message, i) => ({entryId: `e${i}`, message}));
    },
  });
  const k = 'agent:main:b';
  const werkzeug = r.tool({sessionKey: k});
  assert.equal(werkzeug.name, WERKZEUG);
  const a = await r.engine.assemble({messages: verlauf(), sessionKey: k, tokenBudget: 100000});
  assert.match(a.systemPromptAddition, /kontext_bearbeiten/);
  assert.ok(!a.systemPromptAddition.includes(AUFTRAG));
  const voll = await r.engine.assemble({messages: verlauf(), sessionKey: k, tokenBudget: 1500});
  assert.ok(voll.systemPromptAddition.includes(AUFTRAG));
  assert.match(a.messages[2].content[0].text, /^\[#w1\]/);
  const e = await werkzeug.execute('t1', {aktion: 'loeschen', ziele: ['w1']});
  assert.match(e.content[0].text, /^Gelöscht: #w1/);
  const anfragen = [];
  const rc = {rewriteTranscriptEntries: async (req) => { anfragen.push(req); return {changed: true, bytesFreed: 4990, rewrittenEntries: 3}; }};
  const m = await r.engine.maintain({sessionKey: k, sessionId: 's1', sessionTarget: {agentId: 'main'}, runtimeContext: rc});
  assert.equal(m.changed, true);
  assert.deepEqual(anfragen[0].replacements.map((x) => x.entryId), ['e2']);
  assert.equal(gelesen[0].agentId, 'main');
  // zweiter Lauf: nichts mehr offen
  const m2 = await r.engine.maintain({sessionKey: k, sessionId: 's1', runtimeContext: rc});
  assert.equal(m2.changed, false);
  assert.equal(anfragen.length, 1);
});

test('Standard spontan : auch bei vollem Kontext kein Auftrag des Harness', async () => {
  const r = plugin({aktiv: true, editAnteil: 1}, {readVisibleSessionTranscriptMessageEntries: async () => []});
  const voll = await r.engine.assemble({messages: verlauf(), sessionKey: 'agent:main:s', tokenBudget: 1500});
  assert.match(voll.systemPromptAddition, /kontext_bearbeiten/);
  assert.ok(!voll.systemPromptAddition.includes(AUFTRAG));
});

test('Host-Vertrag: Turn-Zaun erklärt, commitTurn idempotent je advancementKey', async () => {
  const r = plugin({aktiv: true, editAnteil: 1});
  assert.deepEqual(r.engine.info.transcriptSemantics,
    {currentTurnFence: 'before-current-turn-entry-v1', turnAdvancementIdempotency: 'atomic-idempotent-v1'});
  assert.deepEqual(await r.engine.commitTurn({advancementKey: 'k1', messages: []}), {status: 'committed'});
  assert.deepEqual(await r.engine.commitTurn({advancementKey: 'k1', messages: []}), {status: 'duplicate'});
  assert.deepEqual(await r.engine.commitTurn({advancementKey: 'k2', messages: []}), {status: 'committed'});
});

test('maintain ohne Rewrite-Fähigkeit (z. B. bootstrap) lässt Edits offen', async () => {
  const r = plugin({aktiv: true, editAnteil: 1}, {readVisibleSessionTranscriptMessageEntries: async () => []});
  const k = 'agent:main:c';
  await r.engine.assemble({messages: verlauf(), sessionKey: k});
  await r.tool({sessionKey: k}).execute('t1', {aktion: 'loeschen', ziele: ['w2']});
  const m = await r.engine.maintain({sessionKey: k, runtimeContext: {}});
  assert.equal(m.reason, 'Rewrite nicht verfügbar');
});
