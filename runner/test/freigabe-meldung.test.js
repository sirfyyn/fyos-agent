/**
 * Tests der Freigabe-Meldung: jede neue offene Freigabe genau einmal (auch über Neustarts), Erinnerung mit wachsendem
 * Abstand, Ruhezeit und Bündeln, hohes Risiko immer, Texte ohne Geheimnisse, Befehl nur im Besitzer-Kanal, Ausfall eines Kanals.
 * Matrix und ntfy sind Attrappen (kein Netz, nichts wird gesendet).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxProvider } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { konfigurationLaden } from '../src/config.js';
import { Freigaben, neueFreigabe } from '../src/documents.js';
import {
  FreigabeMeldung,
  erinnerungsAbstand,
  istRuhezeit,
  konfigNormalisieren,
  matrixKanal,
  nachrichtBauen,
  ntfyKanal,
  schwaerzen,
} from '../src/freigabe-meldung.js';
import { Runner } from '../src/runner.js';
import { wachenLesen } from '../src/wachen-zustand.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
// 15.07.2026 10:00 UTC = 12:00 in Berlin (Sommerzeit), also keine Ruhezeit.
const T0 = Date.UTC(2026, 6, 15, 10, 0, 0);
// 21:30 UTC = 23:30 Berlin (Ruhezeit); 05:30 UTC des Folgetags = 07:30 Berlin (vorbei).
const NACHTS = Date.UTC(2026, 6, 15, 21, 30, 0);
const MORGENS = Date.UTC(2026, 6, 16, 5, 30, 0);

const still = { info() {}, warn() {} };

function freigabe(id, extra = {}) {
  return { ...neueFreigabe({ id, conversationId: 1, aktion: `Aktion ${id}`, risiko: 'medium', kontext: 'Kontext', ...extra }), erstellt: extra.erstellt ?? T0 };
}

function speicherMem() {
  const d = { freigabemeldung: {} };
  return {
    d,
    lesen: async () => JSON.parse(JSON.stringify(d)),
    aendern: async (fn) => {
      fn(d);
    },
  };
}

/** Kanal-Attrappe: merkt sich die Nachrichten; `ok.wert = false` lässt ihn ausfallen. */
function stub(name, { befehl = false } = {}) {
  const k = {
    name,
    befehl,
    kontextMax: 200,
    gesendet: [],
    ok: { wert: true },
    async senden(n) {
      if (!k.ok.wert) return { ok: false, grund: 'kaputt' };
      k.gesendet.push(n);
      return { ok: true };
    },
  };
  return k;
}

function aufbau({ kanaele, liste, extra = {}, speicher = speicherMem(), start = T0 }) {
  const uhr = { t: start };
  const konfig = konfigNormalisieren({ kanaele: kanaele.map((k) => k.name), ...extra });
  const bau = () => new FreigabeMeldung({ konfig, kanaele, freigaben: async () => liste, speicher, log: still, jetzt: () => uhr.t });
  return { uhr, speicher, liste, bau, w: bau() };
}

test('Konfiguration: Vorgabe aus, Liste oder Komma-Text, aus gewinnt, unbekannte Kanäle fallen weg', () => {
  assert.deepEqual(konfigNormalisieren(undefined).kanaele, []);
  assert.deepEqual(konfigNormalisieren({ kanaele: ['Matrix', 'ntfy', 'sms'] }).kanaele, ['matrix', 'ntfy']);
  assert.deepEqual(konfigNormalisieren({ kanaele: 'matrix, ntfy' }).kanaele, ['matrix', 'ntfy']);
  assert.deepEqual(konfigNormalisieren({ kanaele: ['matrix', 'aus'] }).kanaele, []);
  assert.deepEqual(konfigNormalisieren({ kanaele: ['matrix'] }, { FYOS_FREIGABE_MELDUNG: 'aus' }).kanaele, []);
  assert.deepEqual(konfigNormalisieren({ kanaele: [] }, { FYOS_FREIGABE_MELDUNG: 'ntfy' }).kanaele, ['ntfy']);
  const k = konfigNormalisieren({ erinnerung: { nach_s: 60, faktor: 3 }, matrix: { befehl: false } }, { FYOS_NTFY_URL: 'https://n.test/', FYOS_NTFY_THEMA: 'geheim' });
  assert.equal(k.erinnerung.nachS, 60);
  assert.equal(k.erinnerung.faktor, 3);
  assert.equal(k.matrix.befehl, false);
  assert.equal(k.ntfy.url, 'https://n.test');
  assert.equal(k.ntfy.befehl, false, 'ntfy zeigt den Befehl nur, wenn es ausdrücklich verlangt ist');
});

