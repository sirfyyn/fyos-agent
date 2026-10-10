/**
 * fyos-bruecke — OpenClaw und der FYOS-Hub greifen ineinander, statt doppelt zu führen.
 *
 * Vertrag: docs/KOPPLUNG-OPENCLAW.md in fyos-os. Zwei Richtungen:
 *
 * - Ereignisse zum Hub: Hooks des Gateways werden zu knappen Ereignissen (Werkzeug- und Modellaufrufe, Läufe,
 *   Sitzungen, Cron, Skills). Nur Namen, Dauer und Ergebnis, nie Argumente, Ergebnisse oder Texte; Sitzungsschlüssel
 *   verlassen das Gateway nur gehasht. Eine begrenzte Warteschlange sammelt sie, ein Takt schickt sie gebündelt an
 *   POST <hub>/hub/openclaw/ereignisse, signiert mit dem Gateway-Token (HMAC-SHA256 über "<zeit>.<körper>"; das Token
 *   selbst geht nie hinaus). Ohne Ereignisse meldet sich die Brücke trotzdem regelmäßig (Lebenszeichen).
 * - Abfragen vom Hub: die Route POST /plugins/fyos-bruecke/v1/rpc (Gateway-Anmeldung, Rechte operator.write) reicht
 *   nur die Methoden aus ERLAUBT an das Gateway weiter. Dazu fyos.skill.lesen (Text eines Skills, den OpenClaw selbst
 *   listet) und fyos.bruecke.status.
 *
 * Diese Datei hängt nicht vom SDK ab: index.mjs reicht dispatchGatewayMethod und die Prüfung der Anmeldung herein,
 * damit die Tests ohne Gateway laufen.
 */
import {createHash, createHmac, randomUUID} from 'node:crypto';
import {readFile, stat} from 'node:fs/promises';
import {hostname} from 'node:os';

export const PLUGIN_ID = 'fyos-bruecke';
export const VERSION = '0.1.0';
export const RPC_PFAD = `/plugins/${PLUGIN_ID}/v1/rpc`;
export const EREIGNIS_PFAD = '/hub/openclaw/ereignisse';

/** Gateway-Methoden, die der Hub über die Brücke rufen darf. Alle brauchen höchstens operator.write. */
export const ERLAUBT = Object.freeze([
  'workboard.boards.list', 'workboard.boards.upsert',
  'workboard.cards.list', 'workboard.cards.create', 'workboard.cards.update', 'workboard.cards.move',
  'workboard.cards.comment', 'workboard.cards.archive',
  'skills.status', 'cron.list', 'cron.runs', 'cron.status', 'usage.cost', 'usage.status', 'health',
]);
/** Methoden, die die Brücke selbst beantwortet. */
export const EIGENE = Object.freeze(['fyos.skill.lesen', 'fyos.bruecke.status']);

export const VORGABEN = Object.freeze({
  intervallSekunden: 5,
  lebenszeichenSekunden: 60,
  warteschlangeMax: 1000,
  paketMax: 200,
  // Hub-Werkzeuge, die der Agent über MCP ruft, protokolliert der Hub selbst.
  werkzeugAuslassen: Object.freeze(['hub__', 'mcp__hub__', 'mcp-hub__']),
});

const KOERPER_MAX = 64 * 1024;
const SKILL_MAX = 512 * 1024;
const LAEUFE_MAX = 500;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

// ── Kleinteile ──────────────────────────────────────────────────────────────────────────────

/** Kurzer Name ohne Steuerzeichen. */
export function kurz(wert, grenze = 80) {
  if (wert === undefined || wert === null) return '';
  const text = String(wert).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return text.length > grenze ? text.slice(0, grenze) : text;
}

/** Ein Fehler ohne Inhalte: Code und erste Zeile der Meldung, gekürzt. */
export function fehlerText(fehler) {
  if (!fehler) return '';
  if (typeof fehler === 'object') {
    const code = typeof fehler.code === 'string' ? fehler.code : '';
    const meldung = typeof fehler.message === 'string' ? fehler.message.split('\n', 1)[0] : '';
    return kurz([code, meldung].filter(Boolean).join(': '), 120);
  }
  return kurz(String(fehler).split('\n', 1)[0], 120);
}

