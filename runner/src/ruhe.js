/**
 * ruhe.js — der eine Ruhe-Schalter des Runners (Besitzer, 25.10.2026, Entscheidung 588; docs/current/RUNNER-RUHE.md).
 *
 * Ruhe heißt: der Runner nimmt keine eigenständige Arbeit auf (Takt, Arbeitsschleife, Hintergrund-Eingang, Jobs).
 * Stufe `normal` lässt Besitzer' Nachrichten durch, `tief` hält auch sie an. Der Spielmodus (Marken) ist immer Ruhe und immer
 * tief; der Schalter kann ihn nicht wecken, er löscht nie eine Marke.
 *
 * Zustand `{ruhe, grund, seit, bis, von, stufe, sofort}` liegt in einer Datei und übersteht den Neustart. Abgelaufen wird
 * bei jedem Lesen und einmal je `pruefenS` im Hintergrund; jede Änderung geht als Ereignis an die Hörer (`beiAenderung`).
 * Die Wirkung selbst sitzt an den Stellen, an denen Neues beginnt (takt.js, ingress.js, jobs.js, server.js).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { wandZeit } from './takt.js';

export const STUFEN = ['normal', 'tief'];
export const BIS_MAX_TAGE = 31;
const TAG = 24 * 60 * 60 * 1000;
const GRUND_MAX = 200;
const VON_MAX = 40;

/** Fehler mit HTTP-Status, den Server und Steuerkanal weitergeben. */
export class RuheFehler extends Error {
  constructor(nachricht, status = 400) {
    super(nachricht);
    this.status = status;
  }
}

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const leer = () => ({ ruhe: false, grund: null, seit: null, bis: null, von: null, stufe: 'normal', sofort: false, wach_bis: null });
const kurz = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** `HH:MM` → Minuten seit Mitternacht, sonst `null`. */
function minuten(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h <= 24 && mi <= 59 ? h * 60 + mi : null;
}

/** Konfiguration der Nachtruhe prüfen; `null`, wenn aus oder unbrauchbar. */
export function nachtruheKonfig(roh) {
  if (!roh || typeof roh !== 'object' || roh.an !== true) return null;
  const von = minuten(roh.von ?? '22:00');
  const bis = minuten(roh.bis ?? '07:00');
  if (von === null || bis === null || von === bis) return null;
  const zone = String(roh.zone || 'Europe/Berlin');
  try {
    wandZeit(0, zone);
  } catch {
    return null;
  }
  return { von, bis, zone, vonText: String(roh.von ?? '22:00'), bisText: String(roh.bis ?? '07:00'), stufe: STUFEN.includes(roh.stufe) ? roh.stufe : 'normal' };
}

export class Ruhe {
  /**
   * @param {object} p
   * @param {string|null} [p.datei]      Zustandsdatei; `null` = nur im Speicher
   * @param {object|null} [p.spielmodus] Spielmodus (`grund()`); gilt immer als Ruhe
   * @param {object} [p.nachtruhe]       {an, von, bis, zone, stufe}; Vorgabe aus
   */
  constructor({ datei = null, spielmodus = null, nachtruhe = null, log = (z) => console.log(z), jetzt = () => Date.now(), pruefenS = 5, dateisystem = {} } = {}) {
    this.datei = datei ? String(datei) : null;
    this.spielmodus = spielmodus;
    this.nacht = nachtruheKonfig(nachtruhe);
    this.log = log;
    this.jetzt = jetzt;
    this.pruefenMs = Math.max(0.01, Number(pruefenS)) * 1000;
    this.fs = { existiert: existsSync, lesen: (p) => readFileSync(p, 'utf8'), schreiben: writeFileSync, umbenennen: renameSync, ordner: (p) => mkdirSync(p, { recursive: true }), ...dateisystem };
    this.hoerer = new Set();
    this.timer = null;
    this.fehler = null;
    this.z = leer();
    this._signatur = null;
    this.#laden();
    this._signatur = this.#signatur(this.zustand());
  }

  // --- Lesen --------------------------------------------------------------------------------

