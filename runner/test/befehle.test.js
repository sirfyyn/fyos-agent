/**
 * Slash-Befehle im Runner (src/befehle.js): Parser, Unbekanntes geht ans Modell, jeder Befehl,
 * Absicherungen für Ginnys Hauptgespräch, Skills und Vorlagen, Liste (GET /api/befehle).
 * Echter Runner (pi-durable + SQLite) mit Faux-Modell und simuliertem Hub.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { argumenteTeilen, befehlParsen, platzhalterErsetzen } from '../src/befehle.js';
import { konfigurationLaden } from '../src/config.js';
import { Ingress } from '../src/ingress.js';
import { Runner } from '../src/runner.js';
import { erstelleServer } from '../src/server.js';
import { Spielmodus } from '../src/spielmodus.js';

const warte = (ms) => new Promise((r) => setTimeout(r, ms));

async function bis(fn, { ms = 15000, schritt = 100, was = 'Bedingung' } = {}) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    const wert = await fn().catch(() => null);
    if (wert) return wert;
    await warte(schritt);
  }
  throw new Error(`Zeit abgelaufen: ${was}`);
}

const tmp = mkdtempSync(join(tmpdir(), 'befehle-test-'));
const arbeit = join(tmp, 'arbeit');
mkdirSync(join(arbeit, '.agents', 'skills', 'probe'), { recursive: true });
mkdirSync(join(arbeit, '.pi', 'prompts'), { recursive: true });
writeFileSync(
  join(arbeit, '.agents', 'skills', 'probe', 'SKILL.md'),
  '---\nname: probe\ndescription: Eine Probe\n---\n# Probe\nTu das Richtige.\n',
);
writeFileSync(
  join(arbeit, '.pi', 'prompts', 'gruss.md'),
  '---\ndescription: Grüßt jemanden\nargument-hint: "<Name>"\n---\nGrüße $1 freundlich. Rest: $ARGUMENTS\n',
);
writeFileSync(join(arbeit, '.pi', 'prompts', 'neu.md'), 'Vorlage, die den Befehl /neu nicht ersetzen darf\n');
process.env.PI_CODING_AGENT_DIR = join(tmp, 'agentdir');
after(() => rmSync(tmp, { recursive: true, force: true }));

function baue(name) {
  const dir = join(tmp, name);
  const cfg = konfigurationLaden(
    {
      hub: 'http://hub.test',
      agent: 'persona',
      arbeitsbereiche: { standard: { pfad: arbeit, titel: 'Test' } },
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
  const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: [{ id: 'hausmodell' }, { id: 'hausmodell-max' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  return { cfg, faux, models };
}

function fakeHub(eintraege = []) {
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

/** Faux-Modell, das notiert, was als letzte Nutzernachricht ankam. */
function mitProtokoll(faux, anzahl = 6) {
  const gesehen = [];
  faux.setResponses(
    Array.from({ length: anzahl }, () => (context) => {
      const letzte = [...context.messages].reverse().find((m) => m.role === 'user');
      gesehen.push(JSON.stringify(letzte?.content ?? ''));
      return fauxAssistantMessage('ok');
    }),
  );
  return gesehen;
}

async function mitRunner(name, fn, { vorbereiten } = {}) {
  const b = baue(name);
  const gesehen = mitProtokoll(b.faux);
  vorbereiten?.(b);
  const runner = new Runner(b.cfg, { models: b.models, hub: fakeHub() });
  await runner.start();
  try {
    await fn({ runner, gesehen, ...b });
  } finally {
    await runner.close().catch(() => {});
  }
}

const befehlsEintraege = async (runner, id) => (await runner.ansicht(id)).entries.filter((e) => e.kind === 'fyos.befehl');

// --- Parser ---------------------------------------------------------------------------------

