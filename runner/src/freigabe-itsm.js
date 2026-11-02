/**
 * freigabe-itsm.js — ITSM-Freigaben erreichen Besitzer auf Matrix, mit denselben Chips (Besitzer 26.10.2026, „ja“ zu „einen Weg für alles“).
 *
 * Anlass: Der ITSM-Fanout zielte auf den früheren Agenten (stillgelegt, „Connection refused“), eine Freigabe am ITSM-Vorgang kam nie bei Besitzer an.
 * Die Wache `freigabe-meldung.js` kennt nur die Freigaben des Runners (Dokument `Freigaben`). Dieses Modul speist die offenen
 * ITSM-Freigaben (Vorgang im Status `waiting_approval`, Eintrag `art: freigabe` in `leitstand.braucht_dich`) in dieselbe Wache ein
 * und beantwortet sie über `leitstand.freigabe` — derselbe Weg wie die FYOS-App, Akteur Besitzer.
 *
 * Kennung in der Wache: `itsm:<Vorgang>` (z. B. `itsm:CHG-5142`); so kollidiert sie nie mit einer Runner-Freigabe.
 * Hohes Risiko oder zerstörend: ✅ verweigert die Wache wie bei Runner-Freigaben (Erlauben nur in der App), ❌ und ⏳ gehen.
 * Fällt der Hub aus, melden die Runner-Freigaben weiter; die ITSM-Seite fehlt dann in dieser Runde (kein Fehler, ein Logeintrag).
 */

const PRAEFIX = 'itsm:';
const RISIKEN = new Set(['low', 'medium', 'high']);
const WORAUF = /^max:\s*freigabe\s*[—–-]\s*/i;

const kurz = (t, n) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** Ein Eintrag aus `leitstand.braucht_dich` → die Form der Freigaben des Runners (Status `offen`). */
export function itsmFreigabe(e) {
  const risiko = RISIKEN.has(e.risiko) ? e.risiko : 'medium';
  const erstellt = Date.parse(e.seit);
  return {
    id: `${PRAEFIX}${e.id}`,
    quelle: 'itsm',
    vorgang: e.id,
    aktion: kurz(String(e.worauf ?? e.worauf_text ?? e.titel ?? '').replace(WORAUF, '') || e.titel, 200),
    risiko,
    zerstoererisch: !!e.zerstoererisch || risiko === 'high',
    kontext: kurz(e.kontext, 600),
    kontextHerkunft: null,
    werkzeug: null,
    befehl: null,
    status: 'offen',
    erstellt: Number.isFinite(erstellt) ? erstellt : Date.now(),
  };
}

/** Nur offene Freigaben am Vorgang: Art `freigabe`, Quelle `itsm`, Status `waiting_approval`. */
export function itsmFreigabenAus(daten) {
  const liste = Array.isArray(daten?.eintraege) ? daten.eintraege : [];
  return liste
    .filter((e) => e && e.art === 'freigabe' && e.quelle === 'itsm' && e.status === 'waiting_approval' && e.id)
    .map(itsmFreigabe);
}

/**
 * Quelle für die Wache: Runner-Freigaben plus ITSM-Freigaben.
 * @param runnerFreigaben async () => Array (Vorgabe der Wache)
 * @param hub Hub-Client (`aufrufen`)
 */
export function freigabenQuelle({ runnerFreigaben, hub, log = () => {} }) {
  let letzterFehler = null;
  // Fällt der Hub einmal aus, bleiben die zuletzt gelesenen ITSM-Freigaben stehen. Sonst löscht die Wache den Meldestand
  // dieser Freigaben und meldet sie nach dem Ausfall noch einmal (gesehen am 26.10.: offen 1 → 0 → neu).
  let zuletzt = [];
  return async () => {
    const eigene = await runnerFreigaben();
    if (!hub?.konfiguriert) return eigene;
    try {
      const a = await hub.aufrufen('leitstand.braucht_dich', {}, { ansicht: 'voll' });
      if (!a.ok) throw new Error(String(a.fehler ?? 'Hub meldet einen Fehler'));
      letzterFehler = null;
      zuletzt = itsmFreigabenAus(a.result);
      return [...eigene, ...zuletzt];
    } catch (fehler) {
      const text = kurz(fehler?.message ?? fehler, 120);
      if (text !== letzterFehler) log(`ITSM-Freigaben nicht lesbar: ${text}`);
      letzterFehler = text;
      return [...eigene, ...zuletzt];
    }
  };
}

/**
 * Entscheidung: `itsm:`-Kennungen gehen an `leitstand.freigabe` (erteilt → erlauben, abgelehnt → ablehnen), alles andere an den Runner.
 */
export function freigabenEntscheiden({ runnerEntscheiden, hub }) {
  return async (id, optionen = {}) => {
    const kennung = String(id ?? '');
    if (!kennung.startsWith(PRAEFIX)) return runnerEntscheiden(id, optionen);
    const vorgang = kennung.slice(PRAEFIX.length);
    const wort = optionen.entscheidung === 'erteilt' ? 'erlauben' : optionen.entscheidung === 'abgelehnt' ? 'ablehnen' : null;
    if (!wort) throw new Error(`Unbekannte Entscheidung: ${optionen.entscheidung}`);
    const begruendung = kurz(optionen.notiz ?? '', 300);
    const a = await hub.aufrufen('leitstand.freigabe', {
      id: vorgang,
      entscheidung: wort,
      expected_status: 'waiting_approval',
      ausfuehren: true, // ohne das ist es nur ein Trockenlauf (leitstand.freigabe)
      ...(begruendung ? { begruendung } : {}),
    });
    if (!a.ok) {
      const text = String(a.fehler ?? 'abgelehnt');
      // Schon anders entschieden (App, ITSM): wie bei Runner-Freigaben als „bereits“ melden, damit der Chip nicht als Fehler zählt.
      throw new Error(/waiting_approval|bereits/i.test(text) ? `bereits entschieden: ${text}` : text);
    }
    return a.result;
  };
}
