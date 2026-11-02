/**
 * lauf/pi-ai.js — Adapter zu @earendil-works/pi-ai (nur dieser Ort in src/ importiert das Paket).
 *
 * Modelle, Provider und das Streaming gegen die OpenAI-kompatible Schnittstelle (Hausmodell, Katy, Ersatzdenker),
 * dazu das Werkzeug-Schema (`Type`, TypeBox, von pi-ai durchgereicht) und die Darstellung einer
 * Systemnachricht, die sich im Verlauf geändert hat.
 */
import { Type } from '@earendil-works/pi-ai';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { stream, streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { renderSystemMessageUpdate } from '@earendil-works/pi-ai/utils/text';

/**
 * Schema-Bausteine für Werkzeugparameter (`Schema.Object({...})`). Heute TypeBox; die Form der
 * Werkzeug-Schemata ist damit Teil der Naht, nicht der Aufrufer.
 */
export const Schema = Type;

/** Die Stromfunktionen der OpenAI-kompatiblen Schnittstelle: `{ stream, streamSimple }`. */
export const openaiStrom = { stream, streamSimple };

/** Leeren Modellbestand anlegen; Provider kommen mit `.setProvider(providerErzeugen({...}))` hinein (Form von pi-ai). */
export function modelleErzeugen() {
  return createModels();
}

/** Einen Provider beschreiben: `{ name, baseUrl, apiKey, models, stream, streamSimple, … }` (Form von pi-ai). */
export function providerErzeugen(beschreibung) {
  return createProvider(beschreibung);
}

/** Der Text, mit dem pi-ai eine spätere Änderung einer Systemnachricht darstellt (Präfix-Hülle, praefix.js). */
export function systemAenderungText(nachricht) {
  return renderSystemMessageUpdate(nachricht);
}
