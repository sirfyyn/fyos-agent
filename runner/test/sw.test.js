/**
 * Service Worker der Web-Oberfläche (public/sw.js): Netz zuerst, Cache als Rückfall.
 * Früher: Cache zuerst mit fester Version, ein neuer Stand von app.js kam nie beim Client an,
 * solange sw.js selbst unverändert blieb.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const QUELLE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../public/sw.js'), 'utf8');

class Response {
  constructor(text, init = {}) {
    this.text = text;
    this.status = init.status ?? 200;
  }
  clone() {
    return new Response(this.text, { status: this.status });
  }
  static error() {
    return Object.assign(new Response('', { status: 0 }), { fehler: true });
  }
}

function baue(netz) {
  const speicher = new Map();
  const handler = {};
  const caches = {
    open: async () => ({
      put: async (req, antwort) => void speicher.set(req.url, antwort),
      addAll: async () => {},
    }),
    match: async (req) => speicher.get(typeof req === 'string' ? `http://runner.test${req}` : req.url),
    keys: async () => [],
    delete: async () => true,
  };
  const self = {
    location: { origin: 'http://runner.test' },
    addEventListener: (typ, fn) => void (handler[typ] = fn),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  vm.runInNewContext(QUELLE, { self, caches, Response, URL, fetch: async (req) => netz(req), Promise });
  /** Ruft den fetch-Handler auf; `undefined`, wenn der Service Worker die Anfrage nicht übernimmt. */
  async function hole(pfad, optionen = {}) {
    const req = { url: `http://runner.test${pfad}`, method: 'GET', mode: 'no-cors', ...optionen };
    let antwort;
    handler.fetch({ request: req, respondWith: (p) => void (antwort = p) });
    if (!antwort) return undefined;
    const a = await antwort;
    await new Promise((r) => setImmediate(r)); // der Cache wird nebenher beschrieben
    return a;
  }
  return { hole, speicher };
}

test('sw: app.js kommt zuerst aus dem Netz, auch wenn eine alte Fassung im Cache liegt', async () => {
  let stand = 'alt';
  const { hole, speicher } = baue(async () => new Response(stand));
  assert.equal((await hole('/app.js')).text, 'alt');
  stand = 'neu';
  assert.equal((await hole('/app.js')).text, 'neu', 'der aktuelle Stand, nicht der Cache');
  assert.equal(speicher.get('http://runner.test/app.js').text, 'neu', 'der Cache wird nachgezogen');
});

test('sw: antwortet der Runner nicht (Neustart), kommt die Datei aus dem Cache; Navigation fällt auf index.html zurück', async () => {
  let online = true;
  const { hole } = baue(async () => {
    if (!online) throw new Error('refused');
    return new Response('inhalt');
  });
  await hole('/app.js');
  await hole('/index.html');
  online = false;
  assert.equal((await hole('/app.js')).text, 'inhalt');
  assert.equal((await hole('/gespraech/7', { mode: 'navigate' })).text, 'inhalt', 'Navigation: index.html');
  assert.equal((await hole('/unbekannt.js')).fehler, true, 'unbekannte Datei: Fehler statt HTML');
});

test('sw: API, andere Hosts und Nicht-GET übernimmt der Service Worker nicht', async () => {
  const { hole } = baue(async () => new Response('x'));
  assert.equal(await hole('/api/gespraeche'), undefined);
  assert.equal(await hole('/app.js', { method: 'POST' }), undefined);
  assert.equal(await hole('/app.js', { url: 'http://fremd.test/app.js' }), undefined);
});

test('sw: fehlerhafte Antworten (404) werden nicht gemerkt', async () => {
  const { hole, speicher } = baue(async () => new Response('weg', { status: 404 }));
  assert.equal((await hole('/app.js')).status, 404);
  assert.equal(speicher.size, 0);
});
