/**
 * reflexe.js — feste Regeln mit Vorrang: Bedingung auf Eingangsereignis oder Weltmodell → Aktion.
 *
 * Port von `_Regel` und `Reflexe` aus dem RPC-Runner (Plan „Persona lebt“ §3a). Deterministisch und
 * ohne Modell: gleiche Regeln, gleiches Ereignis und gleiches Weltbild ergeben dieselbe
 * Entscheidung. Dieselbe `reflexe.yaml` gilt für beide Runner.
 *
 * Anlässe: `eingang` (jedes Ereignis aus dem Eingangsstrom, vor dem Einreihen), `herzschlag`
 * (nach jedem Herzschlag des Weltmodells, mit `je: quelle` einmal je Quelle) und `vor_pi` (bevor
 * ein Auftrag an den Agenten geht; `halten` lässt ihn warten). Höherer `vorrang` zuerst, bei
 * Gleichstand die Reihenfolge der Datei; `stopp` beendet die Auswertung für diesen Anlass.
 * Aktionen sind nur `melden` (sofort nach fyos:agent, ohne Modellzug) und `einreihen` (ein
 * Hintergrund-Auftrag) — keine Wirkungen im Haus oder Cluster.
 *
 * Zwei Schichten:
 *  - `Regelwerk`  die reine Auswertung der Datei (wird auch von der Wiedergabe benutzt);
 *  - `Reflexe`    der Baustein des Runners: lädt die Datei, hält Spielmodus und Pause zusätzlich
 *                 fest eingebaut (auch ohne oder mit kaputter Datei), schreibt die Aufzeichnung und
 *                 liefert Meldungen als fertige Ereignisse. Gesendet wird von außen.
 */
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';
import { REPO_RUNNER, pfadAufloesen } from './config.js';
import { FEHLT, kompakt, kurz, pfadHolen, weltAbleiten } from './welt.js';
import { join } from 'node:path';

export const REFLEX_ANLAESSE = ['eingang', 'herzschlag', 'vor_pi'];
export const REFLEX_VERGLEICHE = ['gleich', 'nicht', 'in', 'ab', 'unter', 'enthaelt', 'vorhanden'];
export const REFLEX_SCHWEREN = ['niedrig', 'mittel', 'hoch'];
const REFLEX_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const REFLEX_PFAD = /^(ereignis|welt|quelle|auftrag)(\.[A-Za-z0-9_-]+)+$/;
const REFLEX_PLATZ = /\{((?:ereignis|welt|quelle|auftrag)(?:\.[A-Za-z0-9_-]+)+)\}/g;
const REFLEX_FELDER = new Set(['id', 'bei', 'vorrang', 'wenn', 'dann', 'stopp', 'an_pi', 'je', 'entprellen', 'beschreibung']);
/** pi-notify-Arten je Schwere (Betrachter zeigen `ui_request/notify` wie eine pi-Benachrichtigung). */
const NOTIFY_ART = { niedrig: 'info', mittel: 'warning', hoch: 'error' };

const istObjekt = (w) => w !== null && typeof w === 'object' && !Array.isArray(w);
const pyText = (w) => (w === null || w === undefined ? 'None' : typeof w === 'boolean' ? (w ? 'True' : 'False') : String(w));

function gleich(ist, soll) {
  if (typeof ist === 'boolean' || typeof soll === 'boolean') {
    if (typeof ist === 'string') return ist.toLowerCase() === pyText(soll).toLowerCase();
    const zahl = (x) => (typeof x === 'boolean' ? Number(x) : x);
    return ist === soll || (typeof zahl(ist) === 'number' && zahl(ist) === zahl(soll));
  }
  if ((typeof ist === 'string') !== (typeof soll === 'string')) return pyText(ist) === pyText(soll);
  return isDeepStrictEqual(ist, soll);
}

