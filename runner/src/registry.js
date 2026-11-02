/**
 * registry.js — was der Agent kann.
 *
 * CodingTools bringt Lesen, Schreiben, Bearbeiten und Bash mit; die FYOS-Extension bringt
 * Identität, Hub, geteilter Zustand, Freigaben und Aufgaben. Beide liegen in einem Registry,
 * das beim Start neu gebaut wird. Die Gespräche speichern nur die Namen der Extensions, nicht
 * den Code — deshalb kann der Code aktualisiert werden, ohne die Gespräche zu verlieren.
 *
 * Der Sprach-Agent (sprache-agent.js) ist eine dritte Extension, die nur das Sprachgespräch wählt: Sie liegt im Registry,
 * gehört aber nicht zur Standardauswahl (`standard`), sonst bekäme jedes Gespräch ihren Kopf und ihre Werkzeuge.
 */
import { registerErzeugen as createRegistry, STANDARD_WERKZEUGE as CodingTools } from './lauf/index.js';
import { fyosExtension } from './extension.js';
import { erstelleHarness2Pilot, harness2Anlegen } from './harness2-lauf.js';
import { erstelleLauf, laufAnlegen } from './lauf.js';
import { erstelleNachtwerkstatt, nachtAnlegen } from './nachtwerkstatt-lauf.js';
import { erstelleNachtTor, nachtKonfig } from './nachtwerkstatt.js';
import { spracheErweiterung } from './sprache-agent.js';
import { hubLesen } from './wachen-zustand.js';

export function baueRegistry(cfg, { hub, browser, desktop, cwdFuer, spielmodus, zugKontext, gedaechtnis, knoten, nachtJetzt, spracheHaken } = {}) {
  const registry = createRegistry();
  const Lauf = erstelleLauf(cfg);
  // Das Nachttor gilt für alle Aufgaben, die `nachtgate` setzen (Nachtwerkstatt und ihr Harness2-Pilot).
  const tor = erstelleNachtTor({ hub, spielmodus, nk: nachtKonfig(cfg), jetzt: nachtJetzt, hubLesen });
  const Harness2Pilot = erstelleHarness2Pilot(cfg, { spielmodus, gate: tor });
  const Nachtwerkstatt = erstelleNachtwerkstatt(cfg, { spielmodus, tor, knoten, harness2Task: Harness2Pilot, jetzt: nachtJetzt });
  const extension = fyosExtension({ cfg, hub, Lauf, laufAnlegen, Harness2Pilot, Nachtwerkstatt, browser, desktop, cwdFuer, spielmodus, zugKontext, gedaechtnis });
  registry.install(CodingTools);
  registry.install(extension);
  // Nur mit eingeschaltetem Sprach-Agenten: sonst bleibt alles wie vorher (keine Auswahl in den Einstellungen nötig).
  const sprache = cfg.sprache?.agent?.an === true ? spracheErweiterung({ cfg, hub, haken: () => spracheHaken ?? {} }) : null;
  if (sprache) registry.install(sprache);
  return {
    registry,
    Lauf,
    extension,
    laufAnlegen,
    Harness2Pilot,
    harness2Anlegen,
    Nachtwerkstatt,
    nachtAnlegen,
    sprache,
    standard: sprache ? [CodingTools, extension] : null,
  };
}
