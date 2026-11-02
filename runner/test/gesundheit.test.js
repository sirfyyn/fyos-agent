/**
 * Der Wächter „Runner stumm“ im Runner (src/gesundheit.js): Ampel, Zähler in Ausgang und Eingang, `/zustand` mit `gesundheit`
 * und `version`. Reine Regeln mit festen Zahlen, die Zähler mit einer Uhr, die der Test vorstellt, und der Steuerkanal über HTTP.
 * Die Verträge mit dem echten Hub prüft vertrag-hub.test.js.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { LiveDoc } from '@earendil-works/pi-durable';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { konfigurationLaden } from '../src/config.js';
import { LaufListe, Laufzeit, Wartend } from '../src/documents.js';
import { Egress } from '../src/egress.js';
import { bewerte } from '../src/gesundheit.js';
import { HubFehler } from '../src/hub.js';
import { Ingress } from '../src/ingress.js';
import { Runner } from '../src/runner.js';
import { erstelleSteuerkanal } from '../src/steuerkanal.js';
import { versionErmitteln } from '../src/version.js';

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

const tmp = mkdtempSync(join(tmpdir(), 'pidurable-gesund-'));
const offene = [];
after(async () => {
  for (const s of offene) await s.beenden?.();
  rmSync(tmp, { recursive: true, force: true });
});

// --- reine Regeln -----------------------------------------------------------------------------------------------------------

const JETZT = 1_792_270_000_000;
const gesund = (extra = {}) => ({
  jetzt: JETZT,
  pi_laeuft: true,
  spielmodus: false,
  beschaeftigt: false,
  ausgang: {
    aktiv: true, stau: 0, max_puffer: 1000, aeltestes_s: null, letzter_erfolg: JETZT - 5000, gemeldet: 10, verworfen: 0, letztes_verwerfen: null,
    fehler: 0, fehler_in_folge: 0, abgelehnt: 0, abgelehnt_in_folge: 0, letzter_fehler: null,
  },
  eingang: { aktiv: true, poll_s: 20, vor_s: 15, fehler: 0, fehler_in_folge: 0, letzter_fehler: null },
  zug: { laeuft: false, seit_s: null },
  max_wartet_s: null,
  ...extra,
});
const mitAusgang = (a) => gesund({ ausgang: { ...gesund().ausgang, ...a } });
const mitEingang = (i) => gesund({ eingang: { ...gesund().eingang, ...i } });
const codes = (u) => u.gruende.map((g) => g.code);

test('Ampel: gesunder Runner ist grün, auch nach langem Schweigen ohne etwas zu sagen', () => {
  assert.deepEqual(bewerte(gesund()), { ampel: 'ok', gruende: [] });
  // Nichts zu melden ist kein Stummsein: alter Erfolg allein färbt nichts.
  assert.equal(bewerte(mitAusgang({ letzter_erfolg: JETZT - 3 * 3600_000 })).ampel, 'ok');
});

test('Ampel: wartende Ereignisse ohne Erfolg: ab 2 min gelb, ab 5 min rot', () => {
  assert.equal(bewerte(mitAusgang({ stau: 4, aeltestes_s: 60 })).ampel, 'ok');
  const gelb = bewerte(mitAusgang({ stau: 4, aeltestes_s: 130 }));
  assert.equal(gelb.ampel, 'gelb');
  assert.deepEqual(codes(gelb), ['ausgang_langsam']);
  const rot = bewerte(mitAusgang({ stau: 41, aeltestes_s: 420 }));
  assert.equal(rot.ampel, 'rot');
  assert.deepEqual(codes(rot), ['ausgang_stumm']);
  assert.match(rot.gruende[0].text, /7 min.*41 Ereignisse/);
});

test('Ampel: der Hub lehnt in Folge ab (Vertragsbruch) ist sofort rot, auch bei leerem Puffer', () => {
  const u = bewerte(mitAusgang({ abgelehnt_in_folge: 3, abgelehnt: 3, fehler_in_folge: 3, letzter_fehler: { text: 'Ereignis 0: Agenten-ID unbrauchbar: None' } }));
  assert.equal(u.ampel, 'rot');
  assert.ok(codes(u).includes('hub_lehnt_ab'));
  assert.match(u.gruende.find((g) => g.code === 'hub_lehnt_ab').text, /Agenten-ID unbrauchbar/);
  assert.equal(bewerte(mitAusgang({ abgelehnt_in_folge: 2 })).ampel, 'ok');
});

test('Ampel: Fehler in Folge, Puffer und Verwerfen', () => {
  assert.equal(bewerte(mitAusgang({ fehler_in_folge: 3 })).ampel, 'gelb');
  assert.equal(bewerte(mitAusgang({ fehler_in_folge: 10 })).ampel, 'rot');
  assert.equal(bewerte(mitAusgang({ stau: 500, aeltestes_s: 1 })).ampel, 'gelb');
  assert.deepEqual(codes(bewerte(mitAusgang({ stau: 950, aeltestes_s: 1 }))), ['puffer_voll']);
  const frisch = bewerte(mitAusgang({ verworfen: 12, letztes_verwerfen: JETZT - 60_000 }));
  assert.equal(frisch.ampel, 'rot');
  assert.deepEqual(codes(frisch), ['verworfen']);
  assert.equal(bewerte(mitAusgang({ verworfen: 12, letztes_verwerfen: JETZT - 3600_000 })).ampel, 'ok', 'altes Verwerfen färbt nicht mehr');
});

test('Ampel: der Eingang steht (Takt der Anfrage zählt nicht mit), Lesefehler, Schatten ohne Eingang', () => {
  assert.equal(bewerte(mitEingang({ vor_s: 20 + 59 })).ampel, 'ok');
  assert.deepEqual(codes(bewerte(mitEingang({ vor_s: 20 + 90 }))), ['eingang_steht']);
  assert.equal(bewerte(mitEingang({ vor_s: 20 + 90 })).ampel, 'gelb');
  assert.equal(bewerte(mitEingang({ vor_s: 20 + 400 })).ampel, 'rot');
  assert.equal(bewerte(mitEingang({ fehler_in_folge: 3 })).ampel, 'gelb');
  assert.equal(bewerte(mitEingang({ fehler_in_folge: 10 })).ampel, 'rot');
  assert.equal(bewerte(mitEingang({ aktiv: false, vor_s: 99999, fehler_in_folge: 99 })).ampel, 'ok', 'im Schatten liest niemand');
  assert.equal(bewerte(gesund({ eingang: null })).ampel, 'ok');
});

test('Ampel: Besitzer\' Nachricht liegt (rot, außer im Spielmodus oder bei laufendem Zug), lange Züge, toter Harness', () => {
  assert.deepEqual(codes(bewerte(gesund({ max_wartet_s: 400 }))), ['max_liegt']);
  assert.equal(bewerte(gesund({ max_wartet_s: 400, spielmodus: true })).ampel, 'ok');
  assert.equal(bewerte(gesund({ max_wartet_s: 400, beschaeftigt: true })).ampel, 'ok');
  assert.equal(bewerte(gesund({ max_wartet_s: 100 })).ampel, 'ok');
  assert.equal(bewerte(gesund({ beschaeftigt: true, zug: { laeuft: true, seit_s: 50 * 60 } })).ampel, 'gelb');
  assert.equal(bewerte(gesund({ beschaeftigt: true, zug: { laeuft: true, seit_s: 5 * 3600 } })).ampel, 'rot');
  assert.deepEqual(codes(bewerte(gesund({ pi_laeuft: false }))), ['harness']);
});

test('Ampel: mehrere Gründe, der schlimmste gewinnt, alle stehen drin; abgeschalteter Ausgang zählt nicht', () => {
  const u = bewerte(gesund({ ausgang: { ...gesund().ausgang, stau: 3, aeltestes_s: 150, fehler_in_folge: 10 } }));
  assert.equal(u.ampel, 'rot');
  assert.deepEqual(codes(u).sort(), ['ausgang_fehler', 'ausgang_langsam']);
  assert.equal(bewerte(gesund({ ausgang: { ...gesund().ausgang, aktiv: false, stau: 9, aeltestes_s: 9999 } })).ampel, 'ok');
});

// --- Zähler im Ausgang -----------------------------------------------------------------------------------------------------

async function runnerMitEgress(name, hub, uhr) {
  const cfg = konfigurationLaden(
    {
      hub: 'http://hub.test',
      arbeitsbereiche: { standard: { pfad: tmp, titel: 'Test' } },
      pi_durable: {
        storage: join(tmp, name, 'fyos.sqlite'),
        security: { token: 'test-token-test-token-test-token-00' },
        egress: { enabled: true, flushMs: 3_600_000, erinnerungS: 0, maxBuffer: 20 },
        browser: { enabled: false },
        desktop: { enabled: false },
      },
    },
    {},
  );
  const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: [{ id: 'hausmodell' }, { id: 'hausmodell-max' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runner = new Runner(cfg, { models, hub });
  await runner.start();
  const egress = new Egress({ cfg, harness: runner.harness, hub, onFehler: () => {}, jetzt: uhr });
  await egress.start();
  return { cfg, faux, runner, egress };
}

test('Ausgang zählt: Erfolg, Fehler in Folge, Ablehnung des Hubs, Verdrängen aus dem Puffer', async () => {
  let jetzt = JETZT;
  const uhr = () => jetzt;
  let antwort = 'ablehnen';
  const hub = {
    melden: async () => {
      if (antwort === 'ablehnen') throw new HubFehler('Ereignis 0: Agenten-ID unbrauchbar: None', { status: 400 });
      if (antwort === 'netz') throw new HubFehler('Hub nicht erreichbar', { art: 'netz' });
      return { ok: true };
    },
    bereicheMelden: async () => ({ ok: true }),
    gesundheit: async () => ({ ok: true }),
    aufrufen: async () => ({ ok: true, result: {} }),
  };
  const { faux, runner, egress } = await runnerMitEgress('zaehler', hub, uhr);
  try {
    const root = runner.root.id;
    faux.setResponses([fauxAssistantMessage('Antwort')]);
    await runner.sende(root, 'frage');
    await bis(() => egress.gesundheit().fehler >= 1, { was: 'erster Fehlschlag' });
    // Die Zeit vergeht, der Hub lehnt weiter ab: drei Versuche, kein Erfolg.
    jetzt += 400_000;
    await egress.flush();
    await egress.flush();
    const g = egress.gesundheit();
    assert.ok(g.stau > 0);
    assert.equal(g.letzter_erfolg, null);
    assert.ok(g.abgelehnt_in_folge >= 3, `abgelehnt_in_folge ${g.abgelehnt_in_folge}`);
    assert.equal(g.letzter_fehler.status, 400);
    assert.match(g.letzter_fehler.text, /Agenten-ID unbrauchbar/);
    assert.ok(g.aeltestes_s >= 400);
    const u = bewerte({ jetzt, pi_laeuft: true, spielmodus: false, beschaeftigt: false, ausgang: g, eingang: null, zug: null, max_wartet_s: null });
    assert.equal(u.ampel, 'rot');
    assert.ok(u.gruende.some((x) => x.code === 'hub_lehnt_ab'));
    assert.ok(u.gruende.some((x) => x.code === 'ausgang_stumm'));

    // Ein Netzfehler ist keine Ablehnung: die Folge der Ablehnungen reißt ab, die der Fehler läuft weiter.
    antwort = 'netz';
    const vorher = egress.gesundheit();
    await egress.flush();
    const netz = egress.gesundheit();
    assert.equal(netz.abgelehnt_in_folge, 0);
    assert.equal(netz.abgelehnt, vorher.abgelehnt);
    assert.equal(netz.fehler_in_folge, vorher.fehler_in_folge + 1);

    // Der Hub erholt sich: alles geht hinaus, die Folgen enden, die Ampel wird grün.
    antwort = 'ok';
    jetzt += 1000;
    await egress.flush();
    await bis(() => egress.tiefe() === 0, { was: 'Puffer leer' });
    const heil = egress.gesundheit();
    assert.equal(heil.fehler_in_folge, 0);
    assert.equal(heil.abgelehnt_in_folge, 0);
    assert.equal(heil.letzter_erfolg, jetzt);
    assert.ok(heil.fehler >= 4, 'die Gesamtzahl bleibt stehen');
    assert.equal(bewerte({ jetzt, pi_laeuft: true, spielmodus: false, beschaeftigt: false, ausgang: heil, eingang: null, zug: null, max_wartet_s: null }).ampel, 'ok');

    // Läuft der Puffer über, merkt sich der Ausgang, wann zuletzt verdrängt wurde.
    antwort = 'netz';
    for (let k = 0; k < 40; k += 1) egress.meldeExtern(root, { typ: 'error', nachricht: `n${k}`, art: 'probe' });
    const voll = egress.gesundheit();
    assert.ok(voll.verworfen > 0);
    assert.equal(voll.letztes_verwerfen, jetzt);
    assert.equal(voll.stau, voll.max_puffer);
  } finally {
    await egress.stop();
    await runner.close().catch(() => {});
  }
});

test('Ausgang zählt Züge: laufend seit …, letztes Ende', async () => {
  let jetzt = JETZT;
  const hub = { melden: async () => ({ ok: true }), bereicheMelden: async () => ({ ok: true }), gesundheit: async () => ({ ok: true }), aufrufen: async () => ({ ok: true, result: {} }) };
  const { runner, egress } = await runnerMitEgress('zug', hub, () => jetzt);
  try {
    const id = runner.root.id;
    assert.deepEqual(egress.zugStand(id), { laeuft: false, seit_s: null, letzter_start: null, letztes_ende: null });
    await egress.verarbeite(id, [{ type: 'run_start', inputs: [1] }]);
    jetzt += 95_000;
    assert.deepEqual(egress.zugStand(id), { laeuft: true, seit_s: 95, letzter_start: JETZT, letztes_ende: null });
    await egress.verarbeite(id, [{ type: 'run_end', inputs: [1] }]);
    const z = egress.zugStand(id);
    assert.equal(z.laeuft, false);
    assert.equal(z.letztes_ende, jetzt);
    assert.equal(z.letzter_start, JETZT);
  } finally {
    await egress.stop();
    await runner.close().catch(() => {});
  }
});

// --- Zähler im Eingang -----------------------------------------------------------------------------------------------------

test('Eingang zählt: letztes Lesen, Lesefehler in Folge, vor dem ersten Lesen zählt der Start', async () => {
  let jetzt = JETZT;
  let modus = 'haengt';
  const hub = {
    melden: async () => ({ ok: true }),
    bereicheMelden: async () => ({ ok: true }),
    gesundheit: async () => ({ ok: true }),
    aufrufen: async () => ({ ok: true, result: {} }),
    eingangLesen: async (nach) => {
      if (modus === 'haengt') return new Promise(() => {});
      if (modus === 'fehler') throw new HubFehler('Hub antwortet 503', { status: 503 });
      await warte(30);
      return { eintraege: [], letzte: nach === '$' ? '0' : nach };
    },
  };
  const { cfg, runner, egress } = await runnerMitEgress('eingang', hub, () => jetzt);
  cfg.pi_durable.proactive = { enabled: true, pollSeconds: 1 };
  cfg.eingang = { fehler_pause_s: 0.05 };
  const ingress = new Ingress({ cfg, runner, hub, spielmodus: runner.spielmodus, tor: { offen: true }, onFehler: () => {}, jetzt: () => jetzt });
  try {
    assert.equal(ingress.gesundheit().aktiv, false);
    await ingress.start();
    jetzt += 400_000;
    const haengt = ingress.gesundheit();
    assert.equal(haengt.aktiv, true);
    assert.equal(haengt.letztes_lesen, null);
    assert.equal(haengt.vor_s, 400, 'ein Leser, der nie ankommt, zählt ab dem Start');
    assert.equal(bewerte({ jetzt, pi_laeuft: true, spielmodus: false, beschaeftigt: false, ausgang: null, eingang: haengt, zug: null, max_wartet_s: null }).ampel, 'rot');
    await ingress.stop();

    modus = 'fehler';
    const fehlerhaft = new Ingress({ cfg, runner, hub, spielmodus: runner.spielmodus, tor: { offen: true }, onFehler: () => {}, jetzt: () => jetzt });
    await fehlerhaft.start();
    // Der Leser muss trotz des schlafenden Ausgebers nach jedem Fehler weiterlesen (früher: gemeinsamer Wecker, Leser blieb stehen).
    await bis(() => fehlerhaft.gesundheit().fehler_in_folge >= 3, { was: 'drei Lesefehler' });
    assert.match(fehlerhaft.gesundheit().letzter_fehler.text, /503/);
    modus = 'ok';
    jetzt += 5000;
    await bis(() => fehlerhaft.gesundheit().fehler_in_folge === 0, { was: 'Lesen gelingt wieder' });
    const heil = fehlerhaft.gesundheit();
    assert.equal(heil.letztes_lesen, jetzt);
    assert.ok(heil.fehler >= 3);
    await fehlerhaft.stop();
  } finally {
    await ingress.stop();
    await egress.stop();
    await runner.close().catch(() => {});
  }
});

// --- Steuerkanal: gesundheit und version ------------------------------------------------------------------------------------

function anfrage(port, pfad) {
  return new Promise((fertig, scheitern) => {
    http
      .get({ host: '127.0.0.1', port, path: pfad, agent: false }, (res) => {
        const s = [];
        res.on('data', (c) => s.push(c));
        res.on('end', () => fertig({ status: res.statusCode, nutz: JSON.parse(Buffer.concat(s).toString('utf8')) }));
      })
      .on('error', scheitern);
  });
}

function kanal(teile = {}) {
  const harness = {
    async snapshot(token) {
      if (token === Wartend) return { eintraege: teile.wartend ?? [] };
      if (token === Laufzeit) return { eingangGesehen: 0, eingangFehler: null };
      if (token === LiveDoc) return { run: null };
      if (token === LaufListe) return { eintraege: {} };
      return undefined;
    },
  };
  const server = erstelleSteuerkanal({
    cfg: { agent: 'persona', steuer: { host: '127.0.0.1', port: 0 } },
    runner: { harness, root: { id: 'w1' }, geschlossen: false },
    jetzt: () => JETZT,
    log: () => {},
    ...teile.ueberschreibe,
  });
  offene.push(server);
  return server.starten().then(({ port }) => ({ port }));
}

test('/zustand meldet die Version aus der Datei VERSION (Paketversion + Git-Stand)', async () => {
  const datei = join(tmp, 'VERSION');
  writeFileSync(datei, 'git=f1b37ceb2\nzweig=main\ngebaut=2026-10-25T17:30:00Z\npaket=0.1.0\n');
  const { port } = await kanal({ ueberschreibe: { versionInfo: versionErmitteln({ datei }) } });
  const z = (await anfrage(port, '/zustand')).nutz;
  assert.match(z.version, /^\d+\.\d+\.\d+\+f1b37ceb2$/);
  assert.equal(z.version_info.git, 'f1b37ceb2');
  assert.equal(z.version_info.zweig, 'main');
  assert.equal(z.version_info.gebaut, '2026-10-25T17:30:00Z');
  assert.equal(z.version_info.quelle, 'VERSION');
  assert.equal(z.zustand_version, 1);
});

test('/zustand ohne VERSION-Datei: Paketversion und „unbekannt“, nichts erfunden', async () => {
  const { port } = await kanal({ ueberschreibe: { versionInfo: versionErmitteln({ datei: join(tmp, 'gibt-es-nicht') }) } });
  const z = (await anfrage(port, '/zustand')).nutz;
  assert.match(z.version, /^\d+\.\d+\.\d+\+unbekannt$/);
  assert.equal(z.version_info.quelle, 'keine VERSION-Datei');
});

test('/zustand zeigt gesundheit mit Ampel und Gründen; rot, wenn der Hub ablehnt', async () => {
  const ausgang = { ...gesund().ausgang, jetzt: undefined };
  const egress = {
    aktiv: true,
    meldestrecke: () => ({ stau: 3, gemeldet: 0, verworfen: 0 }),
    laufend: () => null,
    gesundheit: () => ({ ...ausgang, stau: 3, aeltestes_s: 600, abgelehnt: 4, abgelehnt_in_folge: 4, fehler: 4, fehler_in_folge: 4, letzter_fehler: { zeit: JETZT, text: 'Agenten-ID unbrauchbar: None', status: 400 } }),
    zugStand: () => ({ laeuft: false, seit_s: null, letzter_start: null, letztes_ende: null }),
  };
  const ingress = { cursor: '1-0', einreihen: async () => true, gesundheit: () => gesund().eingang };
  const { port } = await kanal({ ueberschreibe: { egress, ingress } });
  const z = (await anfrage(port, '/zustand')).nutz;
  assert.equal(z.gesundheit.ampel, 'rot');
  const codes_ = z.gesundheit.gruende.map((g) => g.code);
  assert.ok(codes_.includes('hub_lehnt_ab') && codes_.includes('ausgang_stumm'));
  assert.equal(z.gesundheit.ausgang.abgelehnt_in_folge, 4);
  assert.equal(z.gesundheit.eingang.aktiv, true);
  assert.equal(z.gesundheit.zug.laeuft, false);
  assert.equal(z.gesundheit.jetzt, JETZT);
  assert.equal(z.gesundheit.laufzeit_s, 0);
  assert.equal(z.meldestrecke.stau, 3, 'die bisherigen Schlüssel bleiben');
});

test('/zustand ohne Ausgang und Eingang: gesundheit ist grün und trägt null statt zu raten', async () => {
  const { port } = await kanal();
  const g = (await anfrage(port, '/zustand')).nutz.gesundheit;
  assert.equal(g.ampel, 'ok');
  assert.deepEqual(g.gruende, []);
  assert.equal(g.ausgang, null);
  assert.equal(g.eingang, null);
});

test('/zustand: eine Nachricht von Besitzer liegt seit Minuten, kein Zug: rot', async () => {
  const { port } = await kanal({ wartend: [{ klasse: 'max', angenommen: JETZT - 400_000 }] });
  const g = (await anfrage(port, '/zustand')).nutz.gesundheit;
  assert.equal(g.ampel, 'rot');
  assert.deepEqual(g.gruende.map((x) => x.code), ['max_liegt']);
  assert.equal(g.max_wartet_s, 400);
});
