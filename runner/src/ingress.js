/**
 * ingress.js — was von außen hereinkommt.
 *
 * Der Runner liest den Eingang des Hubs (`fyos:agent:eingang`) per Long-Poll. Jeder Eingang wird
 * zuerst dauerhaft in `Wartend` angenommen (zusammen mit dem neuen Zeiger, ein Commit), dann vom
 * Ausgeber an das Gespräch gegeben. So hält der Spielmodus Aufträge nur zurück, statt sie zu
 * verlieren, und Besitzer' Nachrichten (Klasse `max`) kommen vor Hintergrundarbeit dran.
 *
 * Regeln wie im RPC-Runner:
 *  - Spielmodus an → nichts geht an den Agenten (auch nicht Besitzer).
 *  - Hintergrund-Tor zu → nur Klasse `max` geht durch.
 *  - Die Strom-ID ist die `requestId`; ein Neustart erzeugt keine doppelte Ausführung.
 */
import { KONTEXT, gespraechOeffnen, zugStarten } from './lauf/index.js';
import { Laufzeit, Register, Wartend } from './documents.js';
import { darfFreigabeEntscheiden } from './stimme.js';

const CTX = KONTEXT;
const WARTEND_MAX = 500;

/** Der Text, den das Modell für einen Eingang bekommt (Kopf, Text, Weltblock). Auch der Schatten-Rekorder fragt damit dasselbe. */
export function eingabeInhalt(e, zusatz) {
  const kopf = [
    `Eingang von ${e.quelle}${e.von !== e.quelle ? ` (${e.von})` : ''}${e.bezug ? ` · Bezug ${e.bezug}` : ''}.`,
    e.klasse === 'max'
      ? 'Das ist eine Nachricht mit Vorfahrt; sie darf eine laufende Arbeit steuern.'
      : 'Hintergrundnachricht.',
  ].join(' ');
  return `${kopf}\n\n${e.text}${zusatz ? `\n\n${zusatz}` : ''}`;
}

export class Ingress {
  constructor({ cfg, runner, hub, spielmodus, tor, onFehler, ruhe, jetzt } = {}) {
    this.cfg = cfg;
    /** Ruhe-Schalter (`ruhe.js`); ohne Angabe die des Runners. Standard lässt Besitzer durch, `tief` hält alles an. */
    this.ruhe = ruhe === undefined ? (runner?.ruhe ?? null) : ruhe;
    this.jetzt = jetzt ?? (() => Date.now());
    this.runner = runner;
    this.harness = runner.harness;
    this.hub = hub;
    this.spielmodus = spielmodus ?? null;
    this.tor = tor ?? null;
    this.onFehler = onFehler ?? ((e) => console.error(`[fyos-ingress] ${e.message}`));
    this.aktiv = false;
    this.cursor = '$';
    this._schlaefer = new Set();
    this._angestossen = false;
    this._gemeldetSpiel = false;
    /** Pause der Verwaltung (steht im Laufzeit-Dokument, überlebt den Neustart) und Halt vor einem geplanten Neustart (nur im Speicher). */
    this.pausiert = false;
    this.pausiertSeit = null;
    this.pausiertVon = null;
    this.haltNeustart = false;
    /** Haken für Bausteine (alle optional):
     *  promptZusatz(eintrag) → Text, der vor den Eingang gestellt wird (Weltblock).
     *  vorAusgabe(eintrag) → 'weiter' | 'verwerfen' | 'halten' (Reflexe; 'halten' lässt ihn warten). */
    this.promptZusatz = null;
    this.vorAusgabe = null;
    /** beiZug(eintrag, zusatz) läuft unmittelbar vor der Übergabe an den Agenten. */
    this.beiZug = null;
    /** Zusätzliches Tor für kleine lesende Aufträge: (eintrag) → true, wenn er auch bei geschlossenem Tor laufen darf. */
    this.kleinesTor = null;
    // Gesundheit (src/gesundheit.js): wann hat der Leser zuletzt eine Antwort des Hubs bekommen, und wie oft scheiterte er.
    this.letztesLesen = null;
    this.gestartet = null;
    this.lesefehler = 0;
    this.lesefehlerInFolge = 0;
    this.letzterLesefehler = null;
  }