function zahlOderNull(w) {
  if (typeof w === 'boolean') return null;
  if (typeof w === 'number') return w;
  const s = String(w).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

function vergleich(ist, soll) {
  if (!istObjekt(soll)) return ist !== FEHLT && gleich(ist, soll);
  for (const [op, w] of Object.entries(soll)) {
    let ok;
    if (op === 'gleich') ok = ist !== FEHLT && gleich(ist, w);
    else if (op === 'nicht') ok = ist === FEHLT || !gleich(ist, w);
    else if (op === 'in') ok = ist !== FEHLT && w.some((x) => gleich(ist, x));
    else if (op === 'ab' || op === 'unter') {
      const zahl = ist !== FEHLT ? zahlOderNull(ist) : null;
      ok = zahl !== null && (op === 'ab' ? zahl >= w : zahl < w);
    } else if (op === 'enthaelt') ok = typeof ist === 'string' && ist.toLowerCase().includes(String(w).toLowerCase());
    else ok = (ist !== FEHLT && ist !== null) === Boolean(w); // vorhanden
    if (!ok) return false;
  }
  return true;
}

function einsetzen(vorlage, kontext) {
  return vorlage.replace(REFLEX_PLATZ, (_, pfad) => {
    const w = pfadHolen(kontext, pfad);
    if (w === FEHLT || w === null || w === undefined) return '?';
    return typeof w === 'string' ? w : kompakt(w);
  });
}

class Regel {
  constructor(roh, nr) {
    if (!istObjekt(roh)) throw new Error(`Regel ${nr}: muss ein Objekt sein`);
    const rid = String(roh.id || '');
    const unbekannt = Object.keys(roh).filter((k) => !REFLEX_FELDER.has(k)).sort();
    if (unbekannt.length) throw new Error(`Regel ${rid || nr}: unbekannte Felder ${JSON.stringify(unbekannt)}`);
    if (!REFLEX_ID.test(rid)) throw new Error(`Regel ${nr}: id fehlt oder ist nicht [a-z0-9-]`);
    this.id = rid;
    this.bei = String(roh.bei || '');
    if (!REFLEX_ANLAESSE.includes(this.bei)) {
      throw new Error(`Regel ${rid}: bei muss eins aus ${JSON.stringify(REFLEX_ANLAESSE)} sein`);
    }
    const vorrang = roh.vorrang ?? 0;
    if (typeof vorrang === 'boolean' || !Number.isInteger(vorrang)) {
      throw new Error(`Regel ${rid}: vorrang muss eine ganze Zahl sein`);
    }
    this.vorrang = vorrang;
    this.nr = nr;
    this.stopp = Boolean(roh.stopp ?? false);
    this.an_pi = Boolean(roh.an_pi ?? true);
    if ('an_pi' in roh && this.bei !== 'eingang') throw new Error(`Regel ${rid}: an_pi gilt nur bei eingang`);
    this.je = roh.je ?? null;
    if (this.je !== null && (this.bei !== 'herzschlag' || this.je !== 'quelle')) {
      throw new Error(`Regel ${rid}: je: quelle gibt es nur bei herzschlag`);
    }
    this.entprellen = Boolean(roh.entprellen ?? false);
    if (this.entprellen && this.bei !== 'herzschlag') {
      throw new Error(`Regel ${rid}: entprellen gibt es nur bei herzschlag`);
    }
    const wenn = roh.wenn ?? {};
    if (!istObjekt(wenn)) throw new Error(`Regel ${rid}: wenn muss ein Objekt aus Pfad → Bedingung sein`);
    for (const [pfad, soll] of Object.entries(wenn)) {
      if (!REFLEX_PFAD.test(String(pfad))) {
        throw new Error(`Regel ${rid}: Pfad '${pfad}' beginnt nicht mit ereignis/welt/quelle/auftrag`);
      }
      if (istObjekt(soll)) {
        for (const [op, w] of Object.entries(soll)) {
          if (!REFLEX_VERGLEICHE.includes(op)) throw new Error(`Regel ${rid}: Vergleich '${op}' unbekannt`);
          if (op === 'in' && !Array.isArray(w)) throw new Error(`Regel ${rid}: in braucht eine Liste`);
          if ((op === 'ab' || op === 'unter') && (typeof w !== 'number' || Number.isNaN(w))) {
            throw new Error(`Regel ${rid}: ${op} braucht eine Zahl`);
          }
        }
      }
    }
    this.wenn = { ...wenn };
    const dann = roh.dann;
    if (!Array.isArray(dann) || !dann.length) throw new Error(`Regel ${rid}: dann braucht mindestens eine Aktion`);
    this.dann = [];
    for (const aktion of dann) {
      if (aktion === 'halten') {
        if (this.bei !== 'vor_pi') throw new Error(`Regel ${rid}: halten gibt es nur bei vor_pi`);
        this.dann.push({ art: 'halten' });
        continue;
      }
      if (!istObjekt(aktion) || Object.keys(aktion).length !== 1) {
        throw new Error(`Regel ${rid}: Aktion ${kompakt(aktion)} ist weder halten noch melden/einreihen`);
      }
      const [art, arg] = Object.entries(aktion)[0];
      if (!['melden', 'einreihen'].includes(art) || !istObjekt(arg)) {
        throw new Error(`Regel ${rid}: Aktion '${art}' unbekannt (nur melden, einreihen, halten)`);
      }
      if (this.bei === 'vor_pi') throw new Error(`Regel ${rid}: bei vor_pi gibt es nur halten`);
      if (typeof arg.text !== 'string' || !arg.text.trim()) throw new Error(`Regel ${rid}: ${art} braucht text`);
      if (Object.keys(arg).some((k) => k !== 'text' && k !== 'schwere')) {
        throw new Error(`Regel ${rid}: ${art} kennt nur text und schwere`);
      }
      const schwere = String(arg.schwere || 'mittel');
      if (!REFLEX_SCHWEREN.includes(schwere)) {
        throw new Error(`Regel ${rid}: schwere muss eins aus ${JSON.stringify(REFLEX_SCHWEREN)} sein`);
      }
      this.dann.push({ art, text: arg.text, schwere });
    }
  }

  passt(kontext) {
    return Object.entries(this.wenn).every(([p, s]) => vergleich(pfadHolen(kontext, p), s));
  }

  aktionen(kontext) {
    return this.dann
      .filter((a) => a.art !== 'halten')
      .map((a) => ({
        art: a.art,
        regel: this.id,
        schwere: a.schwere,
        text: kurz(einsetzen(a.text, kontext).trim(), 2000),
      }));
  }
}

/** Die reine Auswertung: Regeln aus der Datei, Entscheidungen zu Ereignis, Herzschlag und Auftrag. */
export class Regelwerk {
  constructor(regeln, herkunft = '') {
    this.herkunft = herkunft;
    this.regeln = regeln;
    this._je = Object.fromEntries(
      REFLEX_ANLAESSE.map((anlass) => [
        anlass,
        regeln.filter((r) => r.bei === anlass).sort((a, b) => b.vorrang - a.vorrang || a.nr - b.nr),
      ]),
    );
    this._aktiv = new Set(); // entprellte Regeln, die gerade ausgelöst sind
  }

  static ausDaten(daten, herkunft = '') {
    if (!istObjekt(daten) || daten.version !== 1) throw new Error('Reflexe: Objekt mit version: 1 erwartet');
    if (!Array.isArray(daten.regeln)) throw new Error('Reflexe: regeln muss eine Liste sein');
    const regeln = daten.regeln.map((r, i) => new Regel(r, i + 1));
    const ids = regeln.map((r) => r.id);
    const doppelt = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))].sort();
    if (doppelt.length) throw new Error(`Reflexe: doppelte id ${JSON.stringify(doppelt)}`);
    return new Regelwerk(regeln, herkunft);
  }

  /** YAML (oder JSON, das ist gültiges YAML) lesen; wirft bei Lese- und Formfehlern. */
  static laden(pfad) {
    const text = readFileSync(pfad, 'utf8');
    let daten;
    try {
      daten = parse(text);
    } catch (fehler) {
      throw new Error(`${pfad}: kein gültiges YAML: ${fehler.message}`);
    }
    return Regelwerk.ausDaten(daten, String(pfad));
  }

  hat(anlass) {
    return Boolean(this._je[anlass]?.length);
  }

  /** Entscheidung zu einem Eingangsereignis: {anlass, an_pi, aktionen, regeln}. */
  eingang(ereignis, welt) {
    const kontext = { ereignis, welt };
    let anPi = true;
    const aktionen = [];
    const getroffen = [];
    for (const regel of this._je.eingang) {
      if (!regel.passt(kontext)) continue;
      getroffen.push(regel.id);
      aktionen.push(...regel.aktionen(kontext));
      anPi = anPi && regel.an_pi;
      if (regel.stopp) break;
    }
    return { anlass: 'eingang', an_pi: anPi, aktionen, regeln: getroffen };
  }

  /** Id der Regel, die den Auftrag jetzt hält — sonst null. */
  vorPi(auftrag, welt) {
    const kontext = { auftrag, welt };
    for (const regel of this._je.vor_pi) {
      if (regel.passt(kontext)) {
        if (regel.dann.some((a) => a.art === 'halten')) return regel.id;
        if (regel.stopp) return null;
      }
    }
    return null;
  }

  /**
   * Entscheidung nach einem Herzschlag: {anlass, aktionen, regeln}. Entprellte Regeln lösen je
   * Schlüssel (Regel, ggf. Quelle) einmal aus und erst wieder, nachdem die Bedingung wegfiel.
   */
  herzschlag(welt) {
    const aktionen = [];
    const getroffen = [];
    const nochAktiv = new Set();
    const geprueft = new Set();
    for (const regel of this._je.herzschlag) {
      geprueft.add(regel.id);
      const faelle =
        regel.je === 'quelle'
          ? Object.entries(welt?.quellen ?? {}).map(([n, q]) => [{ welt, quelle: q }, `${regel.id}:${n}`])
          : [[{ welt }, regel.id]];
      let stopp = false;
      for (const [kontext, schluessel] of faelle) {
        if (!regel.passt(kontext)) continue;
        if (regel.entprellen) {
          nochAktiv.add(schluessel);
          if (this._aktiv.has(schluessel)) continue;
        }
        getroffen.push(schluessel);
        aktionen.push(...regel.aktionen(kontext));
        stopp = stopp || regel.stopp;
      }
      if (stopp) break;
    }
    // Schlüssel von Regeln, die wegen `stopp` nicht dran waren, bleiben, wie sie waren.
    const bleiben = [...this._aktiv].filter((s) => !geprueft.has(s.split(':')[0]));
    this._aktiv = new Set([...nochAktiv, ...bleiben]);
    return { anlass: 'herzschlag', aktionen, regeln: getroffen };
  }
}

