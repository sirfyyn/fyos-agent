/**
 * schatten-konfig.js — Konfiguration des Schatten-Rekorders (`pi_durable.schatten`), ohne schwere Importe.
 *
 * Gelesen von `config.js` (geprüfte Form), `schatten.js` und dem Bericht. Unsinn fällt auf die Vorgabe zurück.
 * Alles ist standardmäßig AUS: ohne ausdrückliches `an: true` (Rekorder) und `adapter.<name>.an: true` (Schatten) läuft nichts.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const ADAPTER_NAMEN = ['bolt', 'sprache-agent', 'schnellweg'];

const ADAPTER_VORGABE = Object.freeze({
  an: false,
  art: 'openai-chat', // 'openai-chat' (OpenAI-kompatibel) | 'attrappe' (Schnittstelle ohne Umsetzung)
  budget_stunde: 30, // so viele Schattenzüge je Stunde und Adapter, dann „budget“
  url: '',
  schluessel_datei: '', // Pfad, nie der Schlüssel selbst; wird je Anfrage gelesen und nie geloggt
  modell: '',
  quant: '',
  temperatur: 0.3,
  max_tokens: 700,
  quellen: [], // leer = alle Quellen; sonst nur Züge dieser Quellen (z. B. ['stimme'])
  klassen: [], // leer = alle Klassen; sonst nur 'max' oder 'hintergrund'
});

const ADAPTER_STANDARD = {
  bolt: { art: 'openai-chat', url: 'http://127.0.0.1:18500', schluessel_datei: '/var/lib/fyos-ersatzdenker/api.key', modell: 'ersatzdenker', quant: 'Q3_K_XL' },
  'sprache-agent': { art: 'openai-chat', quellen: ['stimme', 'sprache'] },
  schnellweg: { art: 'attrappe' },
};

export const TOR_VORGABE = Object.freeze({
  min_zuege: 100, // so viele verglichene Züge (Status ok) mindestens
  min_werkzeug: 0.9, // Werkzeug-Übereinstimmung
  max_falsch: 0.03, // Falsch-Auslösung (Schatten ruft ein Werkzeug, Live nicht, oder umgekehrt)
  max_fehler: 0.05, // Fehler- und Timeout-Quote
  min_json: 0.98, // gültiges JSON in den Werkzeugaufrufen des Schattens
  min_deutsch: 0.9, // Antworttexte auf Deutsch
  max_p95_ms: null, // Gesamtlatenz p95; null = nicht geprüft
  streng: false, // true: die Wilson-Grenze (untere bei Mindestwerten, obere bei Höchstwerten) muss die Schwelle halten
  tage: 7, // Auswertungszeitraum
});

export const SCHATTEN_VORGABE = Object.freeze({
  an: false,
  ordner: '/var/lib/fyos-agent/schatten',
  max_mb_tag: 100, // je Datei und Tag
  frist_s: 60, // so lange darf ein Schattenzug höchstens dauern
  warte_ms: 500, // Abstand nach dem Live-Zug, bevor der Schatten anfängt
  max_alter_s: 300, // ein eingereihter Zug, der so lange keine freie Bahn fand, wird übersprungen („veraltet“)
  queue_max: 20, // Warteschlange; darüber fällt der älteste Zug heraus
  wache_ms: 500, // Takt der Prüfung auf Ruhe/Spielmodus während eines Schattenzugs
  gpu_reserve_mib: 0, // 0 = keine Prüfung; sonst mindestens so viel GPU-Speicher frei (nvidia-smi), sonst „gpu-reserve“
  gpu_index: '', // Kennung der GPU für nvidia-smi (-i); leer = alle, kleinster Wert zählt
  ruhe_sperre: [], // Pfade von Marken, bei deren Existenz Ruhe gilt (z. B. /var/lib/fyos-agent/ruhe.sperre)
  kopf_zeichen: 300, // Kopf des Eingangs (redigiert); 0 = nur Hash
  antwort_zeichen: 120, // Kurztext der Antwort (redigiert); 0 = nur Hash
  tor: TOR_VORGABE,
});

const istObjekt = (w) => !!w && typeof w === 'object' && !Array.isArray(w);

const wahr = (w, vorgabe) => {
  if (w === undefined || w === null || w === '') return vorgabe;
  if (typeof w === 'boolean') return w;
  return ['1', 'true', 'ja', 'an', 'on', 'yes'].includes(String(w).trim().toLowerCase());
};

const zahl = (w, vorgabe, min, max) => {
  const n = Number(w);
  if (w === null || w === undefined || w === '' || !Number.isFinite(n)) return vorgabe;
  return Math.min(max, Math.max(min, n));
};

const text = (w, vorgabe = '') => (typeof w === 'string' && w.trim() ? w.trim() : vorgabe);

const liste = (w) => (Array.isArray(w) ? w.map((x) => String(x).trim()).filter(Boolean) : []);

/** `~` auflösen und absolut machen (relative Pfade ab dem Arbeitsverzeichnis). */
export function pfad(p) {
  const s = String(p ?? '').trim();
  if (!s) return '';
  if (s === '~') return homedir();
  if (s.startsWith('~/')) return join(homedir(), s.slice(2));
  return isAbsolute(s) ? s : resolve(s);
}

