/**
 * provider-kette.js — Hausmodell zuerst, der Ersatzdenker danach.
 *
 * `pi_durable.provider_kette` nennt die Provider in der Reihenfolge der Versuche (Vorgabe nur `["hausmodell"]`: dann ist die
 * Kette nicht aktiv und nichts in diesem Modul greift). Die Kette entscheidet an zwei Stellen:
 *
 *  1. Vor jedem Zug (`Runner.bahnEinstellen`, `Runner.sende`): `waehlen()` liefert den ersten brauchbaren Provider. Nicht
 *     brauchbar ist, wer gerade gesperrt ist (frisch ausgefallen, `provider_sperre_s`), wen die Spielmodus-Marke anhält
 *     (`sperrtSpielmodus`, bei Hausmodell an, beim Ersatzdenker aus) oder wer einen konfigurierten Gesundheitsabruf nicht besteht.
 *  2. Während eines Zugs (`kettenHuelle` in models.js): meldet der Strom eines Providers einen Verbindungsfehler, eine
 *     Zeitüberschreitung oder HTTP 5xx, ruft die Hülle `ausfall()`. Der Provider ist dann `provider_sperre_s` Sekunden
 *     gesperrt, und der Runner stellt die laufenden Gespräche auf den nächsten um; der Wiederholungsversuch des Harness
 *     läuft dann dort. So gibt es keinen Rückfall-Pingpong: bis die Sperre abläuft, wählt jeder Zug denselben Ersatz.
 *
 * Keine Geheimnisse hier: Schlüssel bleiben in der Provider-Beschreibung und werden nie geloggt.
 */

/** Referenzwerte der Verdichtung bei Rheas Fenster (Entscheidung 590, Besitzer 25.10.2026). Andere Fenster skalieren daraus. */
export const VERDICHTUNG_BASIS = {
  fenster: 262_144,
  reserveTokens: 24_000,
  keepRecentTokens: 32_000,
  backgroundTokens: 118_000,
};

/** Fester Zuschlag für Systemkopf und Werkzeugschemata, die nicht in den Nachrichten stehen (Schätzung). */
export const KONTEXT_ZUSCHLAG = 6_000;

export const KEIN_PROVIDER = 'KEIN_PROVIDER';

/** Die Provider der Kette in Reihenfolge; ohne Konfiguration (alte Tests) nur Hausmodell aus `pi_durable.model`. */
export function kettenProvider(cfg) {
  const pd = cfg?.pi_durable ?? {};
  const m = pd.model ?? {};
  const map = pd.provider ?? {
    [m.provider ?? 'hausmodell']: {
      name: m.provider ?? 'hausmodell',
      anzeige: 'Hausmodell (Hauptserver)',
      baseUrl: m.baseUrl,
      apiKey: m.apiKey,
      modelId: m.default,
      maxModelId: m.max,
      contextWindow: 262_144,
      maxTokens: 16_384,
      sperrtSpielmodus: true,
      gesundheitUrl: '',
    },
  };
  const namen = Array.isArray(pd.provider_kette) && pd.provider_kette.length ? pd.provider_kette : [m.provider ?? 'hausmodell'];
  return namen.map((n) => map[n]).filter(Boolean);
}

/** Der Provider, dem ein Modellname gehört (für Gespräche mit bewusst gewähltem Modell); Vorgabe Hausmodell. */
export function providerFuerModell(cfg, modelId) {
  const pd = cfg.pi_durable;
  const map = pd.provider ?? {};
  const treffer = Object.values(map).find((p) => p.modelId === modelId || p.maxModelId === modelId);
  return treffer?.name ?? pd.model.provider;
}

/**
 * Verdichtungsgrenzen für ein Fenster: dieselben Anteile wie bei Hausmodell (Hintergrund ab ≈ 46 %, behalten ≈ 12 %), die
 * Reserve nie unter `maxTokens` + Puffer, damit die Antwort noch hineinpasst. Bei 262144 / 16384 genau Rheas Werte.
 */
export function verdichtungFuer(p) {
  const f = p.contextWindow / VERDICHTUNG_BASIS.fenster;
  const reserve = Math.max(Math.round(VERDICHTUNG_BASIS.reserveTokens * f), (p.maxTokens ?? 0) + 2048);
  const behalten = Math.round(VERDICHTUNG_BASIS.keepRecentTokens * f);
  const hintergrund = Math.round(VERDICHTUNG_BASIS.backgroundTokens * f);
  return { enabled: true, reserveTokens: reserve, keepRecentTokens: behalten, backgroundTokens: hintergrund };
}

