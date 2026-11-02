/**
 * persona/kontext.js — Kontextbuch und Repo-Regeln für den Agenten.
 *
 * Port von `fyos-kontext`. Zwei Aufgaben für Sitzungen, die lang werden und Bereiche wechseln:
 *
 * 1. Kontextbuch. Eine Markdown-Datei je Gespräch (<Ablage>/<gespraechs-id>.md), die der Agent selbst
 *    umschreibt (nicht anhängt). Sie steht bei jedem Zug als Abschnitt `kontextbuch` im Prompt, also nach
 *    jeder Verdichtung und jedem Neustart wieder da. Werkzeuge: kontextbuch_lesen, kontextbuch_schreiben.
 *    Ablage: FYOS_KONTEXT_DIR, Vorgabe /var/lib/fyos-agent/kontext.
 *
 * 2. Repo-Regeln. Wer in einem Arbeitsbereich arbeitet, soll AGENTS.md und CLAUDE.md dieses Repos kennen
 *    (gekürzt, Abschnitt `repo_regeln`). Welcher Bereich gilt: im alten Runner die Hinweiszeile des Auftrags
 *    („[Arbeitsbereich: Titel (/pfad). …]“) oder ~/bereich-aktuell. Hier gilt zuerst eine solche Hinweiszeile,
 *    falls ein Aufrufer sie mitgibt, dann der Arbeitsordner des Gesprächs (`agent.cwd`; ein bekannter
 *    Bereich, „standard“ gilt als ausdrückliche Wahl „keiner“), dann ~/bereich-aktuell.
 *
 * Dazu das Werkzeug `bereich`: dünne Hülle um den Befehl `bereich` (scripts/persona/umgebung/bin/bereich), damit
 * dieselbe Logik gilt wie in der Shell. FYOS_BEREICH_BEFEHL (JSON-Liste) ersetzt den Befehl, z. B. in Tests.
 *
 * Unterschiede: Die Kennung ist die Gesprächs-Id (nicht die pi-Sitzungs-Id); unzulässige Zeichen werden zu `_`.
 * Standardordner und Bereichsliste kommen aus `cfg` (dieselbe Datei agent-runner.json), nicht aus einer zweiten Lektüre.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Schema as Type, werkzeug as defineTool, abschnitt as section } from '../lauf/index.js';

const ABLAGE_VORGABE = '/var/lib/fyos-agent/kontext';
export const BUCH_MAX = 12_000; // Zeichen; ein Kontextbuch soll knapp bleiben, sonst frisst es den Zug
export const REGEL_MAX = 9_000; // Zeichen je Datei
const REGELDATEIEN = ['AGENTS.md', 'CLAUDE.md'];
const HINWEIS = /^\s*\[Arbeitsbereich: ([^\n]*?) \((\/[^)\n]+)\)\./;
const KENNUNG = /^[A-Za-z0-9_-]{1,80}$/;

const text = (t, details) => ({ output: [{ type: 'text', text: t }], ...(details !== undefined ? { details } : {}) });

export function kuerzen(s, max, was) {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n[… ${was} gekürzt: ${s.length - max} Zeichen fehlen; ganze Datei lesen]`;
}

function lesen(pfad) {
  try {
    if (!existsSync(pfad) || statSync(pfad).size > 2_000_000) return '';
    return readFileSync(pfad, 'utf8');
  } catch {
    return '';
  }
}

/** Standardordner und Bereichsliste aus der Runner-Konfiguration (dieselbe Quelle wie der Befehl `bereich`). */
function bereichsordner(cfg) {
  const bereiche = cfg?.arbeitsbereiche ?? {};
  const standard = String(cfg?.pi?.arbeitsordner || bereiche.standard?.pfad || '/var/lib/fyos-agent/arbeit');
  const ordner = new Set();
  for (const e of Object.values(bereiche)) if (e && typeof e.pfad === 'string') ordner.add(e.pfad);
  return { standard, ordner, bereiche };
}

/** Der Bereich, in dem `cwd` liegt (der längste passende Pfad), oder null. */
function bereichZuCwd(cwd, bereiche) {
  let beste = null;
  for (const [name, e] of Object.entries(bereiche)) {
    const p = e?.pfad;
    if (typeof p !== 'string' || !p) continue;
    const q = p.replace(/\/+$/, '');
    if (cwd === q || cwd.startsWith(`${q}/`)) {
      if (!beste || q.length > beste.pfad.length) beste = { name, titel: e.titel ?? name, pfad: p };
    }
  }
  return beste;
}

