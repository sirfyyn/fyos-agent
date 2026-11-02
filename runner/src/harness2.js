/**
 * harness2.js — die reine Logik des Harness2-Piloten (Paper arXiv:2610.14224, Propose, Probe, Compose).
 *
 * Nichts hier ruft ein Modell oder den Runner. Die Aufgabe selbst steht in `harness2-lauf.js`; dieses
 * Modul prüft Eingaben, wertet Beobachtungen aus, vergleicht Referenz und Kandidat über die
 * Wiederholungen, entscheidet je Änderung und baut die Konzeptdateien. So lässt sich jede Regel ohne
 * Modell testen.
 *
 * Was der Pilot ist und was nicht:
 *  - Es gibt keinen Wahrheitsprüfer. Eine Aufgabe trägt ein einfaches Beobachtungsmerkmal (ein Wort kommt vor,
 *    ein Werkzeug wurde benutzt, die Antwort ist kurz). Das Merkmal beobachtet Verhalten, nicht Richtigkeit.
 *  - Ein Kandidat ist eine Liste von Ergänzungen zum Skill (nur Anhängen, nie Umschreiben). Gemessen wird der Kandidat
 *    als Ganzes; der Beleg je Änderung ist deshalb ein Beleg auf Kandidatenebene und sagt das auch.
 *  - Entschieden wird nach einer festen Regel im Code, nicht durch das Modell. Das Modell schlägt vor und schreibt
 *    Lehren; die Übernahme an sich bleibt ein Vorschlag an einen Menschen.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

export const PHASEN = ['start', 'referenz', 'propose', 'probe', 'compose', 'ablegen'];
export const KANDIDATEN = ['invariant', 'domaene'];
/** Versuche je Messlauf, bevor der Pilot abbricht (ein Modellfehler ist kein Messwert). */
export const VERSUCHE_MAX = 3;
/** Eine Aufgabe gilt als Rückschritt, wenn ihr Mittel um mindestens so viel fällt. */
export const RUECKSCHRITT = 0.5;
export const AENDERUNGEN_MAX = 4;
export const EPS = 1e-6;

const SKILL_PFAD = /^skills\/agenten\/([a-z0-9][a-z0-9_-]{0,60})\/SKILL\.md$/;
/** Leitplanken und Befehlswächter sind keine editierbare Menge (INC-4869, Entscheidung Besitzer 25.10.2026). */
const SKILL_GESPERRT = /(waechter|wächter|leitplank|grenzen|sicherheit|freigabe|guardrail)/i;
/** Netz, kein Beweis: Wortmuster, die Leitplanken, Wächter oder Freigaben berühren. Übernommen wird ohnehin nichts selbst. */
const AENDERUNG_GESPERRT =
  /(leitplank|befehlsw[äa]chter|w[äa]chter\s+(aus|ab)|freigabe[^.\n]{0,40}(umgehen|überspringen|ueberspringen|ausschalten|abschalten|weglassen)|ohne\s+freigabe|(nie|nicht|kein\w*)\s+(nach\s+)?(einer\s+)?freigabe)/i;

const r4 = (x) => Math.round(x * 10000) / 10000;
const mittelwert = (liste) => liste.reduce((a, b) => a + b, 0) / liste.length;

const text = (wert, grenze) => String(wert ?? '').slice(0, grenze);

// --------------------------------------------------------------------------------------- Beobachtungsmerkmale

const MERKMAL_ARTEN = {
  enthaelt: 'Text',
  'enthaelt-nicht': 'Text',
  regex: 'Text',
  werkzeug: 'Text',
  'ohne-werkzeug': 'Text',
  'laenge-bis': 'Zahl',
  'werkzeuge-bis': 'Zahl',
};

export function pruefeMerkmal(m, wo = 'Merkmal') {
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error(`${wo}: Objekt {art, wert} erwartet`);
  const art = String(m.art ?? '');
  const sorte = MERKMAL_ARTEN[art];
  if (!sorte) throw new Error(`${wo}: unbekannte Art „${art}“ (${Object.keys(MERKMAL_ARTEN).join(', ')})`);
  if (sorte === 'Zahl') {
    const n = Number(m.wert);
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new Error(`${wo}: wert muss eine Zahl 0 bis 1000000 sein`);
    return { art, wert: n };
  }
  const liste = Array.isArray(m.wert) ? m.wert : [m.wert];
  const werte = liste.map((w) => String(w ?? '').trim()).filter(Boolean);
  if (!werte.length || werte.length > 8 || werte.some((w) => w.length > 200)) {
    throw new Error(`${wo}: wert braucht ein bis acht Texte bis 200 Zeichen`);
  }
  if (art === 'regex') {
    for (const w of werte) {
      try {
        new RegExp(w, 'i');
      } catch (fehler) {
        throw new Error(`${wo}: ungültiger regulärer Ausdruck (${fehler.message})`);
      }
    }
  }
  return { art, wert: werte.length === 1 ? werte[0] : werte };
}

