/**
 * lauf/ereignisse.js — Ereignisstrom eines Gesprächs mit unseren Namen.
 *
 * pi-durable nennt Ereignisse englisch (`message_end`, `run_end`, …). Der Runner schaltet nur noch über
 * `EREIGNIS.*` und `ereignisArt(e)`; kommt pi-durable (oder ein Ersatz) mit anderen Namen, ändert sich allein
 * die Tabelle `PI_NAMEN`. Die Nutzlast der Ereignisse bleibt unverändert (Felder `message`, `change`, `entry`, …),
 * ebenso die Form auf der Leitung zum Web-Client: Der SSE-Weg reicht Ereignisse roh durch (siehe Rest-Lecks).
 */
import { ereignisStromOeffnen } from './pi-durable.js';
import { sichtbarerVerlauf } from './verlauf.js';
import { KONTEXT } from './chord.js';

/** Unsere Ereignisnamen. Stabil; sie ändern sich nicht, wenn pi-durable umbenennt. */
export const EREIGNIS = Object.freeze({
  STAND: 'stand', // Überlauf: ein neuer Gesamtstand statt einzelner Ereignisse
  NACHRICHT_START: 'nachricht_start',
  NACHRICHT_UPDATE: 'nachricht_update',
  NACHRICHT_ENDE: 'nachricht_ende',
  WERKZEUG_START: 'werkzeug_start',
  WERKZEUG_UPDATE: 'werkzeug_update',
  WERKZEUG_ENDE: 'werkzeug_ende',
  EINTRAG: 'eintrag', // ein Verlaufseintrag wurde angehängt
  ZUG_START: 'zug_start',
  ZUG_ENDE: 'zug_ende',
  AUFGABE_FEHLGESCHLAGEN: 'aufgabe_fehlgeschlagen',
  VERDICHTEN_START: 'verdichten_start',
  VERDICHTEN_ENDE: 'verdichten_ende',
});

/** Unser Name → Name in pi-durable. Einzige Übersetzungstabelle. */
const PI_NAMEN = Object.freeze({
  [EREIGNIS.STAND]: 'snapshot',
  [EREIGNIS.NACHRICHT_START]: 'message_start',
  [EREIGNIS.NACHRICHT_UPDATE]: 'message_update',
  [EREIGNIS.NACHRICHT_ENDE]: 'message_end',
  [EREIGNIS.WERKZEUG_START]: 'tool_execution_start',
  [EREIGNIS.WERKZEUG_UPDATE]: 'tool_execution_update',
  [EREIGNIS.WERKZEUG_ENDE]: 'tool_execution_end',
  [EREIGNIS.EINTRAG]: 'entry_appended',
  [EREIGNIS.ZUG_START]: 'run_start',
  [EREIGNIS.ZUG_ENDE]: 'run_end',
  [EREIGNIS.AUFGABE_FEHLGESCHLAGEN]: 'task_failed',
  [EREIGNIS.VERDICHTEN_START]: 'compaction_start',
  [EREIGNIS.VERDICHTEN_ENDE]: 'compaction_end',
});

const UNSER_NAME = Object.freeze(Object.fromEntries(Object.entries(PI_NAMEN).map(([unser, pi]) => [pi, unser])));

/**
 * Unser Name eines Ereignisses. Unbekannte Ereignisse behalten den Namen von pi-durable (sie fallen in jedem
 * `switch` durch, wie bisher); ein Ereignis mit eigenem Feld `art` (schon übersetzt) bleibt, wie es ist.
 */
export function ereignisArt(e) {
  return e?.art ?? UNSER_NAME[e?.type] ?? e?.type;
}

/** pi-durable-Name zu einem unserer Namen (für Tests und Fehlersuche). */
export function piName(unser) {
  return PI_NAMEN[unser];
}

/**
 * Ereignisse eines Gesprächs abonnieren.
 *
 *   const strom = await ereignisse(lauf, id);   // strom.snapshot = Stand beim Anhängen (aktives Fenster)
 *   strom.start(async (liste) => {...});        // liste = Ereignisse; Namen über ereignisArt(e) / EREIGNIS.*
 *   await strom.stop();
 *
 * Mit `{ voll: true }` ersetzt der sichtbare Verlauf (auch vor Reset und Verdichtung, `limit` Einträge) die Einträge des
 * ersten Snapshots; Ereignisse danach hängen nur an, Clients ignorieren schon bekannte Kennungen.
 */
export async function ereignisse(lauf, id, { voll = false, limit = 400 } = {}) {
  const strom = await ereignisStromOeffnen(lauf, id);
  if (!voll) return strom;
  const conv = await lauf.conversation(id, KONTEXT);
  const eintraege = conv ? await sichtbarerVerlauf(conv, { limit }) : null;
  return {
    snapshot: { ...strom.snapshot, entries: eintraege ?? strom.snapshot.entries, fenster: 'voll' },
    start: (listener) => strom.start(listener),
    stop: () => strom.stop(),
  };
}
