/**
 * suche-archiv.test.js — Archiv-Parameter, Suche über Sitzungen und Kontextfenster, so wie die Agent-App sie braucht (30.10.2026).
 * Der echte Runner läuft mit einem Faux-Modell (Muster: sitzung-benennen.test.js, kontext-anzeige.test.js); angefragt wird über HTTP.
 *
 *   GET /api/gespraeche[?archiv=0|1|alle]   Standard unverändert (ohne Archivierte); jedes Gespräch trägt `archiviert`
 *   GET /api/suche?q=&limit=&archiv=        { ok, treffer: [{ id, titel, archiviert, aktualisiert, ausschnitt, start, laenge, zahl, ... }], abgeschnitten }
 *   GET /api/modelle                        je Modell `contextWindow`
 *   usage.context = { tokens, window }      in /api/gespraech/:id/ansicht, im Snapshot und in usage_changed des Stroms
 */
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { konfigurationLaden } from '../src/config.js';
import { fensterFuerModell } from '../src/models.js';
import { Runner } from '../src/runner.js';
import { erstelleServer } from '../src/server.js';
import { ausschnittBauen, klein, sichtbareTexte, suchLimit, suchwoerter } from '../src/suche.js';

const TOKEN = 'test-token-test-token-test-token-00';
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'suche-archiv-test-')));
after(() => rmSync(tmp, { recursive: true, force: true }));

const warte = (ms) => new Promise((r) => setTimeout(r, ms));
async function bis(fn, { ms = 20000, was = 'Bedingung' } = {}) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    try {
      const w = await fn();
      if (w) return w;
    } catch {
      /* weiter */
    }
    await warte(80);
  }
  throw new Error(`Zeit abgelaufen: ${was}`);
}

const fakeHub = () => ({
  aufrufen: async () => ({ ok: true, result: {} }),
  melden: async () => ({ ok: true }),
  bereicheMelden: async () => ({ ok: true }),
  gesundheit: async () => ({ ok: true }),
  suchen: async () => [],
  schema: async () => ({}),
  eingangLesen: async (nach) => {
    await warte(150);
    return { eintraege: [], letzte: nach };
  },
});

