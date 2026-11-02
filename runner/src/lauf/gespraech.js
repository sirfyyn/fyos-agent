/**
 * lauf/gespraech.js — Handgriffe an einem Gespräch (Zug starten, abbrechen, leeren, verdichten, abzweigen, umstellen).
 *
 * Alle Funktionen nehmen einen Gesprächs-Griff (`gespraechOeffnen`) und tragen den Kontext selbst ein; kein Aufrufer
 * reicht `KONTEXT` weiter. Der Verlauf liegt in `verlauf.js`, die Ereignisse in `ereignisse.js`.
 */
import { KONTEXT } from './chord.js';

/** Wie sich ein neuer Zug verhält, wenn das Gespräch gerade arbeitet. */
const WENN_BESCHAEFTIGT = Object.freeze({
  folgen: 'followUp', // hinten anreihen, nach dem laufenden Zug
  steuern: 'steer', // in den laufenden Zug hinein
  abweisen: 'reject', // ablehnen
});

/** Das Gespräch mit dieser Kennung, oder `null`/`undefined`, wenn es keines gibt. */
export function gespraechOeffnen(lauf, id) {
  return lauf.conversation(id, KONTEXT);
}

/**
 * Ein neues Gespräch anlegen.
 * @param {object} lauf Harness-Griff.
 * @param {{agent:object, besitzer?:object}} o  `agent`: Modell, Ordner, Anweisungen (Form von pi-durable); ohne Besitzer: eigenständig.
 */
export function gespraechAnlegen(lauf, { agent }) {
  return lauf.createConversation({ ownership: { kind: 'ownerless' }, agent }, KONTEXT);
}

/**
 * Einen Zug starten: Text an das Modell, mit einem Verlaufseintrag eigener Art.
 *
 * @param {object} conv Gesprächs-Griff.
 * @param {object} z
 * @param {string} z.text                                       Inhalt für das Modell.
 * @param {'folgen'|'steuern'|'abweisen'} [z.wennBeschaeftigt]  Standard 'folgen'.
 * @param {string} [z.anfrageId]                                Dieselbe Kennung zweimal ergibt keinen zweiten Zug (Idempotenz).
 * @param {{art:string, daten:object}} [z.eintrag]              Eintrag, den der Verlauf zum Zug trägt (`kind` + `data` in pi-durable).
 * @returns {Promise<{id:*, wait:Function}>} die Einreichung; `.id` ist ihre Kennung.
 */
export function zugStarten(conv, { text, wennBeschaeftigt = 'folgen', anfrageId, eintrag }) {
  return conv.submit(
    {
      type: 'input',
      content: text,
      whenBusy: WENN_BESCHAEFTIGT[wennBeschaeftigt] ?? wennBeschaeftigt,
      requestId: anfrageId,
      ...(eintrag ? { entry: { kind: eintrag.art, data: eintrag.daten } } : {}),
    },
    KONTEXT,
  );
}

/** Einen Eintrag in den Verlauf schreiben, ohne das Modell zu fragen (z. B. das Ergebnis eines Slash-Befehls). */
export function eintragSchreiben(conv, { anfrageId, eintrag }) {
  return conv.submit(
    {
      type: 'write',
      ...(anfrageId ? { requestId: anfrageId } : {}),
      entry: { kind: eintrag.art, data: eintrag.daten },
    },
    KONTEXT,
  );
}

/** Den laufenden Zug abbrechen. */
export function abbrechen(conv) {
  return conv.abort(KONTEXT);
}

/** Einen neuen Kontext beginnen (`pi.reset`); der frühere Verlauf bleibt sichtbar (`verlauf.js`). */
export function leeren(conv, uebergabe) {
  return conv.reset(uebergabe, KONTEXT);
}

/** Den Verlauf verdichten (Zusammenfassung, `pi.compaction`). Liefert die Aufgabe; `aufgabeAbwarten` wartet darauf. */
export function verdichten(conv, hinweis) {
  return conv.compact(hinweis, KONTEXT);
}

/** Auf das Ende einer Aufgabe (z. B. Verdichten) warten. */
export function aufgabeAbwarten(lauf, aufgabe) {
  return lauf.waitForTask(aufgabe, KONTEXT);
}

/** Ein Gespräch ab einem Eintrag abzweigen. */
export function abzweigen(conv, eintragId, { agent }) {
  return conv.fork(eintragId, { ownership: { kind: 'ownerless' }, agent }, KONTEXT);
}

/** Die Einstellung des Gesprächs: `{ model, cwd, tools, … }` (Form von pi-durable). */
export function agentVon(conv) {
  return conv.agent(KONTEXT);
}

/** Modell, Ordner oder Anweisungen eines Gesprächs ändern. */
export function umstellen(conv, einstellung) {
  return conv.configure(einstellung, KONTEXT);
}
