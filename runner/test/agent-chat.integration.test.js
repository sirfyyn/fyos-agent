/**
 * Integrationstest des nativen Agent-Chats (apps/fyos-agent/ui/agent-chat.html) gegen einen EIGENEN Runner mit Faux-Modell
 * auf 127.0.0.1 (test/hilfen/agent-chat-pruefstand.js). Die Seite läuft in jsdom und lädt ihre echten Skripte.
 * Geprüft: Normalpfad ohne Freigabe (Werkzeuge, Diff), Pfad "Runner verlangt Freigabe" (erteilen und ablehnen wirkt im Runner),
 * Reset und Verdichtung (Marker, Verlauf bleibt sichtbar), Neuverbinden mitten im Strom (Inhalt vollständig, nichts doppelt),
 * und überall: 0 Neubauten des fertigen Teils (keine entfernten Elemente im Verlauf).
 * jsdom: FYOS_JSDOM_DIR (Ordner mit node_modules/jsdom); fehlt es, werden die Tests übersprungen.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai';
import { starte } from './hilfen/agent-chat-pruefstand.js';

function findeJsdom() {
  for (const k of [process.env.FYOS_JSDOM_DIR, '/Users/besitzer/fyos-c-web/fyos-web'].filter(Boolean)) {
    try {
      return createRequire(join(k, 'x.js'))('jsdom');
    } catch {
      /* nächster */
    }
  }
  return null;
}
const jsdom = findeJsdom();
const it = (name, fn) => test(name, { skip: jsdom ? false : 'jsdom nicht gefunden (FYOS_JSDOM_DIR setzen)', timeout: 90000 }, fn);
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
async function bis(fn, { ms = 20000, was = 'Bedingung' } = {}) {
  const ende = Date.now() + ms;
  let letzter;
  while (Date.now() < ende) {
    try {
      const w = await fn();
      if (w) return w;
    } catch (f) {
      letzter = f;
    }
    await warte(60);
  }
  throw new Error(`Zeit abgelaufen: ${was}${letzter ? ` (${letzter.message})` : ''}`);
}

const fenster = [];
after(() => fenster.forEach((w) => w.close()));

