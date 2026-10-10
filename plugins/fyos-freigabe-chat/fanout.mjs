/**
 * Der ausgehende Teil des Freigabe-Fanouts.
 *
 * Der Vorgangs-Dienst ist die Wahrheit und entscheidet atomar. Dieser Code darf deshalb nur eine
 * wartende Anfrage sichtbar machen; eine Antwort kommt als Matrix-Reaktion oder
 * Chat-Text (Matrix oder Telegram) und trifft denselben PATCH wie jede andere Sicht.
 *
 * Kanaele: Matrix (Nachricht mit Reaktions-Knoepfen) und Telegram (Textnachricht an die Direktnachricht
 * des Besitzers; geantwortet wird per Text). Es genuegt, wenn ein Kanal zustellt.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';

const TICKET = /^[A-Z]{2,6}-\d+$/i;
const MAX_BODY = 16 * 1024;
const TELEGRAM_API = 'https://api.telegram.org';
// Telegram erlaubt 4096 Zeichen je Nachricht; darunter bleiben.
const TELEGRAM_MAX_ZEICHEN = 4000;
const AKTIONSSICHT = /<!-- fyos-aktionsfreigabe-sicht:v1 -->\s*([\s\S]*?)\s*<!-- \/fyos-aktionsfreigabe-sicht:v1 -->/i;

function text(value, max) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

export function normalisiere_anfrage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON-Objekt erwartet');
  const ticket = text(value.ticket, 40).toUpperCase();
  const titel = text(value.titel, 200);
  if (!TICKET.test(ticket) || !titel) throw new Error('ungueltige Freigabe-Anfrage');
  return {
    ticket,
    titel,
    beschreibung: text(value.beschreibung, 1500),
    severity: text(value.severity, 32),
    ts: text(value.ts, 64),
  };
}

export function normalisiere_aufloesung(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON-Objekt erwartet');
  const ticket = text(value.ticket, 40).toUpperCase();
  const entscheidung = text(value.entscheidung, 16).toLowerCase();
  if (value.event !== 'aufgeloest' || !TICKET.test(ticket) || !['erteilt', 'abgelehnt'].includes(entscheidung)) {
    throw new Error('ungueltige Freigabe-Aufloesung');
  }
  return {event: 'aufgeloest', ticket, entscheidung, ts: text(value.ts, 64)};
}

/** Der Teil der Anfrage, der in jedem Kanal gleich ist: Ticket, Titel, Entscheidungsbrief, Verweis auf die Akte. */
function anfrage_teile(anfrage) {
  // Das Ticket kann lange technische Historie tragen. In der aktiven Chat-Sicht
  // darf sie die Entscheidung nicht verdecken: bei Aktionsfreigaben erscheint
  // ausschliesslich der explizite Kurzbrief; die vollstaendige Akte bleibt verlinkt.
  const sicht = AKTIONSSICHT.exec(anfrage.beschreibung)?.[1]?.trim() || anfrage.beschreibung;
  const details = sicht ? `\n\n${sicht}` : '';
  const severity = anfrage.severity ? ` · Dringlichkeit: ${anfrage.severity}` : '';
  return [
    `Freigabe angefragt: ${anfrage.ticket}${severity}`,
    anfrage.titel,
    `${details}`.trim(),
    `Technische Details, Diff und Logs: Vorgang ${anfrage.ticket}.`,
  ];
}

export function matrix_text(anfrage) {
  return [
    ...anfrage_teile(anfrage),
    'Reagiere direkt auf diese Nachricht: ✅ genehmigen · ❌ ablehnen · ➕ zusätzlicher Kommentar.',
    `Antworte mit \`genehmigt ${anfrage.ticket}\`, \`abgelehnt ${anfrage.ticket}\` oder \`kommentar ${anfrage.ticket}: …\`.`,
    'Die erste gueltige Antwort entscheidet; alle Sichten werden danach aktualisiert.',
  ].filter(Boolean).join('\n\n');
}

/** Telegram: reiner Text ohne Formatierung und ohne Reaktions-Knoepfe; geantwortet wird per Text. */
export function telegram_text(anfrage) {
  return [
    ...anfrage_teile(anfrage),
    `Antworte mit: genehmigt ${anfrage.ticket} · abgelehnt ${anfrage.ticket} · kommentar ${anfrage.ticket}: …`,
    'Die erste gueltige Antwort entscheidet; alle Sichten werden danach aktualisiert.',
  ].filter(Boolean).join('\n\n');
}

