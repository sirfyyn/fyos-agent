/**
 * freigabe-meldung.js — offene Freigaben erreichen Besitzer, auch wenn die App zu ist (Entscheidung 580, 25.10.2026).
 *
 * Die App meldet Freigaben nur bei offenem Strom. Dieses Modul sieht von der Seite des Runners nach: Es liest das
 * `Freigaben`-Dokument, meldet jede neue offene Freigabe genau einmal über die eingestellten Kanäle und erinnert danach
 * mit wachsendem Abstand, bis sie entschieden ist. Kanäle (`pi_durable.freigabe_meldung.kanaele`): `matrix` (Ginnys
 * Sender, Raum ops), `ntfy` (selbst gehostet, Apples Push über das Upstream-Relay der ntfy-App), `aus` (Vorgabe).
 *
 * Gemeldet wird nur; entschieden wird hier nie. Der einzige Weg zur Entscheidung bleibt die App oder das Web mit
 * Anmeldung (App über die Authentik-Tür von persona-life, Runner-Web mit Token; im Eingang `von: app-freigabe`). Eine Antwort auf die Meldung entscheidet nichts;
 * der Text sagt das und trägt höchstens einen Link. Die Texte haben keine Geheimnisse: Zugangsdaten und lange Zeichenketten
 * werden geschwärzt, der Befehl steht nur in Kanälen, die als Besitzer-Kanal gelten (`befehl: true`; Matrix ja, ntfy nein).
 *
 * Verlässlichkeit: Der Zustand liegt im Dokument `WachenZustand` (Schlüssel `freigabemeldung`), ein Neustart meldet nichts
 * doppelt. Gespeichert wird nach dem Senden: Stürzt der Runner genau dazwischen ab, kommt die Meldung ein zweites Mal
 * (lieber doppelt als gar nicht). Fällt ein Kanal aus, versucht es das Modul mit wachsendem Abstand neu, die anderen laufen
 * weiter. Der Zustand erscheint im Steuerkanal unter `freigabe_meldung`.
 *
 * Text: erst der Kurzkontext der Freigabe (3–5 Sätze, Entscheidung 586, `freigabe-kontext.js`; fehlt er, der Rückfall), dann Aktion,
 * Risiko, im Besitzer-Kanal der Befehl.
 *
 * Regeln: Risiko hoch meldet immer (auch in der Ruhezeit, Matrix mit `dringend`), jede einzeln. Alles andere wird
 * gebündelt (Wartefrist `buendel_s`) und in der Ruhezeit (Vorgabe 22–7) zurückgehalten.
 */
import { KONTEXT as CTX } from './lauf/index.js';
import { Freigaben } from './documents.js';
import { kontextAnzeigen, kontextKuerzen } from './freigabe-kontext.js';
import { freigabenEntscheiden, freigabenQuelle } from './freigabe-itsm.js';
import { FreigabeReaktionen, erlaubenErlaubt } from './freigabe-reaktionen.js';
import { schwaerzen } from './schwaerzen.js';
import { Kette, istObjekt, kurz, logger, wachenAendern, wachenLesen } from './wachen-zustand.js';

export const KANAELE = ['matrix', 'ntfy'];
const MIN = 60_000;

const VORGABEN = {
  kanaele: [],
  pruefen_s: 30,
  buendel_s: 120,
  erinnerung: { nach_s: 900, faktor: 2, max_s: 14_400, max_anzahl: 8 },
  ruhezeit: { von: 22, bis: 7, zone: 'Europe/Berlin' },
  link: '',
  link_einzeln: '',
  matrix: {
    url: 'http://127.0.0.1:18436',
    raum: 'ops',
    befehl: true,
    // Reaktions-Chips (26.10.2026, freigabe-reaktionen.js): Standard AUS.
    reaktionen: { an: false, absender: '@max:matrix.fyos.local', lauscher_url: 'http://127.0.0.1:18437', pruefen_s: 5, spaeter_s: 3600 },
  },
  ntfy: { url: '', thema: '', token_env: 'FYOS_NTFY_TOKEN', befehl: false },
};

