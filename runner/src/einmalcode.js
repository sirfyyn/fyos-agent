/**
 * einmalcode.js — Einmal-Codes für die Anmeldung im Browser (Variante C, docs/current/RUNNER-ANMELDUNG-VORSCHLAG.md).
 *
 * Ein Client mit dem Token im Kopf `Authorization: Bearer` holt sich über `POST /api/sitzung/code` einen kurzen Code, der genau einmal
 * und nur kurz gilt. Die Seite wird dann mit `/?code=…` geöffnet: Der Runner löst den Code ein, setzt das Cookie und leitet auf die
 * Adresse OHNE Code weiter. So steht kein Token in Fensterverlauf, Lesezeichen oder Proxy-Protokoll; ein Code, der dort doch landet,
 * ist längst verbraucht.
 *
 * Nur im Speicher: Ein Neustart des Runners macht offene Codes ungültig (sie leben ohnehin nur Sekunden).
 */
import { randomBytes } from 'node:crypto';

export const CODE_GUELTIG_S = 60;
export const CODE_MAX_OFFEN = 32;

export class EinmalCodes {
  #codes = new Map(); // code -> { geheim, bis }
  #jetzt;
  #gueltigMs;

  constructor({ jetzt = () => Date.now(), gueltig_s = CODE_GUELTIG_S } = {}) {
    this.#jetzt = jetzt;
    this.#gueltigMs = gueltig_s * 1000;
  }

  /** Abgelaufene Codes wegräumen. */
  #aufraeumen() {
    const t = this.#jetzt();
    for (const [code, e] of this.#codes) if (e.bis <= t) this.#codes.delete(code);
  }

  /** Neuen Code für `geheim` (das vorgezeigte Token) ausstellen. Zu viele offene Codes: null (der Aufrufer meldet 429). */
  ausstellen(geheim) {
    this.#aufraeumen();
    if (!geheim || this.#codes.size >= CODE_MAX_OFFEN) return null;
    const code = randomBytes(24).toString('base64url');
    this.#codes.set(code, { geheim, bis: this.#jetzt() + this.#gueltigMs });
    return code;
  }

  /** Code einlösen: gibt das Token zurück und löscht den Code (genau einmal). Unbekannt oder abgelaufen: null. */
  einloesen(code) {
    this.#aufraeumen();
    const e = typeof code === 'string' ? this.#codes.get(code) : undefined;
    if (!e) return null;
    this.#codes.delete(code);
    return e.geheim;
  }

  get offen() {
    this.#aufraeumen();
    return this.#codes.size;
  }

  get gueltig_s() {
    return this.#gueltigMs / 1000;
  }
}
