/**
 * persona/geheimnis-wache.js — Secret-Werte verlassen Persona nie (Besitzer 26.10.2026, PERSONA-SECRETS.md).
 *
 * Persona darf Secret-Werte lesen und benutzen (von A nach B durchreichen, anlegen, ersetzen). Sie gibt sie nie aus. Die Redaktion
 * (redaktion.js) schwärzt, was Werkzeuge zurückliefern. Diese Wache schließt die Gegenrichtung: Was Persona selbst in Texte schreibt,
 * die den Rechner verlassen oder liegen bleiben, darf keinen Secret-Wert enthalten.
 *
 * Geprüft wird vor dem Aufruf (`beforeTool`) bei Werkzeugen, deren Text woanders ankommt: Matrix, Bericht, Kontextbuch, Zustand,
 * Hub (ITSM-Notizen, Nachrichten, Wissen), Freigabe-Kontext, Gedächtnis, Aufträge an Läufe, Web und Browser, Dateien (write/edit).
 * Bei einem Treffer wird der Aufruf abgelehnt; die Meldung nennt Werkzeug, Feld und Art, nie den Wert, und sagt den richtigen Weg:
 * Verweis (Namensraum/Secret/Schlüssel) statt Wert.
 *
 * Zusätzlich (Prompt-Injection): Ein Shell-Befehl, der ein Kubernetes-Secret liest und in dasselbe Netzziel außerhalb des eigenen
 * Netzes schickt (curl/wget auf einen fremden Host, nc/socat/telnet), wird abgelehnt. Weiterreichen in den Cluster, an Gitea,
 * GitHub und eigene Dienste bleibt frei. Wird die Ausgabe eines Lesebefehls in eine Datei umgeleitet, kommt ein Hinweis am Ergebnis.
 *
 * Bewusst eng gefasst, damit nichts Gewöhnliches blockiert: Git-Hashes und Digests (Hex) zählen nicht; ein Schlüssel-Wert-Paar zählt nur, wenn
 * der Wert wie ein Geheimnis aussieht (Ziffer und Buchstabe, mindestens 8 Zeichen, kein Platzhalter). Testwerte tragen „Attrappe“.
 */
import { WERKZEUG_AUFRUF as ToolTask, haken as hook } from '../lauf/index.js';
import { befehlTeile, lesendeTeile, secretObjekteSchwaerzen } from './redaktion.js';

/** Werkzeuge, deren Argumente als Text woanders ankommen (Ausgang) oder dauerhaft liegen bleiben. */
export const AUSGANGS_WERKZEUGE =
  /^(?:matrix_senden|persona_bericht|kontextbuch_schreiben|zustand_schreiben|write|edit|web_[a-z_]+|browser|desktop_[a-z_]+|hub_aufrufen|freigabe_bitten|gedaechtnis_merken|unteragent|aufgabe_starten)$/;

/** Felder, die nie Text für Dritte sind. */
const AUSGENOMMEN = new Set(['path', 'cwd', 'tool', 'werkzeug']);

