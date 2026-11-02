/**
 * wachen-zustand.js — was Taktgeber, ITSM-Wache und Chat-Wache sich merken müssen.
 *
 * Der RPC-Runner legt das in `takt.json`, `itsm.json` und `chat.json` ab. Hier ist es ein
 * pi-durable-Dokument in derselben SQLite-Datei wie die Gespräche: ein Neustart setzt dort fort,
 * wo die Wachen standen, und nichts wird doppelt ausgelöst. Dazu die paar Hilfen, die alle drei
 * Wachen gleich brauchen (Hub lesend aufrufen, Text kürzen, Schlaf, Logger).
 */
import { KONTEXT as CTX, dokument as defineDoc } from './lauf/index.js';

/**
 * itsm: { vorgaenge: { [id]: Stand }, bezuege: { [id]: ms } }
 * chat: { seit: '<ms>-<n>' | null }
 * takt: { [takt-id]: { soll, gefragt, erledigt, wie, warum, t } }
 * freigabemeldung: { [freigabe-id]: { kanaele: { [kanal]: ms }, zuletzt, erinnert } } (freigabe-meldung.js)
 * freigabereaktionen: { meldungen: { [matrix-ereignis-id]: { freigabe, text, chips, fertig, … } }, seit, gesehen, entfernt, zaehler } (freigabe-reaktionen.js)
 * arbeit: { vorgaenge, zuege, laufend, ohne_ergebnis, pause_bis, … } (die Arbeitsschleife, `arbeitsschleife.js`)
 */
export const WachenZustand = defineDoc({
  kind: 'fyos.wachen',
  version: 1,
  scope: 'session',
  initial: () => ({ version: 1, itsm: {}, chat: {}, takt: {}, freigabemeldung: {}, freigabereaktionen: {}, arbeit: {} }),
  checkpointWhen: () => false,
});

const json = (wert) => JSON.parse(JSON.stringify(wert ?? null));

/** Der gespeicherte Stand als reine Kopie; fehlt das Dokument noch, der Anfangszustand. */
export async function wachenLesen(harness) {
  const d = (await harness.snapshot(WachenZustand, CTX)) ?? {};
  return {
    version: 1,
    itsm: json(d.itsm) ?? {},
    chat: json(d.chat) ?? {},
    takt: json(d.takt) ?? {},
    freigabemeldung: json(d.freigabemeldung) ?? {},
    freigabereaktionen: json(d.freigabereaktionen) ?? {},
    arbeit: json(d.arbeit) ?? {},
  };
}

/** Ein Commit auf das Dokument: `aendern(d)` setzt die Felder, die sich geändert haben. */
export async function wachenAendern(harness, aendern) {
  await harness.commit(async (tx) => {
    const d = await tx.doc(WachenZustand);
    d.itsm ??= {};
    d.chat ??= {};
    d.takt ??= {};
    d.freigabemeldung ??= {};
    d.freigabereaktionen ??= {};
    d.arbeit ??= {};
    aendern(d);
  }, CTX);
}

/** Wie `hub_aufrufen` im RPC-Runner: ein lesendes Hub-Werkzeug; wirft bei jedem Fehler. */
export async function hubLesen(hub, werkzeug, argumente = {}, { timeoutMs = 15000, signal } = {}) {
  // `ansicht: null`: die ungekürzte Antwort, nicht die Kurzansicht des Hubs.
  const antwort = await hub.aufrufen(werkzeug, argumente, { ansicht: null, timeoutMs, signal });
  if (!antwort || antwort.ok !== true || !('result' in antwort)) {
    throw new Error(`Hub meldet: ${antwort?.fehler ?? antwort?.roh?.error ?? 'keine Antwort'}`);
  }
  return antwort.result;
}

export const kurz = (text, grenze) => (text.length <= grenze ? text : text.slice(0, Math.max(grenze - 1, 0)) + '…');

export const istObjekt = (w) => !!w && typeof w === 'object' && !Array.isArray(w);

/** Logger aus einem optionalen Objekt mit `info`/`warn`; sonst die Konsole mit Namen. */
export function logger(log, name) {
  return {
    info: (...a) => (log?.info ? log.info(...a) : console.log(`[${name}]`, ...a)),
    warn: (...a) => (log?.warn ? log.warn(...a) : console.warn(`[${name}]`, ...a)),
  };
}

/** Schlaf, den `stop()` sofort beenden kann. */
export class Schlaf {
  constructor() {
    this._timer = null;
    this._ende = null;
    this.beendet = false;
  }

  warten(ms) {
    return new Promise((fertig) => {
      if (this.beendet) return fertig();
      this._ende = () => {
        clearTimeout(this._timer);
        this._timer = null;
        this._ende = null;
        fertig();
      };
      this._timer = setTimeout(this._ende, ms);
      this._timer.unref?.();
    });
  }

  beenden() {
    this.beendet = true;
    this._ende?.();
  }
}

/** Eine Aufgabenkette: Aufrufe laufen nacheinander, auch wenn sie von verschiedenen Stellen kommen. */
export class Kette {
  constructor() {
    this._hinten = Promise.resolve();
  }

  lauf(fn) {
    const ergebnis = this._hinten.then(fn);
    this._hinten = ergebnis.catch(() => {});
    return ergebnis;
  }
}
