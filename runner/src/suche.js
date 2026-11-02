/**
 * suche.js — `GET /api/suche`: Titel und sichtbarer Verlaufstext aller Sitzungen, nur lesend.
 *
 * Wie Gespräche gespeichert sind: pi-durable in SQLite. Das Register (ein Dokument) kennt Titel, Archivmarke und Anlagezeit jeder Sitzung;
 * der Verlauf liegt je Sitzung in Einträgen (`conv.entries`). Eine Volltextindex-Tabelle gibt es nicht, also liest die Suche ohne Index,
 * aber begrenzt und so billig wie möglich:
 *
 *   1. Das Register wird EINMAL gelesen (Titel, Archivmarke); danach wird nach der Archivmarke gefiltert.
 *   2. Stehen alle Suchwörter schon im Titel, ist die Sitzung ein Treffer, ohne dass ihr Verlauf gelesen wird (nur ein paar Einträge
 *      für die Zeit der letzten Aktivität).
 *   3. Sonst werden die neuesten `eintraege` Einträge der Sitzung gelesen (über `runner.verlauf`, die eine Stelle für den Verlauf).
 *      Durchsucht werden nur die Texte von Mensch und Agent (Nachrichten der Rollen user und assistant, nur Textblöcke): keine
 *      Werkzeugaufrufe und -ergebnisse, kein Systemkopf, keine Denkblöcke, keine Zusammenfassungen der Verdichtung.
 *   4. Jeder durchsuchte Text wird vorher wie die Freigabe-Meldungen geschwärzt (schwaerzen.js): Zugangsdaten und lange Schlüssel
 *      sind weder auffindbar noch im Ausschnitt zu lesen.
 *
 * Grenzen (alle zusammen schützen den produktiven Runner): höchstens `sitzungen` Sitzungen (die neuesten, das Hauptgespräch zuerst),
 * je Sitzung die neuesten `eintraege` Einträge und `nachricht_zeichen` Zeichen je Nachricht, ein Zeitlimit `zeit_ms`, höchstens
 * `treffer` Treffer, höchstens `gleichzeitig` Suchen zugleich (sonst 429). Zwischen zwei Sitzungen gibt der Lauf den Ereignisschleifen-
 * Takt frei. Wird eine Grenze erreicht, steht `abgeschnitten: true` in der Antwort.
 *
 * Ein Index wäre eine spätere Stufe (nur als Vorschlag, nicht gebaut): eine kleine Zusatztabelle (Sitzung, Eintrag, Kleintext) in einer
 * eigenen SQLite-Datei, die der Strom der Ereignisse nachführt; dann entfällt das Lesen der Einträge bei jeder Suche.
 */
import { schwaerzen } from './schwaerzen.js';

export const SUCHE_GRENZEN = Object.freeze({
  sitzungen: 200,
  eintraege: 120,
  treffer: 50,
  zeit_ms: 4000,
  nachricht_zeichen: 20_000,
  gleichzeitig: 2,
  ausschnitt: 160,
  woerter: 6,
  wortlaenge: 80,
  frage_zeichen: 200,
});

const MARKER = new Set(['pi.reset', 'pi.compaction']);

export class SucheFehler extends Error {
  constructor(status, nachricht) {
    super(nachricht);
    this.status = status;
  }
}

/** Welche Sitzungen: `aktiv` (Standard), `archiviert` oder `alle`. Wirft SucheFehler 400 bei anderen Werten. */
export function archivModus(roh) {
  if (roh === undefined || roh === null) return 'aktiv';
  const t = String(roh).trim().toLowerCase();
  if (t === '' || t === '0' || t === 'nein') return 'aktiv';
  if (t === '1' || t === 'ja') return 'archiviert';
  if (t === 'alle') return 'alle';
  throw new SucheFehler(400, 'archiv muss 0, 1 oder alle sein');
}

/** Passt ein Register-Eintrag zum Archiv-Modus? */
export function archivPasst(eintrag, modus) {
  const archiviert = !!eintrag?.archiviert;
  if (modus === 'alle') return true;
  return modus === 'archiviert' ? archiviert : !archiviert;
}

/**
 * Kleinschreibung mit gleicher Länge: Zeichen, deren Kleinform eine andere Länge hat (z. B. „İ“), bleiben unverändert, damit die
 * Offsets im Original stimmen.
 */
export function klein(text) {
  let aus = '';
  for (const z of String(text)) {
    const k = z.toLowerCase();
    aus += k.length === z.length ? k : z;
  }
  return aus;
}

