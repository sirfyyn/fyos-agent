/**
 * models.js — Hausmodell (und optional der Ersatzdenker) über die OpenAI-kompatible Schnittstelle.
 *
 * Hausmodell läuft auf Hauptserver hinter `http://127.0.0.1:18421/v1` (Bahnen: `hausmodell`, `hausmodell-max`).
 * pi-ai bekommt dafür einen eigenen Provider je Eintrag der Kette (`pi_durable.provider_kette`); die Modelldaten stehen in
 * der Runner-Konfiguration und werden nicht aus einem fremden Katalog geraten. Fenster und Antwortgrenze kommen je
 * Provider aus der Konfiguration (Hausmodell 262144 / 16384, Ersatzdenker 65536 / 4096).
 */
import { modelleErzeugen as createModels, openaiStrom, providerErzeugen as createProvider } from './lauf/index.js';
import { praefixHuelle } from './praefix.js';
import { fehlerArt, kettenProvider } from './provider-kette.js';

const KOSTEN = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Die Beschreibung des Hausmodell-Providers, wie sie vor der Kette fest im Code stand (für Aufrufer mit alter Konfiguration). */
function rheaBeschreibung(cfg) {
  const p = cfg.pi_durable.model;
  return {
    name: p.provider,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    contextWindow: 262144,
    maxTokens: 16384,
  };
}

/**
 * Eine Modelldefinition. `provider` ist die Beschreibung aus der Kette (Fenster, Adresse); ohne sie gilt Hausmodell mit
 * den bisherigen festen Grenzen.
 */
export function modellDefinition(cfg, id, name, provider = null) {
  const p = provider ?? kettenProvider(cfg)[0] ?? rheaBeschreibung(cfg);
  return {
    id,
    name,
    api: 'openai-completions',
    provider: p.name ?? cfg.pi_durable.model.provider,
    baseUrl: p.baseUrl ?? cfg.pi_durable.model.baseUrl,
    input: ['text', 'image'],
    cost: KOSTEN,
    contextWindow: p.contextWindow ?? 262144,
    maxTokens: p.maxTokens ?? 16384,
    reasoning: false,
  };
}

/**
 * Hüllt `stream`/`streamSimple` eines Providers so, dass ein Ausfall der Kette gemeldet wird. Der Strom selbst bleibt
 * unberührt: gelesen wird nur das Endergebnis. Verbindungsfehler, Zeitüberschreitung und HTTP 5xx sperren den Provider
 * (`kette.ausfall`); andere Fehler (400, Kontextüberlauf, Abbruch) tun es nicht.
 */
export function kettenHuelle({ stream: s, streamSimple: ss }, kette, name) {
  const melden = (text) => {
    const art = fehlerArt(text);
    if (art) kette.ausfall(name, art, text);
  };
  const beobachten = (fn) => (model, context, options) => {
    let strom;
    try {
      strom = fn(model, context, options);
    } catch (fehler) {
      melden(fehler?.message ?? fehler);
      throw fehler;
    }
    Promise.resolve(strom?.result?.())
      .then((nachricht) => {
        if (nachricht?.stopReason === 'error') melden(nachricht.errorMessage);
      })
      .catch((fehler) => melden(fehler?.message ?? fehler));
    return strom;
  };
  return { stream: beobachten(s), streamSimple: beobachten(ss) };
}

/**
 * Ein `Models`-Bestand mit allen Providern der Kette. Der API-Schlüssel ist bei Hausmodell absichtlich beliebig:
 * Hausmodell prüft ihn nicht, er muss nur vorhanden sein, damit pi-ai die Anfrage stellt.
 *
 * `kette` (optional) bekommt die Ausfälle gemeldet; `basis` ersetzt die echten Stromfunktionen (Tests).
 */
