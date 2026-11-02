/**
 * verwaltung.js — was die Verwaltung (Hub-App `runner`, Raum Lage) vom Runner sehen und tun darf.
 *
 * Besitzer, 25.10.2026: Der Runner läuft als systemd-Dienst auf Hauptserver (Port 18438) und bleibt dort; er soll aber im Cluster
 * sichtbar und steuerbar sein. Dieses Modul sammelt dafür alles an einer Stelle, ohne einen zweiten Zustand zu halten:
 *
 *   sicht()                  alles, was die Ansicht braucht (`GET /api/verwaltung`): Dienst, Version, seit wann, Eingang,
 *                            Spielmodus, Tore, offene Freigaben, Läufe, Antwortzeit (p50/p95), letzte Fehler, Knoten.
 *                            Was sich nicht lesen lässt, steht in `luecken`; der Abschnitt ist dann `null`, nie geraten.
 *   eingang(an, von)         Eingang pausieren oder fortsetzen, ohne den Dienst zu stoppen (Zustand im Dokument).
 *   neustart({frist_s})      sauber beenden: erst nichts Neues mehr annehmen, dann den laufenden Zug zu Ende, höchstens
 *                            `frist_s` Sekunden (Vorgabe 60, höchstens 900); danach beendet sich der Prozess mit Code 75,
 *                            systemd startet ihn neu (`SuccessExitStatus=75`, `RestartForceExitStatus=75` in der Unit).
 *                            `{abbrechen: true}` nimmt einen geplanten Neustart zurück.
 *
 * Hilfsklassen: `Fehlerspeicher` (die letzten Fehler des Prozesses, geschwärzt) und `Zugmessung` (Dauer jedes Zugs, p50/p95).
 * Der Server (`server.js`) ruft das nur nach Token-Prüfung auf; die Befehle verlangen das Token ausdrücklich im Kopf
 * `Authorization: Bearer …` (ein Cookie genügt nicht).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KONTEXT, LIVE as LiveDoc } from './lauf/index.js';
import { PAKET } from './config.js';
import { Laufzeit, Wartend } from './documents.js';

const CTX = KONTEXT;

export const NEUSTART_CODE = 75; // EX_TEMPFAIL: „bitte gleich noch einmal“; die Unit startet bei 75 immer neu
export const FRIST_VORGABE_S = 60;
export const FRIST_MAX_S = 900;
const LESEN_FRIST_MS = 4000;
/** Quellen, die zum Sprachweg gehören (HA-Assist, Stimme): ihre Zugdauer steht zusätzlich unter `stimme`. */
const STIMME_QUELLE = /stimme|assist|sprach|voice|anruf/i;

export class VerwaltungsFehler extends Error {
  constructor(status, nachricht) {
    super(nachricht);
    this.status = status;
  }
}

