/**
 * freigabe-reaktionen.js — Reaktions-Chips an der Matrix-Freigabemeldung (Besitzer 26.10.2026, „1“ = vorbelegte Reaktionen).
 *
 * Zu jeder Einzelmeldung einer offenen Freigabe setzt der Bot die Chips ✅ erlauben, ❌ ablehnen, ⏳ später (✅ nur bei Risiko
 * niedrig/mittel und nicht zerstörerisch, sonst nur ❌ ⏳). Besitzer tippt einen Chip an; der Matrix-Lauscher (Hauptserver, 127.0.0.1:18437) puffert
 * seine Reaktion, der Runner holt sie hier ab (`GET /reaktionen?seit=`), prüft die Regeln und entscheidet über denselben Weg wie die App
 * (`runner.entscheideFreigabe`, Absender `matrix-reaktion`, Revisionsspur im Gespräch).
 *
 * Regeln (alle hier, der Lauscher entscheidet nichts):
 *   - nur das Konto Besitzer (`matrix.reaktionen.absender`), nur auf einer Meldung, die der Runner selbst gemeldet hat (Ereignis-Id bekannt),
 *     nur bei noch offener Freigabe, nur einmal (Ereignis-Id der Reaktion wird gemerkt, dazu der Status der Freigabe),
 *   - ✅ und 👍 = erteilt, aber nur wenn `freigabeStimmeErlaubt` (low/medium, nicht zerstörerisch, wie bei der Stimme); sonst Antwort-Hinweis, keine Wirkung,
 *   - ❌ und 👎 = abgelehnt (immer),
 *   - ⏳ = später: die Freigabe bleibt offen (kein Verfall), nur die nächste Erinnerung rückt um `spaeter_s` nach hinten,
 *   - eine Reaktion, die Besitzer vor dem Abholen wieder entfernt, gilt nicht; nach der Entscheidung ändert eine Entfernung nichts.
 * Zustand im Dokument `WachenZustand`, Schlüssel `freigabereaktionen` (übersteht Neustarts): Zuordnung Meldungs-Id → Freigabe, abgeholte
 * Position, gesehene Reaktions-Ids, Zähler. Standard AUS (`pi_durable.freigabe_meldung.matrix.reaktionen.an`).
 *
 * Ehrliche Grenzen: Der Lauscher muss laufen (sonst kommt nichts an, die App bleibt der Weg); nach der Entscheidung markiert der Runner die
 * Meldung(en) per Bearbeitung als erledigt, zieht die Chips zurück und schreibt eine Bestätigungszeile; schlägt das fehl, ist die
 * Entscheidung trotzdem gültig (Zähler `fehler`).
 */
import { freigabeStimmeErlaubt } from './sprache.js';
import { Kette, kurz, logger } from './wachen-zustand.js';
import { tx } from './i18n.js';

/** Decision word for people (`erteilt` → granted …), German stays as stored. */
const wortFuer = (w) => tx(w, { erteilt: 'granted', abgelehnt: 'denied', offen: 'open' }[w] ?? w);

/** Taste → Wirkung. Variantenselektoren werden vorher entfernt. */
export const TASTEN = { '✅': 'erteilt', '👍': 'erteilt', '❌': 'abgelehnt', '👎': 'abgelehnt', '⏳': 'spaeter' };
const GESEHEN_MAX = 400;
const AUFHEBEN_MS = 7 * 24 * 3600 * 1000;

/** Darf diese Freigabe per Reaktion erteilt werden? Gleiche Regel wie per Stimme: niedrig/mittel, nie zerstörerisch. */
export const erlaubenErlaubt = (f) => freigabeStimmeErlaubt(f, 'medium');

/** Die Chips, die der Bot an die Meldung zu dieser Freigabe setzt. */
export const chipsFuer = (f) => (erlaubenErlaubt(f) ? ['✅', '❌', '⏳'] : ['❌', '⏳']);

const leer = () => ({ meldungen: {}, seit: 0, gesehen: [], entfernt: [], zaehler: {} });
const ZAEHLER = ['gesetzt', 'angenommen', 'abgelehnt', 'zurueckgestellt', 'ignoriert', 'verweigert', 'fehler'];

