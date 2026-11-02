/**
 * steuerkanal.js — kleiner HTTP-Kanal auf Loopback für Prüfung und Betrieb.
 *
 * Port von `Steuerkanal`/`_SteuerHandler` des RPC-Runners, gleiche Routen und Antwortformen
 * (Vorgabe 127.0.0.1:18435, `cfg.steuer = { host, port }`):
 *
 *   GET  /healthz     {ok, version}          (auch /health)
 *   GET  /zustand     Sitzung, Warteschlange, Meldestrecke, Budget, Spielmodus, Tore, laufender Eingang, Sitzungen (Läufe),
 *                     Welt, Reflexe, Aufzeichnung, Takt, ITSM, Chat — gleiche Schlüssel wie im RPC-Runner;
 *                     dazu `stimme` (Messung der Sprachsätze: n, p50, p95, letzte, siehe stimme.js)
 *                     neu: gedaechtnis {an, fakten, letzte_aufnahme, qdrant_ok, …} (S5)
 *                     neu: `freigabe_meldung` (Kanäle, Zähler, Fehler der Freigabe-Meldung)
 *                     neu: `freigabe_kontext` (Kurzkontext der Freigaben: vom Modell, Rückfall, Abweichungen; Entscheidung 586)
 *                     neu (25.10.2026):
 *                     `arbeitsschleife` (an, stufe, letzter_vorgang, zuege_stunde, zuege_tag, naechster),
 *                     `version` (Paketversion+Git-Stand aus der Datei VERSION) und `gesundheit` (Ampel ok/gelb/rot mit Gründen, Zähler
 *                     von Ausgang, Eingang und Zug; src/gesundheit.js)
 *   GET  /welt        {ok, welt, block}      das Weltbild und der Weltblock des nächsten prompt
 *   GET  /sitzungen   Hauptgespräch und die übrigen Gespräche
 *   POST /auftrag     {"text", "klasse": "max"|"hintergrund"}  — Klasse `max` kommt zuerst
 *   POST /abbrechen   bricht den laufenden Zug des Hauptgesprächs ab
 *   POST /dialog      pi-Dialoge gibt es im dauerhaften Runner nicht: antwortet 400 „Dialogwache aus“
 *   POST /takt        {"id": "morgen"} — einen Takt jetzt auslösen (geht trotzdem durch schleifen.darf)
 *   POST /aufzeichnung {"an": true|false} — Aufzeichnung zur Laufzeit schalten
 *   GET  /schatten/bericht?tage=7   Auswertung des Schatten-Rekorders (nur Zahlen) samt Tor „bereit für aktiv“
 *   POST /schatten/wahrheit {"ein", "urteil": "gut"|"schlecht"|"korrektur", "werkzeug"?}  — Besitzer' Rückmeldung an einem Zug
 *   (`/zustand.schatten` zeigt die Zähler je Adapter ohne Inhalte)
 *   POST /ruhe        {"an": true|false, "bis"?: ISO, "grund"?, "stufe"?: "normal"|"tief", "sofort"?} — Ruhe-Schalter (RUNNER-RUHE.md)
 *
 * Kein Token (nur Loopback). Damit eine Webseite im Browser den Kanal nicht über localhost
 * erreicht, lehnt er Anfragen mit `Origin`-Kopf und fremdem `Host`-Kopf ab (das RPC-Original
 * prüfte das nicht). Gebunden wird auf `cfg.steuer.host`; ohne Angabe 127.0.0.1, nie 0.0.0.0.
 *
 * Alle Teile außer `cfg` und `runner` dürfen fehlen; die Route antwortet dann wie der RPC-Runner
 * bei abgeschalteter Komponente. Den Zusammenbau ruft `await steuer.starten()`.
 */
import { createServer } from 'node:http';
import { KONTEXT, LIVE as LiveDoc } from './lauf/index.js';
import { LaufListe, Laufzeit, Wartend } from './documents.js';
import { kontextZaehler } from './freigabe-kontext.js';
import { RuheFehler } from './ruhe.js';
import { bewerte } from './gesundheit.js';
import { versionErmitteln } from './version.js';

export const VERSION = 1;
const CTX = KONTEXT;
const HOST_VORGABE = '127.0.0.1';
const PORT_VORGABE = 18435;
const BODY_MAX = 64 * 1024;
const AUFTRAG_MAX_VORGABE = 20_000;

