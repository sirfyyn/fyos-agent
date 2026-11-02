#!/usr/bin/env node
/**
 * index.js — Start des FYOS-Runners.
 *
 *   node src/index.js [--config /pfad/agent-runner.json]
 *
 * Die Konfiguration ist dieselbe wie für den RPC-Runner; der Abschnitt `pi_durable` ergänzt
 * Gerät, Port, SQLite-Datei und Client. Zugangsdaten stehen in der Umgebung, nie im Code.
 *
 * Was läuft immer (auch im Schatten, `proactive.enabled: false`): Weltmodell, Reflexe-Prüfung,
 * Aufzeichnung, Budget, Steuerkanal und der Server. Was Ereignisse erzeugt oder den Eingang liest,
 * läuft nur mit `proactive.enabled`: Hub-Eingang, Takt, ITSM- und Chat-Wache, Hintergrundjobs.
 * Zwei Leser auf demselben Strom würden jedes Ereignis doppelt ausführen.
 */
import { bindungPruefen, konfigurationLaden, oeffentlicheSicht } from './config.js';
import { Fehlerspeicher, Zugmessung, buildInfo, erstelleVerwaltung } from './verwaltung.js';
import { Runner } from './runner.js';
import { Egress } from './egress.js';
import { Ingress, eingabeInhalt } from './ingress.js';
import { SchattenRekorder, baueAdapter, zugKontext } from './schatten.js';
import { AufgabenWaechter } from './aufgaben.js';
import { erstelleServer } from './server.js';
import { HintergrundTor } from './tor.js';
import { tokenSicherstellen } from './token.js';
import { Weltmodell } from './welt.js';
import { Reflexe } from './reflexe.js';
import { Aufzeichnung } from './aufzeichnung.js';
import { Budget } from './budget.js';
import { istKleinLesend, LesenTor } from './kleines-tor.js';
import { Jobmeldungen, jobsOrdner, zugMarkieren } from './jobs.js';
import { erstelleSteuerkanal } from './steuerkanal.js';
import { Taktgeber } from './takt.js';
import { ItsmWache } from './itsm-wache.js';
import { ChatWache } from './chat-wache.js';
import { FreigabeMeldung } from './freigabe-meldung.js';
import { Arbeitsschleife, lageVon } from './arbeitsschleife.js';
import { Register } from './documents.js';
import { StimmeMessung } from './stimme.js';
import { Sprache, anschluesse, kettenSperre, sperreAus, torAusHub } from './sprache.js';
import { Tagesprotokoll } from './persona/gedaechtnis-protokoll.js';
import { KONTEXT } from './lauf/index.js';

