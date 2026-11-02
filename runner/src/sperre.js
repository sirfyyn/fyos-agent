/**
 * sperre.js — Sperrliste für Dateien, die auf Geheimnisse hindeuten (`.env`, Schlüssel, Token-Dateien ...).
 *
 * Gilt für `GET /api/datei` (Lesen -> 403 `gesperrt`) und `GET /api/ordner?dateien=1` (Datei fehlt in der Liste).
 * Die Muster stehen in der Konfiguration (`pi_durable.dateiSperre`, Umgebung `FYOS_RUNNER_DATEI_SPERRE`); ohne Wert gilt die
 * Standardliste. Ein Muster ist ein Name mit `*` (beliebig viele Zeichen) und `?` (ein Zeichen), ohne Schrägstrich, ohne
 * Beachtung der Groß- und Kleinschreibung, und wird auf JEDEN Pfadteil unterhalb der Wurzel bzw. des Sitzungsordners
 * angewendet (also auch auf Ordner wie `.ssh`), jeweils für den Pfad wie angegeben UND für den aufgelösten Pfad (ein Link
 * mit harmlosem Namen auf `.env` ist gesperrt).
 * Das ist ein Netz gegen Versehen, keine Sandbox: Die Werkzeuge der Sitzung selbst lesen, was der Dienstnutzer lesen darf.
 */

export const SPERRE_STANDARD = [
  '.env',
  '.env.*',
  '*.env',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  '*.kdbx',
  '*.ppk',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '.netrc',
  '_netrc',
  '.npmrc',
  '.pypirc',
  '.pgpass',
  '.git-credentials',
  '.htpasswd',
  '.ssh',
  '.gnupg',
  '.aws',
  '.kube',
  'credentials',
  'credentials.*',
  'client_secret*.json',
  'service-account*.json',
  '*.tfstate',
  '*.tfvars',
  '.token',
  '*.token',
  '*-token',
  '*_token',
  'token.txt',
  'token.json',
  'tokens.json',
  'tokens.txt',
  'secret',
  'secrets',
  '*.secret',
  '*.secrets',
  'secret.txt',
  'secret.json',
  'secrets.json',
  'secrets.txt',
  'secrets.yml',
  'secrets.yaml',
  'secrets.toml',
];

/**
 * Liest den Umgebungswert: Komma-getrennte Muster. Beginnt er mit `+`, kommen die Muster zur Standardliste hinzu, sonst
 * ersetzen sie sie. Leer oder fehlend: Standardliste. Muster mit Schrägstrich oder Nullbyte fallen weg.
 */
export function sperreLesen(roh) {
  const text = String(roh ?? '').trim();
  if (!text) return [...SPERRE_STANDARD];
  const zusatz = text.startsWith('+');
  const muster = (zusatz ? text.slice(1) : text)
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m && !m.includes('/') && !m.includes('\0'));
  if (!muster.length) return [...SPERRE_STANDARD];
  return zusatz ? [...new Set([...SPERRE_STANDARD, ...muster])] : [...new Set(muster)];
}

const regexCache = new Map();

function musterRegex(muster) {
  let r = regexCache.get(muster);
  if (!r) {
    const quelle = muster
      .split('')
      .map((c) => (c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
      .join('');
    r = new RegExp(`^${quelle}$`, 'i');
    regexCache.set(muster, r);
  }
  return r;
}

/** Trifft die Sperrliste diesen einen Namen? */
export function nameGesperrt(name, sperre) {
  return (sperre ?? []).some((m) => musterRegex(m).test(name));
}

/** Trifft die Sperrliste irgendeinen Teil des relativen Pfads (`a/b/c.txt`)? */
export function pfadGesperrt(relativ, sperre) {
  return String(relativ)
    .split('/')
    .filter((t) => t && t !== '.')
    .some((t) => nameGesperrt(t, sperre));
}
