// Prüft persona/gedaechtnis*.js: Fakten (merken, Dubletten, ablösen), Suche (Index und Dateien), Abruf-Zähler (SECO-Regel),
// Prompt-Abschnitt, Pflegeliste, Tagesprotokoll, Qdrant-Anbindung gegen eine Attrappe (nur Einheitstest; die Vertragsprüfung
// gegen den echten Qdrant ist eine Probe im Entwurf), Konfiguration und Einbau in ginnyErweiterung.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { konfigurationLaden } from '../src/config.js';
import { Gedaechtnis, gedaechtnisSektionen, gedaechtnisWerkzeuge } from '../src/persona/gedaechtnis.js';
import { GedaechtnisIndex, DIM, punktId } from '../src/persona/gedaechtnis-index.js';
import { Tagesprotokoll, aufzeichnungZaehlen } from '../src/persona/gedaechtnis-protokoll.js';
import { ginnyErweiterung } from '../src/persona/index.js';
import { sparseAnfrage, sparseDokument, aehnlichkeit, zerlege } from '../src/persona/gedaechtnis-lex.js';

const T0 = Date.parse('2026-10-25T10:00:00.000Z');

/** Qdrant- und Einbetter-Attrappe: hält Punkte im Speicher, schreibt jede Anfrage mit. */
function attrappe({ aus = false } = {}) {
  const s = { aus, sammlung: null, punkte: new Map(), aufrufe: [], form: null };
  const antwort = (status, daten) => ({ ok: status < 400, status, text: async () => JSON.stringify(daten) });
  const vektor = (t) => {
    const v = new Array(DIM).fill(0);
    for (const w of zerlege(t)) v[parseInt(w.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % DIM] += 1;
    return v;
  };
  const fetch = async (url, opt = {}) => {
    if (s.aus) throw new Error('connect ECONNREFUSED');
    const u = new URL(url);
    const rumpf = opt.body ? JSON.parse(opt.body) : undefined;
    s.aufrufe.push({ methode: opt.method, pfad: u.pathname + u.search, rumpf });
    if (u.pathname === '/v1/embeddings') {
      return antwort(200, { data: rumpf.input.map((t, i) => ({ index: i, embedding: vektor(t) })) });
    }
    const m = u.pathname.match(/^\/collections\/([^/]+)(\/.*)?$/);
    if (!m) return antwort(404, {});
    const rest = m[2] ?? '';
    if (opt.method === 'GET' && !rest) {
      if (!s.sammlung) return antwort(404, { status: { error: 'nicht da' } });
      return antwort(200, { result: { config: { params: s.form ?? { vectors: { dense: { size: DIM } }, sparse_vectors: { lex: {} } } } } });
    }
    if (opt.method === 'PUT' && !rest) {
      s.sammlung = m[1];
      return antwort(200, { result: true });
    }
    if (rest.startsWith('/index')) return antwort(200, { result: true });
    if (opt.method === 'PUT' && rest.startsWith('/points')) {
      for (const p of rumpf.points) s.punkte.set(p.id, p);
      return antwort(200, { result: true });
    }
    if (rest === '/points/query') {
      const must = rumpf.filter?.must ?? [];
      const nicht = rumpf.filter?.must_not ?? [];
      const treffer = [...s.punkte.values()].filter((p) => {
        for (const c of must) {
          const w = p.payload[c.key];
          if (c.match?.value !== undefined && w !== c.match.value) return false;
          if (c.match?.any && !c.match.any.includes(w)) return false;
          if (c.range && ((c.range.gte && w < c.range.gte) || (c.range.lte && w > c.range.lte))) return false;
        }
        return !nicht.some((c) => p.payload[c.key] === c.match.value);
      });
      const q = rumpf.prefetch?.find((x) => x.using === 'lex')?.query.indices ?? [];
      const punkt = (p) => p.vector.lex.indices.filter((i) => q.includes(i)).length;
      treffer.sort((a, b) => punkt(b) - punkt(a));
      return antwort(200, { result: { points: treffer.slice(0, rumpf.limit).map((p) => ({ id: p.id, score: punkt(p), payload: p.payload })) } });
    }
    return antwort(404, {});
  };
  return { fetch, s };
}

function aufbau({ an = true, agent = 'persona', aus = false, ohneIndex = false, deckel = {} } = {}) {
  const w = mkdtempSync(join(tmpdir(), 'gedaechtnis-'));
  const cfg = konfigurationLaden({ agent, pi_durable: { gedaechtnis: { an, ordner: join(w, 'g'), qdrant_url: 'http://qdrant.test:6333', embed_url: 'http://embed.test:8080', deckel } } }, {});
  const uhr = { t: T0 };
  const a = attrappe({ aus });
  const g = new Gedaechtnis({ cfg, jetzt: () => uhr.t, log: () => {}, fetch: a.fetch, ...(ohneIndex ? { index: null } : {}) });
  return { w, cfg, g, uhr, a, ordner: join(w, 'g') };
}

const ZEHN = 'Das Gedächtnis liegt in Dateien unter gedaechtnis und Qdrant ist nur der Index.';

test('Lex: Kennungen ganz und in Teilen, Umlaute gefaltet, Sparse-Vektor deterministisch und sortiert', () => {
  assert.ok(zerlege('Änderung PRB-3387 im Müll').includes('prb-3387'));
  assert.ok(zerlege('PRB-3387').includes('3387'));
  const d = sparseDokument('Qdrant Index Index');
  assert.deepEqual(d, sparseDokument('Qdrant Index Index'));
  assert.deepEqual([...d.indices], [...d.indices].sort((x, y) => x - y));
  assert.equal(sparseAnfrage('Qdrant').indices.length, 1);
  assert.ok(aehnlichkeit('Qdrant ist der Index der Dateien', 'Qdrant ist der Index der Dateien heute') > 0.7);
  assert.ok(aehnlichkeit('Qdrant Index', 'Tomaten wachsen am Fenster') < 0.1);
});

test('merken: Quelle Pflicht, Geheimnisse abgelehnt, einsicht nur mit Besitzer, Datei und Index geschrieben', async () => {
  const { g, a, ordner } = aufbau();
  assert.match((await g.merken({ text: ZEHN })).grund, /Quelle/);
  const geheim = await g.merken({ text: 'Das Token: ghp_abcdefghijklmnop gilt immer', quelle: 'test' }); // sauber: ok (Testattrappe)
  assert.equal(geheim.ok, false);
  assert.match(geheim.grund, /Zugangsdatum/);
  assert.equal(existsSync(ordner), false, 'nichts geschrieben');

  const r = await g.merken({ text: ZEHN, quelle: 'eintrag:42', reife: 'einsicht' });
  assert.equal(r.ok, true);
  assert.equal(r.reife, 'feldnotiz');
  assert.match(r.hinweis, /max_bestaetigt/);
  assert.equal(r.index, 'ok');
  const f = JSON.parse(readFileSync(join(ordner, 'fakten', `${r.id}.json`), 'utf8'));
  assert.deepEqual([f.art, f.agent, f.quelle, f.abgeloest, f.abrufe], ['fakt', 'persona', 'eintrag:42', null, 0]);
  assert.equal(f.erste_nennung, f.letzte_bestaetigung);
  assert.equal(a.s.punkte.size, 1);
  const p = [...a.s.punkte.values()][0];
  assert.equal(p.payload.agent, 'persona');
  assert.equal(p.payload.art, 'fakt');
  assert.equal(p.id, punktId('persona', r.id));
  assert.equal(p.vector.dense.length, DIM);

  const ein = await g.merken({ text: 'Besitzer hat die Wahl bestätigt: Dateien sind Wahrheit.', quelle: 'Besitzer, 2026-10-25', reife: 'einsicht', max_bestaetigt: true });
  assert.equal(ein.reife, 'einsicht');
});

test('merken: Dublette bestätigt (neues Datum, weitere Quelle), Ähnliches schreibt nichts, trotzdem legt neu an', async () => {
  const { g, uhr, ordner } = aufbau();
  const a = await g.merken({ text: ZEHN, quelle: 'eintrag:1' });
  uhr.t += 86_400_000;
  const b = await g.merken({ text: ZEHN.toUpperCase(), quelle: 'eintrag:2' });
  assert.equal(b.dublette, true);
  assert.equal(b.id, a.id);
  const f = JSON.parse(readFileSync(join(ordner, 'fakten', `${a.id}.json`), 'utf8'));
  assert.equal(f.erste_nennung.slice(0, 10), '2026-10-25');
  assert.equal(f.letzte_bestaetigung.slice(0, 10), '2026-10-26');
  assert.deepEqual(f.weitere_quellen, ['eintrag:2']);
  assert.equal(readdirSync(join(ordner, 'fakten')).length, 1);

  const nah = await g.merken({ text: `${ZEHN} Heute geprüft.`, quelle: 'eintrag:3' });
  assert.equal(nah.ok, false);
  assert.equal(nah.aehnlich, a.id);
  assert.equal(readdirSync(join(ordner, 'fakten')).length, 1);
  const doch = await g.merken({ text: `${ZEHN} Heute geprüft.`, quelle: 'eintrag:3', trotzdem: true });
  assert.equal(doch.ok, true);
  assert.equal(readdirSync(join(ordner, 'fakten')).length, 2);
});

test('Deckel: zu viele aktive Einträge werden abgelehnt, Ablösen schafft Platz', async () => {
  const { g } = aufbau({ deckel: { fakten: 10 } });
  const wort = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliett', 'kilo'];
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push((await g.merken({ text: `Eintrag ${wort[i]} steht für ganz eigene Dinge ${wort[(i + 3) % 11]}x${i}`, quelle: 'q' })).id);
  const voll = await g.merken({ text: 'Völlig anderer Satz über Tomaten am Fenster', quelle: 'q' });
  assert.match(voll.grund, /Deckel/);
  await g.abloesen({ id: ids[0], grund: 'veraltet' });
  assert.equal((await g.merken({ text: 'Völlig anderer Satz über Tomaten am Fenster', quelle: 'q' })).ok, true);
});

test('abloesen: Datei bleibt, Markierung mit Grund, Suche und Zugkopf blenden aus, Wiederholen harmlos', async () => {
  const { g, ordner, a } = aufbau();
  const r = await g.merken({ text: 'Der Hub läuft auf Port 30840 im Cluster.', quelle: 'doku' });
  const neu = await g.merken({ text: 'Der Hub läuft auf Port 31840 im Cluster, Zugriff über NodePort.', quelle: 'doku2' });
  assert.equal(neu.ok, true, 'verschieden genug');
  assert.match((await g.abloesen({ id: r.id, grund: '' })).grund, /Grund/);
  assert.match((await g.abloesen({ id: 'f-gibtsnicht', grund: 'x' })).grund, /Unbekannt/);
  assert.match((await g.abloesen({ id: r.id, grund: 'widerlegt', durch: 'f-nix' })).grund, /unbekannte/);
  const ab = await g.abloesen({ id: r.id, grund: 'widerlegt durch Messung', durch: neu.id });
  assert.equal(ab.ok, true);
  assert.equal(ab.index, 'ok');
  assert.equal(existsSync(join(ordner, 'fakten', `${r.id}.json`)), true, 'nie stilles Löschen');
  const f = JSON.parse(readFileSync(join(ordner, 'fakten', `${r.id}.json`), 'utf8'));
  assert.equal(f.abgeloest.grund, 'widerlegt durch Messung');
  assert.equal(f.abgeloest.durch, neu.id);
  assert.equal((await g.abloesen({ id: r.id, grund: 'nochmal' })).schon, true);

  assert.doesNotMatch(g.indexText(), new RegExp(r.id));
  assert.match(g.indexText(), new RegExp(neu.id));
  const ohne = await g.suchen({ frage: 'Hub Port', art: 'fakt' });
  assert.deepEqual(ohne.treffer.map((t) => t.id), [neu.id]);
  const mit = await g.suchen({ frage: 'Hub Port', art: 'fakt', abgeloeste: true });
  assert.equal(mit.treffer.length, 2);
  assert.equal([...a.s.punkte.values()].find((p) => p.payload.kennung === r.id).payload.abgeloest, true);
  assert.equal(g.zustand().abgeloest, 1);
});

test('suchen: Hybrid-Anfrage trägt den Mandantenfilter, Filter für Art und Zeit, Dateien bleiben Wahrheit', async () => {
  const { g, a, ordner } = aufbau();
  await g.merken({ text: 'Hauptserver hat zwei Grafikkarten, GPU0 für Hausmodell.', quelle: 'doku' });
  await g.merken({ text: 'Die Lektion: Backup-Prüfung läuft sonntags um drei.', quelle: 'Besitzer, 2026-10-24', art: 'lektion' });
  // Fremder Mandant im Index und im Ordner
  mkdirSync(join(ordner, 'fakten'), { recursive: true });
  writeFileSync(join(ordner, 'fakten', 'f-fremd.json'), JSON.stringify({ id: 'f-fremd', art: 'fakt', agent: 'castor', text: 'Hauptserver Grafikkarten gehören Castor', quelle: 'x', reife: 'feldnotiz', erste_nennung: 'a', letzte_bestaetigung: 'a' }));
  const r = await g.suchen({ frage: 'Grafikkarten Hauptserver', art: 'alle', von: '2026-10-01', bis: '2026-10-31T23:59:59Z' });
  assert.equal(r.quelle, 'index');
  assert.equal(r.treffer.length, 2);
  assert.ok(!r.treffer.some((t) => t.id === 'f-fremd'));
  const q = a.s.aufrufe.filter((x) => x.pfad.endsWith('/points/query')).at(-1).rumpf;
  assert.deepEqual(q.filter.must[0], { key: 'agent', match: { value: 'persona' } });
  assert.deepEqual(q.filter.must_not, [{ key: 'abgeloest', match: { value: true } }]);
  assert.equal(q.prefetch.length, 2);
  assert.deepEqual(q.prefetch.map((p) => p.using), ['dense', 'lex']);
  assert.deepEqual(q.query, { fusion: 'rrf' });
  assert.ok(q.filter.must.some((c) => c.key === 'zeit' && c.range.gte === '2026-10-01'));
  const nurLektion = await g.suchen({ frage: 'Backup Prüfung', art: 'lektion' });
  assert.deepEqual(nurLektion.treffer.map((t) => t.art), ['lektion']);
  assert.deepEqual(a.s.aufrufe.filter((x) => x.pfad.endsWith('/points/query')).at(-1).rumpf.filter.must.find((c) => c.key === 'art').match, { any: ['lektion'] });
});

test('Abruf-Zähler: je verschiedene Frage einmal; 3 Abrufe aus 3 Fragen = übernahmereif (Hinweis, Reife bleibt)', async () => {
  const { g, ordner } = aufbau();
  const r = await g.merken({ text: 'Die Pflegeliste speist die Arbeitsschleife nur als zusätzlichen Eingang.', quelle: 'plan' });
  const lies = () => JSON.parse(readFileSync(join(ordner, 'fakten', `${r.id}.json`), 'utf8'));
  await g.suchen({ frage: 'Pflegeliste Arbeitsschleife' });
  await g.suchen({ frage: 'pflegeliste arbeitsschleife!' }); // dieselbe Frage (normalisiert)
  assert.equal(lies().abrufe, 1);
  assert.equal(g.pflegePunkte().length, 0);
  await g.suchen({ frage: 'Wer speist die Arbeitsschleife' });
  assert.equal(lies().abrufe, 2);
  await g.suchen({ frage: 'zusätzlicher Eingang Pflegeliste' });
  const f = lies();
  assert.equal(f.abrufe, 3);
  assert.equal(f.reife, 'feldnotiz', 'keine Automatik');
  const punkte = g.pflegePunkte();
  assert.equal(punkte.length, 1);
  assert.equal(punkte[0].abgeleitet, true);
  assert.match(punkte[0].titel, /Übernahme prüfen/);
  const wz = new Map(gedaechtnisWerkzeuge(g).map((t) => [t.name, t]));
  const out = (await wz.get('gedaechtnis_suchen').execute({ anfrage: 'noch eine Frage zur Pflegeliste Arbeitsschleife' }, {})).output[0].text;
  assert.match(out, /ÜBERNAHMEREIF/);
  assert.match(out, /Besitzer entscheidet/);
});

test('Qdrant nicht erreichbar: Schreiben klappt in Dateien, Suche meldet es und sucht in Dateien, später wird nachgeholt', async () => {
  const { g, a } = aufbau({ aus: true });
  const r = await g.merken({ text: 'Die Probe gegen den echten Qdrant ist ein eigener Schritt.', quelle: 'doku' });
  assert.equal(r.ok, true);
  assert.equal(r.index, 'offen');
  assert.match(r.fehler, /ECONNREFUSED/);
  assert.equal(g.zustand().qdrant_ok, false);
  assert.equal(g.zustand().index_offen, 1);

  const s = await g.suchen({ frage: 'Probe echten Qdrant' });
  assert.equal(s.quelle, 'dateien');
  assert.match(s.fehler, /ECONNREFUSED/);
  assert.equal(s.treffer.length, 1);
  const wz = new Map(gedaechtnisWerkzeuge(g).map((t) => [t.name, t]));
  assert.match((await wz.get('gedaechtnis_suchen').execute({ anfrage: 'Probe Qdrant' }, {})).output[0].text, /ACHTUNG: Index nicht erreichbar/);
  assert.match((await wz.get('gedaechtnis_merken').execute({ text: 'Noch ein Fakt, der nur in der Datei landet.', quelle: 'q' }, {})).output[0].text, /nur in der Datei/);
  assert.match(g.indexText(), /Probe gegen den echten Qdrant/, 'Zugkopf kommt aus den Dateien');

  a.s.aus = false;
  const ab = await g.abgleichen();
  assert.equal(ab.gesendet, 2);
  assert.equal(ab.offen, 0);
  assert.equal(g.zustand().qdrant_ok, true);
  assert.equal(a.s.punkte.size, 2);
  const nochmal = await g.abgleichen();
  assert.equal(nochmal.gesendet, 0);
});

test('Prompt-Abschnitt: einsicht und Lektionen zuerst, Zeilen- und Zeichendeckel, abgelöste fehlen, ohne Zähler im Text', async () => {
  const { g } = aufbau({ deckel: { prompt_zeilen: 3 } });
  assert.match(g.indexText(), /noch leer/);
  await g.merken({ text: 'Erster Fakt über die Wolkenbildung am Morgen im Tal.', quelle: 'a' });
  await g.merken({ text: 'Zweiter Fakt über die Bahnhofsuhr im alten Dorf.', quelle: 'b' });
  await g.merken({ text: 'Dritter Fakt über Bienenstöcke hinter dem Haus.', quelle: 'c' });
  const e = await g.merken({ text: 'Vierter Fakt: Besitzer bestätigt Dateien als Wahrheit.', quelle: 'Besitzer', reife: 'einsicht', max_bestaetigt: true });
  const l = await g.merken({ text: 'Lektion: erst suchen, dann antworten, Quelle nennen.', quelle: 'Besitzer', art: 'lektion' });
  const text1 = g.indexText();
  const zeilen = text1.split('\n').filter((z) => z.startsWith('- '));
  assert.equal(zeilen.length, 3);
  assert.match(zeilen[0], new RegExp(e.id));
  assert.match(zeilen[0], /einsicht/);
  assert.match(text1, /… und 2 weitere/);
  assert.match(zeilen[1], new RegExp(l.id), 'Lektion (nicht bestätigt) kommt vor den Fakten');
  await g.suchen({ frage: 'Bienenstöcke Haus' });
  assert.equal(g.indexText(), text1, 'Abrufe ändern den Zugkopf nicht (Cache)');

  const s = gedaechtnisSektionen(g);
  assert.deepEqual(s.map((x) => x.key), ['gedaechtnis']);
  assert.equal(s[0].render({}, {}), text1);
  const klein = aufbau({ deckel: { prompt_zeichen: 200 } }).g;
  await klein.merken({ text: 'Ein ziemlich langer Satz '.repeat(5) + 'Ende eins.', quelle: 'q1' });
  await klein.merken({ text: 'Ein ganz anderer sehr langer Text '.repeat(5) + 'Ende zwei.', quelle: 'q2' });
  assert.ok(klein.indexText().split('\n').filter((z) => z.startsWith('- ')).length <= 1);
});

test('aus: weder Abschnitt noch Werkzeuge noch Schreiben; zustand sagt aus', async () => {
  const { g } = aufbau({ an: false });
  assert.deepEqual(gedaechtnisSektionen(g), []);
  assert.deepEqual(gedaechtnisWerkzeuge(g), []);
  assert.deepEqual(g.zustand(), { an: false, fakten: 0, letzte_aufnahme: null, qdrant_ok: null });
  assert.equal(g.index, null);
  assert.equal(await g.episodeSchreiben({ tag: '2026-10-25', gespraech: 'x', text: 'y' }), null);
  const e = ginnyErweiterung({ cfg: aufbau({ an: false }).cfg, gedaechtnis: g, env: {} });
  assert.ok(!e.tools.some((t) => t.name === 'gedaechtnis_suchen'));
  assert.ok(!e.sections.some((s) => s.key === 'gedaechtnis'));
});

test('an: ginnyErweiterung bringt Abschnitt und vier Werkzeuge', () => {
  const { g, cfg } = aufbau();
  const e = ginnyErweiterung({ cfg, gedaechtnis: g, env: {} });
  for (const n of ['gedaechtnis_suchen', 'gedaechtnis_merken', 'gedaechtnis_abloesen', 'pflegeliste']) assert.ok(e.tools.some((t) => t.name === n), n);
  assert.ok(e.sections.some((s) => s.key === 'gedaechtnis'));
});

test('Werkzeuge: merken, Dublette, ähnlich, ablösen in Klartext', async () => {
  const { g } = aufbau();
  const wz = new Map(gedaechtnisWerkzeuge(g).map((t) => [t.name, t]));
  const m = (p) => wz.get('gedaechtnis_merken').execute(p, {});
  const r1 = (await m({ text: ZEHN, quelle: 'q1' })).output[0].text;
  assert.match(r1, /^Gemerkt: f-[0-9a-f]{10} \[feldnotiz\], im Index/);
  assert.match((await m({ text: ZEHN, quelle: 'q2' })).output[0].text, /^Bestätigt/);
  assert.match((await m({ text: `${ZEHN} Und mehr.`, quelle: 'q3' })).output[0].text, /Nicht gemerkt\. Sehr ähnlich/);
  const id = r1.match(/f-[0-9a-f]{10}/)[0];
  const ab = (await wz.get('gedaechtnis_abloesen').execute({ id, grund: 'überholt' }, {})).output[0].text;
  assert.match(ab, new RegExp(`${id} abgelöst`));
  assert.match((await wz.get('gedaechtnis_suchen').execute({ anfrage: 'Gedächtnis Dateien Qdrant' }, {})).output[0].text, /Nichts gefunden/);
});

test('Pflegeliste: eintragen (Dublette gleich), fällig nach Zeit, wiederkehrend rückt, verschieben, erledigt, Deckel', () => {
  const { g, uhr } = aufbau({ deckel: { pflege: 10 } });
  const a = g.pflegeEintragen({ titel: 'Morgenlage vorbereiten', antrieb: 'zeit', faellig: '2026-10-26T07:30:00Z', takt_s: 86_400, zweck: 'Alarme, Boots' });
  const b = g.pflegeEintragen({ titel: 'Morgenlage  vorbereiten', antrieb: 'zeit' });
  assert.equal(b.id, a.id);
  assert.equal(b.neu, false);
  const c = g.pflegeEintragen({ titel: 'Freigaben prüfen', antrieb: 'weltblick' }); // ohne Termin: sofort fällig
  g.pflegeEintragen({ titel: 'Besitzer fragen wegen Termin', antrieb: 'max', faellig: '2026-10-25T09:00:00Z' });
  assert.match(g.pflegeEintragen({ titel: 'x', antrieb: 'zeit' }).grund, /Titel/);
  assert.match(g.pflegeEintragen({ titel: 'Fehler im Antrieb', antrieb: 'laune' }).grund, /antrieb/);
  assert.match(g.pflegeEintragen({ titel: 'Kaputter Termin', faellig: 'morgen früh' }).grund, /Zeitpunkt/);
  assert.match(g.pflegeEintragen({ titel: 'Token: ghp_abcdefghijklmnop merken' }).grund, /Zugangsdatum/); // sauber: ok (Testattrappe)

  const jetzt = g.pflegePunkte();
  assert.deepEqual(jetzt.map((p) => p.id).sort(), [c.id, g.pflegeAlle().find((p) => p.antrieb === 'max').id].sort());
  assert.equal(jetzt[0].antrieb, 'max', 'längste Überfälligkeit zuerst');
  assert.deepEqual(g.pflegePunkte({ antrieb: 'weltblick' }).map((p) => p.id), [c.id]);
  assert.equal(g.pflegePunkte({ jetzt: Date.parse('2026-10-26T08:00:00Z') }).some((p) => p.id === a.id), true);

  const e = g.pflegeErledigen({ id: a.id, ergebnis: 'Alarme: 0' });
  assert.equal(e.wiederkehrend, true);
  assert.equal(e.naechste, '2026-10-27T07:30:00.000Z');
  g.pflegeErledigen({ id: c.id, ergebnis: 'ok' });
  assert.equal(g.pflegePunkte().some((p) => p.id === c.id), false);
  assert.equal(g.pflegeAlle().find((p) => p.id === c.id).status, 'erledigt');
  assert.match(g.pflegeErledigen({ id: 'p-nix' }).grund, /Unbekannt/);

  const maxId = g.pflegeAlle().find((p) => p.antrieb === 'max').id;
  assert.equal(g.pflegeVerschieben({ id: maxId, bis: '2026-10-30T00:00:00Z' }).ok, true);
  assert.equal(g.pflegePunkte().some((p) => p.id === maxId), false);
  uhr.t = Date.parse('2026-10-31T00:00:00Z');
  assert.equal(g.pflegePunkte().some((p) => p.id === maxId), true);

  for (let i = 0; i < 12; i++) g.pflegeEintragen({ titel: `Weiterer Punkt Nummer ${i} bitte`, antrieb: 'zeit' });
  assert.match(g.pflegeEintragen({ titel: 'Der Zuviele Punkt hier', antrieb: 'zeit' }).grund, /voll/);
});

test('Werkzeug pflegeliste: liste, faellig, eintragen, erledigt, verschieben', async () => {
  const { g } = aufbau();
  const p = new Map(gedaechtnisWerkzeuge(g).map((t) => [t.name, t])).get('pflegeliste');
  const ruf = async (x) => (await p.execute(x, {})).output[0].text;
  assert.match(await ruf({ aktion: 'liste' }), /leer/);
  assert.match(await ruf({ aktion: 'faellig' }), /Nichts fällig/);
  const t = await ruf({ aktion: 'eintragen', titel: 'Backup-Prüfung ansehen', antrieb: 'zeit', zweck: 'Sonntag' });
  const id = t.match(/p-[0-9a-f]{10}/)[0];
  assert.match(await ruf({ aktion: 'faellig' }), /Backup-Prüfung/);
  assert.match(await ruf({ aktion: 'verschieben', id, bis: '2027-01-01T00:00:00Z' }), /Verschoben/);
  assert.match(await ruf({ aktion: 'faellig' }), /Nichts fällig/);
  assert.match(await ruf({ aktion: 'erledigt', id, ergebnis: 'fertig' }), /Erledigt/);
  assert.match(await ruf({ aktion: 'liste' }), /erledigt/);
});

test('Tagesprotokoll: Episode aus dem Gesprächsverlauf, redigiert, ohne Argumente, mit Quellenverweisen, auffindbar', async () => {
  const { g, ordner } = aufbau();
  const pr = new Tagesprotokoll({ gedaechtnis: g, jetzt: () => T0, log: () => {} });
  const eingang = { kind: 'fyos.eingang', data: { stromId: 's1', quelle: 'chat', von: 'max', klasse: 'max', text: 'Prüf bitte das Backup, mein Passwort: hunter2geheim ist egal' } };
  pr.beobachte('haupt-1', { type: 'message_end', entry: eingang });
  pr.beobachte('haupt-1', { type: 'message_start' });
  pr.beobachte('haupt-1', { type: 'tool_execution_end', toolName: 'bash', toolCallId: 'c1', args: { command: 'echo ghp_abcdefghijklmnopqr' }, entry: { data: { isError: true } } }); // sauber: ok (Testattrappe)
  pr.beobachte('haupt-1', { type: 'tool_execution_end', toolName: 'hub_aufrufen', toolCallId: 'c2' });
  pr.beobachte('haupt-1', { type: 'message_update', changes: [{ type: 'text_delta', delta: 'Backup ist grün. Token Bearer abcdefghijklmnop123 bleibt draußen.' }] });
  pr.beobachte('haupt-1', { type: 'message_end', entry: { model: [] } });
  assert.equal(existsSync(ordner), false, 'vor dem Zugende wird nichts geschrieben');
  pr.beobachte('haupt-1', { type: 'run_end' });
  await pr.aufWarten();
  const datei = join(ordner, 'episoden', '2026-10-25', 'haupt-1.json');
  assert.equal(existsSync(datei), true);
  const ep = JSON.parse(readFileSync(datei, 'utf8'));
  assert.equal(ep.art, 'episode');
  assert.equal(ep.agent, 'persona');
  assert.match(ep.text, /1 Zug\./);
  assert.match(ep.text, /Mit: Besitzer\./);
  assert.match(ep.text, /Anlass: chat: „Prüf bitte das Backup/);
  assert.match(ep.text, /Werkzeuge: bash 1, hub_aufrufen 1\./);
  assert.match(ep.text, /Fehlgeschlagene Werkzeugaufrufe: 1\./);
  assert.match(ep.text, /Backup ist grün/);
  assert.doesNotMatch(JSON.stringify(ep), /hunter2geheim|ghp_|abcdefghijklmnop123|echo /);
  assert.deepEqual(ep.quellen, ['s1', 'aufruf:c1']);
  assert.deepEqual(ep.zaehler.werkzeuge, { bash: 1, hub_aufrufen: 1 });

  // zweiter Zug: dieselbe Episode wird fortgeschrieben, nicht verdoppelt
  pr.beobachte('haupt-1', { type: 'run_end' });
  await pr.aufWarten();
  assert.equal(JSON.parse(readFileSync(datei, 'utf8')).zaehler.zuege, 2);
  assert.equal(readdirSync(join(ordner, 'episoden', '2026-10-25')).length, 1);

  const s = await g.suchen({ frage: 'Backup grün', art: 'episode' });
  assert.equal(s.quelle, 'index');
  assert.equal(s.treffer[0].id, 'e-2026-10-25-haupt-1');
  assert.equal(g.zustand().episoden, 1);
});

test('Tagesprotokoll: Tageszeile aus der Aufzeichnung, nur Zahlen; Tageswechsel schließt den Vortag ab', async () => {
  const { g, w, uhr } = aufbau();
  const auf = join(w, 'auf');
  mkdirSync(auf);
  const zeilen = [
    { t: 1, art: 'eingang', ereignis: { quelle: 'ha', typ: 'tuer' } },
    { t: 2, art: 'eingang', ereignis: { quelle: 'ha' } },
    { t: 3, art: 'eingang', ereignis: { quelle: 'chat' } },
    { t: 4, art: 'zug' },
    { t: 5, art: 'entscheidung' },
    { t: 6, art: 'welt' },
  ];
  writeFileSync(join(auf, 'aufzeichnung-2026-10-25.jsonl'), `${zeilen.map((z) => JSON.stringify(z)).join('\n')}\nkaputt\n`);
  assert.equal(aufzeichnungZaehlen(auf, '2026-10-24'), null);
  assert.deepEqual(aufzeichnungZaehlen(auf, '2026-10-25').eingang_quellen, { ha: 2, chat: 1 });
  const pr = new Tagesprotokoll({ gedaechtnis: g, aufzeichnung: { ordner: auf }, jetzt: () => uhr.t, log: () => {} });
  pr.beobachte('c', { type: 'run_end' }); // setzt den Tag
  await pr.aufWarten();
  uhr.t += 86_400_000;
  pr.beobachte('c', { type: 'run_end' }); // neuer Tag: 25. wird abgeschlossen
  await pr.aufWarten();
  const tag = JSON.parse(readFileSync(join(g.ordner, 'episoden', '2026-10-25', 'tag.json'), 'utf8'));
  assert.match(tag.text, /6 Zeilen\. Eingänge \(ha 2, chat 1\); 1 Züge, 1 Reflex-Entscheidungen, 1 Weltbilder\./);
  assert.deepEqual(tag.quellen, ['aufzeichnung-2026-10-25.jsonl']);
});

test('Tagesprotokoll: ausgeschaltetes Gedächtnis schreibt nichts, Fehler werfen nicht', async () => {
  const aus = aufbau({ an: false });
  const pr = new Tagesprotokoll({ gedaechtnis: aus.g, log: () => {} });
  pr.beobachte('x', { type: 'run_end' });
  await pr.aufWarten();
  assert.equal(existsSync(aus.ordner), false);
  const an = aufbau();
  an.g.episodeSchreiben = async () => {
    throw new Error('Platte voll');
  };
  const meldungen = [];
  const pr2 = new Tagesprotokoll({ gedaechtnis: an.g, jetzt: () => T0, log: (z) => meldungen.push(z) });
  pr2.beobachte('x', { type: 'run_end' });
  pr2.beobachte(undefined, null);
  await pr2.aufWarten();
  assert.match(meldungen.join('\n'), /Platte voll/);
});

test('Index: legt die Sammlung an (Mandantenindex), prüft Form, wirft ehrlich bei Fehlern', async () => {
  const a = attrappe();
  const idx = new GedaechtnisIndex({ url: 'http://q:6333', collection: 'persona_gedaechtnis', embedUrl: 'http://e:8080', fetch: a.fetch });
  await idx.bereitmachen();
  const put = a.s.aufrufe.filter((x) => x.methode === 'PUT');
  assert.equal(put[0].pfad, '/collections/persona_gedaechtnis');
  assert.deepEqual(put[0].rumpf.vectors, { dense: { size: 768, distance: 'Cosine' } });
  assert.deepEqual(put[0].rumpf.sparse_vectors, { lex: { modifier: 'idf' } });
  assert.deepEqual(put[1].rumpf, { field_name: 'agent', field_schema: { type: 'keyword', is_tenant: true } });
  assert.ok(put.some((x) => x.rumpf.field_name === 'zeit' && x.rumpf.field_schema === 'datetime'));
  await idx.bereitmachen();
  assert.equal(a.s.aufrufe.filter((x) => x.methode === 'PUT').length, put.length, 'nur einmal');

  await assert.rejects(() => idx.suchen('', { frage: 'x' }), /ohne Agent/);

  const falsch = attrappe();
  falsch.s.sammlung = 'persona_gedaechtnis';
  falsch.s.form = { vectors: { dense: { size: 1024 } }, sparse_vectors: { lex: {} } };
  const i2 = new GedaechtnisIndex({ url: 'http://q:6333', fetch: falsch.fetch });
  await assert.rejects(() => i2.bereitmachen(), /nicht die erwartete Form/);
  assert.equal(falsch.s.aufrufe.filter((x) => x.methode === 'PUT').length, 0, 'nichts überschrieben');

  const ohneAnlegen = new GedaechtnisIndex({ url: 'http://q:6333', fetch: attrappe().fetch, anlegen: false });
  await assert.rejects(() => ohneAnlegen.bereitmachen(), /HTTP 404/);

  const schlecht = { ok: false, status: 503, text: async () => 'weg' };
  const i3 = new GedaechtnisIndex({ url: 'http://q:6333', fetch: async () => schlecht });
  await assert.rejects(() => i3.einbetten(['a'], 'anfrage'), /Einbetter HTTP 503/);
  const kurz = new GedaechtnisIndex({ fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }) }) });
  await assert.rejects(() => kurz.einbetten(['a'], 'anfrage'), /768/);
});