/** Sitzungsschlüssel verlassen das Gateway nur gehasht (die ersten 12 Zeichen von sha256). */
export function sitzungsHash(schluessel) {
  if (!schluessel) return '';
  return createHash('sha256').update(String(schluessel)).digest('hex').slice(0, 12);
}

/** Agent aus einem Sitzungsschlüssel der Form agent:<id>:… */
export function agentAusSchluessel(schluessel) {
  const treffer = /^agent:([^:]{1,64}):/.exec(String(schluessel ?? ''));
  return treffer ? treffer[1] : '';
}

/** Signatur einer Lieferung: sha256=<hex> von HMAC-SHA256(token, "<zeit>.<körper>"). */
export function signatur(token, zeit, koerper) {
  return 'sha256=' + createHmac('sha256', token).update(`${zeit}.`).update(koerper).digest('hex');
}

function dauer(wert) {
  const zahl = Number(wert);
  return Number.isFinite(zahl) && zahl >= 0 ? Math.round(zahl) : undefined;
}

function zahlIn(wert, min, max, vorgabe) {
  const zahl = Number(wert);
  return Number.isFinite(zahl) ? Math.min(max, Math.max(min, zahl)) : vorgabe;
}

function leer(text) {
  return text || undefined;
}

function agentVon(ctx, schluessel) {
  return leer(kurz(ctx?.agentId || agentAusSchluessel(schluessel), 40));
}

