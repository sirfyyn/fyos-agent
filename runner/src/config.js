/**
 * config.js — eine Konfiguration für alle drei Geräte.
 *
 * Gelesen wird zuerst die bestehende Runner-Konfiguration (`deploy/runner/agent-runner.json`):
 * Hub, Agenten-ID, Arbeitsbereiche, Modelle und Bahnen stehen dort schon für den RPC-Runner.
 * Der eigene Abschnitt `pi_durable` ergänzt nur, was der dauerhafte Lauf zusätzlich braucht
 * (Gerät, Port, SQLite-Datei, Client). So gibt es keine zweite Wahrheit über den Hub.
 *
 * Reihenfolge: Vorgaben < Konfigurationsdatei < Umgebung. Kein Geheimnis steht im Code.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARBEIT_VORGABE, arbeitKonfig } from './arbeit-konfig.js';
import { schattenKonfig } from './schatten-konfig.js';
import { wurzelnLesen } from './ordner.js';
import { sperreLesen } from './sperre.js';

export const PAKET = dirname(dirname(fileURLToPath(import.meta.url)));
export const REPO_RUNNER = resolve(PAKET, '..');

const VORGABEN = {
  hub: 'http://127.0.0.1:30840',
  agent: 'persona',
  arbeitsbereiche: {},
  modelle: {
    hausmodell: { tier: 'normal', ctx_max: 262144 },
    'hausmodell-max': { tier: 'normal', ctx_max: 262144 },
  },
  bahnen: {
    max: { provider: 'hausmodell', modelId: 'hausmodell-max' },
    hintergrund: { provider: 'hausmodell', modelId: 'hausmodell' },
  },
  kurs_usd_eur: null,
  eingang: { an: true, warte_s: 20, anzahl: 20, fehler_pause_s: 10 },
  // Marken, die den Knoten dem Spiel oder Besitzer' Pause überlassen (wie im RPC-Runner).
  spielmodus: ['/var/lib/spielmodus.kid', '/var/lib/spielmodus.nachhut'],
  // Tor für Hintergrundarbeit über ein Hub-Werkzeug; null = immer offen.
  // Quellen-Token der Rolle `runner` (Datei nur für den Dienstbenutzer lesbar); fehlt sie, läuft es ohne Token.
  hub_token_datei: '/etc/fyos/agent-runner.token',
  hintergrund_tor: { werkzeug: 'schleifen.darf', argumente: { schleife: 'arbeit' }, pruefen_s: 60 },
  pi_durable: {},
};

const PD_VORGABEN = {
  host: '127.0.0.1',
  // 18430 gehört auf Hauptserver Ginnys Stimme (Caddy → :18430 /hoeren, /sprechen); 18438 ist frei und nirgends belegt.
  port: 18438,
  token: '',
  device: { id: 'macbook', name: 'MacBook', kind: 'mac' },
  storage: '~/.fyos/runner/fyos.sqlite',
  clientDir: 'public',
  shellPath: '',
  env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' },
  // Rechner, auf die der Agent per ssh darf: nur aus der Konfiguration (`pi_durable.nodes`), im Code keine
  // (Release 0.2, 01.11.2026: die eigenen Adressen stehen in deploy/runner/agent-runner.json und live).
  nodes: [],
  model: {
    provider: 'hausmodell',
    baseUrl: 'http://127.0.0.1:18421/v1',
    apiKey: 'lokal',
    default: 'hausmodell',
    max: 'hausmodell-max',
  },
  // Modellkette (Ersatzdenker, docs/current/PERSONA-ERSATZDENKER-9B.md#umschalten). Vorgabe nur Hausmodell: ohne Eintrag
  // ändert sich nichts. `provider_kette` ist die Reihenfolge der Versuche; `provider.<name>` beschreibt einen Provider
  // (baseUrl, apiKey oder apiKeyDatei, modelId, contextWindow, maxTokens, sperrtSpielmodus, gesundheitUrl).
  // Hausmodell kommt aus `model` und braucht keine Beschreibung; hier lassen sich nur ihre Grenzen überschreiben.
  provider_kette: ['hausmodell'],
  provider_sperre_s: 60,
  provider: {},
  workspaces: null,
  proactive: { enabled: true, pollSeconds: 20, batch: 20, agent: null, conversation: null },
  // Persona arbeitet im Leerlauf ihre fälligen Vorgänge ab (src/arbeitsschleife.js); Stufe `lesen` bis Besitzer `schreiben` sagt.
  arbeitsschleife: { ...ARBEIT_VORGABE },
  egress: { enabled: true, flushMs: 600, maxBuffer: 500 },
  // Offene Freigaben außerhalb der App melden (freigabe-meldung.js). Vorgabe aus; Kanäle: matrix, ntfy.
  freigabe_meldung: { kanaele: [] },
  // Ohne Token startet der Runner nicht: er führt Befehle aus. Kein Ursprung ist vorab erlaubt
  // (nur die eigene Seite); weitere Ursprünge ausdrücklich eintragen.
  security: { token: '', tokenDatei: '~/.fyos/runner/token', allowedOrigins: [] },
  limits: { maxBodyBytes: 2 * 1024 * 1024, maxEntries: 400, maxToolOutput: 24000 },
  prompts: {},
  // Ginnys Gedächtnis (Plan S5/S7, docs/current/PERSONA-GEDAECHTNIS.md). Aus, bis Besitzer es einschaltet.
  // Wahrheit sind Dateien unter `ordner`; Qdrant (`qdrant_url`, Sammlung `collection`) ist nur der Index.
  gedaechtnis: {
    an: false,
    ordner: '/var/lib/fyos-agent/gedaechtnis',
    qdrant_url: '',
    collection: 'persona_gedaechtnis',
    embed_url: '',
    anlegen: true,
    deckel: { fakten: 1000, text_zeichen: 600, treffer: 10, prompt_zeilen: 12, prompt_zeichen: 3000, pflege: 200 },
  },
  browser: {
    enabled: true,
    headless: true,
    channel: 'chrome',
    executablePath: '',
    userDataDir: '~/.fyos/runner/browser',
    screenshotDir: '~/.fyos/runner/bilder',
    timeoutMs: 45000,
    viewport: { width: 1440, height: 900 },
  },
  desktop: {
    enabled: true,
    url: '',
    tokenFile: '~/.fyos/runner/fyos-oeffnen-agent.token',
    token: '',
    ziel: 'agent',
    skala: 0.6,
    timeoutMs: 30000,
  },
};

/**
 * Vorgaben des lokalen Modus (`FYOS_RUNNER_LOKAL=1`), zwischen den allgemeinen Vorgaben und der Konfigurationsdatei:
 * kein Hub (nur mit ausdrücklich eingetragener Adresse), keine Knoten (ssh), kein Browser/Desktop, kein Eingang, keine Marken.
 */