export class FreigabeReaktionen {
  /**
   * @param kanal         Matrix-Kanal mit reagieren(eventId, emoji), zurueckziehen(eventId), bearbeiten(eventId, text), antworten(text, bezug), reaktionenLesen(seit)
   * @param freigaben     async () => Array der Freigaben (alle Stati)
   * @param entscheiden   async (id, {entscheidung, notiz, von}) — `runner.entscheideFreigabe`
   * @param zurueckstellen async (id, bisMs) — verschiebt die nächste Erinnerung (FreigabeMeldung.zurueckstellen)
   * @param speicher      {lesen(): {freigabereaktionen}, aendern(fn)}
   */
  constructor({ konfig, kanal, freigaben, entscheiden, zurueckstellen = async () => false, speicher, log, jetzt = () => Date.now() } = {}) {
    this.kfg = konfig.matrix.reaktionen;
    this.kanal = kanal;
    this.freigaben = freigaben;
    this.entscheiden = entscheiden;
    this.zurueckstellen = zurueckstellen;
    this.speicher = speicher;
    this.log = logger(log, 'fyos-freigabe-reaktionen');
    this.jetzt = jetzt;
    this._kette = new Kette();
    this._timer = null;
    this._aktiv = false;
    this.letzterFehler = null;
    this.letzterLauf = null;
    this.offen = 0;
    this._zaehler = {};
    this._meldungen = 0;
  }

  get an() {
    return this.kfg.an === true && Boolean(this.kanal);
  }

  start() {
    if (!this.an || this._aktiv) return false;
    this._aktiv = true;
    this._timer = setInterval(() => void this.pruefen().catch(() => {}), this.kfg.pruefenS * 1000);
    this._timer.unref?.();
    this.log.info(`Freigabe-Reaktionen an (Absender ${this.kfg.absender})`);
    return true;
  }

  async stop() {
    this._aktiv = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    await this._kette.lauf(async () => {});
  }

