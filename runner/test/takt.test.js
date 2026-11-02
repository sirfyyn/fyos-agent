/**
 * Tests des Taktgebers: Sollzeiten, genau einmal auch nach Neustart (Zustand im Dokument),
 * Tor, Fenster, Vorprüfung, Fehler im Hub. Echter Harness mit SQLite im Temp-Ordner, kein Netz.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fauxProvider } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { konfigurationLaden } from '../src/config.js';
import { Runner } from '../src/runner.js';
import { Taktgeber, minutenSchluessel, taktEreignis, taktSoll, wandZeit } from '../src/takt.js';
import { wachenLesen } from '../src/wachen-zustand.js';

const tmp = mkdtempSync(join(tmpdir(), 'takt-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const leererHub = {
  aufrufen: async () => ({ ok: true, result: {} }),
  melden: async () => ({ ok: true }),
  bereicheMelden: async () => ({ ok: true }),
  gesundheit: async () => ({ ok: true }),
  suchen: async () => [],
  schema: async () => ({}),
  eingangLesen: async (nach) => ({ eintraege: [], letzte: nach }),
};

function konfig(name, extra = {}) {
  return konfigurationLaden(
    {
      hub: 'http://hub.test',
      agent: 'persona',
      arbeitsbereiche: { standard: { pfad: tmp, titel: 'Test' } },
      pi_durable: {
        storage: join(tmp, name, 'fyos.sqlite'),
        security: { token: 'test-token-test-token-test-token-00' },
        proactive: { enabled: false },
        egress: { enabled: false },
        browser: { enabled: false },
        desktop: { enabled: false },
      },
      ...extra,
    },
    {},
  );
}

async function runnerStarten(cfg) {
  const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: [{ id: 'hausmodell' }, { id: 'hausmodell-max' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runner = new Runner(cfg, { models, hub: leererHub });
  await runner.start();
  return runner;
}

/** Ein Hub, dessen Antworten der Test je Werkzeug vorgibt (Wert oder Funktion). */
function stubHub(antworten) {
  const aufrufe = [];
  return {
    aufrufe,
    async aufrufen(werkzeug, argumente) {
      aufrufe.push({ werkzeug, argumente });
      const a = antworten[werkzeug];
      if (a === undefined) return { ok: false, fehler: `unbekannt: ${werkzeug}` };
      const wert = typeof a === 'function' ? await a(argumente) : a;
      return { ok: true, result: wert };
    },
  };
}

const berlin = (j, mo, t, h, mi, s = 0) => {
  // Lokale Berliner Zeit im Oktober 2026 als Epoch-Millisekunden; die Sommerzeit endet am 25.10. um 03:00.
  return Date.UTC(j, mo - 1, t, h - (t >= 25 ? 1 : 2), mi, s);
};

const MORGEN = TAKT_ENTRY('morgen');
function TAKT_ENTRY(id) {
  return {
    id,
    um: '07:30',
    fenster_min: 120,
    schleife: 'arbeit',
    art: 'melden',
    text: `Morgen-Takt (07:30): Test ${id}`,
  };
}

test('wandZeit und taktSoll: Sollzeiten in der Zone', () => {
  // 05:45 UTC = 07:45 in Berlin (Sommerzeit).
  const wand = wandZeit(Date.UTC(2026, 9, 24, 5, 45, 12), 'Europe/Berlin');
  assert.equal(minutenSchluessel(wand), '2026-10-24T07:45');

  assert.equal(minutenSchluessel(taktSoll({ um: '07:30' }, wand)), '2026-10-24T07:30');
  // Vor der Uhrzeit des Tages gilt der Vortag.
  assert.equal(minutenSchluessel(taktSoll({ um: '19:00' }, wand)), '2026-10-23T19:00');
  // Stündlich :15 von 8 bis 21: um 07:45 ist die letzte Sollzeit gestern 21:15.
  assert.equal(minutenSchluessel(taktSoll({ stuendlich: 15, von: 8, bis: 21 }, wand)), '2026-10-23T21:15');
  const mittag = wandZeit(Date.UTC(2026, 9, 24, 10, 20), 'Europe/Berlin'); // 12:20
  assert.equal(minutenSchluessel(taktSoll({ stuendlich: 15, von: 8, bis: 21 }, mittag)), '2026-10-24T12:15');
  // Alle 15 Minuten: auf das Raster abgerundet.
  assert.equal(minutenSchluessel(taktSoll({ alle_min: 15 }, wand)), '2026-10-24T07:45');
  assert.equal(minutenSchluessel(taktSoll({ alle_min: 15 }, mittag)), '2026-10-24T12:15');
  // Ungültiges ergibt null statt eines Absturzes.
  assert.equal(taktSoll({ um: 'abends' }, wand), null);
  assert.equal(taktSoll({}, wand), null);
});

