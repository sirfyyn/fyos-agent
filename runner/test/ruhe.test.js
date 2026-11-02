/**
 * Tests des Ruhe-Schalters (src/ruhe.js): Zustand, Ablauf, Persistenz, Vorrang des Spielmodus, Nachtruhe, Ereignisse.
 * Ohne Runner und ohne Netz; die Uhr ist eine Variable.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Ruhe, RuheFehler, nachtruheKonfig } from '../src/ruhe.js';
import { Spielmodus } from '../src/spielmodus.js';

const tmp = mkdtempSync(join(tmpdir(), 'ruhe-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const stumm = () => {};
const T0 = Date.UTC(2026, 9, 25, 12, 0, 0); // 25.10.2026 12:00 UTC
const MIN = 60_000;
const STUNDE = 60 * MIN;

function bauen({ name = 'a', spiel = null, nacht = null, t = { jetzt: T0 }, datei = join(tmp, `${name}.json`) } = {}) {
  const marke = { an: spiel };
  const spielmodus = new Spielmodus(['/x/spielmodus.kid'], {
    existiert: () => marke.an !== null && marke.an !== false,
    lesen: () => {
      throw new Error('keine .bis');
    },
    log: stumm,
  });
  const ruhe = new Ruhe({ datei, spielmodus, nachtruhe: nacht, log: stumm, jetzt: () => t.jetzt });
  return { ruhe, marke, t, datei };
}

test('ohne Schalter ist alles frei und der Zustand vollständig', () => {
  const { ruhe } = bauen();
  const z = ruhe.zustand();
  assert.equal(z.ruhe, false);
  assert.equal(z.pausiert, false);
  assert.equal(z.spielmodus, null);
  assert.equal(z.quelle, null);
  assert.equal(z.stufe, 'normal');
  assert.equal(ruhe.eingang(), 'frei');
  assert.equal(ruhe.sperre.an(), false);
  assert.equal(ruhe.sperre.grund(), null);
});

test('Ruhe an: Zustand, von, Grund, Stufe normal lässt Besitzer durch', () => {
  const { ruhe } = bauen();
  const r = ruhe.setzen({ an: true, grund: '  Ich\ngehe\tschlafen  ', von: 'app' });
  assert.equal(r.ruhe, true);
  assert.equal(r.pausiert, true);
  assert.equal(r.quelle, 'schalter');
  assert.equal(r.grund, 'Ich gehe schlafen');
  assert.equal(r.von, 'app');
  assert.equal(r.seit, new Date(T0).toISOString());
  assert.equal(r.bis, null);
  assert.equal(r.stufe, 'normal');
  assert.equal(r.geaendert, true);
  assert.equal(ruhe.eingang(), 'nurMax');
  assert.equal(ruhe.sperrtMax(), false);
  assert.equal(ruhe.sperre.an(), true);
  assert.equal(ruhe.sperre.grund(), 'ruhe:Ich gehe schlafen');
});

test('Stufe tief hält auch Besitzer an', () => {
  const { ruhe } = bauen();
  ruhe.setzen({ an: true, stufe: 'tief', von: 'steuer' });
  assert.equal(ruhe.eingang(), 'gesperrt');
  assert.equal(ruhe.sperrtMax(), true);
});

test('Ruhe aus löscht den Schalter; zweimal aus ändert nichts', () => {
  const { ruhe } = bauen();
  ruhe.setzen({ an: true, von: 'app' });
  const aus = ruhe.setzen({ an: false, von: 'app' });
  assert.equal(aus.ruhe, false);
  assert.equal(aus.pausiert, false);
  assert.equal(aus.geweckt, true);
  assert.equal(aus.geaendert, true);
  assert.equal(aus.schalter.an, false);
  assert.equal(ruhe.setzen({ an: false }).geaendert, false);
});

test('Eingaben werden geprüft', () => {
  const { ruhe } = bauen();
  assert.throws(() => ruhe.setzen({}), RuheFehler);
  assert.throws(() => ruhe.setzen({ an: 'ja' }), /true oder false/);
  assert.throws(() => ruhe.setzen({ an: true, stufe: 'mittel' }), /stufe/);
  assert.throws(() => ruhe.setzen({ an: true, sofort: 'ja' }), /sofort/);
  assert.throws(() => ruhe.setzen({ an: true, bis: 'morgen' }), /ISO/);
  assert.throws(() => ruhe.setzen({ an: true, bis: new Date(T0 - 1000).toISOString() }), /Zukunft/);
  assert.throws(() => ruhe.setzen({ an: true, bis: new Date(T0 + 40 * 24 * STUNDE).toISOString() }), /31 Tage/);
  try {
    ruhe.setzen({});
  } catch (f) {
    assert.equal(f.status, 400);
  }
  assert.equal(ruhe.zustand().ruhe, false, 'fehlerhafte Aufrufe ändern nichts');
});

test('Ablauf: bis gilt, danach ist die Ruhe aus und meldet es', () => {
  const { ruhe, t } = bauen();
  const gehoert = [];
  ruhe.beiAenderung((z) => gehoert.push(z.art));
  ruhe.setzen({ an: true, bis: new Date(T0 + 2 * STUNDE).toISOString(), von: 'app' });
  t.jetzt = T0 + 2 * STUNDE - 1;
  assert.equal(ruhe.pausiert(), true);
  t.jetzt = T0 + 2 * STUNDE;
  assert.equal(ruhe.pausiert(), false, 'beim Lesen geprüft, kein Timer nötig');
  assert.equal(ruhe.zustand().bis, null);
  assert.deepEqual(gehoert, ['an', 'abgelaufen']);
});

test('Persistenz: der Neustart sieht den Schalter, ein abgelaufener ist aus', () => {
  const t = { jetzt: T0 };
  const { ruhe, datei } = bauen({ name: 'persist', t });
  ruhe.setzen({ an: true, bis: new Date(T0 + STUNDE).toISOString(), grund: 'Test', stufe: 'tief', von: 'hub' });
  const roh = JSON.parse(readFileSync(datei, 'utf8'));
  assert.equal(roh.ruhe, true);
  assert.equal(roh.von, 'hub');

  const nachNeustart = new Ruhe({ datei, log: stumm, jetzt: () => t.jetzt });
  const z = nachNeustart.zustand();
  assert.equal(z.ruhe, true);
  assert.equal(z.stufe, 'tief');
  assert.equal(z.von, 'hub');
  assert.equal(z.grund, 'Test');

  t.jetzt = T0 + 2 * STUNDE;
  const spaeter = new Ruhe({ datei, log: stumm, jetzt: () => t.jetzt });
  assert.equal(spaeter.zustand().ruhe, false, 'abgelaufen während der Runner aus war');
});

test('Persistenz: unlesbare oder unsinnige Datei gilt als aus, schreibt nichts kaputt', () => {
  const datei = join(tmp, 'kaputt.json');
  writeFileSync(datei, '{kein json');
  const meldungen = [];
  const r = new Ruhe({ datei, log: (z) => meldungen.push(z), jetzt: () => T0 });
  assert.equal(r.zustand().ruhe, false);
  assert.match(meldungen[0], /unlesbar/);

  writeFileSync(datei, JSON.stringify({ ruhe: true, bis: 'irgendwann', stufe: 'wild' }));
  assert.equal(new Ruhe({ datei, log: stumm, jetzt: () => T0 }).zustand().ruhe, false, 'unlesbare Endzeit: aus');

  writeFileSync(datei, JSON.stringify({ ruhe: true, stufe: 'wild', von: 'x'.repeat(100) }));
  const z = new Ruhe({ datei, log: stumm, jetzt: () => T0 }).zustand();
  assert.equal(z.ruhe, true);
  assert.equal(z.stufe, 'normal', 'unbekannte Stufe fällt auf normal');
  assert.equal(z.von.length, 40);
});

test('ohne schreibbare Datei gilt der Schalter im Speicher und der Fehler steht im Zustand', () => {
  const r = new Ruhe({
    datei: '/nicht/da/ruhe.json',
    log: stumm,
    jetzt: () => T0,
    dateisystem: {
      ordner: () => {
        throw new Error('EACCES');
      },
    },
  });
  const z = r.setzen({ an: true, von: 'app' });
  assert.equal(z.pausiert, true);
  assert.match(z.fehler, /nicht gespeichert/);
});

test('Spielmodus ist immer Ruhe und immer tief', () => {
  const { ruhe, marke } = bauen({ spiel: true });
  const z = ruhe.zustand();
  assert.equal(z.ruhe, false, 'der Schalter selbst steht aus');
  assert.equal(z.pausiert, true);
  assert.equal(z.spielmodus, 'spielmodus.kid');
  assert.equal(z.quelle, 'spielmodus');
  assert.equal(z.stufe, 'tief');
  assert.equal(ruhe.eingang(), 'gesperrt');
  assert.equal(ruhe.sperre.grund(), 'spielmodus.kid');
  marke.an = false;
  assert.equal(ruhe.pausiert(), false);
});

test('Der Schalter kann nicht gegen den Spielmodus wecken', () => {
  const { ruhe, marke } = bauen({ spiel: true });
  ruhe.setzen({ an: true, von: 'app', grund: 'Schlafen' });
  assert.deepEqual(ruhe.zustand().quellen, ['spielmodus', 'schalter']);
  assert.equal(ruhe.zustand().schalter.grund, 'Schlafen', 'der Schalter bleibt sichtbar');
  const aus = ruhe.setzen({ an: false, von: 'app' });
  assert.equal(aus.geweckt, false);
  assert.equal(aus.pausiert, true);
  assert.match(aus.hinweis, /Spielmodus/);
  assert.equal(aus.schalter.an, false, 'der Schalter selbst ist aus');
  assert.equal(ruhe.eingang(), 'gesperrt');
  marke.an = false;
  assert.equal(ruhe.pausiert(), false, 'erst mit der Marke endet die Ruhe');
});

test('pruefen meldet Wechsel der Spielmodus-Marke', () => {
  const { ruhe, marke } = bauen();
  const gehoert = [];
  ruhe.beiAenderung((z) => gehoert.push([z.art, z.pausiert, z.spielmodus]));
  ruhe.pruefen();
  assert.deepEqual(gehoert, []);
  marke.an = true;
  ruhe.pruefen();
  ruhe.pruefen();
  marke.an = false;
  ruhe.pruefen();
  assert.deepEqual(gehoert, [
    ['wechsel', true, 'spielmodus.kid'],
    ['wechsel', false, null],
  ]);
});

test('Hörer können sich abmelden, ein werfender Hörer stört die anderen nicht', () => {
  const { ruhe } = bauen();
  const a = [];
  const weg = ruhe.beiAenderung((z) => a.push(z.art));
  ruhe.beiAenderung(() => {
    throw new Error('kaputt');
  });
  ruhe.setzen({ an: true });
  weg();
  ruhe.setzen({ an: false });
  assert.deepEqual(a, ['an']);
});

test('Nachtruhe: Fenster über Mitternacht, Besitzer weckt für diese Nacht', () => {
  const nacht = { an: true, von: '22:00', bis: '07:00', zone: 'Europe/Berlin' };
  const t = { jetzt: Date.UTC(2026, 9, 24, 19, 30) }; // 24.10. 21:30 Berlin (Sommerzeit): noch nicht
  const { ruhe } = bauen({ name: 'nacht', nacht, t });
  assert.equal(ruhe.pausiert(), false);
  t.jetzt = Date.UTC(2026, 9, 24, 20, 30); // 22:30 Berlin
  const z = ruhe.zustand();
  assert.equal(z.ruhe, true);
  assert.equal(z.quelle, 'nachtruhe');
  assert.match(z.grund, /Nachtruhe 22:00–07:00/);
  assert.equal(ruhe.eingang(), 'nurMax');
  assert.ok(z.bis, 'Ende des Fensters ist angegeben');
  // 07:00 Winterzeit (06:00 UTC) am 25.10., nach der Umstellung um 03:00.
  assert.equal(z.bis, new Date(Date.UTC(2026, 9, 25, 6, 0)).toISOString());

  const wach = ruhe.setzen({ an: false, von: 'app' });
  assert.equal(wach.pausiert, false, 'für den Rest der Nacht aufgehoben');
  t.jetzt += 3 * STUNDE;
  assert.equal(ruhe.pausiert(), false);
  t.jetzt = Date.UTC(2026, 9, 25, 7, 30); // 08:30 Berlin, Fenster vorbei (Zeitumstellung 25.10. 03:00)
  assert.equal(ruhe.pausiert(), false);
  t.jetzt = Date.UTC(2026, 9, 25, 21, 30); // nächste Nacht: wieder
  assert.equal(ruhe.pausiert(), true);
});

test('Nachtruhe: ungültige oder abgeschaltete Konfiguration bleibt aus', () => {
  assert.equal(nachtruheKonfig(null), null);
  assert.equal(nachtruheKonfig({ an: false, von: '22:00', bis: '07:00' }), null);
  assert.equal(nachtruheKonfig({ an: true, von: '25:99', bis: '07:00' }), null);
  assert.equal(nachtruheKonfig({ an: true, von: '22:00', bis: '22:00' }), null);
  assert.equal(nachtruheKonfig({ an: true, zone: 'Nirgendwo/Stadt' }), null);
  assert.deepEqual(
    (({ von, bis, zone, stufe }) => ({ von, bis, zone, stufe }))(nachtruheKonfig({ an: true })),
    { von: 22 * 60, bis: 7 * 60, zone: 'Europe/Berlin', stufe: 'normal' },
  );
});
