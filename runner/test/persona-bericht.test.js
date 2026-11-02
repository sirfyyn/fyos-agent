import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GRENZEN, berichtEintrag, berichtPruefen, berichtWerkzeuge } from '../src/persona/bericht.js';

test('Pflichtfelder: Überschrift und Befund fehlen → Fehler', () => {
  assert.throws(() => berichtPruefen({ befund: 'x' }), /ueberschrift fehlt/);
  assert.throws(() => berichtPruefen({ ueberschrift: 'x', befund: '  ' }), /befund fehlt/);
  assert.throws(() => berichtPruefen(undefined), /Kein Bericht/);
});

test('Leere optionale Felder fallen weg, Text wird getrimmt', () => {
  const f = berichtPruefen({ ueberschrift: ' Titel ', befund: 'fertig', beleg: '  ', rueckweg: undefined });
  assert.deepEqual(f, { ueberschrift: 'Titel', befund: 'fertig' });
});

test('Grenzen gelten je Feld', () => {
  assert.throws(() => berichtPruefen({ ueberschrift: 'x'.repeat(GRENZEN.ueberschrift + 1), befund: 'a' }), /ueberschrift/);
  assert.equal(berichtPruefen({ ueberschrift: 'u', befund: 'b'.repeat(GRENZEN.befund) }).befund.length, GRENZEN.befund);
});

test('Nicht-Text wird abgewiesen', () => {
  assert.throws(() => berichtPruefen({ ueberschrift: 'u', befund: 3 }), /muss Text sein/);
});

test('Eintrag: Kennung ist ein sicherer Dateiname und eindeutig je Zeit', () => {
  const e = berichtEintrag({ ueberschrift: 'u', befund: 'b' }, '../abc 1', 1_760_000_000_000);
  assert.equal(e.id, 'abc1-1760000000000');
  assert.equal(e.zeit_ms, 1_760_000_000_000);
  assert.equal(berichtEintrag({}, '', 5).id, 'unbekannt-5');
});

test('Werkzeug legt felder.json atomar ab und beendet den Zug', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'bericht-')), 'berichte');
  const [wz] = berichtWerkzeuge({ env: { FYOS_BERICHTE_DIR: dir }, jetzt: () => 42 });
  assert.equal(wz.name, 'persona_bericht');
  const api = { conversationId: 'gespraech-7', memo: async (_n, kandidat) => kandidat };
  const r = await wz.execute({ ueberschrift: 'Fertig', befund: 'Alles grün', beleg: 'PRB-1' }, api, {});
  assert.equal(r.output[0].text, 'Bericht abgelegt.');
  assert.equal(r.control.terminate, true);
  assert.deepEqual(readdirSync(dir), ['felder.json']);
  const datei = JSON.parse(readFileSync(join(dir, 'felder.json'), 'utf8'));
  assert.equal(datei.id, 'gespraech-7-42');
  assert.equal(datei.zeit_ms, 42);
  assert.deepEqual(datei.felder, { ueberschrift: 'Fertig', befund: 'Alles grün', beleg: 'PRB-1' });
});

test('Werkzeug nimmt die gemerkte Zeit: Wiederholen schreibt denselben Eintrag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bericht-'));
  let uhr = 100;
  const [wz] = berichtWerkzeuge({ env: { FYOS_BERICHTE_DIR: dir }, jetzt: () => uhr++ });
  const gemerkt = new Map();
  const api = {
    conversationId: 'c',
    memo: async (name, kandidat) => {
      if (!gemerkt.has(name)) gemerkt.set(name, kandidat);
      return gemerkt.get(name);
    },
  };
  const arg = { ueberschrift: 'u', befund: 'b' };
  await wz.execute(arg, api, {});
  const erst = readFileSync(join(dir, 'felder.json'), 'utf8');
  await wz.execute(arg, api, {});
  assert.equal(readFileSync(join(dir, 'felder.json'), 'utf8'), erst);
});

test('Werkzeug weist einen unvollständigen Bericht ab, ohne etwas zu schreiben', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'bericht-')), 'x');
  const [wz] = berichtWerkzeuge({ env: { FYOS_BERICHTE_DIR: dir } });
  await assert.rejects(wz.execute({ ueberschrift: 'u' }, { conversationId: 'c' }, {}), /befund fehlt/);
  assert.throws(() => readdirSync(dir));
});
