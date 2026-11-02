/**
 * persona/gedaechtnis-lex.js — Zerlegung für die Wortsuche (BM25 als Qdrant-Sparse-Vektor) und für den Dublettenvergleich.
 *
 * Nachbau von mcp_hub/wissen_lex.py (Zerlegung: Kennungen ganz und in Teilen, Umlaute gefaltet, Stoppwörter, Stamm).
 * Einziger Unterschied: die Begriffs-Kennung (u32) ist hier der Anfang von SHA-1, dort BLAKE2b-4 (Node kennt kein
 * BLAKE2b mit 4 Byte). Die Sammlung `persona_gedaechtnis` ist eine eigene; die Kennungen müssen nur innerhalb von ihr zu
 * Dokument und Anfrage passen. Ändert sich die Zerlegung, steigt LEX_VERSION (der Abgleich baut die Vektoren neu).
 */
import { createHash } from 'node:crypto';

export const LEX_VERSION = 1;
const K1 = 1.2;
const B = 0.75;
const MITTLERE_LAENGE = 40; // Begriffe je Fakt/Episode, grob

const BEZEICHNER = /[A-Za-z][\w.\-/]*\d[\w.\-/]*|\w+[_./][\w._/-]+/gu;
const WORT = /[\p{L}]+|\d+/gu;
const STOPP = new Set(
  ('der die das und oder ist sind ein eine einen einem einer eines den dem des mit von fuer auf im in zu zum zur es sich ' +
    'nicht auch aber wenn dann wie was wer wo wird werden wurde hat haben bei aus nach als an am um dass the and or is are a ' +
    'of for to on it be by as at this that with').split(' '),
);
const FALTEN = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };
const ENDUNGEN = ['ungen', 'ung', 'keit', 'heit', 'lich', 'isch', 'ern', 'ene', 'enen', 'ener', 'en', 'er', 'es', 'em', 'ing', 'ed', 'e', 'n', 's'];

const falten = (w) => w.toLowerCase().replace(/[äöüß]/g, (c) => FALTEN[c]);

export function stamm(w) {
  for (const e of ENDUNGEN) if (w.endsWith(e) && w.length - e.length >= 4) return w.slice(0, -e.length);
  return w;
}

/** Begriffe eines Textes in Reihenfolge, mit Wiederholungen. */
export function zerlege(text, { stammform = true } = {}) {
  const t = String(text ?? '').normalize('NFC');
  if (!t) return [];
  const aus = [];
  const spannen = [];
  const buchen = (w) => {
    if (w.length < 2 || STOPP.has(w)) return;
    aus.push(w);
    if (stammform) {
      const s = stamm(w);
      if (s !== w) aus.push(s);
    }
  };
  for (const m of t.matchAll(BEZEICHNER)) {
    const ganz = falten(m[0].replace(/^[.,;:/]+|[.,;:/]+$/g, ''));
    if (ganz.length < 2) continue;
    aus.push(ganz);
    spannen.push([m.index, m.index + m[0].length]);
    for (const w of ganz.match(WORT) ?? []) buchen(w);
  }
  for (const m of t.matchAll(WORT)) {
    if (spannen.some(([a, b]) => a <= m.index && m.index < b)) continue;
    buchen(falten(m[0]));
  }
  return aus;
}

export function begriffId(begriff) {
  return createHash('sha1').update(begriff).digest().readUInt32BE(0);
}

/** `{indices, values}` für ein Dokument; der IDF-Teil kommt von Qdrant (`modifier: idf`). */
export function sparseDokument(text) {
  const begriffe = zerlege(text);
  if (!begriffe.length) return { indices: [], values: [] };
  const tf = new Map();
  for (const b of begriffe) {
    const i = begriffId(b);
    tf.set(i, (tf.get(i) ?? 0) + 1);
  }
  const norm = 1 - B + B * (begriffe.length / MITTLERE_LAENGE);
  const idx = [...tf.keys()].sort((a, b) => a - b);
  return { indices: idx, values: idx.map((i) => Math.round(((tf.get(i) * (K1 + 1)) / (tf.get(i) + K1 * norm)) * 1e4) / 1e4) };
}

/** Anfrage: jeder verschiedene Begriff mit Gewicht 1. */
export function sparseAnfrage(text) {
  const ids = [...new Set(zerlege(text).map(begriffId))].sort((a, b) => a - b);
  return { indices: ids, values: ids.map(() => 1) };
}

/** Text für den Dublettenvergleich: klein, gefaltet, nur Wortzeichen. */
export function normalisiert(text) {
  return falten(String(text ?? '')).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function inhaltsHash(text) {
  return createHash('sha1').update(normalisiert(text)).digest('hex').slice(0, 20);
}

/** Ähnlichkeit zweier Texte als Jaccard über die Begriffsmengen (0..1), ohne Stammformen. */
export function aehnlichkeit(a, b) {
  const x = new Set(zerlege(a, { stammform: false }));
  const y = new Set(zerlege(b, { stammform: false }));
  if (!x.size || !y.size) return 0;
  let gemeinsam = 0;
  for (const w of x) if (y.has(w)) gemeinsam += 1;
  return gemeinsam / (x.size + y.size - gemeinsam);
}
