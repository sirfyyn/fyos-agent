#!/usr/bin/env node
/**
 * fyos-agent.mjs — Terminal-Client für den dauerhaften FYOS-Runner.
 *
 *   node scripts/fyos-agent.mjs [--url http://127.0.0.1:18438] [--token …] [--aus]
 *
 * Verbunden siehst du sofort den Strom der autonomen Arbeit (Live ist die Voreinstellung).
 *   /live [an|aus]   Strom ein- oder ausblenden (der Agent arbeitet unverändert weiter)
 *   /fokus [nr|text] Gespräch wählen, an das du schreibst (ohne Argument: Liste)
 *   /hilfe           diese Hilfe        /ende  beenden
 * Alles andere geht als Nachricht an das Fokus-Gespräch. Schreiben ändert nur den Fokus.
 * Das Token kommt aus --token, FYOS_RUNNER_TOKEN oder ~/.fyos/runner/token.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

const arg = (name, vorgabe) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : vorgabe;
};
const URL_BASIS = String(arg('--url', process.env.FYOS_RUNNER_URL ?? 'http://127.0.0.1:18438')).replace(/\/+$/, '');

function token() {
  const t = arg('--token', process.env.FYOS_RUNNER_TOKEN);
  if (t) return t;
  try {
    return readFileSync(`${homedir()}/.fyos/runner/token`, 'utf8').trim();
  } catch {
    return '';
  }
}
const TOKEN = token();

const kopf = () => ({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' });
const api = async (pfad, opt = {}) => {
  const r = await fetch(URL_BASIS + pfad, { ...opt, headers: { ...kopf(), ...(opt.headers ?? {}) } });
  const daten = await r.json().catch(() => ({}));
  if (!r.ok || daten.ok === false) throw new Error(daten.fehler || `HTTP ${r.status}`);
  return daten;
};

const FARBE = { sagt: '\x1b[0m', werkzeug: '\x1b[2m', eingang: '\x1b[34m', freigabe: '\x1b[33m', fehler: '\x1b[31m', fertig: '\x1b[2m', schritt: '\x1b[2m', mensch: '\x1b[36m', lauf: '\x1b[35m' };
const AUS = '\x1b[0m';

const S = { live: !process.argv.includes('--aus'), fokus: null, gespraeche: [] };

async function ladeGespraeche() {
  S.gespraeche = (await api('/api/gespraeche')).gespraeche;
  if (!S.fokus) S.fokus = (S.gespraeche.find((g) => g.art === 'root') ?? S.gespraeche[0])?.id ?? null;
}
const titel = (id) => S.gespraeche.find((g) => g.id === id)?.titel ?? id;

function zeigeZeile(z) {
  if (!S.live) return;
  const wo = z.gespraech === S.fokus ? '' : `[${z.titel ?? z.gespraech}] `;
  const zeit = new Date(z.t).toLocaleTimeString('de-DE', { hour12: false });
  process.stdout.write(`\r\x1b[K${FARBE[z.typ] ?? ''}${zeit} ${wo}${z.text}${AUS}\n`);
  rl.prompt(true);
}

async function strom() {
  for (;;) {
    try {
      const r = await fetch(`${URL_BASIS}/api/strom`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const leser = r.body.getReader();
      const dek = new TextDecoder();
      let puffer = '';
      for (;;) {
        const { done, value } = await leser.read();
        if (done) break;
        puffer += dek.decode(value, { stream: true });
        let i;
        while ((i = puffer.indexOf('\n\n')) >= 0) {
          const block = puffer.slice(0, i);
          puffer = puffer.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const daten = /^data: (.+)$/m.exec(block)?.[1];
          if (ev === 'zeile' && daten) zeigeZeile(JSON.parse(daten));
        }
      }
    } catch (fehler) {
      process.stderr.write(`\r\x1b[Kstrom unterbrochen (${fehler.message}), neu in 3 s\n`);
    }
    await new Promise((f) => setTimeout(f, 3000));
  }
}

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '› ' });

async function befehl(zeile) {
  const [kommando, ...rest] = zeile.split(/\s+/);
  const wunsch = rest.join(' ').trim();
  switch (kommando) {
    case '/live':
      S.live = wunsch ? wunsch !== 'aus' : !S.live;
      console.log(S.live ? 'Live an — du siehst die autonome Arbeit.' : 'Live aus — /live blendet den Strom wieder ein.');
      return;
    case '/fokus': {
      await ladeGespraeche();
      if (!wunsch) {
        S.gespraeche.forEach((g, i) => console.log(`${g.id === S.fokus ? '*' : ' '} ${i + 1}  ${g.titel}  (${g.art})`));
        return;
      }
      const g = S.gespraeche[Number(wunsch) - 1] ?? S.gespraeche.find((x) => x.titel.toLowerCase().includes(wunsch.toLowerCase()));
      if (!g) return console.log('Kein solches Gespräch.');
      S.fokus = g.id;
      console.log(`Fokus: ${g.titel}`);
      return;
    }
    case '/hilfe':
      console.log('/live [an|aus]  /fokus [nr|text]  /hilfe  /ende — sonst: Nachricht an den Fokus');
      return;
    case '/ende':
      process.exit(0);
      return;
    default:
      console.log('Unbekannter Befehl. /hilfe zeigt die Liste.');
  }
}

async function main() {
  if (!TOKEN) {
    console.error('Kein Token: --token, FYOS_RUNNER_TOKEN oder ~/.fyos/runner/token (legt der Runner beim ersten Start an).');
    process.exit(1);
  }
  await ladeGespraeche();
  console.log(`Verbunden mit ${URL_BASIS} · Fokus: ${titel(S.fokus)} · Live ${S.live ? 'an' : 'aus'} (/live, /hilfe)`);
  void strom();
  rl.prompt();
  rl.on('line', async (zeile) => {
    const text = zeile.trim();
    try {
      if (text.startsWith('/')) await befehl(text);
      else if (text) {
        await api(`/api/gespraech/${encodeURIComponent(S.fokus)}/nachricht`, {
          method: 'POST',
          body: JSON.stringify({ text, art: 'folgen', requestId: `cli:${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }),
        });
        // Schreiben verschiebt nur den Fokus (er liegt schon hier); der Strom bleibt, wie er ist.
      }
    } catch (fehler) {
      console.error(`Fehler: ${fehler.message}`);
    }
    rl.prompt();
  });
  rl.on('close', () => process.exit(0));
}

main().catch((fehler) => {
  console.error(`Start fehlgeschlagen: ${fehler.message}`);
  process.exit(1);
});
