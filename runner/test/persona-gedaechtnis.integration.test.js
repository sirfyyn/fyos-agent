/**
 * Integration: der echte Runner mit Faux-Modell und eingeschaltetem Gedächtnis. Geprüft wird, was aus Einzelteilen nicht folgt:
 * Der Abschnitt „Gedächtnis“ steht im Zugkopf, das Modell kann gedaechtnis_merken aufrufen (Datei entsteht, Qdrant ist
 * ausdrücklich nicht erreichbar und der Runner läuft trotzdem weiter), und ein zweiter Zug sieht den Fakt im Index des Kopfes.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { konfigurationLaden } from '../src/config.js';
import { Runner } from '../src/runner.js';

const warte = (ms) => new Promise((r) => setTimeout(r, ms));
async function bis(fn, { ms = 15000, was = 'Bedingung' } = {}) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    if (await fn()) return true;
    await warte(100);
  }
  throw new Error(`Zeit abgelaufen: ${was}`);
}

const tmp = mkdtempSync(join(tmpdir(), 'gedaechtnis-int-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const hub = {
  aufrufen: async () => ({ ok: true, result: {} }),
  melden: async () => ({ ok: true }),
  bereicheMelden: async () => ({ ok: true }),
  gesundheit: async () => ({ ok: true }),
  suchen: async () => [],
  schema: async () => ({}),
  eingangLesen: async (nach) => ({ eintraege: [], letzte: nach }),
};

function baue(an) {
  const cfg = konfigurationLaden(
    {
      hub: 'http://hub.test',
      agent: 'persona',
      arbeitsbereiche: { standard: { pfad: tmp, titel: 'Test' } },
      pi_durable: {
        storage: join(tmp, an ? 'an.sqlite' : 'aus.sqlite'),
        security: { token: 'test-token-test-token-test-token-00' },
        proactive: { enabled: false },
        egress: { enabled: false },
        browser: { enabled: false },
        desktop: { enabled: false },
        // 127.0.0.1:1 lehnt sofort ab: der Index ist „nicht erreichbar“, ohne dass der Test wartet.
        gedaechtnis: { an, ordner: join(tmp, an ? 'g-an' : 'g-aus'), qdrant_url: 'http://127.0.0.1:1', embed_url: 'http://127.0.0.1:1' },
      },
    },
    {},
  );
  const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: [{ id: 'hausmodell' }, { id: 'hausmodell-max' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  return { cfg, faux, models };
}

const kopf = (context) => String(context.systemPrompt ?? JSON.stringify(context.messages));
const texte = (ansicht) =>
  ansicht.entries
    .flatMap((e) => e.model ?? [])
    .filter((m) => m?.role === 'assistant')
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b?.type === 'text')
    .map((b) => b.text);

test('Gedächtnis an: Abschnitt im Zugkopf, merken schreibt die Datei, Qdrant aus = Hinweis statt Absturz, nächster Zug sieht den Fakt', async () => {
  const { cfg, faux, models } = baue(true);
  const köpfe = [];
  faux.setResponses([
    (context) => {
      köpfe.push(kopf(context));
      return fauxAssistantMessage([fauxToolCall('gedaechtnis_merken', { text: 'Der Testfakt lautet: Dateien sind die Wahrheit.', quelle: 'integrationstest' })], { stopReason: 'toolUse' });
    },
    (context) => {
      köpfe.push(kopf(context));
      return fauxAssistantMessage('gemerkt');
    },
    (context) => {
      köpfe.push(kopf(context));
      return fauxAssistantMessage('zweiter Zug');
    },
  ]);
  const runner = new Runner(cfg, { models, hub });
  await runner.start();
  try {
    const root = (await runner.gespraeche()).find((g) => g.art === 'root');
    await runner.sende(root.id, 'Merk dir den Testfakt');
    await bis(async () => texte(await runner.ansicht(root.id)).includes('gemerkt'), { was: 'Antwort nach dem Werkzeug' });
    assert.match(köpfe[0], /Dein Gedächtnis/);
    assert.match(köpfe[0], /noch leer/);
    const dateien = readdirSync(join(cfg.pi_durable.gedaechtnis.ordner, 'fakten'));
    assert.equal(dateien.length, 1);
    const z = runner.gedaechtnis.zustand();
    assert.equal(z.an, true);
    assert.equal(z.fakten, 1);
    assert.equal(z.qdrant_ok, false, 'ehrlich: Index nicht erreichbar');
    assert.equal(z.index_offen, 1);
    const ergebnis = JSON.stringify((await runner.ansicht(root.id)).entries);
    assert.match(ergebnis, /nur in der Datei/);

    await runner.sende(root.id, 'Noch ein Zug');
    await bis(async () => texte(await runner.ansicht(root.id)).includes('zweiter Zug'), { was: 'zweiter Zug' });
    assert.match(köpfe.at(-1), /Der Testfakt lautet/);
  } finally {
    await runner.close().catch(() => {});
  }
});

test('Gedächtnis aus: kein Abschnitt, keine Werkzeuge, keine Dateien', async () => {
  const { cfg, faux, models } = baue(false);
  let gesehen = '';
  faux.setResponses([
    (context) => {
      gesehen = kopf(context) + JSON.stringify((context.tools ?? []).map((t) => t.name));
      return fauxAssistantMessage('ok');
    },
  ]);
  const runner = new Runner(cfg, { models, hub });
  await runner.start();
  try {
    const root = (await runner.gespraeche()).find((g) => g.art === 'root');
    await runner.sende(root.id, 'Hallo');
    await bis(async () => texte(await runner.ansicht(root.id)).includes('ok'), { was: 'Antwort' });
    assert.doesNotMatch(gesehen, /Dein Gedächtnis|gedaechtnis_suchen|pflegeliste/);
    assert.equal(existsSync(cfg.pi_durable.gedaechtnis.ordner), false);
    assert.equal(runner.gedaechtnis.zustand().an, false);
  } finally {
    await runner.close().catch(() => {});
  }
});
