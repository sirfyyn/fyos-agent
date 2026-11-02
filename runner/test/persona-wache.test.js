import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { STANDARD_REGELN, begruendung, istSperre, regelnPruefen, treffer, urteil, wacheHooks } from '../src/persona/wache.js';

const regeln = regelnPruefen(STANDARD_REGELN);
const CWD = '/var/lib/fyos-agent/arbeit';
const bash = (command) => urteil(regeln, 'bash', { command }, CWD);

// --- Die Prüflogik, Fälle des alten kern.test.ts (Urteil unverändert) ---

test('rekursives Löschen braucht Freigabe, normales rm nicht', () => {
  assert.equal(bash('rm -rf /var/lib/fyos-agent/arbeit/tmp').aktion, 'freigabe');
  assert.equal(bash('rm -fr x').aktion, 'freigabe');
  assert.equal(bash('rm --recursive x').aktion, 'freigabe');
  assert.equal(bash('rm datei.txt').erlaubt, true);
  assert.equal(bash('rm -f datei.txt').erlaubt, true);
});

test('Force-Push wird blockiert, Force-with-lease und normales Pushen nicht', () => {
  assert.equal(bash('git push --force origin main').aktion, 'blockieren');
  assert.equal(bash('git push -f origin main').aktion, 'blockieren');
  assert.equal(bash('git push origin +main').aktion, 'blockieren');
  assert.equal(bash('git push --force-with-lease origin main').erlaubt, true);
  assert.equal(bash('git push origin feature').erlaubt, true);
});

test('Zugangsdaten bleiben im Urteil zu, über Pfad und über Befehl', () => {
  assert.equal(urteil(regeln, 'read', { path: '/etc/fyos/fyos-oeffnen-agent.token' }, CWD).aktion, 'blockieren');
  assert.equal(urteil(regeln, 'read', { path: '/var/lib/fyos-agent/arbeit/.env' }, CWD).aktion, 'blockieren');
  assert.equal(urteil(regeln, 'edit', { path: '/home/x/.ssh/id_rsa' }, CWD).aktion, 'blockieren');
  assert.equal(bash('cat /etc/fyos/x.token').aktion, 'blockieren');
  assert.equal(bash('grep -r id_rsa ~/').aktion, 'blockieren');
  assert.equal(bash('ls -la').erlaubt, true);
});

test('sudo wird erkannt, auch hinter einem Trennzeichen', () => {
  assert.equal(bash('sudo systemctl restart x').aktion, 'blockieren');
  assert.equal(bash('echo ok && sudo ls').aktion, 'blockieren');
});

test('Freigabe-pflichtige Befehle gehen an Besitzer', () => {
  assert.equal(bash('git reset --hard HEAD~1').aktion, 'freigabe');
  assert.equal(bash('kubectl delete pod x').aktion, 'freigabe');
  assert.equal(bash('systemctl set-property fyos-agent-runner MemoryMax=8G').aktion, 'freigabe');
  assert.equal(bash('systemctl status fyos-agent-runner').erlaubt, true);
  assert.equal(bash('git branch -D alt').aktion, 'freigabe');
});

test('Schreiben innerhalb des Arbeitsbereichs ist frei, außerhalb nur Hinweis-Urteil, auch über ..', () => {
  assert.equal(urteil(regeln, 'write', { path: 'notiz.md' }, CWD).erlaubt, true);
  assert.equal(urteil(regeln, 'edit', { path: '/var/lib/fyos-agent/kontextbuch/x.md' }, CWD).erlaubt, true);
  assert.equal(urteil(regeln, 'edit', { path: '/etc/hosts' }, CWD).aktion, 'freigabe');
  assert.equal(urteil(regeln, 'write', { path: '../../../etc/x' }, CWD).aktion, 'freigabe');
});

test('ungültige Regeln brechen das Laden ab, statt zu erlauben', () => {
  assert.throws(() =>
    regelnPruefen({ schreibbar: ['/a'], regeln: [{ id: 'x', werkzeug: '*', feld: 'command', muster: '(', aktion: 'blockieren', grund: 'g' }] }),
  );
  assert.throws(() => regelnPruefen({ schreibbar: ['relativ'], regeln: [] }));
  assert.throws(() =>
    regelnPruefen({ schreibbar: [], regeln: [{ id: 'x', werkzeug: '*', feld: 'command', muster: 'a', aktion: 'erlauben', grund: 'g' }] }),
  );
  assert.throws(() =>
    regelnPruefen({ schreibbar: [], regeln: [{ id: 'x', werkzeug: '*', feld: 'command', muster: 'a', aktion: 'blockieren', haerte: 'hart', grund: 'g' }] }),
  );
});

// --- Härte: nur Zerstörendes sperrt ---