const zahl = (v, vorgabe, min = 0) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : vorgabe;
};
const text = (v, vorgabe = '') => (typeof v === 'string' && v.trim() ? v.trim() : vorgabe);

/** Konfiguration (`pi_durable.freigabe_meldung`) in die eine Form bringen. Umgebung: FYOS_FREIGABE_MELDUNG, FYOS_NTFY_URL, FYOS_NTFY_THEMA. */
export function konfigNormalisieren(roh, env = {}) {
  const r = istObjekt(roh) ? roh : {};
  let liste = env.FYOS_FREIGABE_MELDUNG !== undefined && env.FYOS_FREIGABE_MELDUNG !== '' ? env.FYOS_FREIGABE_MELDUNG : (r.kanaele ?? []);
  if (typeof liste === 'string') liste = liste.split(/[,\s]+/);
  if (!Array.isArray(liste)) liste = [];
  const namen = liste.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const kanaele = namen.includes('aus') ? [] : [...new Set(namen.filter((n) => KANAELE.includes(n)))];
  const e = istObjekt(r.erinnerung) ? r.erinnerung : {};
  const z = istObjekt(r.ruhezeit) ? r.ruhezeit : {};
  const m = istObjekt(r.matrix) ? r.matrix : {};
  const n = istObjekt(r.ntfy) ? r.ntfy : {};
  const re = istObjekt(m.reaktionen) ? m.reaktionen : {};
  const rv = VORGABEN.matrix.reaktionen;
  return {
    kanaele,
    pruefenS: Math.max(1, zahl(r.pruefen_s, VORGABEN.pruefen_s, 1)),
    buendelS: zahl(r.buendel_s, VORGABEN.buendel_s),
    erinnerung: {
      nachS: Math.max(1, zahl(e.nach_s, VORGABEN.erinnerung.nach_s, 1)),
      faktor: Math.max(1, zahl(e.faktor, VORGABEN.erinnerung.faktor, 1)),
      maxS: Math.max(1, zahl(e.max_s, VORGABEN.erinnerung.max_s, 1)),
      maxAnzahl: Math.trunc(zahl(e.max_anzahl, VORGABEN.erinnerung.max_anzahl)),
    },
    ruhezeit: {
      von: Math.min(23, Math.max(0, Math.trunc(zahl(z.von, VORGABEN.ruhezeit.von)))),
      bis: Math.min(23, Math.max(0, Math.trunc(zahl(z.bis, VORGABEN.ruhezeit.bis)))),
      zone: text(z.zone, VORGABEN.ruhezeit.zone),
    },
    // ITSM-Freigaben (Vorgang waiting_approval) laufen durch dieselbe Wache und dieselben Chips (freigabe-itsm.js). Nur mit Hub.
    itsm: { an: !(istObjekt(r.itsm) && r.itsm.an === false) },
    link: text(r.link),
    linkEinzeln: text(r.link_einzeln),
    matrix: {
      url: text(m.url, VORGABEN.matrix.url).replace(/\/+$/, ''),
      raum: text(m.raum, VORGABEN.matrix.raum),
      befehl: m.befehl === undefined ? VORGABEN.matrix.befehl : m.befehl === true,
      reaktionen: {
        an: re.an === true,
        absender: text(re.absender, rv.absender),
        lauscherUrl: text(re.lauscher_url, rv.lauscher_url).replace(/\/+$/, ''),
        pruefenS: Math.max(1, zahl(re.pruefen_s, rv.pruefen_s, 1)),
        spaeterS: Math.max(60, zahl(re.spaeter_s, rv.spaeter_s, 60)),
      },
    },
    ntfy: {
      url: text(env.FYOS_NTFY_URL, text(n.url)).replace(/\/+$/, ''),
      thema: text(env.FYOS_NTFY_THEMA, text(n.thema)),
      tokenEnv: text(n.token_env, VORGABEN.ntfy.token_env),
      befehl: n.befehl === true,
    },
  };
}

