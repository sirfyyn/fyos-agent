/**
 * aufgaben.js — der Wächter für Hub-Aufgaben (MCP Tasks, docs/current/MCP-TASKS.md).
 *
 * `hub_aufrufen` mit `aufgabe: true` startet ein langes Hub-Werkzeug und beendet den Zug. Der Vermerk steht im Dokument
 * `fyos.hub-aufgaben` (dieselbe SQLite-Datei wie die Gespräche). Dieser Wächter liest das Dokument, fragt den Hub mit
 * `pollIntervalMs` (1 bis 30 s) nach dem Stand und stellt das Ergebnis als Eingang `aufgabe` (Bezug = taskId) in das
 * Gespräch, das die Aufgabe gestartet hat.
 *
 * Regeln:
 *  - Neustart-fest: nichts liegt nur im Speicher. Die `requestId` des Eingangs (`aufgabe:<taskId>:<zustand>`) macht die
 *    Zustellung einmalig, auch wenn der Prozess zwischen Zustellung und Vermerk stirbt.
 *  - Ein Fehler hält den Dienst nie an: Hub nicht erreichbar → Abfrage wird mit wachsendem Abstand wiederholt; nach
 *    20 Minuten ununterbrochener Fehler oder bei „unbekannt“ (404) gilt die Aufgabe als verloren und wird einmal so gemeldet.
 *  - `input_required` wird einmal je Satz offener Schlüssel gemeldet; das Modell antwortet mit `hub_aufgabe`.
 */
import { KONTEXT, gespraechOeffnen, zugStarten } from './lauf/index.js';
import { HubAufgaben } from './documents.js';
import { Hub, HubFehler } from './hub.js';

const CTX = KONTEXT;

export const ENDGUELTIG = new Set(['completed', 'failed', 'cancelled']);
export const POLL_MIN_MS = 1000;
export const POLL_MAX_MS = 30_000;
export const FEHLER_GRENZE_MS = 20 * 60 * 1000;
const AUFBEWAHREN_MS = 7 * 24 * 3600 * 1000;

export const abstand = (ms) => Math.max(POLL_MIN_MS, Math.min(POLL_MAX_MS, Number(ms) || 2000));

const KURZ = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** Der Text, den das Modell als Eingang bekommt. `a` ist die Antwort von `tasks/get` (oder `{status:'verloren', grund}`). */
export function eingangsText(eintrag, a, grenze = 24000) {
  const kopf = `Hub-Aufgabe ${eintrag.taskId} (${eintrag.werkzeug})`;
  switch (a.status) {
    case 'completed': {
      const r = a.result;
      if (r && typeof r === 'object' && r.ok === false) {
        return `${kopf} ist fertig, das Werkzeug meldet aber einen Fehler: ${KURZ(r.error ?? r.meldung ?? 'ok=false', 600)}`;
      }
      const inhalt = r && typeof r === 'object' && 'result' in r ? r.result : r;
      return `${kopf} ist fertig.\n\n${Hub.alsText(inhalt, grenze) || '(leeres Ergebnis)'}`;
    }
    case 'failed':
      return `${kopf} ist fehlgeschlagen: ${KURZ(a.error?.message ?? a.statusMessage ?? 'unbekannter Fehler', 600)}`;
    case 'cancelled':
      return `${kopf} wurde abgebrochen.`;
    case 'input_required': {
      const zeilen = Object.entries(a.inputRequests ?? {}).map(([k, v]) => {
        const p = v?.params ?? {};
        return `- ${k}: ${KURZ(p.message ?? '', 300)}${p.requestedSchema ? ` (Schema: ${KURZ(JSON.stringify(p.requestedSchema), 400)})` : ''}`;
      });
      return (
        `${kopf} wartet auf Eingabe:\n${zeilen.join('\n')}\n\n` +
        `Antworte mit hub_aufgabe(aktion: "antworten", taskId: "${eintrag.taskId}", antworten: {"<schluessel>": {"action": "accept", "content": {...}}}).`
      );
    }
    case 'verloren':
      return `${kopf} ist verloren: ${KURZ(a.grund, 400)} Ob das Werkzeug gewirkt hat, ist ungewiss; prüfe das Ergebnis am Ziel, bevor du es wiederholst.`;
    default:
      return `${kopf}: Stand ${a.status}.`;
  }
}

export class AufgabenWaechter {
  constructor({ runner, hub, cfg, tickMs = 1000, jetzt = () => Date.now(), onFehler } = {}) {
    this.runner = runner;
    this.hub = hub ?? runner?.hub;
    this.cfg = cfg ?? runner?.cfg;
    this.tickMs = tickMs;
    this.jetzt = jetzt;
    this.onFehler = onFehler ?? ((e) => console.error(`[fyos-aufgaben] ${e?.message ?? e}`));
    this.aktiv = false;
    this.laeuft = false;
    this._schlaf = null;
    this._wecken = null;
    this.letzterFehler = null;
  }

  get grenze() {
    return this.cfg?.pi_durable?.limits?.maxToolOutput ?? 24000;
  }

  get harness() {
    return this.runner.harness;
  }

  async start() {
    if (this.aktiv) return;
    this.aktiv = true;
    await this.#aufraeumen().catch((e) => this.onFehler(e));
    void this.#schleife();
  }

  async stop() {
    this.aktiv = false;
    if (this._schlaf) clearTimeout(this._schlaf);
    this._schlaf = null;
    this._wecken?.();
    this._wecken = null;
  }

