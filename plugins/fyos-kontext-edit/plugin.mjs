// OpenClaw-Anbindung des Kontext-Edit-Versuchs (04.10.2026), Logik in kern.mjs.
// - Werkzeug kontext_bearbeiten (Factory, nur im Arm 'edit' sichtbar; sonst null = ausgeblendet)
// - Context Engine 'fyos-kontext-edit' (ownsCompaction false, compact delegiert an die Standardkompaktion):
//   assemble() markiert Werkzeugergebnisse mit [#wN] und wendet offene Edits als Projektion an,
//   maintain() schreibt sie dauerhaft ins Transkript (runtimeContext.rewriteTranscriptEntries).
// - Protokoll je Zug als JSONL (Arm, geschätzte Token, Edits, freigegebene Bytes) für das A/B gegen die Kompaktion.
// Ohne `aktiv: true` verhält sich die Engine wie durchgereicht (keine Markierung, kein Werkzeug).

import {appendFile} from 'node:fs/promises';
import {ANLEITUNG, AUFTRAG, alsErledigt, arm, auftragFaellig, bearbeite, ersatzPlan, markiere, neuerZustand, schaetzeTokens} from './kern.mjs';

export const ENGINE_ID = 'fyos-kontext-edit';
export const WERKZEUG = 'kontext_bearbeiten';

const PARAMETER = {
  type: 'object',
  properties: {
    aktion: {type: 'string', enum: ['loeschen', 'ersetzen']},
    ziele: {type: 'array', items: {type: 'string'}, description: 'Kennungen der Werkzeugergebnisse, z. B. w3'},
    text: {type: 'string', description: 'Zusammenfassung (nur bei ersetzen); alles Nötige wörtlich übernehmen'},
  },
  required: ['aktion', 'ziele'],
  additionalProperties: false,
};

