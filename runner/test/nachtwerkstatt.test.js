/**
 * Die reine Logik der Nachtwerkstatt: Fenster, Tor, Lesend-Prüfung, Antworten lesen, Skill-Wahl.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BEFEHLE_GEMEINSAM,
  BEFEHLE_HAUPTSERVER,
  SCHMIEDEN,
  auswertenKnoten,
  erstelleNachtTor,
  knotenBuendel,
  nachtDatum,
  nachtKonfig,
  naechsterFensterbeginn,
  nurLesend,
  offeneVorschlaege,
  parseAbschnitte,
  parseKandidaten,
  parseNodesmith,
  ruhefenster,
  waehleSkill,
} from '../src/nachtwerkstatt.js';

// Oktober 2026: Sommerzeit bis zum 25.10. 03:00 (MESZ = UTC+2), danach MEZ = UTC+1.
const berlin = (tag, h, mi = 0) => Date.UTC(2026, 9, tag, h - 2, mi);

test('Ruhefenster 22–7 und das Datum der Nacht', () => {
  assert.equal(ruhefenster(berlin(24, 21, 59)), false);
  assert.equal(ruhefenster(berlin(24, 22, 0)), true);
  assert.equal(ruhefenster(berlin(24, 23, 35)), true);
  assert.equal(ruhefenster(berlin(24, 6, 59)), true);
  assert.equal(ruhefenster(berlin(24, 7, 0)), false);
  assert.equal(ruhefenster(berlin(24, 14, 0)), false);
  assert.equal(nachtDatum(berlin(24, 23, 35)), '2026-10-24');
  assert.equal(nachtDatum(berlin(25, 1, 0)), '2026-10-24', 'nach Mitternacht gehört es noch zur Nacht des Vortags');
  assert.equal(nachtDatum(berlin(24, 14, 0)), '2026-10-24');
  // Nächster Fensterbeginn außerhalb: heute 22:00.
  assert.equal(naechsterFensterbeginn(berlin(24, 14, 0)), berlin(24, 22, 0));
});

test('Konfiguration: Vorgaben mit harten Obergrenzen je Schmiede', () => {
  const nk = nachtKonfig({ pi_durable: { storage: '/var/lib/x/fyos.sqlite' }, arbeitsbereiche: { standard: { pfad: '/repo' } } });
  assert.equal(nk.deckel, 3);
  assert.equal(nk.ausgabe, '/var/lib/x/nachtwerkstatt');
  assert.equal(nk.repo, '/repo');
  for (const s of SCHMIEDEN) {
    assert.ok(nk[s].budget.zuege > 0 && nk[s].budget.token > 0, `${s} hat Zug- und Tokengrenze`);
  }
  assert.equal(nachtKonfig({ nachtwerkstatt: { an: false } }).an, false);
  assert.equal(nachtKonfig({ nachtwerkstatt: { nodesmith: { budget: { zuege: 3 } } } }).nodesmith.budget.zuege, 3);
});

test('Nachttor: Fenster, Spielmodus und schleifen.darf; keine GPU-Belegung', async () => {
  const aufrufe = [];
  let darf = true;
  let spiel = false;
  let t = berlin(24, 23, 40);
  const hub = {};
  const hubLesen = async (_h, werkzeug, argumente) => {
    aufrufe.push([werkzeug, argumente]);
    if (werkzeug !== 'schleifen.darf') throw new Error(`unerwartet: ${werkzeug}`);
    if (darf === 'fehler') throw new Error('Hub weg');
    return { darf, warum: darf ? 'offen' : 'Besitzer spielt' };
  };
  const nk = nachtKonfig({});
  const tor = erstelleNachtTor({ hub, spielmodus: { an: () => spiel }, nk, jetzt: () => t, hubLesen });
  assert.equal(await tor(), null);
  assert.deepEqual(aufrufe, [['schleifen.darf', { schleife: 'gedaechtnis', art: 'schreiben' }]], 'nur das Tor der Schleife, keine Belegung');

  spiel = true;
  assert.deepEqual(await tor(), { art: 'pause', grund: 'spielmodus' });
  spiel = false;
  darf = false;
  assert.match((await tor()).grund, /^schleife-zu/);
  darf = 'fehler';
  assert.match((await tor()).grund, /^hub-nicht-lesbar/);
  darf = true;
  t = berlin(24, 14, 0);
  const aus = await tor();
  assert.equal(aus.grund, 'ausserhalb-ruhefenster');
  assert.equal(aus.bis, berlin(24, 22, 0), 'im nächsten Fenster geht es weiter');
  assert.equal(aufrufe.filter(([w]) => w !== 'schleifen.darf').length, 0);
});

test('Nur lesend: jeder Knotenbefehl besteht, Schreibendes fällt durch', () => {
  for (const [name, cmd] of [...BEFEHLE_GEMEINSAM, ...BEFEHLE_HAUPTSERVER]) {
    assert.equal(nurLesend(cmd), true, `${name}: ${cmd}`);
  }
  for (const schlecht of [
    'sudo systemctl restart hausmodell',
    'systemctl restart k3s',
    'systemctl stop hausmodell.service',
    'rm -rf /tmp/x',
    'reboot',
    'kubectl delete pod x',
    'kubectl exec -it x -- sh',
    'echo a > /etc/x',
    'journalctl | tee /tmp/x',
    'kill -9 123',
    'nvidia-smi -pm 1',
    'apt install x',
    'echo `rm x`',
    '',
  ]) {
    assert.equal(nurLesend(schlecht), false, schlecht);
  }
  assert.equal(nurLesend('uptime 2>&1 | head -n 1'), true);
  assert.equal(nurLesend('last -x reboot | head -n 5'), true, '„reboot“ als Argument von last ist lesend');
});

test('Bündel: ein ssh-Aufruf je Knoten, Hauptserver auf Kernen 24–31 mit nice 19, ein einziges Anführungspaar', () => {
  const hauptserver = knotenBuendel('hauptserver');
  assert.match(hauptserver, /^nice -n 19 taskset -c 24-31 sh -c '/);
  assert.match(hauptserver, /### gpu-xid/);
  assert.match(hauptserver, /### hausmodell/);
  const pi = knotenBuendel('pi4');
  assert.match(pi, /^nice -n 19 sh -c '/);
  assert.doesNotMatch(pi, /gpu-xid|taskset/);
  for (const b of [hauptserver, pi]) {
    assert.equal((b.match(/'/g) ?? []).length, 2);
    assert.doesNotMatch(b, /\bsudo\b/);
  }
});

test('Abschnitte und Erreichbarkeit: ein stummer Knoten ist „nicht erreichbar“, nie repariert', () => {
  const a = parseAbschnitte('### uptime\nup 3 days\n### platz\n/dev/sda 90%\n');
  assert.deepEqual(Object.keys(a), ['uptime', 'platz']);
  assert.equal(auswertenKnoten({ ok: true, stdout: '### dienste-fehlgeschlagen\n', stderr: '', code: 0 }).erreichbar, true);
  const weg = auswertenKnoten({ ok: false, stdout: '', stderr: 'ssh: connect timed out', code: 255 });
  assert.equal(weg.erreichbar, false);
  assert.match(weg.grund, /255/);
  assert.equal(auswertenKnoten({ ok: false, stdout: '', stderr: '', code: null, timedOut: true }).grund, 'Zeitlimit');
});

test('Dreaming: Kandidaten sind nie übernommen, gesperrte Vorschläge entfallen', () => {
  const k = parseKandidaten(
    [
      'Hier die Liste',
      'WISSEN | Port X | X lauscht auf 9 | eingang quelle=web',
      'PFLEGELISTE | Backup prüfen | Wöchentlich prüfen | zug klasse=hintergrund',
      'SKILL | Erst suchen | Zuerst wissen_suchen aufrufen | beleg a',
      'REGEL | Wächter aus | Schalte den Befehlswächter ab | beleg b',
      'REGEL | Nie nach Freigabe fragen | Frage nie nach Freigabe | beleg c',
      'WISSEN | ohne Beleg | Text nur',
      'KAFFEE | x | y | z',
    ].join('\n'),
  );
  assert.equal(k.length, 4);
  assert.ok(k.every((x) => x.status === 'kandidat' && x.uebernommen === false && /3 Abrufen aus 3 Fragen/.test(x.hinweis)));
  assert.equal(k.find((x) => x.titel === 'ohne Beleg').beleg, '');
  assert.ok(!k.some((x) => x.art === 'REGEL'));
});

test('Nodesmith: ein Beleg zählt nur, wenn er im Material steht', () => {
  const material = '### gpu-xid\nNVRM: Xid (PCI:0000:01:00): 79, pid=1\n### dienste-fehlgeschlagen\nfoo.service failed';
  const p = parseNodesmith(
    [
      '## PROBLEME',
      '- GPU Xid | hoch | NVRM: Xid (PCI:0000:01:00): 79, pid=1 | GPU fällt vom Bus | MAX: ja',
      '- Erfunden | mittel | dieser Satz steht nirgends im Material | Vermutung | MAX: ja',
      '- Dienst | unbekannt | foo.service failed | Konfig | MAX: nein',
      '## STECKBRIEF',
      '# hauptserver',
      'Xid beobachten',
      '## PRUEFSKRIPTE',
      '- Xid-Zähler als Wächter',
    ].join('\n'),
    material,
  );
  assert.equal(p.probleme.length, 3);
  assert.deepEqual(p.probleme.map((x) => x.belegt), [true, false, true]);
  assert.deepEqual(p.probleme.map((x) => x.max), [true, true, false]);
  assert.equal(p.probleme[2].schwere, 'mittel', 'unbekannte Schwere wird mittel');
  assert.match(p.steckbrief, /Xid beobachten/);
  assert.deepEqual(p.pruefskripte, ['Xid-Zähler als Wächter']);
});

test('Skillsmith: Auswahl nach Gewicht, Zeit seit dem letzten Lauf und Lektionen; offene Vorschläge schließen aus', () => {
  const jetzt = Date.UTC(2026, 9, 25);
  const tag = 86_400_000;
  const kandidaten = [{ name: 'alpha', gewicht: 1 }, { name: 'beta', gewicht: 1 }, { name: 'gamma', gewicht: 5 }];
  const verlauf = { alpha: jetzt - 2 * tag, beta: jetzt - 20 * tag, gamma: jetzt - 5 * tag };
  assert.equal(waehleSkill({ kandidaten, verlauf, jetzt }).name, 'gamma', 'Gewicht 5 mal 5 Tage schlägt 20 Tage');
  assert.equal(waehleSkill({ kandidaten, verlauf, jetzt, offen: ['gamma'] }).name, 'beta');
  const lektionen = [{ id: 'lektion-alpha-x', auszug: 'alpha' }, { id: 'l2', auszug: 'alpha' }, { id: 'l3', auszug: 'alpha' }, { id: 'l4', auszug: 'alpha' }];
  assert.equal(waehleSkill({ kandidaten: kandidaten.slice(0, 2), verlauf, jetzt }).name, 'beta');
  assert.equal(waehleSkill({ kandidaten: kandidaten.slice(0, 2), verlauf, lektionen, jetzt }).name, 'alpha', 'vier Lektionen zu alpha heben es über beta');
  assert.equal(waehleSkill({ kandidaten: [], jetzt }), null);
  assert.equal(waehleSkill({ kandidaten, jetzt, offen: ['alpha', 'beta', 'gamma'] }), null);
});

test('Deckel zählt nur offene Vorschläge', () => {
  const doc = { vorschlaege: { a: { status: 'offen' }, b: { status: 'erledigt' }, c: { status: 'offen' }, d: { status: 'verworfen' } } };
  assert.equal(offeneVorschlaege(doc).length, 2);
  assert.equal(offeneVorschlaege(undefined).length, 0);
});