  async #schleife() {
    if (this.laeuft) return;
    this.laeuft = true;
    while (this.aktiv) {
      try {
        await this.tick();
      } catch (fehler) {
        this.letzterFehler = String(fehler?.message ?? fehler);
        this.onFehler(fehler);
      }
      if (this.aktiv) await this.#warten(this.tickMs);
    }
    this.laeuft = false;
  }

  #warten(ms) {
    return new Promise((fertig) => {
      this._wecken = fertig;
      this._schlaf = setTimeout(() => {
        this._schlaf = null;
        this._wecken = null;
        fertig();
      }, ms);
      this._schlaf.unref?.();
    });
  }

  /** Alte, zugestellte Einträge nach einer Woche entfernen. */
  async #aufraeumen() {
    const jetzt = this.jetzt();
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(HubAufgaben);
      for (const [id, e] of Object.entries(doc.eintraege)) {
        if (e.zugestellt && jetzt - (e.zugestelltAm ?? e.erstellt ?? 0) > AUFBEWAHREN_MS) delete doc.eintraege[id];
      }
    }, CTX);
  }

  /** Ein Durchgang: jede fällige, noch nicht zugestellte Aufgabe einmal abfragen. Wirft nie wegen einer einzelnen Aufgabe. */
  async tick() {
    const doc = (await this.harness.snapshot(HubAufgaben, CTX)) ?? { eintraege: {} };
    const jetzt = this.jetzt();
    let n = 0;
    for (const e of Object.values(doc.eintraege ?? {})) {
      if (e.zugestellt || (e.naechsteAbfrage ?? 0) > jetzt) continue;
      try {
        await this.#abfragen(e);
        n += 1;
      } catch (fehler) {
        this.onFehler(fehler);
      }
    }
    return n;
  }

  async #abfragen(e) {
    let a;
    try {
      a = await this.hub.aufgabeStand(e.taskId);
    } catch (fehler) {
      if (fehler instanceof HubFehler && fehler.status === 404) {
        return this.#zustellen(e, {
          status: 'verloren',
          grund: 'Der Hub kennt die Aufgabe nicht mehr (abgelaufen oder verloren).',
        });
      }
      return this.#fehlschlag(e, fehler);
    }
    const jetzt = this.jetzt();
    if (ENDGUELTIG.has(a.status)) return this.#zustellen(e, a);
    if (a.status === 'input_required') {
      const schluessel = `input_required:${Object.keys(a.inputRequests ?? {}).sort().join(',')}`;
      if (!e.gemeldet?.[schluessel]) {
        await this.#eingang(e, a, `aufgabe:${e.taskId}:${schluessel}`);
        await this.#vermerken(e.taskId, (x) => {
          x.gemeldet = { ...(x.gemeldet ?? {}), [schluessel]: jetzt };
        });
      }
    }
    await this.#vermerken(e.taskId, (x) => {
      x.status = a.status;
      x.letzteAbfrage = jetzt;
      x.fehler = 0;
      x.fehlerSeit = null;
      x.pollIntervalMs = abstand(a.pollIntervalMs);
      x.naechsteAbfrage = jetzt + abstand(a.pollIntervalMs);
    });
  }

  async #fehlschlag(e, fehler) {
    const jetzt = this.jetzt();
    const seit = e.fehlerSeit ?? jetzt;
    if (jetzt - seit > FEHLER_GRENZE_MS) {
      return this.#zustellen(e, {
        status: 'verloren',
        grund: `Der Hub war über ${Math.round(FEHLER_GRENZE_MS / 60000)} Minuten nicht abfragbar (${KURZ(fehler?.message, 200)}).`,
      });
    }
    const n = (e.fehler ?? 0) + 1;
    if (n === 1) this.onFehler(new Error(`Hub-Aufgabe ${e.taskId}: Abfrage scheitert (${fehler?.message ?? fehler}); versuche es weiter`));
    await this.#vermerken(e.taskId, (x) => {
      x.fehler = n;
      x.fehlerSeit = seit;
      x.letzterFehler = KURZ(fehler?.message ?? fehler, 300);
      x.letzteAbfrage = jetzt;
      x.naechsteAbfrage = jetzt + Math.min(POLL_MAX_MS, 2000 * 2 ** Math.min(n, 5));
    });
  }

  /** Eingang zustellen (idempotent über requestId), dann vermerken. */
  async #zustellen(e, a) {
    await this.#eingang(e, a, `aufgabe:${e.taskId}:${a.status}`);
    const jetzt = this.jetzt();
    await this.#vermerken(e.taskId, (x) => {
      x.status = a.status;
      x.zugestellt = true;
      x.zugestelltAm = jetzt;
      x.letzteAbfrage = jetzt;
    });
  }

  async #eingang(e, a, requestId) {
    const text = eingangsText(e, a, this.grenze);
    let conv = await gespraechOeffnen(this.harness, e.conversationId);
    if (!conv && this.runner.root) conv = await gespraechOeffnen(this.harness, this.runner.root.id);
    if (!conv) throw new Error(`Zielgespräch ${e.conversationId} fehlt`);
    await zugStarten(conv, {
      text: `Eingang von aufgabe · Bezug ${e.taskId}. Hintergrundnachricht.\n\n${text}`,
      wennBeschaeftigt: 'folgen',
      anfrageId: requestId,
      eintrag: {
        art: 'fyos.aufgabe',
        daten: {
          quelle: 'aufgabe',
          bezug: e.taskId,
          werkzeug: e.werkzeug,
          status: a.status,
          text: KURZ(text, 4000),
          zeit: this.jetzt(),
        },
      },
    });
  }

  async #vermerken(taskId, aendern) {
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(HubAufgaben);
      const x = doc.eintraege[taskId];
      if (x) aendern(x);
    }, CTX);
  }
}
