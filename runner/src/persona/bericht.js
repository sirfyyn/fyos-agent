/**
 * persona/bericht.js — Abschlussbericht einer Hintergrundaufgabe in festen Feldern (Plan S8/S9).
 *
 * Port von `persona-bericht` (kern.ts + index.ts). Das Werkzeug `persona_bericht` legt die Felder in
 * `felder.json` ab und beendet den Zug (`control.terminate`). Die Ablage ist dieselbe wie im alten
 * Runner: `$FYOS_BERICHTE_DIR`, Vorgabe `/var/lib/fyos-agent/berichte`.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Schema as Type, werkzeug as defineTool } from '../lauf/index.js';

export const GRENZEN = {
  ueberschrift: 120,
  befund: 1200,
  beleg: 400,
  rueckweg: 300,
  naechster_schritt: 300,
};

/** Prüft die Felder: Überschrift und Befund sind Pflicht, die übrigen optional. Leere Felder fallen weg. */
export function berichtPruefen(eingabe) {
  if (!eingabe || typeof eingabe !== 'object') throw new Error('Kein Bericht übergeben.');
  const felder = {};
  for (const [name, grenze] of Object.entries(GRENZEN)) {
    const wert = eingabe[name];
    if (wert === undefined || wert === null) continue;
    if (typeof wert !== 'string') throw new Error(`${name} muss Text sein.`);
    const sauber = wert.trim();
    if (!sauber) continue;
    if (sauber.length > grenze) throw new Error(`${name}: höchstens ${grenze} Zeichen.`);
    felder[name] = sauber;
  }
  if (!felder.ueberschrift) throw new Error('ueberschrift fehlt.');
  if (!felder.befund) throw new Error('befund fehlt.');
  return felder;
}

/** Form des Eintrags in felder.json. Die Kennung macht jeden Bericht einmalig lesbar. */
export function berichtEintrag(felder, sitzung, jetztMs) {
  const sauber = String(sitzung ?? '').replace(/[^A-Za-z0-9_-]/g, '') || 'unbekannt';
  return { id: `${sauber}-${jetztMs}`, zeit_ms: jetztMs, felder };
}

export function berichtWerkzeuge({ env = process.env, jetzt = Date.now } = {}) {
  const ablage = () => env.FYOS_BERICHTE_DIR || '/var/lib/fyos-agent/berichte';

  const bericht = defineTool({
    name: 'persona_bericht',
    description:
      'Legt den Abschlussbericht dieser Aufgabe in festen Feldern ab und beendet die Aufgabe. ' +
      'Pflicht: ueberschrift, befund. Optional: beleg, rueckweg, naechster_schritt. Nutze es zum Schluss, nicht vorher.',
    parameters: Type.Object({
      ueberschrift: Type.String({ description: 'Worum es ging, ein Satz' }),
      befund: Type.String({ description: 'Was herausgekommen ist' }),
      beleg: Type.Optional(Type.String({ description: 'Wo man es nachsehen kann (Pfad, Link, Kennung)' })),
      rueckweg: Type.Optional(Type.String({ description: 'Wie man es zurücknimmt, falls nötig' })),
      naechster_schritt: Type.Optional(Type.String({ description: 'Was als Nächstes ansteht' })),
    }),
    // Die Zeit wird gemerkt: ein Wiederholen nach einem Absturz schreibt denselben Eintrag, keinen zweiten.
    replay: 'safe',
    execute: async (args, api, context) => {
      const felder = berichtPruefen(args);
      const zeit = typeof api?.memo === 'function' ? await api.memo('bericht_zeit', jetzt(), context) : jetzt();
      const eintrag = berichtEintrag(felder, api?.conversationId ?? '', zeit);
      const dir = ablage();
      mkdirSync(dir, { recursive: true });
      const ziel = join(dir, 'felder.json');
      const tmp = `${ziel}.tmp`;
      writeFileSync(tmp, JSON.stringify(eintrag));
      renameSync(tmp, ziel);
      return {
        output: [{ type: 'text', text: 'Bericht abgelegt.' }],
        details: eintrag,
        control: { terminate: true },
      };
    },
  });

  return [bericht];
}