const LOKAL_VORGABEN = {
  hub: '',
  hub_token_datei: '',
  hintergrund_tor: null,
  spielmodus: [],
  agent: 'agent',
};

const LOKAL_PD_VORGABEN = {
  device: { id: 'lokal', name: 'Dieser Computer', kind: 'mac' },
  nodes: [],
  proactive: { enabled: false },
  egress: { enabled: false },
  arbeitsschleife: { an: false },
  browser: { enabled: false },
  desktop: { enabled: false },
  gedaechtnis: { an: false },
};

const tief = (a, b) => {
  if (Array.isArray(a) || Array.isArray(b)) return b === undefined ? a : b;
  if (!a || typeof a !== 'object' || !b || typeof b !== 'object') return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = tief(a[k], v);
  return out;
};

const wahr = (v, vorgabe) => {
  if (v === undefined || v === null || v === '') return vorgabe;
  const s = String(v).trim().toLowerCase();
  return ['1', 'true', 'ja', 'an', 'on', 'yes'].includes(s);
};

const zahl = (v, vorgabe) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : vorgabe;
};

const text = (v, vorgabe = '') => (typeof v === 'string' && v.trim() ? v.trim() : vorgabe);

/** `~` und relative Pfade auflösen; relative Pfade gelten ab dem Paketverzeichnis. */
export function pfadAufloesen(p, basis = PAKET) {
  let s = String(p ?? '').trim();
  if (!s) return basis;
  if (s === '~') return homedir();
  if (s.startsWith('~/')) s = join(homedir(), s.slice(2));
  return isAbsolute(s) ? s : resolve(basis, s);
}

