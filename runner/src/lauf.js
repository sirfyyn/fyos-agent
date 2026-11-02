/**
 * lauf.js — der dauerhafte Lauf mit Phasen.
 *
 * Das ist die FYOS-Übersetzung der Aufgabe aus dem Video: kein Skript, das von oben nach
 * unten durchläuft, sondern eine Zustandsmaschine mit einem gespeicherten Checkpoint nach
 * jeder Phase. Ein Absturz mitten in „arbeiten“ verliert nichts: Dieselbe Submission wird
 * über ihre `requestId` gefunden, und der Lauf macht an derselben Stelle weiter.
 *
 * Phasen: start → arbeiten → (freigabe) → abschluss
 *   start     legt das Kindgespräch an (idempotent über die Eigentümer-Suche)
 *   arbeiten  schickt den Auftrag und wartet auf die Antwort
 *   freigabe  wartet dauerhaft (Sleep) auf die menschliche Entscheidung
 *   abschluss schreibt das Ergebnis in die Aufgabenliste und endet
 */
import { aktivesFensterImHandler, konfigurieren as configure, aufgabe as defineTask } from './lauf/index.js';
import { Freigaben, LaufListe, neueFreigabe } from './documents.js';
import { providerFuerModell } from './provider-kette.js';
import { aufruferMerken } from './aufrufer.js';
import { kontextFallback, kontextZaehler } from './freigabe-kontext.js';

/** Text aus einem Assistant-Eintrag; Werkzeugaufrufe werden zu einer kurzen Spur. */
export function antwortText(entry) {
  const nachricht = entry?.model?.[0];
  if (!nachricht || !Array.isArray(nachricht.content)) return '';
  const teile = [];
  for (const block of nachricht.content) {
    if (block?.type === 'text' && block.text) teile.push(block.text);
    else if (block?.type === 'toolCall') teile.push(`[Werkzeug ${block.name ?? '?'}]`);
  }
  return teile.join('\n').trim();
}

function kindAnweisung(input) {
  return [
    'Du bist ein FYOS-Lauf. Du arbeitest einen konkreten Auftrag ab und lieferst am Ende ein Ergebnis.',
    `Titel: ${input.titel}`,
    input.freigabe
      ? 'Vor dem Abschluss entscheidet ein Mensch über die Freigabe. Beschreibe im Ergebnis klar, was du getan hast und was noch fehlt.'
      : 'Arbeite eigenständig; ein Mensch kann jederzeit eingreifen.',
    'Erfinde keine Zustände. Wenn du etwas nicht getan hast, sage das.',
    'Antworte auf Deutsch, knapp und mit Belegen (Pfade, Werkzeugnamen, Ergebnisse).',
    '',
    'Auftrag:',
    input.auftrag,
  ].join('\n');
}

/**
 * Die Aufgaben-Definition bekommt die Konfiguration als Closure. Sie wird beim Start
 * einmal gebaut und im Registry installiert; spätere Änderungen an der Konfiguration
 * gelten für neue Läufe, nicht rückwirkend für laufende.
 */
