/**
 * Verwaltung: Sicht, Eingang pausieren (übersteht einen Neustart), geplanter Neustart, Server-Routen mit Token,
 * Bindung außerhalb von Loopback. Die Teile laufen mit Attrappen; nur der Eingang-Test nimmt den echten Runner.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { LiveDoc } from '@earendil-works/pi-durable';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { bindungPruefen, konfigurationLaden } from '../src/config.js';
import { Laufzeit, Wartend } from '../src/documents.js';
import { Ingress } from '../src/ingress.js';
import { Runner } from '../src/runner.js';
import { erstelleServer } from '../src/server.js';
import { Spielmodus } from '../src/spielmodus.js';
import {
  Fehlerspeicher,
  NEUSTART_CODE,
  VerwaltungsFehler,
  Zugmessung,
  buildInfo,
  erstelleVerwaltung,
  perzentil,
  schwaerzen,
} from '../src/verwaltung.js';

const CTX = BACKGROUND_CONTEXT;
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
async function bis(fn, { ms = 15000, was = 'Bedingung' } = {}) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    const wert = await fn();
    if (wert) return wert;
    await warte(50);
  }
  throw new Error(`Zeit abgelaufen: ${was}`);
}

const tmp = mkdtempSync(join(tmpdir(), 'pidurable-verw-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const TOKEN = 'verwaltung-token-verwaltung-token-0001';

// --- reine Bausteine --------------------------------------------------------------------------

test('perzentil: Rang, leere Liste, kaputte Werte', () => {
  assert.equal(perzentil([], 50), null);
  assert.equal(perzentil([5], 95), 5);
  const zehn = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(perzentil(zehn, 50), 5);
  assert.equal(perzentil(zehn, 95), 10);
  assert.equal(perzentil([3, NaN, 1, undefined, 2], 50), 2);
});

test('schwaerzen nimmt Token, Bearer und lange Hex-Zeichenketten heraus und kürzt', () => {
  const t = schwaerzen(`Fehler mit Bearer abcdef1234567890 und ?token=geheim123 und ${'a'.repeat(40)} fertig`);
  assert.doesNotMatch(t, /abcdef1234567890|geheim123|aaaaaaaa/);
  assert.match(t, /Bearer \*\*\*/);
  assert.equal(schwaerzen('x'.repeat(500), 50).length, 50);
});

test('Fehlerspeicher: Ringspeicher, neueste zuerst, console.error wird mitgeschrieben und weitergereicht', () => {
  const f = new Fehlerspeicher(3, () => 1000);
  for (let i = 1; i <= 5; i++) f.melde('test', new Error(`fehler ${i}`));
  assert.equal(f.gesamt, 5);
  assert.deepEqual(
    f.liste(10).map((e) => e.text),
    ['fehler 5', 'fehler 4', 'fehler 3'],
  );
  const ausgegeben = [];
  const konsole = { error: (...a) => ausgegeben.push(a.join(' ')) };
  const ab = f.anzapfen(konsole);
  konsole.error('[fyos-egress] Zustellung: kaputt Bearer 0123456789abcdef');
  assert.equal(ausgegeben.length, 1, 'die Ausgabe bleibt unverändert');
  const neu = f.liste(1)[0];
  assert.equal(neu.quelle, 'fyos-egress');
  assert.match(neu.text, /Zustellung: kaputt Bearer \*\*\*/);
  ab();
  konsole.error('danach');
  assert.equal(f.gesamt, 6, 'nach dem Abmelden wird nichts mehr mitgeschrieben');
});