/** Arbeitsbereiche in die eine Form bringen: Name -> { pfad, titel }. */
export function bereicheNormalisieren(roh) {
  const out = {};
  for (const [name, wert] of Object.entries(roh ?? {})) {
    if (!/^[a-z0-9_-]{1,40}$/.test(name)) continue;
    if (typeof wert === 'string') {
      out[name] = { pfad: pfadAufloesen(wert), titel: name };
    } else if (wert && typeof wert === 'object' && typeof wert.pfad === 'string') {
      out[name] = {
        pfad: pfadAufloesen(wert.pfad),
        titel: text(wert.titel, name),
      };
    }
  }
  if (!out.standard) {
    out.standard = { pfad: process.cwd(), titel: 'Standard' };
  }
  return out;
}

const HAUSMODELL_FENSTER = 262144;
const HAUSMODELL_MAX_TOKENS = 16384;
const ERSATZ_FENSTER = 65536;
const ERSATZ_MAX_TOKENS = 4096;

const ganz = (v, vorgabe, min, max = Number.MAX_SAFE_INTEGER) => Math.min(max, Math.max(min, Math.round(zahl(v, vorgabe))));

/** Der API-Schlüssel eines Providers: Wert vor Datei vor Vorgabe. Er wird nie geloggt. */
function schluesselLesen(beschreibung, vorgabe) {
  const wert = text(beschreibung?.apiKey);
  if (wert) return wert;
  const datei = text(beschreibung?.apiKeyDatei);
  if (datei) {
    try {
      const inhalt = readFileSync(pfadAufloesen(datei), 'utf8').trim();
      if (inhalt) return inhalt;
    } catch {
      /* fehlt die Datei, gilt die Vorgabe — der Server lehnt einen falschen Schlüssel selbst ab */
    }
  }
  return vorgabe;
}

/**
 * Die Provider der Kette in eine Form bringen: Name -> { name, anzeige, baseUrl, apiKey, modelId, maxModelId,
 * contextWindow, maxTokens, sperrtSpielmodus, gesundheitUrl }. Hausmodell ist immer dabei (aus `model`); weitere Provider nur,
 * wenn sie beschrieben sind. Ein Name in `provider_kette` ohne Beschreibung ist ein Konfigurationsfehler.
 */
