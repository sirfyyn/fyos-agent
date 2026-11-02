/**
 * ordner.test.js — „Ordner je Sitzung“ (src/ordner.js, GET /api/ordner, POST /api/gespraeche mit `ordner`).
 *
 * Geprüft: Wurzeln, Auflisten, Ausbruchsversuche (`..`, Symlink hinaus, Nullbyte, relativ, Vorfahr der Wurzel, Nachbar mit
 * gleichem Namensanfang), nicht vorhanden, Datei statt Ordner, kein Token, Funktion aus, und dass der Ordner wirklich das
 * Arbeitsverzeichnis (agent.cwd) der Sitzung wird. Der echte Runner läuft mit einem Faux-Modell.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fauxProvider } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { konfigurationLaden } from '../src/config.js';
import { MAX_EINTRAEGE, wurzelnLesen } from '../src/ordner.js';
import { Runner } from '../src/runner.js';
import { erstelleServer } from '../src/server.js';

const TOKEN = 'test-token-test-token-test-token-00';
// Auf dem Mac ist /var ein Link nach /private/var: genau der Fall, den realpath richtig behandeln muss.
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ordner-test-')));
after(() => rmSync(tmp, { recursive: true, force: true }));

const wurzel = join(tmp, 'wurzel');
const gross = join(tmp, 'gross');
const aussen = join(tmp, 'aussen');
const nachbar = join(tmp, 'wurzel-nachbar'); // gleicher Namensanfang wie die Wurzel, aber nicht darin
const arbeit = join(tmp, 'arbeit');

before(() => {
  for (const d of [wurzel, join(wurzel, 'alpha'), join(wurzel, 'Beta'), join(wurzel, '.versteckt'), join(wurzel, 'alpha', 'tief'), gross, aussen, nachbar, arbeit]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(wurzel, 'datei.txt'), 'x');
  writeFileSync(join(aussen, 'geheim.txt'), 'x');
  symlinkSync(aussen, join(wurzel, 'link-raus'));
  symlinkSync(join(wurzel, 'alpha'), join(wurzel, 'link-rein'));
  symlinkSync(join(wurzel, 'gibtsnicht'), join(wurzel, 'link-kaputt'));
  symlinkSync(nachbar, join(wurzel, 'link-nachbar'));
  for (let i = 0; i < MAX_EINTRAEGE + 10; i += 1) mkdirSync(join(gross, `d${String(i).padStart(4, '0')}`));
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

/** Baut Runner und Server; `erlaubt` ist der Wert von FYOS_RUNNER_ORDNER_ERLAUBT. */
async function mitRunner(name, erlaubt, fn) {
  const env = erlaubt === undefined ? {} : { FYOS_RUNNER_ORDNER_ERLAUBT: erlaubt };
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
    env,
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
  const liste = (pfad, opt) => rufe('GET', `/api/ordner${pfad === undefined ? '' : `?pfad=${encodeURIComponent(pfad)}`}`, opt);
  const neu = (body, opt) => rufe('POST', '/api/gespraeche', { body, ...opt });
  try {
    await fn({ rufe, liste, neu, cfg, runner });
  } finally {
    await new Promise((ok) => server.close(ok));
    await runner.close().catch(() => {});
  }
}

const ERLAUBT = `${wurzel}:${gross}`;

test('wurzelnLesen: nur absolute Pfade, ohne Doppelte, Dateisystemwurzel und Müll fallen weg', () => {
  assert.deepEqual(wurzelnLesen('/a/b/:/a/b:rel/pfad::/:/c//d'), ['/a/b', '/c/d']);
  assert.deepEqual(wurzelnLesen(undefined), []);
  assert.deepEqual(wurzelnLesen('/x\0y'), []);
});

test('ohne Pfad kommen nur die Wurzeln', async () => {
  await mitRunner('wurzeln', ERLAUBT, async ({ liste }) => {
    const r = await liste();
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.wurzeln, [wurzel, gross]);
    assert.equal(r.json.pfad, null);
    assert.deepEqual(r.json.eintraege, []);
    assert.equal(r.json.erlaubt, true);
  });
});