/** Die Schwelle, ab der verdichtet werden muss (blockierend): Fenster minus Reserve. */
export function blockierendAb(p) {
  return p.contextWindow - verdichtungFuer(p).reserveTokens;
}

/** `modelOverrides` für die Verdichtung: je Provider/Modell die Grenzen des eigenen Fensters. */
export function verdichtungsUeberschreibungen(cfg) {
  const out = {};
  for (const p of kettenProvider(cfg)) {
    const grenzen = verdichtungFuer(p);
    for (const id of new Set([p.modelId, p.maxModelId].filter(Boolean))) out[`${p.name}/${id}`] = grenzen;
  }
  return out;
}

/** Grobe Schätzung der Tokenzahl einer Nachrichtenliste (≈ 3,3 Zeichen je Token, dazu Kopf und Werkzeuge). */
export function schaetzeTokens(nachrichten, zuschlag = KONTEXT_ZUSCHLAG) {
  let zeichen = 0;
  try {
    zeichen = JSON.stringify(nachrichten ?? []).length;
  } catch {
    zeichen = 0;
  }
  return Math.ceil(zeichen / 3.3) + zuschlag;
}

/**
 * Einordnung eines Fehlertexts eines Modellstroms: `verbindung`, `zeit`, `http5xx` oder `null` (anderer Fehler,
 * z. B. 400, 401, Kontextüberlauf — der führt nicht zum Rückfall).
 */
export function fehlerArt(nachricht) {
  const t = String(nachricht ?? '');
  if (!t) return null;
  if (/context.{0,12}(length|window|overflow)|too many tokens|exceeds the (available )?context/i.test(t)) return null;
  if (/timed? ?out|timeout|ETIMEDOUT|aborted due to timeout/i.test(t)) return 'zeit';
  if (/connection.?(error|refused|lost|reset|closed)|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|fetch failed|network.?error|socket hang up|other side closed|getaddrinfo|ENOTFOUND|EAI_AGAIN|terminated/i.test(t)) return 'verbindung';
  if (/(?<![a-z0-9])5\d\d(?![a-z0-9])|server.?error|service.?(is.?)?unavailable|overloaded|bad gateway|gateway time/i.test(t)) return 'http5xx';
  return null;
}

const ARTEN = { verbindung: 'Verbindungsfehler', zeit: 'Zeitüberschreitung', http5xx: 'HTTP 5xx' };

export class ProviderKette {
  /**
   * @param {object} cfg
   * @param {object} [p]
   * @param {object} [p.spielmodus]  Objekt mit `an()`
   * @param {Function} [p.jetzt]     () → Millisekunden
   * @param {Function} [p.pruefen]   async (provider) → true/false; Vorgabe: GET `gesundheitUrl`, falls gesetzt
   * @param {Function} [p.log]
   */
  constructor(cfg, { spielmodus = null, jetzt = () => Date.now(), pruefen = null, log = (z) => console.log(z) } = {}) {
    this.liste = kettenProvider(cfg);
    this.sperreMs = Math.max(1, Number(cfg?.pi_durable?.provider_sperre_s ?? 60)) * 1000;
    this.spielmodus = spielmodus;
    this.jetzt = jetzt;
    this.log = log;
    this._pruefen = pruefen ?? ((p) => ProviderKette.gesundheitAbrufen(p));
    this._gesperrt = new Map(); // name → { bis, art, text }
    this._probe = new Map(); // name → { t, ok }
    this._hoerer = new Set();
  }

  /** Mehr als ein Provider: nur dann greift die Kette. */
  get aktiv() {
    return this.liste.length > 1;
  }

  provider(name) {
    return this.liste.find((p) => p.name === name) ?? null;
  }

  /** Läuft die Marke und hält sie diesen Provider an? */
  haeltSpielmodus(p) {
    return Boolean(p.sperrtSpielmodus && this.spielmodus?.an?.());
  }

  gesperrt(name) {
    const s = this._gesperrt.get(name);
    if (!s) return false;
    if (this.jetzt() >= s.bis) {
      this._gesperrt.delete(name);
      return false;
    }
    return true;
  }

