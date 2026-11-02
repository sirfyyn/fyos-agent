/**
 * persona/wache.js — Leitplanke für Persona: Zerstörendes und Zugriffe auf Zugangsdaten (Plan-Stufe S13).
 *
 * Port von `persona-wache` (kern.ts, index.ts, regeln.json). Die Regeln und ihre Muster sind 1:1 die
 * alten; jede Regel prüft ein Eingabefeld (command oder path) eines Werkzeugaufrufs. Keine
 * Shell-Analyse: das Muster sieht nur die Zeichenkette. Die Wache ist eine Leitplanke, keine Sandbox.
 *
 * Härte (Besitzer 24.10.2026, „Beschränkungen nicht hart“): Im alten Stand sperrte jeder Treffer. Jetzt sperrt
 * nur, was Zerstörendes tut (`haerte: 'sperre'`). Alles andere kommt als Hinweis (`diagnostics`, Stufe
 * warn) am Ergebnis; der Aufruf läuft. `haerte: 'schreibend'` sperrt nur bei write/edit (Überschreiben
 * von Zugangsdaten), sonst Hinweis.
 *
 *   zugangsdaten-pfad     schreibend  (write/edit gesperrt, Lesen nur Hinweis; die Redaktion schwärzt Ausgaben)
 *   zugangsdaten-befehl   hinweis
 *   rechte-erhoehen       hinweis     (sudo; das Regelwerk gibt Persona ausdrücklich sudo)
 *   force-push            sperre
 *   rekursiv-loeschen     sperre
 *   branch-loeschen       sperre
 *   lokal-verwerfen       sperre
 *   cluster-loeschen      sperre
 *   dienste-umstellen     hinweis     (Dienste ändern ist nicht Datenverlust)
 *   schreiben-ausserhalb  hinweis
 *
 * Neu gegenüber dem alten Stand: Der Befehl von `knoten_befehl` (Feld `befehl`) wird wie ein
 * bash-`command` geprüft, weil er im neuen Runner derselbe Weg zur Shell ist.
 *
 * Ein Fehler in der Prüfung sperrt nicht (früher: alles gesperrt); eine nicht ladbare Regeldatei
 * (`FYOS_WACHE_REGELN`) lässt die eingebauten Regeln gelten und meldet es als Hinweis.
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { WERKZEUG_AUFRUF as ToolTask, haken as hook } from '../lauf/index.js';
import { befehlFreigegeben, freigabeHinweis } from '../freigabe-befehl.js';

const SCHREIBEND = new Set(['write', 'edit']);
const HAERTEN = new Set(['sperre', 'schreibend', 'hinweis']);

/** Die Regeln aus regeln.json, ergänzt um `haerte`. Die erste passende Regel entscheidet in `urteil`. */
export const STANDARD_REGELN = {
  schreibbar: ['/var/lib/fyos-agent/'],
  regeln: [
    {
      id: 'zugangsdaten-pfad',
      werkzeug: '*',
      feld: 'path',
      muster: '(\\.token$|\\.env$|\\.netrc$|\\.git-credentials$|id_rsa|/\\.ssh/|/etc/fyos/)',
      aktion: 'blockieren',
      haerte: 'schreibend',
      grund: 'Zugriff auf Zugangsdaten oder Geheimnisse ist nicht erlaubt',
    },
    {
      id: 'zugangsdaten-befehl',
      werkzeug: 'bash',
      feld: 'command',
      muster: '(\\.token\\b|\\.env\\b|\\.netrc|git-credentials|id_rsa|/\\.ssh/|/etc/fyos/)',
      aktion: 'blockieren',
      haerte: 'hinweis',
      grund: 'Der Befehl berührt Zugangsdaten',
    },
    {
      id: 'rechte-erhoehen',
      werkzeug: 'bash',
      feld: 'command',
      muster: '(^|[;&|(]\\s*)sudo\\b',
      aktion: 'blockieren',
      haerte: 'hinweis',
      grund: 'Rechteerhöhung ist im Dienst gesperrt',
    },
    {
      id: 'force-push',
      werkzeug: 'bash',
      feld: 'command',
      muster: 'git\\s+push\\b.*(\\s--force(?!-with-lease)\\b|\\s-f\\b|\\s\\+\\S)',
      aktion: 'blockieren',
      haerte: 'sperre',
      grund: 'Force-Push verwirft fremde Commits',
    },
    {
      id: 'rekursiv-loeschen',
      werkzeug: 'bash',
      feld: 'command',
      muster: '\\brm\\s+(-[a-zA-Z]*r|--recursive)',
      aktion: 'freigabe',
      // Besitzer: nicht streng. Das Katastrophale (HOME, /, Hauptcheckout, leere Variable) sperrt src/waechter.js.
      haerte: 'hinweis',
      grund: "Rekursives Löschen ist Besitzer' Entscheidung",
    },
    {
      id: 'branch-loeschen',
      werkzeug: 'bash',
      feld: 'command',
      muster: 'git\\s+branch\\s+-D\\b',
      aktion: 'freigabe',
      haerte: 'sperre',
      grund: "Branch löschen ist Besitzer' Entscheidung",
    },
    {
      id: 'lokal-verwerfen',
      werkzeug: 'bash',
      feld: 'command',
      muster: 'git\\s+(reset\\s+--hard|clean\\s+-[a-zA-Z]*f)',
      aktion: 'freigabe',
      haerte: 'sperre',
      grund: 'Verwirft lokale Änderungen',
    },
    {
      id: 'cluster-loeschen',
      werkzeug: 'bash',
      feld: 'command',
      // `kubectl delete job` ist erlaubt (Entscheidungsbuch 530, Regelwerk Z.94-98).
      muster: '\\bkubectl\\s+(delete\\s+(?!job\\b)|drain\\b|replace\\s+--force\\b)',
      aktion: 'freigabe',
      haerte: 'sperre',
      grund: "Löschen oder Leeren im Cluster ist Besitzer' Entscheidung",
    },
    {
      id: 'dienste-umstellen',
      werkzeug: 'bash',
      feld: 'command',
      muster: '\\bsystemctl\\s+(set-property|edit|disable|mask|stop)\\b',
      aktion: 'freigabe',
      haerte: 'hinweis',
      grund: "Dienste umstellen ist System und Besitzer' Entscheidung",
    },
  ],
};

