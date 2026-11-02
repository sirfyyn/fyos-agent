/**
 * persona/matrix.js — Persona schreibt Besitzer von sich aus auf Matrix (Besitzer 20.10.2026, Entscheidungsbuch 511).
 *
 * Port von `fyos-matrix`. Werkzeug `matrix_senden {text, art?, bezug?, dringend?, raum?}`. Dahinter steht
 * der Dienst `fyos-matrix-sender` auf Hauptserver (Vorgabe 127.0.0.1:18436, `FYOS_MATRIX_URL`): Er hält das Konto
 * @persona und erlaubt nur freigegebene Räume. Das Werkzeug trägt weder Token noch Raum-Ids. In der Ruhezeit
 * 22–7 weist der Dienst ab (außer `dringend`), ebenso bei mehr als 30 Nachrichten je Stunde.
 *
 * Fehler und Abweisungen kommen wie früher als Text zurück, nicht als geworfener Fehler.
 */
import { Schema as Type, werkzeug as defineTool } from '../lauf/index.js';

const text = (t, details) => ({ output: [{ type: 'text', text: t }], ...(details !== undefined ? { details } : {}) });

export function matrixWerkzeuge({ env = process.env, fetch: holen = (...a) => fetch(...a) } = {}) {
  const senden = defineTool({
    name: 'matrix_senden',
    description:
      'Schreibt Besitzer eine Nachricht auf Matrix (Raum ops). Für alles Relevante, was du tust, findest oder entscheidest und wo du sicher bist, ' +
      'dass es ihn interessiert: was, warum es ihn betrifft, nächster Schritt, Vorgangsnummer in `bezug`. Kleinigkeiten bündeln, Routine ohne ' +
      'Wirkung nicht melden. Ruhezeit 22–7 nur mit dringend=true und nur für Notfälle. Keine Geheimnisse, keine Inhalte Dritter.',
    parameters: Type.Object({
      text: Type.String({ minLength: 1, maxLength: 3000 }),
      art: Type.Optional(
        Type.Union(['meldung', 'erledigt', 'befund', 'frage', 'info'].map((w) => Type.Literal(w))),
      ),
      bezug: Type.Optional(Type.String({ maxLength: 60, description: 'Vorgang oder Anlass, z. B. PRB-4429' })),
      dringend: Type.Optional(Type.Boolean()),
      raum: Type.Optional(Type.String({ maxLength: 40, description: 'Alias eines freigegebenen Raums; Vorgabe ops' })),
    }),
    execute: async (p, _api, context) => {
      const basis = (env.FYOS_MATRIX_URL || 'http://127.0.0.1:18436').replace(/\/$/, '');
      const body = {
        text: String(p?.text ?? ''),
        art: p?.art,
        bezug: p?.bezug,
        dringend: p?.dringend === true,
        raum: p?.raum,
      };
      const frist = AbortSignal.timeout(20_000);
      const signal = context?.signal ? AbortSignal.any([context.signal, frist]) : frist;
      try {
        const r = await holen(`${basis}/senden`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
        const j = await r.json().catch(() => ({}));
        if (r.status === 200 && j.ok) return text(j.schatten ? 'Nur festgehalten (Schattenbetrieb), nicht gesendet.' : 'Gesendet.', j);
        if (r.status === 409) return text(`Nicht gesendet: ${j.grund}. Heb es dir auf (Kontextbuch, Abendbriefing).`, j);
        if (r.status === 429) return text(`Nicht gesendet: ${j.grund}.`, j);
        return text(`Nicht gesendet (${r.status}): ${j.grund ?? 'unbekannter Fehler'}.`, j);
      } catch (f) {
        return text(`Matrix-Sender nicht erreichbar: ${String(f?.message ?? f).slice(0, 120)}. Zur Not os.mitteilen.`);
      }
    },
  });

  return [senden];
}
