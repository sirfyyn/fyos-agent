/**
 * itsm-wache.js — die ITSM-Wache (M4: Fortsetzung nach Freigabe, Kommentare, Wiedervorlagen).
 *
 * Betrachtet die Vorgänge, an denen der Agent hängt, und weckt ihn bei Änderungen von Besitzer.
 * Beobachtet werden: Vorgänge, die auf Besitzer warten und dem Agenten gehören (`itsm.wartend`), sein
 * Rückstand (`denken.liegt`, Grund persona) und Vorgänge, die als Bezug seiner Züge vorkamen
 * (`bezug_tage`). Alles lesend über den Hub, ohne Modell. Der Stand liegt im Dokument `WachenZustand`.
 *
 * Portiert aus `ItsmWache` und `itsm_ereignisse` im RPC-Runner (agent_runner.py). Konfiguration
 * unverändert aus agent-runner.json: `itsm` (an, pruefen_s, vorgaenge_max, bezug_tage, besitzer, agent).
 */
import {
  Kette,
  Schlaf,
  hubLesen,
  istObjekt,
  kurz,
  logger,
  wachenAendern,
  wachenLesen,
} from './wachen-zustand.js';

export const VORGANG_ID = /^(INC|PRB|CHG|VOR|WB|REQ)-[A-Za-z0-9]{1,16}$/;
export const ITSM_TEXT_MAX = 1500;

const TAG_MS = 86_400_000;

/** ISO-Zeit wie `datetime.fromisoformat`: ohne Zeitzone gilt UTC. `NaN`, wenn unlesbar. */
function isoMs(text) {
  let s = String(text).trim().replace(/Z$/i, '+00:00');
  if (/[T ]/.test(s) && !/([+-]\d\d:?\d\d)$/.test(s)) s += '+00:00';
  s = s.replace(' ', 'T');
  return Date.parse(s);
}

/**
 * Vergleicht den gemerkten Stand eines Vorgangs mit `itsm.vorgang`; liefert Ereignisse und neuen Stand.
 *
 * Beim ersten Blick entsteht nur der Stand (keine Flut alter Einträge). Danach zählen nur neue
 * Verlaufseinträge. Eine Freigabe gilt nur, wenn der Statuswechsel aus waiting_approval vom
 * Akteur `max` kommt (leitstand.freigabe schreibt immer als max) — sonst weckt er nichts.
 * `jetzt` in Millisekunden.
 */
export function itsmEreignisse(alt, v, jetzt, besitzer = 'max', log = null) {
  const tid = String(v.id || alt.id || '');
  const titel = kurz(String(v.titel || ''), 120);
  const status = String(v.status || '');
  const verlauf = (Array.isArray(v.verlauf) ? v.verlauf : []).filter(istObjekt);
  const altTs = String(alt.ts || '');
  let neuester = altTs;
  if (verlauf.length) {
    neuester = verlauf.map((e) => String(e.ts || '')).reduce((a, b) => (b > a ? b : a));
  }
  const stand = {
    id: tid,
    status,
    ts: neuester || alt.ts || '',
    wiedervorlage_gemeldet: alt.wiedervorlage_gemeldet ?? null,
    gesehen: jetzt,
  };
  if (!alt.status) return { ereignisse: [], stand };
  const neu = verlauf
    .filter((e) => String(e.ts || '') > altTs)
    .sort((a, b) => (String(a.ts || '') < String(b.ts || '') ? -1 : String(a.ts || '') > String(b.ts || '') ? 1 : 0));
  const ereignisse = [];

  const ereignis = (art, text, klasse, ts) => {
    ereignisse.push({
      id: `itsm:${tid}:${art}:${ts}`,
      quelle: 'itsm',
      klasse,
      text,
      bezug: tid,
      von: klasse === 'max' ? 'max' : 'itsm',
    });
  };

  for (const e of neu) {
    if (e.ereignis === 'comment' && String(e.wer || '').toLowerCase() === besitzer) {
      const inhalt = kurz(String(e.text || '').trim(), ITSM_TEXT_MAX);
      ereignis('kommentar', `Besitzer hat am Vorgang ${tid} „${titel}“ kommentiert:\n${inhalt}`, 'max', String(e.ts));
    }
  }
  if (alt.status === 'waiting_approval' && status && status !== 'waiting_approval') {
    const wechsel = neu.filter((e) => e.ereignis === 'updated' && String(e.text || '').includes('waiting_approval→'));
    const letzter = wechsel.at(-1) ?? {};
    const wer = String(letzter.wer || '').toLowerCase();
    const ts = String(letzter.ts || neuester);
    if (wer !== besitzer) {
      log?.warn?.(`ITSM ${tid}: waiting_approval→${status} von ${JSON.stringify(wer || '?')} — keine Freigabe von Besitzer, weckt nichts`);
    } else if (status === 'in_progress') {
      ereignis(
        'erteilt',
        `Besitzer hat die Freigabe am Vorgang ${tid} „${titel}“ erteilt (waiting_approval → in_progress). ` +
          'Führe genau den beantragten Schritt aus, nichts darüber hinaus, und schreib Ergebnis und ' +
          'Beleg an den Vorgang.',
        'max',
        ts,
      );
    } else if (status === 'triage') {
      ereignis(
        'abgelehnt',
        `Besitzer hat die Freigabe am Vorgang ${tid} „${titel}“ abgelehnt (→ triage). Führe den Schritt ` +
          'nicht aus. Such eine Alternative im Rahmen deiner Regeln oder vermerke am Vorgang, dass er ' +
          'ruht.',
        'max',
        ts,
      );
    } else {
      ereignis(
        'beendet',
        `Besitzer hat den Vorgang ${tid} „${titel}“ auf ${status} gesetzt, statt die Freigabe ` +
          'zu beantworten. Der beantragte Schritt entfällt.',
        'max',
        ts,
      );
    }
  }
  const wv = String(v.wiedervorlage || '');
  if (wv && wv !== alt.wiedervorlage_gemeldet && !['resolved', 'closed'].includes(status)) {
    const faellig = isoMs(wv);
    if (Number.isFinite(faellig) && faellig <= jetzt) {
      ereignis(
        'wiedervorlage',
        `Wiedervorlage fällig: Vorgang ${tid} „${titel}“ (Status ${status}). Prüfe, ob er jetzt ` +
          'bearbeitet werden kann, und vermerke das Ergebnis am Vorgang.',
        'hintergrund',
        wv,
      );
      stand.wiedervorlage_gemeldet = wv;
    }
  }
  return { ereignisse, stand };
}

