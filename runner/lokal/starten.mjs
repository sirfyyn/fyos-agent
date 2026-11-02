#!/usr/bin/env node
/**
 * starten.mjs — Startprogramm des LOKALEN Runners der FYOS-Agent-Hülle (apps/fyos-shell, Profil `agent`, Vertrag Version 1).
 *
 * Es erfüllt den Vertrag aus apps/fyos-shell/README.md („Lokaler Runner“): die Hülle startet es als Kindprozess und setzt
 *   FYOS_RUNNER_PORT, FYOS_RUNNER_TOKEN (64 Hexzeichen), FYOS_RUNNER_ORDNER_ERLAUBT (absolute Pfade, `:`), FYOS_RUNNER_HOST (127.0.0.1),
 *   FYOS_RUNNER_DATEN (eigener Ordner für den Zustand).
 * Dieses Programm übersetzt das in die Konfiguration des Runners (deploy/runner/pi-durable) und startet dessen lokalen Modus (src/lokal.js).
 *
 * Was entsteht in FYOS_RUNNER_DATEN:
 *   fyos.sqlite        die Gespräche (eigene Datei, nichts von Hauptserver)
 *   runner-konfig.json bei jedem Start neu erzeugt, ohne Geheimnisse (Token und Schlüssel gehen nur über die Umgebung)
 *   arbeit/            Arbeitsbereich „standard“ für Sitzungen ohne gewählten Ordner
 *   modell.json        VOM NUTZER: welches Modell (siehe unten); fehlt sie, wird sie nicht angelegt
 *   konfig.json        VOM NUTZER, optional: Ergänzungen zur Konfiguration (z. B. ausdrücklich ein Hub); wird eingemischt
 *
 * modell.json (OpenAI-kompatible Schnittstelle, z. B. Ollama, LM Studio, ein Gateway):
 *   { "baseUrl": "http://127.0.0.1:11434/v1", "modelId": "qwen3", "maxModelId": "…", "apiKey": "…" | "apiKeyDatei": "~/pfad",
 *     "contextWindow": 32768, "maxTokens": 8192 }
 * Umgebung überschreibt die Datei: FYOS_LOKAL_MODELL_URL, FYOS_LOKAL_MODELL_ID, FYOS_LOKAL_MODELL_KEY, FYOS_LOKAL_MODELL_KEY_DATEI.
 * Es ist kein Schlüssel eingebaut; ohne Einrichtung startet der Runner trotzdem (Gesundheit, Ordner), ein Zug meldet dann „Modell nicht erreichbar“.
 *
 * Optionale Argumente (aus der Vorlage der Hülle): `--port N` (muss zu FYOS_RUNNER_PORT passen oder ersetzt ihn, wenn die Umgebung ihn nicht
 * setzt) und `--ordner PFAD` (eine zusätzliche erlaubte Wurzel). Alles andere wird ignoriert.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOKEN_FORM = /^[0-9a-fA-F]{64}$/;
const OLLAMA = 'http://127.0.0.1:11434/v1';

export class StartFehler extends Error {}

const text = (v, vorgabe = '') => (typeof v === 'string' && v.trim() ? v.trim() : vorgabe);

const tief = (a, b) => {
  if (Array.isArray(b) || !b || typeof b !== 'object' || !a || typeof a !== 'object' || Array.isArray(a)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = tief(a[k], v);
  return out;
};

function jsonLesen(pfad, was) {
  if (!existsSync(pfad)) return null;
  try {
    const j = JSON.parse(readFileSync(pfad, 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('muss ein Objekt sein');
    return j;
  } catch (fehler) {
    throw new StartFehler(`${was} (${pfad}) ist nicht lesbar: ${fehler.message}`);
  }
}

function pfadAufloesen(p) {
  const s = text(p);
  if (s === '~') return homedir();
  if (s.startsWith('~/')) return join(homedir(), s.slice(2));
  return s;
}

/** Ordnerliste aus der Umgebung des Vertrags: `:` (unter Windows `;`), nur absolute Pfade, ohne Doppelte. */
export function wurzelnAusUmgebung(roh) {
  const out = [];
  for (const t of String(roh ?? '').split(delimiter)) {
    const p = t.trim();
    if (p && isAbsolute(p) && !p.includes('\0') && !out.includes(p)) out.push(p);
  }
  return out;
}