test('Ausgeschaltet tut die Wache nichts', async () => {
  const w = FreigabeMeldung.ausKonfig({ cfg: { pi_durable: {} }, harness: null, freigaben: async () => [freigabe('a')], speicher: speicherMem() });
  assert.equal(w.an, false);
  assert.equal(w.start(), false);
  assert.deepEqual(await w.pruefen(), []);
});

test('Schwärzen: Zugangsdaten und Schlüssel verschwinden, Pfade und Wörter bleiben', () => {
  const roh =
    'curl -H "Authorization: Bearer abc123def456ghi789" https://user:geheim@host/x ' + // gitleaks:allow (Testattrappe)
    'GITHUB_TOKEN=ghp_AbCdEf1234567890xyz password=hunter2 --token sk-live-1234567890abcdef ' + // sauber: ok (Testattrappe) gitleaks:allow
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlMTIz ' + // gitleaks:allow (Testattrappe)
    'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0 /Users/besitzer/fyos/deploy/runner/pi-durable/src/freigabe-meldung.js';
  const s = schwaerzen(roh, 2000);
  for (const geheim of ['abc123def456ghi789', 'geheim@', 'ghp_AbCdEf1234567890xyz', 'hunter2', 'sk-live-1234567890abcdef', 'c2lnbmF0dXJlMTIz', 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0']) { // sauber: ok (Testattrappe)
    assert.ok(!s.includes(geheim), `${geheim} muss weg sein: ${s}`);
  }
  assert.ok(s.includes('/Users/besitzer/fyos/deploy/runner/pi-durable/src/freigabe-meldung.js'), 'Pfade bleiben');
  assert.ok(s.includes('https://***@host/x'));
  assert.equal(schwaerzen('a\n\n  b\tc', 50), 'a b c');
  assert.equal(schwaerzen('x'.repeat(30) + ' ' + 'y'.repeat(300), 40).length, 40);
});

test('Ruhezeit nach Ortszeit, Abstände wachsen bis zur Grenze', () => {
  const z = { von: 22, bis: 7, zone: 'Europe/Berlin' };
  assert.equal(istRuhezeit(T0, z), false);
  assert.equal(istRuhezeit(NACHTS, z), true);
  assert.equal(istRuhezeit(MORGENS, z), false);
  assert.equal(istRuhezeit(Date.UTC(2026, 6, 15, 3, 0, 0), z), true, '05:00 in Berlin');
  assert.equal(istRuhezeit(NACHTS, { von: 8, bis: 8, zone: 'Europe/Berlin' }), false, 'von == bis: keine Ruhezeit');
  const e = { nachS: 900, faktor: 2, maxS: 14_400 };
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((k) => erinnerungsAbstand(k, e) / MIN), [15, 30, 60, 120, 240, 240]);
});

test('eine neue offene Freigabe wird genau einmal gemeldet, auch nach einem Neustart', async () => {
  const matrix = stub('matrix', { befehl: true });
  const a = aufbau({ kanaele: [matrix], liste: [freigabe('f1', { risiko: 'high' })] });
  assert.equal((await a.w.pruefen()).length, 1);
  assert.equal(matrix.gesendet.length, 1);
  assert.deepEqual(await a.w.pruefen(), [], 'zweiter Durchgang: nichts Neues');
  // Neustart: neue Instanz, derselbe Speicher.
  a.uhr.t += 5 * MIN;
  const neu = a.bau();
  assert.deepEqual(await neu.pruefen(), []);
  assert.equal(matrix.gesendet.length, 1, 'kein zweites Mal');
  assert.equal(a.speicher.d.freigabemeldung.f1.kanaele.matrix, T0);
  assert.equal(neu.zustand().offen, 1);
});

