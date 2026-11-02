/**
 * sprachwahl.test.js — the runner speaks German or English (`pi_durable.sprache`, Besitzer-Entscheidung Nr. 739).
 *
 * German stays the default (Persona notices nothing); English when set: configuration, API errors, the served page,
 * the web client's table, the runner's own prompt sections and tool descriptions, approval notices.
 * Every test that switches to English switches back, so the German tests in the same process are unaffected.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { konfigurationLaden } from '../src/config.js';
import { fehlerText, sprache, spracheSetzen, tx } from '../src/i18n.js';
import { erstelleServer } from '../src/server.js';
import { hubWerkzeuge } from '../src/tools.js';
import { nachrichtBauen } from '../src/freigabe-meldung.js';
import { freigabeHinweis } from '../src/freigabe-befehl.js';
import { fyosExtension } from '../src/extension.js';
import { EN, spracheSetzen as uiSprache, t } from '../public/i18n.js';

const HIER = dirname(fileURLToPath(import.meta.url));

async function englisch(fn) {
  spracheSetzen('en');
  try {
    return await fn();
  } finally {
    spracheSetzen('de');
  }
}

test('Vorgabe ist Deutsch; tx und fehlerText ändern dann nichts', () => {
  assert.equal(sprache(), 'de');
  assert.equal(tx('Gespräch', 'Conversation'), 'Gespräch');
  assert.equal(fehlerText('Gespräch nicht gefunden'), 'Gespräch nicht gefunden');
});

test('Konfiguration: Vorgabe de, lokaler Modus en, Datei und Umgebung setzen', () => {
  assert.equal(konfigurationLaden({}, {}).pi_durable.sprache, 'de');
  assert.equal(konfigurationLaden({}, { FYOS_RUNNER_LOKAL: '1' }).pi_durable.sprache, 'en');
  assert.equal(konfigurationLaden({ pi_durable: { sprache: 'en' } }, {}).pi_durable.sprache, 'en');
  assert.equal(konfigurationLaden({ pi_durable: { sprache: 'en' } }, { FYOS_RUNNER_SPRACHE: 'de' }).pi_durable.sprache, 'de');
  assert.equal(konfigurationLaden({}, { FYOS_RUNNER_LOKAL: '1', FYOS_RUNNER_SPRACHE: 'de' }).pi_durable.sprache, 'de');
  assert.equal(konfigurationLaden({ pi_durable: { sprache: 'klingonisch' } }, {}).pi_durable.sprache, 'de');
  // Die öffentliche Vorlage ist englisch.
  const vorlage = JSON.parse(readFileSync(join(HIER, '..', 'beispiele', 'agent-runner.beispiel.json'), 'utf8'));
  assert.equal(vorlage.pi_durable.sprache, 'en');
});

test('API-Fehler auf Englisch: genau und nach Muster, Unbekanntes bleibt', async () => {
  await englisch(() => {
    assert.equal(fehlerText('Gespräch nicht gefunden'), 'Conversation not found');
    assert.equal(fehlerText('Unbekannte Route: GET /api/x'), 'Unknown route: GET /api/x');
    assert.equal(fehlerText('Ordner abgelehnt (ausserhalb): Pfad liegt außerhalb der erlaubten Wurzeln'), 'Folder rejected (ausserhalb): Path is outside the allowed roots');
    assert.equal(fehlerText('q darf höchstens 200 Zeichen haben'), 'q may have at most 200 characters');
    assert.equal(fehlerText('etwas ganz anderes'), 'etwas ganz anderes');
  });
});

test('Server: Fehler und ausgelieferte Seite folgen der Sprache', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sprachwahl-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, 'index.html'), '<!doctype html>\n<html lang="de"><title>x</title></html>');
  const cfg = { pi_durable: { security: { token: '', allowedOrigins: [] }, limits: { maxBodyBytes: 65536 }, clientDir: tmp } };
  const server = erstelleServer({ runner: {}, cfg });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  const hole = (pfad) =>
    new Promise((fertig, scheitern) => {
      http
        .get({ host: '127.0.0.1', port, path: pfad, agent: false }, (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (s) => (text += s));
          res.on('end', () => fertig({ status: res.statusCode, text }));
        })
        .on('error', scheitern);
    });
  try {
    const de = await hole('/api/gibt-es-nicht');
    assert.equal(de.status, 404);
    assert.match(JSON.parse(de.text).fehler, /^Unbekannte Route/);
    assert.match((await hole('/')).text, /<html lang="de">/);
    await englisch(async () => {
      const en = await hole('/api/gibt-es-nicht');
      assert.equal(en.status, 404);
      assert.equal(JSON.parse(en.text).fehler, 'Unknown route: GET /api/gibt-es-nicht');
      assert.match((await hole('/')).text, /<html lang="en">/);
      assert.equal(JSON.parse((await hole('/gibt-es-nicht.css')).text).fehler, 'Not found');
    });
  } finally {
    await new Promise((ok) => server.close(ok));
  }
});

test('Weboberfläche: jeder t()-Text in app.js steht in der Tabelle, Platzhalter werden gefüllt', () => {
  const app = readFileSync(join(HIER, '..', 'public', 'app.js'), 'utf8');
  const schluessel = [...app.matchAll(/\b(?:t|tr)\('((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
  assert.ok(schluessel.length > 100, `zu wenige Texte gefunden: ${schluessel.length}`);
  const fehlt = schluessel.filter((k) => !Object.hasOwn(EN, k) && !/^[a-z]+$/.test(k));
  assert.deepEqual(fehlt, [], 'Texte ohne englische Fassung');
  uiSprache('de');
  assert.equal(t('vor {n} min', { n: 3 }), 'vor 3 min');
  uiSprache('en');
  try {
    assert.equal(t('vor {n} min', { n: 3 }), '3 min ago');
    assert.equal(t('Gespräche'), 'Conversations');
    assert.equal(t('nicht in der Tabelle'), 'nicht in der Tabelle');
  } finally {
    uiSprache('de');
  }
  // Die festen Texte der Seite: jeder Knopf und jede Überschrift aus index.html steht in der Tabelle.
  const html = readFileSync(join(HIER, '..', 'public', 'index.html'), 'utf8');
  for (const text of ['Gespräche', 'Freigaben', 'Neuer Lauf', 'Geteilter Zustand', 'Verlauf exportieren', 'Vor dem Abschluss Freigabe einholen']) {
    assert.ok(html.includes(text), text);
    assert.ok(Object.hasOwn(EN, text), text);
  }
});

test('Prompt und Werkzeuge: englische Beschreibung, gleiche Namen', async () => {
  const cfg = { hub: '', agent: 'agent', pi_durable: { limits: { maxToolOutput: 4000 }, security: {} } };
  const hub = { suchen: async () => [], schema: async () => ({}), scope: async () => 'READ', aufrufen: async () => ({ ok: true }) };
  const de = hubWerkzeuge({ cfg, hub });
  const en = await englisch(() => hubWerkzeuge({ cfg, hub }));
  assert.deepEqual(en.map((w) => w.name), de.map((w) => w.name), 'Werkzeugnamen bleiben (Vertrag mit dem Hub)');
  const bitten = (liste) => liste.find((w) => w.name === 'freigabe_bitten');
  assert.match(bitten(de).description, /Bittet einen Menschen/);
  assert.match(bitten(en).description, /^Asks a human to approve/);
  assert.match(freigabeHinweis('rm -rf /tmp/x'), /^Zerstörend/);
  assert.match(await englisch(() => freigabeHinweis('rm -rf /tmp/x')), /^Destructive, so it needs an approval/);
});

test('Prompt-Abschnitte: Rolle und Werkzeugregeln englisch, deutsch bleibt Vorgabe', async () => {
  const abschnitt = (cfg, key) => fyosExtension({ cfg }).sections.find((s) => s.key === key);
  for (const env of [{}, { FYOS_RUNNER_LOKAL: '1' }]) {
    const cfg = konfigurationLaden({}, env);
    assert.match(await abschnitt(cfg, 'fyos-rolle').render(), /^Du bist/);
    await englisch(async () => {
      assert.match(await abschnitt(cfg, 'fyos-rolle').render(), /^You are /);
      const regeln = await abschnitt(cfg, 'fyos-werkzeuge').render();
      assert.match(regeln, /^Tools:/);
      assert.match(regeln, /freigabe_bitten/, 'Werkzeugnamen bleiben');
    });
  }
});

test('Freigabe-Meldung (Matrix/ntfy) auf Englisch', async () => {
  const f = { id: 'fr-1', aktion: 'Ordner löschen', risiko: 'high', erstellt: 1000, kontext: 'Kontext.' };
  const bauen = () => nachrichtBauen({ art: 'neu', liste: [f], kanal: {}, kfg: { link: '' }, jetzt: 1000 + 5 * 60_000 });
  assert.match(bauen().titel, /^Freigabe nötig/);
  const en = await englisch(bauen);
  assert.equal(en.titel, 'Approval needed (high risk)');
  assert.match(en.text, /Risk: high/);
  assert.match(en.text, /Open for 5 min/);
});
