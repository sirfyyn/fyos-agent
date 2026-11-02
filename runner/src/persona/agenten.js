/**
 * persona/agenten.js — Unteragenten (bis zu 2 gleichzeitig, Besitzer 19.10.2026: „bis zu 2 subagenten erlaubt“).
 *
 * Port von `fyos-agenten`. Werkzeug `unteragent {aufgabe, art?, ordner?, frist_s?}` startet ein eigenes pi
 * (Kurzlauf `--mode json -p`, ohne Sitzung) mit frischem Kontext und gibt dessen Schlussantwort zurück.
 *
 *  - art = lesen (Vorgabe): nur read, grep, find, ls. art = arbeiten: zusätzlich bash, edit, write.
 *  - Zwei Plätze als Dateien <Ablage>/slot-1 und slot-2 (Prozesskennung darin), also über alle Läufe und
 *    Runner hinweg gezählt; ein Platz mit totem Prozess wird übernommen. Sind beide belegt, sagt das
 *    Werkzeug es sofort, statt zu warten. Ablage: FYOS_UNTERAGENTEN_DIR, Vorgabe /var/lib/fyos-agent/unteragenten.
 *  - Der Unteragent bekommt weder Erweiterungen noch MCP (--no-extensions --no-mcp): keinen Hub, keinen
 *    Desktop, keine Unteragenten. Die Umgebung wird ohne Variablen mit TOKEN, SECRET, KEY, PASSWORD, PASSWD
 *    im Namen vererbt. Frist Vorgabe 15 Minuten (10 s bis 60 min), Ausgabe höchstens 16 000 Zeichen.
 *    Abbruch des Zugs beendet den Unteragenten.
 *
 * Unterschied zum alten Runner: pi-durable ist kein pi-CLI. Das Kind-Programm ist deshalb nicht mehr „derselbe
 * Node mit demselben pi-Skript“, sondern `FYOS_UNTERAGENT_BEFEHL` (JSON-Liste [Programm, Argumente…]) oder `pi`
 * im PATH. Es ist der alte Weg, nicht ein dauerhaftes Kindgespräch (dafür gibt es `aufgabe_starten`).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Schema as Type, werkzeug as defineTool } from '../lauf/index.js';

const ABLAGE_VORGABE = '/var/lib/fyos-agent/unteragenten';
export const PLAETZE = 2;
const FRIST_VORGABE_S = 15 * 60;
const FRIST_MAX_S = 60 * 60;
const FRIST_MIN_S = 10;
const AUFGABE_MAX = 8000;
const AUSGABE_MAX = 16_000;
const GEHEIM = /TOKEN|SECRET|KEY|PASSWORD|PASSWD/i;
const WERKZEUGE = { lesen: 'read,grep,find,ls', arbeiten: 'read,grep,find,ls,bash,edit,write' };

const SYSTEM =
  'Du bist ein Unteragent. Erledige genau die Aufgabe, die dir gegeben wird, mit den Werkzeugen, die du hast. Du hast keinen Rückkanal: ' +
  'frage nicht nach, triff vernünftige Annahmen und nenne sie. Deine letzte Nachricht ist das Ergebnis und wird dem Auftraggeber ' +
  'unverändert gegeben: knapp, mit Pfaden und Zeilennummern als Beleg, ohne Einleitung. Wenn etwas nicht geht, sag genau was.';

const text = (t, details) => ({ output: [{ type: 'text', text: t }], ...(details !== undefined ? { details } : {}) });

function piBefehl(env) {
  if (env.FYOS_UNTERAGENT_BEFEHL) {
    try {
      const b = JSON.parse(env.FYOS_UNTERAGENT_BEFEHL);
      if (Array.isArray(b) && b.length && b.every((x) => typeof x === 'string')) return b;
    } catch {
      /* unbrauchbar: Vorgabe */
    }
  }
  return ['pi'];
}

const pidLebtEcht = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
};