test('taktEreignis: Wortlaut der Id, Quelle, Klasse und Bezug wie im RPC-Runner', () => {
  const soll = wandZeit(Date.UTC(2026, 9, 24, 5, 30), 'Europe/Berlin');
  const e = taktEreignis({ id: 'liegt', text: 'Stündliche Prüfung' }, soll);
  assert.deepEqual(e, {
    id: 'zeitplan:liegt:2026-10-24T07:30',
    text: 'Stündliche Prüfung',
    quelle: 'zeitplan',
    klasse: 'hintergrund',
    bezug: 'takt-liegt-2026-10-24',
  });
});

test('Takt feuert zur Sollzeit genau einmal, auch nach Neustart', async () => {
  const cfg = konfig('einmal');
  let runner = await runnerStarten(cfg);
  const hub = stubHub({ 'schleifen.darf': { darf: true, warum: 'offen' } });
  const eingereiht = [];
  let t = berlin(2026, 10, 24, 7, 29); // eine Minute vor dem Soll
  const bauen = () =>
    new Taktgeber({
      cfg: { takt: { zone: 'Europe/Berlin', eintraege: [MORGEN] } },
      hub,
      harness: runner.harness,
      einreihen: async (e) => void eingereiht.push(e),
      log: { info() {}, warn() {} },
      jetzt: () => t,
    });
  try {
    let takt = bauen();
    // 07:29: letzter Soll ist gestern 07:30, das Fenster (2 h) ist lange vorbei -> verfallen, nichts eingereiht.
    assert.deepEqual(await takt.runde(), []);
    assert.equal(eingereiht.length, 0);

    t = berlin(2026, 10, 24, 7, 31);
    assert.deepEqual(await takt.runde(), ['zeitplan:morgen:2026-10-24T07:30']);
    assert.equal(eingereiht.length, 1);
    assert.equal(eingereiht[0].bezug, 'takt-morgen-2026-10-24');
    assert.equal(eingereiht[0].klasse, 'hintergrund');
    assert.equal(eingereiht[0].quelle, 'zeitplan');

    // Gleiche Minute, spätere Runde: nichts mehr.
    t = berlin(2026, 10, 24, 8, 0);
    assert.deepEqual(await takt.runde(), []);

    // Neustart des ganzen Runners: derselbe Takt, frische Instanz, Zustand aus dem Dokument.
    await runner.close().catch(() => {});
    runner = await runnerStarten(cfg);
    takt = bauen();
    t = berlin(2026, 10, 24, 8, 30);
    assert.deepEqual(await takt.runde(), []);
    assert.equal(eingereiht.length, 1, 'nach dem Neustart nicht noch einmal');

    const d = await wachenLesen(runner.harness);
    assert.equal(d.takt.morgen.erledigt, '2026-10-24T07:30');
    assert.equal(d.takt.morgen.wie, 'ausgelöst');

    // Am nächsten Tag feuert er wieder, mit neuer Id.
    t = berlin(2026, 10, 25, 7, 40);
    assert.deepEqual(await takt.runde(), ['zeitplan:morgen:2026-10-25T07:30']);
    assert.equal(eingereiht.length, 2);
  } finally {
    await runner.close().catch(() => {});
  }
});

