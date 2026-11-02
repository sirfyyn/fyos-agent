/**
 * Tests der Stufe `schreiben_klein` der Arbeitsschleife (Besitzer, 26.10.2026): die reinen Regeln (erteilte gebundene
 * Freigabe, Besitz, Eignung, Grenzen), die Konfiguration und der Ablauf in der Schleife (Auswahl, Ablehnung ohne Freigabe,
 * Zerstörendes bleibt Lesen, Tageslimit, Mindestabstand, Rückfall, Neustart, frische Prüfung vor dem Start) mit
 * Attrappen-Hub, dazu ein Durchlauf mit echtem Eingang und Faux-Modell. Kein Netz.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { Arbeitsschleife, arbeitKonfig, lageVon, zugText } from '../src/arbeitsschleife.js';
import { besitzPruefen, freigabePruefen, istZerstoerend, schreibEignung, schreibGrenze } from '../src/arbeit-schreiben.js';
import { konfigurationLaden } from '../src/config.js';
import { Ingress } from '../src/ingress.js';
import { istKleinLesend } from '../src/kleines-tor.js';
import { Runner } from '../src/runner.js';
import { wachenLesen } from '../src/wachen-zustand.js';

const tmp = mkdtempSync(join(tmpdir(), 'arbeit-schreiben-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const MIN = 60_000;
const STD = 60 * MIN;
const T0 = Date.UTC(2026, 9, 26, 10, 0, 0);
const SUMME = '647dc9189535';
const KOPF = `## Freigabe angefragt (Prüfsumme ${SUMME})\n**Vorhaben:** Die zwei veralteten Authentik-Objekte entfernen.\n**Wirkung:** nur diese.`;

/** Ein Vorgang mit erteilter Freigabe, so wie `itsm.vorgang` CHG-3558 liefert (Verlauf neueste zuerst). */
function chg(extra = {}) {
  return {
    id: 'CHG-3558',
    titel: 'Veralteten Authentik-Zugang hello-test entfernen',
    status: 'in_progress',
    zustaendig: 'persona',
    beschreibung: `${KOPF}\n\n---\n## Befund\n...`,
    verlauf: [
      { ts: '2026-10-25T14:49:14.723782+00:00', ereignis: 'comment', wer: 'persona', text: 'Befund (25.10.): Freigabe erteilt, Ausführung steht aus.' },
      { ts: '2026-10-21T06:07:49.733440+00:00', ereignis: 'freigabe-aufloesung-fehlt', wer: 'api', text: 'Beschluss in_progress, aber Sicht NICHT fortgeschrieben' },
      { ts: '2026-10-21T06:07:36.212078+00:00', ereignis: 'comment', wer: 'max', text: 'Per App erlaubt (ein Dienst; Status waiting_approval → in_progress).' },
      {
        ts: '2026-10-21T06:07:36.165066+00:00',
        ereignis: 'updated',
        wer: 'max',
        text: 'status waiting_approval→in_progress; waiting_for entfaellt (Freigabe entschieden); Freigabe-Sicht aufgeraeumt',
      },
      { ts: '2026-10-21T06:06:43.959413+00:00', ereignis: 'comment', wer: 'persona', text: `${KOPF}\n...` },
      { ts: '2026-10-21T06:06:43.941976+00:00', ereignis: 'updated', wer: 'persona', text: 'status in_progress→waiting_approval; description geändert' },
    ],
    ...extra,
  };
}

const klein = (id, extra = {}) => ({ id, titel: `Titel ${id}`, status: 'in_progress', zustaendig: 'persona', beschreibung: 'Eine Kleinigkeit.', verlauf: [], ...extra });
const JETZT = Date.UTC(2026, 9, 26, 10, 0, 0);
const K = arbeitKonfig({ stufe: 'schreiben_klein' });

// --- Konfiguration ------------------------------------------------------------------------------

test('arbeitKonfig: schreiben_klein ist eine gültige Stufe, Vorgabe bleibt lesen, Unsinn fällt auf lesen, die Grenzen haben Vorgaben', () => {
  assert.equal(arbeitKonfig(undefined).stufe, 'lesen');
  assert.equal(arbeitKonfig({ stufe: 'schreiben_klein' }).stufe, 'schreiben_klein');
  assert.equal(arbeitKonfig({ stufe: 'schreiben' }).stufe, 'schreiben');
  assert.equal(arbeitKonfig({ stufe: 'schreiben-klein' }).stufe, 'lesen');
  assert.equal(arbeitKonfig({ stufe: 'SCHREIBEN_KLEIN' }).stufe, 'lesen');
  const v = arbeitKonfig({});
  assert.equal(v.schreiben_klein_max_je_tag, 5);
  assert.equal(v.schreiben_klein_abstand_min, 90);
  assert.equal(v.schreiben_klein_rueckfall_h, 24);
  assert.equal(v.schreiben_klein_je_vorhaben, 2);
  assert.equal(v.schreiben_klein_freigabe_max_tage, 30);
  assert.equal(v.schreiben_klein_zerstoerend_mit_freigabe, true);
  const k = arbeitKonfig({ schreiben_klein_max_je_tag: 2, schreiben_klein_zerstoerend_mit_freigabe: 'nein', schreiben_klein_abstand_min: 'viel' });
  assert.equal(k.schreiben_klein_max_je_tag, 2);
  assert.equal(k.schreiben_klein_zerstoerend_mit_freigabe, false);
  assert.equal(k.schreiben_klein_abstand_min, 90, 'Unsinn fällt auf die Vorgabe');
  assert.equal(arbeitKonfig({ schreiben_klein_max_je_tag: -3 }).schreiben_klein_max_je_tag, 0);
});