export function matrix_aufloesung_text(aufloesung) {
  const entscheidung = aufloesung.entscheidung === 'erteilt' ? 'erteilt' : 'abgelehnt';
  return [
    `Freigabe ${entscheidung}: ${aufloesung.ticket}`,
    entscheidung === 'erteilt'
      ? 'Der Vorgang wird von der gebundenen Sitzung des Agenten fortgesetzt.'
      : 'Der Vorgang wurde nach Triage verschoben; die angefragte Wirkung wird nicht ausgeführt.',
    'Diese Anfrage ist entschieden und in allen Sichten aufgelöst.',
  ].join('\n\n');
}

export function token_stimmt(gegeben, erwartet) {
  const left = Buffer.from(String(gegeben ?? ''));
  const right = Buffer.from(String(erwartet ?? ''));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

async function json(fetchImpl, url, init) {
  const antwort = await fetchImpl(url, init);
  if (!antwort.ok) throw new Error(`Matrix HTTP ${antwort.status}: ${(await antwort.text()).slice(0, 200)}`);
  return antwort.status === 204 ? {} : await antwort.json();
}

/** Liefert oder erzeugt genau einen DM-Raum fuer den Besitzer; der Raum wird als m.direct gemerkt. */
export async function sende_matrix_anfrage(anfrage, optionen) {
  const {homeserver, accessToken, botUserId, approverId, fetchImpl = fetch} = optionen;
  if (!homeserver || !accessToken || !botUserId || !approverId) throw new Error('Matrix-Fanout unvollstaendig konfiguriert');
  const basis = homeserver.replace(/\/$/, '');
  const headers = {Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json'};
  const konto = `${basis}/_matrix/client/v3/user/${encodeURIComponent(botUserId)}/account_data/m.direct`;
  let direkt = {};
  try { direkt = await json(fetchImpl, konto, {headers}); } catch (fehler) {
    if (!String(fehler.message).includes('Matrix HTTP 404')) throw fehler;
  }
  let raum = Array.isArray(direkt[approverId]) ? direkt[approverId][0] : undefined;
  if (!raum) {
    const erstellt = await json(fetchImpl, `${basis}/_matrix/client/v3/createRoom`, {
      method: 'POST', headers,
      body: JSON.stringify({invite: [approverId], is_direct: true, preset: 'trusted_private_chat'}),
    });
    raum = text(erstellt.room_id, 256);
    if (!raum) throw new Error('Matrix lieferte keine room_id');
    direkt[approverId] = [raum];
    await json(fetchImpl, konto, {method: 'PUT', headers, body: JSON.stringify(direkt)});
  }
  const txn = randomUUID();
  const gesendet = await json(fetchImpl,
    `${basis}/_matrix/client/v3/rooms/${encodeURIComponent(raum)}/send/m.room.message/${txn}`,
    {method: 'PUT', headers, body: JSON.stringify({msgtype: 'm.text', body: matrix_text(anfrage)})});
  const event_id = text(gesendet.event_id, 256);
  if (!event_id) throw new Error('Matrix lieferte keine event_id');
  // Element rendert diese drei eigenen Reaktionen als die Button-Zeile. Die
  // Aufloesung passiert im separaten Matrix-Listener, nicht im Chat-Hook.
  for (const key of ['✅', '❌', '➕']) {
    await json(fetchImpl,
      `${basis}/_matrix/client/v3/rooms/${encodeURIComponent(raum)}/send/m.reaction/${randomUUID()}`,
      {method: 'PUT', headers, body: JSON.stringify({'m.relates_to': {rel_type: 'm.annotation', event_id, key}})},
    );
  }
  return {room_id: raum, event_id};
}

/** Sendet die Abschlussnachricht in die schon verwendeten Räumen, ohne neue Knöpfe. */
export async function sende_matrix_aufloesung(aufloesung, optionen) {
  const {homeserver, accessToken, reaktionsspeicher, fetchImpl = fetch} = optionen;
  if (!homeserver || !accessToken) throw new Error('Matrix-Fanout unvollstaendig konfiguriert');
  const raeume = reaktionsspeicher?.raeume_fuer_ticket?.(aufloesung.ticket) || [];
  const basis = homeserver.replace(/\/$/, '');
  const headers = {Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json'};
  for (const raum of raeume) {
    await json(fetchImpl,
      `${basis}/_matrix/client/v3/rooms/${encodeURIComponent(raum)}/send/m.room.message/${randomUUID()}`,
      {method: 'PUT', headers, body: JSON.stringify({msgtype: 'm.text', body: matrix_aufloesung_text(aufloesung)})},
    );
  }
  await reaktionsspeicher?.loesche_prompts_fuer_ticket?.(aufloesung.ticket);
  return {raeume: raeume.length};
}

function ohne_token(meldung, token) {
  const roh = String(meldung ?? '');
  return token ? roh.split(token).join('***') : roh;
}

/**
 * Eine Textnachricht an die Direktnachricht des Besitzers (Bot-API von Telegram). In einem privaten Chat ist
 * die Chat-ID die Nutzer-ID. Der Bot kann dem Besitzer erst schreiben, nachdem dieser ihm einmal geschrieben
 * hat. Das Token steht im Pfad der Adresse und darf nie in einer Fehlermeldung oder im Log landen.
 */
export async function sende_telegram_nachricht(nachricht, optionen) {
  const {telegramToken, telegramChatId, fetchImpl = fetch} = optionen;
  if (!telegramToken || !telegramChatId) throw new Error('Telegram-Fanout unvollstaendig konfiguriert');
  const kennung = String(telegramChatId);
  if (!/^[1-9]\d{0,15}$/.test(kennung)) throw new Error('Telegram-Fanout: Besitzer-ID ist keine Nutzer-ID');
  try {
    const antwort = await fetchImpl(`${TELEGRAM_API}/bot${telegramToken}/sendMessage`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        chat_id: Number.isSafeInteger(Number(kennung)) ? Number(kennung) : kennung,
        text: String(nachricht).slice(0, TELEGRAM_MAX_ZEICHEN),
        disable_web_page_preview: true,
      }),
    });
    const koerper = await antwort.json().catch(() => ({}));
    if (!antwort.ok || koerper?.ok === false) {
      throw new Error(`Telegram HTTP ${antwort.status}: ${text(koerper?.description, 200)}`);
    }
    const id = koerper?.result?.message_id;
    return Number.isInteger(id) ? {message_id: id} : {};
  } catch (fehler) {
    throw new Error(ohne_token(fehler?.message ?? fehler, telegramToken));
  }
}

