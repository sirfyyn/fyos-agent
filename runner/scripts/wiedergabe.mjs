#!/usr/bin/env node
/**
 * wiedergabe.mjs — eine Runner-Aufzeichnung gegen Reflexe und Weltblock abspielen (wie `rosbag play`).
 *
 * Port von deploy/runner/wiedergabe.py: ohne Modell, ohne Hub, ohne Netz, ohne GPU. Die
 * Aufzeichnung schreibt `src/aufzeichnung.js` (oder der RPC-Runner) als JSONL je Tag. Abgespielt
 * werden `welt` (das jeweils gültige Weltbild, danach die Herzschlag-Reflexe) und `eingang` (die
 * Eingangs-Reflexe gegen das Weltbild jener Zeit, mit den damals live gemessenen Angaben wie dem
 * Spielmodus; für Ereignisse, die an den Agenten gingen, auch `vor_pi` und der Weltblock).
 * Für Aufzeichnungen des RPC-Runners (Variante B) rechnet `sitzungenNachrechnen` die Sitzungswahl jedes Zugs
 * (`sitzungFuer`: Haupt-, neue oder fortgesetzte Arbeitssitzung) gegen das damalige Sitzungsverzeichnis nach und
 * zählt Berichte und Unterbrechungen — dieselbe Semantik wie `wiedergabe.py`. Der dauerhafte Runner schreibt keine
 * `sitzung`-Zeilen; seine Aufzeichnungen liefern dort nur Zähler.
 *
 *   node scripts/wiedergabe.mjs AUFZEICHNUNG.jsonl [--reflexe reflexe.yaml] [--block]
 *                               [--block-max 1500] [--vergleichen] [--json]
 *
 * --vergleichen  stellt die neuen Entscheidungen den aufgezeichneten gegenüber; Rückgabe 1 bei
 *                Abweichung — so wird eine geänderte reflexe.yaml gegen einen echten Tag geprüft.
 * --block        zeigt den Weltblock je Ereignis, das an den Agenten ginge.
 * --json         eine JSON-Zeile je Schritt statt Text (für Auswertungen).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_RUNNER } from '../src/config.js';
import { Regelwerk } from '../src/reflexe.js';
import { weltAbleiten, weltblock } from '../src/welt.js';

/** Was beim Vergleich zählt: Regeln, an_pi und die Aktionen (Art, Regel, Text). */
export function schluessel(entscheidung) {
  return JSON.stringify([
    entscheidung.regeln ?? [],
    entscheidung.an_pi ?? null,
    (entscheidung.aktionen ?? []).map((a) => [a.art ?? null, a.regel ?? null, a.text ?? null]),
  ]);
}

/** Ganzzahl wie Pythons `int(x or 0)`: Zahl oder Zahlentext, sonst 0. */
const ganz = (w) => Math.trunc(Number(w) || 0);

/**
 * In welcher Sitzung läuft der Auftrag? ['haupt', null] | ['neu', null] | ['fortsetzen', schluessel].
 * Port von `sitzung_fuer` (deploy/runner/agent_runner.py): Besitzer (Klasse `max`) immer in der Hauptsitzung; ein unterbrochener
 * Hintergrundauftrag trägt den Schlüssel seiner Sitzung (`fortsetzen`); ein Ereignis mit demselben `bezug` wie eine noch nicht
 * abgelaufene Arbeitssitzung (fertig oder unterbrochen, mit Datei) läuft dort weiter; sonst eine neue.
 */
export function sitzungFuer(auftrag, sitzungen, jetzt, fristMs) {
  if (auftrag.klasse === 'max') return ['haupt', null];
  const schluessel = auftrag.fortsetzen;
  if (typeof schluessel === 'string' && Object.hasOwn(sitzungen, schluessel)) return ['fortsetzen', schluessel];
  const bezug = auftrag.bezug;
  if (bezug) {
    let beste = null;
    for (const [k, e] of Object.entries(sitzungen)) {
      const ende = ganz(e.ende || e.beginn);
      if (e.bezug === bezug && (e.status === 'fertig' || e.status === 'unterbrochen') && e.datei && jetzt - ende <= fristMs) {
        // Wie Pythons max() über (ende, schluessel)-Paare.
        if (!beste || ende > beste[0] || (ende === beste[0] && k > beste[1])) beste = [ende, k];
      }
    }
    if (beste) return ['fortsetzen', beste[1]];
  }
  return ['neu', null];
}

/**
 * Variante B: die Sitzungswahl jedes aufgezeichneten Zugs gegen das Verzeichnis jener Zeit nachrechnen. Port von
 * `sitzungen_nachrechnen` (deploy/runner/wiedergabe.py). Liefert { zaehler, abweichungen }; Aufzeichnungen ohne
 * Sitzungsangaben (auch die des dauerhaften Runners): nur Zähler, keine Abweichung.
 */