// --- Schwärzen und Kürzen ---------------------------------------------------------------------------------------

export { schwaerzen };

// --- Ruhezeit, Abstände, Texte --------------------------------------------------------------------------------------

/** Liegt `ms` in der Ruhezeit (Ortszeit der Zone)? `von == bis` heißt: keine Ruhezeit. */
export function istRuhezeit(ms, { von = 22, bis = 7, zone = 'Europe/Berlin' } = {}) {
  if (von === bis) return false;
  const stunde = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: zone }).format(new Date(ms)));
  return von > bis ? stunde >= von || stunde < bis : stunde >= von && stunde < bis;
}

/** Abstand vor der (k+1). Erinnerung in ms: nachS · faktor^k, höchstens maxS. */
export function erinnerungsAbstand(k, { nachS, faktor, maxS }) {
  return Math.min(nachS * faktor ** k, maxS) * 1000;
}

function dauer(ms) {
  const m = Math.round(ms / MIN);
  if (m < 1) return 'gerade eben';
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} Tage`;
}

const RISIKO = { high: 'hoch', medium: 'mittel', low: 'niedrig' };
const risikoWort = (f) => RISIKO[f.risiko] ?? 'mittel';
const linkFuer = (kfg, f) =>
  f && kfg.linkEinzeln ? kfg.linkEinzeln.replaceAll('{id}', encodeURIComponent(String(f.id))) : kfg.link;

const HINWEIS = 'Entscheiden nur in der FYOS-App (Persona-Tab) oder im Runner-Web, jeweils mit Anmeldung. Eine Antwort auf diese Nachricht entscheidet nichts.';

/**
 * Baut die Nachricht für einen Kanal. `art`: 'neu' | 'erinnerung'; `liste`: Freigaben (eine = Einzelmeldung, mehrere = Bündel).
 * Gibt {titel, text, dringend, link, bezug, art} zurück; kein Geheimnis im Text, der Befehl nur bei `kanal.befehl`.
 */
export function nachrichtBauen({ art, liste, kanal, kfg, jetzt, nummer = 1 }) {
  const link = liste.length === 1 ? linkFuer(kfg, liste[0]) : kfg.link;
  const hoch = liste.some((f) => f.risiko === 'high');
  const alter = (f) => dauer(jetzt - (Number(f.erstellt) || jetzt));
  const zeilen = [];
  let titel;
  if (liste.length === 1) {
    const f = liste[0];
    titel = art === 'neu' ? 'Freigabe nötig' : `Erinnerung ${nummer}: Freigabe weiter offen`;
    if (f.risiko === 'high') titel += ' (hohes Risiko)';
    zeilen.push(titel);
    // Entscheidung 586: der Kurzkontext (3–5 Sätze) steht zuerst, damit man in Sekunden entscheiden kann; dann Aktion und Risiko.
    const kontext = kontextKuerzen(kontextAnzeigen(f), kanal.kontextMax ?? 600);
    if (kontext) zeilen.push(kontext);
    zeilen.push(`Aktion: ${schwaerzen(f.aktion, 160)}`);
    zeilen.push(`Risiko: ${risikoWort(f)}${f.zerstoererisch ? ' · zerstörend' : ''}`);
    if (kanal.befehl && f.befehl) zeilen.push(`Befehl: ${schwaerzen(f.befehl, 300)}`);
    zeilen.push(`Offen seit ${alter(f)}`);
  } else {
    titel = art === 'neu' ? `${liste.length} Freigaben warten auf dich` : `Erinnerung ${nummer}: ${liste.length} Freigaben weiter offen`;
    zeilen.push(titel);
    for (const f of liste.slice(0, 8)) zeilen.push(`- ${risikoWort(f)} · ${schwaerzen(f.aktion, 100)} (seit ${alter(f)})`);
    if (liste.length > 8) zeilen.push(`… und ${liste.length - 8} weitere`);
  }
  if (liste.length === 1 && kanal.chips === true) {
    zeilen.push(
      erlaubenErlaubt(liste[0])
        ? 'Entscheide mit einer Reaktion: ✅ erlauben, ❌ ablehnen, ⏳ später. Eine Textantwort entscheidet nichts.'
        : 'Erlauben nur in der App (Halten); hier gehen ❌ ablehnen und ⏳ später. Eine Textantwort entscheidet nichts.',
    );
  } else zeilen.push(HINWEIS);
  if (link) zeilen.push(`Öffnen: ${link}`);
  const bezug = liste.length === 1 ? `Freigabe ${kurz(String(liste[0].id).replace(/[^A-Za-z0-9._:-]/g, ''), 40)}` : `${liste.length} Freigaben`;
  return { titel, text: zeilen.join('\n'), dringend: hoch, link: link || '', bezug, art };
}

// --- Kanäle -----------------------------------------------------------------------------------------------------------

const ZEITLIMIT_MS = 15_000;

/** Ginnys Matrix-Sender (`fyos-matrix-sender`): Konto und Räume hält der Dienst, hier steht weder Token noch Raum-Id. */
export function matrixKanal({ url = VORGABEN.matrix.url, raum = VORGABEN.matrix.raum, befehl = true, reaktionen = {}, fetch: holen = (...a) => fetch(...a) } = {}) {
  const lauscher = (reaktionen.lauscherUrl ?? VORGABEN.matrix.reaktionen.lauscher_url).replace(/\/+$/, '');
  /** POST an den Sender (Reaktion, Bearbeitung, Rückzug): {ok, eventId?, schatten?, grund?}; wirft nie. */
  const post = async (pfad, body) => {
    try {
      const r = await holen(`${url}${pfad}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, raum }),
        signal: AbortSignal.timeout(ZEITLIMIT_MS),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 200 && j.ok) return { ok: true, schatten: j.schatten === true, eventId: j.event_id ?? null };
      return { ok: false, grund: `Matrix ${r.status}: ${kurz(String(j.grund ?? 'abgewiesen'), 80)}` };
    } catch (f) {
      return { ok: false, grund: `Matrix-Sender nicht erreichbar: ${kurz(String(f?.message ?? f), 80)}` };
    }
  };
  return {
    name: 'matrix',
    befehl,
    kontextMax: 600,
    /** Chips an der Meldung (Text sagt „Reaktion“) nur, wenn die Reaktionen an sind. */
    chips: reaktionen.an === true,
    reagieren: (eventId, emoji) => post('/reagieren', { event_id: eventId, emoji }),
    bearbeiten: (eventId, text) => post('/bearbeiten', { event_id: eventId, text }),
    zurueckziehen: (eventId) => post('/zurueckziehen', { event_id: eventId }),
    /** Kurze Zeile von Besitzer' eigener Reaktion ausgelöst (Bestätigung, Hinweis): `dringend`, damit die Ruhezeit des Senders sie nicht verschluckt. */
    antworten: async (text, bezug) => {
      const r = await post('/senden', { text, art: 'info', bezug: kurz(String(bezug ?? ''), 60), dringend: true });
      return r;
    },
    /** Besitzer' gepufferte Reaktionen beim Lauscher abholen. */
    async reaktionenLesen(seit = 0) {
      try {
        const r = await holen(`${lauscher}/reaktionen?seit=${Math.max(0, Math.trunc(Number(seit) || 0))}`, { signal: AbortSignal.timeout(ZEITLIMIT_MS) });
        const j = await r.json().catch(() => ({}));
        if (r.status === 200 && j.ok) return { ok: true, naechste: Number(j.naechste) || 0, ereignisse: Array.isArray(j.ereignisse) ? j.ereignisse : [] };
        return { ok: false, grund: `Lauscher ${r.status}` };
      } catch (f) {
        return { ok: false, grund: `Lauscher nicht erreichbar: ${kurz(String(f?.message ?? f), 80)}` };
      }
    },
    async senden(n) {
      try {
        const r = await holen(`${url}/senden`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // `frage`: Besitzer soll etwas tun. `dringend` nur bei hohem Risiko; der Dienst weist sonst in der Ruhezeit ab.
          body: JSON.stringify({ text: n.text, art: 'frage', bezug: kurz(n.bezug, 60), dringend: n.dringend === true, raum }),
          signal: AbortSignal.timeout(ZEITLIMIT_MS),
        });
        const j = await r.json().catch(() => ({}));
        if (r.status === 200 && j.ok) return { ok: true, schatten: j.schatten === true, eventId: j.event_id ?? null };
        return { ok: false, grund: `Matrix ${r.status}: ${kurz(String(j.grund ?? 'abgewiesen'), 80)}` };
      } catch (f) {
        return { ok: false, grund: `Matrix-Sender nicht erreichbar: ${kurz(String(f?.message ?? f), 80)}` };
      }
    },
  };
}

