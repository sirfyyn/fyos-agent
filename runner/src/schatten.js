/**
 * schatten.js — der Schatten-Rekorder: ein Schattenmodell bearbeitet dieselbe Anfrage wie der Live-Zug, die Reaktion wird aufgezeichnet.
 *
 * Besitzer, 25.10.2026: „wozu haben wir die Schatten dann, wir müssen doch ermessen können, wie gut das funktioniert“. Jeder Schatten
 * soll Zahlen haben (Trefferquote, Falsch-Auslösung, Latenz, Fehler), bevor er live geht. Das Tor „Schatten wird aktiv“ steht in
 * `schatten-auswertung.js` (`torUrteil`) und im Bericht `scripts/ops/schatten_bericht.py`; hier läuft nur die Aufzeichnung.
 *
 * Ablauf eines Zugs:
 *   1. `beginne` (Ingress, vor der Übergabe an den Agenten) merkt Eingang, Systemkopf und Werkzeugschemata des Zugs.
 *   2. Der Ausgang meldet die Live-Aktion: erste Werkzeugwahl (`werkzeug`) und Antworttext (`text`).
 *   3. `ende` (Zugende) reiht für jeden eingeschalteten Adapter einen Schattenzug ein. Erst jetzt, nie vor und nie während des
 *      Live-Zugs; höchstens ein Schattenzug gleichzeitig, mit Frist. Beginnt ein neuer Live-Zug, bricht der laufende Schattenzug ab.
 *   4. Vor und während des Schattenzugs gelten die Sperren: Spielmodus, Ruhe (`ruhe_sperre`), Stunden-Budget, GPU-Reserve.
 *   5. Eine Zeile je Zug nach `<ordner>/<adapter>-<JJJJ-MM-TT>.jsonl` (Verweise, Hashes, Kopf ≤ 300 Zeichen redigiert, nie Volltext).
 *
 * Die Schatten-Antwort wird nie ausgeführt: aufgezeichnet wird nur der erste Werkzeugaufruf oder der Text.
 * Standard ist AUS (`pi_durable.schatten.an`, je Adapter `adapter.<name>.an`).
 */
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { schwaerzen } from './persona/redaktion.js';
import { aktion, auswerten, hash16, vergleiche, zeilenAusText } from './schatten-auswertung.js';
import { schattenKonfig } from './schatten-konfig.js';