/** Die Suchwörter: an Leerraum getrennt, klein, ohne Doppelte. Wirft SucheFehler 400, wenn die Frage zu kurz oder zu lang ist. */
export function suchwoerter(q) {
  if (typeof q !== 'string') throw new SucheFehler(400, 'q fehlt');
  const t = q.trim();
  if (Array.from(t).length < 2) throw new SucheFehler(400, 'q muss mindestens 2 Zeichen haben');
  if (t.length > SUCHE_GRENZEN.frage_zeichen) throw new SucheFehler(400, `q darf höchstens ${SUCHE_GRENZEN.frage_zeichen} Zeichen haben`);
  const woerter = [...new Set(t.split(/\s+/).map((w) => klein(w.slice(0, SUCHE_GRENZEN.wortlaenge))).filter(Boolean))];
  if (woerter.length > SUCHE_GRENZEN.woerter) throw new SucheFehler(400, `q darf höchstens ${SUCHE_GRENZEN.woerter} Wörter haben`);
  return woerter;
}

/** `limit` als ganze Zahl 1..50 (Standard 20); alles andere ist 400, mehr als 50 wird auf 50 gekappt. */
export function suchLimit(roh, max = SUCHE_GRENZEN.treffer) {
  if (roh === undefined || roh === null || roh === '') return Math.min(20, max);
  const n = Number(roh);
  if (!Number.isInteger(n) || n < 1) throw new SucheFehler(400, `limit muss eine ganze Zahl von 1 bis ${max} sein`);
  return Math.min(n, max);
}

