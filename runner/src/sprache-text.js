/**
 * sprache-text.js — Text für die Stimme: sprechbar machen und in Häppchen zerlegen.
 *
 * Reine Funktionen und ein kleiner Zerleger, ohne Netz und ohne Zustand des Runners (docs/current/RUNNER-SPRACHE.md#text).
 * Die Stimme (VoxCPM2 auf Hauptserver, `/sprechen`) liest, was sie bekommt: Markdown-Zeichen, Pfade, Hashes und Tabellen
 * würden vorgelesen. Hier wird alles entfernt, was man nicht hören will, und was man hören will (Zahlen, Uhrzeiten, Daten,
 * Einheiten) in deutsche Wörter gesetzt.
 *
 *   sprechbar(text)        → Text für die Stimme (leer, wenn nichts Sprechbares bleibt)
 *   zahlWort(n)            → 2026 → „zweitausendsechsundzwanzig“
 *   new Satzstrom().schiebe(delta) → fertige Häppchen; .ende() → Rest
 */

// --- Zahlen ----------------------------------------------------------------------------------

const EINER = ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn', 'sechzehn', 'siebzehn', 'achtzehn', 'neunzehn'];
const ZEHNER = ['', '', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig'];

/** 1..999 in Wörtern; `eins` am Ende bleibt `eins`, davor `ein`. */
function unter1000(n, endeEins = true) {
  if (n < 20) return n === 1 && !endeEins ? 'ein' : EINER[n];
  if (n < 100) {
    const z = Math.floor(n / 10);
    const e = n % 10;
    if (e === 0) return ZEHNER[z];
    return `${e === 1 ? 'ein' : EINER[e]}und${ZEHNER[z]}`;
  }
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const kopf = `${h === 1 ? 'ein' : EINER[h]}hundert`;
  return rest === 0 ? kopf : kopf + unter1000(rest, endeEins);
}

/** Ganze Zahl in deutschen Wörtern (bis unter einer Billion); größere Zahlen Ziffer für Ziffer. */
export function zahlWort(n, { jahr = false } = {}) {
  if (!Number.isInteger(n) || n < 0) return String(n);
  if (n < 1000) return unter1000(n);
  if (jahr && n >= 1100 && n < 2000) {
    const h = Math.floor(n / 100);
    const rest = n % 100;
    return `${unter1000(h)}hundert${rest ? unter1000(rest) : ''}`;
  }
  if (n >= 1e12) return ziffernWorte(String(n));
  const teile = [];
  const mrd = Math.floor(n / 1e9);
  const mio = Math.floor((n % 1e9) / 1e6);
  const tsd = Math.floor((n % 1e6) / 1e3);
  const rest = n % 1e3;
  if (mrd) teile.push(mrd === 1 ? 'eine Milliarde ' : `${unter1000(mrd)} Milliarden `);
  if (mio) teile.push(mio === 1 ? 'eine Million ' : `${unter1000(mio)} Millionen `);
  if (tsd) teile.push(`${unter1000(tsd, false)}tausend`);
  if (rest) teile.push(unter1000(rest));
  return teile.join('').trim();
}

/** „1234“ → „eins zwei drei vier“ (Kennungen, Telefonnummern, riesige Zahlen). */
export function ziffernWorte(ziffern) {
  return String(ziffern)
    .replace(/\D/g, '')
    .split('')
    .map((z) => EINER[Number(z)])
    .join(' ');
}

const ORD_SONDER = { 1: 'erst', 3: 'dritt', 7: 'siebt', 8: 'acht' };

/** Ordnungszahl als Stamm mit Endung: 25 → „fünfundzwanzigste“, mit `dativ` „fünfundzwanzigsten“. */
export function ordnungsWort(n, { dativ = false } = {}) {
  if (!Number.isInteger(n) || n < 1 || n > 99) return String(n);
  let wort;
  if (n < 20) wort = ORD_SONDER[n] ? `${ORD_SONDER[n]}e` : `${EINER[n]}te`;
  else {
    const z = Math.floor(n / 10);
    const e = n % 10;
    wort = e === 0 ? `${ZEHNER[z]}ste` : `${e === 1 ? 'ein' : EINER[e]}und${ZEHNER[z]}ste`;
  }
  return dativ ? `${wort}n` : wort;
}

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MONAT_RE = MONATE.join('|');
const DATIV_VOR = /(?:^|[\s(])(am|vom|zum|dem|im|ab|bis|seit|vor|nach|zwischen|und)\s*$/i;

// --- Abkürzungen -----------------------------------------------------------------------------

const ABKUERZUNGEN = [
  [/\bz\.\s?B\./g, 'zum Beispiel'],
  [/\bd\.\s?h\./g, 'das heißt'],
  [/\bu\.\s?a\./g, 'unter anderem'],
  [/\bu\.\s?U\./g, 'unter Umständen'],
  [/\bs\.\s?o\./g, 'siehe oben'],
  [/\bs\.\s?u\./g, 'siehe unten'],
  [/\bbzw\./gi, 'beziehungsweise'],
  [/\busw\./gi, 'und so weiter'],
  [/\betc\./gi, 'und so weiter'],
  [/\bggf\./gi, 'gegebenenfalls'],
  [/\bevtl\./gi, 'eventuell'],
  [/\binkl\./gi, 'inklusive'],
  [/\bca\./gi, 'circa'],
  [/\bNr\./g, 'Nummer'],
  [/\bvgl\./gi, 'vergleiche'],
  [/\bggü\./gi, 'gegenüber'],
];

/** Wörter, nach deren Punkt kein Satz endet (für den Zerleger; klein geschrieben, ohne Punkt). */
const KEIN_SATZENDE = new Set(['z', 'b', 'd', 'h', 'u', 'a', 's', 'o', 'bzw', 'usw', 'etc', 'ggf', 'evtl', 'inkl', 'ca', 'nr', 'vgl', 'ggü', 'dr', 'prof', 'hr', 'fr', 'tel', 'str', 'abs', 'ev', 'bsp', 'ff']);

// --- Einheiten -------------------------------------------------------------------------------

const EINHEITEN = [
  ['tok/s', 'Token pro Sekunde'],
  ['GiB', 'Gibibyte'],
  ['MiB', 'Mebibyte'],
  ['KiB', 'Kibibyte'],
  ['TB', 'Terabyte'],
  ['GB', 'Gigabyte'],
  ['MB', 'Megabyte'],
  ['KB', 'Kilobyte'],
  ['kHz', 'Kilohertz'],
  ['MHz', 'Megahertz'],
  ['GHz', 'Gigahertz'],
  ['Hz', 'Hertz'],
  ['°C', 'Grad'],
  ['°', 'Grad'],
  ['km', 'Kilometer'],
  ['cm', 'Zentimeter'],
  ['mm', 'Millimeter'],
  ['kg', 'Kilogramm'],
  ['ms', 'Millisekunden'],
  ['min', 'Minuten'],
  ['Std', 'Stunden'],
  ['kW', 'Kilowatt'],
  ['kWh', 'Kilowattstunden'],
  ['W', 'Watt'],
  ['s', 'Sekunden'],
  ['h', 'Stunden'],
  ['m', 'Metern'],
  ['g', 'Gramm'],
  ['V', 'Volt'],
  ['A', 'Ampere'],
];
const EINHEIT_RE = EINHEITEN.map(([k]) => k.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|');

const dezimal = (ganz, nach) => `${zahlWortLang(ganz)} Komma ${nach.split('').map((z) => EINER[Number(z)]).join(' ')}`;
const zahlWortLang = (text) => {
  const s = String(text).replace(/^0+(?=\d)/, '');
  return s.length > 12 ? ziffernWorte(s) : zahlWort(Number(s));
};

// --- sprechbar -------------------------------------------------------------------------------

/**
 * Macht einen Text vorlesbar. Gibt `''` zurück, wenn nichts Sprechbares bleibt. Idempotent genug für die Praxis:
 * zweimal angewendet ändert sich nichts mehr.
 */
export function sprechbar(roh) {
  let t = String(roh ?? '');

  // Code-Blöcke (auch unvollständige) und Tabellenzeilen fallen weg.
  t = t.replace(/```[\s\S]*?(```|$)/g, ' ');
  t = t
    .split('\n')
    .filter((z) => !/^\s*\|/.test(z))
    .join('\n');

  // Bilder und Links: der Linktext bleibt, die Adresse nicht.
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  t = t.replace(/\bhttps?:\/\/[^\s)>\]]+/gi, 'Link').replace(/\bwww\.[^\s)>\]]+/gi, 'Link');

  // Inline-Code: kurze Wörter bleiben, alles mit Zeichen von Befehlen und Pfaden fällt weg.
  t = t.replace(/`([^`]*)`/g, (_, innen) => (/^[\p{L}\p{N} _-]{1,24}$/u.test(innen) ? innen.replace(/_/g, ' ') : ''));

  // Pfade: nur der letzte Teil, Punkte gesprochen.
  const PFAD = /\b[A-Za-z_@][\w.@+-]*(?:\/[\w.@+-]+){2,}\/?|\b[A-Za-z_@][\w.@+-]*(?:\/[\w.@+-]+)*\/[\w@+-]+\.[A-Za-z]{1,6}\b|(?:~|[A-Za-z]:)?(?:[\\/][\w.@+-]+){2,}[\\/]?/g;
  t = t.replace(PFAD, (p) => {
    const teile = p.split(/[\\/]/).filter(Boolean);
    return (teile.at(-1) ?? '').replace(/\./g, ' Punkt ');
  });

  // Kennungen: Hashes, UUIDs, lange Tokens → weg; Ticketnummern (CHG-1234) → Buchstaben und Ziffern einzeln.
  t = t.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'eine Kennung');
  t = t.replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, 'eine Kennung');
  t = t.replace(/\b[A-Za-z0-9+_-]{28,}\b/g, 'eine Kennung');
  t = t.replace(/\b([A-Z]{2,6})-(\d{2,6})\b/g, (_, b, z) => `${b.split('').join(' ')} ${ziffernWorte(z)}`);

  // Markdown-Zeichen.
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/^\s*>+\s?/gm, '');
  t = t.replace(/^\s*(?:[-*•]|\d{1,2}[.)])\s+/gm, '');
  t = t.replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2');
  t = t.replace(/[*~#]+/g, ' ').replace(/^-{3,}$/gm, ' ');

  // Abkürzungen vor der Zahlenverarbeitung (sie enthalten Punkte).
  for (const [re, ersatz] of ABKUERZUNGEN) t = t.replace(re, ersatz);

  // Daten: 25.10.2026, 2026-10-25, 25.10.
  const datum = (tag, monat, jahr, vor) => {
    const m = MONATE[Number(monat) - 1];
    if (!m || Number(tag) < 1 || Number(tag) > 31) return null;
    const o = ordnungsWort(Number(tag), { dativ: DATIV_VOR.test(vor) });
    return `${o} ${m}${jahr ? ` ${zahlWort(Number(jahr), { jahr: true })}` : ''}`;
  };
  t = t.replace(/(\d{4})-(\d{2})-(\d{2})(?!\d)/g, (g, j, m, d, off, s) => datum(d, m, j, s.slice(0, off)) ?? g);
  t = t.replace(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\d)/g, (g, d, m, j, off, s) => datum(d, m, j, s.slice(0, off)) ?? g);
  t = t.replace(/\b(\d{1,2})\.(\d{1,2})\.(?!\d)/g, (g, d, m, off, s) => datum(d, m, null, s.slice(0, off)) ?? g);
  t = t.replace(new RegExp(`\\b(\\d{1,2})\\.\\s?(${MONAT_RE})\\b`, 'g'), (g, d, mon, off, s) => `${ordnungsWort(Number(d), { dativ: DATIV_VOR.test(s.slice(0, off)) })} ${mon}`);

  // Uhrzeiten: 14:30, 9:05, 14:00 Uhr
  t = t.replace(/\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?(\s*Uhr)?\b/g, (_, h, m) => `${zahlWort(Number(h))} Uhr${Number(m) ? ` ${zahlWort(Number(m))}` : ''}`);

  // Geld, Prozent, Einheiten
  t = t.replace(/(\d+)(?:[,.](\d{2}))?\s?(?:€|EUR\b)/g, (_, e, c) => `${zahlWort(Number(e))} Euro${c && Number(c) ? ` ${zahlWort(Number(c))}` : ''}`);
  t = t.replace(/(\d+(?:[.,]\d+)?)\s?%/g, '$1 Prozent');
  t = t.replace(new RegExp(`(\\d+(?:[.,]\\d+)?)\\s?(${EINHEIT_RE})(?![\\p{L}\\d])`, 'gu'), (_, z, e) => `${z} ${EINHEITEN.find(([k]) => k === e)?.[1] ?? e}`);

  // Versionen und Dezimalzahlen
  t = t.replace(/\b(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?\b/g, (g) => g.split('.').map((z) => zahlWortLang(z)).join(' Punkt '));
  t = t.replace(/\b\d{1,3}(?:\.\d{3})+(?![\d,])/g, (g) => zahlWortLang(g.replace(/\./g, '')));
  t = t.replace(/\b(\d+)[,.](\d+)\b/g, (_, g, n) => dezimal(g, n));
  t = t.replace(/\b(\d+)\s?[-–]\s?(\d+)\b/g, '$1 bis $2');
  t = t.replace(/(^|[\s(])-(\d)/g, '$1minus $2');
  t = t.replace(/\b\d+\b/g, (z) => (z.length > 12 ? ziffernWorte(z) : zahlWort(Number(z))));

  // Zeichen
  t = t.replace(/&/g, ' und ').replace(/[→⇒➜]|->|=>/g, ' ').replace(/≈/g, ' circa ').replace(/\+/g, ' plus ');
  t = t.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '');
  t = t.replace(/[<>{}[\]|\\^=]/g, ' ');

  // Zeilen werden Sätze: ohne Satzzeichen am Zeilenende einen Punkt setzen.
  t = t
    .split('\n')
    .map((z) => z.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((z) => (/[.!?…:;]$/.test(z) ? z : `${z}.`))
    .join(' ');
  t = t.replace(/\s+([.,;:!?])/g, '$1').replace(/([.!?])\1+/g, '$1').replace(/\s+/g, ' ').trim();
  return /[\p{L}\p{N}]/u.test(t) ? t : '';
}

// --- Zerlegen --------------------------------------------------------------------------------

/**
 * Setzt einen Strom von Textteilen (Deltas) zu Häppchen für die Stimme zusammen.
 *  - Satzende an `. ! ? …` und an Zeilenenden; Abkürzungen, Dezimalzahlen und Ordnungszahlen vor Monatsnamen enden keinen Satz.
 *  - Das erste Häppchen darf früher an einem Komma enden (`ersteMin` Zeichen), damit der erste Ton früh kommt.
 *  - Ein Satz über `max` Zeichen wird an einem Komma oder Leerzeichen geteilt.
 *  - Code-Blöcke werden verworfen (`uebersprungen.code`), Tabellenzeilen ebenso (`uebersprungen.tabelle`).
 * Die Häppchen sind noch roher Text; `sprechbar()` macht sie vorlesbar.
 */
export class Satzstrom {
  constructor({ ersteMin = 36, ersteMax = 90, max = 220 } = {}) {
    this.ersteMin = ersteMin;
    this.ersteMax = ersteMax;
    this.max = max;
    this.neu();
  }

  neu() {
    this.puffer = '';
    this.imCode = false;
    this.anzahl = 0;
    this.uebersprungen = { code: false, tabelle: false };
  }

  /** Neuer Text; liefert die dadurch fertig gewordenen Häppchen (`{text, erste, liste}`). */
  schiebe(delta) {
    const aus = [];
    this.puffer += String(delta ?? '');
    for (;;) {
      if (this.imCode) {
        const i = this.puffer.indexOf('```');
        if (i < 0) {
          this.puffer = this.puffer.slice(-2);
          return aus;
        }
        this.puffer = this.puffer.slice(i + 3);
        this.imCode = false;
        this.uebersprungen.code = true;
        continue;
      }
      const f = this.puffer.indexOf('```');
      if (f < 0) break;
      // Vor der Schranke ist Text; was danach folgt, ist Code, bis sie sich schließt.
      const nach = this.puffer.slice(f + 3);
      this.puffer = this.puffer.slice(0, f);
      this.#abschneiden(aus, true);
      this.puffer = nach;
      this.imCode = true;
    }
    this.#abschneiden(aus, false);
    return aus;
  }

  /** Alles Restliche als letztes Häppchen. */
  ende() {
    const aus = [];
    if (!this.imCode) this.#abschneiden(aus, true);
    this.puffer = '';
    this.imCode = false;
    return aus;
  }

  #emit(aus, roh) {
    const zeilen = roh.split('\n');
    const behalten = [];
    for (const z of zeilen) {
      if (/^\s*\|/.test(z)) {
        this.uebersprungen.tabelle = true;
        continue;
      }
      behalten.push(z);
    }
    const text = behalten.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const liste = /^\s*(?:[-*•]|\d{1,2}[.)])\s+/.test(roh);
    aus.push({ text, erste: this.anzahl === 0, liste });
    this.anzahl += 1;
  }

  /** Häppchen aus dem Puffer lösen; `alles` nimmt auch den unfertigen Rest. */
  #abschneiden(aus, alles) {
    for (;;) {
      const p = this.puffer;
      let ende = -1;
      for (let i = 0; i < p.length; i += 1) {
        const c = p[i];
        if (c === '\n') {
          ende = i + 1;
          break;
        }
        if (c !== '.' && c !== '!' && c !== '?' && c !== '…') continue;
        // Mehrfach-Satzzeichen und schließende Anführungszeichen gehören zum Satz.
        let j = i;
        while (j + 1 < p.length && /[.!?…"“”»«)]/.test(p[j + 1])) j += 1;
        if (j + 1 >= p.length) break; // Was folgt, ist noch unbekannt.
        if (!/\s/.test(p[j + 1])) {
          i = j;
          continue; // „3.5“, „sprache.js“
        }
        // Nach dem Leerraum muss ein Zeichen kommen, sonst ist die Entscheidung noch offen.
        let k = j + 1;
        while (k < p.length && /[ \t]/.test(p[k])) k += 1;
        if (k >= p.length) break;
        if (c === '.' && !this.#satzEnde(p, i, k)) {
          i = j;
          continue;
        }
        ende = j + 1;
        break;
      }
      if (ende < 0) {
        const fruehes = this.anzahl === 0 ? this.#fruehEnde(p) : -1;
        if (fruehes > 0) ende = fruehes;
        else if (p.length > this.max) ende = this.#teilEnde(p);
        else if (alles && p.trim()) ende = p.length;
      }
      if (ende < 0) return;
      const roh = p.slice(0, ende);
      this.puffer = p.slice(ende);
      this.#emit(aus, roh);
    }
  }

  /** Endet der Satz am Punkt an Stelle `i`, wenn das nächste Wort bei `k` beginnt? */
  #satzEnde(p, i, k) {
    const davor = p.slice(0, i);
    const wort = /([\p{L}\p{N}]+)$/u.exec(davor)?.[1] ?? '';
    if (KEIN_SATZENDE.has(wort.toLowerCase())) return false;
    if (/^\p{L}$/u.test(wort)) return false; // einzelner Buchstabe: „z. B.“, Initialen
    const danach = p.slice(k);
    if (/^\d+$/.test(wort) && Number(wort) <= 31) {
      if (new RegExp(`^(${MONAT_RE})\\b`).test(danach)) return false; // „am 25. Oktober“
      if (/^\p{Ll}/u.test(danach)) return false; // „der 3. dritte“
    }
    return true;
  }

  /** Erstes Häppchen früher beenden: Komma ab `ersteMin`, notfalls Leerzeichen ab `ersteMax`. */
  #fruehEnde(p) {
    if (p.length < this.ersteMin) return -1;
    const re = /[,;:–—](?=\s)/g;
    let m;
    while ((m = re.exec(p))) {
      if (m.index + 1 >= this.ersteMin && m.index + 1 < p.length - 1) return m.index + 1;
    }
    if (p.length >= this.ersteMax) {
      const i = p.lastIndexOf(' ', this.ersteMax);
      if (i >= this.ersteMin) return i + 1;
    }
    return -1;
  }

  /** Zu langen Satz teilen: letztes Komma vor `max`, sonst letztes Leerzeichen, sonst hart. */
  #teilEnde(p) {
    const fenster = p.slice(0, this.max);
    const komma = Math.max(fenster.lastIndexOf(', '), fenster.lastIndexOf('; '));
    if (komma > this.max / 3) return komma + 2;
    const leer = fenster.lastIndexOf(' ');
    return leer > this.max / 3 ? leer + 1 : this.max;
  }
}
