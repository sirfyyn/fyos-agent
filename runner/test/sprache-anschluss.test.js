/**
 * E10 (Kalender, Mitteilungsweg) und E1 (Vorrang der Sprache auf GPU1): nur Schnittstellen und Adapter, geprüft mit Attrappen.
 * Nichts wird gelesen, gesendet oder gesprochen.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sprache, anschluesse, kalender, kettenSperre, mitteilung } from '../src/sprache.js';
import { istPrivat, matrixHubKanal, osKanal, schwaerzen } from '../src/sprache-anschluss.js';

const TAG = Date.UTC(2026, 9, 26, 10, 0, 0); // 11:00 in Berlin
const iso = (min) => new Date(TAG + min * 60_000).toISOString();

function hubAttrappe(antworten = {}) {
  const h = {
    aufrufe: [],
    async aufrufen(tool, arg, opt) {
      h.aufrufe.push({ tool, arg, opt });
      const a = antworten[tool];
      if (a instanceof Error) throw a;
      return typeof a === 'function' ? a(arg) : (a ?? { ok: true, result: {} });
    },
  };
  return h;
}

const TERMINE = {
  'leitstand.termine': {
    ok: true,
    result: {
      termine: [
        { titel: 'Planung Team', start: iso(-10), ende: iso(20), ganztaegig: false, ort: 'Raum 2' },
        { titel: 'Urlaub', start: '2026-10-26', ganztaegig: true },
        { titel: 'Arzt wegen Rücken', start: iso(120), ende: iso(150), visibility: 'private' },
        { titel: '[privat] Wohnungsbesichtigung', start: iso(60), ende: iso(90) },
        { titel: 'Review', start: iso(240), ende: iso(270) },
      ],
    },
  },
};

// --- Kalender -------------------------------------------------------------------------------------------

test('Kalender: im Termin heißt beschäftigt, ganztägige zählen nicht, kein Titel im Ergebnis, nur lesendes Werkzeug', async () => {
  const hub = hubAttrappe(TERMINE);
  const k = kalender({ hub });
  const r = await k.beschaeftigt(TAG);
  assert.equal(r.beschaeftigt, true);
  assert.equal(r.bis, iso(20));
  assert.doesNotMatch(JSON.stringify(r), /Planung|Raum|Urlaub/);
  assert.deepEqual(hub.aufrufe.map((a) => a.tool), ['leitstand.termine'], 'nur das lesende Termin-Werkzeug');
  assert.deepEqual(hub.aufrufe[0].arg, { tage: 2 });
  await k.beschaeftigt(TAG + 1000);
  assert.equal(hub.aufrufe.length, 1, 'zwischengespeichert (60 s)');
  assert.equal((await k.beschaeftigt(TAG + 25 * 60_000)).beschaeftigt, false, 'nach dem Termin frei');
  assert.equal((await k.beschaeftigt(TAG + 110 * 60_000)).beschaeftigt, false, 'ein Termin später liegt noch weit weg');
  assert.equal((await k.beschaeftigt(TAG + 59 * 60_000)).beschaeftigt, true, 'zwei Minuten Vorlauf vor dem privaten Termin');
});

test('Kalender: private Termine machen beschäftigt, werden aber nie genannt', async () => {
  const k = kalender({ hub: hubAttrappe(TERMINE) });
  const privat = await k.beschaeftigt(TAG + 70 * 60_000);
  assert.equal(privat.beschaeftigt, true, 'Besitzer ist im Termin');
  assert.doesNotMatch(JSON.stringify(privat), /Wohnung/);
  const naechste = await k.naechste(TAG, { n: 10 });
  const titel = naechste.map((t) => t.titel);
  assert.deepEqual(titel, ['Planung Team', 'Review'], 'private und ganztägige tauchen nicht auf');
  assert.doesNotMatch(JSON.stringify(naechste), /Arzt|Wohnung|Rücken/);
  assert.equal(istPrivat({ privat: true }), true);
  assert.equal(istPrivat({ sichtbarkeit: 'Vertraulich' }), true);
  assert.equal(istPrivat({ class: 'PRIVATE' }), true);
  assert.equal(istPrivat({ titel: 'Privat: Zahnarzt' }), true);
  assert.equal(istPrivat({ titel: 'Privatkundenbetreuung' }), true, 'im Zweifel zu viel verborgen, nie zu wenig');
  assert.equal(istPrivat({ titel: 'Review' }), false);
});

test('Kalender: das Hub-Feld sichtbarkeit entscheidet; nur oeffentlich wird genannt, Titel „privat“ gewinnt trotzdem', async () => {
  assert.equal(istPrivat({ titel: 'Review', sichtbarkeit: 'oeffentlich' }), false);
  assert.equal(istPrivat({ titel: 'Review', sichtbarkeit: 'privat' }), true);
  assert.equal(istPrivat({ titel: 'Review', sichtbarkeit: '' }), true, 'leer ist unbekannt, also privat');
  assert.equal(istPrivat({ titel: 'Review', sichtbarkeit: 'irgendwas' }), true, 'unbekannter Wert ist privat');
  assert.equal(istPrivat({ titel: 'Privat: Zahnarzt', sichtbarkeit: 'oeffentlich' }), true, 'die strengste Quelle gewinnt');
  assert.equal(istPrivat({ titel: 'Review' }), false, 'älterer Hub ohne Feld: wie bisher');
  assert.equal(istPrivat({ titel: 'Review' }, { strikt: true }), true, 'mit Pflicht zählt ein fehlendes Feld als privat');

  const termine = [
    { titel: 'Planung', start: iso(30), ende: iso(60), sichtbarkeit: 'oeffentlich' },
    { titel: 'Bank', start: iso(70), ende: iso(80), sichtbarkeit: 'privat' },
    { titel: 'Ohne Feld', start: iso(90), ende: iso(100) },
  ];
  const lose = kalender({ hub: hubAttrappe({ 'leitstand.termine': { ok: true, result: { termine } } }), jetzt: () => TAG });
  assert.deepEqual((await lose.naechste(TAG)).map((t) => t.titel), ['Planung', 'Ohne Feld']);
  const streng = kalender({ hub: hubAttrappe({ 'leitstand.termine': { ok: true, result: { termine } } }), sichtbarkeitPflicht: true, jetzt: () => TAG });
  const liste = await streng.naechste(TAG);
  assert.deepEqual(liste.map((t) => t.titel), ['Planung']);
  assert.doesNotMatch(JSON.stringify(liste), /Bank/);
  assert.equal((await streng.beschaeftigt(TAG + 75 * 60_000)).beschaeftigt, true, 'privat zählt als beschäftigt');
});

test('Kalender: Hub-Fehler und fehlender Kalender sind „unbekannt“, nicht „frei“ und nicht ein Fehler; kein Ersatz, der die App öffnet', async () => {
  const kaputt = hubAttrappe({ 'leitstand.termine': new Error('Hub weg') });
  const k1 = kalender({ hub: kaputt });
  assert.deepEqual(await k1.beschaeftigt(TAG), { beschaeftigt: false, bis: null, unbekannt: true });
  assert.match(k1.zustand().fehler, /Hub weg/);
  assert.deepEqual(kaputt.aufrufe.map((a) => a.tool), ['leitstand.termine']);
  await k1.beschaeftigt(TAG + 1000);
  assert.equal(kaputt.aufrufe.length, 1, 'ein toter Hub wird nicht bei jedem Aufruf neu gefragt');

  const keiner = hubAttrappe({ 'leitstand.termine': { ok: true, result: { termine: null, eingerichtet: false, hinweis: 'Kein Kalender eingerichtet' } } });
  const k2 = kalender({ hub: keiner });
  assert.equal((await k2.beschaeftigt(TAG)).unbekannt, true);
  assert.match(k2.zustand().fehler, /Kein Kalender/);

  const ablehnung = hubAttrappe({ 'leitstand.termine': { ok: false, fehler: 'Kalender ohne Zugang' }, 'termine.zeigen': { ok: true, result: { termine: [] } } });
  await kalender({ hub: ablehnung }).beschaeftigt(TAG);
  assert.ok(!ablehnung.aufrufe.some((a) => a.tool === 'termine.zeigen'), 'termine.zeigen öffnet die App und wird nur auf Wunsch gerufen');
  const mitErsatz = hubAttrappe({ 'leitstand.termine': { ok: false, fehler: 'x' }, 'termine.zeigen': { ok: true, result: { termine: [{ titel: 'A', start: iso(-5), ende: iso(5) }] } } });
  assert.equal((await kalender({ hub: mitErsatz, ersatz: 'termine.zeigen' }).beschaeftigt(TAG)).beschaeftigt, true);
});

test('Kalender: Bereiche nach Hub-Vorgabe, eigene Einengung nur auf Wunsch', async () => {
  const hub = hubAttrappe({
    'leitstand.termine': { ok: true, result: { termine: [{ titel: 'Büro', start: iso(-5), ende: iso(5), kalender: 'Arbeit' }, { titel: 'Sport', start: iso(30), ende: iso(60), kalender: 'Privat' }] } },
  });
  assert.equal((await kalender({ hub }).beschaeftigt(TAG + 40 * 60_000)).beschaeftigt, true, 'ohne Einengung zählt alles, was der Hub liefert');
  const nurArbeit = kalender({ hub, bereiche: ['arbeit'] });
  assert.equal((await nurArbeit.beschaeftigt(TAG + 40 * 60_000)).beschaeftigt, false);
  assert.equal((await nurArbeit.beschaeftigt(TAG)).beschaeftigt, true);
});

test('Kalender in der Richtlinie: im Termin hält eine Ansprache zurück, dringend übergeht es', async () => {
  const hub = hubAttrappe(TERMINE);
  const s = new Sprache({ cfg: { sprache: { proaktiv: { an: true, stille: { an: false } } } }, runner: { root: { id: 1 } }, kalender: kalender({ hub }), jetzt: () => TAG, log: () => {} });
  s.ausgabeMelden({ client: 'iphone', route: 'airpods', geraet: 'AirPods' });
  const r = await s.melden({ text: 'Der Build ist grün.', dringlichkeit: 'wichtig', quelle: 'ci' });
  assert.equal(r.entscheidung, 'gehalten');
  assert.equal(r.grund, 'im Termin');
  const d = await s.melden({ text: 'Hausmodell ist ausgefallen.', dringlichkeit: 'dringend', quelle: 'alarm' });
  assert.equal(d.entscheidung, 'gesprochen');
  assert.equal(s.zustand().kalender.quelle, 'leitstand.termine');
});

// --- Mitteilungsweg ---------------------------------------------------------------------------------------------

const m = (o = {}) => ({ text: 'Der Build ist grün.', dringlichkeit: 'wichtig', grund: 'keine AirPods', quelle: 'ci', bezug: 'job-1', art: 'proaktiv', zug: null, ...o });

test('Mitteilung: Info nur als Karte, Wichtiges auch auf Matrix, Dringendes mit hoher Dringlichkeit; Art und Bezug werden übersetzt', async () => {
  const hub = hubAttrappe();
  const mit = mitteilung({ hub });
  await mit(m({ dringlichkeit: 'info', bezug: 'a' }));
  assert.deepEqual(hub.aufrufe.map((a) => a.tool), ['os.mitteilen']);
  assert.equal(hub.aufrufe[0].arg.dringlichkeit, 'niedrig');
  assert.equal(hub.aufrufe[0].arg.quelle, 'sprache');

  hub.aufrufe.length = 0;
  const r = await mit(m({ bezug: 'b', art: 'fehler', text: 'Das hat nicht geklappt: Zeitüberschreitung.' }));
  assert.deepEqual(r.gesendet, ['os', 'matrix']);
  const matrix = hub.aufrufe.find((a) => a.tool === 'chat.matrix_senden').arg;
  assert.equal(matrix.art, 'befund');
  assert.equal(matrix.raum, 'ops');
  assert.equal(matrix.dringend, false);
  assert.equal(matrix.bezug, 'b');

  hub.aufrufe.length = 0;
  await mit(m({ bezug: 'c', dringlichkeit: 'dringend', art: 'proaktiv', text: 'Hausmodell ist ausgefallen.' }));
  assert.equal(hub.aufrufe.find((a) => a.tool === 'os.mitteilen').arg.dringlichkeit, 'hoch');
  assert.equal(hub.aufrufe.find((a) => a.tool === 'chat.matrix_senden').arg.dringend, true);
  assert.equal(mit.zustand().gesendet, 5);
});

test('Mitteilung: Antworten auf Besitzer’ eigene Frage bleiben im Client; gleiche Meldung nicht doppelt; Zugangsdaten werden geschwärzt', async () => {
  const hub = hubAttrappe();
  const mit = mitteilung({ hub });
  assert.match((await mit(m({ art: 'antwort' }))).uebersprungen, /bleibt im Client/);
  assert.equal(hub.aufrufe.length, 0);
  await mit(m({ text: 'Fehler: Authorization: Bearer abcdefghijkl1234567890 und Schlüssel ABCDEFGH12345678abcdefgh12345678ZZZZ', art: 'fehler', bezug: 'x' }));
  const gesendet = JSON.stringify(hub.aufrufe);
  assert.doesNotMatch(gesendet, /abcdefghijkl1234567890|ABCDEFGH12345678abcdefgh12345678ZZZZ/);
  assert.match(gesendet, /\*\*\*/);
  hub.aufrufe.length = 0;
  assert.match((await mit(m({ art: 'fehler', bezug: 'x', text: 'Fehler: Authorization: Bearer abcdefghijkl1234567890 und Schlüssel ABCDEFGH12345678abcdefgh12345678ZZZZ' }))).uebersprungen, /vor Kurzem/);
  assert.equal(hub.aufrufe.length, 0);
  assert.equal(schwaerzen('token=geheim123 und Passwort: hunter2'), 'token=*** und Passwort: ***');
});

