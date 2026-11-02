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
 *
 * Language: FYOS_RUNNER_SPRACHE (de|en) wins, otherwise the runner's setting (`sprache` in /api/konfiguration).
 * English commands work in both languages: /live [on|off], /focus, /help, /quit.
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

// Language of this client: environment first, then the runner (main reads /api/konfiguration).
let EN = /^en/i.test(process.env.FYOS_RUNNER_SPRACHE ?? '');
const festeSprache = /^(de|en)/i.test(process.env.FYOS_RUNNER_SPRACHE ?? '');
const tx = (de, en) => (EN ? en : de);

async function ladeGespraeche() {
  S.gespraeche = (await api('/api/gespraeche')).gespraeche;
  if (!S.fokus) S.fokus = (S.gespraeche.find((g) => g.art === 'root') ?? S.gespraeche[0])?.id ?? null;
}
const titel = (id) => S.gespraeche.find((g) => g.id === id)?.titel ?? id;

function zeigeZeile(z) {
  if (!S.live) return;
  const wo = z.gespraech === S.fokus ? '' : `[${z.titel ?? z.gespraech}] `;
  const zeit = new Date(z.t).toLocaleTimeString(EN ? 'en-GB' : 'de-DE', { hour12: false });
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
      process.stderr.write(`\r\x1b[K${tx('strom unterbrochen', 'stream interrupted')} (${fehler.message}), ${tx('neu in 3 s', 'retrying in 3 s')}\n`);
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
      S.live = wunsch ? !['aus', 'off'].includes(wunsch.toLowerCase()) : !S.live;
      console.log(S.live
        ? tx('Live an — du siehst die autonome Arbeit.', 'Live on — you see the autonomous work.')
        : tx('Live aus — /live blendet den Strom wieder ein.', 'Live off — /live shows the stream again.'));
      return;
    case '/focus':
    case '/fokus': {
      await ladeGespraeche();
      if (!wunsch) {
        S.gespraeche.forEach((g, i) => console.log(`${g.id === S.fokus ? '*' : ' '} ${i + 1}  ${g.titel}  (${g.art})`));
        return;
      }
      const g = S.gespraeche[Number(wunsch) - 1] ?? S.gespraeche.find((x) => x.titel.toLowerCase().includes(wunsch.toLowerCase()));
      if (!g) return console.log(tx('Kein solches Gespräch.', 'No such conversation.'));
      S.fokus = g.id;
      console.log(`${tx('Fokus', 'Focus')}: ${g.titel}`);
      return;
    }
    case '/help':
    case '/hilfe':
      console.log(tx(
        '/live [an|aus]  /fokus [nr|text]  /hilfe  /ende — sonst: Nachricht an den Fokus',
        '/live [on|off]  /focus [no|text]  /help  /quit — anything else: message to the focused conversation',
      ));
      return;
    case '/quit':
    case '/ende':
      process.exit(0);
      return;
    default:
      console.log(tx('Unbekannter Befehl. /hilfe zeigt die Liste.', 'Unknown command. /help shows the list.'));
  }
}

async function main() {
  if (!TOKEN) {
    console.error(tx(
      'Kein Token: --token, FYOS_RUNNER_TOKEN oder ~/.fyos/runner/token (legt der Runner beim ersten Start an).',
      'No token: --token, FYOS_RUNNER_TOKEN or ~/.fyos/runner/token (the runner creates it on first start).',
    ));
    process.exit(1);
  }
  if (!festeSprache) {
    try {
      EN = /^en/i.test(String((await api('/api/konfiguration')).sprache ?? ''));
    } catch {
      /* an older runner without the setting: German */
    }
  }
  await ladeGespraeche();
  console.log(tx(
    `Verbunden mit ${URL_BASIS} · Fokus: ${titel(S.fokus)} · Live ${S.live ? 'an' : 'aus'} (/live, /hilfe)`,
    `Connected to ${URL_BASIS} · focus: ${titel(S.fokus)} · live ${S.live ? 'on' : 'off'} (/live, /help)`,
  ));
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
      console.error(`${tx('Fehler', 'Error')}: ${fehler.message}`);
    }
    rl.prompt();
  });
  rl.on('close', () => process.exit(0));
}

main().catch((fehler) => {
  console.error(`${tx('Start fehlgeschlagen', 'Start failed')}: ${fehler.message}`);
  process.exit(1);
});
