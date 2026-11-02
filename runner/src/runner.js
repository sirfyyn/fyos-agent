/**
 * runner.js — der dauerhafte FYOS-Agent.
 *
 * Ein Runner besitzt genau eine SQLite-Datei und ein Harness. Alles, was ein Client sieht —
 * Gespräche, laufende Antworten, Werkzeuge, Freigaben, Aufgaben, geteilter Zustand — kommt aus
 * dieser Datei. Der Client hält keinen zweiten Zustand; er verbindet sich und liest.
 *
 * Mehrere Clients dürfen gleichzeitig auf dasselbe Gespräch schauen. Ein Mensch kann folgen
 * (follow-up), steuern (steer) oder abbrechen. Ein Absturz des Prozesses ist kein Neuanfang:
 * beim nächsten Öffnen setzt das Harness die offenen Aufgaben am letzten Checkpoint fort.
 */
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import {
  AGENT,
  KONTEXT,
  NUTZUNG as UsageDoc,
  abbrechen as zugAbbrechen,
  abzweigen,
  agentVon,
  ansichtVon,
  aufgabeAbwarten,
  aktivesFenster,
  ereignisse,
  fortsetzen,
  gespraechAnlegen,
  gespraechOeffnen,
  leeren as kontextLeeren,
  letzterEintragId,
  oeffneLauf,
  schliessen,
  umstellen,
  verdichten as verlaufVerdichten,
  verlaufVon,
  zugStarten,
} from './lauf/index.js';
import { kontextAnzeigen } from './freigabe-kontext.js';
import { AgentMeta, Freigaben, HubAufgaben, LaufListe, Laufzeit, NachtDoc, Register, Zustand, neueFreigabe } from './documents.js';
import { SCHMIEDEN, nachtDatum, offeneVorschlaege, ruhefenster } from './nachtwerkstatt.js';
import { resolve } from 'node:path';
import { Hub } from './hub.js';
import { fensterFuerModell, modellListe, modellRef, rheaModelle } from './models.js';
import { kontextAusEintraegen, kontextNachEintrag, nutzungMitKontext } from './kontext-anzeige.js';
import { SUCHE_GRENZEN, SucheFehler, archivModus, archivPasst, sitzungenDurchsuchen } from './suche.js';
import { baueRegistry } from './registry.js';
import { oeffneSpeicher } from './storage.js';
import { Knoten } from './knoten.js';
import { Browser } from './browser.js';
import { Desktop } from './desktop.js';
import { oeffneWirkenStrom } from './wirken.js';
import { Spielmodus } from './spielmodus.js';
import { Zugkontext } from './stimme.js';
import {
  KEIN_PROVIDER,
  ProviderKette,
  blockierendAb,
  providerFuerModell,
  schaetzeTokens,
  verdichtungsUeberschreibungen,
} from './provider-kette.js';
import { Gedaechtnis } from './persona/gedaechtnis.js';
import { Befehle } from './befehle.js';
import { Ruhe } from './ruhe.js';
import { ordnerNochGueltig, ordnerPruefen } from './ordner.js';
import { planZuege, pruefeEingabe as pruefeHarness2Eingabe } from './harness2.js';

const CTX = KONTEXT;
const jetzt = () => Date.now();
/** Wie lange eine Verdichtung vor dem Wechsel auf einen kleineren Provider höchstens dauern darf. */
const VERDICHTEN_MAX_MS = 480_000;

const TEXT = (wert, grenze) => String(wert ?? '').slice(0, grenze);

/** Der Ordner der Sitzung, falls gemerkt UND noch erlaubt (sonst gilt der Arbeitsbereich). */
function ordnerVon(cfg, meta) {
  return ordnerNochGueltig(cfg.pi_durable.ordnerErlaubt ?? [], meta?.ordner);
}

function agentFuer(cfg, meta) {
  const raum = cfg.arbeitsbereiche[meta?.arbeitsbereich] ?? cfg.arbeitsbereiche.standard;
  const ordner = ordnerVon(cfg, meta);
  const modelId = meta?.modell || cfg.pi_durable.model.default;
  return {
    model: {
      // Ein bewusst gewähltes Modell (z. B. `ersatzdenker`) gehört seinem Provider; sonst Hausmodell wie bisher.
      provider: meta?.modell ? providerFuerModell(cfg, modelId) : cfg.pi_durable.model.provider,
      modelId,
    },
    cwd: ordner ?? raum?.pfad,
    instructions: [
      `Dieses Gespräch heißt „${meta?.titel || 'Neuer Agent'}“.`,
      `Arbeitsbereich: ${raum?.titel || 'Standard'} (${raum?.pfad || process.cwd()}).`,
      ...(ordner ? [`Arbeitsordner dieser Sitzung: ${ordner}. Dateiarbeit beginnt dort.`] : []),
      'Der Mensch sieht deine Antwort live. Arbeite im Auftrag, nicht an ihm vorbei.',
    ].join('\n'),
  };
}

function registerEintrag(meta) {
  return {
    id: meta.id,
    titel: meta.titel,
    erstellt: meta.erstellt,
    arbeitsbereich: meta.arbeitsbereich,
    ordner: meta.ordner ?? null,
    modell: meta.modell,
    art: meta.art ?? 'mensch',
    parent: meta.parent ?? null,
    archiviert: !!meta.archiviert,
  };
}

