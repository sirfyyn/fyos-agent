/**
 * Die Modellkette im echten Runner (pi-durable + SQLite) mit künstlichen Stromfunktionen: Rückfall bei Verbindungsfehler,
 * Zeitüberschreitung und 503, kein Rückfall bei Erfolg, Spielmodus-Marke, Ersatz nicht erreichbar, Verdichtung vor dem Wechsel
 * auf den kleineren Provider. Es wird nichts Echtes angesprochen.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { konfigurationLaden } from '../src/config.js';
import { Wartend } from '../src/documents.js';
import { Ingress } from '../src/ingress.js';
import { KEIN_PROVIDER } from '../src/provider-kette.js';
import { Runner } from '../src/runner.js';

const CTX = BACKGROUND_CONTEXT;
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
async function bis(fn, { ms = 40000, was = 'Bedingung' } = {}) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    const wert = await fn();
    if (wert) return wert;
    await warte(100);
  }
  throw new Error(`Zeit abgelaufen: ${was}`);
}

const tmp = mkdtempSync(join(tmpdir(), 'pidurable-kette-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const hub = () => ({
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

/** Künstliche Stromfunktionen: `verhalten[provider](context, nr)` → { fehler } oder { text }. */
function basis(verhalten, aufrufe) {
  const bauen = (einfach) => (model, context) => {
    const s = createAssistantMessageEventStream();
    const nr = aufrufe.filter((a) => a.provider === model.provider).length + 1;
    aufrufe.push({ provider: model.provider, einfach, fenster: model.contextWindow });
    queueMicrotask(() => {
      const v = verhalten[model.provider](context, nr);
      if (v.fehler) {
        const m = fauxAssistantMessage([], { stopReason: 'error', errorMessage: v.fehler });
        s.push({ type: 'error', reason: 'error', error: m });
        s.end(m);
      } else {
        const m = fauxAssistantMessage(v.text);
        s.push({ type: 'done', reason: 'stop', message: m });
        s.end(m);
      }
    });
    return s;
  };
  return { stream: bauen(false), streamSimple: bauen(true) };
}

function baue(name, extra = {}, pdExtra = {}) {
  const dir = join(tmp, name);
  const marke = join(tmp, `${name}-spielmodus.kid`);
  const cfg = konfigurationLaden(
    {
      hub: 'http://hub.test',
      arbeitsbereiche: { standard: { pfad: tmp, titel: 'Test' } },
      spielmodus: [marke],
      ...extra,
      pi_durable: {
        storage: join(dir, 'fyos.sqlite'),
        security: { token: 'test-token-test-token-test-token-00' },
        proactive: { enabled: true, pollSeconds: 3 },
        egress: { enabled: false },
        browser: { enabled: false },
        desktop: { enabled: false },
        provider_kette: ['hausmodell', 'ersatzdenker'],
        provider: { ersatzdenker: { baseUrl: 'http://127.0.0.1:18460/v1', modelId: 'ersatzdenker' } },
        provider_sperre_s: 60,
        ...pdExtra,
      },
    },
    {},
  );
  return { cfg, marke };
}

const antworten = (ansicht) =>
  ansicht.entries
    .flatMap((e) => e.model ?? [])
    .filter((m) => m?.role === 'assistant')
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b?.type === 'text')
    .map((b) => b.text);

async function start(cfg, verhalten) {
  const aufrufe = [];
  const runner = new Runner(cfg, { basis: basis(verhalten, aufrufe), hub: hub() });
  runner.kette.log = () => {};
  await runner.start();
  const root = (await runner.gespraeche()).find((g) => g.art === 'root');
  const modell = async () => (await runner.gespraech(root.id)).agent.model;
  return { runner, root, aufrufe, modell };
}

for (const [fall, fehlertext] of [
  ['Verbindungsfehler', 'Connection error.'],
  ['Zeitüberschreitung', 'Request timed out.'],
  ['HTTP 503', '503 Service Unavailable'],
]) {
  test(`Rückfall bei ${fall}: der Wiederholungsversuch läuft beim Ersatzdenker, danach bleibt es dort`, async () => {
    const { cfg } = baue(`rueckfall-${fall.replace(/\W/g, '')}`);
    const { runner, root, aufrufe, modell } = await start(cfg, {
      hausmodell: () => ({ fehler: fehlertext }),
      ersatzdenker: () => ({ text: 'ersatz-ok' }),
    });
    try {
      assert.equal((await modell()).provider, 'hausmodell');
      await runner.sende(root.id, 'Hallo');
      await bis(async () => antworten(await runner.ansicht(root.id)).includes('ersatz-ok'), { was: 'Antwort vom Ersatz' });
      assert.deepEqual(aufrufe.map((a) => a.provider), ['hausmodell', 'ersatzdenker']);
      assert.equal((await modell()).provider, 'ersatzdenker');
      assert.equal(aufrufe[1].fenster, 65536, 'der Ersatz läuft mit seinem eigenen Fenster');
      // Zweiter Lauf innerhalb der Sperrfrist: Hausmodell wird gar nicht erst versucht (kein Pingpong).
      await runner.sende(root.id, 'Noch eins');
      await bis(() => aufrufe.length === 3, { was: 'zweiter Zug' });
      assert.equal(aufrufe[2].provider, 'ersatzdenker');
      assert.deepEqual(runner.kette.zustand().map((z) => [z.name, z.gesperrtBis !== null]), [['hausmodell', true], ['ersatzdenker', false]]);
    } finally {
      await runner.close().catch(() => {});
    }
  });
}

