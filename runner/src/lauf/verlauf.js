/**
 * lauf/verlauf.js — der sichtbare Verlauf eines Gesprächs: EINE Definition, an EINER Stelle.
 *
 * Die Eigenheit von pi-durable (Anlass: Chat-Fehler vom 28.10.2026): `conv.context()` und der erste Snapshot des
 * Ereignisstroms liefern nur das AKTIVE FENSTER, also die Einträge ab dem letzten Kopf-Marker (`pi.reset` oder
 * `pi.compaction`). Nach „leeren“ bleibt dort nur der Marker, nach dem Verdichten die Zusammenfassung plus rund
 * 32k Token. Die Clients versprechen aber „der bisherige Verlauf bleibt sichtbar“ (befehle.js, #neu).
 * Darum gilt in FYOS:
 *
 *   - `aktivesFenster(conv)`   was das Modell sieht (Einträge und Nachrichten ab dem letzten Marker). Nur für Aufgaben,
 *                              die das Modell-Fenster meinen (Zugbeginn suchen, Größe schätzen).
 *   - `sichtbarerVerlauf(...)` was der Mensch sieht: die neuesten `limit` Einträge, aufsteigend, auch vor dem Marker.
 *   - `neuesteEintraege(...)`  dieselben Einträge, neueste zuerst (Suche nach einer Kennung).
 *
 * Wer „den Verlauf“ braucht, ruft eine dieser Funktionen. Wer `conv.entries` oder `conv.context` selbst ruft, hat die
 * Eigenheit wieder an einer zweiten Stelle (der Wächtertest `test/naht-wachter.test.js` sucht danach).
 */
import { KONTEXT } from './chord.js';

const SEITE_MAX = 200;

/** Die neuesten `n` Einträge, neueste zuerst, durch alle Marker hindurch (seitenweise gelesen). */
export async function neuesteEintraege(conv, n = 400) {
  const neueste = [];
  let cursor;
  do {
    const seite = await conv.entries({ order: 'descending' }, Math.min(SEITE_MAX, n - neueste.length), cursor, KONTEXT);
    neueste.push(...seite.items);
    cursor = seite.next;
  } while (cursor !== undefined && neueste.length < n);
  return neueste;
}

/** Der sichtbare Verlauf: die neuesten `limit` Einträge in aufsteigender Reihenfolge, auch vor `pi.reset`/`pi.compaction`. */
export async function sichtbarerVerlauf(conv, { limit = 400 } = {}) {
  return (await neuesteEintraege(conv, limit)).reverse();
}

/** Das aktive Fenster: `{ entries, messages }` ab dem letzten Kopf-Marker (was das Modell als Verlauf sieht). */
export async function aktivesFenster(conv) {
  return conv.context(KONTEXT);
}

/**
 * Das aktive Fenster eines Gesprächs innerhalb einer Aufgabe (`runtime` und `context` kommen aus dem Aufgaben-Handler,
 * `aufgabe({ phases: { x: async (task, runtime, context) => … } })`). Gleiche Eigenheit wie `aktivesFenster`.
 */
export function aktivesFensterImHandler(runtime, gespraechId, context) {
  return runtime.context(gespraechId, context);
}

/** Die Kennung des neuesten Eintrags (zum Abzweigen), oder `undefined` bei leerem Gespräch. */
export async function letzterEintragId(conv) {
  return (await neuesteEintraege(conv, 1))[0]?.id;
}

/**
 * Der Verlauf eines Gesprächs nach Kennung; `null`, wenn es das Gespräch nicht gibt.
 * @param {object} lauf Harness-Griff aus `oeffneLauf`.
 */
export async function verlaufVon(lauf, id, { limit = 400 } = {}) {
  const conv = await lauf.conversation(id, KONTEXT);
  if (!conv) return null;
  return sichtbarerVerlauf(conv, { limit });
}

/**
 * Die Ansicht eines Gesprächs für Clients: `voll` = sichtbarer Verlauf, sonst aktives Fenster.
 * `fenster` sagt dem Client, welches von beiden er bekommt; `messages` ist die Zahl der Nachrichten im aktiven Fenster.
 * @returns {Promise<{entries:Array, fenster:'voll'|'aktiv', messages:number}|null>}
 */
export async function ansichtVon(lauf, id, { voll = false, limit = 400 } = {}) {
  const conv = await lauf.conversation(id, KONTEXT);
  if (!conv) return null;
  const fenster = await aktivesFenster(conv);
  return {
    entries: voll ? await sichtbarerVerlauf(conv, { limit }) : fenster.entries,
    fenster: voll ? 'voll' : 'aktiv',
    messages: fenster.messages.length,
  };
}
