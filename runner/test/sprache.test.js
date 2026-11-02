import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sprache, antwortVon, freigabeEntscheidungVon, freigabeStimmeErlaubt, freigabeText, istStoppWort, sperreAus } from '../src/sprache.js';

const warte = (ms) => new Promise((r) => setTimeout(r, ms));
const TAG = Date.UTC(2026, 9, 26, 10, 0, 0); // Montag 11 Uhr in Berlin
const NACHT = Date.UTC(2026, 9, 26, 22, 30, 0); // 23:30 in Berlin

function fakeRunner() {
  const r = {
    root: { id: 1 },
    gesendet: [],
    abgebrochen: [],
    entschieden: [],
    freigabenListe: [],
    listener: null,
    async sende(id, text, opt) {
      r.gesendet.push({ id, text, opt });
      return { id: 's1' };
    },
    async abbrechen(id) {
      r.abgebrochen.push(id);
    },
    async watchConversation() {
      return { snapshot: {}, start: (fn) => (r.listener = fn), stop: async () => {} };
    },
    async freigaben() {
      return r.freigabenListe;
    },
    async entscheideFreigabe(id, o) {
      r.entschieden.push({ id, ...o });
    },
  };
  return r;
}

function bau({ cfg = {}, zeit = TAG, ...rest } = {}) {
  const uhr = { t: zeit };
  const runner = fakeRunner();
  const s = new Sprache({ cfg: { sprache: { sprechen: { quittungMs: 0 }, ...cfg } }, runner, jetzt: () => uhr.t, log: () => {}, ...rest });
  const ev = [];
  s.beiEreignis((e) => ev.push(e));
  return { s, runner, uhr, ev, typen: (t) => ev.filter((e) => e.typ === t) };
}

const airpods = (s, client = 'iphone', extra = {}) => s.ausgabeMelden({ client, route: 'airpods', geraet: 'Besitzer’ AirPods Pro', ...extra });
const antwortStrom = (s, ...deltas) =>
  s.beiEreignisse([
    { type: 'message_start', message: { role: 'assistant' } },
    ...deltas.map((delta) => ({ type: 'message_update', changes: [{ type: 'text_delta', contentIndex: 0, delta }] })),
    { type: 'message_end', entry: { model: [{ role: 'assistant' }] } },
  ]);

test('Wörter: Stopp, Ja, Später, Nein, Freigabe strikt', () => {
  assert.equal(istStoppWort('Stopp!'), true);
  assert.equal(istStoppWort('Stopp die Stimme auf Hauptserver'), false);
  assert.equal(antwortVon('Ja, bitte.'), 'ja');
  assert.equal(antwortVon('Nicht jetzt'), 'spaeter');
  assert.equal(antwortVon('Nein danke'), 'nein');
  assert.equal(antwortVon('vielleicht'), null);
  assert.equal(freigabeEntscheidungVon('Ja'), 'erteilt');
  assert.equal(freigabeEntscheidungVon('Lehn CHG-1234 ab'), null, 'lange Sätze entscheiden nie');
  assert.equal(freigabeEntscheidungVon('Nein'), 'abgelehnt');
});

test('Freigabe-Regeln: nur niedrig/mittel und nicht zerstörerisch; Text ohne Befehl', () => {
  assert.equal(freigabeStimmeErlaubt({ risiko: 'low' }), true);
  assert.equal(freigabeStimmeErlaubt({ risiko: 'medium' }), true);
  assert.equal(freigabeStimmeErlaubt({ risiko: 'high' }), false);
  assert.equal(freigabeStimmeErlaubt({ risiko: 'low', zerstoererisch: true }), false);
  assert.equal(freigabeStimmeErlaubt({}), false);
  const t = freigabeText({ aktion: 'Dienst neu starten', kontext: 'Er hängt seit Stunden.', risiko: 'medium', befehl: 'systemctl restart x' });
  assert.match(t, /Dienst neu starten/);
  assert.match(t, /mittel/);
  assert.match(t, /Sag ja oder nein/);
  assert.doesNotMatch(t, /systemctl/);
  assert.match(freigabeText({ aktion: 'x', risiko: 'high' }), /in der App/);
});