/**
 * Selbst gehostetes ntfy (JSON-Veröffentlichung). Kein Aktionsknopf, der entscheidet: nur `click` auf den Link. Das Token kommt
 * aus der Umgebungsvariablen `tokenEnv` und wird bei jedem Senden frisch gelesen, nie gespeichert oder ausgegeben.
 */
export function ntfyKanal({ url, thema, tokenEnv = 'FYOS_NTFY_TOKEN', befehl = false, env = process.env, fetch: holen = (...a) => fetch(...a) } = {}) {
  return {
    name: 'ntfy',
    befehl,
    kontextMax: 400,
    async senden(n) {
      const kopf = { 'content-type': 'application/json' };
      const token = env[tokenEnv];
      if (token) kopf.authorization = `Bearer ${String(token).trim()}`;
      const nutz = {
        topic: thema,
        title: n.titel,
        // Die erste Zeile ist der Titel; die Nachricht trägt den Rest.
        message: n.text.split('\n').slice(1).join('\n'),
        priority: n.dringend ? 4 : 3,
        tags: n.dringend ? ['rotating_light'] : ['raised_hand'],
      };
      if (n.link) nutz.click = n.link;
      try {
        const r = await holen(url, { method: 'POST', headers: kopf, body: JSON.stringify(nutz), signal: AbortSignal.timeout(ZEITLIMIT_MS) });
        if (r.status >= 200 && r.status < 300) return { ok: true };
        return { ok: false, grund: `ntfy ${r.status}` };
      } catch (f) {
        return { ok: false, grund: `ntfy nicht erreichbar: ${kurz(String(f?.message ?? f), 80)}` };
      }
    },
  };
}

