/**
 * browser.js — Ginnys eigener Browser.
 *
 * Kein „Web lesen“ mit einem anderen Namen: hier läuft ein echter Chromium/Chrome mit
 * einem eigenen, dauerhaften Profil. Cookies, Anmeldungen und Downloads bleiben über
 * Läufe und Abstürze hinweg erhalten. Der Agent kann öffnen, klicken, tippen, Tasten
 * drücken, scrollen, JavaScript ausführen und sich den Bildschirm ansehen.
 *
 * Auf dem Mac wird das installierte Google Chrome benutzt. Auf Hauptserver/Cluster wird ein
 * Chromium-Pfad gesetzt (siehe Dockerfile/Deployment). `playwright-core` bringt keinen
 * eigenen Browser mit — das ist Absicht: kein zweiter, versteckter Browser.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { Schema as Type, werkzeug as defineTool } from './lauf/index.js';

const KURZ = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
];

function browserWeg(b) {
  if (b.executablePath) return String(b.executablePath);
  for (const p of CHROME) {
    if (existsSync(p)) return p;
  }
  return null;
}

function zielUrl(url) {
  const roh = String(url ?? '').trim();
  if (!roh) throw new Error('url fehlt');
  let u;
  try {
    u = new URL(roh);
  } catch {
    // Eine nackte Adresse wie „example.com“ ist im Browser eine Suche, keine URL.
    if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(roh)) {
      return `https://${roh}`;
    }
    throw new Error('Keine gültige URL (http/https/file/about erwartet)');
  }
  if (!['http:', 'https:', 'file:', 'about:'].includes(u.protocol)) {
    throw new Error(`Nur http, https, file und about sind erlaubt (nicht ${u.protocol})`);
  }
  return u.href;
}

function textAusErgebnis(wert) {
  if (typeof wert === 'string') return wert;
  try {
    return JSON.stringify(wert, null, 2);
  } catch {
    return String(wert);
  }
}

export class Browser {
  constructor(cfg) {
    const b = cfg.pi_durable.browser ?? {};
    this.cfg = cfg;
    this.enabled = b.enabled !== false;
    this.headless = b.headless !== false;
    this.channel = b.channel ?? 'chrome';
    this.executablePath = b.executablePath ?? '';
    this.userDataDir = b.userDataDir;
    this.screenshotDir = b.screenshotDir;
    this.timeoutMs = Math.max(5000, Number(b.timeoutMs) || 45_000);
    this.viewport = {
      width: Math.max(320, Number(b.viewport?.width) || 1440),
      height: Math.max(240, Number(b.viewport?.height) || 900),
    };
    this.maxText = Math.max(2000, Number(cfg.pi_durable.limits?.maxToolOutput) || 24_000);
    this.kontext = null;
    this.seite = null;
    this._start = null;
  }

  sicht() {
    return {
      enabled: this.enabled,
      headless: this.headless,
      profile: this.userDataDir,
      screenshotDir: this.screenshotDir,
    };
  }

  async start() {
    if (!this.enabled) throw new Error('Der Browser ist in der Konfiguration abgeschaltet (pi_durable.browser.enabled=false).');
    if (this.kontext) {
      if (!this.seite || this.seite.isClosed()) {
        const seiten = this.kontext.pages();
        this.seite = seiten[0] ?? (await this.kontext.newPage());
      }
      return this.seite;
    }
    if (this._start) return this._start;
    this._start = (async () => {
      mkdirSync(this.userDataDir, { recursive: true });
      mkdirSync(this.screenshotDir, { recursive: true });
      const weg = browserWeg(this.cfg.pi_durable.browser ?? {});
      const optionen = {
        headless: this.headless,
        viewport: this.viewport,
        acceptDownloads: true,
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin',
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-networking',
        ],
      };
      if (weg) optionen.executablePath = weg;
      else if (this.channel) optionen.channel = this.channel;
      else throw new Error('Kein Chrome/Chromium gefunden. Setze pi_durable.browser.executablePath.');
      this.kontext = await chromium.launchPersistentContext(this.userDataDir, optionen);
      this.kontext.setDefaultTimeout(this.timeoutMs);
      this.kontext.on('close', () => {
        this.kontext = null;
        this.seite = null;
        this._start = null;
      });
      this.kontext.on('page', (seite) => {
        if (!this.seite || this.seite.isClosed()) this.seite = seite;
      });
      const seiten = this.kontext.pages();
      this.seite = seiten[0] ?? (await this.kontext.newPage());
      this.seite.on('dialog', (dialog) => void dialog.dismiss().catch(() => {}));
      return this.seite;
    })().catch((fehler) => {
      this._start = null;
      throw fehler;
    });
    return this._start;
  }

  async seiteOderFehler() {
    const seite = await this.start();
    if (seite.isClosed()) return this.start();
    return seite;
  }

  async info() {
    const seite = await this.seiteOderFehler();
    const titel = await seite.title().catch(() => '');
    const text = await seite.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const links = await seite
      .evaluate(() => {
        const sichtbar = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        return [...document.querySelectorAll('a[href]')]
          .filter(sichtbar)
          .slice(0, 80)
          .map((a) => ({
            text: String(a.innerText || a.getAttribute('aria-label') || a.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 140),
            href: a.href,
          }))
          .filter((l) => l.text);
      })
      .catch(() => []);
    const felder = await seite
      .evaluate(() => {
        const css = (s) => (window.CSS?.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));
        const sichtbar = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        return [...document.querySelectorAll('input,textarea,select,button')]
          .filter(sichtbar)
          .slice(0, 60)
          .map((el) => {
            const tag = el.tagName.toLowerCase();
            let selector = '';
            if (el.id) selector = `#${css(el.id)}`;
            else if (el.getAttribute('name')) selector = `${tag}[name="${css(el.getAttribute('name'))}"]`;
            else if (el.getAttribute('placeholder')) selector = `${tag}[placeholder="${css(el.getAttribute('placeholder'))}"]`;
            return {
              tag,
              selector,
              typ: el.getAttribute('type') || (tag === 'button' ? 'button' : undefined),
              name: el.getAttribute('name') || undefined,
              text: String(el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 100) || undefined,
              placeholder: el.getAttribute('placeholder') || undefined,
            };
          });
      })
      .catch(() => []);
    return {
      url: seite.url(),
      titel,
      text: KURZ(text, this.maxText),
      links,
      felder,
    };
  }

  async bild() {
    const seite = await this.seiteOderFehler();
    const buf = await seite.screenshot({ type: 'jpeg', quality: 72, fullPage: false });
    const datei = join(this.screenshotDir, `browser-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(datei, buf, { mode: 0o600 });
    return { base64: buf.toString('base64'), mimeType: 'image/jpeg', pfad: datei };
  }

  async schliessen() {
    const k = this.kontext;
    this.kontext = null;
    this.seite = null;
    this._start = null;
    if (k) await k.close().catch(() => {});
  }
}

/**
 * Ein Werkzeug statt zehn: der Agent wählt die Aktion. Das hält den Prompt klein und
 * lässt trotzdem jeden Browser-Schritt zu, den ein Mensch mit einer Maus tun kann.
 */
