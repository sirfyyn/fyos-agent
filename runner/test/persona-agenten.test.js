// Prüft persona/agenten.js mit einem falschen pi (kleines Node-Skript, das Ereigniszeilen wie `pi --mode json` ausgibt):
// Schlussantwort, Werkzeugliste je Art, höchstens zwei Plätze, Zeitgrenze, Abbruch, Exit-Fehler,
// keine Geheimnisse in der Umgebung des Kindes, keine Verschachtelung, toter Platz wird übernommen.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentenWerkzeuge, schlussantwort } from '../src/persona/agenten.js';

const w = mkdtempSync(join(tmpdir(), 'agenten-'));
const falsch = join(w, 'falsch-pi.mjs');
writeFileSync(
  falsch,
  `const a = process.argv.slice(2);
const aufgabe = a[a.length - 1];
const ms = Number((/schlaf (\\d+)/.exec(aufgabe) || [])[1] || 0);
await new Promise((r) => setTimeout(r, ms));
if (/exit 3/.test(aufgabe)) { console.error("kaputt"); process.exit(3); }
const ausgabe = JSON.stringify({ argumente: a.slice(0, -1).filter((x) => !x.endsWith("system.md")), aufgabe, geheim: process.env.GITEA_TOKEN ?? null, unter: process.env.FYOS_UNTERAGENT ?? null, cwd: process.cwd() });
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Zwischenstand" }] } }));
console.log("keine json-zeile");
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: ausgabe }], stopReason: "stop" } }));
`,
);

const lebt = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function aufbau(extra = {}) {
  const env = { ...process.env, FYOS_UNTERAGENTEN_DIR: join(mkdtempSync(join(tmpdir(), 'slots-')), 'u'), GITEA_TOKEN: 'geheim-wert', ...extra };
  const werkzeuge = agentenWerkzeuge({ cfg: { arbeitsbereiche: { standard: { pfad: w } } }, env, befehl: [process.execPath, falsch], pidLebt: lebt, fristMinS: 1 });
  const wz = werkzeuge.find((t) => t.name === 'unteragent');
  return { rufen: (p, signal) => wz?.execute(p, { conversationId: 'c' }, { signal }), werkzeuge, env };
}

const antwortJson = (r) => JSON.parse(/:\n([\s\S]*)$/.exec(r.output[0].text)[1]);

test('lesen: Schlussantwort, nur Lesewerkzeuge, ohne Erweiterungen, Geheimnis und Verschachtelung', async () => {
  const { rufen } = aufbau();
  const a = antwortJson(await rufen({ aufgabe: 'Lies die Datei und fasse zusammen', ordner: w }));
  assert.equal(a.aufgabe, 'Aufgabe: Lies die Datei und fasse zusammen');
  assert.ok(a.argumente.includes('--no-extensions') && a.argumente.includes('--no-mcp') && a.argumente.includes('--no-session'));
  assert.equal(a.argumente[a.argumente.indexOf('--tools') + 1], 'read,grep,find,ls');
  assert.equal(a.geheim, null);
  assert.equal(a.unter, '1');
  assert.match(a.cwd, /agenten-/);
});

test('ohne ordner gilt der Standardordner der Konfiguration', async () => {
  const { rufen } = aufbau();
  const a = antwortJson(await rufen({ aufgabe: 'Lies die Datei und fasse zusammen' }));
  assert.match(a.cwd, /agenten-/);
});

test('arbeiten: Werkzeuge mit bash, edit, write', async () => {
  const { rufen } = aufbau();
  const a = antwortJson(await rufen({ aufgabe: 'Ändere die Datei und teste', art: 'arbeiten', ordner: w }));
  assert.equal(a.argumente[a.argumente.indexOf('--tools') + 1], 'read,grep,find,ls,bash,edit,write');
});