test('Bündeln: mittleres Risiko wartet die Frist ab und geht als eine Nachricht', async () => {
  const matrix = stub('matrix');
  const liste = [freigabe('a'), freigabe('b'), freigabe('c')];
  const a = aufbau({ kanaele: [matrix], liste, start: T0 + 10_000 });
  assert.deepEqual(await a.w.pruefen(), [], 'zu frisch (Frist 120 s)');
  a.uhr.t = T0 + 121_000;
  const g = await a.w.pruefen();
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].ids, ['a', 'b', 'c']);
  assert.equal(matrix.gesendet.length, 1);
  assert.match(matrix.gesendet[0].text, /3 Freigaben warten auf dich/);
  assert.equal(matrix.gesendet[0].dringend, false);
});

test('hohes Risiko meldet immer, einzeln und dringend; der Rest wartet die Ruhezeit ab', async () => {
  const matrix = stub('matrix');
  const liste = [freigabe('hoch', { risiko: 'high', erstellt: NACHTS }), freigabe('mittel', { erstellt: NACHTS }), freigabe('niedrig', { risiko: 'low', erstellt: NACHTS })];
  const a = aufbau({ kanaele: [matrix], liste, start: NACHTS + 10 * MIN });
  const g = await a.w.pruefen();
  assert.deepEqual(g.map((x) => x.ids), [['hoch']]);
  assert.equal(matrix.gesendet[0].dringend, true);
  assert.equal(a.w.zustand().ruhezeit, true);
  // Später in der Ruhezeit: weiter still.
  a.uhr.t = NACHTS + 4 * HOUR;
  assert.deepEqual((await a.w.pruefen()).filter((x) => x.art === 'neu'), []);
  // Nach der Ruhezeit kommen die zurückgehaltenen gebündelt.
  a.uhr.t = MORGENS;
  const morgens = (await a.w.pruefen()).filter((x) => x.art === 'neu');
  assert.deepEqual(morgens.map((x) => x.ids), [['mittel', 'niedrig']]);
  const buendel = matrix.gesendet.find((n) => n.art === 'neu' && /2 Freigaben warten auf dich/.test(n.text));
  assert.ok(buendel, 'das Bündel kam');
  assert.equal(buendel.dringend, false, 'gebündelt ist nie dringend');
});

test('Erinnerung nach der Frist, dann mit wachsendem Abstand, bis die Höchstzahl erreicht ist', async () => {
  const matrix = stub('matrix');
  const a = aufbau({ kanaele: [matrix], liste: [freigabe('f1', { risiko: 'high' })], extra: { erinnerung: { nach_s: 900, faktor: 2, max_s: 3600, max_anzahl: 4 } } });
  await a.w.pruefen(); // t0: neu
  const stufen = [];
  for (const minuten of [14, 15, 44, 45, 74, 75, 135, 136, 195, 196, 400]) {
    a.uhr.t = T0 + minuten * MIN;
    const g = await a.w.pruefen();
    if (g.length) stufen.push(minuten);
  }
  // 15 min nach der Meldung, dann 30 min später, dann 60, dann 60 (Grenze); danach nichts mehr (max_anzahl 4).
  assert.deepEqual(stufen, [15, 45, 135, 195]);
  assert.match(matrix.gesendet[1].text, /Erinnerung 1: Freigabe weiter offen/);
  assert.match(matrix.gesendet[4].text, /Erinnerung 4/);
  assert.equal(a.speicher.d.freigabemeldung.f1.erinnert, 4);
  assert.equal(matrix.gesendet.length, 5);
  assert.equal(a.w.zustand().gemeldet.erinnerung, 4);
});

