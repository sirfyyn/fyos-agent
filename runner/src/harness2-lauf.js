/**
 * harness2-lauf.js — die Aufgabe `harness2-pilot`: Propose, Probe, Compose ohne Wahrheitsprüfer.
 *
 * Phasen, je mit einem Prüfpunkt in der SQLite-Datei:
 *   start      Eingabe und Ausgabeort prüfen, Eintrag in der Läuferliste
 *   referenz   der heutige Skill auf allen Aufgaben, n Wiederholungen (ein Messlauf = ein Zug im eigenen Kindgespräch)
 *   propose    ein Editor-Zug schlägt zwei Kandidaten vor (invariant, domänenspezifisch), nur Ergänzungen
 *   probe      jeder Kandidat auf denselben Aufgaben, n Wiederholungen
 *   compose    feste Regel im Code: übernehmen, überarbeiten, verwerfen je Änderung mit Beleg; ein Zug schreibt Lehren
 *   ablegen    Konzeptdateien in den Ausgabeordner (Skill-Entwurf, EXPERIENCE.md-Entwurf, belege.json)
 *
 * Jeder Messlauf ist ein Prüfpunkt: nach einem Absturz läuft die Aufgabe mit dem nächsten fehlenden Lauf weiter,
 * ein halber Lauf wird über seine `requestId` wiedergefunden, nicht doppelt gezählt. Rekursionstiefe k ist ein fester
 * Zähler (sequentielle Rekursion: jede Runde misst den Skill der vorigen neu als Referenz). Die Budgetgrenze (Züge,
 * optional Token) wird vor jedem neuen Zug geprüft; ein Zug, der schon läuft, wird zu Ende geführt.
 *
 * Nichts hier übernimmt etwas: kein Git, kein Schreiben nach `skills/`, nur der eigene Ergebnisordner.
 * Die Kindgespräche gehören der Aufgabe und laufen mit den Freigabe-Regeln des Runners unverändert.
 */
import { mkdirSync } from 'node:fs';
import { aufgabe as defineTask } from './lauf/index.js';
import { LaufListe } from './documents.js';
import {
  HINWEIS_MESSUNG,
  ausgabeGesperrt,
  auswerten,
  composeAuftrag,
  ergebnisOrdner,
  erzeugeDateien,
  kandidatSkill,
  komponiere,
  laufAnweisung,
  parseLehren,
  parseVorschlaege,
  planProbe,
  planReferenz,
  proposeAuftrag,
  RAHMEN_EDITOR,
  schluessel,
  schreibeDateien,
  VERSUCHE_MAX,
} from './harness2.js';
import { budgetGrenze, erstelleZug, listeAktualisieren } from './zug.js';

/** Auswertung der Referenz einer Runde aus den gespeicherten Läufen; `null`, wenn ein Lauf fehlt. */
function referenzAuswertung(cp, input) {
  return auswerten(input.aufgaben, input.n, (id, rep) => cp.laeufe[schluessel.ref(cp.runde, id, rep)]?.wert);
}

