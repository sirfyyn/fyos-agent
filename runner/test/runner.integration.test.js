/**
 * Integrationstest: der echte Runner (pi-durable + SQLite) mit einem Faux-Modell und einem
 * simulierten Hub. Geprüft wird, was den RPC-Runner ersetzen soll und nicht aus Einzelteilen
 * folgt: Eingang → Warteschlange → Gespräch, Spielmodus, Hintergrund-Tor, Vorfahrt,
 * Neustart ohne Verlust, Zugang zum Server und der Strom der autonomen Arbeit.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { konfigurationLaden } from '../src/config.js';
import { Laufzeit, Wartend } from '../src/documents.js';
import { Ingress } from '../src/ingress.js';
import { Runner } from '../src/runner.js';
import { erstelleServer } from '../src/server.js';
import { Spielmodus } from '../src/spielmodus.js';

const CTX = BACKGROUND_CONTEXT;
const warte = (ms) => new Promise((r) => setTimeout(r, ms));

async function bis(fn, { ms = 15000, schritt = 100, was = 'Bedingung' } = {}) {
  const ende = Date.now() + ms;
  let letzter;
  while (Date.now() < ende) {
    try {
      const wert = await fn();
      if (wert) return wert;
    } catch (fehler) {
      letzter = fehler;
    }
    await warte(schritt);
  }
  throw new Error(`Zeit abgelaufen: ${was}${letzter ? ` (${letzter.message})` : ''}`);
}

const tmp = mkdtempSync(join(tmpdir(), 'pidurable-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function baue(name, extra = {}) {
  const dir = join(tmp, name);
  const cfg = konfigurationLaden(
    {
      hub: 'http://hub.test',
      agent: 'persona',
      arbeitsbereiche: { standard: { pfad: tmp, titel: 'Test' } },
      pi_durable: {
        storage: join(dir, 'fyos.sqlite'),
        security: { token: 'test-token-test-token-test-token-00' },
        proactive: { enabled: true, pollSeconds: 3 },
        egress: { enabled: false },
        browser: { enabled: false },
        desktop: { enabled: false },
        ...extra,
      },
    },
    {},
  );
  const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: [{ id: 'hausmodell' }, { id: 'hausmodell-max' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  return { cfg, faux, models };
}

/** Ein Hub, der vorgegebene Eingänge genau einmal liefert und sonst kurz wartet. */
function fakeHub(eintraege) {
  let offen = [...eintraege];
  return {
    aufrufen: async () => ({ ok: true, result: {} }),
    melden: async () => ({ ok: true }),
    bereicheMelden: async () => ({ ok: true }),
    gesundheit: async () => ({ ok: true }),
    suchen: async () => [],
    schema: async () => ({}),
    async eingangLesen(nach) {
      if (offen.length) {
        const e = offen;
        offen = [];
        return { eintraege: e, letzte: e.at(-1).id };
      }
      await warte(150);
      return { eintraege: [], letzte: nach };
    },
  };
}

const assistentenTexte = (ansicht) =>
  ansicht.entries
    .flatMap((e) => e.model ?? [])
    .filter((m) => m?.role === 'assistant')
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b?.type === 'text')
    .map((b) => b.text);

/** Faux-Antwort, die den Text der letzten Nutzernachricht notiert und mit „ok:<text>“ antwortet. */
function mitProtokoll(faux, anzahl) {
  const gesehen = [];
  const schritte = Array.from({ length: anzahl }, () => (context) => {
    const letzte = [...context.messages].reverse().find((m) => m.role === 'user');
    const text = JSON.stringify(letzte?.content ?? '');
    gesehen.push(text);
    const kurz = /hg\d|max\d/.exec(text)?.[0] ?? 'x';
    return fauxAssistantMessage(`ok:${kurz}`);
  });
  faux.setResponses(schritte);
  return gesehen;
}