/**
 * Prüft die Regelliste beim Laden. Ein ungültiges Muster bricht ab. Fehlt `haerte`, gilt `sperre`
 * (wie im alten Stand, in dem jeder Treffer sperrte).
 */
export function regelnPruefen(daten) {
  if (!daten || typeof daten !== 'object') throw new Error('regeln.json: kein Objekt');
  if (!Array.isArray(daten.regeln)) throw new Error('regeln.json: „regeln“ fehlt');
  if (!Array.isArray(daten.schreibbar) || !daten.schreibbar.every((p) => typeof p === 'string' && p.startsWith('/'))) {
    throw new Error('regeln.json: „schreibbar“ braucht absolute Pfade');
  }
  const regeln = daten.regeln.map((r, i) => {
    for (const k of ['id', 'werkzeug', 'feld', 'muster', 'aktion', 'grund']) {
      if (typeof r?.[k] !== 'string' || !r[k]) throw new Error(`regeln.json: Regel ${i} ohne „${k}“`);
    }
    if (r.feld !== 'command' && r.feld !== 'path') throw new Error(`Regel ${r.id}: feld ist command oder path`);
    if (r.aktion !== 'blockieren' && r.aktion !== 'freigabe') throw new Error(`Regel ${r.id}: aktion ungültig`);
    const haerte = r.haerte ?? 'sperre';
    if (!HAERTEN.has(haerte)) throw new Error(`Regel ${r.id}: haerte ungültig`);
    return { ...r, haerte, re: new RegExp(r.muster, 'i') };
  });
  return { regeln, schreibbar: daten.schreibbar.map((p) => resolve(p)) };
}

