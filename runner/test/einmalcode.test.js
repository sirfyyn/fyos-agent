/**
 * einmalcode.test.js — Anmeldung mit Einmal-Code (Variante C, docs/current/RUNNER-ANMELDUNG-VORSCHLAG.md).
 * Der Code gilt genau einmal und kurz; danach steht kein Token in der Adresse.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CODE_MAX_OFFEN, EinmalCodes } from '../src/einmalcode.js';
import { erstelleServer } from '../src/server.js';

const HAUPT = 'haupt-geheimnis-0123456789';
const GERAET = 'geraet-geheimnis-0123456789';
const tmp = mkdtempSync(join(tmpdir(), 'einmalcode-'));
writeFileSync(join(tmp, 'index.html'), '<!doctype html><title>x</title>');
writeFileSync(join(tmp, 'style.css'), 'body{}');
after(() => rmSync(tmp, { recursive: true, force: true }));

// --- die Ablage ---------------------------------------------------------------------------------

test('ein Code gilt genau einmal', () => {
  const c = new EinmalCodes();
  const code = c.ausstellen('geheim');
  assert.equal(c.einloesen(code), 'geheim');
  assert.equal(c.einloesen(code), null, 'zweites Einlösen scheitert');
});

test('ein Code verfällt nach der Frist', () => {
  let t = 1000;
  const c = new EinmalCodes({ jetzt: () => t, gueltig_s: 60 });
  const code = c.ausstellen('geheim');
  t += 59_000;
  assert.equal(c.offen, 1);
  t += 2_000;
  assert.equal(c.einloesen(code), null);
  assert.equal(c.offen, 0, 'abgelaufene Codes werden weggeräumt');
});

test('unbekannte, leere und fremde Eingaben lösen nichts ein', () => {
  const c = new EinmalCodes();
  c.ausstellen('geheim');
  for (const x of ['', 'falsch', undefined, null, 5, {}]) assert.equal(c.einloesen(x), null);
  assert.equal(c.ausstellen(''), null, 'ohne Token kein Code');
});

test('höchstens CODE_MAX_OFFEN offene Codes', () => {
  const c = new EinmalCodes();
  for (let i = 0; i < CODE_MAX_OFFEN; i += 1) assert.ok(c.ausstellen('g'));
  assert.equal(c.ausstellen('g'), null);
});

test('zwei Codes sind verschieden und nicht erratbar kurz', () => {
  const c = new EinmalCodes();
  const a = c.ausstellen('g');
  const b = c.ausstellen('g');
  assert.notEqual(a, b);
  assert.ok(a.length >= 30);
});

// --- der Server ---------------------------------------------------------------------------------

async function mitServer(fn, security = {}) {
  const cfg = {
    pi_durable: {
      security: { token: HAUPT, tokens: { geraet: GERAET }, allowedOrigins: [], ...security },
      limits: { maxBodyBytes: 65536 },
      clientDir: tmp,
    },
  };
  const server = erstelleServer({ runner: {}, cfg });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  const anfrage = (methode, pfad, kopf = {}) =>
    new Promise((fertig, scheitern) => {
      const req = http.request({ host: '127.0.0.1', port, method: methode, path: pfad, headers: kopf, agent: false }, (res) => {
        const stuecke = [];
        res.on('data', (c) => stuecke.push(c));
        res.on('end', () => {
          let nutz = null;
          try {
            nutz = JSON.parse(Buffer.concat(stuecke).toString('utf8'));
          } catch {
            /* keine JSON-Antwort */
          }
          fertig({ status: res.statusCode, nutz, ort: res.headers.location ?? null, cookie: res.headers['set-cookie']?.[0] ?? null });
        });
      });
      req.on('error', scheitern);
      req.end();
    });
  try {
    await fn(anfrage);
  } finally {
    await new Promise((ok) => server.close(ok));
  }
}

const KOPF = (token) => ({ Authorization: `Bearer ${token}`, 'X-FYOS-Agent': '1' });