test('Mitteilung: ein Kanal fällt aus, die anderen laufen; Matrix hat ein Stundenlimit (Dringendes nicht); trocken sendet nichts', async () => {
  const hub = hubAttrappe({ 'os.mitteilen': { ok: false, fehler: 'Gerät aus' } });
  const mit = mitteilung({ hub, matrixProStunde: 2 });
  const r = await mit(m({ bezug: '1' }));
  assert.deepEqual(r.gesendet, ['matrix']);
  assert.match(mit.zustand().fehler.os, /Gerät aus/);
  await mit(m({ bezug: '2' }));
  const dritte = await mit(m({ bezug: '3' }));
  assert.deepEqual(dritte.gesendet, [], 'Limit erreicht');
  const dringend = await mit(m({ bezug: '4', dringlichkeit: 'dringend' }));
  assert.ok(dringend.gesendet.includes('matrix'), 'Dringendes geht durch');

  const still = hubAttrappe();
  const trocken = mitteilung({ hub: still, trocken: true });
  const t = await trocken(m());
  assert.deepEqual(t.gesendet, ['os:trocken', 'matrix:trocken']);
  assert.equal(still.aufrufe.length, 0);
  assert.equal(trocken.zustand().protokoll.length, 2);
  assert.doesNotMatch(JSON.stringify(trocken.zustand()), /Build ist grün/, 'der Zustand enthält keinen Text');
});