test('Zugmessung: p50/p95, je Quelle, Sprachweg getrennt, ein offener Zug zählt nicht', () => {
  let t = 0;
  const z = new Zugmessung(100, () => t);
  const zug = (id, quelle, dauerMs) => {
    z.beginn(id, quelle, 'max');
    t += dauerMs;
    z.ende(id);
  };
  zug('a', 'web', 2000);
  zug('b', 'web', 4000);
  zug('c', 'ha-assist', 1000);
  z.beginn('offen', 'web', 'max');
  z.beginn('offen', 'web', 'max'); // zweiter Beginn im selben Zug ändert nichts
  const s = z.statistik();
  assert.equal(s.n, 3);
  assert.equal(s.p50_s, 2);
  assert.equal(s.p95_s, 4);
  assert.equal(s.je_quelle.web.n, 2);
  assert.equal(s.stimme.n, 1);
  assert.equal(s.stimme.p50_s, 1);
  assert.equal(s.offen, 1);
  z.ende('unbekannt'); // schadet nicht
  assert.equal(new Zugmessung().statistik().p50_s, null, 'ohne Zug kein erfundener Wert');
  assert.equal(new Zugmessung().statistik().stimme, null);
});

test('buildInfo: Umgebung vor Datei, fehlende Dateien ergeben null statt Fehler', () => {
  const leer = buildInfo({ paket: join(tmp, 'gibtsnicht'), env: {} });
  assert.deepEqual(leer, { version: null, commit: null, gebaut: null });
  assert.equal(buildInfo({ paket: join(tmp, 'gibtsnicht'), env: { FYOS_RUNNER_COMMIT: 'abc1234' } }).commit, 'abc1234');
});

test('bindungPruefen: Loopback frei, LAN nur mit langem Token, nie Wildcard', () => {
  assert.deepEqual(bindungPruefen({ host: '127.0.0.1', security: { token: '' } }), { art: 'loopback', fehler: null });
  assert.equal(bindungPruefen({ host: 'localhost' }).art, 'loopback');
  assert.match(bindungPruefen({ host: '0.0.0.0', security: { token: TOKEN } }).fehler, /Wildcard/);
  assert.match(bindungPruefen({ host: '::', security: { token: TOKEN } }).fehler, /Wildcard/);
  assert.match(bindungPruefen({ host: '', security: { token: TOKEN } }).fehler, /Wildcard/);
  assert.match(bindungPruefen({ host: '192.0.2.10', security: { token: 'kurz' } }).fehler, /mindestens 32/);
  assert.match(bindungPruefen({ host: '192.0.2.10', security: {} }).fehler, /mindestens 32/);
  assert.deepEqual(bindungPruefen({ host: '192.0.2.10', security: { token: TOKEN } }), { art: 'netz', fehler: null });
});

test('FYOS_RUNNER_HOST kommt in die Konfiguration; ohne Angabe bleibt es Loopback', () => {
  assert.equal(konfigurationLaden({}, {}).pi_durable.host, '127.0.0.1');
  assert.equal(konfigurationLaden({}, { FYOS_RUNNER_HOST: '192.0.2.10' }).pi_durable.host, '192.0.2.10');
});

// --- Sicht mit Attrappen ----------------------------------------------------------------------

