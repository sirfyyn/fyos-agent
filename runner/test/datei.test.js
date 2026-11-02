/**
 * datei.test.js — „Datei lesen“ und „Dateiliste“ (src/datei.js, src/sperre.js, GET /api/datei, GET /api/ordner?dateien=1).
 *
 * Der echte Runner läuft mit einem Faux-Modell (Muster ordner.test.js). Geprüft: Inhalt, Abschneiden (auch mitten im
 * UTF-8-Zeichen), Binärdatei, ungültiges UTF-8, Ausbruchsversuche (`..`, Link hinaus, Link auf Geheimnisdatei, absoluter Pfad
 * außerhalb, FIFO, Socket gesperrter Link auf ein Gerät, Nullbyte, relativ), Sperrliste (Standard, Ergänzung, Ordner),
 * Schwärzung, Token, Gespräch (unbekannt, ohne Ordner), Dateiliste mit Ordnern zuerst, Grenzen.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fauxProvider } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { konfigurationLaden } from '../src/config.js';
import { MAX_EINTRAEGE } from '../src/ordner.js';
import { schwaerzenText } from '../src/schwaerzen.js';
import { SPERRE_STANDARD, nameGesperrt, pfadGesperrt, sperreLesen } from '../src/sperre.js';
import { Runner } from '../src/runner.js';
import { erstelleServer } from '../src/server.js';

const TOKEN = 'test-token-test-token-test-token-00';
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'dt-')));
const wurzel = join(tmp, 'w');
const aussen = join(tmp, 'aussen');
const nachbar = join(tmp, 'w-nachbar');
const arbeit = join(tmp, 'arbeit');
const viele = join(wurzel, 'viele');
let sockServer = null;

before(async () => {
  for (const d of [wurzel, join(wurzel, 'alpha'), join(wurzel, 'Beta'), join(wurzel, '.versteckt'), join(wurzel, '.ssh'), join(wurzel, 'secrets'), aussen, nachbar, arbeit, viele]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(wurzel, 'alpha', 'hallo.txt'), 'Grüße aus dem Test\nzweite Zeile\n');
  writeFileSync(join(wurzel, 'alpha', 'gross.txt'), `${'a'.repeat(99)}\n`.repeat(3000)); // 300000 Byte
  writeFileSync(join(wurzel, 'alpha', 'leer.txt'), '');
  writeFileSync(join(wurzel, 'alpha', 'umlaut.txt'), 'ä'.repeat(10)); // 20 Byte, je 2
  writeFileSync(join(wurzel, 'alpha', 'kaputt-utf8.txt'), Buffer.from([0x61, 0xff, 0xfe, 0x62]));
  writeFileSync(join(wurzel, 'alpha', 'bild.bin'), Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d]));
  writeFileSync(join(wurzel, 'alpha', 'nul-spaet.txt'), `${'x'.repeat(9000)}\0hinten`); // NUL erst nach 8 KiB
  writeFileSync(
    join(wurzel, 'alpha', 'zugang.txt'),
    ['name = Test', 'password=hunter2geheim', 'Authorization: Bearer abcdefghijklmnop', '  eingerückt bleibt', '-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA', '-----END RSA PRIVATE KEY-----', 'Ende', ''].join('\n'), // sauber: ok (Testattrappe)
  );
  writeFileSync(join(wurzel, '.env'), 'KEY=1\n');
  writeFileSync(join(wurzel, 'alpha', 'server.pem'), 'x');
  writeFileSync(join(wurzel, 'alpha', 'id_rsa'), 'x');
  writeFileSync(join(wurzel, 'alpha', 'id_rsa.pub'), 'x');
  writeFileSync(join(wurzel, 'alpha', '.netrc'), 'x');
  writeFileSync(join(wurzel, 'alpha', 'token.json'), '{}');
  writeFileSync(join(wurzel, 'alpha', 'dienst.key'), 'x');
  writeFileSync(join(wurzel, 'alpha', 'plan.geheim'), 'nur mit Zusatz gesperrt');
  writeFileSync(join(wurzel, '.ssh', 'config'), 'x');
  writeFileSync(join(wurzel, 'secrets', 'a.txt'), 'x');
  writeFileSync(join(aussen, 'geheim.txt'), 'draussen');
  writeFileSync(join(nachbar, 'n.txt'), 'nachbar');
  symlinkSync(join(wurzel, '.env'), join(wurzel, 'harmlos.txt')); // harmloser Name, Ziel gesperrt
  symlinkSync(join(aussen, 'geheim.txt'), join(wurzel, 'link-raus.txt'));
  symlinkSync(aussen, join(wurzel, 'link-raus-ordner'));
  symlinkSync(join(nachbar, 'n.txt'), join(wurzel, 'link-nachbar.txt'));
  symlinkSync(join(wurzel, 'alpha', 'hallo.txt'), join(wurzel, 'link-rein.txt'));
  symlinkSync('/dev/null', join(wurzel, 'link-geraet'));
  symlinkSync(join(wurzel, 'gibtsnicht'), join(wurzel, 'link-kaputt.txt'));
  execFileSync('mkfifo', [join(wurzel, 'alpha', 'rohr')]);
  sockServer = net.createServer();
  await new Promise((ok) => sockServer.listen(join(wurzel, 'alpha', 's.sock'), ok));
  for (let i = 0; i < 300; i += 1) mkdirSync(join(viele, `d${String(i).padStart(3, '0')}`));
  for (let i = 0; i < 300; i += 1) writeFileSync(join(viele, `f${String(i).padStart(3, '0')}.txt`), 'x'.repeat(i));
});

after(async () => {
  await new Promise((ok) => (sockServer ? sockServer.close(ok) : ok()));
  rmSync(tmp, { recursive: true, force: true });
});

const fakeHub = () => ({
  aufrufen: async () => ({ ok: true, result: {} }),
  melden: async () => ({ ok: true }),
  bereicheMelden: async () => ({ ok: true }),
  gesundheit: async () => ({ ok: true }),
  suchen: async () => [],
  schema: async () => ({}),
  eingangLesen: async (nach) => {
    await new Promise((r) => setTimeout(r, 150));
    return { eintraege: [], letzte: nach };
  },
});

async function mitRunner(name, env, fn) {
  const cfg = konfigurationLaden(
    {
      hub: 'http://hub.test',
      agent: 'persona',
      arbeitsbereiche: { standard: { pfad: arbeit, titel: 'Test' } },
      pi_durable: {
        storage: join(tmp, `${name}.sqlite`),
        security: { token: TOKEN },
        proactive: { enabled: false },
        egress: { enabled: false },
        browser: { enabled: false },
        desktop: { enabled: false },
      },
    },
    { FYOS_RUNNER_ORDNER_ERLAUBT: wurzel, ...env },
  );
  const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: [{ id: 'hausmodell' }, { id: 'hausmodell-max' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runner = new Runner(cfg, { models, hub: fakeHub() });
  await runner.start();
  const server = erstelleServer({ runner, cfg });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const basis = `http://127.0.0.1:${server.address().port}`;
  const rufe = async (methode, pfad, { body, token = TOKEN } = {}) => {
    const r = await fetch(basis + pfad, {
      method: methode,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const datei = (pfad, { max, gespraech, token } = {}) => {
    const q = [`pfad=${encodeURIComponent(pfad)}`];
    if (max !== undefined) q.push(`max=${encodeURIComponent(max)}`);
    if (gespraech !== undefined) q.push(`gespraech=${encodeURIComponent(gespraech)}`);
    return rufe('GET', `/api/datei?${q.join('&')}`, { token });
  };
  const liste = (pfad, dateien = true) => rufe('GET', `/api/ordner?pfad=${encodeURIComponent(pfad)}${dateien ? '&dateien=1' : ''}`);
  try {
    await fn({ rufe, datei, liste, cfg, runner });
  } finally {
    await new Promise((ok) => server.close(ok));
    await runner.close().catch(() => {});
  }
}

const A = (n) => join(wurzel, 'alpha', n);

test('Sperrliste: Muster, Groß-/Kleinschreibung, Pfadteile, Umgebungswert ersetzt oder ergänzt', () => {
  assert.ok(SPERRE_STANDARD.includes('.env'));
  for (const n of ['.env', '.ENV', '.env.local', 'a.pem', 'x.KEY', 'id_rsa', 'id_ed25519.pub', '.netrc', 'token.json', 'secrets.yaml']) {
    assert.equal(nameGesperrt(n, SPERRE_STANDARD), true, n);
  }
  // Quelltext mit „token“ oder „secret“ im Namen bleibt lesbar.
  for (const n of ['token.js', 'secrets.js', 'keyboard.ts', 'envelope.md', 'readme.md', 'pem.txt']) assert.equal(nameGesperrt(n, SPERRE_STANDARD), false, n);
  assert.equal(pfadGesperrt('a/.ssh/config', SPERRE_STANDARD), true);
  assert.equal(pfadGesperrt('a/b/c.txt', SPERRE_STANDARD), false);
  assert.deepEqual(sperreLesen(undefined), SPERRE_STANDARD);
  assert.deepEqual(sperreLesen('  '), SPERRE_STANDARD);
  assert.deepEqual(sperreLesen('*.a, *.b ,x/y,'), ['*.a', '*.b']);
  assert.ok(sperreLesen('+*.geheim').includes('*.geheim') && sperreLesen('+*.geheim').includes('.env'));
  assert.deepEqual(sperreLesen('x/y'), SPERRE_STANDARD, 'nur Unbrauchbares: Standard');
});

test('schwaerzenText: Zeilen bleiben, Zugangsdaten und Schlüsselblöcke fallen weg', () => {
  const r = schwaerzenText('a\n  b: 1\npassword=geheim\nBearer abcdefghijkl\n-----BEGIN PRIVATE KEY-----\nXYZ\n-----END PRIVATE KEY-----\nende'); // sauber: ok (Testattrappe)
  assert.equal(r.geschwaerzt, true);
  const z = r.text.split('\n');
  assert.equal(z[0], 'a');
  assert.equal(z[1], '  b: 1');
  assert.equal(z[2], 'password=***');
  assert.equal(z[3], 'Bearer ***');
  assert.equal(z[4], '***PRIVATE KEY***');
  assert.equal(z[5], 'ende');
  assert.deepEqual(schwaerzenText('nichts zu tun\n'), { text: 'nichts zu tun\n', geschwaerzt: false });
});

test('Lesen: Text, UTF-8, Größe, Zeitstempel, leere Datei', async () => {
  await mitRunner('lesen', {}, async ({ datei }) => {
    const r = await datei(A('hallo.txt'));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.ok, true);
    assert.equal(r.json.pfad, A('hallo.txt'));
    assert.equal(r.json.text, 'Grüße aus dem Test\nzweite Zeile\n');
    assert.equal(r.json.groesse, Buffer.byteLength('Grüße aus dem Test\nzweite Zeile\n'));
    assert.equal(r.json.abgeschnitten, false);
    assert.equal(r.json.binaer, false);
    assert.equal(typeof r.json.geaendert, 'number');
    assert.ok(Math.abs(Date.now() - r.json.geaendert) < 3_600_000);
    assert.equal(r.json.geschwaerzt, undefined);

    const leer = await datei(A('leer.txt'));
    assert.equal(leer.status, 200);
    assert.deepEqual([leer.json.text, leer.json.groesse, leer.json.abgeschnitten], ['', 0, false]);

    // Doppelte und abschließende Schrägstriche im Pfad sind derselbe Pfad; die Antwort nennt den echten Pfad.
    const doppelt = await datei(`${wurzel}//alpha/./hallo.txt`);
    assert.equal(doppelt.status, 200);
    assert.equal(doppelt.json.pfad, A('hallo.txt'));
  });
});

test('Abschneiden: Standard 200000, max, nie mitten im UTF-8-Zeichen, Grenzen von max', async () => {
  await mitRunner('abschneiden', {}, async ({ datei }) => {
    const r = await datei(A('gross.txt'));
    assert.equal(r.status, 200);
    assert.equal(r.json.groesse, 300000);
    assert.equal(r.json.text.length, 200000);
    assert.equal(r.json.abgeschnitten, true);

    const klein = await datei(A('gross.txt'), { max: 150 });
    assert.equal(klein.json.text.length, 150);
    assert.equal(klein.json.abgeschnitten, true);

    const genau = await datei(A('hallo.txt'), { max: Buffer.byteLength('Grüße aus dem Test\nzweite Zeile\n') });
    assert.equal(genau.json.abgeschnitten, false, 'max gleich Größe: nicht abgeschnitten');
    const eins = await datei(A('hallo.txt'), { max: 1 });
    assert.equal(eins.json.text, 'G');

    // 10 x „ä“ (2 Byte): max=3 liefert ein ganzes Zeichen, nicht ein halbes (kein Ersatzzeichen).
    const u = await datei(A('umlaut.txt'), { max: 3 });
    assert.equal(u.json.text, 'ä');
    assert.equal(u.json.abgeschnitten, true);
    assert.equal((await datei(A('umlaut.txt'), { max: 4 })).json.text, 'ää');
    assert.equal((await datei(A('umlaut.txt'), { max: 1 })).json.text, '', 'ein halbes Zeichen allein fällt weg');

    // Höchstwert 1 MiB ist erlaubt, ein Byte mehr ist 413; Müll ist 400.
    assert.equal((await datei(A('hallo.txt'), { max: 1048576 })).status, 200);
    const zuGross = await datei(A('hallo.txt'), { max: 1048577 });
    assert.equal(zuGross.status, 413);
    assert.equal(zuGross.json.fehler, 'zu_gross');
    for (const m of ['0', '-5', 'abc', '1.5', '1e3', ' ', '99999999999999999']) {
      const x = await datei(A('hallo.txt'), { max: m });
      assert.ok([400, 413].includes(x.status), `${m} -> ${x.status}`);
    }
    assert.equal((await datei(A('hallo.txt'), { max: '0' })).status, 400);
    assert.equal((await datei(A('hallo.txt'), { max: 'abc' })).status, 400);
  });
});

test('Binärdatei: NUL in den ersten 8 KiB ohne Inhalt; ungültiges UTF-8 wird ersetzt; spätes NUL ist Text', async () => {
  await mitRunner('binaer', {}, async ({ datei }) => {
    const b = await datei(A('bild.bin'));
    assert.equal(b.status, 200);
    assert.deepEqual(b.json, { ok: true, pfad: A('bild.bin'), groesse: 5, binaer: true });

    const k = await datei(A('kaputt-utf8.txt'));
    assert.equal(k.status, 200);
    assert.equal(k.json.text, 'a��b');
    assert.equal(k.json.binaer, false);

    const spaet = await datei(A('nul-spaet.txt'));
    assert.equal(spaet.json.binaer, false);
    assert.ok(!spaet.json.text.includes('\0'));
    assert.ok(spaet.json.text.endsWith('�hinten'));
  });
});

test('Schwärzung im Dateiinhalt, Zeilen bleiben', async () => {
  await mitRunner('schwaerzen', {}, async ({ datei }) => {
    const r = await datei(A('zugang.txt'));
    assert.equal(r.status, 200);
    assert.equal(r.json.geschwaerzt, true);
    const z = r.json.text.split('\n');
    assert.equal(z.length, 7);
    assert.deepEqual([z[0], z[1], z[3], z[4], z[5], z[6]], ['name = Test', 'password=***', '  eingerückt bleibt', '***PRIVATE KEY***', 'Ende', '']);
    assert.ok(z[2].startsWith('Authorization:') && !z[2].includes('abcdefgh'));
    assert.ok(!r.json.text.includes('hunter2geheim'));
    assert.ok(!r.json.text.includes('abcdefghijklmnop'));
    assert.ok(!r.json.text.includes('MIIEow'));
  });
});

test('Ausbrüche beim Lesen: 403 ausserhalb bzw. 400 ungueltig', async () => {
  await mitRunner('ausbruch', {}, async ({ datei }) => {
    const ausserhalb = [
      `${wurzel}/../aussen/geheim.txt`,
      `${wurzel}/alpha/../../aussen/geheim.txt`,
      join(aussen, 'geheim.txt'), // absoluter Pfad außerhalb
      join(nachbar, 'n.txt'), // gleicher Namensanfang
      '/etc/passwd',
      '/etc/hosts',
      '/',
      tmp,
      join(wurzel, 'link-raus.txt'), // Link auf Datei außerhalb
      join(wurzel, 'link-raus-ordner', 'geheim.txt'), // Link auf Ordner außerhalb
      join(wurzel, 'link-nachbar.txt'),
      join(wurzel, 'link-geraet'), // Link auf /dev/null
      '/dev/null',
      '/gibt/es/nicht',
    ];
    for (const p of ausserhalb) {
      const r = await datei(p);
      assert.equal(r.status, 403, `${p} -> ${r.status} ${JSON.stringify(r.json)}`);
      assert.equal(r.json.ok, false);
      assert.ok(['ausserhalb'].includes(r.json.fehler), `${p} -> ${r.json.fehler}`);
      assert.equal(r.json.text, undefined);
    }
    for (const p of ['relativ.txt', 'alpha/hallo.txt', './x', '..', '', `${A('hallo.txt')}\0`, `${wurzel}\0/alpha/hallo.txt`, `${A('hallo.txt')}\0.png`]) {
      const r = await datei(p);
      assert.equal(r.status, 400, `${JSON.stringify(p)} -> ${r.status}`);
      assert.equal(r.json.fehler, 'ungueltig');
    }
    // Ohne Parameter pfad.
    const ohne = await (async () => {
      let x;
      await mitRunner('ohne-pfad', {}, async ({ rufe }) => {
        x = await rufe('GET', '/api/datei');
      });
      return x;
    })();
    assert.equal(ohne.status, 400);
  });
});

test('Sonderdateien: Ordner, FIFO (ohne zu blockieren), Socket, kaputter Link', async () => {
  await mitRunner('sonder', {}, async ({ datei }) => {
    const ordner = await datei(join(wurzel, 'alpha'));
    assert.equal(ordner.status, 400);
    assert.equal(ordner.json.fehler, 'keine_datei');

    const t0 = Date.now();
    const rohr = await datei(A('rohr'));
    assert.ok(Date.now() - t0 < 5000, 'FIFO blockiert nicht');
    assert.equal(rohr.status, 400);
    assert.equal(rohr.json.fehler, 'keine_datei');

    const sock = await datei(A('s.sock'));
    assert.ok([400, 404].includes(sock.status), `Socket -> ${sock.status}`);
    assert.equal(sock.json.ok, false);
    assert.equal(sock.json.text, undefined);

    assert.equal((await datei(join(wurzel, 'link-kaputt.txt'))).status, 404);
    assert.equal((await datei(A('gibtsnicht.txt'))).status, 404);
    // Nicht vorhanden AUSSERHALB verrät nichts: 403, nicht 404.
    assert.equal((await datei('/gibt/es/nicht/aussen.txt')).status, 403);
  });
});

test('Sperrliste beim Lesen: 403 gesperrt, auch bei Link mit harmlosem Namen, auch für nicht vorhandene Namen', async () => {
  await mitRunner('sperre', {}, async ({ datei }) => {
    const gesperrt = [
      join(wurzel, '.env'),
      A('server.pem'),
      A('id_rsa'),
      A('id_rsa.pub'),
      A('.netrc'),
      A('token.json'),
      A('dienst.key'),
      join(wurzel, '.ssh', 'config'),
      join(wurzel, 'secrets', 'a.txt'),
      join(wurzel, 'harmlos.txt'), // Link auf .env
      A('nicht-da.pem'), // gibt es nicht, ist aber gesperrt: kein Orakel
    ];
    for (const p of gesperrt) {
      const r = await datei(p);
      assert.equal(r.status, 403, `${p} -> ${r.status}`);
      assert.equal(r.json.fehler, 'gesperrt', p);
      assert.equal(r.json.ok, false);
      assert.equal(r.json.text, undefined);
    }
    // Daneben bleibt Normales lesbar, auch ähnliche Namen.
    assert.equal((await datei(A('hallo.txt'))).status, 200);
    assert.equal((await datei(join(wurzel, 'link-rein.txt'))).json.text.startsWith('Grüße'), true, 'Link innerhalb der Wurzel');
    assert.equal((await datei(A('plan.geheim'))).status, 200, 'Standardliste kennt .geheim nicht');
  });
});

test('Sperrliste ergänzen und ersetzen über FYOS_RUNNER_DATEI_SPERRE', async () => {
  await mitRunner('sperre-plus', { FYOS_RUNNER_DATEI_SPERRE: '+*.geheim' }, async ({ datei, cfg }) => {
    assert.ok(cfg.pi_durable.dateiSperre.includes('.env') && cfg.pi_durable.dateiSperre.includes('*.geheim'));
    assert.equal((await datei(A('plan.geheim'))).json.fehler, 'gesperrt');
    assert.equal((await datei(join(wurzel, '.env'))).json.fehler, 'gesperrt');
  });
  await mitRunner('sperre-ersetzt', { FYOS_RUNNER_DATEI_SPERRE: '*.geheim' }, async ({ datei }) => {
    assert.equal((await datei(A('plan.geheim'))).json.fehler, 'gesperrt');
    assert.equal((await datei(A('server.pem'))).status, 200, 'ersetzt: Standard gilt nicht mehr');
  });
});

test('Ohne Token oder mit falschem: 401, nichts gelesen', async () => {
  await mitRunner('token', {}, async ({ datei, rufe }) => {
    assert.equal((await datei(A('hallo.txt'), { token: null })).status, 401);
    assert.equal((await datei(A('hallo.txt'), { token: 'falsch' })).status, 401);
    const l = await rufe('GET', `/api/ordner?pfad=${encodeURIComponent(wurzel)}&dateien=1`, { token: null });
    assert.equal(l.status, 401);
    assert.equal(JSON.stringify((await datei(A('hallo.txt'), { token: null })).json).includes('Grüße'), false);
  });
});

test('Nur lesend: andere Methoden auf /api/datei sind keine Treffer', async () => {
  await mitRunner('methode', {}, async ({ rufe }) => {
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await rufe(m, `/api/datei?pfad=${encodeURIComponent(A('hallo.txt'))}`, { body: { x: 1 } });
      assert.ok(r.status >= 400, `${m} -> ${r.status}`);
    }
  });
});

test('Gespräch: unbekannt 404; ohne eigenen Ordner gelten nur die erlaubten Wurzeln; mit Ordner wie Wurzel', async () => {
  writeFileSync(join(arbeit, 'im-arbeitsbereich.txt'), 'arbeitsbereich');
  await mitRunner('gespraech', {}, async ({ datei, rufe }) => {
    const unbekannt = await datei(A('hallo.txt'), { gespraech: 'gibt-es-nicht' });
    assert.equal(unbekannt.status, 404);
    assert.equal(unbekannt.json.ok, false);

    // Hauptgespräch hat keinen eigenen Ordner: der Arbeitsbereich liegt nicht in einer Wurzel -> 403.
    const alle = await rufe('GET', '/api/gespraeche');
    const root = alle.json.gespraeche.find((g) => g.art === 'root');
    assert.equal(root.agent.cwd, arbeit);
    const ohne = await datei(join(arbeit, 'im-arbeitsbereich.txt'), { gespraech: root.id });
    assert.equal(ohne.status, 403);
    assert.equal(ohne.json.fehler, 'ausserhalb');
    assert.equal((await datei(A('hallo.txt'), { gespraech: root.id })).status, 200, 'erlaubte Wurzel gilt weiter');

    // Sitzung mit Ordner.
    const neu = await rufe('POST', '/api/gespraeche', { body: { ordner: join(wurzel, 'alpha') } });
    assert.equal(neu.status, 201);
    const id = neu.json.gespraech.id;
    const ok = await datei(A('hallo.txt'), { gespraech: id });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.text.startsWith('Grüße'), true);
    assert.equal((await datei(join(arbeit, 'im-arbeitsbereich.txt'), { gespraech: id })).status, 403);
    assert.equal((await datei(join(aussen, 'geheim.txt'), { gespraech: id })).status, 403);
    assert.equal((await datei(A('server.pem'), { gespraech: id })).json.fehler, 'gesperrt');
  });
});

test('Ohne erlaubte Wurzeln (Funktion aus): alles 403', async () => {
  await mitRunner('aus', { FYOS_RUNNER_ORDNER_ERLAUBT: '' }, async ({ datei, cfg }) => {
    assert.deepEqual(cfg.pi_durable.ordnerErlaubt, []);
    const r = await datei(A('hallo.txt'));
    assert.equal(r.status, 403);
    assert.equal(r.json.fehler, 'ausserhalb');
  });
});

test('Dateiliste: Ordner zuerst, alphabetisch, Dateien mit Größe, ohne Versteckte, Gesperrte, Sonderdateien, fremde Links', async () => {
  await mitRunner('liste', {}, async ({ liste }) => {
    const r = await liste(wurzel);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.pfad, wurzel);
    // Ordner: alpha, Beta, link-rein? (kein Ordnerlink), viele; „secrets“ ist gesperrt, `.ssh`/`.versteckt` versteckt,
    // link-raus-ordner führt hinaus. Dateien: nur link-rein.txt (Link innerhalb); .env, harmlos.txt (Ziel gesperrt),
    // link-raus.txt, link-nachbar.txt, link-geraet, link-kaputt.txt fehlen.
    assert.deepEqual(r.json.eintraege, [
      { name: 'alpha', ordner: true },
      { name: 'Beta', ordner: true },
      { name: 'viele', ordner: true },
      { name: 'link-rein.txt', ordner: false, groesse: Buffer.byteLength('Grüße aus dem Test\nzweite Zeile\n') },
    ]);

    const a = await liste(join(wurzel, 'alpha'));
    const namen = a.json.eintraege.map((e) => e.name);
    assert.deepEqual(namen, ['bild.bin', 'gross.txt', 'hallo.txt', 'kaputt-utf8.txt', 'leer.txt', 'nul-spaet.txt', 'plan.geheim', 'umlaut.txt', 'zugang.txt']);
    for (const e of a.json.eintraege) {
      assert.equal(e.ordner, false);
      assert.equal(typeof e.groesse, 'number');
    }
    assert.equal(a.json.eintraege.find((e) => e.name === 'gross.txt').groesse, 300000);
    assert.equal(a.json.eintraege.find((e) => e.name === 'leer.txt').groesse, 0);
    for (const verboten of ['rohr', 's.sock', 'server.pem', 'id_rsa', 'id_rsa.pub', '.netrc', 'token.json', 'dienst.key']) {
      assert.ok(!namen.includes(verboten), verboten);
    }
    assert.equal(a.json.abgeschnitten, undefined);
  });
});

test('Dateiliste: Ordner vor Dateien auch bei gemischten Namen, Groß-/Kleinschreibung gleichrangig', async () => {
  const d = join(wurzel, 'mix');
  mkdirSync(join(d, 'Zeta'), { recursive: true });
  mkdirSync(join(d, 'apfel'));
  writeFileSync(join(d, 'Birne.txt'), 'b');
  writeFileSync(join(d, 'anna.txt'), 'a');
  writeFileSync(join(d, 'Zebra.txt'), 'z');
  writeFileSync(join(d, '.versteckt.txt'), 'v');
  await mitRunner('mix', {}, async ({ liste }) => {
    const r = await liste(d);
    assert.deepEqual(r.json.eintraege.map((e) => `${e.ordner ? 'D' : 'F'}:${e.name}`), ['D:apfel', 'D:Zeta', 'F:anna.txt', 'F:Birne.txt', 'F:Zebra.txt']);
  });
});

test('Dateiliste: ohne dateien=1 bleibt alles wie bisher (nur Ordner); Grenze 500 mit abgeschnitten', async () => {
  await mitRunner('liste-alt', {}, async ({ liste }) => {
    const alt = await liste(join(wurzel, 'alpha'), false);
    assert.deepEqual(alt.json.eintraege, []);
    const altWurzel = await liste(wurzel, false);
    // Wie bisher: auch „secrets“ steht in der reinen Ordnerliste (die Sperre gilt nur mit dateien=1).
    assert.deepEqual(altWurzel.json.eintraege.map((e) => e.name), ['alpha', 'Beta', 'mix', 'secrets', 'viele']);
    for (const e of altWurzel.json.eintraege) assert.deepEqual(Object.keys(e), ['name', 'ordner']);

    // 300 Ordner + 300 Dateien -> 500 Einträge: alle Ordner, 200 Dateien, abgeschnitten.
    const v = await liste(viele);
    assert.equal(v.json.eintraege.length, MAX_EINTRAEGE);
    assert.equal(v.json.abgeschnitten, true);
    assert.equal(v.json.eintraege.filter((e) => e.ordner).length, 300);
    assert.equal(v.json.eintraege.at(-1).name, 'f199.txt');
    assert.equal(v.json.eintraege[300].name, 'f000.txt');
    // Ohne den Schalter bleiben 300 Ordner, nicht abgeschnitten.
    const o = await liste(viele, false);
    assert.equal(o.json.eintraege.length, 300);
    assert.equal(o.json.abgeschnitten, undefined);
  });
});

test('Dateiliste: Ausbrüche und gesperrte Ordner wie beim Auflisten', async () => {
  await mitRunner('liste-ausbruch', {}, async ({ liste }) => {
    for (const p of [`${wurzel}/../aussen`, nachbar, tmp, '/etc', join(wurzel, 'link-raus-ordner')]) {
      const r = await liste(p);
      assert.equal(r.status, 403, p);
      assert.equal(r.json.fehler, 'ausserhalb', p);
    }
    for (const p of [join(wurzel, '.ssh'), join(wurzel, 'secrets')]) {
      const r = await liste(p);
      assert.equal(r.status, 403, p);
      assert.equal(r.json.fehler, 'gesperrt', p);
    }
    assert.equal((await liste('relativ')).status, 400);
    assert.equal((await liste(`${wurzel}\0`)).status, 400);
    assert.equal((await liste(A('hallo.txt'))).status, 400, 'Datei statt Ordner');
    assert.equal((await liste(join(wurzel, 'gibtsnicht'))).status, 404);
  });
});