export class ItsmWache {
  constructor({ cfg = {}, hub, harness, einreihen, log, jetzt = () => Date.now() } = {}) {
    const itsm = istObjekt(cfg.itsm) ? cfg.itsm : {};
    // Wie im RPC-Runner: fehlt `itsm`, ist die Wache an; ein Objekt gilt mit `an` (Vorgabe true); sonst aus.
    this.an = cfg.itsm === undefined ? true : istObjekt(cfg.itsm) && Boolean(itsm.an ?? true);
    this.hub = hub;
    this.harness = harness;
    this.einreihen = einreihen;
    this.log = logger(log, 'fyos-itsm');
    this.jetzt = jetzt;
    this.besitzer = String(itsm.besitzer || 'max').toLowerCase();
    this.agent = String(itsm.agent || cfg.agent || 'persona').toLowerCase();
    this.pruefenMs = Math.max(Number(itsm.pruefen_s ?? 120), 0.01) * 1000;
    this.vorgaengeMax = Math.trunc(Number(itsm.vorgaenge_max ?? 40));
    this.bezugMs = Number(itsm.bezug_tage ?? 7) * TAG_MS;
    this.vorgaenge = {};
    this.bezuege = {};
    this.fehler = null;
    this.gemeldet = 0;
    this._geladen = false;
    this._kette = new Kette();
    this._schlaf = new Schlaf();
    this._aktiv = false;
    this._lauf = null;
  }