test('AirPods-Regel: nur Name oder gebundene UID, frisch, getragen', () => {
  const { s, uhr } = bau({ cfg: { ausgabe: { uids: ['AA:BB'] } } });
  assert.equal(s.ausgabeMelden({ client: 'mac', route: 'airpods', geraet: 'MacBook-Lautsprecher' }).route, 'andere');
  assert.equal(s.airpodsAktiv('mac'), false);
  assert.equal(s.ausgabeMelden({ client: 'mac', route: 'airpods', geraet: 'Kopfhörer von Besitzer', uid: 'AA:BB' }).airpods_aktiv, true, 'gebundene UID genügt');
  assert.equal(airpods(s, 'iphone').airpods_aktiv, true);
  assert.equal(airpods(s, 'iphone', { getragen: false }).airpods_aktiv, false, 'abgelegt');
  airpods(s, 'iphone');
  uhr.t += 91_000;
  assert.equal(s.airpodsAktiv('iphone'), false, 'veraltete Meldung gilt nicht');
  assert.throws(() => s.ausgabeMelden({ route: 'lautsprecher' }), /route/);
  assert.equal(s.ausgabeMelden({ client: 'x', route: 'keine' }).airpods_aktiv, false);
});

test('Äußerung braucht eine offene Sitzung; Ruhe tief sperrt', async () => {
  const { s } = bau({ sperre: { pausiert: () => true, grund: () => 'spielmodus.kid', sperrtMax: () => true } });
  await assert.rejects(s.aeusserung({ text: 'Hallo' }), (f) => f.status === 409);
  s.sitzungSetzen({ an: true, client: 'iphone', mikrofon: 'an' });
  await assert.rejects(s.aeusserung({ text: 'Hallo' }), (f) => f.status === 423);
  assert.throws(() => s.sitzungSetzen({ an: 'ja' }), /true oder false/);
});

test('Sitzung läuft nach Inaktivität ab', async () => {
  const { s, uhr, typen } = bau();
  s.sitzungSetzen({ an: true, client: 'iphone' });
  uhr.t += 16 * 60_000;
  await assert.rejects(s.aeusserung({ text: 'Hallo' }), (f) => f.status === 409);
  assert.equal(typen('sitzung').at(-1).grund, 'inaktiv');
});

test('Antwort wird satzweise gesprochen, Sprachprofil nur im Kopf, Eintrag trägt den Kanal', async () => {
  const { s, runner, typen } = bau();
  airpods(s);
  s.sitzungSetzen({ an: true, client: 'iphone' });
  const r = await s.aeusserung({ text: 'Wie spät ist es?', client: 'iphone' });
  assert.equal(r.weg, 'modell');
  assert.equal(runner.gesendet[0].text, 'Wie spät ist es?');
  assert.equal(runner.gesendet[0].opt.kanal, 'sprache');
  assert.equal(runner.gesendet[0].opt.art, 'steuern');
  assert.match(runner.gesendet[0].opt.kopf, /Kanal: Sprache/);
  assert.match(runner.gesendet[0].opt.kopf, /Keine Listen/);

  antwortStrom(s, 'Es ist **14:30** Uhr. Am 25. Oktober ', 'ist Sonntag. Details unter https://x.de/a.');
  runner.listener([{ type: 'run_end' }]);
  const sp = typen('sprechen');
  assert.deepEqual(sp.map((e) => e.text), ['Es ist vierzehn Uhr dreißig.', 'Am fünfundzwanzigsten Oktober ist Sonntag.', 'Details unter Link.']);
  assert.deepEqual(sp.map((e) => e.nr), [1, 2, 3]);
  assert.equal(sp[0].erste, true);
  assert.equal(sp[0].ziel, 'iphone');
  assert.equal(sp[0].zug, r.zug);
  assert.equal(typen('sprechen.ende').at(-1).vollstaendig, true);
  assert.equal(typen('sprechen.ende').at(-1).haeppchen, 3);
});