test('Erinnerungen mittlerer Freigaben kommen gebündelt und nicht in der Ruhezeit', async () => {
  const matrix = stub('matrix');
  const a = aufbau({ kanaele: [matrix], liste: [freigabe('a'), freigabe('b')], start: T0 + 3 * MIN });
  await a.w.pruefen();
  assert.equal(matrix.gesendet.length, 1);
  // 15 min später: fällig, aber in der Ruhezeit (23:35 Berlin)? Zeit auf die Nacht setzen.
  a.uhr.t = NACHTS;
  assert.deepEqual(await a.w.pruefen(), [], 'Ruhezeit: keine Erinnerung für mittleres Risiko');
  a.uhr.t = MORGENS;
  const g = await a.w.pruefen();
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].ids, ['a', 'b']);
  assert.match(matrix.gesendet.at(-1).text, /Erinnerung 1: 2 Freigaben weiter offen/);
});

test('Entschiedene Freigaben bekommen keine Erinnerung mehr und verlieren ihren Zustandseintrag', async () => {
  const matrix = stub('matrix');
  const f = freigabe('f1', { risiko: 'high' });
  const a = aufbau({ kanaele: [matrix], liste: [f] });
  await a.w.pruefen();
  assert.ok(a.speicher.d.freigabemeldung.f1);
  f.status = 'erteilt';
  a.uhr.t = T0 + 2 * HOUR;
  assert.deepEqual(await a.w.pruefen(), []);
  assert.deepEqual(a.speicher.d.freigabemeldung, {});
  assert.equal(matrix.gesendet.length, 1);
});

test('Texte: Aktion, Risiko, gekürzter Kontext; Befehl nur im Besitzer-Kanal; Hinweis, dass nur App/Web entscheidet; keine Geheimnisse', () => {
  const f = freigabe('fr-1', {
    risiko: 'high',
    aktion: 'Branch löschen mit Token ghp_AbCdEf1234567890xyz', // sauber: ok (Testattrappe)
    kontext: 'Aufräumen. '.repeat(100),
    befehl: 'git push --force https://max:passwort123@git.test/r.git', // sauber: ok (Testattrappe)
    werkzeug: 'bash',
  });
  const kfg = konfigNormalisieren({ link_einzeln: 'https://fyos.test/os?freigabe={id}', link: 'https://fyos.test/os' });
  const max = nachrichtBauen({ art: 'neu', liste: [f], kanal: { befehl: true, kontextMax: 240 }, kfg, jetzt: T0 + 12 * MIN });
  const fremd = nachrichtBauen({ art: 'neu', liste: [f], kanal: { befehl: false, kontextMax: 120 }, kfg, jetzt: T0 + 12 * MIN });
  assert.match(max.text, /^Freigabe nötig \(hohes Risiko\)/);
  assert.match(max.text, /Risiko: hoch/);
  assert.match(max.text, /Offen seit 12 min/);
  assert.match(max.text, /Befehl: git push --force https:\/\/\*\*\*@git\.test\/r\.git/);
  assert.ok(!fremd.text.includes('Befehl:'), 'ntfy ohne Befehl');
  for (const t of [max.text, fremd.text]) {
    assert.ok(!t.includes('ghp_'), 'Token geschwärzt');
    assert.ok(!t.includes('passwort123'));
    assert.match(t, /Entscheiden nur in der FYOS-App \(Persona-Tab\) oder im Runner-Web, jeweils mit Anmeldung\. Eine Antwort auf diese Nachricht entscheidet nichts\./);
    assert.match(t, /Öffnen: https:\/\/fyos\.test\/os\?freigabe=fr-1/);
  }
  // Entscheidung 586: der Kontext steht als zweite Zeile (nach dem Titel), vor Aktion und Risiko, und wird an Satzgrenzen gekürzt.
  const zeilen = (t) => t.split('\n');
  assert.ok(zeilen(max.text)[1].length <= 240 && zeilen(max.text)[1].startsWith('Aufräumen.'));
  assert.ok(zeilen(fremd.text)[1].length <= 120 && zeilen(fremd.text)[1].startsWith('Aufräumen.'));
  assert.ok(zeilen(max.text)[2].startsWith('Aktion:') && zeilen(max.text)[3].startsWith('Risiko:'));
  assert.equal(max.dringend, true);
  // Bündel: nur Aktion, Risiko, Alter; kein Kontext, kein Befehl, der allgemeine Link.
  const buendel = nachrichtBauen({ art: 'neu', liste: [f, freigabe('f2')], kanal: { befehl: true }, kfg, jetzt: T0 + 5 * MIN });
  assert.ok(!buendel.text.includes('Befehl:') && !buendel.text.includes('Aufräumen'));
  assert.match(buendel.text, /Öffnen: https:\/\/fyos\.test\/os$/);
});

