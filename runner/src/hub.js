/**
 * hub.js — der FYOS-Hub über seine REST-Schiene.
 *
 * Die REST-Routen sind derselbe Vertrag wie die MCP-Werkzeuge, nur ohne Transport-Sitzung:
 *   GET  /hub/search?query=…&voll=1     Werkzeuge samt Eingabeschema
 *   GET  /hub/map?domain=…              Karte nach Domäne
 *   POST /hub/call {tool, arguments}    ein Werkzeug aufrufen
 *   GET  /hub/agent/eingang?nach=…      Eingang lesen (Long-Poll)
 *   POST /hub/agent/melden {ereignisse} Ausgang melden
 *
 * Kein Werkzeugname wird geraten: erst suchen, dann das Schema lesen, dann aufrufen.
 */

const SCOPE_RANG = ['read', 'write', 'exec', 'extern', 'destructive'];
const SCOPE_GROSS = { read: 'READ', write: 'WRITE', exec: 'EXEC', extern: 'EXTERN', destructive: 'DESTRUCTIVE' };

export class HubFehler extends Error {
  constructor(nachricht, { status = 0, art = 'hub', antwort = null } = {}) {
    super(nachricht);
    this.name = 'HubFehler';
    this.status = status;
    this.art = art;
    this.antwort = antwort;
  }
}

export function scopeAusTags(tags) {
  let hoechste = -1;
  for (const tag of Array.isArray(tags) ? tags : []) {
    const i = SCOPE_RANG.indexOf(String(tag).toLowerCase());
    if (i > hoechste) hoechste = i;
  }
  return hoechste >= 0 ? SCOPE_GROSS[SCOPE_RANG[hoechste]] : 'READ';
}

export class Hub {
  constructor({ url, token = '', agentToken = '', agent = 'persona', timeoutMs = 20000 } = {}) {
    this.url = String(url ?? '').replace(/\/+$/, '');
    this.token = token || '';
    // Quellen-Token der Rolle `runner` für /hub/agent/melden und /hub/agent/eingang (Kopf X-Agent-Token).
    this.agentToken = agentToken || '';
    this.agent = agent;
    this.timeoutMs = timeoutMs;
    this._scope = new Map();
    this._scopeZeit = new Map();
  }

  get konfiguriert() {
    return !!this.url;
  }

  kopf(extra = {}, pfad = '') {
    const h = { Accept: 'application/json', ...extra };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    if (this.agentToken && String(pfad).startsWith('/hub/agent/')) h['X-Agent-Token'] = this.agentToken;
    return h;
  }

