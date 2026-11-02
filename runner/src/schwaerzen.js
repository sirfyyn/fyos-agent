/**
 * schwaerzen.js — Zugangsdaten und lange Zeichenketten aus kurzen Texten entfernen (Freigabe-Meldung, Freigabe-Kontext).
 * Herausgelöst aus freigabe-meldung.js, damit freigabe-kontext.js und freigabe-meldung.js sich nicht gegenseitig einbinden.
 */
import { kurz } from './wachen-zustand.js';

const SCHWAERZEN = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer ***'],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '***'],
  [/\b(?:ghp|gho|ghs|ghu|github_pat|glpat|xox[abeprs]|syt|sk|pk|rk|AKIA)[-_][A-Za-z0-9_-]{8,}/g, '***'],
  [/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1***@'],
  [/\b(authorization|token|passwort|password|passwd|pwd|secret|geheimnis|api[_-]?key|apikey|access[_-]?key|private[_-]?key)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2***'],
  [/(--?(?:password|passwort|token|secret|api-key)[= ])\S+/gi, '$1***'],
  // Lange Zeichenfolgen mit Buchstaben und Ziffern sind fast immer Schlüssel; Pfade und reine Wörter bleiben.
  [/[A-Za-z0-9+_=-]{32,}/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? '***' : m)],
];

const PRIVATER_SCHLUESSEL = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;

/**
 * Wie `schwaerzen`, aber für mehrzeilige Dateiinhalte: Zeilenumbrüche und Einrückung bleiben, jede Zeile wird für sich
 * geprüft, private Schlüsselblöcke fallen ganz weg. Gibt `{ text, geschwaerzt }` zurück.
 */
export function schwaerzenText(wert) {
  const roh = String(wert ?? '');
  let t = roh.replace(PRIVATER_SCHLUESSEL, '***PRIVATE KEY***');
  t = t
    .split('\n')
    .map((zeile) => {
      let z = zeile;
      for (const [muster, ersatz] of SCHWAERZEN) z = z.replace(muster, ersatz);
      return z;
    })
    .join('\n');
  return { text: t, geschwaerzt: t !== roh };
}

/** Entfernt Zugangsdaten und lange Zeichenketten und macht aus dem Text eine Zeile. */
export function schwaerzen(wert, grenze = 200) {
  let t = String(wert ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [muster, ersatz] of SCHWAERZEN) t = t.replace(muster, ersatz);
  return kurz(t, grenze);
}
