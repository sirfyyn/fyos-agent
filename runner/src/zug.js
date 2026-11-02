/**
 * zug.js — ein Modellzug in einem eigenen Kindgespräch, mit Prüfpunkt, Budget und Toren.
 *
 * Gemeinsamer Unterbau von Harness2-Pilot und Nachtwerkstatt. Der Prüfpunkt der Aufgabe trägt `laeufe`
 * (Ergebnis je Schlüssel), `verbrauch` ({zuege, token}) und `abbruch`. Ein Zug ist wiederholbar und zählt genau einmal:
 *   kein Eintrag → Kind anlegen und Zug zählen (eine Transaktion),
 *   Kind da, Ergebnis fehlt → Auftrag senden (idempotent über `requestId`), abwarten, Ergebnis festhalten.
 * Budget: die Grenze wird vor jedem neuen Zug geprüft; ein laufender Zug wird zu Ende geführt.
 * Tore (Spielmodus; bei `input.nachtgate` zusätzlich das Nachttor): kein neuer Zug, solange eines zu ist.
 */
import { NUTZUNG as UsageDoc, aktivesFensterImHandler, konfigurieren as configure } from './lauf/index.js';
import { LaufListe } from './documents.js';
import { VERSUCHE_MAX, beobachte, tokenAusNutzung } from './harness2.js';
import { aufruferMerken } from './aufrufer.js';

/** Nur Text, ohne Werkzeugmarken: das Merkmal soll die Antwort sehen, nicht unsere Spur. */
export function klartext(eintrag) {
  const nachricht = eintrag?.model?.[0];
  if (!nachricht || !Array.isArray(nachricht.content)) return '';
  return nachricht.content
    .filter((b) => b?.type === 'text' && b.text)
    .map((b) => b.text)
    .join('\n')
    .trim();
}

export function werkzeugNamen(eintraege) {
  const namen = [];
  for (const e of eintraege) {
    for (const m of e.model ?? []) {
      if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
      for (const b of m.content) if (b?.type === 'toolCall') namen.push(String(b.name ?? ''));
    }
  }
  return namen;
}

export const kurzText = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function budgetGrenze(input, verbrauch) {
  if (verbrauch.zuege >= input.budget.zuege) return 'budget-zuege';
  if (input.budget.token && verbrauch.token >= input.budget.token) return 'budget-token';
  return null;
}

export async function listeAktualisieren(tx, taskId, aendern) {
  const liste = await tx.doc(LaufListe);
  const e = liste.eintraege[String(taskId)];
  if (e) aendern(e);
}

/**
 * @param gate optional, `async (task) => null | { art: 'pause' | 'abbruch', grund, bis? }`; wirkt nur bei `input.nachtgate`.
 *        `bis` (ms) = frühester Wiederbeginn bei einer Pause (z. B. nächster Fensterbeginn).
 */