test('geschlossenes Tor: Nachfragen höchstens alle fragen_alle_s, Fenster vorbei verfällt still', async () => {
  const runner = await runnerStarten(konfig('tor'));
  let offen = false;
  const hub = stubHub({ 'schleifen.darf': () => ({ darf: offen, warum: offen ? 'frei' : 'Spielmodus' }) });
  const eingereiht = [];
  let t = berlin(2026, 10, 24, 7, 31);
  const takt = new Taktgeber({
    cfg: { takt: { zone: 'Europe/Berlin', fragen_alle_s: 120, eintraege: [MORGEN] } },
    hub,
    harness: runner.harness,
    einreihen: async (e) => void eingereiht.push(e),
    log: { info() {}, warn() {} },
    jetzt: () => t,
  });
  try {
    assert.deepEqual(await takt.runde(), []);
    assert.equal(hub.aufrufe.length, 1);
    t += 60_000; // innerhalb von fragen_alle_s: keine neue Anfrage
    assert.deepEqual(await takt.runde(), []);
    assert.equal(hub.aufrufe.length, 1);
    assert.equal(takt.zustand().eintraege[0].warum, 'Spielmodus');

    t += 120_000; // jetzt darf er wieder fragen
    offen = true;
    assert.deepEqual(await takt.runde(), ['zeitplan:morgen:2026-10-24T07:30']);
    assert.equal(eingereiht.length, 1);

    // Anderer Tag: Tor zu, bis das Fenster (2 h) vorbei ist -> verfallen, nie ausgelöst.
    offen = false;
    t = berlin(2026, 10, 25, 7, 40);
    assert.deepEqual(await takt.runde(), []);
    t = berlin(2026, 10, 25, 9, 31);
    assert.deepEqual(await takt.runde(), []);
    offen = true;
    t = berlin(2026, 10, 25, 9, 40);
    assert.deepEqual(await takt.runde(), []);
    assert.equal(eingereiht.length, 1);
    assert.equal(takt.zustand().eintraege[0].wie, 'verfallen');
  } finally {
    await runner.close().catch(() => {});
  }
});

test('Vorprüfung: nichts zu tun verbraucht den Takt, Rückstand weckt', async () => {
  const runner = await runnerStarten(konfig('vor'));
  let rueckstand = 0;
  const hub = stubHub({
    'schleifen.darf': { darf: true },
    'denken.liegt': () => ({ rueckstand_persona: rueckstand }),
  });
  const liegt = {
    id: 'liegt',
    stuendlich: 15,
    von: 8,
    bis: 21,
    fenster_min: 30,
    schleife: 'arbeit',
    art: 'schreiben',
    vorpruefung: { werkzeug: 'denken.liegt', feld: 'rueckstand_persona' },
    text: 'Stündliche Prüfung',
  };
  const eingereiht = [];
  let t = berlin(2026, 10, 24, 12, 20);
  const takt = new Taktgeber({
    cfg: { takt: { zone: 'Europe/Berlin', eintraege: [liegt] } },
    hub,
    harness: runner.harness,
    einreihen: async (e) => void eingereiht.push(e),
    log: { info() {}, warn() {} },
    jetzt: () => t,
  });
  try {
    assert.deepEqual(await takt.runde(), []);
    assert.equal(takt.zustand().eintraege[0].wie, 'nichts zu tun');
    t = berlin(2026, 10, 24, 12, 25); // gleiche Sollstunde, schon erledigt
    rueckstand = 5;
    assert.deepEqual(await takt.runde(), []);

    t = berlin(2026, 10, 24, 13, 16);
    assert.deepEqual(await takt.runde(), ['zeitplan:liegt:2026-10-24T13:15']);
    assert.equal(eingereiht[0].bezug, 'takt-liegt-2026-10-24');
  } finally {
    await runner.close().catch(() => {});
  }
});

