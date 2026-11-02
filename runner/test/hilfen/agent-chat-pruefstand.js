/**
 * Prüfstand für den nativen Agent-Chat (apps/fyos-agent/ui/agent-chat.html): ein EIGENER Runner mit Faux-Modell auf 127.0.0.1,
 * davor ein kleiner Server, der die Chat-Seite ausliefert (Ordner apps/fyos-agent/ui) und `/api/*` an den Runner weiterreicht.
 * Der Proxy hängt den Zugangsschlüssel an: die Seite kennt ihn nicht (gleicher Ursprung, kein CORS). Nie gegen Hauptserver oder den
 * Produktivrunner; Daten und Schlüssel sind Testwerte in einem Temp-Ordner.
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { fauxProvider } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { konfigurationLaden } from '../../src/config.js';
import { Runner } from '../../src/runner.js';
import { erstelleServer } from '../../src/server.js';

const HIER = dirname(fileURLToPath(import.meta.url));
export const UI = join(HIER, '..', '..', '..', '..', '..', 'apps', 'fyos-agent', 'ui');
const TYPEN = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const TOKEN = 'test-token-test-token-test-token-00';

const fakeHub = () => ({
  aufrufen: async () => ({ ok: true, result: {} }),
  melden: async () => ({ ok: true }),
  bereicheMelden: async () => ({ ok: true }),
  gesundheit: async () => ({ ok: true }),
  suchen: async () => [],
  schema: async () => ({}),
  async eingangLesen(nach) {
    await new Promise((r) => setTimeout(r, 200));
    return { eintraege: [], letzte: nach };
  },
});

/** opts.tokensProSekunde: Streaming-Tempo des Faux-Modells (0 = sofort). opts.port: fester Port (für die Ansicht im Browser). */
export async function starte(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-chat-'));
  const arbeit = join(dir, 'arbeit');
  const cfg = konfigurationLaden(
    {
      hub: 'http://hub.test',
      agent: 'persona',
      arbeitsbereiche: { standard: { pfad: dir, titel: 'Test' } },
      pi_durable: {
        storage: join(dir, 'fyos.sqlite'),
        security: { token: TOKEN },
        proactive: { enabled: false, pollSeconds: 3 },
        egress: { enabled: false },
        browser: { enabled: false },
        desktop: { enabled: false },
      },
    },
    {},
  );
  const faux = fauxProvider({
    provider: cfg.pi_durable.model.provider,
    models: [{ id: 'hausmodell', contextWindow: 128000 }, { id: 'hausmodell-max', contextWindow: 128000 }],
    ...(opts.tokensProSekunde ? { tokensPerSecond: opts.tokensProSekunde } : {}),
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const runner = new Runner(cfg, { models, hub: fakeHub() });
  await runner.start();
  const api = erstelleServer({ runner, cfg });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const apiBasis = `http://127.0.0.1:${api.address().port}`;
  const gekappt = new Set(); // offene Proxy-Verbindungen (Strom), für Verbindungsabbrüche im Test
  const front = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) {
        const ac = new AbortController();
        res.on('close', () => ac.abort());
        let body;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          const teile = [];
          for await (const c of req) teile.push(c);
          body = Buffer.concat(teile);
        }
        const r = await fetch(apiBasis + url.pathname + url.search, {
          method: req.method,
          headers: { Authorization: `Bearer ${TOKEN}`, ...(req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {}) },
          body,
          signal: ac.signal,
        });
        res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
        if (r.body) {
          gekappt.add(res);
          res.on('close', () => gekappt.delete(res));
          Readable.fromWeb(r.body).on('error', () => res.end()).pipe(res);
        } else res.end();
        return;
      }
      const rel = normalize(url.pathname === '/' ? '/agent-chat.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
      const datei = join(UI, rel);
      if (!datei.startsWith(UI) || !existsSync(datei) || !statSync(datei).isFile()) {
        res.writeHead(404).end('nicht gefunden');
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPEN[extname(datei)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(readFileSync(datei));
    } catch (f) {
      if (!res.headersSent) res.writeHead(502);
      res.end(String(f?.message ?? f));
    }
  });
  await new Promise((r) => front.listen(opts.port || 0, '127.0.0.1', r));
  const basis = `http://127.0.0.1:${front.address().port}`;
  return {
    basis,
    runner,
    faux,
    arbeit: dir,
    cfg,
    /** Alle offenen Strom-Verbindungen zwischen Seite und Runner hart kappen (Netzabbruch). */
    kappeStrome() {
      for (const r of gekappt) r.destroy();
    },
    async stopp() {
      for (const r of gekappt) r.destroy();
      await new Promise((r) => front.close(r));
      api.closeAllConnections?.();
      await new Promise((r) => api.close(r));
      await runner.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
