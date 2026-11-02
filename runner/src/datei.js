/**
 * datei.js — eine Textdatei lesen (`GET /api/datei`), nur lesend, nur innerhalb des Arbeitsordners der Sitzung oder einer
 * erlaubten Wurzel (`FYOS_RUNNER_ORDNER_ERLAUBT`).
 *
 * Prüfung in Stufen, damit kein Pfad vor der Entscheidung das Dateisystem berührt:
 *   1. textlich: absolut, kein Nullbyte, kein `..`-Teil, innerhalb einer Basis (erlaubte Wurzeln und, falls vorhanden, der
 *      Ordner der Sitzung), Sperrliste (`sperre.js`) auf die Pfadteile unterhalb der Basis -> kein Orakel über Dateinamen;
 *   2. `realpath` (Symlinks aufgelöst) muss erneut innerhalb des `realpath` einer Basis liegen, und auch der aufgelöste Pfad
 *      darf nicht in der Sperrliste stehen (ein Link `harmlos.txt` auf `.env` scheitert);
 *   3. geöffnet wird der aufgelöste Pfad mit O_NOFOLLOW und O_NONBLOCK (ein FIFO blockiert nicht), danach `fstat` auf dem
 *      offenen Deskriptor: nur reguläre Dateien (keine Geräte, FIFOs, Sockets, Ordner). Gelesen werden höchstens `max` Byte.
 * Der Inhalt wird als UTF-8 gelesen (ungültige Folgen werden ersetzt, ein mitten im Zeichen abgeschnittener Schluss entfällt)
 * und wie in der Verlaufsansicht geschwärzt (`schwaerzen.js`, zeilenweise).
 */
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { OrdnerFehler, echteWurzeln, innerhalb, relativ, textlich } from './ordner.js';
import { schwaerzenText } from './schwaerzen.js';
import { pfadGesperrt } from './sperre.js';

export const MAX_STANDARD = 200_000;
export const MAX_HOECHST = 1_048_576;
const ERKENNUNG = 8192;

/** `max` aus der Abfrage: fehlt -> Standard; keine ganze Zahl >= 1 -> 400; über dem Höchstwert -> 413. */
export function maxLesen(roh) {
  if (roh === undefined || roh === null || roh === '') return MAX_STANDARD;
  if (!/^\d{1,12}$/.test(String(roh)) || Number(roh) < 1) throw new OrdnerFehler(400, 'ungueltig', 'max muss eine ganze Zahl ab 1 sein');
  const n = Number(roh);
  if (n > MAX_HOECHST) throw new OrdnerFehler(413, 'zu_gross', `max darf höchstens ${MAX_HOECHST} Byte sein`);
  return n;
}

/** Schneidet einen unvollständigen UTF-8-Schluss ab (nur nötig, wenn mitten in der Datei abgeschnitten wurde). */
function vollstaendigeFolge(buf) {
  let i = buf.length;
  let zurueck = 0;
  while (i > 0 && zurueck < 4) {
    i -= 1;
    zurueck += 1;
    const b = buf[i];
    if ((b & 0xc0) === 0x80) continue; // Fortsetzungsbyte: weiter zum Anfangsbyte
    const erwartet = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return erwartet > zurueck ? buf.subarray(0, i) : buf;
  }
  return buf;
}

/**
 * @param {{ wurzeln: string[], basis?: string|null, sperre?: string[], pfad: unknown, max?: unknown }} p
 * `basis`: der (schon geprüfte, aufgelöste) Ordner der Sitzung, oder null. Fehler: OrdnerFehler.
 */
