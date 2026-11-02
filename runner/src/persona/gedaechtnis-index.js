/**
 * persona/gedaechtnis-index.js — der Qdrant-Index des Gedächtnisses (nur Index; die Dateien bleiben Wahrheit).
 *
 * Sammlung `persona_gedaechtnis` (Vorgabe), ein Mandant je Agent über das Nutzlastfeld `agent`:
 *   - eine Sammlung für alle Agenten, kein Satz Sammlungen je Agent (Skill qdrant-multitenancy: gleiche Form, gleiches Modell);
 *   - Schlüsselwort-Index auf `agent` mit `is_tenant: true`; jede Anfrage trägt `agent` als `must`-Filter (Pflicht, nicht optional);
 *   - Vektoren wie `wissen_eg2_v1`: benannter Dichte-Vektor `dense` (768, Cosine, EmbeddingGemma 2) und Sparse-Vektor `lex`
 *     (BM25, `modifier: idf`); Suche = zwei Prefetch-Zweige mit RRF-Fusion (Query API).
 * Nutzlast: agent, art (episode|fakt|lektion|pflege), kennung, reife, quelle, zeit (ISO, Datumsindex), abgeloest (bool), text, tag.
 * Der Index prüft beim Start die Dichte der vorhandenen Sammlung (Dimension 768) und legt sie sonst an (`anlegen`).
 *
 * Alles geht über `fetch` (einspritzbar für Tests). Jeder Fehler wird geworfen; der Aufrufer entscheidet, wie er ihn meldet.
 */
import { createHash } from 'node:crypto';
import { sparseAnfrage, sparseDokument } from './gedaechtnis-lex.js';

export const DIM = 768;
export const DENSE = 'dense';
export const SPARSE = 'lex';
export const EG2_URL = 'http://llama-cpp-embed-eg2.fyos.svc.cluster.local:8080';
export const QDRANT_URL = 'http://qdrant.fyos.svc.cluster.local:6333';
const ANFRAGE = (q) => `task: search result | query: ${String(q).slice(0, 2000)}`;
const DOKUMENT = (titel, x) => `title: ${titel || 'none'} | text: ${String(x).slice(0, 4000)}`;
const FRIST_MS = 8000;

