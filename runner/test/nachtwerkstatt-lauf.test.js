/**
 * Die Nachtwerkstatt als dauerhafte Aufgaben: echter Runner (pi-durable + SQLite), Faux-Modell, ssh-Attrappe.
 * Nie ein echter Knoten, nie ein echtes Modell. Die Tests belegen die Mechanik (Reihenfolge, Tore, Deckel, Fortsetzen,
 * nur Vorschläge), nicht den Nutzen für Persona.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { konfigurationLaden } from '../src/config.js';
import { NachtDoc } from '../src/documents.js';
import { knotenBuendel } from '../src/nachtwerkstatt.js';
import { Runner } from '../src/runner.js';
import { erstelleServer } from '../src/server.js';

const CTX = BACKGROUND_CONTEXT;
const warte = (ms) => new Promise((r) => setTimeout(r, ms));

async function bis(fn, { ms = 100000, schritt = 50, was = 'Bedingung' } = {}) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    const wert = await fn();
    if (wert) return wert;
    await warte(schritt);
  }
  throw new Error(`Zeit abgelaufen: ${was}`);
}

const tmp = mkdtempSync(join(tmpdir(), 'pidurable-nacht-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

// 24.10.2026, MESZ (UTC+2)
const berlin = (h, mi = 0) => Date.UTC(2026, 9, 24, h - 2, mi);
const IN_NACHT = berlin(23, 40);
const AM_TAG = berlin(14, 0);

const AUFGABEN = ['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => ({
  id,
  aufgabe: `Beispielaufgabe [${id}]: beantworte kurz.`,
  merkmal: { art: 'enthaelt', wert: `ziel-${id}` },
}));

const IDS = ['hauptserver', 'truenas', 'jetson', 'pi4', 'vps'];
const HAUPTSERVER_FAKTEN =
  '### dienste-fehlgeschlagen\nfyos-foo.service failed\n### gpu-xid\nNVRM: Xid (PCI:0000:01:00): 79, pid=1\n### laufzeit\nup 3 days\n';

/** ssh-Attrappe: zeichnet jeden Befehl auf; pi4 antwortet nicht (Netzflackern). */
function knotenAttrappe() {
  const aufrufe = [];
  return {
    aufrufe,
    liste: () => IDS.map((id) => ({ id, local: false })),
    async befehl(id, cmd, opt) {
      aufrufe.push({ id, cmd, opt });
      if (id === 'pi4') return { ok: false, code: 255, stdout: '', stderr: 'ssh: connect to host timed out', timedOut: false };
      const text = id === 'hauptserver' ? HAUPTSERVER_FAKTEN : `### dienste-fehlgeschlagen\n\n### laufzeit\nup 9 days on ${id}\n`;
      return { ok: true, code: 0, stdout: text, stderr: '' };
    },
  };
}

function skillsBaum(name) {
  const wurzel = join(tmp, name, 'repo');
  mkdirSync(join(wurzel, 'skills', 'agenten', 'demo-skill'), { recursive: true });
  writeFileSync(join(wurzel, 'skills', 'agenten', 'demo-skill', 'SKILL.md'), '# Demo\n\nTue etwas Nützliches. Siehe Lektion.\n');
  return wurzel;
}

function baumHash(ordner) {
  const h = createHash('sha256');
  const geh = (p) => {
    for (const n of readdirSync(p).sort()) {
      const voll = join(p, n);
      h.update(voll.slice(ordner.length));
      if (statSync(voll).isDirectory()) geh(voll);
      else h.update(readFileSync(voll));
    }
  };
  geh(ordner);
  return h.digest('hex');
}