// --- Die Wache --------------------------------------------------------------------------------------------------------

export class FreigabeMeldung {
  /**
   * @param kanaele  Liste von Kanälen {name, befehl, kontextMax, senden(nachricht) → {ok, grund?}}
   * @param freigaben  async () => Array der Freigaben (alle Stati); Vorgabe: das Dokument `Freigaben`
   * @param speicher  {lesen(): {freigabemeldung}, aendern(fn)}; Vorgabe: `WachenZustand` im Harness
   */
  constructor({ cfg = {}, harness, kanaele = [], freigaben, speicher, log, jetzt = () => Date.now(), konfig, reaktionen = null } = {}) {
    this.reaktionen = reaktionen; // FreigabeReaktionen oder null (Chips aus)
    this.kfg = konfig ?? konfigNormalisieren(cfg.pi_durable?.freigabe_meldung);
    this.kanaele = kanaele;
    this.harness = harness;
    this.log = logger(log, 'fyos-freigabe-meldung');
    this.jetzt = jetzt;
    this.freigaben =
      freigaben ??
      (async () => Object.values((await harness.snapshot(Freigaben, CTX))?.eintraege ?? {}));
    this.speicher =
      speicher ??
      {
        lesen: () => wachenLesen(harness),
        aendern: (fn) => wachenAendern(harness, fn),
      };
    this._kette = new Kette();
    this._timer = null;
    this._aktiv = false;
    this._pause = {}; // Kanal -> {n, bis, grund}
    this.fehler = {}; // Kanal -> letzter Grund
    this.gemeldet = { neu: 0, erinnerung: 0 };
    this.offen = 0;
    this.letzter = null;
    this.letzterLauf = null;
    this.letzterLaufFehler = null;
  }

