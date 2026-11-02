/**
 * sprache-anschluss.js — Kalender und Mitteilungsweg der Sprachsitzung (docs/current/RUNNER-SPRACHE.md#anschluesse, Entscheidung E10).
 *
 * Beides sind Schnittstellen mit Adaptern; hineingereicht wird der Hub des Runners (oder eine Attrappe). Nichts hier spricht, nichts sendet von selbst:
 *
 *  - `kalender({hub})` liefert `{beschaeftigt(ms), naechste(ms)}` für „nicht in Meetings ansprechen“. Quelle ist das lesende Hub-Werkzeug
 *    `leitstand.termine` (Ersatz nur auf Wunsch: `termine.zeigen`, das aber die App öffnet). Es wird nur gelesen; die Bereiche (welche Kalender) bestimmt der Hub, hier gibt es keinen eigenen Filter
 *    außer einer ausdrücklichen Einengung (`bereiche`). Als privat markierte Termine zählen als „beschäftigt“ (Besitzer ist ja im Termin), werden aber nie
 *    genannt: weder der Titel noch der Ort noch die Existenz in `naechste()`. `beschaeftigt()` gibt nie einen Titel heraus.
 *  - `mitteilung({hub})` liefert die Funktion für `Sprache({mitteilen})`: Texte, die nicht gesprochen werden konnten (keine AirPods, Ruhe, Fehler,
 *    Ergebnis einer Übergabe, verfallene Ansprache), gehen über den Hub-Meldeweg `os.mitteilen` (Karte auf dem Gerät) und die Matrix-Meldung
 *    `chat.matrix_senden` (Raum ops). Weitere Kanäle (z. B. `matrixKanal` und `ntfyKanal` aus src/freigabe-meldung.js auf feat/freigaben-push, deren Vertrag
 *    `{name, senden(n) → {ok, grund?}}` ist) kommen über `extra` hinein, ohne dass dieses Modul sie kennt.
 */

const MIN = 60_000;

// --- Kalender -------------------------------------------------------------------------------------------------------

