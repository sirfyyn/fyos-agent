import assert from 'node:assert/strict';
import { test } from 'node:test';
import { erzeugeWaechter, zerlege } from '../src/waechter.js';

// Ein fester Heimatordner, damit die Tests auf jedem Rechner dasselbe prüfen.
const home = '/tmp/waechter-home';
const pruefe = erzeugeWaechter({ home, hauptcheckout: `${home}/fyos` });

test('Home und Wurzel sind für rm -r gesperrt', () => {
  assert.match(pruefe('rm -rf /', '/tmp'), /Wurzel/);
  assert.match(pruefe(`rm -rf ${home}`, '/tmp'), /Home/);
  assert.match(pruefe('rm -rf ~', '/tmp'), /Home/);
  assert.match(pruefe('rm -rf $HOME', '/tmp'), /Home/);
});

test('Hauptcheckout und Vorfahren sind für rm -r gesperrt', () => {
  assert.match(pruefe(`rm -rf ${home}/fyos`, '/tmp'), /Hauptcheckout|Home/);
});

test('leere Pfadvariable ist gesperrt, eine Variable mit Unterpfad nicht', () => {
  assert.match(pruefe('rm -rf $X', '/tmp'), /leer sein/);
  assert.match(pruefe('rm -rf ${X}/', '/tmp'), /leer sein/);
  assert.equal(pruefe('rm -rf $W/build', '/tmp'), null);
});

test('gewöhnliches Aufräumen läuft durch', () => {
  assert.equal(pruefe('rm -rf build', '/tmp'), null);
  assert.equal(pruefe('rm datei.txt', '/tmp'), null);
  assert.equal(pruefe('rm -r /tmp/irgendwas', '/tmp'), null);
  assert.equal(pruefe('ls -la && echo fertig', '/tmp'), null);
});

test('gefährliches Ziel hinter && oder ; wird gefunden', () => {
  assert.match(pruefe('echo hi && rm -rf /', '/tmp'), /Wurzel/);
  assert.match(pruefe('echo hi; rm -rf /', '/tmp'), /Wurzel/);
  assert.match(pruefe('true | rm -rf /', '/tmp'), /Wurzel/);
});

test('git clean -f und reset --hard sind nur im Hauptcheckout gesperrt', () => {
  const haupt = `${home}/fyos`;
  assert.equal(pruefe('git clean -fd', '/tmp'), null);
  assert.equal(pruefe('git reset --hard', '/tmp'), null);
  // Das Verzeichnis existiert nicht; der Wächter löst es als Pfad auf und erkennt den Hauptcheckout trotzdem.
  assert.match(pruefe('git clean -fd', haupt), /git clean/);
  assert.match(pruefe('git reset --hard HEAD~1', haupt), /git reset/);
  assert.equal(pruefe('git clean -nd', haupt), null);
  assert.equal(pruefe('git status', haupt), null);
});

test('Worktrees unter .claude/worktrees zählen nicht als Hauptcheckout', () => {
  assert.equal(pruefe('git reset --hard', `${home}/fyos/.claude/worktrees/x`), null);
});

test('cd in den Hauptcheckout schaltet die Git-Regeln scharf', () => {
  assert.match(pruefe(`cd ${home}/fyos && git reset --hard`, '/tmp'), /git reset/);
});

test('zerlege versteht Anführungszeichen und Trenner', () => {
  assert.deepEqual(zerlege(`echo "a b" 'c d' e\\ f`), ['echo', 'a b', 'c d', 'e f']);
  assert.deepEqual(zerlege('a&&b;c'), ['a', '&&', 'b', ';', 'c']);
  assert.equal(zerlege('echo "offen'), null);
});

test('unlesbarer Befehl sperrt nicht grundlos', () => {
  assert.equal(pruefe('echo "offen', '/tmp'), null);
});