test('Parser erkennt Name und Rest, lehnt Unsinn ab', () => {
  assert.deepEqual(befehlParsen('/name Mein Titel'), { name: 'name', rest: 'Mein Titel' });
  assert.deepEqual(befehlParsen('  /skill:probe  hallo  '), { name: 'skill:probe', rest: 'hallo' });
  assert.deepEqual(befehlParsen('/hilfe'), { name: 'hilfe', rest: '' });
  assert.equal(befehlParsen('hallo /name'), null);
  assert.equal(befehlParsen('/'), null);
  assert.equal(befehlParsen('/../etc/passwd'), null);
  assert.equal(befehlParsen('/skill:../x'), null);
  assert.equal(befehlParsen('//kommentar'), null);
  assert.equal(befehlParsen('/9eins'), null);
});

test('Argumente und Platzhalter wie in Pi', () => {
  assert.deepEqual(argumenteTeilen('a "b c" \'d e\' ""'), ['a', 'b c', 'd e', '']);
  const a = ['x', 'y', 'z'];
  assert.equal(platzhalterErsetzen('$1-$2 $@ ${3:-nix} ${4:-nix} ${@:2}', a), 'x-y x y z z nix y z');
  assert.equal(platzhalterErsetzen('$ARGUMENTS|$9', a), 'x y z|');
});

// --- Unbekanntes geht ans Modell ----------------------------------------------------------------