const PRIVAT_WERT = /^(private|privat|confidential|vertraulich|secret|geheim)$/i;
const PRIVAT_TITEL = /^\s*[[(]?\s*privat/i;

/**
 * Ist der Termin als privat markiert (Feld, Sichtbarkeit oder Titelpräfix „privat“)? Beim Titel gilt jeder Anfang mit „privat“ (auch „Privatkunden …“):
 * lieber einen Termin zu viel verbergen als einen privaten nennen. Der Hub liefert seit E11 (25.10.2026) das Feld `sichtbarkeit`
 * (`oeffentlich|privat`) an jedem Termin von `leitstand.termine`; es ist der Hauptweg. Ein älterer Hub liefert es nicht, dann schützen die übrigen Felder und der Titel.
 */
export function istPrivat(t, { strikt = false } = {}) {
  if (!t || typeof t !== 'object') return false;
  // Das Hub-Feld `sichtbarkeit` (E11, 25.10.2026) entscheidet, wo es vorhanden ist: nur `oeffentlich` darf genannt werden, jeder andere Wert
  // (`privat`, leer, unbekannt) ist privat. Der Titel gilt zusätzlich weiter (strengste Quelle gewinnt). Fehlt das Feld (älterer Hub),
  // schützt wie bisher der Rest; mit `strikt` zählt ein fehlendes Feld als privat.
  if (typeof t.sichtbarkeit === 'string' && /^(oeffentlich|öffentlich)$/i.test(t.sichtbarkeit.trim())) {
    return (typeof t.titel === 'string' && PRIVAT_TITEL.test(t.titel)) || (typeof t.title === 'string' && PRIVAT_TITEL.test(t.title)) || t.privat === true;
  }
  if ('sichtbarkeit' in t) return true;
  if (strikt) return true;
  if (t.privat === true || t.private === true || t.vertraulich === true || t.geheim === true) return true;
  for (const k of ['visibility', 'sichtbarkeit', 'class', 'klasse', 'access', 'zugriff']) {
    if (typeof t[k] === 'string' && PRIVAT_WERT.test(t[k].trim())) return true;
  }
  if (typeof t.titel === 'string' && PRIVAT_TITEL.test(t.titel)) return true;
  if (typeof t.title === 'string' && PRIVAT_TITEL.test(t.title)) return true;
  return false;
}

const zeit = (v) => {
  if (v === null || v === undefined || v === '') return null;
  // Reine Datumsangaben (ganztägig) sind keine Uhrzeiten.
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return null;
  const ms = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
};

function termineAus(r) {
  if (Array.isArray(r)) return r;
  if (!r || typeof r !== 'object') return null;
  for (const k of ['termine', 'events', 'eintraege', 'liste']) if (Array.isArray(r[k])) return r[k];
  return null;
}

/**
 * @param {object} p
 * @param {object} p.hub                   `aufrufen(werkzeug, argumente, opts) → {ok, result, fehler}`
 * @param {string} [p.werkzeug]            Vorgabe `leitstand.termine`
 * @param {string} [p.ersatz]              Vorgabe keiner. `termine.zeigen` liest zwar auch nur, öffnet aber jedes Mal die App „Termine“ auf Besitzer' Schirm: nur ausdrücklich eintragen
 * @param {number} [p.tage]                Fenster in Tagen (Vorgabe 2)
 * @param {number} [p.cacheS]              Zwischenspeicher (Vorgabe 60, wie der Hub)
 * @param {number} [p.vorlaufMin]          schon vor Beginn nicht mehr stören (Vorgabe 2)
 * @param {number} [p.standardDauerMin]    wenn ein Termin kein Ende hat (Vorgabe 60)
 * @param {boolean} [p.sichtbarkeitPflicht] ein Termin ohne Hub-Feld `sichtbarkeit` zählt als privat (Vorgabe nein, bis der Hub das Feld liefert)
 * @param {string[]} [p.bereiche]         nur diese Kalender/Bereiche (Feld `bereich` oder `kalender`); leer = alles, was der Hub liefert
 */
export function kalender({ hub, werkzeug = 'leitstand.termine', ersatz = null, tage = 2, cacheS = 60, vorlaufMin = 2, standardDauerMin = 60, bereiche = [], sichtbarkeitPflicht = false, jetzt = () => Date.now(), log = () => {} } = {}) {
  let cache = null; // { t, termine }
  let letzterFehler = null;
  let quelle = null;

  async function laden(ms) {
    if (cache && ms - cache.t < cacheS * 1000) return cache.termine;
    let fehler = null;
    for (const name of [werkzeug, ersatz].filter(Boolean)) {
      try {
        const a = await hub.aufrufen(name, { tage }, { ansicht: 'voll', timeoutMs: 8000 });
        if (!a?.ok) {
          fehler = String(a?.fehler ?? 'Hub meldet einen Fehler').slice(0, 120);
          continue;
        }
        const liste = termineAus(a.result);
        // Kein Kalender eingerichtet (`termine: null`) ist weder „frei“ noch ein Fehler: unbekannt.
        if (liste === null) {
          fehler = String(a.result?.hinweis ?? 'kein Kalender eingerichtet').slice(0, 120);
          quelle = name;
          cache = { t: ms, termine: null };
          letzterFehler = fehler;
          return null;
        }
        quelle = name;
        letzterFehler = null;
        cache = { t: ms, termine: liste };
        return liste;
      } catch (f) {
        fehler = String(f?.message ?? f).slice(0, 120);
      }
    }
    letzterFehler = fehler;
    log(`[fyos-sprache] Kalender nicht lesbar: ${fehler}`);
    // Kurz merken, damit ein toter Hub nicht bei jedem Aufruf neu angefragt wird.
    cache = { t: ms - (cacheS * 1000 - 10_000), termine: null };
    return null;
  }

  const imBereich = (t) => {
    if (!bereiche.length) return true;
    const b = String(t.bereich ?? t.kalender ?? t.calendar ?? '').toLowerCase();
    return bereiche.some((x) => b === String(x).toLowerCase());
  };

  return {
    /** `{beschaeftigt, bis, unbekannt?}` — nie ein Titel. Nicht lesbar heißt `unbekannt` (nicht beschäftigt: die Richtlinie darf dann nicht für immer schweigen). */
    async beschaeftigt(ms = jetzt()) {
      const liste = await laden(ms);
      if (liste === null) return { beschaeftigt: false, bis: null, unbekannt: true };
      let bis = null;
      for (const t of liste) {
        if (!t || typeof t !== 'object' || !imBereich(t)) continue;
        if (t.ganztaegig === true || t.all_day === true || t.ganztag === true) continue;
        const s = zeit(t.start ?? t.von ?? t.beginn);
        if (s === null) continue;
        const e = zeit(t.ende ?? t.end ?? t.bis) ?? s + standardDauerMin * MIN;
        if (ms >= s - vorlaufMin * MIN && ms < e) bis = Math.max(bis ?? 0, e);
      }
      return { beschaeftigt: bis !== null, bis: bis !== null ? new Date(bis).toISOString() : null, unbekannt: false };
    },

    /** Die nächsten nicht privaten Termine (nur Beginn, Ende und Titel); private Termine tauchen hier gar nicht auf. */
    async naechste(ms = jetzt(), { n = 3 } = {}) {
      const liste = await laden(ms);
      if (liste === null) return [];
      return liste
        .filter((t) => t && typeof t === 'object' && imBereich(t) && !istPrivat(t, { strikt: sichtbarkeitPflicht }) && t.ganztaegig !== true && t.all_day !== true)
        .map((t) => ({ start: zeit(t.start ?? t.von ?? t.beginn), ende: zeit(t.ende ?? t.end ?? t.bis), titel: String(t.titel ?? t.title ?? '').slice(0, 120) || null }))
        .filter((t) => t.start !== null && (t.ende ?? t.start + standardDauerMin * MIN) > ms)
        .sort((a, b) => a.start - b.start)
        .slice(0, n)
        .map((t) => ({ start: new Date(t.start).toISOString(), ende: t.ende !== null ? new Date(t.ende).toISOString() : null, titel: t.titel }));
    },

    zustand() {
      return { quelle, fehler: letzterFehler, zwischengespeichert: Boolean(cache), bereiche: bereiche.length ? bereiche : null };
    },
  };
}

// --- Mitteilungsweg -----------------------------------------------------------------------------------------------------

const RANG = { info: 0, wichtig: 1, dringend: 2 };

/** Zugangsdaten und lange Schlüsselfolgen raus, eine Zeile daraus machen. */
export function schwaerzen(wert, grenze = 300) {
  let t = String(wert ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  t = t.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer ***');
  t = t.replace(/\b(authorization|token|passwort|password|secret|api[_-]?key)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2***');
  t = t.replace(/[A-Za-z0-9+_=-]{32,}/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? '***' : m));
  return t.length > grenze ? `${t.slice(0, grenze - 1)}…` : t;
}

const MATRIX_ART = { freigabe: 'frage', fehler: 'befund', ergebnis: 'erledigt', proaktiv: 'meldung', antwort: 'info', hinweis: 'info' };

/** Kanal „Karte auf dem Gerät“: das Hub-Werkzeug `os.mitteilen`. Ob Ton oder Vorlesen, bestimmt der Ton-Modus des Geräts. */
export function osKanal(hub) {
  return {
    name: 'os',
    ab: 'info',
    async senden(n) {
      const a = await hub.aufrufen('os.mitteilen', {
        titel: schwaerzen(n.titel, 80) || 'Persona',
        text: schwaerzen(n.text, 300),
        dringlichkeit: n.dringend ? 'hoch' : n.dringlichkeit === 'info' ? 'niedrig' : 'normal',
        quelle: 'sprache',
      });
      return a?.ok ? { ok: true } : { ok: false, grund: String(a?.fehler ?? 'os.mitteilen abgewiesen').slice(0, 100) };
    },
  };
}

/** Kanal Matrix: das Hub-Werkzeug `chat.matrix_senden` (Ginnys Sender; Konto und Räume hält der Dienst). */
export function matrixHubKanal(hub, { raum = 'ops' } = {}) {
  return {
    name: 'matrix',
    ab: 'wichtig',
    async senden(n) {
      const a = await hub.aufrufen('chat.matrix_senden', {
        text: schwaerzen(`${n.titel ? `${n.titel}: ` : ''}${n.text}`, 1200),
        art: MATRIX_ART[n.art] ?? 'info',
        ...(n.bezug ? { bezug: String(n.bezug).slice(0, 40) } : {}),
        dringend: n.dringend === true,
        raum,
      });
      return a?.ok ? { ok: true } : { ok: false, grund: String(a?.fehler ?? 'chat.matrix_senden abgewiesen').slice(0, 100) };
    },
  };
}

const TITEL = { freigabe: 'Freigabe wartet', fehler: 'Persona: nicht geklappt', ergebnis: 'Persona: Ergebnis', proaktiv: 'Persona hat etwas', antwort: 'Persona', hinweis: 'Persona' };

/**
 * Die Funktion für `Sprache({mitteilen})`. Jede Mitteilung (`{text, dringlichkeit, grund, quelle, bezug, art, zug}`) geht an die Kanäle, deren Schwelle (`ab`)
 * sie erreicht. Nach außen gehen nur Arten, die Besitzer nicht schon im Client sieht (`arten`): eine Antwort auf Besitzer' eigene Frage bleibt im Client.
 *
 * @param {object} p
 * @param {object} p.hub
 * @param {string[]} [p.kanaele]         eingebaute Kanäle: `os`, `matrix` (Vorgabe: beide)
 * @param {object[]} [p.extra]           weitere Kanäle `{name, ab?, senden(n)}` (z. B. aus freigabe-meldung.js)
 * @param {string[]} [p.arten]           Vorgabe `proaktiv, freigabe, fehler, ergebnis`
 * @param {number} [p.matrixProStunde]   Vorgabe 6 (der Sender begrenzt selbst auf 30)
 * @param {boolean} [p.trocken]          nichts senden, nur festhalten, was gesendet würde
 */
export function mitteilung({ hub, kanaele = ['os', 'matrix'], matrix = {}, extra = [], arten = ['proaktiv', 'freigabe', 'fehler', 'ergebnis'], matrixProStunde = 6, trocken = false, jetzt = () => Date.now(), log = () => {} } = {}) {
  const alle = [];
  if (kanaele.includes('os')) alle.push(osKanal(hub));
  if (kanaele.includes('matrix')) alle.push(matrixHubKanal(hub, matrix));
  for (const k of extra) if (k && typeof k.senden === 'function') alle.push({ ab: 'wichtig', ...k });
  const stand = { gesendet: 0, trocken: 0, uebersprungen: 0, fehler: {}, letzte: null, protokoll: [] };
  const gesehen = new Map(); // bezug|text → ms
  const matrixZeiten = [];

  const mitteilen = async function mitteilen(m) {
    const art = String(m?.art ?? 'hinweis');
    const stufe = RANG[m?.dringlichkeit] ?? 0;
    if (!arten.includes(art)) {
      stand.uebersprungen += 1;
      return { gesendet: [], uebersprungen: `Art ${art} bleibt im Client` };
    }
    const jetztMs = jetzt();
    const schluessel = `${m.bezug ?? ''}|${String(m.text ?? '').slice(0, 80)}`;
    if (jetztMs - (gesehen.get(schluessel) ?? 0) < 10 * MIN) {
      stand.uebersprungen += 1;
      return { gesendet: [], uebersprungen: 'gleiche Mitteilung vor Kurzem' };
    }
    gesehen.set(schluessel, jetztMs);
    for (const [k, t] of gesehen) if (jetztMs - t > 60 * MIN) gesehen.delete(k);

    const n = {
      titel: TITEL[art] ?? 'Persona',
      text: schwaerzen(m.text, 1200),
      dringend: m.dringlichkeit === 'dringend',
      dringlichkeit: m.dringlichkeit ?? 'info',
      bezug: m.bezug ?? null,
      art,
      link: '',
    };
    const gesendet = [];
    for (const k of alle) {
      if (stufe < (RANG[k.ab] ?? 1)) continue;
      if (k.name === 'matrix') {
        while (matrixZeiten.length && jetztMs - matrixZeiten[0] > 60 * MIN) matrixZeiten.shift();
        if (matrixZeiten.length >= matrixProStunde && !n.dringend) {
          stand.uebersprungen += 1;
          continue;
        }
      }
      if (trocken) {
        stand.trocken += 1;
        stand.protokoll.push({ kanal: k.name, art, dringlichkeit: n.dringlichkeit, zeichen: n.text.length });
        if (stand.protokoll.length > 20) stand.protokoll.shift();
        gesendet.push(`${k.name}:trocken`);
        continue;
      }
      try {
        const r = await k.senden(n);
        if (r?.ok) {
          stand.gesendet += 1;
          stand.letzte = { kanal: k.name, art, zeit: jetztMs };
          delete stand.fehler[k.name];
          if (k.name === 'matrix') matrixZeiten.push(jetztMs);
          gesendet.push(k.name);
        } else stand.fehler[k.name] = String(r?.grund ?? 'abgewiesen').slice(0, 100);
      } catch (f) {
        stand.fehler[k.name] = String(f?.message ?? f).slice(0, 100);
        log(`[fyos-sprache] Mitteilung über ${k.name}: ${stand.fehler[k.name]}`);
      }
    }
    return { gesendet };
  };
  mitteilen.zustand = () => ({ kanaele: alle.map((k) => k.name), arten, trocken, gesendet: stand.gesendet, trocken_gezaehlt: stand.trocken, uebersprungen: stand.uebersprungen, fehler: { ...stand.fehler }, letzte: stand.letzte, protokoll: [...stand.protokoll] });
  return mitteilen;
}