export function providerAufloesen(pd, modell, env = {}) {
  const roh = pd.provider && typeof pd.provider === 'object' && !Array.isArray(pd.provider) ? pd.provider : {};
  const map = {};
  const hausmodell = roh.hausmodell ?? {};
  map[modell.provider] = {
    name: modell.provider,
    anzeige: text(hausmodell.name, 'Hausmodell (Hauptserver)'),
    baseUrl: modell.baseUrl,
    apiKey: modell.apiKey,
    modelId: modell.default,
    maxModelId: modell.max,
    contextWindow: ganz(hausmodell.contextWindow, HAUSMODELL_FENSTER, 4096),
    maxTokens: ganz(hausmodell.maxTokens, HAUSMODELL_MAX_TOKENS, 256),
    sperrtSpielmodus: hausmodell.sperrtSpielmodus === undefined ? true : wahr(hausmodell.sperrtSpielmodus, true),
    gesundheitUrl: text(hausmodell.gesundheitUrl),
  };
  for (const [name, d0] of Object.entries(roh)) {
    if (name === modell.provider) continue;
    if (!/^[a-z0-9_-]{1,32}$/.test(name)) throw new Error(`Providername unbrauchbar: ${name} (^[a-z0-9_-]{1,32}$)`);
    let d = d0 && typeof d0 === 'object' ? d0 : {};
    if (name === 'ersatzdenker') {
      d = { ...d };
      if (env.FYOS_ERSATZ_URL) d.baseUrl = env.FYOS_ERSATZ_URL;
      if (env.FYOS_ERSATZ_KEY) d.apiKey = env.FYOS_ERSATZ_KEY;
    }
    const baseUrl = text(d.baseUrl).replace(/\/+$/, '');
    if (!baseUrl) continue; // ohne Adresse nicht benutzbar; in der Kette gemeldet
    const fenster = ganz(d.contextWindow, ERSATZ_FENSTER, 4096);
    const modelId = text(d.modelId, name);
    map[name] = {
      name,
      anzeige: text(d.name, name === 'ersatzdenker' ? 'Ersatzdenker' : name),
      baseUrl,
      apiKey: schluesselLesen(d, 'lokal'),
      modelId,
      maxModelId: text(d.maxModelId, modelId),
      contextWindow: fenster,
      maxTokens: ganz(d.maxTokens, ERSATZ_MAX_TOKENS, 256, Math.floor(fenster / 2)),
      sperrtSpielmodus: wahr(d.sperrtSpielmodus, false),
      gesundheitUrl: text(d.gesundheitUrl),
    };
  }
  if (!roh.ersatzdenker && env.FYOS_ERSATZ_URL) {
    const baseUrl = text(env.FYOS_ERSATZ_URL).replace(/\/+$/, '');
    map.ersatzdenker = {
      name: 'ersatzdenker', anzeige: 'Ersatzdenker', baseUrl, apiKey: text(env.FYOS_ERSATZ_KEY, 'lokal'),
      modelId: 'ersatzdenker', maxModelId: 'ersatzdenker', contextWindow: ERSATZ_FENSTER, maxTokens: ERSATZ_MAX_TOKENS,
      sperrtSpielmodus: false, gesundheitUrl: '',
    };
  }
  map[modell.provider].maxTokens = Math.min(map[modell.provider].maxTokens, Math.floor(map[modell.provider].contextWindow / 2));
  return map;
}

/** Die Reihenfolge der Kette prüfen; Vorgabe nur Hausmodell. */
export function ketteAufloesen(pd, map, modell, env = {}) {
  const ausEnv = text(env.FYOS_PROVIDER_KETTE);
  const roh = ausEnv ? ausEnv.split(',') : Array.isArray(pd.provider_kette) ? pd.provider_kette : [modell.provider];
  const namen = [...new Set(roh.map((n) => String(n).trim()).filter(Boolean))];
  if (!namen.length) return [modell.provider];
  for (const n of namen) {
    if (!map[n]) throw new Error(`provider_kette nennt „${n}“, aber der Provider ist nicht beschrieben (pi_durable.provider.${n}.baseUrl fehlt)`);
  }
  return namen;
}

/** Das Hub-Token der Rolle `runner`: Umgebung vor Datei; fehlt beides, gibt es keins (wie im RPC-Runner). */
function hubTokenLesen(datei, env) {
  if (env.FYOS_HUB_AGENT_TOKEN) return String(env.FYOS_HUB_AGENT_TOKEN).trim();
  if (!datei) return '';
  try {
    return readFileSync(pfadAufloesen(datei), 'utf8').trim();
  } catch {
    return '';
  }
}

function configPfad(argumente = process.argv.slice(2)) {
  const i = argumente.indexOf('--config');
  const ausArgument = i >= 0 ? argumente[i + 1] : undefined;
  return text(
    ausArgument || process.env.FYOS_RUNNER_CONFIG,
    join(REPO_RUNNER, 'agent-runner.json'),
  );
}

/**
 * Konfiguration laden. `quelle` ist ein Pfad oder ein bereits gelesenes Objekt (Tests).
 */