/** Das Modell aus `modell.json` und der Umgebung. Der Schlüssel wird hier gelesen und nie in die Konfigurationsdatei geschrieben. */
export function modellLesen(daten, env) {
  const d = jsonLesen(join(daten, 'modell.json'), 'modell.json') ?? {};
  const baseUrl = text(env.FYOS_LOKAL_MODELL_URL, text(d.baseUrl, OLLAMA)).replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) throw new StartFehler(`Modelladresse unbrauchbar: ${baseUrl}`);
  const modelId = text(env.FYOS_LOKAL_MODELL_ID, text(d.modelId, 'modell'));
  let schluessel = text(env.FYOS_LOKAL_MODELL_KEY, text(d.apiKey));
  const datei = text(env.FYOS_LOKAL_MODELL_KEY_DATEI, text(d.apiKeyDatei));
  if (!schluessel && datei) {
    try {
      schluessel = readFileSync(pfadAufloesen(datei), 'utf8').trim();
    } catch {
      /* fehlt die Datei, gilt „lokal“: lokale Server prüfen den Schlüssel meist nicht */
    }
  }
  const ganz = (v, vorgabe, min) => (Number.isFinite(Number(v)) && Number(v) >= min ? Math.round(Number(v)) : vorgabe);
  const contextWindow = ganz(d.contextWindow, 65536, 4096);
  return {
    baseUrl,
    modelId,
    maxModelId: text(d.maxModelId, modelId),
    schluessel: schluessel || 'lokal',
    contextWindow,
    maxTokens: Math.min(ganz(d.maxTokens, 8192, 256), Math.floor(contextWindow / 2)),
    eingerichtet: Boolean(d.baseUrl || env.FYOS_LOKAL_MODELL_URL),
  };
}

/**
 * Aus der Umgebung des Vertrags die Konfiguration des Runners. Rein bis auf das Lesen von `modell.json`/`konfig.json`/Schlüsseldatei.
 * Gibt `{ konfig, umgebung, daten, wurzeln, modell }`; wirft StartFehler bei einem Verstoß gegen den Vertrag.
 */