/** Qdrant-Punktkennung (UUID-Form) aus agent und Kennung: stabil, damit ein Wiederholen denselben Punkt trifft. */
export function punktId(agent, kennung) {
  const h = createHash('sha1').update(`${agent}\u0000${kennung}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export class GedaechtnisIndex {
  constructor({ url, collection = 'persona_gedaechtnis', embedUrl, fetch: holen = globalThis.fetch, anlegen = true, frist = FRIST_MS } = {}) {
    this.url = String(url || QDRANT_URL).replace(/\/+$/, '');
    this.collection = collection;
    this.embedUrl = String(embedUrl || EG2_URL).replace(/\/+$/, '');
    this.fetch = holen;
    this.anlegenErlaubt = anlegen;
    this.frist = frist;
    this._bereit = false;
  }

  async #json(methode, pfad, rumpf, basis = this.url) {
    const res = await this.fetch(`${basis}${pfad}`, {
      method: methode,
      headers: { 'Content-Type': 'application/json' },
      body: rumpf === undefined ? undefined : JSON.stringify(rumpf),
      signal: AbortSignal.timeout(this.frist),
    });
    const roh = await res.text();
    let daten = null;
    try {
      daten = roh ? JSON.parse(roh) : null;
    } catch {
      /* kein JSON */
    }
    return { status: res.status, ok: res.ok, daten, roh };
  }

  async #muss(methode, pfad, rumpf) {
    const a = await this.#json(methode, pfad, rumpf);
    if (!a.ok) throw new Error(`Qdrant ${methode} ${pfad}: HTTP ${a.status} ${String(a.roh).slice(0, 160)}`);
    return a.daten;
  }

  /** Einbetten (EmbeddingGemma 2, /v1/embeddings). `art`: anfrage | dokument. */
  async einbetten(texte, art, titel = []) {
    const eingabe = texte.map((t, i) => (art === 'anfrage' ? ANFRAGE(t) : DOKUMENT(titel[i], t)));
    const a = await this.#json('POST', '/v1/embeddings', { input: eingabe }, this.embedUrl);
    if (!a.ok) throw new Error(`Einbetter HTTP ${a.status} ${String(a.roh).slice(0, 120)}`);
    const liste = [...(a.daten?.data ?? [])].sort((x, y) => x.index - y.index).map((d) => d.embedding);
    if (liste.length !== texte.length || liste.some((v) => !Array.isArray(v) || v.length !== DIM)) {
      throw new Error(`Einbetter lieferte keine ${DIM}-dimensionalen Vektoren`);
    }
    return liste;
  }

  /** Sammlung prüfen oder anlegen (einmal je Prozess). Falsche Dimension oder fehlende Vektoren = Fehler, keine Überschreibung. */
  async bereitmachen() {
    if (this._bereit) return;
    const c = `/collections/${encodeURIComponent(this.collection)}`;
    const a = await this.#json('GET', c);
    if (a.ok) {
      const v = a.daten?.result?.config?.params?.vectors?.[DENSE];
      const s = a.daten?.result?.config?.params?.sparse_vectors?.[SPARSE];
      if (v?.size !== DIM || !s) throw new Error(`Sammlung ${this.collection} hat nicht die erwartete Form (dense ${DIM}, lex); nichts verändert`);
    } else if (a.status === 404 && this.anlegenErlaubt) {
      await this.#muss('PUT', c, {
        vectors: { [DENSE]: { size: DIM, distance: 'Cosine' } },
        sparse_vectors: { [SPARSE]: { modifier: 'idf' } },
      });
      await this.#muss('PUT', `${c}/index?wait=true`, { field_name: 'agent', field_schema: { type: 'keyword', is_tenant: true } });
      for (const f of ['art', 'reife', 'quelle', 'kennung', 'tag']) {
        await this.#muss('PUT', `${c}/index?wait=true`, { field_name: f, field_schema: 'keyword' });
      }
      await this.#muss('PUT', `${c}/index?wait=true`, { field_name: 'zeit', field_schema: 'datetime' });
      await this.#muss('PUT', `${c}/index?wait=true`, { field_name: 'abgeloest', field_schema: 'bool' });
    } else {
      throw new Error(`Sammlung ${this.collection}: HTTP ${a.status} ${String(a.roh).slice(0, 120)}`);
    }
    this._bereit = true;
  }

  /** Erreichbar und von der erwarteten Form? */
  async anpingen() {
    await this.bereitmachen();
    return true;
  }

  /**
   * Ein oder mehrere Einträge einsortieren (Punkt komplett neu, auch bei einer Ablösung: dieselbe Punktkennung, die
   * Nutzlast `abgeloest` ändert sich). `eintraege`: [{agent, kennung, titel, text, nutzlast}].
   */
  async einsortieren(eintraege) {
    if (!eintraege.length) return;
    await this.bereitmachen();
    const dicht = await this.einbetten(eintraege.map((e) => e.text), 'dokument', eintraege.map((e) => e.titel));
    const punkte = eintraege.map((e, i) => ({
      id: punktId(e.agent, e.kennung),
      vector: { [DENSE]: dicht[i], [SPARSE]: sparseDokument(`${e.titel ?? ''} ${e.text}`) },
      payload: { ...e.nutzlast, agent: e.agent, kennung: e.kennung, text: e.text },
    }));
    await this.#muss('PUT', `/collections/${encodeURIComponent(this.collection)}/points?wait=true`, { points: punkte });
  }

  /**
   * Hybrid-Suche. Der Filter auf `agent` steht immer drin. Treffer: [{kennung, art, score, text, ...nutzlast}].
   * `suche`: {frage, art (Liste), von, bis (ISO), anzahl, abgeloeste}
   */
  async suchen(agent, { frage, art, von, bis, anzahl = 10, abgeloeste = false }) {
    if (!agent) throw new Error('Suche ohne Agent ist nicht erlaubt');
    await this.bereitmachen();
    const must = [{ key: 'agent', match: { value: agent } }];
    if (art?.length) must.push({ key: 'art', match: { any: art } });
    if (von || bis) must.push({ key: 'zeit', range: { ...(von ? { gte: von } : {}), ...(bis ? { lte: bis } : {}) } });
    const filter = { must, ...(abgeloeste ? {} : { must_not: [{ key: 'abgeloest', match: { value: true } }] }) };
    const [dicht] = await this.einbetten([frage], 'anfrage');
    const tiefe = Math.max(anzahl * 4, 20);
    const prefetch = [{ query: dicht, using: DENSE, limit: tiefe, filter }];
    const sp = sparseAnfrage(frage);
    if (sp.indices.length) prefetch.push({ query: sp, using: SPARSE, limit: tiefe, filter });
    const rumpf = { prefetch, query: { fusion: 'rrf' }, limit: anzahl, filter, with_payload: true, with_vector: false };
    const d = await this.#muss('POST', `/collections/${encodeURIComponent(this.collection)}/points/query`, rumpf);
    return (d?.result?.points ?? []).map((p) => ({ score: p.score, ...(p.payload ?? {}) }));
  }
}