test('Ereignisse, die nicht zu unserem Zug gehören, werden nicht gesprochen', async () => {
  const { s, runner, typen } = bau();
  airpods(s);
  s.sitzungSetzen({ an: true, client: 'iphone' });
  antwortStrom(s, 'Niemand hat gefragt. ');
  assert.equal(typen('sprechen').length, 0);
  await s.aeusserung({ text: 'Hallo', client: 'iphone' });
  runner.listener([{ type: 'run_end' }]); // Ende des Zugs davor: zu früh, zählt nicht
  assert.equal(typen('sprechen.ende').length, 0);
  antwortStrom(s, 'Hallo Besitzer. ');
  runner.listener([{ type: 'run_end' }]);
  assert.equal(typen('sprechen').length, 1);
  assert.equal(typen('sprechen.ende').length, 1);
});

test('Ohne AirPods: nichts gesprochen, am Ende eine Mitteilung mit dem Text', async () => {
  const mit = [];
  const { s, runner, typen } = bau({ mitteilen: (m) => mit.push(m) });
  s.ausgabeMelden({ client: 'mac', route: 'andere', geraet: 'MacBook-Lautsprecher' });
  s.sitzungSetzen({ an: true, client: 'mac' });
  await s.aeusserung({ text: 'Status?', client: 'mac' });
  antwortStrom(s, 'Alles ruhig. Hausmodell schläft.');
  runner.listener([{ type: 'run_end' }]);
  assert.equal(typen('sprechen').length, 0, 'die harte Regel');
  const m = typen('mitteilung');
  assert.equal(m.length, 1);
  assert.equal(m[0].text, 'Alles ruhig. Hausmodell schläft.');
  assert.equal(m[0].grund, 'keine AirPods');
  assert.equal(mit.length, 1);
});

test('AirPods mitten in der Rede weg: Stopp-Ereignis, Rest wird Mitteilung', async () => {
  const { s, runner, typen } = bau();
  airpods(s);
  s.sitzungSetzen({ an: true, client: 'iphone' });
  await s.aeusserung({ text: 'Erzähl', client: 'iphone' });
  antwortStrom(s, 'Erster Satz. Zweiter Satz. ');
  s.ausgabeMelden({ client: 'iphone', route: 'andere', geraet: 'iPhone' });
  assert.equal(typen('sprechen.stopp').at(-1).grund, 'airpods-weg');
  antwortStrom(s, 'Dritter Satz.');
  runner.listener([{ type: 'run_end' }]);
  assert.equal(typen('sprechen').length, 2);
  assert.equal(typen('mitteilung')[0].text, 'Dritter Satz.');
});

test('Kurzquittung als Reflex, wenn das Modell schweigt oder ein Werkzeug läuft', async () => {
  const a = bau({ cfg: { sprechen: { quittungMs: 20 } } });
  airpods(a.s);
  a.s.sitzungSetzen({ an: true, client: 'iphone' });
  await a.s.aeusserung({ text: 'Mach mal', client: 'iphone' });
  await warte(60);
  const q = a.typen('sprechen').filter((e) => e.art === 'quittung');
  assert.equal(q.length, 1);
  assert.equal(q[0].text, 'Moment.');

  const b = bau();
  airpods(b.s);
  b.s.sitzungSetzen({ an: true, client: 'iphone' });
  await b.s.aeusserung({ text: 'Schau nach', client: 'iphone' });
  b.s.beiEreignisse([{ type: 'tool_execution_start', toolName: 'x' }]);
  assert.equal(b.typen('sprechen')[0].text, 'Ich schaue nach.');
  antwortStrom(b.s, 'Erledigt.');
  assert.equal(b.typen('sprechen').at(-1).art, 'antwort', 'die Quittung hält die Antwort nicht auf');
});