const zweistellig = (n) => String(n).padStart(2, '0');
const tagVon = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${zweistellig(d.getMonth() + 1)}-${zweistellig(d.getDate())}`;
};
const schlafen = (ms) => new Promise((fertig) => setTimeout(fertig, ms));
/** Dieselbe Kennung wie im Ausgang (`egress.js`), damit Eingang und Ausgang denselben Zug meinen. */
export const zugKennung = (s) => String(s ?? '').replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 64);

/** Kürzen und Zugangsdaten schwärzen. `n = 0` gibt nichts zurück (nur der Hash bleibt). */
export function redigiert(text, n) {
  if (!n) return '';
  const t = schwaerzen(String(text ?? '')).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// --- Adapter -------------------------------------------------------------------------------------------------------

/** Antwortformen, die der Rekorder versteht: `{werkzeug: {name, argumente?, argumente_roh}|null, text, erstes_token_ms, gesamt_ms, tokens}` oder `{uebersprungen: grund}`. */
const OHNE_SCHLUESSEL = (text, schluessel) => (schluessel ? String(text).split(schluessel).join('[Schlüssel]') : String(text));

function werkzeugeOpenAI(werkzeuge) {
  return (werkzeuge ?? [])
    .filter((w) => w?.name)
    .map((w) => ({ type: 'function', function: { name: w.name, description: w.description ?? '', parameters: w.parameters ?? { type: 'object', properties: {} } } }));
}

/** Liest einen Server-Sent-Events-Strom einer Chat-Completions-Antwort bis zum Ende. */
async function sseLesen(koerper, jetzt) {
  const dec = new TextDecoder();
  let puffer = '';
  let text = '';
  const aufrufe = new Map();
  let erst = null;
  let nutzung = null;
  const zeile = (roh) => {
    const z = roh.trim();
    if (!z.startsWith('data:')) return;
    const daten = z.slice(5).trim();
    if (!daten || daten === '[DONE]') return;
    let d;
    try {
      d = JSON.parse(daten);
    } catch {
      return;
    }
    if (d.usage) nutzung = d.usage;
    for (const c of d.choices ?? []) {
      const dl = c.delta ?? {};
      if ((dl.content || dl.reasoning_content || dl.tool_calls?.length) && erst === null) erst = jetzt();
      text += dl.content ?? '';
      for (const t of dl.tool_calls ?? []) {
        const i = t.index ?? 0;
        const e = aufrufe.get(i) ?? { name: '', roh: '' };
        e.name += t.function?.name ?? '';
        e.roh += t.function?.arguments ?? '';
        aufrufe.set(i, e);
      }
    }
  };
  for await (const stueck of koerper) {
    puffer += dec.decode(stueck, { stream: true });
    let i;
    while ((i = puffer.indexOf('\n')) >= 0) {
      zeile(puffer.slice(0, i));
      puffer = puffer.slice(i + 1);
    }
  }
  if (puffer) zeile(puffer);
  return { text, aufrufe, erst, nutzung };
}

function ersterAufruf(aufrufe) {
  const erster = [...aufrufe.entries()].sort((a, b) => a[0] - b[0]).map((x) => x[1]).find((x) => x.name);
  if (!erster) return null;
  let argumente;
  try {
    const p = JSON.parse(erster.roh || '{}');
    if (p && typeof p === 'object' && !Array.isArray(p)) argumente = p;
  } catch {
    /* ungültiges JSON: argumente bleibt undefined */
  }
  return { name: erster.name, argumente, argumente_roh: erster.roh };
}

/**
 * OpenAI-kompatibler Chat-Completions-Aufruf (Bolt-Ersatzdenker, später Sprach-Agent). Die Werkzeugschemata des Zugs gehen mit,
 * `tool_choice: auto`; Werkzeuge werden nie ausgeführt. Der Schlüssel kommt nur aus der Datei (Pfad in der Konfiguration), wird
 * je Anfrage gelesen und taucht in keiner Meldung auf.
 */
export function openaiAdapter(name, ak, { fetchImpl = globalThis.fetch, leseDatei = (p) => readFileSync(p, 'utf8'), jetzt = () => performance.now() } = {}) {
  return {
    name,
    art: 'openai-chat',
    an: ak.an,
    budget: ak.budget_stunde,
    version: (zug) => ({ modell: ak.modell, quant: ak.quant, systemkopf: hash16(zug?.system ?? '') }),
    async anfrage(zug, { signal } = {}) {
      if (!ak.url || !ak.modell) return { uebersprungen: 'nicht-konfiguriert' };
      let schluessel = '';
      if (ak.schluessel_datei) {
        try {
          schluessel = String(leseDatei(ak.schluessel_datei)).trim();
        } catch {
          throw new Error('Schlüsseldatei nicht lesbar');
        }
      }
      const kopf = { 'Content-Type': 'application/json' };
      if (schluessel) kopf.Authorization = `Bearer ${schluessel}`;
      const werkzeuge = werkzeugeOpenAI(zug.werkzeuge);
      const body = {
        model: ak.modell,
        messages: [...(zug.system ? [{ role: 'system', content: zug.system }] : []), { role: 'user', content: zug.text }],
        ...(werkzeuge.length ? { tools: werkzeuge, tool_choice: 'auto' } : {}),
        stream: true,
        stream_options: { include_usage: true },
        temperature: ak.temperatur,
        max_tokens: ak.max_tokens,
        cache_prompt: true,
      };
      const t0 = jetzt();
      let res;
      try {
        res = await fetchImpl(`${ak.url}/v1/chat/completions`, { method: 'POST', headers: kopf, body: JSON.stringify(body), signal });
      } catch (fehler) {
        const neu = new Error(OHNE_SCHLUESSEL(fehler?.message ?? fehler, schluessel));
        neu.name = fehler?.name ?? 'Error';
        throw neu;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`); // der Rumpf bleibt ungelesen: er könnte Eingaben zurückgeben
      let text = '';
      let aufrufe = new Map();
      let erst = null;
      let nutzung = null;
      if (String(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        ({ text, aufrufe, erst, nutzung } = await sseLesen(res.body, jetzt));
      } else {
        const j = await res.json();
        erst = jetzt();
        const m = j?.choices?.[0]?.message ?? {};
        text = m.content ?? '';
        (m.tool_calls ?? []).forEach((t, i) => aufrufe.set(i, { name: t.function?.name ?? '', roh: t.function?.arguments ?? '' }));
        nutzung = j?.usage ?? null;
      }
      const ende = jetzt();
      return {
        werkzeug: ersterAufruf(aufrufe),
        text,
        erstes_token_ms: erst === null ? null : Math.round(erst - t0),
        gesamt_ms: Math.round(ende - t0),
        tokens: { ein: nutzung?.prompt_tokens ?? null, aus: nutzung?.completion_tokens ?? null },
      };
    },
  };
}