/** Die echte Chat-Seite laden; fetch und AbortController kommen von Node (jsdom hat keine). */
async function oeffneSeite(basis) {
  const dom = await jsdom.JSDOM.fromURL(`${basis}/agent-chat.html`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = (u, o) => fetch(new URL(u, basis), o);
      w.AbortController = AbortController;
      w.TextDecoder = TextDecoder;
    },
  });
  const w = dom.window;
  fenster.push(w);
  await bis(() => w.__chat && w.__chat.S.id !== null, { was: 'Seite gestartet' });
  const d = w.document;
  const spalte = d.getElementById('spalte');
  const beobachter = new w.MutationObserver(() => {});
  beobachter.observe(spalte, { childList: true, subtree: true });
  let entfernt = 0;
  return {
    w,
    d,
    spalte,
    chat: w.__chat,
    /** Seit dem letzten Aufruf entfernte Elemente im Verlauf (ein Neuaufbau wäre hier sichtbar). */
    entfernte() {
      for (const r of beobachter.takeRecords()) entfernt += [...r.removedNodes].filter((n) => n.nodeType === 1).length;
      return entfernt;
    },
    async tippe(text, absenden = true) {
      const t = d.getElementById('eingabe');
      t.value = text;
      t.dispatchEvent(new w.Event('input', { bubbles: true }));
      if (absenden) d.getElementById('eingabeForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    },
    text: () => spalte.textContent,
    zaehle: (sel) => spalte.querySelectorAll(sel).length,
  };
}
const erstesGespraech = async (ps) => (await ps.runner.gespraeche()).find((g) => g.art === 'root');
const SCHREIB = (arbeit) => join(arbeit, 'a.txt');

it('Normalpfad ohne Freigabe: Denken, Text, Werkzeuge, Diff; 0 Neubauten; Neuladen zeigt dasselbe vollständig', async () => {
  const ps = await starte({ tokensProSekunde: 80 });
  try {
    const datei = SCHREIB(ps.arbeit);
    ps.faux.setResponses([
      fauxAssistantMessage([fauxThinking('Ich lege die Datei an.'), fauxText('Ich schreibe **zwei** Zeilen:\n\n- eins\n- zwei\n'), fauxToolCall('write', { path: datei, content: 'hallo\nwelt\n' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('edit', { path: datei, edits: [{ oldText: 'welt', newText: 'Welt' }] })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('bash', { command: `cat ${datei}` })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Fertig: die Datei steht.'),
    ]);
    const s = await oeffneSeite(ps.basis);
    s.entfernte();
    await s.tippe('Leg a.txt an');
    await bis(() => s.zaehle('.zugfuss') === 1, { was: 'Zug fertig' });
    assert.equal(s.zaehle('.mensch'), 1);
    assert.equal(s.zaehle('.freigabe'), 0, 'Normalpfad: keine Freigabe-Leiste');
    assert.equal(s.zaehle('.karte'), 3);
    assert.equal(s.zaehle('.diff'), 2, 'write und edit zeigen einen Diff');
    const editDiff = [...s.spalte.querySelectorAll('.karte')].find((k) => k.dataset.art === 'edit' && k.querySelector('.tok-add, tr.del'));
    assert.ok(editDiff, 'Edit-Karte mit Diff');
    assert.equal(s.spalte.querySelectorAll('.karte')[1].querySelectorAll('tr.del').length, 1);
    assert.match(s.spalte.querySelectorAll('.karte')[2].querySelector('.ausgabe-pre').textContent, /hallo\nWelt/);
    assert.match(s.text(), /Fertig: die Datei steht\./);
    // gestreamt (80 Token/s) kommt der Text genau einmal und ohne Lücke an (Regression: erste Token in message_start)
    const texte = [...s.spalte.querySelectorAll('.zug > .text')].map((x) => x.textContent.replace(/\s+/g, ' ').trim());
    assert.equal(texte[0], 'Ich schreibe zwei Zeilen:eins zwei'.replace('eins zwei', 'eins' + 'zwei'));
    assert.equal(texte[1], 'Fertig: die Datei steht.');
    assert.equal(s.zaehle('.denken'), 1);
    assert.equal(s.zaehle('li'), 2);
    assert.equal(s.entfernte(), 0, 'Neubauten des fertigen Teils');
    assert.equal(s.d.getElementById('zustandText').textContent, 'bereit');
    const vorher = { karten: s.zaehle('.karte'), diffs: s.zaehle('.diff'), antwort: [...s.spalte.querySelectorAll('.text')].pop().textContent };

    // Neu laden = frische Seite: der Verlauf kommt aus dem Runner vollständig zurück
    const s2 = await oeffneSeite(ps.basis);
    await bis(() => s2.zaehle('.zugfuss') === 1, { was: 'Verlauf geladen' });
    assert.equal(s2.zaehle('.karte'), vorher.karten);
    assert.equal(s2.zaehle('.diff'), vorher.diffs);
    assert.equal(s2.zaehle('.mensch'), 1);
    assert.match(s2.text(), /Fertig: die Datei steht\./);
    assert.equal(s2.zaehle('.denken'), 1);
    assert.equal(s2.entfernte(), 0);
  } finally {
    await ps.stopp();
  }
});

const BEFEHL = 'git push --force origin main';
function freigabeSkript(ps, danach) {
  ps.faux.setResponses([
    fauxAssistantMessage([fauxText('Ich versuche es.'), fauxToolCall('bash', { command: BEFEHL })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('freigabe_bitten', { aktion: 'Force-Push auf main', risiko: 'high', kontext: 'Überschreibt main auf dem Server. Wirkung: die Historie ändert sich. Rückweg: alten Stand per Reflog wiederherstellen.', werkzeug: 'bash', befehl: BEFEHL })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Ich warte auf deine Entscheidung.'),
    ...danach,
  ]);
}

it('Runner verlangt Freigabe: Leiste mit Befehl, Erteilen wirkt im Runner und die Antwort geht weiter', async () => {
  const ps = await starte({});
  try {
    freigabeSkript(ps, [fauxAssistantMessage([fauxToolCall('bash', { command: BEFEHL })], { stopReason: 'toolUse' }), fauxAssistantMessage('Erledigt.')]);
    const s = await oeffneSeite(ps.basis);
    s.entfernte();
    await s.tippe('Push bitte');
    await bis(() => s.zaehle('.freigabe[data-zustand="offen"]') === 1, { was: 'Freigabe-Leiste' });
    // Der Runner beendet den Zug nach der Bitte: die Leiste muss das Zugende überleben und darf nichts von selbst entscheiden
    await bis(() => s.zaehle('.zugfuss') === 1, { was: 'Zug nach der Bitte beendet' });
    await warte(400);
    assert.equal(s.zaehle('.freigabe[data-zustand="offen"]'), 1, 'Leiste bleibt offen');
    assert.equal((await ps.runner.freigaben())[0].status, 'offen', 'der Runner wurde nicht ungefragt entschieden');
    const box = s.spalte.querySelector('.freigabe');
    assert.match(box.querySelector('.fz-frage').textContent, /Force-Push auf main/);
    assert.match(box.querySelector('.fz-frage').textContent, /git push --force origin main/, 'Befehl sichtbar');
    assert.equal(box.dataset.risiko, 'high');
    assert.deepEqual([...box.querySelectorAll('.fz-knoepfe button')].map((b) => b.textContent.replace(/\s+/g, ' ').trim()), ['Erlauben 1', 'Ablehnen 2']);
    assert.equal(s.d.getElementById('zustandText').textContent, 'wartet auf dich');
    assert.equal(s.zaehle('.karte[data-art="bash"]') >= 1, true, 'die Sperre des Befehlswächters ist als Karte sichtbar');
    const offen = (await ps.runner.freigaben()).filter((f) => f.status === 'offen');
    assert.equal(offen.length, 1);
    box.querySelector('input.fz-notiz').value = 'nur dieses eine Mal';
    box.querySelector('.fz-knoepfe button.primaer').click();
    await bis(async () => (await ps.runner.freigaben())[0]?.status === 'erteilt', { was: 'Runner kennt die Erteilung' });
    const f = (await ps.runner.freigaben())[0];
    assert.equal(f.notiz, 'nur dieses eine Mal');
    assert.equal(f.entschiedenVon ?? 'mensch', 'mensch');
    await s.tippe('Weiter');
    await bis(() => /Erledigt\./.test(s.text()), { was: 'Antwort nach der Freigabe' });
    assert.equal(box.dataset.zustand, 'erlaubt');
    assert.match(box.querySelector('.fz-ergebnis').textContent, /nur dieses eine Mal/);
    assert.equal(s.entfernte(), 0, 'Neubauten des fertigen Teils');

    // frische Seite: die entschiedene Freigabe erscheint entschieden, nicht wieder offen
    const s2 = await oeffneSeite(ps.basis);
    await bis(() => /Erledigt\./.test(s2.text()), { was: 'Verlauf geladen' });
    assert.equal(s2.zaehle('.freigabe[data-zustand="offen"]'), 0);
    assert.equal(s2.zaehle('.freigabe[data-zustand="erlaubt"]'), 1);
  } finally {
    await ps.stopp();
  }
});

it('Runner verlangt Freigabe: Ablehnen (Taste 2) wirkt im Runner, der Agent schlägt Alternative vor', async () => {
  const ps = await starte({});
  try {
    freigabeSkript(ps, [fauxAssistantMessage('Dann lasse ich es.')]);
    const s = await oeffneSeite(ps.basis);
    await s.tippe('Push bitte');
    await bis(() => s.zaehle('.freigabe[data-zustand="offen"]') === 1, { was: 'Freigabe-Leiste' });
    assert.equal(s.chat.view.handleKey({ key: '2', preventDefault() {} }), true);
    await bis(async () => (await ps.runner.freigaben())[0]?.status === 'abgelehnt', { was: 'Runner kennt die Ablehnung' });
    await s.tippe('Weiter');
    await bis(() => /Dann lasse ich es\./.test(s.text()), { was: 'Antwort nach Ablehnung' });
    assert.equal(s.spalte.querySelector('.freigabe').dataset.zustand, 'abgelehnt');
    assert.equal(s.zaehle('.karte[data-art="bash"]'), 1, 'der Befehl lief nicht noch einmal');
  } finally {
    await ps.stopp();
  }
});

it('Reset und Verdichtung: Marker, der Verlauf davor bleibt sichtbar (auch nach Neuladen)', async () => {
  const ps = await starte({});
  try {
    ps.faux.setResponses([fauxAssistantMessage('Erste Antwort.'), fauxAssistantMessage('Zweite Antwort.'), fauxAssistantMessage('Zusammenfassung des bisherigen Gesprächs.'), fauxAssistantMessage('Dritte Antwort.')]);
    const s = await oeffneSeite(ps.basis);
    s.entfernte();
    await s.tippe('Eins');
    await bis(() => s.zaehle('.zugfuss') === 1, { was: 'Antwort 1' });
    await s.tippe('Zwei');
    await bis(() => s.zaehle('.zugfuss') === 2, { was: 'Antwort 2' });
    await s.tippe('/verdichten');
    await bis(() => /wird verdichtet/.test(s.text()), { was: 'Hinweiszeile Verdichten' });
    await s.tippe('/leeren');
    await bis(() => s.zaehle('.marker[data-kind="pi.reset"]') === 1, { was: 'Reset-Marker' });
    assert.match(s.text(), /Erste Antwort\./);
    assert.match(s.text(), /Zweite Antwort\./);
    assert.equal(s.entfernte(), 0, 'Neubauten des fertigen Teils');
    // Neuladen: ?voll=1 bringt den Verlauf vor den Markern zurück
    const s2 = await oeffneSeite(ps.basis);
    await bis(() => s2.zaehle('.marker[data-kind="pi.reset"]') === 1, { was: 'Verlauf geladen' });
    assert.match(s2.text(), /Erste Antwort\./);
    assert.equal(s2.zaehle('.mensch'), 2);
    assert.match(s2.text(), /Zweite Antwort\./);
  } finally {
    await ps.stopp();
  }
});

it('Neuverbinden mitten im Strom: Inhalt vollständig, nichts doppelt, fertiger Teil bleibt derselbe Knoten', async () => {
  const ps = await starte({ tokensProSekunde: 40 });
  try {
    const satz = 'Dies ist ein langer Satz, der langsam gestreamt wird, damit die Verbindung mittendrin abreißen kann. ';
    const text = satz.repeat(4).trim();
    ps.faux.setResponses([fauxAssistantMessage([fauxText(text)])]);
    const s = await oeffneSeite(ps.basis);
    s.entfernte();
    await s.tippe('Erzähl');
    await bis(() => s.zaehle('.text') === 1 && s.spalte.querySelector('.text').textContent.length > 20, { was: 'Text beginnt' });
    const zug = s.spalte.querySelector('.zug');
    const textKnoten = s.spalte.querySelector('.text');
    const mensch = s.spalte.querySelector('.mensch');
    const teilVorher = textKnoten.textContent.length;
    ps.kappeStrome();
    await bis(() => /getrennt/.test(s.d.getElementById('zustandText').textContent) || !s.d.getElementById('banner').hidden, { was: 'Trennung angezeigt', ms: 8000 }).catch(() => {});
    await bis(() => s.zaehle('.zugfuss') === 1, { ms: 40000, was: 'Zug fertig nach Neuverbinden' });
    assert.ok(teilVorher < text.length, 'der Abbruch kam vor dem Ende');
    assert.equal(s.spalte.querySelector('.text').textContent.replace(/\s+/g, ' ').trim(), text, 'Text vollständig und genau einmal');
    assert.equal(s.zaehle('.zug'), 1);
    assert.equal(s.zaehle('.text'), 1);
    assert.equal(s.zaehle('.mensch'), 1);
    assert.ok(zug.isConnected && textKnoten.isConnected && mensch.isConnected, 'fertige Teile sind noch dieselben Knoten');
    assert.equal(s.entfernte(), 0, 'Neubauten des fertigen Teils');
    assert.equal(s.d.getElementById('banner').hidden, true, 'Trennungsanzeige ist wieder weg');
  } finally {
    await ps.stopp();
  }
});