test('Listen, Code und Tabellen werden nicht vorgelesen; ein Hinweis bleibt', async () => {
  const { s, runner, typen } = bau();
  airpods(s);
  s.sitzungSetzen({ an: true, client: 'iphone' });
  await s.aeusserung({ text: 'Liste', client: 'iphone' });
  antwortStrom(s, 'Das ist da:\n- eins\n- zwei\n- drei\n- vier\n- fünf\n- sechs\n```sh\nrm -rf x\n```\nFertig.');
  runner.listener([{ type: 'run_end' }]);
  const texte = typen('sprechen').map((e) => e.text);
  assert.ok(!texte.some((t) => /rm|sechs|fünf/.test(t)), texte.join(' | '));
  assert.equal(texte.at(-1), 'Den Rest siehst du im Text.');
});

test('Schnellweg beantwortet ohne Modell', async () => {
  const { s, runner, typen } = bau({ schnellweg: async (t) => (t === 'Danke' ? { text: 'Gern.' } : null) });
  airpods(s);
  s.sitzungSetzen({ an: true, client: 'iphone' });
  const r = await s.aeusserung({ text: 'Danke', client: 'iphone' });
  assert.equal(r.weg, 'schnell');
  assert.equal(runner.gesendet.length, 0);
  assert.equal(typen('sprechen')[0].text, 'Gern.');
  assert.equal((await s.aeusserung({ text: 'Erkläre mir Quantenphysik', client: 'iphone' })).weg, 'modell');
});

test('Barge-in: Zug abbrechen, Teilantwort markieren, nächster Zug erfährt es', async () => {
  const { s, runner, typen } = bau();
  airpods(s);
  s.sitzungSetzen({ an: true, client: 'iphone' });
  await s.aeusserung({ text: 'Erzähl', client: 'iphone' });
  antwortStrom(s, 'Eins. Zwei. Drei. ');
  const r = await s.unterbrechen({ modus: 'abbrechen', gespielt: 1 });
  assert.equal(r.status, 'unterbrochen');
  assert.equal(r.teilantwort.gesprochen_bis, 1);
  assert.deepEqual(runner.abgebrochen, [1]);
  assert.equal(typen('sprechen.stopp').at(-1).grund, 'barge-in');
  assert.equal(typen('sprechen.ende').at(-1).vollstaendig, false);
  antwortStrom(s, 'Vier.');
  assert.equal(typen('sprechen').length, 3, 'nach dem Abbruch kommt nichts mehr');

  await s.aeusserung({ text: 'Nein, anders', client: 'iphone' });
  const kopf = runner.gesendet.at(-1).opt.kopf;
  assert.match(kopf, /unterbrochen/);
  assert.match(kopf, /Gesagt hast du: „Eins\.“/);
  assert.match(kopf, /Nicht mehr gesagt: „Zwei\. Drei\.“/);
  antwortStrom(s, 'Ok.');
  runner.listener([{ type: 'run_end' }]);
  await s.aeusserung({ text: 'Und noch was', client: 'iphone' });
  assert.doesNotMatch(runner.gesendet.at(-1).opt.kopf, /unterbrochen/, 'der Hinweis gilt einmal');
});

test('Sprechen über laufende Rede ist Barge-in: erst abbrechen, dann neuer Zug', async () => {
  const { s, runner, typen } = bau();
  airpods(s);
  s.sitzungSetzen({ an: true, client: 'iphone' });
  await s.aeusserung({ text: 'Erzähl', client: 'iphone' });
  antwortStrom(s, 'Eins. Zwei. ');
  await s.aeusserung({ text: 'Moment mal', client: 'iphone' });
  assert.equal(runner.abgebrochen.length, 1);
  assert.equal(runner.gesendet.length, 2);
  assert.equal(typen('sprechen.stopp').length, 1);
});

test('Anhalten und Fortsetzen: Häppchen werden zurückgehalten und nachgereicht', async () => {
  const { s, typen } = bau();
  airpods(s);
  s.sitzungSetzen({ an: true, client: 'iphone' });
  await s.aeusserung({ text: 'Erzähl', client: 'iphone' });
  antwortStrom(s, 'Eins. Zwei. ');
  assert.equal((await s.unterbrechen({ modus: 'fortfuehren' })).status, 'angehalten');
  antwortStrom(s, 'Drei. Vier. ');
  assert.equal(typen('sprechen').length, 2);
  const r = s.fortsetzen();
  assert.equal(r.nachgereicht, 2);
  assert.deepEqual(typen('sprechen').map((e) => e.text), ['Eins.', 'Zwei.', 'Drei.', 'Vier.']);
});

