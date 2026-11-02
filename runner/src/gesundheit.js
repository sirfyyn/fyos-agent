/**
 * gesundheit.js — der Wächter „Runner stumm“ im Runner selbst (Besitzer 25.10.2026: „go dafür“, Entscheidung 581).
 *
 * Anlass: Am 25.10. verwarf der Hub jedes Ereignis des Runners; der Dienst lief, der Steuerkanal antwortete, nur die Welt hörte nichts.
 * Der Runner zählt darum selbst mit, was nach außen gelingt, und bewertet es mit einer Ampel:
 *
 *   ok    alles kommt an
 *   gelb  etwas staut sich oder wiederholt sich (Puffer halb voll, drei Fehler in Folge, Ausgang ≥ 2 min stumm …)
 *   rot   der Runner ist für die Welt stumm oder blind (Ausgang ≥ 5 min ohne Erfolg trotz wartender Ereignisse, Hub lehnt ab,
 *         Eingang liest seit Minuten nicht, Besitzer' Nachricht liegt, Puffer läuft über)
 *
 * Die Zähler leben in `Egress.gesundheit()` und `Ingress.gesundheit()`; diese Datei bewertet nur (reine Funktion, ohne Uhr und
 * ohne E/A), damit jede Regel ohne Warten testbar ist. `/zustand` zeigt das Ergebnis unter `gesundheit`;
 * `scripts/ops/runner_wache.py` liest es und meldet Wechsel über den Meldeweg des Hubs.
 */

export const SCHWELLEN = Object.freeze({
  /** Ältestes wartendes Ausgangsereignis (s): gelb / rot. */
  ausgang_gelb_s: 120,
  ausgang_rot_s: 300,
  /** Fehler des Ausgangs in Folge: gelb / rot. */
  fehler_gelb: 3,
  fehler_rot: 10,
  /** Ablehnungen des Hubs (HTTP 4xx) in Folge: ab hier rot, das ist ein Vertragsbruch und heilt nicht von selbst. */
  ablehnung_rot: 3,
  /** Puffer-Füllung (Anteil von maxBuffer): gelb / rot. */
  stau_gelb: 0.5,
  stau_rot: 0.9,
  /** Ein Verwerfen aus dem Puffer ist so lange rot (s). */
  verworfen_rot_s: 600,
  /** Eingang: so lange ohne erfolgreichen Lesevorgang (s) über dem Takt der Anfrage: gelb / rot. */
  eingang_gelb_s: 60,
  eingang_rot_s: 300,
  lesefehler_gelb: 3,
  lesefehler_rot: 10,
  /** Ein Zug (Hauptgespräch) dauert so lange (s): gelb / rot. */
  zug_gelb_s: 45 * 60,
  zug_rot_s: 4 * 3600,
  /** Eine Nachricht von Besitzer liegt so lange (s), ohne dass ein Zug läuft: rot. */
  max_wartet_rot_s: 300,
});

const RANG = { ok: 0, gelb: 1, rot: 2 };

const minuten = (s) => (s >= 90 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);

/**
 * @param {object} e
 * @param {number} e.jetzt                   Uhr in ms
 * @param {boolean} e.pi_laeuft              Harness lebt
 * @param {boolean} e.spielmodus
 * @param {boolean} e.beschaeftigt           ein Zug läuft im Hauptgespräch
 * @param {object|null} e.ausgang            `Egress.gesundheit()` oder null (Ausgang aus)
 * @param {object|null} e.eingang            `Ingress.gesundheit()` oder null (Schatten, kein Eingang)
 * @param {object|null} e.zug                `{laeuft, seit_s}` des Hauptgesprächs
 * @param {number|null} e.max_wartet_s       Alter der ältesten wartenden Nachricht von Besitzer in s
 * @param {object} [schwellen]
 * @returns {{ampel: 'ok'|'gelb'|'rot', gruende: {stufe: string, code: string, text: string}[]}}
 */
