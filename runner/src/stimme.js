/**
 * stimme.js — Sprachsätze (Eingang mit Bezug `stimme`, von HA Assist): Messung und Regeln.
 *
 * Messung (nur zählend, nach außen wirkt sie nicht): je Satz
 *   angenommen  Runner hat den Eingang aus dem Hub gelesen und eingereiht (Ingress)
 *   ausgegeben  Ingress hat ihn dem Gespräch übergeben
 *   zug         der Agent nimmt ihn auf (Nutzernachricht im Verlauf; Ausgang klammert `ein:<id>`)
 *   erstes      erstes Textstück der Antwort
 *   idle        Zug fertig (`session.idle`)
 * daraus wartezeit_ms (angenommen → zug: Bahn), erstes_ms (zug → erstes Textstück), fertig_ms (angenommen → idle),
 * dazu Token des Prompts (erster Modellaufruf des Zuges) und ob der Cache warm war, wenn der Anbieter es meldet.
 * Abgelegt im Dokument `fyos.stimme` (die letzten MAX Sätze), ein Journalzeile je Satz, Zeile in der Aufzeichnung,
 * Zusammenfassung in `/zustand` unter `stimme`. Nie der gesprochene Text.
 *
 * Regeln (Besitzer 19.10.2026, Entscheidung 478; 25.10.2026): Rechte per Sprache Haus und Medien für alle Sprecher gleich;
 * Sprachsätze sind Klasse `max`, entscheiden aber nie eine Freigabe (das tut nur die App, siehe Ingress); Zerstörendes
 * per Sprache geht als Freigabe in die App und Persona sagt das in einem Satz an.
 */
import { KONTEXT } from './lauf/index.js';
import { StimmeDoc } from './documents.js';

const CTX = KONTEXT;

export const STIMME_BEZUG = 'stimme';
export const STIMME_VON = 'ha-assist';
export const MAX_SAETZE = 200;
/** Der eine Satz, den Persona nach einem Freigabe-Antrag per Sprache sagt. */
export const FREIGABE_SATZ = 'Freigabe liegt in der App.';

/** Ist der Eingang (oder Eintrag mit `bezug`) ein Sprachsatz? */
export function istStimme(e) {
  return String(e?.bezug ?? '').trim().toLowerCase() === STIMME_BEZUG;
}

/**
 * Welche Eingänge dürfen eine Freigabe entscheiden? Nur die App: Quelle `web`, Klasse `max`, von `app-freigabe`.
 * Ein Sprachsatz nie, auch wenn er `von: app-freigabe` behauptet (der Bezug `stimme` und der Absender `ha-assist`
 * schließen es aus). Klasse `max` hat er trotzdem.
 */
export function darfFreigabeEntscheiden(e) {
  if (e?.quelle !== 'web' || e?.klasse !== 'max' || e?.von !== 'app-freigabe') return false;
  if (istStimme(e)) return false;
  return true;
}

/** Wer gerade am Zug ist, je Gespräch: damit Werkzeuge (freigabe_bitten) wissen, ob der Zug ein Sprachsatz beantwortet. */
export class Zugkontext {
  constructor() {
    this.map = new Map();
  }

  setze(gespraech, daten) {
    this.map.set(String(gespraech), { ...daten });
  }

  loesche(gespraech) {
    this.map.delete(String(gespraech));
  }

  hole(gespraech) {
    return this.map.get(String(gespraech)) ?? null;
  }

  /** Antwortet der laufende Zug dieses Gesprächs auf einen Sprachsatz? */
  istStimme(gespraech) {
    return istStimme(this.hole(gespraech));
  }
}

const zahl = (x) => (Number.isFinite(Number(x)) && x !== null && x !== undefined ? Number(x) : null);

/** Nächster-Rang-Perzentil (p in 0..100) über die endlichen Werte; ohne Werte `null`. */
export function perzentil(werte, p) {
  const w = werte.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!w.length) return null;
  const rang = Math.max(1, Math.ceil((p / 100) * w.length));
  return w[Math.min(rang, w.length) - 1];
}

const FELDER = ['wartezeit_ms', 'erstes_ms', 'zug_ms', 'fertig_ms', 'prompt'];

export class StimmeMessung {
  constructor({ harness, aufzeichnung, log = (z) => console.log(z), jetzt = () => Date.now(), max = MAX_SAETZE } = {}) {
    this.harness = harness;
    this.aufzeichnung = aufzeichnung ?? null;
    this.log = log;
    this.jetzt = jetzt;
    this.max = max;
    // offen: Gespräch -> Map(stromId -> Satz); aktuell: Gespräch -> stromId des Satzes, dessen Zug gerade läuft (oder null)
    this.offen = new Map();
    this.aktuell = new Map();
    this.kette = Promise.resolve();
    this.fehler = null;
  }

  /** Ein Eingang beginnt seinen Zug (`entry.kind === 'fyos.eingang'`). */
  zugBeginn(gespraech, entry) {
    const d = entry?.data ?? {};
    const g = String(gespraech);
    if (!istStimme(d)) {
      this.aktuell.set(g, null);
      return;
    }
    const stromId = String(d.stromId ?? '');
    const satz = {
      ein: stromId,
      angenommen: zahl(d.angenommen),
      ausgegeben: zahl(d.ausgegeben),
      zug: this.jetzt(),
      erstes: null,
      idle: null,
      schritte: 0,
      prompt: null,
      cacheRead: null,
      kalt: null,
      ausgabeToken: 0,
    };
    if (!this.offen.has(g)) this.offen.set(g, new Map());
    this.offen.get(g).set(stromId, satz);
    this.aktuell.set(g, stromId);
  }