test('Matrix-Attrappe: Text, Art frage, dringend nur bei hohem Risiko, bezug gekürzt, Raum; Ablehnung wird nicht als Erfolg gezählt', async () => {
  const aufrufe = [];
  let antwort = { status: 200, body: { ok: true } };
  const holen = async (url, opt) => {
    aufrufe.push({ url, ...opt, body: JSON.parse(opt.body) });
    return { status: antwort.status, json: async () => antwort.body };
  };
  const kanal = matrixKanal({ url: 'http://sender.test:18436', raum: 'ops', fetch: holen });
  const n = nachrichtBauen({ art: 'neu', liste: [freigabe('f1', { risiko: 'high' })], kanal, kfg: konfigNormalisieren({}), jetzt: T0 });
  assert.deepEqual(await kanal.senden(n), { ok: true, schatten: false, eventId: null });
  assert.equal(aufrufe[0].url, 'http://sender.test:18436/senden');
  assert.equal(aufrufe[0].method, 'POST');
  assert.equal(aufrufe[0].body.art, 'frage');
  assert.equal(aufrufe[0].body.dringend, true);
  assert.equal(aufrufe[0].body.raum, 'ops');
  assert.ok(aufrufe[0].body.bezug.length <= 60);
  assert.ok(!('authorization' in (aufrufe[0].headers ?? {})), 'der Sender trägt das Konto, hier steht kein Token');
  antwort = { status: 409, body: { ok: false, grund: 'Ruhezeit 22-7' } };
  const r = await kanal.senden(n);
  assert.equal(r.ok, false);
  assert.match(r.grund, /409/);
  antwort = { status: 200, body: { ok: true, schatten: true } };
  assert.equal((await kanal.senden(n)).schatten, true, 'Schattenbetrieb des Senders ist sichtbar');
  const weg = matrixKanal({ fetch: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal((await weg.senden(n)).ok, false);
});

test('ntfy-Attrappe: JSON mit Titel, Priorität und Klick-Link; Token aus der Umgebung; kein Aktionsknopf; kein Befehl', async () => {
  const aufrufe = [];
  const holen = async (url, opt) => {
    aufrufe.push({ url, headers: opt.headers, body: JSON.parse(opt.body) });
    return { status: 200 };
  };
  const kanal = ntfyKanal({ url: 'https://ntfy.test', thema: 'fyos-freigabe-0123', env: { FYOS_NTFY_TOKEN: 'tk_test_attrappe' }, fetch: holen });
  const f = freigabe('f1', { risiko: 'high', befehl: 'rm -rf /tmp/x' });
  const n = nachrichtBauen({ art: 'neu', liste: [f], kanal, kfg: konfigNormalisieren({ link: 'https://fyos.test/os' }), jetzt: T0 });
  assert.deepEqual(await kanal.senden(n), { ok: true });
  const a = aufrufe[0];
  assert.equal(a.url, 'https://ntfy.test');
  assert.equal(a.headers.authorization, 'Bearer tk_test_attrappe');
  assert.equal(a.body.topic, 'fyos-freigabe-0123');
  assert.equal(a.body.title, 'Freigabe nötig (hohes Risiko)');
  assert.equal(a.body.priority, 4);
  assert.equal(a.body.click, 'https://fyos.test/os');
  assert.ok(!('actions' in a.body), 'kein Knopf, der entscheidet');
  assert.ok(!a.body.message.includes('rm -rf'), 'kein Befehl in ntfy');
  // Ohne Token in der Umgebung geht keine Anmeldung mit.
  const ohne = ntfyKanal({ url: 'https://ntfy.test', thema: 't', env: {}, fetch: holen });
  await ohne.senden(n);
  assert.ok(!('authorization' in aufrufe[1].headers));
  const kaputt = ntfyKanal({ url: 'https://ntfy.test', thema: 't', env: {}, fetch: async () => ({ status: 403 }) });
  assert.deepEqual(await kaputt.senden(n), { ok: false, grund: 'ntfy 403' });
});

test('ausKonfig: ntfy ohne URL oder Thema wird nicht gebaut und steht im Zustand; Zustand verrät weder URL noch Thema', async () => {
  const cfg = { pi_durable: { freigabe_meldung: { kanaele: ['matrix', 'ntfy'], ntfy: { url: 'https://ntfy.test' } } } };
  const w = FreigabeMeldung.ausKonfig({ cfg, harness: null, env: {}, freigaben: async () => [], speicher: speicherMem(), log: still });
  assert.deepEqual(w.zustand().kanaele, ['matrix']);
  assert.match(w.zustand().fehler.ntfy, /nicht eingerichtet/);
  const voll = FreigabeMeldung.ausKonfig({
    cfg: { pi_durable: { freigabe_meldung: { kanaele: ['ntfy'] } } },
    harness: null,
    env: { FYOS_NTFY_URL: 'https://ntfy.test', FYOS_NTFY_THEMA: 'sehr-geheimes-thema', FYOS_NTFY_TOKEN: 'tk_geheim' },
    fetch: async () => ({ status: 200 }),
    freigaben: async () => [freigabe('x', { risiko: 'high' })],
    speicher: speicherMem(),
    log: still,
  });
  await voll.pruefen();
  const z = JSON.stringify(voll.zustand());
  assert.ok(!z.includes('sehr-geheimes-thema') && !z.includes('tk_geheim') && !z.includes('ntfy.test'));
  assert.equal(voll.zustand().gemeldet.neu, 1);
});

test('Ein Kanal fällt aus: der andere meldet weiter, der kaputte wird mit Pause neu versucht, nichts doppelt', async () => {
  const matrix = stub('matrix', { befehl: true });
  const ntfy = stub('ntfy');
  ntfy.ok.wert = false;
  const a = aufbau({ kanaele: [matrix, ntfy], liste: [freigabe('f1', { risiko: 'high' })] });
  const g1 = await a.w.pruefen();
  assert.deepEqual(g1.map((x) => x.kanal), ['matrix']);
  assert.equal(a.w.zustand().fehler.ntfy, 'kaputt');
  assert.ok(a.w.zustand().pause.ntfy);
  // 10 s später: ntfy ist noch in der Pause, Matrix hat schon gemeldet.
  a.uhr.t = T0 + 10_000;
  assert.deepEqual(await a.w.pruefen(), []);
  // Nach der Pause (30 s) wieder gesund: ntfy bekommt die Meldung nach, Matrix nicht ein zweites Mal.
  ntfy.ok.wert = true;
  a.uhr.t = T0 + 40_000;
  const g2 = await a.w.pruefen();
  assert.deepEqual(g2.map((x) => x.kanal), ['ntfy']);
  assert.equal(matrix.gesendet.length, 1);
  assert.equal(ntfy.gesendet.length, 1);
  assert.deepEqual(a.w.zustand().pause, {});
  assert.equal(a.w.zustand().fehler.ntfy, undefined);
});

test('Alle Kanäle tot: nichts wird als gemeldet vermerkt, die Pause wächst bis 15 Minuten', async () => {
  const matrix = stub('matrix');
  matrix.ok.wert = false;
  const a = aufbau({ kanaele: [matrix], liste: [freigabe('f1', { risiko: 'high' })] });
  const bis = [];
  for (let i = 0; i < 8; i++) {
    await a.w.pruefen();
    const p = a.w.zustand().pause.matrix;
    bis.push((p.bis - a.uhr.t) / 1000);
    a.uhr.t = p.bis + 1;
  }
  assert.deepEqual(bis, [30, 60, 120, 240, 480, 900, 900, 900]);
  assert.deepEqual(a.speicher.d.freigabemeldung, {});
  matrix.ok.wert = true;
  assert.equal((await a.w.pruefen()).length, 1);
});

test('Wache läuft im Takt und stoppt sauber', async () => {
  const matrix = stub('matrix');
  const konfig = konfigNormalisieren({ kanaele: ['matrix'], pruefen_s: 1 });
  const w = new FreigabeMeldung({ konfig, kanaele: [matrix], freigaben: async () => [freigabe('f1', { risiko: 'high' })], speicher: speicherMem(), log: still });
  assert.equal(w.start(), true);
  assert.equal(w.start(), false, 'zweimal starten schadet nicht');
  await new Promise((r) => setTimeout(r, 150));
  await w.stop();
  assert.equal(matrix.gesendet.length, 1);
});

// --- Mit dem echten Harness: der Zustand überlebt einen Neustart des Runners -------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), 'freigabemeldung-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const leererHub = {
  aufrufen: async () => ({ ok: true, result: {} }),
  melden: async () => ({ ok: true }),
  bereicheMelden: async () => ({ ok: true }),
  gesundheit: async () => ({ ok: true }),
  suchen: async () => [],
  schema: async () => ({}),
  eingangLesen: async (nach) => ({ eintraege: [], letzte: nach }),
};

async function runnerStarten(cfg) {
  const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: [{ id: 'hausmodell' }, { id: 'hausmodell-max' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runner = new Runner(cfg, { models, hub: leererHub });
  await runner.start();
  return runner;
}

test('mit dem echten Harness: genau eine Meldung über einen Neustart des Runners hinweg', async () => {
  const cfg = konfigurationLaden(
    {
      hub: 'http://hub.test',
      arbeitsbereiche: { standard: { pfad: tmp, titel: 'Test' } },
      pi_durable: {
        storage: join(tmp, 'neustart', 'fyos.sqlite'),
        security: { token: 'test-token-test-token-test-token-00' },
        proactive: { enabled: false },
        egress: { enabled: false },
        browser: { enabled: false },
        desktop: { enabled: false },
        freigabe_meldung: { kanaele: ['matrix'], matrix: { url: 'http://sender.test' } },
      },
    },
    {},
  );
  const gesendet = [];
  const holen = async (url, opt) => {
    gesendet.push({ url, body: JSON.parse(opt.body) });
    return { status: 200, json: async () => ({ ok: true }) };
  };
  const meldung = (runner) => FreigabeMeldung.ausKonfig({ cfg, harness: runner.harness, env: {}, fetch: holen, log: still });

  let runner = await runnerStarten(cfg);
  try {
    await runner.harness.commit(async (tx) => {
      const doc = await tx.doc(Freigaben);
      doc.eintraege['fr-neustart'] = neueFreigabe({ id: 'fr-neustart', conversationId: runner.root.id, aktion: 'Branch löschen', risiko: 'high', werkzeug: 'bash', befehl: 'git branch -D alt' });
    }, BACKGROUND_CONTEXT);
    const w1 = meldung(runner);
    assert.equal((await w1.pruefen()).length, 1);
    assert.equal(gesendet.length, 1);
    assert.equal(gesendet[0].url, 'http://sender.test/senden');
    assert.match(gesendet[0].body.text, /Befehl: git branch -D alt/);
    const stand = await wachenLesen(runner.harness);
    assert.ok(stand.freigabemeldung['fr-neustart'].kanaele.matrix, 'Zustand liegt im Harness');
    assert.deepEqual(stand.itsm, {}, 'die anderen Wachen bleiben unberührt');
  } finally {
    await runner.close().catch(() => {});
  }

  runner = await runnerStarten(cfg);
  try {
    const w2 = meldung(runner);
    assert.deepEqual(await w2.pruefen(), [], 'nach dem Neustart nichts doppelt');
    assert.equal(gesendet.length, 1);
    assert.equal(w2.zustand().offen, 1);
  } finally {
    await runner.close().catch(() => {});
  }
});