/** Adresse für die Ereignisse: hubUrl aus der Konfiguration, sonst FYOS_HUB_URL ohne den Pfad /mcp. */
export function hubZiel(konfig = {}, env = process.env) {
  let basis = kurz(konfig.hubUrl, 500);
  if (!basis) {
    const mcp = kurz(env.FYOS_HUB_URL, 500);
    if (!mcp) return '';
    basis = mcp.replace(/\/+$/, '').replace(/\/mcp$/, '');
  }
  try {
    const url = new URL(basis.replace(/\/+$/, '') + EREIGNIS_PFAD);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

// ── Ereignisse aus den Hooks ────────────────────────────────────────────────────────────────

export function werkzeugEreignis(event = {}, ctx = {}, {auslassen = VORGABEN.werkzeugAuslassen, uhr = Date.now} = {}) {
  const name = kurz(event.toolName ?? ctx.toolName, 80);
  if (!name || auslassen.some((anfang) => name.startsWith(anfang))) return null;
  const schluessel = ctx.sessionKey ?? event.sessionKey;
  return {
    art: 'werkzeug', zeit: uhr(), werkzeug: name, ok: !event.error,
    dauer_ms: dauer(event.durationMs), fehler: leer(fehlerText(event.error)),
    agent: agentVon(ctx, schluessel), sitzung: leer(sitzungsHash(schluessel ?? ctx.sessionId)),
    kanal: leer(kurz(ctx.channelId, 30)),
  };
}

/** Nachgeladene Werkzeuge (MCP, Plugins) ruft das Modell über das Steuer-Werkzeug tool_call. */
export const HUELLE = 'tool_call';
const AUFRUFE_MAX = 500;

/** Bereinigt einen Teil einer Aufruf-ID wie OpenClaw (sanitizeToolCallIdPart in tool-search). */
export function idTeil(wert) {
  return String(wert ?? '').trim().replace(/[^A-Za-z0-9_.:-]+/g, '_').slice(0, 120) || 'call';
}

/** Ziel einer Hülle aus params.id: Katalog-ID <quelle>:<herkunft>:<name> oder der Name selbst. */
export function huellenZiel(params) {
  const id = params && typeof params === 'object' && typeof params.id === 'string' ? params.id.trim() : '';
  const treffer = /^(?:openclaw|mcp|client):[^:]*:(.+)$/.exec(id);
  return kurz(treffer ? treffer[1] : id, 80);
}

/**
 * Werkzeugereignisse ohne Doppelzählung. Ruft das Modell ein Werkzeug über die Hülle tool_call, meldet OpenClaw zwei
 * after_tool_call: zuerst den inneren Aufruf (ID tool_call:<Hüllen-ID>:<Name>:<n>, echter Name), dann die Hülle.
 * Der innere zählt; die Hülle nur, wenn kein innerer kam (Läufer ohne eigenen Lebenszyklus), dann unter dem Namen
 * aus params.id. Kommt die Hülle doch zuerst, fällt der innere weg. Ausgelassen wird nach dem echten Namen.
 */
export function erzeugeWerkzeuge({auslassen = VORGABEN.werkzeugAuslassen, uhr = Date.now, max = AUFRUFE_MAX} = {}) {
  const innere = [];
  const huellen = [];
  const merke = (liste, wert) => {
    liste.push(wert);
    if (liste.length > max) liste.shift();
  };
  return {
    verarbeite(event, ctx) {
      const ereignis = event ?? {};
      const kontext = ctx ?? {};
      const id = String(ereignis.toolCallId ?? kontext.toolCallId ?? '');
      if (kurz(ereignis.toolName ?? kontext.toolName, 80) === HUELLE) {
        const anfang = `${HUELLE}:${idTeil(id)}:`;
        if (id && innere.some((x) => x.startsWith(anfang))) return null;
        if (id) merke(huellen, anfang);
        return werkzeugEreignis({...ereignis, toolName: huellenZiel(ereignis.params) || HUELLE}, kontext,
                                {auslassen, uhr});
      }
      if (id.startsWith(`${HUELLE}:`)) {
        if (huellen.some((x) => id.startsWith(x))) return null;
        merke(innere, id);
      }
      return werkzeugEreignis(ereignis, kontext, {auslassen, uhr});
    },
  };
}

export function modellEreignis(event = {}, ctx = {}, {uhr = Date.now} = {}) {
  const schluessel = event.sessionKey ?? ctx.sessionKey;
  return {
    art: 'modell', zeit: uhr(),
    anbieter: leer(kurz(event.provider ?? ctx.modelProviderId, 40)),
    modell: leer(kurz(event.model ?? ctx.modelId, 80)),
    ergebnis: event.outcome === 'error' ? 'error' : 'completed',
    dauer_ms: dauer(event.durationMs),
    fehlerart: leer(kurz(event.errorCategory ?? event.failureKind, 60)),
    agent: agentVon(ctx, schluessel), sitzung: leer(sitzungsHash(schluessel)),
  };
}

export function sitzungsEreignis(phase, event = {}, ctx = {}, {uhr = Date.now} = {}) {
  const ende = phase === 'ende';
  const schluessel = event.sessionKey ?? ctx.sessionKey;
  return {
    art: 'sitzung', zeit: uhr(), phase: ende ? 'ende' : 'beginn',
    sitzung: leer(sitzungsHash(schluessel ?? event.sessionId)), agent: agentVon(ctx, schluessel),
    grund: ende ? leer(kurz(event.reason, 30)) : (event.resumedFrom ? 'fortgesetzt' : undefined),
    dauer_ms: ende ? dauer(event.durationMs) : undefined,
  };
}

export function cronEreignis(event = {}, {uhr = Date.now} = {}) {
  const job = event.job && typeof event.job === 'object' ? event.job : {};
  return {
    art: 'cron', zeit: uhr(),
    aktion: leer(kurz(event.action, 20)),
    job: leer(kurz(event.jobId ?? job.id, 80)),
    name: leer(kurz(job.displayName ?? job.name, 80)),
    status: leer(kurz(event.status ?? event.completionStatus, 20)),
    dauer_ms: dauer(event.durationMs),
    fehler: leer(fehlerText(event.error)),
    naechster_ms: dauer(event.nextRunAtMs),
    agent: leer(kurz(event.agentId ?? job.agentId, 40)),
  };
}

export function skillEreignis(event = {}, {uhr = Date.now} = {}) {
  const artefakt = event.after ?? event.before ?? {};
  return {
    art: 'skill', zeit: uhr(), aktion: leer(kurz(event.action, 30)),
    name: leer(kurz(artefakt.name ?? artefakt.skillKey, 80)), quelle: leer(kurz(event.source ?? artefakt.source, 40)),
  };
}

export function vorschlagEreignis(event = {}, {uhr = Date.now} = {}) {
  const vorschlag = event.proposal ?? {};
  return {
    art: 'skill_vorschlag', zeit: uhr(), aktion: leer(kurz(event.action, 30)),
    name: leer(kurz(vorschlag.skillName ?? vorschlag.skillKey, 80)), status: leer(kurz(vorschlag.status, 30)),
  };
}

/** Läufe aus dem Lebenszyklus-Strom (bereinigt, ohne Text): Start merken, beim ersten Ende melden. */
export function erzeugeLaeufe({uhr = Date.now, max = LAEUFE_MAX} = {}) {
  const offen = new Map();
  const beendet = new Set();
  return {
    verarbeite(event = {}) {
      if (event.stream !== 'lifecycle') return null;
      const id = String(event.runId ?? '');
      const phase = event.data?.phase;
      if (!id || beendet.has(id)) return null;
      if (phase === 'start') {
        if (!offen.has(id)) offen.set(id, uhr());
        if (offen.size > max) offen.delete(offen.keys().next().value);
        return null;
      }
      if (phase !== 'end' && phase !== 'error') return null;
      beendet.add(id);
      if (beendet.size > max) beendet.delete(beendet.values().next().value);
      const beginn = offen.get(id);
      offen.delete(id);
      const schluessel = event.sessionKey;
      return {
        art: 'lauf', zeit: uhr(), ok: phase === 'end' && !event.data?.error,
        dauer_ms: beginn === undefined ? undefined : Math.max(0, uhr() - beginn),
        fehler: phase === 'error' ? fehlerText(event.data?.error) || 'error' : undefined,
        agent: agentVon(event, schluessel), sitzung: leer(sitzungsHash(schluessel ?? event.sessionId)),
      };
    },
    get offen() {
      return offen.size;
    },
  };
}

// ── Warteschlange und Lieferung ─────────────────────────────────────────────────────────────

/** Begrenzte Warteschlange: ist sie voll, fällt das älteste Ereignis heraus und wird gezählt. */
export function erzeugeWarteschlange(max = VORGABEN.warteschlangeMax) {
  let liste = [];
  let verworfen = 0;
  return {
    rein(ereignis) {
      if (!ereignis) return;
      liste.push(ereignis);
      if (liste.length > max) {
        liste.shift();
        verworfen += 1;
      }
    },
    nimm(anzahl) {
      return liste.splice(0, anzahl);
    },
    zurueck(teil) {
      if (!teil.length) return;
      liste = teil.concat(liste);
      if (liste.length > max) {
        verworfen += liste.length - max;
        liste = liste.slice(liste.length - max);
      }
    },
    verwerfen(anzahl) {
      verworfen += anzahl;
    },
    get laenge() {
      return liste.length;
    },
    get verworfen() {
      return verworfen;
    },
  };
}

/** Schickt Pakete an den Hub; nie zwei Lieferungen gleichzeitig, nach Fehlern mit wachsender Pause. */
export function erzeugeSender({ziel, token, warteschlange, kopf, fetchImpl = globalThis.fetch, uhr = Date.now, logger,
                               paketMax = VORGABEN.paketMax, lebenszeichenMs = VORGABEN.lebenszeichenSekunden * 1000,
                               zeitlimitMs = 8000}) {
  const stand = {gesendet: 0, lieferungen: 0, fehler: 0, folge: 0, letzterFehler: '', zuletzt: 0, naechsterVersuch: 0};
  let laufend = null;

  async function einmal() {
    const jetzt = uhr();
    if (!ziel) return 'ohne_ziel';
    if (jetzt < stand.naechsterVersuch) return 'warten';
    if (warteschlange.laenge === 0 && jetzt - stand.zuletzt < lebenszeichenMs) return 'nichts';
    const teil = warteschlange.nimm(paketMax);
    const koerper = JSON.stringify({bruecke: kopf(), ereignisse: teil});
    const zeit = String(jetzt);
    const koepfe = {'Content-Type': 'application/json', 'X-FYOS-Zeit': zeit};
    if (token) koepfe['X-FYOS-Signatur'] = signatur(token, zeit, koerper);
    let status = 0;
    try {
      const antwort = await fetchImpl(ziel, {method: 'POST', headers: koepfe, body: koerper,
                                             signal: AbortSignal.timeout(zeitlimitMs)});
      status = antwort.status;
      await antwort.text?.().catch(() => '');
      if (!antwort.ok) throw new Error(`HTTP ${status}`);
    } catch (fehler) {
      stand.fehler += 1;
      stand.folge += 1;
      stand.letzterFehler = fehlerText(fehler) || 'unbekannt';
      // Abgelehnt (4xx außer 408 und 429): Wiederholen hilft nicht, das Paket fällt weg und wird gezählt.
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) warteschlange.verwerfen(teil.length);
      else warteschlange.zurueck(teil);
      stand.naechsterVersuch = jetzt + Math.min(60000, 2000 * 2 ** Math.min(stand.folge - 1, 5));
      if (stand.folge === 1 || stand.folge % 20 === 0) {
        logger?.warn?.(`${PLUGIN_ID}: Hub nicht erreicht (${stand.letzterFehler}), ${warteschlange.laenge} Ereignisse warten`);
      }
      return 'fehler';
    }
    if (stand.folge > 0) logger?.info?.(`${PLUGIN_ID}: Hub wieder erreicht`);
    stand.folge = 0;
    stand.naechsterVersuch = 0;
    stand.zuletzt = jetzt;
    stand.gesendet += teil.length;
    stand.lieferungen += 1;
    return 'gesendet';
  }

  return {
    senden() {
      if (!laufend) laufend = einmal().finally(() => { laufend = null; });
      return laufend;
    },
    stand,
  };
}

// ── Abfragen vom Hub ────────────────────────────────────────────────────────────────────────

function mitStatus(status, code, meldung) {
  const fehler = new Error(meldung);
  fehler.status = status;
  fehler.rpcCode = code;
  return fehler;
}

const HTTP_FUER = {INVALID_REQUEST: 400, FORBIDDEN: 403, NOT_FOUND: 404, UNAVAILABLE: 503, AGENT_TIMEOUT: 504};

function httpStatus(fehler) {
  const code = String(fehler?.code ?? '');
  if (/conflict/i.test(code) || /conflict/i.test(String(fehler?.message ?? ''))) return 409;
  return HTTP_FUER[code] ?? 500;
}

function antworte(res, status, koerper) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(koerper));
}

