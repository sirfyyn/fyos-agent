/**
 * praefix.js — der Systemkopf bleibt fest, Abschnittsänderungen kommen an ihre Stelle im Gespräch.
 *
 * pi-durable schreibt jede Änderung eines Prompt-Abschnitts (Kontextbuch, Repo-Regeln, geteilter Zustand) als spätere
 * Systemnachricht in das Gespräch. Für Modelle ohne Systemnachrichten mitten im Gespräch (Katys und Rheas Qwen-Vorlage
 * wirft „System message must be at the beginning.“) faltet pi-ai sie zurück in die erste Systemnachricht. Dann ändert sich
 * der Prompt bei Token ≈ 12k, und llama-server rechnet die 100k–200k Token dahinter neu (25.10.2026: 38 volle Neuaufbauten
 * in 18,5 h, zusammen 1,84 h; docs/current/FLE-KRITIK-PLAN.md#turnzeit).
 *
 * Hier wird jede spätere Systemnachricht zerlegt: Werkzeugänderungen bleiben als Systemnachricht ohne Text stehen (pi-ai
 * löst sie wie bisher auf), der Text der Änderung geht an die Nachricht davor, wenn das eine Nutzernachricht oder ein
 * Werkzeugergebnis ist, sonst als eigene Nutzernachricht an dieselbe Stelle. Die Regel hängt nur von der Nachricht davor
 * ab; spätere Nachrichten ändern die Darstellung nicht, der Präfix bleibt also über alle Folgezüge gleich. Nach einer
 * Verdichtung schreibt pi-durable einen neuen vollständigen Kopf; dann steht der neue Stand wieder vorn.
 */
import { systemAenderungText as renderSystemMessageUpdate } from './lauf/index.js';
import { aufruferVon, mitAufruferKopf } from './aufrufer.js';

const ANFANG = '<system_aktualisierung>\nDieser Stand ersetzt den gleichnamigen Abschnitt im Systemprompt.\n';
const ENDE = '\n</system_aktualisierung>';

const hatText = (m) => {
  const c = m.content;
  const inhalt = typeof c === 'string' ? c.length > 0 : Array.isArray(c) && c.length > 0;
  return inhalt || Object.keys(m.sections ?? {}).length > 0;
};

function anhaengen(nachricht, text) {
  const c = nachricht.content;
  if (typeof c === 'string') return { ...nachricht, content: `${c}\n\n${text}` };
  return { ...nachricht, content: [...(Array.isArray(c) ? c : []), { type: 'text', text }] };
}

/** Gibt einen Kontext zurück, dessen erste Systemnachricht sich durch spätere Abschnittsänderungen nicht mehr ändert. */
export function praefixStabil(context) {
  const msgs = context?.messages;
  if (!Array.isArray(msgs) || msgs.length < 2) return context;
  if (!msgs.slice(1).some((m) => m?.role === 'system' && hatText(m))) return context;

  const aus = [];
  msgs.forEach((m, i) => {
    if (i === 0 || m?.role !== 'system' || !hatText(m)) {
      aus.push(m);
      return;
    }
    const text = `${ANFANG}${renderSystemMessageUpdate(m)}${ENDE}`;
    const { content: _c, sections: _s, ...rest } = m;
    if (rest.toolsAdded?.length || rest.toolsRemoved?.length) aus.push({ ...rest, content: '' });
    // Die Nachricht davor, ohne die eben stehengelassenen Werkzeug-Systemnachrichten.
    let j = aus.length - 1;
    while (j >= 0 && aus[j]?.role === 'system' && j > 0) j--;
    const vorher = aus[j];
    if (j > 0 && (vorher?.role === 'user' || vorher?.role === 'toolResult')) {
      aus[j] = anhaengen(vorher, text);
    } else {
      aus.push({ role: 'user', content: text, timestamp: m.timestamp ?? 0 });
    }
  });
  return { ...context, messages: aus };
}

/**
 * Hüllt die `stream`/`streamSimple`-Funktionen einer API so, dass jede Anfrage den festen Kopf bekommt und den
 * Aufruferkopf `X-FYOS-Aufrufer` trägt (aufrufer.js). Der Header ändert den Prompt nicht.
 */
export function praefixHuelle({ stream, streamSimple }) {
  return {
    stream: (model, context, options) => stream(model, praefixStabil(context), mitAufruferKopf(options, aufruferVon(context))),
    streamSimple: (model, context, options) => streamSimple(model, praefixStabil(context), mitAufruferKopf(options, aufruferVon(context))),
  };
}
