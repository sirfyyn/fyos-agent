/**
 * kleines-tor.js — das zweite Tor (Besitzer 20.10., Entscheidungsbuch 512).
 *
 * Kleine, lesende, umkehrbare Aufträge (`istKleinLesend`) dürfen auch laufen, wenn das erste Tor
 * zu ist, solange das Hub-Tor für die Art `lesen` offen ist. Besitzer' Anwesenheit hält sie nicht auf;
 * Hausmodell belegt (er spricht gerade mit ihr), Dev-Fenster, Pause und Schalter schon.
 *
 * Zusammenbau:  ingress.kleinesTor = (e) => istKleinLesend(e) && lesenTor.offen;
 */
import { HintergrundTor } from './tor.js';

// Im RPC-Runner steht die Kopfzeile `[Ereignis aus alarm, …]` schon im gemerkten Text; hier kommt sie erst bei
// der Übergabe an den Agenten dazu. Beide Formen zählen.
const BEHOBEN = /^(?:\[Ereignis aus alarm[^\]]*\]\s*)?Behoben:/i;
const JOB_OK = /fertig\.\s+Exit 0\b/;

/** Vorgabe von `hintergrund_tor_lesen` im RPC-Runner (gilt, wenn der Schlüssel fehlt; `null` = aus). */
export const LESEN_VORGABE = {
  werkzeug: 'schleifen.darf',
  argumente: { schleife: 'arbeit', art: 'lesen' },
  pruefen_s: 60,
};

/**
 * Ist das ein kleiner, lesender, umkehrbarer Auftrag? Nur Aufträge, die von sich aus nichts
 * verlangen als zur Kenntnis nehmen oder nachsehen:
 *   - Alarm „Behoben: …“ (der Alarm ist weg, nichts zu tun außer vermerken),
 *   - Fertigmeldung eines Hintergrundjobs, der mit Exit 0 endete,
 *   - die stündliche Prüfung „Was liegt“ (`takt-liegt-…`, liest nur),
 *   - ein Zug der Arbeitsschleife in der Stufe `lesen` (Bezug `arbeit-<Vorgang>`, von `arbeit-lesen`).
 * Alles andere (neue Alarme, Besitzer' Nachrichten, ITSM, Freigaben, fehlgeschlagene Jobs) braucht das
 * volle Tor.
 *
 * Abweichung vom RPC-Runner: dort steht „fertig. Exit 0“ mit einem Leerzeichen, der Text der
 * Fertigmeldung trennt aber mit einem Zeilenumbruch — die Regel traf nie. Hier genügt Leerraum.
 * Gesucht wird nur im Kopf der Meldung, nicht in der abgedruckten Programmausgabe (Daten).
 */
export function istKleinLesend(eintrag) {
  if (String(eintrag?.klasse ?? '') === 'max') return false;
  const quelle = String(eintrag?.quelle ?? '');
  const text = String(eintrag?.text ?? '');
  if (quelle === 'alarm') return BEHOBEN.test(text);
  if (quelle === 'job') return JOB_OK.test(text.split('\nLetzte Ausgabe')[0]);
  if (quelle === 'zeitplan') {
    const bezug = String(eintrag?.bezug ?? '');
    if (bezug.startsWith('takt-liegt-')) return true;
    // Arbeitsschleife in der Stufe `lesen`: der Zug ist ausdrücklich ein lesender (von = `arbeit-lesen`).
    // Stufe `schreiben` trägt `arbeit-schreiben` und braucht das volle Tor.
    return bezug.startsWith('arbeit-') && String(eintrag?.von ?? '') === 'arbeit-lesen';
  }
  return false;
}

/** Das Hub-Tor für die Art `lesen`; sonst genau wie `HintergrundTor`. */
export class LesenTor extends HintergrundTor {
  constructor({ hub, cfg, beiOeffnen, log } = {}) {
    const k = cfg?.hintergrund_tor_lesen ?? LESEN_VORGABE;
    const ausgabe = log ?? ((z) => console.log(z));
    super({
      hub,
      werkzeug: k.werkzeug,
      argumente: k.argumente ?? {},
      pruefenS: k.pruefen_s ?? 60,
      beiOeffnen,
      log: (z) => ausgabe(String(z).replace('Hintergrund-Tor', 'Lesen-Tor')),
    });
  }

  /**
   * Wie im RPC-Runner: das zweite Tor gibt es nur mit erstem Tor und gesetztem Werkzeug.
   * Fehlt der Schlüssel, gilt die Vorgabe; `hintergrund_tor_lesen: null` schaltet es ab.
   */
  static ausKonfig(cfg, { hub, tor, beiOeffnen, log } = {}) {
    const k = cfg?.hintergrund_tor_lesen === undefined ? LESEN_VORGABE : cfg.hintergrund_tor_lesen;
    if (!k || typeof k !== 'object' || !k.werkzeug || !tor) return null;
    return new LesenTor({ hub, cfg: { hintergrund_tor_lesen: k }, beiOeffnen, log });
  }
}
