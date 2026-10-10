// Meldebudget: hoechstens N proaktive Meldungen pro Tag (Standard 5) und Ruhezeiten
// (Standard 22 bis 7 Uhr). Antworten auf Nachrichten des Besitzers zaehlen nicht.
// Durchgesetzt wird das im Hook `message_sending`, also unter dem Modell: Ein Prompt
// kann die Grenze nicht ueberreden, und es gilt fuer jeden Absender (Werkzeug `message`,
// Automationen, Heartbeat, CLI).
//
// Antwort heisst: In derselben Sitzung kam kurz vorher eine Nachricht von aussen herein
// (`message_received`) oder dort laeuft ein vom Menschen ausgeloester Lauf (`trigger: user`),
// bzw. er endete vor weniger als `antwortFensterMinuten`. Vorgangs-, Automations-,
// Heartbeat-, Subagent- und Hook-Sitzungen sind nie Antworten. Alles andere ist proaktiv.
//
// Fail-closed: Scheitert die Entscheidung bei einer proaktiven Sendung, wird sie gesperrt.
// Eine Antwort wird nie gesperrt. Gespeichert werden nur Zaehler und Entscheidungen, nie Inhalte.

import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';

export const PLUGIN_ID = 'fyos-meldebudget';

export const STANDARD = Object.freeze({
  tagesbudget: 5,
  ruheVon: '22:00',
  ruheBis: '07:00',
  zeitzone: 'Europe/Berlin',
  antwortFensterMinuten: 10,
  buendelMinuten: 5,
});

const KEINE_ANTWORT = /:(?:vorgang-|cron|heartbeat|subagent|hook|automation|isolated)/i;
const PROTOKOLL_MAX = 100;

function minuten(hhmm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm ?? ''));
  if (!m) throw new Error(`Uhrzeit ${hhmm} ist nicht HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function einstellungen(roh = {}) {
  const cfg = {...STANDARD, ...(roh ?? {})};
  if (!Number.isInteger(cfg.tagesbudget) || cfg.tagesbudget < 0) throw new Error('tagesbudget ungueltig');
  minuten(cfg.ruheVon);
  minuten(cfg.ruheBis);
  // Wirft bei einer unbekannten Zeitzone.
  new Intl.DateTimeFormat('de-DE', {timeZone: cfg.zeitzone});
  return cfg;
}

function ortszeit(jetztMs, zeitzone) {
  const teile = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: zeitzone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(jetztMs)).map((t) => [t.type, t.value]));
  return {tag: `${teile.year}-${teile.month}-${teile.day}`, minute: Number(teile.hour) * 60 + Number(teile.minute)};
}

export function tagesschluessel(jetztMs, zeitzone) {
  return ortszeit(jetztMs, zeitzone).tag;
}

export function istRuhezeit(jetztMs, cfg) {
  const {minute} = ortszeit(jetztMs, cfg.zeitzone);
  const von = minuten(cfg.ruheVon);
  const bis = minuten(cfg.ruheBis);
  if (von === bis) return false;
  return von < bis ? minute >= von && minute < bis : minute >= von || minute < bis;
}

export function sitzungsart(sessionKey) {
  if (typeof sessionKey !== 'string' || !sessionKey) return 'ohne';
  if (/^agent:[^:]+:main$/i.test(sessionKey)) return 'main';
  if (/^agent:[^:]+:dashboard:/i.test(sessionKey)) return 'dashboard';
  const m = KEINE_ANTWORT.exec(sessionKey);
  if (m) return m[0].slice(1).replace(/-$/, '').toLowerCase();
  return 'sonstige';
}

export function leererZustand(tag) {
  return {version: 1, tag, gezaehlt: 0, letzteZaehlung: {}, protokoll: []};
}

export function ladeZustand(datei, tag) {
  try {
    const z = JSON.parse(readFileSync(datei, 'utf8'));
    if (z?.version !== 1 || typeof z.gezaehlt !== 'number') return leererZustand(tag);
    if (z.tag !== tag) return {...leererZustand(tag), protokoll: Array.isArray(z.protokoll) ? z.protokoll : []};
    return {...leererZustand(tag), ...z};
  } catch (fehler) {
    if (fehler?.code === 'ENOENT') return leererZustand(tag);
    throw fehler;
  }
}

export function speichereZustand(datei, zustand) {
  const tmp = `${datei}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(zustand), {mode: 0o600});
  renameSync(tmp, datei);
}