const PLATZHALTER = /attrappe|beispiel|example|dummy|platzhalter|changeme|xxxx|\*\*\*|geschwärzt|<[^>\s]+>|\$\{?[A-Za-z_]|your[_-]|\.\.\./i;
const SCHLUESSEL =
  'token|passwort|password|passwd|secret|api[_-]?key|kennwort|private[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret';

const aussieht = (wert) => wert.length >= 8 && /\d/.test(wert) && /[A-Za-z]/.test(wert) && !/[()[\]{}<>$]/.test(wert);

/** Mutmaßliche Secret-Werte in einem Text: Liste der Arten (nie der Werte). */
export function geheimnisFunde(text) {
  const t = String(text ?? '');
  const arten = new Set();
  const treffer = (re, art, pruefen = () => true) => {
    for (const m of t.matchAll(re)) {
      if (PLATZHALTER.test(m[0])) continue;
      if (pruefen(m)) arten.add(art);
    }
  };
  treffer(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g, 'privater Schlüssel (PEM)');
  treffer(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g, 'Bearer-Token');
  treffer(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, 'JWT');
  treffer(/\b(?:ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xox[abeprs]-|syt_|sk-|AKIA)[A-Za-z0-9_-]{12,}/g, 'Token mit bekanntem Präfix');
  treffer(/:\/\/[^\s/@:]+:([^\s/@]+)@/g, 'Zugangsdaten in URL', (m) => m[1].length >= 4);
  treffer(new RegExp(`(?:${SCHLUESSEL})["']?\\s*[:=]\\s*"?([^\\s"',;]+)`, 'gi'), 'Schlüssel-Wert-Paar', (m) => aussieht(m[1]));
  treffer(/[A-Za-z0-9+_=-]{40,}/g, 'lange Zeichenkette', (m) => /[A-Z]/.test(m[0]) && /[a-z]/.test(m[0]) && /\d/.test(m[0]));
  if (secretObjekteSchwaerzen(t) !== t) arten.add('Kubernetes-Secret mit Werten');
  return [...arten];
}

/** Alle Zeichenketten eines Arguments mit ihrem Feldpfad. */
function zeichenketten(wert, pfad = '', aus = []) {
  if (typeof wert === 'string') aus.push([pfad, wert]);
  else if (Array.isArray(wert)) wert.forEach((w, i) => zeichenketten(w, `${pfad}[${i}]`, aus));
  else if (wert && typeof wert === 'object') {
    for (const [k, v] of Object.entries(wert)) if (!AUSGENOMMEN.has(k)) zeichenketten(v, pfad ? `${pfad}.${k}` : k, aus);
  }
  return aus;
}

/** Erster Fund in den Argumenten eines Aufrufs: {feld, arten} oder null. */
export function argumentFund(arguments_) {
  for (const [feld, text] of zeichenketten(arguments_)) {
    const arten = geheimnisFunde(text);
    if (arten.length) return { feld: feld || '(Wert)', arten };
  }
  return null;
}

// --- Shell: Secret lesen und nach außen schicken -----------------------------------------------------------------------

/** Eigenes Netz und eigene Dienste: Hosts, an die ein Secret-Wert weitergereicht werden darf. */
export function hostErlaubt(host) {
  const h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (!h.includes('.') && !h.includes(':')) return true; // einzelnes Wort: Dienst im Cluster oder localhost
  if (h === '::1' || h.includes(':')) return h === '::1';
  return (
    /^(?:127\.|10\.|192\.168\.|100\.64\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(h) ||
    /(?:^|\.)(?:example\.net|fyos\.local|local|svc|svc\.cluster\.local|github\.com|githubusercontent\.com)$/.test(h)
  );
}

const URL_IN_BEFEHL = /\bhttps?:\/\/(?:[^\s/@"']+@)?(\[[0-9a-f:]+\]|[^\s/:?#"'\\)]+)/gi;

/** Liest der Befehl ein Secret und schickt er (irgendwas) an ein fremdes Netzziel? Gibt den Grund zurück oder ''. */
export function ausgangsGrund(befehl) {
  const s = String(befehl ?? '');
  if (!lesendeTeile(s).length) return '';
  const teile = befehlTeile(s);
  if (teile.some((t) => /^(?:nc|ncat|netcat|socat|telnet)\b/.test(t) || /\|\s*(?:nc|ncat|netcat|socat|telnet)\b/.test(t))) {
    return 'Secret-Lesebefehl zusammen mit nc/socat/telnet';
  }
  if (/\b(?:curl|wget)\b/.test(s)) {
    for (const m of s.matchAll(URL_IN_BEFEHL)) if (!hostErlaubt(m[1])) return `Secret-Lesebefehl zusammen mit curl/wget auf ${m[1]}`;
  }
  return '';
}

/** Leitet der Befehl die Ausgabe eines Secret-Lesebefehls in eine Datei um? */
export function leitetInDatei(befehl) {
  return lesendeTeile(befehl).length > 0 && /(?:^|[^>&0-9])>{1,2}\s*(?!&|\/dev\/null\b)[^\s&|;]/.test(String(befehl ?? ''));
}

const SCHELL_WERKZEUGE = new Set(['bash', 'knoten_befehl', 'hintergrund_starten']);

export function geheimnisWacheHooks() {
  const wache = hook(ToolTask, {
    beforeTool: async (call) => {
      try {
        const name = String(call?.name ?? '');
        const args = call?.arguments && typeof call.arguments === 'object' ? call.arguments : {};
        if (AUSGANGS_WERKZEUGE.test(name)) {
          const fund = argumentFund(args);
          if (fund) {
            return {
              block:
                `GEHEIMNIS-WACHE: In ${name}, Feld ${fund.feld}, steht mutmaßlich ein Secret-Wert (${fund.arten.join(', ')}). ` +
                'Secret-Werte werden nie ausgegeben, abgelegt oder gesendet: nicht in Chat, Matrix, Notizen, ITSM, Berichten, Dateien oder Anfragen. ' +
                'Schreibe stattdessen den Verweis (Namensraum, Secret, Schlüssel) und benutze den Wert nur direkt im Zielbefehl.',
            };
          }
        }
        if (SCHELL_WERKZEUGE.has(name)) {
          const grund = ausgangsGrund(args.command ?? args.befehl);
          if (grund) {
            return {
              block:
                `GEHEIMNIS-WACHE: ${grund}. Ein Secret-Wert darf in den Cluster und an eigene Dienste (Gitea, GitHub, example.net, lokales Netz), ` +
                'nicht an ein fremdes Netzziel. Ist das Ziel gewollt, beantrage es bei Besitzer (freigabe_bitten).',
            };
          }
        }
      } catch {
        /* Ein Fehler in der Prüfung sperrt nicht: die Redaktion schwärzt weiter, und nur Zerstörendes ist hart. */
      }
      return undefined;
    },
    afterTool: async (call, result) => {
      try {
        const name = String(call?.name ?? '');
        if (!SCHELL_WERKZEUGE.has(name)) return undefined;
        const a = call?.arguments ?? {};
        if (!leitetInDatei(a.command ?? a.befehl)) return undefined;
        return {
          ...result,
          diagnostics: [
            ...(result?.diagnostics ?? []),
            {
              severity: 'warn',
              code: 'geheimnis:datei',
              message:
                'Geheimnis-Wache: Die Ausgabe eines Secret-Lesebefehls geht in eine Datei. Nicht ins Repo und nicht unter /home; nach Gebrauch löschen (nur die eigene Datei).',
            },
          ],
        };
      } catch {
        return undefined;
      }
    },
  });
  return [wache];
}
