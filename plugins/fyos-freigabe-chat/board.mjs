/**
 * board.mjs — der Zugang zum Vorgangs-Dienst, den der Chat-Hook braucht.
 *
 * ## Vertrag zum Vorgangs-Dienst
 *
 * Der Dienst ist die Wahrheit ueber offene Freigaben; dieses Plugin ist nur ein weiterer
 * WEG auf denselben Gegenstand. Erwartet wird eine kleine HTTP-API unter `FYOS_VORGAENGE_URL`
 * (zum Beispiel `http://vorgaenge:8000/api`):
 *
 *     GET   /tickets?status=waiting_approval&limit=50   -> {tickets: [{id, ...}]}
 *     POST  /tickets/{id}/comments   {actor, text}
 *     PATCH /tickets/{id}   {actor, status, expected_status: "waiting_approval", waiting_for: ""}
 *
 * Der STATUSWECHSEL ist die Freigabe (`in_progress` = genehmigt, `triage` = abgelehnt, siehe
 * `freigabe_vertrag.json`). `expected_status` sorgt dafuer, dass zwei gleichzeitige Antworten
 * (Chat, Reaktion, Oberflaeche) sich nicht ueberschreiben: die erste gueltige entscheidet.
 *
 * Ist `FYOS_VORGAENGE_URL` nicht gesetzt, bleibt das Plugin passiv: der Hook behandelt
 * keine Nachricht als Entscheidung.
 *
 * ## Der Riegel
 *
 * `senderIsOwner` kommt vom Host, nicht aus dem Text. Fehlt das Feld, wird NICHT gehandelt.
 * Ein Hook, dem ein beliebiger Absender „genehmigt“ schreiben kann, waere schlimmer als keiner.
 */

export const VORGAENGE_URL = () => (process.env.FYOS_VORGAENGE_URL || '').replace(/\/$/, '');

/** Der Akteur, unter dem die Chat-Antwort des Besitzers im Vorgangs-Dienst erscheint. */
export const AKTEUR = process.env.FYOS_BESITZER_AKTEUR || 'besitzer';

/** Wie lange eine Abfrage warten darf. Kurz: der Hook sitzt vor dem Turn. */
const FRIST_MS = 5000;

async function hole(pfad, {methode = 'GET', koerper = null} = {}) {
  const basis = VORGAENGE_URL();
  if (!basis) throw new Error('FYOS_VORGAENGE_URL nicht gesetzt');
  const steuerung = new AbortController();
  const uhr = setTimeout(() => steuerung.abort(), FRIST_MS);
  try {
    const antwort = await fetch(`${basis}${pfad}`, {
      method: methode,
      headers: {'Content-Type': 'application/json'},
      body: koerper ? JSON.stringify(koerper) : undefined,
      signal: steuerung.signal,
    });
    if (!antwort.ok) {
      const text = await antwort.text().catch(() => '');
      throw new Error(`Vorgangs-Dienst HTTP ${antwort.status} auf ${methode} ${pfad}: ${text.slice(0, 200)}`);
    }
    const roh = await antwort.text();
    return roh ? JSON.parse(roh) : {};
  } finally {
    clearTimeout(uhr);
  }
}

/** Die offenen Freigaben (Status `waiting_approval`). */
export async function offene_freigaben() {
  const d = await hole('/tickets?status=waiting_approval&limit=50');
  return (d.tickets || []).filter((t) => t && t.id);
}

/** Ein Kommentar am Vorgang: der Wortlaut des Besitzers, damit die Entscheidung eine Spur hat. */
export async function kommentiere(ticket, text) {
  return hole(`/tickets/${ticket}/comments`, {
    methode: 'POST',
    koerper: {actor: AKTEUR, text},
  });
}

/**
 * Die Entscheidung setzen. Das IST die Freigabe.
 *
 * `waiting_for` wird im selben PATCH geleert: beim Verlassen der Warteschlange ist die Frage
 * beantwortet, und ein stehengebliebenes „wartet auf den Besitzer“ waere eine Behauptung,
 * die der Status widerlegt.
 */
export async function setze_status(ticket, zielstatus) {
  return hole(`/tickets/${ticket}`, {
    methode: 'PATCH',
    koerper: {
      actor: AKTEUR,
      status: zielstatus,
      expected_status: 'waiting_approval',
      waiting_for: '',
    },
  });
}

/**
 * Handelt eine Chat-Nachricht als Entscheidung — oder gar nicht.
 *
 * Rueckgabe: was tatsaechlich passiert ist, in Worten, die der Besitzer lesen kann. Der
 * Aufrufer (der Hook) gibt diesen Text als Antwort zurueck, OHNE Modellaufruf.
 */
export async function behandle(text, {handeln = true} = {}) {
  const {entscheide, waehle_vorgang, antwort_text, ENTSCHEIDUNGEN} = await import(
    './entscheidung.mjs'
  );

  const regel = entscheide(text);
  if (regel.art === 'keine') {
    // Keine eindeutige Entscheidung (eine Frage, ein Vorbehalt, ein Kommentar, ein
    // „ok, aber …“): nur ein Kommentar, der Status bleibt, die Frage bleibt offen.
    // Dafuer braucht es einen eindeutigen Vorgang — sonst waere der Kommentar am falschen.
    const offen = await offene_freigaben();
    const wahl = waehle_vorgang(offen, text);
    if (wahl.fehler) {
      return {gehandelt: false, grund: wahl.fehler, text: antwort_text('', 'keine', wahl.fehler)};
    }
    if (!handeln) {
      return {gehandelt: false, grund: 'trockenlauf', text: antwort_text(wahl.ticket.id, 'keine', regel.grund)};
    }
    await kommentiere(wahl.ticket.id, text);
    return {
      gehandelt: true,
      ticket: wahl.ticket.id,
      art: 'keine',
      grund: regel.grund,
      text: antwort_text(wahl.ticket.id, 'keine', regel.grund),
    };
  }

  const offen = await offene_freigaben();
  const wahl = waehle_vorgang(offen, text);
  if (wahl.fehler) {
    return {gehandelt: false, grund: wahl.fehler, text: antwort_text('', 'keine', wahl.fehler)};
  }
  if (!handeln) {
    return {gehandelt: false, grund: 'trockenlauf', text: antwort_text(wahl.ticket.id, regel.art)};
  }

  // Kommentar ZUERST: die Spur der Entscheidung gehoert in die Akte, auch wenn der
  // Statuswechsel danach scheitert. Ein Statuswechsel ohne Begruendung waere eine
  // Entscheidung ohne Herkunft.
  await kommentiere(wahl.ticket.id, text);
  await setze_status(wahl.ticket.id, ENTSCHEIDUNGEN[regel.art]);
  return {
    gehandelt: true,
    ticket: wahl.ticket.id,
    art: regel.art,
    text: antwort_text(wahl.ticket.id, regel.art),
  };
}