test('Mitteilung: Kanäle aus freigabe-meldung.js (Vertrag senden(n)) lassen sich ohne Änderung einhängen', async () => {
  const empfangen = [];
  const ntfy = { name: 'ntfy', async senden(n) { empfangen.push(n); return { ok: true }; } };
  const mit = mitteilung({ hub: hubAttrappe(), kanaele: [], extra: [ntfy] });
  const r = await mit(m({ art: 'freigabe', text: 'Freigabe offen: Dienst neu starten. Das entscheidest du in der App.', bezug: 'freigabe:fr-1' }));
  assert.deepEqual(r.gesendet, ['ntfy']);
  assert.equal(empfangen[0].titel, 'Freigabe wartet');
  assert.equal(empfangen[0].dringend, false);
  assert.equal(empfangen[0].bezug, 'freigabe:fr-1');
  assert.ok('link' in empfangen[0] && 'text' in empfangen[0]);
});

test('Mitteilung in der Sitzung: ohne AirPods geht der Text an den Kanal; ohne eingetragene Kanäle gibt es keinen Weg', async () => {
  const hub = hubAttrappe();
  const a = anschluesse({ cfg: { sprache: { mitteilung: { kanaele: ['os'] } } }, hub });
  assert.ok(a.kalender && typeof a.mitteilen === 'function');
  const s = new Sprache({ cfg: { sprache: { proaktiv: { an: false } } }, runner: { root: { id: 1 } }, mitteilen: a.mitteilen, jetzt: () => TAG, log: () => {} });
  await s.melden({ text: 'Der Backup-Lauf ist fertig.', dringlichkeit: 'info', quelle: 'backup' }); // proaktiv aus → Text
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(hub.aufrufe.map((x) => x.tool), ['os.mitteilen']);
  assert.equal(s.zustand().mitteilung.kanaele[0], 'os');

  const leer = anschluesse({ cfg: {}, hub });
  assert.equal(leer.mitteilen, null, 'Vorgabe: keine Kanäle, nichts wird gesendet');
  assert.ok(leer.kalender, 'der Kalender (nur lesen) ist dabei');
  assert.equal(anschluesse({ cfg: { sprache: { kalender: { an: false } } }, hub }).kalender, null);
  assert.equal(osKanal(hub).name, 'os');
  assert.equal(matrixHubKanal(hub).ab, 'wichtig');
});