test('Fehler im Hub oder beim Einreihen beenden den Takt nicht', async () => {
  const runner = await runnerStarten(konfig('fehler'));
  let hubKaputt = true;
  let einreihenKaputt = false;
  const hub = {
    async aufrufen() {
      if (hubKaputt) throw new Error('Hub weg');
      return { ok: true, result: { darf: true } };
    },
  };
  const eingereiht = [];
  let t = berlin(2026, 10, 24, 7, 31);
  const takt = new Taktgeber({
    cfg: { takt: { zone: 'Europe/Berlin', pruefen_s: 0.02, fragen_alle_s: 0, eintraege: [MORGEN] } },
    hub,
    harness: runner.harness,
    einreihen: async (e) => {
      if (einreihenKaputt) throw new Error('Warteschlange kaputt');
      eingereiht.push(e);
    },
    log: { info() {}, warn() {} },
    jetzt: () => t,
  });
  try {
    // Hub weg: Tor gilt als zu, die Runde wirft nicht.
    assert.deepEqual(await takt.runde(), []);
    assert.match(takt.zustand().eintraege[0].warum, /nicht prüfbar: Hub weg/);

    // Einreihen scheitert: die Runde wirft nicht, der Takt bleibt offen.
    hubKaputt = false;
    einreihenKaputt = true;
    assert.deepEqual(await takt.runde(), []);
    assert.equal(eingereiht.length, 0);
    assert.notEqual(takt.zustand().eintraege[0].wie, 'ausgelöst');

    // Die Schleife läuft weiter und holt es nach, sobald es wieder geht.
    einreihenKaputt = false;
    assert.equal(takt.start(), true);
    const ende = Date.now() + 5000;
    while (!eingereiht.length && Date.now() < ende) await new Promise((r) => setTimeout(r, 25));
    await takt.stop();
    assert.equal(eingereiht.length, 1);
    assert.equal(eingereiht[0].id, 'zeitplan:morgen:2026-10-24T07:30');
  } finally {
    await runner.close().catch(() => {});
  }
});

test('Nachrichtenpult: Werkzeug-Takt ruft nachrichten.lauf statt den Agenten zu wecken', async () => {
  const runner = await runnerStarten(konfig('pult'));
  const hub = stubHub({
    'schleifen.darf': { darf: true },
    'nachrichten.lauf': { satz: '3 Karten' },
  });
  const eingereiht = [];
  const t = berlin(2026, 10, 24, 7, 46); // Raster :45
  const takt = new Taktgeber({
    cfg: {
      takt: { zone: 'Europe/Berlin', eintraege: [] },
      nachrichten: { an: true, alle_min: 5, frist_s: 30 }, // unter 15 wird auf 15 gehoben
    },
    hub,
    harness: runner.harness,
    einreihen: async (e) => void eingereiht.push(e),
    log: { info() {}, warn() {} },
    jetzt: () => t,
    imHintergrund: false,
  });
  try {
    assert.deepEqual(await takt.runde(), ['werkzeug:nachrichten:2026-10-24T07:45']);
    assert.equal(eingereiht.length, 0);
    assert.ok(hub.aufrufe.some((a) => a.werkzeug === 'nachrichten.lauf'));
    const lauf = takt.zustand().eintraege[0].lauf;
    assert.equal(lauf.ok, true);
    assert.equal(lauf.satz, '3 Karten');
    assert.equal(takt.zustand().eintraege[0].wann, 'alle 15 min');
  } finally {
    await runner.close().catch(() => {});
  }
});

test('ausloesen: Steuerkanal geht weiter durch das Tor; unbekannter Takt meldet Fehler', async () => {
  const runner = await runnerStarten(konfig('ausloesen'));
  let offen = false;
  const hub = stubHub({ 'schleifen.darf': () => ({ darf: offen, warum: 'zu' }) });
  const eingereiht = [];
  const takt = new Taktgeber({
    cfg: { takt: { zone: 'Europe/Berlin', eintraege: [MORGEN] } },
    hub,
    harness: runner.harness,
    einreihen: async (e) => void eingereiht.push(e),
    log: { info() {}, warn() {} },
    jetzt: () => berlin(2026, 10, 24, 15, 3, 40),
  });
  try {
    assert.equal((await takt.ausloesen('gibtsnicht')).ok, false);
    const zu = await takt.ausloesen('morgen');
    assert.equal(zu.ok, false);
    assert.equal(zu.warum, 'zu');
    offen = true;
    const auf = await takt.ausloesen('morgen');
    assert.equal(auf.ok, true);
    assert.deepEqual(auf.ausgeloest, ['zeitplan:morgen:2026-10-24T15:03']);
    assert.equal(eingereiht.length, 1);
  } finally {
    await runner.close().catch(() => {});
  }
});