export class Runner {
  constructor(cfg, { models, storage, hub, speicherDatei, kette, basis, knoten, nachtJetzt } = {}) {
    this.cfg = cfg;
    this.pd = cfg.pi_durable;
    // Spielmodus und Pause: eine Quelle für Eingang, Weltmodell, Jobs und Steuerkanal.
    this.spielmodus = new Spielmodus(cfg.spielmodus);
    // Modellkette (Hausmodell, dann Ersatzdenker); ohne `provider_kette` mit einem Eintrag ist sie nicht aktiv.
    this.kette = kette ?? new ProviderKette(cfg, { spielmodus: this.spielmodus });
    this.models = models ?? rheaModelle(cfg, { kette: this.kette, ...(basis ? { basis } : {}) });
    this.storage = storage;
    this.speicherDatei = speicherDatei ?? this.pd.storage;
    this.hub = hub ?? new Hub({ url: cfg.hub, agent: cfg.agent, agentToken: cfg.hub_agent_token });
    this.knoten = knoten ?? new Knoten(cfg);
    this.nachtJetzt = nachtJetzt ?? (() => Date.now());
    this.browser = new Browser(cfg);
    this.desktop = new Desktop(cfg);
    // Wer gerade am Zug ist (Sprachsatz oder nicht): der Ausgang pflegt es, Werkzeuge lesen es (stimme.js).
    this.zugKontext = new Zugkontext();
    // Was Eingang und Reflexe als „Spielmodus“ sehen: die Marke hält nur Hausmodell an. Läuft der Ersatzdenker, gehen Aufträge
    // weiter (er bearbeitet sie); sonst ist es dasselbe Objekt wie `spielmodus`. Weltbild, Jobs und Steuerkanal sehen die Marke selbst.
    this.spielmodusEinlass = this.kette.aktiv
      ? {
          an: () => this.spielmodus.an() && !this.kette.ersatzBereit(),
          grund: () => (this.kette.ersatzBereit() ? null : this.spielmodus.grund()),
        }
      : this.spielmodus;
    this.kette.beiAusfall((name) => this.#nachAusfall(name));
    // Ginnys Gedächtnis (S5): eine Instanz für Werkzeuge, Zugkopf, Tagesprotokoll und /zustand; aus, solange Besitzer es nicht einschaltet.
    this.gedaechtnis = new Gedaechtnis({ cfg });
    // Der Ruhe-Schalter (docs/current/RUNNER-RUHE.md): Datei laut Konfiguration, sonst neben der SQLite-Datei, ohne Pfad nur im Speicher.
    this.ruhe = new Ruhe({
      datei: cfg.ruhe?.datei ?? (isAbsolute(this.speicherDatei) ? join(dirname(this.speicherDatei), 'ruhe.json') : null),
      spielmodus: this.spielmodus,
      nachtruhe: cfg.ruhe?.nachtruhe,
      pruefenS: cfg.ruhe?.pruefen_s ?? 5,
    });
    /** Slash-Befehle (befehle.js); `bruecken` kann ein Baustein später füllen (z. B. ruhe). */
    this.befehle = new Befehle({ runner: this, cfg, bruecken: {} });
    this.harness = null;
    this.root = null;
    this.registry = null;
    this.Lauf = null;
    this.laufAnlegen = null;
    this.Harness2Pilot = null;
    this.harness2Anlegen = null;
    this.extension = null;
    this.geschlossen = false;
    this._berichte = [];
    this._watch = new Map();
    // Brücke zur Sprachsitzung: der Sprach-Agent (sprache-agent.js) ruft Schnellweg und Übergabe darüber; index.js bindet sie.
    this.spracheHaken = {};
    this.spracheErweiterung = null;
    this._spracheId = null;
    this._spracheLauf = null;
  }

  async start() {
    if (this.harness) return this;
    this.storage = this.storage ?? (await oeffneSpeicher(this.speicherDatei));
    const gebaut = baueRegistry(this.cfg, {
      hub: this.hub,
      browser: this.browser,
      desktop: this.desktop,
      // Jobs starten weder im Spielmodus noch in der Ruhe.
      spielmodus: this.ruhe.sperre,
      zugKontext: this.zugKontext,
      gedaechtnis: this.gedaechtnis,
      knoten: this.knoten,
      nachtJetzt: this.nachtJetzt,
      spracheHaken: this.spracheHaken,
      cwdFuer: async (id) => {
        const conv = this.harness ? await gespraechOeffnen(this.harness, id) : undefined;
        return conv ? (await agentVon(conv)).cwd : null;
      },
    });
    this.registry = gebaut.registry;
    this.Lauf = gebaut.Lauf;
    this.laufAnlegen = gebaut.laufAnlegen;
    this.Harness2Pilot = gebaut.Harness2Pilot;
    this.harness2Anlegen = gebaut.harness2Anlegen;
    this.Nachtwerkstatt = gebaut.Nachtwerkstatt;
    this.nachtAnlegen = gebaut.nachtAnlegen;
    this.extension = gebaut.extension;
    this.spracheErweiterung = gebaut.sprache;

    this.harness = await oeffneLauf(this.storage, {
      modelle: this.models,
      register: this.registry,
      umgebung: {
        standardCwd: this.cfg.arbeitsbereiche.standard?.pfad ?? process.cwd(),
        shell: this.pd.shellPath,
        env: this.pd.env,
      },
      // Mit Sprach-Agent wählt die Standardauswahl nur die beiden Haupt-Erweiterungen; die Sprach-Erweiterung wählt nur ihr Gespräch.
      standardErweiterungen: gebaut.standard || undefined,
      streamZeitlimitMs: 180_000,
      wiederholungen: 2,
      werkzeugAusfuehrung: 'parallel',
      // Hintergrund-Verdichtung ab contextWindow − reserve − background ≈ 120k (Besitzer 25.10.2026, Entscheidung 590):
      // über 60k fällt Katys Decode auf ≈ 54 tok/s, und ein Neuaufbau bei 190k kostet ≈ 5 min. Harte Grenze bleibt ≈ 238k.
      verdichtung: {
        an: true,
        reserve: 24_000,
        behalten: 32_000,
        hintergrund: 118_000,
        // Mit Kette: Grenzen je Provider aus dessen Fenster (Ersatzdenker 65536 → Hintergrund ab ≈ 30k, blockierend ab ≈ 59k).
        // Lokaler Modus: das Fenster des Nutzer-Modells ist meist viel kleiner als Rheas; die Grenzen folgen ihm.
        jeModell: this.kette.aktiv || this.pd.lokal === true ? verdichtungsUeberschreibungen(this.cfg) : undefined,
      },
      beiGespraechAngelegt: async (tx, record) => {
        // Kinder eines Laufs gehören nicht in die Seitenleiste; sie werden über den Lauf geöffnet.
        if (record.owner) return;
        const reg = await tx.doc(Register);
        if (!reg.agents.some((a) => a.id === record.id)) {
          const meta = await tx.doc(AgentMeta, record.id);
          meta.erstellt = meta.erstellt ?? jetzt();
          meta.titel = meta.titel === 'Neuer Agent' ? (record.parent ? 'Zweig' : 'Neuer Agent') : meta.titel;
          meta.art = record.parent ? 'zweig' : 'mensch';
          reg.agents.push(registerEintrag({ ...meta, id: record.id }));
          reg.aktualisiert = jetzt();
          reg.geraet = this.pd.device;
        }
      },
      beiBericht: (fehler, info) => {
        const eintrag = {
          zeit: jetzt(),
          art: info?.type ?? 'unbekannt',
          nachricht: String(fehler?.message ?? fehler ?? ''),
          task: info?.task?.id ?? null,
          gespraech: info?.task?.conversationId ?? info?.conversationId ?? null,
          extension: info?.extension ?? null,
        };
        this._berichte.push(eintrag);
        if (this._berichte.length > 100) this._berichte.shift();
        console.error(`[fyos-runner] ${eintrag.art}: ${eintrag.nachricht}`);
      },
    });

    await this.#sicherstellenDocs();
    this.root = await this.harness.root(CTX);
    await this.#registriereRoot();
    fortsetzen(this.harness);
    this.ruhe.start();

    // Arbeitsbereiche melden: nur Namen und Titel, nie Pfade.
    // Ohne Hub (lokaler Modus) gibt es nichts zu melden.
    if (this.hub.konfiguriert === false) return this;
    try {
      // `name` ist der Schlüssel (^[a-z0-9_-]{1,40}$, das prüft der Hub), nicht der Titel.
      const bereiche = Object.entries(this.cfg.arbeitsbereiche).map(([name, b]) => ({ name, titel: b.titel }));
      Promise.resolve(this.hub.bereicheMelden?.(bereiche, { agent: this.cfg.agent })).catch((fehler) =>
        console.error(`[fyos-runner] Arbeitsbereiche nicht gemeldet: ${fehler.message}`),
      );
    } catch (fehler) {
      console.error(`[fyos-runner] Arbeitsbereiche nicht gemeldet: ${fehler.message}`);
    }

    return this;
  }

  async #sicherstellenDocs() {
    await this.harness.commit(async (tx) => {
      const reg = await tx.doc(Register);
      reg.geraet = this.pd.device;
      reg.aktualisiert = jetzt();
      const lz = await tx.doc(Laufzeit);
      lz.gestartet = lz.gestartet ?? jetzt();
      await tx.doc(Freigaben);
      await tx.doc(LaufListe);
      await tx.doc(Zustand);
      await tx.doc(HubAufgaben);
    }, CTX);
  }

