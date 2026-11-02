/**
 * sprache.js — die Sprachsitzung des Runners (docs/current/RUNNER-SPRACHE.md, Protokoll: FYOS-CLIENT-PROTOKOLL.md#sprache).
 *
 * Der Runner spricht und hört selbst nicht. Er ist die Mitte zwischen zwei Seiten:
 *   Client (Mac, iPhone)  →  Äußerung (Text, vom Ohr erkannt)  →  Runner  →  Zug im Gespräch (Modell)
 *   Client                ←  `sprechen`-Ereignisse (Häppchen)  ←  Runner  ←  Text-Deltas des Zugs
 * Die Häppchen gehen an die Stimme (VoxCPM2, Hauptserver) und von dort in die AirPods; das macht der Client. Hier liegen die Regeln:
 *
 *  - AirPods-Regel: gesprochen wird nur, wenn ein Client frisch „AirPods aktiv“ meldet (`ausgabeMelden`). Sonst gibt es nur
 *    `mitteilung`-Ereignisse (Text). Die Regel gilt im Client und hier.
 *  - Antworten werden satzweise gestreamt (sprache-text.js), Barge-in bricht den Zug ab oder hält ihn an, die Teilantwort wird markiert.
 *  - Proaktive Ansprache läuft durch eine Richtlinie (Ruhe/Spielmodus, Aufmerksamkeit, AirPods, Nachtruhe, Kalender, Präsenz,
 *    Abkühlzeit, Rate), fragt zuerst „Darf ich?“ und zieht sich bei Nein oder Schweigen zurück. Standard: AUS (`proaktiv.an`).
 *  - Freigaben werden mit Kurzkontext vorgelesen; per Stimme entscheidet nur niedriges/mittleres, nicht zerstörerisches Risiko,
 *    nur über AirPods und nur, was gerade vorgelesen wurde.
 *
 * Alles hier ist testbar ohne Geräte: Runner, Tor, Kalender, Schnellweg und Mitteilungsweg werden hineingereicht.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Satzstrom, sprechbar } from './sprache-text.js';
import { kalender, mitteilung } from './sprache-anschluss.js';
import { Uebergaben, kurzfassung } from './sprache-uebergabe.js';

// Die Schnittstellen zu Kalender und Mitteilungsweg (E10) liegen in sprache-anschluss.js und gehören zur Oberfläche dieses Moduls.
export { kalender, mitteilung };

export const DRINGLICHKEITEN = ['info', 'wichtig', 'dringend'];
export const ROUTEN = ['airpods', 'andere', 'keine'];
const RANG = { info: 0, wichtig: 1, dringend: 2 };
const RISIKO_RANG = { low: 0, medium: 1, high: 2 };

export const VORGABE = {
  an: true,
  gespraech: null,
  sitzungMaxMin: 15,
  ausgabe: { maxAlterS: 90, geraeteMuster: 'airpods', uids: [] },
  sprechen: { ersteMin: 36, maxZeichen: 220, listeMax: 4, quittungMs: 1500, quittungen: ['Moment.', 'Ich schaue nach.'] },
  proaktiv: {
    an: false,
    maxProStunde: 3,
    abkuehlungMin: 10,
    abkuehlungMaxMin: 240,
    anfrageTimeoutS: 15,
    spaeterMin: 30,
    spaeterMax: 2,
    infoVerfaelltMin: 120,
    wichtigVerfaelltMin: 720,
    warteschlangeMax: 20,
    aktivMaxS: 600,
    stoppRuheMin: 5,
    gemutetStunden: 24,
    pruefenS: 10,
    stille: { an: true, von: '22:00', bis: '07:00', zone: 'Europe/Berlin' },
  },
  freigabe: { stimmeMaxRisiko: 'medium', vorgelesenTtlS: 180 },
  // E2: Sprach-Agent „Persona Sprache“ (sprache-agent.js). Aus, bis Besitzer es einschaltet; dann antwortet nicht das Hauptgespräch, sondern das kurze Sprachgespräch.
  agent: { an: false, modell: null, maxZuege: 40, kopfDatei: null, uebergabe: { timeoutMin: 30, maxOffen: 4 } },
  // E1: Vorrang der Sprache auf GPU1. Meldet `vorrang().aktiv`, solange gesprochen wird oder Besitzer gerade gesprochen hat; die Provider-Kette (Zweig
  // feat/ersatzdenker-schatten) und der Wächter von fyos-ersatzdenker lesen es. `sprachAgentAusnahme`: der Sprach-Agent selbst darf den Ersatzdenker nutzen.
  vorrang_gpu1: { an: true, providers: ['ersatzdenker'], nachlaufS: 20, sprachAgentAusnahme: true },
  // E10: Anschlüsse. Der Kalender liest nur; die Mitteilung sendet nur mit eingetragenen Kanälen (Vorgabe: keine).
  kalender: { an: true, werkzeug: 'leitstand.termine', ersatz: null, tage: 2, vorlaufMin: 2, standardDauerMin: 60, bereiche: [] },
  mitteilung: { kanaele: [], arten: ['proaktiv', 'freigabe', 'fehler', 'ergebnis'], matrixProStunde: 6, raum: 'ops', trocken: false },
};

const tief = (a, b) => {
  if (Array.isArray(a) || Array.isArray(b)) return b === undefined ? a : b;
  if (!a || typeof a !== 'object' || !b || typeof b !== 'object') return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = tief(a[k], v);
  return out;
};

export class SpracheFehler extends Error {
  constructor(nachricht, status = 400) {
    super(nachricht);
    this.status = status;
  }
}

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[.!?,;:„“"]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const STOPP = /^(stopp|stop|halt|sei still|ruhe|ruhig|genug|aufhören|hör auf)( persona)?$/;
const JA = /^(ja|jo|jep|klar|gern|gerne|okay|ok|los|schieß los|schiess los|leg los|ja bitte|ja klar|ja gern|ja gerne|bitte|sprich|erzähl|sag)$/;
const SPAETER = /^(später|spaeter|gleich|nicht jetzt|jetzt nicht|nachher|moment|warte|in einer stunde)$/;
const NEIN = /^(nein|nee|nö|ne|lass|lass das|nicht|kein bedarf|nein danke|danke nein)$/;
const ERTEILT = /^(ja|ja bitte|ok|okay|erteilt|freigeben|genehmigt|genehmige|mach|mach es|mach das|erlaubt)$/;
const ABGELEHNT = /^(nein|ablehnen|abgelehnt|lehn ab|lehne ab|nicht freigeben|verweigert)$/;

/** Antwort auf „Darf ich?“ aus einer gesprochenen Äußerung; `null`, wenn es keine eindeutige ist. */
export function antwortVon(text) {
  const n = norm(text);
  if (JA.test(n)) return 'ja';
  if (SPAETER.test(n)) return 'spaeter';
  if (NEIN.test(n)) return 'nein';
  return null;
}

/** Entscheidung über eine Freigabe: nur ganze, eindeutige Äußerungen. Alles andere ergibt `null` (dann passiert nichts). */
export function freigabeEntscheidungVon(text) {
  const n = norm(text);
  if (ERTEILT.test(n)) return 'erteilt';
  if (ABGELEHNT.test(n)) return 'abgelehnt';
  return null;
}

export function istStoppWort(text) {
  return STOPP.test(norm(text));
}

// --- Freigaben ---------------------------------------------------------------------------------

/** Darf diese Freigabe per Stimme entschieden werden? Nur niedriges und mittleres Risiko, nie Zerstörerisches. */
export function freigabeStimmeErlaubt(f, maxRisiko = 'medium') {
  if (!f || f.zerstoererisch) return false;
  const r = RISIKO_RANG[f.risiko];
  return r !== undefined && r <= (RISIKO_RANG[maxRisiko] ?? 1);
}

const kontextText = (k) => {
  if (!k) return '';
  if (typeof k === 'string') return k;
  if (Array.isArray(k)) return k.map(kontextText).filter(Boolean).join(' ');
  if (typeof k === 'object') return Object.values(k).map(kontextText).filter(Boolean).join(' ');
  return String(k);
};

/** Der Text, den Besitzer zu einer Freigabe hört: Kurzkontext (3 bis 5 Sätze), Risiko, Frage. Den Befehl liest sie nie vor. */
export function freigabeText(f, { stimmeErlaubt = freigabeStimmeErlaubt(f) } = {}) {
  const risiko = { low: 'niedrig', medium: 'mittel', high: 'hoch' }[f?.risiko] ?? 'unbekannt';
  const kontext = kontextText(f?.kontext).replace(/\s+/g, ' ').trim().slice(0, 700);
  const teile = [`Freigabe offen: ${String(f?.aktion ?? 'eine Aktion').slice(0, 200)}.`];
  if (kontext) teile.push(kontext);
  teile.push(`Das Risiko ist ${risiko}${f?.zerstoererisch ? ' und die Aktion ist zerstörerisch' : ''}.`);
  teile.push(stimmeErlaubt ? 'Sag ja oder nein.' : 'Das entscheidest du in der App.');
  return teile.join(' ');
}