test('konfigurationLaden: die Stufe schreiben_klein kommt aus der Datei, die Vorgabe bleibt lesen', () => {
  const basis = { arbeitsbereiche: { standard: { pfad: tmp, titel: 'T' } } };
  assert.equal(konfigurationLaden(basis, {}).pi_durable.arbeitsschleife.stufe, 'lesen');
  const a = konfigurationLaden({ ...basis, pi_durable: { arbeitsschleife: { stufe: 'schreiben_klein', schreiben_klein_max_je_tag: 3 } } }, {}).pi_durable.arbeitsschleife;
  assert.equal(a.stufe, 'schreiben_klein');
  assert.equal(a.schreiben_klein_max_je_tag, 3);
  assert.equal(a.schreiben_klein_abstand_min, 90);
  assert.equal(konfigurationLaden({ ...basis, pi_durable: { arbeitsschleife: { stufe: 'wild' } } }, {}).pi_durable.arbeitsschleife.stufe, 'lesen');
});

// --- reine Regeln -------------------------------------------------------------------------------

test('freigabePruefen: die echte Form von CHG-3558 gilt als erteilt, gebunden an die Prüfsumme', () => {
  const r = freigabePruefen(chg(), { jetzt: JETZT });
  assert.equal(r.erteilt, true);
  assert.equal(r.summe, SUMME);
  assert.equal(r.von, 'max');
});

test('freigabePruefen: ohne Erteilung, von anderen erteilt, gebrochene Bindung, zurückgenommen, abgelaufen oder erneut beantragt gilt nichts', () => {
  const ohne = (f) => freigabePruefen(f, { jetzt: JETZT }).erteilt;
  // Status: wartet noch
  assert.equal(ohne(chg({ status: 'waiting_approval' })), false);
  // Keine Erteilung im Verlauf
  const v = chg().verlauf;
  assert.equal(ohne(chg({ verlauf: v.filter((e) => e.wer !== 'max') })), false);
  // „Erteilt“ von Persona, der API oder Claude zählt nicht
  for (const wer of ['persona', 'api', 'claude', 'codex']) {
    assert.equal(ohne(chg({ verlauf: v.map((e) => (e.wer === 'max' ? { ...e, wer } : e)) })), false, `von ${wer}`);
  }
  // Der Statuswechsel steht vor dem Antrag
  assert.equal(ohne(chg({ verlauf: v.map((e) => (e.wer === 'max' ? { ...e, ts: '2026-10-20T00:00:00+00:00' } : e)) })), false);
  // Statuswechsel von Besitzer ohne Freigabe-Vermerk und ohne Kommentar
  assert.equal(
    ohne(chg({ verlauf: v.filter((e) => !(e.wer === 'max' && e.ereignis === 'comment')).map((e) => (e.wer === 'max' ? { ...e, text: 'status waiting_approval→in_progress' } : e)) })),
    false,
  );
  // Ein Kommentar von Besitzer daneben sagt Nein
  assert.equal(ohne(chg({ verlauf: v.map((e) => (e.wer === 'max' && e.ereignis === 'comment' ? { ...e, text: 'Abgelehnt, bitte nicht.' } : e)) })), false);
  // Kopf fehlt oder andere Prüfsumme in der Beschreibung (Vorhaben nachträglich geändert)
  assert.equal(ohne(chg({ beschreibung: 'Ohne Kopf' })), false);
  assert.equal(ohne(chg({ beschreibung: KOPF.replace(SUMME, 'abcdef012345') })), false);
  // Neuer Antrag nach der Erteilung
  const neu = [{ ts: '2026-10-25T10:00:00+00:00', ereignis: 'comment', wer: 'persona', text: KOPF.replace(SUMME, 'abcdef012345') }, ...v];
  assert.equal(ohne(chg({ verlauf: neu })), false);
  // Besitzer nimmt zurück
  const zurueck = [{ ts: '2026-10-22T10:00:00+00:00', ereignis: 'comment', wer: 'max', text: 'Bitte nicht ausführen, ich habe es mir anders überlegt (Widerruf).' }, ...v];
  assert.equal(ohne(chg({ verlauf: zurueck })), false);
  // Zu alt
  assert.equal(freigabePruefen(chg(), { jetzt: Date.UTC(2026, 11, 31), maxTage: 30 }).erteilt, false);
  assert.equal(freigabePruefen(chg(), { jetzt: Date.UTC(2026, 9, 26), maxTage: 30 }).erteilt, true);
  // Müll
  assert.equal(ohne(null), false);
  assert.equal(ohne({ status: 'in_progress', beschreibung: KOPF, verlauf: 'x' }), false);
});

test('besitzPruefen: Zuständiger ist Persona und keine lebende fremde Übernahme; unlesbar heißt nein', () => {
  const ok = { pachten: [], alt_ohne_pacht: [] };
  assert.equal(besitzPruefen(klein('INC-1'), ok), true);
  assert.equal(besitzPruefen(klein('INC-1', { zustaendig: 'claude' }), ok), false);
  assert.equal(besitzPruefen(klein('INC-1', { zustaendig: null }), ok), false);
  assert.equal(besitzPruefen(klein('INC-1'), { pachten: [{ id: 'INC-1', wer: 'claude', verfallen: false }] }), false);
  assert.equal(besitzPruefen(klein('INC-1'), { pachten: [{ id: 'INC-1', wer: 'claude', verfallen: true }] }), true, 'verfallene Übernahme zählt nicht');
  assert.equal(besitzPruefen(klein('INC-1'), { pachten: [{ id: 'INC-1', wer: 'persona', verfallen: false }] }), true);
  assert.equal(besitzPruefen(klein('INC-1'), { pachten: [{ id: 'INC-2', wer: 'claude', verfallen: false }] }), true);
  assert.equal(besitzPruefen(klein('INC-1'), null), false);
  assert.equal(besitzPruefen(klein('INC-1'), {}), false);
});

