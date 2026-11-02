/**
 * token.js — der Runner startet nie ohne Zugangstoken.
 *
 * Der Runner führt Befehle aus (bash, ssh, Browser, Desktop). Ein offener Port auf 127.0.0.1 ist
 * deshalb nicht harmlos: jede Webseite im Browser des Menschen könnte ihn ansprechen. Ohne
 * gesetztes Token erzeugt der Runner einmal eines und legt es mit Modus 0600 ab.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function tokenSicherstellen(cfg) {
  const sec = cfg.pi_durable.security;
  if (sec.token) return { quelle: 'konfiguration', datei: null };
  const datei = sec.tokenDatei;
  if (existsSync(datei)) {
    const t = readFileSync(datei, 'utf8').trim();
    if (t.length >= 32) {
      sec.token = t;
      return { quelle: 'datei', datei };
    }
  }
  mkdirSync(dirname(datei), { recursive: true, mode: 0o700 });
  const neu = randomBytes(32).toString('hex');
  writeFileSync(datei, neu + '\n', { mode: 0o600 });
  chmodSync(datei, 0o600);
  sec.token = neu;
  return { quelle: 'neu', datei };
}
