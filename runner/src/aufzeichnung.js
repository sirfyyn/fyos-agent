/**
 * aufzeichnung.js — Eingang, Weltmodell und Reflex-Entscheidungen als JSONL (wie `rosbag`).
 *
 * Port von `Aufzeichnung` aus dem RPC-Runner. Eine Datei je Tag (`aufzeichnung-JJJJ-MM-TT.jsonl`),
 * jede Zeile `{t, art, …}` mit art `eingang` (Ereignis + Live-Angaben), `welt` (Bild nach dem
 * Herzschlag), `entscheidung` (Reflexe) und `zug` (was an pi ging, mit Weltblock); dazu `steuer`,
 * `sitzung`, `bericht`, `unterbrechung`. Abspielen: `scripts/wiedergabe.mjs`.
 * Über `max_mb_tag` hinaus wird nicht weitergeschrieben (Platz auf hauptserver).
 *
 * Konfiguration wie im RPC-Runner: `cfg.aufzeichnung = { an, ordner, max_mb_tag }`; ohne `ordner`
 * liegt sie neben dem Zustand (`<Ordner von pi_durable.storage>/aufzeichnung`).
 */
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pfadAufloesen } from './config.js';

const zweistellig = (n) => String(n).padStart(2, '0');

export class Aufzeichnung {
  constructor({ cfg = {}, log = (z) => console.log(z), jetzt = () => Date.now(), ordner, an, max_mb_tag } = {}) {
    const auf = cfg.aufzeichnung && typeof cfg.aufzeichnung === 'object' ? cfg.aufzeichnung : {};
    const storage = cfg.pi_durable?.storage;
    this.ordner =
      ordner ??
      (auf.ordner ? pfadAufloesen(auf.ordner) : join(storage ? dirname(storage) : process.cwd(), 'aufzeichnung'));
    this._an = Boolean(an ?? auf.an ?? false);
    this.maxBytes = Math.trunc(Number(max_mb_tag ?? auf.max_mb_tag ?? 200) * 1024 * 1024);
    this.log = log;
    this._jetzt = jetzt;
    this._pfad = null;
    this._bytes = 0;
    this._voll = false;
    this.zeilen = 0;
    this.fehler = null;
  }

  /** Ist die Aufzeichnung eingeschaltet? */
  an() {
    return this._an;
  }

  schalten(an) {
    this._an = Boolean(an);
    this.log(`[fyos-aufzeichnung] ${this._an ? 'an' : 'aus'} (${this.ordner})`);
  }

  /** Die Datei des heutigen Tags (Ortszeit). */
  datei() {
    const d = new Date(this._jetzt());
    const tag = `${d.getFullYear()}-${zweistellig(d.getMonth() + 1)}-${zweistellig(d.getDate())}`;
    return join(this.ordner, `aufzeichnung-${tag}.jsonl`);
  }

  /** Eine Zeile `{t, art, …daten}` anhängen; aus oder über der Tagesgrenze schreibt sie nichts. */
  schreibe(art, daten = {}) {
    if (!this._an) return;
    let zeile;
    try {
      zeile = JSON.stringify({ t: this._jetzt(), art, ...daten }) + '\n';
    } catch (fehler) {
      this.#fehler(`nicht serialisierbar: ${fehler?.message ?? fehler}`);
      return;
    }
    const roh = Buffer.from(zeile, 'utf8');
    const pfad = this.datei();
    if (pfad !== this._pfad) {
      this._pfad = pfad;
      this._voll = false;
      this._bytes = existsSync(pfad) ? statSync(pfad).size : 0;
    }
    if (this._bytes + roh.length > this.maxBytes) {
      if (!this._voll) {
        this._voll = true;
        this.log(`[fyos-aufzeichnung] ${pfad} hat die Tagesgrenze erreicht`);
      }
      return;
    }
    try {
      mkdirSync(dirname(pfad), { recursive: true });
      appendFileSync(pfad, roh);
    } catch (fehler) {
      this.#fehler(fehler?.message ?? String(fehler));
      return;
    }
    this._bytes += roh.length;
    this.zeilen += 1;
    this.fehler = null;
  }

  #fehler(text) {
    if (text !== this.fehler) this.log(`[fyos-aufzeichnung] ${text}`);
    this.fehler = text;
  }

  /** Kleines Objekt für /zustand. */
  zustand() {
    return { an: this._an, datei: this.datei(), zeilen: this.zeilen, fehler: this.fehler };
  }
}