test('Stopp-Wort beendet alles, ohne das Modell zu fragen, und hält Proaktives eine Weile still', async () => {
  const { s, runner, typen } = bau({ cfg: { proaktiv: { an: true } } });
  airpods(s);
  s.sitzungSetzen({ an: true, client: 'iphone' });
  await s.aeusserung({ text: 'Erzähl', client: 'iphone' });
  antwortStrom(s, 'Eins. Zwei. ');
  const r = await s.aeusserung({ text: 'Stopp', client: 'iphone' });
  assert.equal(r.art, 'stopp');
  assert.equal(runner.gesendet.length, 1, 'Stopp geht nicht ans Modell');
  assert.equal(runner.abgebrochen.length, 1);
  assert.ok(typen('stopp').length === 1);
  const m = await s.melden({ text: 'Info', dringlichkeit: 'info' });
  assert.equal(m.entscheidung, 'gehalten');
  assert.match(m.grund, /Stopp/);
});

// --- Proaktiv --------------------------------------------------------------------------------

const proaktiv = (extra = {}, rest = {}) => bau({ cfg: { proaktiv: { an: true, ...extra } }, ...rest });

test('Proaktiv ist standardmäßig aus: nur Mitteilung', async () => {
  const { s, typen } = bau();
  airpods(s);
  const r = await s.melden({ text: 'Hallo', dringlichkeit: 'wichtig' });
  assert.equal(r.entscheidung, 'text');
  assert.equal(typen('sprechen').length, 0);
  assert.equal(typen('mitteilung').length, 1);
  await assert.rejects(s.melden({ text: 'x', dringlichkeit: 'laut' }), /dringlichkeit/);
});

test('Proaktiv: Ruhe und Spielmodus lassen nur Text zu, Dringendes inklusive', async () => {
  const sperre = { pausiert: () => true, grund: () => 'spielmodus.kid', sperrtMax: () => true };
  const { s, typen } = proaktiv({}, { sperre });
  airpods(s);
  assert.equal((await s.melden({ text: 'a', dringlichkeit: 'info' })).entscheidung, 'gehalten');
  assert.equal((await s.melden({ text: 'b', dringlichkeit: 'dringend' })).entscheidung, 'text');
  assert.equal(typen('sprechen').length, 0);
});

test('Proaktiv: Aufmerksamkeits-Tor zu hält zurück, nicht prüfbar gilt als zu, Dringendes übergeht es', async () => {
  const art = [];
  const tor = { darf: async (a) => (art.push(a), false) };
  const { s, typen } = proaktiv({}, { tor });
  airpods(s);
  assert.equal((await s.melden({ text: 'a', dringlichkeit: 'info' })).entscheidung, 'gehalten');
  assert.ok(art.length >= 1 && art.every((a) => a === 'melden'), 'das Tor wird mit art melden gefragt');
  const d = await s.melden({ text: 'b', dringlichkeit: 'dringend' });
  assert.equal(d.entscheidung, 'gesprochen');
  assert.equal(typen('sprechen').at(-1).ton, 'dringend');
  const { s: s2 } = proaktiv({}, { tor: { darf: async () => { throw new Error('Hub weg'); } } });
  airpods(s2);
  assert.equal((await s2.melden({ text: 'a', dringlichkeit: 'info' })).entscheidung, 'gehalten');
});

test('Proaktiv: ohne AirPods wird Wichtiges Text, Info wartet; mit AirPods kommt es danach', async () => {
  const { s, typen } = proaktiv();
  assert.equal((await s.melden({ text: 'a', dringlichkeit: 'wichtig' })).entscheidung, 'text');
  assert.equal((await s.melden({ text: 'b', dringlichkeit: 'info' })).entscheidung, 'gehalten');
  airpods(s);
  await s.pruefen();
  const an = typen('sprechen').filter((e) => e.art === 'anfrage');
  assert.equal(an.length, 1, 'jetzt wird gefragt, nicht gleich gesprochen');
  assert.equal(an[0].ton, 'ping');
  assert.equal(an[0].ziel, 'iphone');
});