  async #laden() {
    if (this._geladen) return;
    const d = (await wachenLesen(this.harness)).itsm;
    const alt = istObjekt(d.vorgaenge) ? d.vorgaenge : {};
    this.vorgaenge = { ...Object.fromEntries(Object.entries(alt).filter(([, w]) => istObjekt(w))), ...this.vorgaenge };
    for (const [k, w] of Object.entries(istObjekt(d.bezuege) ? d.bezuege : {})) {
      const t = Number(w);
      if (Number.isFinite(t) && !(k in this.bezuege)) this.bezuege[k] = t;
    }
    this._geladen = true;
  }

  async #sichern(vorgaenge = this.vorgaenge) {
    const itsm = JSON.parse(JSON.stringify({ vorgaenge, bezuege: this.bezuege }));
    await wachenAendern(this.harness, (d) => {
      d.itsm = itsm;
    });
  }

  start() {
    if (!this.an || this._aktiv) return false;
    this._aktiv = true;
    this._schlaf = new Schlaf();
    this._lauf = this.#schleife();
    return true;
  }

  async stop() {
    this._aktiv = false;
    this._schlaf.beenden();
    await Promise.race([this._lauf, new Promise((r) => setTimeout(r, 1000).unref?.())]).catch(() => {});
    this._lauf = null;
  }

  /** Ein Vorgang als Bezug eines Zugs: die Wache behält ihn `bezug_tage` lang im Auge. */
  bezugMerken(bezug) {
    const kennung = String(bezug ?? '');
    if (VORGANG_ID.test(kennung)) this.bezuege[kennung] = this.jetzt();
  }

  async #schleife() {
    for (;;) {
      await this._schlaf.warten(this.pruefenMs);
      if (!this._aktiv) return;
      try {
        await this.runde();
      } catch (fehler) {
        // Die Wache darf den Runner nie mitreißen.
        this.log.warn(`Runde gescheitert: ${fehler?.message ?? fehler}`);
      }
    }
  }

  async #beobachtet() {
    const ids = [];
    try {
      const wartend = await hubLesen(this.hub, 'itsm.wartend', {});
      for (const t of istObjekt(wartend) && Array.isArray(wartend.tickets) ? wartend.tickets : []) {
        if (istObjekt(t) && String(t.zustaendig || '').toLowerCase() === this.agent) ids.push(String(t.id));
      }
    } catch (fehler) {
      this.fehler = `itsm.wartend: ${String(fehler?.message ?? fehler).slice(0, 160)}`;
    }
    try {
      const liegt = await hubLesen(this.hub, 'denken.liegt', {});
      for (const t of istObjekt(liegt) && Array.isArray(liegt.liste) ? liegt.liste : []) {
        if (istObjekt(t) && t.grund === 'persona') ids.push(String(t.id));
      }
    } catch (fehler) {
      this.fehler = `denken.liegt: ${String(fehler?.message ?? fehler).slice(0, 160)}`;
    }
    const grenze = this.jetzt() - this.bezugMs;
    for (const [k, t] of Object.entries(this.bezuege)) if (t < grenze) delete this.bezuege[k];
    ids.push(...Object.keys(this.bezuege).sort((a, b) => this.bezuege[b] - this.bezuege[a]));
    // Bekannte, die noch auf Besitzer warten, nicht aus den Augen verlieren.
    ids.push(...Object.entries(this.vorgaenge).filter(([, st]) => st.status === 'waiting_approval').map(([k]) => k));
    const sauber = [];
    for (const k of ids) if (VORGANG_ID.test(k) && !sauber.includes(k)) sauber.push(k);
    return sauber.slice(0, this.vorgaengeMax);
  }

  /** Eine Runde: Vorgänge lesen, Ereignisse bilden, einreihen, Stand sichern. */
  runde() {
    return this._kette.lauf(async () => {
      await this.#laden();
      const ids = await this.#beobachtet();
      const alle = [];
      const staende = { ...this.vorgaenge };
      for (const tid of ids) {
        let v;
        try {
          v = await hubLesen(this.hub, 'itsm.vorgang', { id: tid });
        } catch (fehler) {
          this.fehler = `itsm.vorgang ${tid}: ${String(fehler?.message ?? fehler).slice(0, 160)}`;
          continue;
        }
        if (!istObjekt(v) || !v.status) continue;
        const { ereignisse, stand } = itsmEreignisse(staende[tid] ?? {}, v, this.jetzt(), this.besitzer, this.log);
        if (['resolved', 'closed'].includes(stand.status)) delete staende[tid];
        else staende[tid] = stand;
        alle.push(...ereignisse);
      }
      const behalten = new Set(ids);
      for (const k of Object.keys(staende)) if (!behalten.has(k)) delete staende[k];
      // Erst einreihen (idempotent über die Id), dann den Stand sichern: scheitert das Einreihen,
      // bildet die nächste Runde dieselben Ereignisse noch einmal, statt sie zu verlieren.
      for (const e of alle) {
        this.log.info(`ITSM-Wache: ${e.id}`);
        await this.einreihen(e);
        this.gemeldet += 1;
      }
      this.vorgaenge = staende;
      await this.#sichern();
      return alle;
    });
  }

  /** Kleines Objekt für /zustand. */
  zustand() {
    return {
      vorgaenge: Object.keys(this.vorgaenge).length,
      wartet_auf_max: Object.entries(this.vorgaenge)
        .filter(([, st]) => st.status === 'waiting_approval')
        .map(([k]) => k)
        .sort(),
      gemeldet: this.gemeldet,
      fehler: this.fehler,
    };
  }
}