  async #stand() {
    const roh = (await this.speicher.lesen()).freigabereaktionen;
    const st = { ...leer(), ...(roh && typeof roh === 'object' ? JSON.parse(JSON.stringify(roh)) : {}) };
    this._zaehler = { ...st.zaehler };
    this._meldungen = Object.keys(st.meldungen).length;
    return st;
  }

  #aendern(fn) {
    return this.speicher.aendern((d) => {
      d.freigabereaktionen ??= {};
      const s = d.freigabereaktionen;
      s.meldungen ??= {};
      s.gesehen ??= [];
      s.entfernt ??= [];
      s.zaehler ??= {};
      s.seit ??= 0;
      fn(s);
      this._zaehler = { ...s.zaehler }; // Spiegel für das synchrone zustand()
      this._meldungen = Object.keys(s.meldungen).length;
    });
  }

  #zaehlen(name, n = 1) {
    return this.#aendern((s) => void (s.zaehler[name] = (Number(s.zaehler[name]) || 0) + n));
  }

  /**
   * Nach dem Senden einer Einzelmeldung: Zuordnung Ereignis-Id ↔ Freigabe dauerhaft festhalten, dann die Chips setzen.
   * Die Zuordnung kommt zuerst; setzt ein Chip nicht, kann Besitzer trotzdem selbst eine Taste an die Meldung hängen.
   */
  async meldungMerken({ eventId, freigabe, text = '', bezug = '' }) {
    if (!this.an || !eventId || !freigabe?.id) return { chips: 0 };
    const jetzt = this.jetzt();
    await this.#aendern((s) => {
      s.meldungen[eventId] = { freigabe: freigabe.id, text: String(text).slice(0, 3000), bezug: String(bezug).slice(0, 60), chips: {}, erstellt: jetzt, fertig: null, hinweis: false };
    });
    const gesetzt = {};
    for (const emoji of chipsFuer(freigabe)) {
      const r = await this.kanal.reagieren(eventId, emoji).catch((f) => ({ ok: false, grund: String(f?.message ?? f) }));
      if (r?.ok && !r.schatten) gesetzt[emoji] = r.eventId ?? null;
      else if (!r?.ok) {
        this.letzterFehler = kurz(String(r?.grund ?? 'Chip nicht gesetzt'), 120);
        await this.#zaehlen('fehler');
      }
    }
    await this.#aendern((s) => {
      if (s.meldungen[eventId]) s.meldungen[eventId].chips = gesetzt;
    });
    await this.#zaehlen('gesetzt', Object.keys(gesetzt).length);
    return { chips: Object.keys(gesetzt).length };
  }

  pruefen() {
    return this._kette.lauf(() => this.#runde());
  }

  async #runde() {
    if (!this.an) return { verarbeitet: 0 };
    const jetzt = this.jetzt();
    let verarbeitet = 0;
    try {
      const alle = await this.freigaben();
      const nachId = new Map((alle ?? []).filter((f) => f?.id).map((f) => [f.id, f]));
      let st = await this.#stand();

      // 1. In der App (oder sonst wo) entschiedene oder verschwundene Freigaben: Meldung als erledigt markieren, Chips weg.
      for (const [eid, m] of Object.entries(st.meldungen)) {
        if (m.fertig) continue;
        const f = nachId.get(m.freigabe);
        if (f && f.status === 'offen') continue;
        const wort = f
          ? `${tx('Erledigt', 'Done')}: ${wortFuer(f.status)}${f.entschiedenVon ? ` (${kurz(String(f.entschiedenVon), 30)})` : ''}`
          : tx('Erledigt: Freigabe nicht mehr vorhanden', 'Done: approval no longer exists');
        await this.#abschliessen(eid, m, wort);
      }
      st = await this.#stand();
      const offene = Object.values(st.meldungen).filter((m) => !m.fertig && nachId.get(m.freigabe)?.status === 'offen');
      this.offen = offene.length;

      // 2. Reaktionen abholen, nur wenn es etwas zu entscheiden gibt.
      if (offene.length) {
        const antwort = await this.kanal.reaktionenLesen(st.seit);
        if (!antwort?.ok) throw new Error(antwort?.grund ?? 'Lauscher nicht erreichbar');
        let seit = st.seit;
        if (Number(antwort.naechste) < st.seit) {
          // Der Lauscher zählt neu (frischer Zustand): von vorn lesen, doppelte Reaktions-Ids fängt `gesehen` ab.
          seit = 0;
          await this.#aendern((s) => void (s.seit = 0));
        }
        const ereignisse = (antwort.ereignisse ?? []).filter((e) => Number(e.n) > seit).sort((a, b) => a.n - b.n);
        const entferntImLauf = new Set(ereignisse.filter((e) => e.typ === 'entfernt').map((e) => e.ziel));
        for (const e of ereignisse) {
          await this.#ereignis(e, entferntImLauf, jetzt);
          verarbeitet += 1;
        }
      }

      // 3. Altes wegräumen.
      await this.#aendern((s) => {
        for (const [eid, m] of Object.entries(s.meldungen)) if (m.fertig && jetzt - m.fertig > AUFHEBEN_MS) delete s.meldungen[eid];
        s.gesehen = s.gesehen.slice(-GESEHEN_MAX);
        s.entfernt = s.entfernt.slice(-GESEHEN_MAX);
      });
      this.letzterFehler = null;
    } catch (f) {
      this.letzterFehler = kurz(String(f?.message ?? f), 160);
      this.log.warn(`Freigabe-Reaktionen: ${this.letzterFehler}`);
    }
    this.letzterLauf = jetzt;
    return { verarbeitet };
  }

  /** Eine abgeholte Reaktion oder Entfernung behandeln und danach die Position festhalten (höchstens ein Ereignis wird bei Absturz doppelt gesehen). */
  async #ereignis(e, entferntImLauf, jetzt) {
    const ign = async () => {
      await this.#aendern((s) => {
        s.zaehler.ignoriert = (Number(s.zaehler.ignoriert) || 0) + 1;
        s.seit = Math.max(s.seit, Number(e.n) || 0);
      });
    };
    const fertig = (extra) =>
      this.#aendern((s) => {
        if (e.id && !s.gesehen.includes(e.id)) s.gesehen.push(e.id);
        s.seit = Math.max(s.seit, Number(e.n) || 0);
        extra?.(s);
      });
    const st = await this.#stand();

    if (e.typ === 'entfernt') {
      const schonBehandelt = st.gesehen.includes(e.ziel);
      await fertig((s) => {
        if (!s.entfernt.includes(e.ziel)) s.entfernt.push(e.ziel);
        if (schonBehandelt) s.zaehler.ignoriert = (Number(s.zaehler.ignoriert) || 0) + 1; // nach der Entscheidung ohne Wirkung
      });
      return;
    }
    if (e.typ !== 'reaktion') return ign();
    if (e.sender !== this.kfg.absender) return ign(); // fremdes Konto
    if (st.gesehen.includes(e.id)) return ign(); // doppelt
    if (entferntImLauf.has(e.id) || st.entfernt.includes(e.id)) {
      await fertig((s) => void (s.zaehler.ignoriert = (Number(s.zaehler.ignoriert) || 0) + 1));
      return;
    }
    const m = st.meldungen[e.ziel];
    if (!m) return ign(); // nicht unsere Meldung
    const taste = String(e.key ?? '').replace(/️/g, '');
    const wirkung = TASTEN[taste];
    if (!wirkung) return ign();
    const alle = await this.freigaben();
    const f = (alle ?? []).find((x) => x?.id === m.freigabe);
    if (!f || f.status !== 'offen') {
      await fertig((s) => void (s.zaehler.ignoriert = (Number(s.zaehler.ignoriert) || 0) + 1)); // veraltet
      return;
    }
    const nenn = kurz(String(f.id).replace(/[^A-Za-z0-9._:-]/g, ''), 40);

    if (wirkung === 'spaeter') {
      await this.zurueckstellen(f.id, this.jetzt() + this.kfg.spaeterS * 1000).catch(() => false);
      await fertig((s) => void (s.zaehler.zurueckgestellt = (Number(s.zaehler.zurueckgestellt) || 0) + 1));
      await this.#sagen(tx(
        `Freigabe ${nenn} zurückgestellt per ⏳, bleibt offen (nächste Erinnerung in ${Math.round(this.kfg.spaeterS / 60)} min).`,
        `Approval ${nenn} postponed via ⏳, stays open (next reminder in ${Math.round(this.kfg.spaeterS / 60)} min).`,
      ), nenn);
      return;
    }
    if (wirkung === 'erteilt' && !erlaubenErlaubt(f)) {
      await fertig((s) => {
        s.zaehler.verweigert = (Number(s.zaehler.verweigert) || 0) + 1;
        s.zaehler.ignoriert = (Number(s.zaehler.ignoriert) || 0) + 1;
      });
      if (!m.hinweis) {
        await this.#aendern((s) => {
          if (s.meldungen[e.ziel]) s.meldungen[e.ziel].hinweis = true;
        });
        await this.#sagen(tx(
          `Freigabe ${nenn}: Erlauben nur in der App (Halten), Risiko ${f.risiko === 'high' ? 'hoch' : f.zerstoererisch ? 'zerstörend' : 'unbekannt'}. Ablehnen (❌) geht hier.`,
          `Approval ${nenn}: allow only in the app (hold), risk ${f.risiko === 'high' ? 'high' : f.zerstoererisch ? 'destructive' : 'unknown'}. Deny (❌) works here.`,
        ), nenn);
      }
      return;
    }

    try {
      await this.entscheiden(f.id, { entscheidung: wirkung, notiz: `per Matrix-Reaktion ${taste}`, von: 'matrix-reaktion' });
    } catch (fehler) {
      const text = String(fehler?.message ?? fehler);
      await fertig((s) => {
        const name = /bereits/.test(text) ? 'ignoriert' : 'fehler';
        s.zaehler[name] = (Number(s.zaehler[name]) || 0) + 1;
      });
      if (!/bereits/.test(text)) this.letzterFehler = kurz(text, 120);
      return;
    }
    await fertig((s) => {
      const name = wirkung === 'erteilt' ? 'angenommen' : 'abgelehnt';
      s.zaehler[name] = (Number(s.zaehler[name]) || 0) + 1;
    });
    const wort = tx(`Freigabe ${nenn} ${wirkung} per ${taste}`, `Approval ${nenn} ${wortFuer(wirkung)} via ${taste}`);
    await this.#sagen(wort, nenn);
    // Alle Meldungen (Erinnerungen) zu dieser Freigabe als erledigt markieren, Chips zurücknehmen.
    const frisch = await this.#stand();
    for (const [eid, mm] of Object.entries(frisch.meldungen)) {
      if (mm.freigabe === f.id && !mm.fertig) await this.#abschliessen(eid, mm, tx(`Erledigt: ${wirkung} per ${taste}`, `Done: ${wortFuer(wirkung)} via ${taste}`));
    }
  }

  /** Bestätigungs- oder Hinweiszeile in den Raum; ein Fehler ändert an der Entscheidung nichts. */
  async #sagen(text, bezug) {
    const r = await this.kanal.antworten(text, `Freigabe ${bezug}`).catch((f) => ({ ok: false, grund: String(f?.message ?? f) }));
    if (!r?.ok) {
      this.letzterFehler = kurz(String(r?.grund ?? 'Antwort nicht gesendet'), 120);
      await this.#zaehlen('fehler');
    }
  }

  /** Meldung als erledigt kennzeichnen: Text ergänzen (Bearbeitung), Chips des Bots zurückziehen. Fehler zählen, brechen aber nichts ab. */
  async #abschliessen(eid, m, wort) {
    await this.#aendern((s) => {
      if (s.meldungen[eid]) s.meldungen[eid].fertig = this.jetzt();
    });
    const b = await this.kanal.bearbeiten(eid, `${m.text}\n\n— ${wort}`, m.bezug).catch((f) => ({ ok: false, grund: String(f?.message ?? f) }));
    if (!b?.ok) await this.#zaehlen('fehler');
    for (const chipId of Object.values(m.chips ?? {})) {
      if (!chipId) continue;
      const z = await this.kanal.zurueckziehen(chipId).catch((f) => ({ ok: false, grund: String(f?.message ?? f) }));
      if (!z?.ok) await this.#zaehlen('fehler');
    }
  }

  /** Für /zustand.freigabe_meldung.reaktionen: nur Zähler und Zustand, keine Inhalte, keine Ids, keine URLs. */
  zustand() {
    const z = { an: this.an, offen: this.offen, letzter_lauf: this.letzterLauf, letzter_fehler: this.letzterFehler };
    if (!this.an) return z;
    for (const n of ZAEHLER) z[n] = Number(this._zaehler[n]) || 0;
    z.meldungen = this._meldungen;
    return z;
  }
}