export function konfigurationLaden(quelle = configPfad(), env = process.env) {
  let datei = {};
  let herkunft = null;
  if (typeof quelle === 'string') {
    herkunft = pfadAufloesen(quelle);
    if (existsSync(herkunft)) {
      try {
        datei = JSON.parse(readFileSync(herkunft, 'utf8'));
      } catch (fehler) {
        throw new Error(`Konfiguration ${herkunft} ist kein gültiges JSON: ${fehler.message}`);
      }
      if (!datei || typeof datei !== 'object' || Array.isArray(datei)) {
        throw new Error(`Konfiguration ${herkunft} muss ein Objekt sein`);
      }
    }
  } else if (quelle && typeof quelle === 'object') {
    datei = quelle;
    herkunft = '(objekt)';
  }

  // Lokaler Modus (Vertrag des lokalen Runners der Hülle, docs/current/FYOS-AGENT-HUELLE.md#lokaler-runner): eigene Vorgaben
  // ohne Hauptserver, Hub, Knoten, Browser, Desktop, Eingang. Aus, solange `FYOS_RUNNER_LOKAL` nicht gesetzt ist: dann ändert sich nichts.
  const lokal = wahr(env.FYOS_RUNNER_LOKAL, datei.pi_durable?.lokal === true);
  const basis = tief(lokal ? tief(VORGABEN, LOKAL_VORGABEN) : VORGABEN, datei);
  const pd = tief(lokal ? tief(PD_VORGABEN, LOKAL_PD_VORGABEN) : PD_VORGABEN, datei.pi_durable ?? {});
  pd.lokal = lokal;

  // Umgebung überschreibt die Datei — nützlich für systemd und Tests.
  const e = env;
  if (e.FYOS_HUB_URL) basis.hub = e.FYOS_HUB_URL;
  // Der Steuerkanal liegt im RPC-Runner auf 18435. Im Schatten läuft jener weiter: eigener Port per Umgebung.
  if (e.FYOS_STEUER_PORT) basis.steuer = { ...(basis.steuer ?? {}), port: zahl(e.FYOS_STEUER_PORT, 18435) };
  if (e.FYOS_AGENT_ID) basis.agent = e.FYOS_AGENT_ID;

  pd.host = text(e.FYOS_RUNNER_HOST, pd.host);
  pd.port = zahl(e.FYOS_RUNNER_PORT, pd.port);
  pd.token = text(e.FYOS_RUNNER_TOKEN, pd.token);
  // Im Container (Bild fyos-agent/runner) ist die eigene Adresse vorher unbekannt: dort darf er auf alle Adressen binden,
  // aber nur mit Token (bindungPruefen). Außerhalb eines Containers bleibt die Wildcard verboten.
  pd.container = wahr(e.FYOS_RUNNER_CONTAINER, pd.container === true);
  pd.storage = text(e.FYOS_RUNNER_STORAGE, pd.storage);
  pd.systemPrompt = text(e.FYOS_RUNNER_SYSTEMPROMPT, pd.systemPrompt ?? '');
  pd.device = {
    id: text(e.FYOS_DEVICE_ID, pd.device?.id || 'macbook'),
    name: text(e.FYOS_DEVICE_NAME, pd.device?.name || 'MacBook'),
    kind: text(e.FYOS_DEVICE_KIND, pd.device?.kind || 'mac'),
  };
  if (e.FYOS_HAUSMODELL_URL) pd.model.baseUrl = e.FYOS_HAUSMODELL_URL;
  if (e.FYOS_HAUSMODELL_KEY) pd.model.apiKey = e.FYOS_HAUSMODELL_KEY;
  // Dieselben Namen wie der OpenClaw-Agent und der Installer (Release 0.2): jedes OpenAI-kompatible Modell.
  if (e.FYOS_MODELL_BASIS_URL) pd.model.baseUrl = e.FYOS_MODELL_BASIS_URL;
  if (e.FYOS_MODELL_SCHLUESSEL) pd.model.apiKey = e.FYOS_MODELL_SCHLUESSEL;
  if (e.FYOS_MODELL_NAME) pd.model = { ...pd.model, default: e.FYOS_MODELL_NAME, max: e.FYOS_MODELL_NAME };
  if (e.FYOS_RUNNER_WORKSPACE) {
    pd.workspaces = { standard: e.FYOS_RUNNER_WORKSPACE };
  }
  if (e.FYOS_RUNNER_PROAKTIV !== undefined) {
    pd.proactive.enabled = wahr(e.FYOS_RUNNER_PROAKTIV, pd.proactive.enabled);
  }

  const ged = pd.gedaechtnis ?? {};
  if (e.FYOS_GEDAECHTNIS !== undefined) ged.an = wahr(e.FYOS_GEDAECHTNIS, ged.an === true);
  if (e.FYOS_GEDAECHTNIS_DIR) ged.ordner = String(e.FYOS_GEDAECHTNIS_DIR).trim();
  if (e.QDRANT_URL) ged.qdrant_url = String(e.QDRANT_URL).trim();
  if (e.FYOS_GEDAECHTNIS_COLLECTION) ged.collection = String(e.FYOS_GEDAECHTNIS_COLLECTION).trim();
  if (e.EMBED_EG2_URL) ged.embed_url = String(e.EMBED_EG2_URL).trim();
  pd.gedaechtnis = {
    ...ged,
    an: ged.an === true,
    ordner: pfadAufloesen(text(ged.ordner, '/var/lib/fyos-agent/gedaechtnis')),
    qdrant_url: text(ged.qdrant_url).replace(/\/+$/, ''),
    collection: text(ged.collection, 'persona_gedaechtnis'),
    embed_url: text(ged.embed_url).replace(/\/+$/, ''),
    anlegen: ged.anlegen !== false,
    deckel: {
      fakten: Math.max(10, zahl(ged.deckel?.fakten, 1000)),
      text_zeichen: Math.max(80, zahl(ged.deckel?.text_zeichen, 600)),
      treffer: Math.max(1, Math.min(30, zahl(ged.deckel?.treffer, 10))),
      prompt_zeilen: Math.max(0, Math.min(40, zahl(ged.deckel?.prompt_zeilen, 12))),
      prompt_zeichen: Math.max(200, zahl(ged.deckel?.prompt_zeichen, 3000)),
      pflege: Math.max(10, zahl(ged.deckel?.pflege, 200)),
    },
  };

  // Schalter für Betrieb und Tests; die Stufe lässt sich nur in der Datei ändern.
  if (e.FYOS_ARBEITSSCHLEIFE !== undefined) pd.arbeitsschleife = { ...pd.arbeitsschleife, an: wahr(e.FYOS_ARBEITSSCHLEIFE, true) };
  // Hauptschalter des Schatten-Rekorders (Testserver); welche Adapter laufen, steht nur in der Datei.
  if (e.FYOS_SCHATTEN !== undefined) pd.schatten = { ...(pd.schatten ?? {}), an: wahr(e.FYOS_SCHATTEN, false) };

  const brow = pd.browser ?? {};
  if (e.FYOS_BROWSER_ENABLED !== undefined) brow.enabled = wahr(e.FYOS_BROWSER_ENABLED, brow.enabled !== false);
  if (e.FYOS_BROWSER_HEADLESS !== undefined) brow.headless = wahr(e.FYOS_BROWSER_HEADLESS, brow.headless !== false);
  if (e.FYOS_BROWSER_PATH) brow.executablePath = String(e.FYOS_BROWSER_PATH).trim();
  if (e.FYOS_BROWSER_PROFILE) brow.userDataDir = String(e.FYOS_BROWSER_PROFILE).trim();
  pd.browser = brow;

  const dtp = pd.desktop ?? {};
  if (e.FYOS_DESKTOP_ENABLED !== undefined) dtp.enabled = wahr(e.FYOS_DESKTOP_ENABLED, dtp.enabled !== false);
  if (e.FYOS_DESKTOP_URL) dtp.url = String(e.FYOS_DESKTOP_URL).trim().replace(/\/+$/, '');
  if (e.FYOS_DESKTOP_TOKEN) dtp.token = String(e.FYOS_DESKTOP_TOKEN).trim();
  if (e.FYOS_DESKTOP_TOKEN_DATEI) dtp.tokenFile = String(e.FYOS_DESKTOP_TOKEN_DATEI).trim();
  if (e.FYOS_DESKTOP_ZIEL) dtp.ziel = String(e.FYOS_DESKTOP_ZIEL).trim();
  pd.desktop = dtp;

  const arbeitsbereiche = bereicheNormalisieren(pd.workspaces ?? basis.arbeitsbereiche);
  if (!/^[a-z0-9_-]{1,32}$/.test(pd.device.id)) {
    throw new Error(`Geräte-ID unbrauchbar: ${pd.device.id} (^[a-z0-9_-]{1,32}$)`);
  }
  const kinds = new Set(['mac', 'hauptserver', 'web', 'linux']);
  if (!kinds.has(pd.device.kind)) {
    throw new Error(`Geräteart unbrauchbar: ${pd.device.kind} (${[...kinds].join(', ')})`);
  }

  const modell = {
    ...pd.model,
    provider: text(pd.model?.provider, 'hausmodell'),
    baseUrl: text(pd.model?.baseUrl, 'http://127.0.0.1:18421/v1').replace(/\/+$/, ''),
    apiKey: text(pd.model?.apiKey, 'lokal'),
  };
  const providerMap = providerAufloesen(pd, modell, e);
  const providerKette = ketteAufloesen(pd, providerMap, modell, e);
  // Browser-Profil und Screenshots liegen außerhalb des Repos; relative Pfade
  // gelten ab dem Runner-Paketverzeichnis.
  pd.browser.userDataDir = pfadAufloesen(pd.browser.userDataDir);
  pd.browser.screenshotDir = pfadAufloesen(pd.browser.screenshotDir);
  pd.desktop.tokenFile = pfadAufloesen(pd.desktop.tokenFile);

  return {
    ...basis,
    arbeitsbereiche,
    hub: text(basis.hub, lokal ? '' : VORGABEN.hub).replace(/\/+$/, ''),
    agent: text(basis.agent, 'persona'),
    pi_durable: {
      ...pd,
      storage: pfadAufloesen(pd.storage),
      clientDir: pfadAufloesen(pd.clientDir, PAKET),
      model: modell,
      provider: providerMap,
      provider_kette: providerKette,
      provider_sperre_s: Math.max(1, zahl(pd.provider_sperre_s, 60)),
      workspaces: arbeitsbereiche,
      // „Ordner je Sitzung“: erlaubte Wurzeln nur aus der Umgebung (`:`-getrennt, absolut); leer = Funktion aus.
      ordnerErlaubt: wurzelnLesen(e.FYOS_RUNNER_ORDNER_ERLAUBT),
      // Sperrliste für `GET /api/datei` und `/api/ordner?dateien=1` (src/sperre.js); Standardliste, `+a,b` ergänzt sie.
      dateiSperre: sperreLesen(e.FYOS_RUNNER_DATEI_SPERRE),
      proactive: {
        ...pd.proactive,
        pollSeconds: Math.max(3, zahl(pd.proactive?.pollSeconds, 20)),
        batch: Math.max(1, Math.min(50, zahl(pd.proactive?.batch, 20))),
        agent: text(pd.proactive?.agent, basis.agent),
      },
      arbeitsschleife: arbeitKonfig(pd.arbeitsschleife),
      // Schatten-Rekorder (src/schatten.js): Standard AUS, je Adapter eigener Schalter.
      schatten: schattenKonfig(pd.schatten),
      egress: {
        ...pd.egress,
        flushMs: Math.max(100, zahl(pd.egress?.flushMs, 600)),
        maxBuffer: Math.max(10, zahl(pd.egress?.maxBuffer, 500)),
      },
      security: {
        ...pd.security,
        token: text(pd.security?.token, pd.token),
        tokenDatei: pfadAufloesen(text(pd.security?.tokenDatei, '~/.fyos/runner/token')),
        allowedOrigins: Array.isArray(pd.security?.allowedOrigins) ? pd.security.allowedOrigins : [],
      },
      limits: {
        ...pd.limits,
        maxBodyBytes: Math.max(64 * 1024, zahl(pd.limits?.maxBodyBytes, 2 * 1024 * 1024)),
        maxEntries: Math.max(50, zahl(pd.limits?.maxEntries, 400)),
        maxToolOutput: Math.max(2000, zahl(pd.limits?.maxToolOutput, 24000)),
      },
    },
    hub_agent_token: hubTokenLesen(basis.hub_token_datei, e),
    quelle: herkunft,
  };
}
/**
 * Darf der Runner so gebunden werden? Vorgabe ist Loopback (`FYOS_RUNNER_HOST=127.0.0.1`). Die LAN-Adresse des Geräts ist
 * erlaubt (Verwaltung aus dem Cluster, Besitzer 25.10.2026), aber nur mit einem Token von mindestens 32 Zeichen und nie als
 * Wildcard (0.0.0.0, ::): der Runner führt Befehle aus. Gibt `{art, fehler}`; `fehler` ist `null`, wenn es so geht.
 */