export function sitzungenNachrechnen(zeilen, { fristH = 168 } = {}) {
  const verzeichnis = new Map();
  const vorher = new Map(); // Stand vor der letzten Änderung je Eintrag
  const zaehler = {};
  const abweichungen = [];
  const fristMs = Math.trunc(fristH * 3_600_000);
  const zaehle = (k) => {
    zaehler[k] = (zaehler[k] ?? 0) + 1;
  };
  for (const zeile of zeilen) {
    const art = zeile.art;
    if (art === 'sitzung' && zeile.eintrag) {
      const schluessel = String(zeile.eintrag);
      vorher.set(schluessel, verzeichnis.get(schluessel) ?? null);
      const eintrag = {};
      for (const k of ['status', 'bezug', 'beginn', 'ende', 'datei']) eintrag[k] = zeile[k] ?? null;
      verzeichnis.set(schluessel, eintrag);
    } else if (art === 'zug' && zeile.sitzung) {
      // Der Runner vermerkt die gewählte Sitzung kurz vor der zug-Zeile; entschieden hat er über den Stand davor.
      const damals = new Map(verzeichnis);
      if (zeile.eintrag && vorher.has(String(zeile.eintrag))) {
        const alt = vorher.get(String(zeile.eintrag));
        if (alt === null) damals.delete(String(zeile.eintrag));
        else damals.set(String(zeile.eintrag), alt);
      }
      const auftrag = {};
      for (const k of ['klasse', 'bezug', 'fortsetzen']) if (zeile[k]) auftrag[k] = zeile[k];
      const [modus, schluessel] = sitzungFuer(auftrag, Object.fromEntries(damals), ganz(zeile.t), fristMs);
      zaehle(`zug:${zeile.sitzung}`);
      const erwartet = [zeile.sitzung, zeile.sitzung === 'fortsetzen' ? (zeile.eintrag ?? null) : null];
      if (modus !== erwartet[0] || schluessel !== erwartet[1]) {
        abweichungen.push({ sitzung: true, t: zeile.t ?? null, ein: zeile.ein ?? null, aufgezeichnet: erwartet, neu: [modus, schluessel] });
      }
    } else if (art === 'bericht' || art === 'unterbrechung') {
      zaehle(art);
    }
  }
  return { zaehler, abweichungen };
}

/** Spielt die Zeilen ab und liefert { schritte, abweichungen, zaehler, sitzungen }. Rein. */
export function abspielen(zeilen, regelwerk, { blockMax = 1500 } = {}) {
  let welt = null;
  const schritte = [];
  const abweichungen = [];
  const zaehler = {};
  const neuJeEin = new Map();
  const neuHerzschlag = [];
  const altHerzschlag = [];
  const zaehle = (z, k) => {
    z[k] = (z[k] ?? 0) + 1;
  };

  for (const zeile of zeilen) {
    const art = zeile.art;
    const t = Math.trunc(Number(zeile.t) || 0);
    if (art === 'welt' && zeile.welt && typeof zeile.welt === 'object') {
      welt = zeile.welt;
      if (regelwerk.hat('herzschlag')) {
        const e = regelwerk.herzschlag(weltAbleiten(welt, Math.trunc(Number(welt.t) || t)));
        neuHerzschlag.push(e);
        for (const r of e.regeln) zaehle(zaehler, r.split(':')[0]);
        if (e.regeln.length) schritte.push({ t, art: 'herzschlag', ...e });
      }
    } else if (art === 'eingang' && zeile.ereignis && typeof zeile.ereignis === 'object') {
      const ereignis = zeile.ereignis;
      const basis = { ...(welt ?? { v: 1, t, quellen: {} }) };
      // Damals live gemessen (Spielmodus …).
      for (const [k, w] of Object.entries(zeile.live ?? {})) basis[k] = { wert: w, t, quelle: 'runner' };
      const abgeleitet = weltAbleiten(basis, t);
      const e = regelwerk.eingang(ereignis, abgeleitet);
      for (const r of e.regeln) zaehle(zaehler, r);
      const schritt = {
        t, art: 'eingang', ein: String(ereignis.id ?? ''),
        quelle: ereignis.quelle, klasse: ereignis.klasse, ...e,
      };
      if (e.an_pi) {
        const auftrag = {
          klasse: ereignis.klasse === 'max' ? 'max' : 'hintergrund',
          quelle: ereignis.quelle,
          ein: schritt.ein,
        };
        schritt.halten = regelwerk.vorPi(auftrag, abgeleitet);
        schritt.block = welt ? weltblock(basis, t, blockMax) : '';
      }
      neuJeEin.set(schritt.ein, e);
      schritte.push(schritt);
    } else if (art === 'entscheidung') {
      if (zeile.anlass === 'herzschlag') altHerzschlag.push(zeile);
      else if (zeile.ein !== undefined && zeile.ein !== null) {
        const neu = neuJeEin.get(String(zeile.ein));
        if (!neu || schluessel(neu) !== schluessel(zeile)) {
          abweichungen.push({ ein: zeile.ein, aufgezeichnet: schluessel(zeile), neu: neu ? schluessel(neu) : null });
        }
      }
    }
  }
  // Herzschlag-Entscheidungen: als Folge vergleichen (nur die, die etwas auslösten).
  const neuFolge = neuHerzschlag.filter((e) => e.regeln.length).map(schluessel);
  const altFolge = altHerzschlag.map(schluessel);
  if (JSON.stringify(neuFolge) !== JSON.stringify(altFolge)) {
    abweichungen.push({ herzschlag: true, aufgezeichnet: altFolge, neu: neuFolge });
  }
  // Neue Treffer ohne aufgezeichnete Entscheidung sind ebenfalls eine Abweichung.
  const alteEin = new Set(
    zeilen.filter((z) => z.art === 'entscheidung' && z.ein !== undefined && z.ein !== null).map((z) => String(z.ein)),
  );
  for (const [ein, e] of neuJeEin) {
    if (e.regeln.length && !alteEin.has(ein)) abweichungen.push({ ein, aufgezeichnet: null, neu: schluessel(e) });
  }
  const sitzungen = sitzungenNachrechnen(zeilen);
  abweichungen.push(...sitzungen.abweichungen);
  return { schritte, abweichungen, zaehler, sitzungen: sitzungen.zaehler };
}

