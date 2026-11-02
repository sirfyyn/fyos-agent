/**
 * budget.js — was kostet der Monat?
 *
 * Der RPC-Runner summiert `usage.cost.total` (Dollar) jeder abgeschlossenen Assistant-Nachricht
 * zum Monat (`Zustand.budget_buchen`) und rechnet mit `kurs_usd_eur` in Euro. Er MELDET nur: die
 * Sperre bei `budget_monat_eur` kommt erst mit der Fallback-Kette (ADR-216 §2.5/§7a). Dieser
 * Port tut dasselbe — `erlaubt()` sagt immer ok und nennt den Grund, sobald die Grenze erreicht
 * ist; nichts wird angehalten.
 *
 * Quelle der Kosten ist hier die dauerhafte Nutzung von pi-durable (`UsageDoc`, je Gespräch,
 * über die ganze Lebenszeit des Gesprächs). Daraus wird der Monat so gebildet: beim Monatswechsel
 * merkt sich ein eigenes Dokument den Stand je Gespräch als Basis; der Monat ist die Summe aus
 * `aktuell − Basis`. Beim allerersten Start gibt es keine Basis, also zählt die bisherige Nutzung
 * ganz zum laufenden Monat (lieber zu viel gemeldet als zu wenig).
 *
 * Konfiguration wie im RPC-Runner: `cfg.budget_monat_eur` (Vorgabe 200), `cfg.kurs_usd_eur`.
 */
import { KONTEXT, NUTZUNG as UsageDoc, dokument as defineDoc } from './lauf/index.js';
import { LaufListe, Register } from './documents.js';

const CTX = KONTEXT;
const BUDGET_VORGABE_EUR = 200;
const PRUEFEN_S = 60;

/** Basisstand je Gespräch am Monatsanfang. */
export const BudgetDoc = defineDoc({
  kind: 'fyos.budget',
  version: 1,
  scope: 'session',
  initial: () => ({ version: 1, monat: null, basis: {} }),
  checkpointWhen: () => false,
});

const zweistellig = (n) => String(n).padStart(2, '0');