test('Runner startet, Hauptgespräch besteht, Antwort kommt an', async () => {
  const { cfg, faux, models } = baue('basis');
  faux.setResponses([fauxAssistantMessage('Moin Besitzer')]);
  const runner = new Runner(cfg, { models, hub: fakeHub([]) });
  await runner.start();
  try {
    const liste = await runner.gespraeche();
    assert.equal(liste.filter((g) => g.art === 'root').length, 1);
    const root = liste.find((g) => g.art === 'root');
    await runner.sende(root.id, 'Hallo');
    await bis(async () => assistentenTexte(await runner.ansicht(root.id)).includes('Moin Besitzer'), { was: 'Antwort' });
  } finally {
    await runner.close().catch(() => {});
  }
});

test('Spielmodus hält Eingänge zurück, danach Besitzer zuerst, nichts geht verloren', async () => {
  const { cfg, faux, models } = baue('spiel');
  const gesehen = mitProtokoll(faux, 4);
  const hub = fakeHub([
    { id: '1-0', text: 'hg1', klasse: 'hintergrund', quelle: 'itsm' },
    { id: '2-0', text: 'max1', klasse: 'max', quelle: 'web' },
  ]);
  const runner = new Runner(cfg, { models, hub });
  await runner.start();
  let spiel = true;
  const spielmodus = new Spielmodus(['/x/spielmodus.kid'], { existiert: () => spiel, lesen: () => { throw new Error('x'); }, log: () => {} });
  const ingress = new Ingress({ cfg, runner, hub, spielmodus, tor: { offen: true } });
  await ingress.start();
  try {
    const wartend = await bis(
      async () => {
        const w = await runner.harness.snapshot(Wartend, CTX);
        return w.eintraege.length === 2 ? w : null;
      },
      { was: 'zwei angenommene Eingänge' },
    );
    assert.deepEqual(wartend.eintraege.map((e) => e.stromId).sort(), ['1-0', '2-0']);
    // Der Zeiger ist schon weitergewandert: angenommen heißt dauerhaft angenommen.
    assert.equal((await runner.harness.snapshot(Laufzeit, CTX)).letzteEingang, '2-0');
    await warte(2500);
    assert.equal(gesehen.length, 0, 'im Spielmodus darf nichts an den Agenten gehen');

    spiel = false;
    ingress.anstossen();
    await bis(() => gesehen.length === 2, { was: 'beide Eingänge verarbeitet' });
    assert.match(gesehen[0], /max1/, 'Besitzer kommt vor Hintergrundarbeit');
    assert.match(gesehen[1], /hg1/);
    await bis(async () => (await runner.harness.snapshot(Wartend, CTX)).eintraege.length === 0, { was: 'Warteschlange leer' });
  } finally {
    await ingress.stop();
    await runner.close().catch(() => {});
  }
});

test('geschlossenes Tor lässt nur Besitzer durch, ein Neustart verliert keinen Eingang', async () => {
  const { cfg, faux, models } = baue('tor');
  const gesehen = mitProtokoll(faux, 4);
  const tor = { offen: false };
  const hub = fakeHub([
    { id: '1-0', text: 'hg1', klasse: 'hintergrund', quelle: 'itsm' },
    { id: '2-0', text: 'max1', klasse: 'max', quelle: 'web' },
  ]);
  let runner = new Runner(cfg, { models, hub });
  await runner.start();
  let ingress = new Ingress({ cfg, runner, hub, spielmodus: new Spielmodus([]), tor });
  await ingress.start();
  await bis(() => gesehen.length === 1, { was: 'Besitzer durchgelassen' });
  assert.match(gesehen[0], /max1/);
  await warte(2500);
  assert.equal(gesehen.length, 1, 'Hintergrund bleibt hinter dem Tor');
  assert.equal((await runner.harness.snapshot(Wartend, CTX)).eintraege.length, 1);

  // Neustart mit derselben Datei: der wartende Eintrag ist noch da und wird nachgeholt.
  await ingress.stop();
  await runner.close().catch(() => {});
  runner = new Runner(cfg, { models, hub: fakeHub([]) });
  await runner.start();
  try {
    assert.equal((await runner.harness.snapshot(Wartend, CTX)).eintraege.length, 1);
    tor.offen = true;
    ingress = new Ingress({ cfg, runner, hub: fakeHub([]), spielmodus: new Spielmodus([]), tor });
    await ingress.start();
    await bis(() => gesehen.length === 2, { was: 'wartender Eintrag nach Neustart verarbeitet' });
    assert.match(gesehen[1], /hg1/);
  } finally {
    await ingress.stop();
    await runner.close().catch(() => {});
  }
});