export function rheaModelle(cfg, { kette = null, basis = openaiStrom } = {}) {
  const models = createModels();
  const provider = kettenProvider(cfg);
  const liste = provider.length ? provider : [{ ...rheaBeschreibung(cfg), modelId: cfg.pi_durable.model.default, maxModelId: cfg.pi_durable.model.max, anzeige: 'Hausmodell (Hauptserver)' }];
  const mitKette = Boolean(kette?.aktiv);
  for (const p of liste) {
    const istRhea = p.name === cfg.pi_durable.model.provider;
    const marke = istRhea ? 'Hausmodell' : (p.anzeige || p.name);
    const roh = mitKette ? kettenHuelle(basis, kette, p.name) : basis;
    models.setProvider(
      createProvider({
        id: p.name,
        name: istRhea ? 'Hausmodell (Hauptserver)' : marke,
        baseUrl: p.baseUrl,
        auth: {
          apiKey: {
            name: istRhea ? 'Hausmodell (lokal)' : `${marke} (lokal)`,
            async resolve() {
              return { auth: { apiKey: p.apiKey }, source: 'konfiguration' };
            },
          },
        },
        models: [
          modellDefinition(cfg, p.modelId, istRhea ? `Hausmodell (${p.modelId})` : `${marke} (${p.modelId})`, p),
          ...(p.maxModelId && p.maxModelId !== p.modelId
            ? [modellDefinition(cfg, p.maxModelId, istRhea ? `Hausmodell (${p.maxModelId}, Vorfahrt)` : `${marke} (${p.maxModelId}, Vorfahrt)`, p)]
            : []),
        ].filter((m, i, alle) => alle.findIndex((x) => x.id === m.id) === i),
        api: {
          // Fester Systemkopf: Abschnittsänderungen gehen an ihre Stelle im Gespräch statt an den Anfang (praefix.js).
          'openai-completions': praefixHuelle(roh),
        },
      }),
    );
  }
  return models;
}

/** Der pi-durable ModelRef für eine Bahn. */
export function modellRef(cfg, art = 'hintergrund') {
  const bahn = cfg.bahnen?.[art] ?? cfg.bahnen?.hintergrund ?? {};
  return {
    provider: bahn.provider || cfg.pi_durable.model.provider,
    modelId: bahn.modelId || (art === 'max' ? cfg.pi_durable.model.max : cfg.pi_durable.model.default),
  };
}

/**
 * Die im Client anwählbaren Modelle (Name + Kennung). Rheas Zeilen sind unverändert; jeder weitere Provider der Kette
 * (Ersatzdenker) bringt eine eigene Zeile.
 */
export function modellListe(cfg) {
  const p = cfg.pi_durable.model;
  const ids = [...new Set([p.default, p.max])];
  // Lokaler Modus: das Modell des Nutzers, nicht Hausmodell.
  const marke = cfg.pi_durable.lokal === true ? 'Lokales Modell' : 'Hausmodell';
  const rheaFenster = fensterFuerModell(cfg, { provider: p.provider });
  const hausmodell = ids.map((id) => ({
    id,
    provider: p.provider,
    name: id === p.max ? `${marke} (${id}, Vorfahrt)` : `${marke} (${id})`,
    max: id === p.max,
    contextWindow: rheaFenster,
  }));
  const weitere = kettenProvider(cfg)
    .filter((q) => q.name !== p.provider)
    .map((q) => ({
      id: q.modelId,
      provider: q.name,
      name: `${q.anzeige || q.name} (${q.modelId})`,
      max: false,
      contextWindow: fensterFuerModell(cfg, { provider: q.name }),
    }));
  return [...hausmodell, ...weitere.filter((w) => !hausmodell.some((r) => r.id === w.id))];
}

/**
 * Das Kontextfenster (Token) eines Modells der Kette: zuerst nach Provider, dann nach Modellname; ohne Angabe oder ohne Treffer das
 * des ersten Providers (Hausmodell). Dieselbe Zahl, die modellDefinition() dem Modell gibt (Hausmodell 262144, Ersatzdenker 65536).
 */
export function fensterFuerModell(cfg, ref) {
  const liste = kettenProvider(cfg);
  const p =
    liste.find((q) => ref?.provider && q.name === ref.provider) ??
    liste.find((q) => ref?.modelId && (q.modelId === ref.modelId || q.maxModelId === ref.modelId)) ??
    liste[0];
  const fenster = Number(p?.contextWindow);
  return Number.isFinite(fenster) && fenster > 0 ? fenster : rheaBeschreibung(cfg).contextWindow;
}
