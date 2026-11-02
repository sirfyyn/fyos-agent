/**
 * takt.js — der Zeitplan-Takt (SeCo-Rhythmus, Skill seco).
 *
 * Weckt den Agenten nach festen Zeiten, aber nur durch das Tor seiner Schleife (`schleifen.darf`).
 * Je Eintrag merkt das Dokument `WachenZustand`, welcher Sollzeitpunkt erledigt ist (ausgelöst oder
 * verfallen); ein Neustart löst deshalb nichts doppelt aus. Sagt das Tor nein, fragt der Takt
 * höchstens alle `fragen_alle_s` erneut, bis das Fenster des Eintrags vorbei ist; dann verfällt er still.
 *
 * Portiert aus `Taktgeber` im RPC-Runner (agent_runner.py). Konfiguration unverändert aus
 * agent-runner.json: `takt` (an, zone, pruefen_s, fragen_alle_s, eintraege) und `nachrichten`.
 * Rechnet wie Python in Wanduhr-Zeit der Zone (Sommerzeit ändert keine Sollzeiten).
 */
import {
  Kette,
  Schlaf,
  hubLesen,
  istObjekt,
  logger,
  wachenAendern,
  wachenLesen,
} from './wachen-zustand.js';

const MIN = 60_000;
const TAG = 24 * 60 * MIN;

/**
 * Was der Takt weckt. `um` = täglich (HH:MM), `stuendlich` = Minute jeder Stunde von `von` bis `bis`.
 * `fenster_min`: so lange nach dem Soll darf er noch nachgeholt werden (Tor zu, Neustart), sonst verfällt er.
 * Wortlaut wie im RPC-Runner — andere Teile des Systems erkennen die Bezüge (`takt-liegt-…`).
 */
export const TAKT_VORGABE = [
  {
    id: 'morgen',
    um: '07:30',
    fenster_min: 120,
    schleife: 'arbeit',
    art: 'melden',
    text:
      'Morgen-Takt (07:30): Morgenbriefing nach Skill seco. Lies, was liegt (denken.liegt), deine ' +
      'offenen Vorgänge und offene Freigaben, und lege 1–3 Tagesvorhaben fest (denken.plan). ' +
      "Kleines startet danach, Schweres erst nach Besitzer' Zustimmung; Schweigen ist kein Ja. " +
      'Der Morgenbericht der Nachtwerkstatt steht unter nachtbericht_lesen (nur Vorschläge).',
  },
  {
    id: 'abend',
    um: '19:00',
    fenster_min: 120,
    schleife: 'arbeit',
    art: 'melden',
    text:
      'Abend-Takt (19:00): Das Abendbriefing baut der Hub selbst (brief.abend). Sorge dafür, dass ' +
      'deine Vorgänge Stand, Ergebnis und offene Fragen tragen (auch deine Vorgangsnotizen: ' +
      'vorgangsnotizen.py pruefen, bei Statuswechsel den Notiztext abschließen), und leg den Nachtplan fest. ' +
      'Melde nur, wenn es etwas Neues gibt.',
  },
  {
    id: 'liegt',
    stuendlich: 15,
    von: 8,
    bis: 21,
    fenster_min: 30,
    schleife: 'arbeit',
    art: 'schreiben',
    // Ohne Modell vorab: nur wecken, wenn bei Persona etwas liegt (Bauprinzip §3a, Hausmodell sparen).
    vorpruefung: { werkzeug: 'denken.liegt', feld: 'rueckstand_persona' },
    text:
      'Stündliche Prüfung: Was liegt (denken.liegt) und welche deiner Vorgänge sind fällig? ' +
      'Erledige höchstens ein fälliges Kleines; ist nichts fällig, tu nichts und melde nichts. ' +
      'Schließe mit einem Satz.',
  },
  {
    id: 'nacht',
    um: '23:30',
    fenster_min: 300,
    schleife: 'gedaechtnis',
    art: 'schreiben',
    text:
      'Nachtfenster (22–7): Prüfe denken.darf und denken.nachtbudget. Liegen mehr als 5 ' +
      'Kleinigkeiten, arbeite sie ab; sonst Neugier und Reflexion als Notiz mit Quelle ' +
      '(denken.ablegen) und fehlende Vorgangsnotizen zu deinen offenen Vorgängen anlegen ' +
      '(vorgangsnotizen.py neu/pruefen). Keine Meldungen, höchstens das Nachtbudget. ' +
      'Die Nachtwerkstatt (Dreaming, Skillsmith, Nodesmith) startet um 23:35 von selbst; du musst sie nicht anstoßen.',
  },
  {
    // Kein Agentenzug: der Takt startet die Aufgabe im Runner. Reihenfolge Dreaming → Skillsmith → Nodesmith.
    id: 'nachtwerkstatt',
    um: '23:35',
    fenster_min: 300,
    schleife: 'gedaechtnis',
    art: 'schreiben',
    nachtwerkstatt: true,
    text: 'Nachtwerkstatt (23:35): Dreaming, Skillsmith, Nodesmith nacheinander, nur lesend, nur Vorschläge.',
  },
];