// --- Schnittstellen zu anderen Teilen -----------------------------------------------------------

/**
 * Ruhe und Spielmodus in einer Schnittstelle: `{pausiert(), grund(), sperrtMax()}`.
 * Mit dem Ruhe-Schalter (Zweig feat/ruhe-schalter, `runner.ruhe`) gilt dessen Zustand; ohne ihn gilt der Spielmodus
 * (Marken, auch die Pause-Marke des Spielmodus). Später genügt es, `runner.ruhe` zu setzen, nichts hier ändert sich.
 */
export function sperreAus({ ruhe, spielmodus } = {}) {
  if (ruhe && typeof ruhe.pausiert === 'function') {
    return {
      pausiert: () => Boolean(ruhe.pausiert()),
      grund: () => ruhe.sperre?.grund?.() ?? (ruhe.pausiert() ? 'ruhe' : null),
      sperrtMax: () => (typeof ruhe.sperrtMax === 'function' ? Boolean(ruhe.sperrtMax()) : false) || Boolean(spielmodus?.an?.()),
    };
  }
  return {
    pausiert: () => Boolean(spielmodus?.an?.()),
    grund: () => spielmodus?.grund?.() ?? null,
    sperrtMax: () => Boolean(spielmodus?.an?.()),
  };
}

/** Das Aufmerksamkeits-Tor über den Hub: `schleifen.darf` mit `art: melden`. Fehler oder Zeitüberschreitung heißen „nein“. */
export function torAusHub(hub, { schleife = 'arbeit', timeoutMs = 4000 } = {}) {
  return {
    async darf(art = 'melden') {
      try {
        const a = await hub.aufrufen('schleifen.darf', { schleife, art }, { ansicht: 'voll', timeoutMs });
        return a?.ok === true && a.result?.darf === true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Kalender und Mitteilungsweg aus der Konfiguration (`sprache.kalender`, `sprache.mitteilung`) und dem Hub. Der Kalender liest nur (`leitstand.termine`).
 * Die Mitteilung hat ohne eingetragene Kanäle keinen Weg: `mitteilen` ist dann `null` und nichts wird gesendet. `extra`: weitere Kanäle mit dem Vertrag
 * `{name, ab?, senden(n) → {ok, grund?}}` (z. B. die aus src/freigabe-meldung.js auf feat/freigaben-push).
 */
export function anschluesse({ cfg, hub, extra = [], jetzt = () => Date.now(), log = () => {} } = {}) {
  const k = tief(VORGABE.kalender, cfg?.sprache?.kalender ?? {});
  const m = tief(VORGABE.mitteilung, cfg?.sprache?.mitteilung ?? {});
  const kal = k.an === false || !hub ? null : kalender({ hub, werkzeug: k.werkzeug, ersatz: k.ersatz, tage: k.tage, vorlaufMin: k.vorlaufMin, standardDauerMin: k.standardDauerMin, bereiche: k.bereiche, jetzt, log });
  const mit =
    !hub || (!m.kanaele.length && !extra.length)
      ? null
      : mitteilung({ hub, kanaele: m.kanaele, matrix: { raum: m.raum }, extra, arten: m.arten, matrixProStunde: m.matrixProStunde, trocken: m.trocken === true, jetzt, log });
  return { kalender: kal, mitteilen: mit };
}

/**
 * Schnittstelle für die Provider-Kette (Zweig feat/ersatzdenker-schatten, `ProviderKette.waehlen`): `sperrt(name, {gespraech})` sagt, ob ein Provider
 * wegen der Sprache gerade nicht gewählt werden soll. Die Kette fragt es vor jedem Zug und beim Umstellen. Passt ohne Änderung an dieser Datei.
 */
export function kettenSperre(sprache) {
  return (name, info = {}) => sprache.sperrtProvider(name, info);
}

function minutenInZone(ms, zone) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
  const t = {};
  for (const p of f.formatToParts(new Date(ms))) t[p.type] = Number(p.value);
  return (t.hour % 24) * 60 + t.minute;
}

const hhmm = (s, vorgabe) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? vorgabe).trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

// --- Die Sitzung -------------------------------------------------------------------------------

export class Sprache {
  /**
   * @param {object} p
   * @param {object} p.cfg           Runner-Konfiguration; Abschnitt `sprache` überschreibt VORGABE
   * @param {object} p.runner        braucht `sende`, `abbrechen`, `watchConversation`, `root`, `freigaben`, `entscheideFreigabe`
   * @param {object} [p.sperre]      `sperreAus(...)`
   * @param {object} [p.tor]         `{darf(art)}` (Aufmerksamkeit)
   * @param {object} [p.kalender]    `{beschaeftigt(ms)}` → `{beschaeftigt, bis}`
   * @param {Function} [p.schnellweg] `async (text) → {text}|null`: beantwortet Einfaches ohne Modell
   * @param {Function} [p.mitteilen] bekommt jede Mitteilung (Text-Weg: Push, Matrix, ntfy)
   * @param {string} [p.datei]       Datei für Gelerntes (Abkühlzeit, stumme Quellen); ohne: nur im Speicher
   */
  constructor({ cfg, runner, sperre = null, tor = null, kalender = null, schnellweg = null, mitteilen = null, datei = null, jetzt = () => Date.now(), log = (z) => console.log(z) } = {}) {
    this.cfg = tief(VORGABE, cfg?.sprache ?? {});
    this.runner = runner;
    this.sperre = sperre;
    this.tor = tor;
    this.kalender = kalender;
    this.schnellweg = schnellweg;
    this.mitteilen = mitteilen;
    this.datei = datei;
    this.jetzt = jetzt;
    this.log = log;
    this.muster = new RegExp(String(this.cfg.ausgabe.geraeteMuster || 'airpods'), 'i');

    this.ausgaben = new Map();
    this.sitzung = { an: false, client: null, seit: null, zuletzt: null, mikrofon: 'unbekannt', gespraech: null };
    this.sitzungId = null;
    this.zug = null;
    this.zugNr = 0;
    this.hinweisNaechster = null;
    this.erwartet = null;
    this.hoerer = new Set();
    this.ring = [];
    this.seq = 0;
    this.strom = null;
    this.stromId = null;
    this.zaehler = { aeusserungen: 0, haeppchen: 0, mitteilungen: 0, unterbrechungen: 0, abgelehnt: 0 };
    this.p = { queue: [], anfrage: null, gesendet: [], neinZaehler: 0, cooldownBis: 0, gemutet: {}, stoppBis: 0, n: 0, kuerzlich: new Map() };
    this._lauf = Promise.resolve();
    this._timer = null;
    // Sprach-Agent (E2) und Vorrang (E1)
    this.agent = { id: null, fehler: null, rueckfall: 0, zuege: 0, leerungen: 0 };
    this.vorrangBis = 0;
    this._vorrangAktiv = false;
    this.uebergaben = this.cfg.agent.an
      ? new Uebergaben({
          cfg: this.cfg.agent.uebergabe,
          runner,
          ziel: () => this.cfg.agent.hauptgespraech ?? this.runner.root?.id,
          liefern: (u) => this.#ergebnisZustellen(u),
          beiFehler: (u, grund) => this.#uebergabeFehler(u, grund),
          jetzt,
          log,
        })
      : null;
    if (this.cfg.agent.an && runner?.spracheHaken) {
      // Die Brücke, über die die Werkzeuge des Sprach-Agenten (sprache-agent.js) zurück in diese Sitzung greifen.
      runner.spracheHaken.schnellweg = (t) => (typeof this.schnellweg === 'function' ? this.schnellweg(t) : null);
      runner.spracheHaken.uebergabe = (a) => this.uebergabe(a);
    }
    this.#laden();
  }

  // --- Ereignisbus ---------------------------------------------------------------------------

  /** Hörer für alle Ereignisse; `ziel` (Client) filtert der Server. Gibt die Abmeldung zurück. */
  beiEreignis(fn) {
    this.hoerer.add(fn);
    return () => this.hoerer.delete(fn);
  }

  /** Verpasste Ereignisse nach `seq` (für Last-Event-ID). */
  seit(seq = 0) {
    return this.ring.filter((e) => e.seq > seq);
  }

  #emit(typ, daten = {}) {
    const e = { seq: (this.seq += 1), typ, zeit: new Date(this.jetzt()).toISOString(), sitzung: this.sitzungId, ...daten };
    this.ring.push(e);
    if (this.ring.length > 200) this.ring.shift();
    for (const h of [...this.hoerer]) {
      try {
        h(e);
      } catch (fehler) {
        this.log(`[fyos-sprache] Hörer: ${String(fehler?.message ?? fehler).slice(0, 160)}`);
      }
    }
    return e;
  }

  #mitteilung({ text, dringlichkeit = 'info', grund, quelle = null, bezug = null, art = 'hinweis', zug = null }) {
    this.zaehler.mitteilungen += 1;
    const m = { text: String(text).slice(0, 1200), dringlichkeit, grund, quelle, bezug, art, zug };
    this.#emit('mitteilung', m);
    try {
      void Promise.resolve(this.mitteilen?.(m)).catch((f) => this.log(`[fyos-sprache] Mitteilung nicht zugestellt: ${f.message}`));
    } catch (fehler) {
      this.log(`[fyos-sprache] Mitteilung nicht zugestellt: ${fehler.message}`);
    }
  }

  // --- Ausgabe-Route (die AirPods-Regel) -------------------------------------------------------

  /**
   * Der Client meldet seine Ausgabe: `{client, route: airpods|andere|keine, geraet, uid?, getragen?, aktiv_s?}`.
   * `airpods` gilt nur, wenn der Gerätename zu `ausgabe.geraeteMuster` passt oder die `uid` in `ausgabe.uids` steht;
   * sonst wird `andere` daraus. Eine Meldung gilt `ausgabe.maxAlterS` Sekunden; der Client muss sie also erneuern (Herzschlag).
   */
  ausgabeMelden({ client = 'client', route, geraet = null, uid = null, getragen = null, aktiv_s = null } = {}) {
    if (!ROUTEN.includes(route)) throw new SpracheFehler(`route: ${ROUTEN.join(', ')}`);
    const name = String((geraet && typeof geraet === 'object' ? geraet.name : geraet) ?? '').slice(0, 80);
    const kennung = String((geraet && typeof geraet === 'object' ? geraet.uid : null) ?? uid ?? '').slice(0, 80);
    const id = String(client).slice(0, 32) || 'client';
    let wirklich = route;
    let hinweis = null;
    if (route === 'airpods') {
      const nameOk = this.muster.test(name);
      const uidOk = Boolean(kennung) && this.cfg.ausgabe.uids.includes(kennung);
      if (!nameOk && !uidOk) {
        wirklich = 'andere';
        hinweis = 'Gerätename passt nicht zu AirPods';
      }
    }
    const vorher = this.airpodsAktiv(id);
    this.ausgaben.set(id, {
      route: wirklich,
      gemeldet_route: route,
      geraet: name || null,
      getragen: typeof getragen === 'boolean' ? getragen : null,
      aktiv_s: Number.isFinite(Number(aktiv_s)) ? Number(aktiv_s) : null,
      gemeldet: this.jetzt(),
      hinweis,
    });
    const jetztAktiv = this.airpodsAktiv(id);
    this.#emit('ausgabe', { client: id, route: wirklich, airpods_aktiv: jetztAktiv, hinweis });
    if (vorher && !jetztAktiv) this.#verloren(id);
    if (!vorher && jetztAktiv) void this.pruefen();
    return { ok: true, client: id, route: wirklich, airpods_aktiv: jetztAktiv, hinweis };
  }

  /** Gilt für diesen Client gerade „AirPods aktiv“ (frisch gemeldet, Route AirPods, nicht als abgelegt gemeldet)? */
  airpodsAktiv(client) {
    const a = this.ausgaben.get(client);
    if (!a) return false;
    return a.route === 'airpods' && a.getragen !== false && this.jetzt() - a.gemeldet <= this.cfg.ausgabe.maxAlterS * 1000;
  }

  /** Der Client, der jetzt sprechen darf: der bevorzugte, sonst der mit der jüngsten Eingabe. */
  sprechClient(bevorzugt = null) {
    if (bevorzugt && this.airpodsAktiv(bevorzugt)) return bevorzugt;
    const frei = [...this.ausgaben.keys()].filter((c) => this.airpodsAktiv(c));
    frei.sort((a, b) => (this.ausgaben.get(a).aktiv_s ?? 1e9) - (this.ausgaben.get(b).aktiv_s ?? 1e9));
    return frei[0] ?? null;
  }

  /** AirPods weg (abgelegt, getrennt, Meldung veraltet): sofort still, laufende Rede stoppt. */
  #verloren(client) {
    const z = this.zug;
    if (z && z.client === client && this.#laeuft(z)) {
      this.#emit('sprechen.stopp', { zug: z.id, grund: 'airpods-weg' });
    }
  }

  // --- Sitzung -------------------------------------------------------------------------------

  /** Sprachsitzung öffnen oder schließen. Der Client meldet, ob sein Mikrofon offen ist (`mikrofon: an|aus`). */
  sitzungSetzen({ an, client = 'client', mikrofon, gespraech = null } = {}) {
    if (typeof an !== 'boolean') throw new SpracheFehler('an: true oder false');
    const jetzt = this.jetzt();
    if (an) {
      if (this.cfg.an === false) throw new SpracheFehler('Sprachkanal aus', 423);
      this.sitzungId = `s${jetzt.toString(36)}`;
      this.sitzung = { an: true, client: String(client).slice(0, 32), seit: jetzt, zuletzt: jetzt, mikrofon: mikrofon === 'an' ? 'an' : 'aus', gespraech: gespraech ?? this.cfg.gespraech ?? null };
      this.#emit('sitzung', { an: true, client: this.sitzung.client });
    } else {
      if (this.zug && this.#laeuft(this.zug)) void this.unterbrechen({ modus: 'abbrechen', grund: 'sitzung-ende' });
      this.sitzung = { ...this.sitzung, an: false, mikrofon: 'aus' };
      this.#emit('sitzung', { an: false, client: this.sitzung.client });
    }
    return this.sitzung;
  }

  #sitzungLebt() {
    const s = this.sitzung;
    if (!s.an) return false;
    if (this.jetzt() - s.zuletzt > this.cfg.sitzungMaxMin * 60_000) {
      this.sitzung = { ...s, an: false, mikrofon: 'aus' };
      this.#emit('sitzung', { an: false, client: s.client, grund: 'inaktiv' });
      return false;
    }
    return true;
  }

  // --- Äußerung und Zug -------------------------------------------------------------------------

  #laeuft(z) {
    return z && (z.status === 'laeuft' || z.status === 'angehalten');
  }

  /**
   * Besitzer hat etwas gesagt (Text vom Ohr). Reihenfolge: Stopp-Wort, Antwort auf „Darf ich?“, Entscheidung über eine vorgelesene
   * Freigabe, Schnellweg, Modell. Spricht Besitzer über eine laufende Rede, ist das Barge-in: erst abbrechen, dann der neue Zug.
   */
  async aeusserung({ text, client = 'client', requestId, gespraech = null } = {}) {
    const t = String(text ?? '').trim();
    if (!t) throw new SpracheFehler('Text fehlt');
    if (t.length > 2000) throw new SpracheFehler('Äußerung zu lang (höchstens 2000 Zeichen)');
    if (!this.#sitzungLebt()) {
      this.zaehler.abgelehnt += 1;
      throw new SpracheFehler('Sprachsitzung nicht aktiv (zuerst POST /api/sprache/sitzung)', 409);
    }
    this.sitzung.zuletzt = this.jetzt();
    this.zaehler.aeusserungen += 1;
    if (this.sperre?.sperrtMax?.()) throw new SpracheFehler(`Persona ruht (${this.sperre.grund?.() ?? 'Ruhe'})`, 423);

    if (istStoppWort(t)) {
      await this.stoppen({ client });
      return { ok: true, art: 'stopp' };
    }
    if (this.p.anfrage) {
      const a = antwortVon(t);
      if (a) return { ok: true, art: 'anfrage-antwort', ...(await this.antwort({ antwort: a })) };
    }
    if (this.erwartet?.typ === 'freigabe' && this.jetzt() < this.erwartet.bis) {
      const e = freigabeEntscheidungVon(t);
      if (e) return { ok: true, art: 'freigabe', ...(await this.entscheiden({ freigabeId: this.erwartet.id, entscheidung: e, client })) };
    }

    if (this.zug && this.#laeuft(this.zug)) await this.unterbrechen({ modus: 'abbrechen', grund: 'neue-aeusserung' });

    if (this.schnellweg) {
      let r = null;
      try {
        r = await this.schnellweg(t);
      } catch (fehler) {
        this.log(`[fyos-sprache] Schnellweg: ${String(fehler?.message ?? fehler).slice(0, 160)}`);
      }
      if (r?.text) {
        const z = this.#sprichText({ art: 'schnell', client, text: r.text });
        return { ok: true, weg: 'schnell', zug: z.id };
      }
    }

    let id = gespraech ?? this.sitzung.gespraech ?? this.cfg.gespraech ?? null;
    let imAgent = false;
    if (id === null && this.cfg.agent.an) {
      // E2: ohne ausdrückliches Zielgespräch antwortet der Sprach-Agent. Gelingt das nicht, antwortet wie bisher das Hauptgespräch (mit langem Profil).
      try {
        id = await this.runner.spracheAgent();
        imAgent = true;
        this.agent.id = id;
        this.agent.fehler = null;
        await this.#agentBegrenzen(id);
      } catch (fehler) {
        this.agent.fehler = String(fehler?.message ?? fehler).slice(0, 160);
        this.agent.rueckfall += 1;
        id = null;
        imAgent = false;
        this.log(`[fyos-sprache] Sprach-Agent nicht verfügbar, Rückfall aufs Hauptgespräch: ${this.agent.fehler}`);
      }
    }
    if (id === null) id = this.runner.root?.id;
    if (id === undefined || id === null) throw new SpracheFehler('Kein Zielgespräch', 503);
    this.#vorrangMarke();
    await this.#abonnieren(id);
    const z = this.#neuerZug({ art: 'antwort', client, gespraech: id });
    z.imAgent = imAgent;
    this.#quittungPlan(z);
    try {
      await this.runner.sende(id, t, { art: 'steuern', requestId: requestId || `sprache:${z.id}`, kanal: 'sprache', kopf: imAgent ? this.#agentKopf() : this.profil() });
    } catch (fehler) {
      this.#beende(z, { fehler: String(fehler?.message ?? fehler) });
      throw fehler;
    }
    return { ok: true, weg: 'modell', zug: z.id };
  }

  #neuerZug({ art, client, gespraech = null }) {
    this.zugNr += 1;
    const z = {
      id: `z${this.zugNr}`,
      art,
      client,
      gespraech,
      status: 'laeuft',
      gestartet: this.jetzt(),
      nr: 0,
      chunks: [],
      zurueck: [],
      stumm: [],
      satz: new Satzstrom({ ersteMin: this.cfg.sprechen.ersteMin, max: this.cfg.sprechen.maxZeichen }),
      listen: 0,
      listeGekappt: false,
      quittung: false,
      quittungTimer: null,
      assistentGesehen: false,
      abgebrochen: false,
      teilantwort: null,
    };
    this.zug = z;
    return z;
  }

  /** Der zusätzliche Prompt-Abschnitt nur für den Sprachkanal. Ein Unterbrechungshinweis gilt einmal. */
  profil() {
    const zeilen = [
      '[Kanal: Sprache] Besitzer hört dich über seine AirPods; deine Antwort wird satzweise vorgelesen.',
      '- Höchstens drei kurze Sätze. Der erste Satz hat höchstens acht Wörter und sagt schon das Ergebnis oder was du tust.',
      '- Keine Listen, keine Tabellen, kein Markdown, kein Code, keine Links, Pfade, Hashes oder Kennungen. Sag stattdessen, wo Details stehen („steht im Text“).',
      '- Sprich Zahlen so, wie man sie sagt: zwei Uhr dreißig, fünfundzwanzigster Oktober, rund drei Gigabyte. Runde große Zahlen.',
      '- Duzen, keine Anrede in jedem Satz, keine Floskeln, kein „Gerne!“.',
      '- Erst erledigen, dann antworten, nur das Ergebnis nennen. „Erledigt“ sagst du nur nach einem bestätigten Werkzeugergebnis.',
      '- Nichts Zerstörerisches auf bloßes Zuhören hin: Das läuft über eine Freigabe, auch wenn Besitzer es nebenbei sagt.',
    ];
    if (this.hinweisNaechster) {
      zeilen.push(`- ${this.hinweisNaechster}`);
      this.hinweisNaechster = null;
    }
    return zeilen.join('\n');
  }

  // --- Sprach-Agent (E2) -----------------------------------------------------------------------------

  /** Im Sprach-Agenten gilt der Kopf des Agenten; nur ein Unterbrechungshinweis wird der Nachricht vorangestellt. */
  #agentKopf() {
    const h = this.hinweisNaechster;
    this.hinweisNaechster = null;
    return h ? `[Hinweis] ${h}` : null;
  }

  /** Das Sprachgespräch bleibt klein: nach `maxZuege` Zügen wird es geleert (der Kopf bleibt warm, nur der Verlauf geht). */
  async #agentBegrenzen(id) {
    this.agent.zuege += 1;
    const max = Number(this.cfg.agent.maxZuege);
    if (max > 0 && this.agent.zuege > max) {
      await this.runner.leeren(id);
      this.agent.zuege = 1;
      this.agent.leerungen += 1;
    }
  }

  /**
   * Der Sprach-Agent übergibt einen Auftrag ans Hauptgespräch („das muss ich nachschauen und melde mich“). Das Ergebnis kommt von selbst:
   * gesprochen, wenn Besitzer zuhört, sonst als Mitteilung (Text).
   */
  async uebergabe({ auftrag, id } = {}) {
    if (!this.uebergaben) throw new SpracheFehler('Sprach-Agent aus (sprache.agent.an)', 423);
    const r = await this.uebergaben.uebergeben({ auftrag, id, zug: this.zug?.id ?? null });
    if (!r.doppelt) this.#emit('uebergabe', { id, zug: this.zug?.id ?? null, status: 'offen' });
    return r;
  }

  /** Ergebnis einer Übergabe zustellen. `false`: gerade nicht (Besitzer oder Persona spricht), später noch einmal. */
  async #ergebnisZustellen(u) {
    const roh = String(u.ergebnis ?? '').trim();
    const volltext = roh || 'Das Hauptgespräch ist fertig, hat aber nichts zu berichten.';
    const ruht = Boolean(this.sperre?.pausiert?.());
    const ziel = !u.leise && !ruht && this.#sitzungLebt() ? this.sprechClient(this.sitzung.client) : null;
    if (ziel) {
      if (this.zug && this.#laeuft(this.zug)) return false;
      const k = kurzfassung(roh || 'Fertig. Es gibt nichts zu berichten.');
      const saetze = k.saetze.length ? k.saetze : ['Fertig.'];
      if (k.mehr) saetze.push('Den Rest siehst du im Text.');
      this.#vorrangMarke();
      this.#sprichText({ art: 'ergebnis', client: ziel, text: saetze.join(' '), dringlichkeit: 'wichtig' });
      this.#emit('uebergabe', { id: u.id, status: 'gesprochen' });
      // Der Volltext steht im Hauptgespräch; der Client bekommt ihn zusätzlich als Ereignis (nicht als Mitteilung, es geht also nichts nach außen).
      this.#emit('uebergabe.ergebnis', { id: u.id, text: volltext.slice(0, 3000) });
      return true;
    }
    const grund = u.leise ? 'nach „Stopp“' : ruht ? 'Ruhe/Spielmodus' : !this.#sitzungLebt() ? 'keine Sprachsitzung' : 'keine AirPods';
    this.#mitteilung({ text: volltext, dringlichkeit: 'wichtig', grund, quelle: 'uebergabe', bezug: `uebergabe:${u.id}`, art: 'ergebnis' });
    this.#emit('uebergabe', { id: u.id, status: 'text' });
    return true;
  }

  #uebergabeFehler(u, grund) {
    this.#mitteilung({ text: `Die Übergabe an das Hauptgespräch hat nicht geklappt: ${grund}`, dringlichkeit: 'wichtig', grund: 'fehler', quelle: 'uebergabe', bezug: `uebergabe:${u.id}`, art: 'fehler' });
    this.#emit('uebergabe', { id: u.id, status: u.status });
  }

  // --- Vorrang auf GPU1 (E1) --------------------------------------------------------------------------

  #vorrangMarke() {
    this.vorrangBis = this.jetzt() + Number(this.cfg.vorrang_gpu1.nachlaufS) * 1000;
    this.#vorrangPruefen();
  }

  /**
   * Hat die Sprache gerade Vorrang auf GPU1? Ja, solange eine Sprachsitzung offen ist und entweder ein Zug läuft (Persona antwortet oder spricht)
   * oder in den letzten `nachlaufS` Sekunden etwas gesprochen, gefragt oder geantwortet wurde. Eine offene Sitzung allein genügt nicht, sonst
   * stünde der Ersatzdenker 15 Minuten still. Mit `an: false` (oder ohne Sitzung) ist es immer `aktiv: false`.
   */
  vorrang() {
    const c = this.cfg.vorrang_gpu1;
    if (!c.an) return { aktiv: false, grund: 'aus', bis: null, providers: c.providers };
    if (!this.#sitzungLebt()) return { aktiv: false, grund: 'keine Sprachsitzung', bis: null, providers: c.providers };
    if (this.zug && this.#laeuft(this.zug)) return { aktiv: true, grund: 'Zug läuft', bis: null, providers: c.providers };
    if (this.jetzt() < this.vorrangBis) return { aktiv: true, grund: 'Nachlauf', bis: new Date(this.vorrangBis).toISOString(), providers: c.providers };
    return { aktiv: false, grund: 'ruhig', bis: null, providers: c.providers };
  }

  /** Meldet jeden Wechsel als Ereignis `vorrang` (für den Wächter und die Provider-Kette). */
  #vorrangPruefen() {
    const v = this.vorrang();
    if (v.aktiv !== this._vorrangAktiv) {
      this._vorrangAktiv = v.aktiv;
      this.#emit('vorrang', { aktiv: v.aktiv, grund: v.grund, providers: v.providers });
    }
    return v;
  }

  /**
   * Soll dieser Provider wegen der Sprache jetzt nicht gewählt werden? Für die Provider-Kette: `sperrt('ersatzdenker')`.
   * Der Sprach-Agent selbst (Gespräch `info.gespraech`) ist ausgenommen, solange `sprachAgentAusnahme` gilt: Er braucht ein Modell, um zu antworten.
   */
  sperrtProvider(name, { gespraech = null } = {}) {
    const c = this.cfg.vorrang_gpu1;
    if (!c.an || !c.providers.includes(name)) return false;
    if (c.sprachAgentAusnahme && gespraech !== null && gespraech === this.agent.id) return false;
    return this.#vorrangPruefen().aktiv;
  }

  async #abonnieren(id) {
    if (this.strom && this.stromId === id) return;
    if (this.strom) await Promise.resolve(this.strom.stop?.()).catch(() => {});
    this.strom = await this.runner.watchConversation(id);
    this.stromId = id;
    this.strom.start((ereignisse) => this.beiEreignisse(ereignisse));
  }

  /** Ereignisse des Gesprächs (siehe FYOS-CLIENT-PROTOKOLL.md#verlauf). Öffentlich, damit Tests sie hineinreichen können. */
  beiEreignisse(batch) {
    for (const ev of Array.isArray(batch) ? batch : [batch]) {
      try {
        this.#ereignis(ev);
      } catch (fehler) {
        this.log(`[fyos-sprache] Ereignis: ${String(fehler?.message ?? fehler).slice(0, 160)}`);
      }
    }
  }

  #ereignis(ev) {
    const z = this.zug;
    if (!ev || !z || z.art !== 'antwort' || !this.#laeuft(z)) return;
    switch (ev.type) {
      case 'message_start':
        if (ev.message?.role === 'assistant') {
          z.assistentGesehen = true;
          z.deltas = false;
        }
        break;
      case 'message_update':
        for (const c of ev.changes ?? []) {
          if (c.type === 'text_delta' && c.delta) {
            z.deltas = true;
            this.#delta(z, c.delta);
          }
        }
        break;
      case 'message_end': {
        const m = ev.entry?.model?.[0];
        if (m?.role !== 'assistant') break;
        // Ein Modell ohne Teilstrom (Faux, manche Anbieter) liefert den Text erst hier ganz.
        if (!z.deltas && Array.isArray(m.content)) {
          for (const b of m.content) if (b?.type === 'text' && b.text) this.#delta(z, `${b.text}\n`);
        }
        z.deltas = false;
        this.#haeppchen(z, z.satz.ende());
        break;
      }
      case 'tool_execution_start':
        // Bei der Übergabe sagt der Agent selbst „Das muss ich nachschauen“; eine zweite Quittung davor wäre doppelt.
        if (z.nr === 0 && ev.toolName !== 'sprache_uebergabe') this.#quittung(z, 'werkzeug');
        break;
      case 'run_end':
        // Ein Ende, bevor der Assistent zu unserem Zug etwas gesagt hat, gehört meist zum Zug davor (Steuern während der Arbeit).
        if (z.assistentGesehen || this.jetzt() - z.gestartet > 60_000) this.#beende(z, {});
        break;
      case 'task_failed':
        this.#beende(z, { fehler: String(ev.message ?? ev.kind ?? 'Aufgabe fehlgeschlagen') });
        break;
      default:
    }
  }

  #delta(z, delta) {
    z.assistentGesehen = true;
    this.#haeppchen(z, z.satz.schiebe(delta));
  }

  #haeppchen(z, liste) {
    for (const h of liste) {
      if (h.liste) {
        z.listen += 1;
        if (z.listen > this.cfg.sprechen.listeMax) {
          z.listeGekappt = true;
          continue;
        }
      }
      this.#sprich(z, h.text, 'antwort');
    }
  }

  /** Ein Häppchen an die Stimme, wenn AirPods aktiv sind; sonst für die Mitteilung am Ende sammeln. */
  #sprich(z, roh, art, { dringlichkeit = 'info', ton = null } = {}) {
    const text = sprechbar(roh);
    if (!text) return;
    if (z.status === 'angehalten') {
      z.zurueck.push({ text, art, dringlichkeit, ton });
      return;
    }
    const ziel = this.sprechClient(z.client);
    if (!ziel) {
      z.stumm.push(text);
      return;
    }
    clearTimeout(z.quittungTimer);
    z.nr += 1;
    z.chunks.push({ nr: z.nr, text });
    this.zaehler.haeppchen += 1;
    this.#vorrangMarke();
    this.#emit('sprechen', { id: `${z.id}.${z.nr}`, zug: z.id, nr: z.nr, text, art, dringlichkeit, ton, sprache: 'de', stil: null, ziel, erste: z.nr === 1, ende: false });
  }

  /** Kurzquittung („Moment.“) als Reflex, wenn das Modell zu lange schweigt oder ein Werkzeug anläuft. */
  #quittung(z, warum) {
    if (z.quittung || z.nr > 0 || !this.#laeuft(z) || z.status === 'angehalten') return;
    const ziel = this.sprechClient(z.client);
    if (!ziel) return;
    const liste = this.cfg.sprechen.quittungen;
    const text = warum === 'werkzeug' ? liste[1] ?? liste[0] : liste[0];
    if (!text) return;
    z.quittung = true;
    this.#emit('sprechen', { id: `${z.id}.q`, zug: z.id, nr: 0, text, art: 'quittung', dringlichkeit: 'info', ton: null, ziel, erste: false });
  }

  #quittungPlan(z) {
    const ms = Number(this.cfg.sprechen.quittungMs);
    if (!(ms > 0)) return;
    z.quittungTimer = setTimeout(() => this.#quittung(z, 'zeit'), ms);
    z.quittungTimer.unref?.();
  }

  #beende(z, { fehler = null, unterbrochen = false } = {}) {
    if (!this.#laeuft(z)) return;
    clearTimeout(z.quittungTimer);
    if (!unterbrochen) {
      this.#haeppchen(z, z.satz.ende());
      const hinweise = [];
      if (z.satz.uebersprungen.code || z.satz.uebersprungen.tabelle || z.listeGekappt) hinweise.push('Den Rest siehst du im Text.');
      for (const h of hinweise) this.#sprich(z, h, 'antwort');
    }
    z.status = fehler ? 'fehler' : unterbrochen ? 'unterbrochen' : 'fertig';
    if (fehler) {
      this.#mitteilung({ text: `Das hat nicht geklappt: ${fehler}`, grund: 'fehler', zug: z.id, art: 'fehler' });
    }
    if (z.stumm.length && !unterbrochen) {
      this.#mitteilung({ text: z.stumm.join(' '), grund: 'keine AirPods', zug: z.id, art: 'antwort' });
    }
    this.#emit('sprechen.ende', { zug: z.id, vollstaendig: !fehler && !unterbrochen, haeppchen: z.nr, fehler, ende: true });
    // Ein Ergebnis einer Übergabe, das auf das Ende dieser Rede gewartet hat, kommt jetzt.
    if (this.uebergaben && z.art !== 'ergebnis') void this.uebergaben.pruefen();
  }

  /** Text ohne Modell sprechen (Schnellweg, Proaktives, Freigaben): ein eigener, sofort fertiger Zug. */
  #sprichText({ art, client, text, dringlichkeit = 'info', ton = null }) {
    const z = this.#neuerZug({ art, client });
    const satz = new Satzstrom({ ersteMin: this.cfg.sprechen.ersteMin, max: this.cfg.sprechen.maxZeichen });
    const liste = [...satz.schiebe(`${text}\n`), ...satz.ende()];
    let erster = true;
    for (const h of liste) {
      this.#sprich(z, h.text, art, { dringlichkeit, ton: erster ? ton : null });
      erster = false;
    }
    this.#beende(z, { unterbrochen: false });
    return z;
  }

  // --- Unterbrechen ----------------------------------------------------------------------------

  /**
   * Barge-in. Der Client hat die Wiedergabe schon selbst gestoppt (so schnell wie möglich, lokal); hier wird der Zug behandelt.
   *  - `modus: 'abbrechen'` (Standard): Zug im Gespräch abbrechen, Rest verwerfen, Teilantwort markieren; der nächste Zug erfährt es.
   *  - `modus: 'fortfuehren'`: Rede angehalten, der Zug läuft weiter, neue Häppchen werden zurückgehalten bis `fortsetzen()`.
   * `gespielt` ist die Nummer des letzten Häppchens, das der Client ganz gespielt hat (sonst gilt alles Gesendete als gesprochen).
   */
  async unterbrechen({ modus = 'abbrechen', gespielt = null, grund = 'barge-in' } = {}) {
    if (!['abbrechen', 'fortfuehren'].includes(modus)) throw new SpracheFehler('modus: abbrechen oder fortfuehren');
    const z = this.zug;
    if (!z) return { ok: true, ignoriert: true };
    this.zaehler.unterbrechungen += 1;
    this.#emit('sprechen.stopp', { zug: z.id, grund });
    if (!this.#laeuft(z)) return { ok: true, zug: z.id, status: z.status, ignoriert: true };
    const bis = Number.isInteger(gespielt) ? Math.max(0, Math.min(gespielt, z.nr)) : z.nr;
    if (modus === 'fortfuehren') {
      z.status = 'angehalten';
      z.angehaltenBis = bis;
      return { ok: true, zug: z.id, status: 'angehalten' };
    }
    clearTimeout(z.quittungTimer);
    z.abgebrochen = true;
    const gesagt = z.chunks.filter((c) => c.nr <= bis).map((c) => c.text).join(' ');
    const ungesagt = [...z.chunks.filter((c) => c.nr > bis).map((c) => c.text), ...z.zurueck.map((c) => c.text)].join(' ');
    z.teilantwort = { gesprochen_bis: bis, gesagt, ungesagt };
    this.#beende(z, { unterbrochen: true });
    if (z.art === 'antwort') {
      // Nur wenn Besitzer schon etwas gehört hat, ist der Hinweis für den nächsten Zug nützlich.
      if (z.chunks.length) {
        this.hinweisNaechster =
          `Besitzer hat dich nach ${bis} gesprochenen Häppchen unterbrochen. Gesagt hast du: „${gesagt.slice(0, 300)}“.` +
          (ungesagt ? ` Nicht mehr gesagt: „${ungesagt.slice(0, 300)}“. Wiederhole nichts, was schon gesagt wurde.` : '');
      }
      try {
        if (z.gespraech !== null) await this.runner.abbrechen(z.gespraech);
      } catch (fehler) {
        this.log(`[fyos-sprache] Abbrechen: ${String(fehler?.message ?? fehler).slice(0, 160)}`);
      }
    }
    return { ok: true, zug: z.id, status: 'unterbrochen', teilantwort: { gesprochen_bis: bis } };
  }

  /** Eine mit `fortfuehren` angehaltene Rede weitersprechen (zurückgehaltene Häppchen kommen jetzt). */
  fortsetzen() {
    const z = this.zug;
    if (!z || z.status !== 'angehalten') return { ok: true, ignoriert: true };
    z.status = 'laeuft';
    const rest = z.zurueck.splice(0);
    for (const h of rest) this.#sprich(z, h.text, h.art, h);
    return { ok: true, zug: z.id, status: z.status, nachgereicht: rest.length };
  }

  /** „Stopp“: Rede und Zug beenden, offene Frage als Nein werten, eine Weile keine ungebetene Ansprache. */
  async stoppen({ client = null } = {}) {
    const r = await this.unterbrechen({ modus: 'abbrechen', grund: 'stopp' });
    this.uebergaben?.leise();
    this.p.stoppBis = this.jetzt() + this.cfg.proaktiv.stoppRuheMin * 60_000;
    if (this.p.anfrage) await this.antwort({ antwort: 'nein' });
    this.#emit('stopp', { client });
    return r;
  }

  // --- Freigaben per Stimme ------------------------------------------------------------------------

  /** Eine offene Freigabe vorlesen (Besitzer hat danach gefragt oder die proaktive Ansprache wurde bejaht). */
  async freigabeVorlesen({ id, client = 'client' } = {}) {
    const f = await this.#freigabe(id);
    if (!f) throw new SpracheFehler('Freigabe nicht gefunden', 404);
    if (f.status !== 'offen') throw new SpracheFehler(`Freigabe ist bereits ${f.status}`, 409);
    const darf = freigabeStimmeErlaubt(f, this.cfg.freigabe.stimmeMaxRisiko);
    const text = freigabeText(f, { stimmeErlaubt: darf });
    const ziel = this.sprechClient(client);
    if (!ziel) {
      this.#mitteilung({ text, dringlichkeit: 'wichtig', grund: 'keine AirPods', art: 'freigabe', bezug: `freigabe:${f.id}` });
      return { ok: true, gesprochen: false, entscheidung_per_stimme: false };
    }
    this.#sprichText({ art: 'freigabe', client: ziel, text, dringlichkeit: 'wichtig' });
    this.erwartet = darf ? { typ: 'freigabe', id: f.id, client: ziel, bis: this.jetzt() + this.cfg.freigabe.vorgelesenTtlS * 1000 } : null;
    return { ok: true, gesprochen: true, entscheidung_per_stimme: darf };
  }

  async #freigabe(id) {
    const liste = await this.runner.freigaben();
    return (liste ?? []).find((f) => f.id === id) ?? null;
  }

  /**
   * Entscheidung per Stimme. Gilt nur für eine Freigabe, die in diesem Fenster vorgelesen wurde, vom Client mit aktiven AirPods,
   * bei niedrigem oder mittlerem, nicht zerstörerischem Risiko. Hohes oder zerstörerisches entscheidet nur die App.
   */
  async entscheiden({ freigabeId, entscheidung, client = 'client' } = {}) {
    if (!['erteilt', 'abgelehnt'].includes(entscheidung)) throw new SpracheFehler('entscheidung: erteilt oder abgelehnt');
    const e = this.erwartet;
    if (!e || e.typ !== 'freigabe' || e.id !== freigabeId || this.jetzt() >= e.bis) {
      throw new SpracheFehler('Diese Freigabe wurde nicht gerade vorgelesen; bitte in der App entscheiden', 403);
    }
    if (!this.airpodsAktiv(client) || (e.client && e.client !== client)) {
      throw new SpracheFehler('Per Stimme nur über die AirPods, über die vorgelesen wurde', 403);
    }
    const f = await this.#freigabe(freigabeId);
    if (!f) throw new SpracheFehler('Freigabe nicht gefunden', 404);
    if (!freigabeStimmeErlaubt(f, this.cfg.freigabe.stimmeMaxRisiko)) {
      throw new SpracheFehler('Dieses Risiko entscheidest du in der App (Halten)', 403);
    }
    this.erwartet = null;
    await this.runner.entscheideFreigabe(freigabeId, { entscheidung, notiz: 'per Stimme über AirPods', von: 'stimme' });
    this.#sprichText({ art: 'quittung', client, text: entscheidung === 'erteilt' ? 'Erteilt.' : 'Abgelehnt.' });
    return { ok: true, freigabe: freigabeId, entscheidung };
  }

  // --- Proaktive Ansprache --------------------------------------------------------------------------

  /**
   * „Persona will etwas sagen.“ Läuft durch die Richtlinie und liefert, was daraus wird:
   * `sprechen` (dringend, direkt), `anfrage` („Darf ich?“ läuft), `gehalten`, `text` (nur Mitteilung), `verworfen`.
   */
  async melden({ text, dringlichkeit = 'info', quelle = 'runner', bezug = null, freigabeId = null } = {}) {
    if (!DRINGLICHKEITEN.includes(dringlichkeit)) throw new SpracheFehler(`dringlichkeit: ${DRINGLICHKEITEN.join(', ')}`);
    const t = String(text ?? '').trim();
    if (!t) throw new SpracheFehler('Text fehlt');
    const jetzt = this.jetzt();
    const item = { text: t.slice(0, 1200), dringlichkeit, quelle: String(quelle).slice(0, 40), bezug: bezug ? String(bezug).slice(0, 80) : null, freigabeId, erstellt: jetzt, spaeter: 0, zurueckBis: 0, zustand: 'neu', grund: null };
    if (!this.cfg.proaktiv.an) {
      this.#mitteilung({ ...item, grund: 'Proaktive Ansprache aus', art: 'proaktiv' });
      return { ok: true, entscheidung: 'text', grund: 'Proaktive Ansprache aus' };
    }
    if (item.bezug) {
      const zuletzt = this.p.kuerzlich.get(item.bezug);
      if (zuletzt && jetzt - zuletzt < 10 * 60_000) return { ok: true, entscheidung: 'verworfen', grund: 'gleicher Bezug vor Kurzem' };
      this.p.kuerzlich.set(item.bezug, jetzt);
    }
    item.id = `p${(this.p.n += 1)}`;
    const ttl = dringlichkeit === 'info' ? this.cfg.proaktiv.infoVerfaelltMin : this.cfg.proaktiv.wichtigVerfaelltMin;
    item.bis = jetzt + ttl * 60_000;
    if (this.p.queue.length >= this.cfg.proaktiv.warteschlangeMax) {
      const schwach = this.p.queue.filter((q) => q.dringlichkeit === 'info').sort((a, b) => a.erstellt - b.erstellt)[0];
      if (schwach) this.p.queue.splice(this.p.queue.indexOf(schwach), 1);
      else return { ok: true, entscheidung: 'verworfen', grund: 'Warteschlange voll' };
    }
    this.p.queue.push(item);
    await this.pruefen();
    return { ok: true, id: item.id, entscheidung: item.zustand, grund: item.grund };
  }

  /** Richtlinie für einen Eintrag: `{art, grund}` mit art `sprechen|anfrage|halten|text|verwerfen`. */
  async bewerte(it) {
    const c = this.cfg.proaktiv;
    const jetzt = this.jetzt();
    const dringend = it.dringlichkeit === 'dringend';
    const haltenOderText = (grund) => ({ art: dringend || it.dringlichkeit === 'wichtig' ? 'text' : 'halten', grund });

    if (this.p.gemutet[it.quelle] && this.p.gemutet[it.quelle] > jetzt && !dringend) return { art: 'text', grund: `Quelle ${it.quelle} nach „Nein“ stumm` };
    if (it.zurueckBis > jetzt) return { art: 'halten', grund: 'später (auf Wunsch)' };

    // 1. Ruhe und Spielmodus: nie sprechen. Dringendes geht als Text hinaus.
    if (this.sperre?.pausiert?.()) {
      return dringend ? { art: 'text', grund: `Ruhe/Spielmodus (${this.sperre.grund?.() ?? 'pausiert'})` } : { art: 'halten', grund: `Ruhe/Spielmodus (${this.sperre.grund?.() ?? 'pausiert'})` };
    }
    // 2. Aufmerksamkeits-Tor (schleifen.darf, art melden). Nicht prüfbar heißt zu. Dringendes übergeht es.
    if (!dringend && this.tor) {
      const darf = await this.tor.darf('melden').catch(() => false);
      if (!darf) return { art: 'halten', grund: 'Aufmerksamkeit: schleifen.darf melden = nein' };
    }
    // 3. AirPods: ohne sie keine Stimme.
    const ziel = this.sprechClient();
    if (!ziel) return haltenOderText('keine AirPods aktiv');
    // 4. Nachtruhe.
    if (!dringend && c.stille?.an) {
      const von = hhmm(c.stille.von, '22:00');
      const bis = hhmm(c.stille.bis, '07:00');
      if (von !== null && bis !== null && von !== bis) {
        const m = minutenInZone(jetzt, c.stille.zone || 'Europe/Berlin');
        const innen = von < bis ? m >= von && m < bis : m >= von || m < bis;
        if (innen) return { art: 'halten', grund: `Nachtruhe ${c.stille.von}–${c.stille.bis}` };
      }
    }
    // 5. Kalender: nicht in Terminen.
    if (!dringend && this.kalender) {
      const k = await Promise.resolve(this.kalender.beschaeftigt(jetzt)).catch(() => null);
      if (k?.beschaeftigt) return { art: 'halten', grund: 'im Termin' };
    }
    // 6. Präsenz: sitzt Besitzer am Gerät?
    const aktiv = this.ausgaben.get(ziel)?.aktiv_s;
    if (!dringend && aktiv !== null && aktiv !== undefined && aktiv > c.aktivMaxS) return { art: 'halten', grund: `Besitzer seit ${Math.round(aktiv)} s nicht am Gerät` };
    if (dringend) return { art: 'sprechen', grund: 'dringend' };
    // 7. Stopp-Ruhe, Abkühlzeit, Rate.
    if (this.p.stoppBis > jetzt) return { art: 'halten', grund: 'nach „Stopp“ still' };
    if (this.p.cooldownBis > jetzt) return { art: 'halten', grund: 'Abkühlzeit' };
    if (this.#proStunde() >= c.maxProStunde) return { art: 'halten', grund: `höchstens ${c.maxProStunde} Ansprachen pro Stunde` };
    return { art: 'anfrage', grund: 'Darf ich?' };
  }

  #proStunde() {
    const grenze = this.jetzt() - 3_600_000;
    this.p.gesendet = this.p.gesendet.filter((t) => t > grenze);
    return this.p.gesendet.length;
  }

  /** Eintrag wird Text-Mitteilung und verlässt die Warteschlange. */
  #alsText(it, grund) {
    this.p.queue = this.p.queue.filter((q) => q !== it);
    it.zustand = 'text';
    it.grund = grund;
    this.#mitteilung({ text: it.text, dringlichkeit: it.dringlichkeit, grund, quelle: it.quelle, bezug: it.bezug, art: 'proaktiv' });
  }

  /** Warteschlange durchgehen (Zeitgeber, neue AirPods, Ende der Ruhe, Antwort auf eine Frage). Immer eins nach dem anderen. */
  pruefen() {
    this._lauf = this._lauf.then(() => this.#pruefen()).catch((f) => this.log(`[fyos-sprache] Prüfung: ${String(f?.message ?? f).slice(0, 160)}`));
    return this._lauf;
  }

  async #pruefen() {
    const jetzt = this.jetzt();
    this.#vorrangPruefen();
    await this.uebergaben?.pruefen();
    const a = this.p.anfrage;
    if (a && jetzt >= a.ablauf) await this.antwort({ id: a.id, antwort: 'ignoriert' });
    const reihe = [...this.p.queue].sort((x, y) => RANG[y.dringlichkeit] - RANG[x.dringlichkeit] || x.erstellt - y.erstellt);
    for (const it of reihe) {
      if (!this.p.queue.includes(it) || it.zustand === 'angefragt') continue;
      if (jetzt >= it.bis) {
        if (it.dringlichkeit === 'info') {
          this.p.queue = this.p.queue.filter((q) => q !== it);
          it.zustand = 'verfallen';
        } else this.#alsText(it, 'verfallen, nie angesprochen');
        continue;
      }
      const r = await this.bewerte(it);
      it.grund = r.grund;
      if (r.art === 'text') this.#alsText(it, r.grund);
      else if (r.art === 'verwerfen') {
        this.p.queue = this.p.queue.filter((q) => q !== it);
        it.zustand = 'verworfen';
      } else if (r.art === 'halten') it.zustand = 'gehalten';
      else if (r.art === 'sprechen') await this.#ansprechen(it, { ton: 'dringend' });
      else if (r.art === 'anfrage') {
        if (this.p.anfrage) it.zustand = 'wartet';
        else this.#anfragen(it);
      }
    }
  }

  #anfragen(it) {
    const client = this.sprechClient();
    if (!client) return;
    const jetzt = this.jetzt();
    const id = `a${(this.p.n += 1)}`;
    this.p.anfrage = { id, item: it.id, seit: jetzt, ablauf: jetzt + this.cfg.proaktiv.anfrageTimeoutS * 1000, client };
    this.p.gesendet.push(jetzt);
    it.zustand = 'angefragt';
    this.#vorrangMarke();
    const text = it.dringlichkeit === 'wichtig' ? 'Besitzer, ich habe etwas Wichtiges. Darf ich?' : 'Besitzer, hast du kurz Zeit für mich?';
    this.#emit('sprechen', { id, zug: null, nr: 0, text, art: 'anfrage', dringlichkeit: it.dringlichkeit, ton: 'ping', anfrage: id, ziel: client, erste: true });
  }

  /** Den Inhalt sprechen (nach „Ja“ oder bei Dringendem). Eine Freigabe wird mit Kurzkontext vorgelesen. */
  async #ansprechen(it, { ton = null } = {}) {
    this.p.queue = this.p.queue.filter((q) => q !== it);
    it.zustand = 'gesprochen';
    const client = this.sprechClient();
    if (!client) {
      this.#alsText(it, 'AirPods weg');
      return;
    }
    if (it.dringlichkeit === 'dringend') this.p.gesendet.push(this.jetzt());
    if (it.freigabeId) {
      try {
        await this.freigabeVorlesen({ id: it.freigabeId, client });
        return;
      } catch (fehler) {
        this.log(`[fyos-sprache] Freigabe vorlesen: ${String(fehler?.message ?? fehler).slice(0, 160)}`);
      }
    }
    this.#sprichText({ art: 'proaktiv', client, text: it.text, dringlichkeit: it.dringlichkeit, ton });
  }

  /**
   * Besitzer antwortet auf „Darf ich?“: `ja`, `spaeter`, `nein`; `ignoriert` setzt der Zeitgeber, wenn er schweigt.
   * Nein und Schweigen verlängern die Abkühlzeit (verdoppeln sich bis `abkuehlungMaxMin`); zweimal Nein von derselben Quelle
   * macht sie für `gemutetStunden` stumm. Ja halbiert den Zähler.
   */
  async antwort({ id = null, antwort } = {}) {
    const a = this.p.anfrage;
    if (!a || (id && id !== a.id)) return { ok: true, ignoriert: true };
    if (!['ja', 'spaeter', 'nein', 'ignoriert'].includes(antwort)) throw new SpracheFehler('antwort: ja, spaeter oder nein');
    const c = this.cfg.proaktiv;
    const jetzt = this.jetzt();
    const it = this.p.queue.find((q) => q.id === a.item);
    this.p.anfrage = null;
    if (antwort === 'ja') {
      this.p.neinZaehler = Math.floor(this.p.neinZaehler / 2);
      this.p.cooldownBis = 0;
      if (it) await this.#ansprechen(it);
    } else if (antwort === 'spaeter') {
      if (it) {
        it.spaeter += 1;
        it.zurueckBis = jetzt + c.spaeterMin * 60_000;
        it.zustand = 'gehalten';
        it.grund = 'später (auf Wunsch)';
        if (it.spaeter > c.spaeterMax) this.#alsText(it, 'zu oft verschoben');
      }
    } else {
      this.p.neinZaehler += 1;
      const min = Math.min(c.abkuehlungMin * 2 ** (this.p.neinZaehler - 1), c.abkuehlungMaxMin);
      this.p.cooldownBis = jetzt + min * 60_000;
      if (it) {
        if (antwort === 'nein') {
          const q = it.quelle;
          this.p.neinPro = { ...(this.p.neinPro ?? {}), [q]: (this.p.neinPro?.[q] ?? 0) + 1 };
          if (this.p.neinPro[q] >= 2) this.p.gemutet[q] = jetzt + c.gemutetStunden * 3_600_000;
        }
        if (it.dringlichkeit === 'info') {
          this.p.queue = this.p.queue.filter((x) => x !== it);
          it.zustand = 'abgelehnt';
        } else this.#alsText(it, antwort === 'nein' ? 'abgelehnt' : 'nicht beantwortet');
      }
    }
    this.#sichern();
    this.#emit('anfrage.ende', { id: a.id, antwort });
    void this.pruefen();
    return { ok: true, id: a.id, antwort };
  }

  // --- Zustand, Lauf, Gedächtnis ---------------------------------------------------------------

  /** Für `GET /api/sprache` und `/zustand.sprache` des Steuerkanals. Enthält keinen gesprochenen Text. */
  zustand() {
    const jetzt = this.jetzt();
    const clients = {};
    for (const [c, a] of this.ausgaben) {
      clients[c] = { route: a.route, gemeldet_route: a.gemeldet_route, geraet: a.geraet, getragen: a.getragen, aktiv_s: a.aktiv_s, alter_s: Math.round((jetzt - a.gemeldet) / 1000), airpods_aktiv: this.airpodsAktiv(c), hinweis: a.hinweis };
    }
    const z = this.zug;
    return {
      an: this.cfg.an !== false,
      sitzung: { an: this.sitzung.an && this.#sitzungLebt(), client: this.sitzung.client, seit: this.sitzung.seit, mikrofon: this.sitzung.mikrofon },
      ausgabe: { airpods_aktiv: this.sprechClient() !== null, sprechclient: this.sprechClient(), clients },
      zug: z ? { id: z.id, art: z.art, status: z.status, haeppchen: z.nr, client: z.client, teilantwort: z.teilantwort ? { gesprochen_bis: z.teilantwort.gesprochen_bis } : null } : null,
      erwartet: this.erwartet && jetzt < this.erwartet.bis ? { typ: this.erwartet.typ, id: this.erwartet.id } : null,
      sperre: this.sperre ? { pausiert: Boolean(this.sperre.pausiert?.()), grund: this.sperre.grund?.() ?? null, sperrt_max: Boolean(this.sperre.sperrtMax?.()) } : null,
      proaktiv: {
        an: Boolean(this.cfg.proaktiv.an),
        wartend: this.p.queue.map((q) => ({ id: q.id, dringlichkeit: q.dringlichkeit, quelle: q.quelle, zustand: q.zustand, grund: q.grund })),
        anfrage: this.p.anfrage ? { id: this.p.anfrage.id, ablauf_s: Math.max(0, Math.round((this.p.anfrage.ablauf - jetzt) / 1000)) } : null,
        angesprochen_letzte_stunde: this.#proStunde(),
        max_pro_stunde: this.cfg.proaktiv.maxProStunde,
        abkuehlung_bis: this.p.cooldownBis > jetzt ? new Date(this.p.cooldownBis).toISOString() : null,
        nein_zaehler: this.p.neinZaehler,
        stumme_quellen: Object.keys(this.p.gemutet).filter((q) => this.p.gemutet[q] > jetzt),
        still_bis: this.p.stoppBis > jetzt ? new Date(this.p.stoppBis).toISOString() : null,
      },
      zaehler: { ...this.zaehler },
      // Neu (E1, E2, E10). Keine Aufträge, keine Ergebnisse, kein gesprochener Text.
      agent: {
        an: Boolean(this.cfg.agent.an),
        gespraech: this.agent.id,
        modell: this.cfg.agent.an ? (this.cfg.agent.modell?.modelId ?? this.cfg.agent.modell ?? 'bahn max') : null,
        zuege: this.agent.zuege,
        leerungen: this.agent.leerungen,
        rueckfall: this.agent.rueckfall,
        fehler: this.agent.fehler,
        uebergaben: this.uebergaben ? this.uebergaben.zustand() : null,
      },
      vorrang: this.vorrang(),
      kalender: this.kalender?.zustand?.() ?? null,
      mitteilung: this.mitteilen?.zustand?.() ?? (this.mitteilen ? { kanaele: 'unbekannt' } : null),
    };
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => void this.pruefen(), Math.max(1, Number(this.cfg.proaktiv.pruefenS) || 10) * 1000);
    this._timer.unref?.();
  }

  async stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this.zug) clearTimeout(this.zug.quittungTimer);
    await this.uebergaben?.stop().catch(() => {});
    if (this.strom) await Promise.resolve(this.strom.stop?.()).catch(() => {});
    this.strom = null;
    this.stromId = null;
  }

  #laden() {
    if (!this.datei || !existsSync(this.datei)) return;
    try {
      const r = JSON.parse(readFileSync(this.datei, 'utf8'));
      this.p.neinZaehler = Number(r.neinZaehler) || 0;
      this.p.cooldownBis = Number(r.cooldownBis) || 0;
      this.p.gemutet = r.gemutet && typeof r.gemutet === 'object' ? r.gemutet : {};
      this.p.neinPro = r.neinPro && typeof r.neinPro === 'object' ? r.neinPro : {};
    } catch (fehler) {
      this.log(`[fyos-sprache] ${this.datei} unlesbar (${fehler.message}) — gilt als leer`);
    }
  }

  #sichern() {
    if (!this.datei) return;
    try {
      mkdirSync(dirname(this.datei), { recursive: true });
      const tmp = `${this.datei}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ v: 1, neinZaehler: this.p.neinZaehler, cooldownBis: this.p.cooldownBis, gemutet: this.p.gemutet, neinPro: this.p.neinPro ?? {} }, null, 2)}\n`);
      renameSync(tmp, this.datei);
    } catch (fehler) {
      this.log(`[fyos-sprache] Gelerntes nicht gespeichert: ${String(fehler?.message ?? fehler).slice(0, 160)}`);
    }
  }
}
