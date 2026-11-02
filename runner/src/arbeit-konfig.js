/**
 * arbeit-konfig.js — Konfiguration der Arbeitsschleife (`pi_durable.arbeitsschleife`), ohne schwere Importe.
 *
 * Gelesen von `config.js` (Vorgaben, geprüfte Form) und `arbeitsschleife.js`. Unsinn fällt auf die Vorgabe zurück;
 * die Stufe fällt nie auf `schreiben` oder `schreiben_klein` zurück, sondern immer auf `lesen`.
 * Stufen: `lesen` (Vorgabe) | `schreiben_klein` (Schreibzüge nur für Vorgänge mit erteilter Freigabe oder Einstufung klein,
 * sonst lesen) | `schreiben` (alles, volles Tor).
 */

export const STUFEN = ['lesen', 'schreiben_klein', 'schreiben'];

/** Vorgaben von `pi_durable.arbeitsschleife`. */
export const ARBEIT_VORGABE = Object.freeze({
  an: true,
  stufe: 'lesen',
  pause_s: 30, // Abstand zwischen zwei Zügen
  max_je_stunde: 6,
  max_je_tag: 40,
  mindestabstand_je_vorgang_min: 120,
  max_je_vorgang_tag: 3,
  erfolglos_max: 3, // so viele Züge in Folge ohne Ergebnis, dann Pause bis zum nächsten Takt
  pruefen_s: 15, // wie oft die Schleife nach dem Leerlauf schaut
  leer_pause_s: 300, // nach „nichts fällig“
  fehler_pause_s: 120, // nach einem Lesefehler des Hubs
  ruhe_s: 5, // so lange nach dem Zug muss der Agent ruhig sein, bevor er als fertig gilt
  zug_frist_min: 90, // so lange darf ein eingereihter Zug unausgeliefert liegen (Tor zu, Reflex hält)
  abbruch_pause_min: 60, // Pause nach Abbruch, wenn kein Takt bekannt ist
  // Nur für die Stufe `schreiben_klein` (src/arbeit-schreiben.js):
  schreiben_klein_max_je_tag: 5, // höchstens so viele Schreibzüge je gleitendem Tag
  schreiben_klein_abstand_min: 90, // Mindestabstand zwischen dem Ende eines Schreibzugs und dem nächsten
  schreiben_klein_rueckfall_h: 24, // nach einem Schreibzug ohne Ergebnis gilt so lange wieder `lesen`
  schreiben_klein_je_vorhaben: 2, // höchstens so viele Schreibzüge je freigegebenem Vorhaben (Prüfsumme)
  schreiben_klein_freigabe_max_tage: 30, // eine ältere Freigabe trägt nicht mehr
  schreiben_klein_zerstoerend_mit_freigabe: true, // ein ausdrücklich freigegebenes (auch zerstörendes) Vorhaben darf laufen; false = nie
});

const istObjekt = (w) => !!w && typeof w === 'object' && !Array.isArray(w);

const zahl = (w, vorgabe, min, max) => {
  const n = Number(w);
  if (w === null || w === undefined || w === '' || !Number.isFinite(n)) return vorgabe;
  return Math.min(max, Math.max(min, n));
};

const wahr = (w, vorgabe) =>
  w === undefined || w === null ? vorgabe : w === true || ['1', 'true', 'ja', 'an', 'on', 'yes'].includes(String(w).trim().toLowerCase());

/** Die Konfiguration in eine geprüfte Form bringen. */
export function arbeitKonfig(roh) {
  const r = istObjekt(roh) ? roh : {};
  const v = ARBEIT_VORGABE;
  const an = wahr(r.an, v.an);
  return {
    an,
    stufe: STUFEN.includes(r.stufe) ? r.stufe : v.stufe,
    pause_s: zahl(r.pause_s, v.pause_s, 0, 3600),
    max_je_stunde: Math.trunc(zahl(r.max_je_stunde, v.max_je_stunde, 0, 1000)),
    max_je_tag: Math.trunc(zahl(r.max_je_tag, v.max_je_tag, 0, 10_000)),
    mindestabstand_je_vorgang_min: zahl(r.mindestabstand_je_vorgang_min, v.mindestabstand_je_vorgang_min, 0, 10_080),
    max_je_vorgang_tag: Math.trunc(zahl(r.max_je_vorgang_tag, v.max_je_vorgang_tag, 1, 1000)),
    erfolglos_max: Math.trunc(zahl(r.erfolglos_max, v.erfolglos_max, 1, 100)),
    pruefen_s: zahl(r.pruefen_s, v.pruefen_s, 0.01, 3600),
    leer_pause_s: zahl(r.leer_pause_s, v.leer_pause_s, 0.01, 86_400),
    fehler_pause_s: zahl(r.fehler_pause_s, v.fehler_pause_s, 0.01, 86_400),
    ruhe_s: zahl(r.ruhe_s, v.ruhe_s, 0, 600),
    zug_frist_min: zahl(r.zug_frist_min, v.zug_frist_min, 0.01, 10_080),
    abbruch_pause_min: zahl(r.abbruch_pause_min, v.abbruch_pause_min, 1, 10_080),
    schreiben_klein_max_je_tag: Math.trunc(zahl(r.schreiben_klein_max_je_tag, v.schreiben_klein_max_je_tag, 0, 1000)),
    schreiben_klein_abstand_min: zahl(r.schreiben_klein_abstand_min, v.schreiben_klein_abstand_min, 0, 10_080),
    schreiben_klein_rueckfall_h: zahl(r.schreiben_klein_rueckfall_h, v.schreiben_klein_rueckfall_h, 0.01, 720),
    schreiben_klein_je_vorhaben: Math.trunc(zahl(r.schreiben_klein_je_vorhaben, v.schreiben_klein_je_vorhaben, 1, 100)),
    schreiben_klein_freigabe_max_tage: zahl(r.schreiben_klein_freigabe_max_tage, v.schreiben_klein_freigabe_max_tage, 0.01, 3650),
    schreiben_klein_zerstoerend_mit_freigabe: wahr(r.schreiben_klein_zerstoerend_mit_freigabe, v.schreiben_klein_zerstoerend_mit_freigabe),
  };
}
