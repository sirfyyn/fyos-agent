/**
 * spielmodus.js — gehört der Knoten gerade dem Spiel (oder Besitzer' Pause)?
 *
 * Gleiche Regeln wie `_spielmodus_an` im RPC-Runner (agent_runner.py):
 *  - eine Marke gilt, solange die Datei liegt;
 *  - `*.nachhut` enthält eine PID und gilt nur, solange der Prozess lebt (nach hartem Aus bleibt sie liegen);
 *  - `*.kid` kann eine Endzeit in `<marke>.bis` (Epoche, Sekunden) tragen und gilt danach nicht mehr;
 *  - fehlt die `.bis`-Datei, zählt allein die Existenz.
 * Eine Marke, die als veraltet erkannt wird, meldet sich genau einmal im Log.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

export function pidLebt(pfad, { lesen = (p) => readFileSync(p, 'utf8'), kill = process.kill } = {}) {
  let pid;
  try {
    pid = Number.parseInt(String(lesen(pfad)).trim(), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
  } catch (fehler) {
    return fehler?.code === 'EPERM';
  }
  return true;
}

export function markeAbgelaufen(pfad, { jetzt = () => Date.now() / 1000, lesen = (p) => readFileSync(p, 'utf8') } = {}) {
  let bis;
  try {
    bis = Number.parseInt(String(lesen(`${pfad}.bis`)).trim(), 10);
  } catch {
    return false;
  }
  return Number.isInteger(bis) && jetzt() > bis;
}

export class Spielmodus {
  constructor(pfade = [], { log = (z) => console.log(z), existiert = existsSync, ...optionen } = {}) {
    this.pfade = (Array.isArray(pfade) ? pfade : []).map(String);
    this.log = log;
    this.existiert = existiert;
    this.optionen = optionen;
    this._gemeldet = new Set();
  }

  /** Name der Marke, die gilt, oder `null`. */
  grund() {
    for (const pfad of this.pfade) {
      if (!this.existiert(pfad)) continue;
      const name = basename(pfad);
      if (name.endsWith('spielmodus.nachhut') && !pidLebt(pfad, this.optionen)) {
        this.#veraltet(pfad, 'ohne lebenden Prozess');
        continue;
      }
      if (name.endsWith('spielmodus.kid') && markeAbgelaufen(pfad, this.optionen)) {
        this.#veraltet(pfad, 'abgelaufen');
        continue;
      }
      return name;
    }
    return null;
  }

  an() {
    return this.grund() !== null;
  }

  #veraltet(pfad, warum) {
    if (this._gemeldet.has(pfad)) return;
    this._gemeldet.add(pfad);
    this.log(`[fyos-runner] Spielmodus-Marke ${pfad} ${warum} — gilt als vorbei`);
  }
}