export function merkmalText(m) {
  const w = Array.isArray(m.wert) ? m.wert.map((x) => `„${x}“`).join(' und ') : m.wert;
  switch (m.art) {
    case 'enthaelt':
      return `Antwort enthält ${Array.isArray(m.wert) ? 'alle von ' : ''}${Array.isArray(m.wert) ? w : `„${w}“`}`;
    case 'enthaelt-nicht':
      return `Antwort enthält nicht ${w}`;
    case 'regex':
      return `Antwort passt auf ${w}`;
    case 'werkzeug':
      return `ruft ein Werkzeug mit „${w}“ im Namen auf`;
    case 'ohne-werkzeug':
      return `ruft kein Werkzeug mit „${w}“ im Namen auf`;
    case 'laenge-bis':
      return `Antwort höchstens ${w} Zeichen`;
    case 'werkzeuge-bis':
      return `höchstens ${w} Werkzeugaufrufe`;
    default:
      return String(m.art);
  }
}

/** 1, wenn das Merkmal beobachtet wurde, sonst 0. `lauf` = { antwort, werkzeuge: [Namen] }. */
export function beobachte(m, lauf) {
  const antwort = String(lauf?.antwort ?? '');
  const klein = antwort.toLowerCase();
  const werkzeuge = (lauf?.werkzeuge ?? []).map((w) => String(w).toLowerCase());
  const liste = Array.isArray(m.wert) ? m.wert : [m.wert];
  switch (m.art) {
    case 'enthaelt':
      return liste.every((w) => klein.includes(String(w).toLowerCase())) ? 1 : 0;
    case 'enthaelt-nicht':
      return liste.some((w) => klein.includes(String(w).toLowerCase())) ? 0 : 1;
    case 'regex':
      return liste.every((w) => new RegExp(w, 'i').test(antwort)) ? 1 : 0;
    case 'werkzeug':
      return liste.every((w) => werkzeuge.some((t) => t.includes(String(w).toLowerCase()))) ? 1 : 0;
    case 'ohne-werkzeug':
      return liste.some((w) => werkzeuge.some((t) => t.includes(String(w).toLowerCase()))) ? 0 : 1;
    case 'laenge-bis':
      return antwort.length <= Number(m.wert) ? 1 : 0;
    case 'werkzeuge-bis':
      return werkzeuge.length <= Number(m.wert) ? 1 : 0;
    default:
      return 0;
  }
}

// ------------------------------------------------------------------------------------------ Eingabe prüfen

/** Planobergrenze der Züge: je Runde Referenz, ein Propose, zwei Kandidaten, ein Compose. */
export function planZuege(aufgaben, n, k) {
  return k * (aufgaben * n * 3 + 2);
}

/** Ist `ausgabe` ein Ort, an dem der Lauf nichts verloren hat (Skills-Baum)? */
export function ausgabeGesperrt(ausgabe) {
  const teile = resolve(ausgabe).split(sep);
  for (let i = 0; i < teile.length - 1; i++) {
    if (teile[i] === 'skills' && teile[i + 1] === 'agenten') return true;
  }
  return false;
}

