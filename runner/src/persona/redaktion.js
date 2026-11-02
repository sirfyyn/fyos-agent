/**
 * persona/redaktion.js — Schwärzung von Zugangsdaten in Werkzeugergebnissen (Plan S2, erweitert 26.10.2026 für „Secrets wie Claude“).
 *
 * Port von `persona-redaktion` (kern.ts + index.ts). Die Muster bleiben gleich mit
 * deploy/runner/_gedaechtnis.py (dort für Episoden). Der Hook `afterTool` ersetzt den Text, bevor das
 * Ergebnis ins Gespräch kommt; das Modell sieht nie die Rohfassung, und was nicht im Gespräch steht, steht auch nicht in der
 * Aufzeichnung und nicht im Egress zum Hub.
 *
 * Grundsatz (Besitzer 26.10.2026, PERSONA-SECRETS.md): Persona darf Secret-Werte lesen und benutzen (durchreichen, anlegen, ersetzen),
 * aber nie ausgeben. Darum gilt hier eine zweite Schicht über den Mustern:
 *   1. Befehlsbezogen: Der Befehl, der das Ergebnis erzeugt hat, ist bekannt (`call`). Liest er ein Kubernetes-Secret
 *      (`kubectl get|describe|view-secret|edit … secret`) und die Ausgabe ist kein Name und keine Tabelle, wird sie geschwärzt:
 *      yaml/json strukturell (`data:` und `stringData:` Wert für Wert, die letzte angewendete Konfiguration ganz), alles andere
 *      (jsonpath, go-template, base64-Dekodierung am Ende der Pipe) ganz. Endet die Pipe in einem Verbraucher (`kubectl create|apply|…`,
 *      `wc`, `sha256sum`, `grep -q` …), ist die Ausgabe des Verbrauchers gemeint und bleibt lesbar: so reicht Persona einen Wert von A nach B durch.
 *   2. Inhaltsbezogen: Secret-YAML/JSON (`kind: Secret`) wird auch ohne Befehlskenntnis (zum Beispiel aus einer Datei) strukturell
 *      geschwärzt. Dazu Muster für Bearer, JWT, PEM-Schlüssel, bekannte Token-Präfixe, URL-Zugangsdaten, Schlüssel-Wert-Paare in
 *      YAML, JSON und Umgebung, lange Hex- und Base64-Ketten.
 *
 * Abweichung: Der alte Hook ließ bei einer Änderung `structuredContent` wegfallen (pi-Vertrag). Hier
 * wird `structuredOutput` nicht verworfen — das bräche Werkzeuge mit Ausgabeschema —, sondern in allen
 * Textwerten gleich geschwärzt.
 */
import { WERKZEUG_AUFRUF as ToolTask, haken as hook } from '../lauf/index.js';

export const ERSATZ = '[geschwärzt]';

/** Ersatztext, wenn die ganze Ausgabe eines Secret-Lesebefehls wegfällt. */
export const SECRET_AUSGABE_ERSATZ =
  `${ERSATZ} Ausgabe eines Secret-Lesebefehls. Werte werden nie angezeigt. ` +
  'Benutze den Wert direkt (Pipe in den Zielbefehl, z. B. kubectl create/apply) oder prüfe mit -o name, describe oder einem Hash (sha256sum).';

const SCHLUESSEL =
  'token|passwort|password|passwd|secret|api[_-]?key|kennwort|private[_-]?key|access[_-]?key|secret[_-]?key|client-key-data|client-certificate-data|tls\\.key|\\.dockerconfigjson';