test('Proaktiv: Nachtruhe hält Info zurück, Dringendes spricht', async () => {
  const { s, typen } = proaktiv({}, { zeit: NACHT });
  airpods(s);
  const i = await s.melden({ text: 'a', dringlichkeit: 'info' });
  assert.equal(i.entscheidung, 'gehalten');
  assert.match(i.grund, /Nachtruhe/);
  assert.equal((await s.melden({ text: 'b', dringlichkeit: 'dringend' })).entscheidung, 'gesprochen');
  assert.equal(typen('sprechen').length, 1);
});

test('Proaktiv: im Kalendertermin und wenn Besitzer nicht am Gerät sitzt', async () => {
  const { s } = proaktiv({}, { kalender: { beschaeftigt: () => ({ beschaeftigt: true }) } });
  airpods(s);
  assert.match((await s.melden({ text: 'a', dringlichkeit: 'wichtig' })).grund, /Termin/);
  const b = proaktiv();
  airpods(b.s, 'iphone', { aktiv_s: 3600 });
  assert.match((await b.s.melden({ text: 'a', dringlichkeit: 'info' })).grund, /nicht am Gerät/);
});

test('Proaktiv: Darf ich? – Ja spricht, Freigabe-Kontext inklusive', async () => {
  const { s, runner, typen } = proaktiv();
  airpods(s);
  runner.freigabenListe = [{ id: 'F1', status: 'offen', aktion: 'Dienst neu starten', kontext: 'Er hängt.', risiko: 'low' }];
  const r = await s.melden({ text: 'Eine Freigabe wartet', dringlichkeit: 'wichtig', freigabeId: 'F1', bezug: 'freigabe:F1' });
  assert.equal(r.entscheidung, 'angefragt');
  assert.equal(typen('sprechen')[0].art, 'anfrage');
  const a = await s.aeusserung.call(s, { text: 'ja bitte', client: 'iphone' }).catch((f) => f);
  assert.equal(a.status, 409, 'ohne Sitzung gibt es keine Äußerung');
  s.sitzungSetzen({ an: true, client: 'iphone' });
  const a2 = await s.aeusserung({ text: 'Ja bitte', client: 'iphone' });
  assert.equal(a2.art, 'anfrage-antwort');
  const texte = typen('sprechen').map((e) => e.text).join(' ');
  assert.match(texte, /Dienst neu starten/);
  assert.match(texte, /Sag ja oder nein/);
  assert.deepEqual(s.zustand().erwartet, { typ: 'freigabe', id: 'F1' });
  // und die Entscheidung per Stimme
  const e = await s.aeusserung({ text: 'Ja', client: 'iphone' });
  assert.equal(e.art, 'freigabe');
  assert.deepEqual(runner.entschieden, [{ id: 'F1', entscheidung: 'erteilt', notiz: 'per Stimme über AirPods', von: 'stimme' }]);
  assert.equal(runner.gesendet.length, 0);
});

test('Proaktiv: Nein verlängert die Abkühlzeit, zweimal Nein macht die Quelle stumm, Ja entspannt', async () => {
  const { s, uhr } = proaktiv({ abkuehlungMin: 10 });
  airpods(s);
  s.sitzungSetzen({ an: true, client: 'iphone' });
  await s.melden({ text: 'a', dringlichkeit: 'info', quelle: 'itsm', bezug: 'x1' });
  await s.antwort({ antwort: 'nein' });
  assert.equal(s.zustand().proaktiv.nein_zaehler, 1);
  assert.ok(s.zustand().proaktiv.abkuehlung_bis);
  const w = await s.melden({ text: 'b', dringlichkeit: 'info', quelle: 'itsm', bezug: 'x2' });
  assert.match(w.grund, /Abkühlzeit/);
  uhr.t += 11 * 60_000;
  airpods(s);
  await s.pruefen();
  assert.equal(s.zustand().proaktiv.anfrage !== null, true);
  await s.antwort({ antwort: 'nein' });
  assert.equal(s.zustand().proaktiv.nein_zaehler, 2);
  assert.deepEqual(s.zustand().proaktiv.stumme_quellen, ['itsm']);
  uhr.t += 25 * 60_000;
  airpods(s);
  const stumm = await s.melden({ text: 'c', dringlichkeit: 'info', quelle: 'itsm', bezug: 'x3' });
  assert.equal(stumm.entscheidung, 'text');
  assert.equal((await s.melden({ text: 'd', dringlichkeit: 'dringend', quelle: 'itsm', bezug: 'x4' })).entscheidung, 'gesprochen', 'Dringendes ist nie stumm');
});

