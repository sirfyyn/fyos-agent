/**
 * sprache-uebergabe.js — Übergabe vom Sprach-Agenten an das Hauptgespräch (docs/current/RUNNER-SPRACHE.md#sprach-agent).
 *
 * Der Sprach-Agent hat nur lesende Werkzeuge. Braucht eine Bitte Wirkung („das muss ich nachschauen und melde mich“), ruft er
 * `sprache_uebergabe`. Dann:
 *   1. Der Auftrag geht als Nachricht (`art: folgen`, Kanal `sprache-uebergabe`, mit einem Kopf, der sprechbare Kürze verlangt) ins Hauptgespräch.
 *   2. Hier wird der Strom des Hauptgesprächs gelesen. Beginnt die Arbeit an genau dieser Nachricht (Eintrag `fyos.mensch` mit Kanal und Text),
 *      sammelt dieses Modul den Text der Antworten; am `run_end` ist die Übergabe fertig, die letzte Antwort mit Text ist das Ergebnis.
 *   3. Das Ergebnis geht an `liefern(übergabe)`, das die Sprachsitzung stellt: sprechen (wenn Besitzer zuhört) oder als Mitteilung (Text).
 * Freigaben, Zerstörendes und lange Arbeit bleiben vollständig im Hauptgespräch (Freigabe-Regeln, Hintergrundjobs). Hier geschieht nichts mit Wirkung.
 *
 * Grenze, ehrlich: Ob ein `run_end` zu unserer Nachricht gehört, ergibt sich aus der Reihenfolge der Ereignisse. Arbeitet das Hauptgespräch gleichzeitig an
 * etwas anderem und mischt der Harness beide Läufe, kann das Ergebnis die Antwort auf die falsche Frage sein. Gegenmittel: Der Sammler beginnt erst an unserer Nachricht.
 */
import { Satzstrom, sprechbar } from './sprache-text.js';

export const UEBERGABE_KANAL = 'sprache-uebergabe';
export const UEBERGABE_VORGABE = { timeoutMin: 30, maxOffen: 4, maxZeichen: 1500, sprechenMaxSaetze: 3, textMaxZeichen: 1200 };

const tief = (a, b) => ({ ...a, ...(b && typeof b === 'object' ? b : {}) });

/** Der Kopf, der dem Auftrag im Hauptgespräch vorangestellt wird (nur dem Modell, nicht im Verlauf). */
export function uebergabeKopf(id) {
  return [
    `[Übergabe aus der Sprache ${id}] Besitzer hat per Sprache gefragt; der Sprach-Agent hat dir diesen Auftrag übergeben und Besitzer gesagt, dass du dich meldest.`,
    'Erledige ihn mit deinen Werkzeugen (Freigaben wie sonst). Deine letzte Antwort wird Besitzer vorgelesen: höchstens drei kurze Sätze, der erste mit dem Ergebnis,',
    'ohne Markdown, Listen, Pfade, Links oder Kennungen; Details gehören in den Text davor. Dauert es länger als eine Minute, starte einen Hintergrundjob und sag das.',
  ].join('\n');
}

/**
 * Aus einer Antwort die Sprechfassung: höchstens `maxSaetze` Sätze, ohne Listen, Code und Tabellen.
 * @returns {{ saetze: string[], mehr: boolean }}  `mehr`: Es gibt mehr, als gesprochen wird („Den Rest siehst du im Text.“)
 */
export function kurzfassung(roh, maxSaetze = UEBERGABE_VORGABE.sprechenMaxSaetze) {
  const s = new Satzstrom({ ersteMin: 36, max: 220 });
  const alle = [...s.schiebe(`${String(roh ?? '')}\n`), ...s.ende()].filter((h) => !h.liste).map((h) => sprechbar(h.text)).filter(Boolean);
  const mehr = alle.length > maxSaetze || s.uebersprungen.code || s.uebersprungen.tabelle;
  return { saetze: alle.slice(0, maxSaetze), mehr };
}