test('kein Rückfall bei normalem Erfolg und bei einem anderen Fehler', async () => {
  const { cfg } = baue('erfolg');
  const { runner, root, aufrufe, modell } = await start(cfg, {
    hausmodell: (_c, nr) => (nr === 1 ? { text: 'hausmodell-ok' } : { fehler: '401 Unauthorized' }),
    ersatzdenker: () => ({ text: 'ersatz-ok' }),
  });
  try {
    await runner.sende(root.id, 'Hallo');
    await bis(async () => antworten(await runner.ansicht(root.id)).includes('hausmodell-ok'), { was: 'Antwort von Hausmodell' });
    assert.deepEqual(aufrufe.map((a) => a.provider), ['hausmodell']);
    assert.equal((await modell()).provider, 'hausmodell');
    assert.equal(runner.kette.zustand()[0].gesperrtBis, null);
    await runner.sende(root.id, 'Zweite');
    await bis(() => aufrufe.length >= 2, { was: 'zweiter Aufruf' });
    await warte(500);
    assert.ok(aufrufe.every((a) => a.provider === 'hausmodell'), 'ein 401 ist kein Ausfall');
    assert.equal(runner.kette.zustand()[0].gesperrtBis, null);
  } finally {
    await runner.close().catch(() => {});
  }
});

test('Spielmodus: Hausmodell steht, der Ersatzdenker bearbeitet den Eingang; die Marke hält ihn nicht an', async () => {
  const { cfg, marke } = baue('spiel');
  writeFileSync(marke, '');
  const { runner, root, aufrufe, modell } = await start(cfg, {
    hausmodell: () => ({ text: 'hausmodell-ok' }),
    ersatzdenker: () => ({ text: 'ersatz-ok' }),
  });
  const h = hub();
  let geliefert = false;
  h.eingangLesen = async (nach) => {
    if (!geliefert) {
      geliefert = true;
      return { eintraege: [{ id: '1-0', text: 'Wassermelder', klasse: 'max', quelle: 'web' }], letzte: '1-0' };
    }
    await warte(150);
    return { eintraege: [], letzte: nach };
  };
  const ingress = new Ingress({ cfg, runner, hub: h, spielmodus: runner.spielmodusEinlass, tor: { offen: true } });
  await ingress.start();
  try {
    assert.equal(runner.spielmodus.an(), true);
    assert.equal(runner.spielmodusEinlass.an(), false, 'mit bereitem Ersatz hält die Marke den Eingang nicht an');
    await bis(async () => antworten(await runner.ansicht(root.id)).includes('ersatz-ok'), { was: 'Antwort vom Ersatz' });
    assert.deepEqual(aufrufe.map((a) => a.provider), ['ersatzdenker']);
    assert.equal((await modell()).provider, 'ersatzdenker');
    // Marke weg: der nächste Zug beginnt wieder vorn.
    rmSync(marke);
    await runner.bahnEinstellen(root.id, 'max');
    assert.deepEqual(await modell(), { provider: 'hausmodell', modelId: 'hausmodell-max' });
  } finally {
    await ingress.stop();
    await runner.close().catch(() => {});
  }
});

test('Spielmodus und Ersatz nicht erreichbar: klarer Fehler, Eintrag bleibt liegen, keine Endlosschleife', async () => {
  const { cfg, marke } = baue('beide-weg');
  writeFileSync(marke, '');
  const { runner, root, aufrufe } = await start(cfg, {
    hausmodell: () => ({ text: 'hausmodell-ok' }),
    ersatzdenker: () => ({ fehler: 'fetch failed: ECONNREFUSED' }),
  });
  runner.kette.ausfall('ersatzdenker', 'verbindung', 'ECONNREFUSED');
  try {
    await assert.rejects(runner.bahnEinstellen(root.id, 'max'), (f) => {
      assert.equal(f.code, KEIN_PROVIDER);
      assert.match(f.message, /Kein Modell erreichbar/);
      return true;
    });
    await assert.rejects(runner.sende(root.id, 'Hallo'), /Kein Modell erreichbar/);
    // Der Eingang selbst: Hausmodell hält die Marke, der Ersatz ist gesperrt → der Eingang wartet (Spielmodus), nichts geht an ein Modell.
    const h = hub();
    let geliefert = false;
    h.eingangLesen = async (nach) => {
      if (!geliefert) {
        geliefert = true;
        return { eintraege: [{ id: '1-0', text: 'Hallo', klasse: 'max', quelle: 'web' }], letzte: '1-0' };
      }
      await warte(150);
      return { eintraege: [], letzte: nach };
    };
    const fehler = [];
    const ingress = new Ingress({ cfg, runner, hub: h, spielmodus: runner.spielmodusEinlass, tor: { offen: true }, onFehler: (f) => fehler.push(f.message) });
    await ingress.start();
    await bis(async () => (await runner.harness.snapshot(Wartend, CTX)).eintraege.length === 1, { was: 'Eintrag angenommen' });
    await warte(2500);
    assert.equal((await runner.harness.snapshot(Wartend, CTX)).eintraege.length, 1);
    assert.equal(aufrufe.length, 0);
    await ingress.stop();
  } finally {
    await runner.close().catch(() => {});
  }
});