async function leseJson(req, grenze) {
  const teile = [];
  let groesse = 0;
  for await (const teil of req) {
    groesse += teil.length;
    if (groesse > grenze) throw mitStatus(413, 'INVALID_REQUEST', 'Anfrage zu groß');
    teile.push(teil);
  }
  try {
    return JSON.parse(Buffer.concat(teile).toString('utf8') || 'null');
  } catch {
    throw mitStatus(400, 'INVALID_REQUEST', 'kein gültiges JSON');
  }
}

/** Text eines Skills, den OpenClaw selbst listet (skills.status); andere Dateien liest die Brücke nie. */
export async function leseSkill(name, dispatch, {lesen = readFile, groesse = stat} = {}) {
  const skillName = kurz(name, 120);
  if (!SKILL_NAME.test(skillName)) throw mitStatus(400, 'INVALID_REQUEST', 'name fehlt oder ist ungültig');
  const antwort = await dispatch('skills.status', {});
  if (!antwort?.ok) throw mitStatus(503, 'UNAVAILABLE', 'skills.status gescheitert');
  const skill = (antwort.payload?.skills ?? []).find((s) => s && s.name === skillName);
  if (!skill || typeof skill.filePath !== 'string' || !skill.filePath) {
    throw mitStatus(404, 'NOT_FOUND', `kein Skill ${skillName}`);
  }
  const info = await groesse(skill.filePath);
  if (info.size > SKILL_MAX) throw mitStatus(413, 'INVALID_REQUEST', `Skill ${skillName} ist zu groß`);
  return {name: skillName, text: await lesen(skill.filePath, 'utf8'), quelle: leer(kurz(skill.source, 40))};
}

