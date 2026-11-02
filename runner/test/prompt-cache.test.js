/**
 * Prompt-Cache der Modellanfragen (Befund 26.10.2026: der Block „# Stand …, ~HH:MM“ im Kontextbuch stand im Systemkopf bei
 * Zeichen ≈ 15.430; jede neue Fassung warf den Rest des Prompts aus dem Cache). Geprüft im echten Runner (pi-durable + SQLite)
 * mit künstlicher Stromfunktion, die jede Anfrage so festhält, wie Hausmodell/Katy sie bekäme:
 *
 *  - zwei aufeinanderfolgende Züge mit anderem Kontextbuch (neue Uhrzeit, neuer Inhalt) und anderem Weltbild: der Systemkopf
 *    bleibt Byte für Byte gleich (Länge und Hash), der neue Stand steht NACH dem Verlauf;
 *  - nur die Uhrzeit neu geschrieben (gleiche Stunde): gar keine Aktualisierung;
 *  - die veränderlichen Abschnitte stehen hinten im Kopf, ein später dazukommender Repo-Abschnitt hängt hinten an.
 *
 * `FYOS_PROMPT_AUFBAU=1 node --test test/prompt-cache.test.js` gibt den Aufbau einer echten Anfrage mit Zeichenpositionen aus.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { convertMessages } from '@earendil-works/pi-ai/api/openai-completions';
import { konfigurationLaden } from '../src/config.js';
import { FLUECHTIGE_ABSCHNITTE, ordneAbschnitte } from '../src/extension.js';
import { standGerundet } from '../src/persona/kontext.js';
import { eingabeInhalt } from '../src/ingress.js';
import { Runner } from '../src/runner.js';
import { weltblock } from '../src/welt.js';

const CTX = BACKGROUND_CONTEXT;
const COMPAT = { supportsMidConvoSystemMessages: false, supportsDeveloperRole: false, requiresAssistantAfterToolResult: false };
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
async function bis(fn, { ms = 40000, was = 'Bedingung' } = {}) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    const wert = await fn();
    if (wert) return wert;
    await warte(100);
  }
  throw new Error(`Zeit abgelaufen: ${was}`);
}

const tmp = mkdtempSync(join(tmpdir(), 'pidurable-cache-'));
const kontextDir = join(tmp, 'kontext');
mkdirSync(kontextDir, { recursive: true });
process.env.FYOS_KONTEXT_DIR = kontextDir;
after(() => rmSync(tmp, { recursive: true, force: true }));

const hub = () => ({
  aufrufen: async () => ({ ok: true, result: {} }),
  melden: async () => ({ ok: true }),
  bereicheMelden: async () => ({ ok: true }),
  gesundheit: async () => ({ ok: true }),
  suchen: async () => [],
  schema: async () => ({}),
  eingangLesen: async (nach) => {
    await warte(150);
    return { eintraege: [], letzte: nach };
  },
});

/** Hält jede Anfrage fest (Kontext nach der Präfix-Hülle, Optionen mit Header) und antwortet kurz. */
function basis(aufrufe) {
  const bauen = (model, context, options) => {
    const s = createAssistantMessageEventStream();
    aufrufe.push({ model, context, options });
    queueMicrotask(() => {
      const m = fauxAssistantMessage(`Antwort ${aufrufe.length}`);
      s.push({ type: 'done', reason: 'stop', message: m });
      s.end(m);
    });
    return s;
  };
  return { stream: bauen, streamSimple: bauen };
}

const hash = (t) => createHash('sha256').update(t).digest('hex');
const anfrage = (a) => convertMessages(a.model, a.context, COMPAT);
const alsText = (c) => (typeof c === 'string' ? c : (c ?? []).map((b) => b.text ?? '').join(''));

const buch = (zeit, inhalt) =>
  `# Stand 25.10.2026, ~${zeit} (pi-durable-Runner)\n\nAuftrag: Prompt-Cache.\n${inhalt}\n`;

const eingang = (text, welt, jetzt) =>
  eingabeInhalt(
    { quelle: 'matrix', von: 'max', bezug: `t-${jetzt}`, klasse: 'max', text },
    weltblock({ quellen: { hauptserver: { ok: true, t: jetzt, wert: { gpu: `${jetzt % 97} %` } }, haus: { ok: true, t: jetzt, wert: welt } } }, jetzt),
  );

