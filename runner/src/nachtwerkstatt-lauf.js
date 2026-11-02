/**
 * nachtwerkstatt-lauf.js — die Aufgaben der Nachtwerkstatt auf dem Gerüst von zug.js.
 *
 *   fyos.nachtwerkstatt            die Nacht: Dreaming → Skillsmith → Nodesmith → Morgenbericht (je Schmiede ein Kind)
 *   fyos.nachtwerkstatt.dreaming   Tagesspur lesen, Episode und Kandidaten schreiben (S10)
 *   fyos.nachtwerkstatt.skillsmith einen Skill über den Harness2-Piloten verbessern (S11)
 *   fyos.nachtwerkstatt.nodesmith  Knoten nur lesend untersuchen, Steckbriefe fortschreiben
 *
 * Jede Schmiede hat dieselben Phasen mit Prüfpunkt: start → sammeln → analysieren → vorschlagen → ablegen.
 * Nur Vorschläge: Dateien in einem Ordner mit Datum, nichts wird übernommen, nichts angelegt, kein Git.
 * Vor jedem neuen Modellzug gilt das Nachttor (Ruhefenster 22–7, Spielmodus/Pause-Marken, schleifen.darf):
 * ist es zu, pausiert die Aufgabe an dieser Stelle und setzt im nächsten Fenster dort fort. Obergrenzen für Züge
 * und Token je Schmiede sind hart. Keine GPU-Buchung: Persona läuft ohnehin auf GPU0 (Besitzer, 25.10.2026).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Schema as Type, aufgabe as defineTask, werkzeug as defineTool } from './lauf/index.js';
import { LaufListe, NachtDoc } from './documents.js';
import { RAHMEN_EDITOR, pruefeEingabe, tabelle } from './harness2.js';
import {
  SCHMIEDEN,
  dreamingAuftraege,
  dreamingDateien,
  liesLektionen,
  liesSpuren,
  liesTagesspur,
  knotenBuendel,
  auswertenKnoten,
  materialText,
  morgenbericht,
  nachtDatum,
  nachtKonfig,
  nodesmithAuftrag,
  nodesmithDateien,
  offeneVorschlaege,
  parseKandidaten,
  parseNodesmith,
  ruhefenster,
  skillsmithDateien,
  waehleSkill,
} from './nachtwerkstatt.js';
import { erstelleZug, listeAktualisieren } from './zug.js';

const RAHMEN_NACHT = `${RAHMEN_EDITOR}\nDu arbeitest in der Nachtwerkstatt: lesend, ohne Wirkung, nur Vorschläge für einen Menschen.`;

/** Dateien mit Unterordnern in den Ergebnisordner schreiben; Namen dürfen nicht ausbrechen. */
export function schreibeBaum(ordner, dateien) {
  const namen = Object.keys(dateien).sort();
  for (const name of namen) {
    if (name.startsWith('/') || name.split('/').includes('..')) throw new Error(`Dateiname ausserhalb des Ordners: ${name}`);
    const pfad = join(ordner, name);
    mkdirSync(dirname(pfad), { recursive: true });
    writeFileSync(pfad, dateien[name], 'utf8');
  }
  return namen;
}

const leseOderLeer = (pfad, n = 4000) => {
  try {
    return readFileSync(pfad, 'utf8').slice(0, n);
  } catch {
    return '';
  }
};

