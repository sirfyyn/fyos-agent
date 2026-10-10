/**
 * hook.mjs — die testbare Logik des Freigabe-Chat-Hooks.
 *
 * Getrennt von `index.mjs` aus demselben Grund wie bei `fyos-prioritaet`: `index.mjs`
 * importiert `openclaw/plugin-sdk/plugin-entry`, und das gibt es nur im laufenden
 * Gateway. Wer die Logik testen will, darf den SDK nicht ziehen muessen.
 *
 * Hier steht deshalb alles, was falsch sein kann: der Vor-Filter, der Riegel
 * (`senderIsOwner`), und die Verdrahtung ans Board. `index.mjs` ist nur noch das
 * Manifest darum.
 */

const MARKER =
  /^\s*(fyos[-\s]?)?(freigabe|vollfreigab\w*|genehmig\w*|erteil\w*|abgelehnt|ablehn\w*|nein|ja|ok|okay|go|passt|einverstanden|freigegeben|stop|stopp)\b/i;

const KENNUNG = /\b[a-z]{2,6}-\d+/i;

/**
 * Nur Nachrichten mit einem Entscheidungswort erreichen das Board.
 *
 * Ohne diesen Vor-Filter liefe fuer JEDEN Satz eine Board-Abfrage — das waere ein
 * Netzaufruf vor jedem Turn, auch bei „erzaehl mir was". Der Filter ist absichtlich
 * weit (er laesst viel durch); die enge Regel steht in `entscheidung.mjs`.
 */
export function koennte_entscheidung_sein(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  // Kurze Nachrichten sind der haeufige Fall („ja", „genehmigt"). Laengere nur, wenn
  // der Marker am Anfang steht — ein Aufsatz ueber Freigaben ist keine Freigabe.
  if (t.length <= 60) return MARKER.test(t) || KENNUNG.test(t);
  return MARKER.test(t);
}

/**
 * Der Handler. Gibt `{handled:true, reply}` zurueck, wenn die Nachricht des Besitzers eine
 * Entscheidung war — sonst `undefined`, und der Turn laeuft normal weiter.
 *
 * Die zwei Riegel:
 *
 *     senderIsOwner === true   sonst gar nichts (auch bei fehlendem Feld)
 *     eine echte Entscheidung   entschieden von `entscheidung.mjs`, nicht hier
 */
export function mache_handler(api, dependencies = {}) {
  return async function before_agent_reply(event, ctx) {
    // ─ Riegel 1: nur der Besitzer ──────────────────────────────────────────────────────
    // Der Host liefert das; fehlt es, wird nicht gehandelt (fail closed). Die
    // OpenClaw-Doku: „Missing fields are unproven, not false assurances."
    if (ctx?.requester?.senderIsOwner !== true) return undefined;

    const text = String(event?.cleanedBody ?? '');
    // ➕ ist kein vierter Entscheidungsweg. Nach der Reaktion gehoert genau die
    // naechste Matrix-Nachricht als Kommentar an das schon bekannte Ticket.
    const zusatz = ctx?.sessionKey?.includes(':matrix:')
      ? dependencies.reaktionsspeicher?.zusatz_fuer(dependencies.approverId)
      : null;
    if (zusatz && text.trim()) {
      try {
        const board = dependencies.board ?? (await import('./board.mjs'));
        await board.kommentiere(zusatz.ticket, text);
        await dependencies.reaktionsspeicher.loesche_zusatz(dependencies.approverId);
        return {handled: true, reply: {text: `Notiert am Vorgang ${zusatz.ticket} — die Freigabe bleibt offen.`}};
      } catch (fehler) {
        api.logger.error(`fyos-freigabe-chat: Zusatz-Kommentar nicht gespeichert (${String(fehler?.message ?? fehler).slice(0, 200)})`);
        return undefined;
      }
    }
    if (!koennte_entscheidung_sein(text)) return undefined;

    // ── Riegel 2: nur wenn wirklich eine Entscheidung vorliegt ────────────────
    let ergebnis;
    try {
      const board = dependencies.board ?? (await import('./board.mjs'));
      ergebnis = await board.behandle(text, {handeln: dependencies.handeln !== false});
    } catch (fehler) {
      // Ein Fehler hier darf den Chat nicht kippen. Kein `handled`, also laeuft der
      // Turn normal weiter — der Besitzer sieht seine Nachricht im Gespraech, und der Agent
      // antwortet wie sonst. Der Fehlschlag ist sichtbar im Gateway-Log.
      api.logger.error(
        `fyos-freigabe-chat: Board nicht erreichbar (${fehler?.name ?? 'Fehler'}): ${String(
          fehler?.message ?? fehler,
        ).slice(0, 200)}`,
      );
      return undefined;
    }

    if (!ergebnis?.gehandelt) return undefined;

    // `handled: true` beendet den Turn OHNE Modellaufruf und liefert den Text fuer den Besitzer.
    return {handled: true, reply: {text: ergebnis.text}};
  };
}

/** Registriert den Hook an einer `api` (dem echten Gateway oder einer Attrappe). */
export function registerFreigabeChat(api, dependencies = {}) {
  api.on('before_agent_reply', mache_handler(api, dependencies), {eligibleTriggers: ['user']});
  return {koennte_entscheidung_sein};
}
