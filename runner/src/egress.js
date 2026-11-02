/**
 * egress.js — was der Agent nach außen sagt.
 *
 * Der Hub ist die gemeinsame Sicht für Matrix, ITSM, Oberflächen und andere Agenten. Der Runner
 * schreibt dorthin keine zweiten Wahrheiten, sondern übersetzt seine pi-durable-Ereignisse in den
 * Vertrag `fyos:agent` (part.updated, proposal, session.idle, error). Der Puffer ist absichtlich
 * klein und wird bei jedem Fehler stehen gelassen; die Reihenfolge je Sitzung bleibt erhalten.
 */
import { EREIGNIS, KONTEXT, aktivesFenster, ereignisArt, ereignisse, gespraechOeffnen } from './lauf/index.js';
import { Freigaben, LaufListe, Laufzeit, Register } from './documents.js';
import { kontextAnzeigen } from './freigabe-kontext.js';
import { befehlVon, jsonSchwaerzen, liestSecret, schwaerzen } from './persona/redaktion.js';

const CTX = KONTEXT;
const MAX_EREIGNISSE = 200;
const MAX_BYTES = 60_000;
const KUERZ = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const KENNUNG = (s) => String(s ?? '').replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 64);

export class Egress {
  constructor({ cfg, harness, hub, onFehler, ruhe = null, zugmessung, jetzt, messung, zugKontext } = {}) {
    this.cfg = cfg;
    /** Ruhe-Schalter (`ruhe.js`): dämpft die Freigabe-Erinnerungen und meldet seinen Wechsel (`meldeRuhe`). */
    this.ruhe = ruhe;
    // Optional: misst die Dauer jedes Zugs (Eingang bis Ende) für die Verwaltung (verwaltung.js).
    this.zugmessung = zugmessung ?? null;
    this.jetzt = jetzt ?? (() => Date.now());
    this.harness = harness;
    this.hub = hub;
    // Optional: Messung der Sprachsätze (stimme.js) und der Zugkontext, den der Ingress setzt und der Zug am Ende löscht.
    this.messung = messung ?? null;
    this.zugKontext = zugKontext ?? null;
    this.onFehler = onFehler ?? ((e) => console.error(`[fyos-egress] ${e.message}`));
    this.buffer = [];
    this.streams = new Map();
    this.sequenzen = {};
    this.live = new Map();
    this.laufKinder = new Set();
    this.laufWatch = null;
    // Offener Zug je Gespräch: die Strom-ID des Eingangs, den der Zug beantwortet (Klammer `ein:<Strom-ID>`).
    this.zug = new Map();
    // Was der offene Zug beantwortet: {quelle, klasse, ein, bezug} (für /zustand `laufend`).
    this.zugDaten = new Map();
    // Meldestrecke wie im RPC-Runner: gemeldet = beim Hub angekommen, verworfen = aus dem Puffer verdrängt.
    this.gemeldet = 0;
    this.verworfen = 0;
    this.erinnerung = null;
    this.tools = new Map();
    this.flushTimer = null;
    this.flushLaeuft = false;
    this.regWatch = null;
    this.aktiv = false;
    this.letzterFehler = null;
    this._zaehler = 0;
    // Wer den Gesprächsverlauf mitlesen will (Tagesprotokoll des Gedächtnisses): mitleser(gespraechsId, ereignis). Wirft nie.
    this.mitleser = null;
    // Gesundheit (Wächter „Runner stumm“, src/gesundheit.js): was nach außen gelingt und was nicht.
    this.letzterErfolg = null; // ms, letzter Flush, den der Hub angenommen hat
    this.fehlerZahl = 0; // Fehler beim Melden seit dem Start
    this.fehlerInFolge = 0;
    this.abgelehnt = 0; // Antworten 4xx des Hubs (Vertrag), seit dem Start
    this.abgelehntInFolge = 0;
    this.letzterFehlerInfo = null; // {zeit, text, status}
    this.letztesVerwerfen = null; // ms
    // Zug je Gespräch: Beginn des offenen Zugs und Ende des letzten (run_start/run_end).
    this.zuege = new Map();
    /** Beobachter des Zugs (Schatten-Rekorder), alle Methoden optional und ohne Wirkung auf den Ausgang:
     *  werkzeug(ein, name, args) bei der ersten Werkzeugwahl, text(ein, delta) bei Antworttext, ende(ein) am Zugende. */
    this.beobachter = null;
  }

