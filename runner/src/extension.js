/**
 * extension.js — Identität, Regeln und Werkzeuge des FYOS-Agenten.
 *
 * Die Abschnitte sind bewusst kurz und stabil: pi-durable legt sie als System-Einträge ab
 * und sendet nur Änderungen erneut. Ein Abschnitt, der bei jedem Aufruf eine andere Uhrzeit
 * nennt, würde den Prompt-Cache zerstören. Der geteilte Zustand wird deshalb nur als
 * Schlüsselliste und Änderungszeit genannt, nicht als vollständiges JSON.
 */
import { WERKZEUG_AUFRUF as ToolTask, erweiterung as defineExtension, haken as hook, abschnitt as section } from './lauf/index.js';
import { Zustand } from './documents.js';
import { Hub } from './hub.js';
import { hubWerkzeuge, zustandWerkzeuge, aufgabenWerkzeuge } from './tools.js';
import { knotenWerkzeuge } from './knoten.js';
import { webWerkzeuge } from './web.js';
import { browserWerkzeuge, Browser } from './browser.js';
import { desktopWerkzeuge, Desktop } from './desktop.js';

import { pruefeBefehl } from './waechter.js';
import { befehlFreigegeben, freigabeHinweis } from './freigabe-befehl.js';
import { ginnyErweiterung } from './persona/index.js';
import { jobWerkzeuge } from './jobs.js';
import { FREIGABE_SATZ } from './stimme.js';
import { nachtWerkzeuge } from './nachtwerkstatt-lauf.js';
import { aufruferHaken } from './aufrufer.js';

const FORK_BOMBE = /:\(\)\s*\{\s*:\|:\&\s*\};:/;

/**
 * Abschnitte, deren Text sich im Betrieb ändert (Kontextbuch mit „# Stand …“, Gedächtnis-Index, geteilter Zustand mit
 * Änderungszeit, Repo-Regeln je Arbeitsbereich). Sie stehen hinten im Systemkopf: alles davor (Regelwerk, Rolle, Werkzeugregeln,
 * rund 20.000 Zeichen) bleibt über Verdichtungen und neue Gespräche Byte für Byte gleich und damit im Prompt-Cache. Die Reihenfolge
 * unter ihnen ist so gewählt, dass ein Abschnitt, der erst später dazukommt oder wegfällt (`repo_regeln` beim Wechsel des
 * Arbeitsbereichs), hinten steht: pi-durable ersetzt sonst bei geänderter Reihenfolge alle Abschnitte auf einmal.
 */
export const FLUECHTIGE_ABSCHNITTE = ['kontextbuch', 'gedaechtnis', 'fyos-zustand', 'repo_regeln'];

export function ordneAbschnitte(abschnitte) {
  const rang = (s) => FLUECHTIGE_ABSCHNITTE.indexOf(s.key);
  const fest = abschnitte.filter((s) => rang(s) < 0);
  const fluechtig = abschnitte.filter((s) => rang(s) >= 0).sort((a, b) => rang(a) - rang(b));
  return [...fest, ...fluechtig];
}

/** Grund für eine Sperre oder `null`: Befehlswächter (VOR-4870) plus Fork-Bombe. */
function gefaehrlich(cmd, cwd) {
  const s = String(cmd ?? '');
  if (FORK_BOMBE.test(s)) return 'Fork-Bombe';
  return pruefeBefehl(s, cwd);
}

