/**
 * i18n.js — language of the texts a human or the model reads (`pi_durable.sprache`: `de` | `en`).
 *
 * The default is German (`de`), so an existing installation keeps its texts unchanged. The public image and the local mode
 * set `en`. The language is process-wide: a runner process serves one configuration. `spracheSetzen` is called once at
 * start (index.js, lokal.js) and by tests.
 *
 * Two helpers:
 * - `tx(de, en)` picks the text for the current language (inline pairs, used for prompts, tool descriptions, messages).
 * - `fehlerText(text)` translates a known German API error message (exact or by pattern) to English; unknown texts stay.
 *   This keeps the many `throw new …Fehler('…')` sites unchanged and translates once at the HTTP boundary.
 */

export const SPRACHEN = ['de', 'en'];
export const SPRACHE_VORGABE = 'de';

let aktuell = SPRACHE_VORGABE;

/** Normalise a language value (`de`, `en`, `en-US`, `English` …); unknown values give `null`. */
export function spracheNormalisieren(wert) {
  const s = String(wert ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('en')) return 'en';
  if (s.startsWith('de')) return 'de';
  return null;
}

/** Set the process language; returns the language in effect. */
export function spracheSetzen(wert) {
  aktuell = spracheNormalisieren(wert) ?? SPRACHE_VORGABE;
  return aktuell;
}

/** The current process language (`de` | `en`). */
export function sprache() {
  return aktuell;
}

export const istEnglisch = () => aktuell === 'en';

/** Text for the current language: `tx('Gespräch', 'Conversation')`. */
export function tx(de, en) {
  return aktuell === 'en' && en !== undefined ? en : de;
}

/**
 * German API error messages → English. Exact strings first, then patterns (the first match wins).
 * Patterns keep the variable parts (`$1` …).
 */
const FEHLER_EXAKT = new Map([
  ['Ungültige Adresse', 'Invalid address'],
  ['Code ungültig, abgelaufen oder schon benutzt', 'Code invalid, expired or already used'],
  ['Nicht erlaubt', 'Not allowed'],
  ['Fehler', 'Error'],
  ['Ungültiges JSON', 'Invalid JSON'],
  ['Sprachkanal nicht eingerichtet', 'Voice channel not set up'],
  ['Methode nicht erlaubt', 'Method not allowed'],
  ['Verwaltung nicht eingerichtet', 'Administration not set up'],
  ['Befehle verlangen das Token im Kopf Authorization: Bearer', 'Commands require the token in the header Authorization: Bearer'],
  ['Nur POST', 'POST only'],
  ['Kopf X-FYOS-Agent: 1 fehlt', 'Header X-FYOS-Agent: 1 missing'],
  ['Das Token im Kopf Authorization: Bearer fehlt oder gilt nicht', 'The token in the header Authorization: Bearer is missing or invalid'],
  ['Kein Token eingerichtet: ein Code ist nicht nötig', 'No token configured: a code is not needed'],
  ['Zu viele offene Codes', 'Too many open codes'],
  ['ordner muss ein absoluter Pfad (Text) sein', 'ordner must be an absolute path (text)'],
  ['Gespräch nicht gefunden', 'Conversation not found'],
  ['Ruhe (tief): Nachrichten werden nicht bearbeitet, bis die Ruhe aufgehoben ist', 'Quiet (deep): messages are not processed until quiet is lifted'],
  ['Lauf nicht gefunden', 'Run not found'],
  ['Pilot nicht gefunden', 'Pilot not found'],
  ['Nacht nicht gefunden', 'Night not found'],
  ['gespraech muss eine Nummer sein', 'gespraech must be a number'],
  ['Ungültiger Pfad', 'Invalid path'],
  ['Pfad außerhalb des Clients', 'Path outside the client'],
  ['Nicht gefunden', 'Not found'],
  ['Unbekannter Arbeitsbereich', 'Unknown workspace'],
  ['Unbekanntes Modell', 'Unknown model'],
  ['Nachricht ist leer', 'Message is empty'],
  ['Das Gespräch hat noch keinen Eintrag zum Abzweigen', 'The conversation has no entry to branch from yet'],
  ['Entscheidung: erteilt oder abgelehnt', 'Decision: erteilt (granted) or abgelehnt (denied)'],
  ['entscheidung: erteilt oder abgelehnt', 'entscheidung: erteilt (granted) or abgelehnt (denied)'],
  ['Freigabe nicht gefunden', 'Approval not found'],
  ['Gespräch zur Freigabe nicht gefunden', 'Conversation of the approval not found'],
  ['Auftrag fehlt', 'Task description missing'],
  ['Vorschlag nicht gefunden', 'Proposal not found'],
  ['status: erledigt oder verworfen', 'status: erledigt (done) or verworfen (discarded)'],
  ['Ungültiger Schlüssel', 'Invalid key'],
  ['Es läuft schon eine Suche, bitte gleich noch einmal', 'A search is already running, please try again shortly'],
  ['archiv muss 0, 1 oder alle sein', 'archiv must be 0, 1 or alle'],
  ['q fehlt', 'q missing'],
  ['q muss mindestens 2 Zeichen haben', 'q must have at least 2 characters'],
  ['an: true oder false', 'an: true or false'],
  ['sofort: true oder false', 'sofort: true or false'],
  ['bis: ISO-Zeitpunkt erwartet', 'bis: ISO timestamp expected'],
  ['bis liegt nicht in der Zukunft', 'bis is not in the future'],
  ['Pfad fehlt oder ist kein Text', 'Path missing or not text'],
  ['Pfad enthält ein Nullbyte', 'Path contains a null byte'],
  ['Pfad zu lang', 'Path too long'],
  ['Pfad muss absolut sein', 'Path must be absolute'],
  ['Ordnerwahl nicht freigegeben (keine erlaubten Wurzeln eingerichtet)', 'Folder selection not enabled (no allowed roots configured)'],
  ['Pfade mit „..“ sind nicht erlaubt', 'Paths with “..” are not allowed'],
  ['Pfad liegt außerhalb der erlaubten Wurzeln', 'Path is outside the allowed roots'],
  ['Ordner nicht gefunden', 'Folder not found'],
  ['Zugriff auf den Ordner verwehrt', 'Access to the folder denied'],
  ['Pfad führt (über einen Link) aus den erlaubten Wurzeln hinaus', 'Path leads (via a link) outside the allowed roots'],
  ['Das ist kein Ordner', 'This is not a folder'],
  ['Dieser Ordner ist gesperrt (deutet auf Geheimnisse hin)', 'This folder is blocked (suggests secrets)'],
  ['Die Wurzel des Dateisystems kann keine erlaubte Wurzel sein', 'The file system root cannot be an allowed root'],
  ['max muss eine ganze Zahl ab 1 sein', 'max must be an integer of at least 1'],
  ['Diese Datei ist gesperrt (deutet auf Geheimnisse hin)', 'This file is blocked (suggests secrets)'],
  ['Datei nicht gefunden', 'File not found'],
  ['Zugriff auf die Datei verwehrt', 'Access to the file denied'],
  ['Zu viele Links hintereinander', 'Too many links in a row'],
  ['Pfad führt (über einen Link) aus dem erlaubten Bereich hinaus', 'Path leads (via a link) outside the allowed area'],
  ['Das ist keine reguläre Datei', 'This is not a regular file'],
  ['Zugmessung nicht eingebaut', 'Turn measurement not built in'],
  ['Eingang nicht eingebaut', 'Inbox not built in'],
  ['Neustart nicht eingebaut', 'Restart not built in'],
  ['Sprachkanal aus', 'Voice channel off'],
  ['Text fehlt', 'Text missing'],
  ['Äußerung zu lang (höchstens 2000 Zeichen)', 'Utterance too long (at most 2000 characters)'],
  ['Sprachsitzung nicht aktiv (zuerst POST /api/sprache/sitzung)', 'Voice session not active (first POST /api/sprache/sitzung)'],
  ['Kein Zielgespräch', 'No target conversation'],
  ['Sprach-Agent aus (sprache.agent.an)', 'Voice agent off (sprache.agent.an)'],
  ['Sprach-Agent nicht eingeschaltet (sprache.agent.an)', 'Voice agent not enabled (sprache.agent.an)'],
  ['modus: abbrechen oder fortfuehren', 'modus: abbrechen (cancel) or fortfuehren (continue)'],
  ['Diese Freigabe wurde nicht gerade vorgelesen; bitte in der App entscheiden', 'This approval was not just read aloud; please decide in the app'],
  ['Per Stimme nur über die AirPods, über die vorgelesen wurde', 'By voice only through the headphones it was read on'],
  ['Dieses Risiko entscheidest du in der App (Halten)', 'Decide this risk in the app (hold)'],
  ['antwort: ja, spaeter oder nein', 'antwort: ja (yes), spaeter (later) or nein (no)'],
  ['Der Runner antwortet nicht rechtzeitig.', 'The runner does not answer in time.'],
]);