test('Proaktiv: Schweigen auf die Frage zieht sich zurück; Später kommt wieder', async () => {
  const { s, uhr, typen } = proaktiv();
  airpods(s, 'iphone');
  await s.melden({ text: 'a', dringlichkeit: 'wichtig', bezug: 'a' });
  uhr.t += 16_000;
  airpods(s, 'iphone');
  await s.pruefen();
  assert.equal(s.zustand().proaktiv.anfrage, null);
  assert.equal(typen('mitteilung').length, 1, 'Wichtiges wird Text');
  assert.equal(s.zustand().proaktiv.nein_zaehler, 1);

  const b = proaktiv({ abkuehlungMin: 0 });
  airpods(b.s);
  await b.s.melden({ text: 'z', dringlichkeit: 'wichtig', bezug: 'z' });
  await b.s.antwort({ antwort: 'spaeter' });
  assert.match(b.s.zustand().proaktiv.wartend[0].grund, /später/);
  b.uhr.t += 31 * 60_000;
  airpods(b.s);
  await b.s.pruefen();
  assert.equal(b.s.zustand().proaktiv.anfrage !== null, true);
});

test('Proaktiv: höchstens N ungebetene Ansprachen pro Stunde', async () => {
  const { s, uhr } = proaktiv({ maxProStunde: 2, abkuehlungMin: 0 });
  airpods(s);
  for (const n of [1, 2]) {
    const r = await s.melden({ text: `a${n}`, dringlichkeit: 'info', bezug: `r${n}` });
    assert.equal(r.entscheidung, 'angefragt');
    await s.antwort({ antwort: 'ja' });
  }
  const dritte = await s.melden({ text: 'a3', dringlichkeit: 'info', bezug: 'r3' });
  assert.equal(dritte.entscheidung, 'gehalten');
  assert.match(dritte.grund, /pro Stunde/);
  uhr.t += 61 * 60_000;
  airpods(s);
  await s.pruefen();
  assert.equal(s.zustand().proaktiv.anfrage !== null, true);
});

test('Proaktiv: gleicher Bezug binnen zehn Minuten wird verworfen; Info verfällt', async () => {
  const { s, uhr } = proaktiv({ infoVerfaelltMin: 5 });
  assert.equal((await s.melden({ text: 'a', dringlichkeit: 'info', bezug: 'k' })).entscheidung, 'gehalten');
  assert.equal((await s.melden({ text: 'a', dringlichkeit: 'info', bezug: 'k' })).entscheidung, 'verworfen');
  uhr.t += 6 * 60_000;
  await s.pruefen();
  assert.equal(s.zustand().proaktiv.wartend.length, 0);
});