/** Das Urteil zu einem Werkzeugaufruf, 1:1 der alte: die erste passende Regel entscheidet. */
export function urteil(regeln, werkzeug, eingabe, cwd) {
  for (const r of regeln.regeln) {
    if (r.werkzeug !== '*' && r.werkzeug !== werkzeug) continue;
    const wert = eingabe[r.feld];
    if (typeof wert !== 'string') continue;
    if (r.re.test(wert)) return { erlaubt: false, aktion: r.aktion, regel: r.id, grund: r.grund, haerte: r.haerte };
  }
  if (SCHREIBEND.has(werkzeug) && typeof eingabe.path === 'string') {
    const ziel = resolve(cwd, eingabe.path);
    const innen = regeln.schreibbar.some((p) => ziel === p || ziel.startsWith(`${p}/`));
    if (!innen) {
      return {
        erlaubt: false,
        aktion: 'freigabe',
        regel: 'schreiben-ausserhalb',
        grund: `Schreiben nach ${ziel} liegt außerhalb des Arbeitsbereichs`,
        haerte: 'hinweis',
      };
    }
  }
  return { erlaubt: true };
}

/** Alle Treffer eines Aufrufs (nicht nur der erste), damit ein Hinweis keine Sperre verdeckt. */
export function treffer(regeln, werkzeug, eingabe, cwd) {
  const alle = [];
  for (const r of regeln.regeln) {
    if (r.werkzeug !== '*' && r.werkzeug !== werkzeug) continue;
    const wert = eingabe[r.feld];
    if (typeof wert !== 'string') continue;
    if (r.re.test(wert)) alle.push({ erlaubt: false, aktion: r.aktion, regel: r.id, grund: r.grund, haerte: r.haerte });
  }
  const rest = urteil({ regeln: [], schreibbar: regeln.schreibbar }, werkzeug, eingabe, cwd);
  if (!rest.erlaubt) alle.push(rest);
  return alle;
}

/** Ist ein Treffer eine Sperre oder nur ein Hinweis? */
export function istSperre(u, werkzeug) {
  if (u.erlaubt) return false;
  if (u.haerte === 'sperre') return true;
  if (u.haerte === 'schreibend') return SCHREIBEND.has(werkzeug);
  return false;
}

/** Text der Sperre, wie der alte `begruendung`, mit den Wegen des neuen Runners. */
export function begruendung(u) {
  if (u.aktion === 'freigabe') {
    return (
      `${u.grund}. Zerstörend, braucht Besitzer' Freigabe: stelle das Vorhaben mit freigabe_bitten ` +
      'und beende deinen Zug. Der Aufruf bleibt gesperrt, bis ein Mensch ihn ausführt oder freigibt.'
    );
  }
  return `${u.grund}. Nicht erlaubt.`;
}

/** Text des Hinweises (keine Sperre). */
export function hinweisText(u) {
  if (u.aktion === 'freigabe') {
    return `Wache: ${u.grund}. Das ist nur ein Hinweis; prüfe, ob es sich zurückholen lässt, sonst frage Besitzer (freigabe_bitten).`;
  }
  return `Wache: ${u.grund}. Das ist nur ein Hinweis, der Aufruf lief.`;
}

/** Eingabe für die Regeln: `knoten_befehl` trägt den Befehl im Feld `befehl`. */
function eingabeFuer(call) {
  const a = call?.arguments && typeof call.arguments === 'object' ? call.arguments : {};
  if (call?.name === 'knoten_befehl') return { ...a, command: a.command ?? a.befehl };
  return a;
}

/** Werkzeugname für die Regeln: `knoten_befehl` wird wie bash geprüft. */
function werkzeugFuer(call) {
  return call?.name === 'knoten_befehl' ? 'bash' : String(call?.name ?? '');
}

