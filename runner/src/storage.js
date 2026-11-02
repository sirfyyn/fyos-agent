/**
 * storage.js — die dauerhafte Ablage.
 *
 * Eine SQLite-Datei je Gerät. Gespräche, Werkzeugaufrufe, Aufgaben, Freigaben und der geteilte
 * Zustand liegen in derselben Datei; deshalb ist ein Neustart kein Datenverlust, sondern ein
 * Fortsetzen. Der Ordner wird beim ersten Start angelegt.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { speicherOeffnen } from './lauf/index.js';

export async function oeffneSpeicher(datei) {
  mkdirSync(dirname(datei), { recursive: true });
  return speicherOeffnen(datei);
}
