/**
 * welt.js — das Weltmodell: eine Wahrheit über Haus, Besitzer und System, ohne Sprachmodell gepflegt.
 *
 * Port von `Weltmodell`, `weltblock`, `welt_ableiten`, `auszug` und `pfad_holen` aus dem
 * RPC-Runner (agent_runner.py, Plan „Persona lebt“ §3a). Gleiche Quellen, gleiche Konfigschlüssel
 * (`cfg.welt`: an, datei, herzschlag_s, zeit_s, block_max, quellen), gleiches Format der
 * `welt.json`.
 *
 * Je Quelle ein lesendes Hub-Werkzeug. Jede Angabe trägt einen Zeitstempel `t` (letzte gelungene
 * Antwort) und ihre `quelle`. Scheitert eine Abfrage, bleibt der zuletzt bekannte Wert mit seinem
 * alten Zeitstempel stehen, `ok` wird false, `fehler` und `ausfall_seit` sagen, was los ist —
 * geraten wird nichts. Der Runner steuert eigene Angaben bei (Spielmodus, was Persona tut) über
 * `fakten`, live bei jedem Bild.
 *
 * Die reinen Funktionen (`weltAbleiten`, `weltblock`, `pfadHolen`) bekommen Weltbild und Zeit von
 * außen; so spielt `scripts/wiedergabe.mjs` eine Aufzeichnung ohne Modell und GPU ab.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pfadAufloesen } from './config.js';

/** Marke für „Pfad fehlt“ (nicht null: null ist ein echter Wert). */
export const FEHLT = Symbol('fehlt');

/** Ein Feld im Weltmodell: Text oder JSON-Vorschau, höchstens so lang. */
export const WERT_MAX = 600;

/** Vorgaben von `cfg.welt` (wie `VORGABE["welt"]` im RPC-Runner; ein Schlüssel auf oberster Ebene ersetzt). */
export const WELT_VORGABE = {
  an: true,
  datei: null,
  herzschlag_s: 60,
  zeit_s: 8,
  block_max: 1500,
  quellen: {
    anwesenheit: { werkzeug: 'anwesenheit.wo', felder: ['satz', 'vermutung.bereich', 'vermutung.sicherheit'] },
    zentrale: { werkzeug: 'zentrale.zustand', argumente: { form: 'kurz' }, felder: ['lage_satz', 'ampel'] },
    lagebild: { werkzeug: 'leitstand.lagebild', argumente: { stunden: 1 }, felder: ['satz'] },
    belegung: {
      werkzeug: 'belegung.zustand',
      argumente: { schlank: true, tage: 1 },
      felder: ['gesamt.satz', 'wirkung.text', 'schloesser.satz'],
    },
    schleifen: { werkzeug: 'schleifen.darf', argumente: { schleife: 'arbeit' }, felder: ['darf', 'warum'] },
    augen: { werkzeug: 'augen.zustand', felder: ['erreichbar', 'satz'] },
    // Besitzer 20.10. („genehmigt“, Entscheidungsbuch 510): was sie regelmäßig braucht, ohne es erst zu fragen.
    cluster: { werkzeug: 'cluster.lage', felder: ['zustand', 'satz'] },
    hausmodell: { werkzeug: 'hausmodell.zustand', felder: ['satz'] },
    erkunden: {
      werkzeug: 'erkunden.zustand',
      felder: ['naechster', 'offen.gesamt', 'offen.schwer', 'offen.ungemeldet', 'letzter.bereich'],
    },
    wartet_auf_max: { werkzeug: 'itsm.wartend', felder: ['anzahl', 'andere_wartende'] },
    // Reiner Kontext (Fenstertitel sind Besitzer' Bildschirm): nicht in die Aufzeichnung.
    os: { werkzeug: 'os.lage', felder: ['satz'], aufzeichnen: false },
    // Anonym, nur „Raum belegt seit“; im Weltblock ja (Entscheidungsbuch 487), in der Aufzeichnung nie.
    raeume: { werkzeug: 'anwesenheit.raeume', felder: ['satz', 'belegt'], im_block: true, aufzeichnen: false },
  },
};

const istObjekt = (w) => w !== null && typeof w === 'object' && !Array.isArray(w);
const hat = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function jetztMs() {
  return Date.now();
}

/** Kompaktes JSON ohne Leerraum; bei Unbrauchbarem der Text des Werts. */
export function kompakt(wert) {
  try {
    const s = JSON.stringify(wert);
    return s === undefined ? String(wert) : s;
  } catch {
    return String(wert);
  }
}