test('Auflisten: nur Ordner, alphabetisch, ohne Versteckte, Links nur wenn sie in der Wurzel bleiben', async () => {
  await mitRunner('auflisten', ERLAUBT, async ({ liste }) => {
    const r = await liste(wurzel);
    assert.equal(r.status, 200);
    assert.equal(r.json.pfad, wurzel);
    // datei.txt, .versteckt, link-raus (führt hinaus), link-nachbar (Nachbar), link-kaputt fehlen.
    assert.deepEqual(r.json.eintraege, [
      { name: 'alpha', ordner: true },
      { name: 'Beta', ordner: true },
      { name: 'link-rein', ordner: true },
    ]);
    assert.equal(r.json.abgeschnitten, undefined);
    const tief = await liste(join(wurzel, 'alpha'));
    assert.deepEqual(tief.json.eintraege, [{ name: 'tief', ordner: true }]);
    // Ein Pfad mit abschließendem Schrägstrich und doppelten Schrägstrichen ist derselbe Ordner.
    assert.equal((await liste(`${wurzel}//alpha/`)).status, 200);
  });
});

test('mehr als 500 Einträge: abgeschnitten', async () => {
  await mitRunner('gross', ERLAUBT, async ({ liste }) => {
    const r = await liste(gross);
    assert.equal(r.status, 200);
    assert.equal(r.json.eintraege.length, MAX_EINTRAEGE);
    assert.equal(r.json.abgeschnitten, true);
    assert.equal(r.json.eintraege[0].name, 'd0000');
  });
});

test('Ausbrüche beim Auflisten: 403 ausserhalb bzw. 400 ungueltig', async () => {
  await mitRunner('ausbruch', ERLAUBT, async ({ liste }) => {
    const ausserhalb = [
      join(wurzel, '..'),
      `${wurzel}/../aussen`,
      `${wurzel}/alpha/../../aussen`,
      `${wurzel}/..`,
      tmp, // Vorfahr der Wurzel
      '/',
      '/etc',
      nachbar, // gleicher Namensanfang
      `${wurzel}-nachbar`,
      join(wurzel, 'link-raus'), // Link aus der Wurzel hinaus
      `${wurzel}/link-raus/..`,
      join(wurzel, 'link-nachbar'),
    ];
    for (const p of ausserhalb) {
      const r = await liste(p);
      assert.equal(r.status, 403, `${p} -> ${r.status}`);
      assert.equal(r.json.fehler, 'ausserhalb', p);
      assert.equal(r.json.ok, false);
    }
    for (const p of ['relativ/pfad', 'alpha', '.', '..', `${wurzel}\0/alpha`, `${wurzel}/alpha\0`]) {
      const r = await liste(p);
      assert.equal(r.status, 400, `${JSON.stringify(p)} -> ${r.status}`);
      assert.equal(r.json.fehler, 'ungueltig');
    }
  });
});

test('Ordner nicht vorhanden: 404; Datei statt Ordner: 400', async () => {
  await mitRunner('fehlt', ERLAUBT, async ({ liste }) => {
    assert.equal((await liste(join(wurzel, 'gibtsnicht'))).status, 404);
    assert.equal((await liste(join(wurzel, 'link-kaputt'))).status, 404);
    const datei = await liste(join(wurzel, 'datei.txt'));
    assert.equal(datei.status, 400);
    assert.equal(datei.json.fehler, 'kein_ordner');
    // Ein nicht vorhandener Pfad AUSSERHALB verrät nichts über das Dateisystem: gleich 403.
    assert.equal((await liste('/gibt/es/nicht/aussen')).status, 403);
  });
});

test('ohne Token (oder mit falschem) weisen beide Wege ab', async () => {
  await mitRunner('token', ERLAUBT, async ({ rufe }) => {
    assert.equal((await rufe('GET', '/api/ordner', { token: null })).status, 401);
    assert.equal((await rufe('GET', `/api/ordner?pfad=${encodeURIComponent(wurzel)}`, { token: 'falsch' })).status, 401);
    assert.equal((await rufe('POST', '/api/gespraeche', { body: { ordner: wurzel }, token: null })).status, 401);
    assert.equal((await rufe('POST', '/api/gespraeche', { body: { ordner: wurzel }, token: 'falsch' })).status, 401);
    // Es ist dabei kein Gespräch entstanden.
    const alle = await rufe('GET', '/api/gespraeche');
    assert.equal(alle.json.gespraeche.filter((g) => g.ordner).length, 0);
  });
});

test('Funktion aus (keine Umgebungsvariable): Wurzeln leer, Auflisten 403, POST mit ordner 400 „nicht freigegeben“', async () => {
  await mitRunner('aus', undefined, async ({ liste, neu, rufe }) => {
    const r = await liste();
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.wurzeln, []);
    assert.equal(r.json.erlaubt, false);
    assert.equal((await liste(wurzel)).status, 403);
    const p = await neu({ ordner: wurzel });
    assert.equal(p.status, 400);
    assert.match(p.json.fehler, /nicht freigegeben/);
    // Ohne `ordner` geht alles wie bisher.
    assert.equal((await neu({ titel: 'ohne' })).status, 201);
    assert.equal((await rufe('GET', '/api/ordner?pfad=')).json.erlaubt, false);
  });
});