  /** Zähler für `/zustand` → `gesundheit`; `aktiv` heißt: der Leser läuft (nicht im Schatten). */
  gesundheit() {
    const jetzt = this.jetzt();
    return {
      aktiv: this.aktiv,
      poll_s: this.cfg.pi_durable.proactive?.pollSeconds ?? 20,
      letztes_lesen: this.letztesLesen,
      // Vor dem ersten erfolgreichen Lesen zählt der Start: ein Leser, der nie ankommt, ist auch ein stehender Leser.
      vor_s: (this.letztesLesen ?? this.gestartet) === null ? null : Math.max(0, Math.round((jetzt - (this.letztesLesen ?? this.gestartet)) / 1000)),
      fehler: this.lesefehler,
      fehler_in_folge: this.lesefehlerInFolge,
      letzter_fehler: this.letzterLesefehler,
    };
  }

  /** Die Pause aus dem Dokument holen (auch im Schatten, damit die Verwaltung sie zeigen kann). */
  async pauseLaden() {
    try {
      const lz = await this.harness.snapshot(Laufzeit, CTX);
      this.pausiert = Boolean(lz?.eingangPausiert);
      this.pausiertSeit = this.pausiert ? (lz?.eingangPausiertSeit ?? null) : null;
      this.pausiertVon = this.pausiert ? (lz?.eingangPausiertVon ?? null) : null;
    } catch {
      /* ohne Dokument gilt: nicht pausiert */
    }
  }

  /** Läuft der Eingang nach der Konfiguration (`proactive.enabled`)? Unabhängig von der Pause. */
  get konfiguriert() {
    return Boolean(this.cfg.pi_durable.proactive?.enabled);
  }

  /** Hält gerade irgendetwas den Eingang an (Pause der Verwaltung oder geplanter Neustart)? */
  get haelt() {
    return this.pausiert || this.haltNeustart;
  }

  /**
   * Eingang pausieren oder fortsetzen, ohne den Dienst zu stoppen. Die Pause steht im Dokument: nach einem Neustart
   * bleibt sie, bis jemand fortsetzt. Pausiert wird nicht mehr gelesen und nichts mehr an den Agenten gegeben (auch
   * Besitzer' Nachrichten nicht, wie im Spielmodus); was schon angenommen ist, bleibt in `Wartend`. Freigaben entscheidet
   * die Verwaltung weiter direkt, sie laufen nicht über diese Strecke.
   */
  async pausieren(pausiert, von = 'verwaltung') {
    const an = Boolean(pausiert);
    if (an === this.pausiert) return { pausiert: an, seit: this.pausiertSeit, von: this.pausiertVon, geaendert: false };
    const jetzt = Date.now();
    await this.harness.commit(async (tx) => {
      const lz = await tx.doc(Laufzeit);
      lz.eingangPausiert = an;
      lz.eingangPausiertSeit = an ? jetzt : null;
      lz.eingangPausiertVon = an ? String(von).slice(0, 64) : null;
    }, CTX);
    this.pausiert = an;
    this.pausiertSeit = an ? jetzt : null;
    this.pausiertVon = an ? String(von).slice(0, 64) : null;
    console.log(`[fyos-ingress] Eingang ${an ? 'pausiert' : 'fortgesetzt'} (${von})`);
    if (!an) this.anstossen();
    return { pausiert: an, seit: this.pausiertSeit, von: this.pausiertVon, geaendert: true };
  }

  /** Vor einem Neustart: nichts Neues mehr an den Agenten geben (nur im Speicher; ein Neustart hebt es auf). */
  anhalten(an) {
    this.haltNeustart = Boolean(an);
    if (!an) this.anstossen();
  }