  async _fetch(pfad, { method = 'GET', body, timeoutMs, signal } = {}) {
    if (!this.konfiguriert) throw new HubFehler('Kein Hub konfiguriert', { art: 'nicht_konfiguriert' });
    const steuerung = new AbortController();
    const timer = setTimeout(() => steuerung.abort(new Error('Hub-Zeitüberschreitung')), timeoutMs ?? this.timeoutMs);
    const abbruch = () => steuerung.abort(signal?.reason);
    signal?.addEventListener('abort', abbruch, { once: true });
    try {
      const antwort = await fetch(this.url + pfad, {
        method,
        headers: this.kopf(body === undefined ? {} : { 'Content-Type': 'application/json' }, pfad),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: steuerung.signal,
      });
      const roh = await antwort.text();
      let daten = null;
      try {
        daten = roh ? JSON.parse(roh) : null;
      } catch {
        daten = roh;
      }
      if (!antwort.ok) {
        const meldung =
          (daten && typeof daten === 'object' && (daten.error || daten.meldung)) ||
          `Hub antwortet ${antwort.status}`;
        throw new HubFehler(String(meldung), { status: antwort.status, antwort: daten });
      }
      return daten;
    } catch (fehler) {
      if (fehler instanceof HubFehler) throw fehler;
      throw new HubFehler(fehler?.message || 'Hub nicht erreichbar', { art: 'netz', antwort: null });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abbruch);
    }
  }

  /** Werkzeuge suchen; `voll` liefert Beschreibung und Eingabeschema. */
  async suchen(query = '', { voll = true, limit = 200, signal } = {}) {
    const q = new URLSearchParams();
    if (query) q.set('query', query);
    if (voll) q.set('voll', '1');
    if (limit) q.set('limit', String(limit));
    const daten = await this._fetch(`/hub/search?${q}`, { signal });
    if (!daten || daten.ok === false) {
      throw new HubFehler(daten?.error || 'Suche fehlgeschlagen', { antwort: daten });
    }
    return Array.isArray(daten.tools) ? daten.tools : [];
  }

  /** Ein Werkzeug samt Schema; sucht exakt und fällt auf Teiltreffer zurück. */
  async schema(tool, { signal } = {}) {
    const name = String(tool ?? '').trim();
    if (!name) throw new HubFehler('Werkzeugname fehlt', { art: 'aufruf' });
    const treffer = await this.suchen(name, { voll: true, limit: 200, signal });
    const genau = treffer.find((t) => t.name === name) ?? treffer.find((t) => t.name === name.replace('__', '.'));
    if (!genau) throw new HubFehler(`Unbekanntes Hub-Werkzeug: ${name}`, { art: 'not_found' });
    return {
      ...genau,
      scope: scopeAusTags(genau.tags),
    };
  }

  /** Wirkungsgrad eines Werkzeugs (gecacht, 60 s). */
  async scope(tool, { signal } = {}) {
    const jetzt = Date.now();
    const alt = this._scope.get(tool);
    if (alt && jetzt - (this._scopeZeit.get(tool) ?? 0) < 60_000) return alt;
    const s = await this.schema(tool, { signal });
    this._scope.set(tool, s.scope);
    this._scopeZeit.set(tool, jetzt);
    return s.scope;
  }

  /**
   * Ein Werkzeug aufrufen. Gibt `{ok, result, fehler}` zurück, wirft nur bei Transportfehlern.
   *
   * Mit `aufgabe: true` erklärt der Runner dem Hub die Erweiterung `io.modelcontextprotocol/tasks` (REST: `aufgabe: true`,
   * docs/current/MCP-TASKS.md). Ist das Werkzeug Task-fähig, kommt statt des Ergebnisses eine Aufgabe zurück:
   * `{ok: true, aufgabe: {taskId, status, ttlMs, pollIntervalMs, …}}`; sonst wie gewohnt das Ergebnis. Ohne `aufgabe`
   * kann der Hub nie eine Aufgabe liefern.
   */
  async aufrufen(tool, argumente = {}, { ansicht = 'kurz', signal, timeoutMs, aufgabe = false } = {}) {
    const daten = await this._fetch('/hub/call', {
      method: 'POST',
      body: { tool, arguments: argumente ?? {}, ...(ansicht ? { ansicht } : {}), ...(aufgabe ? { aufgabe: true } : {}) },
      timeoutMs,
      signal,
    });
    if (!daten || typeof daten !== 'object') {
      return { ok: false, fehler: 'Hub lieferte keine Antwort', roh: daten };
    }
    if (daten.ok === false) {
      return { ok: false, fehler: daten.error || daten.meldung || 'Hub meldet einen Fehler', roh: daten };
    }
    if (aufgabe && daten.resultType === 'task' && typeof daten.taskId === 'string') {
      const { ok: _ok, ...task } = daten;
      return { ok: true, aufgabe: task, roh: daten };
    }
    return { ok: true, result: daten.result ?? daten, roh: daten };
  }

  /** `tasks/get`: Stand einer Hub-Aufgabe. Wirft `HubFehler` (status 404 = unbekannt oder abgelaufen). */
  async aufgabeStand(taskId, { signal, timeoutMs = 30_000 } = {}) {
    const { ok: _ok, ...task } = (await this._fetch('/hub/aufgaben/get', { method: 'POST', body: { taskId }, signal, timeoutMs })) ?? {};
    return task;
  }

  /** `tasks/cancel`: kooperativ; der Hub setzt die Aufgabe sofort auf `cancelled`. */
  async aufgabeAbbrechen(taskId, { signal } = {}) {
    await this._fetch('/hub/aufgaben/cancel', { method: 'POST', body: { taskId }, signal, timeoutMs: 30_000 });
    return { ok: true };
  }

  /** `tasks/update`: Antworten auf `inputRequests` nachreichen, `{schluessel: {action, content}}`. */
  async aufgabeAntworten(taskId, inputResponses, { signal } = {}) {
    await this._fetch('/hub/aufgaben/update', {
      method: 'POST',
      body: { taskId, inputResponses: inputResponses ?? {} },
      signal,
      timeoutMs: 30_000,
    });
    return { ok: true };
  }

  /** Eingang lesen. `nach` ist `$` (nur Neues) oder eine Strom-ID. */
  async eingangLesen(nach = '$', { warteS = 20, anzahl = 20, agent = this.agent, signal } = {}) {
    const q = new URLSearchParams({
      nach: String(nach || '$'),
      warte: String(Math.max(0, Math.min(25, Number(warteS) || 0))),
      anzahl: String(Math.max(1, Math.min(50, Number(anzahl) || 20))),
      agent,
    });
    return this._fetch(`/hub/agent/eingang?${q}`, { timeoutMs: (Number(warteS) + 15) * 1000, signal });
  }

  /** Ereignisse in den Ausgang legen. */
  async melden(ereignisse, { signal } = {}) {
    if (!Array.isArray(ereignisse) || ereignisse.length === 0) return { ok: true, angenommen: 0 };
    return this._fetch('/hub/agent/melden', {
      method: 'POST',
      body: { ereignisse },
      timeoutMs: 30_000,
      signal,
    });
  }

  /** Arbeitsbereiche melden (nur Namen und Titel, nie Pfade). */
  async bereicheMelden(liste, { agent = this.agent, signal } = {}) {
    return this._fetch('/hub/agent/arbeitsbereiche', {
      method: 'POST',
      body: { agent, bereiche: liste },
      signal,
    });
  }

  async gesundheit({ signal } = {}) {
    try {
      const daten = await this._fetch('/hub/health', { timeoutMs: 4000, signal });
      return { ok: true, daten };
    } catch (fehler) {
      return { ok: false, fehler: fehler.message };
    }
  }

  /** Kurzform für das Modell: Text bleibt Text, Objekte werden begrenztes JSON. */
  static alsText(wert, grenze = 24000) {
    if (wert === undefined || wert === null) return '';
    if (typeof wert === 'string') return wert.length > grenze ? wert.slice(0, grenze) + '\n… gekürzt' : wert;
    if (typeof wert === 'object' && Array.isArray(wert.content)) {
      const teile = wert.content
        .filter((t) => t && typeof t === 'object' && t.type === 'text' && typeof t.text === 'string')
        .map((t) => t.text);
      if (teile.length) {
        const s = teile.join('\n');
        return s.length > grenze ? s.slice(0, grenze) + '\n… gekürzt' : s;
      }
    }
    let s;
    try {
      s = JSON.stringify(wert, null, 2);
    } catch {
      s = String(wert);
    }
    return s.length > grenze ? s.slice(0, grenze) + '\n… gekürzt' : s;
  }
}
