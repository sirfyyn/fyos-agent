#!/usr/bin/env node
/**
 * ressourcen.mjs — legt den Runner und sein Node in src-tauri/resources/runner/ ab (wird ins Bündel kopiert).
 *
 *   node scripts/ressourcen.mjs [--node <pfad>] [--node-laden <version> --ziel <darwin-arm64|linux-x64|linux-arm64>]
 *                               [--quelle <runner-ordner>] [--ohne-npm]
 *
 * Ergebnis:
 *   src-tauri/resources/runner/bin/node      das Node für den Runner (>= 22.19)
 *   src-tauri/resources/runner/lib/…         nur bei Homebrew-Node (libnode), siehe unten
 *   src-tauri/resources/runner/app/…         package.json, src/, public/ und node_modules (npm ci --omit=dev)
 *
 * Welches Node:
 *   1. --node <pfad> oder FYOS_NODE
 *   2. --node-laden <version> --ziel <plattform>: offizieller Tarball von nodejs.org, SHA-256 gegen SHASUMS256.txt geprüft
 *      (so holt die CI die richtige Binärdatei je Ziel; hier nicht ausgeführt)
 *   3. sonst das Node, das dieses Skript ausführt (macOS-Entwicklungsbau, Docker-Bau mit dem offiziellen node-Image).
 * Ein Homebrew-Node ist ein kleiner Starter plus libnode.dylib, und libnode hängt an /opt/homebrew. Das läuft auf dieser
 * Maschine, ist aber KEIN weitergebbares Bündel: dafür --node-laden benutzen.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HIER = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HIER, '..');
const REPO = resolve(APP, '..', '..');
const ZIEL = join(APP, 'src-tauri', 'resources', 'runner');
const MIN_NODE = [22, 19, 0];

const arg = (name, vorgabe = null) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : vorgabe;
};
const hat = (name) => process.argv.includes(name);

function lauf(befehl, args, opt = {}) {
  const r = spawnSync(befehl, args, { stdio: 'inherit', ...opt });
  if (r.status !== 0) throw new Error(`${befehl} ${args.join(' ')} endete mit ${r.status ?? r.signal}`);
}

function versionVon(nodePfad) {
  const r = spawnSync(nodePfad, ['--version'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${nodePfad} --version schlug fehl: ${r.stderr}`);
  return r.stdout.trim();
}

export function versionReicht(text, min = MIN_NODE) {
  const t = String(text).trim().replace(/^v/, '').split('.').map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < 3; i++) {
    const a = t[i] || 0;
    if (a !== min[i]) return a > min[i];
  }
  return true;
}

export async function nodeLaden(version, plattform) {
  const v = version.replace(/^v/, '');
  const name = `node-v${v}-${plattform}`;
  const basis = `https://nodejs.org/dist/v${v}`;
  const arbeit = join(tmpdir(), `fyos-agent-node-${process.pid}`);
  rmSync(arbeit, { recursive: true, force: true });
  mkdirSync(arbeit, { recursive: true });
  const summen = await (await fetch(`${basis}/SHASUMS256.txt`)).text();
  const zeile = summen.split('\n').find((l) => l.endsWith(`  ${name}.tar.gz`));
  if (!zeile) throw new Error(`keine Prüfsumme für ${name}.tar.gz`);
  const soll = zeile.split(/\s+/)[0];
  const datei = join(arbeit, `${name}.tar.gz`);
  const antwort = await fetch(`${basis}/${name}.tar.gz`);
  if (!antwort.ok) throw new Error(`Download ${antwort.status}`);
  const bytes = Buffer.from(await antwort.arrayBuffer());
  const ist = createHash('sha256').update(bytes).digest('hex');
  if (ist !== soll) throw new Error(`Prüfsumme stimmt nicht: ${ist} != ${soll}`);
  writeFileSync(datei, bytes);
  lauf('tar', ['-xzf', datei, '-C', arbeit, `${name}/bin/node`]);
  return join(arbeit, name, 'bin', 'node');
}

function homebrewLibnode(nodePfad) {
  const echt = realpathSync(nodePfad);
  const lib = join(dirname(dirname(echt)), 'lib');
  if (!existsSync(lib)) return null;
  const d = readdirSync(lib).find((f) => /^libnode.*\.dylib$/.test(f) || /^libnode\.so/.test(f));
  return d ? join(lib, d) : null;
}

async function main() {
  const quelle = resolve(arg('--quelle', process.env.FYOS_RUNNER_QUELLE ?? join(REPO, 'deploy', 'runner', 'pi-durable')));
  if (!existsSync(join(quelle, 'package.json'))) throw new Error(`Runner-Quelle fehlt: ${quelle}`);

  let nodeQuelle = arg('--node', process.env.FYOS_NODE ?? null);
  if (!nodeQuelle && arg('--node-laden')) {
    const ziel = arg('--ziel');
    if (!ziel) throw new Error('--node-laden braucht --ziel (z. B. linux-x64)');
    nodeQuelle = await nodeLaden(arg('--node-laden'), ziel);
  }
  nodeQuelle ??= process.execPath;
  const version = versionVon(nodeQuelle);
  if (!versionReicht(version)) throw new Error(`Node ${version} ist zu alt, der Runner braucht >= ${MIN_NODE.join('.')}`);

  rmSync(ZIEL, { recursive: true, force: true });
  mkdirSync(join(ZIEL, 'app'), { recursive: true });

  // Node
  mkdirSync(join(ZIEL, 'bin'), { recursive: true });
  const nodeZiel = join(ZIEL, 'bin', 'node');
  cpSync(realpathSync(nodeQuelle), nodeZiel);
  chmodSync(nodeZiel, 0o755);
  const libnode = homebrewLibnode(nodeQuelle);
  if (libnode) {
    mkdirSync(join(ZIEL, 'lib'), { recursive: true });
    cpSync(libnode, join(ZIEL, 'lib', libnode.split('/').pop()));
    console.warn(`WARNUNG: ${nodeQuelle} ist ein Node mit libnode (Homebrew). Das Bündel läuft nur auf Rechnern mit denselben Homebrew-Bibliotheken.`);
  }

  // Runner-Code (ohne Tests, Skripte, Dienstdatei) und Produktionsabhängigkeiten
  for (const eintrag of ['package.json', 'package-lock.json', 'src', 'public']) {
    cpSync(join(quelle, eintrag), join(ZIEL, 'app', eintrag), { recursive: true });
  }
  if (!hat('--ohne-npm')) {
    // Das Node, das später läuft, soll auch installieren (gleiche ABI); npm kommt vom Bau-Rechner.
    lauf('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: join(ZIEL, 'app') });
    rmSync(join(ZIEL, 'app', 'node_modules', '.bin'), { recursive: true, force: true }); // Symlinks stören die Bündelung
  }
  writeFileSync(
    join(ZIEL, 'VERSION.json'),
    JSON.stringify({ node: version, runner: JSON.parse(readFileSync(join(quelle, 'package.json'), 'utf8')).version, gebaut: new Date().toISOString() }, null, 2) + '\n',
  );
  console.log(`Runner-Ressourcen bereit: ${ZIEL} (Node ${version}${libnode ? ', Homebrew-libnode' : ''})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('FEHLER:', e.message);
    process.exit(1);
  });
}