test('schreibEignung: Freigabe oder klein; ohne beides, mit Zerstörendem oder ohne Besitz bleibt es Lesen', () => {
  const e = (o) => schreibEignung({ k: K, jetzt: JETZT, besitz: true, ...o });
  // Freigabe: auch ein schwerer, zerstörender Vorgang (das Vorhaben ist ausdrücklich erlaubt)
  const f = e({ vorgang: chg(), stufe: 'schwer', einstufung: 'schwer' });
  assert.equal(f.art, 'schreiben');
  assert.equal(f.pfad, 'freigabe');
  assert.equal(f.summe, SUMME);
  assert.equal(f.zerstoerend, true);
  // … es sei denn, die Konfiguration verbietet Zerstörendes auch mit Freigabe
  const streng = arbeitKonfig({ stufe: 'schreiben_klein', schreiben_klein_zerstoerend_mit_freigabe: false });
  assert.equal(schreibEignung({ vorgang: chg(), stufe: 'schwer', besitz: true, k: streng, jetzt: JETZT }).art, 'lesen');
  // klein
  const kl = e({ vorgang: klein('INC-1'), stufe: 'klein', einstufung: 'klein' });
  assert.equal(kl.art, 'schreiben');
  assert.equal(kl.pfad, 'klein');
  // keine Freigabe und schwer: Lesen
  assert.equal(e({ vorgang: klein('INC-1'), stufe: 'schwer', einstufung: 'klein' }).art, 'lesen');
  assert.equal(e({ vorgang: klein('INC-1'), stufe: 'klein', einstufung: 'schwer' }).art, 'lesen');
  assert.equal(e({ vorgang: klein('INC-1'), stufe: 'klein', einstufung: null }).art, 'lesen', 'Einstufung nicht lesbar');
  assert.equal(e({ vorgang: chg({ status: 'new' }), stufe: 'schwer', einstufung: 'schwer' }).art, 'lesen');
  // Zerstörendes ohne Freigabe: Lesen, auch wenn alles klein heißt
  const z = e({ vorgang: klein('INC-1', { beschreibung: 'Bitte den Ordner /srv/tmp/alt löschen.' }), stufe: 'klein', einstufung: 'klein' });
  assert.equal(z.art, 'lesen');
  assert.match(z.warum, /Zerstörendes/);
  // kein Besitz
  assert.equal(e({ vorgang: klein('INC-1'), stufe: 'klein', einstufung: 'klein', besitz: false }).art, 'lesen');
  assert.equal(e({ vorgang: chg(), stufe: 'schwer', besitz: false }).art, 'lesen');
  assert.equal(e({ vorgang: null }).art, 'lesen');
});

test('istZerstoerend: Löschen, Entfernen, Force-Push, Neustart und Verwandtes zählen; Gewöhnliches nicht', () => {
  for (const t of ['Ordner löschen', 'Zugang entfernen', 'kubectl delete pod x', 'rm -rf /srv/x', 'git push --force', 'Node reboot', 'Dienst neu starten', 'zpool destroy', 'DROP TABLE a', 'Konfiguration überschreiben']) {
    assert.equal(istZerstoerend(t), true, t);
  }
  for (const t of ['Tippfehler im Text korrigieren', 'Guardian-URL anpassen', 'Mail-Mapping ergänzen', 'Lösung beschreiben', 'Aufbau der Doku']) {
    assert.equal(istZerstoerend(t), false, t);
  }
});

test('schreibGrenze: Rückfall, Tagesgrenze, Mindestabstand und Grenze je Vorhaben', () => {
  const k = arbeitKonfig({ stufe: 'schreiben_klein', schreiben_klein_max_je_tag: 2, schreiben_klein_abstand_min: 60, schreiben_klein_je_vorhaben: 1 });
  assert.equal(schreibGrenze({}, k, { jetzt: JETZT }), null);
  assert.equal(schreibGrenze(undefined, k, { jetzt: JETZT }), null);
  assert.equal(schreibGrenze({ zuege: [JETZT - 3 * STD, JETZT - 4 * STD] }, k, { jetzt: JETZT }).code, 'tagesgrenze');
  assert.equal(schreibGrenze({ zuege: [JETZT - 25 * STD, JETZT - 26 * STD] }, k, { jetzt: JETZT }), null, 'älter als ein Tag zählt nicht');
  assert.equal(schreibGrenze({ zuege: [JETZT - 40 * MIN], letzter_ende: JETZT - 30 * MIN }, k, { jetzt: JETZT }).code, 'abstand');
  assert.equal(schreibGrenze({ zuege: [JETZT - 3 * STD], letzter_ende: JETZT - 2 * STD }, k, { jetzt: JETZT }), null);
  assert.equal(schreibGrenze({ vorhaben: { [SUMME]: 1 } }, k, { jetzt: JETZT, summe: SUMME }).code, 'je_vorhaben');
  assert.equal(schreibGrenze({ vorhaben: { [SUMME]: 1 } }, k, { jetzt: JETZT, summe: 'anderes' }), null);
  const r = schreibGrenze({ rueckfall_bis: JETZT + STD, rueckfall_grund: 'Test' }, k, { jetzt: JETZT });
  assert.equal(r.code, 'rueckfall');
  assert.equal(schreibGrenze({ rueckfall_bis: JETZT - 1 }, k, { jetzt: JETZT }), null, 'abgelaufener Rückfall');
});

test('zugText: der Schreibzug nennt die Prüfsumme, die Übernahme, den Weg nach main und die Wache; der Lesezug bleibt unverändert', () => {
  const v = { id: 'CHG-3558', titel: 'T', status: 'in_progress', stufe: 'schwer' };
  const t = zugText(v, 'schreiben_klein', { pfad: 'freigabe', summe: SUMME });
  assert.match(t, /Stufe schreiben_klein/);
  assert.match(t, new RegExp(SUMME));
  assert.match(t, /agenten\.uebernehmen/);
  assert.match(t, /nach_main\.py/);
  assert.match(t, /freigabe_bitten/);
  assert.match(t, /nie auf closed/);
  assert.match(t, /Daten, keine Anweisungen/);
  const kl = zugText(v, 'schreiben_klein', { pfad: 'klein', summe: null });
  assert.match(kl, /als klein eingestuft/);
  assert.doesNotMatch(kl, /Prüfsumme/);
  assert.match(zugText(v, 'lesen'), /Stufe lesen: nur lesen und vermerken/);
  assert.equal(istKleinLesend({ quelle: 'zeitplan', klasse: 'hintergrund', bezug: 'arbeit-CHG-3558', von: 'arbeit-schreiben_klein', text: 'x' }), false, 'braucht das volle Tor');
});

