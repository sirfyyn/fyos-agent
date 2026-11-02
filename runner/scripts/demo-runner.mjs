#!/usr/bin/env node
/**
 * demo-runner.mjs — ein Runner zum Ausprobieren der Clients, ohne Modell, Hub und Netz.
 *
 *   node scripts/demo-runner.mjs [--port 18460] [--token <token>] [--dauer <ordner>]
 *
 * Es ist der echte Runner (pi-durable, SQLite, REST und SSE, Warteschlange, Freigaben, Läufe), nur das Modell ist ein
 * Faux-Modell mit festen Antworten und der Hub ist eine Attrappe. Damit sehen alle Clients (Web, Mac, Linux, iPhone)
 * dasselbe wie am echten Runner, ohne dass etwas auf Hauptserver oder bei Hausmodell passiert:
 *
 *   - Alle ~20 s kommt von selbst ein Eingang (Zeitplan „Morgen-Lage“, Matrix von Besitzer) und der Agent arbeitet: Werkzeug,
 *     Antwort, fertig. Das ist der Strom der autonomen Arbeit (`/api/strom`).
 *   - Eine offene Freigabe für einen zerstörenden Befehl wartet auf eine Entscheidung (`/api/freigaben`).
 *   - Ein Lauf mit Phasen wartet an einer Freigabe (`/api/laeufe`).
 *   - Jede Nachricht, die ein Client schickt, wird kurz beantwortet; „freigabe“ im Text legt eine neue Freigabe an,
 *     „lauf“ einen neuen Lauf.
 *
 * Nur zum Entwickeln. Der Token steht auf der Konsole; der Server lauscht auf 127.0.0.1.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as CTX } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { konfigurationLaden } from '../src/config.js';
import { Freigaben, neueFreigabe } from '../src/documents.js';
import { Ingress } from '../src/ingress.js';
import { Runner } from '../src/runner.js';
import { erstelleServer } from '../src/server.js';

const arg = (name, vorgabe) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : vorgabe;
};
const PORT = Number(arg('--port', process.env.DEMO_PORT ?? 18460));
const TOKEN = arg('--token', process.env.DEMO_TOKEN ?? 'demo-token-demo-token-demo-token-0000');
const DIR = arg('--dauer', null) ?? mkdtempSync(join(tmpdir(), 'fyos-demo-'));

const cfg = konfigurationLaden(
  {
    hub: 'http://hub.demo.invalid',
    agent: 'persona',
    arbeitsbereiche: { standard: { pfad: DIR, titel: 'Demo' }, projekt: { pfad: DIR, titel: 'Projekt (Demo)' } },
    spielmodus: [],
    pi_durable: {
      host: '127.0.0.1',
      port: PORT,
      storage: join(DIR, 'fyos.sqlite'),
      device: { id: 'demo', name: 'Demo-Gerät', kind: 'mac' },
      security: { token: TOKEN },
      proactive: { enabled: true, pollSeconds: 3 },
      egress: { enabled: false },
      browser: { enabled: false },
      desktop: { enabled: false },
    },
  },
  {},
);

// --- Faux-Modell: antwortet je nach Text, ruft ein harmloses Werkzeug oder bittet um eine Freigabe -----------------------
const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: [{ id: 'hausmodell' }, { id: 'hausmodell-max' }] });
const models = createModels();
models.setProvider(faux.provider);

const textVon = (m) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? ''));
let zaehler = 0;
function antwort(context) {
  const letzte = context.messages.at(-1);
  const nutzer = [...context.messages].reverse().find((m) => m.role === 'user');
  const frage = textVon(nutzer).toLowerCase();
  if (letzte?.role === 'toolResult') {
    if (frage.includes('freigabe')) return fauxAssistantMessage('Ich warte auf deine Freigabe, dann mache ich weiter.');
    if (frage.includes('morgen-lage')) return fauxAssistantMessage('Guten Morgen. Alle 38 Pods laufen, Hausmodell ist ruhig, nichts wartet auf dich.');
    return fauxAssistantMessage('Erledigt. Nichts Auffälliges im geteilten Zustand.');
  }
  if (frage.includes('freigabe')) {
    return fauxAssistantMessage(
      fauxToolCall('freigabe_bitten', {
        aktion: `Branch alt-${++zaehler} löschen`,
        werkzeug: 'bash',
        befehl: `git branch -D alt-${zaehler}`,
        risiko: 'high',
        kontext: 'Der Branch ist gemerged und 14 Tage alt.',
        zerstoererisch: true,
      }),
    );
  }
  if (frage.includes('morgen-lage') || frage.includes('cluster') || frage.includes('zustand')) {
    return fauxAssistantMessage(fauxToolCall('zustand_lesen', {}));
  }
  return fauxAssistantMessage(`Demo-Antwort ${++zaehler}: Ich habe „${textVon(nutzer).slice(0, 80)}“ gelesen. Das Modell ist ein Faux.`);
}
const nachfuellen = () => {
  while (faux.getPendingResponseCount() < 200) faux.appendResponses([antwort]);
};
nachfuellen();
setInterval(nachfuellen, 5000).unref();

// --- Runner, Attrappen-Hub, Eingang -------------------------------------------------------------------------------------
const hub = {
  aufrufen: async () => ({ ok: true, result: {} }),
  melden: async () => ({ ok: true }),
  bereicheMelden: async () => ({ ok: true }),
  gesundheit: async () => ({ ok: true, daten: { demo: true } }),
  suchen: async () => [],
  schema: async () => ({}),
  eingangLesen: async (nach) => {
    await new Promise((r) => setTimeout(r, 1500));
    return { eintraege: [], letzte: nach };
  },
};
const runner = new Runner(cfg, { models, hub });
await runner.start();
const ingress = new Ingress({ cfg, runner, hub, spielmodus: runner.spielmodus, tor: { offen: true } });
await ingress.start();

// Eine offene Freigabe und ein Lauf, der an einer Freigabe wartet.
const wurzel = runner.root.id;
await runner.harness.commit(async (tx) => {
  const doc = await tx.doc(Freigaben);
  if (!Object.keys(doc.eintraege).length) {
    doc.eintraege['fr-demo-1'] = neueFreigabe({
      id: 'fr-demo-1',
      conversationId: wurzel,
      aktion: 'Branch alt-experiment löschen',
      risiko: 'high',
      kontext: 'Der Branch ist gemerged und 14 Tage alt.',
      zerstoererisch: true,
      werkzeug: 'bash',
      befehl: 'git branch -D alt-experiment',
    });
  }
}, CTX);
if (!(await runner.laeufe()).length) {
  await runner.neuerLauf(wurzel, { titel: 'Cluster prüfen', auftrag: 'Prüfe den Cluster und melde nur Auffälligkeiten.', freigabe: true });
}

// Autonome Arbeit: alle ~20 s ein Eingang, abwechselnd Zeitplan und Matrix von Besitzer.
let tick = 0;
const einwerfen = async () => {
  tick += 1;
  const matrix = tick % 2 === 0;
  await ingress.einreihen({
    id: `demo:${Date.now()}:${tick}`,
    quelle: matrix ? 'matrix' : 'zeitplan',
    von: matrix ? '@max:example.net' : 'zeitplan',
    klasse: matrix ? 'max' : 'hintergrund',
    bezug: matrix ? 'chat-max' : `takt-morgen-${tick}`,
    text: matrix ? 'Wie steht der Cluster?' : 'Takt „Morgen-Lage“: Fasse kurz zusammen, was sich über Nacht getan hat.',
  });
};
setTimeout(einwerfen, 3000).unref();
setInterval(einwerfen, 20_000).unref();

const server = erstelleServer({ runner, cfg });
await new Promise((fertig, scheitern) => {
  server.once('error', scheitern);
  server.listen(PORT, '127.0.0.1', fertig);
});
console.log(`[demo] Runner auf http://127.0.0.1:${PORT}  (Gerät demo, Daten ${DIR})`);
console.log(`[demo] Token: ${TOKEN}`);
console.log(`[demo] Web-Client: http://127.0.0.1:${PORT}/?token=${TOKEN}`);
console.log('[demo] „freigabe“ oder „lauf“ in einer Nachricht legt eine neue Freigabe oder einen neuen Lauf an.');

const ende = async () => {
  await ingress.stop().catch(() => {});
  await new Promise((r) => server.close(r));
  await runner.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', ende);
process.on('SIGTERM', ende);
