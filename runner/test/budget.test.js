import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UsageDoc } from '@earendil-works/pi-durable';
import { LaufListe, Register } from '../src/documents.js';
import { Budget, BudgetDoc, kostenAusNutzung, monatVon, usageEreignis } from '../src/budget.js';

const stumm = () => {};
const nutzung = (modelle, werkzeuge = 0) => ({
  models: { 'hausmodell/hausmodell': { cost: { total: modelle } }, 'hausmodell/hausmodell-max': { cost: { total: 0 } } },
  tools: werkzeuge ? { bash: { cost: { total: werkzeuge } } } : {},
});

/** Ein Harness aus dem Speicher: genug für Register, LaufListe, UsageDoc und das Budget-Dokument. */
function falschesHarness({ agents = ['a', 'b'], usage = {}, laeufe = {} } = {}) {
  const bud = { version: 1, monat: null, basis: {} };
  const harness = {
    usage,
    bud,
    commits: 0,
    async snapshot(token, ...rest) {
      if (token === Register) return { agents: agents.map((id) => ({ id })) };
      if (token === LaufListe) return { eintraege: laeufe };
      if (token === BudgetDoc) return structuredClone(bud);
      if (token === UsageDoc) return usage[rest[0]];
      throw new Error('unerwartetes Dokument');
    },
    async commit(fn) {
      harness.commits += 1;
      await fn({ doc: async (token) => (token === BudgetDoc ? bud : assert.fail('anderes Dokument')) });
    },
  };
  return harness;
}

test('kostenAusNutzung summiert Modelle und Werkzeuge, ignoriert Unsinn', () => {
  assert.equal(kostenAusNutzung(nutzung(1.5, 0.25)), 1.75);
  assert.equal(kostenAusNutzung(undefined), 0);
  assert.equal(kostenAusNutzung({ models: { x: { cost: { total: -3 } }, y: { cost: { total: 'a' } }, z: {} } }), 0);
});

test('Monat summiert über alle Gespräche und Kindgespräche von Läufen', async () => {
  const harness = falschesHarness({
    usage: { a: nutzung(1), b: nutzung(2, 0.5), kind: nutzung(4) },
    laeufe: { 7: { id: '7', kindId: 'kind' }, 8: { id: '8', kindId: null } },
  });
  const b = new Budget({ cfg: { kurs_usd_eur: 0.5, budget_monat_eur: 200 }, harness, log: stumm, jetzt: () => new Date(2026, 9, 24).getTime() });
  const z = await b.aktualisieren();
  assert.equal(z.monat, '2026-10');
  assert.equal(z.usd, 7.5);
  assert.equal(z.eur, 3.75);
  assert.equal(z.grenze_eur, 200);
  assert.equal(z.erreicht, false);
  assert.equal(b.zustand().usd, 7.5);
});

test('Ohne Kurs nur Dollar; erlaubt bleibt ok', async () => {
  const harness = falschesHarness({ usage: { a: nutzung(2) } });
  const b = new Budget({ cfg: {}, harness, log: stumm });
  await b.aktualisieren();
  assert.deepEqual(Object.keys(b.zustand()).sort(), ['monat', 'usd']);
  assert.equal(b.erlaubt().ok, true);
});

test('Grenze: wird nur gemeldet (einmal je Monat), erlaubt sperrt nicht', async () => {
  const zeilen = [];
  const harness = falschesHarness({ usage: { a: nutzung(100) } });
  const b = new Budget({ cfg: { kurs_usd_eur: 1, budget_monat_eur: 50 }, harness, log: (z) => zeilen.push(z) });
  await b.aktualisieren();
  await b.aktualisieren();
  assert.equal(b.zustand().erreicht, true);
  const e = b.erlaubt();
  assert.equal(e.ok, true);
  assert.match(e.grund, /Monatsbudget erreicht/);
  assert.equal(zeilen.filter((z) => /erreicht/.test(z)).length, 1);
});

test('Vorgabe der Grenze ist 200 Euro', () => {
  assert.equal(new Budget({ cfg: {}, harness: falschesHarness() }).grenzeEur, 200);
});

test('Monatswechsel: der Stand am Monatsanfang ist die Null', async () => {
  let jetzt = new Date(2026, 9, 30, 12).getTime();
  const harness = falschesHarness({ usage: { a: nutzung(10) } });
  const b = new Budget({ cfg: { kurs_usd_eur: 1 }, harness, log: stumm, jetzt: () => jetzt });
  assert.equal((await b.aktualisieren()).usd, 10); // erster Start: alles zählt
  harness.usage.a = nutzung(12);
  assert.equal((await b.aktualisieren()).usd, 12);
  jetzt = new Date(2026, 10, 1, 0, 5).getTime();
  const z = await b.aktualisieren();
  assert.equal(z.monat, '2026-11');
  assert.equal(z.usd, 0);
  harness.usage.a = nutzung(13.5);
  harness.usage.b = nutzung(1); // neues Gespräch im neuen Monat zählt ganz
  assert.equal((await b.aktualisieren()).usd, 2.5);
  assert.equal(monatVon(jetzt), '2026-11');
});

test('Zurückgesetzte Nutzung zählt wieder ab Null; ohne Änderung kein Schreiben', async () => {
  const harness = falschesHarness({ usage: { a: nutzung(10) } });
  const b = new Budget({ cfg: { kurs_usd_eur: 1 }, harness, log: stumm });
  await b.aktualisieren();
  const nachErstem = harness.commits;
  await b.aktualisieren();
  assert.equal(harness.commits, nachErstem);
  harness.bud.basis = { a: 10 };
  harness.usage.a = nutzung(3);
  assert.equal((await b.aktualisieren()).usd, 3);
  assert.equal(harness.bud.basis.a, 0);
});

test('Ein Fehler beim Rechnen hält den letzten Stand und wird einmal gemeldet', async () => {
  const zeilen = [];
  const harness = falschesHarness({ usage: { a: nutzung(1) } });
  const b = new Budget({ cfg: { kurs_usd_eur: 1 }, harness, log: (z) => zeilen.push(z) });
  await b.aktualisieren();
  harness.snapshot = async () => {
    throw new Error('Speicher weg');
  };
  await b.aktualisieren();
  await b.aktualisieren();
  assert.equal(b.zustand().usd, 1);
  assert.equal(b.zustand().fehler, 'Speicher weg');
  assert.equal(zeilen.length, 1);
});

test('start/stop rechnet sofort und räumt den Zeitgeber ab', async () => {
  const harness = falschesHarness({ usage: { a: nutzung(5) } });
  const b = new Budget({ cfg: { kurs_usd_eur: 1 }, harness, log: stumm });
  b.start();
  await new Promise((r) => setTimeout(r, 50));
  b.stop();
  assert.equal(b.zustand().usd, 5);
});

test('usageEreignis wie im RPC-Runner: Stufe, Kontext, Mikro-Euro', () => {
  const cfg = { kurs_usd_eur: 0.5, modelle: { hausmodell: { tier: 'normal', ctx_max: 65536 } } };
  assert.deepEqual(usageEreignis({ cfg, modell: 'hausmodell', tokens: 1200, kosten: 0.002 }), {
    typ: 'usage',
    modell: 'hausmodell',
    tier: 'normal',
    ctx: 1200,
    ctx_max: 65536,
    kosten_micro_eur: 1000,
  });
  assert.deepEqual(usageEreignis({ cfg: {}, modell: '', tokens: -1 }), { typ: 'usage', modell: 'unbekannt', tier: 'normal' });
});