  /** Aus der Konfiguration: baut die Kanäle (ohne Einstellung keine Wache). */
  static ausKonfig({ cfg, harness, env = process.env, fetch: holen, log, jetzt, freigaben, speicher, entscheiden, hub } = {}) {
    const kfg = konfigNormalisieren(cfg?.pi_durable?.freigabe_meldung, env);
    if (hub && kfg.itsm.an && kfg.kanaele.length) {
      const runnerFreigaben = freigaben ?? (async () => Object.values((await harness.snapshot(Freigaben, CTX))?.eintraege ?? {}));
      freigaben = freigabenQuelle({ runnerFreigaben, hub, log: (t) => logger(log, 'fyos-freigabe-meldung').warn(t) });
      if (typeof entscheiden === 'function') entscheiden = freigabenEntscheiden({ runnerEntscheiden: entscheiden, hub });
    }
    const kanaele = [];
    const fehler = {};
    const optionen = holen ? { fetch: holen } : {};
    for (const name of kfg.kanaele) {
      if (name === 'matrix') kanaele.push(matrixKanal({ ...kfg.matrix, ...optionen }));
      if (name === 'ntfy') {
        if (!kfg.ntfy.url || !kfg.ntfy.thema) fehler.ntfy = 'nicht eingerichtet (url und thema fehlen)';
        else kanaele.push(ntfyKanal({ ...kfg.ntfy, env, ...optionen }));
      }
    }
    const w = new FreigabeMeldung({ cfg, harness, kanaele, konfig: kfg, log, jetzt, freigaben, speicher });
    Object.assign(w.fehler, fehler);
    // Reaktions-Chips: nur mit Matrix-Kanal, eingeschalteten Reaktionen und einem Weg zur Entscheidung (Runner).
    const matrix = kanaele.find((k) => k.name === 'matrix');
    if (matrix && kfg.matrix.reaktionen.an && typeof entscheiden === 'function') {
      w.reaktionen = new FreigabeReaktionen({
        konfig: kfg,
        kanal: matrix,
        freigaben: w.freigaben,
        entscheiden,
        zurueckstellen: (id, bis) => w.zurueckstellen(id, bis),
        speicher: w.speicher,
        log,
        jetzt: w.jetzt,
      });
    }
    return w;
  }

  /** ⏳ später: die nächste Erinnerung dieser Freigabe rückt bis `bisMs` nach hinten; die Freigabe bleibt offen. */
  zurueckstellen(id, bisMs) {
    return this._kette.lauf(async () => {
      const s = ((await this.speicher.lesen()).freigabemeldung ?? {})[id];
      if (!s || !s.zuletzt) return false;
      const neu = Math.max(Number(s.zuletzt) || 0, bisMs - erinnerungsAbstand(Number(s.erinnert) || 0, this.kfg.erinnerung));
      await this.speicher.aendern((d) => {
        d.freigabemeldung ??= {};
        if (d.freigabemeldung[id]) d.freigabemeldung[id].zuletzt = neu;
      });
      return true;
    });
  }

  get an() {
    return this.kanaele.length > 0;
  }

  start() {
    if (!this.an || this._aktiv) return false;
    this._aktiv = true;
    const takt = () => void this.pruefen().catch(() => {});
    this._timer = setInterval(takt, this.kfg.pruefenS * 1000);
    this._timer.unref?.();
    this.reaktionen?.start();
    this.log.info(`Freigabe-Meldung: ${this.kanaele.map((k) => k.name).join(', ')}`);
    takt();
    return true;
  }

  async stop() {
    this._aktiv = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    await this.reaktionen?.stop();
    await this._kette.lauf(async () => {});
  }