export const sende_telegram_anfrage = (anfrage, optionen) =>
  sende_telegram_nachricht(telegram_text(anfrage), optionen);

/** Abschlussnachricht; Telegram hat keine Knoepfe, die zu entfernen waeren. */
export const sende_telegram_aufloesung = (aufloesung, optionen) =>
  sende_telegram_nachricht(matrix_aufloesung_text(aufloesung), optionen);

/**
 * Stellt in allen eingerichteten Kanaelen zu. Ohne Telegram bleibt es beim bisherigen Weg (Matrix, auch bei
 * unvollstaendiger Konfiguration: dann ein Fehler). Ein gescheiterter Kanal wird protokolliert; es genuegt,
 * wenn ein Kanal zustellt.
 */
async function stelle_zu(art, wert, optionen) {
  const telegram = Boolean(optionen.telegramToken && optionen.telegramChatId);
  const matrix = !telegram || Boolean(optionen.homeserver);
  const versuche = [];
  if (matrix) {
    versuche.push(['matrix', art === 'aufloesung'
      ? sende_matrix_aufloesung(wert, optionen) : sende_matrix_anfrage(wert, optionen)]);
  }
  if (telegram) {
    versuche.push(['telegram', art === 'aufloesung'
      ? sende_telegram_aufloesung(wert, optionen) : sende_telegram_anfrage(wert, optionen)]);
  }
  const ergebnisse = await Promise.allSettled(versuche.map(([, zustellung]) => zustellung));
  const geliefert = {};
  ergebnisse.forEach((ergebnis, i) => {
    const kanal = versuche[i][0];
    if (ergebnis.status === 'fulfilled') { geliefert[kanal] = ergebnis.value; return; }
    optionen.logger?.warn(`fyos-freigabe-fanout (${kanal}): ${String(ergebnis.reason?.message ?? ergebnis.reason).slice(0, 300)}`);
  });
  return geliefert;
}