function regelnLaden(env) {
  const datei = env.FYOS_WACHE_REGELN;
  if (!datei) return { regeln: regelnPruefen(STANDARD_REGELN), fehler: null };
  try {
    return { regeln: regelnPruefen(JSON.parse(readFileSync(datei, 'utf8'))), fehler: null };
  } catch (f) {
    return { regeln: regelnPruefen(STANDARD_REGELN), fehler: `Regeldatei ${datei} nicht ladbar (${f?.message ?? f}); eingebaute Regeln gelten` };
  }
}

/** Schreibbare Präfixe: die alten, dazu die Arbeitsbereiche, `FYOS_WACHE_SCHREIBBAR` (durch : getrennt) und das Temp-Verzeichnis. */
function schreibbarErgaenzen(regeln, cfg, env) {
  const extra = [];
  for (const b of Object.values(cfg?.arbeitsbereiche ?? {})) if (b?.pfad) extra.push(b.pfad);
  for (const p of String(env.FYOS_WACHE_SCHREIBBAR ?? '').split(':')) if (p.startsWith('/')) extra.push(p);
  extra.push(tmpdir());
  return { ...regeln, schreibbar: [...new Set([...regeln.schreibbar, ...extra.map((p) => resolve(p))])] };
}

export function wacheHooks({ cfg, env = process.env, regeln: vorgegeben, cwdFuer } = {}) {
  let geladen;
  if (vorgegeben) geladen = { regeln: vorgegeben, fehler: null };
  else {
    geladen = regelnLaden(env);
    geladen.regeln = schreibbarErgaenzen(geladen.regeln, cfg, env);
  }

  const cwdVon = async (call, api) => {
    const a = call?.arguments ?? {};
    if (typeof a.cwd === 'string' && a.cwd) return a.cwd;
    const vomGespraech = await Promise.resolve(cwdFuer?.(api?.conversationId)).catch(() => null);
    return vomGespraech ?? cfg?.arbeitsbereiche?.standard?.pfad ?? process.cwd();
  };

  const pruefen = async (call, api) => {
    const cwd = await cwdVon(call, api);
    return treffer(geladen.regeln, werkzeugFuer(call), eingabeFuer(call), cwd);
  };

  const wache = hook(ToolTask, {
    beforeTool: async (call, api) => {
      try {
        const alle = await pruefen(call, api);
        const sperre = alle.find((u) => istSperre(u, werkzeugFuer(call)));
        if (sperre) {
          // Ein Shell-Befehl geht nach erteilter Freigabe durch; der Text sagt dem Agenten den Weg.
          if (werkzeugFuer(call) === 'bash') {
            const befehl = eingabeFuer(call).command;
            if (await befehlFreigegeben(api, befehl)) return undefined;
            return { block: `PERSONA-WACHE: ${sperre.grund}. ${freigabeHinweis(befehl)}` };
          }
          return { block: `PERSONA-WACHE: ${begruendung(sperre)}` };
        }
      } catch {
        /* Ein Fehler in der Prüfung sperrt nicht: nur Zerstörendes ist hart, und das ist hier nicht erkannt. */
      }
      return undefined;
    },
    afterTool: async (call, result, api) => {
      let hinweise = [];
      try {
        const alle = await pruefen(call, api);
        hinweise = alle.filter((u) => !istSperre(u, werkzeugFuer(call))).map((u) => ({ severity: 'warn', code: `wache:${u.regel}`, message: hinweisText(u) }));
      } catch {
        /* ohne Prüfung kein Hinweis */
      }
      if (geladen.fehler) hinweise.push({ severity: 'warn', code: 'wache:regeln', message: `Wache: ${geladen.fehler}` });
      if (!hinweise.length) return undefined;
      return { ...result, diagnostics: [...(result.diagnostics ?? []), ...hinweise] };
    },
  });
  return [wache];
}