export function platzNehmen(ablage, pidLebt = pidLebtEcht) {
  mkdirSync(ablage, { recursive: true, mode: 0o750 });
  for (let i = 1; i <= PLAETZE; i++) {
    const datei = join(ablage, `slot-${i}`);
    if (existsSync(datei)) {
      const pid = Number.parseInt(readFileSync(datei, 'utf8').trim(), 10);
      if (Number.isInteger(pid) && pid > 1 && pidLebt(pid)) continue;
      rmSync(datei, { force: true });
    }
    try {
      writeFileSync(datei, String(process.pid), { flag: 'wx', mode: 0o640 });
      return i;
    } catch {
      /* ein anderer hat ihn gerade genommen */
    }
  }
  return 0;
}

export function platzGeben(ablage, i) {
  rmSync(join(ablage, `slot-${i}`), { force: true });
}

/** Letzte Assistenten-Nachricht aus den JSON-Zeilen von `pi --mode json`, dazu ein Modellfehler. */
export function schlussantwort(zeilen) {
  let letzte = '';
  let fehler = '';
  for (const z of zeilen) {
    if (!z.trim()) continue;
    let e;
    try {
      e = JSON.parse(z);
    } catch {
      continue;
    }
    if (e?.type === 'message_end' && e.message?.role === 'assistant') {
      const t = (Array.isArray(e.message.content) ? e.message.content : [])
        .filter((p) => p?.type === 'text')
        .map((p) => p.text)
        .join('\n')
        .trim();
      if (t) letzte = t;
      if (e.message.stopReason === 'error' || e.message.errorMessage) fehler = String(e.message.errorMessage || 'Modellfehler');
    }
  }
  return { text: letzte, fehler };
}

/**
 * `befehl` und `pidLebt` sind für Tests austauschbar, `fristMinS` ebenso (Vorgabe 10 s wie im Schema).
 * `cwdFuer(conversationId)` liefert den Ordner des Gesprächs, wenn kein `ordner` angegeben ist.
 */
