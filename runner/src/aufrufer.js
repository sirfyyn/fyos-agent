/**
 * aufrufer.js — wer fragt das Modell? Der Aufruferkopf `X-FYOS-Aufrufer` je Anfrage an Hausmodell/Katy.
 *
 * Das Tor (und die Engine dahinter) legt feste Slots je Aufrufer an, damit das Hauptgespräch, der Zusammenfasser (Pi-Verdichtung)
 * und die Kindgespräche sich nicht gegenseitig den Prompt-Cache verdrängen (25.10.2026: 37 verlorene lange Prompts, ca. 1,7 Mio
 * Token). Der Kopf ändert den Prompt nicht; er ist nur ein HTTP-Header.
 *
 * Werte (Vertrag, docs/current/PI-DURABLE-RUNNER.md#aufruferkopf):
 *   persona-haupt              Hauptgespräch und jedes Gespräch eines Menschen (Vorgabe, auch für Unbekanntes)
 *   persona-kind:<art>         Kindgespräch einer Aufgabe: `lauf` (aufgabe_starten), `harness2` (Harness2-Pilot)
 *   zusammenfasser           Pi-Verdichtung („You are a context summarization assistant“)
 *   sprache                  das Sprachgespräch „Persona Sprache“
 *   nachtwerkstatt:<schmiede> `dreaming`, `skillsmith`, `nodesmith` (deren Züge und der Pilot der Skillsmith)
 *   arbeit                   Zug der Arbeitsschleife im Hauptgespräch (Eingang von `zeitplan`, Bezug `arbeit-…`)
 *   schnellweg               reserviert: der Schnellweg läuft nicht über diesen Runner, ein Aufrufer außerhalb setzt ihn selbst
 *
 * Wie der Wert vom Gespräch zur Stromfunktion kommt: Ein `beforeRequest`-Haken (pi-durable ruft ihn vor jeder Anfrage mit der
 * Gesprächs-Id) bestimmt die Art und hängt sie als Symbol-Eigenschaft an die erste Nachricht der Anfrage. `praefixHuelle`
 * liest sie dort und setzt den Header. Symbol-Eigenschaften landen weder im Prompt noch in der Datenbank. Die Art eines
 * Kindgesprächs wird beim Anlegen in `AgentMeta.aufrufer` festgehalten (dauerhaft, überlebt den Neustart).
 */
import { ERZEUGUNG as GenerationTask, haken as hook } from './lauf/index.js';
import { AgentMeta } from './documents.js';

export const AUFRUFER_KOPF = 'X-FYOS-Aufrufer';
export const AUFRUFER_VORGABE = 'persona-haupt';
export const MARKE = Symbol.for('fyos.aufrufer');

const ZUSAMMENFASSER = /^\s*You are a context summarization assistant/;
const ARBEIT = /^\s*Eingang von [^\n]*?· Bezug arbeit-/;

const textVon = (inhalt) => {
  if (typeof inhalt === 'string') return inhalt;
  if (!Array.isArray(inhalt)) return '';
  return inhalt.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
};

/** Der Anfang einer Nachricht als Text (nur so viel, wie die Muster brauchen). */
const anfang = (nachricht) => textVon(nachricht?.content).slice(0, 400);

/** Der Wert für eine Aufgabe, die ein Kindgespräch anlegt (`task.kind`, `task.input`); sonst null. */
export function aufruferAusAufgabe(task) {
  const art = String(task?.kind ?? '');
  if (art.startsWith('fyos.nachtwerkstatt.')) return `nachtwerkstatt:${art.slice('fyos.nachtwerkstatt.'.length)}`;
  if (art === 'fyos.harness2-pilot') return task?.input?.nachtgate ? 'nachtwerkstatt:skillsmith' : 'persona-kind:harness2';
  if (art === 'fyos.lauf') return 'persona-kind:lauf';
  return null;
}

/** Hält die Art in `AgentMeta` des Kindgesprächs fest; `tx` ist die Transaktion, in der es angelegt wird. */
export async function aufruferMerken(tx, conversationId, task) {
  const wert = aufruferAusAufgabe(task);
  if (!wert) return;
  const meta = await tx.doc(AgentMeta, conversationId);
  meta.aufrufer = wert;
}

/**
 * Die Art einer Anfrage. `meta` ist `AgentMeta` des Gesprächs (oder null), `messages` die Nachrichten der Anfrage.
 * Rein; ohne Hinweis gilt `persona-haupt`.
 */
export function bestimmeAufrufer({ meta = null, messages = [] } = {}) {
  if (ZUSAMMENFASSER.test(anfang(messages[0]))) return 'zusammenfasser';
  if (typeof meta?.aufrufer === 'string' && meta.aufrufer) return meta.aufrufer;
  if (meta?.art === 'sprache') return 'sprache';
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== 'user') continue;
    return ARBEIT.test(anfang(messages[i])) ? 'arbeit' : AUFRUFER_VORGABE;
  }
  return AUFRUFER_VORGABE;
}

/** Hängt die Art an die erste Nachricht (eine Kopie; Symbol-Eigenschaft, nicht Teil des Prompts). */
export function markiere(messages, art) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const [erste, ...rest] = messages;
  return [{ ...erste, [MARKE]: art }, ...rest];
}

/** Die Art, die ein Kontext trägt; ohne Marke an der ersten Nachricht erkennt sie den Zusammenfasser, sonst `persona-haupt`. */
export function aufruferVon(context) {
  const erste = context?.messages?.[0];
  if (erste?.[MARKE]) return erste[MARKE];
  return ZUSAMMENFASSER.test(anfang(erste)) ? 'zusammenfasser' : AUFRUFER_VORGABE;
}

/** Die Optionen mit dem Aufruferkopf; andere Köpfe bleiben, ein schon gesetzter Aufruferkopf auch. */
export function mitAufruferKopf(options, art) {
  const koepfe = options?.headers ?? {};
  if (Object.keys(koepfe).some((k) => k.toLowerCase() === AUFRUFER_KOPF.toLowerCase())) return options;
  return { ...(options ?? {}), headers: { ...koepfe, [AUFRUFER_KOPF]: art } };
}

/**
 * Der Haken für eine Erweiterung. `fest` setzt die Art ohne Nachschlagen (Sprach-Erweiterung); sonst wird sie aus
 * `AgentMeta` und den Nachrichten bestimmt. Ein Fehler beim Nachschlagen lässt die Anfrage unberührt.
 */
export function aufruferHaken({ fest = null } = {}) {
  return hook(GenerationTask, {
    beforeRequest: async (request, api, context) => {
      let art = fest;
      if (!art) {
        let meta = null;
        try {
          meta = (await api.snapshot(AgentMeta, api.conversationId, context)) ?? null;
        } catch {
          meta = null;
        }
        art = bestimmeAufrufer({ meta, messages: request.messages });
      }
      return { messages: markiere(request.messages, art) };
    },
  });
}