function attrappe({ busy = false, ueberschreibe = {} } = {}) {
  const zustand = { busy };
  const beendet = [];
  const angehalten = [];
  const pausen = [];
  const dokumente = new Map([
    [Laufzeit, { eingangGesehen: 12, eingangFehler: 'Hub weg Bearer 0123456789abcdef' }],
    [Wartend, { eintraege: [{ klasse: 'max' }, { klasse: 'hintergrund' }] }],
  ]);
  const runner = {
    root: { id: 7 },
    harness: {
      snapshot: async (token) => (token === LiveDoc ? { run: zustand.busy ? { taskId: 1 } : null } : dokumente.get(token)),
    },
    freigaben: async () => [
      { id: 'fr-1', status: 'offen', aktion: 'Branch löschen', risiko: 'high', zerstoererisch: true, werkzeug: 'bash', befehl: 'git branch -D alt', kontext: 'Aufräumen', erstellt: 5, gespraechTitel: 'Hauptgespräch', taskId: null },
      { id: 'fr-0', status: 'erteilt', aktion: 'alt' },
    ],
    laeufe: async () => [
      { id: '3', titel: 'Bauen', status: 'laeuft', taskStatus: 'running', erstellt: 9 },
      { id: '2', titel: 'Fertig', status: 'abgeschlossen', taskStatus: 'terminal', erstellt: 8 },
    ],
    knotenListe: () => [{ id: 'hauptserver', titel: 'Hauptserver', weg: 'ssh', local: true, geheim: 'nein' }],
    hub: { gesundheit: async () => ({ ok: true }) },
  };
  const ingress = {
    konfiguriert: true,
    pausiert: false,
    pausiertSeit: null,
    pausiertVon: null,
    haltNeustart: false,
    cursor: '1-0',
    pausieren: async (p, von) => {
      pausen.push([p, von]);
      const geaendert = p !== ingress.pausiert;
      ingress.pausiert = p;
      ingress.pausiertSeit = p ? 123 : null;
      ingress.pausiertVon = p ? von : null;
      return { pausiert: p, geaendert };
    },
    anhalten: (an) => {
      ingress.haltNeustart = an;
      angehalten.push(an);
    },
  };
  const fehler = new Fehlerspeicher(10, () => 50);
  fehler.melde('egress', new Error('Zustellung gescheitert'));
  const zugmessung = new Zugmessung();
  const v = erstelleVerwaltung({
    cfg: { agent: 'persona', hub: 'http://hub.test', pi_durable: { host: '192.0.2.10', port: 18438, device: { id: 'hauptserver' }, security: { token: TOKEN }, storage: '/var/lib/x.sqlite', proactive: { enabled: true } } },
    runner,
    ingress,
    spielmodus: { grund: () => 'spielmodus.kid' },
    tor: { zustand: () => ({ offen: false, warum: 'Schleife pausiert', geprueft: 1 }) },
    lesenTor: { zustand: () => ({ offen: true, warum: 'lesen ok', geprueft: 1 }) },
    egress: { laufend: () => ({ quelle: 'web', klasse: 'max', ein: 'x', bezug: null }), meldestrecke: () => ({ stau: 0, gemeldet: 3, verworfen: 0 }), letzterFehler: null },
    budget: { zustand: () => ({ monat: '2026-10', usd: 1.5 }) },
    fehler,
    zugmessung,
    gestartet: 1_000_000,
    jetzt: () => 1_090_000,
    abfrageMs: 20,
    build: { version: '0.1.0', commit: 'abc1234', gebaut: '2026-10-25T10:00:00Z' },
    beenden: async (grund, code) => beendet.push([grund, code]),
    log: () => {},
    ...ueberschreibe,
  });
  return { v, runner, ingress, beendet, angehalten, pausen, zustand, dokumente, fehler };
}

test('sicht: alle Abschnitte, keine Geheimnisse, offene Freigaben und Läufe', async () => {
  const { v } = attrappe();
  const s = await v.sicht();
  assert.equal(s.ok, true);
  assert.deepEqual(s.luecken, []);
  assert.equal(s.dienst.name, 'fyos-pi-durable');
  assert.equal(s.dienst.version, '0.1.0');
  assert.equal(s.dienst.commit, 'abc1234');
  assert.equal(s.dienst.laeuft_s, 90);
  assert.equal(s.dienst.bindung, 'netz');
  assert.equal(s.dienst.token, true);
  assert.equal(s.eingang.an, true);
  assert.equal(s.eingang.konfiguriert, true);
  assert.equal(s.eingang.gesehen, 12);
  assert.doesNotMatch(s.eingang.fehler, /0123456789abcdef/);
  assert.deepEqual(s.spielmodus, { an: true, grund: 'spielmodus.kid' });
  assert.equal(s.tore.hintergrund.offen, false);
  assert.equal(s.tore.lesen.offen, true);
  assert.equal(s.zug.beschaeftigt, false);
  assert.deepEqual(s.warteschlange, { max: 1, hintergrund: 1 });
  assert.equal(s.freigaben.offen, 1);
  assert.equal(s.freigaben.liste[0].id, 'fr-1');
  assert.equal(s.freigaben.liste[0].befehl, 'git branch -D alt');
  assert.equal(s.laeufe.gesamt, 2);
  assert.deepEqual(s.laeufe.aktiv.map((l) => l.id), ['3']);
  assert.equal(s.fehler.liste[0].text, 'Zustellung gescheitert');
  assert.deepEqual(s.knoten, [{ id: 'hauptserver', titel: 'Hauptserver', weg: 'ssh', local: true }]);
  assert.equal(s.hub.ok, true);
  assert.equal(s.budget.usd, 1.5);
  assert.equal(s.antwortzeit.n, 0);
  assert.equal(s.antwortzeit.p50_s, null);
  assert.doesNotMatch(JSON.stringify(s), new RegExp(TOKEN), 'das Token steht nirgends in der Sicht');
});