let zaehler = 0;
async function mitRunner(fn, { pdExtra = {} } = {}) {
  const cfg = konfigurationLaden(
    {
      hub: 'http://hub.test',
      agent: 'persona',
      arbeitsbereiche: { standard: { pfad: tmp, titel: 'Test' } },
      pi_durable: {
        storage: join(tmp, `suche-${++zaehler}.sqlite`),
        security: { token: TOKEN },
        proactive: { enabled: false },
        egress: { enabled: false },
        browser: { enabled: false },
        desktop: { enabled: false },
        ...pdExtra,
      },
    },
    {},
  );
  const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: [{ id: 'hausmodell' }, { id: 'hausmodell-max' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runner = new Runner(cfg, { models, hub: fakeHub() });
  await runner.start();
  const server = erstelleServer({ runner, cfg });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const basis = `http://127.0.0.1:${server.address().port}`;
  const rufeRoh = async (methode, pfad, { body, token = TOKEN } = {}) => {
    const r = await fetch(basis + pfad, {
      method: methode,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const rufe = (methode, pfad, body) => rufeRoh(methode, pfad, { body });
  const neu = async (titel) => (await rufe('POST', '/api/gespraeche', { titel })).json.gespraech.id;
  const antwortTexte = (a) =>
    a.entries
      .flatMap((e) => e.model ?? [])
      .filter((m) => m?.role === 'assistant')
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b?.type === 'text')
      .map((b) => b.text);
  /** Eine Frage stellen, die Antwort des Faux-Modells abwarten. `antworten` ist die Reihe der Modellantworten dieses Zugs. */
  const sprich = async (id, frage, antworten) => {
    const text = typeof antworten === 'string' ? [fauxAssistantMessage(antworten)] : antworten;
    faux.setResponses(text);
    await runner.sende(id, frage);
    const letzter = [...text].reverse().map((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'text').map((b) => b.text).join('') : String(m.content))).find(Boolean);
    await bis(async () => antwortTexte(await runner.ansicht(id, { voll: true })).includes(letzter), { was: `Antwort „${letzter}“` });
  };
  try {
    await fn({ rufe, rufeRoh, neu, sprich, runner, cfg, faux, basis });
  } finally {
    await new Promise((ok) => server.close(ok));
    await runner.close().catch(() => {});
  }
}

const ids = (liste) => liste.map((g) => String(g.id));

// ------------------------------------------------------------------------------------------------------------------ 1. Archiv

test('Archiv: Standard ohne Archivierte (Antwortform gleich), ?archiv=1 nur Archivierte, ?archiv=alle beide; jedes Gespräch trägt archiviert', async () => {
  await mitRunner(async ({ rufe, neu }) => {
    const a = await neu('Aktiv A');
    const b = await neu('Wird archiviert B');
    const c = await neu('Aktiv C');
    await rufe('PATCH', `/api/gespraech/${b}`, { archiviert: true });

    const standard = await rufe('GET', '/api/gespraeche');
    assert.equal(standard.status, 200);
    assert.equal(standard.json.ok, true);
    assert.ok(Array.isArray(standard.json.gespraeche));
    assert.deepEqual(Object.keys(standard.json).sort(), ['gespraeche', 'ok'], 'Antwortform unverändert');
    assert.ok(!ids(standard.json.gespraeche).includes(String(b)));
    assert.ok(ids(standard.json.gespraeche).includes(String(a)) && ids(standard.json.gespraeche).includes(String(c)));
    for (const g of standard.json.gespraeche) assert.equal(g.archiviert, false, `archiviert=false bei ${g.id}`);

    const null0 = await rufe('GET', '/api/gespraeche?archiv=0');
    assert.deepEqual(ids(null0.json.gespraeche), ids(standard.json.gespraeche), '?archiv=0 ist der Standard');

    const nur = await rufe('GET', '/api/gespraeche?archiv=1');
    assert.equal(nur.status, 200);
    assert.deepEqual(ids(nur.json.gespraeche), [String(b)]);
    assert.equal(nur.json.gespraeche[0].archiviert, true);
    assert.equal(nur.json.gespraeche[0].titel, 'Wird archiviert B');
    assert.deepEqual(Object.keys(nur.json).sort(), ['gespraeche', 'ok']);

    const alle = await rufe('GET', '/api/gespraeche?archiv=alle');
    assert.deepEqual(ids(alle.json.gespraeche).sort(), [...ids(standard.json.gespraeche), String(b)].sort());
    assert.equal(alle.json.gespraeche.find((g) => String(g.id) === String(b)).archiviert, true);
    assert.equal(alle.json.gespraeche.find((g) => String(g.id) === String(a)).archiviert, false);
  });
});

test('Archiv: Wiederherstellen per PATCH {archiviert:false} bringt die Sitzung zurück in den Standard und aus dem Archiv', async () => {
  await mitRunner(async ({ rufe, neu }) => {
    const b = await neu('Hin und zurück');
    await rufe('PATCH', `/api/gespraech/${b}`, { archiviert: true });
    assert.deepEqual(ids((await rufe('GET', '/api/gespraeche?archiv=1')).json.gespraeche), [String(b)]);
    const zurueck = await rufe('PATCH', `/api/gespraech/${b}`, { archiviert: false });
    assert.equal(zurueck.status, 200);
    assert.ok(ids((await rufe('GET', '/api/gespraeche')).json.gespraeche).includes(String(b)));
    assert.deepEqual((await rufe('GET', '/api/gespraeche?archiv=1')).json.gespraeche, []);
  });
});

test('Archiv: ungültiger Wert ist 400 mit Fehlertext; ohne Token 401', async () => {
  await mitRunner(async ({ rufe, rufeRoh }) => {
    const r = await rufe('GET', '/api/gespraeche?archiv=vielleicht');
    assert.equal(r.status, 400);
    assert.equal(r.json.ok, false);
    assert.match(r.json.fehler, /archiv/);
    assert.equal((await rufeRoh('GET', '/api/gespraeche?archiv=1', { token: null })).status, 401);
    assert.equal((await rufeRoh('GET', '/api/gespraeche?archiv=1', { token: 'falsch' })).status, 401);
  });
});

// ------------------------------------------------------------------------------------------------------------------ 2. Suche

test('Suche im Titel: Groß/Klein egal, Offsets zeigen auf den Treffer, Form der Antwort', async () => {
  await mitRunner(async ({ rufe, neu }) => {
    const id = await neu('Rechnung Mahnung Quartal 3');
    await neu('Etwas ganz anderes');
    const r = await rufe('GET', '/api/suche?q=RECHNUNG');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(typeof r.json.abgeschnitten, 'boolean');
    assert.equal(r.json.treffer.length, 1);
    const t = r.json.treffer[0];
    for (const feld of ['id', 'titel', 'archiviert', 'aktualisiert', 'ausschnitt', 'start', 'laenge', 'zahl']) assert.ok(feld in t, `Feld ${feld}`);
    assert.equal(String(t.id), String(id));
    assert.equal(t.titel, 'Rechnung Mahnung Quartal 3');
    assert.equal(t.archiviert, false);
    assert.equal(typeof t.aktualisiert, 'number');
    assert.equal(t.zahl, 1);
    assert.equal(t.ausschnitt.slice(t.start, t.start + t.laenge).toLowerCase(), 'rechnung');
    // Teilwort zählt (Teilzeichenfolge), mehrere Wörter in beliebiger Reihenfolge und Schreibweise
    assert.equal((await rufe('GET', '/api/suche?q=mahn')).json.treffer.length, 1);
    assert.equal((await rufe('GET', '/api/suche?q=' + encodeURIComponent('QUARTAL rechnung'))).json.treffer.length, 1);
    assert.equal((await rufe('GET', '/api/suche?q=' + encodeURIComponent('rechnung anderes'))).json.treffer.length, 0, 'alle Wörter müssen vorkommen');
  });
});

test('Suche im Verlauf: Mensch und Agent, mehrere Wörter über Nachrichten hinweg, Treffer mit Offsets, zahl', async () => {
  await mitRunner(async ({ rufe, neu, sprich }) => {
    const id = await neu('Gespräch ohne Stichwort im Titel');
    await sprich(id, 'Bitte prüfe die Quartalszahlen von Xylophon GmbH', 'Die Zahlen sind plausibel, Marzipan-Faktor 3.');
    await sprich(id, 'Und was ist mit Zebrastreifen?', 'Zebrastreifen sind unauffällig.');
    const finde = async (q, extra = '') => (await rufe('GET', `/api/suche?q=${encodeURIComponent(q)}${extra}`)).json;

    const mensch = await finde('xylophon');
    assert.equal(mensch.treffer.length, 1);
    const t = mensch.treffer[0];
    assert.equal(String(t.id), String(id));
    assert.equal(t.quelle, 'verlauf');
    assert.match(t.ausschnitt, /Xylophon GmbH/);
    assert.equal(t.ausschnitt.slice(t.start, t.start + t.laenge), 'Xylophon', 'Offsets zeigen auf den Treffer im Ausschnitt (Originalschreibweise)');
    assert.equal(t.zahl, 1);

    const agent = await finde('MARZIPAN');
    assert.equal(agent.treffer.length, 1);
    assert.match(agent.treffer[0].ausschnitt, /Marzipan/);

    // „zebrastreifen“ steht in Frage und Antwort: zahl zählt die Nachrichten mit Treffer
    assert.equal((await finde('zebrastreifen')).treffer[0].zahl, 2);

    // zwei Wörter aus zwei verschiedenen Nachrichten: alle müssen irgendwo in der Sitzung vorkommen
    assert.equal((await finde('xylophon marzipan')).treffer.length, 1);
    assert.equal((await finde('xylophon gibtesnicht')).treffer.length, 0);
  });
});

test('Suche: Werkzeugrohdaten, Denkblöcke und Systemtexte sind nicht durchsuchbar', async () => {
  await mitRunner(async ({ rufe, neu, sprich, runner }) => {
    const id = await neu('Werkzeugtest');
    await sprich(id, 'Lies den Zustand', [
      fauxAssistantMessage(
        [fauxThinking('Denkblock-Pelikan überlegt leise.'), fauxToolCall('zustand_lesen', { geheimwort: 'Rohdaten-Zebra' }, { id: 'call_s1' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Fertig, sichtbarer Text Kolibri.'),
    ]);
    // zur Kontrolle: die Rohdaten stehen wirklich im Verlauf
    const roh = JSON.stringify((await runner.ansicht(id, { voll: true })).entries);
    assert.ok(roh.includes('Rohdaten-Zebra') && roh.includes('Denkblock-Pelikan'), 'Rohdaten und Denkblock liegen im Verlauf');
    assert.equal((await rufe('GET', '/api/suche?q=Rohdaten-Zebra')).json.treffer.length, 0);
    assert.equal((await rufe('GET', '/api/suche?q=Denkblock-Pelikan')).json.treffer.length, 0);
    assert.equal((await rufe('GET', '/api/suche?q=Hintergrundjob')).json.treffer.length, 0, 'Systemkopf (Regelwerk) wird nicht durchsucht');
    assert.equal((await rufe('GET', '/api/suche?q=Kolibri')).json.treffer.length, 1, 'der sichtbare Text schon');
  });
});

test('Suche: Geheimnisse werden geschwärzt (nicht auffindbar, nicht im Ausschnitt)', async () => {
  await mitRunner(async ({ rufe, neu, sprich }) => {
    const id = await neu('Zugang');
    await sprich(id, 'Meine Zugangsdaten: token=abcDEF123456geheim und Bearer sk-live-ABCDEF1234567890 bitte merken', 'Notiert, Schlüsselwort Papagei.'); // gitleaks:allow (Testattrappe)
    assert.equal((await rufe('GET', '/api/suche?q=abcDEF123456geheim')).json.treffer.length, 0);
    assert.equal((await rufe('GET', '/api/suche?q=ABCDEF1234567890')).json.treffer.length, 0);
    const r = await rufe('GET', '/api/suche?q=Zugangsdaten');
    assert.equal(r.json.treffer.length, 1);
    assert.ok(!r.json.treffer[0].ausschnitt.includes('abcDEF123456geheim'));
    assert.ok(!r.json.treffer[0].ausschnitt.includes('ABCDEF1234567890'));
    assert.match(r.json.treffer[0].ausschnitt, /\*\*\*/);
    assert.equal(String(r.json.treffer[0].id), String(id));
  });
});

test('Suche: Archivierte nur mit Parameter; Treffer tragen archiviert', async () => {
  await mitRunner(async ({ rufe, neu, sprich }) => {
    const alt = await neu('Altlast Projekt');
    await sprich(alt, 'Die Altlast-Analyse bitte', 'Altlast gefunden: Hamster.');
    const neuer = await neu('Neues Projekt');
    await sprich(neuer, 'Altlast Nachfolger', 'Ok, Nachfolger notiert.');
    await rufe('PATCH', `/api/gespraech/${alt}`, { archiviert: true });

    const standard = (await rufe('GET', '/api/suche?q=altlast')).json;
    assert.deepEqual(ids(standard.treffer), [String(neuer)], 'Standard: nur nicht archivierte');
    assert.equal(standard.treffer[0].archiviert, false);
    const nurArchiv = (await rufe('GET', '/api/suche?q=altlast&archiv=1')).json;
    assert.deepEqual(ids(nurArchiv.treffer), [String(alt)]);
    assert.equal(nurArchiv.treffer[0].archiviert, true);
    const alle = (await rufe('GET', '/api/suche?q=altlast&archiv=alle')).json;
    assert.deepEqual(ids(alle.treffer).sort(), [String(alt), String(neuer)].sort());
    assert.equal((await rufe('GET', '/api/suche?q=altlast&archiv=0')).json.treffer.length, 1);
    // nach dem Wiederherstellen ist sie wieder im Standard
    await rufe('PATCH', `/api/gespraech/${alt}`, { archiviert: false });
    assert.equal((await rufe('GET', '/api/suche?q=altlast')).json.treffer.length, 2);
  });
});

test('Suche: Ausschnitt höchstens 160 Zeichen, Treffer darin, Markierungen stimmen (auch bei Umlauten)', async () => {
  await mitRunner(async ({ rufe, neu, sprich }) => {
    const id = await neu('Lang');
    const lang = `${'Füllwort '.repeat(60)}ÄRGER mit der Nadel ${'danach '.repeat(60)}`;
    await sprich(id, lang, 'Verstanden.');
    const r = (await rufe('GET', `/api/suche?q=${encodeURIComponent('ärger nadel')}`)).json;
    assert.equal(r.treffer.length, 1);
    const t = r.treffer[0];
    assert.ok(t.ausschnitt.length <= 160, `Länge ${t.ausschnitt.length}`);
    assert.equal(t.ausschnitt.slice(t.start, t.start + t.laenge), 'ÄRGER');
    assert.ok(Array.isArray(t.markierungen) && t.markierungen.length === 2);
    assert.deepEqual(t.markierungen.map((m) => t.ausschnitt.slice(m.start, m.start + m.laenge).toLowerCase()), ['ärger', 'nadel']);
  });
});

test('Suche: Fehlerformen (zu kurz, fehlt, limit, archiv, zu viele Wörter), ohne Token 401, falsche Methode', async () => {
  await mitRunner(async ({ rufe, rufeRoh, neu }) => {
    await neu('Irgendwas');
    for (const pfad of ['/api/suche?q=a', '/api/suche?q=%20a%20', '/api/suche', '/api/suche?q=', '/api/suche?q=ab&limit=0', '/api/suche?q=ab&limit=x', '/api/suche?q=ab&limit=1.5', '/api/suche?q=ab&archiv=?', '/api/suche?q=a+b+c+d+e+f+g']) {
      const r = await rufe('GET', pfad);
      assert.equal(r.status, 400, pfad);
      assert.equal(r.json.ok, false, pfad);
      assert.equal(typeof r.json.fehler, 'string', pfad);
    }
    assert.equal((await rufe('GET', '/api/suche?q=' + 'x'.repeat(300))).status, 400);
    assert.match((await rufe('GET', '/api/suche?q=a')).json.fehler, /2 Zeichen/);
    // genau zwei Zeichen reichen
    assert.equal((await rufe('GET', '/api/suche?q=ir')).status, 200);
    // ohne oder mit falschem Token: 401, auch mit gültiger Frage
    assert.equal((await rufeRoh('GET', '/api/suche?q=irgend', { token: null })).status, 401);
    assert.equal((await rufeRoh('GET', '/api/suche?q=irgend', { token: 'falsch' })).status, 401);
    // nur lesend: POST gibt es nicht
    assert.equal((await rufe('POST', '/api/suche', { q: 'irgend' })).status, 404);
  });
});

test('Suche: Grenzen (limit, Zahl der Sitzungen, Einträge je Sitzung, Zeit, gleichzeitige Suchen) setzen abgeschnitten', async () => {
  await mitRunner(async ({ rufe, neu, sprich, cfg }) => {
    const a = await neu('Gleichwort eins');
    const b = await neu('Gleichwort zwei');
    const c = await neu('Gleichwort drei');
    await neu('Nichts');

    // limit
    const eins = (await rufe('GET', '/api/suche?q=gleichwort&limit=1')).json;
    assert.equal(eins.treffer.length, 1);
    assert.equal(eins.abgeschnitten, true);
    const alle = (await rufe('GET', '/api/suche?q=gleichwort&limit=50')).json;
    assert.deepEqual(ids(alle.treffer).sort(), [String(a), String(b), String(c)].sort());
    assert.equal(alle.abgeschnitten, false);
    assert.equal((await rufe('GET', '/api/suche?q=gleichwort&limit=5000')).status, 200, 'mehr als 50 wird gekappt, nicht abgelehnt');

    // Zahl der durchsuchten Sitzungen (Hauptgespräch zuerst, dann die neuesten)
    cfg.pi_durable.suche = { sitzungen: 2 };
    const zwei = (await rufe('GET', '/api/suche?q=gleichwort')).json;
    assert.equal(zwei.abgeschnitten, true);
    assert.equal(zwei.durchsucht, 2);
    assert.ok(zwei.treffer.length <= 1, 'Hauptgespräch + neueste Sitzung');

    // Zeitlimit
    cfg.pi_durable.suche = { zeit_ms: 0 };
    const zeit = (await rufe('GET', '/api/suche?q=gleichwort')).json;
    assert.equal(zeit.abgeschnitten, true);
    assert.equal(zeit.durchsucht, 0);

    // Einträge je Sitzung: nur die neuesten werden gelesen
    cfg.pi_durable.suche = {};
    const id = await neu('Lang laufend');
    await sprich(id, 'Uralte Frage Seltenwort', 'Alte Antwort.');
    await sprich(id, 'Neuere Frage', 'Neuere Antwort.');
    assert.equal((await rufe('GET', '/api/suche?q=seltenwort')).json.treffer.length, 1);
    cfg.pi_durable.suche = { eintraege: 1 };
    assert.equal((await rufe('GET', '/api/suche?q=seltenwort')).json.treffer.length, 0, 'älter als die letzten Einträge: nicht mehr gelesen');

    // gleichzeitige Suchen: über der Grenze antwortet der Runner 429, ohne zu arbeiten
    cfg.pi_durable.suche = { gleichzeitig: 0 };
    const voll = await rufe('GET', '/api/suche?q=gleichwort');
    assert.equal(voll.status, 429);
    assert.equal(voll.json.ok, false);
  });
});

test('Suche: die Hilfsfunktionen (Wörter, limit, klein, Ausschnitt, sichtbare Texte)', () => {
  assert.deepEqual(suchwoerter('  Foo  BAR foo '), ['foo', 'bar']);
  assert.throws(() => suchwoerter('x'), (f) => f.status === 400);
  assert.equal(suchLimit(undefined), 20);
  assert.equal(suchLimit('7'), 7);
  assert.equal(suchLimit('999'), 50);
  assert.throws(() => suchLimit('0'), (f) => f.status === 400);
  assert.equal(klein('İÄ').length, 'İÄ'.length, 'Länge bleibt, damit Offsets stimmen');
  const a = ausschnittBauen('x'.repeat(500) + ' Treffer ' + 'y'.repeat(500), ['treffer'], 160);
  assert.ok(a.ausschnitt.length <= 160);
  assert.equal(a.ausschnitt.slice(a.start, a.start + a.laenge), 'Treffer');
  const texte = sichtbareTexte([
    { kind: 'pi.reset', model: [{ role: 'user', content: 'Marker' }] },
    { kind: 'pi.system', model: [{ role: 'system', content: 'Systemtext' }] },
    { kind: 'x', model: [{ role: 'toolResult', content: [{ type: 'text', text: 'Rohausgabe' }] }] },
    { kind: 'x', model: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'Denken' }, { type: 'toolCall', name: 't', arguments: { a: 1 } }, { type: 'text', text: 'Sichtbar' }] }] },
    { kind: 'x', model: [{ role: 'user', content: [{ type: 'text', text: 'Frage' }, { type: 'image', data: 'AAAA' }] }] },
  ]);
  assert.deepEqual(texte.map((t) => [t.rolle, t.text]), [['agent', 'Sichtbar'], ['mensch', 'Frage']]);
});

// ------------------------------------------------------------------------------------------------------------------ 3. Kontextfenster

test('GET /api/modelle: jedes Modell trägt contextWindow (Hausmodell 262144); Konfiguration und befehle bleiben', async () => {
  await mitRunner(async ({ rufe }) => {
    const r = await rufe('GET', '/api/modelle');
    assert.equal(r.status, 200);
    assert.ok(r.json.modelle.length >= 1);
    for (const m of r.json.modelle) {
      assert.equal(typeof m.contextWindow, 'number', `contextWindow bei ${m.id}`);
      for (const feld of ['id', 'provider', 'name', 'max']) assert.ok(feld in m, `bestehendes Feld ${feld}`);
    }
    assert.ok(r.json.modelle.every((m) => m.contextWindow === 262144));
    assert.deepEqual((await rufe('GET', '/api/konfiguration')).json.modelle, r.json.modelle);
  });
});

test('Modellkette: der Ersatzdenker meldet sein kleineres Fenster, die Sitzung auf ihm auch (usage.context.window)', async () => {
  await mitRunner(
    async ({ rufe, neu, cfg }) => {
      const m = (await rufe('GET', '/api/modelle')).json.modelle;
      assert.equal(m.find((x) => x.provider === 'hausmodell').contextWindow, 262144);
      const ersatz = m.find((x) => x.provider === 'ersatzdenker');
      assert.ok(ersatz && ersatz.contextWindow > 0 && ersatz.contextWindow < 262144, `Ersatzdenker ${ersatz?.contextWindow}`);
      assert.equal(fensterFuerModell(cfg, { provider: 'ersatzdenker', modelId: 'ersatzdenker' }), ersatz.contextWindow);
      assert.equal(fensterFuerModell(cfg, { modelId: 'ersatzdenker' }), ersatz.contextWindow, 'auch nur nach Modellname');
      assert.equal(fensterFuerModell(cfg, null), 262144, 'unbekannt: Hausmodell');
      const id = await neu('Auf dem Ersatz');
      assert.equal((await rufe('GET', `/api/gespraech/${id}/ansicht`)).json.usage.context.window, 262144);
      assert.equal((await rufe('PATCH', `/api/gespraech/${id}`, { modell: 'ersatzdenker' })).status, 200);
      assert.equal((await rufe('GET', `/api/gespraech/${id}/ansicht`)).json.usage.context.window, ersatz.contextWindow);
    },
    {
      pdExtra: {
        provider_kette: ['hausmodell', 'ersatzdenker'],
        provider: { ersatzdenker: { baseUrl: 'http://127.0.0.1:18460/v1', modelId: 'ersatzdenker' } },
      },
    },
  );
});

test('usage.context in Ansicht: tokens = totalTokens der letzten Antwort, window des Modells; null vor der ersten Antwort und nach leeren; Summe bleibt', async () => {
  await mitRunner(async ({ rufe, neu, sprich, runner }) => {
    const id = await neu('Kontext');
    const leer = (await rufe('GET', `/api/gespraech/${id}/ansicht`)).json;
    assert.deepEqual(leer.usage.context, { tokens: null, window: 262144 }, 'neue Sitzung: Fenster bekannt, Füllung noch nicht');
    assert.ok(leer.usage.models && leer.usage.tools, 'bestehende Felder bleiben (auch ohne Nutzung)');

    await sprich(id, 'Frage eins ' + 'x'.repeat(300), 'Antwort eins ' + 'a '.repeat(30));
    await sprich(id, 'Frage zwei ' + 'y'.repeat(300), 'Antwort zwei ' + 'b '.repeat(60));
    const a = (await rufe('GET', `/api/gespraech/${id}/ansicht`)).json;
    const antworten = a.entries.flatMap((e) => e.model ?? []).filter((m) => m?.role === 'assistant');
    assert.equal(antworten.length, 2);
    assert.equal(a.usage.context.tokens, antworten.at(-1).usage.totalTokens);
    assert.equal(a.usage.context.window, 262144);
    const lebenszeit = Object.values(a.usage.models).reduce((s, u) => s + u.totalTokens, 0);
    assert.ok(lebenszeit > a.usage.context.tokens, 'usage.models bleibt die Lebenszeit-Summe, context ist die Füllung');
    // voll=1 ändert die Zahl nicht
    assert.equal((await rufe('GET', `/api/gespraech/${id}/ansicht?voll=1`)).json.usage.context.tokens, a.usage.context.tokens);

    await runner.leeren(id);
    const nachLeeren = (await rufe('GET', `/api/gespraech/${id}/ansicht`)).json;
    assert.equal(nachLeeren.usage.context.tokens, null, 'nach leeren unbekannt');
    assert.equal(nachLeeren.usage.context.window, 262144);
    assert.ok(Object.values(nachLeeren.usage.models).reduce((s, u) => s + u.totalTokens, 0) >= lebenszeit, 'Summe bleibt');
    assert.equal((await rufe('GET', `/api/gespraech/${id}/ansicht?voll=1`)).json.usage.context.tokens, null, 'der Marker am Ende setzt auch im vollen Verlauf zurück');
  });
});

test('usage.context im Strom: Snapshot und usage_changed tragen { tokens, window }', async () => {
  await mitRunner(async ({ neu, sprich, runner }) => {
    const id = await neu('Strom');
    await sprich(id, 'Erste Frage', 'Erste Antwort.');
    const strom = await runner.watchConversation(id);
    const gesehen = [];
    try {
      const letzte = (await runner.ansicht(id)).usage.context.tokens;
      assert.ok(letzte > 0);
      assert.deepEqual(strom.snapshot.usage.context, { tokens: letzte, window: 262144 }, 'Snapshot');
      assert.ok(strom.snapshot.usage.models, 'bestehende Felder im Snapshot');
      strom.start(async (ev) => {
        gesehen.push(...(Array.isArray(ev) ? ev : [ev]));
      });
      await sprich(id, 'Zweite Frage ' + 'z'.repeat(400), 'Zweite Antwort ' + 'c '.repeat(50));
      const uc = await bis(() => gesehen.filter((e) => e.type === 'usage_changed').at(-1), { was: 'usage_changed' });
      const nun = (await runner.ansicht(id)).usage.context.tokens;
      assert.notEqual(nun, letzte);
      assert.deepEqual(uc.usage.context, { tokens: nun, window: 262144 }, 'usage_changed trägt die neue Füllung (nach der Antwort)');
      assert.ok(uc.usage.models, 'bestehende Felder in usage_changed');
    } finally {
      await strom.stop();
    }
  });
});