const KEINE = { anlass: 'eingang', an_pi: true, aktionen: [], regeln: [] };
const CACHE_MAX = 500;

export class Reflexe {
  /**
   * @param {object} p
   * @param {object} p.cfg           `cfg.reflexe.datei`, `cfg.agent`
   * @param {object} [p.welt]        Weltmodell (Weltbild für die Regeln)
   * @param {object} [p.spielmodus]  Spielmodus (`an()`, `grund()`): hält fest eingebaut, auch ohne Datei
   * @param {object} [p.aufzeichnung] Aufzeichnung (`schreibe`)
   * @param {Function} [p.log]
   * @param {Function} [p.jetzt]     () → Millisekunden
   */
  constructor({ cfg = {}, hub = null, welt = null, spielmodus = null, aufzeichnung = null, log = (z) => console.log(z), jetzt = () => Date.now() } = {}) {
    this.cfg = cfg;
    this.hub = hub;
    this.welt = welt;
    this.spielmodus = spielmodus;
    this.aufzeichnung = aufzeichnung;
    this.log = log;
    this._jetzt = jetzt;
    this.agent = cfg.agent ?? 'persona';
    this.regelwerk = null;
    this.fehler = null;
    this.datei = null;
    this.ausgeloest = {};
    this._meldungNr = 0;
    this._eingaenge = new Map(); // stromId → Ergebnis der Eingangs-Reflexe (jeder Eingang zählt nur einmal)
    this._gehalten = new Map(); // stromId → Grund, mit dem er gerade wartet
    this._spielGemeldet = false;
  }