export function fyosExtension({
  cfg,
  hub = new Hub({ url: cfg.hub, agent: cfg.agent }),
  Lauf,
  laufAnlegen,
  Harness2Pilot,
  Nachtwerkstatt,
  browser,
  desktop,
  cwdFuer,
  spielmodus,
  zugKontext = null,
  gedaechtnis,
} = {}) {
  const pd = cfg.pi_durable;
  const geraet = pd.device;
  const brw = browser ?? new Browser(cfg);
  const dtp = desktop ?? new Desktop(cfg);

  const rolle = section('fyos-rolle', () => {
    const bereiche = Object.entries(cfg.arbeitsbereiche)
      .map(([name, wert]) => `- ${name}: ${wert.titel}`)
      .join('\n');
    return [
      `Du bist ${cfg.agent}, der FYOS-Agent auf dem Gerät „${geraet.name}“ (${geraet.kind}, Kennung ${geraet.id}).`,
      'FYOS heißt „For Your Own Sake“. Du arbeitest für Besitzer, nicht für eine fremde Plattform.',
      'Du sprichst Deutsch. Du bist knapp, konkret und ehrlich. Du erfindest keine Zustände, Dateien oder Ergebnisse.',
      'Was du nicht geprüft hast, hast du nicht geprüft. Was du nicht getan hast, hast du nicht getan.',
      'Bevor du eine Wirkung behauptest, belege sie mit einem Werkzeugergebnis.',
      '',
      'Arbeitsbereiche (Name → was dort liegt):',
      bereiche,
      '',
      'Der Lauf ist dauerhaft. Ein Absturz ist kein Neuanfang: pi-durable setzt am letzten Checkpoint fort.',
      'Mehrere Clients können dasselbe Gespräch sehen; ein Mensch kann jederzeit steuern, abbrechen oder freigeben.',
      '',
      'Du hast die Möglichkeiten eines Menschen am Terminal: bash, Dateien lesen/schreiben/bearbeiten,',
      'ssh auf jeden FYOS-Knoten, kubectl/docker, Web lesen. Du bist nicht auf einen Ordner eingesperrt.',
      'Arbeite mit Besitzer, wenn er da ist; arbeite ohne ihn autonom weiter. Kleines selbst, Schweres als Vorgang.',
      'Sprache kommt als Text an (Mikrofon im Client), du antwortest mit Text und Werkzeugen.',
    ].join('\n');
  }, { tag: false });

  const werkzeugRegeln = section('fyos-werkzeuge', () => {
    return [
      'Werkzeuge:',
      '- Hub: hub_suchen → hub_schema → hub_aufrufen. Nie einen Hub-Werkzeugnamen raten.',
      '- Nur zerstörende Hub-Werkzeuge brauchen eine Freigabe: freigabe_bitten, dann die Kennung als freigabe_id. Alles andere tust du einfach.',
      '- Jede Freigabe braucht einen Kurzkontext (Feld kontext, 3–5 Sätze, Deutsch, ohne Geheimnisse und ohne rohen Befehl): was und wo, warum jetzt, Wirkung, Risiko, Rückweg. Besitzer soll in 10 Sekunden entscheiden können.',
      '- Lange Hub-Werkzeuge (medien_bild, Bauten, Experimente): hub_aufrufen mit aufgabe=true, Zug beenden; das Ergebnis kommt als Eingang „aufgabe“. Stand, Abbruch, Eingabe: hub_aufgabe.',
      '- Geteilter Zustand: zustand_lesen / zustand_schreiben. Er gilt für alle Agenten auf diesem Gerät und ist dauerhaft.',
      '- Lange Arbeit: aufgabe_starten. Der Lauf bekommt ein eigenes Gespräch, Phasen und einen Abschluss.',
      '- Dateien und Befehle: read, write, edit, bash. Absolute Pfade sind erlaubt; du bist nicht auf den Arbeitsbereich beschränkt.',
      '- Knoten: knoten_liste, dann knoten_befehl. Jeder Knoten (dieses Gerät, Hauptserver, TrueNAS, Jetson, Pi4, VPS) ist per ssh erreichbar.',
      '- Web: web_suchen und web_holen für Fremddoku, Upstreams und Fehlermeldungen. Für FYOS-Wissen zuerst hub_suchen.',
      '- Ein Freigabewunsch blockiert nicht. Sag dem Menschen klar, worauf du wartest, und beende deinen Zug.',
      '- Ohne Menschen im Gespräch: arbeite selbst weiter; nur Zerstörendes (Löschen, Überschreiben, nicht Rückholbares) als Freigabe stellen.',
      '- Browser: browser({aktion,...}) steuert einen echten Chromium/Chrome mit eigenem Profil auf diesem Gerät. oeffnen, klicken, tippen, taste, scrollen, js, zurueck, sehen, text, schliessen. Für FYOS-Wissen zuerst hub_suchen, für reines Lesen web_holen.',
      '- Desktop: desktop_bild, desktop_fenster, desktop_eingabe_stand, desktop_starter, desktop_klick, desktop_tippen, desktop_taste, desktop_scrollen, desktop_starten, desktop_fokus. Ziel „agent“ ist dein eigener Desktop auf Hauptserver (ohne Freigabe); „mensch“ ist Besitzer Desktop und braucht dessen Freigabe. Nie Passwörter oder Schlüssel tippen.',
    ].join('\n');
  }, { tag: false });

  const zustand = section('fyos-zustand', async (input, context) => {
    const doc = await input.read.snapshot(Zustand, context);
    if (!doc) return undefined;
    const schluessel = Object.keys(doc.werte ?? {}).sort();
    return [
      `Geteilter Zustand: ${schluessel.length} Schlüssel${doc.geaendert ? `, zuletzt geändert ${new Date(doc.geaendert).toISOString()}` : ''}.`,
      schluessel.length ? `Schlüssel: ${schluessel.join(', ')}` : 'Noch leer.',
      'Werte mit zustand_lesen holen; nicht aus dem Gedächtnis zitieren.',
    ].join('\n');
  }, { tag: false });

  const wache = hook(ToolTask, {
    beforeTool: async (call, api, context) => {
      if (call.name === 'bash') {
        const cmd = call.arguments?.command;
        const cwd = call.arguments?.cwd ?? (await cwdFuer?.(api.conversationId).catch(() => null)) ?? process.cwd();
        const grund = gefaehrlich(cmd, cwd);
        if (grund && !(await befehlFreigegeben(api, cmd))) {
          const stimme = zugKontext?.istStimme(api.conversationId)
            ? ` Per Sprache: danach nur den einen Satz „${FREIGABE_SATZ}“ sagen; entscheiden kann nur die App.`
            : '';
          return { block: `BEFEHLSWÄCHTER: ${grund}. ${freigabeHinweis(cmd)}${stimme}` };
        }
      }
      if (call.name === 'write' || call.name === 'edit') {
        const pfad = String(call.arguments?.path ?? '');
        if (pfad.includes('\u0000')) return { block: 'Ungültiger Pfad.' };
      }
      return undefined;
    },
    afterTool: async (call, result) => {
      if (call.name === 'bash' && result.isError) {
        const text = (result.output ?? [])
          .filter((b) => b?.type === 'text')
          .map((b) => b.text)
          .join('\n');
        if (/permission denied|operation not permitted/i.test(text)) {
          return { ...result, diagnostics: [...(result.diagnostics ?? []), { severity: 'warn', code: 'permission', message: 'Rechte fehlen' }] };
        }
      }
      return result;
    },
  });

  // Ginnys Erweiterungen (Bericht, Redaktion, Wache, Matrix, Unteragent, Kontext, Regelwerk) und die Hintergrundjobs.
  const persona = ginnyErweiterung({ cfg, hub, cwdFuer, gedaechtnis });

  // Lokaler Modus (FYOS_RUNNER_LOKAL=1): Dateien und Befehle im gewählten Ordner, Freigabe für Zerstörendes, Web lesen. Ohne Knoten (ssh),
  // Browser, Desktop, Hintergrundjobs, Ginnys Berichte/Matrix/Unteragenten und Hub (der Hub nur, wenn ausdrücklich eine Adresse eingetragen ist).
  // Bleibt die Wache (Zerstörendes) und die Schwärzung von Geheimnissen in Ausgaben.
  if (pd.lokal === true) {
    const lokalRolle = section('fyos-rolle', () => {
      const bereiche = Object.entries(cfg.arbeitsbereiche)
        .map(([name, wert]) => `- ${name}: ${wert.titel}`)
        .join('\n');
      return [
        `Du bist der FYOS-Agent auf dem Gerät „${geraet.name}“ (${geraet.kind}). Du läufst lokal auf dem Rechner des Menschen, der mit dir spricht.`,
        'Du antwortest in der Sprache des Menschen. Du bist knapp, konkret und ehrlich. Du erfindest keine Zustände, Dateien oder Ergebnisse.',
        'Was du nicht geprüft hast, hast du nicht geprüft. Was du nicht getan hast, hast du nicht getan.',
        'Bevor du eine Wirkung behauptest, belege sie mit einem Werkzeugergebnis.',
        '',
        'Arbeitsbereiche (Name → was dort liegt):',
        bereiche,
        '',
        'Dein Arbeitsordner ist der Ordner dieser Sitzung (siehe Kopf des Gesprächs). Dateiarbeit beginnt dort.',
        'Der Lauf ist dauerhaft: ein Absturz ist kein Neuanfang, die Arbeit setzt am letzten Checkpoint fort.',
      ].join('\n');
    }, { tag: false });

    const lokalRegeln = section('fyos-werkzeuge', () => {
      return [
        'Werkzeuge:',
        '- Dateien und Befehle: read, write, edit, bash. Arbeite im Arbeitsordner der Sitzung; andere Orte nur, wenn der Auftrag es verlangt.',
        '- Nur Zerstörendes (Löschen, Überschreiben, nicht Rückholbares) braucht eine Freigabe: freigabe_bitten mit Kurzkontext (Feld kontext, 3–5 Sätze: was und wo, warum, Wirkung, Risiko, Rückweg), danach den Zug beenden. Alles andere tust du einfach.',
        '- Zerstörender Shell-Befehl: freigabe_bitten(aktion, werkzeug: "bash", befehl: "<genau dieser Befehl>"); nach der Zustimmung denselben Befehl noch einmal ausführen.',
        '- Web: web_holen für eine bekannte Adresse; web_suchen nur, wenn eine Suche eingerichtet ist.',
        '- Zugangsdaten, Schlüssel und Token liest, schreibst und nennst du nicht.',
        ...(cfg.hub ? ['- Hub: hub_suchen → hub_schema → hub_aufrufen. Nie einen Hub-Werkzeugnamen raten.'] : []),
      ].join('\n');
    }, { tag: false });

    return defineExtension({
      name: 'fyos',
      sections: [lokalRolle, lokalRegeln],
      hooks: [wache, ...persona.hooks],
      tools: [
        ...(cfg.hub ? hubWerkzeuge({ cfg, hub, zugKontext }) : hubWerkzeuge({ cfg, hub, zugKontext }).filter((w) => w.name === 'freigabe_bitten')),
        ...webWerkzeuge({ cfg }),
      ],
      tasks: [Lauf, Harness2Pilot].filter((aufgabe) => aufgabe !== undefined),
    });
  }

  return defineExtension({
    name: 'fyos',
    sections: ordneAbschnitte([...persona.sections, rolle, werkzeugRegeln, zustand]),
    hooks: [wache, aufruferHaken(), ...persona.hooks],
    tools: [
      ...persona.tools,
      ...jobWerkzeuge({ cfg, spielmodus }),
      ...nachtWerkzeuge(),
      ...hubWerkzeuge({ cfg, hub, zugKontext }),
      ...zustandWerkzeuge({ cfg }),
      ...aufgabenWerkzeuge({ cfg, Lauf, laufAnlegen }),
      ...knotenWerkzeuge({ cfg }),
      ...webWerkzeuge({ cfg }),
      ...browserWerkzeuge({ cfg, browser: brw }),
      ...desktopWerkzeuge({ cfg, desktop: dtp }),
    ],
    // Der Harness2-Pilot ist eine Aufgabe, kein Werkzeug des Agenten: gestartet wird er vom Starter über den Server.
    tasks: [
      Lauf,
      Harness2Pilot,
      ...(Nachtwerkstatt ? [Nachtwerkstatt.Nacht, Nachtwerkstatt.Dreaming, Nachtwerkstatt.Skillsmith, Nachtwerkstatt.Nodesmith] : []),
    ].filter((aufgabe) => aufgabe !== undefined),
  });
}