const FEHLER_MUSTER = [
  [/^Anfrage größer als (\d+) Bytes$/, 'Request larger than $1 bytes'],
  [/^Unbekannte Route: (.*)$/, 'Unknown route: $1'],
  [/^Ordner abgelehnt \(([^)]*)\): (.*)$/, (m) => `Folder rejected (${m[1]}): ${fehlerText(m[2])}`],
  [/^Unbekannter Arbeitsbereich: (.*)$/, 'Unknown workspace: $1'],
  [/^Unbekanntes Modell: (.*)$/, 'Unknown model: $1'],
  [/^Freigabe ist bereits (.*)$/, 'Approval is already $1'],
  [/^q darf höchstens (\d+) Zeichen haben$/, 'q may have at most $1 characters'],
  [/^q darf höchstens (\d+) Wörter haben$/, 'q may have at most $1 words'],
  [/^limit muss eine ganze Zahl von 1 bis (\d+) sein$/, 'limit must be an integer from 1 to $1'],
  [/^stufe: (.*)$/, (m) => `stufe: ${m[1].replaceAll(' oder ', ' or ')}`],
  [/^bis liegt mehr als (\d+) Tage voraus$/, 'bis is more than $1 days ahead'],
  [/^max darf höchstens (\d+) Byte sein$/, 'max may be at most $1 bytes'],
  [/^frist_s: 0 bis (\d+) Sekunden$/, 'frist_s: 0 to $1 seconds'],
  [/^Persona ruht \((.*)\)$/, 'Persona is resting ($1)'],
  [/^Zielgespräch (.*) fehlt$/, 'Target conversation $1 missing'],
];

/** Translate a German API error message for the current language; unknown texts stay as they are. */
export function fehlerText(text) {
  const s = String(text ?? '');
  if (aktuell !== 'en' || !s) return s;
  const exakt = FEHLER_EXAKT.get(s);
  if (exakt) return exakt;
  for (const [muster, ersatz] of FEHLER_MUSTER) {
    const m = muster.exec(s);
    if (!m) continue;
    return typeof ersatz === 'function' ? ersatz(m) : s.replace(muster, ersatz);
  }
  return s;
}