export function bewerte(e, schwellen = SCHWELLEN) {
  const s = { ...SCHWELLEN, ...schwellen };
  const gruende = [];
  const grund = (stufe, code, text) => gruende.push({ stufe, code, text });

  if (!e.pi_laeuft) grund('rot', 'harness', 'Der dauerhafte Harness läuft nicht (Neustart nötig).');

  const a = e.ausgang;
  if (a && a.aktiv !== false) {
    const wartet = a.stau > 0;
    if (a.abgelehnt_in_folge >= s.ablehnung_rot) {
      grund('rot', 'hub_lehnt_ab', `Der Hub lehnt ${a.abgelehnt_in_folge} Meldungen in Folge ab (${a.letzter_fehler?.text ?? 'ohne Text'}).`);
    }
    if (wartet && a.aeltestes_s !== null && a.aeltestes_s >= s.ausgang_rot_s) {
      grund('rot', 'ausgang_stumm', `Ausgang seit ${minuten(a.aeltestes_s)} ohne Erfolg, ${a.stau} Ereignisse warten.`);
    } else if (wartet && a.aeltestes_s !== null && a.aeltestes_s >= s.ausgang_gelb_s) {
      grund('gelb', 'ausgang_langsam', `Ausgang zögert: ältestes Ereignis wartet ${minuten(a.aeltestes_s)}, ${a.stau} im Puffer.`);
    }
    if (a.fehler_in_folge >= s.fehler_rot) {
      grund('rot', 'ausgang_fehler', `${a.fehler_in_folge} Fehler in Folge beim Melden (${a.letzter_fehler?.text ?? 'ohne Text'}).`);
    } else if (a.fehler_in_folge >= s.fehler_gelb) {
      grund('gelb', 'ausgang_fehler', `${a.fehler_in_folge} Fehler in Folge beim Melden (${a.letzter_fehler?.text ?? 'ohne Text'}).`);
    }
    const fuell = a.max_puffer > 0 ? a.stau / a.max_puffer : 0;
    if (fuell >= s.stau_rot) grund('rot', 'puffer_voll', `Ausgangspuffer zu ${Math.round(fuell * 100)} % voll (${a.stau}/${a.max_puffer}).`);
    else if (fuell >= s.stau_gelb) grund('gelb', 'puffer_waechst', `Ausgangspuffer zu ${Math.round(fuell * 100)} % voll (${a.stau}/${a.max_puffer}).`);
    if (a.letztes_verwerfen !== null && e.jetzt - a.letztes_verwerfen < s.verworfen_rot_s * 1000) {
      grund('rot', 'verworfen', `Ereignisse wurden aus dem Puffer verdrängt (${a.verworfen} insgesamt) und gehen verloren.`);
    }
  }

  const i = e.eingang;
  if (i?.aktiv) {
    if (i.fehler_in_folge >= s.lesefehler_rot) {
      grund('rot', 'eingang_fehler', `Eingang: ${i.fehler_in_folge} Lesefehler in Folge (${i.letzter_fehler?.text ?? 'ohne Text'}).`);
    } else if (i.fehler_in_folge >= s.lesefehler_gelb) {
      grund('gelb', 'eingang_fehler', `Eingang: ${i.fehler_in_folge} Lesefehler in Folge (${i.letzter_fehler?.text ?? 'ohne Text'}).`);
    }
    // Ein Lesevorgang dauert bis zu `poll_s` (Long-Poll) plus Antwortzeit; erst deutlich darüber steht der Leser.
    if (i.vor_s !== null) {
      const ueber = i.vor_s - (i.poll_s ?? 20);
      if (ueber >= s.eingang_rot_s) grund('rot', 'eingang_steht', `Eingang liest seit ${minuten(i.vor_s)} nicht mehr.`);
      else if (ueber >= s.eingang_gelb_s) grund('gelb', 'eingang_steht', `Eingang liest seit ${minuten(i.vor_s)} nicht mehr.`);
    }
  }

  if (!e.spielmodus && !e.beschaeftigt && e.max_wartet_s !== null && e.max_wartet_s >= s.max_wartet_rot_s) {
    grund('rot', 'max_liegt', `Eine Nachricht von Besitzer liegt seit ${minuten(e.max_wartet_s)}, und kein Zug läuft.`);
  }

  if (e.zug?.laeuft && e.zug.seit_s !== null) {
    if (e.zug.seit_s >= s.zug_rot_s) grund('rot', 'zug_haengt', `Ein Zug läuft seit ${minuten(e.zug.seit_s)}.`);
    else if (e.zug.seit_s >= s.zug_gelb_s) grund('gelb', 'zug_lang', `Ein Zug läuft seit ${minuten(e.zug.seit_s)}.`);
  }

  let ampel = 'ok';
  for (const g of gruende) if (RANG[g.stufe] > RANG[ampel]) ampel = g.stufe;
  return { ampel, gruende };
}
