#!/usr/bin/env node
/**
 * lokal.js — der Runner im lokalen Modus (Vertrag des lokalen Runners der Hülle `apps/fyos-shell`, Version 1).
 *
 *   FYOS_RUNNER_LOKAL=1 FYOS_RUNNER_TOKEN=… FYOS_RUNNER_PORT=… node src/lokal.js [--config datei]
 *
 * Gestartet wird normalerweise über `apps/fyos-agent/runner-lokal/starten.mjs`, das die Umgebung des Vertrags in diese
 * Konfiguration übersetzt (docs/current/FYOS-AGENT-HUELLE.md#lokaler-runner).
 *
 * Was läuft: Runner (SQLite-Datei, Gespräche, Werkzeuge, Freigaben) und der Server. Was NICHT läuft: Egress/Ingress zum Hub, Weltmodell,
 * Reflexe, Takt, Wachen, Arbeitsschleife, Sprache, Gedächtnis, Steuerkanal (zweiter Port), Verwaltung, Hub-Aufgaben. Das alles gehört zu
 * Persona auf Hauptserver (src/index.js). Kein Zugang zu Hauptserver, kein Hub ohne ausdrücklich eingetragene Adresse.
 * Endet bei SIGTERM/SIGINT sauber (Server zu, Harness zu) und nach spätestens 5 s hart.
 */
import { bindungPruefen, konfigurationLaden, oeffentlicheSicht } from './config.js';
import { Runner } from './runner.js';
import { erstelleServer } from './server.js';

async function main() {
  const cfg = konfigurationLaden();
  const pd = cfg.pi_durable;
  if (pd.lokal !== true) {
    console.error('[fyos-runner-lokal] Start abgelehnt: FYOS_RUNNER_LOKAL=1 fehlt (für den vollen Runner gilt src/index.js)');
    process.exit(2);
  }
  const bindung = bindungPruefen(pd);
  if (bindung.fehler) {
    console.error(`[fyos-runner-lokal] Start abgelehnt: ${bindung.fehler}`);
    process.exit(2);
  }
  // Das Token (und der Schlüssel des Modells) steht jetzt in der Konfiguration; aus der Umgebung verschwindet er, damit Befehle des
  // Agenten (bash) ihn nicht erben.
  for (const name of ['FYOS_RUNNER_TOKEN', 'FYOS_HAUSMODELL_KEY', 'FYOS_HUB_AGENT_TOKEN']) delete process.env[name];

  const runner = new Runner(cfg);
  await runner.start();
  const server = erstelleServer({ runner, cfg });
  await new Promise((fertig, scheitern) => {
    server.once('error', scheitern);
    server.listen(pd.port, pd.host, () => {
      server.off('error', scheitern);
      fertig();
    });
  });

  const sicht = oeffentlicheSicht(cfg);
  console.log(`[fyos-runner-lokal] bereit auf http://${pd.host}:${pd.port}/ · Speicher: ${sicht.storage}`);
  console.log(`[fyos-runner-lokal] Modell: ${sicht.model.default} bei ${sicht.model.baseUrl} · Hub: ${sicht.hub || 'keiner'}`);
  console.log(`[fyos-runner-lokal] erlaubte Wurzeln: ${(pd.ordnerErlaubt ?? []).join(', ') || '(keine)'}`);

  let schliesst = false;
  async function schliessen(signal) {
    if (schliesst) return;
    schliesst = true;
    console.log(`[fyos-runner-lokal] ${signal}: schließe`);
    // Harte Grenze: der Vertrag verlangt das Ende binnen 8 s.
    setTimeout(() => process.exit(0), 5000).unref();
    await new Promise((fertig) => {
      server.close(() => fertig());
      server.closeIdleConnections?.();
      // Offene Ströme (SSE) würden das Schließen sonst aufhalten.
      setTimeout(() => server.closeAllConnections?.(), 1000).unref?.();
    });
    await runner.close().catch(() => {});
    process.exit(0);
  }
  process.on('SIGINT', () => void schliessen('SIGINT'));
  process.on('SIGTERM', () => void schliessen('SIGTERM'));

  runner.harness.closed.then((ende) => {
    if (ende.reason === 'failed') {
      console.error('[fyos-runner-lokal] Harness ist fehlgeschlagen.', ende.error);
      process.exit(1);
    }
  });
}

main().catch((fehler) => {
  console.error(`[fyos-runner-lokal] Start fehlgeschlagen: ${fehler?.stack ?? fehler}`);
  process.exit(1);
});