/** Handler der Route RPC_PFAD (Anmeldung prüft das Gateway: auth "gateway"). */
export function erzeugeRpcHandler({dispatch, revalidate, status, logger, skillLesen}) {
  const erlaubt = new Set(ERLAUBT);
  const lesen = skillLesen ?? ((name) => leseSkill(name, dispatch));
  return async (req, res) => {
    if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
      res.setHeader('Allow', 'POST');
      antworte(res, 405, {ok: false, error: {code: 'METHOD_NOT_ALLOWED', message: 'POST erwartet'}});
      return true;
    }
    let anfrage;
    try {
      anfrage = await leseJson(req, KOERPER_MAX);
    } catch (fehler) {
      antworte(res, fehler.status ?? 400, {ok: false, error: {code: 'INVALID_REQUEST', message: fehler.message}});
      return true;
    }
    if (!anfrage || typeof anfrage !== 'object' || Array.isArray(anfrage) || typeof anfrage.method !== 'string'
        || !anfrage.method.trim()) {
      antworte(res, 400, {ok: false, error: {code: 'INVALID_REQUEST', message: 'method fehlt'}});
      return true;
    }
    const id = typeof anfrage.id === 'string' && anfrage.id.trim() ? kurz(anfrage.id, 80) : randomUUID();
    const methode = anfrage.method.trim();
    const params = anfrage.params && typeof anfrage.params === 'object' && !Array.isArray(anfrage.params)
      ? anfrage.params : {};
    if (!erlaubt.has(methode) && !EIGENE.includes(methode)) {
      antworte(res, 403, {id, ok: false, error: {code: 'FORBIDDEN', message: `Methode nicht freigegeben: ${kurz(methode, 80)}`}});
      return true;
    }
    // Abgelaufene Anmeldung: der Fehler gehört dem Gateway, das die Antwort dann selbst schreibt.
    await revalidate?.();
    try {
      if (methode === 'fyos.bruecke.status') {
        antworte(res, 200, {id, ok: true, payload: status()});
      } else if (methode === 'fyos.skill.lesen') {
        antworte(res, 200, {id, ok: true, payload: await lesen(params.name)});
      } else {
        const antwort = await dispatch(methode, params);
        if (antwort?.ok) {
          antworte(res, 200, {id, ok: true, payload: antwort.payload});
        } else {
          const fehler = antwort?.error ?? {code: 'UNAVAILABLE', message: 'Gateway-Methode ohne Antwort'};
          antworte(res, httpStatus(fehler), {id, ok: false, error: fehler});
        }
      }
    } catch (fehler) {
      const code = fehler?.rpcCode ?? 'UNAVAILABLE';
      if (!fehler?.rpcCode) logger?.warn?.(`${PLUGIN_ID}: ${methode}: ${fehlerText(fehler)}`);
      antworte(res, fehler?.status ?? httpStatus({code}),
               {id, ok: false, error: {code, message: fehlerText(fehler) || 'Gateway-Methode gescheitert'}});
    }
    return true;
  };
}

