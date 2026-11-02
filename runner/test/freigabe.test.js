import assert from 'node:assert/strict';
import { test } from 'node:test';
import { konfigurationLaden } from '../src/config.js';
import { Freigaben } from '../src/documents.js';
import { hubWerkzeuge } from '../src/tools.js';

// Besitzer 24.10.2026: nur Destruktives geht durch eine Freigabe.
function aufrufer(scope, { pflicht } = {}) {
  const cfg = konfigurationLaden(pflicht ? { pi_durable: { security: { freigabePflicht: pflicht } } } : {}, {});
  const hub = { scope: async () => scope, aufrufen: async () => ({ ok: true, result: 'erledigt' }) };
  const wz = hubWerkzeuge({ cfg, hub }).find((t) => t.name === 'hub_aufrufen');
  const api = { snapshot: async () => ({ eintraege: {} }), conversationId: 'c', commit: async () => {} };
  return (args) => wz.execute({ werkzeug: 'x.y', ...args }, api, {});
}

test('ausführende und schreibende Hub-Werkzeuge laufen ohne Freigabe', async () => {
  for (const scope of ['READ', 'WRITE', 'EXEC', 'EXTERN']) {
    const r = await aufrufer(scope)({});
    assert.match(r.output[0].text, /erledigt/, scope);
  }
});

// Befund 26.10.2026: die Pauschalregel (Karten VOR-4987 bis VOR-5028) lebte in der Pi-Erweiterung fyos-freigabe des alten
// RPC-Runners (Standard-Verbot nach Namen). Im neuen Runner zählt nur der Wirkungsgrad; das hier hält es fest.
test('Lese-Werkzeuge und Werkzeuge ohne Wirkungs-Tag brauchen nie eine Freigabe, auch mit Namen aus den alten Karten', async () => {
  const { scopeAusTags } = await import('../src/hub.js');
  assert.equal(scopeAusTags([]), 'READ', 'ohne Tag gilt READ');
  assert.equal(scopeAusTags(undefined), 'READ');
  assert.equal(scopeAusTags(['read']), 'READ');
  assert.equal(scopeAusTags(['read', 'destructive']), 'DESTRUCTIVE', 'das Höchste zählt');
  const cfg = konfigurationLaden({}, {});
  for (const name of ['hub.search_tools', 'seco.zustand', 'cluster.lage', 'kontextbuch_lesen', 'hintergrund_liste', 'mcp__fyos__hub__call_tool', 'matrix_senden']) {
    const hub = { scope: async () => 'READ', aufrufen: async () => ({ ok: true, result: 'gelesen' }) };
    const wz = hubWerkzeuge({ cfg, hub }).find((t) => t.name === 'hub_aufrufen');
    const api = { snapshot: async () => ({ eintraege: {} }), conversationId: 'c', commit: async () => {} };
    const r = await wz.execute({ werkzeug: name }, api, {});
    assert.match(r.output[0].text, /gelesen/, name);
  }
});

test('zerstörende Hub-Werkzeuge verlangen eine Freigabe', async () => {
  await assert.rejects(aufrufer('DESTRUCTIVE')({}), /freigabe_bitten/);
  await assert.rejects(aufrufer('DESTRUCTIVE')({ freigabe_id: 'fr-gibt-es-nicht' }), /unbekannt/);
});

test('wer mehr will, kann es einstellen', async () => {
  await assert.rejects(aufrufer('EXEC', { pflicht: ['DESTRUCTIVE', 'EXEC'] })({}), /freigabe_bitten/);
});

test('eine erteilte Freigabe wird verbraucht und gilt nur für das Werkzeug', async () => {
  const cfg = konfigurationLaden({}, {});
  const doc = {
    eintraege: {
      'fr-1': { id: 'fr-1', status: 'erteilt', conversationId: 'c', werkzeug: 'x.y', entschieden: Date.now() },
      'fr-2': { id: 'fr-2', status: 'erteilt', conversationId: 'c', werkzeug: 'anders', entschieden: Date.now() },
    },
  };
  const hub = { scope: async () => 'DESTRUCTIVE', aufrufen: async () => ({ ok: true, result: 'weg' }) };
  const wz = hubWerkzeuge({ cfg, hub }).find((t) => t.name === 'hub_aufrufen');
  const api = {
    snapshot: async (token) => (token === Freigaben ? doc : null),
    conversationId: 'c',
    commit: async (fn) => fn({ doc: async () => doc }),
  };
  await assert.rejects(wz.execute({ werkzeug: 'x.y', freigabe_id: 'fr-2' }, api, {}), /gilt für/);
  const ok = await wz.execute({ werkzeug: 'x.y', freigabe_id: 'fr-1' }, api, {});
  assert.match(ok.output[0].text, /weg/);
  assert.equal(doc.eintraege['fr-1'].verbraucht, true);
  await assert.rejects(wz.execute({ werkzeug: 'x.y', freigabe_id: 'fr-1' }, api, {}), /verbraucht/);
});