function antwort(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function lese_json(req) {
  const teile = [];
  let groesse = 0;
  for await (const teil of req) {
    groesse += teil.length;
    if (groesse > MAX_BODY) throw new Error('Nutzlast zu gross');
    teile.push(teil);
  }
  try { return JSON.parse(Buffer.concat(teile).toString('utf8')); }
  catch { throw new Error('ungueltiges JSON'); }
}

export function erstelle_fanout_handler(optionen) {
  return async (req, res) => {
    if (req.method !== 'POST') { antwort(res, 405, {ok: false, error: 'POST erwartet'}); return true; }
    if (!token_stimmt(req.headers['x-fyos-freigabe-relay'], optionen.relayToken)) {
      antwort(res, 401, {ok: false, error: 'nicht autorisiert'}); return true;
    }
    let nutzlast;
    try {
      const roh = await lese_json(req);
      nutzlast = roh?.event === 'aufgeloest'
        ? {art: 'aufloesung', wert: normalisiere_aufloesung(roh)}
        : {art: 'anfrage', wert: normalisiere_anfrage(roh)};
    } catch (fehler) {
      optionen.logger?.warn(`fyos-freigabe-fanout: ${String(fehler.message ?? fehler).slice(0, 300)}`);
      antwort(res, 400, {ok: false, error: 'ungueltige Freigabe-Nutzlast'});
      return true;
    }
    try {
      // Dieses Plugin darf keine beliebigen Kern-Genehmigungskarten erfinden.
      // Die native Karte entsteht ausschließlich aus OpenClaws `requireApproval`
      // beim echten, ticketgebundenen Tool-Call (fyos-prioritaet). Dieser Relay
      // liefert die Matrix- und Telegram-Sicht derselben Akte.
      const geliefert = await stelle_zu(nutzlast.art, nutzlast.wert, optionen);
      if (!geliefert.matrix && !geliefert.telegram) {
        antwort(res, 502, {ok: false, error: 'Fanout nicht zugestellt'});
        return true;
      }
      // Das Antwortformat des reinen Matrix-Betriebs bleibt unveraendert; Telegram kommt unter eigenem Schluessel dazu.
      const telegram = geliefert.telegram ? {telegram: geliefert.telegram} : {};
      if (nutzlast.art === 'aufloesung') {
        antwort(res, 200, {ok: true, ticket: nutzlast.wert.ticket, entscheidung: nutzlast.wert.entscheidung,
          ...geliefert.matrix, ...telegram});
        return true;
      }
      const anfrage = nutzlast.wert;
      if (geliefert.matrix) {
        try { await optionen.reaktionsspeicher?.merke_prompt({eventId: geliefert.matrix.event_id, ticket: anfrage.ticket, raum: geliefert.matrix.room_id}); }
        catch (fehler) { optionen.logger?.warn(`fyos-freigabe-speicher: ${String(fehler.message ?? fehler).slice(0, 200)}`); }
      }
      antwort(res, 200, {ok: true, ticket: anfrage.ticket, ...geliefert.matrix, ...telegram});
    } catch (fehler) {
      optionen.logger?.warn(`fyos-freigabe-fanout: ${String(fehler.message ?? fehler).slice(0, 300)}`);
      antwort(res, 502, {ok: false, error: 'Fanout nicht zugestellt'});
    }
    return true;
  };
}

export function registerFanout(api, config = {}) {
  // Telegram nur, wenn der Kanal in der Konfiguration an ist; Token und Besitzer-ID kommen aus der Umgebung.
  const telegramAn = api.config?.channels?.telegram?.enabled === true;
  api.registerHttpRoute({
    path: '/plugins/fyos-freigabe-chat/v1/requests', auth: 'plugin', match: 'exact',
    handler: erstelle_fanout_handler({
      relayToken: process.env.FYOS_FREIGABE_RELAY_TOKEN,
      accessToken: process.env.OPENCLAW_MATRIX_TOKEN,
      homeserver: api.config?.channels?.matrix?.homeserver,
      botUserId: api.config?.channels?.matrix?.userId,
      approverId: process.env.FYOS_APPROVER_MATRIX_ID || '',
      telegramToken: telegramAn ? process.env.OPENCLAW_TELEGRAM_TOKEN : undefined,
      telegramChatId: telegramAn ? process.env.FYOS_APPROVER_TELEGRAM_ID : undefined,
      logger: api.logger,
      reaktionsspeicher: config.reaktionsspeicher,
    }),
  });
}