/**
 * Welcher Ordner gilt für diesen Zug? null = keiner (Standard oder unbekannt). Nur Ordner aus der
 * Bereichsliste zählen. `umg` = { cfg, env }; `cwd` ist der Arbeitsordner des Gesprächs.
 */
export function geltenderBereich(prompt, umg = {}, cwd = '') {
  const env = umg.env ?? process.env;
  const { standard, ordner, bereiche } = bereichsordner(umg.cfg);
  const h = HINWEIS.exec(prompt || '');
  let pfad = '';
  let name = '';
  if (h) {
    name = h[1];
    pfad = h[2];
  } else if (cwd && bereichZuCwd(cwd, bereiche)) {
    const b = bereichZuCwd(cwd, bereiche);
    if (b.name === 'standard') return null; // ausdrückliche Wahl „Standard“ sticht den Merker
    name = b.titel;
    pfad = b.pfad;
  } else {
    const merker = lesen(join(env.HOME || '/var/lib/fyos-agent', 'bereich-aktuell')).trim();
    if (!merker || merker === 'standard') return null;
    // `bereich` schreibt den Namen; der Pfad steht in der Konfiguration unter arbeitsbereiche[name].pfad
    pfad = String(bereiche?.[merker]?.pfad || '');
    name = String(bereiche?.[merker]?.titel || merker);
  }
  if (!pfad || pfad === standard || !ordner.has(pfad)) return null;
  return { name, pfad };
}

export function repoRegeln(pfad) {
  const teile = [];
  for (const d of REGELDATEIEN) {
    const t = lesen(join(pfad, d)).trim();
    if (t) teile.push(`### ${d}\n${kuerzen(t, REGEL_MAX, d)}`);
  }
  return teile.join('\n\n');
}

const kennungVon = (id) => {
  const k = String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return KENNUNG.test(k) ? k : '';
};