const sperrt = (werkzeug, eingabe) => treffer(regeln, werkzeug, eingabe, CWD).some((u) => istSperre(u, werkzeug));
const hinweise = (werkzeug, eingabe) =>
  treffer(regeln, werkzeug, eingabe, CWD)
    .filter((u) => !istSperre(u, werkzeug))
    .map((u) => u.regel);

test('Zerstörendes bleibt gesperrt', () => {
  for (const c of [
    'git push --force origin main',
    'git branch -D alt',
    'git reset --hard HEAD~1',
    'git clean -fd',
    'kubectl delete pod x',
    'kubectl drain n1',
  ]) {
    assert.equal(sperrt('bash', { command: c }), true, c);
  }
});

test('rm -r ist nur ein Hinweis (das Katastrophale sperrt waechter.js), kubectl delete job ist erlaubt', () => {
  assert.equal(sperrt('bash', { command: 'rm -rf build' }), false);
  assert.deepEqual(hinweise('bash', { command: 'rm -rf build' }), ['rekursiv-loeschen']);
  assert.equal(sperrt('bash', { command: 'kubectl delete job x -n fyos' }), false);
  assert.equal(sperrt('bash', { command: 'kubectl delete pod x' }), true);
});

test('sudo, Dienste, Zugangsdaten-Befehl und Lesen von Zugangsdaten sind nur Hinweise', () => {
  assert.equal(sperrt('bash', { command: 'sudo systemctl restart x' }), false);
  assert.deepEqual(hinweise('bash', { command: 'sudo ls' }), ['rechte-erhoehen']);
  assert.equal(sperrt('bash', { command: 'systemctl stop x' }), false);
  assert.deepEqual(hinweise('bash', { command: 'systemctl stop x' }), ['dienste-umstellen']);
  assert.equal(sperrt('bash', { command: 'cat /etc/fyos/x.token' }), false);
  assert.deepEqual(hinweise('bash', { command: 'cat /etc/fyos/x.token' }), ['zugangsdaten-befehl']);
  assert.equal(sperrt('read', { path: '/etc/fyos/x.token' }), false);
  assert.deepEqual(hinweise('read', { path: '/etc/fyos/x.token' }), ['zugangsdaten-pfad']);
});

test('Zugangsdaten überschreiben (write, edit) bleibt gesperrt', () => {
  assert.equal(sperrt('write', { path: '/home/x/.ssh/id_rsa' }), true);
  assert.equal(sperrt('edit', { path: '/var/lib/fyos-agent/arbeit/.env' }), true);
});

test('Schreiben außerhalb des Arbeitsbereichs ist ein Hinweis', () => {
  assert.equal(sperrt('write', { path: '/etc/hosts' }), false);
  assert.deepEqual(hinweise('write', { path: '/etc/hosts' }), ['schreiben-ausserhalb']);
  assert.deepEqual(hinweise('write', { path: 'ok.md' }), []);
});

test('ein Hinweis verdeckt keine Sperre: Befehl mit .env und rm -rf', () => {
  const alle = treffer(regeln, 'bash', { command: 'git push --force && cat .env' }, CWD);
  assert.equal(alle.some((u) => istSperre(u, 'bash')), true);
  assert.equal(alle.length, 2);
});

test('Begründung der Sperre nennt den Weg über freigabe_bitten', () => {
  assert.match(begruendung(bash('rm -rf x')), /freigabe_bitten/);
  assert.match(begruendung(bash('git push -f')), /Nicht erlaubt/);
});

// --- Der Hook ---

function hookMit(optionen = {}) {
  const [h] = wacheHooks({ cfg: { arbeitsbereiche: { standard: { pfad: CWD, titel: 'Standard' } } }, env: {}, ...optionen });
  return h.handlers;
}
const aufruf = (name, args) => ({ type: 'toolCall', id: 't1', name, arguments: args });
const api = { conversationId: 'c1' };

test('Hook beforeTool: sperrt Zerstörendes mit Begründung, lässt sudo durch', async () => {
  const { beforeTool } = hookMit();
  const g = await beforeTool(aufruf('bash', { command: 'git push --force origin main' }), api, {});
  assert.match(g.block, /PERSONA-WACHE.*Force-Push/);
  assert.match(g.block, /freigabe_bitten/);
  assert.equal(await beforeTool(aufruf('bash', { command: 'rm -rf /x' }), api, {}), undefined);
  assert.equal(await beforeTool(aufruf('bash', { command: 'sudo ls' }), api, {}), undefined);
  assert.equal(await beforeTool(aufruf('bash', { command: 'ls -la' }), api, {}), undefined);
  assert.equal(await beforeTool(aufruf('hub_suchen', { suche: 'x' }), api, {}), undefined);
});

