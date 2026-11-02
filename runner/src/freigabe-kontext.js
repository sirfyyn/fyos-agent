/**
 * freigabe-kontext.js — jede Freigabe trägt einen Kurzkontext von 3 bis 5 Sätzen (Entscheidung 586, Besitzer 25.10.2026:
 * „allgemein sollte Persona Freigaben mit kurzem 3–5-Satz-Kontext angeben, damit man schnell entscheiden kann“).
 *
 * Der Kontext beantwortet in 10 Sekunden lesbarem Deutsch: Was soll geschehen und wo, warum jetzt (Auftrag oder Vorgang),
 * welche Wirkung, welches Risiko, wie macht man es rückgängig. Er enthält keine Geheimnisse und nicht den rohen Befehl
 * (der steht im eigenen Feld `befehl`).
 *
 * Entstehung: bevorzugt vom Modell über das Pflichtfeld `kontext` des Werkzeugs `freigabe_bitten`. Dieses Modul prüft ihn
 * (Satzzahl, Länge, Geheimnisse, Befehl im Klartext). Ein Verstoß lehnt die Freigabe nicht ab: Dann gilt der deterministische
 * Rückfalltext aus Quelle, Vorgang, Werkzeug und Ziel, und die Abweichung wird gezählt (Steuerkanal `/zustand`, Schlüssel
 * `freigabe_kontext`). Der Kontext ist nie leer.
 */
import { schwaerzen as redaktion } from './persona/redaktion.js';
import { schwaerzen as meldungSchwaerzen } from './schwaerzen.js';

export const KONTEXT_MAX = 600;
export const SAETZE_MIN = 3;
export const SAETZE_MAX = 5;

const RISIKO = { high: 'hoch', medium: 'mittel', low: 'niedrig' };
const EINZEILIG = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const VORGANG = /\b[A-Z]{2,6}-\d{1,6}\b/;

/** Abkürzungen mit Punkt zählen nicht als Satzende. */
const ABKUERZUNG = /\b(?:z\.\s?B|d\.\s?h|u\.\s?a|u\.\s?U|i\.\s?d\.\s?R|o\.\s?ä|bzw|ca|ggf|evtl|etc|Nr|vgl|inkl|max|min)\./gi;