/** Takt-Eintrag des Nachrichtenpults: ruft `nachrichten.lauf` direkt (Werkzeug-Takt, ohne Agentenzug). */
export function nachrichtenEintrag(n = {}) {
  const alle = Math.max(15, Math.trunc(Number(n.alle_min ?? 15)) || 15); // kein Minutentakt: nie öfter als alle 15 min
  return {
    id: 'nachrichten',
    alle_min: alle,
    fenster_min: Math.max(5, alle - 5),
    schleife: String(n.schleife || 'arbeit'),
    art: String(n.art || 'schreiben'),
    werkzeug: 'nachrichten.lauf',
    argumente: { ...(n.argumente ?? {}) },
    frist_s: Number(n.frist_s ?? 600),
    text: 'Nachrichtenpult: ein Lauf der Vorfilter-Kette (Werkzeug-Takt, kein Pi-Zug).',
  };
}

const formate = new Map();

/**
 * Die Wanduhr einer Zone als "naive" Zeit: Millisekunden, als wäre die Ortszeit UTC. Rechnen und
 * Vergleichen auf diesen Werten ist Wanduhr-Arithmetik wie `datetime` mit fester `tzinfo`.
 */
export function wandZeit(ms, zone) {
  let f = formate.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formate.set(zone, f);
  }
  const t = {};
  for (const p of f.formatToParts(new Date(ms))) t[p.type] = Number(p.value);
  return Date.UTC(t.year, t.month - 1, t.day, t.hour % 24, t.minute, t.second, ms % 1000);
}

const z2 = (n) => String(n).padStart(2, '0');

/** `2026-10-24T07:30` aus einer Wanduhr-Zeit. */
export function minutenSchluessel(wand) {
  const d = new Date(wand);
  return `${tagSchluessel(wand)}T${z2(d.getUTCHours())}:${z2(d.getUTCMinutes())}`;
}

/** `2026-10-24` aus einer Wanduhr-Zeit. */
export function tagSchluessel(wand) {
  const d = new Date(wand);
  return `${d.getUTCFullYear()}-${z2(d.getUTCMonth() + 1)}-${z2(d.getUTCDate())}`;
}

const ganz = (w) => {
  const n = Math.trunc(Number(w));
  return Number.isFinite(n) ? n : NaN;
};