  /** Ruft eine Methode des Beobachters; ein Fehler dort darf den Ausgang nie stören. */
  #beobachte(methode, ...args) {
    try {
      this.beobachter?.[methode]?.(...args);
    } catch (fehler) {
      this.onFehler(fehler);
    }
  }

  /**
   * Was der Zug `ein` im Gespräch `id` getan hat, aus dem gespeicherten Verlauf: erste Werkzeugwahl und aller Text seit dem Eingang.
   * Nur der Beobachter ruft das auf (am Zugende); die Beobachtung der Ereignisse allein kann einen sehr schnellen Aufruf verpassen.
   */
  async #verlaufFuer(id, ein) {
    const conv = await gespraechOeffnen(this.harness, id);
    if (!conv) return null;
    // Das aktive Fenster genügt: der Zug, nach dem gefragt wird, liegt immer nach dem letzten Kopf-Marker.
    const { entries } = await aktivesFenster(conv);
    let start = -1;
    (entries ?? []).forEach((e, i) => {
      if (e?.kind === 'fyos.eingang' && KENNUNG(e.data?.stromId) === ein) start = i;
    });
    if (start < 0) return null;
    let werkzeug = null;
    let text = '';
    for (const e of entries.slice(start + 1)) {
      for (const m of e.model ?? []) {
        if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
        for (const b of m.content) {
          if (b?.type === 'toolCall' && !werkzeug) werkzeug = { name: String(b.name ?? ''), args: b.arguments ?? {} };
          else if (b?.type === 'text' && b.text) text += b.text;
        }
      }
    }
    return { werkzeug, text };
  }

  async start() {
    if (this.aktiv) return;
    if (!this.cfg.pi_durable.egress.enabled) return;
    this.aktiv = true;
    const lz = await this.harness.snapshot(Laufzeit, CTX);
    this.sequenzen = { ...(lz?.sequenzen ?? {}) };
    const reg = (await this.harness.snapshot(Register, CTX)) ?? { agents: [] };
    for (const a of reg.agents ?? []) await this.#haengen(a.id);
    this.regWatch = await this.harness.watchDoc(Register, CTX);
    if (this.regWatch) {
      this.regWatch.start(async (wert) => {
        const ids = new Set((wert?.agents ?? []).map((a) => a.id));
        for (const id of ids) if (!this.streams.has(id)) await this.#haengen(id);
        for (const id of [...this.streams.keys()]) {
          if (!ids.has(id) && !this.laufKinder.has(id)) {
            const s = this.streams.get(id);
            this.streams.delete(id);
            await s.stop?.().catch(() => {});
          }
        }
      });
    }
    // Kind-Gespräche der Läufe stehen nicht im Register, arbeiten aber für den Menschen:
    // ihre Zeilen gehören ebenfalls in den Ausgang.
    const haengeLaeufe = async (liste) => {
      for (const e of Object.values(liste?.eintraege ?? {})) {
        if (!e.kindId) continue;
        this.laufKinder.add(e.kindId);
        await this.#haengen(e.kindId);
      }
    };
    await haengeLaeufe(await this.harness.snapshot(LaufListe, CTX));
    this.laufWatch = await this.harness.watchDoc(LaufListe, CTX);
    this.laufWatch?.start(async (wert) => haengeLaeufe(wert));
    this.flushTimer = setInterval(() => void this.flush(), this.cfg.pi_durable.egress.flushMs);
    this.flushTimer.unref?.();
    // Offene Freigaben immer wieder melden: wer sich später verbindet (Handy, zweiter Client), sieht sie trotzdem.
    // Betrachter führen sie über die Kennung zusammen; die Matrix-Brücke liest `proposal` nicht.
    const erinnerungS = Number(this.cfg.pi_durable.egress.erinnerungS ?? 60);
    if (erinnerungS > 0) {
      this.erinnerung = setInterval(() => void this.freigabenErinnern(), erinnerungS * 1000);
      this.erinnerung.unref?.();
    }
  }

  /** Alle offenen Freigaben noch einmal als `proposal` in den Ausgang legen. */
  async freigabenErinnern() {
    try {
      const doc = await this.harness.snapshot(Freigaben, CTX);
      // In der Ruhe (oder im Spielmodus) erinnert nur noch, was hohes Risiko trägt; die übrigen bleiben offen und ruhig.
      const gedaempft = Boolean(this.ruhe?.pausiert?.());
      for (const f of Object.values(doc?.eintraege ?? {})) {
        if (f.status !== 'offen' || f.conversationId === undefined || f.conversationId === null) continue;
        if (gedaempft && f.risiko !== 'high') continue;
        this.#lege(f.conversationId, 'proposal', {
          id: f.id,
          aktion: f.aktion,
          risiko: f.risiko,
          kontext: kontextAnzeigen(f),
          zerstoererisch: !!f.zerstoererisch,
          optionen: ['once', 'deny'],
        });
      }
      await this.flush();
    } catch (fehler) {
      this.onFehler(fehler);
    }
  }

  async #haengen(id) {
    if (this.streams.has(id)) return;
    try {
      const stream = await ereignisse(this.harness, id);
      this.streams.set(id, stream);
      stream.start((ereignisse) => this.verarbeite(id, ereignisse));
    } catch (fehler) {
      this.onFehler(fehler);
    }
  }

  /** pi-durable-Ereignisse eines Gesprächs übersetzen und melden (der Strom ruft das; Tests füttern live-förmige Ereignisse ein). */
  async verarbeite(id, ereignisse) {
    for (const e of ereignisse) {
      try {
        this.mitleser?.(id, e);
      } catch {
        /* ein Mitleser hält den Ausgang nie auf */
      }
      this.#uebersetzen(id, e);
    }
    await this.flush();
  }

  #naechste(id) {
    const q = (this.sequenzen[id] ?? 0) + 1;
    this.sequenzen[id] = q;
    return q;
  }

  #lege(id, typ, felder = {}) {
    this.buffer.push({
      v: '1',
      typ,
      // Eingabeformat des Hubs (mcp_hub/plugins/_agentenstrom.py::eintrag): `agent` und `sitzung`. Die Kurzschlüssel a/s
      // sind erst das Format im Strom; wer sie sendet, wird mit „Agenten-ID unbrauchbar: None“ verworfen (25.10.2026).
      agent: this.cfg.agent,
      sitzung: String(id),
      q: this.#naechste(id),
      t: this.jetzt(),
      ...felder,
    });
    if (this.buffer.length > this.cfg.pi_durable.egress.maxBuffer) {
      const zuviel = this.buffer.length - this.cfg.pi_durable.egress.maxBuffer;
      this.buffer.splice(0, zuviel);
      this.verworfen += zuviel;
      this.letztesVerwerfen = this.jetzt();
    }
  }

  /** Zähler für `/zustand` → `gesundheit` und die Ampel in src/gesundheit.js. */
  gesundheit() {
    const jetzt = this.jetzt();
    const aeltestes = this.buffer.length > 0 ? this.buffer[0].t : null;
    return {
      aktiv: this.aktiv,
      stau: this.buffer.length,
      max_puffer: this.cfg.pi_durable.egress.maxBuffer,
      aeltestes_s: aeltestes === null ? null : Math.max(0, Math.round((jetzt - aeltestes) / 1000)),
      letzter_erfolg: this.letzterErfolg,
      letzter_erfolg_vor_s: this.letzterErfolg === null ? null : Math.round((jetzt - this.letzterErfolg) / 1000),
      gemeldet: this.gemeldet,
      verworfen: this.verworfen,
      letztes_verwerfen: this.letztesVerwerfen,
      fehler: this.fehlerZahl,
      fehler_in_folge: this.fehlerInFolge,
      abgelehnt: this.abgelehnt,
      abgelehnt_in_folge: this.abgelehntInFolge,
      letzter_fehler: this.letzterFehlerInfo,
    };
  }

  /** Der Zug des Gesprächs `id`: läuft er, seit wann, wann endete der letzte. */
  zugStand(id) {
    const z = this.zuege.get(String(id));
    const jetzt = this.jetzt();
    return {
      laeuft: Boolean(z?.laeuft),
      seit_s: z?.laeuft && z.start !== null ? Math.max(0, Math.round((jetzt - z.start) / 1000)) : null,
      letzter_start: z?.start ?? null,
      letztes_ende: z?.ende ?? null,
    };
  }

  /** Ereignisse, die noch auf die Zustellung warten. */
  tiefe() {
    return this.buffer.length;
  }

  /** Form wie `meldestrecke` im RPC-Runner: {stau, gemeldet, verworfen}. */
  meldestrecke() {
    return { stau: this.tiefe(), gemeldet: this.gemeldet, verworfen: this.verworfen };
  }

  /** Der offene Zug des Gesprächs `id` als {quelle, klasse, ein, bezug}; `null`, wenn keiner offen ist. */
  laufend(id) {
    return this.zugDaten.get(String(id)) ?? this.zugDaten.get(id) ?? null;
  }

  /**
   * Ein Ereignis eines Bausteins (z. B. Reflex-Meldung `ui_request`) in den Ausgang legen. Sitzung und
   * Sequenz setzt der Egress, wie bei seinen eigenen Ereignissen.
   */
  meldeExtern(sitzung, ereignis) {
    const { typ, agent: _agent, t: _t, sitzung: _s, q: _q, ...rest } = ereignis ?? {};
    if (!typ || sitzung === undefined || sitzung === null) return false;
    this.#lege(String(sitzung), String(typ), rest);
    void this.flush();
    return true;
  }

  /**
   * Wechsel des Ruhe-Schalters als Ereignis `ruhe` in den Ausgang (Hub-Strom). Aus, solange `egress.ruheMelden` fehlt: der Hub
   * lehnt einen Stapel mit unbekanntem Typ ganz ab, erst nach seinem Rollout einschalten. Clients brauchen es nicht,
   * sie bekommen `event: ruhe` direkt vom Runner.
   */
  meldeRuhe(sitzung, z) {
    if (!this.cfg.pi_durable.egress.ruheMelden || !this.aktiv) return false;
    return this.meldeExtern(sitzung, {
      typ: 'ruhe',
      an: z.ruhe ? '1' : '0',
      pausiert: z.pausiert ? '1' : '0',
      stufe: z.stufe,
      quelle: z.quelle ?? '',
      grund: z.grund ?? '',
      bis: z.bis ?? '',
      von: z.von ?? '',
    });
  }

  /**
   * Der Zug beantwortet einen Eingang: wie im RPC-Runner klammert ein Step-Part `ein:<Strom-ID>` ihn ein,
   * damit Betrachter (HA-Sprachweg, Matrix) die Antwort dem Ereignis zuordnen.
   */
  #zugBeginn(id, entry) {
    if (entry?.kind !== 'fyos.eingang' || !entry.data?.stromId) return;
    const stromId = KENNUNG(entry.data.stromId);
    const offen = this.zug.get(id);
    if (offen === stromId) return;
    // Ein zweiter Eingang im selben Lauf (Besitzer steuert, Hintergrund folgt) löst den ersten ab; ohne Abschluss bliebe seine Klammer
    // bei den Betrachtern für immer offen (Vertragstest vertrag-hub.test.js).
    if (offen) this.#lege(id, 'part.updated', { id: `ein:${offen}`, pt: 'step', label: 'Eingang', phase: 'finish' });
    this.zug.set(id, stromId);
    const d = entry.data;
    this.zugDaten.set(id, { quelle: d.quelle ?? null, klasse: d.klasse ?? null, ein: stromId, bezug: d.bezug ?? null });
    this.messung?.zugBeginn(id, entry);
    this.zugKontext?.setze(id, { ein: stromId, quelle: d.quelle ?? null, von: d.von ?? null, klasse: d.klasse ?? null, bezug: d.bezug ?? null });
    this.zugmessung?.beginn(id, d.quelle ?? null, d.klasse ?? null);
    const label = KUERZ(`${d.quelle ?? 'hub'}${d.klasse === 'max' ? ' (Besitzer)' : ''}: ${d.text ?? ''}`, 190);
    this.#lege(id, 'part.updated', { id: `ein:${stromId}`, pt: 'step', label, phase: 'start' });
  }

  #uebersetzen(id, e) {
    switch (ereignisArt(e)) {
      case EREIGNIS.NACHRICHT_START: {
        this.live.set(id, { id: `m${++this._zaehler}`, text: '' });
        break;
      }
      case EREIGNIS.NACHRICHT_UPDATE: {
        const live = this.live.get(id) ?? { id: `m${++this._zaehler}`, text: '' };
        this.live.set(id, live);
        for (const change of e.changes ?? []) {
          if (change.type === 'text_delta' && change.delta) {
            if (!live.text) this.messung?.text(id);
            live.text += change.delta;
            this.#beobachte('text', this.zug.get(id), change.delta);
            this.#lege(id, 'part.updated', {
              id: live.id,
              pt: 'text',
              delta: KUERZ(change.delta, 2000),
            });
          } else if (change.type === 'thinking_delta' && change.delta) {
            this.#lege(id, 'part.updated', {
              id: `${live.id}-denken`,
              pt: 'reasoning',
              delta: KUERZ(change.delta, 2000),
            });
          }
        }
        break;
      }
      case EREIGNIS.NACHRICHT_ENDE: {
        // Ein Eingang erscheint als Nutzernachricht (`message_end` mit entry.kind), nicht als `entry_appended`.
        this.#zugBeginn(id, e.entry);
        if (this.messung) {
          for (const m of e.entry?.model ?? []) if (m?.role === 'assistant' && m.usage) this.messung.nutzung(id, m.usage);
        }
        const live = this.live.get(id);
        if (live) {
          const text = (e.entry?.model ?? [])
            .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
            .filter((b) => b?.type === 'text')
            .map((b) => b.text)
            .join('');
          if (!live.text && text) {
            this.messung?.text(id);
            this.#beobachte('text', this.zug.get(id), text);
            this.#lege(id, 'part.updated', {
              id: live.id,
              pt: 'text',
              delta: KUERZ(text, 2000),
            });
          }
          this.#lege(id, 'part.done', { id: live.id });
          this.live.delete(id);
        }
        break;
      }
      case EREIGNIS.WERKZEUG_START: {
        const callId = KENNUNG(e.toolCallId);
        this.tools.set(callId, { text: '', befehl: befehlVon({ arguments: e.args }) });
        this.#beobachte('werkzeug', this.zug.get(id), e.toolName, e.args ?? {});
        this.#lege(id, 'part.updated', {
          id: callId,
          pt: 'tool',
          wz: e.toolName,
          st: 'running',
          // Was zum Hub geht, ist geschwärzt wie das, was das Modell sieht (Secrets wie Claude, PERSONA-SECRETS.md).
          args: jsonSchwaerzen(e.args ?? {}),
        });
        break;
      }
      case EREIGNIS.WERKZEUG_UPDATE: {
        const callId = KENNUNG(e.toolCallId);
        const t = this.tools.get(callId) ?? { text: '' };
        if (e.output && 'set' in e.output) t.text = e.output.set;
        else if (e.output) {
          if (e.output.trimStart) t.text = t.text.slice(e.output.trimStart);
          t.text += e.output.append ?? '';
        }
        this.tools.set(callId, t);
        // Liest der Befehl ein Secret, gehen Zwischenstände nicht hinaus: ein Teilstück könnte den Wert zeigen, bevor die Struktur erkennbar ist.
        if (t.text && !liestSecret(t.befehl)) {
          this.#lege(id, 'part.updated', {
            id: callId,
            pt: 'tool',
            st: 'running',
            ergebnis: KUERZ(schwaerzen(t.text, { befehl: t.befehl }), 1000),
          });
        }
        break;
      }
      case EREIGNIS.WERKZEUG_ENDE: {
        const callId = KENNUNG(e.toolCallId);
        const t = this.tools.get(callId) ?? { text: '' };
        const fehler = e.entry?.data?.isError || e.entry?.model?.some?.((m) => m?.isError);
        this.#lege(id, 'part.updated', {
          id: callId,
          pt: 'tool',
          wz: e.toolName,
          st: fehler ? 'error' : 'completed',
          ergebnis: KUERZ(schwaerzen(t.text, { befehl: t.befehl }), 1000),
        });
        this.#lege(id, 'part.done', { id: callId });
        this.tools.delete(callId);
        break;
      }
      case EREIGNIS.EINTRAG: {
        const entry = e.entry;
        if (entry?.kind === 'fyos.freigabe') {
          const d = entry.data ?? {};
          this.#lege(id, 'proposal', {
            id: d.id,
            aktion: d.aktion,
            risiko: d.risiko,
            kontext: kontextAnzeigen(d),
            zerstoererisch: !!d.zerstoererisch,
            optionen: ['once', 'deny'],
          });
        }
        // Ein Befehlsergebnis hat im Hub-Vertrag keinen eigenen Part-Typ: es geht als kurzer `text`-Teil.
        if (entry?.kind === 'fyos.befehl') {
          const pid = `befehl:${KENNUNG(entry.id ?? ++this._zaehler)}`;
          this.#lege(id, 'part.updated', { id: pid, pt: 'text', delta: KUERZ(`/${entry.data?.name ?? ''}: ${entry.data?.text ?? ''}`, 2000) });
          this.#lege(id, 'part.done', { id: pid });
        }
        this.#zugBeginn(id, entry);
        // Eine Freigabe ist entschieden: den Betrachtern sagen, dass sie nicht mehr offen ist.
        if (entry?.kind === 'fyos.freigabe-entscheidung' && entry.data?.id) {
          const ok = entry.data.entscheidung === 'erteilt';
          this.#lege(id, 'part.updated', {
            id: `freigabe:${KENNUNG(entry.data.id)}`,
            pt: 'step',
            label: ok ? 'Freigabe erteilt' : 'Freigabe abgelehnt',
            phase: 'finish',
          });
        }
        break;
      }
      case EREIGNIS.ZUG_START: {
        this.zuege.set(String(id), { start: this.jetzt(), ende: this.zuege.get(String(id))?.ende ?? null, laeuft: true });
        break;
      }
      case EREIGNIS.ZUG_ENDE: {
        this.messung?.ende(id);
        this.zugKontext?.loesche(id);
        const z = this.zuege.get(String(id));
        this.zuege.set(String(id), { start: z?.start ?? null, ende: this.jetzt(), laeuft: false });
        const offen = this.zug.get(id);
        if (offen) {
          this.zug.delete(id);
          this.zugDaten.delete(id);
          this.#beobachte('ende', offen, () => this.#verlaufFuer(id, offen));
          this.zugmessung?.ende(id);
          this.#lege(id, 'part.updated', { id: `ein:${offen}`, pt: 'step', label: 'Eingang', phase: 'finish' });
        }
        this.#lege(id, 'session.idle', {});
        break;
      }
      case EREIGNIS.AUFGABE_FEHLGESCHLAGEN: {
        this.#lege(id, 'error', {
          nachricht: KUERZ(e.message || 'Aufgabe fehlgeschlagen', 600),
          art: KUERZ(e.kind || 'task', 40),
        });
        break;
      }
      case EREIGNIS.VERDICHTEN_START: {
        this.#lege(id, 'part.updated', {
          id: `verdichten-${KENNUNG(e.taskId)}`,
          pt: 'step',
          label: 'Verdichte den Verlauf',
          phase: 'start',
        });
        break;
      }
      case EREIGNIS.VERDICHTEN_ENDE: {
        this.#lege(id, 'part.updated', {
          id: `verdichten-${KENNUNG(e.taskId)}`,
          pt: 'step',
          label: e.error ? 'Verdichten fehlgeschlagen' : 'Verlauf verdichtet',
          phase: 'finish',
        });
        break;
      }
      default:
        break;
    }
  }

  #stueck() {
    const stueck = [];
    let bytes = 0;
    for (const e of this.buffer) {
      const groesse = Buffer.byteLength(JSON.stringify(e));
      if (stueck.length >= MAX_EREIGNISSE || (stueck.length > 0 && bytes + groesse > MAX_BYTES)) break;
      stueck.push(e);
      bytes += groesse;
    }
    return stueck;
  }

  async flush() {
    if (this.flushLaeuft || this.buffer.length === 0) return;
    this.flushLaeuft = true;
    try {
      const stueck = this.#stueck();
      if (stueck.length === 0) return;
      // Sequenzstand zuerst sichern: nach einem Neustart darf keine Sitzung rückwärts laufen.
      await this.harness.commit(async (tx) => {
        const lz = await tx.doc(Laufzeit);
        // Feld heißt `sitzung` (Eingabeformat des Hubs); mit dem alten `e.s` landete alles unter „undefined“ und die
        // Sequenzen liefen nach einem Neustart je Sitzung wieder bei 1 los (Vertragstest vertrag-hub.test.js).
        for (const e of stueck) lz.sequenzen[e.sitzung] = Math.max(lz.sequenzen[e.sitzung] ?? 0, e.q);
      }, CTX);
      await this.hub.melden(stueck);
      this.buffer.splice(0, stueck.length);
      this.gemeldet += stueck.length;
      this.letzterFehler = null;
      this.letzterErfolg = this.jetzt();
      this.fehlerInFolge = 0;
      this.abgelehntInFolge = 0;
    } catch (fehler) {
      this.letzterFehler = fehler;
      this.fehlerZahl += 1;
      this.fehlerInFolge += 1;
      // 4xx (außer Zeitüberschreitung und Drosselung) heißt: der Hub hat das Ereignis gelesen und abgelehnt, also Vertragsbruch.
      const status = Number(fehler?.status ?? 0);
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        this.abgelehnt += 1;
        this.abgelehntInFolge += 1;
      } else {
        this.abgelehntInFolge = 0;
      }
      this.letzterFehlerInfo = { zeit: this.jetzt(), text: KUERZ(fehler?.message ?? fehler, 200), status: status || null };
      this.onFehler(fehler);
    } finally {
      this.flushLaeuft = false;
    }
  }

  async stop() {
    this.aktiv = false;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    if (this.erinnerung) clearInterval(this.erinnerung);
    this.erinnerung = null;
    await this.flush().catch(() => {});
    await this.regWatch?.stop?.().catch(() => {});
    this.regWatch = null;
    await this.laufWatch?.stop?.().catch(() => {});
    this.laufWatch = null;
    for (const [id, s] of this.streams) {
      await s.stop?.().catch(() => {});
      this.streams.delete(id);
    }
  }
}