export function bindungPruefen(pd) {
  const host = String(pd?.host ?? '').trim();
  const lokal = ['127.0.0.1', '::1', 'localhost'].includes(host);
  // Lokaler Modus: nur Loopback und immer mit Token (der Vertrag verlangt 401 ohne Token), nie das Netz.
  if (pd?.lokal === true) {
    if (!lokal) return { art: 'netz', fehler: `FYOS_RUNNER_HOST=${host || '(leer)'}: der lokale Modus bindet nur an Loopback (127.0.0.1)` };
    if (String(pd?.security?.token ?? '').length < 32) return { art: 'loopback', fehler: 'der lokale Modus verlangt FYOS_RUNNER_TOKEN (mindestens 32 Zeichen)' };
    return { art: 'loopback', fehler: null };
  }
  if (lokal) return { art: 'loopback', fehler: null };
  const wildcard = !host || host === '0.0.0.0' || host === '::' || host === '[::]';
  if (wildcard && pd?.container === true) {
    if (String(pd?.security?.token ?? '').length < 32) {
      return { art: 'container', fehler: 'im Container nur mit einem Token von mindestens 32 Zeichen (FYOS_RUNNER_TOKEN)' };
    }
    return { art: 'container', fehler: null };
  }
  if (wildcard) {
    return { art: 'netz', fehler: `FYOS_RUNNER_HOST=${host || '(leer)'}: keine Wildcard-Bindung; die LAN-Adresse des Geräts angeben (z. B. 192.0.2.10)` };
  }
  const token = String(pd?.security?.token ?? '');
  if (token.length < 32) {
    return { art: 'netz', fehler: `FYOS_RUNNER_HOST=${host}: außerhalb von Loopback nur mit einem Token von mindestens 32 Zeichen` };
  }
  return { art: 'netz', fehler: null };
}