/**
 * Grundgerüst für Adapter ohne Umsetzung (`schnellweg`: persona-life läuft in einem anderen Dienst; `sprache-agent` ohne Endpunkt).
 * Mit `sender(zug, {signal}) → Antwort` wird daraus ein Adapter; ohne ihn überspringt er jeden Zug mit dem Grund „nicht-umgesetzt“.
 */
export function attrappeAdapter(name, ak, { sender = null } = {}) {
  return {
    name,
    art: 'attrappe',
    an: ak.an,
    budget: ak.budget_stunde,
    version: (zug) => ({ modell: ak.modell || name, quant: ak.quant, systemkopf: hash16(zug?.system ?? '') }),
    async anfrage(zug, optionen) {
      if (typeof sender !== 'function') return { uebersprungen: 'nicht-umgesetzt' };
      return sender(zug, optionen);
    },
  };
}

/** Adapter aus der Konfiguration; `senders: {name: fn}` setzt Umsetzungen für Attrappen (z. B. den Schnellweg), `fetchImpl` den Netzzugriff. */
export function baueAdapter(konfig, { fetchImpl, senders = {}, leseDatei } = {}) {
  const aus = [];
  for (const [name, ak] of Object.entries(konfig.adapter)) {
    if (senders[name]) aus.push(attrappeAdapter(name, ak, { sender: senders[name] }));
    else if (ak.art === 'openai-chat') aus.push(openaiAdapter(name, ak, { fetchImpl, leseDatei }));
    else aus.push(attrappeAdapter(name, ak));
  }
  return aus;
}

/** Freier GPU-Speicher in MiB über `nvidia-smi` (kleinster Wert aller betrachteten GPUs); `null`, wenn nicht ermittelbar. */
export function nvidiaFrei(gpuIndex = '') {
  return new Promise((fertig) => {
    const args = ['--query-gpu=memory.free', '--format=csv,noheader,nounits', ...(gpuIndex ? ['-i', String(gpuIndex)] : [])];
    execFile('nvidia-smi', args, { timeout: 5000 }, (fehler, aus) => {
      if (fehler) return fertig(null);
      const werte = String(aus).split('\n').map((z) => Number(z.trim())).filter((x) => Number.isFinite(x));
      fertig(werte.length ? Math.min(...werte) : null);
    });
  });
}

// --- Dateien -------------------------------------------------------------------------------------------------------

const DATEI = /^(.+)-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** Alle Zeilen der letzten `tage` Tage aus `ordner` (alle Adapter und die Wahrheiten). */
export function schattenZeilenLesen(ordner, tage, jetztMs = Date.now()) {
  let namen;
  try {
    namen = readdirSync(ordner);
  } catch {
    return [];
  }
  const ab = tagVon(jetztMs - (Math.max(1, tage) - 1) * 86_400_000);
  const zeilen = [];
  for (const n of namen.sort()) {
    const m = DATEI.exec(n);
    if (!m || m[2] < ab) continue;
    try {
      zeilen.push(...zeilenAusText(readFileSync(join(ordner, n), 'utf8')));
    } catch {
      /* Datei nicht lesbar */
    }
  }
  return zeilen;
}

