// Prüft provider-kette.js, die Kettenkonfiguration und models.js: Vorgaben, Auswahl, Sperre, Spielmodus, Verdichtung je Fenster.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAssistantMessageEventStream, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { konfigurationLaden } from '../src/config.js';
import { kettenHuelle, modellListe, rheaModelle } from '../src/models.js';
import {
  KEIN_PROVIDER,
  ProviderKette,
  blockierendAb,
  fehlerArt,
  schaetzeTokens,
  verdichtungFuer,
  verdichtungsUeberschreibungen,
} from '../src/provider-kette.js';

const ERSATZ = { baseUrl: 'http://127.0.0.1:18460/v1/', apiKey: 'geheim-nicht-loggen', modelId: 'ersatzdenker' };
const laden = (pd = {}, env = {}) => konfigurationLaden({ pi_durable: pd }, env);
const mitKette = (extra = {}) => laden({ provider_kette: ['hausmodell', 'ersatzdenker'], provider: { ersatzdenker: ERSATZ }, ...extra });

function kette(cfg, { spiel = false, pruefen, t = { ms: 1_000_000 } } = {}) {
  const sp = { an: () => spiel.wert ?? spiel };
  const k = new ProviderKette(cfg, { spielmodus: typeof spiel === 'object' ? spiel : sp, jetzt: () => t.ms, pruefen, log: () => {} });
  return { k, t };
}

test('Vorgabe: ohne provider_kette nur Hausmodell, nichts ändert sich', () => {
  const cfg = laden();
  assert.deepEqual(cfg.pi_durable.provider_kette, ['hausmodell']);
  assert.equal(cfg.pi_durable.provider_sperre_s, 60);
  const hausmodell = cfg.pi_durable.provider.hausmodell;
  assert.equal(hausmodell.contextWindow, 262144);
  assert.equal(hausmodell.maxTokens, 16384);
  assert.equal(hausmodell.sperrtSpielmodus, true);
  assert.equal(new ProviderKette(cfg).aktiv, false);
  assert.deepEqual(modellListe(cfg).map((m) => m.id), ['hausmodell', 'hausmodell-max']);
  const modelle = rheaModelle(cfg);
  const m = modelle.getModel('hausmodell', 'hausmodell');
  assert.equal(m.contextWindow, 262144);
  assert.equal(m.maxTokens, 16384);
  assert.equal(modelle.getModel('ersatzdenker', 'ersatzdenker'), undefined);
});

test('Konfiguration: Ersatzdenker mit eigenen Grenzen, Schlüssel nicht in der öffentlichen Sicht', async () => {
  const cfg = mitKette();
  const p = cfg.pi_durable.provider.ersatzdenker;
  assert.equal(p.baseUrl, 'http://127.0.0.1:18460/v1');
  assert.equal(p.contextWindow, 65536);
  assert.equal(p.maxTokens, 4096);
  assert.equal(p.sperrtSpielmodus, false);
  assert.equal(p.apiKey, 'geheim-nicht-loggen');
  const { oeffentlicheSicht } = await import('../src/config.js');
  assert.ok(!JSON.stringify(oeffentlicheSicht(cfg)).includes('geheim-nicht-loggen'));
  assert.deepEqual(oeffentlicheSicht(cfg).kette.map((k) => k.name), ['hausmodell', 'ersatzdenker']);
  const modelle = rheaModelle(cfg);
  assert.equal(modelle.getModel('ersatzdenker', 'ersatzdenker').contextWindow, 65536);
  assert.equal(modelle.getModel('ersatzdenker', 'ersatzdenker').maxTokens, 4096);
  assert.equal(modelle.getModel('hausmodell', 'hausmodell').contextWindow, 262144);
  assert.deepEqual(modellListe(cfg).map((m) => m.id), ['hausmodell', 'hausmodell-max', 'ersatzdenker']);
});

test('Konfiguration: Kette ohne Beschreibung ist ein Fehler, Umgebung füllt den Ersatzdenker', () => {
  assert.throws(() => laden({ provider_kette: ['hausmodell', 'ersatzdenker'] }), /ersatzdenker/);
  const cfg = laden({ provider_kette: ['hausmodell', 'ersatzdenker'] }, { FYOS_ERSATZ_URL: 'http://x:1/v1', FYOS_ERSATZ_KEY: 'k' });
  assert.equal(cfg.pi_durable.provider.ersatzdenker.baseUrl, 'http://x:1/v1');
  assert.equal(cfg.pi_durable.provider.ersatzdenker.contextWindow, 65536);
});

test('Verdichtung je Provider: Hausmodell wie bisher, Ersatzdenker proportional mit Reserve für maxTokens', () => {
  const cfg = mitKette();
  const hausmodell = verdichtungFuer(cfg.pi_durable.provider.hausmodell);
  assert.deepEqual(hausmodell, { enabled: true, reserveTokens: 24000, keepRecentTokens: 32000, backgroundTokens: 118000 });
  assert.equal(blockierendAb(cfg.pi_durable.provider.hausmodell) - hausmodell.backgroundTokens, 120144); // ≈ 120k wie Entscheidung 590
  const e = cfg.pi_durable.provider.ersatzdenker;
  const v = verdichtungFuer(e);
  assert.ok(v.reserveTokens >= e.maxTokens + 2048);
  assert.equal(v.backgroundTokens, 29500);
  assert.equal(v.keepRecentTokens, 8000);
  const hintergrundAb = blockierendAb(e) - v.backgroundTokens;
  assert.ok(hintergrundAb > 25000 && hintergrundAb < 35000, `Hintergrund ab ${hintergrundAb}`);
  assert.ok(blockierendAb(e) < e.contextWindow - e.maxTokens);
  const ue = verdichtungsUeberschreibungen(cfg);
  assert.equal(ue['hausmodell/hausmodell-max'].backgroundTokens, 118000);
  assert.equal(ue['ersatzdenker/ersatzdenker'].backgroundTokens, 29500);
});