/** Der letzte Sollzeitpunkt des Eintrags bis `wand` (Wanduhr-Zeit), `null` wenn ungültig. */
export function taktSoll(eintrag, wand) {
  const jetzt = new Date(wand);
  const mitternacht = Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth(), jetzt.getUTCDate());
  if (eintrag.alle_min) {
    const alle = Math.max(1, ganz(eintrag.alle_min));
    if (!Number.isFinite(alle)) return null;
    const minuten = jetzt.getUTCHours() * 60 + jetzt.getUTCMinutes();
    return mitternacht + (minuten - (minuten % alle)) * MIN;
  }
  if (eintrag.um) {
    const [h, m] = String(eintrag.um).split(':', 2).map(ganz);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    let soll = mitternacht + h * 60 * MIN + m * MIN;
    if (soll > wand) soll -= TAG;
    return soll;
  }
  if (eintrag.stuendlich !== undefined && eintrag.stuendlich !== null) {
    const von = ganz(eintrag.von ?? 0);
    const bis = ganz(eintrag.bis ?? 23);
    const minute = ganz(eintrag.stuendlich);
    if (![von, bis, minute].every(Number.isFinite)) return null;
    let soll = Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth(), jetzt.getUTCDate(), jetzt.getUTCHours(), minute);
    if (soll > wand) soll -= 60 * MIN;
    for (let i = 0; i < 25; i += 1) {
      const stunde = new Date(soll).getUTCHours();
      if (von <= stunde && stunde <= bis) return soll;
      soll -= 60 * MIN;
    }
  }
  return null;
}

/** Das Eingangsereignis eines Takts (Quelle `zeitplan`); die Id ist je Takt und Sollminute eindeutig. */
export function taktEreignis(eintrag, soll) {
  return {
    id: `zeitplan:${eintrag.id}:${minutenSchluessel(soll)}`,
    text: String(eintrag.text),
    quelle: 'zeitplan',
    klasse: 'hintergrund',
    // Ein Bezug je Takt und Tag: die Fortsetzungen eines Tages liegen in derselben Arbeitssitzung.
    bezug: `takt-${eintrag.id}-${tagSchluessel(soll)}`,
  };
}

export class Taktgeber {
  constructor({ cfg = {}, hub, harness, einreihen, nachtwerkstatt, log, jetzt = () => Date.now(), imHintergrund = true, ruhe = null } = {}) {
    /** Der Ruhe-Schalter (`ruhe.js`): in der Ruhe oder im Spielmodus löst der Takt nichts aus. */
    this.ruhe = ruhe;
    const takt = istObjekt(cfg.takt) ? cfg.takt : {};
    // Wie im RPC-Runner: fehlt `takt`, ist er an; ein Objekt gilt mit `an` (Vorgabe true); alles andere ist aus.
    this.an = cfg.takt === undefined ? true : istObjekt(cfg.takt) && Boolean(takt.an ?? true);
    this.hub = hub;
    this.harness = harness;
    this.einreihen = einreihen;
    /** Startet die Nachtwerkstatt (Runner.nachtwerkstattStarten); fehlt sie, verfällt der Eintrag ohne Wirkung. */
    this.nachtwerkstatt = nachtwerkstatt;
    this.log = logger(log, 'fyos-takt');
    this.jetzt = jetzt;
    this.imHintergrund = imHintergrund;
    this.zone = String(takt.zone || 'Europe/Berlin');
    wandZeit(0, this.zone); // ungültige Zone: früh scheitern, nicht erst beim ersten Takt
    this.pruefenMs = Math.max(Number(takt.pruefen_s ?? 30), 0.01) * 1000;
    this.fragenAlleMs = Number(takt.fragen_alle_s ?? 120) * 1000;
    let eintraege = Array.isArray(takt.eintraege) ? takt.eintraege : null;
    if (istObjekt(cfg.nachrichten) && cfg.nachrichten.an) {
      eintraege = [...(eintraege ?? TAKT_VORGABE), nachrichtenEintrag(cfg.nachrichten)];
    }
    // Eigene `eintraege` ERSETZEN die Standardliste. Das hat am 26.10.2026 die Nachtwerkstatt (23:35) abgeschaltet, ohne dass es jemand
    // sah. Mit `takt.mit_standard: true` kommen die Standardeintraege dazu, deren Kennung die eigene Liste nicht traegt; ohne bleibt es beim
    // Ersetzen (wie bisher), aber das Fehlende steht im Log und in `zustand().fehlende_standard`.
    this.fehlendeStandard = [];
    if (eintraege && !eintraege.some((e) => e?.id === undefined)) {
      const vorhanden = new Set(eintraege.map((e) => e.id));
      const fehlt = TAKT_VORGABE.filter((e) => !vorhanden.has(e.id));
      if (takt.mit_standard === true) eintraege = [...eintraege, ...fehlt];
      else this.fehlendeStandard = fehlt.map((e) => e.id);
    }
    if (this.fehlendeStandard.length) {
      this.log.warn(`Takt: eigene Eintraege ersetzen die Standardliste, es fehlen ${this.fehlendeStandard.join(', ')} (takt.mit_standard: true holt sie dazu)`);
    }
    this.eintraege = (eintraege ?? TAKT_VORGABE).map((e) => ({ ...e }));
    /** Werkzeug-Takte: ruft das Hub-Werkzeug selbst, statt den Agenten zu wecken. */
    this.werkzeugLaeufe = {};
    this.stand = {};
    this._geladen = false;
    this._kette = new Kette();
    this._schlaf = new Schlaf();
    this._aktiv = false;
    this._lauf = null;
  }

