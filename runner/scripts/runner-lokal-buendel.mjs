#!/usr/bin/env node
/**
 * runner-lokal-buendel.mjs — baut das Bündel des LOKALEN Runners (Programm für „Einstellungen → Lokaler Runner“ der Hülle).
 *
 *   node scripts/runner-lokal-buendel.mjs [--ziel <ordner>] [--node <pfad>] [--node-laden <version> --ziel-plattform <darwin-arm64|…>]
 *                                         [--quelle <runner-ordner>] [--ohne-npm]
 *
 * Ergebnis (Vorgabe: apps/fyos-agent/build/runner-lokal, steht in .gitignore und kommt NICHT ins Repo):
 *   runner-lokal        Startskript (das ist das „Programm“ in den Einstellungen)
 *   starten.mjs         Übersetzung des Vertrags in die Konfiguration (runner-lokal/starten.mjs)
 *   bin/node            das Node (>= 22.19)
 *   app/                package.json, src/ und node_modules (npm ci --omit=dev) des Runners aus deploy/runner/pi-durable
 *   VERSION.json
 * Ohne Tests, public/, Skripte und Dienstdatei. Gleiche Regeln für das Node wie scripts/ressourcen.mjs (Homebrew-Node ist nur lokal brauchbar).
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeLaden, versionReicht } from './ressourcen.mjs';

const HIER = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HIER, '..');
const REPO = resolve(APP, '..', '..');
// Im öffentlichen fyos-agent (Release 0.2) liegt dieses Skript in runner/scripts/: Runner ein Ordner darüber, Start in runner/lokal/.
const OEFFENTLICH = existsSync(join(HIER, '..', 'src', 'lokal.js'));
const LOKAL = OEFFENTLICH ? join(HIER, '..', 'lokal') : join(HIER, '..', 'runner-lokal');

const arg = (name, vorgabe = null) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : vorgabe;
};
const hat = (name) => process.argv.includes(name);

function lauf(befehl, args, opt = {}) {
  const r = spawnSync(befehl, args, { stdio: 'inherit', ...opt });
  if (r.status !== 0) throw new Error(`${befehl} ${args.join(' ')} endete mit ${r.status ?? r.signal}`);
}

function groesse(pfad) {
  let summe = 0;
  for (const e of readdirSync(pfad, { withFileTypes: true })) {
    const p = join(pfad, e.name);
    summe += e.isDirectory() ? groesse(p) : statSync(p).size;
  }
  return summe;
}

async function main() {
  const ziel = resolve(arg('--ziel', join(APP, 'build', 'runner-lokal')));
  const quelle = resolve(arg('--quelle', process.env.FYOS_RUNNER_QUELLE ?? (OEFFENTLICH ? APP : join(REPO, 'deploy', 'runner', 'pi-durable'))));
  if (!existsSync(join(quelle, 'src', 'lokal.js'))) throw new Error(`Runner-Quelle ohne src/lokal.js: ${quelle}`);

  let nodeQuelle = arg('--node', process.env.FYOS_NODE ?? null);
  if (!nodeQuelle && arg('--node-laden')) {
    const plattform = arg('--ziel-plattform');
    if (!plattform) throw new Error('--node-laden braucht --ziel-plattform (z. B. darwin-arm64)');
    nodeQuelle = await nodeLaden(arg('--node-laden'), plattform);
  }
  nodeQuelle ??= process.execPath;
  const v = spawnSync(nodeQuelle, ['--version'], { encoding: 'utf8' });
  if (v.status !== 0) throw new Error(`${nodeQuelle} --version schlug fehl`);
  const version = v.stdout.trim();
  if (!versionReicht(version)) throw new Error(`Node ${version} ist zu alt, der Runner braucht >= 22.19.0`);

  rmSync(ziel, { recursive: true, force: true });
  mkdirSync(join(ziel, 'app'), { recursive: true });
  mkdirSync(join(ziel, 'bin'), { recursive: true });
  cpSync(realpathSync(nodeQuelle), join(ziel, 'bin', 'node'));
  chmodSync(join(ziel, 'bin', 'node'), 0o755);
  // Homebrew-Node ist ein kleiner Starter plus libnode (hängt an /opt/homebrew): läuft hier, ist aber kein weitergebbares Bündel.
  const lib = join(dirname(dirname(realpathSync(nodeQuelle))), 'lib');
  const libnode = existsSync(lib) ? readdirSync(lib).find((f) => /^libnode.*\.dylib$/.test(f) || /^libnode\.so/.test(f)) : null;
  if (libnode) {
    mkdirSync(join(ziel, 'lib'), { recursive: true });
    cpSync(join(lib, libnode), join(ziel, 'lib', libnode));
    console.warn(`WARNUNG: ${nodeQuelle} ist ein Node mit libnode (Homebrew): das Bündel läuft nur mit denselben Homebrew-Bibliotheken. Zum Weitergeben --node-laden benutzen.`);
  }

  for (const eintrag of ['package.json', 'package-lock.json', 'src']) cpSync(join(quelle, eintrag), join(ziel, 'app', eintrag), { recursive: true });
  cpSync(join(LOKAL, 'starten.mjs'), join(ziel, 'starten.mjs'));
  cpSync(join(LOKAL, 'runner-lokal'), join(ziel, 'runner-lokal'));
  chmodSync(join(ziel, 'runner-lokal'), 0o755);

  if (!hat('--ohne-npm')) {
    lauf('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: join(ziel, 'app') });
    rmSync(join(ziel, 'app', 'node_modules', '.bin'), { recursive: true, force: true });
  }
  const paket = JSON.parse(readFileSync(join(quelle, 'package.json'), 'utf8'));
  writeFileSync(join(ziel, 'VERSION.json'), JSON.stringify({ node: version, runner: paket.version, art: 'lokal', gebaut: new Date().toISOString() }, null, 2) + '\n');
  const mb = (groesse(ziel) / 1048576).toFixed(1);
  console.log(`Bündel des lokalen Runners: ${ziel} (${mb} MB, Node ${version})`);
  console.log(`Programm für die Einstellungen der Hülle: ${join(ziel, 'runner-lokal')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('FEHLER:', e.message);
    process.exit(1);
  });
}
