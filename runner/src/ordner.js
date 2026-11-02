/**
 * ordner.js — „Ordner je Sitzung“: frei wählbare Arbeitsordner, aber nur unterhalb erlaubter Wurzeln.
 *
 * Die Wurzeln kommen aus der Umgebung des Runners (`FYOS_RUNNER_ORDNER_ERLAUBT`, durch `:` getrennt, absolute Pfade).
 * Ohne Wert ist die Funktion aus: keine Wurzeln, nichts wählbar. Im Quelltext stehen keine Standardwurzeln.
 *
 * Prüfung in zwei Stufen, damit kein Pfad vor der Entscheidung das Dateisystem berührt:
 *   1. rein textlich: absolut, kein Nullbyte, kein `..`-Teil, innerhalb einer Wurzel (nach Normalisieren);
 *   2. nach `realpath` (Symlinks aufgelöst) erneut innerhalb des `realpath` einer Wurzel.
 * Ein Symlink, der aus der Wurzel hinausführt, scheitert an Stufe 2.
 *
 * Wichtig (docs/current/PI-DURABLE-RUNNER.md#ordner-je-sitzung): Das ist eine Auswahlgrenze für den Menschen in der App,
 * keine Sandbox. Die Werkzeuge der Sitzung laufen mit den Rechten des Dienstnutzers und können mit `cd` anderswohin.
 */
import { readdir, realpath, stat } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, posix, sep } from 'node:path';

import { nameGesperrt, pfadGesperrt } from './sperre.js';

export const MAX_EINTRAEGE = 500;
const MAX_PFAD = 4096;

export class OrdnerFehler extends Error {
  /** @param {number} status HTTP-Status  @param {string} code kurzer Maschinenname (`ausserhalb`, `ungueltig`, ...)  @param {string} meldung */
  constructor(status, code, meldung) {
    super(meldung);
    this.status = status;
    this.code = code;
  }
}

