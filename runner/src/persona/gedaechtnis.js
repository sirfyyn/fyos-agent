/**
 * persona/gedaechtnis.js — Ginnys Gedächtnis (Plan S5) und Pflegeliste (S7).
 *
 * Entwurf: docs/current/PERSONA-GEDAECHTNIS.md. Kurz:
 *   - Wahrheit sind Dateien unter `<ordner>` (Vorgabe /var/lib/fyos-agent/gedaechtnis):
 *       fakten/<id>.json            ein Fakt oder eine Lektion
 *       episoden/<JJJJ-MM-TT>/<gespräch>.json   Tagesprotokoll je Gespräch (schreibt persona/gedaechtnis-protokoll.js)
 *       pflege.json                 Pflegeliste
 *       index-stand.json            was im Qdrant-Index steht (Hash je Eintrag)
 *   - Qdrant (`persona_gedaechtnis`) ist nur der Index (Hybrid-Suche). Ist er nicht erreichbar, melden die Werkzeuge es ehrlich
 *     und suchen in den Dateien; geschrieben wird trotzdem, der Abgleich holt den Index später nach.
 *   - Veraltetes wird abgelöst (Markierung mit Grund), nie gelöscht.
 *   - Der Abruf-Zähler folgt der SECO-Regel: ab 3 Abrufen aus 3 verschiedenen Fragen ist ein Fakt „übernahmereif“. Das ist ein
 *     Hinweis (und ein abgeleiteter Pflegepunkt), keine Automatik: die Reife ändert nur ein Mensch (`max_bestaetigt`).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Schema as Type, werkzeug as defineTool, abschnitt as section } from '../lauf/index.js';
import { GedaechtnisIndex } from './gedaechtnis-index.js';
import { LEX_VERSION, aehnlichkeit, inhaltsHash, normalisiert, zerlege } from './gedaechtnis-lex.js';
import { schwaerzen } from './redaktion.js';

const text = (t, details) => ({ output: [{ type: 'text', text: t }], ...(details !== undefined ? { details } : {}) });
const ARTEN = ['fakt', 'lektion'];
const REIFEN = ['einsicht', 'feldnotiz'];
const ANTRIEBE = ['zeit', 'weltblick', 'antrieb', 'max'];
const AEHNLICH = 0.7;
const UEBERNAHME_ABRUFE = 3;
const FRAGEN_MAX = 20;
const KENNUNG = /^[A-Za-z0-9_-]{1,80}$/;
const iso = (ms) => new Date(ms).toISOString();
const kurz = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const tagVon = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function lesenJson(pfad, vorgabe) {
  try {
    return JSON.parse(readFileSync(pfad, 'utf8'));
  } catch {
    return vorgabe;
  }
}

function schreibenJson(pfad, wert) {
  mkdirSync(join(pfad, '..'), { recursive: true });
  const tmp = `${pfad}.neu`;
  writeFileSync(tmp, `${JSON.stringify(wert, null, 2)}\n`, { mode: 0o640 });
  renameSync(tmp, pfad);
}

/** Wie weit ist ein Fakt auf dem Weg zur Übernahme? (SECO-Regel: 3 Abrufe aus 3 Fragen) */
export const uebernahmereif = (f) => f.reife !== 'einsicht' && !f.abgeloest && (f.fragen?.length ?? 0) >= UEBERNAHME_ABRUFE;

export class Gedaechtnis {
  /**
   * @param {{ cfg: object, env?: object, fetch?: Function, jetzt?: () => number, log?: Function, index?: object|null }} o
   *   `index` ersetzt den Qdrant-Index (Tests); `null` = ohne Index.
   */
  constructor({ cfg, env = process.env, fetch: holen, jetzt = () => Date.now(), log = (z) => console.log(z), index } = {}) {
    const g = cfg?.pi_durable?.gedaechtnis ?? {};
    this.an = g.an === true;
    this.agent = String(cfg?.agent || 'persona');
    this.ordner = String(env.FYOS_GEDAECHTNIS_DIR || g.ordner || '/var/lib/fyos-agent/gedaechtnis');
    this.deckel = { fakten: 1000, text_zeichen: 600, treffer: 10, prompt_zeilen: 12, prompt_zeichen: 3000, pflege: 200, ...(g.deckel ?? {}) };
    this.jetzt = jetzt;
    this.log = log;
    this.index =
      index !== undefined
        ? index
        : this.an
          ? new GedaechtnisIndex({ url: g.qdrant_url, collection: g.collection, embedUrl: g.embed_url, anlegen: g.anlegen !== false, ...(holen ? { fetch: holen } : {}) })
          : null;
    this.qdrantOk = null; // null = noch nie versucht
    this.fehler = null;
    this.letzteAufnahme = null;
    this._cache = null;
    this._timer = null;
    this._abgleichLaeuft = false;
  }

  // ---- Ablage ------------------------------------------------------------------------------------------

