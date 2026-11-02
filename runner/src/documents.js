/**
 * documents.js — der geteilte Zustand des Laufs, dauerhaft in derselben SQLite-Datei
 * wie die Gespräche.
 *
 * Die pi-durable-Dokumente sind der Grund, warum mehrere Clients denselben Lauf sehen:
 * Register, Freigaben, Aufgabenliste und Gerätezustand liegen neben dem Transkript und
 * werden in denselben Commits geschrieben. Nichts davon ist ein zweiter Speicher.
 */
import { dokument as defineDoc } from './lauf/index.js';

const ohneCheckpoint = () => false;

/** Alle Agenten dieses Geräts. Die Wahrheit für die linke Leiste. */
export const Register = defineDoc({
  kind: 'fyos.register',
  version: 1,
  scope: 'session',
  initial: () => ({ version: 1, agents: [], geraet: null, aktualisiert: null }),
  checkpointWhen: ohneCheckpoint,
});

/** Laufzeit: Eingangszeiger, Startzeit, was der proaktive Teil zuletzt gesehen hat. */
export const Laufzeit = defineDoc({
  kind: 'fyos.laufzeit',
  version: 1,
  scope: 'session',
  initial: () => ({
    version: 1,
    gestartet: null,
    letzteEingang: '$',
    eingangGesehen: 0,
    eingangFehler: null,
    /**
     * Eingang pausiert (Verwaltung, `POST /api/steuern/eingang`): nichts wird gelesen, nichts geht an den Agenten.
     * Liegt im Dokument, überlebt also einen Neustart. Ältere Dokumente haben die Felder nicht: fehlt es, gilt „nicht pausiert“.
     */
    eingangPausiert: false,
    eingangPausiertSeit: null,
    eingangPausiertVon: null,
    /** Ausgangssequenz je Gespräch; überlebt einen Neustart. */
    sequenzen: {},
  }),
  checkpointWhen: ohneCheckpoint,
});

/**
 * Geteilter Anwendungszustand: ein JSON-Objekt für alle Agenten dieses Geräts.
 * Genau die Rolle, die im Video „shared application state“ hat — nur dass er hier
 * in derselben SQLite-Datei liegt wie die Gespräche.
 */
export const Zustand = defineDoc({
  kind: 'fyos.zustand',
  version: 1,
  scope: 'session',
  initial: () => ({ version: 1, werte: {}, geaendert: null, von: null }),
  checkpointWhen: ohneCheckpoint,
});

/** Freigaben (Human near the loop). Ein Dokument, damit die Liste in einem Commit stimmt. */
export const Freigaben = defineDoc({
  kind: 'fyos.freigaben',
  version: 1,
  scope: 'session',
  initial: () => ({ version: 1, eintraege: {} }),
  checkpointWhen: ohneCheckpoint,
});

/** Die sichtbare Aufgabenliste; die Task-Records selbst bleiben bei pi-durable. */
export const LaufListe = defineDoc({
  kind: 'fyos.laeufe',
  version: 1,
  scope: 'session',
  initial: () => ({ version: 1, eintraege: {} }),
  checkpointWhen: ohneCheckpoint,
});

/**
 * Angenommene, noch nicht an den Agenten gegebene Eingänge. Der Zeiger im Hub-Strom wandert in
 * demselben Commit weiter, in dem ein Eingang hier landet; ein Neustart verliert nichts, was
 * schon angenommen war. Spielmodus und Hintergrund-Tor halten Einträge nur zurück.
 */
export const Wartend = defineDoc({
  kind: 'fyos.wartend',
  version: 1,
  scope: 'session',
  initial: () => ({ version: 1, eintraege: [] }),
  checkpointWhen: ohneCheckpoint,
});

/**
 * Messung der Sprachsätze (Eingang mit Bezug `stimme`): je Satz die Zeiten und der Prompt, die letzten
 * Sätze dauerhaft. Nur Zahlen, nie der gesprochene Text. Siehe stimme.js.
 */
export const StimmeDoc = defineDoc({
  kind: 'fyos.stimme',
  version: 1,
  scope: 'session',
  initial: () => ({ version: 1, saetze: [] }),
  checkpointWhen: ohneCheckpoint,
});