  async #registriereRoot() {
    await this.root.commit(async (tx) => {
      const meta = await tx.doc(AgentMeta, this.root.id);
      if (!meta.erstellt) meta.erstellt = jetzt();
      if (!meta.titel || meta.titel === 'Neuer Agent') meta.titel = 'Hauptgespräch';
      meta.art = 'root';
      meta.arbeitsbereich = this.cfg.arbeitsbereiche[meta.arbeitsbereich]
        ? meta.arbeitsbereich
        : 'standard';
      const reg = await tx.doc(Register);
      const vorhanden = reg.agents.find((a) => a.id === this.root.id);
      if (vorhanden) Object.assign(vorhanden, registerEintrag({ ...meta, id: this.root.id }));
      else reg.agents.push(registerEintrag({ ...meta, id: this.root.id }));
      reg.aktualisiert = jetzt();
    }, CTX);
    const meta = await this.harness.snapshot(AgentMeta, this.root.id, CTX);
    await this.root.configure(agentFuer(this.cfg, { ...meta, id: this.root.id }), CTX);
  }

  async close() {
    if (this.geschlossen) return;
    this.geschlossen = true;
    this.ruhe.stop();
    for (const watch of this._watch.values()) {
      await watch.stop().catch(() => {});
    }
    this._watch.clear();
    await this.browser.schliessen().catch(() => {});
    if (this.harness) await schliessen(this.harness);
  }

  /**
   * Die Sitzungen. `archiv`: `0` (Standard, ohne Archivierte), `1` (nur Archivierte) oder `alle`; jedes Gespräch trägt `archiviert`.
   * Ohne Argument genau das Verhalten von vor dem Archiv-Weg (alle anderen Aufrufer im Runner).
   */
  async gespraeche({ archiv } = {}) {
    const modus = archivModus(archiv);
    const reg = (await this.harness.snapshot(Register, CTX)) ?? { agents: [] };
    const out = [];
    for (const eintrag of reg.agents ?? []) {
      if (modus === 'aktiv' && eintrag.archiviert) continue;
      const meta = (await this.harness.snapshot(AgentMeta, eintrag.id, CTX)) ?? eintrag;
      if (modus !== 'aktiv' && !archivPasst(meta, modus)) continue;
      out.push({
        ...registerEintrag({ ...meta, id: eintrag.id }),
        ...eintrag,
        id: eintrag.id,
        titel: meta.titel ?? eintrag.titel,
        arbeitsbereich: meta.arbeitsbereich ?? eintrag.arbeitsbereich,
        modell: meta.modell ?? eintrag.modell,
        archiviert: !!meta.archiviert,
        ordner: meta.ordner ?? null,
        // Das Arbeitsverzeichnis, wie die Werkzeuge es sehen (Ordner der Sitzung, sonst der Arbeitsbereich).
        agent: { cwd: agentFuer(this.cfg, { ...meta, id: eintrag.id }).cwd ?? null },
      });
    }
    out.sort((a, b) => {
      if (a.art === 'root' && b.art !== 'root') return -1;
      if (b.art === 'root' && a.art !== 'root') return 1;
      return (b.erstellt ?? 0) - (a.erstellt ?? 0);
    });
    return out;
  }

  /** Die Registereinträge nach Archiv-Modus (`aktiv`, `archiviert`, `alle`), Hauptgespräch zuerst, dann neueste zuerst. Ein Dokument, keine Metalesung je Sitzung. */
  async registerListe(modus = 'aktiv') {
    const reg = (await this.harness.snapshot(Register, CTX)) ?? { agents: [] };
    return (reg.agents ?? [])
      .filter((e) => archivPasst(e, modus))
      .sort((a, b) => {
        if (a.art === 'root' && b.art !== 'root') return -1;
        if (b.art === 'root' && a.art !== 'root') return 1;
        return (b.erstellt ?? 0) - (a.erstellt ?? 0);
      });
  }

  /**
   * Suche über Titel und sichtbaren Verlauf (suche.js) für `GET /api/suche`. Nur lesend; höchstens `gleichzeitig` Suchen zugleich
   * (sonst `SucheFehler` 429). Grenzen aus `pi_durable.suche` (Standard: SUCHE_GRENZEN).
   */
  async suche({ q, limit, archiv } = {}) {
    const grenzen = { ...SUCHE_GRENZEN, ...(this.pd.suche ?? {}) };
    if ((this._suchen ?? 0) >= grenzen.gleichzeitig) throw new SucheFehler(429, 'Es läuft schon eine Suche, bitte gleich noch einmal');
    this._suchen = (this._suchen ?? 0) + 1;
    try {
      return await sitzungenDurchsuchen(this, { q, limit, archiv }, grenzen);
    } finally {
      this._suchen -= 1;
    }
  }

  /** Das Kontextfenster (Token) des Modells, das die Sitzung gerade benutzt; fällt auf Rheas Fenster zurück. */
  async kontextFenster(id) {
    try {
      // ein Dokument lesen (wie die Nutzung), kein Gespräch öffnen: die Ansicht wird von der Oberfläche oft abgefragt
      const agent = await this.harness.snapshot(AGENT, id, CTX);
      return fensterFuerModell(this.cfg, agent?.model);
    } catch {
      return fensterFuerModell(this.cfg, null);
    }
  }

  /**
   * Bahnen (ADR-209): Besitzer' Klasse läuft auf dem Besitzer-Modell, Hintergrund auf dem Standardmodell.
   * Gesprächsmodelle, die ein Mensch bewusst gewählt hat (`meta.modell`), bleiben unberührt.
   */
  async bahnEinstellen(id, klasse) {
    const bahn = this.cfg.bahnen?.[klasse === 'max' ? 'max' : 'hintergrund'];
    if (!bahn?.provider || !bahn?.modelId) return;
    const meta = await this.harness.snapshot(AgentMeta, id, CTX).catch(() => null);
    if (meta?.modell) return;
    const conv = await gespraechOeffnen(this.harness, id);
    if (!conv) return;
    const agent = await agentVon(conv);
    // Kette: der erste brauchbare Provider; die Bahn gilt, solange es ihr eigener Provider ist.
    if (this.kette.aktiv && this.kette.provider(bahn.provider)) {
      const ziel = await this.kette.waehlen(); // wirft KEIN_PROVIDER, wenn keiner erreichbar ist
      if (ziel.name !== bahn.provider) {
        await this.#wechseln(conv, agent, ziel, klasse === 'max' ? 'max' : 'standard', { geplant: true });
        return;
      }
    }
    if (agent.model?.provider === bahn.provider && agent.model?.modelId === bahn.modelId) return;
    await umstellen(conv, { model: { provider: bahn.provider, modelId: bahn.modelId } });
  }

  /**
   * Vor einem Zug eines Menschen (`sende`): bei aktiver Kette den ersten brauchbaren Provider wählen. Die Rolle des
   * bisherigen Modells (Standard oder Vorfahrt) bleibt; ein bewusst gewähltes Modell (`meta.modell`) bleibt unberührt.
   */
  async #providerWaehlen(conv, id) {
    if (!this.kette.aktiv) return;
    const meta = await this.harness.snapshot(AgentMeta, id, CTX).catch(() => null);
    if (meta?.modell) return;
    const agent = await agentVon(conv);
    const von = this.kette.provider(agent.model?.provider);
    if (!von) return;
    const ziel = await this.kette.waehlen();
    if (ziel.name === von.name) return;
    const rolle = von.maxModelId !== von.modelId && agent.model?.modelId === von.maxModelId ? 'max' : 'standard';
    await this.#wechseln(conv, agent, ziel, rolle, { geplant: true });
  }

  /**
   * Das Gespräch auf `ziel` umstellen. Ist `ziel` kleiner als der bisherige Provider und lebt der bisherige noch
   * (`geplant`), wird zuerst dort verdichtet: der Harness verdichtet sonst mit dem kleinen Modell, dem der lange
   * Verlauf als Ganzes nicht passt.
   */
  async #wechseln(conv, agent, ziel, rolle, { geplant }) {
    const modelId = rolle === 'max' ? ziel.maxModelId : ziel.modelId;
    if (agent.model?.provider === ziel.name && agent.model?.modelId === modelId) return false;
    const von = this.kette.provider(agent.model?.provider);
    if (geplant && von && ziel.contextWindow < von.contextWindow && !this.kette.gesperrt(von.name)) {
      await this.#vorherVerdichten(conv, ziel);
    }
    await umstellen(conv, { model: { provider: ziel.name, modelId } });
    console.log(`[fyos-provider] Gespräch ${conv.id}: ${agent.model?.provider ?? '—'} → ${ziel.name}/${modelId}`);
    return true;
  }

  /** Passt der Verlauf nicht mit Luft in das Fenster von `ziel`, auf dem bisherigen Modell verdichten (höchstens zweimal). */
  async #vorherVerdichten(conv, ziel) {
    const grenze = blockierendAb(ziel) - Math.round(ziel.contextWindow * 0.1);
    for (let i = 0; i < 2; i++) {
      const ctx = await aktivesFenster(conv);
      if (schaetzeTokens(ctx.messages) <= grenze) return;
      try {
        const task = await verlaufVerdichten(conv);
        let timer;
        await Promise.race([
          aufgabeAbwarten(this.harness, task),
          new Promise((_, nein) => {
            timer = setTimeout(() => nein(new Error('Verdichtung dauert zu lange')), VERDICHTEN_MAX_MS);
            timer.unref?.();
          }),
        ]).finally(() => clearTimeout(timer));
      } catch (fehler) {
        console.error(`[fyos-provider] Verdichtung vor dem Wechsel auf ${ziel.name} fehlgeschlagen: ${fehler.message}`);
        return;
      }
    }
  }

  /**
   * Ein Provider ist mitten im Zug ausgefallen: Gespräche, die auf ihm stehen (und kein bewusst gewähltes Modell haben),
   * auf den nächsten brauchbaren umstellen. Der Wiederholungsversuch des Harness liest das Modell neu und läuft dort.
   * Ohne brauchbaren Ersatz bleibt alles stehen; der nächste Zug meldet KEIN_PROVIDER.
   */
  async #nachAusfall(name) {
    if (!this.harness) return;
    let ziel;
    try {
      ziel = await this.kette.waehlen({ ausser: [name] });
    } catch (fehler) {
      if (fehler?.code === KEIN_PROVIDER) {
        console.error(`[fyos-provider] ${fehler.message}`);
        return;
      }
      throw fehler;
    }
    const reg = (await this.harness.snapshot(Register, CTX).catch(() => null)) ?? { agents: [] };
    for (const eintrag of reg.agents ?? []) {
      if (eintrag.archiviert) continue;
      const meta = await this.harness.snapshot(AgentMeta, eintrag.id, CTX).catch(() => null);
      if (meta?.modell) continue;
      const conv = await gespraechOeffnen(this.harness, eintrag.id).catch(() => null);
      if (!conv) continue;
      const agent = await agentVon(conv);
      if (agent.model?.provider !== name) continue;
      const von = this.kette.provider(name);
      const rolle = von && von.maxModelId !== von.modelId && agent.model?.modelId === von.maxModelId ? 'max' : 'standard';
      await this.#wechseln(conv, agent, ziel, rolle, { geplant: false });
    }
  }

  async gespraech(id) {
    const conv = await gespraechOeffnen(this.harness, id);
    if (!conv) return null;
    const meta = (await this.harness.snapshot(AgentMeta, id, CTX)) ?? {
      id,
      titel: 'Gespräch',
      erstellt: null,
      arbeitsbereich: 'standard',
      modell: null,
      archiviert: false,
      art: 'mensch',
    };
    const usage = await this.harness.snapshot(UsageDoc, id, CTX);
    const agent = await agentVon(conv);
    return {
      id,
      meta,
      agent: { model: agent.model ?? null, cwd: agent.cwd ?? null, tools: agent.tools.map((t) => t.name) },
      usage: usage ?? null,
    };
  }

  /**
   * Der sichtbare Verlauf: die neuesten `limit` Einträge in aufsteigender Reihenfolge, AUCH vor dem letzten Kopf-Marker
   * (`pi.reset`, `pi.compaction`). `conv.context()` und der erste Snapshot des Stroms liefern nur das aktive Fenster ab dem
   * Marker; nach `leeren` bleibt dort nur der Marker, nach Verdichten Zusammenfassung plus ca. 32k Token. Die Clients
   * versprechen aber „der bisherige Verlauf bleibt sichtbar“ (befehle.js, #neu).
   */
  async verlauf(id, limit = 400) {
    return verlaufVon(this.harness, id, { limit });
  }

  async ansicht(id, { voll = false, limit = 400 } = {}) {
    const [sicht, meta, usage] = await Promise.all([
      ansichtVon(this.harness, id, { voll, limit }),
      this.harness.snapshot(AgentMeta, id, CTX).catch(() => null),
      this.harness.snapshot(UsageDoc, id, CTX).catch(() => null),
    ]);
    if (!sicht) return null;
    // `usage.context = { tokens, window }` (kontext-anzeige.js): Füllung nach der letzten Antwort (null nach leeren/verdichten) und Fenster des Modells.
    const kontext = nutzungMitKontext(usage, kontextAusEintraegen(sicht.entries), await this.kontextFenster(id));
    return {
      id,
      meta: meta ?? null,
      entries: sicht.entries,
      fenster: sicht.fenster,
      messages: sicht.messages,
      usage: kontext,
    };
  }

  async neuesGespraech({ titel, arbeitsbereich = 'standard', modell = null, art = 'mensch', ordner = null } = {}) {
    if (!this.cfg.arbeitsbereiche[arbeitsbereich]) {
      throw new Error(`Unbekannter Arbeitsbereich: ${arbeitsbereich}`);
    }
    // Ordner je Sitzung: gewinnt gegen den Arbeitsbereich als cwd; geprüft wird hier (nicht nur an der Haustür), gespeichert
    // wird der aufgelöste Pfad. Fehler tragen `status` 400/403/404 (OrdnerFehler).
    let ordnerEcht = null;
    if (ordner !== null && ordner !== undefined && ordner !== '') {
      ordnerEcht = (await ordnerPruefen(this.pd.ordnerErlaubt ?? [], ordner)).echt;
    }
    if (modell && !modellListe(this.cfg).some((m) => m.id === modell)) {
      throw new Error(`Unbekanntes Modell: ${modell}`);
    }
    const meta = {
      titel: TEXT(titel, 120) || 'Neuer Agent',
      arbeitsbereich,
      ordner: ordnerEcht,
      modell,
      erstellt: jetzt(),
      art,
    };
    const conv = await gespraechAnlegen(this.harness, { agent: agentFuer(this.cfg, { ...meta, id: 'neu' }) });
    await conv.commit(async (tx) => {
      const doc = await tx.doc(AgentMeta, conv.id);
      Object.assign(doc, {
        titel: meta.titel,
        arbeitsbereich,
        ordner: ordnerEcht,
        modell,
        erstellt: meta.erstellt,
        art,
        archiviert: false,
      });
      const reg = await tx.doc(Register);
      const eintrag = reg.agents.find((a) => a.id === conv.id);
      const neu = registerEintrag({ ...doc, id: conv.id });
      if (eintrag) Object.assign(eintrag, neu);
      else reg.agents.push(neu);
      reg.aktualisiert = jetzt();
    }, CTX);
    return this.gespraech(conv.id);
  }

  /**
   * Das Sprachgespräch „Persona Sprache“ (sprache-agent.js, RUNNER-SPRACHE.md#sprach-agent): ein eigenes, ewiges Gespräch mit kurzem Systemkopf,
   * nur den Sprach-Werkzeugen und der Bahn max. Es wird beim ersten Gebrauch angelegt und danach über das Register wiedergefunden
   * (Art `sprache`), auch nach einem Neustart. Wirft, wenn der Sprach-Agent nicht eingeschaltet ist (`sprache.agent.an`).
   */
  spracheAgent() {
    if (!this._spracheLauf) {
      this._spracheLauf = this.#spracheAgentSuchen().finally(() => {
        this._spracheLauf = null;
      });
    }
    return this._spracheLauf;
  }

  async #spracheAgentSuchen() {
    if (!this.spracheErweiterung) throw new Error('Sprach-Agent nicht eingeschaltet (sprache.agent.an)');
    if (this._spracheId !== null) {
      const c = await gespraechOeffnen(this.harness, this._spracheId).catch(() => null);
      if (c) return this._spracheId;
      this._spracheId = null;
    }
    const reg = (await this.harness.snapshot(Register, CTX)) ?? { agents: [] };
    for (const e of reg.agents ?? []) {
      if (e.art !== 'sprache' || e.archiviert) continue;
      const c = await gespraechOeffnen(this.harness, e.id).catch(() => null);
      if (c) {
        this._spracheId = e.id;
        return e.id;
      }
    }
    const roh = this.cfg.sprache?.agent?.modell;
    const modell = roh
      ? { provider: roh.provider ?? this.cfg.pi_durable.model.provider, modelId: roh.modelId ?? roh }
      : modellRef(this.cfg, 'max');
    const raum = this.cfg.arbeitsbereiche.standard;
    const conv = await gespraechAnlegen(this.harness, {
      agent: { model: modell, cwd: raum?.pfad, extensions: [this.spracheErweiterung] },
    });
    await conv.commit(async (tx) => {
      const doc = await tx.doc(AgentMeta, conv.id);
      Object.assign(doc, { titel: 'Persona Sprache', arbeitsbereich: 'standard', modell: null, erstellt: jetzt(), art: 'sprache', archiviert: false });
      const r = await tx.doc(Register);
      const neu = registerEintrag({ ...doc, id: conv.id });
      const eintrag = r.agents.find((a) => a.id === conv.id);
      if (eintrag) Object.assign(eintrag, neu);
      else r.agents.push(neu);
      r.aktualisiert = jetzt();
    }, CTX);
    this._spracheId = conv.id;
    return conv.id;
  }

  async aendereGespraech(id, { titel, arbeitsbereich, modell, archiviert } = {}) {
    const conv = await gespraechOeffnen(this.harness, id);
    if (!conv) throw new Error('Gespräch nicht gefunden');
    const alt = (await this.harness.snapshot(AgentMeta, id, CTX)) ?? {};
    const neu = {
      titel: titel === undefined ? alt.titel : TEXT(titel, 120) || alt.titel,
      arbeitsbereich: arbeitsbereich ?? alt.arbeitsbereich ?? 'standard',
      modell: modell === undefined ? alt.modell : modell,
      archiviert: archiviert === undefined ? !!alt.archiviert : !!archiviert,
    };
    if (!this.cfg.arbeitsbereiche[neu.arbeitsbereich]) throw new Error('Unbekannter Arbeitsbereich');
    if (neu.modell && !modellListe(this.cfg).some((m) => m.id === neu.modell)) throw new Error('Unbekanntes Modell');
    await umstellen(conv, agentFuer(this.cfg, { ...alt, ...neu, id }));
    await conv.commit(async (tx) => {
      const doc = await tx.doc(AgentMeta, id);
      Object.assign(doc, neu);
      const reg = await tx.doc(Register);
      const eintrag = reg.agents.find((a) => a.id === id);
      if (eintrag) Object.assign(eintrag, registerEintrag({ ...doc, id }));
      reg.aktualisiert = jetzt();
    }, CTX);
    return this.gespraech(id);
  }

  /**
   * `kanal` (z. B. `sprache`) steht im Eintrag; `kopf` ist ein Zusatz-Abschnitt, der nur dem Modell vorangestellt wird
   * (Sprachprofil), nicht im Eintrag steht und im Verlauf der Clients nicht erscheint.
   */
  async sende(id, text, { art = 'folgen', requestId, kanal = null, kopf = null } = {}) {
    const conv = await gespraechOeffnen(this.harness, id);
    if (!conv) throw new Error('Gespräch nicht gefunden');
    let inhalt = TEXT(text, 40_000).trim();
    if (!inhalt) throw new Error('Nachricht ist leer');
    // Slash-Befehle: ein bekannter Befehl wird hier ausgeführt und erreicht das Modell nicht. Skills und
    // Prompt-Vorlagen werden zu Text und gehen als gewöhnliche Nachricht weiter; Unbekanntes bleibt Text.
    let vorlage = null;
    if (inhalt.startsWith('/') && art !== 'abweisen') {
      const b = await this.befehle.versuche(id, inhalt, { requestId });
      if (b && !b.modell) {
        return { id: null, art, befehl: { name: b.name, ok: b.ok, text: b.text, aktion: b.aktion ?? null, ...(b.wiederholt ? { wiederholt: true } : {}) } };
      }
      if (b?.modell) {
        vorlage = { name: b.name, art: b.art, eingabe: inhalt };
        inhalt = TEXT(b.text, 40_000);
      }
    }
    await this.#providerWaehlen(conv, id);
    const submission = await zugStarten(conv, {
      text: kopf ? `${TEXT(kopf, 4000)}\n\n${inhalt}` : inhalt,
      wennBeschaeftigt: art === 'steuern' ? 'steuern' : art === 'abweisen' ? 'abweisen' : 'folgen',
      anfrageId: requestId || `web:${randomUUID()}`,
      eintrag: {
        art: 'fyos.mensch',
        daten: {
          text: vorlage ? vorlage.eingabe : inhalt,
          von: 'mensch',
          art,
          zeit: jetzt(),
          ...(kanal ? { kanal: TEXT(kanal, 24) } : {}),
          ...(vorlage ? { vorlage: vorlage.name, vorlageArt: vorlage.art } : {}),
        },
      },
    });
    return { id: submission.id, art };
  }

  async abbrechen(id) {
    const conv = await gespraechOeffnen(this.harness, id);
    if (!conv) throw new Error('Gespräch nicht gefunden');
    await zugAbbrechen(conv);
  }

  async leeren(id, uebergabe) {
    const conv = await gespraechOeffnen(this.harness, id);
    if (!conv) throw new Error('Gespräch nicht gefunden');
    await kontextLeeren(conv, uebergabe ? TEXT(uebergabe, 4000) : undefined);
  }

  async verdichten(id, hinweis) {
    const conv = await gespraechOeffnen(this.harness, id);
    if (!conv) throw new Error('Gespräch nicht gefunden');
    return verlaufVerdichten(conv, hinweis ? TEXT(hinweis, 1000) : undefined);
  }

  async zweig(id, entryId, titel) {
    const conv = await gespraechOeffnen(this.harness, id);
    if (!conv) throw new Error('Gespräch nicht gefunden');
    const at = entryId || (await letzterEintragId(conv));
    if (!at) throw new Error('Das Gespräch hat noch keinen Eintrag zum Abzweigen');
    const original = (await this.harness.snapshot(AgentMeta, id, CTX)) ?? {};
    const fork = await abzweigen(conv, at, {
      agent: agentFuer(this.cfg, { ...original, titel: titel || `${original.titel ?? 'Gespräch'} · Zweig` }),
    });
    await fork.commit(async (tx) => {
      const doc = await tx.doc(AgentMeta, fork.id);
      Object.assign(doc, {
        titel: TEXT(titel, 120) || `${original.titel ?? 'Gespräch'} · Zweig`,
        arbeitsbereich: original.arbeitsbereich ?? 'standard',
        ordner: original.ordner ?? null,
        modell: original.modell ?? null,
        erstellt: jetzt(),
        archiviert: false,
        art: 'zweig',
        // Das Register trug `parent` bisher nie ein (Protokoll verspricht es); /baum liest es.
        parent: id,
      });
      const reg = await tx.doc(Register);
      const eintrag = reg.agents.find((a) => a.id === fork.id);
      const neu = registerEintrag({ ...doc, id: fork.id });
      if (eintrag) Object.assign(eintrag, neu);
      else reg.agents.push(neu);
      reg.aktualisiert = jetzt();
    }, CTX);
    return this.gespraech(fork.id);
  }

  async freigaben() {
    const doc = (await this.harness.snapshot(Freigaben, CTX)) ?? { eintraege: {} };
    const reg = (await this.harness.snapshot(Register, CTX)) ?? { agents: [] };
    const titel = new Map((reg.agents ?? []).map((a) => [a.id, a.titel]));
    return Object.values(doc.eintraege ?? {})
      .map((f) => {
        const gespraechTitel = titel.get(f.conversationId) ?? f.conversationId;
        // Entscheidung 586: jede Freigabe trägt einen Kurzkontext, auch ältere Einträge ohne (dann der Rückfall).
        return { ...f, gespraechTitel, kontext: kontextAnzeigen(f, { titel: titel.get(f.conversationId) }) };
      })
      .sort((a, b) => (b.erstellt ?? 0) - (a.erstellt ?? 0));
  }

  async entscheideFreigabe(id, { entscheidung, notiz, von = 'mensch' }) {
    if (!['erteilt', 'abgelehnt'].includes(entscheidung)) throw new Error('Entscheidung: erteilt oder abgelehnt');
    const doc = (await this.harness.snapshot(Freigaben, CTX)) ?? { eintraege: {} };
    const f = doc.eintraege?.[id];
    if (!f) throw new Error('Freigabe nicht gefunden');
    if (f.status !== 'offen') throw new Error(`Freigabe ist bereits ${f.status}`);
    const conv = await gespraechOeffnen(this.harness, f.conversationId);
    if (!conv) throw new Error('Gespräch zur Freigabe nicht gefunden');
    const text = TEXT(notiz, 600);
    await conv.commit(async (tx) => {
      const d = await tx.doc(Freigaben);
      const e = d.eintraege[id];
      e.status = entscheidung;
      e.entschieden = jetzt();
      e.entschiedenVon = TEXT(von, 64) || 'mensch';
      e.notiz = text || null;
      await tx.appendEntry(f.conversationId, {
        kind: 'fyos.freigabe-entscheidung',
        data: { id, entscheidung, von, notiz: text || null, zeit: jetzt() },
      });
    }, CTX);

    // Ein Werkzeug-Freigabewunsch hat den Zug beendet. Die Entscheidung kommt als neue
    // Nachricht zurück, damit der Agent weiterarbeiten kann. Ein Lauf wartet dagegen selbst
    // auf das Dokument und wird hier nicht doppelt geweckt.
    if (!f.taskId) {
      const satz =
        entscheidung === 'erteilt'
          ? `Freigabe ${id} ist erteilt. Aktion: ${f.aktion}. Du kannst jetzt fortfahren.${text ? ` Notiz: ${text}` : ''}`
          : `Freigabe ${id} wurde abgelehnt. Aktion: ${f.aktion}.${text ? ` Begründung: ${text}` : ''} Bitte nicht ausführen; schlage eine Alternative vor.`;
      await this.sende(f.conversationId, satz, {
        art: 'folgen',
        requestId: `freigabe-antwort:${id}`,
      }).catch((fehler) => console.error(`[fyos-runner] Freigabeantwort nicht zugestellt: ${fehler.message}`));
    }
    return this.freigaben();
  }

  async neuerLauf(id, eingabe) {
    const conv = await gespraechOeffnen(this.harness, id);
    if (!conv) throw new Error('Gespräch nicht gefunden');
    const raum = this.cfg.arbeitsbereiche[eingabe.arbeitsbereich ?? 'standard'];
    if (!raum) throw new Error('Unbekannter Arbeitsbereich');
    if (!String(eingabe.auftrag ?? '').trim()) throw new Error('Auftrag fehlt');
    const laufId = await conv.commit(
      (tx) =>
        this.laufAnlegen(tx, this.Lauf, {
          titel: eingabe.titel || 'Lauf',
          auftrag: eingabe.auftrag,
          arbeitsbereich: eingabe.arbeitsbereich ?? 'standard',
          cwd: raum.pfad,
          freigabe: !!eingabe.freigabe,
          modell: eingabe.modell || null,
          quelle: 'mensch',
          elternId: id,
          risiko: eingabe.risiko ?? 'medium',
        }),
      CTX,
    );
    fortsetzen(this.harness);
    return this.lauf(laufId);
  }

  /**
   * Harness2-Pilot starten (Schatten): Eingabe prüfen und die Aufgabe am Hauptgespräch anlegen.
   * Das Ergebnis liegt nur im Ausgabeordner der Eingabe; der Pilot übernimmt nichts.
   */
  async neuerHarness2Pilot(eingabe) {
    const raum = this.cfg.arbeitsbereiche[eingabe?.arbeitsbereich ?? 'standard'];
    if (!raum) throw new Error('Unbekannter Arbeitsbereich');
    const input = pruefeHarness2Eingabe({ ...eingabe, cwd: raum.pfad, elternId: this.root.id });
    const id = await this.root.commit((tx) => this.harness2Anlegen(tx, this.Harness2Pilot, input), CTX);
    fortsetzen(this.harness);
    return this.harness2Stand(id);
  }

  /**
   * Die Nachtwerkstatt für eine Nacht starten (Takt `nachtwerkstatt` oder von Hand). Je Nacht genau eine Aufgabe:
   * ein zweiter Aufruf mit demselben Datum liefert die vorhandene (außer mit `erneut`). Nur Vorschläge, nur lesend.
   */
  async nachtwerkstattStarten({ nacht, schmieden, fensterIgnorieren = false, erneut = false, quelle = 'mensch' } = {}) {
    const nk = this.Nachtwerkstatt.nk;
    if (!nk.an) return { gestartet: false, grund: 'Nachtwerkstatt aus (cfg.nachtwerkstatt.an=false)' };
    const datum = nacht ?? nachtDatum(this.nachtJetzt(), nk.zone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) throw new Error('nacht: JJJJ-MM-TT');
    const gewuenscht = (schmieden ?? SCHMIEDEN).map(String);
    if (!gewuenscht.every((s) => SCHMIEDEN.includes(s))) throw new Error(`schmieden: ${SCHMIEDEN.join(', ')}`);
    const bekannt = new Set(this.knoten.liste().map((k) => k.id));
    const knotenIds = (Array.isArray(this.cfg.pi_durable.nodes) ? this.cfg.pi_durable.nodes : [])
      .map((n) => String(n.id ?? '').toLowerCase())
      .filter((id) => bekannt.has(id));
    const input = {
      nacht: datum,
      basis: resolve(nk.ausgabe),
      schmieden: gewuenscht,
      knotenIds,
      cwd: this.cfg.arbeitsbereiche.standard?.pfad ?? null,
      fensterIgnorieren: Boolean(fensterIgnorieren),
      quelle: String(quelle).slice(0, 20),
    };
    const erg = await this.root.commit(async (tx) => {
      const doc = await tx.doc(NachtDoc);
      if (doc.naechte[datum] && !erneut) return { schon: doc.naechte[datum] };
      return { id: await this.nachtAnlegen(tx, this.Nachtwerkstatt.Nacht, input) };
    }, CTX);
    if (erg.schon) return { gestartet: false, grund: 'diese Nacht läuft oder lief schon', id: erg.schon, nacht: datum };
    fortsetzen(this.harness);
    return { gestartet: true, id: erg.id, nacht: datum, schmieden: gewuenscht };
  }

  async nachtwerkstattStand(id) {
    const task = await this.harness.getTask(Number(id), CTX).catch(() => undefined);
    if (!task || task.kind !== 'fyos.nachtwerkstatt') return null;
    const cp = task.state.checkpoint ?? {};
    return {
      id: String(id),
      taskStatus: task.state.status,
      phase: cp.phase ?? null,
      kinder: cp.kinder ?? {},
      ergebnisse: cp.ergebnisse ?? {},
      outcome: task.state.status === 'terminal' ? task.state.outcome : null,
    };
  }

  /** Zustand für den Steuerkanal (`/zustand` → `nachtwerkstatt`) und die Verwaltungsansicht. */
  async nachtwerkstattZustand() {
    const nk = this.Nachtwerkstatt.nk;
    const doc = (await this.harness.snapshot(NachtDoc, CTX)) ?? { vorschlaege: {}, naechte: {}, bericht: null };
    const liste = (await this.harness.snapshot(LaufListe, CTX)) ?? { eintraege: {} };
    const offen = offeneVorschlaege(doc);
    return {
      an: nk.an,
      fenster: { von: nk.von, bis: nk.bis, zone: nk.zone, jetzt_im_fenster: ruhefenster(this.nachtJetzt(), nk.zone, nk.von, nk.bis) },
      deckel: nk.deckel,
      offen: offen.length,
      vorschlaege: offen.map(({ id, schmiede, nacht, titel, ordner }) => ({ id, schmiede, nacht, titel, ordner })),
      letzter_bericht: doc.bericht ? { nacht: doc.bericht.nacht, pfad: doc.bericht.pfad, status: doc.bericht.status } : null,
      laufend: Object.values(liste.eintraege ?? {})
        .filter((e) => String(e.art ?? '').startsWith('nachtwerkstatt') && e.status === 'laeuft')
        .map((e) => ({ id: e.id, art: e.art, phase: e.phase })),
    };
  }

  /** Einen Vorschlag als erledigt oder verworfen markieren (macht der Mensch; gibt dem Deckel wieder Platz). */
  async vorschlagSchliessen(id, status) {
    if (!['erledigt', 'verworfen'].includes(status)) throw new Error('status: erledigt oder verworfen');
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(NachtDoc);
      const v = doc.vorschlaege[id];
      if (!v) throw new Error('Vorschlag nicht gefunden');
      v.status = status;
      v.geschlossen = Date.now();
    }, CTX);
    return this.nachtwerkstattZustand();
  }

  /** Stand eines Pilots aus seinem Prüfpunkt: Phase, Runde, Verbrauch, Fortschritt, am Ende das Ergebnis. */
  async harness2Stand(id) {
    const task = await this.harness.getTask(Number(id), CTX).catch(() => undefined);
    if (!task || task.kind !== 'fyos.harness2-pilot') return null;
    const cp = task.state.checkpoint ?? {};
    const input = task.input ?? {};
    const fertig = Object.values(cp.laeufe ?? {}).filter((r) => r.ende).length;
    const terminal = task.state.status === 'terminal';
    return {
      id: String(id),
      taskStatus: task.state.status,
      phase: cp.phase ?? null,
      runde: cp.runde ?? null,
      k: input.k ?? null,
      verbrauch: cp.verbrauch ?? null,
      budget: input.budget ?? null,
      geplant: input.aufgaben ? planZuege(input.aufgaben.length, input.n, input.k) : null,
      messlaeufe: fertig,
      abbruch: cp.abbruch ?? null,
      outcome: terminal ? task.state.outcome : null,
    };
  }

  async laeufe() {
    const doc = (await this.harness.snapshot(LaufListe, CTX)) ?? { eintraege: {} };
    const out = [];
    for (const e of Object.values(doc.eintraege ?? {})) {
      const task = await this.harness.getTask(Number(e.id), CTX).catch(() => undefined);
      out.push({
        ...e,
        taskStatus: task?.state?.status ?? 'unbekannt',
        outcome: task?.state?.status === 'terminal' ? task.state.outcome : null,
        abgebrochen: !!task?.abortRequested,
      });
    }
    out.sort((a, b) => (b.erstellt ?? 0) - (a.erstellt ?? 0));
    return out;
  }

  async lauf(id) {
    const doc = (await this.harness.snapshot(LaufListe, CTX)) ?? { eintraege: {} };
    const e = doc.eintraege?.[String(id)];
    if (!e) return null;
    const task = await this.harness.getTask(Number(id), CTX).catch(() => undefined);
    return {
      ...e,
      taskStatus: task?.state?.status ?? 'unbekannt',
      outcome: task?.state?.status === 'terminal' ? task.state.outcome : null,
    };
  }

  async laufAbbrechen(id) {
    const task = await this.harness.getTask(Number(id), CTX);
    if (!task) throw new Error('Lauf nicht gefunden');
    return this.harness.abortTask(Number(id), CTX);
  }

  async zustand() {
    return (await this.harness.snapshot(Zustand, CTX)) ?? { werte: {}, geaendert: null, von: null };
  }

  async zustandSetzen(schluessel, wert) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(schluessel)) throw new Error('Ungültiger Schlüssel');
    let anzahl = 0;
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(Zustand);
      if (wert === null) delete doc.werte[schluessel];
      else doc.werte[schluessel] = wert;
      doc.geaendert = jetzt();
      doc.von = 'mensch';
      anzahl = Object.keys(doc.werte).length;
    }, CTX);
    return { anzahl, zustand: await this.zustand() };
  }

  knotenListe() {
    return this.knoten.liste();
  }

  async knotenPruefen() {
    return this.knoten.allePruefen();
  }

  async werkzeuge(q) {
    return this.hub.suchen(q ?? '', { voll: true, limit: 200 });
  }

  async werkzeugSchema(name) {
    return this.hub.schema(name);
  }

  async modelle() {
    return modellListe(this.cfg);
  }

  /** Der Ruhe-Schalter für `/api/ruhe`: Zustand, ohne etwas zu ändern. */
  ruheZustand() {
    const ruhe = this.ruhe.zustand();
    return { ruhe, pausiert: ruhe.pausiert, spielmodus: ruhe.spielmodus };
  }

  /**
   * Ruhe an oder aus. `von` kommt vom Aufrufer (Token, Steuerkanal), nie aus dem Rumpf. Mit `sofort` wird zusätzlich
   * abgebrochen, was gerade läuft: der Zug im Hauptgespräch und alle laufenden Läufe.
   */
  async ruheSetzen({ an, bis, grund, stufe, sofort } = {}, von = null) {
    const ergebnis = this.ruhe.setzen({ an, bis, grund, stufe, sofort, von });
    const angehalten = [];
    if (an === true && sofort === true) {
      if (this.root?.id !== undefined) {
        await this.abbrechen(this.root.id).then(() => angehalten.push(`gespraech:${this.root.id}`), () => {});
      }
      for (const lauf of await this.laeufe().catch(() => [])) {
        if (lauf.status !== 'laeuft') continue;
        await this.laufAbbrechen(lauf.id).then(() => angehalten.push(`lauf:${lauf.id}`), () => {});
      }
    }
    return { ...this.ruheZustand(), ruhe: ergebnis, angehalten };
  }

  async health() {
    const hub = await this.hub.gesundheit();
    const ruhe = this.ruheZustand();
    return {
      ok: !this.geschlossen,
      // `pausiert`: Ruhe oder Spielmodus; `spielmodus`: Name der geltenden Marke oder null (Clients zeigen beides).
      ruhe: ruhe.ruhe,
      pausiert: ruhe.pausiert,
      spielmodus: ruhe.spielmodus,
      agent: this.cfg.agent,
      geraet: this.pd.device,
      knoten: this.knoten.liste().map(({ id, titel, weg, local }) => ({ id, titel, weg, local })),
      gespraeche: (await this.gespraeche()).length,
      speicher: this.speicherDatei,
      hub,
      ...(this.kette.aktiv ? { provider: this.kette.zustand() } : {}),
      berichte: this._berichte.slice(-10),
      zeit: jetzt(),
    };
  }

  async watchConversation(id, { voll = false, limit = 400 } = {}) {
    // Mit `voll` ersetzt der sichtbare Verlauf (auch vor Reset und Verdichtung) die Einträge des Snapshots (lauf/ereignisse.js).
    const stream = await ereignisse(this.harness, id, { voll, limit });
    // `usage.context = { tokens, window }` im Snapshot und in jedem `usage_changed` (kontext-anzeige.js). Der Stand wird aus den
    // Einträgen nachgeführt, die der Strom ohnehin liefert; es kommt keine zusätzliche Datenbanklesung dazu.
    let tokens = kontextAusEintraegen(stream.snapshot?.entries);
    let fenster = fensterFuerModell(this.cfg, stream.snapshot?.agent?.model); // der Snapshot trägt die Einstellung schon
    const mitKontext = (u) => nutzungMitKontext(u, tokens, fenster);
    return {
      snapshot: { ...stream.snapshot, usage: mitKontext(stream.snapshot?.usage) },
      start: (listener) => {
        stream.start(async (events) => {
          const liste = Array.isArray(events) ? events : [events];
          // erst den Stand über die ganze Gruppe nachführen (die Reihenfolge von usage_changed und message_end ist nicht zugesichert) ...
          for (const ev of liste) {
            if (ev?.type === 'snapshot') {
              tokens = kontextAusEintraegen(ev.entries);
            } else if (ev?.type === 'agent_changed') {
              fenster = fensterFuerModell(this.cfg, ev.agent?.model);
            } else if (ev?.entry) {
              tokens = kontextNachEintrag(tokens, ev.entry);
            }
          }
          // ... dann die Ereignisse mit Kontext versehen; alles andere bleibt, wie es kommt
          const ergaenzt = liste.map((ev) => {
            if (ev?.type === 'usage_changed') return { ...ev, usage: mitKontext(ev.usage) };
            if (ev?.type === 'snapshot') return { ...ev, usage: mitKontext(ev.usage) };
            return ev;
          });
          await listener(Array.isArray(events) ? ergaenzt : ergaenzt[0]);
        });
      },
      stop: () => stream.stop().catch(() => ({ reason: 'closed' })),
    };
  }

  /** Der Strom der autonomen Arbeit über alle Gespräche (Standardansicht jedes Clients). */
  oeffneWirkenStrom() {
    return oeffneWirkenStrom(this.harness);
  }

  async watchDokumente(listener) {
    const strom = await this.oeffneDokumenteStrom();
    strom.start(listener);
    return { stop: strom.stop };
  }

  /** Dokumente als ein Strom; `werte` ist der Stand beim Anhängen, `start` die Fortsetzung. */
  async oeffneDokumenteStrom() {
    const watches = [];
    const werte = {};
    const anhaengen = async (name, token) => {
      const w = await this.harness.watchDoc(token, CTX);
      if (!w) return;
      watches.push([name, w]);
      werte[name] = w.value;
    };
    await anhaengen('register', Register);
    await anhaengen('freigaben', Freigaben);
    await anhaengen('laeufe', LaufListe);
    await anhaengen('zustand', Zustand);
    return {
      werte,
      start: (listener) => {
        for (const [name, w] of watches) {
          w.start(async (wert) => {
            await listener(name, wert);
          });
        }
      },
      stop: async () => {
        for (const [, w] of watches) await w.stop().catch(() => {});
      },
    };
  }

  async watchAufgaben(listener) {
    const strom = await this.oeffneAufgabenStrom();
    strom.start(listener);
    return { stop: strom.stop };
  }

  async oeffneAufgabenStrom() {
    const w = await this.harness.watchTaskGraph(CTX);
    return {
      wert: w.value,
      start: (listener) => {
        w.start(async (wert) => listener(wert));
      },
      stop: () => w.stop().catch(() => ({ reason: 'closed' })),
    };
  }
}