  #fakten() {
    return join(this.ordner, 'fakten');
  }
  #episoden() {
    return join(this.ordner, 'episoden');
  }

  /** Alle Fakten und Lektionen dieses Agenten (auch abgelöste); ein Cache hängt am Ordnerstand. */
  alleFakten() {
    const dir = this.#fakten();
    let stand = '';
    try {
      stand = `${statSync(dir).mtimeMs}:${readdirSync(dir).length}`;
    } catch {
      return [];
    }
    if (this._cache?.stand === stand) return this._cache.liste;
    const liste = [];
    for (const n of readdirSync(dir)) {
      if (!n.endsWith('.json')) continue;
      const f = lesenJson(join(dir, n), null);
      if (f?.id && f.agent === this.agent && typeof f.text === 'string') liste.push(f);
    }
    this._cache = { stand, liste };
    return liste;
  }

  fakt(id) {
    if (!KENNUNG.test(String(id ?? ''))) return null;
    const f = lesenJson(join(this.#fakten(), `${id}.json`), null);
    return f?.agent === this.agent ? f : null;
  }

  #speichern(f) {
    schreibenJson(join(this.#fakten(), `${f.id}.json`), f);
    this._cache = null;
    this.letzteAufnahme = iso(this.jetzt());
  }

  alleEpisoden(max = 400) {
    const liste = [];
    let tage = [];
    try {
      tage = readdirSync(this.#episoden()).sort().reverse();
    } catch {
      return liste;
    }
    for (const tag of tage) {
      for (const n of readdirSync(join(this.#episoden(), tag))) {
        if (!n.endsWith('.json')) continue;
        const e = lesenJson(join(this.#episoden(), tag, n), null);
        if (e?.id && e.agent === this.agent) liste.push(e);
        if (liste.length >= max) return liste;
      }
    }
    return liste;
  }

  /** Datensatz für Index und Dateisuche: einheitliche Form für Fakt, Lektion und Episode. */
  #eintrag(r) {
    const episode = r.art === 'episode';
    return {
      agent: this.agent,
      kennung: r.id,
      titel: episode ? `Episode ${r.tag}` : r.art === 'lektion' ? 'Lektion' : 'Fakt',
      text: r.text,
      nutzlast: {
        art: r.art,
        reife: r.reife ?? 'feldnotiz',
        quelle: episode ? (r.quellen ?? []).slice(0, 5).join(',') || 'aufzeichnung' : r.quelle,
        zeit: episode ? r.aktualisiert : r.letzte_bestaetigung,
        tag: episode ? r.tag : tagVon(Date.parse(r.erste_nennung) || this.jetzt()),
        abgeloest: Boolean(r.abgeloest),
      },
    };
  }

  #stand(r) {
    return createHash('sha1').update(`${LEX_VERSION}|${r.text}|${r.reife ?? ''}|${r.abgeloest ? 1 : 0}|${r.letzte_bestaetigung ?? r.aktualisiert ?? ''}`).digest('hex').slice(0, 16);
  }

  // ---- Index-Abgleich ----------------------------------------------------------------------------------

  /** Wie viele Einträge fehlen im Index oder stehen dort veraltet? */
  indexOffen() {
    const st = lesenJson(join(this.ordner, 'index-stand.json'), {});
    return [...this.alleFakten(), ...this.alleEpisoden()].filter((r) => st[r.id] !== this.#stand(r)).length;
  }

  /** Bringt höchstens `max` fehlende Einträge in den Index. Wirft nichts; Ergebnis {gesendet, offen, fehler}. */
  async abgleichen(max = 20) {
    if (!this.index || this._abgleichLaeuft) return { gesendet: 0, offen: this.index ? this.indexOffen() : 0, fehler: null };
    this._abgleichLaeuft = true;
    try {
      const pfad = join(this.ordner, 'index-stand.json');
      const st = lesenJson(pfad, {});
      const offen = [...this.alleFakten(), ...this.alleEpisoden()].filter((r) => st[r.id] !== this.#stand(r)).slice(0, max);
      if (offen.length) {
        await this.index.einsortieren(offen.map((r) => this.#eintrag(r)));
        for (const r of offen) st[r.id] = this.#stand(r);
        schreibenJson(pfad, st);
      } else {
        await this.index.anpingen();
      }
      this.qdrantOk = true;
      this.fehler = null;
      return { gesendet: offen.length, offen: this.indexOffen(), fehler: null };
    } catch (f) {
      this.qdrantOk = false;
      this.fehler = kurz(f?.message ?? f, 200);
      return { gesendet: 0, offen: this.indexOffen(), fehler: this.fehler };
    } finally {
      this._abgleichLaeuft = false;
    }
  }

  /** Hintergrund: alle 60 s Index anpingen und Rückstand abarbeiten. */
  start({ takt_s = 60 } = {}) {
    if (!this.an || !this.index || this._timer) return;
    const lauf = () => void this.abgleichen().catch(() => {});
    lauf();
    this._timer = setInterval(lauf, takt_s * 1000);
    this._timer.unref?.();
  }
  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  // ---- Fakten ------------------------------------------------------------------------------------------

  /**
   * Merkt einen Fakt oder eine Lektion. Dublettenprüfung: derselbe Text (normalisiert) bestätigt den vorhandenen Eintrag;
   * ein sehr ähnlicher (Jaccard ≥ 0,7) schreibt nichts und nennt ihn, außer `trotzdem`.
   */
  async merken({ text: roh, quelle, art = 'fakt', reife, max_bestaetigt = false, trotzdem = false } = {}) {
    if (!ARTEN.includes(art)) return { ok: false, grund: `art muss ${ARTEN.join(' oder ')} sein` };
    const t = String(roh ?? '').trim();
    const q = String(quelle ?? '').trim();
    if (t.length < 8) return { ok: false, grund: 'Text zu kurz (mindestens 8 Zeichen).' };
    if (t.length > this.deckel.text_zeichen) return { ok: false, grund: `Text zu lang (${t.length} Zeichen, erlaubt ${this.deckel.text_zeichen}). Kürzer fassen.` };
    if (!q) return { ok: false, grund: 'Ohne Quelle wird nichts gemerkt (Eintrags-ID, Pfad, Link oder „Besitzer, <Datum>“).' };
    if (schwaerzen(t) !== t || schwaerzen(q) !== q) return { ok: false, grund: 'Der Text enthält etwas, das wie ein Zugangsdatum aussieht (oder <private>). Ohne Geheimnis neu fassen.' };
    let wunsch = REIFEN.includes(reife) ? reife : 'feldnotiz';
    let hinweis = null;
    if (wunsch === 'einsicht' && !max_bestaetigt) {
      wunsch = 'feldnotiz';
      hinweis = 'Reife bleibt feldnotiz: einsicht gilt nur mit Besitzer\' ausdrücklicher Bestätigung (max_bestaetigt).';
    }
    const jetzt = iso(this.jetzt());
    const id = `${art === 'lektion' ? 'l' : 'f'}-${inhaltsHash(t).slice(0, 10)}`;
    const da = this.fakt(id);
    if (da) {
      const neu = { ...da, letzte_bestaetigung: jetzt };
      if (q !== da.quelle && !(da.weitere_quellen ?? []).includes(q)) neu.weitere_quellen = [...(da.weitere_quellen ?? []), q].slice(-10);
      if (wunsch === 'einsicht' && da.reife !== 'einsicht') neu.reife = 'einsicht';
      if (da.abgeloest) neu.abgeloest = null; // dieselbe Aussage wird neu bestätigt: wieder gültig, die alte Ablösung bleibt im Verlauf
      if (da.abgeloest) neu.verlauf = [...(da.verlauf ?? []), { zeit: jetzt, ereignis: 'wieder bestätigt', quelle: q }].slice(-20);
      this.#speichern(neu);
      const ab = await this.abgleichen(5);
      return { ok: true, id, neu: false, dublette: true, reife: neu.reife, hinweis, index: ab.fehler ? 'offen' : 'ok', fehler: ab.fehler };
    }
    const aktiv = this.alleFakten().filter((f) => !f.abgeloest);
    if (!trotzdem) {
      for (const f of aktiv) {
        if (f.art !== art) continue;
        const s = aehnlichkeit(t, f.text);
        if (s >= AEHNLICH) return { ok: false, aehnlich: f.id, aehnlichkeit: Math.round(s * 100) / 100, grund: `Sehr ähnlich zu ${f.id}: „${kurz(f.text, 140)}“. Bestätige ihn mit demselben Text, löse ihn mit gedaechtnis_abloesen(durch) ab, oder lege mit trotzdem=true neu an.` };
      }
    }
    if (aktiv.length >= this.deckel.fakten) return { ok: false, grund: `Deckel erreicht (${this.deckel.fakten} aktive Einträge). Löse Veraltetes mit gedaechtnis_abloesen ab.` };
    const f = { id, art, agent: this.agent, text: t, quelle: q, weitere_quellen: [], reife: wunsch, erste_nennung: jetzt, letzte_bestaetigung: jetzt, abrufe: 0, fragen: [], abgeloest: null, verlauf: [] };
    this.#speichern(f);
    const ab = await this.abgleichen(5);
    return { ok: true, id, neu: true, dublette: false, reife: wunsch, hinweis, index: ab.fehler ? 'offen' : 'ok', fehler: ab.fehler };
  }

  /** Markiert einen Eintrag als abgelöst (veraltet oder widerlegt). Nie löschen. Wiederholen ist harmlos. */
  async abloesen({ id, grund, durch } = {}) {
    const f = this.fakt(id);
    if (!f) return { ok: false, grund: `Unbekannte Kennung ${id}.` };
    const g = String(grund ?? '').trim();
    if (!g) return { ok: false, grund: 'Ohne Grund wird nichts abgelöst (veraltet, widerlegt, ersetzt durch …).' };
    if (schwaerzen(g) !== g) return { ok: false, grund: 'Der Grund enthält etwas, das wie ein Zugangsdatum aussieht.' };
    if (durch && !this.fakt(durch)) return { ok: false, grund: `„durch“ nennt eine unbekannte Kennung ${durch}.` };
    if (f.abgeloest) return { ok: true, id, schon: true, abgeloest: f.abgeloest };
    const jetzt = iso(this.jetzt());
    const neu = { ...f, abgeloest: { zeit: jetzt, grund: g, ...(durch ? { durch } : {}) }, verlauf: [...(f.verlauf ?? []), { zeit: jetzt, ereignis: 'abgelöst', grund: g }].slice(-20) };
    this.#speichern(neu);
    const ab = await this.abgleichen(5);
    return { ok: true, id, schon: false, abgeloest: neu.abgeloest, index: ab.fehler ? 'offen' : 'ok', fehler: ab.fehler };
  }

  // ---- Suche -------------------------------------------------------------------------------------------

  #lokal(frage, { arten, von, bis, abgeloeste, anzahl }) {
    const q = [...new Set(zerlege(frage))];
    const eintraege = [];
    if (arten.some((a) => a !== 'episode')) {
      for (const f of this.alleFakten()) if (arten.includes(f.art) && (abgeloeste || !f.abgeloest)) eintraege.push({ r: f, zeit: f.letzte_bestaetigung });
    }
    if (arten.includes('episode')) for (const e of this.alleEpisoden()) eintraege.push({ r: e, zeit: e.aktualisiert });
    const gefiltert = eintraege.filter((x) => (!von || x.zeit >= von) && (!bis || x.zeit <= bis));
    const docs = gefiltert.map((x) => ({ ...x, tokens: new Set(zerlege(x.r.text)) }));
    const n = docs.length || 1;
    const df = new Map(q.map((w) => [w, docs.filter((d) => d.tokens.has(w)).length]));
    return docs
      .map((d) => ({ r: d.r, score: q.reduce((s, w) => (d.tokens.has(w) ? s + Math.log(1 + (n - df.get(w) + 0.5) / (df.get(w) + 0.5)) : s), 0) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || String(a.r.id).localeCompare(String(b.r.id)))
      .slice(0, anzahl);
  }

  /**
   * Sucht im Index (Hybrid), sonst in den Dateien. Zählt für Fakten und Lektionen den Abruf (je verschiedene Frage einmal).
   * Ergebnis: {quelle: 'index'|'dateien', fehler, treffer: [{...Eintrag, score}]}
   */
  async suchen({ frage, art, von, bis, anzahl, abgeloeste = false } = {}) {
    const f = String(frage ?? '').trim();
    if (!f) return { ok: false, grund: 'Ohne Anfrage keine Suche.' };
    const arten = art && art !== 'alle' ? [art] : ['fakt', 'lektion', 'episode'];
    const n = Math.max(1, Math.min(this.deckel.treffer, Number(anzahl) > 0 ? Math.trunc(Number(anzahl)) : 5));
    const opt = { arten, von, bis, abgeloeste, anzahl: n };
    let rohe = null;
    let quelle = 'index';
    let fehler = null;
    if (this.index) {
      try {
        const t = await this.index.suchen(this.agent, { frage: f, art: arten, von, bis, anzahl: n, abgeloeste });
        this.qdrantOk = true;
        this.fehler = null;
        rohe = t.map((x) => ({ id: x.kennung, score: x.score, nutz: x }));
      } catch (e) {
        this.qdrantOk = false;
        fehler = kurz(e?.message ?? e, 200);
        this.fehler = fehler;
      }
    } else if (this.an) {
      fehler = 'Kein Index konfiguriert.';
    }
    let treffer;
    if (rohe) {
      // Die Dateien sind Wahrheit: Treffer, die es dort nicht (mehr) gibt, fallen weg; Text und Markierungen kommen aus der Datei.
      const episoden = new Map(this.alleEpisoden().map((e) => [e.id, e]));
      treffer = rohe
        .map((x) => ({ r: this.fakt(x.id) ?? episoden.get(x.id), score: x.score }))
        .filter((x) => x.r && (abgeloeste || !x.r.abgeloest));
    } else {
      quelle = 'dateien';
      treffer = this.#lokal(f, opt);
    }
    const frageHash = createHash('sha1').update(normalisiert(f)).digest('hex').slice(0, 12);
    for (const x of treffer) {
      if (x.r.art === 'episode') continue;
      if (x.r.fragen?.includes(frageHash)) continue;
      const neu = { ...x.r, abrufe: (x.r.abrufe ?? 0) + 1, fragen: [...(x.r.fragen ?? []), frageHash].slice(-FRAGEN_MAX) };
      try {
        this.#speichern(neu);
        x.r = neu;
      } catch {
        /* Zähler nicht gespeichert: die Suche zählt trotzdem */
      }
    }
    return { ok: true, quelle, fehler, treffer: treffer.map((x) => ({ ...x.r, score: x.score })) };
  }

  // ---- Prompt und Zustand ------------------------------------------------------------------------------

  /** Der Index der wichtigsten Fakten für den Zugkopf: begrenzt, ohne flüchtige Zähler (damit der Cache hält). */
  indexText() {
    const aktiv = this.alleFakten().filter((f) => !f.abgeloest);
    const rang = (f) => (f.reife === 'einsicht' ? 0 : 1) * 2 + (f.art === 'lektion' ? 0 : 1);
    aktiv.sort((a, b) => rang(a) - rang(b) || String(b.letzte_bestaetigung).localeCompare(String(a.letzte_bestaetigung)) || a.id.localeCompare(b.id));
    const zeilen = [];
    let zeichen = 0;
    for (const f of aktiv) {
      if (zeilen.length >= this.deckel.prompt_zeilen) break;
      const z = `- ${f.id} [${f.reife}${f.art === 'lektion' ? ', Lektion' : ''}] ${kurz(f.text.replace(/\s+/g, ' '), 150)} (${kurz(f.quelle, 40)})`;
      if (zeichen + z.length > this.deckel.prompt_zeichen) break;
      zeilen.push(z);
      zeichen += z.length + 1;
    }
    const rest = aktiv.length - zeilen.length;
    return [
      'Dein Gedächtnis (Fakten und Lektionen mit Quelle; überlebt jedes Gespräch). einsicht gilt, feldnotiz ist nur ein Hinweis.',
      'Suche mit gedaechtnis_suchen, bevor du aus dem Kopf antwortest; merke mit gedaechtnis_merken (nur mit Quelle, keine Geheimnisse);',
      'Veraltetes oder Widerlegtes mit gedaechtnis_abloesen markieren, nie stillschweigend übergehen.',
      zeilen.length ? zeilen.join('\n') : '(noch leer)',
      ...(rest > 0 ? [`… und ${rest} weitere; gedaechtnis_suchen findet sie.`] : []),
    ].join('\n');
  }

  zustand() {
    if (!this.an) return { an: false, fakten: 0, letzte_aufnahme: null, qdrant_ok: null };
    const alle = this.alleFakten();
    return {
      an: true,
      fakten: alle.filter((f) => !f.abgeloest).length,
      abgeloest: alle.filter((f) => f.abgeloest).length,
      episoden: this.alleEpisoden(1000).length,
      pflege_faellig: this.pflegePunkte().length,
      letzte_aufnahme: this.letzteAufnahme,
      qdrant_ok: this.qdrantOk,
      index_offen: this.index ? this.indexOffen() : null,
      fehler: this.fehler,
    };
  }

  // ---- Episoden (vom Tagesprotokoll geschrieben) --------------------------------------------------------

  /** Legt eine Episode ab oder ersetzt die desselben Tags und Gesprächs. Redaktion und Kürzung hier, nicht beim Aufrufer. */
  async episodeSchreiben({ tag, gespraech, text: roh, zaehler = {}, quellen = [] }) {
    if (!this.an) return null;
    const g = String(gespraech ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'unbekannt';
    const t = String(tag ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
    const pfad = join(this.#episoden(), t, `${g}.json`);
    const alt = lesenJson(pfad, null);
    const jetzt = iso(this.jetzt());
    const e = {
      id: `e-${t}-${g}`,
      art: 'episode',
      agent: this.agent,
      tag: t,
      gespraech: g,
      text: kurz(schwaerzen(String(roh ?? '')), 1500),
      zaehler,
      quellen: quellen.map((q) => schwaerzen(String(q))).slice(0, 30),
      erste_nennung: alt?.erste_nennung ?? jetzt,
      aktualisiert: jetzt,
    };
    schreibenJson(pfad, e);
    this.letzteAufnahme = jetzt;
    await this.abgleichen(5);
    return e.id;
  }

  // ---- Pflegeliste (S7) ---------------------------------------------------------------------------------

  #pflege() {
    return lesenJson(join(this.ordner, 'pflege.json'), { punkte: [] });
  }
  #pflegeSpeichern(d) {
    schreibenJson(join(this.ordner, 'pflege.json'), d);
    this.letzteAufnahme = iso(this.jetzt());
  }

  /** Neuer Pflegepunkt. Gleicher Titel und Antrieb, noch offen: derselbe Punkt (wiederholbar). */
  pflegeEintragen({ titel, antrieb = 'zeit', faellig, takt_s, zweck, quelle } = {}) {
    const ti = String(titel ?? '').trim();
    if (ti.length < 4 || ti.length > 200) return { ok: false, grund: 'Titel: 4 bis 200 Zeichen.' };
    if (!ANTRIEBE.includes(antrieb)) return { ok: false, grund: `antrieb muss ${ANTRIEBE.join(', ')} sein.` };
    if (schwaerzen(ti) !== ti || schwaerzen(String(zweck ?? '')) !== String(zweck ?? '')) return { ok: false, grund: 'Enthält etwas, das wie ein Zugangsdatum aussieht.' };
    let f = null;
    if (faellig !== undefined && faellig !== null && faellig !== '') {
      f = Date.parse(faellig);
      if (!Number.isFinite(f)) return { ok: false, grund: 'faellig ist kein Zeitpunkt (ISO 8601).' };
    }
    const takt = Number(takt_s) > 0 ? Math.trunc(Number(takt_s)) : null;
    if (takt !== null && takt < 60) return { ok: false, grund: 'takt_s mindestens 60.' };
    const d = this.#pflege();
    const id = `p-${createHash('sha1').update(`${antrieb}|${normalisiert(ti)}`).digest('hex').slice(0, 10)}`;
    const da = d.punkte.find((p) => p.id === id && p.status === 'offen');
    if (da) return { ok: true, id, neu: false };
    if (d.punkte.filter((p) => p.status === 'offen').length >= this.deckel.pflege) return { ok: false, grund: `Pflegeliste voll (${this.deckel.pflege} offene Punkte).` };
    const jetzt = this.jetzt();
    const rest = d.punkte.filter((p) => p.id !== id);
    rest.push({ id, titel: ti, antrieb, zweck: kurz(String(zweck ?? ''), 300), quelle: kurz(String(quelle ?? ''), 120), takt_s: takt, faellig: f === null ? null : iso(f), status: 'offen', angelegt: iso(jetzt), zuletzt_erledigt: null, ergebnis: null });
    this.#pflegeSpeichern({ punkte: rest });
    return { ok: true, id, neu: true };
  }

  /** Erledigt einen Punkt; mit `takt_s` rückt er zum nächsten Termin, sonst bleibt er als erledigt stehen (Verlauf). */
  pflegeErledigen({ id, ergebnis } = {}) {
    const d = this.#pflege();
    const p = d.punkte.find((x) => x.id === id);
    if (!p) return { ok: false, grund: `Unbekannter Pflegepunkt ${id}.` };
    const e = schwaerzen(kurz(String(ergebnis ?? ''), 300));
    const jetzt = this.jetzt();
    p.zuletzt_erledigt = iso(jetzt);
    p.ergebnis = e;
    if (p.takt_s) p.faellig = iso(Math.max(jetzt, Date.parse(p.faellig ?? '') || 0) + p.takt_s * 1000);
    else p.status = 'erledigt';
    this.#pflegeSpeichern(d);
    return { ok: true, id, wiederkehrend: Boolean(p.takt_s), naechste: p.takt_s ? p.faellig : null };
  }

  pflegeVerschieben({ id, bis } = {}) {
    const d = this.#pflege();
    const p = d.punkte.find((x) => x.id === id);
    const t = Date.parse(bis);
    if (!p || p.status !== 'offen') return { ok: false, grund: `Kein offener Pflegepunkt ${id}.` };
    if (!Number.isFinite(t)) return { ok: false, grund: 'bis ist kein Zeitpunkt (ISO 8601).' };
    p.faellig = iso(t);
    this.#pflegeSpeichern(d);
    return { ok: true, id, faellig: p.faellig };
  }

  /** Alle Punkte der Liste (offen zuerst, nach Fälligkeit). */
  pflegeAlle() {
    const rang = (p) => (p.status === 'offen' ? 0 : 1);
    return [...this.#pflege().punkte].sort((a, b) => rang(a) - rang(b) || String(a.faellig ?? '').localeCompare(String(b.faellig ?? '')) || a.id.localeCompare(b.id));
  }

  /**
   * Fällige Pflegepunkte: der zusätzliche Eingang der Arbeitsschleife (S7/S8). Die Schleife entscheidet selbst, ob sie einen
   * Zug daraus macht; diese Funktion ändert nichts. Fällig = offen und (kein Termin oder Termin erreicht). Dazu abgeleitete
   * Punkte „Übernahme prüfen“ für Fakten mit 3 Abrufen aus 3 Fragen (SECO-Regel; nur Hinweis, nichts wird übernommen).
   * @param {{ jetzt?: number, antrieb?: string }} [o]
   * @returns {{id: string, titel: string, antrieb: string, zweck: string, faellig: string|null, ueber_s: number, abgeleitet?: boolean}[]}
   */
  pflegePunkte({ jetzt = this.jetzt(), antrieb } = {}) {
    const fertig = this.#pflege()
      .punkte.filter((p) => p.status === 'offen' && (!p.faellig || Date.parse(p.faellig) <= jetzt) && (!antrieb || p.antrieb === antrieb))
      .map((p) => ({ id: p.id, titel: p.titel, antrieb: p.antrieb, zweck: p.zweck, faellig: p.faellig, ueber_s: p.faellig ? Math.round((jetzt - Date.parse(p.faellig)) / 1000) : 0 }));
    const abgeleitet =
      antrieb && antrieb !== 'antrieb'
        ? []
        : this.alleFakten()
            .filter(uebernahmereif)
            .map((f) => ({ id: `uebernahme-${f.id}`, titel: `Übernahme prüfen: ${f.id} (${f.fragen.length} Abrufe aus ${f.fragen.length} Fragen)`, antrieb: 'antrieb', zweck: kurz(f.text, 160), faellig: null, ueber_s: 0, abgeleitet: true }));
    return [...fertig.sort((a, b) => b.ueber_s - a.ueber_s || a.id.localeCompare(b.id)), ...abgeleitet];
  }
}

// ---- Erweiterung: Abschnitt und Werkzeuge ---------------------------------------------------------------

const zeile = (f) => {
  const rest = [];
  if (f.abgeloest) rest.push(`ABGELÖST ${f.abgeloest.zeit.slice(0, 10)}: ${f.abgeloest.grund}${f.abgeloest.durch ? ` → ${f.abgeloest.durch}` : ''}`);
  if (f.art === 'episode') return `[${f.id} · Episode ${f.tag}] ${f.text}`;
  rest.push(`Quelle: ${f.quelle}`);
  rest.push(`erste Nennung ${f.erste_nennung.slice(0, 10)}, bestätigt ${f.letzte_bestaetigung.slice(0, 10)}`);
  rest.push(`Abrufe ${f.abrufe ?? 0}`);
  if (uebernahmereif(f)) rest.push('ÜBERNAHMEREIF (3 Abrufe aus 3 Fragen): nur Hinweis, Besitzer entscheidet');
  return `[${f.id} · ${f.art} · ${f.reife}] ${f.text}\n   ${rest.join(' · ')}`;
};

/** Abschnitt „gedaechtnis“ für den Zugkopf; ohne eingeschaltetes Gedächtnis kein Abschnitt. */
export function gedaechtnisSektionen(g) {
  if (!g?.an) return [];
  return [section('gedaechtnis', () => g.indexText())];
}

export function gedaechtnisWerkzeuge(g) {
  if (!g?.an) return [];
  const suchen = defineTool({
    name: 'gedaechtnis_suchen',
    description:
      'Sucht in deinem Gedächtnis (Fakten, Lektionen, Tagesprotokolle) nach Sinn und Wort zugleich. Nimm es, bevor du aus dem Kopf ' +
      'antwortest oder Besitzer etwas zum zweiten Mal fragst. art: fakt, lektion, episode oder alle. von/bis: ISO-Datum. Abgelöste Einträge ' +
      'nur mit abgeloeste=true. Ist der Index nicht erreichbar, steht es im Ergebnis, und es wird in den Dateien gesucht.',
    parameters: Type.Object({
      anfrage: Type.String({ minLength: 2, maxLength: 400 }),
      art: Type.Optional(Type.Union(['fakt', 'lektion', 'episode', 'alle'].map((w) => Type.Literal(w)))),
      von: Type.Optional(Type.String({ description: 'ISO-Datum, z. B. 2026-10-20' })),
      bis: Type.Optional(Type.String({ description: 'ISO-Datum' })),
      anzahl: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
      abgeloeste: Type.Optional(Type.Boolean()),
    }),
    // Der Abruf-Zähler zählt je Frage einmal: ein Wiederholen ändert nichts.
    replay: 'safe',
    execute: async (p) => {
      const r = await g.suchen({ frage: p?.anfrage, art: p?.art, von: p?.von, bis: p?.bis, anzahl: p?.anzahl, abgeloeste: p?.abgeloeste });
      if (!r.ok) return text(r.grund);
      const kopf = r.quelle === 'index' ? 'Quelle: Index (Hybrid-Suche).' : `ACHTUNG: Index nicht erreichbar${r.fehler ? ` (${r.fehler})` : ''}; durchsucht wurden nur die Dateien (Wortsuche, kein Sinn).`;
      if (!r.treffer.length) return text(`${kopf}\nNichts gefunden. Das heißt: nicht gemerkt, nicht: nicht wahr.`, { quelle: r.quelle, anzahl: 0 });
      return text(`${kopf}\n${r.treffer.map(zeile).join('\n')}`, { quelle: r.quelle, anzahl: r.treffer.length, fehler: r.fehler });
    },
  });

  const merken = defineTool({
    name: 'gedaechtnis_merken',
    description:
      'Merkt einen Fakt oder eine Lektion dauerhaft. Pflicht: Quelle (Eintrags-ID, Pfad, Link oder „Besitzer, <Datum>“). Keine Geheimnisse. ' +
      'Derselbe Text bestätigt den vorhandenen Eintrag; ein sehr ähnlicher wird nicht doppelt angelegt (dann ablösen oder trotzdem=true). ' +
      'reife=einsicht nur mit max_bestaetigt=true (Besitzer hat es ausdrücklich bestätigt); sonst feldnotiz. Lektion = Besitzer\' Korrektur.',
    parameters: Type.Object({
      text: Type.String({ minLength: 8, maxLength: 1000 }),
      quelle: Type.String({ minLength: 2, maxLength: 200 }),
      art: Type.Optional(Type.Union(ARTEN.map((w) => Type.Literal(w)))),
      reife: Type.Optional(Type.Union(REIFEN.map((w) => Type.Literal(w)))),
      max_bestaetigt: Type.Optional(Type.Boolean()),
      trotzdem: Type.Optional(Type.Boolean()),
    }),
    // Die Kennung hängt am Text: Wiederholen bestätigt denselben Eintrag.
    replay: 'safe',
    execute: async (p) => {
      const r = await g.merken(p ?? {});
      if (!r.ok) return text(`Nicht gemerkt. ${r.grund}`, r);
      const stand = r.index === 'ok' ? 'im Index' : `nur in der Datei (Index offen: ${r.fehler})`;
      return text(`${r.dublette ? 'Bestätigt (gab es schon)' : 'Gemerkt'}: ${r.id} [${r.reife}], ${stand}.${r.hinweis ? ` ${r.hinweis}` : ''}`, r);
    },
  });

  const abloesen = defineTool({
    name: 'gedaechtnis_abloesen',
    description:
      'Löst einen veralteten oder widerlegten Eintrag ab (Markierung mit Grund; die Datei bleibt, nichts wird gelöscht). ' +
      'durch = Kennung des Eintrags, der ihn ersetzt (falls es einen gibt). Abgelöste Einträge erscheinen nicht mehr in Suche und Zugkopf.',
    parameters: Type.Object({
      id: Type.String({ pattern: '^[A-Za-z0-9_-]{1,80}$' }),
      grund: Type.String({ minLength: 3, maxLength: 300 }),
      durch: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_-]{1,80}$' })),
    }),
    replay: 'safe',
    execute: async (p) => {
      const r = await g.abloesen(p ?? {});
      if (!r.ok) return text(`Nicht abgelöst. ${r.grund}`, r);
      return text(r.schon ? `${r.id} war schon abgelöst (${r.abgeloest.grund}).` : `${r.id} abgelöst. ${r.index === 'ok' ? '' : `Index offen: ${r.fehler}`}`.trim(), r);
    },
  });

  const pflege = defineTool({
    name: 'pflegeliste',
    description:
      'Deine Pflegeliste (Pflichten mit Fälligkeit und Antrieb). aktion=liste (alle, fällige zuerst), faellig (nur was jetzt dran ist, ' +
      'auch „Übernahme prüfen“-Hinweise), eintragen (titel, antrieb: zeit|weltblick|antrieb|max, faellig ISO, takt_s für Wiederkehrendes, zweck, quelle), ' +
      'erledigt (id, ergebnis), verschieben (id, bis). Nichts außerhalb der Liste erfindest du „aus eigenem Antrieb“.',
    parameters: Type.Object({
      aktion: Type.Union(['liste', 'faellig', 'eintragen', 'erledigt', 'verschieben'].map((w) => Type.Literal(w))),
      id: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_-]{1,80}$' })),
      titel: Type.Optional(Type.String({ maxLength: 200 })),
      antrieb: Type.Optional(Type.Union(ANTRIEBE.map((w) => Type.Literal(w)))),
      faellig: Type.Optional(Type.String()),
      takt_s: Type.Optional(Type.Integer({ minimum: 60 })),
      zweck: Type.Optional(Type.String({ maxLength: 300 })),
      quelle: Type.Optional(Type.String({ maxLength: 120 })),
      ergebnis: Type.Optional(Type.String({ maxLength: 300 })),
      bis: Type.Optional(Type.String()),
    }),
    replay: 'safe',
    execute: async (p) => {
      switch (p?.aktion) {
        case 'liste': {
          const l = g.pflegeAlle();
          return text(l.length ? l.map((x) => `${x.id} [${x.status}, ${x.antrieb}] ${x.titel} · fällig ${x.faellig ?? 'jetzt'}${x.takt_s ? ` · alle ${x.takt_s} s` : ''}`).join('\n') : '(Pflegeliste leer)', { anzahl: l.length });
        }
        case 'faellig': {
          const l = g.pflegePunkte();
          return text(l.length ? l.map((x) => `${x.id} [${x.antrieb}] ${x.titel}${x.ueber_s > 0 ? ` · seit ${x.ueber_s} s fällig` : ''}${x.zweck ? `\n   ${x.zweck}` : ''}`).join('\n') : 'Nichts fällig.', { anzahl: l.length });
        }
        case 'eintragen': {
          const r = g.pflegeEintragen(p);
          return text(r.ok ? `${r.neu ? 'Eingetragen' : 'Gab es schon'}: ${r.id}` : `Nicht eingetragen. ${r.grund}`, r);
        }
        case 'erledigt': {
          const r = g.pflegeErledigen(p);
          return text(r.ok ? `Erledigt: ${r.id}${r.wiederkehrend ? `; nächste Fälligkeit ${r.naechste}` : ''}` : r.grund, r);
        }
        case 'verschieben': {
          const r = g.pflegeVerschieben(p);
          return text(r.ok ? `Verschoben: ${r.id} auf ${r.faellig}` : r.grund, r);
        }
        default:
          return text('aktion muss liste, faellig, eintragen, erledigt oder verschieben sein.');
      }
    },
  });

  return [suchen, merken, abloesen, pflege];
}
