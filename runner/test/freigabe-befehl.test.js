import assert from 'node:assert/strict';
import { test } from 'node:test';
import { befehlFreigegeben, freigabeHinweis } from '../src/freigabe-befehl.js';
import { neueFreigabe } from '../src/documents.js';
import { wacheHooks } from '../src/persona/wache.js';
import { fyosExtension } from '../src/extension.js';
import { konfigurationLaden } from '../src/config.js';

// Besitzer 24.10.2026: nur Destruktives geht durch eine Freigabe, und es muss einen Weg geben.
const jetzt = Date.now();
const freigabe = (extra) => ({
  ...neueFreigabe({ id: 'fr-1', conversationId: 'c1', aktion: 'Branch löschen', werkzeug: 'bash', befehl: 'git branch -D alt', risiko: 'high' }),
  status: 'erteilt',
  entschieden: jetzt,
  ...extra,
});
const apiMit = (eintraege, conversationId = 'c1') => ({ conversationId, snapshot: async () => ({ eintraege }) });

test('ein erteilter Befehl ist freigegeben, auch bei anderem Leerraum', async () => {
  const api = apiMit({ 'fr-1': freigabe() });
  assert.equal(await befehlFreigegeben(api, 'git branch -D alt'), true);
  assert.equal(await befehlFreigegeben(api, '  git   branch -D   alt '), true);
});

test('anderer Befehl, andere Unterhaltung, offen, abgelehnt oder zu alt gelten nicht', async () => {
  assert.equal(await befehlFreigegeben(apiMit({ a: freigabe() }), 'git branch -D andere'), false);
  assert.equal(await befehlFreigegeben(apiMit({ a: freigabe() }, 'c2'), 'git branch -D alt'), false);
  assert.equal(await befehlFreigegeben(apiMit({ a: freigabe({ status: 'offen' }) }), 'git branch -D alt'), false);
  assert.equal(await befehlFreigegeben(apiMit({ a: freigabe({ status: 'abgelehnt' }) }), 'git branch -D alt'), false);
  assert.equal(await befehlFreigegeben(apiMit({ a: freigabe({ entschieden: jetzt - 2 * 3600 * 1000 }) }), 'git branch -D alt'), false);
  assert.equal(await befehlFreigegeben(apiMit({}), ''), false);
});

test('die Wache sperrt den Befehl, nennt den Weg und lässt ihn nach der Freigabe durch', async () => {
  const wache = wacheHooks({ cfg: konfigurationLaden({}, {}) })[0].handlers;
  const aufruf = { name: 'bash', arguments: { command: 'git branch -D alt' } };
  const gesperrt = await wache.beforeTool(aufruf, apiMit({}), {});
  assert.match(gesperrt.block, /freigabe_bitten/);
  assert.match(gesperrt.block, /git branch -D alt/);
  assert.equal(await wache.beforeTool(aufruf, apiMit({ a: freigabe() }), {}), undefined);
  // eine Freigabe für einen anderen Befehl öffnet nichts
  const anderer = { name: 'bash', arguments: { command: 'git branch -D anders' } };
  assert.ok((await wache.beforeTool(anderer, apiMit({ a: freigabe() }), {})).block);
});

test('der Hinweis nennt den genauen Befehl', () => {
  assert.match(freigabeHinweis('rm -rf $HOME'), /rm -rf \$HOME/);
  assert.match(freigabeHinweis('x'.repeat(500)), /…/);
});

test('die Erweiterung enthält die Wache und den Befehlswächter, ohne zu werfen', () => {
  const cfg = konfigurationLaden({}, {});
  const e = fyosExtension({ cfg, Lauf: undefined, laufAnlegen: undefined });
  assert.ok(e);
});