  /**
   * Die Datei laden: `cfg.reflexe.datei`, sonst `reflexe.yaml` neben dem Runner; `cfg.reflexe: null`
   * schaltet die Datei ab. Ein Fehler hält den Runner nicht auf — es gelten dann nur die fest
   * eingebauten Regeln (Spielmodus, Pause). Gibt die Zahl geladener Regeln zurück.
   */
  laden() {
    this.regelwerk = null;
    this.fehler = null;
    const ref = this.cfg.reflexe === undefined ? {} : this.cfg.reflexe;
    if (ref === null || typeof ref !== 'object') {
      this.datei = null;
      return 0;
    }
    this.datei = ref.datei ? pfadAufloesen(ref.datei) : join(REPO_RUNNER, 'reflexe.yaml');
    try {
      this.regelwerk = Regelwerk.laden(this.datei);
      this.log(`[fyos-reflexe] ${this.regelwerk.regeln.length} Regeln aus ${this.datei}`);
      return this.regelwerk.regeln.length;
    } catch (fehler) {
      this.fehler = String(fehler?.message ?? fehler).slice(0, 300);
      this.log(`[fyos-reflexe] nicht geladen — Runner läuft ohne: ${this.fehler}`);
      return 0;
    }
  }

  hat(anlass) {
    return Boolean(this.regelwerk?.hat(anlass));
  }