/** Zugangsdaten aus einem Text nehmen, bevor er in die Ansicht kommt. */
export function schwaerzen(text, n = 300) {
  const t = String(text ?? '')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(/([?&](?:token|key|apikey|api_key)=)[^&\s]+/gi, '$1***')
    .replace(/\b[a-f0-9]{32,}\b/gi, '***')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Perzentil nach dem Rang (nächster Rang); `null`, wenn es keine Werte gibt. */
export function perzentil(werte, p) {
  const v = [...werte].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const rang = Math.min(v.length, Math.max(1, Math.ceil((p / 100) * v.length)));
  return v[rang - 1];
}

const rund = (x) => (x === null ? null : Math.round(x * 10) / 10);

/** Die letzten Fehler des Prozesses (Ringspeicher). Quelle sind `onFehler`-Haken und, über `anzapfen`, `console.error`. */
export class Fehlerspeicher {
  constructor(max = 40, jetzt = () => Date.now()) {
    this.max = max;
    this.jetzt = jetzt;
    this.eintraege = [];
    this.gesamt = 0;
  }

  melde(quelle, fehler) {
    const text = schwaerzen(fehler?.message ?? fehler);
    if (!text) return;
    this.gesamt += 1;
    this.eintraege.push({ zeit: this.jetzt(), quelle: String(quelle).slice(0, 40), text });
    if (this.eintraege.length > this.max) this.eintraege.shift();
  }

  /** Die jüngsten `n`, neueste zuerst. */
  liste(n = 10) {
    return this.eintraege.slice(-n).reverse();
  }

  /** `console.error` weiterreichen und mitschreiben; gibt die Rückgabefunktion zurück (Tests). */
  anzapfen(konsole = console) {
    const alt = konsole.error;
    konsole.error = (...a) => {
      try {
        const roh = a.map((x) => (x instanceof Error ? x.message : typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
        const treffer = /^\[([a-z0-9-]+)\]\s*/i.exec(roh);
        this.melde(treffer ? treffer[1] : 'log', treffer ? roh.slice(treffer[0].length) : roh);
      } catch {
        /* Mitschreiben darf nie die Ausgabe stören */
      }
      return alt.apply(konsole, a);
    };
    return () => {
      konsole.error = alt;
    };
  }
}

/** Dauer jedes Zugs (Eingang bis Ende) für p50/p95; vom Ausgang gespeist (`egress.zugmessung`). */
export class Zugmessung {
  constructor(max = 200, jetzt = () => Date.now()) {
    this.max = max;
    this.jetzt = jetzt;
    this.offen = new Map();
    this.fertig = [];
  }

  beginn(id, quelle = null, klasse = null) {
    if (this.offen.has(String(id))) return; // ein zweiter Eingang im selben Zug verlängert ihn nur
    this.offen.set(String(id), { t0: this.jetzt(), quelle: quelle ?? 'unbekannt', klasse });
  }

  ende(id) {
    const o = this.offen.get(String(id));
    if (!o) return;
    this.offen.delete(String(id));
    this.fertig.push({ s: (this.jetzt() - o.t0) / 1000, quelle: o.quelle, klasse: o.klasse, ende: this.jetzt() });
    if (this.fertig.length > this.max) this.fertig.shift();
  }

  static block(liste) {
    const s = liste.map((x) => x.s);
    return { n: s.length, p50_s: rund(perzentil(s, 50)), p95_s: rund(perzentil(s, 95)), max_s: rund(s.length ? Math.max(...s) : null) };
  }

  statistik() {
    const je = {};
    for (const q of new Set(this.fertig.map((x) => x.quelle))) je[q] = Zugmessung.block(this.fertig.filter((x) => x.quelle === q));
    const stimme = this.fertig.filter((x) => STIMME_QUELLE.test(x.quelle));
    return {
      ...Zugmessung.block(this.fertig),
      je_quelle: je,
      stimme: stimme.length ? Zugmessung.block(stimme) : null,
      offen: this.offen.size,
      fenster: this.max,
    };
  }
}

/** Version und Stand des Auslieferns: `package.json` und, wenn das Einrichtungsskript sie schrieb, `build.json`. */
export function buildInfo({ paket = PAKET, env = process.env } = {}) {
  let version = null;
  let build = {};
  try {
    version = JSON.parse(readFileSync(join(paket, 'package.json'), 'utf8')).version ?? null;
  } catch {
    /* ohne package.json: Version unbekannt */
  }
  try {
    const datei = join(paket, 'build.json');
    if (existsSync(datei)) build = JSON.parse(readFileSync(datei, 'utf8')) ?? {};
  } catch {
    build = {};
  }
  return {
    version,
    commit: String(env.FYOS_RUNNER_COMMIT || build.commit || '').slice(0, 40) || null,
    gebaut: build.gebaut ?? null,
  };
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function bindungArt(host) {
  return LOOPBACK.has(String(host)) ? 'loopback' : 'netz';
}

const mitFrist = (versprechen, ms = LESEN_FRIST_MS) =>
  Promise.race([
    Promise.resolve(versprechen),
    new Promise((_, nein) => {
      const t = setTimeout(() => nein(new Error(`keine Antwort nach ${ms / 1000} s`)), ms);
      t.unref?.();
    }),
  ]);

export function erstelleVerwaltung({
  cfg,
  runner,
  ingress = null,
  spielmodus = null,
  tor = null,
  lesenTor = null,
  egress = null,
  budget = null,
  fehler = null,
  zugmessung = null,
  aufzeichnung = null,
  beenden = null,
  gestartet = Date.now(),
  jetzt = () => Date.now(),
  abfrageMs = 1000,
  build = buildInfo(),
  log = (z) => console.log(z),
} = {}) {
  const pd = cfg?.pi_durable ?? {};
  let plan = null; // geplanter Neustart: {seit, frist_s, frist_bis, von, timer}

  const wurzelId = () => runner?.root?.id ?? null;

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

  function eingangSicht() {
    const konfiguriert = ingress ? ingress.konfiguriert : Boolean(pd.proactive?.enabled);
    const pausiert = Boolean(ingress?.pausiert);
    return {
      konfiguriert,
      pausiert,
      pausiert_seit: pausiert ? (ingress?.pausiertSeit ?? null) : null,
      pausiert_von: pausiert ? (ingress?.pausiertVon ?? null) : null,
      halt_neustart: Boolean(ingress?.haltNeustart),
      an: konfiguriert && !pausiert && !ingress?.haltNeustart,
      nach: ingress?.cursor ?? null,
    };
  }

  function neustartSicht() {
    if (!plan) return null;
    return {
      seit: plan.seit,
      frist_s: plan.frist_s,
      frist_bis: plan.frist_bis,
      von: plan.von,
      rest_s: Math.max(0, Math.round((plan.frist_bis - jetzt()) / 1000)),
    };
  }

  /** Alles für die Ansicht. Jeder Abschnitt für sich: fällt einer aus, steht er in `luecken`, die anderen bleiben. */
  async function sicht() {
    const luecken = [];
    const abschnitt = async (name, fn) => {
      try {
        return await fn();
      } catch (e) {
        luecken.push({ quelle: name, grund: schwaerzen(e?.message ?? e, 160) });
        return null;
      }
    };

    const dienst = await abschnitt('dienst', async () => ({
      name: 'fyos-pi-durable',
      agent: cfg?.agent ?? null,
      geraet: pd.device ?? null,
      pid: process.pid,
      node: process.version,
      version: build.version ?? null,
      commit: build.commit ?? null,
      gebaut: build.gebaut ?? null,
      gestartet,
      laeuft_s: Math.max(0, Math.round((jetzt() - gestartet) / 1000)),
      host: pd.host ?? null,
      port: pd.port ?? null,
      bindung: bindungArt(pd.host),
      token: Boolean(pd.security?.token),
      speicher: pd.storage ?? null,
      neustart: neustartSicht(),
    }));

    const eingang = await abschnitt('eingang', async () => ({
      ...eingangSicht(),
      gesehen: (await runner.harness.snapshot(Laufzeit, CTX))?.eingangGesehen ?? null,
      fehler: schwaerzen((await runner.harness.snapshot(Laufzeit, CTX))?.eingangFehler ?? '', 200) || null,
    }));

    const spiel = await abschnitt('spielmodus', async () => {
      const grund = spielmodus?.grund?.() ?? null;
      return { an: grund !== null, grund };
    });

    const tore = await abschnitt('tore', async () => ({
      hintergrund: tor ? tor.zustand() : null,
      lesen: lesenTor ? lesenTor.zustand() : null,
    }));

    const arbeit = await abschnitt('zug', async () => ({
      beschaeftigt: await beschaeftigt(),
      laufend: egress && wurzelId() ? (egress.laufend(wurzelId()) ?? null) : null,
    }));

    const freigaben = await abschnitt('freigaben', async () => {
      const alle = await mitFrist(runner.freigaben());
      const offen = alle.filter((f) => f.status === 'offen');
      return {
        offen: offen.length,
        gesamt: alle.length,
        liste: offen.slice(0, 20).map((f) => ({
          id: f.id,
          aktion: schwaerzen(f.aktion, 200),
          risiko: f.risiko ?? null,
          zerstoererisch: Boolean(f.zerstoererisch),
          werkzeug: f.werkzeug ?? null,
          befehl: f.befehl ? schwaerzen(f.befehl, 300) : null,
          kontext: schwaerzen(f.kontext, 240),
          erstellt: f.erstellt ?? null,
          gespraech: f.gespraechTitel ?? null,
          lauf: f.taskId ?? null,
        })),
      };
    });

    const laeufe = await abschnitt('laeufe', async () => {
      const alle = await mitFrist(runner.laeufe());
      const status = {};
      for (const l of alle) status[String(l.taskStatus ?? l.status)] = (status[String(l.taskStatus ?? l.status)] ?? 0) + 1;
      const aktiv = alle.filter((l) => l.taskStatus !== 'terminal');
      return {
        gesamt: alle.length,
        status,
        aktiv: aktiv.slice(0, 8).map((l) => ({
          id: l.id,
          titel: schwaerzen(l.titel ?? '', 120),
          status: l.status ?? null,
          task: l.taskStatus ?? null,
          erstellt: l.erstellt ?? null,
        })),
      };
    });

    const warteschlange = await abschnitt('warteschlange', async () => {
      const liste = (await runner.harness.snapshot(Wartend, CTX))?.eintraege ?? [];
      const max = liste.filter((x) => x.klasse === 'max').length;
      return { max, hintergrund: liste.length - max };
    });

    const antwortzeit = await abschnitt('antwortzeit', async () => {
      if (!zugmessung) throw new Error('Zugmessung nicht eingebaut');
      return zugmessung.statistik();
    });

    const letzte = await abschnitt('fehler', async () => {
      const aus = fehler ? fehler.liste(10) : [];
      const egressFehler = egress?.letzterFehler ? [{ zeit: null, quelle: 'egress', text: schwaerzen(egress.letzterFehler.message ?? egress.letzterFehler) }] : [];
      return { gesamt: fehler?.gesamt ?? 0, liste: aus, egress: egressFehler[0] ?? null };
    });

    const knoten = await abschnitt('knoten', async () =>
      runner.knotenListe().map(({ id, titel, weg, local }) => ({ id, titel, weg: weg ?? null, local: Boolean(local) })),
    );

    const hub = await abschnitt('hub', async () => {
      const h = await mitFrist(runner.hub.gesundheit());
      return { url: cfg?.hub ?? null, ok: h?.ok !== false, antwort: h && typeof h === 'object' ? { ok: h.ok ?? null } : null };
    });

    const strecke = egress ? egress.meldestrecke() : null;
    const kosten = budget ? await abschnitt('budget', async () => budget.zustand()) : null;

    return {
      ok: true,
      version: 1,
      stand: jetzt(),
      dienst,
      eingang,
      spielmodus: spiel,
      tore,
      zug: arbeit,
      warteschlange,
      freigaben,
      laeufe,
      antwortzeit,
      meldestrecke: strecke,
      budget: kosten,
      fehler: letzte,
      knoten,
      hub,
      aufzeichnung: aufzeichnung ? { an: Boolean(typeof aufzeichnung.an === 'function' ? aufzeichnung.an() : aufzeichnung.an) } : null,
      luecken,
    };
  }

  async function eingang(an, von = 'verwaltung') {
    if (typeof an !== 'boolean') throw new VerwaltungsFehler(400, 'an: true oder false');
    if (!ingress) throw new VerwaltungsFehler(503, 'Eingang nicht eingebaut');
    const r = await ingress.pausieren(!an, schwaerzen(von, 64) || 'verwaltung');
    aufzeichnung?.schreibe?.('verwaltung', { eingang: { an, von } });
    const s = eingangSicht();
    let hinweis = null;
    if (an && !s.konfiguriert) hinweis = 'Der Eingang ist per Konfiguration aus (FYOS_RUNNER_PROAKTIV=0, Schatten): Fortsetzen hebt nur die Pause auf, gelesen wird weiter nicht.';
    else if (an && s.halt_neustart) hinweis = 'Ein Neustart ist geplant: der Eingang bleibt bis dahin angehalten.';
    return { ok: true, geaendert: r.geaendert, eingang: s, hinweis };
  }

  function planAufheben() {
    if (plan?.timer) clearInterval(plan.timer);
    plan = null;
    ingress?.anhalten(false);
  }

  async function neustart({ frist_s: fristRoh, abbrechen = false } = {}, von = 'verwaltung') {
    if (abbrechen === true) {
      if (!plan) return { ok: true, geplant: false, hinweis: 'Es war kein Neustart geplant.' };
      planAufheben();
      log(`[fyos-verwaltung] Neustart abgebrochen (${von})`);
      return { ok: true, geplant: false, abgebrochen: true };
    }
    if (typeof beenden !== 'function') throw new VerwaltungsFehler(503, 'Neustart nicht eingebaut');
    let frist = FRIST_VORGABE_S;
    if (fristRoh !== undefined && fristRoh !== null) {
      frist = Number(fristRoh);
      if (!Number.isFinite(frist) || frist < 0 || frist > FRIST_MAX_S) {
        throw new VerwaltungsFehler(400, `frist_s: 0 bis ${FRIST_MAX_S} Sekunden`);
      }
    }
    if (plan) return { ok: true, geplant: true, schon_geplant: true, neustart: neustartSicht() };
    const jetztMs = jetzt();
    plan = { seit: jetztMs, frist_s: frist, frist_bis: jetztMs + frist * 1000, von: schwaerzen(von, 64) || 'verwaltung', timer: null };
    ingress?.anhalten(true); // nichts Neues mehr an den Agenten, bis der Prozess neu startet
    aufzeichnung?.schreibe?.('verwaltung', { neustart: { frist_s: frist, von } });
    log(`[fyos-verwaltung] Neustart geplant (${plan.von}): nach dem laufenden Zug, spätestens in ${frist} s`);

    let laeuft = false;
    const pruefen = async () => {
      if (!plan || laeuft) return;
      const dran = plan;
      const busy = await beschaeftigt();
      if (plan !== dran) return; // inzwischen abgebrochen
      if (busy && jetzt() < dran.frist_bis) return;
      laeuft = true;
      clearInterval(dran.timer);
      log(`[fyos-verwaltung] Neustart: ${busy ? 'Frist abgelaufen, der Zug wird unterbrochen (er setzt am Checkpoint fort)' : 'kein Zug offen'}`);
      try {
        await beenden('Neustart (Verwaltung)', NEUSTART_CODE);
      } catch (e) {
        log(`[fyos-verwaltung] Neustart gescheitert: ${e?.message ?? e}`);
        laeuft = false;
        planAufheben();
      }
    };
    plan.timer = setInterval(() => void pruefen(), Math.max(10, abfrageMs));
    plan.timer.unref?.();
    return { ok: true, geplant: true, neustart: neustartSicht(), wartet_auf_zug: await beschaeftigt() };
  }

  return {
    sicht,
    eingang,
    neustart,
    neustartSicht,
    /** Für Tests und das Beenden: einen geplanten Neustart fallen lassen. */
    stop: () => planAufheben(),
  };
}
