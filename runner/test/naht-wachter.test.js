/**
 * Wächter der Naht (docs/current/PI-DURABLE-RUNNER.md#naht):
 *  1. Außerhalb von `src/lauf/` importiert keine Datei in `src/` ein @earendil-works-Paket (statisch, dynamisch, require).
 *  2. Die Fenster-Eigenheit des Verlaufs (`conv.entries(...)`, `conv.context(...)`) wird nur in `src/lauf/` gelesen.
 *  3. Die Ausnahmeliste ist leer; jeder Eintrag bräuchte hier eine Begründung.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const NAHT = join(SRC, 'lauf') + sep;

/** Ausnahmen: relativer Pfad in src/ → Begründung. Leer halten. */
const AUSNAHMEN = {};

function dateien(ordner) {
  const aus = [];
  for (const name of readdirSync(ordner)) {
    const pfad = join(ordner, name);
    if (statSync(pfad).isDirectory()) aus.push(...dateien(pfad));
    else if (/\.(js|mjs|cjs|ts)$/.test(name)) aus.push(pfad);
  }
  return aus;
}

/** Quelltext ohne Zeilen- und Blockkommentare (Kommentare dürfen Paketnamen nennen). */
function ohneKommentare(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const ausserhalb = () => dateien(SRC).filter((d) => !d.startsWith(NAHT) && !(relative(SRC, d) in AUSNAHMEN));

test('Naht: außerhalb von src/lauf/ kein Import aus @earendil-works', () => {
  const verstoesse = [];
  for (const datei of ausserhalb()) {
    const code = ohneKommentare(readFileSync(datei, 'utf8'));
    for (const treffer of code.matchAll(/(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)['"`](@earendil-works\/[^'"`]+)['"`]/g)) {
      verstoesse.push(`${relative(SRC, datei)}: ${treffer[1]}`);
    }
  }
  assert.deepEqual(verstoesse, [], `Importe an der Naht vorbei:\n${verstoesse.join('\n')}`);
});

test('Naht: src/lauf/ ist der Ort, der die drei Pakete wirklich einbindet', () => {
  const pakete = new Set();
  for (const datei of dateien(SRC).filter((d) => d.startsWith(NAHT))) {
    for (const t of ohneKommentare(readFileSync(datei, 'utf8')).matchAll(/['"](@earendil-works\/[a-z-]+)/g)) pakete.add(t[1]);
  }
  assert.deepEqual([...pakete].sort(), ['@earendil-works/chord', '@earendil-works/pi-ai', '@earendil-works/pi-durable']);
});

test('Naht: die Fenster-Eigenheit des Verlaufs (entries/context eines Gesprächs) wird nur in src/lauf/ gelesen', () => {
  const verstoesse = [];
  for (const datei of ausserhalb()) {
    const code = ohneKommentare(readFileSync(datei, 'utf8'));
    // `conv.entries(`, `gespraech.context(`, `runtime.context(` usw. — Object.entries/Map.entries sind kein Gesprächsverlauf.
    for (const treffer of code.matchAll(/\b(?!Object\b|titel\b|je\b|m\b)([A-Za-z_][\w.]*)\.(entries|context)\(\s*(\{ order|CTX|ctx|context|KONTEXT|[a-zA-Z]+Id\b|rec\.kindId|kindId)/g)) {
      verstoesse.push(`${relative(SRC, datei)}: ${treffer[0]}`);
    }
  }
  assert.deepEqual(verstoesse, [], `Verlauf an der Naht vorbei:\n${verstoesse.join('\n')}`);
});

test('Naht: die Ausnahmeliste ist leer', () => {
  assert.deepEqual(Object.keys(AUSNAHMEN), []);
});
