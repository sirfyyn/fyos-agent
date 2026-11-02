/**
 * desktop.js — Ginnys eigener Desktop auf Hauptserver.
 *
 * Der Desktop ist kein Anhängsel des Browsers: es ist eine eigene sway-Sitzung als
 * `fyos-agent` mit wayvnc (nur ansehen) und dem Dienst `fyos-oeffnen`. Genau diesen
 * Dienst spricht dieses Modul an — dieselben Grenzen wie die bestehende
 * Pi-Erweiterung `fyos-desktop`: Ziel `agent` ist ihr eigener Desktop und ohne
 * Freigabe bedienbar; Ziel `mensch` ist Besitzer' Desktop und bleibt dem Menschen
 * vorbehalten. Der Dienst entscheidet, nicht der Runner.
 *
 * Auf dem Mac liegt das Agenten-Token unter `~/.fyos/runner/fyos-oeffnen-agent.token`;
 * auf Hauptserver kann `tokenFile` auf `/etc/fyos/fyos-oeffnen-agent.token` zeigen. Das
 * Token wird nie in einer Antwort oder einem Protokoll ausgegeben.
 */
import { readFileSync } from 'node:fs';
import { Schema as Type, werkzeug as defineTool } from './lauf/index.js';

const KURZ = (s, n = 600) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

class Gesperrt extends Error {
  constructor(message, ziel) {
    super(message);
    this.ziel = ziel;
  }
}

const textErgebnis = (text, details) => ({
  output: [{ type: 'text', text: String(text ?? '') }],
  ...(details === undefined ? {} : { details }),
});

export class Desktop {
  constructor(cfg) {
    const d = cfg.pi_durable.desktop ?? {};
    this.cfg = cfg;
    this.enabled = d.enabled !== false;
    this.basis = String(d.url ?? '').replace(/\/+$/, '');
    this.tokenDatei = d.tokenFile ?? '';
    this.tokenWert = d.token ?? '';
    this.zielVorgabe = d.ziel === 'mensch' ? 'mensch' : 'agent';
    this.skalaVorgabe = Math.min(1, Math.max(0.1, Number(d.skala) || 0.6));
    this.timeoutMs = Math.max(3000, Number(d.timeoutMs) || 30_000);
    this.skalen = {};
  }

  sicht() {
    return {
      enabled: this.enabled,
      url: this.basis,
      ziel: this.zielVorgabe,
      skala: this.skalaVorgabe,
    };
  }

  zielVon(p) {
    return p?.ziel === 'mensch' || p?.ziel === 'agent' ? p.ziel : this.zielVorgabe;
  }

  skalaFuer(ziel) {
    return this.skalen[ziel] ?? this.skalaVorgabe;
  }

  token() {
    const t = String(this.tokenWert || '').trim() || (this.tokenDatei ? readFileSync(this.tokenDatei, 'utf8').trim() : '');
    if (t.length < 32) {
      throw new Error(
        `Desktop-Token fehlt oder ist zu kurz${this.tokenDatei ? ` (${this.tokenDatei})` : ''}. ` +
          'Setze pi_durable.desktop.tokenFile oder FYOS_DESKTOP_TOKEN.',
      );
    }
    return t;
  }