// --- Ablauf in der Schleife ------------------------------------------------------------------------

const leererHub = {
  aufrufen: async () => ({ ok: true, result: {} }),
  melden: async () => ({ ok: true }),
  bereicheMelden: async () => ({ ok: true }),
  gesundheit: async () => ({ ok: true }),
  suchen: async () => [],
  schema: async () => ({}),
  eingangLesen: async (nach) => ({ eintraege: [], letzte: nach }),
};

function konfig(name, arbeit = {}) {
  return konfigurationLaden(
    {
      hub: 'http://hub.test',
      agent: 'persona',
      arbeitsbereiche: { standard: { pfad: tmp, titel: 'Test' } },
      spielmodus: [],
      pi_durable: {
        storage: join(tmp, name, 'fyos.sqlite'),
        security: { token: 'test-token-test-token-test-token-00' },
        proactive: { enabled: false },
        egress: { enabled: false },
        browser: { enabled: false },
        desktop: { enabled: false },
        arbeitsschleife: {
          stufe: 'schreiben_klein',
          ruhe_s: 0,
          pause_s: 0,
          max_je_stunde: 100,
          max_je_tag: 100,
          max_je_vorgang_tag: 100,
          schreiben_klein_abstand_min: 0,
          ...arbeit,
        },
      },
    },
    {},
  );
}