export class Uebergaben {
  /**
   * @param {object} p
   * @param {object} [p.cfg]                   Abschnitt `sprache.agent.uebergabe`
   * @param {object} p.runner                  braucht `sende`, `watchConversation`
   * @param {() => (string|number|undefined)} p.ziel   das Hauptgespräch
   * @param {(u: object) => Promise<boolean>|boolean} p.liefern  stellt das Ergebnis zu; `false` = später noch einmal
   * @param {(u: object, grund: string) => void} [p.beiFehler]
   */
  constructor({ cfg, runner, ziel, liefern, beiFehler = () => {}, jetzt = () => Date.now(), log = (z) => console.log(z) } = {}) {
    this.cfg = tief(UEBERGABE_VORGABE, cfg);
    this.runner = runner;
    this.ziel = ziel;
    this.liefern = liefern;
    this.beiFehler = beiFehler;
    this.jetzt = jetzt;
    this.log = log;
    this.liste = new Map(); // id → Übergabe
    this.stroeme = new Map(); // gespraech → { strom, aktuell, letzter, aktuellerText, deltas }
    this.zaehler = { uebergeben: 0, fertig: 0, fehler: 0, zeit: 0 };
  }

  /** Eine Übergabe annehmen. Dieselbe Kennung zweimal ist keine zweite Übergabe. */
  async uebergeben({ auftrag, id, zug = null } = {}) {
    const text = String(auftrag ?? '').trim();
    if (!text) throw new Error('Auftrag fehlt');
    if (!id) throw new Error('Kennung fehlt');
    if (this.liste.has(id)) return { ok: true, id, doppelt: true };
    const offen = [...this.liste.values()].filter((u) => u.status === 'offen' || (u.status === 'fertig' && !u.geliefert)).length;
    if (offen >= this.cfg.maxOffen) throw new Error(`Zu viele offene Übergaben (${offen}); eine davon muss erst fertig sein`);
    const gespraech = this.ziel();
    if (gespraech === undefined || gespraech === null) throw new Error('Kein Hauptgespräch');
    const u = {
      id,
      auftrag: text.slice(0, this.cfg.maxZeichen),
      gespraech,
      zug,
      status: 'offen',
      seit: this.jetzt(),
      begonnen: null,
      fertig: null,
      ergebnis: null,
      fehler: null,
      leise: false,
      geliefert: false,
    };
    await this.#abonnieren(gespraech);
    this.liste.set(id, u);
    try {
      await this.runner.sende(gespraech, u.auftrag, { art: 'folgen', requestId: `uebergabe:${id}`, kanal: UEBERGABE_KANAL, kopf: uebergabeKopf(id) });
    } catch (fehler) {
      this.liste.delete(id);
      throw fehler;
    }
    this.zaehler.uebergeben += 1;
    return { ok: true, id };
  }