function textVon(inhalt) {
  if (typeof inhalt === 'string') return inhalt;
  if (!Array.isArray(inhalt)) return '';
  return inhalt
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Die sichtbaren Texte eines Verlaufs (aufsteigend) als `[{ rolle, text, zeit }]`: Nachrichten von Mensch (`user`) und Agent
 * (`assistant`), nur Text. Nicht dabei: System, Werkzeugergebnisse, Werkzeugaufrufe, Denkblöcke, Marker (`pi.reset`, `pi.compaction`).
 */
export function sichtbareTexte(eintraege, { zeichen = SUCHE_GRENZEN.nachricht_zeichen } = {}) {
  const aus = [];
  for (const e of eintraege ?? []) {
    if (!e || MARKER.has(e.kind)) continue;
    for (const m of e.model ?? []) {
      if (m?.role !== 'user' && m?.role !== 'assistant') continue;
      const roh = textVon(m.content).slice(0, zeichen);
      if (!roh.trim()) continue;
      const zeit = Number(m.timestamp ?? e.data?.zeit);
      aus.push({ rolle: m.role === 'user' ? 'mensch' : 'agent', text: schwaerzen(roh, Infinity), zeit: Number.isFinite(zeit) ? zeit : null });
    }
  }
  return aus;
}

/** Die jüngste Zeit, die in den Einträgen steht (Nachrichten, Mensch-Eingaben), oder null. */
export function letzteZeit(eintraege) {
  let max = null;
  for (const e of eintraege ?? []) {
    for (const z of [e?.data?.zeit, ...(e?.model ?? []).map((m) => m?.timestamp)]) {
      if (typeof z === 'number' && Number.isFinite(z) && (max === null || z > max)) max = z;
    }
  }
  return max;
}

/** Wie viele der Wörter stehen im (kleingeschriebenen) Text, und wo das erste davon beginnt. */
function wortTreffer(klTxt, woerter) {
  let gefunden = 0;
  let erster = -1;
  for (const w of woerter) {
    const i = klTxt.indexOf(w);
    if (i < 0) continue;
    gefunden += 1;
    if (erster < 0 || i < erster) erster = i;
  }
  return { gefunden, erster };
}

/**
 * Ein Ausschnitt von höchstens `max` Zeichen um den ersten Treffer. Die Treffer stehen NICHT als HTML im Text, sondern als
 * Offsets (UTF-16-Einheiten, wie `String.slice` und `indexOf` in JavaScript) in den Ausschnitt: `start`/`laenge` ist der erste Treffer,
 * `markierungen` sind alle (höchstens 10, ohne Überlappung, aufsteigend).
 */
export function ausschnittBauen(text, woerter, max = SUCHE_GRENZEN.ausschnitt) {
  const kl = klein(text);
  const { erster } = wortTreffer(kl, woerter);
  const pos = Math.max(erster, 0);
  let von = Math.max(0, pos - Math.floor(max / 3));
  let bis = Math.min(text.length, von + max);
  von = Math.max(0, bis - max);
  // keine halben Ersatzpaare an den Rändern
  if (von > 0 && /[\udc00-\udfff]/.test(text[von])) von += 1;
  if (bis < text.length && /[\ud800-\udbff]/.test(text[bis - 1])) bis -= 1;
  const ausschnitt = text.slice(von, bis);
  const klAus = kl.slice(von, bis);
  const alle = [];
  for (const w of woerter) {
    let i = klAus.indexOf(w);
    while (i >= 0) {
      alle.push({ start: i, laenge: w.length });
      i = klAus.indexOf(w, i + w.length);
    }
  }
  alle.sort((a, b) => a.start - b.start || b.laenge - a.laenge);
  const markierungen = [];
  let ende = 0;
  for (const m of alle) {
    if (m.start < ende) continue;
    markierungen.push(m);
    ende = m.start + m.laenge;
    if (markierungen.length >= 10) break;
  }
  const erste = markierungen[0] ?? { start: 0, laenge: 0 };
  return { ausschnitt, start: erste.start, laenge: erste.laenge, markierungen };
}

/**
 * Einen Treffer für EINE Sitzung suchen. `eintrag` ist der Registereintrag, `lies(id, n)` liefert die neuesten n Einträge aufsteigend.
 * Rückgabe: der Treffer oder null.
 */
export async function sitzungPruefen(eintrag, woerter, lies, grenzen = SUCHE_GRENZEN) {
  const titel = schwaerzen(eintrag.titel ?? '', 200);
  const klTitel = klein(titel);
  const imTitel = wortTreffer(klTitel, woerter);
  const erstellt = typeof eintrag.erstellt === 'number' ? eintrag.erstellt : null;
  const basis = { id: eintrag.id, titel, archiviert: !!eintrag.archiviert };

  // Stufe 2: alle Wörter im Titel, der Verlauf bleibt zu.
  if (imTitel.gefunden === woerter.length) {
    const kurz = await lies(eintrag.id, 8).catch(() => []);
    return { ...basis, aktualisiert: letzteZeit(kurz) ?? erstellt, quelle: 'titel', ...ausschnittBauen(titel, woerter, grenzen.ausschnitt), zahl: 1 };
  }

  // Stufe 3: Volltext der neuesten Einträge.
  const eintraege = await lies(eintrag.id, grenzen.eintraege).catch(() => null);
  if (!eintraege) return null;
  const texte = sichtbareTexte(eintraege, { zeichen: grenzen.nachricht_zeichen }).reverse(); // neueste zuerst
  const einheiten = [{ quelle: 'titel', text: titel, kl: klTitel }, ...texte.map((t) => ({ quelle: 'verlauf', text: t.text, kl: klein(t.text) }))];
  const gesehen = new Set();
  let zahl = 0;
  let beste = null;
  for (const u of einheiten) {
    const t = wortTreffer(u.kl, woerter);
    if (t.gefunden === 0) continue;
    zahl += 1;
    for (const w of woerter) if (u.kl.includes(w)) gesehen.add(w);
    if (!beste || t.gefunden > beste.gefunden) beste = { ...u, gefunden: t.gefunden };
  }
  if (gesehen.size !== woerter.length || !beste) return null;
  return {
    ...basis,
    aktualisiert: letzteZeit(eintraege) ?? erstellt,
    quelle: beste.quelle,
    ...ausschnittBauen(beste.text, woerter, grenzen.ausschnitt),
    zahl,
  };
}

const naechsterTakt = () => new Promise((ok) => setImmediate(ok));

/**
 * Die Suche selbst. `quelle` stellt bereit: `registerListe(modus)` (Registereinträge, Hauptgespräch zuerst, dann neueste zuerst) und
 * `verlauf(id, n)`. `grenzen` darf einzelne Werte überschreiben (Konfiguration `pi_durable.suche`, Tests).
 * @returns {Promise<{ok:true, treffer:Array, abgeschnitten:boolean, durchsucht:number, gesamt:number}>}
 */
export async function sitzungenDurchsuchen(quelle, { q, limit, archiv }, grenzen = {}, jetzt = () => Date.now()) {
  const g = { ...SUCHE_GRENZEN, ...grenzen };
  const woerter = suchwoerter(q);
  const max = suchLimit(limit, g.treffer);
  const modus = archivModus(archiv);
  const liste = await quelle.registerListe(modus);
  const kandidaten = liste.slice(0, g.sitzungen);
  let abgeschnitten = liste.length > kandidaten.length;
  const ende = jetzt() + g.zeit_ms;
  const treffer = [];
  let durchsucht = 0;
  for (let i = 0; i < kandidaten.length; i += 1) {
    if (treffer.length >= max || jetzt() >= ende) {
      abgeschnitten = true;
      break;
    }
    const t = await sitzungPruefen(kandidaten[i], woerter, (id, n) => quelle.verlauf(id, n), g).catch(() => null);
    durchsucht += 1;
    if (t) treffer.push(t);
    await naechsterTakt();
  }
  treffer.sort((a, b) => (b.aktualisiert ?? 0) - (a.aktualisiert ?? 0));
  return { ok: true, treffer, abgeschnitten, durchsucht, gesamt: liste.length };
}