  async anfrage(methode, weg, koerper, signal, ziel) {
    if (!this.enabled) throw new Error('Der Desktop ist in der Konfiguration abgeschaltet (pi_durable.desktop.enabled=false).');
    if (!this.basis) throw new Error('Desktop-Adresse fehlt (pi_durable.desktop.url).');
    let zielWeg = weg;
    let zielKoerper = koerper;
    if (ziel === 'agent') {
      if (methode === 'GET') zielWeg += `${zielWeg.includes('?') ? '&' : '?'}ziel=agent`;
      else zielKoerper = { ...(koerper ?? {}), ziel: 'agent' };
    }
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const r = await fetch(this.basis + zielWeg, {
      method: methode,
      headers: {
        Authorization: `Bearer ${this.token()}`,
        ...(zielKoerper ? { 'Content-Type': 'application/json' } : {}),
      },
      body: zielKoerper ? JSON.stringify(zielKoerper) : undefined,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    let d = null;
    try {
      d = await r.json();
    } catch {
      /* keine JSON-Antwort */
    }
    if (r.status === 423) {
      throw new Gesperrt(
        String(d?.error || (ziel === 'agent' ? 'Besitzer hat deinen Desktop übernommen.' : 'Computer Use ist gesperrt: nur Besitzer an Hauptserver gibt es frei.')),
        ziel,
      );
    }
    if (!r.ok || !d || d.ok !== true) {
      throw new Error(KURZ(d?.error || `Der Desktop antwortet mit ${r.status}`, 400));
    }
    return d;
  }

  async bild(p, signal) {
    const ziel = this.zielVon(p);
    const skala = typeof p.skala === 'number' ? Math.min(1, Math.max(0.1, p.skala)) : this.skalaVorgabe;
    const d = await this.anfrage('GET', `/bild?skala=${skala.toFixed(2)}`, undefined, signal, ziel);
    if (typeof d.daten !== 'string' || !d.typ) throw new Error('Der Desktop lieferte kein Bild.');
    this.skalen[ziel] = skala;
    return {
      output: [
        {
          type: 'text',
          text:
            `Bildschirmfoto von ${ziel === 'agent' ? 'deinem Desktop' : 'Besitzer Desktop'} in Skala ${skala}. ` +
            'Koordinaten für desktop_klick gelten in diesem Bild.',
        },
        { type: 'image', data: d.daten, mimeType: d.typ },
      ],
      details: { skala, groesse: d.groesse ?? null, ziel },
    };
  }

  async fenster(p, signal) {
    const d = await this.anfrage('GET', '/fenster', undefined, signal, this.zielVon(p));
    const zeilen = (Array.isArray(d.fenster) ? d.fenster : []).map(
      (f) => `${f.adresse}  ${f.klasse ?? '?'}  „${String(f.titel ?? '').slice(0, 60)}“  Fläche ${f.arbeitsflaeche ?? '?'}${f.fokus ? '  (vorn)' : ''}`,
    );
    return textErgebnis(zeilen.length ? zeilen.join('\n') : 'Kein Fenster offen.', { fenster: d.fenster ?? [] });
  }

  async eingabeStand(p, signal) {
    const ziel = this.zielVon(p);
    const d = await this.anfrage('GET', '/eingabe', undefined, signal, ziel);
    if (ziel === 'agent') {
      return textErgebnis(
        d.uebernommen ? 'Besitzer hat deinen Desktop übernommen: du ruhst.' : 'Dein Desktop ist frei: du darfst dort klicken und tippen.',
        { freigabe: !!d.freigabe, uebernommen: !!d.uebernommen, ziel },
      );
    }
    const rest = Number(d.rest_sekunden) || 0;
    return textErgebnis(
      d.freigabe
        ? `Freigegeben, noch ${Math.floor(rest / 60)}:${String(rest % 60).padStart(2, '0')} Minuten.`
        : 'Gesperrt: nur ein Mensch an Hauptserver gibt Computer Use frei.',
      { freigabe: !!d.freigabe, rest_sekunden: rest, ziel },
    );
  }

  async starter(p, signal) {
    const d = await this.anfrage('GET', '/starter', undefined, signal, this.zielVon(p));
    const liste = (Array.isArray(d.starter) ? d.starter : []).map((s) => `${s.id}  ${s.name ?? ''}`);
    return textErgebnis(liste.length ? liste.join('\n') : 'Keine Starter freigegeben.', { starter: d.starter ?? [] });
  }
}

export function desktopWerkzeuge({ cfg, desktop = new Desktop(cfg) }) {
  const lauf = (fn) => async (p, _api, context) => {
    try {
      return await fn(p, context.signal);
    } catch (fehler) {
      if (fehler instanceof Gesperrt) {
        const hinweis = fehler.ziel === 'agent'
          ? ' Warte, bis Besitzer den Desktop zurückgibt, oder frag ihn.'
          : ' Frag Besitzer, ob er Computer Use freigibt.';
        return textErgebnis(fehler.message + hinweis, { gesperrt: true, ziel: fehler.ziel });
      }
      throw fehler;
    }
  };

  const ziel = Type.Optional(
    Type.Union([Type.Literal('agent'), Type.Literal('mensch')], {
      description: 'agent = dein eigener Desktop (Vorgabe, ohne Freigabe); mensch = Besitzer Desktop (nur mit Freigabe)',
    }),
  );
  const koord = Type.Number({ minimum: 0, maximum: 20000 });

  const bild = defineTool({
    name: 'desktop_bild',
    description:
      'Macht ein Bildschirmfoto von Ginnys eigenem Desktop auf Hauptserver (ziel agent) oder von Besitzer Desktop (ziel mensch) ' +
      'und gibt es als Bild zurück. Koordinaten für desktop_klick gelten in genau diesem Bild.',
    parameters: Type.Object({
      ziel,
      skala: Type.Optional(Type.Number({ minimum: 0.1, maximum: 1, description: 'Bildskala (Vorgabe 0.6)' })),
    }),
    replay: 'safe',
    execute: lauf((p, signal) => desktop.bild(p, signal)),
  });

  const fenster = defineTool({
    name: 'desktop_fenster',
    description: 'Listet die offenen Fenster auf Ginnys Desktop (Adresse g5, Klasse, Titel, Arbeitsfläche, Fokus).',
    parameters: Type.Object({ ziel }),
    replay: 'safe',
    execute: lauf((p, signal) => desktop.fenster(p, signal)),
  });

  const stand = defineTool({
    name: 'desktop_eingabe_stand',
    description:
      'Sagt, ob du auf dem Desktop klicken und tippen darfst: auf Ginnys Desktop, solange Besitzer nicht übernommen hat; ' +
      'auf Besitzer Desktop nur mit seiner Freigabe an Hauptserver.',
    parameters: Type.Object({ ziel }),
    replay: 'safe',
    execute: lauf((p, signal) => desktop.eingabeStand(p, signal)),
  });

  const starter = defineTool({
    name: 'desktop_starter',
    description: 'Listet die Programme, die auf Ginnys Desktop gestartet werden dürfen (z. B. terminal, browser, dateimanager).',
    parameters: Type.Object({ ziel }),
    replay: 'safe',
    execute: lauf((p, signal) => desktop.starter(p, signal)),
  });

  const klick = defineTool({
    name: 'desktop_klick',
    description:
      'Klickt auf den Punkt (x, y) im letzten Bildschirmfoto von desktop_bild. Mach vorher ein Foto und klicke nur, ' +
      'was du darauf siehst. Auf Besitzer Desktop nur mit Freigabe.',
    parameters: Type.Object({
      ziel,
      x: koord,
      y: koord,
      taste: Type.Optional(Type.Union([Type.Literal('links'), Type.Literal('rechts'), Type.Literal('mitte')])),
      doppelt: Type.Optional(Type.Boolean()),
    }),
    replay: 'unsafe',
    execute: lauf(async (p, signal) => {
      const z = desktop.zielVon(p);
      const d = await desktop.anfrage(
        'POST',
        '/klick',
        { x: p.x, y: p.y, skala: desktop.skalaFuer(z), taste: p.taste, doppelt: p.doppelt === true },
        signal,
        z,
      );
      return textErgebnis(`Geklickt (${p.taste || 'links'}${p.doppelt ? ', doppelt' : ''}). Mach ein neues Foto, um das Ergebnis zu sehen.`, d);
    }),
  });

  const tippen = defineTool({
    name: 'desktop_tippen',
    description:
      'Tippt Text in das Fenster mit dem Fokus (höchstens 500 Zeichen; Zeilenumbruch drückt Return). ' +
      'Nie Passwörter oder Schlüssel tippen. Auf Besitzer Desktop nur mit Freigabe.',
    parameters: Type.Object({
      ziel,
      text: Type.String({ minLength: 1, maxLength: 500 }),
    }),
    replay: 'unsafe',
    execute: lauf(async (p, signal) => {
      const d = await desktop.anfrage('POST', '/tippen', { text: p.text }, signal, desktop.zielVon(p));
      return textErgebnis(`${d.zeichen ?? String(p.text).length} Zeichen getippt.`);
    }),
  });

  const taste = defineTool({
    name: 'desktop_taste',
    description:
      'Drückt eine Taste oder Kombination mit ctrl und/oder shift: ctrl+l, Return, shift+Tab, F5, Escape. ' +
      'Kein alt, kein super. Auf Besitzer Desktop nur mit Freigabe.',
    parameters: Type.Object({
      ziel,
      kombi: Type.String({ maxLength: 40 }),
    }),
    replay: 'unsafe',
    execute: lauf(async (p, signal) => {
      await desktop.anfrage('POST', '/taste', { kombi: p.kombi }, signal, desktop.zielVon(p));
      return textErgebnis(`${p.kombi} gedrückt.`);
    }),
  });

  const scrollen = defineTool({
    name: 'desktop_scrollen',
    description:
      'Dreht das Mausrad (dy negativ = nach oben, höchstens 20 Rasten); mit x und y zeigt der Zeiger vorher dorthin. ' +
      'Auf Besitzer Desktop nur mit Freigabe.',
    parameters: Type.Object({
      ziel,
      dy: Type.Optional(Type.Integer({ minimum: -20, maximum: 20 })),
      dx: Type.Optional(Type.Integer({ minimum: -20, maximum: 20 })),
      x: Type.Optional(koord),
      y: Type.Optional(koord),
    }),
    replay: 'unsafe',
    execute: lauf(async (p, signal) => {
      const z = desktop.zielVon(p);
      const koerper = {
        dx: p.dx ?? 0,
        dy: p.dy ?? 0,
        ...(p.x !== undefined && p.y !== undefined ? { x: p.x, y: p.y, skala: desktop.skalaFuer(z) } : {}),
      };
      await desktop.anfrage('POST', '/scrollen', koerper, signal, z);
      return textErgebnis('Gescrollt.');
    }),
  });

  const starten = defineTool({
    name: 'desktop_starten',
    description:
      'Startet ein freigegebenes Programm auf Ginnys Desktop (Kennung aus desktop_starter, etwa terminal, browser, dateimanager). ' +
      'Kein freier Befehl.',
    parameters: Type.Object({
      ziel,
      starter: Type.String({ maxLength: 60 }),
    }),
    replay: 'unsafe',
    execute: lauf(async (p, signal) => {
      const d = await desktop.anfrage('POST', '/starten', { starter: p.starter }, signal, desktop.zielVon(p));
      return textErgebnis(`${d.starter || p.starter} wird gestartet.`);
    }),
  });

  const fokus = defineTool({
    name: 'desktop_fokus',
    description: 'Holt das Fenster mit dieser Adresse (aus desktop_fenster) nach vorn; die Arbeitsfläche wechselt mit.',
    parameters: Type.Object({
      ziel,
      adresse: Type.String({ pattern: '^(0x[0-9a-f]{1,16}|g[0-9]{1,9})$' }),
    }),
    replay: 'unsafe',
    execute: lauf(async (p, signal) => {
      const d = await desktop.anfrage(
        'POST',
        '/fokus',
        { adresse: p.adresse },
        signal,
        p.adresse.startsWith('g') ? 'agent' : desktop.zielVon(p),
      );
      return textErgebnis(
        d.fokus_wirksam === false
          ? `Fenster ${p.adresse}: der Fokus ist nicht angekommen. Mach ein neues Foto und prüfe.`
          : `Fenster ${p.adresse} ist vorn.`,
      );
    }),
  });

  return [bild, fenster, stand, starter, klick, tippen, taste, scrollen, starten, fokus];
}
