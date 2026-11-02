import assert from 'node:assert/strict';
import http from 'node:http';
import { after, test } from 'node:test';
import { LiveDoc } from '@earendil-works/pi-durable';
import { LaufListe, Laufzeit, Wartend } from '../src/documents.js';
import { Egress } from '../src/egress.js';
import { kontextZaehler } from '../src/freigabe-kontext.js';
import { VERSION, erstelleSteuerkanal } from '../src/steuerkanal.js';

const stumm = () => {};
const offene = [];
after(async () => {
  for (const s of offene) await s.beenden();
});

/** Roher HTTP-Aufruf (fetch setzt kein Origin, aber wir wollen Köpfe frei wählen können). */
function anfrage(port, methode, pfad, { body, kopf = {} } = {}) {
  return new Promise((fertig, scheitern) => {
    const req = http.request({ host: '127.0.0.1', port, method: methode, path: pfad, headers: kopf, agent: false }, (res) => {
      const stuecke = [];
      res.on('data', (c) => stuecke.push(c));
      res.on('end', () => {
        const roh = Buffer.concat(stuecke).toString('utf8');
        fertig({ status: res.statusCode, nutz: roh ? JSON.parse(roh) : null });
      });
    });
    req.on('error', scheitern);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function aufbau(teile = {}) {
  const eingereiht = [];
  const abgebrochen = [];
  const geschrieben = [];
  const harness = {
    async snapshot(token) {
      if (token === Wartend) {
        return { eintraege: [{ klasse: 'max' }, { klasse: 'hintergrund' }, { klasse: 'hintergrund' }] };
      }
      if (token === Laufzeit) return { eingangGesehen: 7, eingangFehler: null };
      if (token === LiveDoc) return { run: { taskId: 1, inputs: [] } };
      if (token === LaufListe) return { eintraege: { l1: { status: 'laeuft' }, l2: { status: 'abgeschlossen' }, l3: { status: 'laeuft' } } };
      return undefined;
    },
  };
  const runner = {
    harness,
    root: { id: 'wurzel-1' },
    geschlossen: false,
    abbrechen: async (id) => abgebrochen.push(id),
    gespraeche: async () => [
      { id: 'wurzel-1', titel: 'Hauptgespräch', art: 'root', erstellt: 1 },
      { id: 'g2', titel: 'Zweig', art: 'zweig', erstellt: 2 },
    ],
  };
  const ingress = {
    cursor: '123-0',
    einreihen: async (e) => (eingereiht.push(e), true),
  };
  const server = erstelleSteuerkanal({
    cfg: { agent: 'persona', auftrag_max_zeichen: 50, steuer: { host: '127.0.0.1', port: 0 } },
    runner,
    ingress,
    log: stumm,
    ...teile.ueberschreibe,
  });
  offene.push(server);
  const { port } = await server.starten();
  return { port, server, eingereiht, abgebrochen, geschrieben, runner, ingress };
}

test('Vorgabe: 127.0.0.1:18435, nie 0.0.0.0 ohne Angabe', () => {
  const s = erstelleSteuerkanal({ cfg: {}, runner: {}, log: stumm });
  let adresse;
  s.listen = (port, host) => (adresse = [port, host]);
  s.starten();
  assert.deepEqual(adresse, [18435, '127.0.0.1']);
});

test('GET /healthz und /health', async () => {
  const { port } = await aufbau();
  for (const pfad of ['/healthz', '/health']) {
    const r = await anfrage(port, 'GET', pfad);
    assert.equal(r.status, 200);
    assert.deepEqual(r.nutz, { ok: true, version: VERSION });
  }
  assert.equal((await anfrage(port, 'GET', '/gibtsnicht')).status, 404);
});

test('GET /zustand mit allen Teilen', async () => {
  const welt = { zustand: () => ({ an: true, herzschlaege: 3 }), welt: () => ({ t: 1 }), weltblock: () => 'Weltblock' };
  const { port } = await aufbau({
    ueberschreibe: {
      budget: { zustand: () => ({ monat: '2026-10', usd: 1.5 }) },
      tor: { zustand: () => ({ offen: false, warum: 'Besitzer ist da', geprueft: 5 }) },
      lesenTor: { zustand: () => ({ offen: true, warum: 'lesen frei', geprueft: 6 }) },
      spielmodus: { an: () => true },
      welt,
      aufzeichnung: { zustand: () => ({ an: true, datei: '/a.jsonl', zeilen: 2, fehler: null }) },
      takt: { zustand: () => ({ eintraege: [] }) },
      arbeit: { zustand: () => ({ an: true, stufe: 'lesen', letzter_vorgang: 'INC-1', zuege_stunde: 2, zuege_tag: 5, naechster: null }) },
      zusatz: () => ({ reflexe: { regeln: 4 } }),
    },
  });
  const r = await anfrage(port, 'GET', '/zustand');
  assert.equal(r.status, 200);
  const z = r.nutz;
  assert.equal(z.ok, true);
  assert.equal(z.agent, 'persona');
  assert.equal(z.sitzung, 'wurzel-1');
  assert.equal(z.beschaeftigt, true);
  assert.deepEqual(z.wartend, { max: 1, hintergrund: 2 });
  assert.deepEqual(z.budget, { monat: '2026-10', usd: 1.5 });
  assert.equal(z.spielmodus, true);
  assert.equal(z.pi_laeuft, true);
  assert.deepEqual(z.eingang, { nach: '123-0', gelesen: 7, fehler: null, letzter_kontakt: null });
  assert.equal(z.hintergrund_tor.warum, 'Besitzer ist da');
  assert.equal(z.hintergrund_tor_lesen.offen, true);
  assert.equal(z.welt.herzschlaege, 3);
  assert.equal(z.aufzeichnung.an, true);
  assert.deepEqual(z.takt, { eintraege: [] });
  assert.deepEqual(z.arbeitsschleife, { an: true, stufe: 'lesen', letzter_vorgang: 'INC-1', zuege_stunde: 2, zuege_tag: 5, naechster: null });
  assert.deepEqual(z.reflexe, { regeln: 4 });
});

test('GET /zustand: meldestrecke, laufend, sitzungen, reflexe, itsm, chat in der Form des RPC-Runners', async () => {
  const egress = {
    meldestrecke: () => ({ stau: 3, gemeldet: 40, verworfen: 1 }),
    laufend: (id) => (id === 'wurzel-1' ? { quelle: 'alarm', klasse: 'hintergrund', ein: 'e-9', bezug: 'am:1' } : null),
  };
  const { port } = await aufbau({
    ueberschreibe: {
      egress,
      reflexe: { zustand: () => ({ regeln: 4, datei: 'r.yaml', fehler: null, ausgeloest: { 'alarm-hoch': 2 } }) },
      itsm: { zustand: () => ({ vorgaenge: 2, wartet_auf_max: [], gemeldet: 5, fehler: null }) },
      chat: { zustand: () => ({ raum: '!x', als: 'persona', seit: 1, gelesen: 2, gemeldet: 1, fehler: null, letzter_kontakt: null }) },
    },
  });
  const z = (await anfrage(port, 'GET', '/zustand')).nutz;
  assert.deepEqual(z.meldestrecke, { stau: 3, gemeldet: 40, verworfen: 1 });
  assert.deepEqual(z.laufend, { quelle: 'alarm', klasse: 'hintergrund', ein: 'e-9', bezug: 'am:1' });
  assert.deepEqual(z.sitzungen, {
    haupt: 'wurzel-1',
    aktiv: 'wurzel-1',
    arbeit: 3,
    status: { laeuft: 2, abgeschlossen: 1 },
    berichte_offen: 0,
    zug: { nr: null, modus: 'haupt', eintrag: null, phase: 'laeuft', unterbrochen: false },
  });
  assert.equal(z.reflexe.ausgeloest['alarm-hoch'], 2);
  assert.equal(z.itsm.gemeldet, 5);
  assert.equal(z.chat.als, 'persona');
  assert.equal(z.dialoge, null);
});

test('GET /zustand ohne Ausgang: meldestrecke leer, laufend null, sitzungen ohne Zug wenn nichts läuft', async () => {
  const { port, runner } = await aufbau();
  runner.harness.snapshot = async (token) => (token === LiveDoc ? { } : token === LaufListe ? undefined : undefined);
  const z = (await anfrage(port, 'GET', '/zustand')).nutz;
  assert.deepEqual(z.meldestrecke, { stau: 0, gemeldet: 0, verworfen: 0 });
  assert.equal(z.beschaeftigt, false);
  assert.equal(z.laufend, null);
  assert.deepEqual(z.sitzungen, { haupt: 'wurzel-1', aktiv: 'wurzel-1', arbeit: 0, status: {}, berichte_offen: 0, zug: null });
  assert.equal(z.reflexe, null);
  assert.equal(z.itsm, null);
  assert.equal(z.chat, null);
});

test('Egress zählt Meldestrecke: Stau, gemeldet, verworfen; laufend folgt dem offenen Zug', async () => {
  const gemeldet = [];
  const harness = { commit: async (fn) => fn({ doc: async () => ({ sequenzen: {} }) }) };
  const hub = { melden: async (s) => gemeldet.push(...s) };
  const cfg = { agent: 'persona', pi_durable: { egress: { enabled: true, maxBuffer: 3, flushMs: 1000 } } };
  const e = new Egress({ cfg, harness, hub, onFehler: () => {} });
  assert.deepEqual(e.meldestrecke(), { stau: 0, gemeldet: 0, verworfen: 0 });
  for (let i = 0; i < 5; i += 1) e.meldeExtern('s1', { typ: 'ui_request', i });
  await e.flush();
  await e.flush();
  assert.equal(e.verworfen >= 2, true, 'der Puffer fasst nur 3, ältere wurden verdrängt');
  assert.equal(e.gemeldet + e.tiefe(), 3, 'was nicht verworfen wurde, ist gemeldet oder wartet');
  assert.equal(e.meldestrecke().stau, e.tiefe());
  assert.equal(gemeldet.length, e.gemeldet);

  assert.equal(e.laufend('c1'), null);
  e.zugDaten.set('c1', { quelle: 'chat', klasse: 'max', ein: 'x', bezug: null });
  assert.deepEqual(e.laufend('c1'), { quelle: 'chat', klasse: 'max', ein: 'x', bezug: null });
});

test('GET /zustand ohne optionale Teile: null bzw. aus, kein Absturz', async () => {
  const { port } = await aufbau();
  const z = (await anfrage(port, 'GET', '/zustand')).nutz;
  assert.equal(z.budget, null);
  assert.equal(z.hintergrund_tor, null);
  assert.equal(z.hintergrund_tor_lesen, null);
  assert.equal(z.welt, null);
  assert.equal(z.takt, null);
  assert.equal(z.arbeitsschleife, null);
  assert.equal(z.spielmodus, false);
  assert.deepEqual(z.aufzeichnung, { an: false, datei: null, zeilen: 0, fehler: null });
  assert.deepEqual(z.gedaechtnis, { an: false, fakten: 0, letzte_aufnahme: null, qdrant_ok: null });
  assert.equal(z.freigabe_meldung, null);
});

test('GET /zustand: gedaechtnis kommt aus dem Gedächtnis', async () => {
  const gedaechtnis = { zustand: () => ({ an: true, fakten: 3, letzte_aufnahme: '2026-10-25T10:00:00.000Z', qdrant_ok: false }) };
  const { port } = await aufbau({ ueberschreibe: { gedaechtnis } });
  const z = (await anfrage(port, 'GET', '/zustand')).nutz;
  assert.deepEqual(z.gedaechtnis, { an: true, fakten: 3, letzte_aufnahme: '2026-10-25T10:00:00.000Z', qdrant_ok: false });
});

test('GET /zustand zeigt die Freigabe-Meldung', async () => {
  const zustand = { an: true, kanaele: ['matrix'], offen: 2, gemeldet: { neu: 3, erinnerung: 1 }, fehler: {} };
  const { port } = await aufbau({ ueberschreibe: { freigabeMeldung: { zustand: () => zustand } } });
  assert.deepEqual((await anfrage(port, 'GET', '/zustand')).nutz.freigabe_meldung, zustand);
});

test('GET /zustand zeigt den Freigabe-Kontext: vom Modell, Rückfall, Abweichungen (Entscheidung 586)', async () => {
  kontextZaehler.zuruecksetzen();
  kontextZaehler.zaehlen({ herkunft: 'modell', abweichung: null });
  kontextZaehler.zaehlen({ herkunft: 'rueckfall', abweichung: 'saetze' });
  const { port } = await aufbau();
  const k = (await anfrage(port, 'GET', '/zustand')).nutz.freigabe_kontext;
  assert.equal(k.modell, 1);
  assert.equal(k.rueckfall, 1);
  assert.equal(k.abweichung.saetze, 1);
  assert.equal(k.letzte.abweichung, 'saetze');
  kontextZaehler.zuruecksetzen();
});

test('GET /welt und /sitzungen', async () => {
  const { port } = await aufbau({
    ueberschreibe: { welt: { welt: () => ({ t: 9, quellen: {} }), weltblock: () => 'Block', zustand: () => ({}) } },
  });
  assert.deepEqual((await anfrage(port, 'GET', '/welt')).nutz, { ok: true, welt: { t: 9, quellen: {} }, block: 'Block' });
  const s = (await anfrage(port, 'GET', '/sitzungen')).nutz;
  assert.equal(s.haupt.id, 'wurzel-1');
  assert.deepEqual(s.arbeit.map((a) => a.id), ['g2']);

  const leer = await aufbau();
  assert.deepEqual((await anfrage(leer.port, 'GET', '/welt')).nutz, { ok: true, welt: null, block: '' });
});

test('POST /auftrag reiht ein, normalisiert die Klasse und prüft Text und Länge', async () => {
  const geschrieben = [];
  const t = await aufbau({ ueberschreibe: { aufzeichnung: { schreibe: (...a) => geschrieben.push(a), zustand: () => ({}) } } });
  const ok = await anfrage(t.port, 'POST', '/auftrag', { body: { text: '  prüfe den Cluster ', klasse: 'max' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.nutz, { ok: true, angenommen: true, klasse: 'max' });
  assert.equal(t.eingereiht[0].text, 'prüfe den Cluster');
  assert.equal(t.eingereiht[0].klasse, 'max');
  assert.equal(t.eingereiht[0].quelle, 'steuer');
  assert.match(t.eingereiht[0].id, /^steuer:/);
  assert.deepEqual(geschrieben[0], ['steuer', { auftrag: { text: 'prüfe den Cluster', klasse: 'max' } }]);

  const unbekannt = await anfrage(t.port, 'POST', '/auftrag', { body: { text: 'x', klasse: 'komisch' } });
  assert.equal(unbekannt.nutz.klasse, 'hintergrund');
  const ohneKlasse = await anfrage(t.port, 'POST', '/auftrag', { body: { text: 'y' } });
  assert.equal(ohneKlasse.nutz.klasse, 'hintergrund');

  const leer = await anfrage(t.port, 'POST', '/auftrag', { body: { text: '   ' } });
  assert.equal(leer.status, 400);
  assert.deepEqual(leer.nutz, { ok: false, error: 'Text fehlt' });
  const lang = await anfrage(t.port, 'POST', '/auftrag', { body: { text: 'z'.repeat(51) } });
  assert.equal(lang.status, 400);
  assert.match(lang.nutz.error, /Auftrag zu lang \(höchstens 50 Zeichen\)/);
  assert.equal(t.eingereiht.length, 3);
});

test('POST: kaputtes JSON, Nicht-Objekt, leerer und zu großer Rumpf', async () => {
  const { port } = await aufbau();
  assert.deepEqual((await anfrage(port, 'POST', '/auftrag', { body: '{kaputt' })).nutz, { ok: false, error: 'ungültiges JSON' });
  assert.deepEqual((await anfrage(port, 'POST', '/auftrag', { body: '[1]' })).nutz, { ok: false, error: 'Objekt erwartet' });
  assert.equal((await anfrage(port, 'POST', '/auftrag')).status, 400);
  const gross = await anfrage(port, 'POST', '/auftrag', { body: JSON.stringify({ text: 'a'.repeat(70 * 1024) }) }).catch((f) => ({ fehler: f }));
  assert.ok(gross.fehler || gross.status === 400);
  assert.equal((await anfrage(port, 'POST', '/nirgendwo', { body: {} })).status, 404);
});

test('POST /auftrag ohne Eingang: 503', async () => {
  const { port } = await aufbau({ ueberschreibe: { ingress: undefined } });
  const r = await anfrage(port, 'POST', '/auftrag', { body: { text: 'x' } });
  assert.equal(r.status, 503);
  assert.equal(r.nutz.ok, false);
});

test('POST /abbrechen ruft runner.abbrechen mit dem Hauptgespräch (auch ohne Rumpf)', async () => {
  const t = await aufbau();
  assert.deepEqual((await anfrage(t.port, 'POST', '/abbrechen', { body: {} })).nutz, { ok: true });
  assert.deepEqual((await anfrage(t.port, 'POST', '/abbrechen')).nutz, { ok: true });
  assert.deepEqual(t.abgebrochen, ['wurzel-1', 'wurzel-1']);
  t.runner.abbrechen = async () => {
    throw new Error('Gespräch nicht gefunden');
  };
  const f = await anfrage(t.port, 'POST', '/abbrechen', { body: {} });
  assert.deepEqual(f.nutz, { ok: false, error: 'Gespräch nicht gefunden' });
});

test('POST /dialog: ohne Dialogwache 400', async () => {
  const { port } = await aufbau();
  const r = await anfrage(port, 'POST', '/dialog', { body: { id: 'd1', value: 'ja' } });
  assert.equal(r.status, 400);
  assert.deepEqual(r.nutz, { ok: false, error: 'Dialogwache aus' });
});

test('POST /takt: ausloesen mit ID; ohne Takt 400 „Takt aus“', async () => {
  const gerufen = [];
  const mit = await aufbau({ ueberschreibe: { takt: { zustand: () => ({}), ausloesen: async (id) => (gerufen.push(id), { ok: true, ausgeloest: ['takt:morgen:1'] }) } } });
  const r = await anfrage(mit.port, 'POST', '/takt', { body: { id: 'morgen' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.nutz, { ok: true, ausgeloest: ['takt:morgen:1'] });
  assert.deepEqual(gerufen, ['morgen']);

  const ohne = await aufbau();
  const a = await anfrage(ohne.port, 'POST', '/takt', { body: { id: 'morgen' } });
  assert.equal(a.status, 400);
  assert.deepEqual(a.nutz, { ok: false, error: 'Takt aus' });
});

test('POST /aufzeichnung schaltet; an muss boolesch sein', async () => {
  const stand = { an: false };
  const aufzeichnung = {
    an: () => stand.an,
    schalten: (a) => (stand.an = a),
    datei: () => '/tmp/aufzeichnung-2026-10-24.jsonl',
    zustand: () => ({}),
  };
  const { port } = await aufbau({ ueberschreibe: { aufzeichnung } });
  const an = await anfrage(port, 'POST', '/aufzeichnung', { body: { an: true } });
  assert.equal(an.status, 200);
  assert.deepEqual(an.nutz, { ok: true, an: true, datei: '/tmp/aufzeichnung-2026-10-24.jsonl' });
  assert.equal(stand.an, true);
  const schlecht = await anfrage(port, 'POST', '/aufzeichnung', { body: { an: 'ja' } });
  assert.equal(schlecht.status, 400);
  assert.deepEqual(schlecht.nutz, { ok: false, error: 'an: true oder false' });

  const ohne = await aufbau();
  assert.equal((await anfrage(ohne.port, 'POST', '/aufzeichnung', { body: { an: true } })).status, 400);
});

test('Browser-Anfragen (Origin) und fremder Host werden abgewiesen', async () => {
  const { port } = await aufbau();
  const o = await anfrage(port, 'POST', '/auftrag', { body: { text: 'x' }, kopf: { Origin: 'https://boese.example' } });
  assert.equal(o.status, 403);
  const h = await anfrage(port, 'GET', '/zustand', { kopf: { Host: 'boese.example:18435' } });
  assert.equal(h.status, 403);
  const gut = await anfrage(port, 'GET', '/healthz', { kopf: { Host: `localhost:${port}` } });
  assert.equal(gut.status, 200);
});
