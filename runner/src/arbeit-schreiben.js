/**
 * arbeit-schreiben.js — die Regeln der Arbeitsschleifen-Stufe `schreiben_klein` (Besitzer, 26.10.2026, „alles freigegeben und
 * genehmigt“; Befund 1 in docs/current/PERSONA-FREISCHALTUNGEN-2026-10-26.md).
 *
 * Reine Funktionen ohne Hub und ohne Harness; `arbeitsschleife.js` ruft sie auf und liefert die Daten.
 *
 * Die Stufe `schreiben_klein` erlaubt Persona Schreibzüge, aber nur für einen Vorgang, der
 *   (1) in ihrem Besitz ist (Zuständiger persona, keine lebende Übernahme eines anderen Agenten) UND
 *   (2) entweder eine ERTEILTE, GEBUNDENE Freigabe hat (Pfad `freigabe`: Antrag mit Prüfsumme im Verlauf und in der
 *       Beschreibung, danach Besitzer' Statuswechsel waiting_approval → in_progress mit Vermerk der Freigabe, nicht widerrufen)
 *       oder als `klein` eingestuft ist (Pfad `klein`: Betriebskonzept `schleifen.einstufen` über Titel und Beschreibung)
 *       UND keine zerstörende Aktion enthält.
 * Alles andere läuft weiter als Lesezug (Stufe `lesen`). Dazu Tagesgrenze, Mindestabstand, Grenze je Vorhaben und der
 * Rückfall auf `lesen` nach einem Schreibzug ohne Ergebnis (`schreibGrenze`).
 *
 * Zur Lesart von „keine zerstörerische Aktion“: ohne Freigabe (Pfad `klein`) schließt jeder Treffer von `ZERSTOEREND`
 * den Schreibzug aus. Ein ausdrücklich freigegebenes Vorhaben (Prüfsumme, von Besitzer erlaubt) darf auch Zerstörendes
 * enthalten, solange `schreiben_klein_zerstoerend_mit_freigabe` (Vorgabe true) gilt; die Freigabe bindet genau dieses
 * Vorhaben, der Zug erhält es als Auftrag. Zerstörende Befehle zur Laufzeit fängt weiter die Wache (`persona/wache.js`).
 */

const TAG_MS = 24 * 60 * 60 * 1000;

/** Kopf einer gebundenen Freigabe-Anfrage (`itsm.freigabe_beantragen`): `## Freigabe angefragt (Prüfsumme <hex>)`. */
export const FREIGABE_KOPF = /^\s*##\s*Freigabe angefragt\s*\(Pr(?:ü|ue)fsumme\s+([0-9a-f]{8,64})\)/i;

/** Hinweise auf Zerstörendes in Titel und Beschreibung. Im Zweifel zählt ein Treffer (Fehlalarm kostet nur einen Lesezug). */
export const ZERSTOEREND = new RegExp(
  [
    'l(?:ö|oe)sch',
    'entfern',
    'deinstall',
    'zerst(?:ö|oe)r',
    '\\bdelete\\b',
    '\\bdestroy\\b',
    '\\bdrop\\b',
    '\\bpurge\\b',
    '\\bwipe\\b',
    '\\btruncate\\b',
    '\\bprune\\b',
    '\\brm\\s+-[a-z]*r',
    'force[- ]?push',
    '--force\\b',
    'push\\s+-f\\b',
    'reset\\s+--hard',
    'clean\\s+-[a-z]*f',
    '\\bformat(?:ier)',
    '(?:ü|ue)berschreib',
    'verwerf',
    'stilllege',
    'abbau',
    '\\bdrain\\b',
    '\\breboot\\b',
    'neu\\s?start',
    'zpool',
    'kubectl\\s+delete',
  ].join('|'),
  'i',
);