  /** Das abgeleitete Weltbild für die Regeln; der Spielmodus steht immer darin. */
  weltBild() {
    const jetzt = this._jetzt();
    const roh = this.welt ? this.welt.welt() : { v: 1, t: jetzt, quellen: {} };
    if (!roh.spielmodus && this.spielmodus) roh.spielmodus = { wert: this.spielmodus.an(), t: jetzt, quelle: 'runner' };
    return weltAbleiten(roh, Number(roh.t) || jetzt);
  }

  /** Das Ereignis, das die Regeln sehen: die Felder des Hub-Eingangs, aus dem Wartend-Eintrag. */
  static ereignisAus(eintrag) {
    const e = {
      id: String(eintrag.stromId ?? eintrag.id ?? ''),
      text: eintrag.text,
      quelle: eintrag.quelle,
      von: eintrag.von,
      bezug: eintrag.bezug,
      klasse: eintrag.klasse,
      arbeitsbereich: eintrag.arbeitsbereich,
    };
    if (eintrag.schwere !== undefined) e.schwere = eintrag.schwere;
    return e;
  }

  #zaehlen(regeln) {
    for (const regel of regeln ?? []) {
      const schluessel = String(regel).split(':')[0];
      this.ausgeloest[schluessel] = (this.ausgeloest[schluessel] ?? 0) + 1;
    }
  }

  #meldung(aktion, ein) {
    this._meldungNr += 1;
    const nutzlast = {
      message: aktion.text,
      notifyType: NOTIFY_ART[aktion.schwere] ?? 'info',
      reflex: aktion.regel,
      schwere: aktion.schwere,
    };
    if (ein) nutzlast.ein = ein;
    this.log(`[fyos-reflexe] ${aktion.regel} meldet (${aktion.schwere}): ${aktion.text.slice(0, 160)}`);
    // Sitzung und Zähler (`q`) setzt der Ausgang beim Senden.
    return {
      typ: 'ui_request',
      id: `reflex:${aktion.regel}:${this._meldungNr}`,
      methode: 'notify',
      nutzlast,
      agent: this.agent,
      t: this._jetzt(),
    };
  }

  /** Aktionen in Meldungen (`melden`) und Aufträge (`einreihen`) sortieren; sonst bewirken sie nichts. */
  #aktionen(entscheidung, ein, idBasis) {
    const meldungen = [];
    const einreihen = [];
    this.#zaehlen(entscheidung.regeln);
    for (const aktion of entscheidung.aktionen ?? []) {
      if (aktion.art === 'melden') meldungen.push(this.#meldung(aktion, ein));
      else if (aktion.art === 'einreihen') {
        einreihen.push({
          id: `reflex:${aktion.regel}:${idBasis}`,
          text: aktion.text,
          quelle: 'reflex',
          von: 'reflex',
          klasse: 'hintergrund',
          reflex: aktion.regel,
        });
      }
    }
    return { meldungen, einreihen };
  }

  /**
   * Das Urteil zu einem Eintrag aus `Wartend` (stromId, text, quelle, von, bezug, klasse, arbeitsbereich,
   * ggf. schwere): `weiter` (an den Agenten), `verwerfen` (ein Eingangs-Reflex sagt: nicht an pi) oder
   * `halten` (jetzt nicht: vor_pi-Regel, Spielmodus oder Pause — der Eintrag bleibt liegen).
   *
   * Die Eingangs-Reflexe laufen je stromId einmal (Aufzeichnung, Meldungen, Einreihen); ein erneuter Aufruf
   * für denselben Eintrag, etwa nach einem `halten`, prüft nur noch die Haltegründe.
   * Rückgabe: { urteil, grund, meldungen, einreihen }.
   */
  entscheide(eintrag) {
    const ereignis = Reflexe.ereignisAus(eintrag);
    const ein = ereignis.id;
    let meldungen = [];
    let einreihen = [];
    let eingang = ein ? this._eingaenge.get(ein) : undefined;
    if (!eingang) {
      this.aufzeichnung?.schreibe('eingang', { ereignis, live: { ...this.#spielFakt(), ...(this.welt?.faktenJetzt?.() ?? {}) } });
      let entscheidung = KEINE;
      if (this.regelwerk) {
        entscheidung = this.regelwerk.eingang(ereignis, this.weltBild());
        if (entscheidung.regeln.length) this.aufzeichnung?.schreibe('entscheidung', { ein, ...entscheidung });
        ({ meldungen, einreihen } = this.#aktionen(entscheidung, ein, ein || this._meldungNr));
      }
      eingang = { an_pi: entscheidung.an_pi, regeln: entscheidung.regeln };
      if (ein) {
        this._eingaenge.set(ein, eingang);
        if (this._eingaenge.size > CACHE_MAX) this._eingaenge.delete(this._eingaenge.keys().next().value);
      }
      if (!eingang.an_pi) {
        this.log(`[fyos-reflexe] Eingang ${ein}: Reflex ${eingang.regeln.join(',')} — nicht an pi`);
      }
    }
    if (!eingang.an_pi) {
      return { urteil: 'verwerfen', grund: `reflex:${eingang.regeln.join(',')}`, meldungen, einreihen };
    }
    const halt = this.#haltegrund(eintrag, ein);
    if (halt) return { urteil: 'halten', grund: halt, meldungen, einreihen };
    if (ein) this._gehalten.delete(ein);
    return { urteil: 'weiter', grund: '', meldungen, einreihen };
  }

  /** Grund, aus dem ein Eintrag jetzt wartet: erst die Regeln (vor_pi), darunter fest eingebaut Spielmodus und Pause. */
  #haltegrund(eintrag, ein) {
    if (this.hat('vor_pi')) {
      const auftrag = {
        text: eintrag.text,
        klasse: eintrag.klasse === 'max' ? 'max' : 'hintergrund',
        quelle: eintrag.quelle,
        ein,
        bezug: eintrag.bezug,
      };
      const halt = this.regelwerk.vorPi(auftrag, this.weltBild());
      if (halt) {
        if (this._gehalten.get(ein) !== halt) {
          this.log(`[fyos-reflexe] ${halt} hält wartende Aufträge zurück`);
          this.ausgeloest[halt] = (this.ausgeloest[halt] ?? 0) + 1;
        }
        this._gehalten.set(ein, halt);
        return `reflex:${halt}`;
      }
    }
    // Sicherheit, unabhängig von reflexe.yaml: Spielmodus und Pause halten immer.
    const spiel = this.spielmodus?.grund?.() ?? (this.spielmodus?.an?.() ? 'spielmodus' : null);
    if (spiel) {
      if (!this._spielGemeldet) {
        this._spielGemeldet = true;
        this.log('[fyos-reflexe] Spielmodus aktiv — wartende Aufträge bleiben liegen');
      }
      this._gehalten.set(ein, 'spielmodus');
      return `spielmodus:${spiel}`;
    }
    this._spielGemeldet = false;
    return null;
  }

  #spielFakt() {
    return this.spielmodus ? { spielmodus: this.spielmodus.an() } : {};
  }

  /**
   * Nach einem Herzschlag des Weltmodells (`Weltmodell.beiHerzschlag`): Bild aufzeichnen, Herzschlag-Reflexe
   * auswerten. Rückgabe: { meldungen, einreihen } zum Senden bzw. Einreihen durch den Zusammenbau.
   */
  beiHerzschlag(bild) {
    this.aufzeichnung?.schreibe('welt', { welt: this.welt?.fuerAufzeichnung ? this.welt.fuerAufzeichnung(bild) : bild });
    if (!this.hat('herzschlag')) return { meldungen: [], einreihen: [] };
    const entscheidung = this.regelwerk.herzschlag(weltAbleiten(bild, Number(bild.t) || this._jetzt()));
    if (entscheidung.regeln.length) this.aufzeichnung?.schreibe('entscheidung', entscheidung);
    return this.#aktionen(entscheidung, null, bild.t ?? this._jetzt());
  }

  /** Kleines Objekt für /zustand. */
  zustand() {
    return {
      regeln: this.regelwerk ? this.regelwerk.regeln.length : 0,
      datei: this.regelwerk ? this.regelwerk.herkunft : this.datei,
      fehler: this.fehler,
      ausgeloest: { ...this.ausgeloest },
    };
  }
}