// Dringendes: Ein Waechter ohne Modell (ausserhalb dieses Plugins) legt vor einer dringenden Zeile
// `dringend.json` {bis, von} neben den Zustand. Die erste proaktive Sendung einer Automationssitzung bindet die
// Freigabe an sich; diese Sitzung darf dann bis `bis` durch Ruhezeit und Tagesbudget (gezaehlt wird trotzdem).
// Ein Prompt kann keine Freigabe erzeugen: die Datei schreibt nur der Waechter, nie das Modell.
// Hauptsitzung, Dashboard und Vorgangs-Sitzungen nehmen nie eine Freigabe.
export const DRINGEND_DATEI = 'dringend.json';
const DRINGEND_SITZUNGEN = new Set(['sonstige', 'automation', 'isolated', 'cron']);

export function dringendPruefen(datei, sessionKey, jetztMs) {
  let f;
  try {
    f = JSON.parse(readFileSync(datei, 'utf8'));
  } catch {
    return false;
  }
  const bis = Number(f?.bis);
  if (!Number.isFinite(bis) || jetztMs > bis || typeof sessionKey !== 'string' || !sessionKey) return false;
  if (f.sitzung) return f.sitzung === sessionKey;
  if (!DRINGEND_SITZUNGEN.has(sitzungsart(sessionKey))) return false;
  speichereZustand(datei, {...f, sitzung: sessionKey});
  return true;
}

// Reine Entscheidung ohne Ein- und Ausgabe; der Aufrufer zaehlt und speichert.
export function entscheide({jetztMs, sessionKey, antwort, zustand, cfg, dringend = false}) {
  if (antwort) return {aktion: 'durchlassen', grund: 'antwort'};
  if (dringend) return {aktion: 'zaehlen', grund: 'dringend'};
  if (istRuhezeit(jetztMs, cfg)) return {aktion: 'sperren', grund: 'ruhezeit'};
  const letzte = sessionKey ? zustand.letzteZaehlung?.[sessionKey] : undefined;
  if (letzte && jetztMs - letzte < cfg.buendelMinuten * 60_000) return {aktion: 'durchlassen', grund: 'buendel'};
  if (zustand.gezaehlt >= cfg.tagesbudget) return {aktion: 'sperren', grund: 'tagesbudget'};
  return {aktion: 'zaehlen', grund: 'proaktiv'};
}

