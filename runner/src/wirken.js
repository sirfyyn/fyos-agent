/**
 * wirken.js — der Strom der autonomen Arbeit.
 *
 * Wer sich mit einem Client verbindet, sieht standardmäßig, was der Agent gerade selbst tut:
 * Eingänge, Gedanken-Ergebnisse, Werkzeugaufrufe, Läufe, Freigabewünsche — über alle Gespräche
 * und Läufe hinweg, nicht nur im geöffneten. Der Strom ist nur ein Fenster: er ändert nichts am
 * Agenten. Der Client blendet ihn mit `/live` aus oder ein; eine Nachricht an den Agenten
 * verschiebt allein den Fokus (welches Gespräch groß zu sehen ist), nie den Strom.
 *
 * Der Server verdichtet die pi-durable-Ereignisse zu kurzen Zeilen. Web und Terminal zeichnen
 * dieselben Zeilen; den vollen Verlauf des Fokus-Gesprächs liefert weiter `/ereignisse`.
 */
import { EREIGNIS, KONTEXT, ereignisArt, ereignisse } from './lauf/index.js';
import { LaufListe, Register } from './documents.js';
import { schwaerzen } from './persona/redaktion.js';
import { tx } from './i18n.js';

const CTX = KONTEXT;

const kurz = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

function argKurz(args) {
  if (!args || typeof args !== 'object') return '';
  const wert = args.command ?? args.path ?? args.werkzeug ?? args.suche ?? args.aktion ?? args.url ?? args.titel;
  // Geschwärzt wie alles, was den Runner verlässt (Secrets wie Claude, PERSONA-SECRETS.md).
  return wert !== undefined ? kurz(schwaerzen(String(wert)), 120) : kurz(schwaerzen(JSON.stringify(args)), 120);
}

