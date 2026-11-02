import assert from 'node:assert/strict';
import { test } from 'node:test';
import { neueFreigabe } from '../src/documents.js';

const basis = { id: 'fr-z', conversationId: 'c1', aktion: 'Etwas tun' };

test('Risiko hoch gilt immer als zerstörerisch, auch ohne das Flag', () => {
  assert.equal(neueFreigabe({ ...basis, risiko: 'high' }).zerstoererisch, true);
});

test('niedriges und mittleres Risiko sind nicht zerstörerisch, solange das Flag fehlt', () => {
  assert.equal(neueFreigabe({ ...basis, risiko: 'low' }).zerstoererisch, false);
  assert.equal(neueFreigabe({ ...basis, risiko: 'medium' }).zerstoererisch, false);
  assert.equal(neueFreigabe({ ...basis }).zerstoererisch, false);
});

test('das Flag bleibt auch bei niedrigem Risiko erhalten', () => {
  assert.equal(neueFreigabe({ ...basis, risiko: 'low', zerstoererisch: true }).zerstoererisch, true);
});
