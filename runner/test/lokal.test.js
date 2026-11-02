/**
 * lokal.test.js — der lokale Modus (FYOS_RUNNER_LOKAL=1, Vertrag des lokalen Runners der Hülle).
 *
 * Geprüft: Vorgaben (kein Hub, keine Knoten, kein Browser/Desktop/Eingang), Bindung nur an Loopback und nur mit Token,
 * `POST /api/ordner/erlauben` (nur lokal, sonst 404; dieselben Prüfungen wie die Ordnerwahl), Werkzeuge (nur Dateien/Befehle aus
 * dem Kern, Freigabe, Web; kein Hub, keine Knoten) und dass sich ohne den Schalter nichts ändert. Der echte Runner läuft mit einem Faux-Modell.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fauxProvider } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { bindungPruefen, konfigurationLaden } from '../src/config.js';
import { Hub } from '../src/hub.js';
import { modellListe } from '../src/models.js';
import { OrdnerFehler, wurzelHinzufuegen } from '../src/ordner.js';
import { baueRegistry } from '../src/registry.js';
import { Runner } from '../src/runner.js';
import { erstelleServer } from '../src/server.js';

const TOKEN = 'test-token-test-token-test-token-00';
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lokal-test-')));
after(() => rmSync(tmp, { recursive: true, force: true }));

const eins = join(tmp, 'eins');
const zwei = join(tmp, 'zwei');
const arbeit = join(tmp, 'arbeit');
const nichtOrdner = join(tmp, 'datei.txt');

before(() => {
  for (const d of [eins, join(eins, 'unter'), zwei, arbeit]) mkdirSync(d, { recursive: true });
  writeFileSync(nichtOrdner, 'x');
  symlinkSync(zwei, join(tmp, 'link-zu-zwei'));
});

const lokalConfig = (name, extra = {}) =>
  konfigurationLaden(
    {
      arbeitsbereiche: { standard: { pfad: arbeit, titel: 'Test' } },
      pi_durable: { storage: join(tmp, `${name}.sqlite`), security: { token: TOKEN }, ...extra },
    },
    { FYOS_RUNNER_LOKAL: '1', FYOS_RUNNER_ORDNER_ERLAUBT: eins },
  );

async function mitServer(name, cfg, fn) {
  const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: [{ id: 'hausmodell' }, { id: 'hausmodell-max' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runner = new Runner(cfg, { models });
  await runner.start();
  const server = erstelleServer({ runner, cfg });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const basis = `http://127.0.0.1:${server.address().port}`;
  const rufe = async (methode, pfad, { body, token = TOKEN } = {}) => {
    const r = await fetch(basis + pfad, {
      method: methode,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  try {
    await fn({ rufe, cfg, runner });
  } finally {
    await new Promise((ok) => server.close(ok));
    await runner.close().catch(() => {});
  }
}

test('Vorgaben des lokalen Modus: kein Hub, keine Knoten, kein Browser/Desktop/Eingang, Wurzeln aus der Umgebung', () => {
  const cfg = lokalConfig('vorgaben');
  assert.equal(cfg.pi_durable.lokal, true);
  assert.equal(cfg.hub, '');
  assert.equal(cfg.hub_agent_token, '');
  assert.equal(cfg.hintergrund_tor, null);
  assert.deepEqual(cfg.spielmodus, []);
  assert.deepEqual(cfg.pi_durable.nodes, []);
  assert.equal(cfg.pi_durable.proactive.enabled, false);
  assert.equal(cfg.pi_durable.egress.enabled, false);
  assert.equal(cfg.pi_durable.browser.enabled, false);
  assert.equal(cfg.pi_durable.desktop.enabled, false);
  assert.equal(cfg.pi_durable.gedaechtnis.an, false);
  assert.deepEqual(cfg.pi_durable.ordnerErlaubt, [eins]);
  assert.equal(modellListe(cfg)[0].name.startsWith('Lokales Modell'), true);
});

test('Ohne den Schalter bleibt alles beim Alten (Hauptserver-Vorgaben, Route unbekannt)', async () => {
  const cfg = konfigurationLaden({ arbeitsbereiche: { standard: { pfad: arbeit } }, pi_durable: { storage: join(tmp, 'alt.sqlite'), security: { token: TOKEN } } }, {});
  assert.equal(cfg.pi_durable.lokal, false);
  assert.equal(cfg.hub, 'http://127.0.0.1:30840');
  assert.deepEqual(cfg.pi_durable.nodes, []); // Release 0.2: Knoten nur aus der Konfiguration
  assert.equal(cfg.pi_durable.proactive.enabled, true);
  assert.equal(modellListe(cfg)[0].name.startsWith('Hausmodell'), true);
});

test('Bindung: lokal nur Loopback und nur mit Token; ohne den Schalter unverändert', () => {
  const ok = { lokal: true, host: '127.0.0.1', security: { token: TOKEN } };
  assert.equal(bindungPruefen(ok).fehler, null);
  assert.match(bindungPruefen({ ...ok, host: '192.0.2.10' }).fehler, /nur an Loopback/);
  assert.match(bindungPruefen({ ...ok, host: '0.0.0.0' }).fehler, /nur an Loopback/);
  assert.match(bindungPruefen({ ...ok, security: { token: '' } }).fehler, /FYOS_RUNNER_TOKEN/);
  // Ohne lokalen Modus gilt weiter: LAN-Adresse mit langem Token ist erlaubt.
  assert.equal(bindungPruefen({ host: '192.0.2.10', security: { token: TOKEN } }).fehler, null);
});

test('wurzelHinzufuegen: gleiche Prüfungen wie die Ordnerwahl', async () => {
  const w = [];
  await wurzelHinzufuegen(w, eins);
  await wurzelHinzufuegen(w, `${eins}//`);
  assert.deepEqual(w, [eins], 'Doppelte fallen weg');
  await wurzelHinzufuegen(w, join(tmp, 'link-zu-zwei'));
  assert.deepEqual(w, [eins, join(tmp, 'link-zu-zwei')], 'der Pfad bleibt textlich, realpath wurde geprüft');
  const fehler = async (roh) => {
    try {
      await wurzelHinzufuegen([], roh);
    } catch (f) {
      assert.ok(f instanceof OrdnerFehler);
      return `${f.status}:${f.code}`;
    }
    return 'kein Fehler';
  };
  assert.equal(await fehler('relativ/pfad'), '400:ungueltig');
  assert.equal(await fehler(''), '400:ungueltig');
  assert.equal(await fehler(undefined), '400:ungueltig');
  assert.equal(await fehler(`${eins}\0x`), '400:ungueltig');
  assert.equal(await fehler('/'), '403:ausserhalb');
  assert.equal(await fehler('//'), '403:ausserhalb');
  assert.equal(await fehler(`${eins}/../zwei`), '403:ausserhalb');
  assert.equal(await fehler(join(tmp, 'gibtsnicht')), '404:nicht_gefunden');
  assert.equal(await fehler(nichtOrdner), '400:kein_ordner');
});

test('POST /api/ordner/erlauben: nimmt Ordner auf, danach wählbar und als Sitzungsordner nutzbar; Token Pflicht', async () => {
  await mitServer('erlauben', lokalConfig('erlauben'), async ({ rufe, cfg }) => {
    assert.deepEqual((await rufe('GET', '/api/ordner')).json.wurzeln, [eins]);
    // Ein Ordner außerhalb der Wurzeln wird abgelehnt, bis er erlaubt wird.
    assert.equal((await rufe('POST', '/api/gespraeche', { body: { ordner: zwei } })).status, 400);
    assert.equal((await rufe('GET', `/api/ordner?pfad=${encodeURIComponent(zwei)}`)).status, 403);

    const r = await rufe('POST', '/api/ordner/erlauben', { body: { pfad: zwei } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.wurzeln, [eins, zwei]);
    assert.deepEqual(cfg.pi_durable.ordnerErlaubt, [eins, zwei]);
    // Zweimal ist dasselbe.
    assert.deepEqual((await rufe('POST', '/api/ordner/erlauben', { body: { pfad: zwei } })).json.wurzeln, [eins, zwei]);

    assert.equal((await rufe('GET', `/api/ordner?pfad=${encodeURIComponent(zwei)}`)).status, 200);
    const g = await rufe('POST', '/api/gespraeche', { body: { ordner: zwei } });
    assert.equal(g.status, 201);
    assert.equal(g.json.gespraech.agent.cwd, zwei);

    // Fehler: Status und Maschinenname wie bei der Ordnerwahl.
    const rel = await rufe('POST', '/api/ordner/erlauben', { body: { pfad: 'rel' } });
    assert.equal(rel.status, 400);
    assert.equal(rel.json.fehler, 'ungueltig');
    assert.equal((await rufe('POST', '/api/ordner/erlauben', { body: { pfad: '/' } })).status, 403);
    assert.equal((await rufe('POST', '/api/ordner/erlauben', { body: { pfad: join(tmp, 'gibtsnicht') } })).status, 404);
    assert.equal((await rufe('POST', '/api/ordner/erlauben', { body: {} })).status, 400);
    assert.equal((await rufe('POST', '/api/ordner/erlauben', { body: { pfad: nichtOrdner } })).status, 400);
    assert.deepEqual(cfg.pi_durable.ordnerErlaubt, [eins, zwei], 'abgelehnte Pfade ändern nichts');

    // Ohne und mit falschem Token: 401, und es ändert sich nichts.
    const neu = join(tmp, 'eins', 'unter');
    assert.equal((await rufe('POST', '/api/ordner/erlauben', { body: { pfad: neu }, token: null })).status, 401);
    assert.equal((await rufe('POST', '/api/ordner/erlauben', { body: { pfad: neu }, token: 'falsch' })).status, 401);
    assert.deepEqual(cfg.pi_durable.ordnerErlaubt, [eins, zwei]);
    assert.equal((await rufe('GET', '/api/health', { token: null })).status, 401);
    assert.equal((await rufe('GET', '/api/health')).json.ok, true);
  });
});

test('POST /api/ordner/erlauben gibt es ohne lokalen Modus nicht (404)', async () => {
  const cfg = konfigurationLaden(
    {
      hub: 'http://hub.test',
      arbeitsbereiche: { standard: { pfad: arbeit, titel: 'Test' } },
      pi_durable: { storage: join(tmp, 'nichtlokal.sqlite'), security: { token: TOKEN }, proactive: { enabled: false }, egress: { enabled: false }, browser: { enabled: false }, desktop: { enabled: false } },
    },
    { FYOS_RUNNER_ORDNER_ERLAUBT: eins },
  );
  await mitServer('nichtlokal', cfg, async ({ rufe }) => {
    const r = await rufe('POST', '/api/ordner/erlauben', { body: { pfad: zwei } });
    assert.equal(r.status, 404);
    assert.deepEqual((await rufe('GET', '/api/ordner')).json.wurzeln, [eins]);
  });
});

test('Werkzeuge im lokalen Modus: Freigabe und Web, kein Hub, keine Knoten, kein Browser/Desktop', () => {
  const cfg = lokalConfig('werkzeuge');
  const namen = baueRegistry(cfg, { hub: new Hub({ url: cfg.hub }) }).extension.tools.map((t) => t.name);
  assert.deepEqual(namen.sort(), ['freigabe_bitten', 'web_holen', 'web_suchen']);
  // Mit ausdrücklich eingetragener Hub-Adresse kommen die Hub-Werkzeuge dazu.
  const mitHub = lokalConfig('mithub', {});
  mitHub.hub = 'http://hub.test';
  const mehr = baueRegistry(mitHub, { hub: new Hub({ url: mitHub.hub }) }).extension.tools.map((t) => t.name);
  assert.ok(mehr.includes('hub_suchen') && mehr.includes('freigabe_bitten'));
  assert.ok(!mehr.some((n) => /^(knoten|browser|desktop)/.test(n)));
});

test('Container: Wildcard nur mit FYOS_RUNNER_CONTAINER und Token, sonst weiter verboten', () => {
  const lang = 'x'.repeat(32);
  assert.equal(bindungPruefen({ host: '0.0.0.0', container: true, security: { token: lang } }).fehler, null);
  assert.match(bindungPruefen({ host: '0.0.0.0', container: true, security: { token: '' } }).fehler, /Token/);
  assert.match(bindungPruefen({ host: '0.0.0.0', security: { token: lang } }).fehler, /keine Wildcard/);
  const cfg = konfigurationLaden({}, { FYOS_RUNNER_CONTAINER: '1', FYOS_RUNNER_HOST: '0.0.0.0' });
  assert.equal(cfg.pi_durable.container, true);
});

test('Modell aus FYOS_MODELL_* wie im Installer', () => {
  const cfg = konfigurationLaden({}, { FYOS_MODELL_BASIS_URL: 'http://modell:8080/v1/', FYOS_MODELL_NAME: 'mein-modell', FYOS_MODELL_SCHLUESSEL: 'geheim' });
  assert.equal(cfg.pi_durable.model.baseUrl, 'http://modell:8080/v1');
  assert.equal(cfg.pi_durable.model.default, 'mein-modell');
  assert.equal(cfg.pi_durable.model.max, 'mein-modell');
  assert.equal(cfg.pi_durable.model.apiKey, 'geheim');
});