async function main() {
  // Die letzten Fehler des Prozesses für die Verwaltung (`GET /api/verwaltung`); die Ausgabe selbst bleibt unverändert.
  const fehler = new Fehlerspeicher();
  fehler.anzapfen();
  const gestartet = Date.now();

  const cfg = konfigurationLaden();
  const pd = cfg.pi_durable;

  const tokenQuelle = tokenSicherstellen(cfg);
  const bindung = bindungPruefen(pd);
  if (bindung.fehler) {
    console.error(`[fyos-runner] Start abgelehnt: ${bindung.fehler}`);
    process.exit(2);
  }

  const runner = new Runner(cfg);
  await runner.start();
  const hub = runner.hub;
  const spielmodus = runner.spielmodus;
  // Was Eingang, Reflexe und Weltbild als Spielmodus sehen: mit laufendem Ersatzdenker hält die Marke nur Hausmodell an
  // (ohne Kette dasselbe Objekt wie `spielmodus`). Steuerkanal und Jobs sehen die Marke selbst.
  const spielEinlass = runner.spielmodusEinlass;
  const proaktiv = !!pd.proactive?.enabled;
  let ingress = null;

  // --- Tore: Hintergrund (schleifen.darf) und das zweite für kleine lesende Aufträge ---
  const torCfg = cfg.hintergrund_tor;
  const tor = torCfg
    ? new HintergrundTor({
        hub,
        werkzeug: torCfg.werkzeug,
        argumente: torCfg.argumente,
        pruefenS: torCfg.pruefen_s,
        beiOeffnen: () => ingress?.anstossen(),
      })
    : null;
  runner.tor = tor;
  tor?.start();
  const lesenTor = LesenTor.ausKonfig(cfg, { hub, tor, beiOeffnen: () => ingress?.anstossen() });
  lesenTor?.start();

  // --- Weltmodell, Reflexe, Aufzeichnung, Budget ---
  const aufzeichnung = new Aufzeichnung({ cfg });
  const welt = new Weltmodell({
    cfg,
    hub,
    fakten: () => ({
      spielmodus: spielEinlass.an(),
      ...(runner.kette.aktiv ? { ersatzbetrieb: spielmodus.an() && !spielEinlass.an() } : {}),
    }),
  });
  const reflexe = new Reflexe({ cfg, hub, welt, spielmodus: spielEinlass, aufzeichnung });
  reflexe.laden();
  const budget = new Budget({ cfg, harness: runner.harness });
  budget.start();

  const stimme = new StimmeMessung({ harness: runner.harness, aufzeichnung });
  const zugmessung = new Zugmessung();
  const egress = new Egress({ cfg, harness: runner.harness, hub, ruhe: runner.ruhe, zugmessung, messung: stimme, zugKontext: runner.zugKontext });
  await egress.start();
  const wurzelId = () => runner.root?.id;
  // Ruhe-Schalter: jeder Wechsel weckt den Eingang (Ruhe vorbei → Wartendes läuft) und geht, wenn eingeschaltet, in den Hub-Strom.
  runner.ruhe.beiAenderung((z) => {
    ingress?.anstossen();
    if (wurzelId() !== undefined) egress.meldeRuhe(wurzelId(), z);
  });

  /** Meldungen der Reflexe in den Ausgang; ohne laufenden Egress direkt an den Hub. */
  const melden = async (meldungen) => {
    for (const m of meldungen ?? []) {
      try {
        if (egress.aktiv && wurzelId() !== undefined) egress.meldeExtern(wurzelId(), m);
        else await hub.melden([m]);
      } catch (fehler) {
        console.error(`[fyos-runner] Meldung nicht zugestellt: ${fehler.message}`);
      }
    }
  };

  ingress = new Ingress({ cfg, runner, hub, spielmodus: spielEinlass, tor, ruhe: runner.ruhe });

  // --- Schatten-Rekorder (Standard aus): lässt Schattenmodelle nach dem Live-Zug dieselbe Anfrage bearbeiten und zeichnet auf ---
  const schattenKfg = pd.schatten;
  const schatten = new SchattenRekorder({
    konfig: schattenKfg,
    adapter: baueAdapter(schattenKfg),
    spielmodus,
    ruhe: () => runner.ruhe?.an?.() ?? false,
  });
  egress.beobachter = schatten;
  const einreihen = (e) => ingress.einreihen(e);

  welt.beiHerzschlag = async (bild) => {
    const { meldungen, einreihen: neue } = reflexe.beiHerzschlag(bild);
    await melden(meldungen);
    for (const e of neue ?? []) await einreihen(e);
  };
  welt.start();

  // --- Bausteine, die Ereignisse erzeugen: nur mit Eingang ---
  const bausatz = { cfg, hub, harness: runner.harness, einreihen };
  const taktBausatz = { ...bausatz, ruhe: runner.ruhe, nachtwerkstatt: (opt) => runner.nachtwerkstattStarten(opt) };
  const takt = new Taktgeber(taktBausatz);
  const itsm = new ItsmWache(bausatz);
  const chat = new ChatWache(bausatz);
  const jobs = Jobmeldungen.aktiv(cfg) ? new Jobmeldungen({ cfg, einreihen }) : null;
  // Die Arbeitsschleife: im Leerlauf den wichtigsten fälligen Vorgang abarbeiten (Stufe aus pi_durable.arbeitsschleife).
  const arbeit = new Arbeitsschleife({
    cfg,
    hub,
    harness: runner.harness,
    einreihen,
    lage: lageVon({ runner, ingress }),
    spielmodus,
    tor,
    lesenTor,
    budget,
    naechsterTakt: (ab) => takt.naechsterSoll(ab),
    melden: (m) =>
      melden([
        {
          typ: 'ui_request',
          id: m.id,
          methode: 'notify',
          nutzlast: { message: m.text, notifyType: 'warning', schwere: m.schwere },
          agent: cfg.agent,
          t: Date.now(),
        },
      ]),
  });
  if (proaktiv) {
    arbeit.start();
    takt.start();
    itsm.start();
    chat.start();
    jobs?.start();
  }

  // Offene Freigaben außerhalb der App melden (Matrix, ntfy). Ohne `pi_durable.freigabe_meldung.kanaele` tut es nichts.
  // Reaktions-Chips (matrix.reaktionen.an, Vorgabe aus): Besitzer' Reaktion entscheidet über denselben Weg wie die App (von: matrix-reaktion).
  const freigabeMeldung = FreigabeMeldung.ausKonfig({ cfg, harness: runner.harness, hub, entscheiden: (id, o) => runner.entscheideFreigabe(id, o) });
  freigabeMeldung.start();

  // --- Haken im Eingang ---
  ingress.promptZusatz = () => welt.weltblock() || null;
  ingress.vorAusgabe = async (eintrag) => {
    const u = reflexe.entscheide(eintrag);
    await melden(u.meldungen);
    for (const e of u.einreihen ?? []) await einreihen(e);
    return u.urteil;
  };
  ingress.kleinesTor = (e) => istKleinLesend(e) && Boolean(lesenTor?.offen);
  ingress.beiZug = async (e, block) => {
    zugMarkieren(jobsOrdner(cfg), { klasse: e.klasse, quelle: e.quelle, bezug: e.bezug });
    if (e.bezug) itsm.bezugMerken(e.bezug);
    // Zug der Arbeitsschleife (`arbeit-<Vorgang>`): die ITSM-Wache behält den Vorgang im Auge (Besitzer' Kommentare).
    if (String(e.bezug ?? '').startsWith('arbeit-')) itsm.bezugMerken(String(e.bezug).slice('arbeit-'.length));
    aufzeichnung.schreibe('zug', { ein: e.stromId, quelle: e.quelle, klasse: e.klasse, weltblock: welt.blockFuerAufzeichnung(block) });
    // Der Schatten merkt sich Eingang, Systemkopf und Werkzeugschemata; fragen darf er erst nach dem Zugende.
    if (schatten.an()) {
      const kontext = await zugKontext(runner, wurzelId(), KONTEXT);
      schatten.beginne({ ein: e.stromId, quelle: e.quelle, klasse: e.klasse, bezug: e.bezug, eingang: e.text, text: eingabeInhalt(e, block), ...kontext });
    }
  };
  await ingress.start();

  // --- Sprachkanal (docs/current/RUNNER-SPRACHE.md): spricht und hört nicht selbst, hält nur die Regeln. Proaktiv ist aus, solange
  // `sprache.proaktiv.an` nicht gesetzt ist. Ruhe-Schalter: sobald `runner.ruhe` existiert (Zweig feat/ruhe-schalter), gilt er hier.
  // Kalender (nur lesen) und Mitteilungsweg (ohne eingetragene Kanäle `sprache.mitteilung.kanaele` sendet er nichts) aus der Konfiguration.
  const anschluss = anschluesse({ cfg, hub });
  const sprache = new Sprache({
    cfg,
    runner,
    sperre: sperreAus({ ruhe: runner.ruhe, spielmodus }),
    tor: torAusHub(hub),
    kalender: anschluss.kalender,
    mitteilen: anschluss.mitteilen,
    datei: cfg.sprache?.datei ?? null,
  });
  // E1: Vorrang der Sprache auf GPU1. Die Provider-Kette (Zweig feat/ersatzdenker-schatten) gibt es auf diesem Stand noch nicht; sobald sie da ist
  // (`runner.kette`), fragt sie `zusatzSperre(name, {gespraech})` vor jeder Wahl (RUNNER-SPRACHE.md#vorrang-gpu1). Bis dahin ist es nur der Zustand.
  runner.spracheSperre = kettenSperre(sprache);
  if (runner.kette) runner.kette.zusatzSperre = runner.spracheSperre;
  sprache.start();

  // --- Gedächtnis (S5): Tagesprotokoll liest den Gesprächsverlauf mit; Index-Abgleich im Hintergrund ---
  const gedaechtnis = runner.gedaechtnis;
  const protokoll = new Tagesprotokoll({ gedaechtnis, aufzeichnung });
  egress.mitleser = (id, e) => protokoll.beobachte(id, e);
  gedaechtnis.start();

  // --- Steuerkanal (wie im RPC-Runner auf 127.0.0.1:18435; im Schatten per FYOS_STEUER_PORT woanders) ---
  const steuer = erstelleSteuerkanal({ cfg, runner, ingress, hub, welt, takt, aufzeichnung, budget, tor, lesenTor, spielmodus, egress, reflexe, itsm, chat, stimme, gedaechtnis, freigabeMeldung, arbeit, schatten, zusatz: async () => ({ nachtwerkstatt: await runner.nachtwerkstattZustand(), sprache: sprache.zustand() }) });
  await steuer.starten();

  // Verwaltung: Sicht und Befehle für die Hub-App `runner` (Server, Token Pflicht). `schliessen` ist unten als Funktion erklärt.
  const verwaltung = erstelleVerwaltung({
    cfg,
    runner,
    ingress,
    spielmodus,
    tor,
    lesenTor,
    egress,
    budget,
    fehler,
    zugmessung,
    aufzeichnung,
    gestartet,
    build: buildInfo(),
    beenden: (signal, code) => schliessen(signal, code),
  });

  // Hub-Aufgaben (MCP Tasks): fragt den Hub nach gestarteten Aufgaben und stellt Ergebnisse als Eingang `aufgabe` zu.
  const aufgaben = new AufgabenWaechter({ runner, hub: runner.hub, cfg });
  await aufgaben.start();

  const server = erstelleServer({ runner, cfg, verwaltung, sprache });
  await new Promise((fertig, scheitern) => {
    server.once('error', scheitern);
    server.listen(pd.port, pd.host, () => {
      server.off('error', scheitern);
      fertig();
    });
  });

  const sicht = oeffentlicheSicht(cfg);
  console.log(`[fyos-runner] ${sicht.agent} auf ${sicht.device.name} (${sicht.device.kind})`);
  console.log(`[fyos-runner] Client: http://${pd.host}:${pd.port}/`);
  console.log(`[fyos-runner] Gerät: ${sicht.device.id} · Speicher: ${sicht.storage}`);
  console.log(`[fyos-runner] Hub: ${sicht.hub} · Modell: ${sicht.model.default} / ${sicht.model.max}`);
  console.log(`[fyos-runner] Arbeitsbereiche: ${Object.keys(cfg.arbeitsbereiche).join(', ')}`);
  console.log(`[fyos-runner] Eingang: ${proaktiv ? 'AN (Takt, Wachen, Jobs laufen)' : 'aus (Schatten)'}`);
  console.log(
    `[fyos-runner] Token: ${tokenQuelle.quelle}${tokenQuelle.datei ? ` (${tokenQuelle.datei}, nur Besitzer lesbar)` : ''}`,
  );

  if (bindung.art === 'netz') {
    console.log(`[fyos-runner] ACHTUNG: gebunden an ${pd.host} (Netz) — erreichbar nur mit Token; kein Wildcard`);
  }

  let schliesst = false;
  async function schliessen(signal, code = 0) {
    if (schliesst) return;
    schliesst = true;
    console.log(`[fyos-runner] ${signal}: schließe`);
    verwaltung.stop();
    tor?.stop();
    lesenTor?.stop();
    welt.stop();
    budget.stop();
    schatten.schliessen();
    jobs?.stop();
    await Promise.allSettled([arbeit.stop(), takt.stop(), itsm.stop(), chat.stop(), freigabeMeldung.stop()]);
    await aufgaben.stop().catch(() => {});
    await ingress.stop().catch(() => {});
    await egress.stop().catch(() => {});
    await stimme.leeren().catch(() => {});
    await sprache.stop().catch(() => {});
    gedaechtnis.stop();
    await protokoll.leeren().catch(() => {});
    await steuer.beenden().catch(() => {});
    await new Promise((fertig) => {
      server.close(() => fertig());
      server.closeIdleConnections?.();
      // Offene Ströme (SSE) würden das Schließen sonst bis zum Zeitlimit von systemd aufhalten.
      setTimeout(() => server.closeAllConnections?.(), 2000).unref?.();
    });
    await runner.close().catch(() => {});
    process.exit(code);
  }
  process.on('SIGINT', () => void schliessen('SIGINT'));
  process.on('SIGTERM', () => void schliessen('SIGTERM'));

  runner.harness.closed.then((ende) => {
    if (ende.reason === 'failed') {
      console.error('[fyos-runner] Harness ist fehlgeschlagen; Neustart nötig.', ende.error);
      void schliessen('Harness-Fehler', 1);
    }
  });
}

main().catch((fehler) => {
  console.error(`[fyos-runner] Start fehlgeschlagen: ${fehler?.stack ?? fehler}`);
  process.exit(1);
});