const WIDERRUF = /widerruf|zur(?:ü|ue)ckgezogen|nicht\s+ausf(?:ü|ue)hren|doch\s+nicht|\bstopp\b|abgelehnt/i;
const ERTEILT_WORT = /erlaubt|freigegeben|genehmigt|\bja\b|\bok\b|\bgo\b/i;
const ABGELEHNT_WORT = /abgelehnt|nicht\s+erlaubt|verweigert|\bnein\b/i;
const STATUS_ERTEILT = /waiting_approval\s*(?:→|->)\s*in_progress/i;

const zeit = (ts) => {
  const t = Date.parse(String(ts ?? ''));
  return Number.isFinite(t) ? t : null;
};

const istObjekt = (w) => !!w && typeof w === 'object' && !Array.isArray(w);

/** Enthält der Text einen Hinweis auf Zerstörendes? */
export function istZerstoerend(text) {
  return ZERSTOEREND.test(String(text ?? ''));
}

/**
 * Hat der Vorgang eine erteilte, gebundene Freigabe? `vorgang` ist die Antwort von `itsm.vorgang` (Status, Beschreibung,
 * Verlauf neueste zuerst; am besten mit `verlauf: 50` gelesen). Fehlt etwas, ist die Antwort „nein“ mit Grund.
 *
 * Gebunden: Beschreibung und der jüngste Antrag im Verlauf tragen dieselbe Prüfsumme. Erteilt: ein `updated`-Eintrag von
 * `max` (nie von einem Agenten oder der API) nach dem Antrag setzt waiting_approval → in_progress und nennt die Freigabe
 * (oder ein Kommentar von Besitzer kurz davor oder danach sagt erlaubt/freigegeben). Ein späteres Nein von Besitzer (widerrufen,
 * abgelehnt, stopp) hebt sie auf; ein neuer Antrag danach auch.
 */
export function freigabePruefen(vorgang, { jetzt = Date.now(), maxTage = 30 } = {}) {
  const nein = (grund) => ({ erteilt: false, grund });
  if (!istObjekt(vorgang)) return nein('Vorgang nicht lesbar');
  if (String(vorgang.status ?? '') !== 'in_progress') return nein(`Status ${vorgang.status ?? '?'} (nicht in_progress)`);
  const kopf = FREIGABE_KOPF.exec(String(vorgang.beschreibung ?? ''));
  if (!kopf) return nein('keine gebundene Freigabe in der Beschreibung (Kopf mit Prüfsumme fehlt)');
  const summe = kopf[1].toLowerCase();

  const verlauf = (Array.isArray(vorgang.verlauf) ? vorgang.verlauf : [])
    .filter(istObjekt)
    .map((e) => ({ ...e, _t: zeit(e.ts) }))
    .filter((e) => e._t !== null)
    .sort((a, b) => a._t - b._t);

  const antraege = verlauf.filter(
    (e) => e.ereignis === 'comment' && String(e.wer ?? '').toLowerCase() !== 'max' && FREIGABE_KOPF.test(String(e.text ?? '')),
  );
  const antrag = antraege.at(-1);
  if (!antrag) return nein('Freigabe-Antrag nicht im Verlauf (zu alt oder nie gestellt)');
  const antragSumme = FREIGABE_KOPF.exec(String(antrag.text))[1].toLowerCase();
  if (antragSumme !== summe) return nein('Prüfsumme der Beschreibung weicht vom letzten Antrag ab');

  const nachAntrag = verlauf.filter((e) => e._t > antrag._t);
  const erteilung = nachAntrag.find(
    (e) => e.ereignis === 'updated' && String(e.wer ?? '').toLowerCase() === 'max' && STATUS_ERTEILT.test(String(e.text ?? '')),
  );
  if (!erteilung) return nein('keine Erteilung durch Besitzer nach dem Antrag');

  const maxKommentare = nachAntrag.filter(
    (e) => e.ereignis === 'comment' && String(e.wer ?? '').toLowerCase() === 'max' && Math.abs(e._t - erteilung._t) <= 120_000,
  );
  const sagtErteilt = /Freigabe entschieden/i.test(String(erteilung.text ?? '')) || maxKommentare.some((e) => ERTEILT_WORT.test(String(e.text ?? '')));
  const sagtNein = maxKommentare.some((e) => ABGELEHNT_WORT.test(String(e.text ?? '')));
  if (!sagtErteilt || sagtNein) return nein('Besitzer\' Statuswechsel nennt keine Freigabe');

  const widerruf = verlauf.find(
    (e) => e._t > erteilung._t && String(e.wer ?? '').toLowerCase() === 'max' && WIDERRUF.test(String(e.text ?? '')),
  );
  if (widerruf) return nein('Besitzer hat die Freigabe danach zurückgenommen');

  if (jetzt - erteilung._t > maxTage * TAG_MS) return nein(`Freigabe älter als ${maxTage} Tage`);
  return { erteilt: true, summe, von: 'max', ts: erteilung.ts, grund: 'Freigabe erteilt' };
}

