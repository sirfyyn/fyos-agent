/**
 * i18n.js — German/English texts of the web client.
 *
 * The German text is the key; `EN` holds its English form. Placeholders are written `{name}`.
 * The language comes from `<html lang>`, which the runner sets from `pi_durable.sprache` when it serves index.html
 * (src/server.js); without a runner (file opened directly) the browser language decides.
 * `seiteUebersetzen` translates the static page once at start (text nodes and the attributes title, placeholder,
 * aria-label, value of text inputs). It runs before any conversation content is drawn, so it never touches messages.
 */

export const EN = {
  // index.html
  'FYOS Agenten-Lauf: dauerhafte Gespräche, Aufgaben und Freigaben.': 'FYOS agent runner: durable conversations, tasks and approvals.',
  'FYOS · Agenten-Lauf': 'FYOS · Agent runner',
  'Agenten-Lauf': 'Agent runner',
  'Seitenleiste schließen': 'Close sidebar',
  'Seitenleiste öffnen': 'Open sidebar',
  'verbinde …': 'connecting …',
  '＋ Neuer Agent': '＋ New agent',
  'Gespräche': 'Conversations',
  'Freigaben': 'Approvals',
  'Erweitern': 'Settings',
  'dauerhaft · mehrere Clients · Freigaben': 'durable · several clients · approvals',
  'Strom der autonomen Arbeit ein-/ausblenden (/live)': 'Show/hide the stream of autonomous work (/live)',
  'Letzten Stand abzweigen': 'Branch from the latest state',
  'Abzweigen': 'Branch',
  'Verlauf verdichten': 'Compact history',
  'Verdichten': 'Compact',
  'Laufenden Zug abbrechen': 'Cancel the running turn',
  'Abbrechen': 'Cancel',
  'Bereiche': 'Sections',
  'Gespräch': 'Conversation',
  'Zustand': 'State',
  'Aufgaben': 'Tasks',
  'Werkzeuge': 'Tools',
  'Autonome Arbeit': 'Autonomous work',
  'Live · was der Agent gerade selbst tut': 'Live · what the agent is doing on its own',
  'Ausblenden (/live)': 'Hide (/live)',
  'ausblenden': 'hide',
  'Ein Gespräch, das bleibt.': 'A conversation that stays.',
  'Schreib Persona. Der Lauf wird vor jeder Anzeige gespeichert. Du kannst den Tab schließen, einen zweiten Client öffnen oder den Runner neu starten — nichts geht verloren.':
    'Write to the agent. The run is saved before anything is shown. You can close the tab, open a second client or restart the runner — nothing is lost.',
  'Was ist gerade auf den Knoten los? Prüfe alle und fasse knapp zusammen.': 'What is going on on the nodes right now? Check all of them and summarise briefly.',
  'Knoten prüfen': 'Check nodes',
  'Lies den geteilten Zustand und sage mir, was offen ist.': 'Read the shared state and tell me what is open.',
  'Was ist offen?': 'What is open?',
  'Starte einen Lauf: Prüfe den Cluster und melde nur Auffälligkeiten.': 'Start a run: check the cluster and report only anomalies.',
  'Lauf starten': 'Start run',
  'Nachricht an Persona …  (Enter sendet, Shift+Enter neue Zeile)': 'Message to the agent …  (Enter sends, Shift+Enter new line)',
  'Nachricht': 'Message',
  'Wie die Nachricht wirken soll': 'How the message should act',
  'Folgen': 'Follow up',
  'Steuern': 'Steer',
  'Spracheingabe': 'Voice input',
  'Senden': 'Send',
  'Der Lauf ist dauerhaft. Mehrere Clients sehen denselben Stand.': 'The run is durable. Several clients see the same state.',
  'Geteilter Zustand': 'Shared state',
  'Dauerhaft in derselben SQLite-Datei. Alle Agenten dieses Geräts sehen dieselben Werte.': 'Durable in the same SQLite file. All agents on this device see the same values.',
  '＋ Wert': '＋ Value',
  'Läufe': 'Runs',
  'Jeder Lauf hat Phasen, ein Kindgespräch und einen gespeicherten Abschluss.': 'Every run has phases, a child conversation and a saved result.',
  '＋ Lauf': '＋ Run',
  'Der Hub ist die Werkzeugkiste. Suche zuerst, lies das Schema, dann rufe auf — das tut der Agent im Gespräch.':
    'The hub is the toolbox. Search first, read the schema, then call — that is what the agent does in the conversation.',
  'z. B. vorgang anlegen, cluster knoten, hauptserver …': 'e.g. create ticket, cluster nodes …',
  'Suchen': 'Search',
  'Wähle ein Werkzeug.': 'Choose a tool.',
  'Dieses Gerät': 'This device',
  'Der Runner lebt auf dem Gerät oder im Cluster. Ein Token schützt den Zugang von außen.': 'The runner lives on the device or in the cluster. A token protects access from outside.',
  'Neu laden': 'Reload',
  'Knoten': 'Nodes',
  'Jeder Knoten muss erreichbar sein; Befehle laufen lokal oder über ssh.': 'Every node must be reachable; commands run locally or over ssh.',
  'Alle prüfen': 'Check all',
  'Arbeitsbereich und Modell gelten ab der nächsten Nachricht.': 'Workspace and model apply from the next message.',
  'Titel': 'Title',
  'Arbeitsbereich': 'Workspace',
  'Modell': 'Model',
  'Speichern': 'Save',
  'Leeren': 'Clear',
  'Zugang': 'Access',
  'Der Token bleibt nur in diesem Browser. Leer lassen, wenn der Runner nur auf 127.0.0.1 lauscht.': 'The token stays in this browser only. Leave empty if the runner listens on 127.0.0.1 only.',
  'Runner-Token': 'Runner token',
  'Löschen': 'Delete',
  'Als PWA installieren, auf dem Mac als eigene App, auf Hauptserver als Chromium-Fenster.': 'Install as a PWA, as its own app on a Mac, as a Chromium window on a server.',
  'Installieren': 'Install',
  'Verlauf exportieren': 'Export history',
  'Zum Hauptgespräch': 'To the main conversation',
  'Neuer Agent': 'New agent',
  'Ein eigenes Gespräch mit eigenem Verlauf. Mehrere Clients können gleichzeitig zusehen.': 'A separate conversation with its own history. Several clients can watch at the same time.',
  'Anlegen': 'Create',
  'Neuer Lauf': 'New run',
  'Ein dauerhafter Auftrag mit Phasen. Der Lauf arbeitet in einem eigenen Kindgespräch und meldet sich im Aufgaben-Register.':
    'A durable task with phases. The run works in its own child conversation and reports in the task register.',
  'Lauf': 'Run',
  'Auftrag': 'Task',
  'Was soll getan werden? Mit Belegen und Rückweg.': 'What should be done? With evidence and a way back.',
  'Vor dem Abschluss Freigabe einholen': 'Ask for approval before finishing',
  'Starten': 'Start',
  'Freigabe': 'Approval',
  'Notiz (optional)': 'Note (optional)',
  'Ablehnen': 'Deny',
  'Erteilen': 'Grant',
  'Wert setzen': 'Set value',
  'Schlüssel': 'Key',
  'Wert (JSON oder Text)': 'Value (JSON or text)',
  'z. B. {"raum":"buero"} oder einfach hallo': 'e.g. {"room":"office"} or just hello',

  // app.js
  'gerade': 'just now',
  'vor {n} min': '{n} min ago',
  'vor {n} h': '{n} h ago',
  'vor {n} d': '{n} d ago',
  '[Bild]': '[Image]',
  '[Werkzeug {name}]': '[Tool {name}]',
  'Unbekannter Fehler': 'Unknown error',
  'Der Token fehlt oder ist falsch. Bitte hier eintragen.': 'The token is missing or wrong. Please enter it here.',
  'Zeitüberschreitung': 'Timeout',
  'Der Runner antwortet nicht rechtzeitig.': 'The runner does not answer in time.',
  'arbeitet …': 'working …',
  'bereit': 'ready',
  'arbeitet': 'working',
  'Hub ok': 'Hub ok',
  'Hub offline': 'Hub offline',
  'Token': 'Token',
  '{n} Aufgaben': '{n} tasks',
  'Noch keine Verbindung.': 'Not connected yet.',
  'Gerät': 'Device',
  'Art': 'Kind',
  'Agent': 'Agent',
  'Hub': 'Hub',
  'Vorfahrt': 'Priority model',
  'Speicher': 'Storage',
  'Port': 'Port',
  'gesetzt': 'set',
  'nicht gesetzt': 'not set',
  'Version': 'Version',
  'Ohne Titel': 'Untitled',
  'Noch kein Gespräch.': 'No conversation yet.',
  'hohes Risiko · {wann}': 'high risk · {wann}',
  'niedriges Risiko · {wann}': 'low risk · {wann}',
  'mittleres Risiko · {wann}': 'medium risk · {wann}',
  'Nichts offen.': 'Nothing open.',
  'lade Gespräch …': 'loading conversation …',
  'Werkzeug': 'Tool',
  'verbunden': 'connected',
  'unterbrochen · verbinde …': 'interrupted · connecting …',
  'Freigabe {entscheidung}.': 'Approval {entscheidung}.',
  'entschieden': 'decided',
  'erteilt': 'granted',
  'abgelehnt': 'denied',
  'offen': 'open',
  'Aufgabe fehlgeschlagen: {grund}': 'Task failed: {grund}',
  'Modell antwortet nicht; neuer Versuch {n}.': 'Model does not answer; retry {n}.',
  'Verdichte Verlauf …': 'Compacting history …',
  'Verdichten fehlgeschlagen: {grund}': 'Compacting failed: {grund}',
  'Du': 'You',
  'Fehler': 'Error',
  'läuft': 'running',
  'fertig': 'done',
  'Eingabe': 'Input',
  'Eingabe und Ausgabe': 'Input and output',
  'Gedanken': 'Thoughts',
  'Token: {teile}': 'Tokens: {teile}',
  '{n} ein': '{n} in',
  '{n} aus': '{n} out',
  'Steuerung': 'Steering',
  'Freigabe {id}: {entscheidung}': 'Approval {id}: {entscheidung}',
  'Auftrag für Lauf {lauf}: {titel}': 'Task for run {lauf}: {titel}',
  'Neuer Kontext begonnen. Das Modell sieht den Verlauf darüber nicht mehr.': 'New context started. The model no longer sees the history above.',
  'Verlauf verdichtet. Das Modell sieht ab hier nur die Zusammenfassung und das Folgende.': 'History compacted. From here on the model sees only the summary and what follows.',
  'Übergabe': 'Handover',
  'Zusammenfassung': 'Summary',
  'Kontext': 'Context',
  'Verdichtet': 'Compacted',
  'Eine Freigabe wartet': 'One approval is waiting',
  '{n} Freigaben warten': '{n} approvals are waiting',
  'Aktion': 'Action',
  'Freigeben': 'Approve',
  'Diese Freigabe ist bereits {status}.': 'This approval is already {status}.',
  'Aktion: {aktion}': 'Action: {aktion}',
  'Risiko: {risiko}': 'Risk: {risiko}',
  ' · zerstörerisch': ' · destructive',
  'Gespräch: {titel}': 'Conversation: {titel}',
  'Noch kein geteilter Wert. Der Agent kann hier Werte ablegen; du kannst sie auch selbst setzen.': 'No shared value yet. The agent can store values here; you can set them yourself too.',
  'Bearbeiten': 'Edit',
  'Wert „{key}“': 'Value “{key}”',
  'Noch kein Lauf. Ein Lauf ist ein dauerhafter Auftrag mit Phasen und eigenem Kindgespräch.': 'No run yet. A run is a durable task with phases and its own child conversation.',
  'beendet {wann}': 'finished {wann}',
  'Freigabe {id}': 'Approval {id}',
  'Antwort: {text}': 'Answer: {text}',
  'Fehler: {text}': 'Error: {text}',
  'Notiz: {text}': 'Note: {text}',
  'Kindgespräch': 'Child conversation',
  'Keine Werkzeuge gefunden. Ist der Hub erreichbar?': 'No tools found. Is the hub reachable?',
  'Suche …': 'Searching …',
  'Keine Treffer.': 'No results.',
  'Keine Knoten konfiguriert.': 'No nodes configured.',
  ' · lokal': ' · local',
  'erreichbar': 'reachable',
  'nicht erreichbar': 'not reachable',
  'nicht geprüft': 'not checked',
  'Prüfe alle Knoten per ssh …': 'Checking all nodes over ssh …',
  'Token gesetzt. Der Lauf ist dauerhaft; alle Clients sehen denselben Stand.': 'Token set. The run is durable; all clients see the same state.',
  'Standard': 'Default',
  'Ein Token ist gesetzt; er wird nur an den Runner gesendet.': 'A token is set; it is sent to the runner only.',
  'Kein Token gesetzt. Das ist nur bei 127.0.0.1 sicher.': 'No token set. That is safe on 127.0.0.1 only.',
  'nicht verbunden': 'not connected',
  'Hauptgespräch': 'Main conversation',
  'keine Spracheingabe im Browser': 'no voice input in this browser',
  'Abbruch angefordert.': 'Cancellation requested.',
  '{titel} · Zweig': '{titel} · branch',
  'Zweig angelegt.': 'Branch created.',
  'Verdichten gestartet.': 'Compaction started.',
  'Gespräch gespeichert.': 'Conversation saved.',
  'Verlauf dieses Gesprächs leeren? Das lässt sich nicht zurücknehmen.': 'Clear the history of this conversation? This cannot be undone.',
  'Verlauf geleert.': 'History cleared.',
  'Wert „{key}“ löschen?': 'Delete value “{key}”?',
  'Wert gelöscht.': 'Value deleted.',
  'Lauf #{id} abbrechen?': 'Cancel run #{id}?',
  'Lauf abgebrochen.': 'Run cancelled.',
  'Knotenprüfung fertig.': 'Node check done.',
  'Konfiguration neu geladen.': 'Configuration reloaded.',
  'Token ist leer. Zum Löschen den Knopf „Löschen“ verwenden.': 'Token is empty. To remove it, use the “Delete” button.',
  'Agent angelegt.': 'Agent created.',
  'Kein Gespräch geöffnet.': 'No conversation open.',
  'Lauf #{id} gestartet.': 'Run #{id} started.',
  'Wert gespeichert.': 'Value saved.',
  'Live aus': 'Live off',
  'Gerade ruhig. Neue Arbeit erscheint hier von selbst.': 'Quiet right now. New work appears here by itself.',
  '{titel} · Klick: Fokus hierher': '{titel} · click: focus here',
  'zuletzt {wann}': 'last {wann}',
  'Live an: du siehst die autonome Arbeit.': 'Live on: you see the autonomous work.',
  'Live aus: Strom ausgeblendet. /live blendet ihn wieder ein.': 'Live off: stream hidden. /live shows it again.',
  'Freigabe erteilt.': 'Approval granted.',
  'Freigabe abgelehnt.': 'Approval denied.',
  'Dieser Browser hat keine Spracheingabe. Tippen funktioniert weiter.': 'This browser has no voice input. Typing still works.',
  'höre …': 'listening …',
  'erkannt': 'recognised',
  'Mikrofon nicht erlaubt. Tippen funktioniert weiter.': 'Microphone not allowed. Typing still works.',
  'Nichts gehört. Noch einmal versuchen.': 'Heard nothing. Try again.',
  'Spracheingabe: {fehler}': 'Voice input: {fehler}',
  'Start fehlgeschlagen': 'Start failed',
};