/** Zählt Sätze: Ende bei . ! ? vor Leerzeichen oder Textende; Abkürzungen und Zahlen wie „3.5“ zählen nicht. */
export function zaehleSaetze(text) {
  const t = EINZEILIG(text).replace(ABKUERZUNG, (m) => m.replace(/\./g, '·'));
  if (!t) return 0;
  const teile = t.split(/(?<=[.!?])["“”)\]]*\s+(?=[A-ZÄÖÜ„"(\[0-9])/u).filter((s) => /[\p{L}\p{N}]/u.test(s));
  return teile.length;
}

const norm = (s) => EINZEILIG(s);

/** Steckt ein Geheimnis im Text (etwas wird beim Schwärzen verändert)? */
export function hatGeheimnis(text) {
  const t = norm(text);
  if (!t) return false;
  return norm(redaktion(t)) !== t || norm(meldungSchwaerzen(t, 100_000)) !== t;
}

/** Schwärzt zuerst mit der Redaktion (Muster wie bei Werkzeugergebnissen), dann mit den Mustern der Meldung. */
function sauber(text, grenze = KONTEXT_MAX) {
  return meldungSchwaerzen(redaktion(String(text ?? '')), grenze);
}

function satz(text) {
  const t = EINZEILIG(text);
  if (!t) return '';
  return /[.!?]["“”)]?$/.test(t) ? t : `${t}.`;
}

/** Das Programm eines Befehls und, wenn erkennbar, das Ziel (Pfad); nie der ganze Befehl. */
export function befehlKurz(befehl) {
  const b = EINZEILIG(befehl);
  if (!b) return { programm: '', ziel: '' };
  const teile = b.split(' ');
  let i = 0;
  while (i < teile.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(teile[i])) i += 1; // Umgebungsvariablen vorweg
  const programm = (teile[i] ?? '').replace(/^.*\//, '').replace(/[^A-Za-z0-9._+-]/g, '').slice(0, 40);
  const pfade = teile.slice(i + 1).filter((t) => !t.startsWith('-') && /[/~]/.test(t) && !/^[a-z]+:\/\//i.test(t));
  const ziel = (pfade[pfade.length - 1] ?? '').replace(/^["']|["']$/g, '').slice(0, 120);
  return { programm, ziel };
}

/**
 * Deterministischer Rückfall aus dem, was der Runner weiß. Immer 3 bis 4 Sätze, nie leer, ohne den rohen Befehl.
 * @param f {aktion, risiko, zerstoererisch, werkzeug, befehl, quelle, bezug, titel, vorgang, wirkung, rueckweg}; wirkung und rueckweg ersetzen die allgemeinen Sätze 3 und 4
 */
export function kontextFallback(f = {}) {
  const aktion = sauber(EINZEILIG(f.aktion) || 'eine nicht näher beschriebene Aktion', 160).replace(/[.!?]+$/, '');
  const bash = f.werkzeug === 'bash' || (!f.werkzeug && f.befehl);
  const { programm, ziel } = befehlKurz(f.befehl);
  const womit = [];
  if (bash) womit.push(programm ? `Shell-Befehl „${programm}“` : 'Shell-Befehl');
  else if (f.werkzeug) womit.push(`Werkzeug ${sauber(f.werkzeug, 80)}`);
  if (ziel) womit.push(`Ziel ${sauber(ziel, 120)}`);
  const s1 = `Der Agent bittet um Freigabe für „${aktion}“${womit.length ? ` (${womit.join(', ')})` : ''}.`;

  const vorgang = EINZEILIG(f.vorgang ?? f.bezug) || (VORGANG.exec(`${f.titel ?? ''} ${f.aktion ?? ''}`)?.[0] ?? '');
  const anlass = [];
  if (f.titel) anlass.push(`Auftrag „${sauber(f.titel, 100)}“`);
  if (vorgang) anlass.push(`Vorgang ${sauber(vorgang, 40)}`);
  if (f.quelle) anlass.push(`Quelle ${sauber(f.quelle, 40)}`);
  const s2 = anlass.length
    ? `Anlass: ${anlass.join(', ')}.`
    : 'Anlass: ein laufender Auftrag; der Agent hat keinen Vorgang genannt.';

  const risiko = RISIKO[f.risiko] ?? 'mittel';
  const zerst = f.zerstoererisch || f.risiko === 'high';
  const wirkung = f.wirkung ? sauber(f.wirkung, 200).replace(/[.!?]+$/, '') : '';
  const s3 = wirkung
    ? `Das Risiko ist ${risiko}: ${wirkung}.`
    : zerst
      ? `Das Risiko ist ${risiko}, weil die Aktion zerstörend wirken oder Daten überschreiben kann.`
      : `Das Risiko ist ${risiko}; die Aktion verändert Dateien oder Systeme, löscht aber nicht ausdrücklich.`;

  const s4 = f.rueckweg
    ? satz(sauber(f.rueckweg, 200))
    : zerst
      ? 'Ablehnen verwirft sie ohne Wirkung; nach einer Zustimmung lässt sich das Ergebnis nur aus Sicherung oder Versionsverwaltung zurückholen.'
      : 'Ablehnen verwirft sie ohne Wirkung; nach einer Zustimmung macht man sie mit einer Gegenaktion oder aus der Versionsverwaltung rückgängig.';

  const text = [s1, s2, s3, s4].join(' ');
  return text.length <= KONTEXT_MAX ? text : `${text.slice(0, KONTEXT_MAX - 1)}…`;
}

/** Zähler für /zustand: wie oft der Kontext vom Modell kam, wie oft der Rückfall nötig war und warum. */
export class KontextZaehler {
  constructor() {
    this.zuruecksetzen();
  }

  zuruecksetzen() {
    this.modell = 0;
    this.rueckfall = 0;
    this.abweichung = { fehlt: 0, zu_lang: 0, saetze: 0, geheimnis: 0, befehl: 0 };
    this.letzte = null;
  }

  zaehlen(erg) {
    if (erg.herkunft === 'modell') this.modell += 1;
    else this.rueckfall += 1;
    if (erg.abweichung) {
      this.abweichung[erg.abweichung] = (this.abweichung[erg.abweichung] ?? 0) + 1;
      this.letzte = { abweichung: erg.abweichung, zeit: Date.now() };
    }
  }

  zustand() {
    return { modell: this.modell, rueckfall: this.rueckfall, abweichung: { ...this.abweichung }, letzte: this.letzte };
  }
}

export const kontextZaehler = new KontextZaehler();

/**
 * Prüft den Kontext des Modells. Gibt {text, herkunft: 'modell'|'rueckfall', abweichung: null|Grund} zurück; `text` ist nie leer.
 * Gezählt wird hier nicht (Wiederholungen eines Werkzeugs würden doppelt zählen), das tut der Aufrufer mit `kontextZaehler.zaehlen`.
 * @param roh      Text des Modells (kann fehlen)
 * @param fallback Eingaben für den Rückfall, siehe `kontextFallback`; `befehl` dient auch der Prüfung „kein roher Befehl“
 */
export function kontextPruefen(roh, fallback = {}) {
  const t = EINZEILIG(roh);
  const rueck = (abweichung) => ({ text: kontextFallback(fallback), herkunft: 'rueckfall', abweichung });
  if (!t) return rueck('fehlt');
  if (t.length > KONTEXT_MAX) return rueck('zu_lang');
  if (hatGeheimnis(t)) return rueck('geheimnis');
  const befehl = EINZEILIG(fallback.befehl);
  if (befehl.length >= 8 && t.includes(befehl)) return rueck('befehl');
  const n = zaehleSaetze(t);
  if (n < SAETZE_MIN || n > SAETZE_MAX) return rueck('saetze');
  return { text: t, herkunft: 'modell', abweichung: null };
}

/** Kürzt auf ganze Sätze, soweit sie in `max` Zeichen passen; passt nicht einmal der erste, wird hart gekürzt. */
export function kontextKuerzen(text, max = KONTEXT_MAX) {
  const t = EINZEILIG(text);
  if (t.length <= max) return t;
  const teile = t.split(/(?<=[.!?])\s+/u);
  let aus = '';
  for (const s of teile) {
    const naechst = aus ? `${aus} ${s}` : s;
    if (naechst.length > max) break;
    aus = naechst;
  }
  return aus || `${t.slice(0, Math.max(max - 1, 0))}…`;
}

/**
 * Der Kontext einer gespeicherten Freigabe für die Anzeige und die Meldung: der vorhandene (geschwärzt), sonst der Rückfall.
 * So haben auch Freigaben ohne Kontext (ältere Einträge) einen lesbaren Text.
 */
export function kontextAnzeigen(f = {}, extra = {}) {
  const vorhanden = EINZEILIG(f.kontext);
  if (vorhanden) return sauber(vorhanden, KONTEXT_MAX);
  return kontextFallback({
    aktion: f.aktion,
    risiko: f.risiko,
    zerstoererisch: f.zerstoererisch,
    werkzeug: f.werkzeug,
    befehl: f.befehl,
    titel: extra.titel ?? f.gespraechTitel,
    ...extra,
  });
}
