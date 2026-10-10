/**
 * Matrix-Reaktionen sind keine Chat-Turns und erreichen deshalb keinen normalen
 * Plugin-Hook. Dieser kleine Client liest ausschliesslich neue `m.reaction`-Events
 * des eigenen Bots. Er ist eine Sicht auf den Vorgangs-Dienst, keine zweite Entscheidung.
 */
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

const HALTBAR_MS = 72 * 60 * 60 * 1000;
const EMOJI = Object.freeze({'✅': 'genehmigen', '❌': 'ablehnen', '➕': 'zusaetzliches'});

export function lese_matrix_reaktion(raum, event, approver) {
  const beziehung = event?.content?.['m.relates_to'];
  const art = EMOJI[beziehung?.key];
  if (
    event?.type !== 'm.reaction' ||
    event?.sender !== approver ||
    beziehung?.rel_type !== 'm.annotation' ||
    !beziehung?.event_id ||
    !art ||
    !raum
  ) return null;
  return {eventId: String(event.event_id || ''), zielEventId: beziehung.event_id, raum, art, emoji: beziehung.key, sender: event.sender};
}

/** Der kleine Persistenzindex ist nur eine Zuordnung zwischen Matrix-Event und
 * Ticket. Die Entscheidung selbst bleibt ausschliesslich der Statuswechsel im Vorgangs-Dienst. */
export class ReaktionsSpeicher {
  constructor({datei, jetzt = () => Date.now()} = {}) {
    this.datei = datei;
    this.jetzt = jetzt;
    this.prompts = new Map();
    this.zusatz = new Map();
    this.verarbeitet = new Map();
    this.cursor = '';
    // Mehrere Gateway-Ereignisse (Fanout, Reaktion, anschliessender Clear) duerfen
    // denselben kleinen Index gleichzeitig beruehren. Ein gemeinsamer .tmp-Name
    // ohne Serialisierung liess einen Schreiber den anderen beim rename verlieren.
    this.sicherungsfolge = Promise.resolve();
  }

  aufraeumen() {
    const grenze = this.jetzt() - HALTBAR_MS;
    for (const [k, v] of this.prompts) if (v.ts < grenze) this.prompts.delete(k);
    for (const [k, v] of this.zusatz) if (v.ts < grenze) this.zusatz.delete(k);
    for (const [k, ts] of this.verarbeitet) if (ts < grenze) this.verarbeitet.delete(k);
  }

  async laden() {
    if (!this.datei) return this;
    try {
      const roh = JSON.parse(await readFile(this.datei, 'utf8'));
      this.cursor = typeof roh.cursor === 'string' ? roh.cursor : '';
      for (const [id, wert] of Object.entries(roh.prompts || {})) if (wert?.ticket && wert?.ts) this.prompts.set(id, wert);
      for (const [id, wert] of Object.entries(roh.zusatz || {})) if (wert?.ticket && wert?.ts) this.zusatz.set(id, wert);
      for (const [id, ts] of Object.entries(roh.verarbeitet || {})) if (typeof ts === 'number') this.verarbeitet.set(id, ts);
    } catch (fehler) {
      if (fehler?.code !== 'ENOENT') throw fehler;
    }
    this.aufraeumen();
    return this;
  }

  async sichern() {
    if (!this.datei) return;
    const sichern = async () => {
      this.aufraeumen();
      const daten = JSON.stringify({
        cursor: this.cursor,
        prompts: Object.fromEntries(this.prompts),
        zusatz: Object.fromEntries(this.zusatz),
        verarbeitet: Object.fromEntries(this.verarbeitet),
      });
      await mkdir(dirname(this.datei), {recursive: true});
      const zwischen = `${this.datei}.tmp`;
      await writeFile(zwischen, daten, {mode: 0o600});
      await rename(zwischen, this.datei);
    };
    const lauf = this.sicherungsfolge.then(sichern, sichern);
    this.sicherungsfolge = lauf.catch(() => {});
    return lauf;
  }

  async merke_prompt({eventId, ticket, raum}) {
    this.prompts.set(eventId, {ticket, raum, ts: this.jetzt()});
    await this.sichern();
  }

  prompt(eventId) { this.aufraeumen(); return this.prompts.get(eventId) || null; }

  raeume_fuer_ticket(ticket) {
    this.aufraeumen();
    return [...new Set([...this.prompts.values()]
      .filter((prompt) => prompt.ticket === ticket && prompt.raum)
      .map((prompt) => prompt.raum))];
  }

  async loesche_prompts_fuer_ticket(ticket) {
    for (const [eventId, prompt] of this.prompts) {
      if (prompt.ticket === ticket) this.prompts.delete(eventId);
    }
    for (const [sender, zusatz] of this.zusatz) {
      if (zusatz.ticket === ticket) this.zusatz.delete(sender);
    }
    await this.sichern();
  }