/** Eine kurze, geheimnisfreie Beschreibung für /api/health und Logs. */
export function oeffentlicheSicht(cfg) {
  const pd = cfg.pi_durable;
  return {
    agent: cfg.agent,
    hub: cfg.hub,
    device: pd.device,
    port: pd.port,
    storage: pd.storage,
    // Schatten = Eingang aus. Der Harness2-Starter verweigert sich einem Runner, der den Eingang liest.
    proaktiv: Boolean(pd.proactive?.enabled),
    browser: pd.browser
      ? { enabled: pd.browser.enabled, headless: pd.browser.headless, profil: pd.browser.userDataDir }
      : null,
    desktop: pd.desktop
      ? { enabled: pd.desktop.enabled, url: pd.desktop.url, ziel: pd.desktop.ziel, skala: pd.desktop.skala }
      : null,
    model: {
      provider: cfg.pi_durable.model.provider,
      baseUrl: cfg.pi_durable.model.baseUrl,
      default: cfg.pi_durable.model.default,
      max: cfg.pi_durable.model.max,
    },
    // Ohne Schlüssel: nur Name, Adresse, Modell und Grenzen der Kette.
    kette: (pd.provider_kette ?? []).map((n) => {
      const p = pd.provider?.[n];
      return p
        ? { name: p.name, baseUrl: p.baseUrl, modelId: p.modelId, contextWindow: p.contextWindow, maxTokens: p.maxTokens, sperrtSpielmodus: p.sperrtSpielmodus }
        : { name: n };
    }),
    arbeitsbereiche: Object.fromEntries(
      Object.entries(cfg.arbeitsbereiche).map(([name, wert]) => [name, wert.titel]),
    ),
    quelle: cfg.quelle,
  };
}