/** `JJJJ-MM` in Ortszeit, wie `time.strftime("%Y-%m")` im RPC-Runner. */
export function monatVon(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${zweistellig(d.getMonth() + 1)}`;
}

const zahl = (w) => (typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : 0);

/** Alle Dollar eines Nutzungsbuchs: Modelle und Werkzeug-Ergebnisse. */
export function kostenAusNutzung(nutzung) {
  let summe = 0;
  for (const topf of [nutzung?.models, nutzung?.tools]) {
    for (const u of Object.values(topf ?? {})) summe += zahl(u?.cost?.total);
  }
  return summe;
}

/**
 * Das `usage`-Ereignis für den Client (wie `_ende` im RPC-Runner): Modell, Stufe, Kontext und,
 * mit Kurs, Mikro-Euro. `modelle` ist `cfg.modelle` (Stufe, `ctx_max`).
 */
export function usageEreignis({ cfg, modell, tokens, kosten }) {
  const name = String(modell || 'unbekannt');
  const info = cfg?.modelle?.[name] ?? {};
  const e = { typ: 'usage', modell: name, tier: String(info.tier || 'normal') };
  if (Number.isInteger(tokens) && tokens >= 0) e.ctx = tokens;
  if (Number.isInteger(info.ctx_max)) e.ctx_max = info.ctx_max;
  const kurs = Number(cfg?.kurs_usd_eur);
  if (kurs && typeof kosten === 'number' && Number.isFinite(kosten) && kosten >= 0) {
    e.kosten_micro_eur = Math.round(kosten * kurs * 1_000_000);
  }
  return e;
}

export class Budget {
  constructor({ cfg, harness, log, jetzt, pruefenS = PRUEFEN_S } = {}) {
    this.cfg = cfg ?? {};
    this.harness = harness;
    this.log = log ?? ((z) => console.log(z));
    this.jetzt = jetzt ?? (() => Date.now());
    this.pruefenS = Math.max(1, Number(pruefenS) || PRUEFEN_S);
    this.grenzeEur = Number.isFinite(Number(this.cfg.budget_monat_eur))
      ? Number(this.cfg.budget_monat_eur)
      : BUDGET_VORGABE_EUR;
    this.kurs = Number(this.cfg.kurs_usd_eur) || null;
    this._monat = monatVon(this.jetzt());
    this._usd = 0;
    this._aktualisiert = null;
    this._fehler = null;
    this._gemeldet = null; // Monat, für den „erreicht“ schon im Log stand
    this._timer = null;
    this._aktiv = false;
  }

  start() {
    if (this._aktiv) return;
    this._aktiv = true;
    const lauf = async () => {
      if (!this._aktiv) return;
      await this.aktualisieren();
      if (!this._aktiv) return;
      this._timer = setTimeout(lauf, this.pruefenS * 1000);
      this._timer.unref?.();
    };
    void lauf();
  }

  stop() {
    this._aktiv = false;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  /** Dollar je Gespräch (Lebenszeit): Register, Läufe und ihre Kindgespräche. */
  async #kostenJeGespraech() {
    const ids = new Set();
    const reg = await this.harness.snapshot(Register, CTX);
    for (const a of reg?.agents ?? []) if (a?.id) ids.add(String(a.id));
    const laeufe = await this.harness.snapshot(LaufListe, CTX);
    for (const l of Object.values(laeufe?.eintraege ?? {})) {
      if (l?.kindId) ids.add(String(l.kindId));
      // Der Harness2-Pilot führt viele Messläufe in eigenen Kindgesprächen; sie zählen zum Monat.
      for (const kind of l?.kinder ?? []) ids.add(String(kind));
    }
    const aus = {};
    for (const id of ids) {
      const nutzung = await this.harness.snapshot(UsageDoc, id, CTX).catch(() => undefined);
      aus[id] = kostenAusNutzung(nutzung);
    }
    return aus;
  }

  /** Neu rechnen; schreibt nur, wenn sich die Basis ändert (Monatswechsel, zurückgesetzte Nutzung). */
  async aktualisieren() {
    try {
      const monat = monatVon(this.jetzt());
      const kosten = await this.#kostenJeGespraech();
      const doc = (await this.harness.snapshot(BudgetDoc, CTX)) ?? { monat: null, basis: {} };
      let basis = doc.basis ?? {};
      let neueBasis = null;
      if (doc.monat !== monat) {
        // Erster Start: keine Basis, alles zählt. Monatswechsel: der heutige Stand ist die Null.
        neueBasis = doc.monat === null ? {} : { ...kosten };
      } else {
        // Nutzung kleiner als die Basis: das Gespräch wurde zurückgesetzt, es zählt wieder ab Null.
        const zurueck = Object.keys(basis).filter((id) => (kosten[id] ?? 0) < zahl(basis[id]));
        if (zurueck.length) neueBasis = { ...basis, ...Object.fromEntries(zurueck.map((id) => [id, 0])) };
      }
      if (neueBasis) {
        await this.harness.commit(async (tx) => {
          const d = await tx.doc(BudgetDoc);
          d.monat = monat;
          d.basis = neueBasis;
        }, CTX);
        basis = neueBasis;
      }
      let usd = 0;
      for (const [id, k] of Object.entries(kosten)) usd += Math.max(0, k - zahl(basis[id]));
      this._monat = monat;
      this._usd = usd;
      this._aktualisiert = this.jetzt();
      this._fehler = null;
      this.#grenzeMelden();
    } catch (fehler) {
      const text = String(fehler?.message ?? fehler).slice(0, 200);
      if (text !== this._fehler) this.log(`[fyos-budget] nicht gerechnet: ${text}`);
      this._fehler = text;
    }
    return this.zustand();
  }

  #grenzeMelden() {
    const eur = this.#eur();
    if (eur !== null && eur >= this.grenzeEur && this._gemeldet !== this._monat) {
      this._gemeldet = this._monat;
      this.log(`[fyos-budget] Monatsbudget erreicht: ${eur.toFixed(2)} € von ${this.grenzeEur} € (nur gemeldet, keine Sperre)`);
    }
  }

  #eur() {
    return this.kurs ? this._usd * this.kurs : null;
  }

  /** Wie `budget` in `/zustand` des RPC-Runners: Monat, Dollar; mit Kurs auch Euro und Grenze. */
  zustand() {
    const z = { monat: this._monat, usd: Math.round(this._usd * 1e4) / 1e4 };
    const eur = this.#eur();
    if (eur !== null) {
      z.eur = Math.round(eur * 100) / 100;
      z.grenze_eur = this.grenzeEur;
      z.erreicht = eur >= this.grenzeEur;
    }
    if (this._fehler) z.fehler = this._fehler;
    return z;
  }

  /**
   * Darf weitergearbeitet werden? Der RPC-Runner sperrt nicht (die Sperre kommt mit der
   * Fallback-Kette), er zählt nur. Hier ebenso: immer `ok`, aber mit Grund, sobald die Grenze
   * erreicht ist, damit der Zusammenbau später eine Sperre daran hängen kann.
   */
  erlaubt() {
    const eur = this.#eur();
    if (eur !== null && eur >= this.grenzeEur) {
      return {
        ok: true,
        grund: `Monatsbudget erreicht (${eur.toFixed(2)} € von ${this.grenzeEur} €); es wird nur gemeldet, nicht gesperrt`,
      };
    }
    return { ok: true, grund: eur === null ? 'kein Kurs gesetzt, Euro unbekannt' : 'unter der Grenze' };
  }
}
