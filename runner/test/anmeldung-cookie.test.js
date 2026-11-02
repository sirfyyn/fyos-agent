/**
 * anmeldung-cookie.test.js — der Runner setzt das Cookie `fyos_runner` für JEDES gültige Token (Variante A,
 * docs/current/RUNNER-ANMELDUNG-VORSCHLAG.md). Vorher bekam nur das Haupttoken eins; ein benanntes Token öffnete die Seite,
 * aber Stil und Skript lieferten 401.
 *
 * Wichtig: Der Cookie-Wert ist das VORGEZEIGTE Token, nie das Haupttoken (sonst würde ein benanntes Token zum Haupttoken).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { erstelleServer } from '../src/server.js';

const HAUPT = 'haupt-geheimnis-0123456789';
const GERAET = 'geraet-geheimnis-0123456789';
const tmp = mkdtempSync(join(tmpdir(), 'anmeldung-'));
writeFileSync(join(tmp, 'index.html'), '<!doctype html><title>x</title>');
writeFileSync(join(tmp, 'style.css'), 'body{}');
after(() => rmSync(tmp, { recursive: true, force: true }));

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
  const hole = (pfad, kopf = {}) =>
    new Promise((fertig, scheitern) => {
      http
        .get({ host: '127.0.0.1', port, path: pfad, headers: kopf, agent: false }, (res) => {
          res.resume();
          res.on('end', () => fertig({ status: res.statusCode, cookie: res.headers['set-cookie']?.[0] ?? null }));
        })
        .on('error', scheitern);
    });
  try {
    await fn(hole);
  } finally {
    await new Promise((ok) => server.close(ok));
  }
}

test('das Haupttoken setzt weiter sein Cookie (HttpOnly, Strict)', async () => {
  await mitServer(async (hole) => {
    const r = await hole(`/?token=${HAUPT}`);
    assert.equal(r.status, 200);
    assert.match(r.cookie, new RegExp(`^fyos_runner=${HAUPT};`));
    assert.match(r.cookie, /HttpOnly/);
    assert.match(r.cookie, /SameSite=Strict/);
  });
});

test('ein benanntes Token setzt sein EIGENES Cookie, nie das des Haupttokens', async () => {
  await mitServer(async (hole) => {
    const r = await hole(`/?token=${GERAET}`);
    assert.equal(r.status, 200);
    assert.match(r.cookie, new RegExp(`^fyos_runner=${GERAET};`));
    assert.ok(!r.cookie.includes(HAUPT), 'das Haupttoken darf nie im Cookie eines benannten Tokens stehen');
  });
});

test('mit dem Cookie des benannten Tokens laden Stil und Skript (kein 401 mehr)', async () => {
  await mitServer(async (hole) => {
    assert.equal((await hole('/style.css')).status, 401, 'ohne alles 401');
    assert.equal((await hole('/style.css', { Cookie: `fyos_runner=${GERAET}` })).status, 200);
  });
});

test('ein falsches Token bekommt 401 und kein Cookie', async () => {
  await mitServer(async (hole) => {
    const r = await hole('/?token=falsch');
    assert.equal(r.status, 401);
    assert.equal(r.cookie, null);
  });
});

test('wer schon ein Cookie hat, bekommt kein zweites', async () => {
  await mitServer(async (hole) => {
    const r = await hole(`/?token=${GERAET}`, { Cookie: `fyos_runner=${GERAET}` });
    assert.equal(r.status, 200);
    assert.equal(r.cookie, null);
  });
});