function assistentenText(entry) {
  return (entry?.model ?? [])
    .filter((m) => m?.role === 'assistant')
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Ein Agent-Ereignis → null oder eine Zeile `{typ, text, wz?}`.
 * Deltas (Token für Token) gehören nicht in den Strom; er zeigt Taten, nicht Tippen.
 */
function eintragZeile(entry) {
  const k = entry?.kind;
  const d = entry?.data ?? {};
  if (k === 'fyos.eingang') return { typ: 'eingang', text: `${d.quelle ?? 'hub'}${d.klasse === 'max' ? tx(' (Besitzer)', ' (owner)') : ''}: ${kurz(d.text, 240)}` };
  if (k === 'fyos.mensch') return { typ: 'mensch', text: kurz(d.text, 240) };
  if (k === 'fyos.freigabe') return { typ: 'freigabe', text: `${tx('wartet auf Freigabe', 'waiting for approval')}: ${kurz(d.aktion, 200)}` };
  if (k === 'fyos.freigabe-entscheidung') return { typ: 'freigabe', text: `${tx('Freigabe', 'Approval')} ${tx(d.entscheidung ?? '', { erteilt: 'granted', abgelehnt: 'denied' }[d.entscheidung] ?? d.entscheidung ?? '')} (${d.id ?? ''})` };
  if (k === 'fyos.befehl') return { typ: 'befehl', text: `/${d.name ?? ''}${d.ok === false ? tx(' (abgelehnt)', ' (rejected)') : ''}: ${kurz(String(d.text ?? '').split('\n')[0], 160)}` };
  if (k === 'fyos.lauf.auftrag') return { typ: 'lauf', text: `${tx('Lauf', 'Run')} ${d.lauf ?? ''}: ${kurz(d.titel, 160)}` };
  return null;
}

export function zeileAus(e) {
  switch (ereignisArt(e)) {
    case EREIGNIS.NACHRICHT_ENDE: {
      // Eingänge, Menschen-Nachrichten und Lauf-Aufträge kommen als Nutzernachricht mit entry.kind.
      const vonEintrag = eintragZeile(e.entry);
      if (vonEintrag) return vonEintrag;
      const text = kurz(assistentenText(e.entry), 400);
      return text ? { typ: 'sagt', text } : null;
    }
    case EREIGNIS.WERKZEUG_START:
      return { typ: 'werkzeug', wz: e.toolName, text: `${e.toolName ?? tx('Werkzeug', 'Tool')} ${argKurz(e.args)}`.trim() };
    case EREIGNIS.WERKZEUG_ENDE: {
      const fehler = e.entry?.data?.isError || e.entry?.model?.some?.((m) => m?.isError);
      return fehler ? { typ: 'fehler', wz: e.toolName, text: `${e.toolName ?? tx('Werkzeug', 'Tool')} ${tx('fehlgeschlagen', 'failed')}` } : null;
    }
    case EREIGNIS.EINTRAG:
      return eintragZeile(e.entry);
    case EREIGNIS.ZUG_ENDE:
      return { typ: 'fertig', text: tx('Zug fertig', 'Turn done') };
    case EREIGNIS.AUFGABE_FEHLGESCHLAGEN:
      return { typ: 'fehler', text: kurz(e.message || tx('Aufgabe fehlgeschlagen', 'Task failed'), 300) };
    case EREIGNIS.VERDICHTEN_START:
      return { typ: 'schritt', text: tx('verdichtet den Verlauf', 'compacting the history') };
    default:
      return null;
  }
}

/**
 * Öffnet den Strom über alle Gespräche. `werte` ist der Stand beim Anhängen (Liste der
 * Gespräche), `start(listener)` beginnt zu liefern, `stop()` hängt alles wieder ab.
 */
export async function oeffneWirkenStrom(harness) {
  const streams = new Map();
  const titel = new Map();
  let listener = null;
  let aktiv = true;
  let laufend = false;
  const watches = [];

  const meta = (id) => titel.get(id) ?? { titel: id, art: 'mensch' };

  const haengen = async (id) => {
    if (!aktiv || streams.has(id)) return;
    streams.set(id, null);
    try {
      const strom = await ereignisse(harness, id);
      if (!aktiv) {
        await strom.stop().catch(() => {});
        return;
      }
      streams.set(id, strom);
      if (laufend) starteStrom(id, strom);
    } catch {
      streams.delete(id);
    }
  };

  const starteStrom = (id, strom) => {
    strom.start(async (ereignisse) => {
      if (!listener) return;
      for (const e of ereignisse) {
        if (ereignisArt(e) === EREIGNIS.STAND) continue; // Überlauf: der Fokus holt sich den Stand selbst
        const zeile = zeileAus(e);
        if (zeile) {
          const m = meta(id);
          await listener({ t: Date.now(), gespraech: id, titel: m.titel, art: m.art, ...zeile });
        }
      }
    });
  };

  const registerAnwenden = (reg) => {
    for (const a of reg?.agents ?? []) {
      titel.set(a.id, { titel: a.titel, art: a.art ?? 'mensch' });
      void haengen(a.id);
    }
  };
  const laeufeAnwenden = (liste) => {
    for (const e of Object.values(liste?.eintraege ?? {})) {
      if (!e.kindId) continue;
      titel.set(e.kindId, { titel: `${tx('Lauf', 'Run')} ${e.id}: ${e.titel ?? ''}`.trim(), art: 'lauf' });
      void haengen(e.kindId);
    }
  };

  registerAnwenden(await harness.snapshot(Register, CTX));
  laeufeAnwenden(await harness.snapshot(LaufListe, CTX));
  const regWatch = await harness.watchDoc(Register, CTX);
  const lfWatch = await harness.watchDoc(LaufListe, CTX);
  for (const w of [regWatch, lfWatch]) if (w) watches.push(w);

  // Alle anfänglichen Anhänge abwarten, damit `start` keinen Strom auslässt.
  for (let i = 0; i < 50 && [...streams.values()].some((s) => s === null); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }

  return {
    werte: () => ({
      gespraeche: [...titel.entries()].map(([id, m]) => ({ id, ...m })),
    }),
    start: (l) => {
      listener = l;
      laufend = true;
      for (const [id, strom] of streams) if (strom) starteStrom(id, strom);
      regWatch?.start(async (wert) => registerAnwenden(wert));
      lfWatch?.start(async (wert) => laeufeAnwenden(wert));
    },
    stop: async () => {
      aktiv = false;
      listener = null;
      for (const w of watches) await w.stop().catch(() => {});
      for (const s of streams.values()) await s?.stop?.().catch(() => {});
      streams.clear();
    },
  };
}