// --- Der Rekorder --------------------------------------------------------------------------------------------------

export class SchattenRekorder {
  /**
   * @param konfig     `pi_durable.schatten` (wird geprüft)
   * @param adapter    fertige Adapter (`baueAdapter`); Tests reichen Attrappen
   * @param spielmodus `Spielmodus` mit `an()`
   * @param ruhe       optional `() => boolean|string`: gilt gerade Ruhe?
   * @param gpuFrei    optional `async () => MiB|null`; Vorgabe `nvidiaFrei`
   * @param beschaeftigt optional `() => boolean`: läuft gerade ein Live-Zug, den der Rekorder nicht kennt?
   */
  constructor({ konfig, adapter = [], spielmodus = null, ruhe = null, gpuFrei = null, beschaeftigt = null, log = (z) => console.log(z), jetzt = () => Date.now() } = {}) {
    this.konfig = schattenKonfig(konfig);
    this.adapter = new Map(adapter.map((a) => [a.name, a]));
    for (const a of this.adapter.values()) {
      const ak = this.konfig.adapter[a.name];
      if (ak) {
        a.an = Boolean(ak.an) && a.an !== false;
        a.budget = ak.budget_stunde;
      }
    }
    this.spielmodus = spielmodus;
    this.ruhe = ruhe;
    this.gpuFrei = gpuFrei ?? (() => nvidiaFrei(this.konfig.gpu_index));
    this.beschaeftigt = beschaeftigt;
    this.log = log;
    this._jetzt = jetzt;
    this.spuren = new Map(); // offene Live-Züge
    this.warteschlange = [];
    this.aktuell = null;
    this.laeuft = false;
    this.geschlossen = false;
    this.stunde = new Map(); // adapter → Zeitpunkte begonnener Schattenzüge
    this.zaehler = new Map(); // adapter → Zähler (ohne Inhalte)
    this.zeilen = 0;
    this.fehler = null;
    this._pfade = new Map(); // datei → {bytes, voll}
    this._an = this.konfig.an;
  }

  an() {
    return this._an;
  }

  schalten(an) {
    this._an = Boolean(an);
    this.log(`[fyos-schatten] ${this._an ? 'an' : 'aus'} (${this.konfig.ordner})`);
  }

  /** Einen Adapter ein- oder ausschalten (zur Laufzeit, z. B. im Test). */
  adapterSchalten(name, an) {
    const a = this.adapter.get(name);
    if (a) a.an = Boolean(an);
  }