export function uebersetzen(env, argv = [], { plattform = process.platform, rechnername = hostname() } = {}) {
  let port = Number(env.FYOS_RUNNER_PORT);
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (!env.FYOS_RUNNER_PORT && arg('--port')) port = Number(arg('--port'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new StartFehler('FYOS_RUNNER_PORT fehlt oder ist kein Port');
  const token = text(env.FYOS_RUNNER_TOKEN);
  if (!TOKEN_FORM.test(token)) throw new StartFehler('FYOS_RUNNER_TOKEN fehlt oder hat nicht die Form (64 Hexzeichen)');
  const host = text(env.FYOS_RUNNER_HOST, '127.0.0.1');
  if (host !== '127.0.0.1') throw new StartFehler(`FYOS_RUNNER_HOST=${host}: der lokale Runner bindet nur an 127.0.0.1`);
  const daten = text(env.FYOS_RUNNER_DATEN);
  if (!daten || !isAbsolute(daten)) throw new StartFehler('FYOS_RUNNER_DATEN fehlt oder ist kein absoluter Pfad');

  const wurzeln = wurzelnAusUmgebung(env.FYOS_RUNNER_ORDNER_ERLAUBT);
  const zusatz = arg('--ordner');
  if (zusatz && isAbsolute(zusatz) && !wurzeln.includes(zusatz)) wurzeln.push(zusatz);

  const modell = modellLesen(daten, env);
  const arbeit = join(daten, 'arbeit');
  const kind = plattform === 'darwin' ? 'mac' : 'linux';
  const gerId = (`lokal-${rechnername}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '')) || 'lokal';

  const eigene = {
    arbeitsbereiche: { standard: { pfad: arbeit, titel: 'Arbeitsbereich' } },
    modelle: { [modell.modelId]: { tier: 'normal', ctx_max: modell.contextWindow }, [modell.maxModelId]: { tier: 'normal', ctx_max: modell.contextWindow } },
    bahnen: {
      max: { provider: 'hausmodell', modelId: modell.maxModelId },
      hintergrund: { provider: 'hausmodell', modelId: modell.modelId },
    },
    pi_durable: {
      lokal: true,
      host,
      port,
      device: { id: gerId, name: `Dieser Computer (${rechnername})`, kind },
      storage: join(daten, 'fyos.sqlite'),
      // PATH des Nutzers, damit bash die Werkzeuge findet, die er selbst hat; sonst die üblichen Orte.
      env: { PATH: text(env.PATH, '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'), HOME: text(env.HOME, homedir()) },
      model: { provider: 'hausmodell', baseUrl: modell.baseUrl, default: modell.modelId, max: modell.maxModelId },
      provider_kette: ['hausmodell'],
      provider: { hausmodell: { name: 'Lokales Modell', contextWindow: modell.contextWindow, maxTokens: modell.maxTokens, sperrtSpielmodus: false } },
    },
  };
  const konfig = tief(eigene, jsonLesen(join(daten, 'konfig.json'), 'konfig.json') ?? {});
  // Was der Vertrag festlegt, lässt sich durch konfig.json nicht umstellen.
  konfig.pi_durable = { ...konfig.pi_durable, lokal: true, host, port, storage: eigene.pi_durable.storage };

  const umgebung = {
    FYOS_RUNNER_LOKAL: '1',
    FYOS_RUNNER_HOST: host,
    FYOS_RUNNER_PORT: String(port),
    FYOS_RUNNER_TOKEN: token,
    FYOS_RUNNER_ORDNER_ERLAUBT: wurzeln.join(':'),
    FYOS_RUNNER_CONFIG: join(daten, 'runner-konfig.json'),
    FYOS_RUNNER_STORAGE: konfig.pi_durable.storage,
    FYOS_RUNNER_WORKSPACE: konfig.arbeitsbereiche?.standard?.pfad ?? arbeit,
    FYOS_DEVICE_ID: gerId,
    FYOS_DEVICE_NAME: `Dieser Computer (${rechnername})`,
    FYOS_DEVICE_KIND: kind,
    FYOS_HAUSMODELL_KEY: modell.schluessel,
  };
  return { konfig, umgebung, daten, wurzeln, modell, arbeit };
}

/** Ordner anlegen und die Konfigurationsdatei schreiben (ohne Geheimnisse, nur für den Besitzer lesbar). */
export function vorbereiten(u) {
  mkdirSync(u.daten, { recursive: true, mode: 0o700 });
  mkdirSync(u.arbeit, { recursive: true, mode: 0o700 });
  writeFileSync(u.umgebung.FYOS_RUNNER_CONFIG, JSON.stringify(u.konfig, null, 2) + '\n', { mode: 0o600 });
  chmodSync(u.umgebung.FYOS_RUNNER_CONFIG, 0o600);
}

async function main() {
  const hier = dirname(fileURLToPath(import.meta.url));
  // Im Bündel liegt der Runner in app/, im Monorepo unter deploy/runner/pi-durable, im öffentlichen fyos-agent
  // (Release 0.2) liegt dieses Programm in runner/lokal/ und der Runner einen Ordner darüber.
  const kandidaten = [join(hier, 'app'), resolve(hier, '..', '..', '..', 'deploy', 'runner', 'pi-durable'), resolve(hier, '..')];
  const runner = kandidaten.find((k) => existsSync(join(k, 'src', 'lokal.js')));
  if (!runner) throw new StartFehler('Runner-Code (src/lokal.js) nicht gefunden');
  const u = uebersetzen(process.env, process.argv.slice(2));
  vorbereiten(u);
  Object.assign(process.env, u.umgebung);
  if (!u.modell.eingerichtet) {
    console.warn(`[runner-lokal] Kein Modell eingerichtet (${join(u.daten, 'modell.json')}); Vorgabe ${u.modell.baseUrl}`);
  }
  // lokal.js liest `--config` aus der Umgebung (FYOS_RUNNER_CONFIG); eigene Argumente der Hülle sollen es nicht stören.
  process.argv.splice(2);
  await import(pathToFileURL(join(runner, 'src', 'lokal.js')).href);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((fehler) => {
    console.error(`[runner-lokal] ${fehler instanceof StartFehler ? fehler.message : (fehler?.stack ?? fehler)}`);
    process.exit(fehler instanceof StartFehler ? 2 : 1);
  });
}
