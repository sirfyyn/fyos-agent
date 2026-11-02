import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Satzstrom, ordnungsWort, sprechbar, zahlWort, ziffernWorte } from '../src/sprache-text.js';

test('Zahlwörter: ein, eins, Hunderter, Tausender, Jahre', () => {
  assert.equal(zahlWort(0), 'null');
  assert.equal(zahlWort(1), 'eins');
  assert.equal(zahlWort(21), 'einundzwanzig');
  assert.equal(zahlWort(100), 'einhundert');
  assert.equal(zahlWort(101), 'einhunderteins');
  assert.equal(zahlWort(1000), 'eintausend');
  assert.equal(zahlWort(2026), 'zweitausendsechsundzwanzig');
  assert.equal(zahlWort(1990, { jahr: true }), 'neunzehnhundertneunzig');
  assert.equal(zahlWort(1_200_000), 'eine Million zweihunderttausend');
  assert.equal(ziffernWorte('1234'), 'eins zwei drei vier');
  assert.equal(ordnungsWort(25), 'fünfundzwanzigste');
  assert.equal(ordnungsWort(3, { dativ: true }), 'dritten');
  assert.equal(ordnungsWort(1), 'erste');
});

test('sprechbar: Markdown, Links, Pfade, Kennungen fallen weg oder werden lesbar', () => {
  assert.equal(sprechbar('**Fertig**: siehe [die Doku](https://example.org/x).'), 'Fertig: siehe die Doku.');
  assert.equal(sprechbar('Details unter https://example.org/lang/pfad?x=1 bitte.'), 'Details unter Link bitte.');
  assert.equal(sprechbar('Datei deploy/runner/pi-durable/src/sprache.js geändert.'), 'Datei sprache Punkt js geändert.');
  assert.match(sprechbar('Commit 3f2a9c1b7d4e war es.'), /eine Kennung/);
  assert.equal(sprechbar('CHG-1234 ist offen'), 'C H G eins zwei drei vier ist offen.');
  assert.equal(sprechbar('```js\nconst a = 1;\n```'), '');
  assert.equal(sprechbar('| a | b |\n|---|---|\n| 1 | 2 |'), '');
  assert.equal(sprechbar('- Erstens\n- Zweitens'), 'Erstens. Zweitens.');
  assert.equal(sprechbar('Mach `status` an und `rm -rf /tmp/x` nicht.'), 'Mach status an und nicht.');
});

test('sprechbar: Zahlen, Uhrzeit, Datum, Einheiten, Prozent, Geld', () => {
  assert.equal(sprechbar('Es ist 14:30 Uhr.'), 'Es ist vierzehn Uhr dreißig.');
  assert.equal(sprechbar('Um 9:00 los.'), 'Um neun Uhr los.');
  assert.equal(sprechbar('Am 25.10.2026 ist es soweit.'), 'Am fünfundzwanzigsten Oktober zweitausendsechsundzwanzig ist es soweit.');
  assert.equal(sprechbar('Der 3. Oktober ist ein Feiertag.'), 'Der dritte Oktober ist ein Feiertag.');
  assert.equal(sprechbar('Das sind 45 % von 12 GB.'), 'Das sind fünfundvierzig Prozent von zwölf Gigabyte.');
  assert.equal(sprechbar('Kostet 12,50 €.'), 'Kostet zwölf Euro fünfzig.');
  assert.equal(sprechbar('Temperatur 3,5 °C.'), 'Temperatur drei Komma fünf Grad.');
  assert.equal(sprechbar('1.234 Treffer'), 'eintausendzweihundertvierunddreißig Treffer.');
  assert.equal(sprechbar('Version 1.2.3'), 'Version eins Punkt zwei Punkt drei.');
  assert.equal(sprechbar('z. B. 10-20 Stück, d. h. wenige'), 'zum Beispiel zehn bis zwanzig Stück, das heißt wenige.');
  assert.equal(sprechbar('Dauer 2,7 s'), 'Dauer zwei Komma sieben Sekunden.');
});

test('sprechbar: nichts Sprechbares bleibt leer', () => {
  assert.equal(sprechbar(''), '');
  assert.equal(sprechbar('   ***   '), '');
  assert.equal(sprechbar(null), '');
});

const alle = (teile, st) => {
  const aus = [];
  for (const t of teile) aus.push(...st.schiebe(t));
  aus.push(...st.ende());
  return aus.map((x) => x.text);
};

test('Satzstrom: zerlegt an Satzenden, auch wenn Deltas mitten im Satz enden', () => {
  const st = new Satzstrom();
  assert.deepEqual(alle(['Hallo Besitzer. Das ist ein', ' Test! Und noch eins?', ' Ja.'], st), ['Hallo Besitzer.', 'Das ist ein Test!', 'Und noch eins?', 'Ja.']);
});

test('Satzstrom: Abkürzungen, Dezimalzahlen, Ordnungszahlen vor Monat und Dateinamen enden keinen Satz', () => {
  const st = new Satzstrom();
  const t = alle(['Das ist z. B. so. Wert 3.5 ist ok. Am 25. Oktober kommt sprache.js dran. Ende.'], st);
  assert.deepEqual(t, ['Das ist z. B. so.', 'Wert 3.5 ist ok.', 'Am 25. Oktober kommt sprache.js dran.', 'Ende.']);
});

test('Satzstrom: erstes Häppchen endet früh am Komma, die übrigen nicht', () => {
  const st = new Satzstrom({ ersteMin: 20 });
  const aus = [];
  aus.push(...st.schiebe('Ich habe nachgesehen und alles ist in Ordnung, nur Hausmodell schläft noch, wie gewohnt. '));
  aus.push(...st.schiebe('Ende.'));
  aus.push(...st.ende());
  assert.equal(aus[0].text, 'Ich habe nachgesehen und alles ist in Ordnung,');
  assert.equal(aus[0].erste, true);
  assert.equal(aus[1].text, 'nur Hausmodell schläft noch, wie gewohnt.');
  assert.equal(aus[1].erste, false);
});

test('Satzstrom: Zeilenenden trennen, Code-Blöcke und Tabellen werden verworfen und gemeldet', () => {
  const st = new Satzstrom();
  const t = alle(['Schau mal:\n```bash\nls -la\n', '```\nDanach weiter.\n| a | b |\n| 1 | 2 |\nFertig.'], st);
  assert.deepEqual(t, ['Schau mal:', 'Danach weiter.', 'Fertig.']);
  assert.equal(st.uebersprungen.code, true);
  assert.equal(st.uebersprungen.tabelle, true);
});

test('Satzstrom: zu lange Sätze werden geteilt', () => {
  const st = new Satzstrom({ max: 60, ersteMin: 500, ersteMax: 500 });
  const lang = 'eins zwei drei vier fünf, sechs sieben acht neun zehn, elf zwölf dreizehn vierzehn fünfzehn sechzehn siebzehn. ';
  const t = alle([lang], st);
  assert.ok(t.length >= 2);
  assert.ok(t.every((x) => x.length <= 70), JSON.stringify(t));
});

test('Satzstrom: Listenzeilen sind gekennzeichnet', () => {
  const st = new Satzstrom();
  const aus = [...st.schiebe('- Eins\n- Zwei\nText.'), ...st.ende()];
  assert.deepEqual(aus.map((x) => x.liste), [true, true, false]);
});
