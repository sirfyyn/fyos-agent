/**
 * lauf/index.js — die Naht zwischen dem FYOS-Runner und der Bibliothek pi-durable (mit pi-ai und chord).
 *
 * Besitzer, 28.10.2026: keine eigene Agent-Loop-Bibliothek bauen, aber die drei Pakete @earendil-works/pi-durable,
 * pi-ai und chord stehen hinter einer kleinen Schnittstelle, damit ein Tausch, ein Vendoring oder ein Fork nur
 * diese Naht ändert. REGEL: Außerhalb von `src/lauf/` importiert KEINE Datei in `src/` ein @earendil-works-Paket
 * (Wächter: `test/naht-wachter.test.js`). Wer etwas braucht, das hier fehlt, erweitert die Naht.
 *
 * Aufbau (Adapter importieren die Pakete, der Rest nicht):
 *   pi-durable.js  Adapter: Dokumente, Werkzeuge, Erweiterungen, Aufgaben, Haken, Speicher, `oeffneLauf`.
 *   pi-ai.js       Adapter: Modelle, Provider, Streaming, Werkzeug-Schema, Darstellung von Systemänderungen.
 *   chord.js       Adapter: der Ausführungskontext `KONTEXT`.
 *   verlauf.js     Der sichtbare Verlauf (EINE Definition; die Fenster-Eigenheit von pi-durable steckt nur hier).
 *   ereignisse.js  Ereignisstrom und unsere Ereignisnamen (`EREIGNIS`, `ereignisArt`).
 *   gespraech.js   Handgriffe am Gespräch: Zug, Abbruch, Leeren, Verdichten, Abzweigen, Umstellen.
 *
 * Schnittstelle (Gruppen wie in docs/current/RUNNER-NAHT-INVENTUR.md):
 *   Gespräch öffnen/fortsetzen   speicherOeffnen, oeffneLauf, fortsetzen, schliessen, gespraechOeffnen, gespraechAnlegen
 *   Zug                          zugStarten, eintragSchreiben, abbrechen, leeren, abzweigen, umstellen, agentVon
 *   Ereignisstrom                ereignisse, EREIGNIS, ereignisArt, piName
 *   Verlauf/Ansicht              sichtbarerVerlauf, neuesteEintraege, aktivesFenster, letzterEintragId, verlaufVon, ansichtVon
 *   Verdichten                   verdichten, aufgabeAbwarten
 *   Modelle/Provider/Streaming   Schema, openaiStrom, modelleErzeugen, providerErzeugen, systemAenderungText
 *   Werkzeuge/Erweiterungen      werkzeug, erweiterung, abschnitt, haken, HAKEN_ZIEL, registerErzeugen, STANDARD_WERKZEUGE, werkzeugeRegistrieren
 *   Persistenz/Dokumente         dokument, NUTZUNG, LIVE, aufgabe, konfigurieren
 *   Kontext                      KONTEXT
 *
 * Keine Verhaltensänderung: Die Naht benennt und bündelt, sie fügt keine Regeln hinzu.
 */
import { KONTEXT } from './chord.js';

export { KONTEXT };

export {
  AGENT,
  ERZEUGUNG,
  HAKEN_ZIEL,
  LIVE,
  NUTZUNG,
  STANDARD_WERKZEUGE,
  WERKZEUG_AUFRUF,
  abschnitt,
  aufgabe,
  dokument,
  erweiterung,
  haken,
  konfigurieren,
  oeffneLauf,
  registerErzeugen,
  speicherOeffnen,
  werkzeug,
} from './pi-durable.js';

export { Schema, modelleErzeugen, openaiStrom, providerErzeugen, systemAenderungText } from './pi-ai.js';

export { EREIGNIS, ereignisArt, ereignisse, piName } from './ereignisse.js';

export { aktivesFenster, aktivesFensterImHandler, ansichtVon, letzterEintragId, neuesteEintraege, sichtbarerVerlauf, verlaufVon } from './verlauf.js';

export {
  abbrechen,
  abzweigen,
  agentVon,
  aufgabeAbwarten,
  eintragSchreiben,
  gespraechAnlegen,
  gespraechOeffnen,
  leeren,
  umstellen,
  verdichten,
  zugStarten,
} from './gespraech.js';

/** Offene Aufgaben am letzten Checkpoint fortsetzen (nach dem Öffnen und nach dem Anlegen einer Aufgabe). */
export function fortsetzen(lauf) {
  return lauf.resume();
}

/** Den Lauf (Harness) schließen. */
export function schliessen(lauf) {
  return lauf.close(KONTEXT);
}

/** Erweiterungen und Werkzeug-Pakete in ein Register eintragen. */
export function werkzeugeRegistrieren(register, ...pakete) {
  for (const p of pakete) register.install(p);
  return register;
}