// ── Anmeldung im Gateway ────────────────────────────────────────────────────────────────────

/**
 * Meldet Hooks, Lebenszyklus-Abo, Dienst, Gateway-Methode und Route an.
 * abhaengigkeiten: {dispatch, revalidate, config, env, fetch, uhr} (index.mjs reicht dispatch und revalidate herein).
 */
export function registerBruecke(api, abhaengigkeiten = {}) {
  const konfig = {...VORGABEN, ...(abhaengigkeiten.config ?? api.pluginConfig ?? {})};
  const env = abhaengigkeiten.env ?? process.env;
  const uhr = abhaengigkeiten.uhr ?? Date.now;
  const logger = api.logger;
  const ziel = hubZiel(konfig, env);
  const token = String(env.OPENCLAW_GATEWAY_TOKEN ?? '').trim();
  const paketMax = zahlIn(konfig.paketMax, 1, 500, VORGABEN.paketMax);
  const warteschlange = erzeugeWarteschlange(zahlIn(konfig.warteschlangeMax, 10, 100000, VORGABEN.warteschlangeMax));
  const laeufe = erzeugeLaeufe({uhr});
  const auslassen = Array.isArray(konfig.werkzeugAuslassen)
    ? konfig.werkzeugAuslassen.map((x) => String(x)).filter(Boolean) : VORGABEN.werkzeugAuslassen;
  const gestartet = uhr();
  const instanz = kurz(env.HOSTNAME || hostname(), 80);
  const plugins = () => Object.entries(api.config?.plugins?.entries ?? {})
    .map(([id, eintrag]) => ({id, an: eintrag?.enabled !== false}));
  const kopf = () => ({version: VERSION, instanz, gestartet, verworfen: warteschlange.verworfen,
                       warteschlange: warteschlange.laenge, plugins: plugins()});
  const sender = erzeugeSender({
    ziel, token, warteschlange, kopf, uhr, logger, paketMax,
    fetchImpl: abhaengigkeiten.fetch ?? globalThis.fetch,
    lebenszeichenMs: zahlIn(konfig.lebenszeichenSekunden, 10, 3600, VORGABEN.lebenszeichenSekunden) * 1000,
  });
  const intervallMs = zahlIn(konfig.intervallSekunden, 1, 300, VORGABEN.intervallSekunden) * 1000;

  const rein = (ereignis) => {
    if (!ereignis) return;
    warteschlange.rein(ereignis);
    if (warteschlange.laenge >= paketMax) void sender.senden();
  };
  // Ein Hook darf das Gateway nie stören: Fehler beim Übersetzen kosten nur dieses Ereignis.
  const sicher = (uebersetzen) => (...args) => {
    try {
      rein(uebersetzen(...args));
    } catch (fehler) {
      logger?.debug?.(`${PLUGIN_ID}: Ereignis verworfen: ${fehlerText(fehler)}`);
    }
  };

  const werkzeuge = erzeugeWerkzeuge({auslassen, uhr});
  api.on('after_tool_call', sicher((event, ctx) => werkzeuge.verarbeite(event, ctx)));
  api.on('model_call_ended', sicher((event, ctx) => modellEreignis(event, ctx, {uhr})));
  api.on('session_start', sicher((event, ctx) => sitzungsEreignis('beginn', event, ctx, {uhr})));
  api.on('session_end', sicher((event, ctx) => sitzungsEreignis('ende', event, ctx, {uhr})));
  api.on('cron_changed', sicher((event) => cronEreignis(event, {uhr})));
  api.on('skill_changed', sicher((event) => skillEreignis(event, {uhr})));
  api.on('skill_proposal_changed', sicher((event) => vorschlagEreignis(event, {uhr})));
  const abo = api.agent?.events?.registerAgentEventSubscription;
  if (typeof abo === 'function') {
    abo.call(api.agent.events, {id: 'laeufe', streams: ['lifecycle'], handle: sicher((event) => laeufe.verarbeite(event))});
  }

  let timer = null;
  const stand = () => ({
    version: VERSION, hub: ziel || null, signiert: Boolean(token), laeuft: Boolean(timer),
    warteschlange: warteschlange.laenge, verworfen: warteschlange.verworfen, laeufe_offen: laeufe.offen,
    gesendet: sender.stand.gesendet, lieferungen: sender.stand.lieferungen, fehler: sender.stand.fehler,
    letzter_fehler: sender.stand.letzterFehler || null, zuletzt: sender.stand.zuletzt || null,
  });
  const starten = () => {
    if (timer || !ziel) return;
    timer = setInterval(() => { void sender.senden(); }, intervallMs);
    timer.unref?.();
    rein({art: 'hinweis', zeit: uhr(), stufe: 'info', text: `Brücke ${VERSION} gestartet`});
    void sender.senden();
  };
  const anhalten = async () => {
    if (timer) clearInterval(timer);
    timer = null;
    // Letzte Lieferung, aber das Herunterfahren nicht aufhalten.
    await Promise.race([sender.senden(), new Promise((fertig) => setTimeout(fertig, 1500).unref?.())]);
  };
  if (typeof api.registerService === 'function') {
    api.registerService({id: PLUGIN_ID, start: () => starten(), stop: () => anhalten()});
  } else {
    api.on('gateway_start', (ctx) => {
      starten();
      ctx?.abortSignal?.addEventListener?.('abort', () => { void anhalten(); }, {once: true});
    });
  }

  api.registerGatewayMethod?.('fyos.bruecke.status', () => stand(), {scope: 'operator.read'});
  if (typeof abhaengigkeiten.dispatch === 'function') {
    api.registerHttpRoute({
      path: RPC_PFAD, auth: 'gateway', match: 'exact',
      handler: erzeugeRpcHandler({dispatch: abhaengigkeiten.dispatch, revalidate: abhaengigkeiten.revalidate,
                                  status: stand, logger}),
    });
  } else {
    logger?.warn?.(`${PLUGIN_ID}: dispatchGatewayMethod fehlt, Abfragen vom Hub bleiben aus`);
  }
  if (!ziel) logger?.warn?.(`${PLUGIN_ID}: weder hubUrl noch FYOS_HUB_URL gesetzt, Ereignisse bleiben im Gateway`);
  else if (!token) logger?.warn?.(`${PLUGIN_ID}: OPENCLAW_GATEWAY_TOKEN fehlt, Lieferungen gehen unsigniert hinaus`);
  else logger?.info?.(`${PLUGIN_ID}: bereit, Ereignisse an ${ziel}`);

  return {warteschlange, sender, laeufe, stand, starten, anhalten, ziel};
}