  schon_verarbeitet(eventId) { return Boolean(eventId) && this.verarbeitet.has(eventId); }

  async merke_verarbeitet(eventId) {
    if (eventId) this.verarbeitet.set(eventId, this.jetzt());
    await this.sichern();
  }

  async merke_zusatz(sender, eintrag) {
    this.zusatz.set(sender, {...eintrag, ts: this.jetzt()});
    await this.sichern();
  }

  zusatz_fuer(sender) { this.aufraeumen(); return this.zusatz.get(sender) || null; }

  async loesche_zusatz(sender) {
    this.zusatz.delete(sender);
    await this.sichern();
  }
}

export async function verarbeite_reaktion(reaktion, {speicher, board}) {
  if (!reaktion || speicher.schon_verarbeitet(reaktion.eventId)) return {gehandelt: false, grund: 'unbekannt_oder_doppelt'};
  const prompt = speicher.prompt(reaktion.zielEventId);
  if (!prompt || prompt.raum !== reaktion.raum) return {gehandelt: false, grund: 'kein_fyos_prompt'};

  if (reaktion.art === 'zusaetzliches') {
    await board.kommentiere(prompt.ticket, 'Matrix-Reaktion ➕ vom Besitzer: Die nächste Matrix-Nachricht wird als Kommentar + Folgeanweisung erwartet.');
    await speicher.merke_zusatz(reaktion.sender, {ticket: prompt.ticket, raum: reaktion.raum});
  } else {
    await board.kommentiere(prompt.ticket, `Matrix-Reaktion ${reaktion.emoji} vom Besitzer.`);
    await board.setze_status(prompt.ticket, reaktion.art === 'genehmigen' ? 'in_progress' : 'triage');
  }
  await speicher.merke_verarbeitet(reaktion.eventId);
  return {gehandelt: true, ticket: prompt.ticket, art: reaktion.art};
}

function sync_url(homeserver, since, timeout) {
  const url = new URL('/_matrix/client/v3/sync', homeserver);
  url.searchParams.set('timeout', String(timeout));
  if (since) url.searchParams.set('since', since);
  url.searchParams.set('filter', JSON.stringify({room: {timeline: {types: ['m.reaction']}}}));
  return url;
}

export async function sync_runde({homeserver, accessToken, since, timeout = 30000, fetchImpl = fetch}) {
  const antwort = await fetchImpl(sync_url(homeserver, since, timeout), {headers: {Authorization: `Bearer ${accessToken}`}});
  if (!antwort.ok) throw new Error(`Matrix sync HTTP ${antwort.status}`);
  return antwort.json();
}

function warte_oder_abbruch(ms, abortSignal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    abortSignal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, {once: true});
  });
}

export function starte_matrix_reaktionen({api, speicher, board, homeserver, accessToken, approver, abortSignal, fetchImpl = fetch}) {
  if (!homeserver || !accessToken || !approver) return;
  void (async () => {
    try {
      await speicher.laden();
      // Beim allerersten Start nur den Cursor setzen: alte Reaktionen duerfen keine
      // alte Freigabe nachtraeglich ausloesen.
      while (!abortSignal?.aborted) {
        try {
          // Beim allerersten Start nur den Cursor setzen: alte Reaktionen duerfen
          // keine alte Freigabe nachtraeglich ausloesen.
          const antwort = await sync_runde({homeserver, accessToken, since: speicher.cursor, timeout: speicher.cursor ? 30000 : 0, fetchImpl});
          if (!speicher.cursor) {
            speicher.cursor = String(antwort.next_batch || '');
            await speicher.sichern();
            continue;
          }
          speicher.cursor = String(antwort.next_batch || speicher.cursor);
          for (const [raum, daten] of Object.entries(antwort.rooms?.join || {})) {
            for (const event of daten?.timeline?.events || []) {
              const reaktion = lese_matrix_reaktion(raum, event, approver);
              if (!reaktion) continue;
              try { await verarbeite_reaktion(reaktion, {speicher, board}); }
              catch (fehler) { api.logger?.error(`fyos-freigabe-matrix: ${String(fehler?.message || fehler).slice(0, 200)}`); }
            }
          }
          await speicher.sichern();
        } catch (fehler) {
          if (abortSignal?.aborted) break;
          api.logger?.error(`fyos-freigabe-matrix-sync: ${String(fehler?.message || fehler).slice(0, 200)}`);
          await warte_oder_abbruch(1000, abortSignal);
        }
      }
    } catch (fehler) {
      if (!abortSignal?.aborted) api.logger?.error(`fyos-freigabe-matrix-sync: ${String(fehler?.message || fehler).slice(0, 200)}`);
    }
  })();
}