test('Ersatz fällt aus, obwohl die Marke nur Hausmodell hält: Ausgeber meldet KEIN_PROVIDER einmal und wartet', async () => {
  const { cfg, marke } = baue('keinprovider');
  writeFileSync(marke, '');
  const { runner, root, aufrufe } = await start(cfg, {
    hausmodell: () => ({ text: 'hausmodell-ok' }),
    ersatzdenker: () => ({ text: 'ersatz-ok' }),
  });
  // Ersatz scheinbar bereit (nicht gesperrt), aber der Gesundheitsabruf scheitert beim Wählen.
  runner.kette.liste.find((p) => p.name === 'ersatzdenker').gesundheitUrl = 'http://127.0.0.1:1/health';
  runner.kette._pruefen = async () => false;
  const h = hub();
  let geliefert = false;
  h.eingangLesen = async (nach) => {
    if (!geliefert) {
      geliefert = true;
      return { eintraege: [{ id: '1-0', text: 'Hallo', klasse: 'max', quelle: 'web' }], letzte: '1-0' };
    }
    await warte(150);
    return { eintraege: [], letzte: nach };
  };
  const fehler = [];
  const ingress = new Ingress({ cfg, runner, hub: h, spielmodus: runner.spielmodusEinlass, tor: { offen: true }, onFehler: (f) => fehler.push(f.message) });
  await ingress.start();
  try {
    await bis(() => fehler.some((m) => /Kein Modell erreichbar/.test(m)), { was: 'klare Fehlermeldung' });
    await warte(1500);
    assert.equal(fehler.filter((m) => /Kein Modell erreichbar/.test(m)).length, 1, 'einmal gemeldet, nicht im Takt');
    assert.equal((await runner.harness.snapshot(Wartend, CTX)).eintraege.length, 1, 'nichts verloren');
    assert.equal(aufrufe.length, 0);
    assert.ok(root.id);
  } finally {
    await ingress.stop();
    await runner.close().catch(() => {});
  }
});

test('Wechsel auf den kleineren Provider verdichtet zuerst, wenn der Verlauf nicht passt', async () => {
  const { cfg, marke } = baue('verdichten');
  const { runner, root, aufrufe, modell } = await start(cfg, {
    hausmodell: (_c, nr) => ({ text: nr > 99 ? 'x' : `hausmodell-${nr}` }),
    ersatzdenker: () => ({ text: 'ersatz-ok' }),
  });
  try {
    // Genug Verlauf, dass er (≈ 80k Token) nicht in die 65536 des Ersatzes passt, aber weit unter Rheas Schwelle liegt.
    for (let i = 1; i <= 7; i++) {
      await runner.sende(root.id, `${'wort '.repeat(8000)}#${i}`);
      await bis(async () => antworten(await runner.ansicht(root.id)).includes(`hausmodell-${i}`), { was: `Antwort ${i}` });
    }
    const vorher = (await runner.ansicht(root.id)).messages;
    const rheaVorher = aufrufe.filter((a) => a.provider === 'hausmodell').length;
    writeFileSync(marke, ''); // Spielmodus beginnt, Hausmodell lebt noch
    await runner.bahnEinstellen(root.id, 'max');
    assert.equal((await modell()).provider, 'ersatzdenker');
    const einfach = aufrufe.filter((a) => a.provider === 'hausmodell' && a.einfach).length;
    assert.ok(einfach >= 1, 'die Zusammenfassung lief noch auf Hausmodell');
    assert.ok(aufrufe.filter((a) => a.provider === 'hausmodell').length > rheaVorher);
    assert.ok(aufrufe.every((a) => a.provider !== 'ersatzdenker'), 'der Ersatz hat den langen Verlauf nie gesehen');
    assert.ok((await runner.ansicht(root.id)).messages <= vorher, 'der Verlauf ist kürzer geworden');
  } finally {
    await runner.close().catch(() => {});
  }
});
