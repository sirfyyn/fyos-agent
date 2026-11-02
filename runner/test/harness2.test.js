/**
 * Die reine Logik des Harness2-Piloten: Eingabe, Beobachtungsmerkmale, Streuung, Entscheidungsregel, Dateien.
 * Kein Modell, kein Runner.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  KANDIDATEN,
  ausgabeGesperrt,
  auswerten,
  beobachte,
  entscheide,
  erzeugeDateien,
  kandidatSkill,
  komponiere,
  parseLehren,
  parseVorschlaege,
  planProbe,
  planReferenz,
  planZuege,
  pruefeEingabe,
  tabelle,
  tokenAusNutzung,
  vergleiche,
  zusammengesetzt,
} from '../src/harness2.js';

const AUFGABEN = ['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => ({
  id,
  aufgabe: `Aufgabe [${id}]: beantworte kurz`,
  merkmal: { art: 'enthaelt', wert: `ziel-${id}` },
}));

const eingabe = (extra = {}) => ({
  skillPfad: 'skills/agenten/demo-skill/SKILL.md',
  skillText: '# Demo\n\nTue etwas Nützliches mit Werkzeugen.\n',
  lektion: 'Lektion: Dienst X läuft auf Port 9.',
  aufgaben: AUFGABEN,
  n: 3,
  k: 1,
  budget: { zuege: 100 },
  ausgabe: '/tmp/h2-ausgabe',
  ...extra,
});

test('Eingabe: gültig, Vorgaben und Mindestgewinn', () => {
  const i = pruefeEingabe(eingabe());
  assert.equal(i.skillName, 'demo-skill');
  assert.equal(i.n, 3);
  assert.equal(i.k, 1);
  assert.equal(i.mindestGewinn, 0.2);
  assert.equal(i.budget.token, null);
  assert.equal(planZuege(5, 3, 1), 47);
  assert.equal(planZuege(5, 3, 2), 94);
});

test('Eingabe: Fehler werden benannt', () => {
  assert.throws(() => pruefeEingabe(eingabe({ skillPfad: 'skills/agenten/../x/SKILL.md' })), /skillPfad/);
  assert.throws(() => pruefeEingabe(eingabe({ skillPfad: 'docs/x.md' })), /skillPfad/);
  assert.throws(() => pruefeEingabe(eingabe({ skillPfad: 'skills/agenten/bash-waechter/SKILL.md' })), /nicht editierbar/);
  assert.throws(() => pruefeEingabe(eingabe({ skillPfad: 'skills/agenten/max-grenzen/SKILL.md' })), /nicht editierbar/);
  assert.throws(() => pruefeEingabe(eingabe({ aufgaben: AUFGABEN.slice(0, 4) })), /fünf bis zwölf/);
  assert.throws(() => pruefeEingabe(eingabe({ n: 1 })), /Streuung/);
  assert.throws(() => pruefeEingabe(eingabe({ k: 9 })), /k:/);
  assert.throws(() => pruefeEingabe(eingabe({ budget: {} })), /budget\.zuege/);
  assert.throws(() => pruefeEingabe(eingabe({ budget: { zuege: 10, token: 5 } })), /budget\.token/);
  assert.throws(() => pruefeEingabe(eingabe({ ausgabe: 'relativ/pfad' })), /absolut/);
  assert.throws(() => pruefeEingabe(eingabe({ ausgabe: '/repo/skills/agenten/x' })), /Skills-Baum/);
  assert.throws(() => pruefeEingabe(eingabe({ aufgaben: [...AUFGABEN.slice(0, 4), { ...AUFGABEN[0] }] })), /doppelte id/);
  assert.throws(
    () => pruefeEingabe(eingabe({ aufgaben: [...AUFGABEN.slice(0, 4), { id: 'a9', aufgabe: 'Text text', merkmal: { art: 'magie', wert: 'x' } }] })),
    /unbekannte Art/,
  );
  assert.equal(ausgabeGesperrt('/x/skills/agenten'), true);
  assert.equal(ausgabeGesperrt('/x/skills/andere'), false);
});

test('Merkmale beobachten Verhalten, keine Wahrheit', () => {
  const lauf = { antwort: 'Zuerst gesucht, dann geantwortet. Port 9.', werkzeuge: ['wissen_suchen', 'read'] };
  assert.equal(beobachte({ art: 'enthaelt', wert: 'port 9' }, lauf), 1);
  assert.equal(beobachte({ art: 'enthaelt', wert: ['port', 'dann'] }, lauf), 1);
  assert.equal(beobachte({ art: 'enthaelt', wert: ['port', 'fehlt'] }, lauf), 0);
  assert.equal(beobachte({ art: 'enthaelt-nicht', wert: 'unsicher' }, lauf), 1);
  assert.equal(beobachte({ art: 'enthaelt-nicht', wert: 'port' }, lauf), 0);
  assert.equal(beobachte({ art: 'regex', wert: 'port\\s\\d' }, lauf), 1);
  assert.equal(beobachte({ art: 'werkzeug', wert: 'wissen' }, lauf), 1);
  assert.equal(beobachte({ art: 'werkzeug', wert: 'bash' }, lauf), 0);
  assert.equal(beobachte({ art: 'ohne-werkzeug', wert: 'bash' }, lauf), 1);
  assert.equal(beobachte({ art: 'laenge-bis', wert: 10 }, lauf), 0);
  assert.equal(beobachte({ art: 'werkzeuge-bis', wert: 2 }, lauf), 1);
});

const aus = (jeRep, aufgaben = AUFGABEN) => {
  // jeRep: Anzahl gelungener Aufgaben je Wiederholung; die ersten Aufgaben gelingen.
  return auswerten(aufgaben, jeRep.length, (id, rep) => (aufgaben.findIndex((a) => a.id === id) < jeRep[rep - 1] ? 1 : 0));
};

test('Mittel und Spanne über die Wiederholungen', () => {
  const a = aus([1, 3, 2]);
  assert.deepEqual(a.jeRep, [0.2, 0.6, 0.4]);
  assert.equal(a.mittel, 0.4);
  assert.equal(a.spanne, 0.4);
  assert.equal(auswerten(AUFGABEN, 3, () => undefined), null);
});

test('Entscheidungsregel: Gewinn nur über der gemessenen Streuung', () => {
  // klarer Gewinn, keine Streuung
  let v = vergleiche(aus([1, 1, 1]), aus([4, 4, 4]), 0.2);
  assert.equal(v.gewinn, 0.6);
  assert.equal(v.streuung, 0);
  assert.equal(entscheide(v).entscheidung, 'uebernehmen');

  // kleiner Gewinn unter der Streuung der Referenz
  v = vergleiche(aus([1, 3, 2]), aus([2, 3, 3]), 0.2);
  assert.ok(v.gewinn > 0 && v.gewinn < v.streuung);
  assert.equal(entscheide(v).entscheidung, 'verwerfen');
  assert.match(entscheide(v).grund, /kein Gewinn über der Streuung/);

  // Gewinn gleich der Streuung zählt nicht (strikt darüber)
  v = vergleiche(aus([1, 2, 1]), aus([2, 3, 2]), 0.2);
  assert.equal(v.gewinn, 0.2);
  assert.equal(v.streuung, 0.2);
  assert.equal(entscheide(v).entscheidung, 'verwerfen');

  // Gewinn unter dem Mindestgewinn (ein halbes Aufgabenstück)
  v = vergleiche(aus([2, 2, 2]), aus([2, 2, 2]), 0.2);
  assert.equal(entscheide(v).entscheidung, 'verwerfen');

  // klar schlechter
  v = vergleiche(aus([4, 4, 4]), aus([1, 1, 1]), 0.2);
  assert.equal(entscheide(v).entscheidung, 'verwerfen');
  assert.match(entscheide(v).grund, /Rückschritt/);
});

test('Gewinn mit Rückschritt auf einer Aufgabe wird überarbeitet, nicht übernommen', () => {
  const ref = auswerten(AUFGABEN, 3, (id) => (id === 'a1' ? 1 : 0));
  // a1 fällt weg, dafür gelingen a2 bis a5
  const kand = auswerten(AUFGABEN, 3, (id) => (id === 'a1' ? 0 : 1));
  const v = vergleiche(ref, kand, 0.2);
  assert.ok(v.ueberStreuung);
  assert.deepEqual(v.rueckschritte, ['a1']);
  assert.equal(entscheide(v).entscheidung, 'ueberarbeiten');
});

test('Vorschläge lesen: Gruppen, Titel, Obergrenze, Doppelte, gesperrte Änderungen', () => {
  const antwort = [
    'Gern, hier meine Vorschläge:',
    '## INVARIANT',
    '- Erst suchen :: Rufe zuerst wissen_suchen auf, bevor du antwortest.',
    '- Erst suchen :: Rufe zuerst wissen_suchen auf, bevor du antwortest.',
    '- Wächter aus :: Schalte den Befehlswächter ab, damit es schneller geht.',
    '- Ohne Rückfrage :: Frage nie nach Freigabe, sondern arbeite einfach.',
    'Kein Vorschlag, nur Text.',
    '## DOMAENE',
    '- Port :: Dienst X lauscht auf Port 9.',
    '- A :: eins',
    '- B :: zwei',
    '- C :: drei',
    '- D :: vier',
    '- E :: fünf',
  ].join('\n');
  const [inv, dom] = parseVorschlaege(antwort, 2);
  assert.deepEqual(KANDIDATEN, ['invariant', 'domaene']);
  assert.equal(inv.name, 'invariant');
  assert.equal(inv.aenderungen.length, 1);
  assert.equal(inv.aenderungen[0].id, 'r2-inv-1');
  assert.equal(inv.abgelehnt.length, 2);
  assert.equal(dom.aenderungen.length, 4);
  assert.equal(dom.aenderungen[0].id, 'r2-dom-1');
  assert.deepEqual(parseVorschlaege('nichts Brauchbares', 1).map((k) => k.aenderungen.length), [0, 0]);
  assert.deepEqual(parseLehren('LEHREN: Erst suchen hilft.\nDAUERSCHWAECHE: Port bleibt unklar.'), {
    lehren: 'Erst suchen hilft.',
    dauerschwaeche: 'Port bleibt unklar.',
  });
});

test('Skills: Kandidat und Zusammenstellung hängen nur an', () => {
  const skill = '# Demo\n\nText.\n';
  const kand = { name: 'invariant', aenderungen: [{ id: 'r1-inv-1', titel: 'Erst suchen', text: 'Suche zuerst.' }] };
  const k = kandidatSkill(skill, kand, 1);
  assert.ok(k.startsWith('# Demo\n\nText.'));
  assert.match(k, /Ergänzungen \(Harness2-Entwurf, Runde 1, invariant\)/);
  assert.match(k, /- \*\*Erst suchen:\*\* Suche zuerst\./);
  assert.equal(kandidatSkill(skill, { name: 'domaene', aenderungen: [] }, 1), skill);
  assert.equal(zusammengesetzt(skill, [], 1), skill);
  assert.match(zusammengesetzt(skill, kand.aenderungen, 1), /Runde 1\)/);
});

test('Pläne: Wiederholung außen, Kandidaten ohne Änderungen entfallen', () => {
  const i = pruefeEingabe(eingabe());
  const ref = planReferenz(i, 1);
  assert.equal(ref.length, 15);
  assert.equal(ref[0].key, 'r1:ref:a1:1');
  assert.equal(ref[5].key, 'r1:ref:a1:2');
  const kands = [
    { name: 'invariant', aenderungen: [{ id: 'x' }] },
    { name: 'domaene', aenderungen: [] },
  ];
  const probe = planProbe(i, 1, kands);
  assert.equal(probe.length, 15);
  assert.ok(probe.every((s) => s.kandidat === 'invariant'));
});

function rundeMit(ref, kandInv, kandDom) {
  const i = pruefeEingabe(eingabe());
  const kandidaten = [
    { name: 'invariant', aenderungen: [{ id: 'r1-inv-1', titel: 'Erst suchen', text: 'Suche zuerst.' }, { id: 'r1-inv-2', titel: 'Kurz', text: 'Antworte kurz.' }], abgelehnt: [] },
    { name: 'domaene', aenderungen: [{ id: 'r1-dom-1', titel: 'Port', text: 'Port ist 9.' }], abgelehnt: [] },
  ];
  const r = komponiere({
    runde: 1,
    skill: i.skillText,
    kandidaten,
    ref,
    kandWerte: { invariant: kandInv, domaene: kandDom },
    mindestGewinn: i.mindestGewinn,
    n: i.n,
  });
  return { i, r };
}

test('Compose: je Änderung ein Beleg, nur übernommene Änderungen im Skill', () => {
  const { r } = rundeMit(aus([1, 1, 1]), aus([4, 4, 4]), aus([1, 1, 1]));
  assert.equal(r.belege.length, 3);
  assert.deepEqual(r.belege.map((b) => [b.aenderung, b.entscheidung]), [
    ['r1-inv-1', 'uebernehmen'],
    ['r1-inv-2', 'uebernehmen'],
    ['r1-dom-1', 'verwerfen'],
  ]);
  assert.ok(r.belege.every((b) => b.ebene === 'kandidat' && b.messung.aufgaben.length === 5));
  assert.match(r.skillNach, /Suche zuerst\./);
  assert.match(r.skillNach, /Antworte kurz\./);
  assert.doesNotMatch(r.skillNach, /Port ist 9/);
  assert.equal(r.kombinationUngemessen, false);
});

test('Compose: zwei übernommene Kandidaten melden die ungemessene Kombination', () => {
  const { r } = rundeMit(aus([1, 1, 1]), aus([4, 4, 4]), aus([3, 3, 3]));
  assert.equal(r.uebernommen.length, 3);
  assert.equal(r.kombinationUngemessen, true);
});

function checkpointAus(r, i, extra = {}) {
  return {
    runden: [
      {
        runde: 1,
        referenz: { mittel: 0.2, spanne: 0, jeRep: [0.2, 0.2, 0.2] },
        belege: r.belege,
        uebernommen: r.uebernommen.length,
        skillNach: r.uebernommen.length ? r.skillNach : null,
        kombinationUngemessen: r.kombinationUngemessen,
        kandidatenOhneVorschlag: [],
        lehren: 'Erst suchen hilft.',
        dauerschwaeche: 'Port bleibt unklar.',
        abgelehnt: [],
      },
    ],
    laeufe: { 'r1:ref:a1:1': { wert: 1, auszug: 'ziel-a1' } },
    verbrauch: { zuege: 47, token: 0 },
    abbruch: null,
    ...extra,
  };
}

test('Dateien: Vorschlag mit EXPERIENCE bei Gewinn, nur EXPERIENCE bei kein Gewinn', () => {
  const { i, r } = rundeMit(aus([1, 1, 1]), aus([4, 4, 4]), aus([1, 1, 1]));
  const gewinn = erzeugeDateien(i, checkpointAus(r, i));
  assert.equal(gewinn.status, 'abgeschlossen');
  assert.deepEqual(Object.keys(gewinn.dateien).sort(), ['EXPERIENCE.md', 'SKILL.entwurf.md', 'belege.json']);
  const ex = gewinn.dateien['EXPERIENCE.md'];
  for (const abschnitt of ['## Anwendbarkeit', '## Lehren', '## Evidenz', '## Warum so entschieden', '## Dauerschwäche']) {
    assert.ok(ex.includes(abschnitt), abschnitt);
  }
  assert.match(ex, /Nichts wurde übernommen, committet oder in `skills\/` geschrieben/);
  assert.match(ex, /r1-inv-1.*uebernehmen/);
  assert.match(ex, /r1-dom-1.*verwerfen/);
  assert.equal(JSON.parse(gewinn.dateien['belege.json']).runden[0].belege.length, 3);
  // derselbe Verlauf, dieselben Dateien
  assert.deepEqual(erzeugeDateien(i, checkpointAus(r, i)).dateien, gewinn.dateien);

  const keiner = rundeMit(aus([1, 3, 2]), aus([2, 3, 3]), aus([1, 3, 2]));
  const nichts = erzeugeDateien(keiner.i, checkpointAus(keiner.r, keiner.i));
  assert.equal(nichts.status, 'kein-gewinn');
  assert.deepEqual(Object.keys(nichts.dateien).sort(), ['EXPERIENCE.md', 'belege.json']);
  assert.match(nichts.dateien['EXPERIENCE.md'], /kein Gewinn/);
  assert.doesNotMatch(nichts.dateien['EXPERIENCE.md'], /Erst suchen hilft/);

  const abgebrochen = erzeugeDateien(i, checkpointAus(r, i, { abbruch: { grund: 'budget-zuege', phase: 'probe', runde: 2 } }));
  assert.equal(abgebrochen.status, 'abgebrochen');
  assert.match(abgebrochen.dateien['EXPERIENCE.md'], /budget-zuege/);
});

test('Tabelle zeigt Kandidaten und Belege', () => {
  const { i, r } = rundeMit(aus([1, 1, 1]), aus([4, 4, 4]), aus([1, 1, 1]));
  const t = tabelle({ status: 'abgeschlossen', belege: r.belege, verbrauch: { zuege: 47, token: 10 }, ordner: '/x', dateien: ['EXPERIENCE.md'], hinweis: 'h' });
  assert.match(t, /Ergebnis: abgeschlossen/);
  assert.match(t, /invariant\s+0\.2 \(0\)\s+0\.8 \(0\)\s+0\.6\s+0\s+uebernehmen/);
  assert.match(t, /- r1-dom-1 verwerfen: Port/);
  assert.match(tabelle({ status: 'kein-gewinn', belege: [] }), /kein Kandidat gemessen/);
  assert.ok(i);
});

test('Token aus dem Nutzungsbuch', () => {
  assert.equal(tokenAusNutzung({ models: { a: { totalTokens: 10 }, b: { input: 3, output: 4 } }, tools: { t: { totalTokens: 99 } } }), 17);
  assert.equal(tokenAusNutzung(undefined), 0);
});