test('Standardeinträge und an/aus nach der Konfiguration', () => {
  const dummy = { hub: {}, harness: {}, einreihen: async () => {} };
  const standard = new Taktgeber({ cfg: {}, ...dummy });
  assert.equal(standard.an, true);
  assert.deepEqual(
    standard.zustand().eintraege.map((e) => e.id),
    ['morgen', 'abend', 'liegt', 'nacht', 'nachtwerkstatt'],
  );
  assert.equal(standard.zustand().eintraege[2].wann, 'stündlich :15');
  assert.equal(new Taktgeber({ cfg: { takt: { an: false } }, ...dummy }).an, false);
  assert.equal(new Taktgeber({ cfg: { takt: { an: false } }, ...dummy }).start(), false);
});

test('Nachtwerkstatt-Takt: startet die Aufgabe einmal, durch das Tor, ohne Agentenzug; der Wortlaut der anderen Takte bleibt', async () => {
  const cfg = konfig('nachtwerkstatt');
  const runner = await runnerStarten(cfg);
  const hub = stubHub({ 'schleifen.darf': { darf: true, warum: 'offen' } });
  const eingereiht = [];
  const gestartet = [];
  const t = berlin(2026, 10, 24, 23, 36);
  const takt = new Taktgeber({
    cfg: {},
    hub,
    harness: runner.harness,
    einreihen: async (e) => void eingereiht.push(e),
    nachtwerkstatt: async (opt) => {
      gestartet.push(opt);
      return { gestartet: true, nacht: '2026-10-24' };
    },
    log: { info() {}, warn() {} },
    jetzt: () => t,
  });
  try {
    const ausgeloest = await takt.runde();
    assert.ok(ausgeloest.includes('nachtwerkstatt:2026-10-24'));
    assert.deepEqual(gestartet, [{ quelle: 'takt' }]);
    // Der Takt `nacht` weckt den Agenten wie bisher (Bezug und Id unverändert), die Werkstatt nicht.
    assert.ok(eingereiht.some((e) => e.id === 'zeitplan:nacht:2026-10-24T23:30' && e.bezug === 'takt-nacht-2026-10-24'));
    assert.ok(!eingereiht.some((e) => e.id.includes('nachtwerkstatt')));
    assert.match(eingereiht.find((e) => e.id.includes(':nacht:')).text, /^Nachtfenster \(22–7\): Prüfe denken\.darf und denken\.nachtbudget\./);
    await takt.runde();
    assert.equal(gestartet.length, 1, 'derselbe Sollzeitpunkt startet nichts zweimal');
    const eintrag = takt.zustand().eintraege.find((e) => e.id === 'nachtwerkstatt');
    assert.equal(eintrag.wie, 'ausgelöst');
  } finally {
    await runner.close().catch(() => {});
  }
});

// ---------------------------------------------------------------------------------------- eigene Eintraege und die Standardliste

test('eigene Eintraege ersetzen die Standardliste: fehlende Standardeintraege stehen im Log und im Zustand', () => {
  const warnungen = [];
  const takt = new Taktgeber({
    cfg: { takt: { eintraege: [{ id: 'morgen', um: '07:30', schleife: 'arbeit' }] } },
    log: { info() {}, warn: (m) => warnungen.push(m) },
  });
  assert.deepEqual(takt.eintraege.map((e) => e.id), ['morgen']);
  assert.ok(takt.fehlendeStandard.includes('nachtwerkstatt'), 'die Nachtwerkstatt fehlt');
  assert.deepEqual(takt.zustand().fehlende_standard, takt.fehlendeStandard);
  assert.equal(warnungen.length, 1);
  assert.match(warnungen[0], /nachtwerkstatt/);
  assert.match(warnungen[0], /mit_standard/);
});

