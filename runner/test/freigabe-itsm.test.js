/**
 * Tests der ITSM-Freigaben in der Matrix-Wache (freigabe-itsm.js). Hub ist eine Attrappe; es wird nichts gesendet oder entschieden.
 * Geprüft: Abbildung eines braucht_dich-Eintrags, nur offene Freigaben, Quelle Runner + ITSM, Hub-Ausfall, Entscheidung (erlauben/
 * ablehnen, Kennung ohne Präfix an den Runner), schon entschieden, die Wache meldet eine ITSM-Freigabe genau einmal.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { neueFreigabe } from '../src/documents.js';
import { FreigabeMeldung, konfigNormalisieren } from '../src/freigabe-meldung.js';
import { freigabenEntscheiden, freigabenQuelle, itsmFreigabe, itsmFreigabenAus } from '../src/freigabe-itsm.js';

const T0 = Date.UTC(2026, 6, 15, 10, 0, 0); // 12:00 Berlin, keine Ruhezeit
const MIN = 60_000;
const still = { info() {}, warn() {} };

const eintrag = (extra = {}) => ({
  id: 'CHG-5142',
  art: 'freigabe',
  quelle: 'itsm',
  status: 'waiting_approval',
  titel: 'Probe',
  worauf: 'max: Freigabe — Probe der Matrix-Chips',
  risiko: 'low',
  zerstoererisch: false,
  kontext: 'Es wird nichts geaendert. Bitte den Haken tippen.',
  seit: new Date(T0 - 10 * MIN).toISOString(),
  ...extra,
});

const hubMit = (daten, aufrufe = []) => ({
  konfiguriert: true,
  aufrufen: async (tool, args) => {
    aufrufe.push({ tool, args });
    if (daten instanceof Error) throw daten;
    return daten;
  },
});

test('Eintrag wird zu einer offenen Freigabe mit Präfix, Kontext und Alter', () => {
  const f = itsmFreigabe(eintrag());
  assert.equal(f.id, 'itsm:CHG-5142');
  assert.equal(f.status, 'offen');
  assert.equal(f.risiko, 'low');
  assert.equal(f.zerstoererisch, false);
  assert.equal(f.aktion, 'Probe der Matrix-Chips');
  assert.match(f.kontext, /Haken tippen/);
  assert.equal(f.erstellt, T0 - 10 * MIN);
});

test('hohes Risiko gilt als zerstörerisch, unbekanntes Risiko als mittel', () => {
  assert.equal(itsmFreigabe(eintrag({ risiko: 'high' })).zerstoererisch, true);
  assert.equal(itsmFreigabe(eintrag({ risiko: 'komisch' })).risiko, 'medium');
});

test('nur offene Freigaben am Vorgang kommen durch', () => {
  const liste = itsmFreigabenAus({
    eintraege: [
      eintrag(),
      eintrag({ id: 'INC-1', art: 'ticket' }),
      eintrag({ id: 'CHG-2', status: 'in_progress' }),
      eintrag({ id: 'CHG-3', quelle: 'runner' }),
      { art: 'entscheidung', id: 'decision:x' },
    ],
  });
  assert.deepEqual(liste.map((f) => f.id), ['itsm:CHG-5142']);
});

test('Quelle: Runner-Freigaben und ITSM-Freigaben zusammen', async () => {
  const eigene = [{ ...neueFreigabe({ id: 'f1', conversationId: 1, aktion: 'A', risiko: 'low' }), erstellt: T0 }];
  const quelle = freigabenQuelle({
    runnerFreigaben: async () => eigene,
    hub: hubMit({ ok: true, result: { eintraege: [eintrag()] } }),
  });
  assert.deepEqual((await quelle()).map((f) => f.id), ['f1', 'itsm:CHG-5142']);
});

test('Hub-Ausfall: nur Runner-Freigaben, ein Logeintrag je Grund', async () => {
  const logs = [];
  const quelle = freigabenQuelle({
    runnerFreigaben: async () => [{ id: 'f1' }],
    hub: hubMit(new Error('Hub nicht erreichbar')),
    log: (t) => logs.push(t),
  });
  assert.deepEqual(await quelle(), [{ id: 'f1' }]);
  await quelle();
  assert.equal(logs.length, 1);
});

test('Hub fällt kurz aus: die zuletzt gelesenen ITSM-Freigaben bleiben in der Liste', async () => {
  let antwort = { ok: true, result: { eintraege: [eintrag()] } };
  const hub = { konfiguriert: true, aufrufen: async () => (antwort instanceof Error ? Promise.reject(antwort) : antwort) };
  const quelle = freigabenQuelle({ runnerFreigaben: async () => [], hub, log: () => {} });
  assert.deepEqual((await quelle()).map((f) => f.id), ['itsm:CHG-5142']);
  antwort = new Error('Hub-Zeitüberschreitung');
  assert.deepEqual((await quelle()).map((f) => f.id), ['itsm:CHG-5142'], 'bei Ausfall keine Freigabe verlieren');
});

test('Hub-Antwort mit Fehler: nur Runner-Freigaben', async () => {
  const quelle = freigabenQuelle({
    runnerFreigaben: async () => [{ id: 'f1' }],
    hub: hubMit({ ok: false, fehler: 'kaputt' }),
  });
  assert.deepEqual(await quelle(), [{ id: 'f1' }]);
});

test('ohne Hub bleibt es bei den Runner-Freigaben', async () => {
  const quelle = freigabenQuelle({ runnerFreigaben: async () => [{ id: 'f1' }], hub: { konfiguriert: false } });
  assert.deepEqual(await quelle(), [{ id: 'f1' }]);
});

test('Entscheidung: itsm-Kennung → leitstand.freigabe, andere → Runner', async () => {
  const aufrufe = [];
  const runner = [];
  const entscheiden = freigabenEntscheiden({
    runnerEntscheiden: async (id, o) => void runner.push([id, o.entscheidung]),
    hub: hubMit({ ok: true, result: { ok: true } }, aufrufe),
  });
  await entscheiden('itsm:CHG-5142', { entscheidung: 'erteilt', notiz: 'per Matrix-Reaktion ✅', von: 'matrix-reaktion' });
  await entscheiden('itsm:CHG-5142', { entscheidung: 'abgelehnt' });
  await entscheiden('f1', { entscheidung: 'erteilt' });
  assert.deepEqual(aufrufe.map((a) => [a.tool, a.args.id, a.args.entscheidung, a.args.expected_status]), [
    ['leitstand.freigabe', 'CHG-5142', 'erlauben', 'waiting_approval'],
    ['leitstand.freigabe', 'CHG-5142', 'ablehnen', 'waiting_approval'],
  ]);
  assert.match(aufrufe[0].args.begruendung, /Matrix-Reaktion/);
  assert.ok(aufrufe.every((a) => a.args.ausfuehren === true), 'sonst bleibt es ein Trockenlauf');
  assert.deepEqual(runner, [['f1', 'erteilt']]);
});

test('schon anders entschieden: „bereits“, damit der Chip nicht als Fehler zählt', async () => {
  const entscheiden = freigabenEntscheiden({
    runnerEntscheiden: async () => {},
    hub: hubMit({ ok: false, fehler: 'CHG-5142 ist nicht waiting_approval' }),
  });
  await assert.rejects(() => entscheiden('itsm:CHG-5142', { entscheidung: 'erteilt' }), /bereits/);
});

test('unbekannte Entscheidung wird abgelehnt, ohne den Hub zu rufen', async () => {
  const aufrufe = [];
  const entscheiden = freigabenEntscheiden({ runnerEntscheiden: async () => {}, hub: hubMit({ ok: true, result: {} }, aufrufe) });
  await assert.rejects(() => entscheiden('itsm:CHG-5142', { entscheidung: 'vielleicht' }), /Unbekannte/);
  assert.equal(aufrufe.length, 0);
});

test('die Wache meldet eine ITSM-Freigabe genau einmal über den Kanal', async () => {
  const gesendet = [];
  const kanal = { name: 'matrix', befehl: false, kontextMax: 600, senden: async (n) => (gesendet.push(n), { ok: true }) };
  const d = { freigabemeldung: {} };
  const speicher = { lesen: async () => JSON.parse(JSON.stringify(d)), aendern: async (fn) => void fn(d) };
  const quelle = freigabenQuelle({
    runnerFreigaben: async () => [],
    hub: hubMit({ ok: true, result: { eintraege: [eintrag()] } }),
  });
  const wache = new FreigabeMeldung({
    cfg: {},
    kanaele: [kanal],
    freigaben: quelle,
    speicher,
    log: still,
    jetzt: () => T0,
    konfig: konfigNormalisieren({ kanaele: ['matrix'], buendel_s: 0 }),
  });
  await wache.pruefen();
  await wache.pruefen();
  assert.equal(gesendet.length, 1);
  assert.match(gesendet[0].text, /Haken tippen/);
  assert.match(gesendet[0].text, /Probe der Matrix-Chips/);
});