test('sicht: fällt eine Quelle aus, steht sie in luecken, der Rest bleibt', async () => {
  const { v, runner } = attrappe();
  runner.freigaben = async () => {
    throw new Error('Dokument nicht lesbar');
  };
  runner.hub.gesundheit = () => new Promise(() => {}); // antwortet nie
  const s = await Promise.race([v.sicht(), warte(6000).then(() => 'zu langsam')]);
  assert.notEqual(s, 'zu langsam', 'ein hängender Hub hält die Sicht nicht auf');
  assert.equal(s.freigaben, null);
  assert.equal(s.hub, null);
  assert.deepEqual(s.luecken.map((l) => l.quelle).sort(), ['freigaben', 'hub']);
  assert.ok(s.dienst && s.laeufe && s.eingang, 'die übrigen Abschnitte sind da');
});

test('Zug offen: beschaeftigt und laufend stehen in der Sicht', async () => {
  const { v } = attrappe({ busy: true });
  const s = await v.sicht();
  assert.equal(s.zug.beschaeftigt, true);
  assert.equal(s.zug.laufend.quelle, 'web');
});

// --- Eingang ----------------------------------------------------------------------------------

test('eingang: pausieren und fortsetzen, nur boolean, Hinweis im Schatten', async () => {
  const { v, pausen, ingress } = attrappe();
  await assert.rejects(() => v.eingang('nein'), (e) => e instanceof VerwaltungsFehler && e.status === 400);
  const aus = await v.eingang(false, 'max (Verwaltung)');
  assert.equal(aus.ok, true);
  assert.equal(aus.geaendert, true);
  assert.equal(aus.eingang.pausiert, true);
  assert.equal(aus.eingang.an, false);
  assert.equal(aus.eingang.pausiert_von, 'max (Verwaltung)');
  const nochmal = await v.eingang(false);
  assert.equal(nochmal.geaendert, false, 'zweimal pausieren ändert nichts');
  const an = await v.eingang(true);
  assert.equal(an.eingang.an, true);
  assert.equal(an.hinweis, null);
  assert.deepEqual(pausen.map((p) => p[0]), [true, true, false]);

  ingress.konfiguriert = false;
  const schatten = await v.eingang(true);
  assert.equal(schatten.eingang.an, false, 'per Konfiguration aus bleibt aus');
  assert.match(schatten.hinweis, /Konfiguration aus/);
});