export async function dateiLesen({ wurzeln, basis = null, sperre = [], pfad, max }) {
  const grenze = maxLesen(max);
  const basen = basis ? [...wurzeln, basis] : [...wurzeln];
  const n = textlich(basen, pfad);
  if (pfadGesperrt(relativ(n, basen), sperre)) throw new OrdnerFehler(403, 'gesperrt', 'Diese Datei ist gesperrt (deutet auf Geheimnisse hin)');

  let echt;
  try {
    echt = await realpath(n);
  } catch (fehler) {
    if (fehler?.code === 'ENOENT' || fehler?.code === 'ENOTDIR') throw new OrdnerFehler(404, 'nicht_gefunden', 'Datei nicht gefunden');
    if (fehler?.code === 'EACCES') throw new OrdnerFehler(403, 'verwehrt', 'Zugriff auf die Datei verwehrt');
    if (fehler?.code === 'ELOOP') throw new OrdnerFehler(400, 'ungueltig', 'Zu viele Links hintereinander');
    throw fehler;
  }
  const echteBasen = await echteWurzeln(basen);
  if (!echteBasen.some((b) => innerhalb(echt, b))) throw new OrdnerFehler(403, 'ausserhalb', 'Pfad führt (über einen Link) aus dem erlaubten Bereich hinaus');
  if (pfadGesperrt(relativ(echt, echteBasen), sperre)) throw new OrdnerFehler(403, 'gesperrt', 'Diese Datei ist gesperrt (deutet auf Geheimnisse hin)');

  // Erst der Typ am aufgelösten Pfad (Sockets lassen sich nicht öffnen, FIFOs und Geräte sollen gar nicht erst geöffnet werden).
  try {
    if (!(await lstat(echt)).isFile()) throw new OrdnerFehler(400, 'keine_datei', 'Das ist keine reguläre Datei');
  } catch (fehler) {
    if (fehler instanceof OrdnerFehler) throw fehler;
    if (fehler?.code === 'ENOENT' || fehler?.code === 'ENOTDIR') throw new OrdnerFehler(404, 'nicht_gefunden', 'Datei nicht gefunden');
    if (fehler?.code === 'EACCES' || fehler?.code === 'EPERM') throw new OrdnerFehler(403, 'verwehrt', 'Zugriff auf die Datei verwehrt');
    throw fehler;
  }
  let fh;
  try {
    fh = await open(echt, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (fehler) {
    if (fehler?.code === 'ENOENT') throw new OrdnerFehler(404, 'nicht_gefunden', 'Datei nicht gefunden');
    if (fehler?.code === 'EACCES' || fehler?.code === 'EPERM') throw new OrdnerFehler(403, 'verwehrt', 'Zugriff auf die Datei verwehrt');
    if (fehler?.code === 'ELOOP' || fehler?.code === 'ENXIO' || fehler?.code === 'EISDIR') throw new OrdnerFehler(400, 'keine_datei', 'Das ist keine reguläre Datei');
    throw fehler;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new OrdnerFehler(400, 'keine_datei', 'Das ist keine reguläre Datei');
    const groesse = st.size;
    const abgeschnitten = groesse > grenze;
    const lesen = Math.min(groesse, Math.max(grenze, ERKENNUNG));
    const buf = Buffer.alloc(lesen);
    let gelesen = 0;
    while (gelesen < lesen) {
      const { bytesRead } = await fh.read(buf, gelesen, lesen - gelesen, gelesen);
      if (bytesRead === 0) break;
      gelesen += bytesRead;
    }
    const daten = buf.subarray(0, gelesen);
    if (daten.subarray(0, ERKENNUNG).includes(0)) return { pfad: echt, groesse, binaer: true };
    let teil = daten.subarray(0, Math.min(gelesen, grenze));
    if (abgeschnitten) teil = vollstaendigeFolge(teil);
    const roh = new TextDecoder('utf-8', { fatal: false }).decode(teil).replace(/\0/g, '�');
    const { text, geschwaerzt } = schwaerzenText(roh);
    return {
      pfad: echt,
      groesse,
      text,
      abgeschnitten,
      binaer: false,
      geaendert: Math.round(st.mtimeMs),
      ...(geschwaerzt ? { geschwaerzt: true } : {}),
    };
  } finally {
    await fh.close().catch(() => {});
  }
}
