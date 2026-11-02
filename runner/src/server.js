/**
 * server.js — REST, SSE und die ausgelieferte Oberfläche.
 *
 * Der Server ist nur ein Fenster in die SQLite-Datei. Jede Aktion geht über den Runner und
 * damit über einen pi-durable-Commit; keine Route hält eigenen Zustand, der einen Neustart
 * nicht überlebt. SSE ist eine Projektion der Commits, kein zweiter Speicher.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { oeffentlicheSicht } from './config.js';
import { EinmalCodes } from './einmalcode.js';
import { OrdnerFehler, ordnerAuflisten, ordnerNochGueltig, wurzelHinzufuegen } from './ordner.js';
import { dateiLesen } from './datei.js';
import { RuheFehler } from './ruhe.js';
import { SucheFehler } from './suche.js';
import { VerwaltungsFehler } from './verwaltung.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpFehler extends Error {
  constructor(status, nachricht) {
    super(nachricht);
    this.status = status;
  }
}

function kopf(res, status, extra = {}) {
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extra,
  });
}

/** Das Anmelde-Cookie: HttpOnly, nur gleiche Seite, ein Jahr. Wert ist das vorgezeigte Token (nie das eines anderen Zugangs). */
function cookieSetzen(res, token) {
  res.setHeader('Set-Cookie', `fyos_runner=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Besitzer-Age=31536000`);
}