test('takt.mit_standard holt fehlende Standardeintraege dazu, ohne eigene zu doppeln oder zu ueberschreiben', () => {
  const warnungen = [];
  const eigen = { id: 'morgen', um: '06:00', schleife: 'arbeit', text: 'mein Morgen' };
  const takt = new Taktgeber({
    cfg: { takt: { mit_standard: true, eintraege: [eigen] } },
    log: { info() {}, warn: (m) => warnungen.push(m) },
  });
  const ids = takt.eintraege.map((e) => e.id);
  assert.equal(ids.filter((i) => i === 'morgen').length, 1, 'morgen nicht doppelt');
  assert.equal(takt.eintraege.find((e) => e.id === 'morgen').um, '06:00', 'der eigene Eintrag gewinnt');
  assert.ok(ids.includes('nachtwerkstatt'));
  assert.equal(takt.fehlendeStandard.length, 0);
  assert.equal(warnungen.length, 0);
  assert.equal(takt.zustand().fehlende_standard, undefined);
});

test('ohne eigene Eintraege gilt die Standardliste, ohne Warnung', () => {
  const warnungen = [];
  const takt = new Taktgeber({ cfg: {}, log: { info() {}, warn: (m) => warnungen.push(m) } });
  assert.ok(takt.eintraege.some((e) => e.id === 'nachtwerkstatt'));
  assert.equal(warnungen.length, 0);
});

// 31.10.2026: Beim Umzug vom RPC-Runner fehlte `nachrichten` in agent-runner.json; der Nachrichtenpult lief seit dem
// 21.10. nicht mehr und die Zentrale zeigte elf Tage alte Karten. Die Repo-Konfiguration muss den Takt tragen.
// Die Repo-Konfiguration gibt es nur im Monorepo (im öffentlichen fyos-agent fehlt sie).
const REPO_KONFIG = { skip: !existsSync(new URL('../../agent-runner.json', import.meta.url)) && 'nur im Monorepo' };
test('Repo-Konfiguration trägt den Nachrichten-Takt', REPO_KONFIG, async () => {
  const { readFileSync } = await import('node:fs');
  const cfg = JSON.parse(readFileSync(new URL('../../agent-runner.json', import.meta.url), 'utf8'));
  assert.equal(cfg.nachrichten?.an, true);
  const takt = new Taktgeber({ cfg, log: { info() {}, warn() {} } });
  assert.ok(takt.eintraege.some((e) => e.id === 'nachrichten' && e.werkzeug === 'nachrichten.lauf'));
});

// 01.11.2026 (Besitzer Nr. 710): das Lebensbuch schreibt jede Nacht ein Kapitel; die Standardtakte bleiben (mit_standard).
test('Repo-Konfiguration trägt den Kapitel-Takt und behält die Standardtakte', REPO_KONFIG, async () => {
  const { readFileSync } = await import('node:fs');
  const cfg = JSON.parse(readFileSync(new URL('../../agent-runner.json', import.meta.url), 'utf8'));
  const takt = new Taktgeber({ cfg, log: { info() {}, warn() {} } });
  const ids = takt.eintraege.map((e) => e.id);
  assert.ok(takt.eintraege.some((e) => e.id === 'kapitel' && e.werkzeug === 'kapitel.schreiben' && e.um === '23:50'));
  assert.ok(takt.eintraege.some((e) => e.id === 'doku' && e.um === '02:30' && !e.werkzeug), 'Doku-Pflege als Agentenzug');
  for (const id of ['morgen', 'abend', 'nacht', 'nachtwerkstatt', 'nachrichten']) assert.ok(ids.includes(id), id);
  assert.deepEqual(takt.fehlendeStandard, []);
});