export function pruefeEingabe(roh) {
  if (!roh || typeof roh !== 'object') throw new Error('Eingabe fehlt');
  const treffer = SKILL_PFAD.exec(String(roh.skillPfad ?? ''));
  if (!treffer) throw new Error('skillPfad muss skills/agenten/<name>/SKILL.md sein');
  const skillName = treffer[1];
  if (SKILL_GESPERRT.test(skillName)) {
    throw new Error(`Skill „${skillName}“ gehört zu Leitplanken oder Wächtern und ist nicht editierbar`);
  }
  const skillText = String(roh.skillText ?? '');
  if (skillText.length < 20 || skillText.length > 30_000) throw new Error('skillText: 20 bis 30000 Zeichen');
  const lektion = text(roh.lektion, 8000);

  if (!Array.isArray(roh.aufgaben) || roh.aufgaben.length < 5 || roh.aufgaben.length > 12) {
    throw new Error('aufgaben: fünf bis zwölf Beispielaufgaben');
  }
  const ids = new Set();
  const aufgaben = roh.aufgaben.map((a, i) => {
    const id = String(a?.id ?? '');
    if (!/^[a-z0-9_-]{1,24}$/.test(id)) throw new Error(`Aufgabe ${i + 1}: id muss ^[a-z0-9_-]{1,24}$ sein`);
    if (ids.has(id)) throw new Error(`Aufgabe ${id}: doppelte id`);
    ids.add(id);
    const aufgabe = String(a?.aufgabe ?? '').trim();
    if (aufgabe.length < 5 || aufgabe.length > 4000) throw new Error(`Aufgabe ${id}: Text 5 bis 4000 Zeichen`);
    return { id, aufgabe, merkmal: pruefeMerkmal(a?.merkmal, `Aufgabe ${id}`) };
  });

  const n = roh.n === undefined ? 3 : Number(roh.n);
  if (!Number.isInteger(n) || n < 2 || n > 10) throw new Error('n: ganze Zahl 2 bis 10 (ohne Wiederholung gibt es keine Streuung)');
  const k = roh.k === undefined ? 1 : Number(roh.k);
  if (!Number.isInteger(k) || k < 1 || k > 5) throw new Error('k: ganze Zahl 1 bis 5');

  const zuege = Number(roh.budget?.zuege);
  if (!Number.isInteger(zuege) || zuege < 1 || zuege > 5000) {
    throw new Error('budget.zuege: ganze Zahl 1 bis 5000 (harte Obergrenze, Pflicht)');
  }
  let token = null;
  if (roh.budget?.token !== undefined && roh.budget.token !== null) {
    token = Number(roh.budget.token);
    if (!Number.isInteger(token) || token < 1000) throw new Error('budget.token: ganze Zahl ab 1000 oder weglassen');
  }

  const ausgabe = String(roh.ausgabe ?? '');
  if (!ausgabe || ausgabe.includes('\u0000') || !isAbsolute(ausgabe)) throw new Error('ausgabe: absoluter Ordnerpfad');
  if (ausgabeGesperrt(ausgabe)) throw new Error('ausgabe darf nicht im Skills-Baum (skills/agenten) liegen');

  let mindestGewinn = roh.mindestGewinn === undefined ? r4(1 / aufgaben.length) : Number(roh.mindestGewinn);
  if (!Number.isFinite(mindestGewinn) || mindestGewinn < 0 || mindestGewinn > 1) throw new Error('mindestGewinn: 0 bis 1');
  mindestGewinn = r4(mindestGewinn);

  return {
    titel: text(roh.titel, 120) || `Harness2-Pilot: ${skillName}`,
    skillPfad: treffer[0],
    skillName,
    skillText,
    lektion,
    aufgaben,
    n,
    k,
    budget: { zuege, token },
    ausgabe: resolve(ausgabe),
    modell: roh.modell ? text(roh.modell, 80) : null,
    editorModell: roh.editorModell ? text(roh.editorModell, 80) : null,
    mindestGewinn,
    cwd: roh.cwd ? text(roh.cwd, 400) : null,
    elternId: roh.elternId ?? null,
    quelle: roh.quelle === 'nachtwerkstatt' ? 'nachtwerkstatt' : 'harness2',
    // Nur die Nachtwerkstatt setzt es: dann gelten für jeden neuen Zug auch Ruhefenster, Tor und GPU0-Belegung.
    nachtgate: roh.nachtgate === true,
  };
}

// ------------------------------------------------------------------------------------------- Schlüssel, Plan

export const schluessel = {
  ref: (r, aufgabe, rep) => `r${r}:ref:${aufgabe}:${rep}`,
  kand: (r, kandidat, aufgabe, rep) => `r${r}:k:${kandidat}:${aufgabe}:${rep}`,
  propose: (r) => `r${r}:propose`,
  compose: (r) => `r${r}:compose`,
};

/** Alle Messläufe der Referenz einer Runde, Wiederholung außen (gemischte Reihenfolge gegen Drift). */
export function planReferenz(input, runde) {
  const aus = [];
  for (let rep = 1; rep <= input.n; rep++) {
    for (const a of input.aufgaben) aus.push({ key: schluessel.ref(runde, a.id, rep), aufgabe: a, rep });
  }
  return aus;
}

/** Alle Messläufe der Kandidaten einer Runde; Kandidaten ohne Änderungen entfallen. */
export function planProbe(input, runde, kandidaten) {
  const aus = [];
  for (let rep = 1; rep <= input.n; rep++) {
    for (const a of input.aufgaben) {
      for (const kand of kandidaten) {
        if (!kand.aenderungen.length) continue;
        aus.push({ key: schluessel.kand(runde, kand.name, a.id, rep), aufgabe: a, rep, kandidat: kand.name });
      }
    }
  }
  return aus;
}

// ----------------------------------------------------------------------------------------------- Skill bauen

function ergaenzung(aenderungen, kopf) {
  const zeilen = aenderungen.map((a) => `- **${a.titel}:** ${a.text}`);
  return `\n\n## ${kopf}\n\n${zeilen.join('\n')}\n`;
}

/** Der Skill, unter dem ein Kandidat gemessen wird: heutiger Text plus die Ergänzungen des Kandidaten. */
export function kandidatSkill(skill, kandidat, runde) {
  if (!kandidat.aenderungen.length) return skill;
  return skill.trimEnd() + ergaenzung(kandidat.aenderungen, `Ergänzungen (Harness2-Entwurf, Runde ${runde}, ${kandidat.name})`);
}

/** Der Skill nach dem Compose: heutiger Text plus alle übernommenen Änderungen. */
export function zusammengesetzt(skill, uebernommen, runde) {
  if (!uebernommen.length) return skill;
  return skill.trimEnd() + ergaenzung(uebernommen, `Ergänzungen (Harness2-Entwurf, Runde ${runde})`);
}

// ------------------------------------------------------------------------------------------------- Aufträge

export const RAHMEN_LAUF = [
  'Du bist ein FYOS-Messlauf im Schatten (Harness2-Pilot). Bearbeite die Beispielaufgabe, die der Mensch dir gibt.',
  'Arbeite nur lesend: nichts schreiben, löschen, senden oder ausführen, was etwas verändert.',
  'Antworte knapp auf Deutsch und erfinde nichts. Der folgende Skill ist der Baustein unter Messung.',
].join('\n');