  /** Ein Provider ist ausgefallen: sperren und alle melden, die darauf hören (Runner stellt Gespräche um). */
  ausfall(name, art = 'verbindung', text = '') {
    if (!this.provider(name)) return;
    const schon = this.gesperrt(name);
    this._gesperrt.set(name, { bis: this.jetzt() + this.sperreMs, art, text: String(text).slice(0, 200) });
    this._probe.delete(name);
    if (!schon) this.log(`[fyos-provider] ${name} ausgefallen (${ARTEN[art] ?? art}); gesperrt für ${Math.round(this.sperreMs / 1000)} s`);
    for (const h of this._hoerer) {
      try {
        const r = h(name, art);
        if (r && typeof r.catch === 'function') r.catch((f) => this.log(`[fyos-provider] Umstellung nach Ausfall fehlgeschlagen: ${f.message}`));
      } catch (f) {
        this.log(`[fyos-provider] Umstellung nach Ausfall fehlgeschlagen: ${f.message}`);
      }
    }
  }

  /** Ruft `fn(name, art)` bei jedem neuen Ausfall. */
  beiAusfall(fn) {
    this._hoerer.add(fn);
    return () => this._hoerer.delete(fn);
  }

  /**
   * Gibt es einen Provider, den die Spielmodus-Marke nicht anhält und der nicht gesperrt ist? (synchron, ohne Abruf;
   * damit lässt der Eingang im Spielmodus Aufträge durch, die dann der Ersatz bearbeitet.)
   */
  ersatzBereit() {
    return this.liste.some((p) => !p.sperrtSpielmodus && !this.gesperrt(p.name));
  }

  async erreichbar(p) {
    if (!p.gesundheitUrl) return true;
    const alt = this._probe.get(p.name);
    if (alt && this.jetzt() - alt.t < 5000) return alt.ok;
    let ok = false;
    try {
      ok = Boolean(await this._pruefen(p));
    } catch {
      ok = false;
    }
    this._probe.set(p.name, { t: this.jetzt(), ok });
    return ok;
  }

  /**
   * Der erste brauchbare Provider. `ausser` überspringt Namen (der eben ausgefallene). Ohne brauchbaren Provider ein
   * Fehler mit `code === 'KEIN_PROVIDER'` und einer Meldung, die jeden Grund nennt.
   */
  async waehlen({ ausser = [] } = {}) {
    const gruende = [];
    for (const p of this.liste) {
      if (ausser.includes(p.name)) {
        gruende.push(`${p.name}: ausgefallen`);
        continue;
      }
      if (this.haeltSpielmodus(p)) {
        gruende.push(`${p.name}: Spielmodus-Marke`);
        continue;
      }
      if (this.gesperrt(p.name)) {
        const s = this._gesperrt.get(p.name);
        gruende.push(`${p.name}: ${ARTEN[s.art] ?? s.art}, gesperrt noch ${Math.max(1, Math.ceil((s.bis - this.jetzt()) / 1000))} s`);
        continue;
      }
      if (!(await this.erreichbar(p))) {
        // Der Gesundheitsabruf zählt wie ein Ausfall, ohne die Umstellung der Gespräche auszulösen (sie wählen gleich selbst).
        this._gesperrt.set(p.name, { bis: this.jetzt() + this.sperreMs, art: 'verbindung', text: 'Gesundheitsabruf' });
        gruende.push(`${p.name}: Gesundheitsabruf fehlgeschlagen`);
        continue;
      }
      return p;
    }
    const fehler = new Error(`Kein Modell erreichbar (${gruende.join('; ')})`);
    fehler.code = KEIN_PROVIDER;
    throw fehler;
  }

  zustand() {
    return this.liste.map((p) => {
      const s = this.gesperrt(p.name) ? this._gesperrt.get(p.name) : null;
      return {
        name: p.name,
        modelId: p.modelId,
        contextWindow: p.contextWindow,
        gesperrtBis: s ? s.bis : null,
        grund: s ? (ARTEN[s.art] ?? s.art) : this.haeltSpielmodus(p) ? 'Spielmodus-Marke' : null,
      };
    });
  }

  /** Vorgabe des Gesundheitsabrufs: GET, 2 Sekunden Frist, 2xx gilt als gesund. */
  static async gesundheitAbrufen(p) {
    const antwort = await fetch(p.gesundheitUrl, { signal: AbortSignal.timeout(2000) });
    return antwort.ok;
  }
}