export function erstelleHarness2Pilot(cfg, { spielmodus, pauseMs, gate } = {}) {
  const { schritt } = erstelleZug(cfg, { spielmodus, pauseMs, gate });

  async function ablageErgebnis(task, cp, extraAbbruch) {
    const input = task.input;
    const stand = extraAbbruch ? { ...cp, abbruch: cp.abbruch ?? extraAbbruch } : cp;
    const { status, dateien } = erzeugeDateien(input, stand);
    const ordner = ergebnisOrdner(input, task.id);
    const namen = schreibeDateien(ordner, dateien);
    const belege = (stand.runden ?? []).flatMap((r) => r.belege);
    return {
      status,
      grund: stand.abbruch?.grund ?? (status === 'kein-gewinn' ? 'kein Gewinn über der gemessenen Streuung' : null),
      teilergebnis: Boolean(stand.abbruch),
      ordner,
      dateien: namen,
      belege,
      runden: (stand.runden ?? []).map((r) => ({
        runde: r.runde,
        referenz: r.referenz,
        uebernommen: r.uebernommen,
        kombinationUngemessen: r.kombinationUngemessen,
      })),
      verbrauch: stand.verbrauch,
      hinweis: HINWEIS_MESSUNG,
    };
  }

  return defineTask({
    name: 'fyos.harness2-pilot',
    version: 1,
    initial: () => ({
      phase: 'start',
      runde: 1,
      skill: null,
      laeufe: {},
      kandidaten: [],
      runden: [],
      verbrauch: { zuege: 0, token: 0 },
      abbruch: null,
    }),

    phases: {
      start: async (task, runtime, context) => {
        const input = task.input;
        if (ausgabeGesperrt(input.ausgabe)) throw new Error('ausgabe liegt im Skills-Baum');
        mkdirSync(input.ausgabe, { recursive: true });
        await runtime.commit(async (tx, current) => {
          await listeAktualisieren(tx, task.id, (e) => {
            e.phase = 'referenz';
          });
          return { status: 'running', checkpoint: { ...current.state.checkpoint, phase: 'referenz', skill: input.skillText } };
        }, context);
      },

      referenz: async (task, runtime, context) => {
        const input = task.input;
        const cp = task.state.checkpoint;
        for (const s of planReferenz(input, cp.runde)) {
          if (cp.laeufe[s.key]?.ende) continue;
          await schritt(task, runtime, context, {
            key: s.key,
            anweisung: laufAnweisung(cp.skill),
            auftrag: s.aufgabe.aufgabe,
            merkmal: s.aufgabe.merkmal,
          });
          return;
        }
        await runtime.commit(async (tx, current) => {
          await listeAktualisieren(tx, task.id, (e) => {
            e.phase = 'propose';
          });
          return { status: 'running', checkpoint: { ...current.state.checkpoint, phase: 'propose' } };
        }, context);
      },

      propose: async (task, runtime, context) => {
        const input = task.input;
        const cp = task.state.checkpoint;
        const key = schluessel.propose(cp.runde);
        const rec = cp.laeufe[key];
        if (!rec?.ende) {
          const referenz = referenzAuswertung(cp, input);
          await schritt(task, runtime, context, {
            key,
            editor: true,
            anweisung: RAHMEN_EDITOR,
            auftrag: proposeAuftrag({ skill: cp.skill, lektion: input.lektion, input, referenz, laeufe: cp.laeufe, runde: cp.runde }),
          });
          return;
        }
        const kandidaten = parseVorschlaege(rec.text, cp.runde);
        await runtime.commit(async (tx, current) => {
          await listeAktualisieren(tx, task.id, (e) => {
            e.phase = 'probe';
          });
          return { status: 'running', checkpoint: { ...current.state.checkpoint, phase: 'probe', kandidaten } };
        }, context);
      },

      probe: async (task, runtime, context) => {
        const input = task.input;
        const cp = task.state.checkpoint;
        for (const s of planProbe(input, cp.runde, cp.kandidaten)) {
          if (cp.laeufe[s.key]?.ende) continue;
          const kand = cp.kandidaten.find((k) => k.name === s.kandidat);
          await schritt(task, runtime, context, {
            key: s.key,
            anweisung: laufAnweisung(kandidatSkill(cp.skill, kand, cp.runde)),
            auftrag: s.aufgabe.aufgabe,
            merkmal: s.aufgabe.merkmal,
          });
          return;
        }
        await runtime.commit(async (tx, current) => {
          await listeAktualisieren(tx, task.id, (e) => {
            e.phase = 'compose';
          });
          return { status: 'running', checkpoint: { ...current.state.checkpoint, phase: 'compose' } };
        }, context);
      },

      compose: async (task, runtime, context) => {
        const input = task.input;
        const cp = task.state.checkpoint;
        const runde = cp.runde;
        const referenz = referenzAuswertung(cp, input);
        const kandWerte = {};
        for (const kand of cp.kandidaten) {
          if (!kand.aenderungen.length) continue;
          kandWerte[kand.name] = auswerten(input.aufgaben, input.n, (id, rep) => cp.laeufe[schluessel.kand(runde, kand.name, id, rep)]?.wert);
        }
        const ergebnis = komponiere({
          runde,
          skill: cp.skill,
          kandidaten: cp.kandidaten,
          ref: referenz,
          kandWerte,
          mindestGewinn: input.mindestGewinn,
          n: input.n,
        });

        // Die Entscheidung steht schon (feste Regel). Der Zug schreibt nur Lehren und ist verzichtbar,
        // wenn das Budget fehlt: dann bleibt die Runde gültig, nur ohne Modelltext.
        let lehren = { lehren: '', dauerschwaeche: '' };
        if (ergebnis.belege.length) {
          const key = schluessel.compose(runde);
          const rec = cp.laeufe[key];
          // Ein Zug, der schon läuft, wird zu Ende geführt; einen neuen Versuch gibt es nur mit Budget.
          const darf = rec && !rec.fehler ? true : rec ? rec.v < VERSUCHE_MAX && !budgetGrenze(input, cp.verbrauch) : !budgetGrenze(input, cp.verbrauch);
          if (rec?.ende) {
            lehren = parseLehren(rec.text);
          } else if (darf) {
            await schritt(task, runtime, context, {
              key,
              editor: true,
              anweisung: RAHMEN_EDITOR,
              auftrag: composeAuftrag({ runde, belege: ergebnis.belege, uebernommen: ergebnis.uebernommen }),
            });
            return;
          }
        }

        const rundeRec = {
          runde,
          referenz: { mittel: referenz.mittel, spanne: referenz.spanne, jeRep: referenz.jeRep },
          belege: ergebnis.belege,
          uebernommen: ergebnis.uebernommen.length,
          skillNach: ergebnis.uebernommen.length ? ergebnis.skillNach : null,
          kombinationUngemessen: ergebnis.kombinationUngemessen,
          kandidatenOhneVorschlag: ergebnis.kandidatenOhneVorschlag,
          lehren: lehren.lehren,
          dauerschwaeche: lehren.dauerschwaeche,
          abgelehnt: cp.kandidaten.flatMap((k) => k.abgelehnt ?? []),
        };
        // Weiter nur mit etwas Neuem: ohne Übernahme gäbe es nichts, das eine neue Referenz anders messen könnte.
        const weiter = ergebnis.uebernommen.length > 0 && runde < input.k;
        await runtime.commit(async (tx, current) => {
          const c = current.state.checkpoint;
          await listeAktualisieren(tx, task.id, (e) => {
            e.phase = weiter ? 'referenz' : 'ablegen';
          });
          return {
            status: 'running',
            checkpoint: {
              ...c,
              runden: [...c.runden, rundeRec],
              kandidaten: [],
              phase: weiter ? 'referenz' : 'ablegen',
              runde: weiter ? runde + 1 : runde,
              skill: weiter ? ergebnis.skillNach : c.skill,
            },
          };
        }, context);
      },

      ablegen: async (task, runtime, context) => {
        const cp = task.state.checkpoint;
        const ergebnis = await ablageErgebnis(task, cp);
        await runtime.commit(async (tx) => {
          await listeAktualisieren(tx, task.id, (e) => {
            e.phase = 'abschluss';
            e.status = ergebnis.status === 'abgebrochen' ? 'abgebrochen' : 'abgeschlossen';
            e.ergebnis = ergebnis.status;
            e.beendet = Date.now();
            e.ordner = ergebnis.ordner;
          });
          return { status: 'terminal', outcome: { status: 'completed', result: ergebnis } };
        }, context);
      },
    },

    abort: async (task, runtime, context) => {
      const cp = task.state.checkpoint;
      let ergebnis = null;
      try {
        ergebnis = await ablageErgebnis(task, cp, { grund: 'vom-menschen-abgebrochen', phase: cp.phase, runde: cp.runde });
      } catch {
        /* Teilergebnis ist nur ein Entgegenkommen; der Abbruch zählt. */
      }
      await runtime.commit(async (tx) => {
        await listeAktualisieren(tx, task.id, (e) => {
          e.phase = 'abgebrochen';
          e.status = 'abgebrochen';
          e.ergebnis = 'abgebrochen';
          e.beendet = Date.now();
        });
        return { status: 'terminal', outcome: { status: 'aborted', reason: 'Vom Menschen abgebrochen', ...(ergebnis ? { result: ergebnis } : {}) } };
      }, context);
    },
  });
}

/** Einen Pilot anlegen (eine Transaktion mit der Läuferliste); `input` kommt aus `pruefeEingabe`. */
export async function harness2Anlegen(tx, Task, input) {
  const id = await tx.createTask(Task, input, { ownership: { kind: 'conversation' }, background: true });
  const liste = await tx.doc(LaufListe);
  liste.eintraege[String(id)] = {
    id: String(id),
    titel: input.titel,
    auftrag: `Harness2-Pilot für ${input.skillPfad} (${input.aufgaben.length} Aufgaben, n=${input.n}, k=${input.k})`,
    quelle: 'harness2',
    art: 'harness2-pilot',
    erstellt: Date.now(),
    phase: 'start',
    status: 'laeuft',
    // Bewusst null: die Messläufe sollen nicht als Arbeit von Persona in den Ausgang zum Hub strömen.
    kindId: null,
    kinder: [],
    freigabeId: null,
    verbrauch: { zuege: 0, token: 0 },
  };
  return String(id);
}