export const RAHMEN_EDITOR = [
  'Du bist der Editor des Harness2-Piloten. Du änderst nichts selbst: du schlägst Ergänzungen zu einem Skill vor,',
  'und ein Mensch entscheidet später. Du schlägst nie vor, Leitplanken, Befehlswächter oder Freigaben zu lockern.',
  'Antworte genau im verlangten Format, auf Deutsch, ohne Vorrede.',
].join('\n');

export function laufAnweisung(skillText) {
  return `${RAHMEN_LAUF}\n\n# Skill\n\n${skillText}`;
}

function kurz(textWert, grenze) {
  const s = String(textWert ?? '').replace(/\s+/g, ' ').trim();
  return s.length > grenze ? `${s.slice(0, grenze - 1)}…` : s;
}

export function proposeAuftrag({ skill, lektion, input, referenz, laeufe, runde }) {
  const zeilen = [
    'HARNESS2-PROPOSE',
    `Runde ${runde}. Schlage Ergänzungen für den Skill unten vor, in genau zwei Gruppen.`,
    '',
    'Format (jede Zeile ein Vorschlag, höchstens vier je Gruppe, nichts anderes):',
    '## INVARIANT',
    '- <Titel> :: <ein bis drei Sätze, die in den Skill angehängt werden>',
    '## DOMAENE',
    '- <Titel> :: <ein bis drei Sätze>',
    '',
    'INVARIANT = aufgabenübergreifende Schwächen: Kontext, Planung, Werkzeugnutzung, Delegation.',
    'DOMAENE = Fachwissen, Verfahren und Randbedingungen aus der Lektion unten.',
    'Nur Anhängen, kein Umschreiben. Keine Änderungen an Leitplanken, Wächtern oder Freigaben.',
    '',
    '## Skill (heute)',
    skill,
    '',
    '## Messung des heutigen Skills (Referenz)',
  ];
  for (const a of input.aufgaben) {
    const je = referenz?.jeAufgabe?.[a.id];
    zeilen.push(`- ${a.id}: Merkmal „${merkmalText(a.merkmal)}“, Mittel ${je ? je.mittel : '?'} über ${input.n} Wiederholungen.`);
    zeilen.push(`  Aufgabe: ${kurz(a.aufgabe, 240)}`);
    const proben = [];
    for (let rep = 1; rep <= input.n && proben.length < 1; rep++) {
      const rec = laeufe[schluessel.ref(runde, a.id, rep)];
      if (rec && rec.wert === 0) proben.push(rec.auszug);
    }
    if (!proben.length) {
      const rec = laeufe[schluessel.ref(runde, a.id, 1)];
      if (rec) proben.push(rec.auszug);
    }
    if (proben[0]) zeilen.push(`  Beispielantwort (Auszug): ${kurz(proben[0], 240)}`);
  }
  zeilen.push('', '## Lektion (für DOMAENE)', input.lektion ? input.lektion : '(keine Lektion angegeben; DOMAENE darf leer bleiben)');
  return zeilen.join('\n');
}

export function composeAuftrag({ runde, belege, uebernommen }) {
  const zeilen = [
    'HARNESS2-COMPOSE',
    `Runde ${runde}. Die Entscheidungen unten sind gefallen (feste Regel nach Messung). Schreibe nur:`,
    'LEHREN: <höchstens drei Zeilen, nur was die Messung stützt>',
    'DAUERSCHWAECHE: <eine Zeile: was bleibt nach diesen Änderungen schwach>',
    '',
    `Übernommen: ${uebernommen.length}.`,
  ];
  for (const b of belege) {
    zeilen.push(
      `- ${b.aenderung} (${b.kandidat}) „${b.titel}“: ${b.entscheidung}; Gewinn ${b.messung.gewinn} bei Streuung ${b.messung.streuung}.`,
    );
  }
  return zeilen.join('\n');
}

// ---------------------------------------------------------------------------------------------- Antworten lesen

/** Zerlegt die Antwort des Editors in Kandidaten. Tolerant gegen Vorrede; unbrauchbare Zeilen entfallen. */
export function parseVorschlaege(antwort, runde) {
  const kandidaten = KANDIDATEN.map((name) => ({ name, aenderungen: [], abgelehnt: [] }));
  let aktuell = null;
  const gesehen = new Set();
  for (const zeile of String(antwort ?? '').split(/\r?\n/)) {
    const kopf = /^\s{0,3}#{1,3}\s*(INVARIANT|DOMAENE|DOMÄNE)\b/i.exec(zeile);
    if (kopf) {
      aktuell = kandidaten[/^INV/i.test(kopf[1]) ? 0 : 1];
      continue;
    }
    if (!aktuell) continue;
    const punkt = /^\s*[-*]\s+(.+?)\s*::\s*(.+?)\s*$/.exec(zeile);
    if (!punkt) continue;
    const titel = kurz(punkt[1].replace(/^\*+|\*+$/g, ''), 80);
    const wert = kurz(punkt[2], 500);
    if (!titel || !wert) continue;
    if (AENDERUNG_GESPERRT.test(`${titel} ${wert}`)) {
      aktuell.abgelehnt.push({ titel, grund: 'Leitplanken, Wächter und Freigaben sind nicht editierbar' });
      continue;
    }
    const merk = `${aktuell.name}:${wert.toLowerCase()}`;
    if (gesehen.has(merk)) continue;
    gesehen.add(merk);
    if (aktuell.aenderungen.length >= AENDERUNGEN_MAX) continue;
    const kurzName = aktuell.name === 'invariant' ? 'inv' : 'dom';
    aktuell.aenderungen.push({ id: `r${runde}-${kurzName}-${aktuell.aenderungen.length + 1}`, titel, text: wert });
  }
  return kandidaten;
}