function json(res, status, daten) {
  const text = JSON.stringify(daten);
  kopf(res, status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sseKopf(res) {
  kopf(res, 200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': fyos-agent\n\n');
}

function sse(res, event, daten) {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(daten)}\n\n`);
  } catch {
    // Der Client ist weg; der Aufrufer räumt den Watcher über close ab.
  }
}

async function leseJson(req, grenze) {
  let groesse = 0;
  const stuecke = [];
  for await (const stueck of req) {
    groesse += stueck.length;
    if (groesse > grenze) throw new HttpFehler(413, `Anfrage größer als ${grenze} Bytes`);
    stuecke.push(stueck);
  }
  if (stuecke.length === 0) return {};
  const text = Buffer.concat(stuecke).toString('utf8');
  try {
    const wert = JSON.parse(text);
    return wert && typeof wert === 'object' ? wert : {};
  } catch {
    throw new HttpFehler(400, 'Ungültiges JSON');
  }
}

function tokenGleich(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Wer spricht? Der Name zum vorgezeigten Token: `app` für das Runner-Token, sonst der Name aus `security.tokens`
 * (z. B. `hub`), `lokal` ohne Token. Er kommt immer aus dem Token, nie vom Client (Ruhe-Schalter: `von`).
 */
export function tokenName(cfg, mitgebracht) {
  const token = cfg.pi_durable.security.token;
  if (!token) return 'lokal';
  if (tokenGleich(mitgebracht, token)) return 'app';
  for (const [name, geheim] of Object.entries(cfg.pi_durable.security.tokens ?? {})) {
    if (geheim && /^[a-z0-9_-]{1,20}$/.test(name) && tokenGleich(mitgebracht, geheim)) return name;
  }
  return null;
}

function cookieWert(req, name) {
  const roh = String(req.headers.cookie ?? '');
  for (const teil of roh.split(';')) {
    const i = teil.indexOf('=');
    if (i < 0) continue;
    if (teil.slice(0, i).trim() !== name) continue;
    try {
      return decodeURIComponent(teil.slice(i + 1).trim());
    } catch {
      return teil.slice(i + 1).trim();
    }
  }
  return '';
}

function tokenAusAnfrage(req, url) {
  return (
    url.searchParams.get('token') ??
    req.headers.authorization?.replace(/^Bearer\s+/i, '') ??
    cookieWert(req, 'fyos_runner') ??
    ''
  );
}

function erlaubteHerkunft(cfg, origin) {
  const liste = cfg.pi_durable.security.allowedOrigins ?? ['*'];
  if (!origin) return null;
  if (liste.includes('*') || liste.includes(origin)) return origin;
  return null;
}

export function erstelleServer({ runner, cfg, verwaltung = null, sprache = null }) {
  const grenze = cfg.pi_durable.limits.maxBodyBytes;
  const token = cfg.pi_durable.security.token;
  const clientDir = resolve(cfg.pi_durable.clientDir);
  const codes = new EinmalCodes();

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    const herkunft = erlaubteHerkunft(cfg, origin);
    if (herkunft) {
      res.setHeader('Access-Control-Allow-Origin', herkunft);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      kopf(res, herkunft ? 204 : 403, herkunft ? {} : { 'Content-Type': 'text/plain' });
      res.end();
      return;
    }

    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      json(res, 400, { ok: false, fehler: 'Ungültige Adresse' });
      return;
    }

    // Hinter dem FYOS-Proxy kann der Pfad `/agent/...` lauten; direkt ist er `/...`.
    let pfad = url.pathname;
    if (pfad === '/agent') pfad = '/';
    else if (pfad.startsWith('/agent/')) pfad = pfad.slice('/agent'.length);

    // Einmal-Code (Variante C): Seite mit `?code=…` öffnen -> Code einlösen, Cookie setzen, auf die Adresse OHNE Code weiterleiten.
    // Der Code gilt genau einmal und nur kurz; im Fensterverlauf steht danach nichts Brauchbares. Nur für Seiten, nie für die API.
    if (token && req.method === 'GET' && !pfad.startsWith('/api/') && url.searchParams.has('code')) {
      const geheim = codes.einloesen(url.searchParams.get('code') ?? '');
      if (!geheim) {
        json(res, 401, { ok: false, fehler: 'Code ungültig, abgelaufen oder schon benutzt' });
        return;
      }
      cookieSetzen(res, geheim);
      url.searchParams.delete('code');
      kopf(res, 302, { Location: `${url.pathname}${url.search}`, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    const mitgebracht = tokenAusAnfrage(req, url);
    const wer = tokenName(cfg, mitgebracht);
    if (token && wer === null) {
      json(res, 401, { ok: false, fehler: 'Nicht erlaubt' });
      return;
    }
    // Der Browser kann bei EventSource und statischen Dateien keinen Authorization-Kopf
    // setzen. Ein einmal gültig vorgezeigter Token wird deshalb als HttpOnly-Cookie
    // weitergetragen; der Token selbst bleibt aus dem sichtbaren Client-Code heraus.
    // Jedes gültige Token setzt sein EIGENES Cookie (Wert = das vorgezeigte Token, nie das Haupttoken): Ein benanntes Token
    // (`pi_durable.security.tokens`) bekam bis 28.10.2026 keins, und Stil und Skript lieferten dann 401 (Runner-Anmeldung,
    // Variante A in docs/current/RUNNER-ANMELDUNG-VORSCHLAG.md).
    if (token && wer !== null && wer !== 'lokal' && mitgebracht && !cookieWert(req, 'fyos_runner')) {
      cookieSetzen(res, mitgebracht);
    }

    try {
      if (pfad.startsWith('/api/')) {
        await routeApi({ req, res, url, pfad, runner, cfg, grenze, wer, verwaltung, sprache, codes });
        return;
      }
      await statisch(req, res, pfad, clientDir);
    } catch (fehler) {
      const status = fehler instanceof HttpFehler || fehler instanceof VerwaltungsFehler ? fehler.status : 500;
      if (status >= 500) console.error(`[fyos-runner] ${req.method} ${pfad}:`, fehler);
      if (!res.headersSent) json(res, status, { ok: false, fehler: fehler.message || 'Fehler' });
      else res.end();
    }
  });

  return server;
}

/**
 * Sprachkanal (src/sprache.js, FYOS-CLIENT-PROTOKOLL.md#sprache). Fehler der Sprachsitzung tragen ihren HTTP-Status.
 * `GET /api/sprache` Zustand · `GET /api/sprache/ereignisse` SSE · alles andere POST.
 */
async function routeSprache({ req, res, url, pfad, sprache, grenze }) {
  const methode = req.method ?? 'GET';
  if (!sprache) throw new HttpFehler(503, 'Sprachkanal nicht eingerichtet');
  const name = pfad.slice('/api/sprache'.length).replace(/^\/+/, '');
  try {
    if (methode === 'GET' && name === '') {
      json(res, 200, { ok: true, sprache: sprache.zustand() });
      return;
    }
    if (methode === 'GET' && name === 'ereignisse') {
      stromSprache(req, res, url, sprache);
      return;
    }
    if (methode !== 'POST' && methode !== 'PUT') throw new HttpFehler(405, 'Methode nicht erlaubt');
    const body = await leseJson(req, grenze);
    const antworten = {
      ausgabe: () => sprache.ausgabeMelden(body),
      sitzung: () => sprache.sitzungSetzen(body),
      aeusserung: () => sprache.aeusserung(body),
      unterbrechen: () => sprache.unterbrechen(body),
      fortsetzen: () => sprache.fortsetzen(),
      stopp: () => sprache.stoppen(body),
      antwort: () => sprache.antwort(body),
      freigabe: () => sprache.freigabeVorlesen(body),
      entscheidung: () => sprache.entscheiden(body),
      proaktiv: () => sprache.melden(body),
    };
    const f = antworten[name];
    if (!f) throw new HttpFehler(404, `Unbekannte Route: ${methode} ${pfad}`);
    const r = await f();
    json(res, 200, { ok: true, ...(r && typeof r === 'object' && !Array.isArray(r) ? r : { ergebnis: r }) });
  } catch (fehler) {
    if (fehler instanceof HttpFehler) throw fehler;
    if (Number.isInteger(fehler?.status) && fehler.status < 500) throw new HttpFehler(fehler.status, fehler.message);
    throw fehler;
  }
}

/** SSE der Sprachereignisse. `?client=iphone` filtert Ereignisse, die ein anderer Client abspielen soll; `Last-Event-ID` holt Verpasstes. */
function stromSprache(req, res, url, sprache) {
  const client = url.searchParams.get('client') || null;
  sseKopf(res);
  const schicke = (e) => {
    if (e.ziel && client && e.ziel !== client) return;
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(`id: ${e.seq}\nevent: ${e.typ}\ndata: ${JSON.stringify(e)}\n\n`);
    } catch {
      /* Client weg */
    }
  };
  sse(res, 'hallo', { zustand: sprache.zustand() });
  const letzte = Number(req.headers['last-event-id'] ?? url.searchParams.get('seit') ?? 0) || 0;
  if (letzte > 0) for (const e of sprache.seit(letzte)) schicke(e);
  const ab = sprache.beiEreignis(schicke);
  const timer = setInterval(() => {
    if (!res.writableEnded) res.write(': wach\n\n');
  }, 20_000);
  timer.unref?.();
  res.on('close', () => {
    clearInterval(timer);
    ab();
  });
}

/**
 * Verwaltung (Hub-App `runner`): lesen mit jedem gültigen Zugang, Befehle nur mit dem Token im Kopf
 * `Authorization: Bearer …` — ein Cookie genügt hier nicht, damit eine fremde Seite im selben Browser nichts auslösen kann.
 */
async function routeVerwaltung({ req, res, pfad, methode, cfg, grenze, verwaltung }) {
  if (!verwaltung) throw new HttpFehler(503, 'Verwaltung nicht eingerichtet');
  if (methode === 'GET' && pfad === '/api/verwaltung') {
    json(res, 200, await verwaltung.sicht());
    return;
  }
  if (methode === 'POST' && (pfad === '/api/steuern/eingang' || pfad === '/api/steuern/neustart')) {
    const kopfToken = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
    const soll = cfg.pi_durable.security.token;
    if (!soll || !tokenGleich(kopfToken, soll)) {
      json(res, 401, { ok: false, fehler: 'Befehle verlangen das Token im Kopf Authorization: Bearer' });
      return;
    }
    const body = await leseJson(req, grenze);
    const von = typeof body.von === 'string' && body.von.trim() ? body.von.trim().slice(0, 64) : 'verwaltung';
    if (pfad === '/api/steuern/eingang') {
      json(res, 200, await verwaltung.eingang(body.an, von));
      return;
    }
    json(res, 200, await verwaltung.neustart({ frist_s: body.frist_s, abbrechen: body.abbrechen === true }, von));
    return;
  }
  throw new HttpFehler(404, `Unbekannte Route: ${methode} ${pfad}`);
}

/**
 * Sitzung (Variante C): `POST /api/sitzung/code` stellt einen Einmal-Code aus. Verlangt das Token im Kopf `Authorization: Bearer`
 * (ein Cookie genügt nicht) und den Kopf `X-FYOS-Agent: 1`, den eine fremde Seite nicht setzen kann.
 */
function routeSitzung({ req, res, cfg, codes }) {
  if (req.method !== 'POST') throw new HttpFehler(405, 'Nur POST');
  if (req.headers['x-fyos-agent'] !== '1') throw new HttpFehler(400, 'Kopf X-FYOS-Agent: 1 fehlt');
  const kopfToken = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  const name = tokenName(cfg, kopfToken);
  if (name === null) {
    json(res, 401, { ok: false, fehler: 'Das Token im Kopf Authorization: Bearer fehlt oder gilt nicht' });
    return;
  }
  if (name === 'lokal') throw new HttpFehler(400, 'Kein Token eingerichtet: ein Code ist nicht nötig');
  const code = codes.ausstellen(kopfToken);
  if (!code) throw new HttpFehler(429, 'Zu viele offene Codes');
  json(res, 200, { ok: true, code, gueltig_s: codes.gueltig_s });
}

async function routeApi({ req, res, url, pfad, runner, cfg, grenze, wer, verwaltung, sprache, codes }) {
  const methode = req.method ?? 'GET';
  const teile = pfad.split('/').filter(Boolean);

  if (pfad === '/api/sitzung/code') {
    routeSitzung({ req, res, cfg, codes });
    return;
  }

  if (pfad === '/api/sprache' || pfad.startsWith('/api/sprache/')) {
    await routeSprache({ req, res, url, pfad, sprache, grenze });
    return;
  }

  if (pfad === '/api/verwaltung' || pfad.startsWith('/api/steuern/')) {
    await routeVerwaltung({ req, res, pfad, methode, cfg, grenze, verwaltung });
    return;
  }

  // Der Ruhe-Schalter (docs/current/RUNNER-RUHE.md). `von` kommt aus dem Token, nie aus dem Rumpf.
  if (pfad === '/api/ruhe' && methode === 'GET') {
    json(res, 200, { ok: true, ...runner.ruheZustand() });
    return;
  }
  if (pfad === '/api/ruhe' && methode === 'POST') {
    const body = await leseJson(req, grenze);
    try {
      json(res, 200, { ok: true, ...(await runner.ruheSetzen(body, wer)) });
    } catch (fehler) {
      if (fehler instanceof RuheFehler) throw new HttpFehler(fehler.status, fehler.message);
      throw fehler;
    }
    return;
  }

  if (methode === 'GET' && pfad === '/api/health') {
    json(res, 200, { ok: true, ...(await runner.health()), konfiguration: oeffentlicheSicht(cfg) });
    return;
  }

  if (methode === 'GET' && pfad === '/api/konfiguration') {
    json(res, 200, {
      ok: true,
      ...oeffentlicheSicht(cfg),
      modelle: await runner.modelle(),
      arbeitsbereiche: Object.fromEntries(
        Object.entries(cfg.arbeitsbereiche).map(([name, b]) => [name, { titel: b.titel, pfad: b.pfad }]),
      ),
      tokenGesetzt: !!cfg.pi_durable.security.token,
      piDurable: true,
      version: 1,
    });
    return;
  }

  // `?archiv=0` (Standard: ohne Archivierte), `1` (nur Archivierte), `alle`; jedes Gespräch trägt `archiviert`.
  if (methode === 'GET' && pfad === '/api/gespraeche') {
    try {
      json(res, 200, { ok: true, gespraeche: await runner.gespraeche({ archiv: url.searchParams.get('archiv') ?? undefined }) });
    } catch (fehler) {
      if (fehler instanceof SucheFehler) throw new HttpFehler(fehler.status, fehler.message);
      throw fehler;
    }
    return;
  }

  // Suche über Titel und sichtbaren Verlauf aller Sitzungen (src/suche.js). Nur lesend; das Token ist oben schon geprüft.
  if (methode === 'GET' && pfad === '/api/suche') {
    try {
      json(res, 200, await runner.suche({
        q: url.searchParams.get('q') ?? undefined,
        limit: url.searchParams.get('limit') ?? undefined,
        archiv: url.searchParams.get('archiv') ?? undefined,
      }));
    } catch (fehler) {
      if (fehler instanceof SucheFehler) throw new HttpFehler(fehler.status, fehler.message);
      throw fehler;
    }
    return;
  }

  // Ordner je Sitzung: Wurzeln und Unterordner zum Auswählen (src/ordner.js). Das Token ist oben schon geprüft.
  if (methode === 'GET' && pfad === '/api/ordner') {
    const wurzeln = cfg.pi_durable.ordnerErlaubt ?? [];
    try {
      const dateien = ['1', 'true'].includes(url.searchParams.get('dateien') ?? '');
      json(res, 200, { ok: true, ...(await ordnerAuflisten(wurzeln, url.searchParams.get('pfad'), { dateien, sperre: cfg.pi_durable.dateiSperre ?? [] })) });
    } catch (fehler) {
      if (!(fehler instanceof OrdnerFehler)) throw fehler;
      json(res, fehler.status, { ok: false, fehler: fehler.code, meldung: fehler.message, wurzeln, erlaubt: wurzeln.length > 0 });
    }
    return;
  }

  // Eine Textdatei lesen (src/datei.js): nur innerhalb des Ordners der Sitzung (`gespraech`, nur wenn sie einen eigenen
  // Ordner hat) oder einer erlaubten Wurzel. Nur lesend; das Token ist oben schon geprüft.
  if (methode === 'GET' && pfad === '/api/datei') {
    const wurzeln = cfg.pi_durable.ordnerErlaubt ?? [];
    try {
      let basis = null;
      const gespraechId = url.searchParams.get('gespraech');
      if (gespraechId) {
        let g = null;
        try {
          // Gesprächs-IDs sind in pi-durable Zahlen (wie bei /api/gespraech/:id).
          g = await runner.gespraech(/^\d+$/.test(gespraechId) ? Number(gespraechId) : gespraechId);
        } catch {
          g = null;
        }
        if (!g) throw new OrdnerFehler(404, 'gespraech_nicht_gefunden', 'Gespräch nicht gefunden');
        basis = ordnerNochGueltig(wurzeln, g.meta?.ordner);
      }
      const d = await dateiLesen({
        wurzeln,
        basis,
        sperre: cfg.pi_durable.dateiSperre ?? [],
        pfad: url.searchParams.get('pfad'),
        max: url.searchParams.get('max') ?? undefined,
      });
      json(res, 200, { ok: true, ...d });
    } catch (fehler) {
      if (!(fehler instanceof OrdnerFehler)) throw fehler;
      json(res, fehler.status, { ok: false, fehler: fehler.code, meldung: fehler.message });
    }
    return;
  }

  // Nur im lokalen Modus (FYOS_RUNNER_LOKAL=1, Vertrag des lokalen Runners der Hülle): die Hülle meldet einen im Systemdialog
  // gewählten Ordner als weitere Wurzel; sie gilt bis zum Prozessende. Sonst gibt es den Weg nicht (404 wie jede unbekannte Route).
  if (methode === 'POST' && pfad === '/api/ordner/erlauben' && cfg.pi_durable.lokal === true) {
    const body = await leseJson(req, grenze);
    const wurzeln = (cfg.pi_durable.ordnerErlaubt ??= []);
    try {
      await wurzelHinzufuegen(wurzeln, body?.pfad);
      json(res, 200, { ok: true, wurzeln });
    } catch (fehler) {
      if (!(fehler instanceof OrdnerFehler)) throw fehler;
      json(res, fehler.status, { ok: false, fehler: fehler.code, meldung: fehler.message, wurzeln });
    }
    return;
  }

  if (methode === 'POST' && pfad === '/api/gespraeche') {
    const body = await leseJson(req, grenze);
    if (body.ordner !== undefined && body.ordner !== null && typeof body.ordner !== 'string') {
      throw new HttpFehler(400, 'ordner muss ein absoluter Pfad (Text) sein');
    }
    try {
      const g = await runner.neuesGespraech(body);
      json(res, 201, { ok: true, gespraech: g });
    } catch (fehler) {
      // Jeder Ordnerfehler (nicht freigegeben, außerhalb, fehlt, kein Ordner) ist für den Aufrufer ein 400 mit klarer Meldung.
      if (fehler instanceof OrdnerFehler) throw new HttpFehler(400, `Ordner abgelehnt (${fehler.code}): ${fehler.message}`);
      throw fehler;
    }
    return;
  }

  // /api/gespraech/:id...
  if (teile[1] === 'gespraech' && teile[2]) {
    // Gesprächs-IDs sind in pi-durable Zahlen; aus der Adresse kommt ein Text.
    const rohId = decodeURIComponent(teile[2]);
    const id = /^\d+$/.test(rohId) ? Number(rohId) : rohId;
    const rest = teile.slice(3).join('/');

    if (methode === 'GET' && !rest) {
      const g = await runner.gespraech(id);
      if (!g) throw new HttpFehler(404, 'Gespräch nicht gefunden');
      json(res, 200, { ok: true, ...g });
      return;
    }

    if (methode === 'PATCH' && !rest) {
      const body = await leseJson(req, grenze);
      json(res, 200, { ok: true, gespraech: await runner.aendereGespraech(id, body) });
      return;
    }

    if (methode === 'GET' && rest === 'ansicht') {
      // `?voll=1`: auch den Verlauf vor Reset und Verdichtung (sonst nur das aktive Fenster).
      const a = await runner.ansicht(id, { voll: url.searchParams.get('voll') === '1' });
      if (!a) throw new HttpFehler(404, 'Gespräch nicht gefunden');
      json(res, 200, { ok: true, ...a });
      return;
    }

    if (methode === 'GET' && rest === 'ereignisse') {
      await stromGespräch(res, runner, id, { voll: url.searchParams.get('voll') === '1' });
      return;
    }

    if (methode === 'POST' && rest === 'nachricht') {
      // Nur die tiefe Ruhe hält auch Besitzer an (Standard lässt seine Nachrichten durch).
      if (runner.ruhe?.sperrtMax()) throw new HttpFehler(423, 'Ruhe (tief): Nachrichten werden nicht bearbeitet, bis die Ruhe aufgehoben ist');
      const body = await leseJson(req, grenze);
      if (body.kanal === 'sprache') {
        // Der Nachrichtenweg mit Kanal Sprache ist derselbe wie POST /api/sprache/aeusserung, nur mit festem Gespräch.
        if (!sprache) throw new HttpFehler(503, 'Sprachkanal nicht eingerichtet');
        try {
          json(res, 200, { ok: true, ...(await sprache.aeusserung({ text: body.text, client: body.client, requestId: body.requestId, gespraech: id })) });
        } catch (fehler) {
          if (Number.isInteger(fehler?.status) && fehler.status < 500) throw new HttpFehler(fehler.status, fehler.message);
          throw fehler;
        }
        return;
      }
      const r = await runner.sende(id, body.text, { art: body.art, requestId: body.requestId });
      json(res, 200, { ok: true, ...r });
      return;
    }

    if (methode === 'POST' && rest === 'abbrechen') {
      await runner.abbrechen(id);
      json(res, 200, { ok: true });
      return;
    }

    if (methode === 'POST' && rest === 'leeren') {
      const body = await leseJson(req, grenze);
      await runner.leeren(id, body.uebergabe);
      json(res, 200, { ok: true });
      return;
    }

    if (methode === 'POST' && rest === 'verdichten') {
      const body = await leseJson(req, grenze);
      const taskId = await runner.verdichten(id, body.hinweis);
      json(res, 200, { ok: true, taskId });
      return;
    }

    if (methode === 'POST' && rest === 'zweig') {
      const body = await leseJson(req, grenze);
      json(res, 201, { ok: true, gespraech: await runner.zweig(id, body.entryId, body.titel) });
      return;
    }

    if (methode === 'POST' && rest === 'laeufe') {
      const body = await leseJson(req, grenze);
      json(res, 201, { ok: true, lauf: await runner.neuerLauf(id, body) });
      return;
    }
  }

  if (methode === 'GET' && pfad === '/api/dokumente') {
    await stromDokumente(res, runner);
    return;
  }

  if (methode === 'GET' && pfad === '/api/freigaben') {
    json(res, 200, { ok: true, freigaben: await runner.freigaben() });
    return;
  }

  if (methode === 'POST' && teile[1] === 'freigaben' && teile[2]) {
    const body = await leseJson(req, grenze);
    const freigaben = await runner.entscheideFreigabe(decodeURIComponent(teile[2]), {
      entscheidung: body.entscheidung,
      notiz: body.notiz,
      von: body.von,
    });
    json(res, 200, { ok: true, freigaben });
    return;
  }

  if (methode === 'GET' && pfad === '/api/laeufe') {
    json(res, 200, { ok: true, laeufe: await runner.laeufe() });
    return;
  }

  if (methode === 'GET' && teile[1] === 'laeufe' && teile[2]) {
    const l = await runner.lauf(decodeURIComponent(teile[2]));
    if (!l) throw new HttpFehler(404, 'Lauf nicht gefunden');
    json(res, 200, { ok: true, lauf: l });
    return;
  }

  if (methode === 'POST' && teile[1] === 'laeufe' && teile[3] === 'abbrechen') {
    const r = await runner.laufAbbrechen(decodeURIComponent(teile[2]));
    json(res, 200, { ok: true, ergebnis: r });
    return;
  }

  // Harness2-Pilot (Schatten): Messlauf Propose, Probe, Compose; Ergebnis nur als Vorschlag im Ausgabeordner.
  if (methode === 'POST' && pfad === '/api/harness2') {
    const body = await leseJson(req, grenze);
    try {
      json(res, 201, { ok: true, lauf: await runner.neuerHarness2Pilot(body) });
    } catch (fehler) {
      throw new HttpFehler(400, fehler.message);
    }
    return;
  }

  if (methode === 'GET' && teile[1] === 'harness2' && teile[2]) {
    const stand = await runner.harness2Stand(decodeURIComponent(teile[2]));
    if (!stand) throw new HttpFehler(404, 'Pilot nicht gefunden');
    json(res, 200, { ok: true, lauf: stand });
    return;
  }

  // Nachtwerkstatt (Dreaming, Skillsmith, Nodesmith): Zustand, Start von Hand, Vorschläge schließen.
  if (methode === 'GET' && pfad === '/api/nachtwerkstatt') {
    json(res, 200, { ok: true, nachtwerkstatt: await runner.nachtwerkstattZustand() });
    return;
  }
  if (methode === 'POST' && pfad === '/api/nachtwerkstatt/start') {
    const body = await leseJson(req, grenze);
    try {
      json(res, 201, { ok: true, ...(await runner.nachtwerkstattStarten({ ...body, quelle: 'mensch' })) });
    } catch (fehler) {
      throw new HttpFehler(400, fehler.message);
    }
    return;
  }
  if (methode === 'GET' && teile[1] === 'nachtwerkstatt' && teile[2] === 'naechte' && teile[3]) {
    const stand = await runner.nachtwerkstattStand(decodeURIComponent(teile[3]));
    if (!stand) throw new HttpFehler(404, 'Nacht nicht gefunden');
    json(res, 200, { ok: true, nacht: stand });
    return;
  }
  if (methode === 'POST' && teile[1] === 'nachtwerkstatt' && teile[2] === 'vorschlaege' && teile[3]) {
    const body = await leseJson(req, grenze);
    try {
      json(res, 200, { ok: true, nachtwerkstatt: await runner.vorschlagSchliessen(decodeURIComponent(teile[3]), body.status) });
    } catch (fehler) {
      throw new HttpFehler(400, fehler.message);
    }
    return;
  }

  if (methode === 'GET' && pfad === '/api/strom') {
    await stromWirken(res, runner);
    return;
  }

  if (methode === 'GET' && pfad === '/api/zustand') {
    json(res, 200, { ok: true, zustand: await runner.zustand(), ...runner.ruheZustand() });
    return;
  }

  if ((methode === 'PUT' || methode === 'POST') && teile[1] === 'zustand' && teile[2]) {
    const body = await leseJson(req, grenze);
    const r = await runner.zustandSetzen(decodeURIComponent(teile[2]), body.wert ?? null);
    json(res, 200, { ok: true, ...r });
    return;
  }

  if (methode === 'DELETE' && teile[1] === 'zustand' && teile[2]) {
    const r = await runner.zustandSetzen(decodeURIComponent(teile[2]), null);
    json(res, 200, { ok: true, ...r });
    return;
  }

  if (methode === 'GET' && pfad === '/api/werkzeuge') {
    json(res, 200, { ok: true, werkzeuge: await runner.werkzeuge(url.searchParams.get('q') ?? '') });
    return;
  }

  if (methode === 'GET' && teile[1] === 'werkzeuge' && teile[2]) {
    json(res, 200, { ok: true, werkzeug: await runner.werkzeugSchema(decodeURIComponent(teile.slice(2).join('/'))) });
    return;
  }

  if (methode === 'GET' && pfad === '/api/modelle') {
    json(res, 200, { ok: true, modelle: await runner.modelle() });
    return;
  }

  if (methode === 'GET' && pfad === '/api/befehle') {
    const roh = url.searchParams.get('gespraech');
    const id = roh && /^\d+$/.test(roh) ? Number(roh) : null;
    if (roh && id === null) throw new HttpFehler(400, 'gespraech muss eine Nummer sein');
    if (id !== null && !(await runner.gespraech(id))) throw new HttpFehler(404, 'Gespräch nicht gefunden');
    const befehle = await runner.befehle.liste(id);
    json(res, 200, { ok: true, befehle, anzahl: befehle.length });
    return;
  }

  if (methode === 'GET' && pfad === '/api/knoten') {
    const knoten = runner.knotenListe();
    if (url.searchParams.get('pruefen') === '1') {
      const status = await runner.knotenPruefen();
      const nach = new Map(status.map((s) => [s.id, s]));
      for (const k of knoten) Object.assign(k, nach.get(k.id) ?? { ok: false });
    }
    json(res, 200, { ok: true, knoten });
    return;
  }

  throw new HttpFehler(404, `Unbekannte Route: ${methode} ${pfad}`);
}

async function stromGespräch(res, runner, id, { voll = false } = {}) {
  sseKopf(res);
  const strom = await runner.watchConversation(id, { voll });
  sse(res, 'snapshot', strom.snapshot);
  strom.start(async (ereignisse) => {
    sse(res, 'ereignisse', ereignisse);
  });
  const timer = setInterval(() => {
    if (!res.writableEnded) res.write(': wach\n\n');
  }, 20_000);
  timer.unref?.();
  res.on('close', () => {
    clearInterval(timer);
    void strom.stop();
  });
}

/**
 * Der Strom der autonomen Arbeit (siehe wirken.js): kurze Zeilen über alle Gespräche und Läufe.
 * Standard für jeden Client; ausblenden ist Sache des Clients (`/live`), nicht des Servers.
 */
async function stromWirken(res, runner) {
  sseKopf(res);
  const strom = await runner.oeffneWirkenStrom();
  sse(res, 'hallo', { ...strom.werte(), ...runner.ruheZustand() });
  strom.start(async (zeile) => sse(res, 'zeile', zeile));
  const ruheAb = ruheAnhaengen(res, runner);
  const timer = setInterval(() => {
    if (!res.writableEnded) res.write(': wach\n\n');
  }, 20_000);
  timer.unref?.();
  res.on('close', () => {
    clearInterval(timer);
    ruheAb();
    void strom.stop();
  });
}

/** Jede Änderung des Ruhe-Schalters sofort als `event: ruhe` (Zustand wie `GET /api/ruhe`). Gibt die Abmeldung zurück. */
function ruheAnhaengen(res, runner) {
  return runner.ruhe.beiAenderung((z) => {
    const { art, ...ruhe } = z;
    sse(res, 'ruhe', { art, ruhe, pausiert: ruhe.pausiert, spielmodus: ruhe.spielmodus });
  });
}

async function stromDokumente(res, runner) {
  sseKopf(res);
  const docs = await runner.oeffneDokumenteStrom();
  const aufgaben = await runner.oeffneAufgabenStrom();
  sse(res, 'dokumente', { dokumente: docs.werte, aufgaben: aufgaben.wert });
  docs.start((name, wert) => sse(res, 'dokument', { name, wert }));
  aufgaben.start((wert) => sse(res, 'aufgaben', wert));
  const ruheAb = ruheAnhaengen(res, runner);
  const timer = setInterval(() => {
    if (!res.writableEnded) res.write(': wach\n\n');
  }, 20_000);
  timer.unref?.();
  res.on('close', () => {
    clearInterval(timer);
    ruheAb();
    void docs.stop();
    void aufgaben.stop();
  });
}

async function statisch(req, res, pfad, clientDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new HttpFehler(405, 'Methode nicht erlaubt');
  }
  let relativ;
  try {
    relativ = decodeURIComponent(pfad);
  } catch {
    throw new HttpFehler(400, 'Ungültiger Pfad');
  }
  if (relativ.includes('\0') || relativ.split('/').includes('..')) throw new HttpFehler(400, 'Ungültiger Pfad');
  if (relativ.endsWith('/')) relativ += 'index.html';
  const datei = resolve(join(clientDir, relativ));
  if (!datei.startsWith(clientDir + sep) && datei !== join(clientDir, 'index.html')) {
    throw new HttpFehler(403, 'Pfad außerhalb des Clients');
  }
  if (!existsSync(datei) || !statSync(datei).isFile()) {
    throw new HttpFehler(404, 'Nicht gefunden');
  }
  const endung = extname(datei).toLowerCase();
  const typ = MIME[endung] ?? 'application/octet-stream';
  const istHtml = endung === '.html';
  kopf(res, 200, {
    'Content-Type': typ,
    'Cache-Control': istHtml ? 'no-store' : 'no-cache',
    ...(endung === '.js' ? { 'Service-Worker-Allowed': '/' } : {}),
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(datei).pipe(res);
}