  /** Ein Durchgang; geht nie zwei Mal zugleich. Gibt zurück, was gesendet wurde. */
  pruefen() {
    return this._kette.lauf(() => this.#runde());
  }

  async #runde() {
    const gesendet = [];
    if (!this.an) return gesendet;
    const jetzt = this.jetzt();
    try {
      const alle = await this.freigaben();
      const offen = alle.filter((f) => f?.id && f.status === 'offen');
      this.offen = offen.length;
      const gespeichert = (await this.speicher.lesen()).freigabemeldung ?? {};
      const stand = JSON.parse(JSON.stringify(gespeichert));
      let geaendert = false;
      // Entschiedene oder verschwundene Freigaben brauchen keinen Eintrag mehr.
      const offeneIds = new Set(offen.map((f) => f.id));
      for (const id of Object.keys(stand)) {
        if (!offeneIds.has(id)) {
          delete stand[id];
          geaendert = true;
        }
      }
      const ruhe = istRuhezeit(jetzt, this.kfg.ruhezeit);
      const alter = (f) => jetzt - (Number(f.erstellt) || jetzt);
      const buendelMs = this.kfg.buendelS * 1000;

      // Phase 1: neue Freigaben, je Kanal. Hohes Risiko sofort und einzeln, der Rest gebündelt und nie in der Ruhezeit.
      for (const kanal of this.kanaele) {
        if (this.#pausiert(kanal.name, jetzt)) continue;
        const fehlt = offen.filter((f) => stand[f.id]?.kanaele?.[kanal.name] === undefined);
        const hoch = fehlt.filter((f) => f.risiko === 'high');
        const rest = fehlt.filter((f) => f.risiko !== 'high');
        const gruppen = hoch.map((f) => [f]);
        if (rest.length && !ruhe && rest.some((f) => alter(f) >= buendelMs)) gruppen.push(rest);
        for (const gruppe of gruppen) {
          const n = nachrichtBauen({ art: 'neu', liste: gruppe, kanal, kfg: this.kfg, jetzt });
          const ergebnis = await this.#senden(kanal, n, jetzt);
          if (!ergebnis) break; // Kanal gestört: der Rest wartet auf den nächsten Durchgang
          await this.#chips(kanal, ergebnis, gruppe, n);
          for (const f of gruppe) {
            const s = (stand[f.id] ??= { kanaele: {}, zuletzt: null, erinnert: 0 });
            s.kanaele ??= {};
            s.kanaele[kanal.name] = jetzt;
            s.zuletzt = jetzt;
          }
          this.gemeldet.neu += gruppe.length;
          gesendet.push({ kanal: kanal.name, art: 'neu', ids: gruppe.map((f) => f.id) });
          geaendert = true;
        }
      }
      if (geaendert) await this.speicher.aendern((d) => void (d.freigabemeldung = stand));
      geaendert = false;

      // Phase 2: Erinnerungen für Freigaben, die schon gemeldet waren (Zustand vor diesem Durchgang).
      const faellig = offen.filter((f) => {
        const s = gespeichert[f.id];
        if (!s || !s.zuletzt) return false;
        const k = Number(s.erinnert) || 0;
        if (k >= this.kfg.erinnerung.maxAnzahl) return false;
        return jetzt - s.zuletzt >= erinnerungsAbstand(k, this.kfg.erinnerung);
      });
      const hochF = faellig.filter((f) => f.risiko === 'high');
      const restF = faellig.filter((f) => f.risiko !== 'high');
      const gruppen = hochF.map((f) => [f]);
      if (restF.length && !ruhe) gruppen.push(restF);
      for (const gruppe of gruppen) {
        let irgendeiner = false;
        for (const kanal of this.kanaele) {
          if (this.#pausiert(kanal.name, jetzt)) continue;
          // Nummer: die höchste bisherige Erinnerungszahl der Gruppe + 1.
          const nummer = Math.max(...gruppe.map((f) => (Number(stand[f.id]?.erinnert) || 0) + 1));
          const n = nachrichtBauen({ art: 'erinnerung', liste: gruppe, kanal, kfg: this.kfg, jetzt, nummer });
          const ergebnis = await this.#senden(kanal, n, jetzt);
          if (ergebnis) {
            await this.#chips(kanal, ergebnis, gruppe, n);
            irgendeiner = true;
            gesendet.push({ kanal: kanal.name, art: 'erinnerung', ids: gruppe.map((f) => f.id) });
          }
        }
        if (!irgendeiner) continue;
        for (const f of gruppe) {
          const s = stand[f.id];
          s.zuletzt = jetzt;
          s.erinnert = (Number(s.erinnert) || 0) + 1;
        }
        this.gemeldet.erinnerung += gruppe.length;
        geaendert = true;
      }
      if (geaendert) await this.speicher.aendern((d) => void (d.freigabemeldung = stand));
      this.letzterLaufFehler = null;
    } catch (fehler) {
      this.letzterLaufFehler = kurz(String(fehler?.message ?? fehler), 200);
      this.log.warn(`Freigabe-Meldung: ${this.letzterLaufFehler}`);
    }
    this.letzterLauf = jetzt;
    return gesendet;
  }

  /** Chips nur an Einzelmeldungen im Matrix-Kanal (Bündel haben keine eindeutige Freigabe). Ein Fehler hier ändert am Melden nichts. */
  async #chips(kanal, ergebnis, gruppe, nachricht) {
    if (kanal.name !== 'matrix' || !this.reaktionen?.an || gruppe.length !== 1 || ergebnis.schatten === true || !ergebnis.eventId) return;
    try {
      await this.reaktionen.meldungMerken({ eventId: ergebnis.eventId, freigabe: gruppe[0], text: nachricht.text, bezug: nachricht.bezug });
    } catch (f) {
      this.log.warn(`Freigabe-Reaktionen: Chips nicht gesetzt: ${kurz(String(f?.message ?? f), 100)}`);
    }
  }

  #pausiert(name, jetzt) {
    const p = this._pause[name];
    return Boolean(p && p.bis > jetzt);
  }