export function registerKontextEdit(api, abhaengigkeiten = {}) {
  const cfg = abhaengigkeiten.config ?? api.pluginConfig ?? {};
  const aktiv = cfg.aktiv === true;
  const anteil = typeof cfg.editAnteil === 'number' ? cfg.editAnteil : 0.5;
  const protokoll = cfg.protokoll || null;
  // Standard „spontan“ — der Agent entscheidet selbst, wann sie bereinigt (0 = nie verlangen).
  // Der Auftrag des Harness (z. B. 0.6) bleibt per Konfiguration möglich; Messung: Auftrag 4/4, spontan 1/10.
  const auftragAb = typeof cfg.auftragAb === 'number' ? cfg.auftragAb : 0;
  const budgetErsatz = typeof cfg.budget === 'number' ? cfg.budget : 0;        // falls der Host kein tokenBudget liefert
  const delegiere = abhaengigkeiten.delegateCompactionToRuntime;
  const leseEintraege = abhaengigkeiten.readVisibleSessionTranscriptMessageEntries;
  const zustaende = new Map();   // sessionKey -> Zustand
  const zustand = (k) => { if (!zustaende.has(k)) zustaende.set(k, neuerZustand()); return zustaende.get(k); };
  const imVersuch = (k) => aktiv && arm(k, anteil) === 'edit';

  async function schreibe(zeile) {
    if (!protokoll) return;
    try { await appendFile(protokoll, JSON.stringify({zeit: new Date().toISOString(), ...zeile}) + '\n'); }
    catch (fehler) { api.logger?.warn?.(`fyos-kontext-edit: Protokoll nicht geschrieben (${String(fehler?.message ?? fehler).slice(0, 160)})`); }
  }

  api.registerTool((ctx) => {
    const k = ctx?.sessionKey;
    if (!k || !imVersuch(k)) return null;
    return {
      name: WERKZEUG,
      label: 'Kontext bearbeiten',
      description: 'Löscht frühere Werkzeugergebnisse [#wN] aus deinem Verlauf oder ersetzt sie durch eine kurze Zusammenfassung.',
      parameters: PARAMETER,
      async execute(_id, params) {
        const r = bearbeite(zustand(k), params);
        await schreibe({art: 'werkzeug', sessionKey: k, ok: r.ok, aktion: params?.aktion, ziele: params?.ziele,
          textZeichen: typeof params?.text === 'string' ? params.text.length : 0});
        return {content: [{type: 'text', text: r.text}], details: {ok: r.ok}};
      },
    };
  }, {name: WERKZEUG, optional: true});

  // Der Host (OpenClaw 10/2026) nimmt eine Engine nur noch an, wenn sie Turn-Zaun und idempotentes
  // commitTurn erklärt; sonst fällt er je Zug auf „legacy“ zurück. Die Engine speichert selbst keine
  // Nachrichten (das Transkript bleibt beim Host), commitTurn merkt sich deshalb nur den Schlüssel.
  const verbucht = new Set();
  const VERBUCHT_MAX = 5000;

  api.registerContextEngine(ENGINE_ID, () => ({
    info: {id: ENGINE_ID, name: 'FYOS Kontext-Edit', version: '2026.10.6', ownsCompaction: false,
      acceptedHostParams: ['sessionKey', 'runtimeContext'],
      transcriptSemantics: {currentTurnFence: 'before-current-turn-entry-v1', turnAdvancementIdempotency: 'atomic-idempotent-v1'}},
    async ingest() { return {ingested: true}; },
    async commitTurn({advancementKey} = {}) {
      if (advancementKey == null) return {status: 'committed'};
      if (verbucht.has(advancementKey)) return {status: 'duplicate'};
      if (verbucht.size >= VERBUCHT_MAX) verbucht.delete(verbucht.values().next().value);
      verbucht.add(advancementKey);
      return {status: 'committed'};
    },
    async assemble({messages, sessionKey, tokenBudget}) {
      const geschaetzt = schaetzeTokens(messages);
      if (!imVersuch(sessionKey)) {
        await schreibe({art: 'zug', sessionKey, arm: aktiv ? 'kontrolle' : 'aus', token: geschaetzt});
        return {messages, estimatedTokens: geschaetzt};
      }
      const z = zustand(sessionKey);
      const projiziert = markiere(messages, z);
      const token = schaetzeTokens(projiziert);
      const budget = tokenBudget > 0 ? tokenBudget : budgetErsatz;
      const auftrag = auftragFaellig(z, token, budget, auftragAb);
      await schreibe({art: 'zug', sessionKey, arm: 'edit', token, tokenOhneEdit: geschaetzt, budget, offen: z.offen.size, auftrag});
      return {messages: projiziert, estimatedTokens: token, systemPromptAddition: auftrag ? `${ANLEITUNG}\n\n${AUFTRAG}` : ANLEITUNG};
    },
    async maintain({sessionKey, sessionId, sessionTarget, runtimeContext}) {
      const leer = {changed: false, bytesFreed: 0, rewrittenEntries: 0};
      if (!imVersuch(sessionKey)) return {...leer, reason: 'nicht im Versuch'};
      const z = zustand(sessionKey);
      const offen = [...z.offen.keys()].filter((id) => !z.erledigt.has(id));
      if (!offen.length) return {...leer, reason: 'keine offenen Edits'};
      if (!runtimeContext?.rewriteTranscriptEntries || !leseEintraege) return {...leer, reason: 'Rewrite nicht verfügbar'};
      let eintraege;
      try {
        eintraege = await leseEintraege({...(sessionTarget ?? {}), sessionKey, sessionId});
      } catch (fehler) {
        api.logger?.warn?.(`fyos-kontext-edit: Transkript nicht lesbar (${String(fehler?.message ?? fehler).slice(0, 160)})`);
        return {...leer, reason: 'Transkript nicht lesbar'};
      }
      const plan = ersatzPlan(eintraege, z);
      if (!plan.length) { offen.forEach((id) => z.erledigt.add(id)); return {...leer, reason: 'schon angewandt'}; }
      const r = await runtimeContext.rewriteTranscriptEntries({replacements: plan.map(({entryId, message}) => ({entryId, message}))});
      if (r?.changed) alsErledigt(z, plan);
      await schreibe({art: 'rewrite', sessionKey, eintraege: plan.length, geaendert: !!r?.changed,
        bytesFrei: r?.bytesFreed ?? 0, zeichenVorher: plan.reduce((s, p) => s + p.zeichenVorher, 0), grund: r?.reason});
      return r ?? leer;
    },
    async compact(params) {
      await schreibe({art: 'kompaktion', sessionKey: params?.sessionKey, arm: imVersuch(params?.sessionKey) ? 'edit' : 'kontrolle'});
      return delegiere(params);
    },
  }));
}