test('Code holen, Seite öffnen: Cookie und Weiterleitung ohne Code', async () => {
  await mitServer(async (anfrage) => {
    const hol = await anfrage('POST', '/api/sitzung/code', KOPF(HAUPT));
    assert.equal(hol.status, 200);
    assert.ok(hol.nutz.code);
    assert.equal(hol.nutz.gueltig_s, 60);
    const auf = await anfrage('GET', `/?code=${hol.nutz.code}`);
    assert.equal(auf.status, 302);
    assert.equal(auf.ort, '/');
    assert.ok(!auf.ort.includes(hol.nutz.code), 'kein Code in der Zieladresse');
    assert.match(auf.cookie, new RegExp(`^fyos_runner=${HAUPT};`));
    assert.match(auf.cookie, /HttpOnly/);
    const seite = await anfrage('GET', '/style.css', { Cookie: `fyos_runner=${HAUPT}` });
    assert.equal(seite.status, 200);
  });
});

test('ein benannter Zugang bekommt über den Code sein eigenes Cookie, nie das Haupttoken', async () => {
  await mitServer(async (anfrage) => {
    const hol = await anfrage('POST', '/api/sitzung/code', KOPF(GERAET));
    const auf = await anfrage('GET', `/?code=${hol.nutz.code}`);
    assert.match(auf.cookie, new RegExp(`^fyos_runner=${GERAET};`));
    assert.ok(!auf.cookie.includes(HAUPT));
  });
});

test('derselbe Code ein zweites Mal: 401, kein Cookie', async () => {
  await mitServer(async (anfrage) => {
    const { nutz } = await anfrage('POST', '/api/sitzung/code', KOPF(HAUPT));
    assert.equal((await anfrage('GET', `/?code=${nutz.code}`)).status, 302);
    const zweites = await anfrage('GET', `/?code=${nutz.code}`);
    assert.equal(zweites.status, 401);
    assert.equal(zweites.cookie, null);
  });
});

test('Weiterleitung behält Pfad und übrige Abfrage, auch hinter /agent', async () => {
  await mitServer(async (anfrage) => {
    const { nutz } = await anfrage('POST', '/api/sitzung/code', KOPF(HAUPT));
    const auf = await anfrage('GET', `/agent/index.html?a=1&code=${nutz.code}&b=2`);
    assert.equal(auf.status, 302);
    assert.equal(auf.ort, '/agent/index.html?a=1&b=2');
  });
});

test('falscher oder fehlender Kopf: kein Code', async () => {
  await mitServer(async (anfrage) => {
    assert.equal((await anfrage('POST', '/api/sitzung/code', { Authorization: `Bearer ${HAUPT}` })).status, 400, 'ohne X-FYOS-Agent');
    assert.equal((await anfrage('POST', '/api/sitzung/code')).status, 401, 'ohne alles');
    assert.equal((await anfrage('POST', '/api/sitzung/code', { 'X-FYOS-Agent': '1' })).status, 401, 'ohne Token');
    assert.equal((await anfrage('POST', '/api/sitzung/code', KOPF('falsch'))).status, 401);
    assert.equal((await anfrage('POST', '/api/sitzung/code', { Cookie: `fyos_runner=${HAUPT}`, 'X-FYOS-Agent': '1' })).status, 401, 'ein Cookie genügt nicht');
    assert.equal((await anfrage('GET', '/api/sitzung/code', KOPF(HAUPT))).status, 405);
  });
});

test('der Code öffnet nur Seiten, nie die API', async () => {
  await mitServer(async (anfrage) => {
    const { nutz } = await anfrage('POST', '/api/sitzung/code', KOPF(HAUPT));
    const api = await anfrage('GET', `/api/zustand?code=${nutz.code}`);
    assert.equal(api.status, 401);
    assert.equal(api.cookie, null);
    assert.equal((await anfrage('GET', `/?code=${nutz.code}`)).status, 302, 'der Code war noch unverbraucht');
  });
});

test('mit ?token= geht es weiter wie bisher (Rückwärtsverträglichkeit)', async () => {
  await mitServer(async (anfrage) => {
    const r = await anfrage('GET', `/?token=${HAUPT}`);
    assert.equal(r.status, 200);
    assert.match(r.cookie, new RegExp(`^fyos_runner=${HAUPT};`));
  });
});

test('ohne eingerichtetes Token ist kein Code nötig: 400', async () => {
  await mitServer(
    async (anfrage) => {
      assert.equal((await anfrage('POST', '/api/sitzung/code', { 'X-FYOS-Agent': '1' })).status, 400);
    },
    { token: '', tokens: {} },
  );
});
