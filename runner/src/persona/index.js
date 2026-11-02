/**
 * persona/index.js — fasst die Persona-Erweiterungen zusammen.
 *
 * Bericht, Redaktion, Wache, Matrix, Unteragenten, Kontext (mit Repo-Regeln und `bereich`), Gedächtnis (S5, wenn
 * eingeschaltet), Maya und das Regelwerk. Der Zusammenbau steckt `sections`, `hooks` und `tools` in `defineExtension` (src/extension.js).
 *
 * Nicht dabei, bewusst: fyos-freigabe (Besitzer, 24.10.2026: nur Destruktives geht durch eine Freigabe),
 * fyos-befehlswaechter (src/waechter.js), fyos-web, fyos-desktop (src/web.js, src/desktop.js),
 * fyos-hintergrund (anderer Auftrag).
 */
import { abschnitt as section } from '../lauf/index.js';
import { agentenWerkzeuge } from './agenten.js';
import { berichtWerkzeuge } from './bericht.js';
import { gedaechtnisSektionen, gedaechtnisWerkzeuge } from './gedaechtnis.js';
import { geheimnisWacheHooks } from './geheimnis-wache.js';
import { kontextSektionen, kontextWerkzeuge } from './kontext.js';
import { matrixWerkzeuge } from './matrix.js';
import { mayaBeitrag } from './maya.js';
import { redaktionHooks } from './redaktion.js';
import { ladeRegelwerk, regelwerkFuerNeuenRunner } from './regelwerk.js';
import { wacheHooks } from './wache.js';

/**
 * @param {{ cfg: object, hub?: object, runner?: object, env?: object, fetch?: Function, cwdFuer?: Function, gedaechtnis?: object }} optionen
 *   `runner` darf fehlen (Tests); sonst nur für `runner.cwdFuer`, falls der Runner so etwas anbietet.
 *   `gedaechtnis` ist die Gedächtnis-Instanz (src/persona/gedaechtnis.js); ohne sie oder ausgeschaltet gibt es weder Abschnitt noch Werkzeuge.
 * @returns {{ sections: object[], hooks: object[], tools: object[] }}
 */
export function ginnyErweiterung({ cfg, hub: _hub, runner, env = process.env, fetch: holen, cwdFuer, gedaechtnis } = {}) {
  const cwd = cwdFuer ?? (typeof runner?.cwdFuer === 'function' ? (id) => runner.cwdFuer(id) : undefined);

  // Das Regelwerk ist Ginnys Identität: ein stabiler Abschnitt, bei jedem Zug neu gelesen (unverändert = gleicher Text).
  const regelwerk = section(
    'persona-regelwerk',
    () => regelwerkFuerNeuenRunner(ladeRegelwerk(cfg)).trim() || undefined,
    { tag: false },
  );

  // Das Regelwerk stammt vom RPC-Runner. Wo der neue Runner anders heißt oder arbeitet, gilt dieser Abschnitt.
  const zusatz = section(
    'persona-regelwerk-durable',
    () =>
      ladeRegelwerk(cfg).trim()
        ? [
            'Hinweis zum Lauf auf pi-durable (gilt vor dem Regelwerk, wo beide sich widersprechen):',
            '- Eingänge beginnen mit „Eingang von <Quelle> · Bezug <Id>.“ statt „[Ereignis aus …]“.',
            '- Es gibt ein Hauptgespräch und Läufe (aufgabe_starten, eigene Kindgespräche) statt Haupt- und eigener Sitzung. Ein Lauf endet mit persona_bericht.',
            '- Werkzeuge: read, write, edit, bash (ls, grep, find über bash; kein codemode), knoten_befehl, web_suchen, web_holen, browser, desktop_*, zustand_lesen/schreiben, aufgabe_starten, hintergrund_*, bereich, kontextbuch_*, unteragent, persona_bericht, matrix_senden. Der Hub: hub_suchen → hub_schema → hub_aufrufen.',
            '- Nur Zerstörendes geht durch eine Freigabe. Zerstörender Shell-Befehl: freigabe_bitten(aktion, werkzeug: "bash", befehl: "<genau dieser Befehl>"); nach der Zustimmung denselben Befehl noch einmal ausführen. Zerstörendes Hub-Werkzeug: freigabe_bitten, dann die Kennung als freigabe_id. Freigaben laufen allein über freigabe_bitten im Runner und sind auf jedem Gerät im Client zu sehen; ein ITSM-Vorgang dient der Nachverfolgung von Arbeit, nicht der Freigabe.',
            '- kubectl delete job … ist erlaubt (Entscheidungsbuch 530).',
          ].join('\n')
        : undefined,
    { tag: false },
  );

  const maya = mayaBeitrag();

  return {
    sections: [regelwerk, zusatz, ...kontextSektionen({ cfg, env }), ...gedaechtnisSektionen(gedaechtnis), ...maya.sections],
    // Redaktion (schwärzt Ausgaben), Geheimnis-Wache (keine Secret-Werte in Ausgangstexten), Wache (Zerstörendes).
    hooks: [...redaktionHooks(), ...geheimnisWacheHooks(), ...wacheHooks({ cfg, env, cwdFuer: cwd }), ...maya.hooks],
    tools: [
      ...berichtWerkzeuge({ env }),
      ...matrixWerkzeuge({ env, ...(holen ? { fetch: holen } : {}) }),
      ...agentenWerkzeuge({ cfg, env, cwdFuer: cwd }),
      ...kontextWerkzeuge({ env }),
      ...gedaechtnisWerkzeuge(gedaechtnis),
      ...maya.tools,
    ],
  };
}