  #satz(gespraech) {
    const g = String(gespraech);
    const id = this.aktuell.get(g);
    return id ? (this.offen.get(g)?.get(id) ?? null) : null;
  }

  /** Ein Textstück der Antwort kam im Ausgang an. */
  text(gespraech) {
    const s = this.#satz(gespraech);
    if (s && s.erstes === null) s.erstes = this.jetzt();
  }

  /** Ein Modellaufruf des Zuges ist fertig; `usage` wie pi-ai (`input`, `output`, `cacheRead`, `cacheWrite`). */
  nutzung(gespraech, usage) {
    const s = this.#satz(gespraech);
    if (!s || !usage || typeof usage !== 'object') return;
    s.schritte += 1;
    s.ausgabeToken += zahl(usage.output) ?? 0;
    if (s.schritte > 1) return;
    const lesen = zahl(usage.cacheRead);
    const schreiben = zahl(usage.cacheWrite);
    const eingabe = zahl(usage.input);
    const gesamt = (eingabe ?? 0) + (lesen ?? 0) + (schreiben ?? 0);
    s.prompt = gesamt > 0 ? gesamt : null;
    s.cacheRead = lesen;
    // Warm = der Anbieter hat einen Teil des Prompts aus dem Cache gelesen. Meldet er nichts, bleibt es unbekannt.
    s.kalt = lesen === null || s.prompt === null ? null : lesen === 0;
  }

  /** Der Zug des Gesprächs ist zu Ende (`run_end`): alle offenen Sprachsätze abschließen. */
  ende(gespraech) {
    const g = String(gespraech);
    const offene = this.offen.get(g);
    this.aktuell.delete(g);
    if (!offene?.size) return;
    this.offen.delete(g);
    const idle = this.jetzt();
    for (const s of offene.values()) {
      s.idle = idle;
      this.#ablegen(this.#fertig(s));
    }
  }

  #fertig(s) {
    const diff = (a, b) => (a !== null && b !== null ? Math.max(0, a - b) : null);
    return {
      ein: s.ein,
      t: s.idle,
      wartezeit_ms: diff(s.zug, s.angenommen),
      erstes_ms: diff(s.erstes, s.zug),
      zug_ms: diff(s.idle, s.zug),
      fertig_ms: diff(s.idle, s.angenommen ?? s.zug),
      schritte: s.schritte,
      prompt: s.prompt,
      cacheRead: s.cacheRead,
      kalt: s.kalt,
      ausgabeToken: s.ausgabeToken,
    };
  }

  #ablegen(satz) {
    const kalt = satz.kalt === null ? '?' : satz.kalt ? 'kalt' : 'warm';
    const ms = (x) => (x === null ? '-' : `${x}ms`);
    this.log(
      `[fyos-stimme] ein=${satz.ein} wartezeit=${ms(satz.wartezeit_ms)} erstes=${ms(satz.erstes_ms)} zug=${ms(satz.zug_ms)} ` +
        `fertig=${ms(satz.fertig_ms)} prompt=${satz.prompt ?? '-'} cache=${kalt} schritte=${satz.schritte}`,
    );
    this.aufzeichnung?.schreibe?.('stimme', satz);
    if (!this.harness) return;
    this.kette = this.kette
      .then(() =>
        this.harness.commit(async (tx) => {
          const doc = await tx.doc(StimmeDoc);
          doc.saetze.push(satz);
          if (doc.saetze.length > this.max) doc.saetze = doc.saetze.slice(-this.max);
        }, CTX),
      )
      .then(() => {
        this.fehler = null;
      })
      .catch((fehler) => {
        this.fehler = String(fehler?.message ?? fehler);
        this.log(`[fyos-stimme] nicht abgelegt: ${this.fehler}`);
      });
  }

  /** Alle Schreibvorgänge sind durch (für Tests und das Beenden). */
  async leeren() {
    await this.kette;
  }

  /** Für `/zustand`: {n, p50, p95, kalt, letzte[…]}; die Zeiten in ms, `prompt` in Token. */
  async zustand({ letzte = 10 } = {}) {
    await this.kette;
    let saetze = [];
    if (this.harness) {
      try {
        saetze = (await this.harness.snapshot(StimmeDoc, CTX))?.saetze ?? [];
      } catch (fehler) {
        this.fehler = String(fehler?.message ?? fehler);
      }
    }
    const rang = (p) => Object.fromEntries(FELDER.map((f) => [f, perzentil(saetze.map((s) => s[f] ?? NaN), p)]));
    const mitCache = saetze.filter((s) => s.kalt !== null && s.kalt !== undefined);
    return {
      n: saetze.length,
      p50: rang(50),
      p95: rang(95),
      kalt: mitCache.length ? { von: mitCache.length, kalt: mitCache.filter((s) => s.kalt).length } : null,
      letzte: saetze.slice(-letzte),
      fehler: this.fehler,
    };
  }
}