test('fehlerArt ordnet Verbindung, Zeit und 5xx ein, anderes nicht', () => {
  assert.equal(fehlerArt('Connection error.'), 'verbindung');
  assert.equal(fehlerArt('fetch failed: ECONNREFUSED 127.0.0.1:18421'), 'verbindung');
  assert.equal(fehlerArt('Request timed out.'), 'zeit');
  assert.equal(fehlerArt('503 Service Unavailable'), 'http5xx');
  assert.equal(fehlerArt('500 Internal server error'), 'http5xx');
  assert.equal(fehlerArt('400 context length exceeded'), null);
  assert.equal(fehlerArt('401 Unauthorized'), null);
  assert.equal(fehlerArt(''), null);
});

test('waehlen: erster brauchbarer Provider, Hausmodell steht vorn', async () => {
  const { k } = kette(mitKette());
  assert.equal((await k.waehlen()).name, 'hausmodell');
});

test('Ausfall sperrt für provider_sperre_s, danach beginnt die Wahl wieder vorn', async () => {
  const { k, t } = kette(mitKette({ provider_sperre_s: 30 }));
  const gemeldet = [];
  k.beiAusfall((n, art) => gemeldet.push([n, art]));
  k.ausfall('hausmodell', 'http5xx', '503');
  k.ausfall('hausmodell', 'http5xx', '503'); // zweiter Ausfall während der Sperre: kein zweiter Aufruf nötig, aber erlaubt
  assert.equal((await k.waehlen()).name, 'ersatzdenker');
  t.ms += 29_000;
  assert.equal((await k.waehlen()).name, 'ersatzdenker', 'noch gesperrt: kein Pingpong');
  t.ms += 2_000;
  assert.equal((await k.waehlen()).name, 'hausmodell', 'Sperre abgelaufen: wieder vorn');
  assert.equal(gemeldet[0][0], 'hausmodell');
});

test('Spielmodus: Hausmodell gesperrt, Ersatzdenker bleibt; beide nicht erreichbar gibt einen klaren Fehler', async () => {
  const spiel = { wert: true, an() { return this.wert; } };
  const { k } = kette(mitKette(), { spiel });
  assert.equal((await k.waehlen()).name, 'ersatzdenker');
  assert.equal(k.ersatzBereit(), true, 'die Marke hält den Ersatz nicht an');
  assert.equal(k.haeltSpielmodus(k.provider('ersatzdenker')), false);
  k.ausfall('ersatzdenker', 'verbindung', 'ECONNREFUSED');
  assert.equal(k.ersatzBereit(), false);
  await assert.rejects(k.waehlen(), (f) => {
    assert.equal(f.code, KEIN_PROVIDER);
    assert.match(f.message, /hausmodell: Spielmodus-Marke/);
    assert.match(f.message, /ersatzdenker: Verbindungsfehler/);
    return true;
  });
  spiel.wert = false;
  k._gesperrt.clear();
  assert.equal((await k.waehlen()).name, 'hausmodell');
});

test('Gesundheitsabruf: fällt der Ersatz durch, ist er gesperrt', async () => {
  const cfg = mitKette({ provider: { ersatzdenker: { ...ERSATZ, gesundheitUrl: 'http://127.0.0.1:18460/health' } } });
  let gesund = false;
  const { k } = kette(cfg, { spiel: { an: () => true }, pruefen: async () => gesund });
  await assert.rejects(k.waehlen(), /Gesundheitsabruf fehlgeschlagen/);
  gesund = true;
  k._gesperrt.clear();
  k._probe.clear();
  assert.equal((await k.waehlen()).name, 'ersatzdenker');
});

test('Hülle: nur Verbindung, Zeit und 5xx melden einen Ausfall', async () => {
  const cfg = mitKette();
  const { k } = kette(cfg);
  const fehler = [];
  k.beiAusfall((n, art) => fehler.push(art));
  const strom = (text) => () => {
    const s = createAssistantMessageEventStream();
    const m = fauxAssistantMessage([], { stopReason: 'error', errorMessage: text });
    s.push({ type: 'error', reason: 'error', error: m });
    s.end(m);
    return s;
  };
  for (const [text, erwartet] of [['400 context length exceeded', 0], ['503 busy', 1]]) {
    k._gesperrt.clear();
    fehler.length = 0;
    const h = kettenHuelle({ stream: strom(text), streamSimple: strom(text) }, k, 'hausmodell');
    await h.stream({}, {}, {}).result();
    await new Promise((r) => setImmediate(r));
    assert.equal(fehler.length, erwartet, text);
  }
});

test('Token-Schätzung wächst mit dem Inhalt', () => {
  assert.ok(schaetzeTokens([{ role: 'user', content: 'x'.repeat(33000) }]) > 10000);
  assert.ok(schaetzeTokens([]) >= 6000);
});