export function erzeugeBudget({cfg: roh, zustandsdatei, uhr = () => Date.now(), logger = console} = {}) {
  const cfg = einstellungen(roh);
  const laeufe = new Map();        // runId -> sessionKey (vom Menschen ausgeloeste Laeufe)
  const aktiv = new Map();         // sessionKey -> Anzahl laufender Nutzer-Laeufe
  const zuletzt = new Map();       // sessionKey -> letzter Eingang oder letztes Laufende (ms)

  function antwortMoeglich(sessionKey) {
    if (typeof sessionKey !== 'string' || !sessionKey || KEINE_ANTWORT.test(sessionKey)) return false;
    if ((aktiv.get(sessionKey) ?? 0) > 0) return true;
    const t = zuletzt.get(sessionKey);
    return t !== undefined && uhr() - t <= cfg.antwortFensterMinuten * 60_000;
  }

  function protokolliere(zustand, eintrag) {
    zustand.protokoll = [...(zustand.protokoll ?? []), eintrag].slice(-PROTOKOLL_MAX);
  }

  return {
    cfg,
    eingang(sessionKey) {
      if (typeof sessionKey === 'string' && sessionKey && !KEINE_ANTWORT.test(sessionKey)) zuletzt.set(sessionKey, uhr());
    },
    laufBeginn(runId, sessionKey, trigger) {
      if (trigger !== 'user' || !runId || typeof sessionKey !== 'string' || KEINE_ANTWORT.test(sessionKey)) return;
      if (laeufe.has(runId)) return;
      laeufe.set(runId, sessionKey);
      aktiv.set(sessionKey, (aktiv.get(sessionKey) ?? 0) + 1);
      zuletzt.set(sessionKey, uhr());
    },
    laufEnde(runId) {
      const sessionKey = laeufe.get(runId);
      if (!sessionKey) return;
      laeufe.delete(runId);
      aktiv.set(sessionKey, Math.max(0, (aktiv.get(sessionKey) ?? 1) - 1));
      zuletzt.set(sessionKey, uhr());
    },
    senden(sessionKey) {
      const antwort = antwortMoeglich(sessionKey);
      const jetztMs = uhr();
      if (antwort) return {aktion: 'durchlassen', grund: 'antwort'};
      try {
        const tag = tagesschluessel(jetztMs, cfg.zeitzone);
        const zustand = ladeZustand(zustandsdatei, tag);
        const dringend = dringendPruefen(join(dirname(zustandsdatei), DRINGEND_DATEI), sessionKey, jetztMs);
        const ergebnis = entscheide({jetztMs, sessionKey, antwort, zustand, cfg, dringend});
        if (ergebnis.aktion === 'zaehlen') {
          zustand.gezaehlt += 1;
          if (sessionKey) zustand.letzteZaehlung = {...zustand.letzteZaehlung, [sessionKey]: jetztMs};
        }
        protokolliere(zustand, {zeit: new Date(jetztMs).toISOString(), aktion: ergebnis.aktion,
          grund: ergebnis.grund, sitzung: sitzungsart(sessionKey), gezaehlt: zustand.gezaehlt});
        speichereZustand(zustandsdatei, zustand);
        return {...ergebnis, gezaehlt: zustand.gezaehlt};
      } catch (fehler) {
        logger.error?.(`${PLUGIN_ID}: Entscheidung fehlgeschlagen (${fehler?.code ?? fehler?.message ?? 'unbekannt'}); proaktive Sendung gesperrt`);
        return {aktion: 'sperren', grund: 'meldebudget_fehler'};
      }
    },
    stand() {
      const jetztMs = uhr();
      const tag = tagesschluessel(jetztMs, cfg.zeitzone);
      const zustand = ladeZustand(zustandsdatei, tag);
      return {tag, gezaehlt: zustand.gezaehlt, tagesbudget: cfg.tagesbudget,
        ruhe: `${cfg.ruheVon}-${cfg.ruheBis} ${cfg.zeitzone}`, ruhezeitJetzt: istRuhezeit(jetztMs, cfg),
        letzte: (zustand.protokoll ?? []).slice(-10)};
    },
  };
}

export function registerMeldebudget(api, abhaengigkeiten = {}) {
  const cfg = abhaengigkeiten.config ?? api.pluginConfig ?? {};
  const verzeichnis = abhaengigkeiten.verzeichnis ??
    join(process.env.OPENCLAW_STATE_DIR ?? join(process.env.HOME ?? '/home/node', '.openclaw'), PLUGIN_ID);
  mkdirSync(verzeichnis, {recursive: true, mode: 0o700});
  const budget = erzeugeBudget({cfg, zustandsdatei: join(verzeichnis, 'zustand.json'),
    uhr: abhaengigkeiten.uhr, logger: api.logger});

  api.on('message_received', (_event, ctx) => { budget.eingang(ctx?.sessionKey); });
  api.on('before_agent_run', (_event, ctx) => { budget.laufBeginn(ctx?.runId, ctx?.sessionKey, ctx?.trigger); });
  api.on('agent_end', (event, ctx) => { budget.laufEnde(ctx?.runId ?? event?.runId); });
  api.on('message_sending', (_event, ctx) => {
    const e = budget.senden(ctx?.sessionKey);
    if (e.aktion === 'sperren') {
      api.logger?.warn?.(`${PLUGIN_ID}: proaktive Sendung gesperrt (${e.grund}, Sitzung ${sitzungsart(ctx?.sessionKey)})`);
      return {cancel: true, cancelReason: `meldebudget:${e.grund}`};
    }
    if (e.aktion === 'zaehlen') api.logger?.info?.(`${PLUGIN_ID}: proaktive Meldung ${e.gezaehlt}/${budget.cfg.tagesbudget}`);
    return undefined;
  });
  api.registerGatewayMethod?.('fyos.meldebudget.stand', () => budget.stand(), {scope: 'operator.read'});
  return budget;
}