test('unbekanntes „/…“ geht als normaler Text ans Modell, ohne Befehlseintrag', async () => {
  await mitRunner('unbekannt', async ({ runner, gesehen }) => {
    const root = runner.root.id;
    for (const t of ['/gibtsnicht bitte', '/skill:gibtsnicht', '/pfad/zur/datei lesen', '// zwei']) {
      gesehen.length = 0;
      const r = await runner.sende(root, t);
      assert.ok(r.id !== null && !r.befehl, t);
      await bis(async () => gesehen.length === 1, { was: `Modell sieht ${t}` });
      assert.match(gesehen[0], new RegExp(t.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&').slice(0, 14)));
      await warte(300);
    }
    assert.equal((await befehlsEintraege(runner, root)).length, 0);
  });
});

// --- Befehle ---------------------------------------------------------------------------------

test('/hilfe listet Befehle, Skills und Vorlagen; Terminal-Befehle stehen mit Grund da', async () => {
  await mitRunner('hilfe', async ({ runner, gesehen }) => {
    const r = await runner.sende(runner.root.id, '/hilfe');
    assert.equal(r.id, null);
    assert.equal(r.befehl.name, 'hilfe');
    assert.match(r.befehl.text, /\/neu/);
    assert.match(r.befehl.text, /\/skill:probe/);
    assert.match(r.befehl.text, /\/gruss <Name>/);
    assert.match(r.befehl.text, /\/settings/);
    await warte(200);
    assert.equal(gesehen.length, 0, 'Befehle erreichen das Modell nicht');
    const e = await befehlsEintraege(runner, runner.root.id);
    assert.equal(e.length, 1);
    assert.equal(e[0].data.name, 'hilfe');
  });
});

test('/name, /sitzung, /baum und /laden auf einem Gespräch von Besitzer', async () => {
  await mitRunner('name', async ({ runner }) => {
    const g = await runner.neuesGespraech({ titel: 'Alt' });
    const r1 = await runner.sende(g.id, '/name Neuer Titel');
    assert.equal(r1.befehl.ok, true);
    assert.equal((await runner.gespraech(g.id)).meta.titel, 'Neuer Titel');
    assert.match((await runner.sende(g.id, '/name')).befehl.text, /Neuer Titel/);

    const s = (await runner.sende(g.id, '/sitzung')).befehl.text;
    assert.match(s, /Neuer Titel/);
    assert.match(s, /Modell: hausmodell\/hausmodell/);
    assert.match(s, /Kosten: keine/);

    assert.match((await runner.sende(g.id, '/baum')).befehl.text, /keiner/);

    const liste = (await runner.sende(g.id, '/laden')).befehl;
    assert.match(liste.text, /Hauptgespräch/);
    const wechsel = (await runner.sende(g.id, `/laden ${runner.root.id}`)).befehl;
    assert.deepEqual(wechsel.aktion, { art: 'fokus', gespraech: runner.root.id });
    assert.equal((await runner.sende(g.id, '/laden 9999')).befehl.ok, false);
  });
});

test('/modell zeigt, wechselt und weist Unbekanntes ab', async () => {
  await mitRunner('modell', async ({ runner }) => {
    const g = await runner.neuesGespraech({ titel: 'M' });
    const liste = (await runner.sende(g.id, '/modell')).befehl.text;
    assert.match(liste, /hausmodell\/hausmodell-max/);
    const ok = (await runner.sende(g.id, '/modell hausmodell-max')).befehl;
    assert.equal(ok.ok, true);
    assert.equal((await runner.gespraech(g.id)).meta.modell, 'hausmodell-max');
    assert.equal((await runner.gespraech(g.id)).agent.model.modelId, 'hausmodell-max');
    assert.equal((await runner.sende(g.id, '/modell gpt-9')).befehl.ok, false);
    assert.equal((await runner.gespraech(g.id)).meta.modell, 'hausmodell-max');
    assert.equal((await runner.sende(g.id, '/model standard')).befehl.ok, true);
    assert.equal((await runner.gespraech(g.id)).meta.modell, null);
  });
});

test('/neu beginnt einen neuen Kontext, der Verlauf bleibt sichtbar', async () => {
  await mitRunner('neu', async ({ runner, gesehen }) => {
    const g = await runner.neuesGespraech({ titel: 'N' });
    await runner.sende(g.id, 'erste Frage');
    await bis(async () => gesehen.length === 1, { was: 'erste Antwort' });
    await bis(async () => (await runner.ansicht(g.id)).entries.some((e) => (e.model ?? []).some((m) => m.role === 'assistant')), { was: 'Antwort im Verlauf' });
    const vorher = (await runner.ansicht(g.id)).messages;
    assert.ok(vorher >= 2);
    const r = await runner.sende(g.id, '/neu');
    assert.equal(r.befehl.ok, true);
    await bis(async () => (await runner.ansicht(g.id)).messages === 0, { was: 'Kontext leer' });
    assert.equal((await befehlsEintraege(runner, g.id)).length, 1, 'Befehlseintrag nach dem Reset');
  });
});

test('Ginnys Hauptgespräch: verändernde Befehle brauchen --ja, /verdichten ist dort gesperrt', async () => {
  await mitRunner('persona', async ({ runner }) => {
    const root = runner.root.id;
    const neu = (await runner.sende(root, '/neu')).befehl;
    assert.equal(neu.ok, false);
    assert.match(neu.text, /Ginnys Hauptgespräch/);
    assert.match(neu.text, /--ja/);

    const m = (await runner.sende(root, '/modell hausmodell-max')).befehl;
    assert.equal(m.ok, false);
    assert.equal((await runner.gespraech(root)).meta.modell ?? null, null, 'Modell blieb unberührt');
    // Nur ansehen braucht keine Bestätigung.
    assert.equal((await runner.sende(root, '/modell')).befehl.ok, true);

    const v = (await runner.sende(root, '/verdichten --ja')).befehl;
    assert.equal(v.ok, false);
    assert.match(v.text, /verdichtet der Runner selbst/);

    const mit = (await runner.sende(root, '/modell hausmodell-max --ja')).befehl;
    assert.equal(mit.ok, true);
    assert.equal((await runner.gespraech(root)).meta.modell, 'hausmodell-max');
    assert.equal((await runner.befehle.zustand()).abgelehnt >= 3, true);
  });
});

test('/verdichten auf einem Gespräch von Besitzer startet eine Aufgabe', async () => {
  await mitRunner('verdichten', async ({ runner }) => {
    const g = await runner.neuesGespraech({ titel: 'V' });
    const r = (await runner.sende(g.id, '/verdichten Nur das Wichtige')).befehl;
    assert.equal(r.name, 'verdichten');
    assert.match(r.text, /Verdichtung gestartet \(Aufgabe/);
  });
});

test('/fork und /klon zweigen ab, /baum zeigt Ursprung und Zweige', async () => {
  await mitRunner('fork', async ({ runner, gesehen }) => {
    const g = await runner.neuesGespraech({ titel: 'F' });
    await runner.sende(g.id, 'Frage eins');
    await bis(async () => gesehen.length === 1, { was: 'Antwort' });
    await bis(async () => (await runner.ansicht(g.id)).entries.some((e) => e.kind === 'pi.assistant'), { was: 'Antwort abgelegt' });
    const liste = (await runner.sende(g.id, '/fork')).befehl.text;
    const nr = /^\s+(\d+) · Frage eins/m.exec(liste)?.[1];
    assert.ok(nr, liste);
    const bad = (await runner.sende(g.id, '/fork 99999')).befehl;
    assert.equal(bad.ok, false);

    const zweig = (await runner.sende(g.id, `/fork ${nr}`)).befehl;
    assert.equal(zweig.ok, true);
    assert.equal(zweig.aktion.art, 'fokus');
    const klon = (await runner.sende(g.id, '/clone')).befehl;
    assert.equal(klon.aktion.art, 'fokus');

    const baum = (await runner.sende(g.id, '/baum')).befehl.text;
    assert.equal((baum.match(/Nr\. \d+/g) ?? []).length, 2, baum);
    const kind = await runner.gespraech(zweig.aktion.gespraech);
    assert.ok(kind);
    assert.match((await runner.sende(zweig.aktion.gespraech, '/baum')).befehl.text, new RegExp(`Ursprung: Nr\\. ${g.id}`));
  });
});

test('/export schreibt Markdown unter den Arbeitsbereich und meldet den Pfad', async () => {
  await mitRunner('export', async ({ runner, gesehen }) => {
    const g = await runner.neuesGespraech({ titel: 'Export' });
    await runner.sende(g.id, 'Hallo Welt');
    await bis(async () => gesehen.length === 1, { was: 'Antwort' });
    await bis(async () => (await runner.ansicht(g.id)).entries.some((e) => e.kind === 'pi.assistant'), { was: 'Antwort abgelegt' });
    const r = (await runner.sende(g.id, '/export bericht.md')).befehl;
    assert.equal(r.ok, true);
    assert.equal(r.aktion.pfad, join(arbeit, '.fyos-export', 'bericht.md'));
    const inhalt = readFileSync(r.aktion.pfad, 'utf8');
    assert.match(inhalt, /# Export/);
    assert.match(inhalt, /Hallo Welt/);
    // Kein Ausbruch aus dem Ordner, keine fremde Endung.
    for (const schlecht of ['../x.md', 'a/b.md', 'x.sh', '.md']) {
      assert.equal((await runner.sende(g.id, `/export ${schlecht}`)).befehl.ok, false, schlecht);
    }
    assert.equal(existsSync(join(arbeit, 'x.md')), false);
    const auto = (await runner.sende(g.id, '/export')).befehl;
    assert.match(auto.aktion.pfad, /gespraech-\d+-.*\.md$/);
  });
});

test('Brücken: /live, /ruhe, /stopp; Terminal-Befehle sagen, warum es sie hier nicht gibt', async () => {
  await mitRunner('bruecken', async ({ runner }) => {
    const g = await runner.neuesGespraech({ titel: 'B' });
    assert.deepEqual((await runner.sende(g.id, '/live aus')).befehl.aktion, { art: 'live', wert: 'aus' });
    assert.deepEqual((await runner.sende(g.id, '/live')).befehl.aktion, { art: 'live', wert: 'umschalten' });
    const ruhe = (await runner.sende(g.id, '/ruhe an')).befehl;
    assert.equal(ruhe.ok, false);
    assert.match(ruhe.text, /feat\/ruhe-schalter/);
    runner.befehle.bruecken.ruhe = async (wert) => ({ text: `Ruhe ${wert}` });
    assert.equal((await runner.sende(g.id, '/ruhe an')).befehl.text, 'Ruhe an');
    assert.equal((await runner.sende(g.id, '/stopp')).befehl.ok, true);
    assert.equal((await runner.sende(g.id, '/abbrechen')).befehl.ok, true);
    for (const t of ['/login', '/logout', '/settings', '/quit', '/share']) {
      const b = (await runner.sende(g.id, t)).befehl;
      assert.equal(b.ok, false, t);
      assert.match(b.text, /gibt es im Runner nicht/);
    }
  });
});

test('Läufe-Kinder: verändernde Befehle werden abgewiesen', async () => {
  await mitRunner('lauf', async ({ runner }) => {
    const l = await runner.neuerLauf(runner.root.id, { titel: 'T', auftrag: 'Tu etwas' });
    const kind = (await bis(async () => (await runner.lauf(l.id))?.kindId, { was: 'Kindgespräch' }));
    const r = (await runner.sende(kind, '/neu')).befehl;
    assert.equal(r.ok, false);
    assert.match(r.text, /Lauf/);
  });
});

// --- Skills und Vorlagen -----------------------------------------------------------------------

test('/skill:name und /vorlage gehen als ausgebauter Text ans Modell, nicht als Befehl', async () => {
  await mitRunner('vorlagen', async ({ runner, gesehen }) => {
    const g = await runner.neuesGespraech({ titel: 'S' });
    const s = await runner.sende(g.id, '/skill:probe Bitte jetzt');
    assert.ok(s.id !== null && !s.befehl);
    await bis(async () => gesehen.length === 1, { was: 'Skill beim Modell' });
    assert.match(gesehen[0], /<skill name=\\"probe\\"/);
    assert.match(gesehen[0], /Tu das Richtige/);
    assert.match(gesehen[0], /Bitte jetzt/);
    assert.doesNotMatch(gesehen[0], /description: Eine Probe/, 'Kopf ist abgeschnitten');

    await bis(async () => (await runner.ansicht(g.id)).entries.some((e) => e.kind === 'pi.assistant'), { was: 'Antwort' });
    gesehen.length = 0;
    await runner.sende(g.id, '/gruss "Frau Müller" und Herr Meier');
    await bis(async () => gesehen.length === 1, { was: 'Vorlage beim Modell' });
    assert.match(gesehen[0], /Grüße Frau Müller freundlich\. Rest: Frau Müller und Herr Meier/);
    // Der Verlauf zeigt, was Besitzer getippt hat, und merkt sich die Vorlage.
    const mensch = (await runner.ansicht(g.id)).entries.filter((e) => e.kind === 'fyos.mensch');
    assert.equal(mensch.at(-1).data.text, '/gruss "Frau Müller" und Herr Meier');
    assert.equal(mensch.at(-1).data.vorlage, 'gruss');
    assert.equal((await befehlsEintraege(runner, g.id)).length, 0);
  });
});

test('eine Vorlage namens „neu“ ersetzt den eingebauten Befehl nicht', async () => {
  await mitRunner('vorrang', async ({ runner, gesehen }) => {
    const g = await runner.neuesGespraech({ titel: 'P' });
    const r = await runner.sende(g.id, '/neu');
    assert.ok(r.befehl, 'eingebaut gewinnt');
    await warte(200);
    assert.equal(gesehen.length, 0);
    const liste = await runner.befehle.liste(g.id);
    assert.equal(liste.filter((b) => b.name === 'neu').length, 1);
  });
});

test('Skills hinter Verknüpfungen aus dem Ordner hinaus werden nicht gelesen', async () => {
  const geheim = join(tmp, 'geheim.md');
  writeFileSync(geheim, 'GEHEIMNIS');
  mkdirSync(join(arbeit, 'skills', 'agenten', 'boese'), { recursive: true });
  const { symlinkSync } = await import('node:fs');
  symlinkSync(geheim, join(arbeit, 'skills', 'agenten', 'boese', 'SKILL.md'));
  await mitRunner('symlink', async ({ runner, gesehen }) => {
    const g = await runner.neuesGespraech({ titel: 'L' });
    const liste = await runner.befehle.liste(g.id);
    assert.equal(liste.some((b) => b.name === 'skill:boese'), false);
    await runner.sende(g.id, '/skill:boese');
    await bis(async () => gesehen.length === 1, { was: 'geht als Text' });
    assert.doesNotMatch(gesehen[0], /GEHEIMNIS/);
  });
});

// --- Hub-Eingänge sind nie Befehle ----------------------------------------------------------------

test('ein Hub-Eingang mit „/neu“ bleibt Text und stößt keinen Befehl an', async () => {
  const b = baue('ingress');
  const gesehen = mitProtokoll(b.faux);
  const hub = fakeHub([{ id: '1-0', text: '/neu', klasse: 'max', quelle: 'matrix', von: 'jemand' }]);
  const runner = new Runner(b.cfg, { models: b.models, hub });
  await runner.start();
  const ingress = new Ingress({ cfg: b.cfg, runner, hub, spielmodus: new Spielmodus([]), tor: { offen: true } });
  await ingress.start();
  try {
    await bis(async () => gesehen.length === 1, { was: 'Eingang beim Modell' });
    assert.match(gesehen[0], /\/neu/);
    assert.equal((await befehlsEintraege(runner, runner.root.id)).length, 0);
    assert.equal((await runner.befehle.zustand()).ausgefuehrt, 0);
  } finally {
    await ingress.stop();
    await runner.close().catch(() => {});
  }
});

// --- HTTP ------------------------------------------------------------------------------------

test('GET /api/befehle und Befehl über POST …/nachricht', async () => {
  const b = baue('http');
  mitProtokoll(b.faux);
  const runner = new Runner(b.cfg, { models: b.models, hub: fakeHub() });
  await runner.start();
  const server = erstelleServer({ runner, cfg: b.cfg });
  await new Promise((fertig) => server.listen(0, '127.0.0.1', fertig));
  const basis = `http://127.0.0.1:${server.address().port}`;
  const kopf = { Authorization: 'Bearer test-token-test-token-test-token-00', 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(`${basis}/api/befehle`)).status, 401);

    const liste = await (await fetch(`${basis}/api/befehle`, { headers: kopf })).json();
    assert.equal(liste.ok, true);
    const namen = liste.befehle.map((x) => x.name);
    for (const n of ['hilfe', 'neu', 'verdichten', 'modell', 'name', 'sitzung', 'baum', 'fork', 'export', 'laden', 'live', 'ruhe', 'stopp', 'skill:probe', 'gruss']) {
      assert.ok(namen.includes(n), n);
    }
    for (const x of liste.befehle) {
      assert.equal(typeof x.beschreibung, 'string');
      assert.ok(['sitzung', 'verlauf', 'modell', 'anzeige', 'bruecke', 'terminal', 'skill', 'vorlage'].includes(x.art), x.art);
      assert.ok('argumente' in x && Array.isArray(x.aliase));
    }
    assert.equal(liste.anzahl, liste.befehle.length);

    assert.equal((await fetch(`${basis}/api/befehle?gespraech=abc`, { headers: kopf })).status, 400);
    assert.equal((await fetch(`${basis}/api/befehle?gespraech=99999`, { headers: kopf })).status, 404);
    assert.equal((await fetch(`${basis}/api/befehle?gespraech=${runner.root.id}`, { headers: kopf })).status, 200);

    const g = await runner.neuesGespraech({ titel: 'H' });
    const r = await (
      await fetch(`${basis}/api/gespraech/${g.id}/nachricht`, { method: 'POST', headers: kopf, body: JSON.stringify({ text: '/name Per HTTP' }) })
    ).json();
    assert.equal(r.ok, true);
    assert.equal(r.befehl.name, 'name');
    assert.equal(r.id, null);
    assert.equal((await runner.gespraech(g.id)).meta.titel, 'Per HTTP');

    const z = await runner.befehle.zustand();
    assert.ok(z.anzahl >= 20 && z.skills === 1 && z.vorlagen >= 1 && z.ausgefuehrt >= 1);
  } finally {
    await new Promise((fertig) => server.close(fertig));
    await runner.close().catch(() => {});
  }
});

// --- Idempotenz -----------------------------------------------------------------------------------

const zweige = async (runner) => (await runner.gespraeche()).filter((g) => g.art === 'zweig').length;

test('gleiche requestId führt einen Befehl nicht noch einmal aus, auch gleichzeitig', async () => {
  await mitRunner('idem', async ({ runner, gesehen }) => {
    const g = await runner.neuesGespraech({ titel: 'I' });
    await runner.sende(g.id, 'Frage');
    await bis(async () => gesehen.length === 1, { was: 'Antwort' });
    await bis(async () => (await runner.ansicht(g.id)).entries.some((e) => e.kind === 'pi.assistant'), { was: 'Antwort abgelegt' });

    const [a, b] = await Promise.all([
      runner.sende(g.id, '/fork letzte', { requestId: 'r-1' }),
      runner.sende(g.id, '/fork letzte', { requestId: 'r-1' }),
    ]);
    assert.equal(await zweige(runner), 1, 'gleichzeitig: nur ein Zweig');
    assert.equal(a.befehl.text, b.befehl.text);
    assert.equal([a, b].filter((x) => x.befehl.wiederholt).length, 1);

    const c = await runner.sende(g.id, '/fork letzte', { requestId: 'r-1' });
    assert.equal(await zweige(runner), 1, 'danach: weiterhin ein Zweig');
    assert.equal(c.befehl.wiederholt, true);
    assert.equal(c.befehl.text, a.befehl.text);
    assert.deepEqual(c.befehl.aktion, a.befehl.aktion);
    assert.equal((await befehlsEintraege(runner, g.id)).filter((e) => e.data.requestId === 'r-1').length, 1);

    // Andere requestId oder keine: wird ausgeführt.
    await runner.sende(g.id, '/fork letzte', { requestId: 'r-2' });
    await runner.sende(g.id, '/fork letzte');
    assert.equal(await zweige(runner), 3);
    // Dieselbe requestId in einem anderen Gespräch ist ein anderer Aufruf.
    const h = await runner.neuesGespraech({ titel: 'J' });
    await runner.sende(h.id, '/name Anders', { requestId: 'r-1' });
    assert.equal((await runner.gespraech(h.id)).meta.titel, 'Anders');
  });
});

test('die Wiederholung überlebt einen Neustart des Runners', async () => {
  const b = baue('idem-neustart');
  mitProtokoll(b.faux);
  let runner = new Runner(b.cfg, { models: b.models, hub: fakeHub() });
  await runner.start();
  let gid;
  let erst;
  try {
    gid = (await runner.neuesGespraech({ titel: 'N' })).id;
    erst = await runner.sende(gid, '/name Einmalig', { requestId: 'neustart-1' });
    assert.equal(erst.befehl.ok, true);
    await runner.sende(gid, '/name Danach'); // der Titel ändert sich: eine Ausführung wäre jetzt sichtbar
  } finally {
    await runner.close().catch(() => {});
  }
  runner = new Runner(b.cfg, { models: b.models, hub: fakeHub() });
  await runner.start();
  try {
    const nochmal = await runner.sende(gid, '/name Einmalig', { requestId: 'neustart-1' });
    assert.equal(nochmal.befehl.wiederholt, true);
    assert.equal(nochmal.befehl.text, erst.befehl.text);
    assert.equal((await runner.gespraech(gid)).meta.titel, 'Danach', 'nicht noch einmal ausgeführt');
  } finally {
    await runner.close().catch(() => {});
  }
});

test('Wiederholung über HTTP: gleiche requestId, gleiche Antwort mit wiederholt', async () => {
  const b = baue('idem-http');
  mitProtokoll(b.faux);
  const runner = new Runner(b.cfg, { models: b.models, hub: fakeHub() });
  await runner.start();
  const server = erstelleServer({ runner, cfg: b.cfg });
  await new Promise((fertig) => server.listen(0, '127.0.0.1', fertig));
  const basis = `http://127.0.0.1:${server.address().port}`;
  const kopf = { Authorization: 'Bearer test-token-test-token-test-token-00', 'Content-Type': 'application/json' };
  try {
    const g = await runner.neuesGespraech({ titel: 'H' });
    const sende = async () =>
      (await fetch(`${basis}/api/gespraech/${g.id}/nachricht`, { method: 'POST', headers: kopf, body: JSON.stringify({ text: '/name Http', requestId: 'http-1' }) })).json();
    const eins = await sende();
    const zwei = await sende();
    assert.equal(eins.befehl.wiederholt, undefined);
    assert.equal(zwei.befehl.wiederholt, true);
    assert.equal(zwei.befehl.text, eins.befehl.text);
    assert.equal((await befehlsEintraege(runner, g.id)).length, 1);
  } finally {
    await new Promise((fertig) => server.close(fertig));
    await runner.close().catch(() => {});
  }
});
