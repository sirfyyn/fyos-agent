/**
 * kontext-anzeige.js — die Kontextfüllung einer Sitzung für die Statuszeile der Agent-App: `usage.context = { tokens, window }`.
 *
 * `usage` (UsageDoc von pi-durable) ist die SUMME über die Lebenszeit; die aktuelle Füllung steht nur in der `usage` der LETZTEN
 * Antwort im Verlauf (test/kontext-anzeige.test.js). Dieses Modul rechnet daraus dieselbe Zahl, die die Oberfläche beim Abspielen des
 * Verlaufs selbst bildet (apps/fyos-shell/app/ui/agent/runner-adapter.js, kontextAusNutzung):
 *
 *   - tokens = totalTokens der letzten Antwort (sonst Summe input+output+cacheRead+cacheWrite); eine Antwort ohne verwertbare Zahl
 *     (abgebrochen, fehlgeschlagen) ändert nichts;
 *   - nach `pi.reset` (leeren) und `pi.compaction` (verdichten) ist die Füllung unbekannt: `tokens` ist null, bis die nächste
 *     Antwort kommt;
 *   - window = Kontextfenster des Modells, das die Sitzung gerade benutzt (models.js, fensterFuerModell).
 *
 * Rein und ohne Zugriff auf die Datenbank: der Runner reicht die Einträge herein, die er ohnehin liefert (Ansicht, Snapshot, Ereignisse).
 */

const MARKER = new Set(['pi.reset', 'pi.compaction']);

function zahl(x) {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0;
}

/** Tokens aus der `usage` einer Antwort (pi-ai); `null`, wenn keine verwertbare Zahl darin steht. */
export function tokensAusNutzung(u) {
  if (!u || typeof u !== 'object') return null;
  const t = zahl(u.totalTokens) || zahl(u.input) + zahl(u.output) + zahl(u.cacheRead) + zahl(u.cacheWrite);
  return t > 0 ? t : null;
}

/**
 * Der Stand nach EINEM Eintrag: Marker setzen auf `null`, eine Antwort mit verwertbarer usage setzt die neue Zahl,
 * alles andere lässt den bisherigen Stand.
 */
export function kontextNachEintrag(bisher, eintrag) {
  if (!eintrag || typeof eintrag !== 'object') return bisher;
  if (MARKER.has(eintrag.kind)) return null;
  let stand = bisher;
  for (const m of eintrag.model ?? []) {
    if (m?.role !== 'assistant') continue;
    const t = tokensAusNutzung(m.usage);
    if (t !== null) stand = t;
  }
  return stand;
}

/** Die Füllung nach einer Reihe von Einträgen in aufsteigender Reihenfolge (aktives Fenster oder sichtbarer Verlauf). */
export function kontextAusEintraegen(eintraege) {
  let stand = null;
  for (const e of eintraege ?? []) stand = kontextNachEintrag(stand, e);
  return stand;
}

/** `usage` mit dem zusätzlichen Feld `context`; die übrigen Felder bleiben unverändert (auch bei fehlender usage). */
export function nutzungMitKontext(usage, tokens, fenster) {
  const basis = usage && typeof usage === 'object' ? usage : { models: {}, tools: {} };
  return { ...basis, context: { tokens: tokens ?? null, window: fenster ?? null } };
}
