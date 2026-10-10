/**
 * einrichtung.mjs — die testbare Logik der Ersteinrichtung als Gespräch.
 *
 * Getrennt von `index.mjs` aus demselben Grund wie bei den anderen Plugins: `index.mjs` importiert das SDK,
 * und das gibt es nur im laufenden Gateway.
 *
 * Der Renderer (fyos_agent/einrichtung.py) legt beim ersten Start BOOTSTRAP.md in den Workspace. Darin steht das
 * Kennenlern-Gespräch. Am Ende ruft der Agent das Werkzeug `fyos_ersteinrichtung` auf; es trägt die Angaben in
 * USER.md und IDENTITY.md ein und löscht BOOTSTRAP.md zuletzt. Fehlt BOOTSTRAP.md, gibt es das Werkzeug nicht
 * mehr und ein Aufruf ändert nichts: die Einrichtung kommt nie wieder.
 *
 * Der Agent hat in der Vorlage kein Schreibwerkzeug, deshalb ist dieses Werkzeug der einzige Weg. Es nimmt nur
 * kurze einzeilige Werte an und schreibt ausschließlich in den Workspace, den das Gateway nennt.
 */
import { existsSync } from 'node:fs';
import { readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const TOOL = 'fyos_ersteinrichtung';
export const BOOTSTRAP = 'BOOTSTRAP.md';
const GRENZEN = {anrede: 60, sprache: 40, agentenname: 40, zweck: 300, grenzen: 400};

/** Ein einzeiliger Text: Steuerzeichen und Zeilenumbrüche werden zu Leerzeichen, der Rest gekürzt. */
export function bereinige(wert, max) {
  return String(wert ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Der Name aus der IANA-Zeitzonen-Datenbank in der Schreibweise, die das System kennt; sonst ein Fehler. */
export function pruefe_zeitzone(wert) {
  const roh = bereinige(wert, 64);
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(roh)) {
    throw new Error('zeitzone: expected an IANA time zone name such as Europe/Berlin');
  }
  try {
    return new Intl.DateTimeFormat('en-US', {timeZone: roh}).resolvedOptions().timeZone;
  } catch {
    throw new Error(`zeitzone: unknown time zone "${roh}"; use an IANA name such as Europe/Berlin`);
  }
}

/** Prüft die Parameter des Werkzeugs und gibt bereinigte Werte zurück; Pflichtfelder fehlen = Fehler. */
export function pruefe_werte(params) {
  const p = params && typeof params === 'object' ? params : {};
  const werte = {};
  for (const feld of ['anrede', 'sprache', 'agentenname']) {
    werte[feld] = bereinige(p[feld], GRENZEN[feld]);
    if (!werte[feld]) throw new Error(`${feld} is required`);
  }
  werte.zeitzone = pruefe_zeitzone(p.zeitzone);
  for (const feld of ['zweck', 'grenzen']) werte[feld] = bereinige(p[feld], GRENZEN[feld]);
  return werte;
}

/** Das Datum in der Zeitzone des Besitzers als JJJJ-MM-TT. */
export function lokales_datum(jetzt, zeitzone) {
  try {
    // en-US ist in jeder Node-Fassung da; aus den Teilen entsteht das Datum unabhängig von Sprachdaten.
    const teile = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: zeitzone, year: 'numeric', month: '2-digit', day: '2-digit'})
      .formatToParts(jetzt).map((teil) => [teil.type, teil.value]));
    return `${teile.year}-${teile.month}-${teile.day}`;
  } catch {
    return jetzt.toISOString().slice(0, 10);
  }
}

const zeilen_von = (text) => String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
const ist_titel = (zeile) => /^#\s+\S/.test(zeile);
const ist_ueberschrift = (zeile) => /^#{1,2}\s/.test(zeile);
const zusammen = (zeilen) => `${zeilen.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '')}\n`;

/**
 * USER.md: Titel und Abschnitt „## Steckbrief“ werden ersetzt, alles andere (etwa „## Arbeitsweise“) bleibt.
 * Gibt es den Abschnitt nicht, kommt er vor die erste andere Überschrift oder ans Ende.
 */
