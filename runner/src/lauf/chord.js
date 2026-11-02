/**
 * lauf/chord.js — Adapter zu @earendil-works/chord (nur dieser Ort in src/ importiert das Paket).
 *
 * chord liefert dem Runner genau eines: den Ausführungskontext, unter dem pi-durable Aufrufe
 * des Harness stattfinden. Der Runner ist ein Hintergrunddienst ohne Benutzerkontext.
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

/** Der Kontext, den jeder Harness-Aufruf des Runners mitführt (pi-durable: `BACKGROUND_CONTEXT`). */
export const KONTEXT = BACKGROUND_CONTEXT;
