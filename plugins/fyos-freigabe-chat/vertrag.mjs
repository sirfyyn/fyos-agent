/**
 * vertrag.mjs — die EINE Wahrheit ueber eine Freigabe, in JavaScript.
 *
 * Liest `freigabe_vertrag.json`. Dieselbe Datei (siehe `vertrag/freigabe_vertrag.json` im
 * Repo) kann auch eine Python-Seite lesen; so laufen Dienst und Plugin nicht auseinander.
 * Ohne Vertrag wirft das Laden laut: ein Hook, der ohne Vertrag laeuft, raet.
 *
 * Gesucht wird in dieser Reihenfolge: neben dieser Datei, im Bild unter
 * `/opt/fyos/fyos-freigabe-chat/`, dann `FYOS_FREIGABE_VERTRAG`.
 */

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HIER = dirname(fileURLToPath(import.meta.url));

function suche() {
  const kandidaten = [
    join(HIER, 'freigabe_vertrag.json'),
    '/opt/fyos/fyos-freigabe-chat/freigabe_vertrag.json',
    join(HIER, '..', '..', 'vertrag', 'freigabe_vertrag.json'),
    process.env.FYOS_FREIGABE_VERTRAG || '',
  ].filter(Boolean);
  for (const ort of kandidaten) {
    try {
      return JSON.parse(readFileSync(ort, 'utf8'));
    } catch {
      // naechster Ort
    }
  }
  throw new Error(
    `freigabe_vertrag.json nicht gefunden. Gesucht in: ${kandidaten.join(', ')}`,
  );
}

const ROH = suche();

/** Entscheidung -> Zielstatus. `null` heisst: keine Entscheidung, die Frage bleibt offen. */
export const ZIEL = Object.freeze(
  Object.fromEntries(
    Object.entries(ROH.antworten)
      .filter(([name]) => !name.startsWith('_'))
      .map(([name, eintrag]) => [name, eintrag.zielstatus ?? null]),
  ),
);

/** Frueherer Name -> kanonischer. */
export const ALIASE = Object.freeze({freigeben: 'genehmigen'});

export const STROM_ANGEFRAGT = ROH.stroeme.angefragt;
export const STROM_ERTEILT = ROH.stroeme.erteilt;
export const STROM_ABGELEHNT = ROH.stroeme.abgelehnt;
export const UHREN = Object.freeze({...ROH.uhren});
export const FORM = Object.freeze({...ROH.form});
export const KENNUNG = Object.freeze({...ROH.kennung});

/** Uebersetzt einen (moeglicherweise alten) Namen auf den kanonischen. */
export function kanonisch(entscheidung) {
  const e = String(entscheidung ?? '').trim().toLowerCase();
  return ALIASE[e] ?? e;
}

/**
 * Der Zielstatus einer Entscheidung — oder `null`, wenn es keine ist.
 *
 * `null` ist die ehrliche Antwort fuer „keine Entscheidung“: die Frage bleibt offen.
 * Fail-closed — der gefaehrliche Ausgang ist die Genehmigung.
 */
export function zielstatus(entscheidung) {
  return ZIEL[kanonisch(entscheidung)] ?? null;
}

/** Die Vertragsdatei selbst, fuer Tests und Diagnose. */
export const VERTRAG = ROH;