const aufruf = (teil, name) => (typeof teil?.[name] === 'function' ? teil[name]() : teil?.[name]);

export function erstelleSteuerkanal({
  cfg,
  runner,
  ingress,
  hub: _hub,
  welt,
  takt,
  aufzeichnung,
  budget,
  tor,
  lesenTor,
  spielmodus,
  egress,
  reflexe,
  itsm,
  chat,
  stimme,
  gedaechtnis,
  freigabeMeldung,
  arbeit,
  schatten,
  zusatz,
  versionInfo = versionErmitteln(),
  jetzt = () => Date.now(),
  log = (z) => console.log(z),
} = {}) {
  const gestartet = jetzt();
  const steuer = cfg?.steuer && typeof cfg.steuer === 'object' ? cfg.steuer : {};
  const host = String(steuer.host || HOST_VORGABE);
  const port = Number.isInteger(Number(steuer.port)) ? Number(steuer.port) : PORT_VORGABE;
  const auftragMax = Number(cfg?.auftrag_max_zeichen) > 0 ? Number(cfg.auftrag_max_zeichen) : AUFTRAG_MAX_VORGABE;
  const erlaubteHosts = new Set(['127.0.0.1', 'localhost', '[::1]', host.replace(/^\[|\]$/g, '')]);
  const wurzelId = () => runner?.root?.id ?? null;

  const sende = (res, status, nutz) => {
    const roh = Buffer.from(JSON.stringify(nutz), 'utf8');
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': roh.length });
    res.end(roh);
  };

  /** Rumpf als Objekt; sendet selbst den Fehler und gibt dann `null` zurück. `leerOk`: leerer Rumpf gilt als `{}`. */
  async function lies(req, res, { leerOk = false } = {}) {
    const stuecke = [];
    let laenge = 0;
    for await (const stueck of req) {
      laenge += stueck.length;
      if (laenge > BODY_MAX) {
        // Antworten, dann die Verbindung schließen; der Rest des Rumpfes wird nicht mehr gelesen.
        res.shouldKeepAlive = false;
        sende(res, 400, { ok: false, error: 'Anfrage leer oder zu groß' });
        res.once('finish', () => req.destroy());
        return null;
      }
      stuecke.push(stueck);
    }
    if (laenge === 0) {
      if (leerOk) return {};
      sende(res, 400, { ok: false, error: 'Anfrage leer oder zu groß' });
      return null;
    }
    let daten;
    try {
      daten = JSON.parse(Buffer.concat(stuecke).toString('utf8'));
    } catch {
      sende(res, 400, { ok: false, error: 'ungültiges JSON' });
      return null;
    }
    if (!daten || typeof daten !== 'object' || Array.isArray(daten)) {
      sende(res, 400, { ok: false, error: 'Objekt erwartet' });
      return null;
    }
    return daten;
  }

  async function wartendZaehlen() {
    try {
      const doc = await runner.harness.snapshot(Wartend, CTX);
      const liste = doc?.eintraege ?? [];
      const max = liste.filter((x) => x.klasse === 'max').length;
      return { max, hintergrund: liste.length - max };
    } catch {
      return { max: 0, hintergrund: 0 };
    }
  }

  /** Alter der ältesten wartenden Nachricht von Besitzer in s; `null`, wenn keine liegt. */
  async function maxWartetS() {
    try {
      const doc = await runner.harness.snapshot(Wartend, CTX);
      const alt = (doc?.eintraege ?? []).filter((x) => x.klasse === 'max').map((x) => Number(x.angenommen)).filter(Number.isFinite);
      return alt.length ? Math.max(0, Math.round((jetzt() - Math.min(...alt)) / 1000)) : null;
    } catch {
      return null;
    }
  }

  /** `gesundheit` in `/zustand`: Zähler des Ausgangs und des Eingangs, Zug, Ampel mit Gründen (src/gesundheit.js). */
  async function gesundheitBild(laeuft) {
    const ausgang = typeof egress?.gesundheit === 'function' ? egress.gesundheit() : null;
    const eingangG = typeof ingress?.gesundheit === 'function' ? ingress.gesundheit() : null;
    const zug = typeof egress?.zugStand === 'function' && wurzelId() !== null ? egress.zugStand(wurzelId()) : null;
    const maxWartet = await maxWartetS();
    const spiel = spielmodus ? Boolean(aufruf(spielmodus, 'an')) : false;
    const urteil = bewerte({
      jetzt: jetzt(),
      pi_laeuft: Boolean(runner?.harness) && !runner?.geschlossen,
      spielmodus: spiel,
      beschaeftigt: laeuft,
      ausgang,
      eingang: eingangG,
      zug,
      max_wartet_s: maxWartet,
    });
    return {
      ...urteil,
      jetzt: jetzt(),
      gestartet,
      laufzeit_s: Math.round((jetzt() - gestartet) / 1000),
      ausgang,
      eingang: eingangG,
      zug,
      max_wartet_s: maxWartet,
    };
  }

  async function beschaeftigt() {
    const id = wurzelId();
    if (!id) return false;
    try {
      const live = await runner.harness.snapshot(LiveDoc, id, CTX);
      return Boolean(live?.run);
    } catch {
      return false;
    }
  }

  /** Läufe (aufgabe_starten) sind die Arbeitssitzungen des dauerhaften Runners: Zahl und Status je Art. */
  async function laufStatus() {
    try {
      const doc = await runner.harness.snapshot(LaufListe, CTX);
      const liste = Object.values(doc?.eintraege ?? {});
      const status = {};
      for (const e of liste) status[String(e.status)] = (status[String(e.status)] ?? 0) + 1;
      return { arbeit: liste.length, status };
    } catch {
      return { arbeit: 0, status: {} };
    }
  }

  /** Form von `_sitzungen_kurz` im RPC-Runner: {haupt, aktiv, arbeit, status, berichte_offen, zug}. */
  async function sitzungenKurz(laeuft) {
    const { arbeit, status } = await laufStatus();
    return {
      haupt: wurzelId(),
      aktiv: wurzelId(),
      arbeit,
      status,
      berichte_offen: 0, // Berichte gibt es nicht: ein Lauf schließt mit eigener Antwort im Gespräch ab
      zug: laeuft ? { nr: null, modus: 'haupt', eintrag: null, phase: 'laeuft', unterbrochen: false } : null,
    };
  }

  async function zustandBild() {
    const tore = (t) => (t ? t.zustand() : null);
    const laeuft = await beschaeftigt();
    // Welcher Eingang den offenen Zug des Hauptgesprächs ausgelöst hat (nur wenn der Ausgang läuft und der Zug noch offen ist).
    const roh = laeuft && wurzelId() !== null && typeof egress?.laufend === 'function' ? egress.laufend(wurzelId()) : null;
    const laufend = roh ? { quelle: roh.quelle ?? null, klasse: roh.klasse ?? null, ein: roh.ein ?? null, bezug: roh.bezug ?? null } : null;
    let eingang = null;
    if (ingress) {
      let lz = null;
      try {
        lz = await runner.harness.snapshot(Laufzeit, CTX);
      } catch {
        /* Zähler fehlen dann */
      }
      eingang = {
        nach: ingress.cursor ?? null,
        gelesen: lz?.eingangGesehen ?? null,
        fehler: lz?.eingangFehler ?? null,
        letzter_kontakt: null,
      };
    }
    return {
      ok: true,
      // `version` ist die laufende Fassung („Paketversion+Git-Stand“, Datei VERSION); die frühere Zahl 1 (Form des Steuerkanals)
      // steht in `zustand_version`.
      version: versionInfo.version,
      version_info: versionInfo,
      zustand_version: VERSION,
      agent: cfg?.agent ?? null,
      sitzung: wurzelId(),
      beschaeftigt: laeuft,
      wartend: await wartendZaehlen(),
      meldestrecke: egress ? egress.meldestrecke() : { stau: 0, gemeldet: 0, verworfen: 0 },
      budget: budget ? budget.zustand() : null,
      spielmodus: spielmodus ? Boolean(aufruf(spielmodus, 'an')) : false,
      ruhe: runner?.ruhe ? runner.ruhe.zustand() : null,
      pi_laeuft: Boolean(runner?.harness) && !runner?.geschlossen,
      eingang,
      hintergrund_tor: tore(tor),
      hintergrund_tor_lesen: tore(lesenTor),
      laufend,
      sitzungen: await sitzungenKurz(laeuft),
      welt: welt ? welt.zustand() : null,
      reflexe: reflexe ? reflexe.zustand() : null,
      aufzeichnung: aufzeichnung ? aufzeichnung.zustand() : { an: false, datei: null, zeilen: 0, fehler: null },
      befehle: runner?.befehle ? await runner.befehle.zustand() : null,
      dialoge: null, // pi-durable hat keine Dialoge (Freigaben warten dauerhaft)
      takt: takt ? takt.zustand() : null,
      itsm: itsm ? itsm.zustand() : null,
      chat: chat ? chat.zustand() : null,
      // Sprachsätze (Bezug stimme): {n, p50, p95, kalt, letzte[…]}, Zeiten in ms, prompt in Token. Nur Zahlen.
      stimme: stimme ? await stimme.zustand() : null,
      gedaechtnis: gedaechtnis ? gedaechtnis.zustand() : { an: false, fakten: 0, letzte_aufnahme: null, qdrant_ok: null },
      freigabe_meldung: freigabeMeldung ? freigabeMeldung.zustand() : null,
      freigabe_kontext: kontextZaehler.zustand(),
      gesundheit: await gesundheitBild(laeuft),
      // Neu gegenüber dem RPC-Runner: die Arbeitsschleife {an, stufe, letzter_vorgang, zuege_stunde, zuege_tag, naechster, …}.
      arbeitsschleife: arbeit ? arbeit.zustand() : null,
      // Schatten-Rekorder: Zähler je Adapter (eingereiht, ok, fehler, timeout, übersprungen), nie Inhalte.
      schatten: schatten ? schatten.zustand() : null,
      ...(typeof zusatz === 'function' ? await zusatz() : {}),
    };
  }

  async function weltSicht() {
    return { ok: true, welt: welt ? welt.welt() : null, block: welt ? welt.weltblock() : '' };
  }

  async function sitzungenSicht() {
    const haupt = { datei: null, id: wurzelId() };
    let liste = [];
    try {
      liste = await runner.gespraeche();
    } catch {
      /* Liste fehlt dann */
    }
    return {
      ok: true,
      an: true,
      haupt,
      arbeit: liste
        .filter((g) => g.id !== haupt.id)
        .map((g) => ({ schluessel: g.id, id: g.id, titel: g.titel, art: g.art, erstellt: g.erstellt })),
      berichte: [],
    };
  }

  async function auftrag(daten) {
    const text = String(daten.text ?? '').trim();
    if (!text) return [400, { ok: false, error: 'Text fehlt' }];
    if (text.length > auftragMax) return [400, { ok: false, error: `Auftrag zu lang (höchstens ${auftragMax} Zeichen)` }];
    if (!ingress) return [503, { ok: false, error: 'Eingang aus' }];
    const klasse = daten.klasse === 'max' ? 'max' : 'hintergrund';
    aufzeichnung?.schreibe?.('steuer', { auftrag: { text, klasse } });
    const id = `steuer:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await ingress.einreihen({ id, text, quelle: 'steuer', von: 'steuer', klasse });
    return [200, { ok: true, angenommen: true, klasse }];
  }

  async function abbrechen() {
    const id = wurzelId();
    if (!id) return { ok: false, error: 'Kein Hauptgespräch' };
    try {
      await runner.abbrechen(id);
    } catch (fehler) {
      return { ok: false, error: String(fehler?.message ?? fehler) };
    }
    return { ok: true };
  }

  async function taktAusloesen(daten) {
    if (!takt || takt.an === false || typeof takt.ausloesen !== 'function') return [400, { ok: false, error: 'Takt aus' }];
    return [200, await takt.ausloesen(String(daten.id ?? ''))];
  }

  function aufzeichnungSchalten(daten) {
    if (typeof daten.an !== 'boolean') return [400, { ok: false, error: 'an: true oder false' }];
    if (!aufzeichnung) return [400, { ok: false, error: 'Aufzeichnung aus' }];
    aufzeichnung.schalten(daten.an);
    return [200, { ok: true, an: Boolean(aufruf(aufzeichnung, 'an')), datei: String(aufzeichnung.datei()) }];
  }

  function schattenWahrheit(daten) {
    if (!schatten) return [400, { ok: false, error: 'Schatten-Rekorder aus' }];
    try {
      return [200, schatten.wahrheit(String(daten.ein ?? ''), { urteil: daten.urteil, werkzeug: daten.werkzeug, quelle: daten.quelle ?? 'steuer' })];
    } catch (fehler) {
      return [400, { ok: false, error: String(fehler?.message ?? fehler).slice(0, 200) }];
    }
  }

  /** `POST /ruhe {an, bis?, grund?, stufe?, sofort?}`: der Ruhe-Schalter; `von` ist hier immer `steuer`. */
  async function ruheSchalten(daten) {
    if (typeof runner?.ruheSetzen !== 'function') return [400, { ok: false, error: 'Ruhe aus' }];
    try {
      return [200, { ok: true, ...(await runner.ruheSetzen(daten, 'steuer')) }];
    } catch (fehler) {
      if (fehler instanceof RuheFehler) return [fehler.status, { ok: false, error: fehler.message }];
      throw fehler;
    }
  }

  async function behandeln(req, res) {
    // Ein Browser schickt bei fremden Seiten `Origin`; Skripte und curl tun es nicht.
    if (req.headers.origin) return sende(res, 403, { ok: false, error: 'Origin nicht erlaubt' });
    const hostKopf = String(req.headers.host ?? '').replace(/:\d+$/, '');
    if (!erlaubteHosts.has(hostKopf)) return sende(res, 403, { ok: false, error: 'Host nicht erlaubt' });
    const pfad = new URL(req.url ?? '/', 'http://steuer.lokal').pathname;

    if (req.method === 'GET') {
      if (pfad === '/healthz' || pfad === '/health') return sende(res, 200, { ok: true, version: VERSION });
      if (pfad === '/zustand') return sende(res, 200, await zustandBild());
      if (pfad === '/welt') return sende(res, 200, await weltSicht());
      if (pfad === '/sitzungen') return sende(res, 200, await sitzungenSicht());
      if (pfad === '/schatten/bericht') {
        if (!schatten) return sende(res, 400, { ok: false, error: 'Schatten-Rekorder aus' });
        const tage = new URL(req.url ?? '/', 'http://steuer.lokal').searchParams.get('tage');
        return sende(res, 200, schatten.bericht({ tage }));
      }
      return sende(res, 404, { ok: false, error: 'unbekannter Pfad' });
    }
    if (req.method === 'POST') {
      const bekannt = ['/auftrag', '/abbrechen', '/dialog', '/takt', '/aufzeichnung', '/schatten/wahrheit', '/ruhe'];
      if (!bekannt.includes(pfad)) {
        req.resume();
        return sende(res, 404, { ok: false, error: 'unbekannter Pfad' });
      }
      const daten = await lies(req, res, { leerOk: pfad === '/abbrechen' });
      if (daten === null) return undefined;
      if (pfad === '/auftrag') {
        const [status, nutz] = await auftrag(daten);
        return sende(res, status, nutz);
      }
      if (pfad === '/abbrechen') return sende(res, 200, await abbrechen());
      if (pfad === '/dialog') return sende(res, 400, { ok: false, error: 'Dialogwache aus' });
      if (pfad === '/takt') {
        const [status, nutz] = await taktAusloesen(daten);
        return sende(res, status, nutz);
      }
      if (pfad === '/schatten/wahrheit') {
        const [status, nutz] = schattenWahrheit(daten);
        return sende(res, status, nutz);
      }
      if (pfad === '/ruhe') {
        const [status, nutz] = await ruheSchalten(daten);
        return sende(res, status, nutz);
      }
      const [status, nutz] = aufzeichnungSchalten(daten);
      return sende(res, status, nutz);
    }
    return sende(res, 404, { ok: false, error: 'unbekannter Pfad' });
  }

  const server = createServer((req, res) => {
    behandeln(req, res).catch((fehler) => {
      log(`[fyos-steuer] ${req.method} ${req.url}: ${fehler?.message ?? fehler}`);
      if (!res.headersSent) sende(res, 500, { ok: false, error: String(fehler?.message ?? fehler).slice(0, 200) });
      else res.end();
    });
  });

  /** Lauscht auf `cfg.steuer.host/port` (Port 0 wählt einen freien — für Tests); gibt die Adresse zurück. */
  server.starten = () =>
    new Promise((fertig, scheitern) => {
      server.once('error', scheitern);
      server.listen(port, host, () => {
        server.off('error', scheitern);
        const a = server.address();
        if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
          log(`[fyos-steuer] ACHTUNG: gebunden an ${host} — der Kanal hat keinen Token`);
        }
        log(`[fyos-steuer] Steuerkanal auf http://${host}:${a.port}`);
        fertig({ host, port: a.port });
      });
    });
  server.beenden = () => new Promise((fertig) => (server.listening ? server.close(() => fertig()) : fertig()));
  return server;
}