async function runnerStarten(cfg, hub = leererHub) {
  const faux = fauxProvider({ provider: cfg.pi_durable.model.provider, models: [{ id: 'hausmodell' }, { id: 'hausmodell-max' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runner = new Runner(cfg, { models, hub });
  await runner.start();
  return { runner, faux };
}

const eintrag = (id, extra = {}) => ({
  id,
  titel: `Titel ${id}`,
  grund: 'persona',
  stufe: 'klein',
  wer: 'persona',
  status: 'in_progress',
  seit: '2026-10-20T10:00:00+00:00',
  liegezeit: '6 Tagen',
  reaktion_text: 'ganz oben ins Tagesvorhaben',
  ...extra,
});

/** Eine Welt aus Attrappen: Liste, Vorgänge, Übernahmen, Einstufung, Uhr, Leerlauf, Aufrufe. */
function welt(liste = [], vorgaenge = {}) {
  const w = {
    t: T0,
    liste,
    vorgaenge,
    notizen: {},
    uebernahmen: { pachten: [], alt_ohne_pacht: [] },
    uebernahmenFehler: null,
    einstufung: () => 'klein',
    vorgangHook: null,
    vorgangAufrufe: 0,
    aufrufe: [],
    eingereiht: [],
    gemeldet: [],
    log: [],
    lageWert: { frei: true, beschaeftigt: false, wartet: false },
    notiz(id) {
      (w.notizen[id] ??= []).push({ ts: `2026-10-26T10:${String(w.notizen[id]?.length ?? 0).padStart(2, '0')}:00+00:00`, ereignis: 'comment', wer: 'persona', text: 'Notiz' });
    },
  };
  w.hub = {
    async aufrufen(werkzeug, argumente) {
      w.aufrufe.push({ werkzeug, argumente });
      if (werkzeug === 'denken.liegt') return { ok: true, result: { liste: w.liste } };
      if (werkzeug === 'itsm.vorgang') {
        w.vorgangAufrufe += 1;
        const basis = w.vorgangHook?.(w.vorgangAufrufe, argumente) ?? w.vorgaenge[argumente.id] ?? klein(argumente.id);
        const verlauf = [...(w.notizen[argumente.id] ?? []).slice().reverse(), ...(basis.verlauf ?? [])];
        return { ok: true, result: { ...basis, verlauf } };
      }
      if (werkzeug === 'agenten.uebernahmen') {
        if (w.uebernahmenFehler) return { ok: false, fehler: w.uebernahmenFehler };
        return { ok: true, result: w.uebernahmen };
      }
      if (werkzeug === 'schleifen.einstufen') return { ok: true, result: { ok: true, stufe: w.einstufung(String(argumente.text)) } };
      return { ok: false, fehler: `unbekannt: ${werkzeug}` };
    },
  };
  w.einreihen = async (e) => {
    if (w.eingereiht.some((x) => x.id === e.id)) return false;
    w.eingereiht.push(e);
    return true;
  };
  w.lage = async () => ({ ...w.lageWert });
  w.jetzt = () => w.t;
  return w;
}

function schleife(runner, cfg, w, extra = {}) {
  return new Arbeitsschleife({
    cfg,
    hub: w.hub,
    harness: runner.harness,
    einreihen: w.einreihen,
    lage: w.lage,
    jetzt: w.jetzt,
    melden: async (m) => w.gemeldet.push(m),
    log: { info: (z) => w.log.push(['info', z]), warn: (z) => w.log.push(['warn', z]) },
    tor: { offen: true },
    lesenTor: { offen: true },
    ...extra,
  });
}

/** Ein ganzer Zug: einreihen, optional Notiz, abschließen. */
async function zug(s, w, { notiz = true } = {}) {
  const r1 = await s.runde();
  assert.equal(r1.art, 'zug läuft', `Zug nicht gestartet: ${r1.art} ${r1.warum}`);
  const e = w.eingereiht.at(-1);
  const id = e.bezug.replace('arbeit-', '');
  if (notiz) w.notiz(id);
  const r2 = await s.runde();
  return { id, e, r2 };
}

const mit = async (name, arbeit, fn) => {
  const cfg = konfig(name, arbeit);
  const { runner } = await runnerStarten(cfg);
  try {
    await fn({ cfg, runner });
  } finally {
    await runner.close().catch(() => {});
  }
};

test('Auswahl: CHG-3558 mit erteilter Freigabe wird ein Schreibzug, ein Kleiner auch, ein Zerstörender nur ein Lesezug; die Journalzeile nennt die Stufe', async () => {
  await mit('auswahl', { mindestabstand_je_vorgang_min: 120 }, async ({ cfg, runner }) => {
    const w = welt(
      [
        eintrag('CHG-3558', { stufe: 'schwer', seit: '2026-10-01T10:00:00+00:00' }),
        eintrag('INC-2', { seit: '2026-10-22T10:00:00+00:00' }),
        eintrag('INC-3', { seit: '2026-10-23T10:00:00+00:00' }),
      ],
      { 'CHG-3558': chg(), 'INC-2': klein('INC-2'), 'INC-3': klein('INC-3', { beschreibung: 'Das alte Verzeichnis löschen.' }) },
    );
    const s = schleife(runner, cfg, w);

    const a = await zug(s, w);
    assert.equal(a.id, 'CHG-3558');
    assert.equal(a.e.von, 'arbeit-schreiben_klein');
    assert.equal(istKleinLesend(a.e), false, 'ein Schreibzug geht nie durch das zweite Tor');
    assert.match(a.e.text, new RegExp(`Prüfsumme ${SUMME}`));
    assert.match(a.e.text, /agenten\.uebernehmen/);
    assert.equal(a.r2.art, 'fertig');
    const info = w.log.filter(([, z]) => /Zug CHG-3558/.test(z)).map(([, z]) => z);
    assert.match(info[0], new RegExp(`Stufe schreiben_klein, Pfad freigabe ${SUMME}`), 'Journalzeile mit Stufe');

    w.t += 5 * MIN;
    const b = await zug(s, w);
    assert.equal(b.id, 'INC-2');
    assert.equal(b.e.von, 'arbeit-schreiben_klein', 'klein und in Ginnys Besitz');
    assert.match(b.e.text, /als klein eingestuft/);

    w.t += 5 * MIN;
    const c = await zug(s, w);
    assert.equal(c.id, 'INC-3');
    assert.equal(c.e.von, 'arbeit-lesen', 'Zerstörendes ohne Freigabe bleibt Lesen');
    assert.equal(istKleinLesend(c.e), true);
    assert.match(c.e.text, /Stufe lesen: nur lesen und vermerken/);
    assert.match(w.log.map(([, z]) => z).find((z) => /Zug INC-3/.test(z)), /Stufe schreiben_klein → lesen/);
    assert.equal(s.zustand().schreiben_klein.zuege_tag, 2);
  });
});

test('Ablehnung ohne Freigabe: ein schwerer Vorgang ohne Erteilung durch Besitzer und ein Vorgang, der Besitzer gehört, bleiben Lesezüge', async () => {
  await mit('ablehnung', {}, async ({ cfg, runner }) => {
    const ohneErteilung = chg({ verlauf: chg().verlauf.filter((e) => e.wer !== 'max') });
    const w = welt([eintrag('CHG-3558', { stufe: 'schwer' })], { 'CHG-3558': ohneErteilung });
    const s = schleife(runner, cfg, w);
    const a = await zug(s, w);
    assert.equal(a.e.von, 'arbeit-lesen');
    assert.equal(s.zustand().schreiben_klein.zuege_tag, 0);

    // Einstufung klein, aber der Vorgang gehört claude (assignee in der Liste persona, im Vorgang nicht): kein Besitz
    const w2 = welt([eintrag('INC-5')], { 'INC-5': klein('INC-5', { zustaendig: 'claude' }) });
    const b = await zug(schleife(runner, cfg, w2), w2);
    assert.equal(b.e.von, 'arbeit-lesen');
  });
});

test('Besitz: eine lebende Übernahme eines anderen Agenten oder ein unlesbares agenten.uebernahmen halten den Schreibzug zurück', async () => {
  await mit('besitz', { mindestabstand_je_vorgang_min: 0 }, async ({ cfg, runner }) => {
    const w = welt([eintrag('INC-1')], { 'INC-1': klein('INC-1') });
    w.uebernahmen = { pachten: [{ id: 'INC-1', wer: 'claude', verfallen: false }], alt_ohne_pacht: [] };
    const s = schleife(runner, cfg, w);
    assert.equal((await zug(s, w)).e.von, 'arbeit-lesen');

    const w2 = welt([eintrag('INC-1')], { 'INC-1': klein('INC-1') });
    w2.uebernahmenFehler = 'Hub meldet: 504';
    assert.equal((await zug(schleife(runner, cfg, w2), w2)).e.von, 'arbeit-lesen', 'nicht belegt heißt kein Schreiben');

    const w3 = welt([eintrag('INC-1')], { 'INC-1': klein('INC-1') });
    w3.uebernahmen = { pachten: [{ id: 'INC-1', wer: 'persona', verfallen: false }], alt_ohne_pacht: [] };
    assert.equal((await zug(schleife(runner, cfg, w3), w3)).e.von, 'arbeit-schreiben_klein');
  });
});

test('Die Einstufung des ganzen Textes zählt: Titel klein, Beschreibung schwer → Lesezug; ohne Hub-Antwort ebenso', async () => {
  await mit('einstufung', { mindestabstand_je_vorgang_min: 0 }, async ({ cfg, runner }) => {
    const w = welt([eintrag('INC-1')], { 'INC-1': klein('INC-1', { beschreibung: 'SCHWERTEXT: Firewall' }) });
    w.einstufung = (text) => (/SCHWERTEXT/.test(text) ? 'schwer' : 'klein');
    assert.equal((await zug(schleife(runner, cfg, w), w)).e.von, 'arbeit-lesen');
    const w2 = welt([eintrag('INC-1')], { 'INC-1': klein('INC-1') });
    const orig = w2.hub.aufrufen;
    w2.hub.aufrufen = async (name, a) => (name === 'schleifen.einstufen' ? { ok: false, fehler: 'weg' } : orig(name, a));
    assert.equal((await zug(schleife(runner, cfg, w2), w2)).e.von, 'arbeit-lesen');
  });
});

test('Tor: der Schreibzug braucht das volle Tor; ist nur das zweite offen, wartet er und der Kandidat läuft nicht als Lesezug', async () => {
  await mit('tor', {}, async ({ cfg, runner }) => {
    const w = welt([eintrag('CHG-3558', { stufe: 'schwer' })], { 'CHG-3558': chg() });
    const s = schleife(runner, cfg, w, { tor: { offen: false, warum: 'Dev-Fenster' }, lesenTor: { offen: true } });
    const r = await s.runde();
    assert.equal(r.art, 'nichts fällig');
    assert.match(r.warum, /CHG-3558 \(schreiben: Tor zu\)/);
    assert.equal(w.eingereiht.length, 0);

    // Beide zu: kein Zug, Grund aus beiden Toren
    const s2 = schleife(runner, cfg, w, { tor: { offen: false, warum: 'Hausmodell belegt' }, lesenTor: { offen: false, warum: 'Ruhezeit' } });
    const r2 = await s2.runde();
    assert.equal(r2.art, 'tor zu');
    assert.match(r2.warum, /Hausmodell belegt/);
    assert.match(r2.warum, /Ruhezeit/);

    // Ein Lesekandidat läuft bei nur offenem zweitem Tor weiter
    const w3 = welt([eintrag('INC-2', { stufe: 'schwer' })], { 'INC-2': klein('INC-2', { zustaendig: 'claude' }) });
    const a = await zug(schleife(runner, cfg, w3, { tor: { offen: false }, lesenTor: { offen: true } }), w3);
    assert.equal(a.e.von, 'arbeit-lesen');

    // Beide offen: Schreibzug
    const w4 = welt([eintrag('CHG-3558', { stufe: 'schwer' })], { 'CHG-3558': chg() });
    assert.equal((await zug(schleife(runner, cfg, w4), w4)).e.von, 'arbeit-schreiben_klein');
  });
});

test('Tageslimit: höchstens N Schreibzüge je Tag, danach wartet der Kandidat und nach einem Tag geht es weiter', async () => {
  await mit('tageslimit', { schreiben_klein_max_je_tag: 2, mindestabstand_je_vorgang_min: 120 }, async ({ cfg, runner }) => {
    const w = welt([eintrag('INC-1', { seit: '2026-10-20T10:00:00+00:00' }), eintrag('INC-2', { seit: '2026-10-21T10:00:00+00:00' }), eintrag('INC-3', { seit: '2026-10-22T10:00:00+00:00' })]);
    const s = schleife(runner, cfg, w);
    for (const id of ['INC-1', 'INC-2']) {
      const a = await zug(s, w);
      assert.equal(a.id, id);
      assert.equal(a.e.von, 'arbeit-schreiben_klein');
      w.t += 5 * MIN;
    }
    const r = await s.runde();
    assert.equal(r.art, 'nichts fällig');
    assert.match(r.warum, /INC-3 \(schreiben: tagesgrenze\)/);
    assert.equal(w.eingereiht.length, 2);
    assert.equal(s.zustand().schreiben_klein.zuege_tag, 2);
    assert.equal(s.zustand().schreiben_klein.grenze_tag, 2);
    w.t += 25 * STD;
    const a = await zug(s, w);
    assert.equal(a.e.von, 'arbeit-schreiben_klein');
    assert.equal(s.zustand().schreiben_klein.zuege_tag, 1);
  });
});

test('Mindestabstand zwischen Schreibzügen, auch wenn der nächste Kandidat bereit wäre', async () => {
  await mit('abstand', { schreiben_klein_abstand_min: 60, mindestabstand_je_vorgang_min: 120 }, async ({ cfg, runner }) => {
    const w = welt([eintrag('INC-1', { seit: '2026-10-20T10:00:00+00:00' }), eintrag('INC-2', { seit: '2026-10-21T10:00:00+00:00' })]);
    const s = schleife(runner, cfg, w);
    await zug(s, w);
    w.t += 10 * MIN;
    const r = await s.runde();
    assert.equal(r.art, 'nichts fällig');
    assert.match(r.warum, /INC-2 \(schreiben: abstand\)/);
    w.t += 61 * MIN;
    assert.equal((await zug(s, w)).id, 'INC-2');
  });
});

test('Grenze je Vorhaben: dieselbe Freigabe trägt nur wenige Schreibzüge, danach bleibt der Vorgang beim Lesen hängen', async () => {
  await mit('vorhaben', { schreiben_klein_je_vorhaben: 1, mindestabstand_je_vorgang_min: 0 }, async ({ cfg, runner }) => {
    const w = welt([eintrag('CHG-3558', { stufe: 'schwer' })], { 'CHG-3558': chg() });
    const s = schleife(runner, cfg, w);
    assert.equal((await zug(s, w)).e.von, 'arbeit-schreiben_klein');
    w.t += 5 * MIN;
    const r = await s.runde();
    assert.equal(r.art, 'nichts fällig');
    assert.match(r.warum, /CHG-3558 \(schreiben: je_vorhaben\)/);
    const gespeichert = (await wachenLesen(runner.harness)).arbeit;
    assert.equal(gespeichert.schreiben.vorhaben[SUMME], 1);
  });
});

test('Rückfall: ein Schreibzug ohne Ergebnis schaltet auf lesen zurück, meldet einmal, überlebt den Neustart und läuft nach der Frist ab', async () => {
  await mit('rueckfall', { schreiben_klein_rueckfall_h: 6, mindestabstand_je_vorgang_min: 120 }, async ({ cfg, runner }) => {
    const w = welt([eintrag('INC-1', { seit: '2026-10-20T10:00:00+00:00' }), eintrag('INC-2', { seit: '2026-10-21T10:00:00+00:00' }), eintrag('INC-3', { seit: '2026-10-22T10:00:00+00:00' })]);
    const s = schleife(runner, cfg, w);
    const a = await zug(s, w, { notiz: false });
    assert.equal(a.e.von, 'arbeit-schreiben_klein');
    assert.equal(a.r2.art, 'rueckfall');
    assert.match(a.r2.warum, /Rückfall auf lesen bis/);
    assert.equal(w.gemeldet.length, 1);
    assert.match(w.gemeldet[0].text, /INC-1/);
    assert.ok(w.log.some(([art, z]) => art === 'warn' && /Rückfall auf lesen/.test(z)));
    const z = s.zustand();
    assert.equal(z.stufe, 'schreiben_klein');
    assert.equal(z.stufe_wirksam, 'lesen');
    assert.equal(z.schreiben_klein.rueckfall_bis, new Date(w.t + 6 * STD).toISOString());

    // Danach nur noch Lesezüge, obwohl INC-2 geeignet wäre
    w.t += 5 * MIN;
    const b = await zug(s, w);
    assert.equal(b.id, 'INC-2');
    assert.equal(b.e.von, 'arbeit-lesen');

    // Neuer Prozess, gleicher Harness: der Rückfall gilt weiter
    const s2 = schleife(runner, cfg, w);
    w.t += 5 * MIN;
    const c = await zug(s2, w);
    assert.equal(c.id, 'INC-3');
    assert.equal(c.e.von, 'arbeit-lesen');
    assert.equal(s2.zustand().stufe_wirksam, 'lesen');

    // Nach der Frist wieder Schreibzüge (INC-1 ist längst aus dem Mindestabstand)
    w.t += 7 * STD;
    assert.equal(s2.zustand().stufe_wirksam, 'schreiben_klein');
    const d = await zug(s2, w);
    assert.equal(d.e.von, 'arbeit-schreiben_klein');
  });
});

test('Ergebnis unbekannt oder nie ausgeliefert löst keinen Rückfall aus; ein Lesezug ohne Ergebnis auch nicht', async () => {
  await mit('keinrueckfall', { zug_frist_min: 30, mindestabstand_je_vorgang_min: 0, erfolglos_max: 10 }, async ({ cfg, runner }) => {
    const w = welt([eintrag('INC-1')], { 'INC-1': klein('INC-1') });
    const s = schleife(runner, cfg, w);
    // nie ausgeliefert
    await s.runde();
    w.lageWert = { frei: false, beschaeftigt: false, wartet: true };
    w.t += 31 * MIN;
    const r = await s.runde();
    assert.equal(r.art, 'fertig');
    assert.match(r.warum, /kein Ergebnis/);
    assert.equal(s.zustand().stufe_wirksam, 'schreiben_klein');
    assert.equal(w.gemeldet.length, 0);

    // Lesezug (nicht in Besitz) ohne Ergebnis
    w.lageWert = { frei: true, beschaeftigt: false, wartet: false };
    w.vorgaenge['INC-1'] = klein('INC-1', { zustaendig: 'claude' });
    w.t += 5 * MIN;
    const a = await zug(s, w, { notiz: false });
    assert.equal(a.e.von, 'arbeit-lesen');
    assert.equal(a.r2.art, 'fertig');
    assert.equal(s.zustand().stufe_wirksam, 'schreiben_klein');
  });
});

test('Frisch vor dem Start: nimmt Besitzer die Freigabe zwischen Auswahl und Start zurück, startet kein Schreibzug', async () => {
  await mit('frisch', {}, async ({ cfg, runner }) => {
    const w = welt([eintrag('CHG-3558', { stufe: 'schwer' })], { 'CHG-3558': chg() });
    const widerruf = { ts: '2026-10-26T09:00:00+00:00', ereignis: 'comment', wer: 'max', text: 'Widerruf: bitte nicht ausführen.' };
    // 1. Aufruf (Auswahl): gültig; ab dem 2. (frische Prüfung vor dem Start): zurückgenommen
    w.vorgangHook = (n, a) => (n >= 2 && a.verlauf === 50 ? chg({ verlauf: [widerruf, ...chg().verlauf] }) : null);
    const s = schleife(runner, cfg, w);
    const r = await s.runde();
    assert.equal(r.art, 'nichts fällig');
    assert.match(r.warum, /Schreibeignung nicht mehr gegeben/);
    assert.equal(w.eingereiht.length, 0);
    assert.equal(s.zustand().schreiben_klein.zuege_tag, 0);
  });
});

test('Stufe lesen bleibt Lesen: keine Zusatzaufrufe, auch nicht für einen freigegebenen Vorgang; Stufe schreiben unverändert', async () => {
  await mit('lesen', { stufe: 'lesen' }, async ({ cfg, runner }) => {
    const w = welt([eintrag('CHG-3558', { stufe: 'schwer' })], { 'CHG-3558': chg() });
    const a = await zug(schleife(runner, cfg, w), w);
    assert.equal(a.e.von, 'arbeit-lesen');
    assert.deepEqual([...new Set(w.aufrufe.map((x) => x.werkzeug))].sort(), ['denken.liegt', 'itsm.vorgang']);
    assert.ok(w.aufrufe.filter((x) => x.werkzeug === 'itsm.vorgang').every((x) => x.argumente.verlauf === undefined));
    const s = schleife(runner, cfg, w);
    assert.equal(s.zustand().stufe_wirksam, 'lesen');
    assert.equal(s.zustand().schreiben_klein, null);
  });
  await mit('schreiben', { stufe: 'schreiben' }, async ({ cfg, runner }) => {
    const w = welt([eintrag('INC-1')], { 'INC-1': klein('INC-1', { zustaendig: 'claude' }) });
    const a = await zug(schleife(runner, cfg, w), w);
    assert.equal(a.e.von, 'arbeit-schreiben', 'die volle Stufe wählt nicht nach Eignung');
    assert.equal(w.aufrufe.some((x) => x.werkzeug === 'agenten.uebernahmen'), false);
  });
});

test('Ruhe-Schalter und Spielmodus gelten auch für die Stufe schreiben_klein', async () => {
  await mit('ruhe', {}, async ({ cfg, runner }) => {
    const w = welt([eintrag('CHG-3558', { stufe: 'schwer' })], { 'CHG-3558': chg() });
    const r = await schleife(runner, cfg, w, { spielmodus: { grund: () => 'ruhe:Besitzer schläft' } }).runde();
    assert.equal(r.art, 'spielmodus');
    assert.equal(w.eingereiht.length, 0);
    assert.equal(w.aufrufe.length, 0);
  });
});

// --- mit echtem Eingang und Faux-Modell ---------------------------------------------------------

test('Durchlauf mit Faux-Modell: der Schreibzug geht nur durch das offene volle Tor, der Lesezug auch durch das zweite', async () => {
  const cfg = konfig('echt', { ruhe_s: 0.3, pause_s: 0, mindestabstand_je_vorgang_min: 120 });
  const w = welt(
    [eintrag('CHG-3558', { stufe: 'schwer', seit: '2026-10-01T10:00:00+00:00' }), eintrag('INC-3', { seit: '2026-10-23T10:00:00+00:00' })],
    { 'CHG-3558': chg(), 'INC-3': klein('INC-3', { beschreibung: 'Datei löschen.' }) },
  );
  w.jetzt = () => Date.now();
  const gesehen = [];
  const hubVoll = { ...leererHub, aufrufen: w.hub.aufrufen };
  const { runner, faux } = await runnerStarten(cfg, hubVoll);
  faux.setResponses(
    Array.from({ length: 4 }, () => (context) => {
      const letzte = [...context.messages].reverse().find((m) => m.role === 'user');
      const text = JSON.stringify(letzte?.content ?? '');
      gesehen.push(text);
      const m = /Vorgang ((?:INC|PRB|CHG)-\d+)/.exec(text);
      if (m) w.notiz(m[1]);
      return fauxAssistantMessage('ok');
    }),
  );
  const tor = { offen: true };
  const lesenTor = { offen: true };
  const hubIngress = { ...hubVoll, eingangLesen: async (nach) => { await new Promise((r) => setTimeout(r, 200)); return { eintraege: [], letzte: nach }; } };
  const ingress = new Ingress({ cfg: { ...cfg, pi_durable: { ...cfg.pi_durable, proactive: { enabled: true, pollSeconds: 3 } } }, runner, hub: hubIngress, spielmodus: runner.spielmodus, tor });
  ingress.kleinesTor = (e) => istKleinLesend(e) && lesenTor.offen;
  const s = new Arbeitsschleife({
    cfg,
    hub: w.hub,
    harness: runner.harness,
    einreihen: (e) => ingress.einreihen(e),
    lage: lageVon({ runner, ingress }),
    tor,
    lesenTor,
    log: { info: () => {}, warn: () => {} },
  });
  try {
    await ingress.start();
    const ende = Date.now() + 40_000;
    const reihenfolge = [];
    while (Date.now() < ende) {
      const r = await s.runde();
      if (r.art === 'zug läuft' && s.zustand().laeuft && !reihenfolge.includes(s.zustand().laeuft.vorgang)) reihenfolge.push(s.zustand().laeuft.vorgang);
      if (r.art === 'nichts fällig') break;
      await new Promise((res) => setTimeout(res, Math.min(r.warte_ms ?? 200, 300)));
    }
    assert.deepEqual(reihenfolge, ['CHG-3558', 'INC-3']);
    assert.equal(gesehen.length, 2);
    assert.match(gesehen[0], /Stufe schreiben_klein/);
    assert.match(gesehen[0], /arbeit-CHG-3558/);
    assert.match(gesehen[1], /Stufe lesen: nur lesen und vermerken/);
    assert.equal(s.zustand().zuege_tag, 2);
    assert.equal(s.zustand().schreiben_klein.zuege_tag, 1);
    assert.equal(s.zustand().ohne_ergebnis, 0);
  } finally {
    await ingress.stop();
    await runner.close().catch(() => {});
  }
});

test('Durchlauf mit Faux-Modell: bei geschlossenem vollen Tor liefert der Eingang einen Schreibzug nicht aus', async () => {
  const cfg = konfig('echt-zu');
  const { runner } = await runnerStarten(cfg);
  const ingress = new Ingress({ cfg, runner, hub: leererHub, spielmodus: runner.spielmodus, tor: { offen: false } });
  ingress.kleinesTor = (e) => istKleinLesend(e) && true;
  try {
    await ingress.einreihen({ id: 'a1', text: 'x', quelle: 'zeitplan', von: 'arbeit-schreiben_klein', bezug: 'arbeit-CHG-3558' });
    await ingress.einreihen({ id: 'a2', text: 'y', quelle: 'zeitplan', von: 'arbeit-lesen', bezug: 'arbeit-INC-2' });
    const { Wartend } = await import('../src/documents.js');
    const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
    const wartend = await runner.harness.snapshot(Wartend, BACKGROUND_CONTEXT);
    assert.equal(ingress.naechster(wartend).stromId, 'a2', 'nur der lesende Zug passt durchs zweite Tor');
  } finally {
    await runner.close().catch(() => {});
  }
});
