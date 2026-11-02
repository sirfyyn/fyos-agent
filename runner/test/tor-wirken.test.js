import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HintergrundTor } from '../src/tor.js';
import { zeileAus } from '../src/wirken.js';

const hubMit = (antwort) => ({ aufrufen: async () => antwort });
const stumm = () => {};

test('Tor öffnet nur bei darf:true', async () => {
  const tor = new HintergrundTor({ hub: hubMit({ ok: true, result: { darf: true, warum: 'frei' } }), log: stumm });
  assert.equal(await tor.pruefen(), true);
  assert.equal(tor.zustand().warum, 'frei');
});

test('Tor bleibt zu bei darf:false, fehlendem Feld und Hub-Fehlern', async () => {
  for (const hub of [
    hubMit({ ok: true, result: { darf: false, warum: 'Besitzer ist da' } }),
    hubMit({ ok: true, result: {} }),
    hubMit({ ok: true, result: 'text' }),
    hubMit({ ok: false, fehler: 'kaputt' }),
    { aufrufen: async () => { throw new Error('Netz weg'); } },
  ]) {
    const tor = new HintergrundTor({ hub, log: stumm });
    assert.equal(await tor.pruefen(), false);
  }
});

test('Tor ruft beiOeffnen genau beim Übergang zu auf', async () => {
  let antwort = { ok: true, result: { darf: false } };
  let gerufen = 0;
  const tor = new HintergrundTor({ hub: { aufrufen: async () => antwort }, beiOeffnen: () => gerufen++, log: stumm });
  await tor.pruefen();
  assert.equal(gerufen, 0);
  antwort = { ok: true, result: { darf: true } };
  await tor.pruefen();
  await tor.pruefen();
  assert.equal(gerufen, 1);
});

test('zeileAus verdichtet Taten und lässt Deltas weg', () => {
  assert.equal(zeileAus({ type: 'message_update', changes: [{ type: 'text_delta', delta: 'x' }] }), null);
  assert.deepEqual(
    zeileAus({ type: 'message_end', entry: { model: [{ role: 'assistant', content: [{ type: 'text', text: 'Fertig  \n gemacht' }] }] } }),
    { typ: 'sagt', text: 'Fertig gemacht' },
  );
  assert.equal(zeileAus({ type: 'message_end', entry: { model: [{ role: 'assistant', content: [] }] } }), null);
  assert.equal(zeileAus({ type: 'message_end', entry: { model: [{ role: 'toolResult', content: [{ type: 'text', text: 'x' }] }] } }), null);
  const w = zeileAus({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls -la' } });
  assert.equal(w.typ, 'werkzeug');
  assert.equal(w.text, 'bash ls -la');
  assert.equal(zeileAus({ type: 'tool_execution_end', toolName: 'bash', entry: { data: { isError: false } } }), null);
  assert.equal(zeileAus({ type: 'tool_execution_end', toolName: 'bash', entry: { data: { isError: true } } }).typ, 'fehler');
  assert.match(zeileAus({ type: 'entry_appended', entry: { kind: 'fyos.eingang', data: { quelle: 'itsm', klasse: 'max', text: 'Hallo' } } }).text, /itsm \(Besitzer\): Hallo/);
  assert.equal(zeileAus({ type: 'entry_appended', entry: { kind: 'fyos.freigabe', data: { aktion: 'rm' } } }).typ, 'freigabe');
  assert.equal(zeileAus({ type: 'entry_appended', entry: { kind: 'unbekannt' } }), null);
  assert.equal(zeileAus({ type: 'run_end' }).typ, 'fertig');
  assert.equal(zeileAus({ type: 'task_failed', message: 'zu lang' }).typ, 'fehler');
  assert.equal(zeileAus({ type: 'irgendwas' }), null);
  assert.equal(zeileAus(undefined), null);
});

test('lange Texte werden gekürzt', () => {
  const z = zeileAus({ type: 'message_end', entry: { model: [{ role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(2000) }] }] } });
  assert.ok(z.text.length <= 400);
  assert.ok(z.text.endsWith('…'));
});