  async #abonnieren(gespraech) {
    if (this.stroeme.has(gespraech)) return;
    const eintrag = { strom: null, aktuell: null, letzter: '', text: '', deltas: false, assistent: false };
    this.stroeme.set(gespraech, eintrag);
    try {
      eintrag.strom = await this.runner.watchConversation(gespraech);
      eintrag.strom.start((ereignisse) => this.beiEreignisse(gespraech, ereignisse));
    } catch (fehler) {
      this.stroeme.delete(gespraech);
      throw fehler;
    }
  }

  /** Ereignisse des Hauptgesprächs. Öffentlich, damit Tests sie hineinreichen können. */
  beiEreignisse(gespraech, batch) {
    for (const ev of Array.isArray(batch) ? batch : [batch]) {
      try {
        this.#ereignis(gespraech, ev);
      } catch (fehler) {
        this.log(`[fyos-sprache] Übergabe-Ereignis: ${String(fehler?.message ?? fehler).slice(0, 160)}`);
      }
    }
  }

  #ereignis(gespraech, ev) {
    const s = this.stroeme.get(gespraech);
    if (!s || !ev) return;
    switch (ev.type) {
      case 'message_start':
        if (s.aktuell && ev.message?.role === 'assistant') {
          s.assistent = true;
          s.deltas = false;
          s.text = '';
        }
        break;
      case 'message_update':
        if (!s.aktuell) break;
        for (const c of ev.changes ?? []) {
          if (c.type === 'text_delta' && c.delta) {
            s.deltas = true;
            s.text += c.delta;
          }
        }
        break;
      case 'message_end': {
        const e = ev.entry;
        // Beginn unserer Arbeit: die Nachricht, die wir gesendet haben (Kanal und Text stimmen).
        if (e?.kind === 'fyos.mensch' && e.data?.kanal === UEBERGABE_KANAL) {
          const u = [...this.liste.values()].find((x) => x.gespraech === gespraech && x.status === 'offen' && !x.begonnen && x.auftrag === String(e.data.text ?? '').trim());
          if (u) {
            u.begonnen = this.jetzt();
            s.aktuell = u;
            s.letzter = '';
            s.text = '';
            s.assistent = false;
          }
          break;
        }
        const m = e?.model?.[0];
        if (!s.aktuell || m?.role !== 'assistant') break;
        s.assistent = true;
        if (!s.deltas && Array.isArray(m.content)) s.text = m.content.filter((b) => b?.type === 'text' && b.text).map((b) => b.text).join('\n');
        if (s.text.trim()) s.letzter = s.text.trim();
        s.text = '';
        s.deltas = false;
        break;
      }
      case 'run_end':
        if (s.aktuell && s.assistent) this.#fertig(s.aktuell, { ergebnis: s.letzter }, s);
        break;
      case 'task_failed':
        if (s.aktuell) this.#fertig(s.aktuell, { fehler: String(ev.message ?? ev.kind ?? 'Aufgabe fehlgeschlagen') }, s);
        break;
      default:
    }
  }

  #fertig(u, { ergebnis = null, fehler = null }, s) {
    if (u.status !== 'offen') return;
    if (s) {
      s.aktuell = null;
      s.letzter = '';
      s.assistent = false;
    }
    u.fertig = this.jetzt();
    if (fehler) {
      u.status = 'fehler';
      u.fehler = fehler;
      this.zaehler.fehler += 1;
      this.beiFehler(u, fehler);
      u.geliefert = true;
      return;
    }
    u.status = 'fertig';
    u.ergebnis = ergebnis || null;
    this.zaehler.fertig += 1;
    void this.pruefen();
  }

  /** Besitzer hat „Stopp“ gesagt: Ergebnisse offener Übergaben kommen nur noch als Text. */
  leise() {
    for (const u of this.liste.values()) if (u.status === 'offen' || u.status === 'fertig') u.leise = true;
  }

  /** Zeitüberschreitungen und Ergebnisse, die noch zugestellt werden müssen (Besitzer spricht gerade, AirPods weg …). */
  pruefen() {
    this._lauf = (this._lauf ?? Promise.resolve()).then(() => this.#pruefen()).catch((f) => this.log(`[fyos-sprache] Übergaben: ${String(f?.message ?? f).slice(0, 160)}`));
    return this._lauf;
  }

  async #pruefen() {
    const jetzt = this.jetzt();
    for (const u of [...this.liste.values()]) {
      if (u.status === 'offen' && jetzt - u.seit > this.cfg.timeoutMin * 60_000) {
        const s = this.stroeme.get(u.gespraech);
        if (s?.aktuell === u) s.aktuell = null;
        u.status = 'zeit';
        u.fertig = jetzt;
        u.fehler = `keine Antwort nach ${this.cfg.timeoutMin} Minuten`;
        this.zaehler.zeit += 1;
        this.beiFehler(u, u.fehler);
        u.geliefert = true;
      } else if (u.status === 'fertig' && !u.geliefert) {
        let ok = false;
        try {
          ok = (await this.liefern(u)) !== false;
        } catch (fehler) {
          this.log(`[fyos-sprache] Ergebnis nicht zugestellt: ${String(fehler?.message ?? fehler).slice(0, 160)}`);
          ok = true; // nicht endlos wiederholen
        }
        if (ok) u.geliefert = true;
        else if (jetzt - u.fertig > 120_000) {
          // Besitzer war zwei Minuten nicht ansprechbar: das Ergebnis geht als Text hinaus.
          u.leise = true;
          u.geliefert = (await Promise.resolve(this.liefern(u)).catch(() => true)) !== false;
        }
      }
    }
    // Erledigtes verschwindet nach einer Stunde aus der Liste.
    for (const [id, u] of this.liste) if (u.geliefert && jetzt - (u.fertig ?? u.seit) > 3_600_000) this.liste.delete(id);
  }

  /** Für den Zustand: keine Aufträge und keine Ergebnisse, nur Zählung und Stand. */
  zustand() {
    const jetzt = this.jetzt();
    return {
      offen: [...this.liste.values()].filter((u) => u.status === 'offen').length,
      wartend_auf_zustellung: [...this.liste.values()].filter((u) => u.status === 'fertig' && !u.geliefert).length,
      liste: [...this.liste.values()].slice(-8).map((u) => ({ id: u.id, status: u.status, alter_s: Math.round((jetzt - u.seit) / 1000), geliefert: u.geliefert, leise: u.leise })),
      ...this.zaehler,
    };
  }

  async stop() {
    for (const s of this.stroeme.values()) await Promise.resolve(s.strom?.stop?.()).catch(() => {});
    this.stroeme.clear();
  }
}
