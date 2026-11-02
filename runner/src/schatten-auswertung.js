/**
 * schatten-auswertung.js — reine Rechnung des Schatten-Rekorders (ohne Dateien, Netz und Uhr).
 *
 * Eine Zeile je Schattenzug (siehe schatten.js, `art: 'zug'`) wird mit der Live-Aktion verglichen; `auswerten` macht daraus je Adapter
 * Trefferquote (Werkzeug, Argumente, exakt), Falsch-Auslösung, JSON-Gültigkeit, Deutsch-Quote, Latenz, Fehlerquote, Abdeckung,
 * den Verlauf je Tag und das Tor „Schatten bereit für aktiv“. Das Tor schaltet nie etwas um; es sagt nur ja, nein oder zu wenig Daten.
 *
 * Dieselbe Rechnung steht in `scripts/ops/schatten_bericht.py`; beide werden mit derselben Beispieldatei
 * (`test/fixtures/schatten-beispiel.jsonl`) geprüft. Wer hier eine Regel ändert, ändert sie dort mit.
 */
import { createHash } from 'node:crypto';

/** Stabile Zeichenkette eines JSON-Werts (Schlüssel sortiert); Grundlage für Hashes. */
export function kanonisch(wert) {
  if (Array.isArray(wert)) return `[${wert.map(kanonisch).join(',')}]`;
  if (wert && typeof wert === 'object') {
    return `{${Object.keys(wert)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${kanonisch(wert[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(wert === undefined ? null : wert);
}

export const hash16 = (text) => createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16);

/** Die Form von Argumenten: Schlüssel und Typen, nie Werte. */
export function argumenteForm(wert, tiefe = 0) {
  if (wert === null || wert === undefined) return 'null';
  if (Array.isArray(wert)) return tiefe >= 3 || wert.length === 0 ? [] : [argumenteForm(wert[0], tiefe + 1)];
  if (typeof wert === 'object') {
    if (tiefe >= 3) return 'object';
    return Object.fromEntries(Object.keys(wert).sort().map((k) => [k, argumenteForm(wert[k], tiefe + 1)]));
  }
  return typeof wert;
}

const DE = new Set(
  'der die das und ist nicht ein eine ich du es zu mit auf für fuer von dem den im in an wird hat habe kann bei aber noch auch nur sind war steht läuft laeuft heute uhr dir dein deine ihn sie wir wie was ob'.split(' '),
);
const EN = new Set('the and is are not you your with for this that it of to in on was has have can will but also only'.split(' '));

/** Grobe Sprachprüfung wie im Prüfskript des Ersatzdenkers: mindestens so viele deutsche wie englische Funktionswörter. */
export function istDeutsch(text) {
  const w = String(text ?? '').toLowerCase().match(/[A-Za-zÄÖÜäöüß]+/g) ?? [];
  if (w.length === 0) return true;
  let de = 0;
  let en = 0;
  for (const x of w) {
    if (DE.has(x)) de += 1;
    if (EN.has(x)) en += 1;
  }
  return de >= en;
}

/**
 * Aktion in der Form der Aufzeichnung. `name === null` heißt: kein Werkzeug (Text). `argumente` ist das geparste Objekt oder
 * `undefined`, wenn der Aufruf kein gültiges JSON-Objekt war.
 */
export function aktion({ name = null, argumente, argumente_roh = null, text = '' } = {}) {
  const hatText = String(text ?? '').trim().length > 0;
  if (name) {
    const gueltig = argumente !== undefined && argumente !== null && typeof argumente === 'object' && !Array.isArray(argumente);
    return {
      art: 'werkzeug',
      name: String(name),
      args_form: gueltig ? argumenteForm(argumente) : null,
      args_hash: gueltig ? hash16(kanonisch(argumente)) : hash16(argumente_roh ?? ''),
      json_gueltig: gueltig,
      deutsch: hatText ? istDeutsch(text) : null,
    };
  }
  return {
    art: hatText ? 'text' : 'nichts',
    name: null,
    args_form: null,
    args_hash: null,
    json_gueltig: null,
    deutsch: hatText ? istDeutsch(text) : null,
  };
}

/** Übereinstimmung von Live- und Schatten-Aktion (beide in der Form von `aktion`). */
export function vergleiche(live, schatten) {
  const lw = live?.art === 'werkzeug' ? live.name : null;
  const sw = schatten?.art === 'werkzeug' ? schatten.name : null;
  const werkzeug = lw === sw;
  const argumente = lw !== null && lw === sw ? live.args_hash === schatten.args_hash : null;
  return {
    werkzeug,
    argumente,
    exakt: werkzeug && (lw === null || argumente === true),
    json_gueltig: sw !== null ? schatten.json_gueltig === true : null,
    deutsch: schatten?.deutsch ?? null,
    falsch: lw === null && sw !== null ? 'schatten-ruft' : lw !== null && sw === null ? 'live-ruft' : null,
  };
}

/** Wilson-Intervall (95 % bei z = 1,96) einer Quote k von n. */
export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n;
  const z2 = z * z;
  const nenner = 1 + z2 / n;
  const mitte = (p + z2 / (2 * n)) / nenner;
  const rand = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / nenner;
  return [Math.max(0, mitte - rand), Math.min(1, mitte + rand)];
}

/** Perzentil nach dem nächsten Rang; `null` bei leerer Liste. */
export function perzentil(werte, p) {
  const l = werte.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (l.length === 0) return null;
  return l[Math.min(l.length - 1, Math.max(0, Math.ceil(p * l.length) - 1))];
}

export function quote(k, n) {
  return { k, n, rate: n ? k / n : null, wilson: wilson(k, n) };
}

const tagVon = (z) => z.tag ?? new Date(z.t ?? 0).toISOString().slice(0, 10);

/** Das Tor. `a` ist die Auswertung eines Adapters, `tor` die geprüfte Torkonfiguration (`torKonfig`). */
export function torUrteil(a, tor) {
  const versuche = a.versuche;
  if (versuche < tor.min_zuege) {
    return {
      bereit: 'zu wenig Daten',
      satz: `Schatten bereit für aktiv: zu wenig Daten (${versuche} von ${tor.min_zuege} Zügen)`,
      gruende: [`nur ${versuche} von ${tor.min_zuege} Zügen`],
      pruefungen: [],
      streng: tor.streng,
    };
  }
  const pruefungen = [];
  const pruefe = (name, q, schwelle, art) => {
    if (!q || q.n === 0 || q.rate === null) {
      pruefungen.push({ name, wert: null, grenze: null, schwelle, art, ok: false, hinweis: 'keine Messwerte' });
      return;
    }
    const grenze = tor.streng ? (art === 'min' ? q.wilson[0] : q.wilson[1]) : q.rate;
    const ok = art === 'min' ? grenze >= schwelle : art === 'unter' ? grenze < schwelle : grenze <= schwelle;
    pruefungen.push({ name, wert: q.rate, grenze, schwelle, art, ok });
  };
  pruefe('werkzeug', a.werkzeug, tor.min_werkzeug, 'min');
  pruefe('falsch', a.falsch.gesamt, tor.max_falsch, 'unter');
  pruefe('fehler', a.fehlerquote, tor.max_fehler, 'max');
  if (a.json.n > 0) pruefe('json', a.json, tor.min_json, 'min');
  if (a.deutsch.n > 0) pruefe('deutsch', a.deutsch, tor.min_deutsch, 'min');
  if (tor.max_p95_ms !== null && tor.max_p95_ms !== undefined) {
    const p95 = a.latenz.gesamt_p95;
    pruefungen.push({ name: 'latenz_p95', wert: p95, grenze: p95, schwelle: tor.max_p95_ms, art: 'max', ok: p95 !== null && p95 <= tor.max_p95_ms });
  }
  const gruende = pruefungen.filter((p) => !p.ok).map((p) => `${p.name}: ${p.wert === null ? 'keine Messwerte' : `${p.wert}`} gegen ${p.art === 'min' ? '≥' : p.art === 'unter' ? '<' : '≤'} ${p.schwelle}`);
  const bereit = gruende.length === 0 ? 'ja' : 'nein';
  return { bereit, satz: `Schatten bereit für aktiv: ${bereit}`, gruende, pruefungen, streng: tor.streng };
}

/**
 * Auswertung. `zeilen`: geparste JSONL-Zeilen aller Adapter (`art` zug | uebersprungen | wahrheit); `tor`: geprüfte Torkonfiguration.
 * Gibt `{adapter: {<name>: {...}}}` zurück; Inhalte kommen nicht vor, nur Zahlen.
 */
export function auswerten(zeilen, { tor } = {}) {
  const wahrheiten = new Map();
  for (const z of zeilen) {
    if (z?.art !== 'wahrheit' || !z.ein) continue;
    const alt = wahrheiten.get(z.ein);
    if (!alt || (z.t ?? 0) >= (alt.t ?? 0)) wahrheiten.set(z.ein, z); // neueste Wahrheit gewinnt
  }
  const je = new Map();
  const hole = (name) => {
    if (!je.has(name)) je.set(name, { zug: [], uebersprungen: {} });
    return je.get(name);
  };
  for (const z of zeilen) {
    if (!z?.adapter) continue;
    if (z.art === 'zug') hole(z.adapter).zug.push(z);
    else if (z.art === 'uebersprungen') {
      const u = hole(z.adapter).uebersprungen;
      u[z.grund] = (u[z.grund] ?? 0) + 1;
    }
  }
  const aus = {};
  for (const [name, d] of [...je.entries()].sort((a, b) => a[0].localeCompare(b[0]))) aus[name] = einAdapter(name, d, wahrheiten, tor);
  return { adapter: aus, wahrheiten: wahrheiten.size };
}

function einAdapter(name, { zug, uebersprungen }, wahrheiten, tor) {
  const ok = zug.filter((z) => z.status === 'ok');
  const fehler = zug.filter((z) => z.status === 'fehler').length;
  const timeouts = zug.filter((z) => z.status === 'timeout').length;
  const versuche = zug.length;
  const nUeber = Object.values(uebersprungen).reduce((s, x) => s + x, 0);
  const u = (z) => z.uebereinstimmung ?? {};
  const zaehle = (f) => ok.filter(f).length;
  const arg = ok.filter((z) => u(z).argumente !== null && u(z).argumente !== undefined);
  const json = ok.filter((z) => u(z).json_gueltig !== null && u(z).json_gueltig !== undefined);
  const deu = ok.filter((z) => u(z).deutsch !== null && u(z).deutsch !== undefined);
  const schattenRuft = zaehle((z) => u(z).falsch === 'schatten-ruft');
  const liveRuft = zaehle((z) => u(z).falsch === 'live-ruft');
  const zahlen = (f) => ok.map(f).filter((x) => typeof x === 'number');
  const tok = (f) => zahlen((z) => z.tokens?.[f]).reduce((s, x) => s + x, 0);
  const aus = {
    adapter: name,
    versuche,
    zuege: ok.length,
    fehler,
    timeouts,
    uebersprungen,
    abdeckung: quote(versuche, versuche + nUeber),
    fehlerquote: quote(fehler + timeouts, versuche),
    werkzeug: quote(zaehle((z) => u(z).werkzeug === true), ok.length),
    argumente: quote(arg.filter((z) => u(z).argumente === true).length, arg.length),
    exakt: quote(zaehle((z) => u(z).exakt === true), ok.length),
    falsch: { gesamt: quote(schattenRuft + liveRuft, ok.length), schatten_ruft: schattenRuft, live_ruft: liveRuft },
    json: quote(json.filter((z) => u(z).json_gueltig === true).length, json.length),
    deutsch: quote(deu.filter((z) => u(z).deutsch === true).length, deu.length),
    latenz: {
      erstes_token_p50: perzentil(zahlen((z) => z.latenz?.erstes_token_ms), 0.5),
      erstes_token_p95: perzentil(zahlen((z) => z.latenz?.erstes_token_ms), 0.95),
      gesamt_p50: perzentil(zahlen((z) => z.latenz?.gesamt_ms), 0.5),
      gesamt_p95: perzentil(zahlen((z) => z.latenz?.gesamt_ms), 0.95),
    },
    tokens: { ein: tok('ein'), aus: tok('aus') },
    versionen: versionen(zug),
    wahrheit: wahrheitBilanz(ok, wahrheiten),
    tage: tage(zug),
  };
  if (tor) aus.tor = torUrteil(aus, tor);
  return aus;
}

function versionen(zug) {
  const m = new Map();
  for (const z of zug) {
    const v = z.version ?? {};
    const k = `${v.modell ?? ''}|${v.quant ?? ''}|${v.systemkopf ?? ''}`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, n]) => {
    const [modell, quant, systemkopf] = k.split('|');
    return { modell, quant, systemkopf, zuege: n };
  });
}

function tage(zug) {
  const m = new Map();
  for (const z of zug) {
    const t = tagVon(z);
    if (!m.has(t)) m.set(t, []);
    m.get(t).push(z);
  }
  const aus = {};
  for (const t of [...m.keys()].sort()) {
    const liste = m.get(t);
    const ok = liste.filter((z) => z.status === 'ok');
    const u = (z) => z.uebereinstimmung ?? {};
    aus[t] = {
      versuche: liste.length,
      zuege: ok.length,
      werkzeug: quote(ok.filter((z) => u(z).werkzeug === true).length, ok.length).rate,
      falsch: quote(ok.filter((z) => u(z).falsch).length, ok.length).rate,
      fehlerquote: quote(liste.length - ok.length, liste.length).rate,
      gesamt_p50: perzentil(ok.map((z) => z.latenz?.gesamt_ms).filter((x) => typeof x === 'number'), 0.5),
    };
  }
  return aus;
}

/** Besitzer' Rückmeldungen als Wahrheit: wie oft traf Live, wie oft der Schatten das, was später als richtig galt. */
function wahrheitBilanz(ok, wahrheiten) {
  let urteile = 0;
  let bekannt = 0;
  let liveTreffer = 0;
  let schattenTreffer = 0;
  let liveSchlecht = 0;
  for (const z of ok) {
    const w = wahrheiten.get(z.ein);
    if (!w) continue;
    urteile += 1;
    const liveName = z.live?.art === 'werkzeug' ? z.live.name : null;
    const schattenName = z.schatten?.art === 'werkzeug' ? z.schatten.name : null;
    if (w.urteil === 'schlecht' && !('wahr_werkzeug' in w)) {
      liveSchlecht += 1;
      continue;
    }
    if (w.urteil === 'schlecht') liveSchlecht += 1;
    const wahr = 'wahr_werkzeug' in w ? (w.wahr_werkzeug ?? null) : liveName; // „gut“ ohne Angabe: die Live-Aktion war richtig
    bekannt += 1;
    if (liveName === wahr) liveTreffer += 1;
    if (schattenName === wahr) schattenTreffer += 1;
  }
  return {
    mit_urteil: urteile,
    bekannt,
    live_schlecht: liveSchlecht,
    live_treffer: quote(liveTreffer, bekannt),
    schatten_treffer: quote(schattenTreffer, bekannt),
  };
}

/** JSONL-Text in Zeilen; kaputte Zeilen fallen weg. */
export function zeilenAusText(text) {
  const aus = [];
  for (const roh of String(text ?? '').split('\n')) {
    const z = roh.trim();
    if (!z) continue;
    try {
      const o = JSON.parse(z);
      if (o && typeof o === 'object') aus.push(o);
    } catch {
      /* kaputte Zeile */
    }
  }
  return aus;
}