/**
 * Ist der Vorgang in Ginnys Besitz? `vorgang` ist `itsm.vorgang`, `uebernahmen` die Antwort von `agenten.uebernahmen`
 * (`pachten`: lebende und verfallene Übernahmen). Besitz heißt: Zuständiger ist der Agent, und keine nicht verfallene
 * Übernahme eines anderen Agenten liegt darauf. Unlesbar (`uebernahmen` fehlt) heißt nein.
 */
export function besitzPruefen(vorgang, uebernahmen, agent = 'persona') {
  if (!istObjekt(vorgang) || !istObjekt(uebernahmen) || !Array.isArray(uebernahmen.pachten)) return false;
  const ich = String(agent).toLowerCase();
  if (String(vorgang.zustaendig ?? '').toLowerCase() !== ich) return false;
  const id = String(vorgang.id ?? '');
  const fremd = uebernahmen.pachten.some(
    (p) => istObjekt(p) && String(p.id ?? '') === id && String(p.wer ?? '').toLowerCase() !== ich && !p.verfallen,
  );
  return !fremd;
}

/**
 * Die Entscheidung für einen Vorgang: Schreibzug oder Lesezug? Rein; die Grenzen (Tag, Abstand, Rückfall) prüft
 * `schreibGrenze` getrennt, weil sie vom Zustand abhängen und nicht von den Daten des Vorgangs.
 *
 * `stufe`: die Einstufung aus `denken.liegt` (Titel). `einstufung`: `schleifen.einstufen` über Titel und Beschreibung,
 * `null`, wenn nicht lesbar (dann kein Klein-Pfad).
 */
export function schreibEignung({ vorgang, stufe = null, einstufung = null, besitz = false, k, jetzt = Date.now() } = {}) {
  const lesen = (warum) => ({ art: 'lesen', pfad: null, warum });
  if (!istObjekt(vorgang)) return lesen('Vorgang nicht lesbar');
  if (besitz !== true) return lesen('nicht in Ginnys Besitz');
  const text = `${vorgang.titel ?? ''}\n${vorgang.beschreibung ?? ''}`;
  const zerstoerend = istZerstoerend(text);

  const frei = freigabePruefen(vorgang, { jetzt, maxTage: k?.schreiben_klein_freigabe_max_tage ?? 30 });
  if (frei.erteilt) {
    if (zerstoerend && k?.schreiben_klein_zerstoerend_mit_freigabe === false) {
      return lesen('enthält Zerstörendes (Konfiguration erlaubt es auch mit Freigabe nicht)');
    }
    return { art: 'schreiben', pfad: 'freigabe', summe: frei.summe, zerstoerend, warum: `Freigabe erteilt (Prüfsumme ${frei.summe})` };
  }

  if (zerstoerend) return lesen('enthält Zerstörendes ohne erteilte Freigabe');
  if (stufe !== 'klein') return lesen(`Einstufung ${stufe ?? 'unbekannt'}, keine Freigabe (${frei.grund})`);
  if (einstufung !== 'klein') return lesen(`Einstufung des Textes ${einstufung ?? 'nicht lesbar'}, keine Freigabe (${frei.grund})`);
  return { art: 'schreiben', pfad: 'klein', summe: null, zerstoerend: false, warum: 'Einstufung klein' };
}

