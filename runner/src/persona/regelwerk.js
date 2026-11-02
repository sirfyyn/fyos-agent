/**
 * persona/regelwerk.js — Ginnys Regelwerk (`persona-system.md`) laden und für den neuen Runner anpassen.
 *
 * Der Pfad steht in `cfg.pi_durable.systemPrompt`. Vorgabe: `persona-system.md` neben der Konfigurationsdatei
 * (`agent-runner.json`), sonst im Runner-Ordner. Gibt es die Datei nicht, ist der Text leer.
 *
 * Die Datei selbst bleibt unverändert (der alte Runner nutzt sie). `regelwerkFuerNeuenRunner` ersetzt nur
 * die Namen, die im neuen Runner anders heißen und eindeutig sind: Hub-Werkzeuge und Sitzungs-Begriffe.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_RUNNER, pfadAufloesen } from '../config.js';

/** Liest das Regelwerk; leerer Text, wenn die Datei fehlt oder nicht lesbar ist. */
export function ladeRegelwerk(cfg) {
  const gesetzt = cfg?.pi_durable?.systemPrompt;
  let pfad;
  if (typeof gesetzt === 'string' && gesetzt.trim()) {
    pfad = pfadAufloesen(gesetzt.trim());
  } else {
    const quelle = cfg?.quelle;
    const basis = typeof quelle === 'string' && quelle.startsWith('/') ? dirname(quelle) : REPO_RUNNER;
    pfad = join(basis, 'persona-system.md');
  }
  try {
    if (!existsSync(pfad)) return '';
    return readFileSync(pfad, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Bekannte Namen des alten Runners → Namen des neuen, in der Reihenfolge der Anwendung (längere zuerst).
 * Nur eindeutige Ersetzungen. Hub-Werkzeug-Ids wie `wissen.suchen` oder `itsm.anlegen` bleiben, denn sie
 * werden im neuen Runner weiter über `hub_aufrufen` gerufen.
 */
export const ERSETZUNGEN = [
  ['`hub__search_tools` → `hub__schema` → `hub__call_tool`', '`hub_suchen` → `hub_schema` → `hub_aufrufen`'],
  ['hub__search_tools', 'hub_suchen'],
  ['hub__call_tool', 'hub_aufrufen'],
  ['hub__schema', 'hub_schema'],
];

export function regelwerkFuerNeuenRunner(text) {
  let aus = String(text ?? '');
  for (const [alt, neu] of ERSETZUNGEN) aus = aus.split(alt).join(neu);
  return aus;
}