export function erstelleLauf(cfg) {
  const provider = cfg.pi_durable.model.provider;
  const modellFuer = (input) => ({
    // Ein bewusst gewähltes Modell eines anderen Providers (Ersatzdenker) bekommt seinen Provider; sonst Hausmodell wie bisher.
    provider: input.modell ? providerFuerModell(cfg, input.modell) : provider,
    modelId: input.modell || cfg.pi_durable.model.default,
  });

  return defineTask({
    name: 'fyos.lauf',
    version: 1,
    initial: () => ({ phase: 'start', kindId: null, freigabeId: null, antwort: null, fehler: null }),

    phases: {
      start: async (task, runtime, context) => {
        let kindId = task.state.checkpoint.kindId;
        if (!kindId) {
          await runtime.commit(async (tx) => {
            const vorhanden = (await tx.scanConversations({ ownerTaskId: task.id }, 1)).items[0];
            const kind =
              vorhanden ??
              (await tx.createConversation({ ownership: { kind: 'task', taskId: task.id } }));
            kindId = kind.id;
            await configure(tx, kind.id, {
              model: modellFuer(task.input),
              cwd: task.input.cwd ?? undefined,
              instructions: kindAnweisung(task.input),
            });
            // Aufruferkopf für das Tor (aufrufer.js): dieses Kind ist ein Lauf.
            await aufruferMerken(tx, kind.id, task);
            const liste = await tx.doc(LaufListe);
            liste.eintraege[String(task.id)] = {
              ...(liste.eintraege[String(task.id)] ?? {}),
              id: String(task.id),
              titel: task.input.titel,
              auftrag: task.input.auftrag,
              quelle: task.input.quelle ?? 'mensch',
              erstellt: liste.eintraege[String(task.id)]?.erstellt ?? Date.now(),
              phase: 'start',
              status: 'laeuft',
              kindId: kind.id,
              freigabeId: null,
            };
            return { status: 'running', checkpoint: { ...task.state.checkpoint, phase: 'start', kindId: kind.id } };
          }, context);
        }
        await runtime.commit(
          (tx, current) => ({
            status: 'running',
            checkpoint: { ...current.state.checkpoint, phase: 'arbeiten', kindId },
          }),
          context,
        );
      },

      arbeiten: async (task, runtime, context) => {
        const kindId = task.state.checkpoint.kindId;
        const gespraech = await runtime.conversation(kindId, context);
        if (!gespraech) throw new Error(`Kindgespräch ${kindId} fehlt`);
        const submission = await gespraech.submit(
          {
            type: 'input',
            content: task.input.auftrag,
            requestId: `lauf:${task.id}`,
            entry: { kind: 'fyos.lauf.auftrag', data: { lauf: String(task.id), titel: task.input.titel } },
          },
          context,
        );
        const ende = await submission.wait(context);
        if (ende.status !== 'done') {
          await runtime.commit(async (tx) => {
            const liste = await tx.doc(LaufListe);
            const e = liste.eintraege[String(task.id)];
            if (e) {
              e.phase = 'abschluss';
              e.status = 'fehler';
              e.fehler = ende.reason ?? 'unbeantwortet';
            }
            return {
              status: 'terminal',
              outcome: {
                status: 'failed',
                error: { message: `Lauf unbeantwortet: ${ende.reason ?? 'unbekannt'}` },
              },
            };
          }, context);
          return;
        }
        const verlauf = await aktivesFensterImHandler(runtime, kindId, context);
        const entry = verlauf.entries.find((eintrag) => eintrag.id === ende.answer);
        const antwort = antwortText(entry);
        const phase = task.input.freigabe ? 'freigabe' : 'abschluss';
        await runtime.commit(
          () => ({ status: 'running', checkpoint: { ...task.state.checkpoint, phase, antwort } }),
          context,
        );
      },

      freigabe: async (task, runtime, context) => {
        const freigabeId = task.state.checkpoint.freigabeId ?? `fr-lauf-${task.id}`;
        if (!task.state.checkpoint.freigabeId) {
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(Freigaben);
            if (!doc.eintraege[freigabeId]) {
              // Entscheidung 586: 3–5 Sätze Kontext aus Auftrag, Quelle und Vorgang (deterministisch; das Ergebnis selbst liegt im Lauf-Gespräch).
              const aktion = `Lauf abschließen: ${task.input.titel}`;
              const risiko = task.input.risiko ?? 'medium';
              doc.eintraege[freigabeId] = neueFreigabe({
                id: freigabeId,
                conversationId: task.input.elternId ?? task.conversationId,
                taskId: task.id,
                aktion,
                risiko,
                kontext: kontextFallback({
                  aktion,
                  risiko,
                  titel: task.input.titel,
                  quelle: task.input.quelle,
                  vorgang: task.input.bezug,
                  wirkung: 'der Lauf hat eine Antwort erarbeitet und gilt erst nach der Zustimmung als abgeschlossen',
                  rueckweg: 'Ablehnen beendet den Lauf ohne Abschluss; die erarbeitete Antwort bleibt im Gespräch des Laufs nachlesbar',
                }),
                kontextHerkunft: 'rueckfall',
                zerstoererisch: false,
              });
              kontextZaehler.zaehlen({ herkunft: 'rueckfall', abweichung: null });
            }
            return {
              status: 'running',
              checkpoint: { ...task.state.checkpoint, phase: 'freigabe', freigabeId },
            };
          }, context);
        }

        const doc = await runtime.snapshot(Freigaben, context);
        const f = doc?.eintraege?.[freigabeId];
        if (!f || f.status === 'offen') {
          await runtime.sleepUntil(runtime.now() + 3000, { ...task.state.checkpoint, phase: 'freigabe', freigabeId }, context);
          return;
        }
        if (f.status === 'abgelehnt') {
          await runtime.commit(async (tx) => {
            const liste = await tx.doc(LaufListe);
            const e = liste.eintraege[String(task.id)];
            if (e) {
              e.phase = 'abschluss';
              e.status = 'abgelehnt';
              e.freigabeId = freigabeId;
              e.notiz = f.notiz ?? null;
            }
            return {
              status: 'terminal',
              outcome: {
                status: 'aborted',
                reason: `Freigabe abgelehnt${f.notiz ? `: ${f.notiz}` : ''}`,
                result: { antwort: task.state.checkpoint.antwort, freigabeId },
              },
            };
          }, context);
          return;
        }
        await runtime.commit(
          () => ({ status: 'running', checkpoint: { ...task.state.checkpoint, phase: 'abschluss', freigabeId } }),
          context,
        );
      },

      abschluss: async (task, runtime, context) => {
        await runtime.commit(async (tx) => {
          const liste = await tx.doc(LaufListe);
          const e = liste.eintraege[String(task.id)];
          if (e) {
            e.phase = 'abschluss';
            e.status = 'abgeschlossen';
            e.freigabeId = task.state.checkpoint.freigabeId ?? null;
            e.antwort = task.state.checkpoint.antwort ?? null;
            e.beendet = Date.now();
          }
          return {
            status: 'terminal',
            outcome: {
              status: 'completed',
              result: {
                antwort: task.state.checkpoint.antwort ?? '',
                kindId: task.state.checkpoint.kindId,
                freigabeId: task.state.checkpoint.freigabeId ?? null,
              },
            },
          };
        }, context);
      },
    },

    abort: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const liste = await tx.doc(LaufListe);
        const e = liste.eintraege[String(task.id)];
        if (e) {
          e.phase = 'abgebrochen';
          e.status = 'abgebrochen';
          e.beendet = Date.now();
        }
        return {
          status: 'terminal',
          outcome: { status: 'aborted', reason: 'Vom Menschen abgebrochen' },
        };
      }, context);
    },
  });
}

/** Einen Lauf aus dem Server oder einem Werkzeug anlegen (eine Transaktion mit der Liste). */
export async function laufAnlegen(tx, Lauf, input) {
  const id = await tx.createTask(
    Lauf,
    {
      titel: String(input.titel ?? 'Lauf').slice(0, 120),
      auftrag: String(input.auftrag ?? '').slice(0, 40_000),
      freigabe: !!input.freigabe,
      modell: input.modell ?? null,
      cwd: input.cwd ?? null,
      quelle: input.quelle ?? 'mensch',
      bezug: input.bezug ?? null,
      elternId: input.elternId ?? null,
      risiko: input.risiko ?? 'medium',
    },
    { ownership: { kind: 'conversation' }, background: true },
  );
  const liste = await tx.doc(LaufListe);
  liste.eintraege[String(id)] = {
    id: String(id),
    titel: String(input.titel ?? 'Lauf').slice(0, 120),
    auftrag: String(input.auftrag ?? '').slice(0, 2000),
    quelle: input.quelle ?? 'mensch',
    erstellt: Date.now(),
    phase: 'start',
    status: 'laeuft',
    kindId: null,
    freigabeId: null,
  };
  return String(id);
}