export function erstelleNachtwerkstatt(cfg, { spielmodus, tor, knoten, harness2Task, jetzt = () => Date.now(), pauseMs } = {}) {
  const nk = nachtKonfig(cfg);
  const zug = erstelleZug(cfg, { spielmodus, pauseMs, gate: tor });
  const pause = Math.max(50, Number(pauseMs ?? cfg.nachtwerkstatt?.pause_ms ?? cfg.harness2?.pause_ms ?? 30_000));

  // ---------------------------------------------------------------------------------------- Schmieden-Definitionen

  const dreaming = {
    name: 'dreaming',
    async sammelnSchritt(task) {
      const i = task.input;
      return {
        fertig: true,
        material: {
          nacht: i.nacht,
          spur: liesTagesspur(i.aufzeichnung, i.nacht),
          spuren: liesSpuren(i.spuren, jetzt()),
          lektionen: liesLektionen(i.lektionen),
        },
      };
    },
    plan(task, cp) {
      const a = dreamingAuftraege(cp.material);
      return [
        { key: 'episode', anweisung: RAHMEN_NACHT, auftrag: () => a.episode, editor: true },
        { key: 'kandidaten', anweisung: RAHMEN_NACHT, auftrag: () => a.kandidaten(cp.laeufe.episode?.text ?? ''), editor: true },
      ];
    },
    vorschlagen(task, cp) {
      const kandidaten = parseKandidaten(cp.laeufe.kandidaten?.text);
      const episode = Boolean(cp.laeufe.episode?.text);
      return {
        kandidaten,
        offen: episode || kandidaten.length > 0,
        zusammenfassung: `Episode ${episode ? 'geschrieben' : 'fehlt'}, ${kandidaten.length} Kandidaten (alle nur Kandidat, ${kandidaten.filter((k) => !k.beleg).length} ohne Beleg). Tagesspur ${cp.material?.spur?.vorhanden ? 'gelesen' : 'nicht gefunden'}.`,
      };
    },
    dateien: dreamingDateien,
    titel: (i) => `Dreaming ${i.nacht}`,
  };

  const nodesmith = {
    name: 'nodesmith',
    async sammelnSchritt(task, cp, h) {
      const i = task.input;
      const material = cp.material ?? { knoten: {} };
      const id = i.knotenIds.find((k) => !material.knoten[k]);
      if (!id) return { fertig: true, material };
      const vorher = leseOderLeer(join(i.basis, 'knoten', id, 'SKILL.entwurf.md'), 3000);
      let eintrag;
      if (!knoten) {
        eintrag = { erreichbar: false, grund: 'kein Knotenzugang im Runner' };
      } else {
        const r = await knoten.befehl(id, knotenBuendel(id), { timeoutMs: i.timeout_s * 1000 });
        const a = auswertenKnoten(r);
        eintrag = { erreichbar: a.erreichbar, grund: a.grund, text: a.erreichbar ? materialText(a.abschnitte) : '', rohtext: a.erreichbar ? String(r.stdout).slice(0, 20000) : '' };
      }
      eintrag.vorher = vorher;
      const neu = { ...material, knoten: { ...material.knoten, [id]: eintrag } };
      return { fertig: i.knotenIds.every((k) => neu.knoten[k]), material: neu };
    },
    plan(task, cp) {
      return Object.entries(cp.material.knoten)
        .filter(([, k]) => k.erreichbar)
        .map(([id, k]) => ({ key: `knoten:${id}`, anweisung: RAHMEN_NACHT, auftrag: () => nodesmithAuftrag(id, k), editor: true }));
    },
    vorschlagen(task, cp) {
      const knotenAus = {};
      const itsm = [];
      const pruefskripte = [];
      let offen = false;
      for (const [id, k] of Object.entries(cp.material?.knoten ?? {})) {
        if (!k.erreichbar) {
          knotenAus[id] = { erreichbar: false, grund: k.grund, probleme: [] };
          continue;
        }
        const rec = cp.laeufe[`knoten:${id}`];
        const p = rec?.text ? parseNodesmith(rec.text, k.text) : { probleme: [], steckbrief: '', pruefskripte: [] };
        knotenAus[id] = { erreichbar: true, probleme: p.probleme, steckbrief: p.steckbrief, rohtext: k.rohtext };
        for (const x of p.probleme) {
          if (x.max && x.belegt) itsm.push({ knoten: id, titel: x.titel, schwere: x.schwere, beleg: x.beleg, hypothese: x.hypothese, worauf: 'Besitzer' });
        }
        for (const s of p.pruefskripte) pruefskripte.push(`${id}: ${s}`);
        if (p.probleme.length || p.steckbrief) offen = true;
      }
      const unerreichbar = Object.entries(knotenAus).filter(([, k]) => !k.erreichbar).map(([id]) => id);
      return {
        knoten: knotenAus,
        itsm,
        pruefskripte,
        offen,
        zusammenfassung: `${Object.keys(knotenAus).length - unerreichbar.length} Knoten untersucht, nicht erreichbar: ${unerreichbar.join(', ') || 'keiner'}; ${Object.values(knotenAus).reduce((s, k) => s + k.probleme.length, 0)} Probleme, ${itsm.length} ITSM-Vorschläge für Besitzer (nicht angelegt).`,
      };
    },
    dateien: nodesmithDateien,
    nachAblegen(task, ergebnisDateien) {
      // Der Steckbrief wird fortgeschrieben: die jeweils letzte Fassung liegt unter <ausgabe>/knoten/<id>/.
      for (const name of Object.keys(ergebnisDateien)) {
        if (/^knoten\/[a-z0-9_-]+\/SKILL\.entwurf\.md$/.test(name)) {
          const ziel = join(task.input.basis, name);
          mkdirSync(dirname(ziel), { recursive: true });
          writeFileSync(ziel, ergebnisDateien[name], 'utf8');
        }
      }
    },
    titel: (i) => `Nodesmith ${i.nacht}`,
  };

  const skillsmith = {
    name: 'skillsmith',
    async sammelnSchritt(task, cp, h) {
      const i = task.input;
      const doc = await h.runtime.snapshot(NachtDoc, h.context);
      const offen = offeneVorschlaege(doc).filter((v) => v.schmiede === 'skillsmith').map((v) => v.skill);
      const ordner = i.aufgabenOrdner;
      const kandidaten = [];
      if (ordner && existsSync(ordner)) {
        for (const datei of readdirSync(ordner).filter((n) => n.endsWith('.json')).sort()) {
          try {
            const j = JSON.parse(readFileSync(join(ordner, datei), 'utf8'));
            const name = datei.replace(/\.json$/, '');
            const skillDatei = join(i.repo, 'skills', 'agenten', name, 'SKILL.md');
            if (Array.isArray(j.aufgaben) && existsSync(skillDatei)) kandidaten.push({ name, gewicht: j.gewicht ?? 1, daten: j, skillDatei });
          } catch {
            /* eine kaputte Aufgabendatei schließt nur diesen Skill aus */
          }
        }
      }
      const lektionen = liesLektionen(i.lektionen);
      const wahl = waehleSkill({ kandidaten, verlauf: doc?.skillsmith ?? {}, lektionen, offen, jetzt: jetzt() });
      if (!wahl) return { fertig: true, material: { keiner: kandidaten.length ? 'alle Kandidaten haben einen offenen Vorschlag' : 'keine Skills mit Beispielaufgaben (skillsmith_aufgaben_ordner)' } };
      const k = kandidaten.find((x) => x.name === wahl.name);
      const lektion = typeof k.daten.lektion === 'string' ? k.daten.lektion : '';
      const pilotInput = {
        titel: `Skillsmith ${i.nacht}: ${wahl.name}`,
        skillPfad: `skills/agenten/${wahl.name}/SKILL.md`,
        skillText: readFileSync(k.skillDatei, 'utf8'),
        lektion,
        aufgaben: k.daten.aufgaben,
        n: i.n,
        k: i.k,
        budget: i.budget,
        ausgabe: join(i.ordner, 'pilot'),
        modell: i.modell,
        cwd: i.cwd,
        quelle: 'nachtwerkstatt',
        nachtgate: true,
      };
      pruefeEingabe(pilotInput); // früh scheitern, nicht erst im Kind
      return { fertig: true, material: { skill: wahl.name, auswahl: `Punkte ${wahl.punkte}, Lektions-Treffer ${wahl.treffer}`, pilotInput } };
    },
    vorschlagen(task, cp) {
      const m = cp.material ?? {};
      if (m.keiner) return { skill: null, pilotStatus: 'kein-kandidat', grund: m.keiner, offen: false, zusammenfassung: `kein Skill gewählt: ${m.keiner}` };
      const r = cp.pilot;
      if (!r) return { skill: m.skill, auswahl: m.auswahl, pilotStatus: 'nicht gelaufen', grund: cp.abbruch?.grund ?? null, offen: false, zusammenfassung: `${m.skill}: Pilot nicht gelaufen` };
      return {
        skill: m.skill,
        auswahl: m.auswahl,
        pilotStatus: r.status,
        grund: r.grund ?? null,
        pilotOrdner: r.ordner,
        tabelle: tabelle(r),
        pilotVerbrauch: r.verbrauch,
        offen: r.status === 'abgeschlossen',
        zusammenfassung: `${m.skill}: ${r.status}${r.grund ? ` (${r.grund})` : ''}; ${(r.belege ?? []).length} Belege; Gewinn nur über der gemessenen Streuung, sonst kein Gewinn.`,
      };
    },
    dateien: skillsmithDateien,
    docUpdate(doc, e, task) {
      if (e.skill && e.pilotStatus !== 'nicht gelaufen') doc.skillsmith[e.skill] = jetzt();
    },
    titel: (i, e) => `Skillsmith ${i.nacht}: ${e?.skill ?? ''}`,
  };

  // --------------------------------------------------------------------------------------- generisches Gerüst

  function baueSchmiede(def) {
    return defineTask({
      name: `fyos.nachtwerkstatt.${def.name}`,
      version: 1,
      initial: () => ({
        phase: 'start',
        laeufe: {},
        verbrauch: { zuege: 0, token: 0 },
        abbruch: null,
        material: null,
        pilotKind: null,
        pilot: null,
        ergebnis: null,
      }),
      phases: {
        start: async (task, runtime, context) => {
          mkdirSync(task.input.ordner, { recursive: true });
          await runtime.commit(async (tx, current) => {
            await listeAktualisieren(tx, task.id, (e) => {
              e.phase = 'sammeln';
            });
            return { status: 'running', checkpoint: { ...current.state.checkpoint, phase: 'sammeln' } };
          }, context);
        },

        sammeln: async (task, runtime, context) => {
          const cp = task.state.checkpoint;
          const t = tor ? await tor() : null;
          if (t && def.name === 'nodesmith') {
            // ssh nur bei offenem Tor (Hauptserver: nie im Spielmodus).
            await runtime.sleepUntil(Math.max(runtime.now() + pause, Number(t.bis) || 0), { ...cp, pausiert: t.grund }, context);
            return;
          }
          const r = await def.sammelnSchritt(task, cp, { runtime, context });
          await runtime.commit(async (tx, current) => {
            const next = r.fertig ? 'analysieren' : 'sammeln';
            await listeAktualisieren(tx, task.id, (e) => {
              e.phase = next;
            });
            return { status: 'running', checkpoint: { ...current.state.checkpoint, material: r.material, phase: next } };
          }, context);
        },

        analysieren: async (task, runtime, context) => {
          const cp = task.state.checkpoint;
          if (def.name === 'skillsmith') return analysierenSkillsmith(task, runtime, context);
          for (const s of def.plan(task, cp)) {
            if (cp.laeufe[s.key]?.ende) continue;
            await zug.schritt(task, runtime, context, { key: s.key, editor: true, anweisung: s.anweisung, auftrag: s.auftrag() });
            return;
          }
          await runtime.commit(async (tx, current) => {
            await listeAktualisieren(tx, task.id, (e) => {
              e.phase = 'vorschlagen';
            });
            return { status: 'running', checkpoint: { ...current.state.checkpoint, phase: 'vorschlagen' } };
          }, context);
        },

        vorschlagen: async (task, runtime, context) => {
          const ergebnis = def.vorschlagen(task, task.state.checkpoint);
          await runtime.commit(async (tx, current) => {
            await listeAktualisieren(tx, task.id, (e) => {
              e.phase = 'ablegen';
            });
            return { status: 'running', checkpoint: { ...current.state.checkpoint, ergebnis, phase: 'ablegen' } };
          }, context);
        },

        ablegen: async (task, runtime, context) => {
          const cp = task.state.checkpoint;
          // Nach einem Abbruch (Budget, Modellfehler) fehlt `ergebnis`: aus dem Teilstand rechnen.
          const ergebnis = cp.ergebnis ?? def.vorschlagen(task, cp);
          const dateien = def.dateien(task.input, { ...cp, ergebnis });
          const namen = schreibeBaum(task.input.ordner, dateien);
          def.nachAblegen?.(task, dateien);
          const abgebrochen = Boolean(cp.abbruch);
          const status = abgebrochen ? 'abgebrochen' : (ergebnis.pilotStatus && ergebnis.pilotStatus !== 'abgeschlossen' ? ergebnis.pilotStatus : 'abgeschlossen');
          const result = {
            status,
            grund: cp.abbruch?.grund ?? ergebnis.grund ?? null,
            teilergebnis: abgebrochen,
            ordner: task.input.ordner,
            dateien: namen,
            zusammenfassung: ergebnis.zusammenfassung ?? '',
            verbrauch: ergebnis.pilotVerbrauch ?? cp.verbrauch,
            offen: Boolean(ergebnis.offen),
          };
          await runtime.commit(async (tx) => {
            await listeAktualisieren(tx, task.id, (e) => {
              e.phase = 'abschluss';
              e.status = abgebrochen ? 'abgebrochen' : 'abgeschlossen';
              e.ergebnis = status;
              e.beendet = Date.now();
            });
            if (result.offen) {
              const doc = await tx.doc(NachtDoc);
              const id = `${task.input.nacht}:${def.name}`;
              doc.vorschlaege[id] = {
                id,
                schmiede: def.name,
                nacht: task.input.nacht,
                titel: def.titel(task.input, ergebnis),
                ordner: task.input.ordner,
                skill: ergebnis.skill ?? null,
                status: 'offen',
                erstellt: Date.now(),
              };
            }
            if (def.docUpdate) def.docUpdate(await tx.doc(NachtDoc), ergebnis, task);
            return { status: 'terminal', outcome: { status: 'completed', result } };
          }, context);
        },
      },
      abort: async (task, runtime, context) => {
        await runtime.commit(async (tx) => {
          await listeAktualisieren(tx, task.id, (e) => {
            e.phase = 'abgebrochen';
            e.status = 'abgebrochen';
            e.beendet = Date.now();
          });
          return { status: 'terminal', outcome: { status: 'aborted', reason: 'Vom Menschen abgebrochen' } };
        }, context);
      },
    });
  }

  /** Skillsmith: der Harness2-Pilot läuft als Kind dieser Aufgabe; sie wartet dauerhaft auf ihn. */
  async function analysierenSkillsmith(task, runtime, context) {
    const cp = task.state.checkpoint;
    const weiter = (mehr) =>
      runtime.commit(async (tx, current) => {
        await listeAktualisieren(tx, task.id, (e) => {
          e.phase = 'vorschlagen';
        });
        return { status: 'running', checkpoint: { ...current.state.checkpoint, ...mehr, phase: 'vorschlagen' } };
      }, context);
    if (cp.material?.keiner || !cp.material?.pilotInput) return weiter({});
    if (cp.pilotKind === null) {
      const input = pruefeEingabe(cp.material.pilotInput);
      await runtime.commit(async (tx, current) => {
        const id = await tx.createTask(harness2Task, input, { ownership: { kind: 'task', taskId: task.id } });
        const liste = await tx.doc(LaufListe);
        liste.eintraege[String(id)] = {
          id: String(id),
          titel: input.titel,
          auftrag: `Harness2-Pilot (Skillsmith) für ${input.skillPfad}`,
          quelle: 'nachtwerkstatt',
          art: 'harness2-pilot',
          erstellt: Date.now(),
          phase: 'start',
          status: 'laeuft',
          kindId: null,
          kinder: [],
          freigabeId: null,
          verbrauch: { zuege: 0, token: 0 },
        };
        return { status: 'waiting', checkpoint: { ...current.state.checkpoint, pilotKind: String(id), phase: 'analysieren' }, on: [id], policy: 'allSettled' };
      }, context);
      return;
    }
    const [aus] = await runtime.outcomes([Number(cp.pilotKind)], context);
    if (aus.status === 'completed') return weiter({ pilot: aus.result });
    return weiter({ abbruch: { grund: `pilot-${aus.status}`, phase: 'analysieren', runde: null } });
  }

  const Dreaming = baueSchmiede(dreaming);
  const Nodesmith = baueSchmiede(nodesmith);
  const Skillsmith = baueSchmiede(skillsmith);
  const Schmieden = { dreaming: Dreaming, skillsmith: Skillsmith, nodesmith: Nodesmith };

  // ------------------------------------------------------------------------------------------------ die Nacht

  function kindEingabe(name, i) {
    const basis = {
      nacht: i.nacht,
      basis: i.basis,
      ordner: join(i.basis, i.nacht, name),
      modell: nk.modell,
      cwd: i.cwd ?? null,
      nachtgate: true,
      budget: nk[name].budget,
      quelle: 'nachtwerkstatt',
    };
    if (name === 'dreaming') return { ...basis, aufzeichnung: nk.aufzeichnung, spuren: nk.spuren, lektionen: nk.lektionen };
    if (name === 'skillsmith') return { ...basis, aufgabenOrdner: nk.skillsmithAufgaben, repo: nk.repo, lektionen: nk.lektionen, n: nk.skillsmith.n, k: nk.skillsmith.k };
    return { ...basis, knotenIds: i.knotenIds, timeout_s: nk.nodesmith.timeout_s };
  }

  const naechste = (name) => SCHMIEDEN[SCHMIEDEN.indexOf(name) + 1] ?? 'bericht';

  const schmiedePhase = (name) => async (task, runtime, context) => {
    const cp = task.state.checkpoint;
    const weiter = (ergebnis) =>
      runtime.commit(async (tx, current) => {
        const c = current.state.checkpoint;
        await listeAktualisieren(tx, task.id, (e) => {
          e.phase = naechste(name);
        });
        return { status: 'running', checkpoint: { ...c, ergebnisse: { ...c.ergebnisse, [name]: ergebnis }, phase: naechste(name) } };
      }, context);

    const kind = cp.kinder[name];
    if (kind === undefined) {
      if (!task.input.schmieden.includes(name) || !nk[name].an) return weiter({ status: 'uebersprungen', grund: 'aus' });
      if (!ruhefenster(jetzt(), nk.zone, nk.von, nk.bis)) return weiter({ status: 'uebersprungen', grund: 'ausserhalb-ruhefenster' });
      const doc = await runtime.snapshot(NachtDoc, context);
      const offen = offeneVorschlaege(doc).length;
      if (offen >= nk.deckel) return weiter({ status: 'uebersprungen', grund: `deckel: ${offen} offene Vorschläge (höchstens ${nk.deckel})` });
      await runtime.commit(async (tx, current) => {
        const c = current.state.checkpoint;
        const input = kindEingabe(name, task.input);
        const id = await tx.createTask(Schmieden[name], input, { ownership: { kind: 'task', taskId: task.id } });
        const liste = await tx.doc(LaufListe);
        liste.eintraege[String(id)] = {
          id: String(id),
          titel: `Nachtwerkstatt ${task.input.nacht}: ${name}`,
          auftrag: `Nachtwerkstatt ${name}`,
          quelle: 'nachtwerkstatt',
          art: `nachtwerkstatt-${name}`,
          erstellt: Date.now(),
          phase: 'start',
          status: 'laeuft',
          kindId: null,
          kinder: [],
          freigabeId: null,
          verbrauch: { zuege: 0, token: 0 },
        };
        await listeAktualisieren(tx, task.id, (e) => {
          e.phase = name;
        });
        return { status: 'waiting', checkpoint: { ...c, kinder: { ...c.kinder, [name]: String(id) } }, on: [id], policy: 'allSettled' };
      }, context);
      return;
    }
    const [aus] = await runtime.outcomes([Number(kind)], context);
    return weiter(aus.status === 'completed' ? aus.result : { status: 'fehler', grund: aus.error?.message ?? aus.reason ?? aus.status });
  };

  const Nacht = defineTask({
    name: 'fyos.nachtwerkstatt',
    version: 1,
    initial: () => ({ phase: 'start', kinder: {}, ergebnisse: {}, bericht: null }),
    phases: {
      start: async (task, runtime, context) => {
        const i = task.input;
        const zu = !ruhefenster(jetzt(), nk.zone, nk.von, nk.bis);
        if (zu && !i.fensterIgnorieren) {
          await runtime.commit(async (tx) => {
            await listeAktualisieren(tx, task.id, (e) => {
              e.phase = 'abschluss';
              e.status = 'abgeschlossen';
              e.ergebnis = 'nicht-gestartet';
            });
            return { status: 'terminal', outcome: { status: 'completed', result: { status: 'nicht-gestartet', grund: 'ausserhalb-ruhefenster', nacht: i.nacht } } };
          }, context);
          return;
        }
        mkdirSync(join(i.basis, i.nacht), { recursive: true });
        await runtime.commit(async (tx, current) => {
          await listeAktualisieren(tx, task.id, (e) => {
            e.phase = 'dreaming';
          });
          return { status: 'running', checkpoint: { ...current.state.checkpoint, phase: 'dreaming' } };
        }, context);
      },
      dreaming: schmiedePhase('dreaming'),
      skillsmith: schmiedePhase('skillsmith'),
      nodesmith: schmiedePhase('nodesmith'),
      bericht: async (task, runtime, context) => {
        const i = task.input;
        const cp = task.state.checkpoint;
        const doc = await runtime.snapshot(NachtDoc, context);
        // Offen zählt auch, was diese Nacht neu dazukommt (die Kinder haben es schon eingetragen).
        const text = morgenbericht({ nacht: i.nacht, ergebnisse: cp.ergebnisse, offen: offeneVorschlaege(doc).length, deckel: nk.deckel });
        const pfad = join(i.basis, i.nacht, 'MORGENBERICHT.md');
        mkdirSync(dirname(pfad), { recursive: true });
        writeFileSync(pfad, text, 'utf8');
        writeFileSync(join(i.basis, 'LETZTER-BERICHT.md'), text, 'utf8');
        const stati = Object.values(cp.ergebnisse).map((e) => e?.status);
        const status = stati.every((s) => ['abgeschlossen','kein-gewinn','kein-kandidat','uebersprungen'].includes(s)) ? 'abgeschlossen' : 'teilweise';
        const result = { status, nacht: i.nacht, bericht: pfad, schmieden: cp.ergebnisse };
        await runtime.commit(async (tx) => {
          await listeAktualisieren(tx, task.id, (e) => {
            e.phase = 'abschluss';
            e.status = 'abgeschlossen';
            e.ergebnis = status;
            e.beendet = Date.now();
          });
          const d = await tx.doc(NachtDoc);
          d.bericht = { nacht: i.nacht, pfad, text: text.slice(0, 8000), erstellt: Date.now(), status };
          return { status: 'terminal', outcome: { status: 'completed', result } };
        }, context);
      },
    },
    abort: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        await listeAktualisieren(tx, task.id, (e) => {
          e.phase = 'abgebrochen';
          e.status = 'abgebrochen';
          e.beendet = Date.now();
        });
        return { status: 'terminal', outcome: { status: 'aborted', reason: 'Vom Menschen abgebrochen' } };
      }, context);
    },
  });

  return { Nacht, Dreaming, Skillsmith, Nodesmith, nk };
}