export function adapterKonfig(name, roh) {
  const r = istObjekt(roh) ? roh : {};
  const standard = { ...ADAPTER_VORGABE, ...(ADAPTER_STANDARD[name] ?? {}) };
  return {
    an: wahr(r.an, standard.an),
    art: ['openai-chat', 'attrappe'].includes(r.art) ? r.art : standard.art,
    budget_stunde: Math.trunc(zahl(r.budget_stunde, standard.budget_stunde, 0, 100_000)),
    url: text(r.url, standard.url).replace(/\/+$/, ''),
    schluessel_datei: pfad(text(r.schluessel_datei, standard.schluessel_datei)),
    modell: text(r.modell, standard.modell),
    quant: text(r.quant, standard.quant),
    temperatur: zahl(r.temperatur, standard.temperatur, 0, 2),
    max_tokens: Math.trunc(zahl(r.max_tokens, standard.max_tokens, 1, 8192)),
    quellen: r.quellen === undefined ? [...standard.quellen] : liste(r.quellen),
    klassen: (r.klassen === undefined ? [...standard.klassen] : liste(r.klassen)).filter((k) => ['max', 'hintergrund'].includes(k)),
  };
}

export function torKonfig(roh) {
  const r = istObjekt(roh) ? roh : {};
  const v = TOR_VORGABE;
  return {
    min_zuege: Math.trunc(zahl(r.min_zuege, v.min_zuege, 1, 1_000_000)),
    min_werkzeug: zahl(r.min_werkzeug, v.min_werkzeug, 0, 1),
    max_falsch: zahl(r.max_falsch, v.max_falsch, 0, 1),
    max_fehler: zahl(r.max_fehler, v.max_fehler, 0, 1),
    min_json: zahl(r.min_json, v.min_json, 0, 1),
    min_deutsch: zahl(r.min_deutsch, v.min_deutsch, 0, 1),
    max_p95_ms: r.max_p95_ms === null || r.max_p95_ms === undefined ? v.max_p95_ms : zahl(r.max_p95_ms, v.max_p95_ms, 1, 3_600_000),
    streng: wahr(r.streng, v.streng),
    tage: Math.trunc(zahl(r.tage, v.tage, 1, 365)),
  };
}

/** Die Konfiguration in eine geprüfte Form bringen (idempotent). */
export function schattenKonfig(roh) {
  const r = istObjekt(roh) ? roh : {};
  const v = SCHATTEN_VORGABE;
  const adapterRoh = istObjekt(r.adapter) ? r.adapter : {};
  const namen = [...new Set([...ADAPTER_NAMEN, ...Object.keys(adapterRoh).filter((n) => /^[a-z0-9_-]{1,40}$/.test(n))])];
  return {
    an: wahr(r.an, v.an),
    ordner: pfad(text(r.ordner, v.ordner)),
    max_mb_tag: zahl(r.max_mb_tag, v.max_mb_tag, 0.001, 100_000),
    frist_s: zahl(r.frist_s, v.frist_s, 0.01, 3600),
    warte_ms: zahl(r.warte_ms, v.warte_ms, 0, 600_000),
    max_alter_s: zahl(r.max_alter_s, v.max_alter_s, 0.01, 86_400),
    queue_max: Math.trunc(zahl(r.queue_max, v.queue_max, 1, 1000)),
    wache_ms: zahl(r.wache_ms, v.wache_ms, 5, 60_000),
    gpu_reserve_mib: zahl(r.gpu_reserve_mib, v.gpu_reserve_mib, 0, 1_000_000),
    gpu_index: text(String(r.gpu_index ?? ''), v.gpu_index),
    ruhe_sperre: liste(r.ruhe_sperre).map(pfad),
    kopf_zeichen: Math.trunc(zahl(r.kopf_zeichen, v.kopf_zeichen, 0, 300)), // nie mehr als 300
    antwort_zeichen: Math.trunc(zahl(r.antwort_zeichen, v.antwort_zeichen, 0, 300)),
    tor: torKonfig(r.tor),
    adapter: Object.fromEntries(namen.map((n) => [n, adapterKonfig(n, adapterRoh[n])])),
  };
}