/** Text auf `grenze` Zeichen kürzen (Auslassungszeichen zählt mit), ohne ein Ersatzpaar zu zerreißen. */
export function kurz(text, grenze) {
  const s = String(text);
  if (s.length <= grenze) return s;
  let ende = Math.max(grenze - 1, 0);
  const c = s.charCodeAt(ende - 1);
  if (ende > 0 && c >= 0xd800 && c <= 0xdbff) ende -= 1;
  return s.slice(0, ende) + '…';
}

/**
 * Punktpfad (`welt.quellen.augen.ok`) in verschachtelten Objekten; `FEHLT`, wenn er fehlt.
 *
 * Angaben im Weltbild sind Hüllen `{wert, t, quelle}`: Ein Pfad schreitet durch `wert` hindurch,
 * und endet er auf einer Hülle, zählt ihr `wert` (`welt.spielmodus` → true/false).
 */
export function pfadHolen(wert, pfad) {
  let aktuell = wert;
  for (const teil of String(pfad).split('.')) {
    if (istObjekt(aktuell) && !hat(aktuell, teil) && istObjekt(aktuell.wert) && hat(aktuell, 'quelle')) {
      aktuell = aktuell.wert;
    }
    if (istObjekt(aktuell) && hat(aktuell, teil)) {
      aktuell = aktuell[teil];
    } else if (Array.isArray(aktuell) && /^\d+$/.test(teil) && Number(teil) < aktuell.length) {
      aktuell = aktuell[Number(teil)];
    } else {
      return FEHLT;
    }
  }
  if (istObjekt(aktuell) && hat(aktuell, 'wert') && hat(aktuell, 'quelle') && hat(aktuell, 't')) {
    return aktuell.wert;
  }
  return aktuell;
}

function pfadSetzen(ziel, pfad, wert) {
  const teile = pfad.split('.');
  let z = ziel;
  for (const teil of teile.slice(0, -1)) {
    if (!istObjekt(z[teil])) z[teil] = {};
    z = z[teil];
  }
  z[teile[teile.length - 1]] = wert;
}

/** Ein Feld für das Weltmodell: kurze Texte und kleine Strukturen bleiben, Großes wird Vorschau. */
function klein(wert) {
  if (typeof wert === 'string') return kurz(wert, WERT_MAX);
  if (wert !== null && typeof wert === 'object') {
    const text = kompakt(wert);
    return text.length <= WERT_MAX ? wert : kurz(text, WERT_MAX);
  }
  return wert;
}

/** Hub-Ergebnisse im MCP-Mantel (`content[].text` mit JSON) auspacken; sonst unverändert. */
function auspacken(ergebnis) {
  if (istObjekt(ergebnis) && Array.isArray(ergebnis.content)) {
    const text = ergebnis.content
      .filter((t) => t && t.type === 'text' && typeof t.text === 'string')
      .map((t) => t.text)
      .join('\n');
    try {
      const daten = JSON.parse(text);
      if (daten !== null && typeof daten === 'object') return daten;
    } catch {
      /* kein JSON: der Mantel bleibt */
    }
  }
  return ergebnis;
}

/**
 * Aus einem Werkzeug-Ergebnis nur die genannten Felder (Punktpfade) behalten.
 *
 * Ohne Feldliste bleibt ein kleines Ergebnis ganz; ein großes schrumpft auf `satz` (die meisten
 * Lesewerkzeuge haben einen) oder eine Vorschau. Fehlende Felder fehlen — sie werden nicht geraten.
 */
export function auszug(ergebnis, felder) {
  if (Array.isArray(felder) && felder.length) {
    const aus = {};
    for (const feld of felder) {
      const w = pfadHolen(ergebnis, feld);
      if (w !== FEHLT) pfadSetzen(aus, feld, klein(w));
    }
    return aus;
  }
  const text = kompakt(ergebnis);
  if (text.length <= 2000) return ergebnis;
  if (istObjekt(ergebnis) && typeof ergebnis.satz === 'string') return { satz: kurz(ergebnis.satz, WERT_MAX) };
  return { vorschau: kurz(text, WERT_MAX) };
}

/**
 * Abgeleitete Größen für die Reflexe: je Quelle `name` und `stumm_min` (0, solange sie liefert).
 *
 * Stumm heißt: die letzte Abfrage scheiterte. Gezählt wird ab der letzten gelungenen Antwort,
 * sonst ab dem ersten Fehlschlag.
 */