/**
 * Greift eine Grenze für einen weiteren Schreibzug? `s` ist `z.schreiben` der Arbeitsschleife
 * (`zuege` Startzeiten, `letzter_ende`, `vorhaben` {Prüfsumme: Zahl}, `rueckfall_bis`). Liefert `null` (frei) oder
 * `{ code, warum }`; `code` ist `rueckfall`, `tagesgrenze`, `abstand` oder `je_vorhaben`.
 */
export function schreibGrenze(s, k, { jetzt = Date.now(), summe = null } = {}) {
  const z = istObjekt(s) ? s : {};
  if (Number(z.rueckfall_bis ?? 0) > jetzt) {
    return { code: 'rueckfall', warum: `Rückfall auf lesen bis ${new Date(Number(z.rueckfall_bis)).toISOString()} (${z.rueckfall_grund ?? 'Fehlschlag'})` };
  }
  const heute = (Array.isArray(z.zuege) ? z.zuege : []).filter((t) => jetzt - Number(t) < TAG_MS).length;
  if (heute >= k.schreiben_klein_max_je_tag) {
    return { code: 'tagesgrenze', warum: `Schreibzug-Tagesgrenze erreicht (${heute}/${k.schreiben_klein_max_je_tag})` };
  }
  const seit = jetzt - Number(z.letzter_ende ?? 0);
  if (Number(z.letzter_ende ?? 0) > 0 && seit < k.schreiben_klein_abstand_min * 60_000) {
    return { code: 'abstand', warum: `Mindestabstand zwischen Schreibzügen (${k.schreiben_klein_abstand_min} min)` };
  }
  if (summe && Number(z.vorhaben?.[summe] ?? 0) >= k.schreiben_klein_je_vorhaben) {
    return { code: 'je_vorhaben', warum: `Vorhaben ${summe} hatte schon ${z.vorhaben[summe]} Schreibzüge` };
  }
  return null;
}

/** Der Zusatz im Auftragstext eines Schreibzugs (Stufe `schreiben_klein`). Titel und Vorgangsdaten bleiben Daten. */
export function schreibAuftrag({ pfad, summe }) {
  const grund =
    pfad === 'freigabe'
      ? `Für diesen Vorgang liegt eine erteilte, gebundene Freigabe von Besitzer vor (Prüfsumme ${summe}). Führe genau das freigegebene ` +
        'Vorhaben aus, wie es im Freigabe-Antrag (Vorhaben, Wirkung, Ziel, Rückweg) steht, und nichts darüber hinaus. Weicht die ' +
        'Lage davon ab oder brauchst du mehr, schreib das in die Notiz und frag Besitzer, statt es zu tun.'
      : 'Der Vorgang ist als klein eingestuft und enthält nichts Zerstörendes. Du darfst die kleine, umkehrbare Änderung ausführen, ' +
        'prüfen und belegen. Wird es größer als gedacht oder zerstörend, brich ab, notiere es und frag Besitzer.';
  return (
    `Stufe schreiben_klein (Schreibzug, Pfad ${pfad === 'freigabe' ? 'Freigabe' : 'klein'}): ${grund} ` +
    'Ablauf: zuerst agenten.uebernehmen (wer persona) für diesen Vorgang; dann umsetzen; auf main nur über deinen Zweig ' +
    '(persona/<thema>-<datum>) und scripts/ops/nach_main.py, nie direkt, nie ausrollen. Zerstörende Shell- oder Hub-Aufrufe nur mit ' +
    'freigabe_bitten (die Wache bleibt an). Schließe mit einer Notiz am Vorgang (itsm.notiz): was geändert wurde, Beleg, Rückweg. ' +
    'Setze den Vorgang nie auf closed; resolved nur, wenn die Wirkung belegt ist. Schweigen ist kein Ja.'
  );
}
