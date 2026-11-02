/**
 * Freigabe-Kontext (Entscheidung 586): jede Freigabe trägt 3 bis 5 Sätze Kurzkontext. Geprüft wird die Prüfung selbst
 * (Satzzahl, Länge, Geheimnis, roher Befehl), der Rückfall, das Werkzeug `freigabe_bitten` und die Weitergabe bis
 * `/api/freigaben`, zum Egress-Ereignis `proposal` und in den Meldetext (Matrix/ntfy) mit einem Faux-Modell.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { konfigurationLaden } from '../src/config.js';
import { Egress } from '../src/egress.js';
import { Register, neueFreigabe } from '../src/documents.js';
import {
  KONTEXT_MAX,
  befehlKurz,
  kontextAnzeigen,
  kontextFallback,
  kontextKuerzen,
  kontextPruefen,
  kontextZaehler,
  zaehleSaetze,
} from '../src/freigabe-kontext.js';
import { FreigabeMeldung, konfigNormalisieren, nachrichtBauen } from '../src/freigabe-meldung.js';
import { Runner } from '../src/runner.js';
import { erstelleServer } from '../src/server.js';
import { hubWerkzeuge } from '../src/tools.js';

const warte = (ms) => new Promise((r) => setTimeout(r, ms));
async function bis(fn, { ms = 15000, was = 'Bedingung' } = {}) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    const wert = await fn().catch(() => null);
    if (wert) return wert;
    await warte(100);
  }
  throw new Error(`Zeit abgelaufen: ${was}`);
}

const GUT =
  'Der Agent soll den Zweig alt-test im Repo fyos löschen. Anlass ist der Vorgang VOR-4870, der den Zweig als erledigt führt. ' +
  'Die Wirkung: der Zweig verschwindet lokal und auf dem Server. Das Risiko ist mittel, weil unveröffentlichte Commits fehlen könnten. ' +
  'Rückweg: Der Zweig lässt sich aus dem Reflog oder von der Spiegelung wiederherstellen.';

const eingabe = {
  aktion: 'Zweig alt-test löschen',
  risiko: 'medium',
  werkzeug: 'bash',
  befehl: 'git branch -D alt-test',
  titel: 'Aufräumen',
  quelle: 'itsm',
  vorgang: 'VOR-4870',
};

// --- Prüfung ---------------------------------------------------------------------------------------------------------

test('Sätze zählen: Abkürzungen, Zahlen und Pfade zählen nicht als Satzende', () => {
  assert.equal(zaehleSaetze(GUT), 5);
  assert.equal(zaehleSaetze('Eins. Zwei! Drei?'), 3);
  assert.equal(zaehleSaetze('Das gilt z. B. für /srv/a.txt und v1.2 sowie ca. 3.5 GB. Danach ist Ruhe. Ende.'), 3);
  assert.equal(zaehleSaetze('  '), 0);
  assert.equal(zaehleSaetze('Nur ein Satz ohne Punkt'), 1);
});

test('Kontext vom Modell: 3 bis 5 Sätze, kurz, ohne Geheimnis und ohne rohen Befehl gilt unverändert', () => {
  const r = kontextPruefen(GUT, eingabe);
  assert.equal(r.herkunft, 'modell');
  assert.equal(r.abweichung, null);
  assert.equal(r.text, GUT);
  assert.equal(kontextPruefen('Drei Sätze. Gut so. Wirklich.', eingabe).herkunft, 'modell', 'genau 3 ist erlaubt');
});

test('Kontext fehlt: Rückfall, nie leer, Abweichung „fehlt“', () => {
  for (const roh of [undefined, null, '', '   \n ']) {
    const r = kontextPruefen(roh, eingabe);
    assert.equal(r.herkunft, 'rueckfall');
    assert.equal(r.abweichung, 'fehlt');
    assert.ok(r.text.length > 40);
    assert.ok(zaehleSaetze(r.text) >= 3 && zaehleSaetze(r.text) <= 5);
  }
});

test('Zu lang oder zu viele/zu wenige Sätze: nicht abgelehnt, sondern Rückfalltext mit Grund', () => {
  const lang = kontextPruefen(`${GUT} ${'Mehr Text. '.repeat(40)}`, eingabe);
  assert.equal(lang.abweichung, 'zu_lang');
  assert.equal(lang.herkunft, 'rueckfall');
  assert.ok(lang.text.length <= KONTEXT_MAX);

  const sechs = kontextPruefen('Eins ist da. Zwei ist da. Drei ist da. Vier ist da. Fünf ist da. Sechs ist da.', eingabe);
  assert.equal(sechs.abweichung, 'saetze');
  const zwei = kontextPruefen('Nur zwei Sätze. Das ist zu knapp.', eingabe);
  assert.equal(zwei.abweichung, 'saetze');
  for (const r of [sechs, zwei]) assert.match(r.text, /Zweig alt-test löschen/, 'der Rückfall nennt die Aktion');
});

test('Geheimnis im Kontext: der Text des Modells wird nicht übernommen, es gilt der Rückfall ohne das Geheimnis', () => {
  const geheim = [
    'Der Agent löscht den Zweig. Dazu nutzt er Token: abcdef123456 aus der Umgebung. Das ist ein Test.', // gitleaks:allow (Testattrappe)
    'Der Agent löscht den Zweig mit ghp_AbCdEf1234567890xyz im Push. Es wirkt auf den Server. Rückweg ist der Reflog.', // sauber: ok (Testattrappe)
    'Der Agent löscht den Zweig. Er meldet sich als https://max:passwort123@git.test/r.git an. Rückweg ist der Reflog.', // sauber: ok (Testattrappe)
  ];
  for (const roh of geheim) {
    const r = kontextPruefen(roh, eingabe);
    assert.equal(r.abweichung, 'geheimnis', roh);
    assert.equal(r.herkunft, 'rueckfall');
    for (const spur of ['abcdef123456', 'ghp_', 'passwort123']) assert.ok(!r.text.includes(spur), spur);
  }
});

test('Der rohe Befehl gehört nicht in den Kontext (er hat ein eigenes Feld)', () => {
  const r = kontextPruefen('Der Agent führt git branch -D alt-test aus. Das löscht den Zweig. Rückweg ist der Reflog.', eingabe);
  assert.equal(r.abweichung, 'befehl');
  assert.ok(!r.text.includes('git branch -D alt-test'));
});

test('Rückfall: aus Quelle, Vorgang, Werkzeug und Ziel; 3 bis 5 Sätze; weder roher Befehl noch Geheimnis', () => {
  const text = kontextFallback({
    aktion: 'Altes Verzeichnis löschen',
    risiko: 'high',
    zerstoererisch: true,
    werkzeug: 'bash',
    befehl: 'rm -rf /srv/daten/alt --token=geheim12345678901234', // gitleaks:allow (Testattrappe)
    titel: 'Hauptserver aufräumen',
    quelle: 'itsm',
    vorgang: 'VOR-4870',
  });
  assert.ok(zaehleSaetze(text) >= 3 && zaehleSaetze(text) <= 5, text);
  assert.ok(text.length <= KONTEXT_MAX);
  for (const muss of ['Altes Verzeichnis löschen', 'rm', '/srv/daten/alt', 'VOR-4870', 'itsm', 'Hauptserver aufräumen', 'hoch', 'Ablehnen']) {
    assert.ok(text.includes(muss), `„${muss}“ fehlt in: ${text}`);
  }
  assert.ok(!text.includes('rm -rf'), 'kein roher Befehl');
  assert.ok(!text.includes('geheim12345'), 'kein Geheimnis');
  // Ohne jede Angabe bleibt es ein lesbarer, nicht leerer Text.
  const leer = kontextFallback({});
  assert.ok(zaehleSaetze(leer) >= 3 && leer.length > 60, leer);
  // Vorgang aus dem Titel, wenn nicht genannt.
  assert.match(kontextFallback({ aktion: 'X', titel: 'Arbeit an VOR-123' }), /Vorgang VOR-123/);
});

test('Rückfall für den Lauf-Abschluss: eigene Wirkung und eigener Rückweg, Auftrag und Vorgang genannt', () => {
  const text = kontextFallback({
    aktion: 'Lauf abschließen: Backups prüfen',
    risiko: 'medium',
    titel: 'Backups prüfen',
    quelle: 'itsm',
    vorgang: 'VOR-77',
    wirkung: 'der Lauf hat eine Antwort erarbeitet und gilt erst nach der Zustimmung als abgeschlossen',
    rueckweg: 'Ablehnen beendet den Lauf ohne Abschluss; die erarbeitete Antwort bleibt nachlesbar',
  });
  assert.equal(zaehleSaetze(text), 4, text);
  for (const muss of ['Backups prüfen', 'VOR-77', 'itsm', 'gilt erst nach der Zustimmung', 'Ablehnen beendet den Lauf']) assert.ok(text.includes(muss), muss);
});

test('Programm und Ziel aus einem Befehl; Umgebungsvariablen und Optionen zählen nicht', () => {
  assert.deepEqual(befehlKurz('FOO=1 /usr/bin/rm -rf /srv/x'), { programm: 'rm', ziel: '/srv/x' });
  assert.deepEqual(befehlKurz('git push --force'), { programm: 'git', ziel: '' });
  assert.deepEqual(befehlKurz(''), { programm: '', ziel: '' });
});

test('Anzeige: vorhandener Kontext (geschwärzt) oder Rückfall bei älteren Einträgen; Kürzen an Satzgrenzen', () => {
  assert.equal(kontextAnzeigen({ kontext: GUT, aktion: 'A' }), GUT);
  assert.ok(!kontextAnzeigen({ kontext: 'Es gilt Token: abcdef123456 hier.', aktion: 'A' }).includes('abcdef123456')); // gitleaks:allow (Testattrappe)
  const alt = kontextAnzeigen({ aktion: 'Zweig löschen', risiko: 'low', kontext: '' });
  assert.match(alt, /Zweig löschen/);
  assert.ok(zaehleSaetze(alt) >= 3);
  const kurz = kontextKuerzen(GUT, 200);
  assert.ok(kurz.length <= 200 && kurz.endsWith('.'), kurz);
  assert.equal(kontextKuerzen('abc', 200), 'abc');
  assert.ok(kontextKuerzen('x'.repeat(500), 50).length <= 50);
});

// --- Werkzeug freigabe_bitten ----------------------------------------------------------------------------------------

function fakeApi() {
  const doc = { eintraege: {} };
  const eintraege = [];
  return {
    doc,
    eintraege,
    conversationId: 'c1',
    taskId: null,
    memo: async (_k, v) => v,
    snapshot: async (token) => (token === Register ? { agents: [{ id: 'c1', titel: 'Hauptserver aufräumen', art: 'agent' }] } : doc),
    commit: async (fn) => fn({ doc: async () => doc, appendEntry: async (_c, e) => eintraege.push(e) }),
  };
}

function bitten() {
  const cfg = konfigurationLaden({}, {});
  return hubWerkzeuge({ cfg, hub: {} }).find((t) => t.name === 'freigabe_bitten');
}

test('freigabe_bitten: der Kontext ist als Pflicht beschrieben, aber nicht „erforderlich“ im Schema (sonst fiele die Freigabe still aus)', () => {
  const schema = bitten().parameters;
  assert.match(schema.properties.kontext.description, /^PFLICHT: Kurzkontext von 3 bis 5 Sätzen/);
  assert.ok(!schema.required.includes('kontext'));
  assert.ok(schema.required.includes('aktion'));
});

test('freigabe_bitten: Kontext vom Modell wird übernommen und im Eintrag und Verlauf gespeichert', async () => {
  kontextZaehler.zuruecksetzen();
  const api = fakeApi();
  await bitten().execute({ aktion: eingabe.aktion, risiko: 'medium', kontext: GUT, werkzeug: 'bash', befehl: eingabe.befehl }, api, {});
  const f = Object.values(api.doc.eintraege)[0];
  assert.equal(f.kontext, GUT);
  assert.equal(f.kontextHerkunft, 'modell');
  assert.equal(api.eintraege[0].data.kontext, GUT, 'auch der Verlaufseintrag trägt den Kontext');
  assert.deepEqual(kontextZaehler.zustand().abweichung, { fehlt: 0, zu_lang: 0, saetze: 0, geheimnis: 0, befehl: 0 });
  assert.equal(kontextZaehler.zustand().modell, 1);
});

test('freigabe_bitten: fehlender, zu langer, zu knapper oder geheimer Kontext → Rückfall und Zählung, die Freigabe entsteht trotzdem', async () => {
  kontextZaehler.zuruecksetzen();
  const faelle = [
    [undefined, 'fehlt'],
    ['x '.repeat(400), 'zu_lang'],
    ['Nur ein Satz.', 'saetze'],
    ['Eins. Zwei mit Token: abcdef123456. Drei.', 'geheimnis'], // gitleaks:allow (Testattrappe)
  ];
  for (const [kontext, grund] of faelle) {
    const api = fakeApi();
    const args = { aktion: eingabe.aktion, risiko: 'high', werkzeug: 'bash', befehl: eingabe.befehl };
    if (kontext !== undefined) args.kontext = kontext;
    await bitten().execute(args, api, {});
    const f = Object.values(api.doc.eintraege)[0];
    assert.ok(f, grund);
    assert.equal(f.kontextHerkunft, 'rueckfall', grund);
    assert.ok(zaehleSaetze(f.kontext) >= 3 && f.kontext.length <= KONTEXT_MAX, grund);
    assert.match(f.kontext, /Hauptserver aufräumen/, 'Auftrag aus dem Register');
    assert.match(f.kontext, /Shell-Befehl „git“/);
    assert.ok(!f.kontext.includes('abcdef123456'));
  }
  const z = kontextZaehler.zustand();
  assert.equal(z.rueckfall, 4);
  assert.deepEqual(z.abweichung, { fehlt: 1, zu_lang: 1, saetze: 1, geheimnis: 1, befehl: 0 });
});

// --- Weitergabe: Runner mit Faux-Modell ------------------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), 'pidurable-kontext-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('Faux-Modell bittet mit Kontext: bis /api/freigaben, Egress-Ereignis und Matrix-Text', async () => {
  kontextZaehler.zuruecksetzen();
  const cfg = konfigurationLaden(
    {
      hub: 'http://hub.test',
      arbeitsbereiche: { standard: { pfad: tmp, titel: 'Test' } },
      spielmodus: [],
      pi_durable: {
        storage: join(tmp, 'fyos.sqlite'),
        security: { token: 'test-token-test-token-test-token-00' },
        proactive: { enabled: false },
        egress: { enabled: true, flushMs: 100, erinnerungS: 1 },
        browser: { enabled: false },
        desktop: { enabled: false },
      },
    },
    {},
  );
  const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: [{ id: 'hausmodell' }, { id: 'hausmodell-max' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall('freigabe_bitten', { aktion: eingabe.aktion, risiko: 'high', kontext: GUT, werkzeug: 'bash', befehl: eingabe.befehl }),
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Ich warte auf die Freigabe.'),
    // Zweiter Wunsch: das Modell vergisst den Kontext.
    fauxAssistantMessage(
      fauxToolCall('freigabe_bitten', { aktion: 'Ordner /srv/tmp/alt leeren', risiko: 'medium', werkzeug: 'bash', befehl: 'rm -rf /srv/tmp/alt/*' }),
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Ich warte erneut.'),
  ]);
  const gemeldet = [];
  const hub = {
    melden: async (stueck) => {
      gemeldet.push(...stueck);
      return { ok: true };
    },
    aufrufen: async () => ({ ok: true, result: {} }),
    bereicheMelden: async () => ({ ok: true }),
    gesundheit: async () => ({ ok: true }),
    suchen: async () => [],
    schema: async () => ({}),
    eingangLesen: async (nach) => {
      await warte(200);
      return { eintraege: [], letzte: nach };
    },
  };
  const runner = new Runner(cfg, { models, hub });
  await runner.start();
  const egress = new Egress({ cfg, harness: runner.harness, hub, onFehler: () => {} });
  await egress.start();
  const server = erstelleServer({ runner, cfg });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const root = (await runner.gespraeche()).find((g) => g.art === 'root');
    await runner.sende(root.id, 'Bitte den alten Zweig löschen.');

    // 1. /api/freigaben trägt den Kontext des Modells.
    const basis = `http://127.0.0.1:${server.address().port}`;
    const liste = await bis(async () => {
      const r = await (await fetch(`${basis}/api/freigaben`, { headers: { Authorization: `Bearer ${cfg.pi_durable.security.token}` } })).json();
      return r.freigaben?.length ? r.freigaben : null;
    }, { was: 'Freigabe in /api/freigaben' });
    assert.equal(liste[0].kontext, GUT);
    assert.equal(liste[0].kontextHerkunft, 'modell');
    assert.equal(liste[0].aktion, eingabe.aktion);

    // 2. Das Ereignis `proposal` im Ausgang trägt ihn ebenfalls (bei der ersten Meldung und bei der Erinnerung).
    await bis(async () => gemeldet.filter((e) => e.typ === 'proposal').length >= 2, { was: 'proposal im Ausgang' });
    for (const p of gemeldet.filter((e) => e.typ === 'proposal')) assert.equal(p.kontext, GUT);

    // 3. Der Meldetext (Matrix) zeigt den Kontext vor Aktion und Risiko.
    const gesendet = [];
    const matrix = { name: 'matrix', befehl: true, kontextMax: 600, senden: async (n) => (gesendet.push(n), { ok: true }) };
    const speicher = { d: { freigabemeldung: {} }, lesen: async () => JSON.parse(JSON.stringify(speicher.d)), aendern: async (fn) => void fn(speicher.d) };
    const w = new FreigabeMeldung({
      konfig: konfigNormalisieren({ kanaele: ['matrix'] }),
      kanaele: [matrix],
      freigaben: () => runner.freigaben(),
      speicher,
      log: { info() {}, warn() {} },
    });
    await w.pruefen();
    assert.equal(gesendet.length, 1, 'hohes Risiko geht sofort raus');
    const zeilen = gesendet[0].text.split('\n');
    assert.equal(zeilen[0], 'Freigabe nötig (hohes Risiko)');
    assert.equal(zeilen[1], GUT);
    assert.ok(zeilen[2].startsWith('Aktion:') && zeilen[3].startsWith('Risiko:'));

    // 4. Zweiter Wunsch ohne Kontext: Rückfall, gezählt, trotzdem überall vorhanden.
    await runner.sende(root.id, 'Und den Ordner leeren.');
    const zwei = await bis(async () => (await runner.freigaben()).find((f) => f.aktion === 'Ordner /srv/tmp/alt leeren'), { was: 'zweite Freigabe' });
    assert.equal(zwei.kontextHerkunft, 'rueckfall');
    assert.ok(zaehleSaetze(zwei.kontext) >= 3 && zwei.kontext.length <= KONTEXT_MAX, zwei.kontext);
    assert.match(zwei.kontext, /\/srv\/tmp\/alt/);
    assert.ok(!zwei.kontext.includes('rm -rf'), 'kein roher Befehl im Kontext');
    assert.equal(zwei.befehl, 'rm -rf /srv/tmp/alt/*', 'der Befehl bleibt ein eigenes Feld');
    assert.equal(kontextZaehler.zustand().abweichung.fehlt, 1);
    await bis(async () => gemeldet.some((e) => e.typ === 'proposal' && e.id === zwei.id && e.kontext === zwei.kontext), { was: 'proposal mit Rückfall' });
    const n = nachrichtBauen({ art: 'neu', liste: [zwei], kanal: matrix, kfg: konfigNormalisieren({}), jetzt: Date.now() });
    assert.equal(n.text.split('\n')[1], zwei.kontext);
  } finally {
    await new Promise((r) => server.close(r));
    await egress.stop();
    await runner.close().catch(() => {});
  }
});

test('ältere Freigabe ohne Kontext: /api/freigaben und Meldetext zeigen den Rückfall, nie ein leeres Feld', async () => {
  const alt = { ...neueFreigabe({ id: 'fr-alt', conversationId: 1, aktion: 'Branch löschen', risiko: 'medium', werkzeug: 'bash' }), kontext: '' };
  const kfg = konfigNormalisieren({});
  const n = nachrichtBauen({ art: 'neu', liste: [alt], kanal: { befehl: false, kontextMax: 600 }, kfg, jetzt: Date.now() });
  const zeilen = n.text.split('\n');
  assert.match(zeilen[1], /Branch löschen/);
  assert.ok(zaehleSaetze(zeilen[1]) >= 3);
  assert.ok(zeilen[2].startsWith('Aktion:'));
});