/** Die Nacht anlegen (eine Transaktion mit Liste und Nächteverzeichnis); `input` aus dem Runner. */
export async function nachtAnlegen(tx, Nacht, input) {
  const id = await tx.createTask(Nacht, input, { ownership: { kind: 'conversation' }, background: true });
  const liste = await tx.doc(LaufListe);
  liste.eintraege[String(id)] = {
    id: String(id),
    titel: `Nachtwerkstatt ${input.nacht}`,
    auftrag: `Nachtwerkstatt ${input.nacht}: ${input.schmieden.join(' → ')}`,
    quelle: 'nachtwerkstatt',
    art: 'nachtwerkstatt',
    erstellt: Date.now(),
    phase: 'start',
    status: 'laeuft',
    kindId: null,
    kinder: [],
    freigabeId: null,
  };
  const doc = await tx.doc(NachtDoc);
  doc.naechte[input.nacht] = String(id);
  return String(id);
}

/** Lesewerkzeug für den Morgentakt: der Bericht der letzten Nacht und die offenen Vorschläge. Ändert nichts. */
export function nachtWerkzeuge() {
  const lesen = defineTool({
    name: 'nachtbericht_lesen',
    description:
      'Liest den Morgenbericht der Nachtwerkstatt (Dreaming, Skillsmith, Nodesmith) und die offenen Vorschläge. ' +
      'Nur lesend; alles darin ist Vorschlag, nichts ist übernommen oder angelegt.',
    parameters: Type.Object({}),
    replay: 'safe',
    execute: async (_args, api, context) => {
      const doc = (await api.snapshot(NachtDoc, context)) ?? { vorschlaege: {}, bericht: null };
      const aus = { bericht: doc.bericht, offene_vorschlaege: offeneVorschlaege(doc) };
      return { output: [{ type: 'text', text: JSON.stringify(aus, null, 2) }] };
    },
  });
  return [lesen];
}