  #zaehler(name) {
    if (!this.zaehler.has(name)) this.zaehler.set(name, { eingereiht: 0, ok: 0, fehler: 0, timeout: 0, uebersprungen: {}, wahrheiten: 0 });
    return this.zaehler.get(name);
  }

  // --- Live-Zug beobachten ---

  /** Zugbeginn. `zug`: `{ein, quelle, klasse, bezug, text (voller Eingabetext), eingang (Text des Eingangs), system, werkzeuge}`. */
  beginne(zug) {
    if (!this._an || this.geschlossen) return;
    const schluessel = zugKennung(zug?.ein);
    if (!schluessel) return;
    this.#spurenBereinigen();
    // Ein Live-Zug beginnt: ein laufender Schattenzug gibt die Karte frei.
    this.aktuell?.abbrechen('neuer-zug');
    this.spuren.set(schluessel, {
      ...zug,
      ein: schluessel,
      start: this._jetzt(),
      liveWerkzeug: null,
      liveText: '',
    });
  }

  werkzeug(ein, name, args) {
    const s = this.spuren.get(zugKennung(ein));
    if (s && !s.liveWerkzeug && name) s.liveWerkzeug = { name: String(name), argumente: args };
  }

  text(ein, delta) {
    const s = this.spuren.get(zugKennung(ein));
    if (s && s.liveText.length < 4000) s.liveText += String(delta ?? '');
  }

  /**
   * Zugende: für jeden eingeschalteten Adapter einen Schattenzug einreihen. Mit `verlauf` (`async () => {werkzeug: {name, args}|null,
   * text}`) wird die Live-Aktion aus dem gespeicherten Verlauf des Zugs geholt; das ist zuverlässiger als die Beobachtung, die einen
   * sehr schnellen Werkzeugaufruf verpassen kann. Ohne `verlauf` oder bei einem Fehler zählt das Beobachtete.
   */
  ende(ein, verlauf = null) {
    const schluessel = zugKennung(ein);
    const s = this.spuren.get(schluessel);
    if (!s) return undefined;
    if (!this._an || this.geschlossen) {
      this.spuren.delete(schluessel);
      return undefined;
    }
    if (typeof verlauf !== 'function') {
      this.spuren.delete(schluessel);
      this.#einreihen(s);
      return undefined;
    }
    // Der Zug bleibt offen (die Bahn ist belegt), bis der Verlauf gelesen ist.
    return Promise.resolve()
      .then(verlauf)
      .then((v) => {
        if (!v) return;
        if (v.werkzeug?.name) s.liveWerkzeug = { name: String(v.werkzeug.name), argumente: v.werkzeug.args };
        else if (v.werkzeug === null) s.liveWerkzeug = null;
        if (typeof v.text === 'string') s.liveText = v.text;
      })
      .catch(() => {})
      .then(() => {
        this.spuren.delete(schluessel);
        if (this._an && !this.geschlossen) this.#einreihen(s);
      });
  }

  #einreihen(s) {
    const live = aktion({ name: s.liveWerkzeug?.name ?? null, argumente: s.liveWerkzeug?.argumente, text: s.liveText });
    for (const a of this.adapter.values()) {
      if (!a.an) continue;
      const ak = this.konfig.adapter[a.name] ?? {};
      if (ak.quellen?.length && !ak.quellen.includes(s.quelle)) continue;
      if (ak.klassen?.length && !ak.klassen.includes(s.klasse)) continue;
      const item = { adapter: a, spur: s, live, eingereiht: this._jetzt() };
      if (live.art === 'nichts' && !s.liveWerkzeug) {
        this.#uebersprungen(item, 'ohne-live-aktion');
        continue;
      }
      this.#zaehler(a.name).eingereiht += 1;
      this.warteschlange.push(item);
      while (this.warteschlange.length > this.konfig.queue_max) this.#uebersprungen(this.warteschlange.shift(), 'warteschlange-voll');
    }
    void this.#abarbeiten();
  }

  #spurenBereinigen() {
    const grenze = this._jetzt() - Math.max(600_000, this.konfig.max_alter_s * 1000);
    for (const [k, s] of this.spuren) if (s.start < grenze) this.spuren.delete(k);
  }

  #liveLaeuft() {
    return this.spuren.size > 0 || Boolean(this.beschaeftigt?.());
  }

  // --- Sperren ---

  /** Grund, aus dem gerade nichts laufen darf (Spielmodus, Ruhe), sonst `null`. */
  #betrieb() {
    if (this.spielmodus?.an?.()) return 'spielmodus';
    const r = this.ruhe?.();
    if (r) return typeof r === 'string' ? r : 'ruhe';
    if (this.konfig.ruhe_sperre.some((p) => existsSync(p))) return 'ruhe';
    return null;
  }

  #stundeVerbraucht(name) {
    const grenze = this._jetzt() - 3_600_000;
    const liste = (this.stunde.get(name) ?? []).filter((t) => t > grenze);
    this.stunde.set(name, liste);
    return liste.length;
  }

  async #sperre(adapter) {
    if (this.geschlossen) return 'beendet';
    if (!this._an) return 'aus';
    if (!adapter.an) return 'adapter-aus';
    const betrieb = this.#betrieb();
    if (betrieb) return betrieb;
    if (this.#stundeVerbraucht(adapter.name) >= adapter.budget) return 'budget';
    if (this.konfig.gpu_reserve_mib > 0) {
      let frei = null;
      try {
        frei = await this.gpuFrei();
      } catch {
        frei = null;
      }
      if (!Number.isFinite(frei)) return 'gpu-unbekannt';
      if (frei < this.konfig.gpu_reserve_mib) return 'gpu-reserve';
    }
    return null;
  }

  // --- Abarbeiten: höchstens ein Schattenzug gleichzeitig ---

  async #abarbeiten() {
    if (this.laeuft) return;
    this.laeuft = true;
    try {
      while (this.warteschlange.length && !this.geschlossen) {
        await schlafen(this.konfig.warte_ms);
        const item = this.warteschlange[0];
        if (!item) break;
        // Erst wenn kein Live-Zug mehr offen ist; zu alte Züge verfallen.
        if (this.#liveLaeuft()) {
          if (this._jetzt() - item.eingereiht > this.konfig.max_alter_s * 1000) {
            this.warteschlange.shift();
            this.#uebersprungen(item, 'veraltet');
          } else {
            await schlafen(Math.min(250, this.konfig.wache_ms));
          }
          continue;
        }
        this.warteschlange.shift();
        await this.#lauf(item).catch((fehler) => this.log(`[fyos-schatten] ${item.adapter.name}: ${fehler?.message ?? fehler}`));
      }
    } finally {
      this.laeuft = false;
    }
  }

  async #lauf(item) {
    const adapter = item.adapter;
    const grund = await this.#sperre(adapter);
    if (grund) return this.#uebersprungen(item, grund);
    const liste = this.stunde.get(adapter.name) ?? [];
    liste.push(this._jetzt());
    this.stunde.set(adapter.name, liste);

    const ctrl = new AbortController();
    const aktuell = { item, ctrl, grund: null, frist: false };
    aktuell.abbrechen = (g) => {
      if (aktuell.grund) return;
      aktuell.grund = g;
      ctrl.abort(new Error(`abgebrochen: ${g}`));
    };
    this.aktuell = aktuell;
    const fristTimer = setTimeout(() => {
      aktuell.frist = true;
      ctrl.abort(new Error('Frist überschritten'));
    }, this.konfig.frist_s * 1000);
    const wache = setInterval(() => {
      const g = this.#betrieb();
      if (g) aktuell.abbrechen(g);
    }, this.konfig.wache_ms);
    const abbruch = new Promise((_ok, nein) => ctrl.signal.addEventListener('abort', () => nein(ctrl.signal.reason ?? new Error('abgebrochen')), { once: true }));
    abbruch.catch(() => {});
    const zug = this.#zugFuer(item.spur);
    const t0 = this._jetzt();
    try {
      const anfrage = Promise.resolve().then(() => item.adapter.anfrage(zug, { signal: ctrl.signal }));
      anfrage.catch(() => {});
      const antwort = await Promise.race([anfrage, abbruch]);
      if (antwort?.uebersprungen) return this.#uebersprungen(item, String(antwort.uebersprungen));
      this.#zeileZug(item, zug, antwort, 'ok', null);
    } catch (fehler) {
      if (aktuell.grund) return this.#uebersprungen(item, `abgebrochen-${aktuell.grund}`);
      const status = aktuell.frist ? 'timeout' : 'fehler';
      this.#zeileZug(item, zug, null, status, aktuell.frist ? 'Frist überschritten' : fehler?.message ?? String(fehler), this._jetzt() - t0);
    } finally {
      clearTimeout(fristTimer);
      clearInterval(wache);
      if (this.aktuell === aktuell) this.aktuell = null;
    }
  }

  #zugFuer(s) {
    return { ein: s.ein, quelle: s.quelle, klasse: s.klasse, bezug: s.bezug ?? null, text: s.text, eingang: s.eingang, system: s.system ?? '', werkzeuge: s.werkzeuge ?? [] };
  }

  // --- Zeilen ---

  #kopfZeile(item, art) {
    const t = this._jetzt();
    return { v: 1, t, tag: tagVon(t), art, adapter: item.adapter.name, ein: item.spur.ein };
  }

  #uebersprungen(item, grund) {
    const z = this.#zaehler(item.adapter.name);
    z.uebersprungen[grund] = (z.uebersprungen[grund] ?? 0) + 1;
    this.#schreibe(item.adapter.name, { ...this.#kopfZeile(item, 'uebersprungen'), grund });
  }

  #zeileZug(item, zug, antwort, status, fehler, dauerMs = null) {
    const ak = this.konfig.adapter[item.adapter.name] ?? {};
    const s = item.spur;
    const kurzAntwort = (text) => redigiert(text, this.konfig.antwort_zeichen);
    const liveText = s.liveText;
    const live = {
      art: item.live.art,
      name: item.live.name,
      args_form: item.live.args_form,
      args_hash: item.live.args_hash,
      text: item.live.art === 'text' ? kurzAntwort(liveText) : null,
      text_hash: item.live.art === 'text' ? hash16(liveText) : null,
    };
    let schatten = null;
    let vergleich = null;
    if (antwort) {
      const a = aktion({ name: antwort.werkzeug?.name ?? null, argumente: antwort.werkzeug?.argumente, argumente_roh: antwort.werkzeug?.argumente_roh, text: antwort.text });
      schatten = {
        art: a.art,
        name: a.name,
        args_form: a.args_form,
        args_hash: a.args_hash,
        json_gueltig: a.json_gueltig,
        deutsch: a.deutsch,
        text: a.art === 'text' ? kurzAntwort(antwort.text) : null,
        text_hash: String(antwort.text ?? '').trim() ? hash16(antwort.text) : null,
      };
      vergleich = vergleiche(item.live, a);
    }
    const version = item.adapter.version?.(zug) ?? {};
    const z = this.#zaehler(item.adapter.name);
    z[status] += 1;
    this.#schreibe(item.adapter.name, {
      ...this.#kopfZeile(item, 'zug'),
      quelle: s.quelle ?? null,
      klasse: s.klasse ?? null,
      eingang: { kopf: redigiert(s.eingang, this.konfig.kopf_zeichen), hash: hash16(s.eingang), zeichen: String(s.eingang ?? '').length },
      live,
      schatten,
      uebereinstimmung: vergleich,
      latenz: { erstes_token_ms: antwort?.erstes_token_ms ?? null, gesamt_ms: antwort?.gesamt_ms ?? (dauerMs === null ? null : Math.round(dauerMs)) },
      tokens: { ein: antwort?.tokens?.ein ?? null, aus: antwort?.tokens?.aus ?? null },
      status,
      fehler: fehler ? redigiert(OHNE_SCHLUESSEL(fehler, ''), 200) : null,
      version: { modell: version.modell ?? ak.modell ?? null, quant: version.quant ?? ak.quant ?? null, systemkopf: version.systemkopf ?? null },
    });
  }

  /** Eine Zeile an die Tagesdatei `<name>-<Tag>.jsonl` hängen (Tagesgrenze `max_mb_tag`); ein Schreibfehler wirft nie. */
  #schreibe(name, daten) {
    let zeile;
    try {
      zeile = `${JSON.stringify(daten)}\n`;
    } catch (fehler) {
      this.#fehler(`nicht serialisierbar: ${fehler?.message ?? fehler}`);
      return;
    }
    const roh = Buffer.from(zeile, 'utf8');
    const pfad = join(this.konfig.ordner, `${name}-${daten.tag ?? tagVon(this._jetzt())}.jsonl`);
    let st = this._pfade.get(pfad);
    if (!st) {
      st = { bytes: existsSync(pfad) ? statSync(pfad).size : 0, voll: false };
      this._pfade.set(pfad, st);
    }
    if (st.bytes + roh.length > Math.trunc(this.konfig.max_mb_tag * 1024 * 1024)) {
      if (!st.voll) {
        st.voll = true;
        this.log(`[fyos-schatten] ${pfad} hat die Tagesgrenze erreicht`);
      }
      return;
    }
    try {
      mkdirSync(dirname(pfad), { recursive: true });
      appendFileSync(pfad, roh);
    } catch (fehler) {
      this.#fehler(fehler?.message ?? String(fehler));
      return;
    }
    st.bytes += roh.length;
    this.zeilen += 1;
    this.fehler = null;
  }

  #fehler(text) {
    if (text !== this.fehler) this.log(`[fyos-schatten] ${text}`);
    this.fehler = text;
  }

  // --- Wahrheit ---

  /**
   * Besitzer' Rückmeldung (Daumen, Antwort, Korrektur im Chat) als Wahrheit an einem Zug festhalten. `urteil`: `gut` (Live-Aktion war
   * richtig), `schlecht` (war falsch) oder `korrektur` (mit `werkzeug`: das hätte gerufen werden sollen; `null` = gar kein Werkzeug).
   * Quelle im Runner: noch keine. `denken.rueckmeldung` und `entscheiden.wahrheit` liegen im Hub; bis dort ein Weg zum Runner besteht,
   * schreibt der Steuerkanal (`POST /schatten/wahrheit`) oder ein Baustein hierher. Nur Verweis und Urteil, kein Text.
   */
  wahrheit(ein, { urteil, werkzeug, quelle = 'steuer' } = {}) {
    const schluessel = zugKennung(ein);
    if (!schluessel) throw new Error('ein: Zug-Id fehlt');
    if (!['gut', 'schlecht', 'korrektur'].includes(urteil)) throw new Error('urteil: gut, schlecht oder korrektur');
    if (urteil === 'korrektur' && werkzeug === undefined) throw new Error('korrektur braucht werkzeug (Name oder null)');
    const t = this._jetzt();
    const zeile = { v: 1, t, tag: tagVon(t), art: 'wahrheit', ein: schluessel, urteil, quelle: String(quelle).slice(0, 32) };
    if (werkzeug !== undefined) zeile.wahr_werkzeug = werkzeug === null ? null : String(werkzeug).slice(0, 80);
    this.#schreibe('wahrheit', zeile);
    this.#zaehler('wahrheit').wahrheiten += 1;
    return { ok: true, ein: schluessel };
  }

  // --- Sicht ---

  /** Zähler je Adapter, ohne Inhalte (für /zustand). */
  zustand() {
    const adapter = {};
    for (const a of this.adapter.values()) {
      const z = this.#zaehler(a.name);
      adapter[a.name] = {
        an: Boolean(a.an),
        art: a.art,
        budget_stunde: a.budget,
        stunde_verbraucht: this.#stundeVerbraucht(a.name),
        eingereiht: z.eingereiht,
        ok: z.ok,
        fehler: z.fehler,
        timeout: z.timeout,
        uebersprungen: { ...z.uebersprungen },
      };
    }
    return {
      an: this._an,
      ordner: this.konfig.ordner,
      adapter,
      offen: this.spuren.size,
      warteschlange: this.warteschlange.length,
      laeuft: Boolean(this.aktuell),
      wahrheiten: this.#zaehler('wahrheit').wahrheiten,
      zeilen: this.zeilen,
      fehler: this.fehler,
    };
  }

  /** Auswertung der letzten Tage aus den Dateien (nur Zahlen). */
  bericht({ tage } = {}) {
    const n = Number.isFinite(Number(tage)) && Number(tage) > 0 ? Math.trunc(Number(tage)) : this.konfig.tor.tage;
    const zeilen = schattenZeilenLesen(this.konfig.ordner, n, this._jetzt());
    return { ok: true, tage: n, ...auswerten(zeilen, { tor: this.konfig.tor }) };
  }

  /** Beenden: laufenden Schattenzug abbrechen, Warteschlange verwerfen. */
  schliessen() {
    this.geschlossen = true;
    this.aktuell?.abbrechen('beendet');
    this.warteschlange.length = 0;
    this.spuren.clear();
  }
}

/**
 * Den Systemkopf und die Werkzeugschemata eines Gesprächs holen (für `beginne`). Best effort: ein Fehler gibt leere Werte, der
 * Systemkopf-Hash in der Aufzeichnung zeigt dann, dass kein Kopf da war.
 */
export async function zugKontext(runner, conversationId, ctx) {
  try {
    const conv = await runner.harness.conversation(conversationId, ctx);
    const agent = await conv.agent(ctx);
    const teile = [];
    for (const sek of agent.sections ?? []) {
      const t = typeof sek?.text === 'string' ? sek.text : typeof sek?.content === 'string' ? sek.content : '';
      if (t) teile.push(t);
    }
    if (agent.instructions) teile.push(agent.instructions);
    return {
      system: teile.join('\n\n'),
      werkzeuge: (agent.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? '', parameters: t.parameters ?? null })).filter((t) => t.name),
    };
  } catch {
    return { system: '', werkzeuge: [] };
  }
}