/**
 * Nachtwerkstatt: offene Vorschläge (der Deckel zählt sie), Nächte (Datum → Aufgabe, damit ein doppelter Takt nichts
 * doppelt startet), zuletzt bearbeitete Skills und der letzte Morgenbericht. Alles Vorschlag, nichts übernommen.
 */
export const NachtDoc = defineDoc({
  kind: 'fyos.nachtwerkstatt',
  version: 1,
  scope: 'session',
  initial: () => ({ version: 1, vorschlaege: {}, naechte: {}, skillsmith: {}, bericht: null }),
  checkpointWhen: ohneCheckpoint,
});

/**
 * Hub-Aufgaben (MCP Tasks, docs/current/MCP-TASKS.md): was der Runner beim Hub gestartet hat und noch nicht zugestellt hat.
 * Dauerhaft in derselben SQLite-Datei: nach einem Neustart fragt der Wächter (aufgaben.js) einfach weiter.
 * Nicht zu verwechseln mit den Läufen (`LaufListe`, `aufgabe_starten`), die der Runner selbst ausführt.
 */
export const HubAufgaben = defineDoc({
  kind: 'fyos.hub-aufgaben',
  version: 1,
  scope: 'session',
  initial: () => ({ version: 1, eintraege: {} }),
  checkpointWhen: ohneCheckpoint,
});

/** Ein Eintrag in `HubAufgaben` (Schlüssel = taskId). */
export function neueHubAufgabe({ taskId, werkzeug, conversationId, status, ttlMs, pollIntervalMs }, jetzt = Date.now()) {
  return {
    taskId,
    werkzeug: String(werkzeug ?? '').slice(0, 120),
    conversationId,
    status: status || 'working',
    ttlMs: Number(ttlMs) || null,
    pollIntervalMs: Number(pollIntervalMs) || 2000,
    erstellt: jetzt,
    naechsteAbfrage: jetzt + (Number(pollIntervalMs) || 2000),
    letzteAbfrage: null,
    fehler: 0,
    fehlerSeit: null,
    letzterFehler: null,
    gemeldet: {},
    zugestellt: false,
    zugestelltAm: null,
  };
}

/** Metadaten eines Gesprächs: Titel, Arbeitsbereich, Modell, Anlagezeit. */
export const AgentMeta = defineDoc({
  kind: 'fyos.agent.meta',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  initial: () => ({
    version: 1,
    titel: 'Neuer Agent',
    erstellt: null,
    arbeitsbereich: 'standard',
    ordner: null,
    modell: null,
    archiviert: false,
    art: 'mensch',
  }),
  checkpointWhen: ohneCheckpoint,
});

/** Ein Eintrag der Freigabeliste. */
/**
 * `kontext`: Kurzkontext von 3 bis 5 Sätzen (Entscheidung 586), geprüft in freigabe-kontext.js. `kontextHerkunft`: 'modell'
 * (vom Modell geschrieben) oder 'rueckfall' (vom Runner erzeugt); fehlt bei älteren Einträgen.
 */
export function neueFreigabe({ id, conversationId, taskId, aktion, risiko, kontext, kontextHerkunft, zerstoererisch, werkzeug, befehl, bezug }) {
  return {
    // Woher der Auftrag kam (z. B. `stimme`); entschieden wird trotzdem nur in der App.
    bezug: bezug ? String(bezug).slice(0, 64) : null,
    id,
    conversationId,
    taskId: taskId ?? null,
    aktion: String(aktion ?? '').slice(0, 200),
    risiko: ['low', 'medium', 'high'].includes(risiko) ? risiko : 'medium',
    kontext: String(kontext ?? '').slice(0, 600),
    kontextHerkunft: kontextHerkunft === 'modell' || kontextHerkunft === 'rueckfall' ? kontextHerkunft : null,
    // Risiko hoch gilt immer als zerstörerisch, auch wenn der Aufrufer es nicht setzt (Lauf-Freigaben, Runner).
    zerstoererisch: !!zerstoererisch || risiko === 'high',
    werkzeug: werkzeug ? String(werkzeug).slice(0, 120) : null,
    // Bei einer Freigabe für einen Shell-Befehl: genau dieser Befehl (siehe freigabe-befehl.js).
    befehl: befehl ? String(befehl).slice(0, 4000) : null,
    status: 'offen',
    erstellt: Date.now(),
    entschieden: null,
    entschiedenVon: null,
    notiz: null,
  };
}