export function parseLehren(antwort) {
  const s = String(antwort ?? '');
  const lehren = /LEHREN:\s*([\s\S]*?)(?:\n\s*DAUERSCHW(?:AE|[AÄ])CHE:|$)/i.exec(s);
  const dauer = /DAUERSCHW(?:AE|[AÄ])CHE:\s*([^\n]*)/i.exec(s);
  return { lehren: kurz(lehren?.[1] ?? '', 600), dauerschwaeche: kurz(dauer?.[1] ?? '', 300) };
}

/** Summe der Tokens eines Nutzungsbuchs (`UsageDoc`): nur Modelle, ohne Werkzeugergebnisse. */
export function tokenAusNutzung(nutzung) {
  let summe = 0;
  for (const u of Object.values(nutzung?.models ?? {})) {
    const gesamt = Number(u?.totalTokens);
    summe += Number.isFinite(gesamt) && gesamt > 0
      ? gesamt
      : (Number(u?.input) || 0) + (Number(u?.output) || 0) + (Number(u?.cacheRead) || 0) + (Number(u?.cacheWrite) || 0);
  }
  return summe;
}

// --------------------------------------------------------------------------------------------- Auswerten, Compose

/**
 * Mittel und Spanne über die Wiederholungen. Je Wiederholung zählt der Mittelwert über alle Aufgaben;
 * `mittel` ist das Mittel dieser Werte, `spanne` Größtes minus Kleinstes. `wertFn(aufgabeId, rep)` liefert 0/1
 * oder `undefined`, wenn der Lauf fehlt; dann gibt es kein Ergebnis (`null`).
 */
export function auswerten(aufgaben, n, wertFn) {
  const jeRep = [];
  const jeAufgabeWerte = Object.fromEntries(aufgaben.map((a) => [a.id, []]));
  for (let rep = 1; rep <= n; rep++) {
    let summe = 0;
    for (const a of aufgaben) {
      const w = wertFn(a.id, rep);
      if (typeof w !== 'number') return null;
      summe += w;
      jeAufgabeWerte[a.id].push(w);
    }
    jeRep.push(summe / aufgaben.length);
  }
  const jeAufgabe = {};
  for (const [id, werte] of Object.entries(jeAufgabeWerte)) {
    jeAufgabe[id] = { mittel: r4(mittelwert(werte)), spanne: r4(Math.max(...werte) - Math.min(...werte)) };
  }
  return {
    mittel: r4(mittelwert(jeRep)),
    spanne: r4(Math.max(...jeRep) - Math.min(...jeRep)),
    min: r4(Math.min(...jeRep)),
    max: r4(Math.max(...jeRep)),
    jeRep: jeRep.map(r4),
    jeAufgabe,
  };
}

/** Referenz gegen Kandidat. Gewinn zählt nur über der größeren der beiden gemessenen Spannen und über dem Mindestgewinn. */
export function vergleiche(ref, kand, mindestGewinn) {
  const gewinn = r4(kand.mittel - ref.mittel);
  const streuung = r4(Math.max(ref.spanne, kand.spanne));
  const ueber = gewinn > streuung + EPS && gewinn + EPS >= mindestGewinn;
  const schlechter = -gewinn > streuung + EPS && -gewinn + EPS >= mindestGewinn;
  const aufgaben = Object.keys(ref.jeAufgabe).map((id) => {
    const a = ref.jeAufgabe[id];
    const b = kand.jeAufgabe[id];
    return { id, ref: a.mittel, kand: b.mittel, diff: r4(b.mittel - a.mittel) };
  });
  const rueckschritte = aufgaben.filter((a) => a.diff <= -RUECKSCHRITT + EPS).map((a) => a.id);
  return {
    refMittel: ref.mittel,
    refSpanne: ref.spanne,
    kandMittel: kand.mittel,
    kandSpanne: kand.spanne,
    gewinn,
    streuung,
    mindestGewinn,
    ueberStreuung: ueber,
    schlechterAlsStreuung: schlechter,
    aufgaben,
    rueckschritte,
  };
}