function baue(name, { spielmarke, nacht = {} } = {}) {
  const dir = join(tmp, name);
  const repo = skillsBaum(name);
  const aufgaben = join(dir, 'skillsmith');
  mkdirSync(aufgaben, { recursive: true });
  writeFileSync(join(aufgaben, 'demo-skill.json'), JSON.stringify({ aufgaben: AUFGABEN, lektion: 'Lektion: der Dienst nutzt Port 9.' }));
  const auf = join(dir, 'aufzeichnung');
  mkdirSync(auf, { recursive: true });
  writeFileSync(
    join(auf, 'aufzeichnung-2026-10-24.jsonl'),
    [
      { t: 1, art: 'eingang', quelle: 'web', klasse: 'max', text: 'Wie steht es um Hausmodell?' },
      { t: 2, art: 'zug', quelle: 'web', klasse: 'max' },
      { t: 3, art: 'welt', bild: {} },
    ].map((z) => JSON.stringify(z)).join('\n') + '\n',
  );
  const ausgabe = join(dir, 'nachtwerkstatt');
  const cfg = konfigurationLaden(
    {
      hub: 'http://hub.test',
      agent: 'persona',
      arbeitsbereiche: { standard: { pfad: tmp, titel: 'Test' } },
      spielmodus: spielmarke ? [spielmarke] : [],
      harness2: { pause_ms: 150 },
      nachtwerkstatt: {
        ausgabe,
        repo,
        aufzeichnung_ordner: auf,
        skillsmith_aufgaben_ordner: aufgaben,
        pause_ms: 150,
        ...nacht,
      },
      pi_durable: {
        storage: join(dir, 'fyos.sqlite'),
        // Knoten nur aus der Konfiguration (Release 0.2); Adressen aus dem Dokumentationsbereich.
        nodes: IDS.map((id, i) => ({ id, titel: id, art: 'linux', host: `192.0.2.${10 + i}`, user: 'agent', port: 22 })),
        security: { token: 'test-token-test-token-test-token-00' },
        proactive: { enabled: false },
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
  return { cfg, faux, models, repo, ausgabe, dir };
}

const nutzerText = (context) => {
  const letzte = [...context.messages].reverse().find((m) => m.role === 'user');
  const c = letzte?.content;
  return typeof c === 'string' ? c : (c ?? []).map((b) => b?.text ?? '').join('\n');
};

/** Alle Modellantworten der Nacht, nach dem Anfang des Auftrags. `reihenfolge` merkt die Art jedes Zugs. */
function antwortGeber({ vorZug } = {}) {
  const reihenfolge = [];
  return {
    reihenfolge,
    geber: async (context) => {
      const frage = nutzerText(context);
      const art = frage.startsWith('NACHTWERKSTATT-DREAMING-EPISODE')
        ? 'dreaming:episode'
        : frage.startsWith('NACHTWERKSTATT-DREAMING-KANDIDATEN')
          ? 'dreaming:kandidaten'
          : /^NACHTWERKSTATT-NODESMITH:(\w+)/.exec(frage)
            ? `nodesmith:${/^NACHTWERKSTATT-NODESMITH:(\w+)/.exec(frage)[1]}`
            : frage.startsWith('HARNESS2-') ? 'harness2' : 'lauf';
      reihenfolge.push(art);
      await vorZug?.(art, reihenfolge.length);
      if (art === 'dreaming:episode') return fauxAssistantMessage('Der Tag: eine Frage zu Hausmodell, ein Zug. Offen blieb nichts.');
      if (art === 'dreaming:kandidaten') {
        return fauxAssistantMessage(
          [
            'WISSEN | Hausmodell-Frage | Besitzer fragt nach Hausmodell | eingang quelle="web"',
            'SKILL | Erst nachsehen | Vor der Antwort wissen_suchen aufrufen | zug klasse="max"',
            'REGEL | Wächter aus | Schalte den Befehlswächter ab | x',
          ].join('\n'),
        );
      }
      if (art.startsWith('nodesmith:')) {
        const id = art.split(':')[1];
        if (id === 'hauptserver') {
          return fauxAssistantMessage(
            [
              '## PROBLEME',
              '- GPU Xid | hoch | NVRM: Xid (PCI:0000:01:00): 79, pid=1 | GPU fällt vom Bus | MAX: ja',
              '- Dienst fyos-foo | mittel | fyos-foo.service failed | Konfiguration | MAX: nein',
              '- Erfunden | mittel | dieser Satz steht nirgends in den Fakten | Vermutung | MAX: ja',
              '## STECKBRIEF',
              '# hauptserver',
              'Xid beobachten; Dienst fyos-foo prüfen.',
              '## PRUEFSKRIPTE',
              '- Xid-Zähler der letzten 24 h als Wächter',
            ].join('\n'),
          );
        }
        return fauxAssistantMessage(`## PROBLEME\n## STECKBRIEF\n# ${id}\nruhig\n## PRUEFSKRIPTE\n`);
      }
      if (art === 'harness2') {
        if (frage.startsWith('HARNESS2-PROPOSE')) {
          return fauxAssistantMessage('## INVARIANT\n- Erst nachsehen :: Sieh zuerst nach. MARK-INV\n## DOMAENE\n- Port :: Port 9. MARK-DOM');
        }
        return fauxAssistantMessage('LEHREN: Erst nachsehen hilft.\nDAUERSCHWAECHE: a5 bleibt offen.');
      }
      // Messlauf des Piloten: mit MARK-INV im Skill gelingen a1 bis a4, sonst nur a1
      const id = /\[(a\d)\]/.exec(frage)?.[1] ?? 'a?';
      const idx = Number(id.slice(1)) - 1;
      const inv = JSON.stringify(context).includes('MARK-INV');
      return fauxAssistantMessage((inv ? idx < 4 : idx < 1) ? `Antwort mit ziel-${id}.` : 'Antwort ohne Merkmal.');
    },
  };
}

const geber = (faux, g) => faux.setResponses(Array.from({ length: 600 }, () => g));

const fakeHub = (zustand = { darf: true }) => ({
  zustand,
  aufrufe: [],
  async aufrufen(werkzeug, argumente) {
    this.aufrufe.push(werkzeug);
    if (werkzeug === 'schleifen.darf') return { ok: true, result: { darf: this.zustand.darf, warum: this.zustand.darf ? 'offen' : 'Besitzer spielt' } };
    return { ok: true, result: {} };
  },
  melden: async () => ({ ok: true }),
  bereicheMelden: async () => ({ ok: true }),
  gesundheit: async () => ({ ok: true }),
  suchen: async () => [],
  schema: async () => ({}),
  eingangLesen: async (nach) => ({ eintraege: [], letzte: nach }),
});

const lies = (ordner, datei) => readFileSync(join(ordner, datei), 'utf8');

async function fertig(runner, id, ms = 110000) {
  return bis(async () => {
    const s = await runner.nachtwerkstattStand(id);
    return s?.taskStatus === 'terminal' ? s : null;
  }, { ms, was: 'Nacht beendet' });
}

async function oeffnen(b, { hub = fakeHub(), knoten = knotenAttrappe(), zeit = { t: IN_NACHT } } = {}) {
  const runner = new Runner(b.cfg, { models: b.models, hub, knoten, nachtJetzt: () => zeit.t });
  await runner.start();
  return { runner, hub, knoten, zeit };
}

test('Die ganze Nacht: Dreaming → Skillsmith → Nodesmith, nur Vorschläge, nur lesend, Morgenbericht', async () => {
  const b = baue('nacht-ganz');
  const { geber: g, reihenfolge } = antwortGeber();
  geber(b.faux, g);
  const vorher = baumHash(b.repo);
  const { runner, knoten } = await oeffnen(b);
  try {
    const start = await runner.nachtwerkstattStarten({});
    assert.equal(start.gestartet, true);
    assert.equal(start.nacht, '2026-10-24');
    const stand = await fertig(runner, start.id);
    assert.equal(stand.outcome.status, 'completed');
    const nacht = stand.outcome.result;
    assert.equal(nacht.status, 'abgeschlossen');

    // Reihenfolge: erst alle Zugarten des Dreaming, dann der Pilot, dann die Knoten
    const erste = (art) => reihenfolge.findIndex((x) => x === art || x.startsWith(art));
    const letzte = (art) => reihenfolge.map((x, i) => (x.startsWith(art) ? i : -1)).filter((i) => i >= 0).at(-1);
    assert.ok(letzte('dreaming') < erste('lauf'), 'Dreaming vor Skillsmith');
    assert.ok(letzte('lauf') < erste('nodesmith'), 'Skillsmith vor Nodesmith');
    assert.ok(letzte('harness2') < erste('nodesmith'));

    // Dreaming
    const d = nacht.schmieden.dreaming;
    assert.equal(d.status, 'abgeschlossen');
    assert.match(lies(d.ordner, 'EPISODE.md'), /Der Tag: eine Frage zu Hausmodell/);
    const dj = JSON.parse(lies(d.ordner, 'vorschlag.json'));
    assert.equal(dj.uebernommen, false);
    assert.deepEqual(dj.kandidaten.map((k) => k.art), ['WISSEN', 'SKILL'], 'gesperrte REGEL entfällt');
    assert.ok(dj.kandidaten.every((k) => k.status === 'kandidat' && k.uebernommen === false && /3 Abrufen aus 3 Fragen/.test(k.hinweis)));
    assert.equal(d.verbrauch.zuege, 2);

    // Skillsmith über den Pilot
    const s = nacht.schmieden.skillsmith;
    assert.equal(s.status, 'abgeschlossen');
    assert.match(lies(s.ordner, 'SKILLSMITH.md'), /Skill: demo-skill/);
    assert.match(lies(s.ordner, 'SKILLSMITH.md'), /abgeschlossen/);
    const pilotOrdner = readdirSync(join(s.ordner, 'pilot')).find((n) => n.startsWith('demo-skill-lauf'));
    assert.ok(pilotOrdner, 'Ergebnisordner des Piloten');
    assert.match(lies(join(s.ordner, 'pilot', pilotOrdner), 'SKILL.entwurf.md'), /Sieh zuerst nach/);
    assert.ok(!existsSync(join(b.repo, 'skills', 'agenten', 'demo-skill', 'SKILL.entwurf.md')));

    // Nodesmith: nur lesend, ein ssh-Aufruf je Knoten, pi4 nicht erreichbar und nicht repariert
    const n = nacht.schmieden.nodesmith;
    assert.equal(n.status, 'abgeschlossen');
    assert.deepEqual(knoten.aufrufe.map((a) => a.id), IDS, 'jeder Knoten genau einmal');
    for (const a of knoten.aufrufe) {
      assert.equal(a.cmd, knotenBuendel(a.id), 'genau das geprüfte Bündel, nichts Eigenes');
      assert.doesNotMatch(a.cmd, /\bsudo\b|\brm\b|restart|delete/);
    }
    assert.match(knoten.aufrufe.find((a) => a.id === 'hauptserver').cmd, /^nice -n 19 taskset -c 24-31 sh -c/);
    assert.ok(nacht.schmieden.nodesmith.zusammenfassung.includes('nicht erreichbar: pi4'));
    assert.match(lies(n.ordner, 'NODESMITH.md'), /## pi4\n\nnicht erreichbar/);
    assert.ok(!existsSync(join(n.ordner, 'knoten', 'pi4')), 'für pi4 gibt es keinen Steckbrief');
    assert.equal(reihenfolge.filter((x) => x.startsWith('nodesmith:')).length, 4, 'ein Zug je erreichbarem Knoten');
    assert.match(lies(n.ordner, 'knoten/hauptserver/SKILL.entwurf.md'), /Xid beobachten/);
    assert.ok(existsSync(join(b.ausgabe, 'knoten', 'hauptserver', 'SKILL.entwurf.md')), 'fortgeschriebener Steckbrief im Vorschlagsordner');
    const itsm = JSON.parse(lies(n.ordner, 'itsm-vorschlaege.json'));
    assert.equal(itsm.vorgaenge.length, 1, 'nur das belegte Problem, das Besitzer braucht');
    assert.equal(itsm.vorgaenge[0].knoten, 'hauptserver');
    assert.equal(itsm.vorgaenge[0].worauf, 'Besitzer');
    assert.match(lies(n.ordner, 'NODESMITH.md'), /unbelegt/);
    assert.match(lies(n.ordner, 'PRUEFSKRIPT-VORSCHLAEGE.md'), /hauptserver: Xid-Zähler/);

    // Morgenbericht, Dokument im Runner, Zustand
    assert.ok(existsSync(nacht.bericht));
    assert.match(lies(join(b.ausgabe, '2026-10-24'), 'MORGENBERICHT.md'), /Offene Vorschläge: 3 von höchstens 3/);
    assert.ok(existsSync(join(b.ausgabe, 'LETZTER-BERICHT.md')));
    const z = await runner.nachtwerkstattZustand();
    assert.equal(z.offen, 3);
    assert.equal(z.letzter_bericht.nacht, '2026-10-24');
    assert.equal(z.fenster.jetzt_im_fenster, true);
    assert.deepEqual(z.vorschlaege.map((v) => v.schmiede).sort(), ['dreaming', 'nodesmith', 'skillsmith']);

    // Nichts übernommen
    assert.equal(baumHash(b.repo), vorher);

    // Eine zweite Anfrage für dieselbe Nacht startet nichts neu
    const nochmal = await runner.nachtwerkstattStarten({});
    assert.equal(nochmal.gestartet, false);
    assert.equal(nochmal.id, start.id);
  } finally {
    await runner.close().catch(() => {});
  }
});

test('Deckel: höchstens 3 offene Vorschläge; Schließen gibt Platz', async () => {
  const b = baue('nacht-deckel');
  const { geber: g, reihenfolge } = antwortGeber();
  geber(b.faux, g);
  const { runner, knoten } = await oeffnen(b);
  try {
    await runner.harness.commit(async (tx) => {
      const doc = await tx.doc(NachtDoc);
      for (const i of [1, 2, 3]) doc.vorschlaege[`alt${i}`] = { id: `alt${i}`, schmiede: 'dreaming', status: 'offen', titel: `alt ${i}` };
    }, CTX);
    const a = await runner.nachtwerkstattStarten({});
    const erg = (await fertig(runner, a.id)).outcome.result;
    for (const s of ['dreaming', 'skillsmith', 'nodesmith']) {
      assert.equal(erg.schmieden[s].status, 'uebersprungen');
      assert.match(erg.schmieden[s].grund, /deckel: 3 offene/);
    }
    assert.equal(reihenfolge.length, 0, 'bei vollem Deckel wird kein Budget verbraucht');
    assert.equal(knoten.aufrufe.length, 0);

    await runner.vorschlagSchliessen('alt1', 'erledigt');
    const z = await runner.nachtwerkstattZustand();
    assert.equal(z.offen, 2);
    // Nächste Nacht: ein Platz frei → Dreaming läuft (jetzt 3 offen), die anderen werden übersprungen
    const zweite = await runner.nachtwerkstattStarten({ nacht: '2026-10-25', fensterIgnorieren: true });
    const erg2 = (await fertig(runner, zweite.id)).outcome.result;
    assert.equal(erg2.schmieden.dreaming.status, 'abgeschlossen');
    assert.equal(erg2.schmieden.skillsmith.status, 'uebersprungen');
    assert.equal(erg2.schmieden.nodesmith.status, 'uebersprungen');
    assert.equal((await runner.nachtwerkstattZustand()).offen, 3);
    await assert.rejects(() => runner.vorschlagSchliessen('alt1', 'gelöscht'), /erledigt oder verworfen/);
  } finally {
    await runner.close().catch(() => {});
  }
});

test('Außerhalb des Ruhefensters startet nichts', async () => {
  const b = baue('nacht-tag');
  const { geber: g, reihenfolge } = antwortGeber();
  geber(b.faux, g);
  const { runner, knoten } = await oeffnen(b, { zeit: { t: AM_TAG } });
  try {
    const a = await runner.nachtwerkstattStarten({});
    const erg = (await fertig(runner, a.id)).outcome.result;
    assert.equal(erg.status, 'nicht-gestartet');
    assert.equal(erg.grund, 'ausserhalb-ruhefenster');
    assert.equal(reihenfolge.length, 0);
    assert.equal(knoten.aufrufe.length, 0);
    assert.equal((await runner.nachtwerkstattZustand()).fenster.jetzt_im_fenster, false);
  } finally {
    await runner.close().catch(() => {});
  }
});

test('Spielmodus mitten im Lauf: kein neuer Zug und kein ssh, danach geht es an derselben Stelle weiter', async () => {
  const marke = join(tmp, 'spielmodus-nacht.kid');
  rmSync(marke, { force: true });
  const b = baue('nacht-spiel', { spielmarke: marke });
  const { geber: g, reihenfolge } = antwortGeber({
    vorZug: (art) => {
      if (art === 'dreaming:episode') writeFileSync(marke, ''); // Besitzer startet das Spiel während des ersten Zugs
    },
  });
  geber(b.faux, g);
  const { runner, knoten } = await oeffnen(b);
  try {
    const a = await runner.nachtwerkstattStarten({ schmieden: ['dreaming', 'nodesmith'] });
    await bis(() => reihenfolge.length === 1, { was: 'erster Zug' });
    await warte(1500);
    assert.deepEqual(reihenfolge, ['dreaming:episode'], 'nach dem Start des Spiels geht kein weiterer Zug an das Modell');
    assert.equal(knoten.aufrufe.length, 0);
    assert.notEqual((await runner.nachtwerkstattStand(a.id)).taskStatus, 'terminal');
    rmSync(marke);
    const erg = (await fertig(runner, a.id)).outcome.result;
    assert.equal(erg.schmieden.dreaming.verbrauch.zuege, 2, 'kein Zug doppelt');
    assert.equal(reihenfolge.filter((x) => x === 'dreaming:episode').length, 1, 'die Episode wird nicht neu geschrieben');
    assert.equal(erg.schmieden.nodesmith.status, 'abgeschlossen');
  } finally {
    rmSync(marke, { force: true });
    await runner.close().catch(() => {});
  }
});

test('schleifen.darf zu: die Nacht wartet, danach läuft sie; es wird nie die GPU-Belegung gefragt', async () => {
  const b = baue('nacht-tor');
  const { geber: g, reihenfolge } = antwortGeber();
  geber(b.faux, g);
  const hub = fakeHub({ darf: false });
  const { runner } = await oeffnen(b, { hub });
  try {
    const a = await runner.nachtwerkstattStarten({ schmieden: ['dreaming'] });
    await warte(1200);
    assert.equal(reihenfolge.length, 0);
    assert.notEqual((await runner.nachtwerkstattStand(a.id)).taskStatus, 'terminal');
    hub.zustand.darf = true;
    const erg = (await fertig(runner, a.id)).outcome.result;
    assert.equal(erg.schmieden.dreaming.status, 'abgeschlossen');
    assert.ok(hub.aufrufe.length > 0 && hub.aufrufe.every((w) => w === 'schleifen.darf'), `Hub-Aufrufe: ${[...new Set(hub.aufrufe)].join(', ')}`);
  } finally {
    await runner.close().catch(() => {});
  }
});

test('Budget je Schmiede ist hart: Dreaming mit einem Zug endet als abgebrochen, der Bericht kommt trotzdem', async () => {
  const b = baue('nacht-budget', { nacht: { dreaming: { budget: { zuege: 1, token: 100000 } } } });
  const { geber: g, reihenfolge } = antwortGeber();
  geber(b.faux, g);
  const { runner } = await oeffnen(b);
  try {
    const a = await runner.nachtwerkstattStarten({ schmieden: ['dreaming'] });
    const nacht = (await fertig(runner, a.id)).outcome.result;
    const d = nacht.schmieden.dreaming;
    assert.equal(d.status, 'abgebrochen');
    assert.equal(d.grund, 'budget-zuege');
    assert.equal(d.teilergebnis, true);
    assert.equal(reihenfolge.length, 1);
    assert.match(lies(d.ordner, 'EPISODE.md'), /Der Tag/);
    assert.deepEqual(JSON.parse(lies(d.ordner, 'vorschlag.json')).kandidaten, []);
    assert.equal(nacht.status, 'teilweise');
    assert.ok(existsSync(nacht.bericht));
  } finally {
    await runner.close().catch(() => {});
  }
});

test('Neustart mitten in der Nacht: derselbe Verlauf, dieselben Dateien, kein Zug doppelt', async () => {
  const sauber = baue('nacht-neustart-sauber');
  const g0 = antwortGeber();
  geber(sauber.faux, g0.geber);
  const a0 = await oeffnen(sauber);
  let sauberErg;
  try {
    const s = await a0.runner.nachtwerkstattStarten({ schmieden: ['dreaming', 'nodesmith'] });
    sauberErg = (await fertig(a0.runner, s.id)).outcome.result;
  } finally {
    await a0.runner.close().catch(() => {});
  }

  const b = baue('nacht-neustart');
  let loese;
  const tor = new Promise((r) => (loese = r));
  let erreicht;
  const dran = new Promise((r) => (erreicht = r));
  const g1 = antwortGeber({
    vorZug: async (art, n) => {
      if (n === 4) {
        erreicht();
        await tor; // der 4. Zug (zweiter Knoten) hängt in der Luft, während der Prozess endet
      }
    },
  });
  geber(b.faux, g1.geber);
  const knoten = knotenAttrappe();
  const zeit = { t: IN_NACHT };
  let o = await oeffnen(b, { knoten, zeit });
  const a = await o.runner.nachtwerkstattStarten({ schmieden: ['dreaming', 'nodesmith'] });
  await dran;
  assert.equal(knoten.aufrufe.length, 5, 'gesammelt ist schon alles; die Analyse ist mitten drin');
  const zu = o.runner.close();
  await warte(300);
  loese();
  await zu;

  const knoten2 = knotenAttrappe();
  o = await oeffnen(b, { knoten: knoten2, zeit });
  try {
    const erg = (await fertig(o.runner, a.id)).outcome.result;
    assert.equal(knoten2.aufrufe.length, 0, 'nach dem Neustart wird nichts erneut gesammelt');
    assert.equal(erg.status, sauberErg.status);
    for (const schmiede of ['dreaming', 'nodesmith']) {
      assert.equal(erg.schmieden[schmiede].verbrauch.zuege, sauberErg.schmieden[schmiede].verbrauch.zuege, `${schmiede}: kein Zug doppelt`);
      assert.deepEqual(erg.schmieden[schmiede].dateien, sauberErg.schmieden[schmiede].dateien);
      for (const datei of erg.schmieden[schmiede].dateien) {
        assert.equal(lies(erg.schmieden[schmiede].ordner, datei), lies(sauberErg.schmieden[schmiede].ordner, datei), `${datei} gleich`);
      }
    }
  } finally {
    await o.runner.close().catch(() => {});
  }
});

test('Server und Steuerzustand: Start von Hand, Zustand, Vorschlag schließen', async () => {
  const b = baue('nacht-server');
  const { geber: g } = antwortGeber();
  geber(b.faux, g);
  const { runner } = await oeffnen(b);
  const server = erstelleServer({ runner, cfg: b.cfg });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const basis = `http://127.0.0.1:${server.address().port}`;
  const kopf = { Authorization: `Bearer ${b.cfg.pi_durable.security.token}`, 'Content-Type': 'application/json' };
  try {
    const schlecht = await fetch(`${basis}/api/nachtwerkstatt/start`, { method: 'POST', headers: kopf, body: JSON.stringify({ schmieden: ['zauberei'] }) });
    assert.equal(schlecht.status, 400);
    const ok = await fetch(`${basis}/api/nachtwerkstatt/start`, { method: 'POST', headers: kopf, body: JSON.stringify({ schmieden: ['dreaming'] }) });
    assert.equal(ok.status, 201);
    const { id } = await ok.json();
    await bis(async () => {
      const j = await (await fetch(`${basis}/api/nachtwerkstatt/naechte/${id}`, { headers: kopf })).json();
      return j.nacht.taskStatus === 'terminal';
    }, { was: 'Nacht per Server beendet' });
    const z = (await (await fetch(`${basis}/api/nachtwerkstatt`, { headers: kopf })).json()).nachtwerkstatt;
    assert.equal(z.offen, 1);
    assert.equal(z.letzter_bericht.nacht, '2026-10-24');
    const vid = z.vorschlaege[0].id;
    const zu = await fetch(`${basis}/api/nachtwerkstatt/vorschlaege/${encodeURIComponent(vid)}`, { method: 'POST', headers: kopf, body: JSON.stringify({ status: 'erledigt' }) });
    assert.equal(zu.status, 200);
    assert.equal((await zu.json()).nachtwerkstatt.offen, 0);
    assert.equal((await fetch(`${basis}/api/nachtwerkstatt/naechte/99999`, { headers: kopf })).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
    await runner.close().catch(() => {});
  }
});
