import { chromium } from 'playwright-core';

const BASE = 'http://127.0.0.1:18438';

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage();
const consoleLogs = [];
page.on('console', (msg) => consoleLogs.push(`${msg.type()}: ${msg.text()}`));
page.on('pageerror', (e) => consoleLogs.push(`PAGEERROR: ${e.message}`));

const resp = await page.goto(BASE, { waitUntil: 'domcontentloaded' });
console.log('Hauptseite:', resp.status(), resp.url());

await page.waitForTimeout(2000);
const titel = await page.title();
console.log('Titel:', titel);

// Wichtige UI-Marker vorhanden?
const marker = ['lauf', 'werkzeug', 'knoten', 'freigabe', 'zustand', 'gespraech'];
for (const m of marker) {
  const n = await page.locator(`text=${m}`).count();
  console.log(`Marker '${m}': ${n}`);
}

// API direkt testen (dieselbe Herkunft wie die Seite)
const health = await (await fetch(`${BASE}/api/health`)).json();
console.log('Health ok:', health.ok, '| Knoten:', health.knoten?.length, '| Browser:', JSON.stringify(health.konfiguration?.browser));

const cfg = await (await fetch(`${BASE}/api/konfiguration`)).json();
console.log('Konfiguration ok:', cfg.ok, '| Browser:', JSON.stringify(cfg.browser), '| Desktop:', JSON.stringify(cfg.desktop));

// Alle Fehler/Warnungen aus der Konsole ausgeben
for (const log of consoleLogs) {
  if (/error|failed|404|500/.test(log.toLowerCase())) console.log('KONSOLE:', log);
}

await browser.close();
console.log('CLIENT_SMOKE_OK');
