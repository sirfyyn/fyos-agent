import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zeileAus } from '../src/wirken.js';

// pi-durable liefert einen Eingang als Nutzernachricht (`message_end` mit entry.kind), nicht als `entry_appended`.
test('ein Eingang als message_end wird zur Zeile „eingang“', () => {
  const z = zeileAus({ type: 'message_end', entry: { kind: 'fyos.eingang', data: { quelle: 'matrix', klasse: 'max', text: 'Hallo Persona' }, model: [{ role: 'user', content: 'x' }] } });
  assert.deepEqual(z, { typ: 'eingang', text: 'matrix (Besitzer): Hallo Persona' });
});

test('Mensch, Lauf-Auftrag und Freigabe-Entscheidung haben Zeilen, gleich ob message_end oder entry_appended', () => {
  for (const typ of ['message_end', 'entry_appended']) {
    assert.equal(zeileAus({ type: typ, entry: { kind: 'fyos.mensch', data: { text: 'ja' } } }).typ, 'mensch');
    assert.equal(zeileAus({ type: typ, entry: { kind: 'fyos.lauf.auftrag', data: { lauf: '3', titel: 'Prüfen' } } }).text, 'Lauf 3: Prüfen');
    assert.match(zeileAus({ type: typ, entry: { kind: 'fyos.freigabe-entscheidung', data: { id: 'fr-1', entscheidung: 'erteilt' } } }).text, /erteilt \(fr-1\)/);
  }
});

test('eine gewöhnliche Antwort bleibt eine „sagt“-Zeile', () => {
  const z = zeileAus({ type: 'message_end', entry: { kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'Fertig' }] }] } });
  assert.deepEqual(z, { typ: 'sagt', text: 'Fertig' });
});