test('zwei laufen parallel, der dritte wird sofort abgewiesen, danach ist ein Platz wieder frei', async () => {
  const { rufen } = aufbau();
  const t0 = Date.now();
  const a = rufen({ aufgabe: 'schlaf 700 und melde dich', ordner: w });
  const b = rufen({ aufgabe: 'schlaf 700 und melde dich', ordner: w });
  await new Promise((r) => setTimeout(r, 250));
  const c = await rufen({ aufgabe: 'schlaf 0 dritter Versuch', ordner: w });
  assert.match(c.output[0].text, /Beide Plätze/);
  const [ra, rb] = await Promise.all([a, b]);
  assert.ok(Date.now() - t0 < 2500, 'liefen nacheinander statt parallel');
  assert.match(ra.output[0].text, /Unteragent \(lesen/);
  assert.match(rb.output[0].text, /Unteragent \(lesen/);
  const d = await rufen({ aufgabe: 'schlaf 0 jetzt wieder frei', ordner: w });
  assert.match(d.output[0].text, /Unteragent \(lesen/);
});

test('Zeitgrenze beendet das Kind und meldet den letzten Stand', async () => {
  const { rufen } = aufbau();
  const r = await rufen({ aufgabe: 'schlaf 30000 sehr lange', ordner: w, frist_s: 1 });
  assert.match(r.output[0].text, /Zeitgrenze von 1 s/);
});

test('Abbruch des Zugs beendet das Kind', async () => {
  const { rufen } = aufbau();
  const c = new AbortController();
  const p = rufen({ aufgabe: 'schlaf 30000 sehr lange', ordner: w }, c.signal);
  setTimeout(() => c.abort(), 300);
  assert.match((await p).output[0].text, /Zug abgebrochen/);
});

test('Fehlerausgang: Exit 3 ohne Antwort wird gemeldet; falscher Ordner und kurze Aufgabe werden abgelehnt', async () => {
  const { rufen } = aufbau();
  assert.match((await rufen({ aufgabe: 'exit 3 bitte', ordner: w })).output[0].text, /fehlgeschlagen \(Exit 3\): kaputt/);
  assert.match((await rufen({ aufgabe: 'irgendeine Aufgabe', ordner: join(w, 'gibtsnicht') })).output[0].text, /gibt es nicht/);
  assert.match((await rufen({ aufgabe: 'kurz' })).output[0].text, /zu kurz/);
});

test('fehlendes Programm wird als fehlgeschlagen gemeldet, der Platz wird frei', async () => {
  const env = { ...process.env, FYOS_UNTERAGENTEN_DIR: join(mkdtempSync(join(tmpdir(), 'slots-')), 'u') };
  const wz = agentenWerkzeuge({ cfg: {}, env, befehl: [join(w, 'gibt-es-nicht')], pidLebt: lebt })[0];
  const r = await wz.execute({ aufgabe: 'irgendeine Aufgabe hier', ordner: w }, {}, {});
  assert.match(r.output[0].text, /fehlgeschlagen \(Exit 127\)/);
  assert.equal(existsSync(join(env.FYOS_UNTERAGENTEN_DIR, 'slot-1')), false);
});

test('toter Platz wird übernommen; als Unteragent wird das Werkzeug nicht angeboten', async () => {
  const { rufen, env } = aufbau();
  await rufen({ aufgabe: 'schlaf 0 einmal laufen', ordner: w });
  writeFileSync(join(env.FYOS_UNTERAGENTEN_DIR, 'slot-1'), '999999');
  writeFileSync(join(env.FYOS_UNTERAGENTEN_DIR, 'slot-2'), '999998');
  assert.match((await rufen({ aufgabe: 'schlaf 0 mit toten Plätzen', ordner: w })).output[0].text, /Unteragent \(lesen/);
  const k = aufbau({ FYOS_UNTERAGENT: '1' });
  assert.equal(k.werkzeuge.length, 0);
  assert.equal(existsSync(env.FYOS_UNTERAGENTEN_DIR), true);
});

test('schlussantwort: nimmt die letzte Nachricht, ignoriert Müll, meldet Modellfehler', () => {
  const z = [
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } }),
    'kein json',
    JSON.stringify({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'u' }] } }),
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'b' }], stopReason: 'error', errorMessage: 'kaputt' } }),
  ];
  assert.deepEqual(schlussantwort(z), { text: 'b', fehler: 'kaputt' });
});