export function agentenWerkzeuge({ cfg, env = process.env, befehl, pidLebt = pidLebtEcht, fristMinS = FRIST_MIN_S, cwdFuer } = {}) {
  // Ein Unteragent darf keine Unteragenten starten: er läuft ohnehin ohne Erweiterungen; diese Zeile schützt
  // zusätzlich, falls jemand die Erweiterung ausdrücklich lädt.
  if (env.FYOS_UNTERAGENT) return [];
  const ablage = env.FYOS_UNTERAGENTEN_DIR || ABLAGE_VORGABE;

  const unteragent = defineTool({
    name: 'unteragent',
    description:
      'Gibt eine in sich geschlossene Aufgabe an einen Unteragenten (eigenes pi, frischer Kontext) und liefert dessen Schlussantwort. ' +
      'Höchstens 2 gleichzeitig (zwei Aufrufe in einer Antwort laufen parallel). Er hat weder Hub noch Desktop noch dein Kontextbuch: die ' +
      'Aufgabe muss Pfade, Ziel und gewünschte Antwortform selbst nennen. art=lesen (Vorgabe) liest nur; art=arbeiten darf auch ' +
      'Befehle ausführen und Dateien ändern. Sein Ergebnis prüfst du, bevor du es weitergibst.',
    parameters: Type.Object({
      aufgabe: Type.String({ minLength: 10, maxLength: AUFGABE_MAX }),
      art: Type.Optional(Type.Union([Type.Literal('lesen'), Type.Literal('arbeiten')])),
      ordner: Type.Optional(Type.String({ maxLength: 500 })),
      frist_s: Type.Optional(Type.Integer({ minimum: FRIST_MIN_S, maximum: FRIST_MAX_S })),
    }),
    execute: async (p, api, context) => {
      const aufgabe = String(p?.aufgabe ?? '').trim();
      if (aufgabe.length < 10) return text('Aufgabe zu kurz.');
      const art = p?.art === 'arbeiten' ? 'arbeiten' : 'lesen';
      let ordner = p?.ordner ? String(p.ordner) : null;
      if (!ordner) {
        const vomGespraech = await Promise.resolve(cwdFuer?.(api?.conversationId)).catch(() => null);
        ordner = vomGespraech ?? cfg?.arbeitsbereiche?.standard?.pfad ?? process.cwd();
      }
      if (!ordner.startsWith('/') || !existsSync(ordner) || !statSync(ordner).isDirectory()) {
        return text(`Ordner „${ordner}“ gibt es nicht (absoluter Pfad nötig).`);
      }
      const frist = Number.isInteger(p?.frist_s) ? Math.min(FRIST_MAX_S, Math.max(fristMinS, p.frist_s)) : FRIST_VORGABE_S;

      const platz = platzNehmen(ablage, pidLebt);
      if (!platz) {
        return text(`Beide Plätze für Unteragenten sind belegt (höchstens ${PLAETZE} gleichzeitig). Warte auf ein anderes Ergebnis oder erledige es selbst.`);
      }

      const tmp = mkdtempSync(join(tmpdir(), 'unteragent-'));
      const sysDatei = join(tmp, 'system.md');
      writeFileSync(sysDatei, SYSTEM, { mode: 0o600 });
      const kindEnv = {};
      for (const [k, v] of Object.entries(env)) if (v !== undefined && !GEHEIM.test(k)) kindEnv[k] = v;
      kindEnv.FYOS_UNTERAGENT = '1';
      const [prog, ...vor] = befehl ?? piBefehl(env);
      const args = [
        ...vor,
        '--mode', 'json', '-p', '--no-session', '--no-extensions', '--no-mcp', '--no-skills', '--no-context-files',
        '--tools', WERKZEUGE[art],
        '--append-system-prompt', sysDatei,
        `Aufgabe: ${aufgabe}`,
      ];

      const zeilen = [];
      let stderr = '';
      let grund = '';
      const t0 = Date.now();
      const signal = context?.signal;
      try {
        const exit = await new Promise((fertig) => {
          const kind = spawn(prog, args, { cwd: ordner, env: kindEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
          let puffer = '';
          kind.stdout.on('data', (d) => {
            puffer += d.toString();
            const teile = puffer.split('\n');
            puffer = teile.pop() ?? '';
            zeilen.push(...teile);
          });
          kind.stderr.on('data', (d) => {
            if (stderr.length < 4000) stderr += d.toString();
          });
          const beenden = (g) => {
            if (grund) return;
            grund = g;
            try {
              process.kill(-kind.pid, 'SIGTERM');
            } catch {
              /* schon weg */
            }
            setTimeout(() => {
              try {
                process.kill(-kind.pid, 'SIGKILL');
              } catch {
                /* schon weg */
              }
            }, 5000).unref();
          };
          const timer = setTimeout(() => beenden(`Zeitgrenze von ${frist} s erreicht`), frist * 1000);
          const ab = () => beenden('Zug abgebrochen');
          if (signal?.aborted) ab();
          signal?.addEventListener('abort', ab, { once: true });
          kind.on('error', (e) => {
            stderr += `[Start fehlgeschlagen: ${e.message}]`;
            clearTimeout(timer);
            signal?.removeEventListener('abort', ab);
            fertig(127);
          });
          kind.on('close', (code) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', ab);
            if (puffer.trim()) zeilen.push(puffer);
            fertig(code ?? 1);
          });
        });
        const { text: antwort, fehler } = schlussantwort(zeilen);
        const dauer = Math.round((Date.now() - t0) / 1000);
        const kopf = `Unteragent (${art}, ${dauer} s)`;
        if (grund) {
          return text(`${kopf} beendet: ${grund}.${antwort ? `\nLetzter Stand:\n${antwort.slice(-AUSGABE_MAX)}` : ''}`, { art, dauer_s: dauer, grund });
        }
        if (exit !== 0 && !antwort) {
          return text(`${kopf} fehlgeschlagen (Exit ${exit}): ${(fehler || stderr).trim().slice(0, 800) || 'ohne Meldung'}`, { art, dauer_s: dauer, exit });
        }
        if (!antwort) return text(`${kopf}: keine Antwort.${fehler ? ` ${fehler}` : ''}`, { art, dauer_s: dauer, exit });
        const k = antwort.length > AUSGABE_MAX ? `[… vorn gekürzt]\n${antwort.slice(-AUSGABE_MAX)}` : antwort;
        return text(`${kopf}:\n${k}`, { art, dauer_s: dauer, exit, zeichen: antwort.length });
      } finally {
        platzGeben(ablage, platz);
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  });

  return [unteragent];
}