export function zeilenLesen(pfad, fehlerAus = (z) => console.error(z)) {
  const zeilen = [];
  readFileSync(pfad, 'utf8')
    .split('\n')
    .forEach((roh, i) => {
      if (!roh.trim()) return;
      try {
        const obj = JSON.parse(roh);
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) zeilen.push(obj);
      } catch {
        fehlerAus(`Zeile ${i + 1}: kein JSON, übersprungen`);
      }
    });
  return zeilen;
}

function argumente(argv) {
  const a = { aufzeichnung: null, reflexe: join(REPO_RUNNER, 'reflexe.yaml'), block: false, blockMax: 1500, vergleichen: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const w = argv[i];
    if (w === '--reflexe') a.reflexe = argv[++i];
    else if (w === '--block') a.block = true;
    else if (w === '--block-max') a.blockMax = Number(argv[++i]);
    else if (w === '--vergleichen') a.vergleichen = true;
    else if (w === '--json') a.json = true;
    else if (!w.startsWith('--') && !a.aufzeichnung) a.aufzeichnung = w;
    else throw new Error(`Unbekanntes Argument: ${w}`);
  }
  if (!a.aufzeichnung) throw new Error('Aufruf: wiedergabe.mjs AUFZEICHNUNG.jsonl [--reflexe DATEI] [--block] [--block-max N] [--vergleichen] [--json]');
  return a;
}

export function main(argv = process.argv.slice(2), ausgabe = (z) => console.log(z)) {
  const args = argumente(argv);
  const regelwerk = Regelwerk.laden(args.reflexe);
  const zeilen = zeilenLesen(args.aufzeichnung);
  const ergebnis = abspielen(zeilen, regelwerk, { blockMax: args.blockMax });

  for (const s of ergebnis.schritte) {
    if (args.json) {
      ausgabe(JSON.stringify(s));
      continue;
    }
    const aktionen = (s.aktionen ?? []).map((a) => `${a.art}(${a.regel})`).join(', ') || '—';
    if (s.art === 'herzschlag') {
      ausgabe(`${s.t} herzschlag  Regeln ${s.regeln.join(',')}  → ${aktionen}`);
      continue;
    }
    let weg = s.an_pi ? 'an pi' : 'NICHT an pi';
    if (s.halten) weg = `wartet (Reflex ${s.halten})`;
    ausgabe(`${s.t} eingang ${s.ein || '-'} ${s.quelle}/${s.klasse}  → ${aktionen}; ${weg}`);
    if (args.block && s.block) ausgabe('    ' + s.block.replaceAll('\n', '\n    '));
  }
  const eingaenge = ergebnis.schritte.filter((s) => s.art === 'eingang').length;
  const zusammen = {
    zeilen: zeilen.length,
    eingaenge,
    welt: zeilen.filter((z) => z.art === 'welt').length,
    ausgeloest: ergebnis.zaehler,
    sitzungen: ergebnis.sitzungen,
    abweichungen: ergebnis.abweichungen.length,
  };
  if (args.json) {
    ausgabe(JSON.stringify({ zusammenfassung: zusammen, abweichungen: ergebnis.abweichungen }));
  } else {
    ausgabe(`\n${zusammen.zeilen} Zeilen, ${eingaenge} Eingänge, ${zusammen.welt} Weltbilder; ausgelöst: ${JSON.stringify(ergebnis.zaehler)}`);
    if (Object.keys(ergebnis.sitzungen).length) ausgabe(`Sitzungen (Variante B): ${JSON.stringify(ergebnis.sitzungen)}`);
    if (args.vergleichen) {
      ausgabe(`Abweichungen zur Aufzeichnung: ${ergebnis.abweichungen.length}`);
      for (const a of ergebnis.abweichungen.slice(0, 20)) ausgabe('   ' + JSON.stringify(a));
    }
  }
  return args.vergleichen && ergebnis.abweichungen.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (fehler) {
    console.error(fehler.message);
    process.exitCode = 2;
  }
}