test('Pause im Dokument: nichts geht an den Agenten, sie übersteht den Neustart, Fortsetzen holt alles nach', async () => {
  const dir = join(tmp, 'pause');
  const cfg = konfigurationLaden(
    {
      hub: 'http://hub.test',
      arbeitsbereiche: { standard: { pfad: tmp, titel: 'Test' } },
      spielmodus: [],
      pi_durable: {
        storage: join(dir, 'fyos.sqlite'),
        security: { token: TOKEN },
        proactive: { enabled: true, pollSeconds: 3 },
        egress: { enabled: false },
        browser: { enabled: false },
        desktop: { enabled: false },
      },
    },
    {},
  );
  const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: [{ id: 'hausmodell' }, { id: 'hausmodell-max' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const gesehen = [];
  faux.setResponses(
    Array.from({ length: 4 }, () => (context) => {
      gesehen.push(JSON.stringify([...context.messages].reverse().find((m) => m.role === 'user')?.content ?? ''));
      return fauxAssistantMessage('ok');
    }),
  );
  const hub = {
    aufrufen: async () => ({ ok: true, result: {} }),
    melden: async () => ({ ok: true }),
    bereicheMelden: async () => ({ ok: true }),
    gesundheit: async () => ({ ok: true }),
    suchen: async () => [],
    schema: async () => ({}),
    eingangLesen: async (nach) => {
      await warte(100);
      return { eintraege: [], letzte: nach };
    },
  };

  let runner = new Runner(cfg, { models, hub });
  await runner.start();
  let ingress = new Ingress({ cfg, runner, hub, spielmodus: new Spielmodus([]), tor: { offen: true }, onFehler: () => {} });
  await ingress.start();
  try {
    const r = await ingress.pausieren(true, 'test');
    assert.deepEqual({ p: r.pausiert, g: r.geaendert }, { p: true, g: true });
    const lz = await runner.harness.snapshot(Laufzeit, CTX);
    assert.equal(lz.eingangPausiert, true);
    assert.equal(lz.eingangPausiertVon, 'test');
    assert.equal(typeof lz.eingangPausiertSeit, 'number');

    assert.equal(await ingress.einreihen({ id: 'm1', text: 'max1', quelle: 'web', klasse: 'max' }), true);
    await warte(2600);
    assert.equal(gesehen.length, 0, 'pausiert: auch Besitzer geht nicht an den Agenten');
    assert.equal((await runner.harness.snapshot(Wartend, CTX)).eintraege.length, 1, 'angenommen bleibt angenommen');

    // Neustart mit derselben Datei: die Pause steht noch.
    await ingress.stop();
    await runner.close().catch(() => {});
    runner = new Runner(cfg, { models, hub });
    await runner.start();
    ingress = new Ingress({ cfg, runner, hub, spielmodus: new Spielmodus([]), tor: { offen: true }, onFehler: () => {} });
    await ingress.start();
    assert.equal(ingress.pausiert, true, 'die Pause überlebt den Neustart');
    assert.equal(ingress.pausiertVon, 'test');
    await warte(2600);
    assert.equal(gesehen.length, 0, 'nach dem Neustart weiter pausiert');

    const weiter = await ingress.pausieren(false, 'test');
    assert.equal(weiter.geaendert, true);
    assert.equal((await runner.harness.snapshot(Laufzeit, CTX)).eingangPausiert, false);
    await bis(() => gesehen.length === 1, { was: 'der wartende Eintrag läuft nach dem Fortsetzen' });
    assert.match(gesehen[0], /max1/);
  } finally {
    await ingress.stop();
    await runner.close().catch(() => {});
  }
});

// --- Neustart ---------------------------------------------------------------------------------

test('neustart: wartet auf den laufenden Zug, hält den Eingang an, beendet mit Code 75', async () => {
  const { v, beendet, angehalten, zustand } = attrappe({ busy: true });
  const r = await v.neustart({ frist_s: 30 }, 'max');
  assert.equal(r.ok, true);
  assert.equal(r.geplant, true);
  assert.equal(r.wartet_auf_zug, true);
  assert.equal(r.neustart.frist_s, 30);
  assert.deepEqual(angehalten, [true], 'sofort nichts Neues mehr annehmen');
  await warte(150);
  assert.equal(beendet.length, 0, 'solange der Zug läuft, bleibt der Prozess');
  assert.equal((await v.neustart({})).schon_geplant, true, 'ein zweiter Aufruf plant nichts doppelt');
  zustand.busy = false;
  await bis(() => beendet.length === 1, { was: 'beendet nach dem Zug' });
  assert.deepEqual(beendet[0], ['Neustart (Verwaltung)', NEUSTART_CODE]);
  assert.equal(NEUSTART_CODE, 75);
  v.stop();
});

test('neustart: nach der Frist wird auch ein laufender Zug nicht mehr abgewartet', async () => {
  let jetzt = 5_000_000;
  const { v, beendet } = attrappe({ busy: true, ueberschreibe: { jetzt: () => jetzt } });
  await v.neustart({ frist_s: 10 });
  await warte(100);
  assert.equal(beendet.length, 0);
  jetzt += 11_000;
  await bis(() => beendet.length === 1, { was: 'Frist abgelaufen' });
  v.stop();
});

test('neustart: ohne laufenden Zug geht es sofort, Frist 0 ist erlaubt', async () => {
  const { v, beendet } = attrappe({ busy: false });
  const r = await v.neustart({ frist_s: 0 });
  assert.equal(r.wartet_auf_zug, false);
  await bis(() => beendet.length === 1, { was: 'sofort beendet' });
  v.stop();
});

test('neustart: abbrechen hebt den Halt auf, falsche Fristen werden abgelehnt', async () => {
  const { v, beendet, angehalten } = attrappe({ busy: true });
  for (const frist of [-1, 901, 'abc']) {
    await assert.rejects(() => v.neustart({ frist_s: frist }), (e) => e instanceof VerwaltungsFehler && e.status === 400, `frist ${frist}`);
  }
  assert.deepEqual(angehalten, [], 'abgelehnte Aufrufe halten nichts an');
  assert.equal((await v.neustart({ abbrechen: true })).geplant, false, 'nichts geplant, nichts zu tun');
  await v.neustart({ frist_s: 60 });
  const ab = await v.neustart({ abbrechen: true });
  assert.equal(ab.abgebrochen, true);
  assert.deepEqual(angehalten, [true, false]);
  assert.equal(v.neustartSicht(), null);
  await warte(100);
  assert.equal(beendet.length, 0, 'nach dem Abbrechen beendet sich nichts');
});

test('neustart: scheitert das Beenden, wird der Halt aufgehoben', async () => {
  const { v, angehalten } = attrappe({
    busy: false,
    ueberschreibe: {
      beenden: async () => {
        throw new Error('geht nicht');
      },
    },
  });
  await v.neustart({ frist_s: 0 });
  await bis(() => angehalten.includes(false), { was: 'Halt aufgehoben' });
  assert.equal(v.neustartSicht(), null);
});

test('neustart ohne eingebautes Beenden: 503', async () => {
  const { v } = attrappe({ ueberschreibe: { beenden: null } });
  await assert.rejects(() => v.neustart({}), (e) => e instanceof VerwaltungsFehler && e.status === 503);
});

// --- Server: Token und Routen ------------------------------------------------------------------

async function mitServer(verwaltung, fn, { token = TOKEN } = {}) {
  const cfg = { pi_durable: { security: { token, allowedOrigins: [] }, limits: { maxBodyBytes: 65536 }, clientDir: tmp } };
  const server = erstelleServer({ runner: {}, cfg, verwaltung });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  const anfrage = (methode, pfad, { kopf = {}, body } = {}) =>
    new Promise((fertig, scheitern) => {
      const req = createServerRequest({ port, methode, pfad, kopf, body }, fertig, scheitern);
      return req;
    });
  try {
    await fn(anfrage);
  } finally {
    await new Promise((ok) => server.close(ok));
  }
}

function createServerRequest({ port, methode, pfad, kopf, body }, fertig, scheitern) {
  const req = http.request({ host: '127.0.0.1', port, method: methode, path: pfad, headers: kopf, agent: false }, (res) => {
    const stuecke = [];
    res.on('data', (c) => stuecke.push(c));
    res.on('end', () => {
      const roh = Buffer.concat(stuecke).toString('utf8');
      let nutz = null;
      try {
        nutz = roh ? JSON.parse(roh) : null;
      } catch {
        nutz = roh;
      }
      fertig({ status: res.statusCode, nutz });
    });
  });
  req.on('error', scheitern);
  if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
  req.end();
  return req;
}

test('Server: GET /api/verwaltung braucht das Token (Kopf oder Cookie), ohne 401', async () => {
  const { v } = attrappe();
  await mitServer(v, async (anfrage) => {
    assert.equal((await anfrage('GET', '/api/verwaltung')).status, 401);
    assert.equal((await anfrage('GET', '/api/verwaltung', { kopf: { Authorization: 'Bearer falsch' } })).status, 401);
    const ok = await anfrage('GET', '/api/verwaltung', { kopf: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(ok.status, 200);
    assert.equal(ok.nutz.dienst.name, 'fyos-pi-durable');
    const cookie = await anfrage('GET', '/api/verwaltung', { kopf: { Cookie: `fyos_runner=${TOKEN}` } });
    assert.equal(cookie.status, 200, 'Lesen darf auch mit Cookie');
  });
});

test('Server: Befehle nur mit Token im Authorization-Kopf, ein Cookie genügt nicht', async () => {
  const { v, pausen, beendet } = attrappe();
  await mitServer(v, async (anfrage) => {
    const bearer = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
    for (const pfad of ['/api/steuern/eingang', '/api/steuern/neustart']) {
      assert.equal((await anfrage('POST', pfad, { body: { an: false } })).status, 401, `${pfad} ohne alles`);
      const cookie = await anfrage('POST', pfad, { kopf: { Cookie: `fyos_runner=${TOKEN}` }, body: { an: false } });
      assert.equal(cookie.status, 401, `${pfad} nur mit Cookie`);
      assert.match(cookie.nutz.fehler, /Authorization: Bearer/);
      const query = await anfrage('POST', `${pfad}?token=${TOKEN}`, { body: { an: false } });
      assert.equal(query.status, 401, `${pfad} mit Token in der Adresse`);
    }
    assert.deepEqual(pausen, [], 'abgewiesene Befehle haben nichts getan');

    const aus = await anfrage('POST', '/api/steuern/eingang', { kopf: bearer, body: { an: false, von: 'max (Verwaltung)' } });
    assert.equal(aus.status, 200);
    assert.equal(aus.nutz.eingang.pausiert, true);
    assert.equal(aus.nutz.eingang.pausiert_von, 'max (Verwaltung)');
    assert.equal((await anfrage('POST', '/api/steuern/eingang', { kopf: bearer, body: { an: 'ja' } })).status, 400);
    assert.equal((await anfrage('POST', '/api/steuern/eingang', { kopf: bearer, body: 'kein json' })).status, 400);

    const neu = await anfrage('POST', '/api/steuern/neustart', { kopf: bearer, body: { frist_s: 0 } });
    assert.equal(neu.status, 200);
    assert.equal(neu.nutz.geplant, true);
    assert.equal((await anfrage('POST', '/api/steuern/neustart', { kopf: bearer, body: { frist_s: 5000 } })).status, 400);
    await bis(() => beendet.length === 1, { was: 'Neustart über HTTP' });
    assert.equal(beendet[0][1], 75);

    assert.equal((await anfrage('GET', '/api/steuern/eingang', { kopf: bearer })).status, 404, 'nur POST');
    assert.equal((await anfrage('POST', '/api/steuern/unbekannt', { kopf: bearer, body: {} })).status, 404);
  });
  v.stop();
});

test('Server ohne Verwaltung: 503; ohne gesetztes Token gibt es keine Befehle', async () => {
  await mitServer(null, async (anfrage) => {
    const r = await anfrage('GET', '/api/verwaltung', { kopf: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(r.status, 503);
  });
  const { v } = attrappe();
  await mitServer(
    v,
    async (anfrage) => {
      const r = await anfrage('POST', '/api/steuern/eingang', { body: { an: false } });
      assert.equal(r.status, 401, 'ein leeres Token öffnet nichts');
    },
    { token: '' },
  );
});