const MUSTER = [
  [/<private>[\s\S]*?<\/private>/gi, '[privat]'],
  // Private Schlüssel (PEM), auch abgeschnitten (ohne Ende bis zum Textende).
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, ERSATZ],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g, `Bearer ${ERSATZ}`],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, ERSATZ],
  [/\b(?:ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xox[abeprs]-|syt_|sk-|AKIA)[A-Za-z0-9_-]{8,}/g, ERSATZ],
  // Zugangsdaten in URLs: https://nutzer:passwort@host
  [/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, `$1${ERSATZ}@`],
  [/\b[0-9a-fA-F]{40,}\b/g, ERSATZ],
  // JSON: "token": "…", "client_secret": "…", "password":"…" (nur der ganze Schlüsselname, nicht secretName).
  [new RegExp(`("(?:[A-Za-z0-9]+[_.-])*(?:${SCHLUESSEL})"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi'), `$1"${ERSATZ}"`],
  // YAML und Umgebung: token: x, API_KEY=x, password: "x y"
  [new RegExp(`((?:${SCHLUESSEL})\\s*[:=]\\s*)(?!\\[geschwärzt\\])("[^"]*"|'[^']*'|\\S+)`, 'gi'), `$1${ERSATZ}`],
];

/** Lange Base64-/Schlüsselketten (mindestens 40 Zeichen mit Groß-, Klein- und Ziffer); Pfade und Wörter bleiben. */
const LANG = /[A-Za-z0-9+_=-]{40,}/g;
const langErsetzen = (m) => (/[A-Z]/.test(m) && /[a-z]/.test(m) && /\d/.test(m) ? ERSATZ : m);

// --- Kubernetes-Secrets (YAML und JSON) -----------------------------------------------------------------------------

const IST_SECRET = /(?:^|\n)\s*(?:-\s+)?kind:\s*["']?Secret["']?\s*(?:\n|$)|"kind"\s*:\s*"Secret"/;
const GEHEIMER_BLOCK = /^(\s*)(?:-\s+)?(data|stringData|binaryData):\s*$/;
const FLUSS_BLOCK = /^(\s*)(?:-\s+)?(data|stringData|binaryData):\s*\{.*\}\s*$/;
const LAST_APPLIED = /^(\s*)kubectl\.kubernetes\.io\/last-applied-configuration:\s*(.*)$/;

function einrueckung(zeile) {
  return zeile.length - zeile.trimStart().length;
}

/** YAML: Werte unter data:/stringData: und die letzte angewendete Konfiguration ersetzen; Schlüsselnamen bleiben sichtbar. */
function yamlSecretSchwaerzen(text) {
  const zeilen = text.split('\n');
  const aus = [];
  let block = null; // {tiefe, kind}
  let lastApplied = null; // Einrückung des Schlüssels
  for (const zeile of zeilen) {
    const leer = zeile.trim() === '';
    if (lastApplied !== null) {
      if (leer || einrueckung(zeile) > lastApplied) continue; // Folgezeilen des Blocks fallen weg
      lastApplied = null;
    }
    if (block) {
      if (leer) {
        aus.push(zeile);
        continue;
      }
      const tiefe = einrueckung(zeile);
      if (tiefe <= block.tiefe) block = null;
      else {
        block.kind ??= tiefe;
        if (tiefe > block.kind) continue; // Fortsetzungszeilen eines mehrzeiligen Werts
        const m = zeile.match(/^(\s*)([^\s:#][^:]*?):(\s|$)/);
        aus.push(m ? `${m[1]}${m[2]}: ${ERSATZ}` : `${' '.repeat(tiefe)}${ERSATZ}`);
        continue;
      }
    }
    const la = zeile.match(LAST_APPLIED);
    if (la) {
      aus.push(`${la[1]}kubectl.kubernetes.io/last-applied-configuration: ${ERSATZ}`);
      lastApplied = la[1].length;
      continue;
    }
    const fluss = zeile.match(FLUSS_BLOCK);
    if (fluss) {
      aus.push(zeile.replace(/\{.*\}\s*$/, `{ ${ERSATZ} }`));
      continue;
    }
    const b = zeile.match(GEHEIMER_BLOCK);
    if (b) {
      block = { tiefe: b[1].length + (zeile.trimStart().startsWith('- ') ? 2 : 0), kind: null };
      aus.push(zeile);
      continue;
    }
    aus.push(zeile);
  }
  return aus.join('\n');
}

/** Ende des Objekts, das bei `von` (auf `{`) beginnt; berücksichtigt Zeichenketten. -1, wenn es nicht schließt. */
function objektEnde(text, von) {
  let tiefe = 0;
  let inString = false;
  for (let i = von; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') tiefe++;
    else if (c === '}' && --tiefe === 0) return i;
  }
  return -1;
}

/** JSON: Werte in "data"/"stringData"/"binaryData" und die letzte angewendete Konfiguration ersetzen (Formatierung bleibt). */
function jsonSecretSchwaerzen(text) {
  let aus = text.replace(
    /("kubectl\.kubernetes\.io\/last-applied-configuration"\s*:\s*)"(?:[^"\\]|\\.)*"/g,
    `$1"${ERSATZ}"`,
  );
  const re = /"(?:data|stringData|binaryData)"\s*:\s*\{/g;
  let m;
  let ergebnis = '';
  let pos = 0;
  while ((m = re.exec(aus)) !== null) {
    const auf = m.index + m[0].length - 1;
    const zu = objektEnde(aus, auf);
    if (zu < 0) {
      // Abgeschnitten: ab hier alles weg, lieber zu viel als ein Wert.
      ergebnis += aus.slice(pos, auf + 1) + ` "${ERSATZ}": "${ERSATZ}" }`;
      pos = aus.length;
      break;
    }
    const innen = aus.slice(auf + 1, zu).replace(/("(?:[^"\\]|\\.)*"\s*:\s*)"(?:[^"\\]|\\.)*"/g, `$1"${ERSATZ}"`);
    ergebnis += aus.slice(pos, auf + 1) + innen + '}';
    pos = zu + 1;
    re.lastIndex = pos;
  }
  ergebnis += aus.slice(pos);
  aus = ergebnis;
  return aus;
}

/** Secret-Objekte (`kind: Secret`) in YAML oder JSON: Werte weg, Namen bleiben. Ohne Secret im Text unverändert. */
export function secretObjekteSchwaerzen(text) {
  if (!IST_SECRET.test(text)) return text;
  return jsonSecretSchwaerzen(yamlSecretSchwaerzen(text));
}

// --- Der Befehl, der das Ergebnis erzeugt hat ----------------------------------------------------------------------------

/** Teilt einen Shell-Text an Pipe, `;`, `&&`, `||`, Zeilenumbruch auf oberster Ebene (nicht in Anführungszeichen, `$(…)`, Backticks). */
export function befehlTeile(befehl) {
  const teile = [];
  let aktuell = '';
  let q = null;
  let klammer = 0;
  let backtick = false;
  const s = String(befehl ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && q !== "'") {
      aktuell += c + (s[i + 1] ?? '');
      i++;
      continue;
    }
    if (q) {
      if (c === q) q = null;
      else if (q === '"' && c === '$' && s[i + 1] === '(') {
        klammer++;
        aktuell += '$(';
        i++;
        continue;
      }
      aktuell += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      aktuell += c;
      continue;
    }
    if (c === '`') {
      backtick = !backtick;
      aktuell += c;
      continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      klammer++;
      aktuell += '$(';
      i++;
      continue;
    }
    if (c === ')' && klammer > 0) {
      klammer--;
      aktuell += c;
      continue;
    }
    if (klammer === 0 && !backtick && (c === '|' || c === ';' || c === '&' || c === '\n')) {
      if (aktuell.trim()) teile.push(aktuell.trim());
      aktuell = '';
      if ((c === '|' || c === '&') && s[i + 1] === c) i++;
      continue;
    }
    aktuell += c;
  }
  if (aktuell.trim()) teile.push(aktuell.trim());
  return teile;
}

/** Teilbefehle (oberste Ebene), die ein Kubernetes-Secret lesen (get, describe, view-secret, edit; auch `kubectl config view --raw`). */
export function lesendeTeile(befehl) {
  return befehlTeile(befehl).filter(
    (t) =>
      /\bkubectl\b.*\bconfig\s+view\b.*--raw\b/.test(t) ||
      /\bkubectl\b.*?\b(?:get|describe|edit)\b.*?\bsecrets?\b/i.test(t) ||
      /\bkubectl\b.*\bview-secret\b/.test(t) ||
      /\$\(\s*(?:sudo\s+)?kubectl\b.*?\b(?:get|describe|edit)\b.*?\bsecrets?\b/i.test(t),
  );
}

/** Liest der Befehl ein Kubernetes-Secret? */
export function liestSecret(befehl) {
  return lesendeTeile(befehl).length > 0;
}

/** Verbraucher am Ende einer Pipe: Ihre Ausgabe ist nicht der Secret-Wert (Weiterreichen, Prüfen, Hash). */
const VERBRAUCHER = [
  /^(?:wc|sha256sum|sha1sum|sha512sum|md5sum|cksum|shasum|true|false|test|\[)\b/,
  /^grep\s+(?:-[a-zA-Z]*[qs][a-zA-Z]*)\b/,
  /^(?:cmp|diff)\s+(?:-[a-zA-Z]*[sq][a-zA-Z]*)\b/,
];
const KUBECTL_SCHREIBEND = new Set(['create', 'apply', 'replace', 'patch', 'set', 'annotate', 'label', 'rollout', 'scale', 'delete']);
const KUBECTL_FLAG_MIT_WERT = new Set(['-n', '--namespace', '--context', '--kubeconfig', '--cluster', '--user', '-s', '--server', '--as', '--as-group']);

/** Das Verb eines kubectl-Teilbefehls (erstes Wort, das kein Schalter ist), sonst ''. */
export function kubectlVerb(teil) {
  const w = String(teil ?? '').trim().split(/\s+/);
  let i = w[0] === 'sudo' ? 1 : 0;
  if (!/(^|\/)kubectl$/.test(w[i] ?? '')) return '';
  for (i += 1; i < w.length; i++) {
    if (!w[i].startsWith('-')) return w[i];
    if (KUBECTL_FLAG_MIT_WERT.has(w[i])) i++;
  }
  return '';
}

export function mitVerbraucher(befehl) {
  const letzter = befehlTeile(befehl).at(-1) ?? '';
  return KUBECTL_SCHREIBEND.has(kubectlVerb(letzter)) || VERBRAUCHER.some((re) => re.test(letzter));
}

/** Ausgabeformat des Lesebefehls: 'tabelle' (Name/Tabelle), 'strukturiert' (yaml/json) oder 'frei' (jsonpath, Template …). */
export function ausgabeFormat(befehl) {
  const s = String(befehl ?? '');
  const m = s.match(/(?:^|\s)(?:-o|--output)(?:\s+|=)(\S+)/) ?? s.match(/(?:^|\s)-o(\S+)/);
  if (!m) return 'tabelle';
  const wert = m[1].replace(/^['"]|['"]$/g, '').toLowerCase();
  if (wert === 'name' || wert === 'wide') return 'tabelle';
  if (wert === 'yaml' || wert === 'json') return 'strukturiert';
  // jsonpath, go-template, custom-columns: nur harmlos, wenn der Ausdruck keine Werte zieht.
  if (/^(?:jsonpath|go-template|template|custom-columns|custom-columns-file)=/.test(wert) || /^(?:jsonpath|go-template|template|custom-columns)$/.test(wert)) {
    const ausdruck = s.slice(s.indexOf(m[0]));
    const zieht = /\bdata\b|\bstringdata\b|\bbinarydata\b|annotation|last-applied|\{\s*(?:@|\.|\.items(?:\[\*?\])?)\s*\}|\{\{\s*(?:\.|\.items)\s*\}\}|\.\*|\bto(?:json|yaml)\b/i.test(ausdruck);
    return zieht ? 'frei' : 'tabelle';
  }
  return 'frei';
}

const FEHLER_ANFANG = /^\s*(?:error(?: from server)?\b|unable to\b|no resources found|the connection to the server|warning:)/i;

/**
 * Ist die Ausgabe dieses Befehls ganz zu schwärzen? Ja, wenn er ein Secret liest, das Format Werte liefern kann (nicht Name/Tabelle,
 * nicht yaml/json: die werden strukturell behandelt), und keine Verbraucher-Pipe die Ausgabe übernimmt.
 */
export function ausgabeGanzSchwaerzen(befehl, text) {
  const lesend = lesendeTeile(befehl);
  if (!lesend.length) return false;
  if (mitVerbraucher(befehl)) return false;
  const t = String(text ?? '');
  if (!t.trim()) return false;
  if (t.length < 600 && FEHLER_ANFANG.test(t)) return false;
  const teile = befehlTeile(befehl);
  const letzter = teile.at(-1) ?? '';
  const anzeige = /^(?:base64|xxd|openssl|python3?|node|jq|cut|tr|sed|awk|cat|tee|xargs|echo|printf|less|more|head|tail|column|grep)\b/.test(letzter);
  if (anzeige && teile.length > 1) return true;
  return lesend.some((teil) => ausgabeFormat(teil) === 'frei');
}

// --- Die Schwärzung -----------------------------------------------------------------------------------------------------

/**
 * Schwärzt Zugangsdaten und entfernt `<private>`-Abschnitte. Der übrige Text bleibt unverändert.
 * `kontext.befehl`: der Befehl, der den Text erzeugt hat (macht Secret-Lesebefehle erkennbar).
 */
export function schwaerzen(text, kontext = {}) {
  let aus = String(text ?? '');
  if (kontext.befehl && ausgabeGanzSchwaerzen(kontext.befehl, aus)) return SECRET_AUSGABE_ERSATZ;
  aus = secretObjekteSchwaerzen(aus);
  for (const [muster, ersatz] of MUSTER) aus = aus.replace(muster, ersatz);
  return aus.replace(LANG, langErsetzen);
}

/** Der Befehl eines Werkzeugaufrufs (bash `command`, knoten_befehl `befehl`), sonst leer. */
export function befehlVon(call) {
  const a = call?.arguments && typeof call.arguments === 'object' ? call.arguments : {};
  const b = a.command ?? a.befehl;
  return typeof b === 'string' ? b : '';
}

/** Wendet die Schwärzung auf die Textteile eines Werkzeugergebnisses an. Gibt nur zurück, was sich geändert hat. */
export function ergebnisSchwaerzen(inhalt, kontext = {}) {
  let geaendert = false;
  const neu = inhalt.map((teil) => {
    if (teil?.type !== 'text' || typeof teil.text !== 'string') return teil;
    const sauber = schwaerzen(teil.text, kontext);
    if (sauber !== teil.text) geaendert = true;
    return { ...teil, text: sauber };
  });
  return geaendert ? neu : undefined;
}

/** Alle Textwerte eines JSON-Werts schwärzen (Form bleibt erhalten). */
export function jsonSchwaerzen(wert, kontext = {}) {
  if (typeof wert === 'string') return schwaerzen(wert, kontext);
  if (Array.isArray(wert)) return wert.map((w) => jsonSchwaerzen(w, kontext));
  if (wert && typeof wert === 'object') {
    return Object.fromEntries(Object.entries(wert).map(([k, v]) => [k, jsonSchwaerzen(v, kontext)]));
  }
  return wert;
}

export function redaktionHooks() {
  const schwaerzer = hook(ToolTask, {
    afterTool: async (call, result) => {
      if (!Array.isArray(result?.output)) return undefined;
      const kontext = { befehl: befehlVon(call) };
      const neu = ergebnisSchwaerzen(result.output, kontext);
      if (!neu) return undefined;
      const aus = { ...result, output: neu };
      if (result.structuredOutput !== undefined) aus.structuredOutput = jsonSchwaerzen(result.structuredOutput, kontext);
      return aus;
    },
  });
  return [schwaerzer];
}