  async #laden() {
    if (this._geladen) return;
    const d = await wachenLesen(this.harness);
    this.stand = Object.fromEntries(Object.entries(d.takt).filter(([, v]) => istObjekt(v)));
    this._geladen = true;
  }

  async #sichern(kennung) {
    const eintrag = JSON.parse(JSON.stringify(this.stand[kennung] ?? {}));
    await wachenAendern(this.harness, (d) => {
      d.takt[kennung] = eintrag;
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

  async #schleife() {
    for (;;) {
      await this._schlaf.warten(this.pruefenMs);
      if (!this._aktiv) return;
      try {
        await this.runde();
      } catch (fehler) {
        // Der Takt darf den Runner nie mitreißen.
        this.log.warn(`Runde gescheitert: ${fehler?.message ?? fehler}`);
      }
    }
  }

  /** Eine Prüfung aller Einträge; liefert die IDs der ausgelösten Ereignisse. */
  runde() {
    return this._kette.lauf(async () => {
      await this.#laden();
      const jetzt = this.jetzt();
      const wand = wandZeit(jetzt, this.zone);
      const ausgeloest = [];
      for (const eintrag of this.eintraege) {
        try {
          const soll = taktSoll(eintrag, wand);
          if (soll === null) continue;
          const schluessel = minutenSchluessel(soll);
          const kennung = String(eintrag.id);
          const st = (this.stand[kennung] ??= {});
          if (st.erledigt === schluessel) continue;
          if ((wand - soll) / 1000 > Number(eintrag.fenster_min ?? 60) * 60) {
            if (st.soll === schluessel || st.erledigt == null) {
              this.log.info(`Takt ${kennung} ${schluessel} verfallen (${st.warum || 'Fenster vorbei'})`);
            }
            Object.assign(st, { erledigt: schluessel, wie: 'verfallen' });
            await this.#sichern(kennung);
            continue;
          }
          if (st.soll === schluessel && jetzt - Number(st.gefragt ?? 0) < this.fragenAlleMs) continue;
          ausgeloest.push(...(await this.#versuchen(eintrag, soll, schluessel, st)));
        } catch (fehler) {
          // Ein Eintrag, der scheitert, hält die anderen nicht auf; er kommt nach `fragen_alle_s` wieder dran.
          this.log.warn(`Takt ${eintrag.id}: ${String(fehler?.message ?? fehler).slice(0, 200)}`);
        }
      }
      return ausgeloest;
    });
  }

  async #versuchen(eintrag, soll, schluessel, st) {
    const kennung = String(eintrag.id);
    Object.assign(st, { soll: schluessel, gefragt: this.jetzt() });
    // Ruhe (Besitzer' Schalter, Nachtruhe) und Spielmodus: wie ein geschlossenes Tor, aber ohne den Hub zu fragen.
    // Der Eintrag wartet und verfällt mit seinem Fenster, statt danach eine alte Weckung nachzuholen.
    const ruhe = this.ruhe?.zustand?.();
    if (ruhe?.pausiert) {
      st.warum = `Ruhe: ${ruhe.grund ?? ruhe.quelle}`.slice(0, 200);
      await this.#sichern(kennung);
      return [];
    }
    let darf;
    let warum;
    try {
      const tor = await hubLesen(this.hub, 'schleifen.darf', {
        schleife: String(eintrag.schleife || 'arbeit'),
        art: String(eintrag.art || 'schreiben'),
      });
      if (!istObjekt(tor)) throw new Error(`Hub meldet kein Objekt: ${String(tor).slice(0, 120)}`);
      darf = tor.darf === true;
      warum = String(tor.warum ?? '').slice(0, 200);
    } catch (fehler) {
      // Hub weg: Tor zu, später erneut.
      darf = false;
      warum = `nicht prüfbar: ${String(fehler?.message ?? fehler).slice(0, 160)}`;
    }
    st.warum = warum;
    if (!darf) {
      await this.#sichern(kennung);
      return [];
    }
    const vor = eintrag.vorpruefung;
    if (istObjekt(vor)) {
      let wert;
      try {
        const ergebnis = await hubLesen(this.hub, String(vor.werkzeug), { ...(vor.argumente ?? {}) });
        wert = istObjekt(ergebnis) ? ergebnis[String(vor.feld)] : null;
      } catch (fehler) {
        // Nicht lesbar: später erneut.
        st.warum = `Vorprüfung nicht lesbar: ${String(fehler?.message ?? fehler).slice(0, 150)}`;
        await this.#sichern(kennung);
        return [];
      }
      // Wie Python: leer, 0, null, false und [] gelten als „nichts zu tun“.
      if (!wert || (Array.isArray(wert) && wert.length === 0) || (istObjekt(wert) && !Object.keys(wert).length)) {
        Object.assign(st, { erledigt: schluessel, wie: 'nichts zu tun', warum: `${vor.feld}: ${JSON.stringify(wert ?? null)}` });
        await this.#sichern(kennung);
        return [];
      }
    }
    if (eintrag.nachtwerkstatt) return this.#nachtTakt(eintrag, schluessel, st);
    if (eintrag.werkzeug) return this.#werkzeugTakt(eintrag, schluessel, st);
    const e = taktEreignis(eintrag, soll);
    // Erst einreihen (idempotent über die Id), dann als erledigt vermerken: stirbt der Prozess
    // dazwischen, reiht der Neustart dieselbe Id noch einmal ein und nichts geht verloren.
    await this.einreihen(e);
    Object.assign(st, { erledigt: schluessel, wie: 'ausgelöst', t: this.jetzt() });
    await this.#sichern(kennung);
    this.log.info(`Takt ${kennung} ${schluessel} ausgelöst`);
    return [e.id];
  }

  /** Nachtwerkstatt-Takt: die Aufgabe im Runner starten (je Nacht genau eine, das prüft der Runner). */
  async #nachtTakt(eintrag, schluessel, st) {
    const kennung = String(eintrag.id);
    if (typeof this.nachtwerkstatt !== 'function') {
      Object.assign(st, { erledigt: schluessel, wie: 'nichts zu tun', warum: 'Nachtwerkstatt nicht verbunden' });
      await this.#sichern(kennung);
      return [];
    }
    const r = await this.nachtwerkstatt({ quelle: 'takt' });
    // Läuft oder lief die Nacht schon, ist der Takt trotzdem erledigt (Neustart nach dem Start startet nichts doppelt).
    Object.assign(st, { erledigt: schluessel, wie: r?.gestartet ? 'ausgelöst' : 'schon gelaufen', warum: r?.grund ?? null, t: this.jetzt() });
    await this.#sichern(kennung);
    this.log.info(`Takt ${kennung} ${schluessel}: ${r?.gestartet ? 'Nachtwerkstatt gestartet' : r?.grund}`);
    return r?.gestartet ? [`nachtwerkstatt:${r.nacht}`] : [];
  }

  /** Werkzeug-Takt: das Hub-Werkzeug läuft im Hintergrund (die Kette dauert Minuten); ein Lauf zur Zeit. */
  async #werkzeugTakt(eintrag, schluessel, st) {
    const kennung = String(eintrag.id);
    const lauf = (this.werkzeugLaeufe[kennung] ??= {});
    if (lauf.laeuft) {
      Object.assign(st, { erledigt: schluessel, wie: 'übersprungen', warum: 'voriger Lauf noch nicht fertig' });
      await this.#sichern(kennung);
      return [];
    }
    Object.assign(st, { erledigt: schluessel, wie: 'ausgelöst', t: this.jetzt() });
    await this.#sichern(kennung);
    Object.assign(lauf, { laeuft: true, start: this.jetzt(), soll: schluessel });

    const ausfuehren = async () => {
      try {
        const frist = Number(eintrag.frist_s ?? 600);
        const ergebnis = await hubLesen(this.hub, String(eintrag.werkzeug), { ...(eintrag.argumente ?? {}) }, {
          timeoutMs: frist * 1000,
        });
        const satz = istObjekt(ergebnis) ? ergebnis.satz : String(ergebnis).slice(0, 200);
        Object.assign(lauf, { ok: true, satz: String(satz || '').slice(0, 300), fehler: null });
        this.log.info(`Takt ${kennung} ${schluessel}: ${String(satz || '').slice(0, 200)}`);
      } catch (fehler) {
        // Ein gescheiterter Lauf wartet auf den nächsten Takt.
        Object.assign(lauf, { ok: false, fehler: String(fehler?.message ?? fehler).slice(0, 300) });
        this.log.warn(`Takt ${kennung} ${schluessel} gescheitert: ${String(fehler?.message ?? fehler).slice(0, 200)}`);
      } finally {
        Object.assign(lauf, { laeuft: false, ende: this.jetzt() });
      }
    };
    if (this.imHintergrund) void ausfuehren();
    else await ausfuehren();
    return [`werkzeug:${kennung}:${schluessel}`];
  }

  /** Einen Takt jetzt auslösen (Steuerkanal `POST /takt`), weiterhin nur durch das Tor. */
  ausloesen(kennung) {
    const eintrag = this.eintraege.find((e) => e.id === kennung);
    if (!eintrag) return Promise.resolve({ ok: false, error: `kein Takt ${JSON.stringify(kennung)}` });
    return this._kette.lauf(async () => {
      await this.#laden();
      const wand = wandZeit(this.jetzt(), this.zone);
      const soll = wand - (wand % MIN);
      const st = (this.stand[kennung] ??= {});
      const ids = await this.#versuchen(eintrag, soll, minutenSchluessel(soll), st);
      return { ok: ids.length > 0, ausgeloest: ids, warum: st.warum };
    });
  }

  /**
   * Der nächste Sollzeitpunkt (Epoche in ms) eines Agententakts nach `ab`, höchstens 26 Stunden voraus;
   * Werkzeug-Takte (Nachrichtenpult, alle 15 min) zählen nicht. Die Arbeitsschleife pausiert bis dahin.
   */
  naechsterSoll(ab = this.jetzt()) {
    const start = Math.floor(ab / MIN) * MIN + MIN;
    const agentenTakte = this.eintraege.filter((e) => !e.werkzeug);
    for (let t = start; t < start + 26 * 60 * MIN; t += MIN) {
      const wand = wandZeit(t, this.zone);
      if (agentenTakte.some((e) => taktSoll(e, wand) === wand)) return t;
    }
    return null;
  }

  /** Kleines Objekt für /zustand. */
  zustand() {
    return {
      ...(this.fehlendeStandard.length ? { fehlende_standard: [...this.fehlendeStandard] } : {}),
      eintraege: this.eintraege.map((e) => ({
        id: e.id,
        wann: e.um || (e.alle_min ? `alle ${Math.trunc(e.alle_min)} min` : `stündlich :${z2(Math.trunc(e.stuendlich))}`),
        schleife: e.schleife,
        ...Object.fromEntries(Object.entries(this.stand[e.id] ?? {}).filter(([k]) => ['erledigt', 'wie', 'warum'].includes(k))),
        ...(e.werkzeug ? { werkzeug: e.werkzeug, lauf: { ...(this.werkzeugLaeufe[e.id] ?? {}) } } : {}),
      })),
    };
  }
}