test('Server: Token Pflicht, fremder Ursprung ohne CORS, Strom der autonomen Arbeit', async () => {
  const { cfg, faux, models } = baue('server');
  faux.setResponses([fauxAssistantMessage('autonom erledigt')]);
  const runner = new Runner(cfg, { models, hub: fakeHub([]) });
  await runner.start();
  const server = erstelleServer({ runner, cfg });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const basis = `http://127.0.0.1:${server.address().port}`;
  const token = cfg.pi_durable.security.token;
  try {
    assert.equal((await fetch(`${basis}/api/health`)).status, 401);
    assert.equal((await fetch(`${basis}/api/health`, { headers: { Authorization: 'Bearer falsch' } })).status, 401);
    const ok = await fetch(`${basis}/api/health`, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://boese.example' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), null, 'kein CORS für fremde Ursprünge');
    const vorab = await fetch(`${basis}/api/health`, { method: 'OPTIONS', headers: { Origin: 'https://boese.example' } });
    assert.equal(vorab.status, 403);

    // Strom öffnen (Voreinstellung jedes Clients), dann arbeitet der Agent von selbst weiter.
    const strom = await fetch(`${basis}/api/strom`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(strom.status, 200);
    const leser = strom.body.getReader();
    const dek = new TextDecoder();
    let puffer = '';
    const ereignisse = [];
    const lesen = (async () => {
      for (;;) {
        const { done, value } = await leser.read();
        if (done) return;
        puffer += dek.decode(value, { stream: true });
        let i;
        while ((i = puffer.indexOf('\n\n')) >= 0) {
          const block = puffer.slice(0, i);
          puffer = puffer.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const daten = /^data: (.+)$/m.exec(block)?.[1];
          if (ev && daten) ereignisse.push([ev, JSON.parse(daten)]);
        }
      }
    })();
    await bis(() => ereignisse.some(([e]) => e === 'hallo'), { was: 'hallo' });
    const root = (await runner.gespraeche()).find((g) => g.art === 'root');
    assert.ok(ereignisse.find(([e]) => e === 'hallo')[1].gespraeche.some((g) => g.id === root.id));

    // Dieselben Gespräche über HTTP: die Adresse trägt die ID als Text, pi-durable kennt Zahlen.
    const auth = { Authorization: `Bearer ${token}` };
    const einzel = await (await fetch(`${basis}/api/gespraech/${root.id}`, { headers: auth })).json();
    assert.equal(einzel.ok, true, einzel.fehler);
    assert.equal(einzel.meta.art, 'root');
    const ansicht = await (await fetch(`${basis}/api/gespraech/${root.id}/ansicht`, { headers: auth })).json();
    assert.equal(ansicht.meta?.art, 'root');
    const ev = await fetch(`${basis}/api/gespraech/${root.id}/ereignisse`, { headers: auth });
    const evLeser = ev.body.getReader();
    let evText = '';
    const evEnde = Date.now() + 5000;
    while (!evText.includes('event: snapshot') && Date.now() < evEnde) {
      const { done, value } = await Promise.race([evLeser.read(), warte(1000).then(() => ({ done: false, value: undefined }))]);
      if (done) break;
      if (value) evText += new TextDecoder().decode(value);
    }
    await evLeser.cancel().catch(() => {});
    assert.match(evText, /event: snapshot/, 'der Gesprächsstrom liefert einen Snapshot');

    await runner.sende(root.id, 'mach etwas', { art: 'folgen' });
    const zeile = await bis(() => ereignisse.find(([e, d]) => e === 'zeile' && d.typ === 'sagt'), { was: 'Zeile im Strom' });
    assert.equal(zeile[1].text, 'autonom erledigt');
    assert.equal(zeile[1].gespraech, root.id);
    await leser.cancel().catch(() => {});
    await lesen.catch(() => {});
  } finally {
    await new Promise((r) => server.close(r));
    await runner.close().catch(() => {});
  }
});