const STAND_ZEILE = /^(#+[ \t]*Stand\b[^\n]*?)(\d{1,2}):\d{2}/m;

/**
 * Die Uhrzeit der Standzeile („# Stand 25.10.2026, ~08:35 (pi-durable-Runner)“) wird im Prompt auf die Stunde gerundet
 * („~08 Uhr“). Schreibt der Agent das Buch nur wegen einer neuen Uhrzeit neu, bleibt der Abschnitt im Prompt gleich, und
 * pi-durable schickt keine Aktualisierung (jede Aktualisierung ist neuer Text im Gespräch). `kontextbuch_lesen` und die
 * Datei zeigen die genaue Zeit weiter. Nur die erste Standzeile; kein anderer Text wird verändert.
 */
export function standGerundet(buch) {
  return String(buch ?? '').replace(STAND_ZEILE, (_alles, davor, stunde) => `${davor}${stunde.padStart(2, '0')} Uhr`);
}

export function kontextSektionen({ cfg, env = process.env } = {}) {
  const ablage = env.FYOS_KONTEXT_DIR || ABLAGE_VORGABE;
  const buchPfad = (id) => join(ablage, `${id}.md`);

  const kontextbuch = section('kontextbuch', (input) => {
    const id = kennungVon(input?.conversationId);
    const buch = id ? standGerundet(lesen(buchPfad(id)).trim()) : '';
    return (
      'Dein Kontextbuch dieses Gesprächs (von dir geführt; überlebt Verdichtung und Neustart). Schreibe es mit kontextbuch_schreiben ' +
      'um (nicht anhängen), sobald ein Teilschritt fertig ist, ein Beschluss fällt oder du etwas findest, das du nach einer ' +
      'Verdichtung brauchst: Auftrag, Stand, Offenes, Fallen, Pfade und Kommandos. Knapp halten.\n' +
      (buch || '(noch leer)')
    );
  });

  const repo = section('repo_regeln', (input) => {
    const b = geltenderBereich('', { cfg, env }, String(input?.agent?.cwd ?? ''));
    if (!b) return undefined;
    const r = repoRegeln(b.pfad);
    if (!r) return undefined;
    return (
      `Regeln des Repos im Arbeitsbereich „${b.name}“ (${b.pfad}). Sie gelten für deine Arbeit dort, soweit sie nicht Besitzer' ` +
      'Anweisung oder deinen Grenzen widersprechen.\n' +
      r
    );
  });

  return [kontextbuch, repo];
}

export function kontextWerkzeuge({ env = process.env } = {}) {
  const ablage = env.FYOS_KONTEXT_DIR || ABLAGE_VORGABE;
  const buchPfad = (id) => join(ablage, `${id}.md`);

  // Arbeitsbereich wechseln als Werkzeug: dünne Hülle um den Befehl `bereich`, damit dieselbe Logik gilt wie in der
  // Shell (Liste aus der Runner-Konfiguration, Warnung vor Nicht-Committetem, Merker ~/bereich-aktuell).
  const bereich = defineTool({
    name: 'bereich',
    description:
      'Wechselt deinen Arbeitsbereich oder zeigt ihn: aktion=liste (alle mit Git-Stand), rein (name; pull=true bringt das Repo vorher ' +
      'auf den Stand von origin), raus (zurück in den Standard, warnt vor Nicht-Committetem), wo. Ein Werkzeug kann dein Arbeitsverzeichnis ' +
      'nicht verstellen: nimm danach `cd <Ordner> && …` in jedem bash-Befehl. Mit rein lädt das nächste Mal auch AGENTS.md und CLAUDE.md des Repos.',
    parameters: Type.Object({
      aktion: Type.Union(['liste', 'rein', 'raus', 'wo'].map((w) => Type.Literal(w))),
      name: Type.Optional(Type.String({ pattern: '^[a-z0-9_-]{1,40}$' })),
      pull: Type.Optional(Type.Boolean()),
    }),
    execute: async (p) => {
      const aktion = String(p?.aktion ?? '');
      const args = [aktion];
      if (aktion === 'rein') {
        if (!KENNUNG.test(String(p?.name ?? ''))) return text('rein braucht einen Namen (siehe aktion=liste).');
        args.push(String(p.name));
        if (p.pull) args.push('--pull');
      } else if (!['liste', 'raus', 'wo'].includes(aktion)) return text('aktion muss liste, rein, raus oder wo sein.');
      const [prog, ...vor] = env.FYOS_BEREICH_BEFEHL ? JSON.parse(env.FYOS_BEREICH_BEFEHL) : ['bereich'];
      return await new Promise((fertig) => {
        execFile(prog, [...vor, ...args], { env, timeout: 90_000, maxBuffer: 200_000 }, (fehler, aus, err) => {
          const t = `${aus}${err ? `\n${err}` : ''}`.trim();
          fertig(text(fehler && !t ? `bereich fehlgeschlagen: ${fehler.message}` : t || '(keine Ausgabe)', { aktion, exit: fehler ? (typeof fehler.code === 'number' ? fehler.code : 1) : 0 }));
        });
      });
    },
  });

  const buchLesen = defineTool({
    name: 'kontextbuch_lesen',
    description: 'Liest dein Kontextbuch dieses Gesprächs (steht auch im Prompt-Abschnitt kontextbuch).',
    parameters: Type.Object({}),
    replay: 'safe',
    execute: async (_args, api) => {
      const id = kennungVon(api?.conversationId);
      if (!id) return text('Keine Gesprächskennung; Kontextbuch nicht verfügbar.');
      const buch = lesen(buchPfad(id)).trim();
      return text(buch || '(Kontextbuch ist leer)', { zeichen: buch.length });
    },
  });

  const buchSchreiben = defineTool({
    name: 'kontextbuch_schreiben',
    description:
      `Ersetzt dein Kontextbuch dieses Gesprächs durch den übergebenen Markdown-Text (höchstens ${BUCH_MAX} Zeichen). Schreibe den ` +
      'ganzen Stand neu, nicht nur das Neue: Auftrag, Stand, Offenes, Fallen, wichtige Pfade und Kommandos. Keine Geheimnisse hineinschreiben.',
    parameters: Type.Object({ inhalt: Type.String({ maxLength: BUCH_MAX }) }),
    // Ersetzen mit demselben Text ist wiederholbar.
    replay: 'safe',
    execute: async (p, api) => {
      const id = kennungVon(api?.conversationId);
      if (!id) return text('Keine Gesprächskennung; Kontextbuch nicht gespeichert.');
      const t = String(p?.inhalt ?? '');
      if (t.length > BUCH_MAX) return text(`Zu lang (${t.length} Zeichen, erlaubt ${BUCH_MAX}). Kürzer fassen und neu schreiben.`);
      try {
        mkdirSync(ablage, { recursive: true, mode: 0o750 });
        const ziel = buchPfad(id);
        const tmp = `${ziel}.neu`;
        writeFileSync(tmp, t.endsWith('\n') ? t : `${t}\n`, { mode: 0o640 });
        renameSync(tmp, ziel);
      } catch (f) {
        return text(`Kontextbuch nicht gespeichert: ${String(f?.message ?? f).slice(0, 200)} (Ablage ${ablage}; FYOS_KONTEXT_DIR setzen).`);
      }
      return text(`Kontextbuch gespeichert (${t.length} Zeichen).`, { zeichen: t.length });
    },
  });

  return [bereich, buchLesen, buchSchreiben];
}