test('Konfiguration: aus als Vorgabe, Umgebung schaltet und setzt Orte, Deckel begrenzt', () => {
  const vorgabe = konfigurationLaden({}, {}).pi_durable.gedaechtnis;
  assert.equal(vorgabe.an, false);
  assert.equal(vorgabe.ordner, '/var/lib/fyos-agent/gedaechtnis');
  assert.equal(vorgabe.collection, 'persona_gedaechtnis');
  assert.equal(vorgabe.qdrant_url, '');
  assert.equal(vorgabe.deckel.fakten, 1000);
  const env = { FYOS_GEDAECHTNIS: 'an', FYOS_GEDAECHTNIS_DIR: '/tmp/gx', QDRANT_URL: 'http://q:6333/', FYOS_GEDAECHTNIS_COLLECTION: 'probe', EMBED_EG2_URL: 'http://e:8080/' };
  const g = konfigurationLaden({ pi_durable: { gedaechtnis: { deckel: { treffer: 999, fakten: 1 } } } }, env).pi_durable.gedaechtnis;
  assert.deepEqual([g.an, g.ordner, g.qdrant_url, g.collection, g.embed_url], [true, '/tmp/gx', 'http://q:6333', 'probe', 'http://e:8080']);
  assert.equal(g.deckel.treffer, 30);
  assert.equal(g.deckel.fakten, 10);
  assert.equal(konfigurationLaden({ pi_durable: { gedaechtnis: { an: 'ja' } } }, {}).pi_durable.gedaechtnis.an, false, 'nur echtes true schaltet');
});

test('zustand: an, Zahlen, letzte Aufnahme, Qdrant-Stand', async () => {
  const { g } = aufbau();
  assert.deepEqual(g.zustand(), { an: true, fakten: 0, abgeloest: 0, episoden: 0, pflege_faellig: 0, letzte_aufnahme: null, qdrant_ok: null, index_offen: 0, fehler: null });
  await g.merken({ text: ZEHN, quelle: 'q' });
  const z = g.zustand();
  assert.equal(z.fakten, 1);
  assert.equal(z.qdrant_ok, true);
  assert.equal(z.letzte_aufnahme, '2026-10-25T10:00:00.000Z');
  const ohne = aufbau({ ohneIndex: true });
  await ohne.g.merken({ text: ZEHN, quelle: 'q' });
  assert.equal(ohne.g.zustand().index_offen, null);
  assert.equal((await ohne.g.suchen({ frage: 'Dateien Qdrant Index' })).quelle, 'dateien');
});