/** Die feste Entscheidungsregel. Rückgabe: { entscheidung, grund }. */
export function entscheide(v) {
  if (v.ueberStreuung) {
    if (v.rueckschritte.length) {
      return {
        entscheidung: 'ueberarbeiten',
        grund: `Gewinn ${v.gewinn} über Streuung ${v.streuung}, aber Rückschritt bei ${v.rueckschritte.join(', ')}; nicht übernommen, Überarbeitung durch einen Menschen`,
      };
    }
    return { entscheidung: 'uebernehmen', grund: `Gewinn ${v.gewinn} über Streuung ${v.streuung} (Mindestgewinn ${v.mindestGewinn})` };
  }
  if (v.schlechterAlsStreuung) {
    return { entscheidung: 'verwerfen', grund: `Rückschritt ${v.gewinn} jenseits der Streuung ${v.streuung}` };
  }
  return { entscheidung: 'verwerfen', grund: `kein Gewinn über der Streuung (Gewinn ${v.gewinn}, Streuung ${v.streuung}, Mindestgewinn ${v.mindestGewinn})` };
}

/**
 * Compose einer Runde: aus den gemessenen Kandidaten die Belege je Änderung und der zusammengesetzte Skill.
 * `ref` und `kandWerte` ({name: auswertung}) sind bereits ausgewertet. Reine Funktion, deterministisch.
 */
export function komponiere({ runde, skill, kandidaten, ref, kandWerte, mindestGewinn, n }) {
  const belege = [];
  const uebernommen = [];
  for (const kand of kandidaten) {
    if (!kand.aenderungen.length) continue;
    const aus = kandWerte[kand.name];
    if (!aus) continue;
    const v = vergleiche(ref, aus, mindestGewinn);
    const { entscheidung, grund } = entscheide(v);
    for (const a of kand.aenderungen) {
      belege.push({
        runde,
        aenderung: a.id,
        kandidat: kand.name,
        titel: a.titel,
        text: a.text,
        entscheidung,
        grund,
        ebene: 'kandidat',
        n,
        messung: v,
      });
      if (entscheidung === 'uebernehmen') uebernommen.push(a);
    }
  }
  const kandidatenOhneBeleg = kandidaten.filter((k) => !k.aenderungen.length).map((k) => k.name);
  const quellen = new Set(belege.filter((b) => b.entscheidung === 'uebernehmen').map((b) => b.kandidat));
  return {
    runde,
    belege,
    uebernommen,
    skillNach: zusammengesetzt(skill, uebernommen, runde),
    kandidatenOhneVorschlag: kandidatenOhneBeleg,
    // Mehrere Kandidaten zusammen wurden nie gemeinsam gemessen.
    kombinationUngemessen: quellen.size > 1,
  };
}

// ---------------------------------------------------------------------------------------------------- Bericht

export function endStatus(cp) {
  if (cp.abbruch) return 'abgebrochen';
  return (cp.runden ?? []).some((r) => r.uebernommen > 0) ? 'abgeschlossen' : 'kein-gewinn';
}

/** Der Skill, den der Lauf vorschlägt: Ergebnis der letzten Runde mit Übernahmen, sonst null. */
export function vorschlagSkill(cp, input) {
  let skill = null;
  for (const r of cp.runden ?? []) if (r.uebernommen > 0) skill = r.skillNach;
  return skill && skill !== input.skillText ? skill : null;
}

function evidenzTabelle(runden) {
  const zeilen = ['| Runde | Kandidat | Referenz Mittel (Spanne) | Kandidat Mittel (Spanne) | Gewinn | Streuung | Entscheidung |', '|---|---|---|---|---|---|---|'];
  for (const r of runden) {
    const gesehen = new Set();
    for (const b of r.belege) {
      if (gesehen.has(b.kandidat)) continue;
      gesehen.add(b.kandidat);
      const m = b.messung;
      zeilen.push(
        `| ${r.runde} | ${b.kandidat} | ${m.refMittel} (${m.refSpanne}) | ${m.kandMittel} (${m.kandSpanne}) | ${m.gewinn} | ${m.streuung} | ${b.entscheidung} |`,
      );
    }
  }
  return zeilen.length > 2 ? zeilen.join('\n') : '(keine Kandidaten gemessen)';
}

/** Aufgaben, die auch im besten gemessenen Fall unter 1,0 blieben: die Dauerschwäche, die die Messung zeigt. */
function gemesseneDauerschwaeche(runden, input) {
  const letzte = [...runden].reverse().find((r) => r.belege.length);
  if (!letzte) return 'Nicht bestimmbar: es wurde kein Kandidat gemessen.';
  const bester = [...letzte.belege].sort((a, b) => b.messung.kandMittel - a.messung.kandMittel)[0];
  const schwach = bester.messung.aufgaben.filter((a) => a.kand < 1 - EPS).map((a) => `${a.id} (${a.kand})`);
  if (!schwach.length) return `Im besten gemessenen Kandidaten (${bester.kandidat}) zeigten alle ${input.aufgaben.length} Aufgaben das Merkmal in jeder Wiederholung.`;
  return `Im besten gemessenen Kandidaten (${bester.kandidat}) blieb das Merkmal bei ${schwach.join(', ')} unter 1,0.`;
}