  async start() {
    if (this.aktiv) return;
    await this.pauseLaden();
    if (!this.cfg.pi_durable.proactive?.enabled) return;
    this.aktiv = true;
    this.gestartet = this.jetzt();
    const lz = await this.harness.snapshot(Laufzeit, CTX);
    this.cursor = lz?.letzteEingang || '$';
    void this.#leser();
    void this.#ausgeber();
  }

  /** Das Tor ist aufgegangen oder der Spielmodus vorbei: sofort noch einmal ausgeben. */
  anstossen() {
    this._angestossen = true;
    for (const schlaf of [...this._schlaefer]) if (schlaf.weckbar) schlaf.ende();
  }

  /**
   * Ein Ereignis aus einem Baustein (Takt, Wache, Hintergrundjob) dauerhaft einreihen. Es läuft
   * danach durch dieselben Regeln wie ein Hub-Eingang: Spielmodus, Tor, Besitzer zuerst. Die `id` ist
   * die Strom-ID und macht das Einreihen idempotent (z. B. `takt:morgen:2026-10-25`).
   * Gibt `true` zurück, wenn neu eingereiht wurde, `false` bei einer bekannten ID.
   */
  async einreihen({ id, text, quelle = 'baustein', von, bezug = null, klasse = 'hintergrund', arbeitsbereich = null, schwere = null }) {
    const stromId = String(id ?? '').trim();
    const inhalt = String(text ?? '').trim();
    if (!stromId || !inhalt) throw new Error('einreihen: id und text sind Pflicht');
    let neu = false;
    await this.harness.commit(async (tx) => {
      const wartend = await tx.doc(Wartend);
      if (wartend.eintraege.some((x) => x.stromId === stromId)) return;
      wartend.eintraege.push({
        stromId,
        text: inhalt,
        quelle: String(quelle).slice(0, 64),
        von: String(von ?? quelle).slice(0, 64),
        bezug,
        klasse: klasse === 'max' ? 'max' : 'hintergrund',
        arbeitsbereich,
        schwere,
        angenommen: Date.now(),
      });
      neu = true;
    }, CTX);
    if (neu) this.anstossen();
    return neu;
  }

  // --- Lesen: Hub → Wartend --------------------------------------------------------------

