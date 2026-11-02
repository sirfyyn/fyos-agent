/**
 * version.js — welche Fassung läuft?
 *
 * Paketversion (package.json) plus Git-Stand aus der Datei `VERSION` neben package.json. Die Datei schreibt
 * `scripts/ops/hauptserver/pi_durable_einrichten.sh` und `pi_durable_paket.sh bauen` beim Einrichten (Zeilen `schluessel=wert`):
 *
 *   git=f1b37ceb2          Git-Stand des Mac-Checkouts, `-dirty` bei ungesicherten Änderungen im Runner-Ordner
 *   zweig=main
 *   gebaut=2026-10-25T17:30:00Z
 *   paket=0.1.0
 *
 * Ohne Datei (Entwicklung, Tests) meldet der Runner die Paketversion und `git=unbekannt`; er rät nichts.
 */
import { readFileSync } from 'node:fs';

const PAKET_JSON = new URL('../package.json', import.meta.url);
const VERSION_DATEI = new URL('../VERSION', import.meta.url);

export function versionDateiLesen(datei = VERSION_DATEI) {
  const aus = {};
  try {
    for (const zeile of readFileSync(datei, 'utf8').split('\n')) {
      const m = zeile.match(/^([a-z_]+)=(.*)$/);
      if (m) aus[m[1]] = m[2].trim();
    }
  } catch {
    return null;
  }
  return aus;
}

/** `{version, paket, git, zweig, gebaut, quelle}`; `version` ist die kurze Zeichenkette „0.1.0+f1b37ceb2“. */
export function versionErmitteln({ datei, paketJson = PAKET_JSON } = {}) {
  let paket = 'unbekannt';
  try {
    paket = String(JSON.parse(readFileSync(paketJson, 'utf8')).version ?? 'unbekannt');
  } catch {
    /* bleibt unbekannt */
  }
  const d = versionDateiLesen(datei);
  const git = d?.git || 'unbekannt';
  return {
    version: `${paket}+${git}`,
    paket,
    git,
    zweig: d?.zweig || null,
    gebaut: d?.gebaut || null,
    quelle: d ? 'VERSION' : 'keine VERSION-Datei',
  };
}