/** `de` or `en`: the `<html lang>` the runner set, otherwise the browser language. */
export function spracheErmitteln(doc = globalThis.document, nav = globalThis.navigator) {
  const html = String(doc?.documentElement?.getAttribute?.('lang') ?? '').toLowerCase();
  if (html.startsWith('en')) return 'en';
  if (html.startsWith('de')) return 'de';
  return String(nav?.language ?? 'de').toLowerCase().startsWith('de') ? 'de' : 'en';
}

let SPRACHE = spracheErmitteln();

export function sprache() {
  return SPRACHE;
}

/** Set the language (tests, or a later change); returns the language in effect. */
export function spracheSetzen(s) {
  SPRACHE = String(s ?? '').toLowerCase().startsWith('en') ? 'en' : 'de';
  return SPRACHE;
}

/** Text for the current language; `werte` fills `{name}` placeholders. Unknown keys stay German. */
export function t(de, werte = null) {
  let s = SPRACHE === 'en' && Object.hasOwn(EN, de) ? EN[de] : de;
  if (werte) s = s.replace(/\{(\w+)\}/g, (g, k) => (Object.hasOwn(werte, k) ? String(werte[k] ?? '') : g));
  return s;
}

/** Locale for dates and times. */
export const ortsform = () => (SPRACHE === 'en' ? 'en-GB' : 'de-DE');

