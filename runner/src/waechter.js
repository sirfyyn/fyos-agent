/**
 * waechter.js — Befehlswächter (VOR-4870), Port von `befehls_waechter.py`.
 *
 * Bewusst nicht streng. Gesperrt wird nur, was den Vorfall vom 22.10. hätte anrichten können:
 *  - rekursives Löschen (rm -r/-R/-rf), wenn ein Ziel HOME, / oder ein Vorfahr davon ist, oder der
 *    Hauptcheckout (~/fyos) oder einer seiner Vorfahren;
 *  - rm -r mit einer Pfadvariable, die leer sein kann (rm -rf $X, rm -rf ${X}/);
 *  - git clean mit -f (ohne -n) und git reset --hard, wenn der Lauf im Hauptcheckout stattfindet.
 * Alles andere läuft durch (rm -rf build, rm -rf $W/build, einzelne Dateien).
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

const TRENNER = new Set(['&&', '||', ';', '|']);

function echt(pfad) {
  try {
    return realpathSync(pfad);
  } catch {
    return resolve(pfad);
  }
}

const istVorfahrOderGleich = (vorfahr, pfad) => pfad === vorfahr || pfad.startsWith(vorfahr.replace(/\/+$/, '') + '/');

/** shlex.split(posix) in klein: Anführungszeichen, Backslash; Trenner werden eigene Token. */
export function zerlege(befehl) {
  const tokens = [];
  let aktuell = '';
  let hat = false;
  let q = null;
  const s = String(befehl ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") {
      if (c === "'") q = null;
      else aktuell += c;
    } else if (q === '"') {
      if (c === '"') q = null;
      else if (c === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) aktuell += s[++i];
      else aktuell += c;
    } else if (c === "'" || c === '"') {
      q = c;
      hat = true;
    } else if (c === '\\' && i + 1 < s.length) {
      aktuell += s[++i];
      hat = true;
    } else if (/\s/.test(c)) {
      if (hat || aktuell) tokens.push(aktuell);
      aktuell = '';
      hat = false;
    } else if (c === ';' || c === '|' || c === '&') {
      if (hat || aktuell) tokens.push(aktuell);
      aktuell = '';
      hat = false;
      if ((c === '|' || c === '&') && s[i + 1] === c) {
        tokens.push(c + c);
        i++;
      } else if (c === '&') {
        tokens.push(';'); // Hintergrund-& trennt wie ein Semikolon
      } else {
        tokens.push(c);
      }
    } else {
      aktuell += c;
    }
  }
  if (q) return null; // unvollständig
  if (hat || aktuell) tokens.push(aktuell);
  return tokens;
}

function segmente(befehl) {
  const tokens = zerlege(befehl);
  if (!tokens) return [[String(befehl ?? '')]]; // nicht lesbar: das Ganze als ein Segment, Regeln greifen trotzdem
  const out = [[]];
  for (const t of tokens) {
    if (TRENNER.has(t)) out.push([]);
    else out[out.length - 1].push(t);
  }
  return out.filter((x) => x.length);
}

export function erzeugeWaechter({ home = homedir(), hauptcheckout } = {}) {
  const HOME = echt(home);
  const HAUPT = hauptcheckout ?? join(HOME, 'fyos');
  const WORKTREES = join(HAUPT, '.claude', 'worktrees');

  const ersetzeHome = (ziel) => {
    if (ziel === '~' || ziel.startsWith('~/')) return HOME + ziel.slice(1);
    return ziel.replaceAll('${HOME}', HOME).replaceAll('$HOME', HOME);
  };
  const imHauptcheckout = (pfad) => istVorfahrOderGleich(HAUPT, pfad) && !istVorfahrOderGleich(WORKTREES, pfad);

  const zielGefaehrlich = (ziel, cwd) => {
    if (ziel.startsWith('$')) {
      const [, rest] = ziel.split(/\/(.*)/s);
      if (rest === undefined || rest === '' || rest === '*') return `Pfadvariable kann leer sein: ${ziel}`;
      return null;
    }
    const voll = echt(isAbsolute(ziel) ? ziel : join(cwd, ziel));
    if (voll === '/') return 'Wurzelverzeichnis';
    if (istVorfahrOderGleich(voll, HOME)) return `Home-Verzeichnis oder darüber: ${voll}`;
    if (istVorfahrOderGleich(voll, HAUPT)) return `Hauptcheckout oder darüber: ${voll}`;
    return null;
  };

  /** `null`, wenn der Befehl durchgehen darf; sonst der Grund für die Sperre. */
  return function pruefe(befehl, cwd) {
    let ort = echt(cwd || HOME);
    let haupt = imHauptcheckout(ort);
    for (const seg of segmente(befehl)) {
      if (seg[0] === 'cd' && seg.length > 1) {
        ort = echt(isAbsolute(ersetzeHome(seg[1])) ? ersetzeHome(seg[1]) : join(ort, ersetzeHome(seg[1])));
        haupt = imHauptcheckout(ort);
        continue;
      }
      const kopf = basename(seg[0] ?? '');
      if (kopf === 'rm') {
        const flags = seg.slice(1).filter((a) => a.startsWith('-') && a.length > 1);
        let rekursiv = flags.filter((a) => !a.startsWith('--')).some((a) => /[rR]/.test(a));
        if (flags.some((a) => a === '--recursive' || a === '-R')) rekursiv = true;
        if (rekursiv) {
          for (const ziel of seg.slice(1).filter((a) => !a.startsWith('-'))) {
            const grund = zielGefaehrlich(ersetzeHome(ziel), ort);
            if (grund) return `rm -r gesperrt: ${grund}`;
          }
        }
      }
      if (kopf === 'git' && seg.length > 1 && haupt) {
        const unter = seg[1];
        const optionen = seg.slice(2);
        if (unter === 'clean' && optionen.some((a) => a.startsWith('-') && a.includes('f') && !a.includes('n'))) {
          return 'git clean -f im Hauptcheckout gesperrt (erst mit -n ansehen)';
        }
        if (unter === 'reset' && optionen.includes('--hard')) return 'git reset --hard im Hauptcheckout gesperrt';
      }
    }
    return null;
  };
}

export const pruefeBefehl = erzeugeWaechter();