export function aktualisiere_user(alt, werte, datum) {
  const zeilen = zeilen_von(alt);
  const steckbrief = [
    '## Steckbrief',
    `- Anrede: ${werte.anrede}`,
    `- Sprache: ${werte.sprache}`,
    `- Zeitzone: ${werte.zeitzone}`,
    ...(werte.zweck ? [`- Wofür: ${werte.zweck}`] : []),
    ...(werte.grenzen ? [`- Zusätzliche Grenzen: ${werte.grenzen}`] : []),
    `- Ersteinrichtung: abgeschlossen am ${datum}`,
  ];
  const titel = zeilen.findIndex(ist_titel);
  if (titel >= 0) zeilen[titel] = `# ${werte.anrede}`;
  else zeilen.unshift(`# ${werte.anrede}`, '');
  const start = zeilen.findIndex((z) => /^##\s+Steckbrief\s*$/i.test(z));
  if (start >= 0) {
    let ende = zeilen.findIndex((z, i) => i > start && ist_ueberschrift(z));
    if (ende < 0) ende = zeilen.length;
    zeilen.splice(start, ende - start, ...steckbrief, '');
  } else {
    const nach_titel = zeilen.findIndex(ist_titel);
    const erste = zeilen.findIndex((z, i) => i > nach_titel && ist_ueberschrift(z));
    if (erste >= 0) zeilen.splice(erste, 0, ...steckbrief, '');
    else zeilen.push('', ...steckbrief);
  }
  return zusammen(zeilen);
}

/** IDENTITY.md: Titel und die Zeile „- Name: …“ werden gesetzt, die übrigen Zeilen (Creature, Vibe …) bleiben. */
export function aktualisiere_identity(alt, werte) {
  const zeilen = zeilen_von(alt);
  const titel = zeilen.findIndex(ist_titel);
  if (titel >= 0) zeilen[titel] = `# ${werte.agentenname}`;
  else zeilen.unshift(`# ${werte.agentenname}`);
  const zeile = `- Name: ${werte.agentenname}`;
  const name = zeilen.findIndex((z) => /^\s*[-*]\s*\**name\**\s*:/i.test(z));
  if (name >= 0) zeilen[name] = zeile;
  else zeilen.splice(Math.max(zeilen.findIndex(ist_titel), 0) + 1, 0, zeile);
  return zusammen(zeilen);
}

/** Ist die Ersteinrichtung offen? Ja, solange BOOTSTRAP.md im Workspace liegt. */
export function offen(workspaceDir) {
  return typeof workspaceDir === 'string' && workspaceDir !== '' && existsSync(join(workspaceDir, BOOTSTRAP));
}

async function lese(pfad) {
  try { return await readFile(pfad, 'utf8'); }
  catch (fehler) { if (fehler?.code === 'ENOENT') return ''; throw fehler; }
}

async function schreibe_atomar(pfad, inhalt) {
  const vorlaeufig = `${pfad}.${process.pid}.tmp`;
  try {
    await writeFile(vorlaeufig, inhalt, 'utf8');
    await rename(vorlaeufig, pfad);
  } catch (fehler) {
    await unlink(vorlaeufig).catch(() => {});
    throw fehler;
  }
}

/**
 * Beendet die Ersteinrichtung: USER.md und IDENTITY.md schreiben, BOOTSTRAP.md zuletzt löschen.
 * Bricht etwas vorher ab, bleibt BOOTSTRAP.md liegen und der Aufruf lässt sich wiederholen.
 * Ist BOOTSTRAP.md schon weg, ändert sich nichts (`{erledigt: false}`).
 */
export async function schliesse_ab(workspaceDir, params, {jetzt = new Date()} = {}) {
  if (!offen(workspaceDir)) return {erledigt: false};
  const werte = pruefe_werte(params);
  const datum = lokales_datum(jetzt, werte.zeitzone);
  const user = join(workspaceDir, 'USER.md');
  const identity = join(workspaceDir, 'IDENTITY.md');
  const neuUser = aktualisiere_user(await lese(user), werte, datum);
  const neuIdentity = aktualisiere_identity(await lese(identity), werte);
  await schreibe_atomar(user, neuUser);
  await schreibe_atomar(identity, neuIdentity);
  await rm(join(workspaceDir, BOOTSTRAP), {force: true});
  return {erledigt: true, werte};
}