test('Hook beforeTool: knoten_befehl wird wie bash geprüft', async () => {
  const { beforeTool } = hookMit();
  const g = await beforeTool(aufruf('knoten_befehl', { knoten: 'hauptserver', befehl: 'kubectl delete ns x' }), api, {});
  assert.match(g.block, /Cluster/);
  assert.equal(await beforeTool(aufruf('knoten_befehl', { knoten: 'hauptserver', befehl: 'uptime' }), api, {}), undefined);
});

test('Hook beforeTool: Schreiben auf Zugangsdaten gesperrt, Lesen nicht', async () => {
  const { beforeTool } = hookMit();
  assert.match((await beforeTool(aufruf('write', { path: '/home/x/.ssh/id_rsa', content: 'x' }), api, {})).block, /Zugangsdaten/);
  assert.equal(await beforeTool(aufruf('read', { path: '/etc/fyos/a.token' }), api, {}), undefined);
});

test('Hook afterTool: Hinweise stehen als Diagnose am Ergebnis, der Rest bleibt', async () => {
  const { afterTool } = hookMit();
  const result = { output: [{ type: 'text', text: 'ok' }], diagnostics: [{ severity: 'info', message: 'vorher' }] };
  const r = await afterTool(aufruf('bash', { command: 'sudo systemctl stop x' }), result, api, {});
  assert.equal(r.output, result.output);
  assert.equal(r.diagnostics.length, 3);
  assert.equal(r.diagnostics[0].message, 'vorher');
  assert.deepEqual(r.diagnostics.slice(1).map((d) => d.code).sort(), ['wache:dienste-umstellen', 'wache:rechte-erhoehen']);
  assert.ok(r.diagnostics.every((d) => d.severity === 'warn' || d.message === 'vorher'));
  assert.equal(await afterTool(aufruf('bash', { command: 'ls' }), result, api, {}), undefined);
});

test('Hook afterTool: Schreiben außerhalb nutzt den Ordner des Gesprächs für relative Pfade', async () => {
  const { afterTool } = hookMit({ cwdFuer: async () => '/opt/ganz-woanders' });
  const r = await afterTool(aufruf('write', { path: 'notiz.md', content: '' }), { output: [] }, api, {});
  assert.equal(r.diagnostics[0].code, 'wache:schreiben-ausserhalb');
  const { afterTool: innen } = hookMit({ cwdFuer: async () => CWD });
  assert.equal(await innen(aufruf('write', { path: 'notiz.md', content: '' }), { output: [] }, api, {}), undefined);
});

test('Arbeitsbereiche der Konfiguration sind schreibbar', async () => {
  const { afterTool } = hookMit({
    cfg: { arbeitsbereiche: { standard: { pfad: CWD }, repo: { pfad: '/srv/repo' } } },
  });
  assert.equal(await afterTool(aufruf('write', { path: '/srv/repo/a.md', content: '' }), { output: [] }, api, {}), undefined);
});

test('Regeldatei: gültige ersetzt die eingebauten, kaputte fällt zurück und wird gemeldet', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wache-'));
  const gut = join(dir, 'regeln.json');
  writeFileSync(
    gut,
    JSON.stringify({ schreibbar: ['/a'], regeln: [{ id: 'nur-das', werkzeug: 'bash', feld: 'command', muster: 'verboten', aktion: 'blockieren', grund: 'g' }] }),
  );
  const a = hookMit({ env: { FYOS_WACHE_REGELN: gut } });
  assert.match((await a.beforeTool(aufruf('bash', { command: 'tu verboten' }), api, {})).block, /g\. Zerstörend, darum mit Freigabe/);
  assert.equal(await a.beforeTool(aufruf('bash', { command: 'rm -rf x' }), api, {}), undefined);

  const kaputt = join(dir, 'kaputt.json');
  writeFileSync(kaputt, '{ kein json');
  const b = hookMit({ env: { FYOS_WACHE_REGELN: kaputt } });
  assert.match((await b.beforeTool(aufruf('bash', { command: 'git push --force' }), api, {})).block, /Force-Push/);
  const r = await b.afterTool(aufruf('bash', { command: 'ls' }), { output: [] }, api, {});
  assert.equal(r.diagnostics[0].code, 'wache:regeln');
});

test('Eine Wache mit vorgegebenen Regeln (Tests) nimmt sie wörtlich', async () => {
  const eigene = regelnPruefen({
    schreibbar: ['/a'],
    regeln: [{ id: 'x', werkzeug: 'bash', feld: 'command', muster: 'boese', aktion: 'blockieren', haerte: 'hinweis', grund: 'g' }],
  });
  const { beforeTool, afterTool } = hookMit({ regeln: eigene });
  assert.equal(await beforeTool(aufruf('bash', { command: 'boese' }), api, {}), undefined);
  assert.equal((await afterTool(aufruf('bash', { command: 'boese' }), { output: [] }, api, {})).diagnostics[0].code, 'wache:x');
});
