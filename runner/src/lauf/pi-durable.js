/**
 * lauf/pi-durable.js — Adapter zu @earendil-works/pi-durable (nur dieser Ort in src/ importiert das Paket).
 *
 * Hier stehen die Namen, unter denen der Runner pi-durable kennt. Alles, was pi-durable anders nennt oder
 * künftig anders tun könnte (Optionen von `Harness.open`, Einstellungen, Speicher, Umgebung), wird hier
 * übersetzt. Die Aufrufer sehen nur die deutschen Namen aus `lauf/index.js`.
 *
 * Bekannte Durchlässigkeit (bewusst, siehe docs/current/PI-DURABLE-RUNNER.md#naht):
 *  - Dokument-Marken (`dokument(...)`, `NUTZUNG`, `LIVE`) sind pi-durable-Objekte; Tests und Aufrufer vergleichen sie per Identität.
 *  - Der Harness-Griff (`oeffneLauf` liefert ihn) und die Gesprächs-Griffe tragen pi-durable-Methoden
 *    (`snapshot`, `commit`, `conversation`, `submit`, …); die Fenster-Eigenheit des Verlaufs ist in `verlauf.js` gekapselt.
 *  - Aufgaben-Handler (`aufgabe(...)`) und Haken (`haken(...)`) erhalten pi-durable-Objekte (`runtime`, `tx`, `api`).
 */
import {
  AgentDoc,
  GenerationTask,
  Harness,
  LiveDoc,
  ToolTask,
  UsageDoc,
  configure,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  hook,
  section,
  watchEvents,
} from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { KONTEXT } from './chord.js';

// --- Bausteine, die der Runner definiert (Dokumente, Werkzeuge, Erweiterungen, Aufgaben, Haken) ---

/** Ein dauerhaftes Dokument anlegen (pi-durable: `defineDoc`). */
export const dokument = defineDoc;
/** Die dauerhafte Nutzung (Token, Kosten) je Gespräch (pi-durable: `UsageDoc`). */
export const NUTZUNG = UsageDoc;
/** Die Einstellung des Gesprächs als Dokument (Modell, Ordner, …; pi-durable: `AgentDoc`): eine Dokumentlesung, billiger als `agentVon`. */
export const AGENT = AgentDoc;
/** Der Live-Stand eines Gesprächs: läuft ein Zug, welche Aufgabe (pi-durable: `LiveDoc`). */
export const LIVE = LiveDoc;
/** Ein Werkzeug definieren (pi-durable: `defineTool`). */
export const werkzeug = defineTool;
/** Eine Erweiterung bündeln: Werkzeuge, Abschnitte, Haken (pi-durable: `defineExtension`). */
export const erweiterung = defineExtension;
/** Ein Abschnitt des Systemkopfs, der sich später ändern darf (pi-durable: `section`). */
export const abschnitt = section;
/** Einen Haken in einen Ablauf hängen (pi-durable: `hook`). Ziele: `HAKEN_ZIEL`. */
export const haken = hook;
/** Ablauf „Werkzeugaufruf“ als Ziel eines Hakens (pi-durable: `ToolTask`). */
export const WERKZEUG_AUFRUF = ToolTask;
/** Ablauf „Modellerzeugung“ als Ziel eines Hakens (pi-durable: `GenerationTask`). */
export const ERZEUGUNG = GenerationTask;
/** Die Abläufe, an die ein Haken passt. */
export const HAKEN_ZIEL = { werkzeugAufruf: WERKZEUG_AUFRUF, erzeugung: ERZEUGUNG };
/** Eine dauerhafte Aufgabe definieren (Läufe, Piloten, Nachtwerkstatt; pi-durable: `defineTask`). */
export const aufgabe = defineTask;
/** Ein Gespräch in einer Transaktion neu einstellen (Modell, Arbeitsordner, Erweiterungen; pi-durable: `configure`). */
export const konfigurieren = configure;
/** Ein leeres Werkzeugregister (pi-durable: `createRegistry`); `.install(...)` nimmt Erweiterungen und `STANDARD_WERKZEUGE`. */
export const registerErzeugen = createRegistry;
/** Lesen, Schreiben, Bearbeiten und Bash (pi-durable: `CodingTools`). */
export const STANDARD_WERKZEUGE = CodingTools;