async function start(name) {
  const dir = join(tmp, name);
  const cfg = konfigurationLaden(
    {
      hub: 'http://hub.test',
      arbeitsbereiche: { standard: { pfad: tmp, titel: 'Test' } },
      spielmodus: [join(tmp, `${name}.kid`)],
      pi_durable: {
        storage: join(dir, 'fyos.sqlite'),
        security: { token: 'test-token-test-token-test-token-00' },
        proactive: { enabled: true, pollSeconds: 3 },
        egress: { enabled: false },
        browser: { enabled: false },
        desktop: { enabled: false },
      },
    },
    {},
  );
  const aufrufe = [];
  const runner = new Runner(cfg, { basis: basis(aufrufe), hub: hub() });
  await runner.start();
  const root = (await runner.gespraeche()).find((g) => g.art === 'root');
  const kennung = String(root.id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  const schreibeBuch = (text) => writeFileSync(join(kontextDir, `${kennung}.md`), text);
  /** Ein Zug: Text senden und warten, bis die Anfrage `n` beantwortet und das Gespräch ruhig ist. */
  const zug = async (text, n) => {
    await runner.sende(root.id, text);
    await bis(() => aufrufe.length >= n, { was: `Anfrage ${n}` });
    await runner.harness.waitForIdle(CTX);
  };
  return { runner, root, aufrufe, schreibeBuch, zug };
}

test('Kontextbuch mit neuer Uhrzeit und neuem Inhalt: Systemkopf bleibt gleich, der neue Stand steht nach dem Verlauf', async () => {
  const { runner, aufrufe, schreibeBuch, zug } = await start('stand');
  try {
    schreibeBuch(buch('08:35', 'Offen: A.'));
    await zug(eingang('Frage eins', { licht: 'an' }, 1_000), 1);
    schreibeBuch(buch('09:50', 'Offen: A.\nBeschluss: NEUER-BESCHLUSS-XYZ.'));
    await zug(eingang('Frage zwei', { licht: 'aus' }, 2_000), 2);

    const eins = anfrage(aufrufe[0]);
    const zwei = anfrage(aufrufe[1]);
    // Der Systemkopf: gleiche Länge, gleicher Hash, und er trägt den ersten Stand.
    assert.equal(eins[0].role, 'system');
    assert.equal(zwei[0].role, 'system');
    assert.equal(zwei[0].content.length, eins[0].content.length);
    assert.equal(hash(zwei[0].content), hash(eins[0].content));
    assert.match(eins[0].content, /# Stand 25\.10\.2026, ~08 Uhr \(pi-durable-Runner\)/, 'die Uhrzeit steht auf die Stunde gerundet im Kopf');
    assert.doesNotMatch(zwei[0].content, /NEUER-BESCHLUSS-XYZ|~09/);
    // Der gemeinsame Präfix der beiden Anfragen reicht über den ganzen Kopf, die erste Nutzernachricht und die erste Antwort.
    assert.deepEqual(zwei.slice(0, eins.length), eins);
    // Der neue Stand steht hinter dem Verlauf: in der letzten Nachricht, nach der ersten Antwort.
    const stelle = zwei.findIndex((m) => alsText(m.content).includes('NEUER-BESCHLUSS-XYZ'));
    const ersteAntwort = zwei.findIndex((m) => m.role === 'assistant');
    assert.ok(stelle > ersteAntwort && ersteAntwort > 0, `Stand an Stelle ${stelle}, erste Antwort an ${ersteAntwort}`);
    assert.equal(stelle, zwei.length - 1);
    assert.match(alsText(zwei[stelle].content), /system_aktualisierung/);
    assert.match(alsText(zwei[stelle].content), /Frage zwei/, 'die Aktualisierung hängt an der neuen Nutzernachricht, nicht an einer alten');
    // Es gibt keine zweite Systemnachricht im Gespräch.
    assert.equal(zwei.filter((m) => m.role === 'system').length, 1);
  } finally {
    await runner.close().catch(() => {});
  }
});

test('nur die Uhrzeit neu geschrieben (gleiche Stunde): keine Aktualisierung, die Anfrage wächst nur um den Verlauf', async () => {
  const { runner, aufrufe, schreibeBuch, zug } = await start('uhrzeit');
  try {
    schreibeBuch(buch('08:35', 'Offen: A.'));
    await zug(eingang('Frage eins', { licht: 'an' }, 1_000), 1);
    schreibeBuch(buch('08:52', 'Offen: A.'));
    await zug(eingang('Frage zwei', { licht: 'an' }, 2_000), 2);
    const zwei = anfrage(aufrufe[1]);
    assert.ok(!JSON.stringify(zwei).includes('system_aktualisierung'), 'keine Aktualisierung im Gespräch');
    assert.deepEqual(zwei.slice(0, anfrage(aufrufe[0]).length), anfrage(aufrufe[0]));
  } finally {
    await runner.close().catch(() => {});
  }
});

test('standGerundet: nur die Standzeile, nur die Uhrzeit, auf die Stunde', () => {
  assert.equal(standGerundet('# Stand 25.10.2026, ~08:35 (pi-durable-Runner)\n\nUm 09:10 los.'), '# Stand 25.10.2026, ~08 Uhr (pi-durable-Runner)\n\nUm 09:10 los.');
  assert.equal(standGerundet('# Stand 26.10.2026 8:05\nx'), '# Stand 26.10.2026 08 Uhr\nx');
  assert.equal(standGerundet('Offen: 12:30 Termin\n# Stand 1.1.2026'), 'Offen: 12:30 Termin\n# Stand 1.1.2026');
  assert.equal(standGerundet(''), '');
  assert.equal(standGerundet(undefined), '');
});

test('veränderliche Abschnitte stehen hinten im Kopf; ein später dazukommender hängt hinten an', () => {
  const s = (key) => ({ key });
  const alle = ['persona-regelwerk', 'persona-regelwerk-durable', 'kontextbuch', 'repo_regeln', 'gedaechtnis', 'fyos-rolle', 'fyos-werkzeuge', 'fyos-zustand'];
  assert.deepEqual(ordneAbschnitte(alle.map(s)).map((x) => x.key), [
    'persona-regelwerk', 'persona-regelwerk-durable', 'fyos-rolle', 'fyos-werkzeuge', 'kontextbuch', 'gedaechtnis', 'fyos-zustand', 'repo_regeln',
  ]);
  // Ohne repo_regeln und mit: die Reihenfolge der übrigen bleibt, `repo_regeln` ist stets der letzte.
  const ohne = ordneAbschnitte(alle.filter((k) => k !== 'repo_regeln').map(s)).map((x) => x.key);
  const mit = ordneAbschnitte(alle.map(s)).map((x) => x.key);
  assert.deepEqual(mit.slice(0, -1), ohne);
  assert.equal(FLUECHTIGE_ABSCHNITTE.at(-1), 'repo_regeln');
});

// Ginnys Regelwerk (persona-system.md) liegt nur im Monorepo neben dem Runner.
const MIT_REGELWERK = { skip: !existsSync(new URL('../../persona-system.md', import.meta.url)) && 'nur im Monorepo' };
test('im echten Kopf stehen Regelwerk, Rolle und Werkzeugregeln vor Kontextbuch und Zustand', MIT_REGELWERK, async () => {
  const { runner, aufrufe, schreibeBuch, zug } = await start('reihenfolge');
  try {
    schreibeBuch(buch('08:35', 'Offen: A.'));
    await zug(eingang('Frage eins', { licht: 'an' }, 1_000), 1);
    const kopf = anfrage(aufrufe[0])[0].content;
    const pos = (muster) => kopf.search(muster);
    const regelwerk = pos(/Hinweis zum Lauf auf pi-durable/);
    const rolle = pos(/Du bist .*, der FYOS-Agent auf dem Gerät/);
    const werkzeuge = pos(/^Werkzeuge:$/m);
    const kontext = pos(/Dein Kontextbuch dieses Gesprächs/);
    assert.ok(regelwerk >= 0 && rolle > regelwerk && werkzeuge > rolle && kontext > werkzeuge, JSON.stringify({ regelwerk, rolle, werkzeuge, kontext }));
    if (process.env.FYOS_PROMPT_AUFBAU) aufbauAusgeben(aufrufe[0], kopf, { regelwerk, rolle, werkzeuge, kontext });
  } finally {
    await runner.close().catch(() => {});
  }
});

/** Der Aufbau einer echten Anfrage mit Zeichenpositionen (nur auf Wunsch). */
function aufbauAusgeben(a, kopf, p) {
  const zeilen = [`Systemkopf: ${kopf.length} Zeichen`];
  const sections = a.context.messages[0].sections ?? {};
  let von = 0;
  for (const [key, wert] of Object.entries(sections)) {
    const i = kopf.indexOf(wert, von);
    if (i >= 0) {
      zeilen.push(`  ${String(i).padStart(6)}–${String(i + wert.length).padStart(6)}  ${key} (${wert.length})`);
      von = i;
    }
  }
  const werkzeuge = a.context.messages[0].toolsAdded ?? [];
  zeilen.push(`Werkzeuge (Deklarationen, getrennt vom Text): ${werkzeuge.length} Stück, ${JSON.stringify(werkzeuge).length} Zeichen`);
  anfrage(a).slice(1).forEach((m, i) => zeilen.push(`Nachricht ${i + 1}: ${m.role}, ${alsText(m.content).length} Zeichen`));
  zeilen.push(`Marken im Kopf: ${JSON.stringify(p)}`);
  console.log(`\n--- Aufbau ---\n${zeilen.join('\n')}\n--------------`);
}