// --- Vorrang auf GPU1 -----------------------------------------------------------------------------------------------

function vorrangBau(cfg = {}) {
  const uhr = { t: TAG };
  const runner = { root: { id: 1 }, async sende() {}, async abbrechen() {}, async watchConversation() { return { start: (fn) => (runner.listener = fn), stop: async () => {} }; } };
  const s = new Sprache({ cfg: { sprache: { sprechen: { quittungMs: 0 }, ...cfg } }, runner, jetzt: () => uhr.t, log: () => {} });
  const ev = [];
  s.beiEreignis((e) => ev.push(e));
  return { s, runner, uhr, ev };
}

test('Vorrang GPU1: ohne Sitzung aus; mit Zug oder Nachlauf aktiv; danach wieder frei; ein Ereignis je Wechsel', async () => {
  const { s, runner, uhr, ev } = vorrangBau();
  assert.deepEqual({ aktiv: s.vorrang().aktiv, grund: s.vorrang().grund }, { aktiv: false, grund: 'keine Sprachsitzung' });
  s.ausgabeMelden({ client: 'iphone', route: 'airpods', geraet: 'AirPods' });
  s.sitzungSetzen({ an: true, client: 'iphone' });
  assert.equal(s.vorrang().aktiv, false, 'eine offene Sitzung allein genügt nicht');
  await s.aeusserung({ text: 'Hallo Persona', client: 'iphone' });
  assert.equal(s.vorrang().aktiv, true);
  assert.equal(s.vorrang().grund, 'Zug läuft');
  runner.listener([{ type: 'message_start', message: { role: 'assistant' } }, { type: 'message_update', changes: [{ type: 'text_delta', delta: 'Hallo Besitzer. ' }] }, { type: 'message_end', entry: { model: [{ role: 'assistant' }] } }, { type: 'run_end' }]);
  assert.equal(s.vorrang().grund, 'Nachlauf', 'nach der Rede bleibt es 20 Sekunden');
  uhr.t += 19_000;
  assert.equal(s.vorrang().aktiv, true);
  uhr.t += 2_000;
  assert.equal(s.vorrang().aktiv, false);
  assert.equal(s.vorrang().grund, 'ruhig');
  await s.pruefen();
  assert.deepEqual(ev.filter((e) => e.typ === 'vorrang').map((e) => e.aktiv), [true, false]);
  assert.equal(s.zustand().vorrang.aktiv, false);
  s.sitzungSetzen({ an: false });
  assert.equal(s.vorrang().aktiv, false);
});