test('POST mit ordner: wird cwd der Sitzung (agent.cwd in Gespräch und Liste), ordner gewinnt gegen arbeitsbereich', async () => {
  await mitRunner('post', ERLAUBT, async ({ neu, rufe }) => {
    const ziel = join(wurzel, 'alpha');
    const r = await neu({ titel: 'mit Ordner', arbeitsbereich: 'standard', ordner: ziel });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const g = r.json.gespraech;
    assert.equal(g.agent.cwd, ziel);
    assert.equal(g.meta.ordner, ziel);
    assert.equal(g.meta.arbeitsbereich, 'standard', 'der Arbeitsbereich bleibt für Modell und Systemtext maßgeblich');

    const einzeln = await rufe('GET', `/api/gespraech/${g.id}`);
    assert.equal(einzeln.json.agent.cwd, ziel);
    const liste = await rufe('GET', '/api/gespraeche');
    const eintrag = liste.json.gespraeche.find((x) => x.id === g.id);
    assert.equal(eintrag.agent.cwd, ziel);
    assert.equal(eintrag.ordner, ziel);
    // Gespräche ohne Ordner zeigen den Arbeitsbereich.
    const ohne = liste.json.gespraeche.find((x) => x.art === 'root');
    assert.equal(ohne.agent.cwd, arbeit);
    assert.equal(ohne.ordner, null);

    // Ein Link innerhalb der Wurzel ist erlaubt; gespeichert wird das aufgelöste Ziel.
    const ueberLink = await neu({ ordner: join(wurzel, 'link-rein') });
    assert.equal(ueberLink.status, 201);
    assert.equal(ueberLink.json.gespraech.agent.cwd, ziel);
  });
});

test('POST mit ordner: Ausbrüche, Müll und Nichtexistentes sind 400 mit Meldung, und es entsteht kein Gespräch', async () => {
  await mitRunner('post-ausbruch', ERLAUBT, async ({ neu, rufe }) => {
    const schlecht = [
      `${wurzel}/../aussen`,
      join(wurzel, 'link-raus'),
      join(wurzel, 'link-nachbar'),
      tmp,
      '/',
      nachbar,
      'relativ',
      '',
      `${wurzel}\0`,
      join(wurzel, 'gibtsnicht'),
      join(wurzel, 'datei.txt'),
    ].filter((p) => p !== '');
    for (const p of schlecht) {
      const r = await neu({ ordner: p });
      assert.equal(r.status, 400, `${JSON.stringify(p)} -> ${r.status} ${JSON.stringify(r.json)}`);
      assert.ok(r.json.fehler.length > 10, 'klare Meldung');
    }
    for (const p of [42, {}, ['/x'], true]) {
      assert.equal((await neu({ ordner: p })).status, 400, JSON.stringify(p));
    }
    const alle = await rufe('GET', '/api/gespraeche');
    assert.equal(alle.json.gespraeche.length, 1, 'nur das Hauptgespräch');
  });
});

test('Umstellen behält den Ordner; fällt die Wurzel weg, gilt wieder der Arbeitsbereich', async () => {
  const alt = await (async () => {
    let id;
    await mitRunner('rueckfall', ERLAUBT, async ({ neu, runner }) => {
      const ziel = join(wurzel, 'alpha');
      const g = (await neu({ ordner: ziel })).json.gespraech;
      id = g.id;
      await runner.aendereGespraech(id, { titel: 'umbenannt' });
      const danach = await runner.gespraech(id);
      assert.equal(danach.meta.ordner, ziel);
      assert.equal(danach.agent.cwd, ziel, 'Umstellen (Titel) lässt den Ordner stehen');
    });
    return id;
  })();
  assert.ok(alt !== undefined);
  // Neu starten ohne Wurzeln (Rückfall): dieselbe Datenbank, Funktion aus -> cwd ist der Arbeitsbereich.
  await mitRunner('rueckfall', undefined, async ({ rufe }) => {
    const liste = await rufe('GET', '/api/gespraeche');
    const eintrag = liste.json.gespraeche.find((x) => x.id === alt);
    assert.ok(eintrag, 'Gespräch bleibt erhalten');
    assert.equal(eintrag.agent.cwd, arbeit);
    assert.equal((await rufe('GET', `/api/gespraech/${alt}`)).status, 200);
  });
});