export function weltAbleiten(welt, jetzt) {
  const abgeleitet = { ...welt, jetzt };
  const quellen = {};
  for (const [name, roh] of Object.entries(welt?.quellen ?? {})) {
    if (!istObjekt(roh)) continue;
    const q = { ...roh, name };
    const stummSeit = q.ok ? null : q.t || q.ausfall_seit;
    q.stumm_min = stummSeit ? Math.floor(Math.max(jetzt - Number(stummSeit), 0) / 60_000) : 0;
    quellen[name] = q;
  }
  abgeleitet.quellen = quellen;
  return abgeleitet;
}

function alter(ms) {
  const s = Math.max(Math.floor(ms / 1000), 0);
  if (s < 90) return `${s} s`;
  if (s < 90 * 60) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h`;
}

function blaetter(wert, vorne = '') {
  if (istObjekt(wert)) {
    const aus = [];
    for (const [k, w] of Object.entries(wert)) aus.push(...blaetter(w, vorne ? `${vorne}.${k}` : String(k)));
    return aus;
  }
  return [[vorne, wert]];
}

const leer = (w) =>
  w === null ||
  w === undefined ||
  w === '' ||
  (Array.isArray(w) && w.length === 0) ||
  (istObjekt(w) && Object.keys(w).length === 0);

function zeileWert(wert) {
  const teile = [];
  for (const [pfad, w] of blaetter(wert)) {
    if (leer(w)) continue;
    if (typeof w === 'string') teile.push(w.split(/\s+/).filter(Boolean).join(' '));
    else teile.push(`${pfad.split('.').pop() || 'wert'}=${kompakt(w)}`);
  }
  return teile.join('; ') || '(leer)';
}

function uhrzeit(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Der kurze Weltblock, den der Runner jedem prompt anhängt (höchstens `grenze` Zeichen).
 *
 * Jede Zeile nennt das Alter ihrer Angabe; eine ausgefallene Quelle steht als AUSGEFALLEN mit
 * Grund da (und mit dem zuletzt bekannten Wert samt dessen Alter) — nie still weggelassen.
 * Ausgenommen sind nur Quellen, die ausdrücklich `im_block: false` tragen (Raum-Belegung).
 */
export function weltblock(welt, jetzt, grenze = 1500) {
  if (!welt) return '';
  const kopf = `[Weltbild ${uhrzeit(jetzt)} · vom Runner gepflegt, ohne Modell; Alter in Klammern]`;
  const zeilen = [];
  const spiel = welt.spielmodus;
  if (istObjekt(spiel) && hat(spiel, 'wert')) {
    zeilen.push(`Spielmodus: ${spiel.wert ? 'AN (Hauptserver gehört dem Spiel)' : 'aus'}`);
  }
  for (const [name, q] of Object.entries(welt.quellen ?? {})) {
    if (!istObjekt(q) || q.im_block === false) continue;
    if (q.ok && q.t) {
      zeilen.push(`${name} (${alter(jetzt - q.t)}): ${zeileWert(q.wert)}`);
    } else if (q.versuch_t) {
      const seit = q.ausfall_seit || q.versuch_t;
      let zeile = `${name}: AUSGEFALLEN seit ${alter(jetzt - seit)} (${q.fehler || '?'})`;
      if (q.t) zeile += `; zuletzt bekannt (${alter(jetzt - q.t)}): ${zeileWert(q.wert)}`;
      else zeile += '; nichts bekannt';
      zeilen.push(zeile);
    } else {
      zeilen.push(`${name}: noch nicht abgefragt`);
    }
  }
  if (!zeilen.length) return '';
  // Platz gerecht verteilen: kurze Zeilen nehmen nur, was sie brauchen; der Rest geht an die langen.
  let rest = grenze - kopf.length - zeilen.length;
  const budget = new Map();
  const nachLaenge = zeilen.map((_, i) => i).sort((a, b) => zeilen[a].length - zeilen[b].length);
  nachLaenge.forEach((i, rang) => {
    const anteil = Math.max(Math.floor(rest / (zeilen.length - rang)), 12);
    budget.set(i, Math.min(zeilen[i].length, anteil));
    rest -= budget.get(i);
  });
  const text = [kopf, ...zeilen.map((z, i) => kurz(z, budget.get(i)))].join('\n');
  return kurz(text, grenze);
}

function tief(a, b) {
  return { ...a, ...b };
}

export class Weltmodell {
  /**
   * @param {object} p
   * @param {object} p.cfg      Konfiguration (`cfg.welt`, `cfg.pi_durable.storage`)
   * @param {object} p.hub      Hub mit `aufrufen(werkzeug, argumente, {ansicht, timeoutMs})`
   * @param {Function} [p.log]  Zeilen-Logger
   * @param {Function} [p.fakten]        () → Objekt eigener Angaben des Runners (Spielmodus, persona …)
   * @param {Function} [p.beiHerzschlag] (bild) → nach jedem Herzschlag (Reflexe, Aufzeichnung)
   * @param {Function} [p.jetzt]         () → Millisekunden (für Tests)
   */
  constructor({ cfg = {}, hub, log = (z) => console.log(z), fakten = null, beiHerzschlag = null, jetzt = jetztMs, datei } = {}) {
    // Wie im RPC-Runner: fehlt der Schlüssel, gelten die Vorgaben; `welt: null` oder an=false schaltet aus.
    const roh = cfg.welt === undefined ? {} : cfg.welt;
    this.aktiv = roh !== null && typeof roh === 'object' && roh.an !== false;
    const k = this.aktiv ? tief(WELT_VORGABE, roh) : tief(WELT_VORGABE, {});
    this.hub = hub;
    this.log = log;
    this.fakten = fakten;
    this.beiHerzschlag = beiHerzschlag;
    this._jetzt = jetzt;
    const zahl = (w, vorgabe) => (Number.isFinite(Number(w)) && w !== null && w !== '' ? Number(w) : vorgabe);
    this.herzschlag_s = Math.max(zahl(k.herzschlag_s, 60), 1);
    this.zeit_s = zahl(k.zeit_s, 8);
    this.blockMax = Number.isFinite(Number(k.block_max)) ? Math.trunc(Number(k.block_max)) : 1500;
    const storage = cfg.pi_durable?.storage;
    this.datei =
      datei ??
      (k.datei ? pfadAufloesen(k.datei) : join(storage ? dirname(storage) : process.cwd(), 'welt.json'));
    this.herzschlaege = 0;
    this.seit = jetzt();
    this._konf = new Map();
    this._stand = new Map();
    this._timer = null;
    this._laeuft = false;
    if (this.aktiv) {
      for (const [name, q] of Object.entries(k.quellen ?? {})) {
        if (!istObjekt(q) || !q.werkzeug) {
          this.log(`[fyos-welt] Quelle ${JSON.stringify(name)} ohne Werkzeug übersprungen`);
          continue;
        }
        this._konf.set(String(name), {
          werkzeug: String(q.werkzeug),
          argumente: { ...(q.argumente ?? {}) },
          felder: (q.felder ?? []).map(String),
          aufzeichnen: q.aufzeichnen !== false,
        });
        const stand = {
          quelle: `hub:${q.werkzeug}`, ok: false, t: null, versuch_t: null,
          fehler: null, ausfall_seit: null, wert: null,
        };
        if (q.im_block === false) stand.im_block = false;
        this._stand.set(String(name), stand);
      }
      this.#laden();
    }
  }

  /** Nach einem Neustart: zuletzt Bekanntes mit altem Zeitstempel übernehmen (nicht als frisch). */
  #laden() {
    let alt;
    try {
      alt = JSON.parse(readFileSync(this.datei, 'utf8'));
    } catch {
      return;
    }
    for (const [name, q] of Object.entries(alt?.quellen ?? {})) {
      const stand = this._stand.get(name);
      if (stand && istObjekt(q) && Number.isInteger(q.t)) {
        Object.assign(stand, { t: q.t, wert: q.wert ?? null, ok: false, fehler: 'seit dem Neustart noch nicht abgefragt' });
      }
    }
  }

  async #aufrufen(werkzeug, argumente) {
    const antwort = await this.hub.aufrufen(werkzeug, argumente, {
      ansicht: 'voll',
      timeoutMs: this.zeit_s * 1000,
    });
    if (!antwort || antwort.ok === false) throw new Error(antwort?.fehler || 'Hub meldet einen Fehler');
    return auspacken(antwort.result);
  }

  async #abfragen(name, k) {
    const versuch = this._jetzt();
    let neu;
    try {
      const wert = auszug(await this.#aufrufen(k.werkzeug, k.argumente), k.felder);
      neu = { ok: true, t: this._jetzt(), versuch_t: versuch, fehler: null, ausfall_seit: null, wert };
    } catch (fehler) {
      // Jede Quelle darf ausfallen, die Welt nicht.
      const alt = this._stand.get(name);
      neu = {
        ok: false,
        versuch_t: versuch,
        fehler: kurz(String(fehler?.message ?? fehler), 160),
        ausfall_seit: alt.ausfall_seit || versuch,
      };
      if (alt.ok || !alt.ausfall_seit) this.log(`[fyos-welt] Quelle ${name} ausgefallen: ${neu.fehler}`);
    }
    Object.assign(this._stand.get(name), neu);
  }

  /** Ein Herzschlag: alle Quellen abfragen (nebenläufig, je Zeitgrenze), welt.json schreiben, Bild weiterreichen. */
  async schlagen() {
    await Promise.all([...this._konf].map(([name, k]) => this.#abfragen(name, k)));
    this.herzschlaege += 1;
    const bild = this.bild();
    this.#schreiben(bild);
    if (this.beiHerzschlag) {
      try {
        await this.beiHerzschlag(bild);
      } catch (fehler) {
        // Ein Reflexfehler darf den Herzschlag nicht anhalten.
        this.log(`[fyos-welt] Nachlauf des Herzschlags hat geworfen: ${fehler?.stack ?? fehler}`);
      }
    }
    return bild;
  }

  /** Eigene Angaben des Runners, jetzt gemessen (Spielmodus …); leer ohne `fakten`. */
  faktenJetzt() {
    try {
      return (this.fakten ? this.fakten() : null) ?? {};
    } catch (fehler) {
      this.log(`[fyos-welt] fakten() hat geworfen: ${fehler?.message ?? fehler}`);
      return {};
    }
  }

  /** Das Bild wie `welt.json`: Quellen mit Zeit und Quelle, dazu die Angaben des Runners. */
  bild() {
    const jetzt = this._jetzt();
    const quellen = {};
    for (const [n, q] of this._stand) quellen[n] = { ...q };
    const bild = { v: 1, t: jetzt, herzschlag: this.herzschlaege, seit: this.seit, quellen };
    for (const [schluessel, wert] of Object.entries(this.faktenJetzt())) {
      bild[schluessel] = { wert, t: jetzt, quelle: 'runner' };
    }
    return bild;
  }

  /** Schnittstelle des Zusammenbaus: das Weltbild als Objekt. */
  welt() {
    return this.bild();
  }

  /** Der Weltblock für den nächsten prompt; leer, wenn das Weltmodell aus ist. */
  weltblock(grenze = this.blockMax) {
    if (!this.aktiv) return '';
    const bild = this.bild();
    return weltblock(bild, bild.t, grenze);
  }

  /** Das Bild ohne die Werte der Quellen mit `aufzeichnen: false` (Zustand und Alter bleiben). */
  fuerAufzeichnung(bild) {
    const quellen = {};
    for (const [name, q] of Object.entries(bild?.quellen ?? {})) {
      const k = this._konf.get(name);
      quellen[name] = k && !k.aufzeichnen && istObjekt(q) ? { ...q, wert: null, ausgelassen: true } : q;
    }
    return { ...bild, quellen };
  }

  /**
   * Der Weltblock eines Zugs ohne die Zeilen der Quellen mit `aufzeichnen: false` (Raum-Belegung):
   * pi bekommt sie, die Aufzeichnung nicht (Besitzer 19.10.2026, keine Vorratsdaten).
   */
  blockFuerAufzeichnung(block) {
    const verborgen = [...this._konf].filter(([, k]) => !k.aufzeichnen).map(([n]) => n);
    if (!verborgen.length || !block) return block;
    return block
      .split('\n')
      .filter((z) => !verborgen.some((n) => z.startsWith(`${n} (`) || z.startsWith(`${n}:`)))
      .join('\n');
  }

  #schreiben(bild) {
    try {
      mkdirSync(dirname(this.datei), { recursive: true });
      const tmp = `${this.datei}.tmp`;
      writeFileSync(tmp, JSON.stringify(bild, null, 1), 'utf8');
      renameSync(tmp, this.datei);
    } catch (fehler) {
      this.log(`[fyos-welt] welt.json nicht geschrieben: ${fehler?.message ?? fehler}`);
    }
  }

  start() {
    if (!this.aktiv || this._laeuft) return;
    this._laeuft = true;
    const schritt = async () => {
      if (!this._laeuft) return;
      try {
        await this.schlagen();
      } catch (fehler) {
        this.log(`[fyos-welt] Herzschlag gescheitert: ${fehler?.message ?? fehler}`);
      }
      if (!this._laeuft) return;
      this._timer = setTimeout(schritt, this.herzschlag_s * 1000);
      this._timer.unref?.();
    };
    void schritt();
  }

  stop() {
    this._laeuft = false;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  /** Kleines Objekt für /zustand. */
  zustand() {
    const quellen = [...this._stand.values()];
    return {
      an: this.aktiv,
      herzschlaege: this.herzschlaege,
      datei: this.datei,
      quellen_ok: quellen.filter((q) => q.ok).length,
      quellen: quellen.length,
    };
  }
}
