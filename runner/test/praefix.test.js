// Prüft praefix.js: Eine spätere Abschnittsänderung (Kontextbuch neu geschrieben) darf die erste Systemnachricht der
// Anfrage an Hausmodell/Katy nicht mehr ändern; der neue Stand steht an seiner Stelle im Gespräch, Werkzeugänderungen bleiben.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { convertMessages } from '@earendil-works/pi-ai/api/openai-completions';
import { praefixHuelle, praefixStabil } from '../src/praefix.js';

const MODELL = { id: 'katy', api: 'openai-completions', provider: 'hausmodell', reasoning: false, input: ['text'] };
const COMPAT = { supportsMidConvoSystemMessages: false, supportsDeveloperRole: false, requiresAssistantAfterToolResult: false };

const kopf = {
  role: 'system',
  content: '',
  sections: { rolle: 'Du bist Persona.', kontextbuch: '<kontextbuch>\n# Stand 08:35\n</kontextbuch>' },
  toolsAdded: [{ name: 'bash', description: 'Shell', parameters: { type: 'object', properties: {} } }],
  timestamp: 1,
};
const nutzer = { role: 'user', content: 'Mach weiter.', timestamp: 2 };
const aufruf = {
  role: 'assistant',
  content: [{ type: 'toolCall', id: 'c1', name: 'kontextbuch_schreiben', arguments: { inhalt: '# Stand 08:50' } }],
  api: 'openai-completions', provider: 'hausmodell', model: 'katy', stopReason: 'toolUse', timestamp: 3,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};
const ergebnis = { role: 'toolResult', toolCallId: 'c1', toolName: 'kontextbuch_schreiben', content: [{ type: 'text', text: 'Kontextbuch gespeichert.' }], isError: false, timestamp: 4 };
const patch = { role: 'system', content: '', sections: { kontextbuch: '<kontextbuch>\n# Stand 08:50\n</kontextbuch>' }, timestamp: 5 };

const anfrage = (messages) => convertMessages(MODELL, praefixStabil({ messages }), COMPAT);

test('ohne spätere Systemnachricht bleibt der Kontext unverändert', () => {
  const ctx = { messages: [kopf, nutzer] };
  assert.equal(praefixStabil(ctx), ctx);
});

test('Kontextbuch neu geschrieben: der Systemkopf der Anfrage bleibt Byte für Byte gleich', () => {
  const vorher = anfrage([kopf, nutzer, aufruf, ergebnis]);
  const nachher = anfrage([kopf, nutzer, aufruf, ergebnis, patch]);
  assert.equal(nachher[0].role, 'system');
  assert.equal(nachher[0].content, vorher[0].content);
  assert.match(vorher[0].content, /Stand 08:35/);
  assert.doesNotMatch(nachher[0].content, /Stand 08:50/);
  // Der neue Stand hängt am Werkzeugergebnis davor, keine neue Systemnachricht mitten im Gespräch.
  assert.equal(nachher.filter((p) => p.role === 'system').length, 1);
  const letzte = JSON.stringify(nachher.at(-1));
  assert.match(letzte, /Stand 08:50/);
  assert.match(letzte, /system_aktualisierung/);
});

test('Folgezüge ändern die Darstellung der Aktualisierung nicht (stabiler Präfix)', () => {
  const antwort = { ...aufruf, content: [{ type: 'text', text: 'Fertig.' }], stopReason: 'stop', timestamp: 6 };
  const zug1 = anfrage([kopf, nutzer, aufruf, ergebnis, patch]);
  const zug2 = anfrage([kopf, nutzer, aufruf, ergebnis, patch, antwort, { role: 'user', content: 'Und jetzt?', timestamp: 7 }]);
  assert.deepEqual(zug2.slice(0, zug1.length), zug1);
});

test('nach einer Antwort ohne Werkzeug wird die Aktualisierung eine eigene Nutzernachricht', () => {
  const antwort = { ...aufruf, content: [{ type: 'text', text: 'Fertig.' }], stopReason: 'stop', timestamp: 6 };
  const out = praefixStabil({ messages: [kopf, nutzer, antwort, patch] }).messages;
  assert.equal(out.length, 4);
  assert.equal(out[3].role, 'user');
  assert.match(out[3].content, /Updated system prompt section "kontextbuch"/);
});

test('Werkzeugänderungen bleiben als Systemnachricht ohne Text erhalten', () => {
  const mitWerkzeug = { ...patch, toolsAdded: [{ name: 'neu', description: 'x', parameters: { type: 'object', properties: {} } }] };
  const out = praefixStabil({ messages: [kopf, nutzer, mitWerkzeug] }).messages;
  const sys = out.filter((m) => m.role === 'system');
  assert.equal(sys.length, 2);
  assert.equal(sys[1].content, '');
  assert.equal(sys[1].sections, undefined);
  assert.equal(sys[1].toolsAdded[0].name, 'neu');
  assert.match(out[1].content, /Stand 08:50/);
});

test('praefixHuelle reicht den festen Kontext an stream und streamSimple weiter', () => {
  const gesehen = [];
  const h = praefixHuelle({ stream: (_m, c) => gesehen.push(c), streamSimple: (_m, c) => gesehen.push(c) });
  h.stream(MODELL, { messages: [kopf, nutzer, patch] });
  h.streamSimple(MODELL, { messages: [kopf, nutzer, patch] });
  for (const c of gesehen) assert.equal(c.messages.filter((m) => m.role === 'system' && m.sections).length, 1);
});
