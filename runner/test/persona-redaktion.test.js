import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ergebnisSchwaerzen, jsonSchwaerzen, redaktionHooks, schwaerzen } from '../src/persona/redaktion.js';

test('Zugangsdaten werden geschwärzt', () => {
  assert.equal(schwaerzen('Bearer abcdefghijklmnop123'), 'Bearer [geschwärzt]');
  assert.equal(schwaerzen('token=geheim123'), 'token=[geschwärzt]');
  assert.equal(schwaerzen('api_key: abc123xyz'), 'api_key: [geschwärzt]');
  assert.equal(schwaerzen('ghp_' + 'a'.repeat(20)), '[geschwärzt]');
  assert.equal(schwaerzen('commit ' + 'f'.repeat(40)), 'commit [geschwärzt]');
});

test('private Abschnitte fallen weg, auch über Zeilen', () => {
  assert.equal(schwaerzen('vorher <private>Alex\n12:00</private> nachher'), 'vorher [privat] nachher');
});

test('normaler Text bleibt unverändert', () => {
  assert.equal(schwaerzen('Dienst läuft, 3 Jobs offen'), 'Dienst läuft, 3 Jobs offen');
});

test('ergebnisSchwaerzen: nichts zu tun gibt undefined, Bilder bleiben', () => {
  assert.equal(ergebnisSchwaerzen([{ type: 'text', text: 'ok' }]), undefined);
  const bild = { type: 'image', data: 'AAAA' };
  const neu = ergebnisSchwaerzen([{ type: 'text', text: 'token=xyz987' }, bild]);
  assert.ok(neu);
  assert.equal(neu[0].text, 'token=[geschwärzt]');
  assert.deepEqual(neu[1], bild);
});

test('jsonSchwaerzen hält die Form und schwärzt alle Textwerte', () => {
  assert.deepEqual(jsonSchwaerzen({ a: ['token=abc1', 3, null], b: { c: 'ok' } }), { a: ['token=[geschwärzt]', 3, null], b: { c: 'ok' } });
});

test('Hook afterTool: ersetzt den Text, lässt Unverändertes (undefined) in Ruhe', async () => {
  const [h] = redaktionHooks();
  assert.equal(h.task, 'pi.tool');
  const { afterTool } = h.handlers;
  assert.equal(await afterTool({}, { output: [{ type: 'text', text: 'alles gut' }] }), undefined);
  assert.equal(await afterTool({}, { isError: true }), undefined);
  const r = await afterTool(
    {},
    { output: [{ type: 'text', text: 'password: hunter2' }], details: { x: 1 }, structuredOutput: { s: 'secret=abc' } },
  );
  assert.equal(r.output[0].text, 'password: [geschwärzt]');
  assert.deepEqual(r.details, { x: 1 });
  assert.deepEqual(r.structuredOutput, { s: 'secret=[geschwärzt]' });
});