/** `a:b:c` -> normalisierte absolute Pfade ohne Doppelte; Unbrauchbares (relativ, leer, Nullbyte) fällt weg. */
export function wurzelnLesen(roh) {
  const out = [];
  for (const teil of String(roh ?? '').split(':')) {
    const t = teil.trim();
    if (!t || t.includes('\0') || !isAbsolute(t)) continue;
    const n = posix.normalize(t).replace(/\/+$/, '') || '/';
    // Die Wurzel des Dateisystems freizugeben hieße alles freizugeben: bewusst nicht erlaubt.
    if (n === '/') continue;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

export function innerhalb(pfad, wurzel) {
  return pfad === wurzel || pfad.startsWith(wurzel + sep);
}

/** Textliche Vorprüfung. Gibt den normalisierten Pfad zurück. */
export function textlich(wurzeln, roh) {
  if (typeof roh !== 'string' || roh === '') throw new OrdnerFehler(400, 'ungueltig', 'Pfad fehlt oder ist kein Text');
  if (roh.includes('\0')) throw new OrdnerFehler(400, 'ungueltig', 'Pfad enthält ein Nullbyte');
  if (roh.length > MAX_PFAD) throw new OrdnerFehler(400, 'ungueltig', 'Pfad zu lang');
  if (!isAbsolute(roh)) throw new OrdnerFehler(400, 'ungueltig', 'Pfad muss absolut sein');
  if (!wurzeln.length) throw new OrdnerFehler(403, 'ausserhalb', 'Ordnerwahl nicht freigegeben (keine erlaubten Wurzeln eingerichtet)');
  if (roh.split('/').includes('..')) throw new OrdnerFehler(403, 'ausserhalb', 'Pfade mit „..“ sind nicht erlaubt');
  const n = posix.normalize(roh).replace(/\/+$/, '') || '/';
  if (!wurzeln.some((w) => innerhalb(n, w))) throw new OrdnerFehler(403, 'ausserhalb', 'Pfad liegt außerhalb der erlaubten Wurzeln');
  return n;
}

/** Der Pfad relativ zur ersten Wurzel, in der er liegt (`a/b`); liegt er in keiner, der ganze Pfad. */
export function relativ(pfad, wurzeln) {
  const w = wurzeln.find((x) => innerhalb(pfad, x));
  return w ? pfad.slice(w.length).replace(/^\/+/, '') : pfad;
}

/** `realpath` jeder Wurzel, die es gibt (nicht vorhandene Wurzeln fallen weg). */
export async function echteWurzeln(wurzeln) {
  const out = [];
  for (const w of wurzeln) {
    try {
      out.push(await realpath(w));
    } catch {
      /* Wurzel existiert (noch) nicht */
    }
  }
  return out;
}

/**
 * Prüft einen Ordner und gibt seinen `realpath` zurück.
 * Fehler: 400 ungueltig | 403 ausserhalb | 404 nicht gefunden | 400 kein Ordner.
 */
export async function ordnerPruefen(wurzeln, roh) {
  const n = textlich(wurzeln, roh);
  let echt;
  try {
    echt = await realpath(n);
  } catch (fehler) {
    if (fehler?.code === 'ENOENT' || fehler?.code === 'ENOTDIR') throw new OrdnerFehler(404, 'nicht_gefunden', 'Ordner nicht gefunden');
    if (fehler?.code === 'EACCES') throw new OrdnerFehler(403, 'verwehrt', 'Zugriff auf den Ordner verwehrt');
    throw fehler;
  }
  const echteW = await echteWurzeln(wurzeln);
  if (!echteW.some((w) => innerhalb(echt, w))) throw new OrdnerFehler(403, 'ausserhalb', 'Pfad führt (über einen Link) aus den erlaubten Wurzeln hinaus');
  let st;
  try {
    st = await stat(echt);
  } catch {
    throw new OrdnerFehler(404, 'nicht_gefunden', 'Ordner nicht gefunden');
  }
  if (!st.isDirectory()) throw new OrdnerFehler(400, 'kein_ordner', 'Das ist kein Ordner');
  return { normal: n, echt };
}

/**
 * Für `GET /api/ordner`. Ohne Pfad nur die Wurzeln. Mit Pfad: die Unterordner (ohne versteckte, ohne Links aus den Wurzeln
 * hinaus), alphabetisch, höchstens MAX_EINTRAEGE.
 */
export async function ordnerAuflisten(wurzeln, pfad, opt = {}) {
  if (pfad === undefined || pfad === null || pfad === '') {
    return { wurzeln, pfad: null, eintraege: [], erlaubt: wurzeln.length > 0 };
  }
  const mitDateien = opt.dateien === true;
  const sperre = opt.sperre ?? [];
  const { normal, echt } = await ordnerPruefen(wurzeln, pfad);
  const echteW = await echteWurzeln(wurzeln);
  if (mitDateien) {
    // Ein gesperrter Ordner (z. B. `.ssh`) wird auch dann nicht aufgelistet, wenn man seinen Pfad kennt.
    const rel = relativ(normal, wurzeln);
    const relEcht = relativ(echt, echteW);
    if (pfadGesperrt(rel, sperre) || pfadGesperrt(relEcht, sperre)) {
      throw new OrdnerFehler(403, 'gesperrt', 'Dieser Ordner ist gesperrt (deutet auf Geheimnisse hin)');
    }
  }
  let rohe;
  try {
    rohe = await readdir(echt, { withFileTypes: true });
  } catch (fehler) {
    if (fehler?.code === 'EACCES' || fehler?.code === 'EPERM') throw new OrdnerFehler(403, 'verwehrt', 'Zugriff auf den Ordner verwehrt');
    throw fehler;
  }
  const namen = [];
  const dateiNamen = [];
  for (const d of rohe) {
    if (d.name.startsWith('.')) continue;
    if (mitDateien && nameGesperrt(d.name, sperre)) continue;
    if (d.isDirectory()) {
      namen.push(d.name);
    } else if (mitDateien && d.isFile()) {
      dateiNamen.push(d.name);
    } else if (d.isSymbolicLink()) {
      try {
        const ziel = await realpath(`${echt}/${d.name}`);
        if (!echteW.some((w) => innerhalb(ziel, w))) continue;
        const st = await stat(ziel);
        if (st.isDirectory()) {
          namen.push(d.name);
        } else if (mitDateien && st.isFile() && !pfadGesperrt(relativ(ziel, echteW), sperre)) {
          dateiNamen.push(d.name);
        }
      } catch {
        /* kaputter Link: weglassen */
      }
    }
  }
  const ordnung = (a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);
  namen.sort(ordnung);
  dateiNamen.sort(ordnung);
  const abgeschnitten = namen.length + dateiNamen.length > MAX_EINTRAEGE;
  const eintraege = namen.slice(0, MAX_EINTRAEGE).map((name) => ({ name, ordner: true }));
  if (mitDateien) {
    // Ordner zuerst, dann Dateien, zusammen höchstens MAX_EINTRAEGE. Die Größe nur für die gezeigten Dateien (ein stat je Datei).
    for (const name of dateiNamen.slice(0, Math.max(0, MAX_EINTRAEGE - eintraege.length))) {
      try {
        eintraege.push({ name, ordner: false, groesse: (await stat(`${echt}/${name}`)).size });
      } catch {
        /* zwischenzeitlich verschwunden: weglassen */
      }
    }
  }
  return { wurzeln, pfad: normal, eintraege, erlaubt: true, ...(abgeschnitten ? { abgeschnitten: true } : {}) };
}

/**
 * Lokaler Modus (`FYOS_RUNNER_LOKAL=1`): eine weitere Wurzel zu den erlaubten hinzunehmen (`POST /api/ordner/erlauben`).
 * Dieselben Prüfungen wie bei den Wurzeln aus der Umgebung und bei der Ordnerwahl: Text, absolut, kein Nullbyte, kein `..`-Teil,
 * nicht die Dateisystemwurzel; dazu muss `realpath` ein vorhandener Ordner sein und darf auch nicht `/` sein.
 * Gespeichert wird der normalisierte Pfad (wie bei `wurzelnLesen`), damit textliche und `realpath`-Stufe zusammenpassen.
 * Verändert `wurzeln` an Ort und Stelle (die Liste ist die der Konfiguration) und gibt sie zurück. Fehler: OrdnerFehler.
 */
export async function wurzelHinzufuegen(wurzeln, roh) {
  if (typeof roh !== 'string' || roh === '') throw new OrdnerFehler(400, 'ungueltig', 'Pfad fehlt oder ist kein Text');
  if (roh.includes('\0')) throw new OrdnerFehler(400, 'ungueltig', 'Pfad enthält ein Nullbyte');
  if (roh.length > MAX_PFAD) throw new OrdnerFehler(400, 'ungueltig', 'Pfad zu lang');
  if (!isAbsolute(roh)) throw new OrdnerFehler(400, 'ungueltig', 'Pfad muss absolut sein');
  if (roh.split('/').includes('..')) throw new OrdnerFehler(403, 'ausserhalb', 'Pfade mit „..“ sind nicht erlaubt');
  const n = posix.normalize(roh).replace(/\/+$/, '') || '/';
  if (n === '/') throw new OrdnerFehler(403, 'ausserhalb', 'Die Wurzel des Dateisystems kann keine erlaubte Wurzel sein');
  let echt;
  try {
    echt = await realpath(n);
  } catch (fehler) {
    if (fehler?.code === 'ENOENT' || fehler?.code === 'ENOTDIR') throw new OrdnerFehler(404, 'nicht_gefunden', 'Ordner nicht gefunden');
    if (fehler?.code === 'EACCES') throw new OrdnerFehler(403, 'verwehrt', 'Zugriff auf den Ordner verwehrt');
    throw fehler;
  }
  if (echt === '/') throw new OrdnerFehler(403, 'ausserhalb', 'Die Wurzel des Dateisystems kann keine erlaubte Wurzel sein');
  let st;
  try {
    st = await stat(echt);
  } catch {
    throw new OrdnerFehler(404, 'nicht_gefunden', 'Ordner nicht gefunden');
  }
  if (!st.isDirectory()) throw new OrdnerFehler(400, 'kein_ordner', 'Das ist kein Ordner');
  if (!wurzeln.includes(n)) wurzeln.push(n);
  return wurzeln;
}

/**
 * Das Arbeitsverzeichnis einer bestehenden Sitzung: der gemerkte Ordner, solange er noch erlaubt, vorhanden und ein
 * Ordner ist, sonst `null` (dann gilt wieder der Arbeitsbereich). So wirkt „Funktion aus“ auch auf alte Sitzungen.
 */
export function ordnerNochGueltig(wurzeln, gemerkt) {
  if (!gemerkt || typeof gemerkt !== 'string' || !wurzeln.length) return null;
  try {
    const n = textlich(wurzeln, gemerkt);
    const echt = realpathSync(n);
    const ok = wurzeln.some((w) => {
      try {
        return innerhalb(echt, realpathSync(w));
      } catch {
        return false;
      }
    });
    return ok && statSync(echt).isDirectory() ? echt : null;
  } catch {
    return null;
  }
}