/**
 * Alle Dateien des Ergebnisses. Kein Zeitstempel und keine Lauf-Kennung im Inhalt: derselbe Verlauf liefert
 * dieselben Dateien, auch nach einem Neustart mitten im Lauf.
 */
export function erzeugeDateien(input, cp) {
  const status = endStatus(cp);
  const runden = cp.runden ?? [];
  const vorschlag = vorschlagSkill(cp, input);
  const belege = runden.flatMap((r) => r.belege);
  const uebernommen = belege.filter((b) => b.entscheidung === 'uebernehmen');
  const zuege = cp.verbrauch?.zuege ?? 0;

  const dateien = {};
  if (vorschlag) dateien['SKILL.entwurf.md'] = vorschlag.endsWith('\n') ? vorschlag : `${vorschlag}\n`;

  const kette = runden
    .map((r) => `Runde ${r.runde}: Referenz Mittel ${r.referenz.mittel} (Spanne ${r.referenz.spanne}), übernommen ${r.uebernommen}${r.kombinationUngemessen ? ', Kombination mehrerer Kandidaten nicht gemessen' : ''}`)
    .join('\n- ');

  const lehren = [];
  if (uebernommen.length) {
    for (const r of runden) if (r.uebernommen > 0 && r.lehren) lehren.push(`- Runde ${r.runde} (Vorschlag des Modells, nicht geprüft): ${r.lehren}`);
    if (!lehren.length) lehren.push('- Das Modell hat keine Lehre geschrieben; die Messung stützt nur die übernommenen Änderungen unten.');
  } else {
    lehren.push('- Keine. Gewinn nicht über der gemessenen Streuung, nichts übernommen (kein Gewinn).');
  }

  const warum = belege.length
    ? belege
        .map((b) => `- **${b.aenderung}** (${b.kandidat}) „${b.titel}“: ${b.entscheidung}. ${b.grund}. Beleg auf Kandidatenebene: alle Änderungen dieses Kandidaten wurden gemeinsam gemessen.`)
        .join('\n')
    : '- Es wurde keine Änderung gemessen.';

  const dauer = [gemesseneDauerschwaeche(runden, input)];
  for (const r of runden) if (r.dauerschwaeche) dauer.push(`Modell (Runde ${r.runde}, nicht geprüft): ${r.dauerschwaeche}`);

  const abgelehnt = runden.flatMap((r) => r.abgelehnt ?? []);

  const ex = [
    `# EXPERIENCE (Entwurf, Harness2-Pilot): ${input.skillName}`,
    '',
    `Ergebnis: **${status}**${cp.abbruch ? ` (Grund: ${cp.abbruch.grund}, Runde ${cp.abbruch.runde}, Phase ${cp.abbruch.phase}; Teilergebnis)` : ''}`,
    '',
    'Dies ist ein Vorschlag zur Durchsicht. Nichts wurde übernommen, committet oder in `skills/` geschrieben.',
    '',
    '## Anwendbarkeit',
    '',
    `- Skill: \`${input.skillPfad}\``,
    `- Gemessen auf ${input.aufgaben.length} Beispielaufgaben (${input.aufgaben.map((a) => a.id).join(', ')}), ${input.n} Wiederholungen je Bedingung, Tiefe k=${input.k} (gelaufen: ${runden.length} Runde${runden.length === 1 ? '' : 'n'}).`,
    `- Das Beobachtungsmerkmal einer Aufgabe beschreibt Verhalten, nicht Richtigkeit. Gilt nur für diese Aufgaben unter diesem Modell (${input.modell ?? 'Standardmodell des Runners'}).`,
    // Token stehen im Ergebnis des Laufs, nicht hier: sie hängen am Zwischenspeicher des Modells und wären nach einem Neustart anders.
    `- Verbrauch: ${zuege} Züge (Obergrenze ${input.budget.zuege}${input.budget.token ? ` Züge, ${input.budget.token} Token` : ' Züge'}).`,
    '',
    '## Lehren',
    '',
    ...lehren,
    '',
    '## Evidenz',
    '',
    evidenzTabelle(runden),
    '',
    `Mindestgewinn ${input.mindestGewinn}; Gewinn zählt nur über der größeren Spanne von Referenz und Kandidat. Spanne = Größtes minus Kleinstes der ${input.n} Wiederholungswerte.`,
    '',
    kette ? `- ${kette}` : '- (keine abgeschlossene Runde)',
    '',
    '## Warum so entschieden',
    '',
    warum,
    ...(abgelehnt.length
      ? ['', 'Verworfen vor der Messung (Leitplanken, Wächter und Freigaben sind nicht editierbar):', ...abgelehnt.map((a) => `- „${a.titel}“`)]
      : []),
    '',
    '## Dauerschwäche',
    '',
    ...dauer.map((d) => `- ${d}`),
    '',
    '## Grenzen dieser Messung',
    '',
    '- Kein Wahrheitsprüfer: ein Gewinn heißt „das Merkmal tritt öfter auf“, nicht „die Antworten sind richtiger“.',
    '- Streuung wurde aus nur wenigen Wiederholungen geschätzt; gemeinsame Modellverzerrung ist nicht ausgeschlossen.',
    ...(runden.some((r) => r.kombinationUngemessen) ? ['- Übernommene Änderungen aus mehreren Kandidaten wurden nicht gemeinsam gemessen.'] : []),
    ...(vorschlag && input.k < 2 ? ['- Der zusammengesetzte Skill selbst wurde bei k=1 nicht noch einmal gemessen; gemessen sind nur die Kandidaten.'] : []),
    '- Übernahme nur durch Freigabe eines Menschen und die Regel „3 Abrufe aus 3 Fragen“; kein Auto-Merge.',
    '',
  ];
  dateien['EXPERIENCE.md'] = ex.join('\n');

  const laeufe = Object.fromEntries(
    Object.entries(cp.laeufe ?? {})
      .filter(([, rec]) => typeof rec.wert === 'number')
      .map(([key, rec]) => [key, { wert: rec.wert, auszug: rec.auszug ?? '' }]),
  );
  dateien['belege.json'] = `${JSON.stringify(
    {
      status,
      abbruch: cp.abbruch ?? null,
      skill: input.skillPfad,
      aufgaben: input.aufgaben.map((a) => ({ id: a.id, merkmal: a.merkmal })),
      n: input.n,
      k: input.k,
      mindestGewinn: input.mindestGewinn,
      runden: runden.map((r) => ({
        runde: r.runde,
        referenz: r.referenz,
        belege: r.belege,
        uebernommen: r.uebernommen,
        kombinationUngemessen: r.kombinationUngemessen,
        kandidatenOhneVorschlag: r.kandidatenOhneVorschlag,
      })),
      laeufe,
    },
    null,
    2,
  )}\n`;
  return { status, dateien };
}