test('Vorrang GPU1: sperrtProvider für die Provider-Kette – nur der Ersatzdenker, nur bei Vorrang, der Sprach-Agent ist ausgenommen', async () => {
  const { s } = vorrangBau({ agent: { an: false } });
  const sperrt = kettenSperre(s);
  s.ausgabeMelden({ client: 'iphone', route: 'airpods', geraet: 'AirPods' });
  s.sitzungSetzen({ an: true, client: 'iphone' });
  assert.equal(sperrt('ersatzdenker'), false, 'ruhig: nichts gesperrt');
  await s.aeusserung({ text: 'Hallo', client: 'iphone' });
  assert.equal(sperrt('ersatzdenker'), true);
  assert.equal(sperrt('hausmodell'), false, 'Hausmodell läuft auf GPU0 und bleibt');
  assert.equal(sperrt('ersatzdenker', { gespraech: 3 }), true, 'andere Gespräche warten');
  s.agent.id = 9;
  assert.equal(sperrt('ersatzdenker', { gespraech: 9 }), false, 'der Sprach-Agent selbst darf den Ersatzdenker nutzen');
  s.cfg.vorrang_gpu1.sprachAgentAusnahme = false;
  assert.equal(sperrt('ersatzdenker', { gespraech: 9 }), true);
});

test('Vorrang GPU1: abschaltbar und andere Provider-Namen einstellbar', async () => {
  const aus = vorrangBau({ vorrang_gpu1: { an: false } });
  aus.s.ausgabeMelden({ client: 'iphone', route: 'airpods', geraet: 'AirPods' });
  aus.s.sitzungSetzen({ an: true, client: 'iphone' });
  await aus.s.aeusserung({ text: 'Hallo', client: 'iphone' });
  assert.equal(aus.s.vorrang().aktiv, false);
  assert.equal(aus.s.vorrang().grund, 'aus');
  assert.equal(aus.s.sperrtProvider('ersatzdenker'), false);

  const anders = vorrangBau({ vorrang_gpu1: { providers: ['katy'], nachlaufS: 5 } });
  anders.s.ausgabeMelden({ client: 'iphone', route: 'airpods', geraet: 'AirPods' });
  anders.s.sitzungSetzen({ an: true, client: 'iphone' });
  await anders.s.aeusserung({ text: 'Hallo', client: 'iphone' });
  assert.equal(anders.s.sperrtProvider('katy'), true);
  assert.equal(anders.s.sperrtProvider('ersatzdenker'), false);
});
