/**
 * freigabe-befehl.js — ein zerstörender Befehl geht durch eine Freigabe.
 *
 * Besitzer, 24.10.2026: „nur destruktives soll durch eine freigabe gehen“. Heißt: Es gibt einen Weg dafür.
 * Der Agent ruft `freigabe_bitten(aktion, werkzeug: 'bash', befehl: '<genau dieser Befehl>')`, ein Mensch
 * entscheidet im Client, danach läuft derselbe Befehl durch. Gilt für dieses Gespräch und eine Stunde,
 * nur für genau diese Zeichenkette (die Hooks dürfen nicht schreiben, ein Verbrauchen ist darum nicht
 * möglich; die Frist und der genaue Wortlaut begrenzen es).
 */
import { KONTEXT } from './lauf/index.js';
import { Freigaben } from './documents.js';
import { tx } from './i18n.js';

const FRIST_MS = 60 * 60 * 1000;
const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');

/** Ist für diesen Befehl in diesem Gespräch eine Freigabe erteilt? */
export async function befehlFreigegeben(api, befehl, context = KONTEXT) {
  const gesucht = norm(befehl);
  if (!gesucht) return false;
  const doc = await Promise.resolve(api?.snapshot?.(Freigaben, context)).catch(() => null);
  const jetzt = Date.now();
  return Object.values(doc?.eintraege ?? {}).some(
    (f) =>
      f.status === 'erteilt' &&
      f.conversationId === api.conversationId &&
      f.befehl &&
      norm(f.befehl) === gesucht &&
      jetzt - Number(f.entschieden ?? 0) <= FRIST_MS,
  );
}

/** Der Satz, den der Agent bei einer Sperre bekommt: genau der Weg, wie es doch geht. */
export function freigabeHinweis(befehl) {
  const kurz = String(befehl ?? '').length > 160 ? `${String(befehl).slice(0, 160)}…` : String(befehl ?? '');
  return tx(
    `Zerstörend, darum mit Freigabe: rufe freigabe_bitten(aktion, kontext: <3–5 Sätze: was und wo, warum jetzt, Wirkung, Risiko, Rückweg>, werkzeug: "bash", befehl: <genau dieser Befehl>) auf ` +
      `(Befehl: ${kurz}). Sobald ein Mensch zugestimmt hat, führe denselben Befehl noch einmal aus; er läuft dann durch.`,
    `Destructive, so it needs an approval: call freigabe_bitten(aktion, kontext: <3–5 sentences: what and where, why now, effect, risk, way back>, werkzeug: "bash", befehl: <exactly this command>) ` +
      `(command: ${kurz}). As soon as a human has approved, run the same command again; it will then go through.`,
  );
}
