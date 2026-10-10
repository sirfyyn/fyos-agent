import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {erzeugeBudget, istRuhezeit, registerMeldebudget, sitzungsart, STANDARD, tagesschluessel} from './budget.mjs';

// 2026-10-02 ist Sommerzeit: 12:00 UTC = 14:00 in Berlin.
const MITTAG = Date.parse('2026-10-02T12:00:00Z');
const NACHT = Date.parse('2026-10-02T20:30:00Z');      // 22:30 Berlin
const FRUEH = Date.parse('2026-10-03T04:59:00Z');      // 06:59 Berlin
const MORGEN = Date.parse('2026-10-03T05:00:00Z');     // 07:00 Berlin

function neu(start = MITTAG, cfg = {}) {
  let jetzt = start;
  const dir = mkdtempSync(join(tmpdir(), 'meldebudget-'));
  const budget = erzeugeBudget({cfg, zustandsdatei: join(dir, 'zustand.json'), uhr: () => jetzt, logger: {}});
  return {budget, dir, setze: (t) => { jetzt = t; }, vor: (ms) => { jetzt += ms; }};
}

test('Ruhezeit 22-7 Uhr Berlin, ueber Mitternacht', () => {
  assert.equal(istRuhezeit(MITTAG, STANDARD), false);
  assert.equal(istRuhezeit(NACHT, STANDARD), true);
  assert.equal(istRuhezeit(FRUEH, STANDARD), true);
  assert.equal(istRuhezeit(MORGEN, STANDARD), false);
  assert.equal(tagesschluessel(Date.parse('2026-10-02T22:30:00Z'), 'Europe/Berlin'), '2026-10-03');
});

test('Sitzungsarten', () => {
  assert.equal(sitzungsart('agent:main:main'), 'main');
  assert.equal(sitzungsart('agent:main:dashboard:abc'), 'dashboard');
  assert.equal(sitzungsart('agent:main:vorgang-chg-3702'), 'vorgang');
  assert.equal(sitzungsart('agent:main:cron:4644b4d1'), 'cron');
  assert.equal(sitzungsart(undefined), 'ohne');
});

test('fuenf proaktive Meldungen am Tag, die sechste wird gesperrt', () => {
  const {budget, vor} = neu();
  for (let i = 1; i <= 5; i += 1) {
    const e = budget.senden(`agent:main:cron:job${i}`);
    assert.equal(e.aktion, 'zaehlen');
    assert.equal(e.gezaehlt, i);
    vor(60_000);
  }
  const sechste = budget.senden('agent:main:cron:job6');
  assert.deepEqual([sechste.aktion, sechste.grund], ['sperren', 'tagesbudget']);
});

test('neuer Tag setzt den Zaehler zurueck', () => {
  const {budget, setze} = neu();
  for (let i = 0; i < 5; i += 1) budget.senden(`agent:main:cron:j${i}`);
  setze(MORGEN);
  assert.equal(budget.senden('agent:main:cron:neu').aktion, 'zaehlen');
  assert.equal(budget.stand().gezaehlt, 1);
});

test('Ruhezeit sperrt proaktive Meldungen, auch gebuendelte', () => {
  const {budget, setze} = neu(Date.parse('2026-10-02T19:55:00Z')); // 21:55
  assert.equal(budget.senden('agent:main:cron:a').aktion, 'zaehlen');
  setze(Date.parse('2026-10-02T20:01:00Z')); // 22:01, innerhalb des Buendelfensters
  assert.deepEqual(budget.senden('agent:main:cron:a').grund, 'ruhezeit');
  assert.equal(budget.senden(undefined).grund, 'ruhezeit');
});

test('Antwort auf den Besitzer zaehlt nicht und ist nachts erlaubt', () => {
  const {budget, vor} = neu(NACHT);
  budget.eingang('agent:main:main');
  budget.laufBeginn('lauf-1', 'agent:main:main', 'user');
  vor(30 * 60_000); // langer Lauf: 30 Minuten
  assert.deepEqual(budget.senden('agent:main:main'), {aktion: 'durchlassen', grund: 'antwort'});
  budget.laufEnde('lauf-1');
  vor(9 * 60_000);
  assert.equal(budget.senden('agent:main:main').grund, 'antwort');
  vor(2 * 60_000); // Antwortfenster (10 min) abgelaufen
  assert.equal(budget.senden('agent:main:main').grund, 'ruhezeit');
  assert.equal(budget.stand().gezaehlt, 0);
});

test('Antwort in einer Gruppe nach eingehender Nachricht', () => {
  const {budget} = neu(NACHT);
  budget.eingang('agent:main:matrix:group:!raum');
  assert.equal(budget.senden('agent:main:matrix:group:!raum').grund, 'antwort');
});

test('Vorgangs-, Cron- und Heartbeat-Laeufe sind nie Antworten', () => {
  const {budget} = neu();
  budget.laufBeginn('r1', 'agent:main:vorgang-chg-1', 'user');
  budget.eingang('agent:main:cron:x');
  assert.equal(budget.senden('agent:main:vorgang-chg-1').aktion, 'zaehlen');
  assert.equal(budget.senden('agent:main:cron:x').aktion, 'zaehlen');
  budget.laufBeginn('r2', 'agent:main:main', 'heartbeat');
  assert.equal(budget.senden('agent:main:main').aktion, 'zaehlen');
});