  async #leser() {
    while (this.aktiv) {
      if (this.haelt) {
        // Pausiert: nicht lesen, der Zeiger bleibt stehen, die Ereignisse warten im Hub-Strom.
        await new Promise((fertig) => setTimeout(fertig, 500));
        continue;
      }
      try {
        const antwort = await this.hub.eingangLesen(this.cursor, {
          warteS: this.cfg.pi_durable.proactive.pollSeconds ?? 20,
          anzahl: this.cfg.pi_durable.proactive.batch ?? 20,
          agent: this.cfg.agent,
        });
        if (!this.aktiv) break;
        this.letztesLesen = this.jetzt();
        this.lesefehlerInFolge = 0;
        const eintraege = Array.isArray(antwort?.eintraege) ? antwort.eintraege : [];
        const neuerCursor = antwort?.letzte || this.cursor;
        if (eintraege.length || neuerCursor !== this.cursor) {
          await this.#annehmen(eintraege, neuerCursor);
          if (eintraege.length) this.anstossen();
        }
      } catch (fehler) {
        if (!this.aktiv) break;
        this.lesefehler += 1;
        this.lesefehlerInFolge += 1;
        this.letzterLesefehler = { zeit: this.jetzt(), text: String(fehler?.message ?? fehler).slice(0, 200) };
        this.onFehler(fehler);
        await this.#zeigerFehler(String(fehler?.message ?? fehler)).catch(() => {});
        await this.#warten(Math.max(1, this.cfg.eingang?.fehler_pause_s ?? 10) * 1000, false);
      }
    }
  }

  async #annehmen(eintraege, neuerCursor) {
    const zeilen = [];
    for (const e of eintraege) {
      const stromId = String(e.id ?? '').trim();
      const text = String(e.text ?? '').trim();
      if (!stromId || !text) continue;
      zeilen.push({
        stromId,
        text,
        quelle: String(e.quelle ?? 'hub').slice(0, 64),
        von: String(e.von ?? e.quelle ?? 'hub').slice(0, 64),
        bezug: e.bezug ?? null,
        klasse: e.klasse === 'max' ? 'max' : 'hintergrund',
        arbeitsbereich: e.arbeitsbereich ?? null,
        // Die Reflexe (z. B. alarm-hoch) lesen die Schwere des Ereignisses.
        schwere: e.schwere ?? null,
        angenommen: Date.now(),
      });
    }
    await this.harness.commit(async (tx) => {
      const wartend = await tx.doc(Wartend);
      const bekannt = new Set(wartend.eintraege.map((x) => x.stromId));
      for (const z of zeilen) if (!bekannt.has(z.stromId)) wartend.eintraege.push(z);
      if (wartend.eintraege.length > WARTEND_MAX) {
        // Älteste Hintergrundeinträge zuerst fallen lassen; Besitzer' Nachrichten bleiben.
        const max = wartend.eintraege.filter((x) => x.klasse === 'max');
        const rest = wartend.eintraege.filter((x) => x.klasse !== 'max').slice(-Math.max(0, WARTEND_MAX - max.length));
        wartend.eintraege = [...max, ...rest].sort((a, b) => a.angenommen - b.angenommen);
      }
      const lz = await tx.doc(Laufzeit);
      lz.letzteEingang = neuerCursor;
      lz.eingangGesehen = Number(lz.eingangGesehen ?? 0) + zeilen.length;
      lz.eingangFehler = null;
    }, CTX);
    this.cursor = neuerCursor;
  }

  async #zeigerFehler(fehler) {
    await this.harness.commit(async (tx) => {
      const lz = await tx.doc(Laufzeit);
      lz.eingangFehler = fehler;
    }, CTX);
  }

  // --- Ausgeben: Wartend → Gespräch ----------------------------------------------------

  /** Was darf jetzt als Nächstes hinaus? Besitzer zuerst, Hintergrund nur bei offenem Tor. */
  naechster(wartend) {
    const liste = wartend?.eintraege ?? [];
    // Den Spielmodus sieht der Eingang so, wie ihn `this.spielmodus` meldet (mit Ersatzdenker geht die Arbeit weiter).
    const spiel = this.spielmodus ? Boolean(this.spielmodus.grund?.()) : undefined;
    const modus = this.ruhe?.eingang?.({ spiel }) ?? 'frei';
    // Tiefe Ruhe: nichts geht an den Agenten; nur Freigabe-Entscheidungen (sie gehen nie an ihn) kommen durch.
    if (modus === 'gesperrt') return liste.find((x) => Ingress.istFreigabeEntscheidung(x)) ?? null;
    const max = liste.find((x) => x.klasse === 'max');
    if (max) return max;
    // Ruhe (Standard): Besitzer' Nachrichten laufen weiter, alles Eigenständige bleibt in der Warteschlange.
    if (modus === 'nurMax') return null;
    if (this.tor && !this.tor.offen) {
      // Zweites Tor (Entscheidungsbuch 512): kleine, lesende Aufträge dürfen trotzdem.
      return liste.find((x) => x.klasse !== 'max' && this.kleinesTor?.(x)) ?? null;
    }
    return liste.find((x) => x.klasse !== 'max') ?? null;
  }

  async #ausgeber() {
    while (this.aktiv) {
      try {
        const spiel = this.spielmodus?.grund?.() ?? null;
        const grund = spiel ? `Spielmodus (${spiel})` : this.haelt ? (this.haltNeustart ? 'Neustart geplant' : 'Eingang pausiert') : null;
        if (grund) {
          if (!this._gemeldetSpiel) {
            this._gemeldetSpiel = true;
            console.log(`[fyos-ingress] ${grund}: Eingänge warten`);
          }
          // Auch im Spielmodus werden Freigabe-Entscheidungen der App angenommen: sie gehen nicht an den Agenten.
          const wartend = await this.harness.snapshot(Wartend, CTX);
          const freigabe = (wartend?.eintraege ?? []).find((x) => Ingress.istFreigabeEntscheidung(x));
          if (freigabe) {
            await this.#ausgeben(freigabe);
            continue;
          }
        } else {
          this._gemeldetSpiel = false;
          const wartend = await this.harness.snapshot(Wartend, CTX);
          const naechster = this.naechster(wartend);
          if (naechster) {
            await this.#ausgeben(naechster);
            continue; // gleich den nächsten prüfen
          }
        }
      } catch (fehler) {
        if (fehler?.code === 'KEIN_PROVIDER') {
          // Kein Modell erreichbar (z. B. Spielmodus ohne laufenden Ersatzdenker): einmal je Wortlaut melden, dann die
          // Sperrfrist abwarten statt alle 5 Sekunden neu zu versuchen. Die Einträge bleiben in `Wartend`.
          if (this._letzterKetteFehler !== fehler.message) {
            this._letzterKetteFehler = fehler.message;
            this.onFehler(fehler);
            await this.#zeigerFehler(fehler.message).catch(() => {});
          }
          await this.#warten(Math.max(5, this.cfg.pi_durable.provider_sperre_s ?? 60) * 1000, true);
          continue;
        }
        this.onFehler(fehler);
        await this.#warten(5000, false);
        continue;
      }
      this._letzterKetteFehler = null;
      await this.#warten(2000, true);
    }
  }

  /**
   * Eine Freigabe-Entscheidung aus der App (Handy): kommt als Eingang `web`, Klasse `max`, von `app-freigabe`, der Text
   * ist JSON `{id, entscheidung: 'erteilt'|'abgelehnt', notiz?}`. Nur diese feste Kombination entscheidet; derselbe Text aus
   * einer anderen Quelle ist eine gewöhnliche Nachricht und entscheidet nichts. Es geht nicht an den Agenten.
   */
  static istFreigabeEntscheidung(e) {
    // Ein Sprachsatz (Bezug `stimme`, von ha-assist) hat Klasse max, entscheidet aber nie, auch nicht mit behauptetem Absender.
    return darfFreigabeEntscheiden(e);
  }

  async #freigabeEntscheiden(e) {
    try {
      const d = JSON.parse(e.text);
      await this.runner.entscheideFreigabe(String(d.id ?? ''), {
        entscheidung: d.entscheidung,
        notiz: d.notiz,
        von: 'app',
      });
    } catch (fehler) {
      // Schon entschieden, unbekannt oder kaputter Text: nicht erneut versuchen, sondern melden und weiter.
      this.onFehler(new Error(`Freigabe-Entscheidung aus der App nicht angewendet: ${fehler.message}`));
    }
    await this.harness.commit(async (tx) => {
      const wartend = await tx.doc(Wartend);
      wartend.eintraege = wartend.eintraege.filter((x) => x.stromId !== e.stromId);
    }, CTX);
  }

  async #ausgeben(e) {
    if (Ingress.istFreigabeEntscheidung(e)) return this.#freigabeEntscheiden(e);
    const urteil = (await this.vorAusgabe?.(e)) ?? 'weiter';
    if (urteil === 'halten') {
      await this.#warten(2000, true);
      return;
    }
    if (urteil === 'verwerfen') {
      await this.harness.commit(async (tx) => {
        const wartend = await tx.doc(Wartend);
        wartend.eintraege = wartend.eintraege.filter((x) => x.stromId !== e.stromId);
      }, CTX);
      return;
    }
    const zusatz = await this.promptZusatz?.(e);
    // Zugbeginn melden: Klasse und Bezug für Hintergrundjobs, ITSM-Bezug, Aufzeichnung. Ein Fehler hält den Zug nicht auf.
    try {
      await this.beiZug?.(e, zusatz);
    } catch (fehler) {
      this.onFehler(fehler);
    }
    const conversationId = await this.#ziel();
    if (!conversationId) throw new Error('Kein Zielgespräch für den Eingang; Hauptgespräch fehlt');
    const conv = await gespraechOeffnen(this.harness, conversationId);
    if (!conv) throw new Error(`Zielgespräch ${conversationId} fehlt`);

    // Bahnen: Besitzer' Klasse bekommt das Besitzer-Modell, Hintergrund das Standardmodell.
    // Ohne erreichbares Modell (KEIN_PROVIDER) bleibt der Eintrag liegen und der Ausgeber meldet es klar und wartet;
    // jeder andere Fehler der Bahnwahl hält den Zug wie bisher nicht auf.
    await this.runner.bahnEinstellen(conversationId, e.klasse).catch((f) => {
      if (f?.code === 'KEIN_PROVIDER') throw f;
      this.onFehler(f);
    });

    await zugStarten(conv, {
      // Wie im RPC-Runner steht der Weltblock hinter dem Text.
      text: eingabeInhalt(e, zusatz),
      wennBeschaeftigt: e.klasse === 'max' ? 'steuern' : 'folgen',
      anfrageId: `eingang:${e.stromId}`,
      eintrag: {
        art: 'fyos.eingang',
        daten: {
          quelle: e.quelle,
          von: e.von,
          bezug: e.bezug,
          klasse: e.klasse,
          arbeitsbereich: e.arbeitsbereich,
          stromId: e.stromId,
          text: e.text,
          // Zeiten für die Messung der Sprachsätze (stimme.js): eingereiht und dem Gespräch übergeben.
          angenommen: e.angenommen ?? null,
          ausgegeben: Date.now(),
        },
      },
    });
    // requestId macht die Aufnahme idempotent: stirbt der Prozess hier, wird beim Neustart
    // derselbe Eintrag erneut angeboten und nicht doppelt ausgeführt.
    await this.harness.commit(async (tx) => {
      const wartend = await tx.doc(Wartend);
      wartend.eintraege = wartend.eintraege.filter((x) => x.stromId !== e.stromId);
    }, CTX);
  }

  async #ziel() {
    const fest = this.cfg.pi_durable.proactive?.conversation;
    if (fest) return fest;
    if (this.runner.root) return this.runner.root.id;
    const reg = (await this.harness.snapshot(Register, CTX)) ?? { agents: [] };
    const root = (reg.agents ?? []).find((a) => a.art === 'root');
    return root?.id ?? (reg.agents ?? []).find((a) => !a.archiviert)?.id ?? null;
  }

  /**
   * Schläft `ms`; `weckbar` lässt `anstossen()` den Schlaf beenden. Leser und Ausgeber schlafen gleichzeitig: jeder Schlaf hat seinen
   * eigenen Wecker. (Mit einem gemeinsamen Feld löschte der Ausgeber den Timer des Lesers, und der Leser blieb nach dem ersten
   * Lesefehler des Hubs für immer stehen; gefunden von test/gesundheit.test.js, 25.10.2026.)
   */
  #warten(ms, weckbar) {
    return new Promise((fertig) => {
      if (weckbar && this._angestossen) {
        this._angestossen = false;
        fertig();
        return;
      }
      const schlaf = { timer: null, weckbar };
      const ende = () => {
        clearTimeout(schlaf.timer);
        this._schlaefer.delete(schlaf);
        fertig();
      };
      schlaf.ende = ende;
      schlaf.timer = setTimeout(ende, ms);
      schlaf.timer.unref?.();
      this._schlaefer.add(schlaf);
    });
  }

  async stop() {
    this.aktiv = false;
    for (const schlaf of [...this._schlaefer]) schlaf.ende();
  }
}