  /** Sendet über einen Kanal; bei Fehler wächst die Pause des Kanals (30 s, 1 min, … höchstens 15 min). */
  async #senden(kanal, nachricht, jetzt) {
    let ergebnis;
    try {
      ergebnis = await kanal.senden(nachricht);
    } catch (f) {
      ergebnis = { ok: false, grund: kurz(String(f?.message ?? f), 80) };
    }
    if (ergebnis?.ok) {
      delete this._pause[kanal.name];
      delete this.fehler[kanal.name];
      this.letzter = { zeit: jetzt, art: nachricht.art, kanal: kanal.name, schatten: ergebnis.schatten === true };
      return ergebnis;
    }
    const n = (this._pause[kanal.name]?.n ?? 0) + 1;
    const abstandS = Math.min(30 * 2 ** (n - 1), 900);
    this._pause[kanal.name] = { n, bis: jetzt + abstandS * 1000 };
    this.fehler[kanal.name] = ergebnis?.grund ?? 'unbekannter Fehler';
    this.log.warn(`Freigabe-Meldung über ${kanal.name}: ${this.fehler[kanal.name]} (neuer Versuch in ${abstandS} s)`);
    return false;
  }

  /** Für /zustand des Steuerkanals; ohne Geheimnisse (keine URLs, kein Thema, kein Token). */
  zustand() {
    const jetzt = this.jetzt();
    return {
      an: this.an,
      kanaele: this.kanaele.map((k) => k.name),
      offen: this.offen,
      gemeldet: { ...this.gemeldet },
      letzter: this.letzter,
      letzter_lauf: this.letzterLauf,
      ruhezeit: istRuhezeit(jetzt, this.kfg.ruhezeit),
      fehler: { ...this.fehler, ...(this.letzterLaufFehler ? { lauf: this.letzterLaufFehler } : {}) },
      reaktionen: this.reaktionen ? this.reaktionen.zustand() : { an: false },
      pause: Object.fromEntries(Object.entries(this._pause).filter(([, p]) => p.bis > jetzt).map(([k, p]) => [k, { versuche: p.n, bis: p.bis }])),
    };
  }
}
