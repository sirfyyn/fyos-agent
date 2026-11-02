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
import { tx } from './i18n.js';

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
      description: tx('agent = dein eigener Desktop (Vorgabe, ohne Freigabe); mensch = Besitzer Desktop (nur mit Freigabe)', 'agent = your own desktop (default, no approval); mensch = the human\'s desktop (approval only)'),
    }),
  );
  const koord = Type.Number({ minimum: 0, maximum: 20000 });

  const bild = defineTool({
    name: 'desktop_bild',
    description: tx(
      'Macht ein Bildschirmfoto von Ginnys eigenem Desktop auf Hauptserver (ziel agent) oder von Besitzer Desktop (ziel mensch) ' +
        'und gibt es als Bild zurück. Koordinaten für desktop_klick gelten in genau diesem Bild.',
      'Takes a screenshot of your own desktop (ziel agent) or of the human\'s desktop (ziel mensch) ' +
        'and returns it as an image. Coordinates for desktop_klick refer to exactly this image.',
    ),
    parameters: Type.Object({
      ziel,
      skala: Type.Optional(Type.Number({ minimum: 0.1, maximum: 1, description: tx('Bildskala (Vorgabe 0.6)', 'Image scale (default 0.6)') })),
    }),
    replay: 'safe',
    execute: lauf((p, signal) => desktop.bild(p, signal)),
  });

  const fenster = defineTool({
    name: 'desktop_fenster',
    description: tx('Listet die offenen Fenster auf Ginnys Desktop (Adresse g5, Klasse, Titel, Arbeitsfläche, Fokus).', 'Lists the open windows on your desktop (address g5, class, title, workspace, focus).'),
    parameters: Type.Object({ ziel }),
    replay: 'safe',
    execute: lauf((p, signal) => desktop.fenster(p, signal)),
  });

  const stand = defineTool({
    name: 'desktop_eingabe_stand',
    description: tx(
      'Sagt, ob du auf dem Desktop klicken und tippen darfst: auf Ginnys Desktop, solange Besitzer nicht übernommen hat; ' +
        'auf Besitzer Desktop nur mit seiner Freigabe an Hauptserver.',
      'Says whether you may click and type on the desktop: on your own desktop as long as the human has not taken over; ' +
        'on the human\'s desktop only with their approval.',
    ),
    parameters: Type.Object({ ziel }),
    replay: 'safe',
    execute: lauf((p, signal) => desktop.eingabeStand(p, signal)),
  });

  const starter = defineTool({
    name: 'desktop_starter',
    description: tx('Listet die Programme, die auf Ginnys Desktop gestartet werden dürfen (z. B. terminal, browser, dateimanager).', 'Lists the programs that may be started on your desktop (e.g. terminal, browser, dateimanager).'),
    parameters: Type.Object({ ziel }),
    replay: 'safe',
    execute: lauf((p, signal) => desktop.starter(p, signal)),
  });

  const klick = defineTool({
    name: 'desktop_klick',
    description: tx(
      'Klickt auf den Punkt (x, y) im letzten Bildschirmfoto von desktop_bild. Mach vorher ein Foto und klicke nur, ' +
        'was du darauf siehst. Auf Besitzer Desktop nur mit Freigabe.',
      'Clicks the point (x, y) in the latest screenshot from desktop_bild. Take a screenshot first and click only ' +
        'what you see on it. On the human\'s desktop only with approval.',
    ),
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
      return textErgebnis(tx(`Geklickt (${p.taste || 'links'}${p.doppelt ? ', doppelt' : ''}). Mach ein neues Foto, um das Ergebnis zu sehen.`, `Clicked (${p.taste || 'links'}${p.doppelt ? ', double' : ''}). Take a new screenshot to see the result.`), d);
    }),
  });

  const tippen = defineTool({
    name: 'desktop_tippen',
    description: tx(
      'Tippt Text in das Fenster mit dem Fokus (höchstens 500 Zeichen; Zeilenumbruch drückt Return). ' +
        'Nie Passwörter oder Schlüssel tippen. Auf Besitzer Desktop nur mit Freigabe.',
      'Types text into the focused window (at most 500 characters; a line break presses Return). ' +
        'Never type passwords or keys. On the human\'s desktop only with approval.',
    ),
    parameters: Type.Object({
      ziel,
      text: Type.String({ minLength: 1, maxLength: 500 }),
    }),
    replay: 'unsafe',
    execute: lauf(async (p, signal) => {
      const d = await desktop.anfrage('POST', '/tippen', { text: p.text }, signal, desktop.zielVon(p));
      return textErgebnis(tx(`${d.zeichen ?? String(p.text).length} Zeichen getippt.`, `${d.zeichen ?? String(p.text).length} characters typed.`));
    }),
  });

  const taste = defineTool({
    name: 'desktop_taste',
    description: tx(
      'Drückt eine Taste oder Kombination mit ctrl und/oder shift: ctrl+l, Return, shift+Tab, F5, Escape. ' +
        'Kein alt, kein super. Auf Besitzer Desktop nur mit Freigabe.',
      'Presses a key or a combination with ctrl and/or shift: ctrl+l, Return, shift+Tab, F5, Escape. ' +
        'No alt, no super. On the human\'s desktop only with approval.',
    ),
    parameters: Type.Object({
      ziel,
      kombi: Type.String({ maxLength: 40 }),
    }),
    replay: 'unsafe',
    execute: lauf(async (p, signal) => {
      await desktop.anfrage('POST', '/taste', { kombi: p.kombi }, signal, desktop.zielVon(p));
      return textErgebnis(tx(`${p.kombi} gedrückt.`, `${p.kombi} pressed.`));
    }),
  });

  const scrollen = defineTool({
    name: 'desktop_scrollen',
    description: tx(
      'Dreht das Mausrad (dy negativ = nach oben, höchstens 20 Rasten); mit x und y zeigt der Zeiger vorher dorthin. ' +
        'Auf Besitzer Desktop nur mit Freigabe.',
      'Turns the mouse wheel (negative dy = up, at most 20 notches); with x and y the pointer moves there first. ' +
        'On the human\'s desktop only with approval.',
    ),
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
      return textErgebnis(tx('Gescrollt.', 'Scrolled.'));
    }),
  });

  const starten = defineTool({
    name: 'desktop_starten',
    description: tx(
      'Startet ein freigegebenes Programm auf Ginnys Desktop (Kennung aus desktop_starter, etwa terminal, browser, dateimanager). ' +
        'Kein freier Befehl.',
      'Starts an allowed program on your desktop (id from desktop_starter, e.g. terminal, browser, dateimanager). ' +
        'No free-form command.',
    ),
    parameters: Type.Object({
      ziel,
      starter: Type.String({ maxLength: 60 }),
    }),
    replay: 'unsafe',
    execute: lauf(async (p, signal) => {
      const d = await desktop.anfrage('POST', '/starten', { starter: p.starter }, signal, desktop.zielVon(p));
      return textErgebnis(tx(`${d.starter || p.starter} wird gestartet.`, `${d.starter || p.starter} is starting.`));
    }),
  });

  const fokus = defineTool({
    name: 'desktop_fokus',
    description: tx('Holt das Fenster mit dieser Adresse (aus desktop_fenster) nach vorn; die Arbeitsfläche wechselt mit.', 'Brings the window with this address (from desktop_fenster) to the front; the workspace follows.'),
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
