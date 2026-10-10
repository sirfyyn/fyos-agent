import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {lese_matrix_reaktion, ReaktionsSpeicher, verarbeite_reaktion} from './matrix-reaktionen.mjs';

const BESITZER = '@besitzer:matrix.example.com';
const reaction = (key, extra = {}) => ({event_id: '$r', type: 'm.reaction', sender: BESITZER, content: {'m.relates_to': {rel_type: 'm.annotation', event_id: '$frage', key}}, ...extra});

test('nur der Besitzer darf genau die drei Freigabe-Reaktionen erzeugen', () => {
  assert.equal(lese_matrix_reaktion('!raum:matrix', reaction('✅'), BESITZER).art, 'genehmigen');
  assert.equal(lese_matrix_reaktion('!raum:matrix', reaction('❌'), BESITZER).art, 'ablehnen');
  assert.equal(lese_matrix_reaktion('!raum:matrix', reaction('➕'), BESITZER).art, 'zusaetzliches');
  assert.equal(lese_matrix_reaktion('!raum:matrix', reaction('👍'), BESITZER), null);
  assert.equal(lese_matrix_reaktion('!raum:matrix', reaction('✅', {sender: '@fremd:matrix'}), BESITZER), null);
});

test('✅ schreibt Herkunft und entscheidet am selben Ticket', async () => {
  const speicher = new ReaktionsSpeicher({jetzt: () => 10});
  await speicher.merke_prompt({eventId: '$frage', ticket: 'CHG-42', raum: '!raum:matrix'});
  const aufrufe = [];
  const ergebnis = await verarbeite_reaktion(lese_matrix_reaktion('!raum:matrix', reaction('✅'), BESITZER), {speicher, board: {
    kommentiere: async (...args) => aufrufe.push(['kommentar', ...args]), setze_status: async (...args) => aufrufe.push(['status', ...args]),
  }});
  assert.deepEqual(ergebnis, {gehandelt: true, ticket: 'CHG-42', art: 'genehmigen'});
  assert.deepEqual(aufrufe.map((x) => x.slice(0, 2)), [['kommentar', 'CHG-42'], ['status', 'CHG-42']]);
  assert.equal(aufrufe[1][2], 'in_progress');
});

test('➕ speichert nur den Kommentar-Modus, keine Entscheidung', async () => {
  const speicher = new ReaktionsSpeicher({jetzt: () => 10});
  await speicher.merke_prompt({eventId: '$frage', ticket: 'CHG-42', raum: '!raum:matrix'});
  let status = 0;
  await verarbeite_reaktion(lese_matrix_reaktion('!raum:matrix', reaction('➕'), BESITZER), {speicher, board: {
    kommentiere: async () => {}, setze_status: async () => { status += 1; },
  }});
  assert.equal(status, 0);
  assert.equal(speicher.zusatz_fuer(BESITZER).ticket, 'CHG-42');
});

test('eine fremde oder doppelte Reaktion schreibt nichts', async () => {
  const speicher = new ReaktionsSpeicher({jetzt: () => 10});
  await speicher.merke_prompt({eventId: '$frage', ticket: 'CHG-42', raum: '!raum:matrix'});
  const board = {kommentiere: async () => assert.fail('darf nicht kommentieren'), setze_status: async () => assert.fail('darf nicht entscheiden')};
  assert.equal((await verarbeite_reaktion(null, {speicher, board})).gehandelt, false);
  await speicher.merke_verarbeitet('$r');
  assert.equal((await verarbeite_reaktion(lese_matrix_reaktion('!raum:matrix', reaction('✅'), BESITZER), {speicher, board})).gehandelt, false);
});

test('gleichzeitige Speicherungen teilen keinen temporären Dateinamen', async () => {
  const ordner = await mkdtemp(join(tmpdir(), 'fyos-matrix-'));
  const datei = join(ordner, 'reaktionen.json');
  try {
    const speicher = new ReaktionsSpeicher({datei, jetzt: () => 10});
    await Promise.all([
      speicher.merke_prompt({eventId: '$eins', ticket: 'CHG-1', raum: '!raum:matrix'}),
      speicher.merke_prompt({eventId: '$zwei', ticket: 'CHG-2', raum: '!raum:matrix'}),
      speicher.merke_verarbeitet('$antwort'),
    ]);
    const gesichert = JSON.parse(await readFile(datei, 'utf8'));
    assert.equal(gesichert.prompts.$eins.ticket, 'CHG-1');
    assert.equal(gesichert.prompts.$zwei.ticket, 'CHG-2');
    assert.equal(typeof gesichert.verarbeitet.$antwort, 'number');
  } finally {
    await rm(ordner, {recursive: true, force: true});
  }
});