export function browserWerkzeuge({ cfg, browser = new Browser(cfg) }) {
  const werkzeug = defineTool({
    name: 'browser',
    description:
      'Bedient einen echten Chromium/Chrome mit eigenem, dauerhaftem Profil (Anmeldungen bleiben erhalten). ' +
      'Aktionen: oeffnen (url), klicken (selector oder text), tippen (selector + eingabe, optional abschicken), ' +
      'taste (z. B. Enter, Tab, ctrl+l), scrollen (richtung/pixel), js (code), zurueck, sehen (Bildschirmfoto), ' +
      'text (lesbarer Seiteninhalt + Links + Formularfelder), schliessen. ' +
      'Nach dem Öffnen steht der Seiteninhalt als Text bereit; mit sehen bekommst du zusätzlich ein Bild. ' +
      'Für FYOS-Wissen zuerst hub_suchen, für reines Lesen ohne Interaktion web_holen.',
    parameters: Type.Object({
      aktion: Type.Union([
        Type.Literal('oeffnen'),
        Type.Literal('klicken'),
        Type.Literal('tippen'),
        Type.Literal('taste'),
        Type.Literal('scrollen'),
        Type.Literal('js'),
        Type.Literal('zurueck'),
        Type.Literal('sehen'),
        Type.Literal('text'),
        Type.Literal('schliessen'),
      ], { description: 'Was der Browser tun soll' }),
      url: Type.Optional(Type.String({ description: 'Bei oeffnen: http/https/file/about-Adresse oder nackte Domain' })),
      selector: Type.Optional(Type.String({ description: 'CSS-Selektor, z. B. #suche, input[name="q"], button[type="submit"]' })),
      text: Type.Optional(Type.String({ description: 'Bei klicken: sichtbarer Link-/Knopftext (alternativ zu selector)' })),
      eingabe: Type.Optional(Type.String({ description: 'Bei tippen: Text zum Ausfüllen' })),
      abschicken: Type.Optional(Type.Boolean({ description: 'Bei tippen: danach Enter drücken (Vorgabe: false)' })),
      taste: Type.Optional(Type.String({ description: 'Bei taste: Playwright-Taste, z. B. Enter, Tab, Escape, ctrl+l' })),
      richtung: Type.Optional(Type.Union([Type.Literal('oben'), Type.Literal('unten'), Type.Literal('links'), Type.Literal('rechts')])),
      pixel: Type.Optional(Type.Number({ description: 'Bei scrollen: Pixel (Vorgabe 600)' })),
      code: Type.Optional(Type.String({ description: 'Bei js: JavaScript-Ausdruck oder async-Funktionskörper; Rückgabe wird JSON' })),
      index: Type.Optional(Type.Number({ minimum: 0, description: 'Bei mehreren Treffern: der wievielte (0-basiert)' })),
      bild: Type.Optional(Type.Boolean({ description: 'Nach der Aktion ein Bildschirmfoto als Bild mitliefern' })),
    }),
    replay: 'unsafe',
    execute: async (p, _api, context) => {
      const aktion = p.aktion;
      const signal = context.signal;
      const seite = await browser.seiteOderFehler();
      const index = Math.max(0, Number(p.index) || 0);
      let text = '';

      switch (aktion) {
        case 'oeffnen': {
          const url = zielUrl(p.url);
          await seite.goto(url, { waitUntil: 'domcontentloaded', timeout: browser.timeoutMs });
          await seite.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
          const i = await browser.info();
          text = JSON.stringify({ aktion, ...i }, null, 2);
          break;
        }
        case 'klicken': {
          let ziel;
          if (p.selector) ziel = seite.locator(p.selector).nth(index);
          else if (p.text) ziel = seite.getByText(p.text, { exact: false }).nth(index);
          else throw new Error('klicken braucht selector oder text');
          await ziel.click({ timeout: browser.timeoutMs });
          await seite.waitForTimeout(400);
          const i = await browser.info();
          text = JSON.stringify({ aktion, geklickt: p.selector || p.text, ...i }, null, 2);
          break;
        }
        case 'tippen': {
          if (p.eingabe === undefined) throw new Error('tippen braucht eingabe');
          if (p.selector) await seite.locator(p.selector).nth(index).fill(String(p.eingabe), { timeout: browser.timeoutMs });
          else await seite.keyboard.type(String(p.eingabe));
          if (p.abschicken) await seite.keyboard.press('Enter');
          await seite.waitForTimeout(300);
          text = `Getippt${p.selector ? ` in ${p.selector}` : ' in das aktive Feld'}${p.abschicken ? ' und Enter gedrückt' : ''}.`;
          break;
        }
        case 'taste': {
          if (!p.taste) throw new Error('taste fehlt');
          await seite.keyboard.press(String(p.taste));
          await seite.waitForTimeout(300);
          text = `${p.taste} gedrückt.`;
          break;
        }
        case 'scrollen': {
          const pixel = Math.max(1, Math.min(10000, Number(p.pixel) || 600));
          const richtung = p.richtung || 'unten';
          const dx = richtung === 'links' ? -pixel : richtung === 'rechts' ? pixel : 0;
          const dy = richtung === 'oben' ? -pixel : richtung === 'unten' ? pixel : 0;
          await seite.mouse.wheel(dx, dy);
          await seite.waitForTimeout(250);
          text = `Gescrollt (${richtung}, ${pixel} px).`;
          break;
        }
        case 'js': {
          if (!p.code) throw new Error('code fehlt');
          const quelle = /\breturn\b/.test(p.code)
            ? `(async () => { ${p.code} })()`
            : `(async () => (${p.code}))()`;
          const wert = await seite.evaluate(quelle);
          text = KURZ(textAusErgebnis(wert), browser.maxText);
          break;
        }
        case 'zurueck': {
          await seite.goBack({ waitUntil: 'domcontentloaded', timeout: browser.timeoutMs }).catch(() => null);
          const i = await browser.info();
          text = JSON.stringify({ aktion, ...i }, null, 2);
          break;
        }
        case 'sehen': {
          const b = await browser.bild();
          return {
            output: [
              { type: 'text', text: `Bildschirmfoto: ${b.pfad}\n${JSON.stringify({ url: seite.url(), titel: await seite.title().catch(() => '') }, null, 2)}` },
              { type: 'image', data: b.base64, mimeType: b.mimeType },
            ],
            details: { aktion, pfad: b.pfad, url: seite.url() },
          };
        }
        case 'text': {
          const i = await browser.info();
          text = JSON.stringify({ aktion, ...i }, null, 2);
          break;
        }
        case 'schliessen': {
          await browser.schliessen();
          return { output: [{ type: 'text', text: 'Browser geschlossen. Das Profil bleibt erhalten.' }], details: { aktion } };
        }
        default:
          throw new Error(`Unbekannte Browser-Aktion: ${aktion}`);
      }

      if (signal?.aborted) throw new Error('Abgebrochen');
      const ausgabe = [{ type: 'text', text }];
      let details = { aktion, url: seite.url() };
      if (p.bild) {
        const b = await browser.bild();
        ausgabe.push({ type: 'image', data: b.base64, mimeType: b.mimeType });
        details = { ...details, pfad: b.pfad };
      }
      return { output: ausgabe, details };
    },
  });

  return [werkzeug];
}
