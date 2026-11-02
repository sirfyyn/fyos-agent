/**
 * Integration (Besitzer 26.10.2026, „Secrets wie Claude“): der echte Runner mit Faux-Modell und einem falschen `kubectl` (Attrappen, kein Cluster).
 * Gezeigt wird, dass ein Secret-Wert, den ein Werkzeug liefert, weder zum Modell noch in die Aufzeichnung noch in den Egress zum Hub gelangt
 * (`kubectl get secret … -o yaml` und `-o jsonpath`), dass Persona den Wert trotzdem benutzen kann (A nach B durchreichen), und dass die
 * Geheimnis-Wache einen Aufruf ablehnt, der den Wert in einen Matrix-Text schreiben will.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { konfigurationLaden } from '../src/config.js';
import { Egress } from '../src/egress.js';
import { Runner } from '../src/runner.js';

const warte = (ms) => new Promise((r) => setTimeout(r, ms));
async function bis(fn, { ms = 20000, was = 'Bedingung' } = {}) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    if (await fn()) return true;
    await warte(100);
  }
  throw new Error(`Zeit abgelaufen: ${was}`);
}

// Attrappen: nur in diesem Test.
const KLAR = 'Wegwerf-Testwert-4711-nur-Attrappe';
const B64 = Buffer.from(KLAR).toString('base64');

const tmp = mkdtempSync(join(tmpdir(), 'persona-secrets-int-'));
const altPfad = process.env.PATH;
after(() => {
  process.env.PATH = altPfad;
  rmSync(tmp, { recursive: true, force: true });
});

// Falsches kubectl: get liefert yaml oder (mit jsonpath) den Base64-Wert; create nimmt stdin entgegen und legt es als „B“ ab.
const bin = join(tmp, 'bin');
mkdirSync(bin);
const yamlDatei = join(tmp, 'secret.yaml');
const bDatei = join(tmp, 'ziel-b.txt');
writeFileSync(
  yamlDatei,
  `apiVersion: v1\ndata:\n  token: ${B64}\nkind: Secret\nmetadata:\n  name: attrappe-geheimnis\n  namespace: fyos\ntype: Opaque\n`,
);
writeFileSync(
  join(bin, 'kubectl'),
  `#!/bin/sh
case "$*" in
  *create*) cat > '${bDatei}'; echo "secret/b created" ;;
  *jsonpath*) printf '%s' '${B64}' ;;
  *) cat '${yamlDatei}' ;;
esac
`,
);
chmodSync(join(bin, 'kubectl'), 0o755);

const hub = {
  aufrufen: async () => ({ ok: true, result: {} }),
  melden: async () => ({ ok: true }),
  bereicheMelden: async () => ({ ok: true }),
  gesundheit: async () => ({ ok: true }),
  suchen: async () => [],
  schema: async () => ({}),
  eingangLesen: async (nach) => ({ eintraege: [], letzte: nach }),
};

const texte = (ansicht) =>
  ansicht.entries
    .flatMap((e) => e.model ?? [])
    .filter((m) => m?.role === 'assistant')
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b?.type === 'text')
    .map((b) => b.text);

test('Attrappe: das falsche kubectl liefert den Wert wirklich (sonst bewiese der Test nichts)', () => {
  const r = spawnSync('sh', ['-c', 'kubectl get secret x -o jsonpath=a'], { env: { ...process.env, PATH: `${bin}:${altPfad}` }, encoding: 'utf8' });
  assert.equal(r.stdout, B64);
});

test('kubectl get secret -o yaml und -o jsonpath: der Wert erreicht weder Modell noch Aufzeichnung noch Egress; Durchreichen geht', async () => {
  // Absoluter Pfad zum falschen kubectl: Der Test fasst nie das echte kubectl und nie einen Cluster an.
  const k = join(bin, 'kubectl');
  const cfg = konfigurationLaden(
    {
      hub: 'http://hub.test',
      agent: 'persona',
      arbeitsbereiche: { standard: { pfad: tmp, titel: 'Test' } },
      pi_durable: {
        storage: join(tmp, 'fyos.sqlite'),
        security: { token: 'test-token-test-token-test-token-00' },
        proactive: { enabled: false },
        egress: { enabled: true, flushMs: 100 },
        browser: { enabled: false },
        desktop: { enabled: false },
        gedaechtnis: { an: false },
      },
    },
    {},
  );
  const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: [{ id: 'hausmodell' }, { id: 'hausmodell-max' }] });
  const models = createModels();
  models.setProvider(faux.provider);

  const gemeldet = [];
  const hubMitEgress = { ...hub, melden: async (stueck) => (gemeldet.push(...stueck), { ok: true }) };
  const modellSah = [];
  const bash = (command) => fauxAssistantMessage([fauxToolCall('bash', { command })], { stopReason: 'toolUse' });
  faux.setResponses([
    () => bash(`${k} -n fyos get secret attrappe-geheimnis -o yaml`),
    (context) => {
      modellSah.push(JSON.stringify(context.messages));
      return bash(`${k} -n fyos get secret attrappe-geheimnis -o jsonpath='{.data.token}'`);
    },
    (context) => {
      modellSah.push(JSON.stringify(context.messages));
      return bash(
        `${k} -n fyos get secret attrappe-geheimnis -o jsonpath='{.data.token}' | base64 -d | ${k} -n caddy create secret generic b --from-file=token=/dev/stdin`,
      );
    },
    (context) => {
      modellSah.push(JSON.stringify(context.messages));
      return fauxAssistantMessage('fertig');
    },
  ]);

  const runner = new Runner(cfg, { models, hub: hubMitEgress });
  await runner.start();
  const egress = new Egress({ cfg, harness: runner.harness, hub: hubMitEgress, onFehler: () => {} });
  await egress.start();
  try {
    const root = (await runner.gespraeche()).find((g) => g.art === 'root');
    await runner.sende(root.id, 'Reich das Secret von fyos nach caddy durch.');
    await bis(async () => texte(await runner.ansicht(root.id)).includes('fertig'), { was: 'Ende des Zuges' });
    await bis(() => gemeldet.some((e) => e.typ === 'session.idle'), { was: 'Egress meldet das Ende' });
    await egress.flush?.();

    // Modell: sah drei Rückläufe, nie den Wert; es sah die Schwärzung.
    assert.equal(modellSah.length, 3);
    for (const sicht of modellSah) {
      assert.ok(!sicht.includes(B64), 'Base64-Wert im Modellkontext');
      assert.ok(!sicht.includes(KLAR), 'Klartext im Modellkontext');
    }
    assert.match(modellSah[0], /token: \[geschwärzt\]/, '-o yaml: Wert ersetzt, Schlüssel sichtbar');
    assert.match(modellSah[0], /attrappe-geheimnis/, 'Name bleibt');
    assert.match(modellSah[1], /Ausgabe eines Secret-Lesebefehls/, '-o jsonpath: ganze Ausgabe ersetzt');
    assert.match(modellSah[2], /secret\/b created/, 'Ausgabe des Verbrauchers bleibt lesbar');

    // Aufzeichnung (Ansicht des Gesprächs) und Egress zum Hub: nie der Wert.
    const aufzeichnung = JSON.stringify((await runner.ansicht(root.id)).entries);
    assert.ok(!aufzeichnung.includes(B64) && !aufzeichnung.includes(KLAR), 'Wert in der Aufzeichnung');
    const egressText = JSON.stringify(gemeldet);
    assert.ok(gemeldet.length > 0);
    assert.ok(!egressText.includes(B64) && !egressText.includes(KLAR), 'Wert im Egress zum Hub');

    // Benutzen: Der Wert ist bei B angekommen, ohne je angezeigt worden zu sein.
    assert.equal(readFileSync(bDatei, 'utf8'), KLAR);
  } finally {
    await egress.stop();
    await runner.close().catch(() => {});
  }
});

test('matrix_senden mit einem Secret-Wert wird abgelehnt, der Wert erreicht den Sender nie', async () => {
  const cfg = konfigurationLaden(
    {
      hub: 'http://hub.test',
      agent: 'persona',
      arbeitsbereiche: { standard: { pfad: tmp, titel: 'Test' } },
      pi_durable: {
        storage: join(tmp, 'matrix.sqlite'),
        security: { token: 'test-token-test-token-test-token-00' },
        proactive: { enabled: false },
        egress: { enabled: false },
        browser: { enabled: false },
        desktop: { enabled: false },
        gedaechtnis: { an: false },
      },
    },
    {},
  );
  const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: [{ id: 'hausmodell' }, { id: 'hausmodell-max' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const wert = ['ghp', 'Q7x9Lm2Pq4Rt6Vw8Yz0Ab'].join('_');
  let rueckgabe = '';
  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall('matrix_senden', { text: `Das Token ist ${wert}`, art: 'info' })], { stopReason: 'toolUse' }),
    (context) => {
      rueckgabe = JSON.stringify(context.messages);
      return fauxAssistantMessage('verstanden');
    },
  ]);
  const runner = new Runner(cfg, { models, hub });
  await runner.start();
  try {
    const root = (await runner.gespraeche()).find((g) => g.art === 'root');
    await runner.sende(root.id, 'Schick Besitzer das Token.');
    await bis(async () => texte(await runner.ansicht(root.id)).includes('verstanden'), { was: 'Ende des Zuges' });
    assert.match(rueckgabe, /GEHEIMNIS-WACHE/);
    assert.match(rueckgabe, /Verweis/);
    assert.ok(!rueckgabe.replace(/Das Token ist ghp_[A-Za-z0-9]+/g, '').includes(wert), 'Wert nur im eigenen Aufruf, nicht in der Antwort der Wache');
  } finally {
    await runner.close().catch(() => {});
  }
});
