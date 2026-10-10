import test from 'node:test';
import assert from 'node:assert/strict';
import {registerPriority, TOOL} from './plugin.mjs';

// Attrappe der Plugin-API: sammelt die Haken; die Sitzung kennt genau einen laufenden Auftrag.
function haken() {
  const gesammelt = {};
  const eintrag = {sessionId: 'session', lifecycleRevision: 'lifecycle-1'};
  const session = {getSessionEntry: () => eintrag, patchSessionEntry: async () => eintrag, listSessionEntries: () => []};
  registerPriority({
    pluginConfig: {}, logger: {error() {}},
    runtime: {agent: {session}},
    session: {state: {registerSessionExtension() {}}},
    agent: {events: {registerAgentEventSubscription() {}}},
    on: (name, fn) => { gesammelt[name] = fn; },
    registerTool() {}, registerGatewayMethod() {}, registerService() {},
  }, {store: session});
  return gesammelt;
}
const ctx = {sessionKey: 'agent:main:main', sessionId: 'session', runId: 'run-1'};

test('a wrong parameter name is blocked with the exact call form', async () => {
  // 09.10.: das Modell schickte {status: "completed"} und riet beim zweiten Versuch wieder falsch
  const antwort = await haken().before_tool_call({toolName: TOOL, toolCallId: 'call-1', params: {status: 'completed'}}, ctx);
  assert.equal(antwort.block, true);
  assert.match(antwort.blockReason, /\{"state":"completed"\}/);
  assert.match(antwort.blockReason, /named state/);
});