const ATTRIBUTE = ['title', 'placeholder', 'aria-label', 'content'];

/** Translate the static page (text nodes and some attributes) once; does nothing in German. */
export function seiteUebersetzen(wurzel = globalThis.document) {
  if (SPRACHE !== 'en' || !wurzel) return 0;
  let n = 0;
  const ersetze = (roh) => {
    const kern = roh.trim();
    if (!kern || !Object.hasOwn(EN, kern)) return null;
    n += 1;
    return roh.replace(kern, EN[kern]);
  };
  const doc = wurzel.ownerDocument ?? wurzel;
  if (doc.title && Object.hasOwn(EN, doc.title)) doc.title = EN[doc.title];
  const gang = doc.createTreeWalker(wurzel.body ?? wurzel, 4 /* NodeFilter.SHOW_TEXT */);
  for (let k = gang.nextNode(); k; k = gang.nextNode()) {
    const neu = ersetze(k.nodeValue);
    if (neu !== null) k.nodeValue = neu;
  }
  for (const e of (wurzel.querySelectorAll ? wurzel : doc).querySelectorAll('*')) {
    for (const a of ATTRIBUTE) {
      const v = e.getAttribute(a);
      if (v === null) continue;
      const neu = ersetze(v);
      if (neu !== null) e.setAttribute(a, neu);
    }
    if (e.tagName === 'INPUT' && (e.type === 'text' || !e.getAttribute('type')) && e.hasAttribute('value')) {
      const neu = ersetze(e.getAttribute('value'));
      if (neu !== null) {
        e.setAttribute('value', neu);
        e.value = neu;
      }
    }
  }
  return n;
}