// --- Speicher ---

/** Die SQLite-Datei öffnen, in der Gespräche, Dokumente und Aufgaben liegen (Node-Treiber von pi-durable). */
export function speicherOeffnen(datei) {
  return openNodeSqliteStorage(datei);
}

// --- Gespräche öffnen ---

/**
 * Den dauerhaften Harness öffnen. Eigene Optionsnamen, hier auf pi-durable übersetzt:
 *
 * @param {object} speicher                     Ergebnis von `speicherOeffnen`.
 * @param {object} o
 * @param {object} o.modelle                    Modellbestand (`modelleErzeugen()` mit Providern).
 * @param {object} o.register                   Werkzeugregister (`registerErzeugen()`).
 * @param {{standardCwd?:string, shell?:string, env?:object}} o.umgebung  Wo Werkzeuge ausführen: Ordner, Shell, Umgebungsvariablen.
 * @param {Array}  [o.standardErweiterungen]    Wenn gesetzt: nur diese Erweiterungen gelten standardmäßig.
 * @param {number} o.streamZeitlimitMs          Zeitlimit eines Modellstroms.
 * @param {number} o.wiederholungen             Wiederholungsversuche bei Fehlern des Modells.
 * @param {'parallel'} [o.werkzeugAusfuehrung]   Wert wird an pi-durable (`toolExecution`) gereicht; heute nur 'parallel' in Gebrauch.
 * @param {{an:boolean, reserve:number, behalten:number, hintergrund:number, jeModell?:object}} o.verdichtung
 * @param {(tx:object, eintrag:{id:*, owner?:*, parent?:*})=>Promise<void>} [o.beiGespraechAngelegt]
 * @param {(fehler:Error, info:object)=>void} [o.beiBericht]  Fehler und Meldungen aus dem Hintergrund.
 * @returns {Promise<object>} der Harness-Griff (`snapshot`, `commit`, `conversation`, `createConversation`, `root`, `resume`, `close`, `closed`, …)
 */
export function oeffneLauf(speicher, o) {
  const cwdStandard = o.umgebung?.standardCwd ?? process.cwd();
  return Harness.open(
    speicher,
    {
      models: o.modelle,
      registry: o.register,
      env: ({ cwd }) =>
        new NodeExecutionEnv({
          cwd: cwd ?? cwdStandard,
          shellPath: o.umgebung?.shell || undefined,
          shellEnv: { ...process.env, ...(o.umgebung?.env ?? {}) },
        }),
      settings: {
        ...(o.standardErweiterungen ? { extensions: o.standardErweiterungen } : {}),
        stream: { timeoutMs: o.streamZeitlimitMs },
        retry: { maxRetries: o.wiederholungen },
        toolExecution: o.werkzeugAusfuehrung ?? 'parallel',
        compaction: {
          enabled: o.verdichtung.an,
          reserveTokens: o.verdichtung.reserve,
          keepRecentTokens: o.verdichtung.behalten,
          backgroundTokens: o.verdichtung.hintergrund,
          ...(o.verdichtung.jeModell ? { modelOverrides: o.verdichtung.jeModell } : {}),
        },
      },
      conversationCreated: o.beiGespraechAngelegt,
      onReport: o.beiBericht,
    },
    KONTEXT,
  );
}

// --- Ereignisse ---

/** Den Ereignisstrom eines Gesprächs öffnen: `{ snapshot, start(listener), stop() }` (pi-durable: `watchEvents`). */
export function ereignisStromOeffnen(lauf, gespraechId) {
  return watchEvents(lauf, gespraechId, KONTEXT);
}