/** Schreibt die Dateien in einen Ordner, den dieser Lauf allein besitzt. Gibt die Dateinamen zurück. */
export function schreibeDateien(ordner, dateien) {
  mkdirSync(ordner, { recursive: true });
  const namen = Object.keys(dateien).sort();
  for (const name of namen) writeFileSync(join(ordner, name), dateien[name], 'utf8');
  return namen;
}

/** Name des Ergebnisordners: eigener Unterordner je Lauf, nie ein vorhandener Ordner des Menschen. */
export function ergebnisOrdner(input, taskId) {
  return join(input.ausgabe, `${input.skillName}-lauf${taskId}`);
}

// ----------------------------------------------------------------------------------------------- Tabelle (CLI)

const feld = (s, breite) => String(s).padEnd(breite);

/** Die Ausgabetabelle des Starters aus dem Ergebnis eines Laufs (`outcome.result`). */
export function tabelle(ergebnis) {
  const z = [];
  z.push(`Ergebnis: ${ergebnis.status}${ergebnis.grund ? ` (${ergebnis.grund})` : ''}`);
  const kopf = ['Runde', 'Kandidat', 'Referenz', 'Kandidat', 'Gewinn', 'Streuung', 'Entscheidung'];
  const zeilen = [kopf];
  for (const b of ergebnis.belege ?? []) {
    const m = b.messung;
    zeilen.push([
      String(b.runde),
      b.kandidat,
      `${m.refMittel} (${m.refSpanne})`,
      `${m.kandMittel} (${m.kandSpanne})`,
      String(m.gewinn),
      String(m.streuung),
      b.entscheidung,
    ]);
  }
  // Eine Zeile je Kandidat genügt für die Tabelle; die Belege je Änderung folgen darunter.
  const gesehen = new Set();
  const eindeutig = zeilen.filter((r, i) => {
    if (i === 0) return true;
    const k = `${r[0]}|${r[1]}`;
    if (gesehen.has(k)) return false;
    gesehen.add(k);
    return true;
  });
  const breiten = kopf.map((_, i) => Math.max(...eindeutig.map((r) => String(r[i]).length)));
  for (const r of eindeutig) z.push(r.map((c, i) => feld(c, breiten[i])).join('  ').trimEnd());
  if (eindeutig.length === 1) z.push('(kein Kandidat gemessen)');
  z.push('');
  z.push('Belege je Änderung:');
  for (const b of ergebnis.belege ?? []) z.push(`- ${b.aenderung} ${b.entscheidung}: ${b.titel} | ${b.grund}`);
  if (!(ergebnis.belege ?? []).length) z.push('- keine');
  if (ergebnis.verbrauch) z.push('', `Verbrauch: ${ergebnis.verbrauch.zuege} Züge, ${ergebnis.verbrauch.token} Token`);
  if (ergebnis.ordner) z.push(`Ordner: ${ergebnis.ordner}`, `Dateien: ${(ergebnis.dateien ?? []).join(', ') || '-'}`);
  if (ergebnis.hinweis) z.push('', ergebnis.hinweis);
  return z.join('\n');
}

export const HINWEIS_MESSUNG =
  'Vorschlag, nicht übernommen. Ein Lauf mit Faux-Modell misst nichts über Persona; ein Gewinn heißt nur, dass das Beobachtungsmerkmal öfter auftrat.';