test('Teilnachrichten derselben Meldung zaehlen einmal', () => {
  const {budget, vor} = neu();
  assert.equal(budget.senden('agent:main:cron:a').aktion, 'zaehlen');
  vor(60_000);
  assert.equal(budget.senden('agent:main:cron:a').grund, 'buendel');
  vor(5 * 60_000);
  assert.equal(budget.senden('agent:main:cron:a').aktion, 'zaehlen');
  assert.equal(budget.stand().gezaehlt, 2);
});

test('Fehler beim Zustand sperrt proaktiv (fail-closed), Antworten bleiben frei', () => {
  const budget = erzeugeBudget({zustandsdatei: '/nicht/vorhanden/verzeichnis/zustand.json', uhr: () => MITTAG, logger: {}});
  assert.deepEqual(budget.senden('agent:main:cron:a'), {aktion: 'sperren', grund: 'meldebudget_fehler'});
  budget.eingang('agent:main:main');
  assert.equal(budget.senden('agent:main:main').grund, 'antwort');
});

test('Zustand liegt mit Rechten 600 und ohne Inhalte', () => {
  const {budget, dir} = neu();
  budget.senden('agent:main:cron:a');
  const datei = join(dir, 'zustand.json');
  assert.equal(statSync(datei).mode & 0o777, 0o600);
  const z = JSON.parse(readFileSync(datei, 'utf8'));
  assert.deepEqual(Object.keys(z.protokoll[0]).sort(), ['aktion', 'gezaehlt', 'grund', 'sitzung', 'zeit']);
});

test('Hooks: message_sending sperrt mit Grund, Antwort laeuft durch', async () => {
  const hooks = {};
  const methoden = {};
  const api = {pluginConfig: {}, logger: {info() {}, warn() {}, error() {}},
    on: (name, fn) => { hooks[name] = fn; },
    registerGatewayMethod: (name, fn) => { methoden[name] = fn; }};
  const dir = mkdtempSync(join(tmpdir(), 'meldebudget-api-'));
  registerMeldebudget(api, {verzeichnis: dir, uhr: () => NACHT});
  assert.deepEqual(await hooks.message_sending({content: 'x'}, {sessionKey: 'agent:main:cron:a'}),
    {cancel: true, cancelReason: 'meldebudget:ruhezeit'});
  await hooks.message_received({}, {sessionKey: 'agent:main:main'});
  assert.equal(await hooks.message_sending({content: 'x'}, {sessionKey: 'agent:main:main'}), undefined);
  assert.equal(methoden['fyos.meldebudget.stand']().ruhezeitJetzt, true);
});

test('Dringend: eine Freigabe des Waechters bricht Ruhezeit und Budget, nur fuer eine Automationssitzung', () => {
  const {budget, dir, setze} = neu(NACHT);
  const sitzung = 'agent:main:cron:wache-1';
  assert.equal(budget.senden(sitzung).grund, 'ruhezeit');
  writeFileSync(join(dir, 'dringend.json'), JSON.stringify({bis: NACHT + 15 * 60_000, von: 'wache'}));
  // Hauptsitzung und Vorgaenge nehmen die Freigabe nie
  assert.equal(budget.senden('agent:main:main').grund, 'ruhezeit');
  assert.equal(budget.senden('agent:main:vorgang-chg-1').grund, 'ruhezeit');
  const e = budget.senden(sitzung);
  assert.equal(e.aktion, 'zaehlen');
  assert.equal(e.grund, 'dringend');
  assert.equal(JSON.parse(readFileSync(join(dir, 'dringend.json'), 'utf8')).sitzung, sitzung);
  assert.equal(budget.senden(sitzung).grund, 'dringend');                  // Teilnachricht derselben Sitzung
  assert.equal(budget.senden('agent:main:cron:andere').grund, 'ruhezeit'); // an die erste Sitzung gebunden
  setze(NACHT + 16 * 60_000);
  assert.equal(budget.senden(sitzung).grund, 'ruhezeit');                  // abgelaufen
});

test('Dringend auch ueber dem Tagesbudget; eine kaputte Freigabe gilt nicht', () => {
  const {budget, dir} = neu();
  for (let i = 0; i < 5; i += 1) budget.senden(`agent:main:cron:x${i}`);
  assert.equal(budget.senden('agent:main:cron:y').grund, 'tagesbudget');
  writeFileSync(join(dir, 'dringend.json'), '{kaputt');
  assert.equal(budget.senden('agent:main:cron:y').grund, 'tagesbudget');
  writeFileSync(join(dir, 'dringend.json'), JSON.stringify({bis: MITTAG + 60_000}));
  const e = budget.senden('agent:main:cron:y');
  assert.equal(e.grund, 'dringend');
  assert.equal(e.gezaehlt, 6);
});

test('ungueltige Einstellungen werden beim Start abgelehnt', () => {
  assert.throws(() => erzeugeBudget({cfg: {ruheVon: '25:00'}, zustandsdatei: '/tmp/x'}));
  assert.throws(() => erzeugeBudget({cfg: {zeitzone: 'Mond/Basis'}, zustandsdatei: '/tmp/x'}));
});