export function erstelleZug(cfg, { spielmodus, pauseMs, gate } = {}) {
  const provider = cfg.pi_durable.model.provider;
  const standard = cfg.pi_durable.model.default;
  const pause = Math.max(50, Number(pauseMs ?? cfg.harness2?.pause_ms ?? 30_000));
  const modellFuer = (input, editor) => ({
    provider,
    modelId: (editor ? input.editorModell : null) || input.modell || standard,
  });

  /** Bricht geordnet ab: der Rest wird nicht gemessen, `ablegen` schreibt das Teilergebnis. */
  async function abbrechen(task, runtime, context, grund) {
    await runtime.commit((tx, current) => {
      const c = current.state.checkpoint;
      return {
        status: 'running',
        checkpoint: { ...c, phase: 'ablegen', abbruch: { grund, phase: c.phase, runde: c.runde ?? null } },
      };
    }, context);
    return 'abbruch';
  }

  /** Rückgabe: 'fertig' (nichts zu tun), 'weiter' (Prüfpunkt geschrieben), 'pause', 'abbruch'. */
  async function schritt(task, runtime, context, spec) {
    const input = task.input;
    const cp = task.state.checkpoint;
    const rec = cp.laeufe[spec.key];
    if (rec?.ende) return 'fertig';

    if (!rec || rec.fehler) {
      if (rec && rec.v >= VERSUCHE_MAX) return abbrechen(task, runtime, context, 'modell-fehler');
      const grenze = budgetGrenze(input, cp.verbrauch);
      if (grenze) return abbrechen(task, runtime, context, grenze);
      const tor = input.nachtgate && gate ? await gate(task) : null;
      if (tor?.art === 'abbruch') return abbrechen(task, runtime, context, tor.grund);
      const pausiert = tor?.art === 'pause' ? tor.grund : spielmodus?.an?.() ? 'spielmodus' : null;
      if (pausiert) {
        // Kein neuer Zug. Ein schon laufender Zug wird nicht abgebrochen.
        const bis = Math.max(runtime.now() + pause, Number(tor?.bis) || 0);
        await runtime.sleepUntil(bis, { ...cp, pausiert }, context);
        return 'pause';
      }
      await runtime.commit(async (tx, current) => {
        const kind = await tx.createConversation({ ownership: { kind: 'task', taskId: task.id } });
        await configure(tx, kind.id, {
          model: modellFuer(input, spec.editor),
          cwd: input.cwd ?? undefined,
          instructions: spec.anweisung,
        });
        // Aufruferkopf für das Tor (aufrufer.js): Nachtwerkstatt-Schmiede oder Harness2-Pilot.
        await aufruferMerken(tx, kind.id, task);
        const c = current.state.checkpoint;
        const v = (c.laeufe[spec.key]?.v ?? 0) + 1;
        const verbrauch = { ...c.verbrauch, zuege: c.verbrauch.zuege + 1 };
        await listeAktualisieren(tx, task.id, (e) => {
          e.phase = c.phase;
          e.kinder = [...(e.kinder ?? []), kind.id];
          e.verbrauch = verbrauch;
        });
        return {
          status: 'running',
          checkpoint: { ...c, laeufe: { ...c.laeufe, [spec.key]: { v, kindId: kind.id } }, verbrauch },
        };
      }, context);
      return 'weiter';
    }

    const gespraech = await runtime.conversation(rec.kindId, context);
    if (!gespraech) throw new Error(`Kindgespräch ${rec.kindId} fehlt`);
    const submission = await gespraech.submit(
      {
        type: 'input',
        content: spec.auftrag,
        requestId: `h2:${task.id}:${spec.key}:${rec.v}`,
        entry: { kind: 'fyos.harness2.auftrag', data: { lauf: String(task.id), schluessel: spec.key } },
      },
      context,
    );
    const ende = await submission.wait(context);
    let ergebnis;
    if (ende.status !== 'done') {
      ergebnis = { fehler: String(ende.reason ?? 'unbeantwortet') };
    } else {
      const verlauf = await aktivesFensterImHandler(runtime, rec.kindId, context);
      const eintrag = verlauf.entries.find((e) => e.id === ende.answer);
      const antwort = klartext(eintrag);
      ergebnis = spec.merkmal
        ? { ende: true, wert: beobachte(spec.merkmal, { antwort, werkzeuge: werkzeugNamen(verlauf.entries) }), auszug: kurzText(antwort, 240) }
        : { ende: true, text: String(antwort).slice(0, spec.maxZeichen ?? 6000) };
    }
    const nutzung = await runtime.snapshot(UsageDoc, rec.kindId, context).catch(() => undefined);
    const token = tokenAusNutzung(nutzung);
    await runtime.commit(async (tx, current) => {
      const c = current.state.checkpoint;
      const verbrauch = { ...c.verbrauch, token: c.verbrauch.token + token };
      await listeAktualisieren(tx, task.id, (e) => {
        e.verbrauch = verbrauch;
      });
      return {
        status: 'running',
        checkpoint: { ...c, laeufe: { ...c.laeufe, [spec.key]: { ...c.laeufe[spec.key], ...ergebnis, token } }, verbrauch },
      };
    }, context);
    return 'weiter';
  }

  return { schritt, abbrechen, budgetGrenze };
}