test('Freigabe per Stimme: nur vorgelesen, nur AirPods, nie hoch oder zerstörerisch', async () => {
  const { s, runner, typen } = bau();
  runner.freigabenListe = [
    { id: 'A', status: 'offen', aktion: 'Klein', risiko: 'low', kontext: 'Harmlos.' },
    { id: 'B', status: 'offen', aktion: 'Groß', risiko: 'high', kontext: 'Heikel.' },
    { id: 'C', status: 'offen', aktion: 'Löschen', risiko: 'low', zerstoererisch: true },
  ];
  airpods(s);
  await assert.rejects(s.entscheiden({ freigabeId: 'A', entscheidung: 'erteilt', client: 'iphone' }), (f) => f.status === 403, 'nicht vorgelesen');
  assert.equal((await s.freigabeVorlesen({ id: 'A', client: 'iphone' })).entscheidung_per_stimme, true);
  await assert.rejects(s.entscheiden({ freigabeId: 'A', entscheidung: 'erteilt', client: 'mac' }), (f) => f.status === 403, 'anderer Client');
  assert.equal(runner.entschieden.length, 0);
  assert.equal((await s.freigabeVorlesen({ id: 'B', client: 'iphone' })).entscheidung_per_stimme, false);
  await assert.rejects(s.entscheiden({ freigabeId: 'B', entscheidung: 'erteilt', client: 'iphone' }), (f) => f.status === 403);
  assert.equal((await s.freigabeVorlesen({ id: 'C', client: 'iphone' })).entscheidung_per_stimme, false);
  assert.match(typen('sprechen').map((e) => e.text).join(' '), /in der App/);
  await assert.rejects(s.freigabeVorlesen({ id: 'Z' }), (f) => f.status === 404);
  // Fenster abgelaufen
  await s.freigabeVorlesen({ id: 'A', client: 'iphone' });
  s.jetzt = () => TAG + 4 * 60_000;
  airpods(s);
  await assert.rejects(s.entscheiden({ freigabeId: 'A', entscheidung: 'erteilt', client: 'iphone' }), (f) => f.status === 403);
});

test('Freigabe ohne AirPods wird nicht gesprochen, sondern als Mitteilung gemeldet', async () => {
  const { s, runner, typen } = bau();
  runner.freigabenListe = [{ id: 'A', status: 'offen', aktion: 'Klein', risiko: 'low' }];
  const r = await s.freigabeVorlesen({ id: 'A' });
  assert.equal(r.gesprochen, false);
  assert.equal(typen('sprechen').length, 0);
  assert.equal(typen('mitteilung')[0].art, 'freigabe');
});

test('sperreAus: Ruhe-Schalter, wenn vorhanden, sonst Spielmodus', () => {
  let spiel = false;
  const spielmodus = { an: () => spiel, grund: () => (spiel ? 'spielmodus.kid' : null) };
  const ohne = sperreAus({ spielmodus });
  assert.equal(ohne.pausiert(), false);
  spiel = true;
  assert.equal(ohne.pausiert(), true);
  assert.equal(ohne.sperrtMax(), true);
  assert.equal(ohne.grund(), 'spielmodus.kid');
  spiel = false;
  const ruhe = { pausiert: () => true, sperrtMax: () => false, sperre: { grund: () => 'ruhe:Nacht' } };
  const mit = sperreAus({ ruhe, spielmodus });
  assert.equal(mit.pausiert(), true);
  assert.equal(mit.sperrtMax(), false);
  assert.equal(mit.grund(), 'ruhe:Nacht');
  spiel = true;
  assert.equal(mit.sperrtMax(), true, 'Spielmodus ist immer tief');
});

test('Zustand enthält keinen gesprochenen Text', async () => {
  const { s, runner } = bau();
  airpods(s);
  s.sitzungSetzen({ an: true, client: 'iphone' });
  await s.aeusserung({ text: 'Geheimes Wort Kolibri', client: 'iphone' });
  antwortStrom(s, 'Geheime Antwort Kolibri. ');
  runner.listener([{ type: 'run_end' }]);
  assert.doesNotMatch(JSON.stringify(s.zustand()), /Kolibri/);
});

test('Gelerntes überlebt einen Neustart (Datei)', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'sprache-'));
  try {
    const datei = join(dir, 'sprache.json');
    const a = proaktiv({}, { datei });
    airpods(a.s);
    await a.s.melden({ text: 'a', dringlichkeit: 'info', bezug: 'q' });
    await a.s.antwort({ antwort: 'nein' });
    const b = proaktiv({}, { datei });
    assert.equal(b.s.zustand().proaktiv.nein_zaehler, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