  #laden() {
    if (!this.datei || !this.fs.existiert(this.datei)) return;
    let roh;
    try {
      roh = JSON.parse(this.fs.lesen(this.datei));
    } catch (fehler) {
      this.log(`[fyos-ruhe] ${this.datei} unlesbar (${fehler.message}) — gilt als aus`);
      return;
    }
    if (!roh || typeof roh !== 'object') return;
    const bis = roh.bis ? Date.parse(roh.bis) : null;
    this.z = {
      ruhe: roh.ruhe === true,
      grund: roh.grund ? kurz(roh.grund, GRUND_MAX) : null,
      seit: roh.seit ?? null,
      bis: Number.isFinite(bis) ? iso(bis) : null,
      von: roh.von ? kurz(roh.von, VON_MAX) : null,
      stufe: STUFEN.includes(roh.stufe) ? roh.stufe : 'normal',
      sofort: roh.sofort === true,
      wach_bis: Number.isFinite(Date.parse(roh.wach_bis)) ? roh.wach_bis : null,
    };
    if (this.z.ruhe && roh.bis && !Number.isFinite(bis)) {
      this.log(`[fyos-ruhe] Endzeit ${JSON.stringify(roh.bis)} unlesbar — Ruhe gilt als aus`);
      this.z = leer();
    }
  }

  #sichern() {
    if (!this.datei) return;
    try {
      this.fs.ordner(dirname(this.datei));
      const tmp = `${this.datei}.tmp`;
      this.fs.schreiben(tmp, `${JSON.stringify({ v: 1, ...this.z }, null, 2)}\n`, { mode: 0o644 });
      this.fs.umbenennen(tmp, this.datei);
      this.fehler = null;
    } catch (fehler) {
      // Der Schalter gilt trotzdem im Speicher; nur der Neustart würde ihn vergessen.
      this.fehler = `Zustand nicht gespeichert: ${String(fehler?.message ?? fehler).slice(0, 160)}`;
      this.log(`[fyos-ruhe] ${this.fehler}`);
    }
  }

  /** Abgelaufenen Schalter löschen (mit Ereignis). Läuft bei jedem Zugriff. */
  #ablaufen() {
    const bis = this.z.bis ? Date.parse(this.z.bis) : null;
    if (this.z.ruhe && bis !== null && this.jetzt() >= bis) {
      this.log(`[fyos-ruhe] Ruhe bis ${this.z.bis} abgelaufen — aus`);
      this.z = { ...leer(), wach_bis: this.z.wach_bis };
      this.#sichern();
      this.#melden('abgelaufen');
    }
    const wach = this.z.wach_bis ? Date.parse(this.z.wach_bis) : null;
    if (wach !== null && this.jetzt() >= wach) {
      this.z.wach_bis = null;
      this.#sichern();
    }
  }

  /** Läuft die Nachtruhe gerade (und hat Besitzer sie nicht für diese Nacht aufgehoben)? */
  #nacht() {
    const n = this.nacht;
    if (!n) return { aktiv: false, ende: null };
    const jetzt = this.jetzt();
    const wach = this.z.wach_bis ? Date.parse(this.z.wach_bis) : null;
    if (wach !== null && jetzt < wach) return { aktiv: false, ende: null };
    const wand = wandZeit(jetzt, n.zone);
    const d = new Date(wand);
    const jetztMin = d.getUTCHours() * 60 + d.getUTCMinutes();
    const innen = n.von < n.bis ? jetztMin >= n.von && jetztMin < n.bis : jetztMin >= n.von || jetztMin < n.bis;
    if (!innen) return { aktiv: false, ende: null };
    // Ende des Fensters als echter Zeitpunkt: Wanduhr-Differenz auf die Uhr anwenden (Sommerzeit-Sprung im Fenster ist ungenau, aber harmlos).
    const bisMin = n.bis === 1440 ? 0 : n.bis;
    const bisInnen = jetztMin < bisMin ? bisMin - jetztMin : 1440 - jetztMin + bisMin;
    let ende = jetzt - (jetzt % 60_000) + bisInnen * 60_000;
    // Eine Zeitumstellung im Fenster verschiebt die Wanduhr um eine Stunde: einmal nachstellen.
    const w = new Date(wandZeit(ende, n.zone));
    let diff = bisMin - (w.getUTCHours() * 60 + w.getUTCMinutes());
    if (diff > 720) diff -= 1440;
    if (diff < -720) diff += 1440;
    ende += diff * 60_000;
    return { aktiv: true, ende };
  }

  // --- Sicht --------------------------------------------------------------------------------

  /** Der ganze Zustand, wie ihn Clients bekommen. */
  zustand() {
    this.#ablaufen();
    const s = this.z;
    const nacht = this.#nacht();
    const spiel = this.spielmodus?.grund?.() ?? null;
    const quellen = [];
    if (spiel) quellen.push('spielmodus');
    if (s.ruhe) quellen.push('schalter');
    if (nacht.aktiv) quellen.push('nachtruhe');
    const ruhe = s.ruhe || nacht.aktiv;
    const stufe = spiel ? 'tief' : s.ruhe ? s.stufe : nacht.aktiv ? this.nacht.stufe : 'normal';
    const quelle = quellen[0] ?? null;
    let grund = null;
    if (quelle === 'spielmodus') grund = `Spielmodus (${spiel})`;
    else if (quelle === 'schalter') grund = s.grund;
    else if (quelle === 'nachtruhe') grund = `Nachtruhe ${this.nacht.vonText}–${this.nacht.bisText}`;
    return {
      ruhe,
      pausiert: ruhe || Boolean(spiel),
      spielmodus: spiel,
      quelle,
      quellen,
      grund,
      seit: quelle === 'schalter' ? s.seit : null,
      bis: quelle === 'schalter' ? s.bis : quelle === 'nachtruhe' ? iso(nacht.ende) : null,
      von: quelle === 'schalter' ? s.von : null,
      stufe,
      sofort: s.ruhe ? s.sofort : false,
      // Der Schalter für sich, auch wenn der Spielmodus davor liegt (damit ein Client „Ruhe an, aber Spielmodus“ zeigen kann).
      schalter: { an: s.ruhe, grund: s.grund, seit: s.seit, bis: s.bis, von: s.von, stufe: s.stufe, sofort: s.sofort },
      nachtruhe: this.nacht ? { von: this.nacht.vonText, bis: this.nacht.bisText, zone: this.nacht.zone, stufe: this.nacht.stufe, aktiv: nacht.aktiv } : null,
      fehler: this.fehler,
      zeit: iso(this.jetzt()),
    };
  }

  /** Ruhe durch Schalter oder Nachtruhe (ohne Spielmodus). */
  an() {
    const z = this.zustand();
    return z.ruhe;
  }

  /** Ruhe oder Spielmodus: „Persona schläft“. */
  pausiert() {
    return this.zustand().pausiert;
  }

  /** Gilt die Ruhe-Stufe `tief` (Schalter oder Nachtruhe; der Spielmodus hat seinen eigenen Weg)? */
  sperrtMax() {
    const z = this.zustand();
    return z.ruhe && z.stufe === 'tief';
  }

  /**
   * Was darf der Eingang jetzt ausgeben? `frei` alles, `nurMax` nur Klasse `max`, `gesperrt` nichts (außer Freigabe-Entscheidungen,
   * die nie an den Agenten gehen).
   */
  eingang({ spiel } = {}) {
    const z = this.zustand();
    // `spiel`: wer den Spielmodus anders sieht als die Marke (der Eingang bei laufendem Ersatzdenker: Aufträge gehen dann
    // weiter, ProviderKette), übergibt seine Sicht; ohne Angabe gilt die Marke.
    if (spiel === undefined ? z.spielmodus : spiel) return 'gesperrt';
    if (!z.ruhe) return 'frei';
    return z.stufe === 'tief' ? 'gesperrt' : 'nurMax';
  }

  /**
   * Schnittstelle des Spielmodus (`an()`, `grund()`), aber mit der Ruhe darin: für Bausteine, die „darf ich jetzt arbeiten?“
   * fragen (Arbeitsschleife, Jobs, Weltmodell). `grund()` nennt die Marke oder `ruhe:<Grund>`.
   */
  get sperre() {
    return {
      an: () => this.pausiert(),
      grund: () => {
        const z = this.zustand();
        if (z.spielmodus) return z.spielmodus;
        return z.ruhe ? `ruhe:${z.grund ?? z.quelle}` : null;
      },
    };
  }

  // --- Schreiben ----------------------------------------------------------------------------

  /**
   * Den Schalter setzen. `von` bestimmt der Aufrufer aus dem Token, nie der Client.
   * @returns {object} Zustand plus `geaendert`, bei `an:false` auch `geweckt` und ggf. `hinweis`
   */
  setzen({ an, bis, grund, stufe, sofort, von } = {}) {
    if (typeof an !== 'boolean') throw new RuheFehler('an: true oder false');
    if (stufe !== undefined && stufe !== null && !STUFEN.includes(stufe)) throw new RuheFehler(`stufe: ${STUFEN.join(' oder ')}`);
    if (sofort !== undefined && sofort !== null && typeof sofort !== 'boolean') throw new RuheFehler('sofort: true oder false');
    this.#ablaufen();
    const vorher = this.#signatur(this.zustand());
    const jetzt = this.jetzt();
    if (an) {
      let endMs = null;
      if (bis !== undefined && bis !== null && bis !== '') {
        endMs = typeof bis === 'number' ? bis : Date.parse(String(bis));
        if (!Number.isFinite(endMs)) throw new RuheFehler('bis: ISO-Zeitpunkt erwartet');
        if (endMs <= jetzt) throw new RuheFehler('bis liegt nicht in der Zukunft');
        if (endMs - jetzt > BIS_MAX_TAGE * TAG) throw new RuheFehler(`bis liegt mehr als ${BIS_MAX_TAGE} Tage voraus`);
      }
      this.z = {
        ruhe: true,
        grund: kurz(grund, GRUND_MAX) || null,
        seit: iso(jetzt),
        bis: endMs === null ? null : iso(endMs),
        von: kurz(von, VON_MAX) || null,
        stufe: stufe ?? 'normal',
        sofort: sofort === true,
        wach_bis: this.z.wach_bis,
      };
    } else {
      const nacht = this.#nacht();
      // Besitzer weckt mitten in der Nachtruhe: für den Rest dieser Nacht gilt sie nicht.
      this.z = { ...leer(), wach_bis: nacht.aktiv ? iso(nacht.ende) : this.z.wach_bis };
    }
    this.#sichern();
    const z = this.zustand();
    const geaendert = this.#signatur(z) !== vorher;
    if (geaendert) this.#melden(an ? 'an' : 'aus');
    const antwort = { ...z, geaendert };
    if (!an) {
      antwort.geweckt = !z.pausiert;
      if (z.spielmodus) antwort.hinweis = `Der Schalter ist aus, aber der Spielmodus (${z.spielmodus}) hält weiter; der Schalter weckt nicht gegen ihn.`;
      else if (z.ruhe) antwort.hinweis = 'Der Schalter ist aus, aber die Nachtruhe gilt noch.';
    }
    return antwort;
  }

  // --- Ereignisse ---------------------------------------------------------------------------

  #signatur(z) {
    const s = z.schalter;
    return JSON.stringify([z.ruhe, z.pausiert, z.spielmodus, z.stufe, z.bis, z.grund, z.von, z.quelle, s.an, s.bis, s.stufe, s.grund, s.sofort]);
  }

  #melden(art) {
    const z = this.zustand();
    this._signatur = this.#signatur(z);
    for (const h of [...this.hoerer]) {
      try {
        h({ ...z, art });
      } catch (fehler) {
        this.log(`[fyos-ruhe] Hörer: ${String(fehler?.message ?? fehler).slice(0, 160)}`);
      }
    }
  }

  /** Hörer für jede Änderung (Schalter, Ablauf, Spielmodus-Wechsel). Gibt die Abmeldung zurück. */
  beiAenderung(fn) {
    this.hoerer.add(fn);
    return () => this.hoerer.delete(fn);
  }

  /** Ablauf und Wechsel der Spielmodus-Marke bemerken und melden. */
  pruefen() {
    const z = this.zustand();
    if (this.#signatur(z) !== this._signatur) this.#melden('wechsel');
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.pruefen();
      } catch (fehler) {
        this.log(`[fyos-ruhe] Prüfung: ${String(fehler?.message ?? fehler).slice(0, 160)}`);
      }
    }, this.pruefenMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
