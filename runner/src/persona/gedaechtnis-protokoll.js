/**
 * persona/gedaechtnis-protokoll.js — Tagesprotokoll: je Tag und Gespräch eine knappe Episode (Plan S5, Schicht „Episoden“).
 *
 * Quellen:
 *   - Gesprächsverlauf: der Ausgang (`egress.js`) reicht jedes Ereignis eines Gesprächs an `beobachte(id, ereignis)`.
 *     Daraus wird gezählt und zusammengefasst: was kam herein (Quelle, von wem, Anlass), welche Werkzeuge liefen (nur Namen
 *     und Zahlen, nie Argumente), wie viele Fehler, was zuletzt geantwortet wurde (gekürzt). Quellenverweis: Eingangs-IDs
 *     (`stromId`) und Aufruf-IDs fehlgeschlagener Werkzeuge.
 *   - Aufzeichnung: `tagAbschliessen(tag)` liest `aufzeichnung-<tag>.jsonl` und schreibt die Tageszeile (Eingänge je Quelle,
 *     Züge, Reflex-Entscheidungen) als Episode „tag“. Nur Zahlen.
 * Geschrieben wird beim Ende eines Zugs (`run_end`). Jede Zeile geht durch die Redaktion (`schwaerzen`), bevor sie in die Datei
 * kommt; die Episode enthält weder Tokens noch Passwörter noch Werkzeugargumente.
 * Ein Fehler hier hält den Ausgang nie auf.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schwaerzen } from './redaktion.js';

const kurz = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const einzeilig = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const tagVon = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Zahlen aus der Aufzeichnung eines Tages, oder null, wenn es keine Datei gibt. */
export function aufzeichnungZaehlen(ordner, tag) {
  const pfad = join(ordner, `aufzeichnung-${tag}.jsonl`);
  if (!existsSync(pfad)) return null;
  const z = { zeilen: 0, art: {}, eingang_quellen: {} };
  for (const zeile of readFileSync(pfad, 'utf8').split('\n')) {
    if (!zeile) continue;
    let r;
    try {
      r = JSON.parse(zeile);
    } catch {
      continue;
    }
    z.zeilen += 1;
    z.art[r.art] = (z.art[r.art] ?? 0) + 1;
    if (r.art === 'eingang') {
      const q = String(r.ereignis?.quelle ?? r.ereignis?.art ?? 'unbekannt').slice(0, 40);
      z.eingang_quellen[q] = (z.eingang_quellen[q] ?? 0) + 1;
    }
  }
  return z;
}

const liste = (o) =>
  Object.entries(o)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');

export class Tagesprotokoll {
  /**
   * @param {{ gedaechtnis: object, aufzeichnung?: {ordner: string}, jetzt?: () => number, log?: Function }} o
   */
  constructor({ gedaechtnis, aufzeichnung = null, jetzt = () => Date.now(), log = (z) => console.log(z) } = {}) {
    this.g = gedaechtnis;
    this.aufzeichnung = aufzeichnung;
    this.jetzt = jetzt;
    this.log = log;
    this.k = new Map(); // `${tag}|${gespräch}` → Sammler
    this.live = new Map(); // gespräch → laufender Antworttext
    this.letzterTag = null;
    this.offen = new Set(); // laufende Schreibvorgänge (für Tests: aufWarten)
  }

  #sammler(id) {
    const tag = tagVon(this.jetzt());
    if (this.letzterTag && this.letzterTag !== tag) {
      const alt = this.letzterTag;
      this.#merken(this.tagAbschliessen(alt));
    }
    this.letzterTag = tag;
    const key = `${tag}|${id}`;
    if (!this.k.has(key)) {
      this.k.set(key, { tag, id: String(id), zuege: 0, eingaenge: [], quellen: new Set(), mit: new Set(), werkzeuge: {}, fehler: 0, fehlerIds: [], ergebnis: '', geaendert: false });
    }
    return this.k.get(key);
  }

  #merken(p) {
    const q = Promise.resolve(p).catch((f) => this.log(`[fyos-gedaechtnis] Protokoll: ${f?.message ?? f}`));
    this.offen.add(q);
    q.finally(() => this.offen.delete(q));
  }

  async aufWarten() {
    await Promise.all([...this.offen]);
  }

  /** Ein Ereignis des Gesprächs `id` (Form wie in egress.js `#uebersetzen`). Wirft nie. */
  beobachte(id, e) {
    try {
      if (!this.g?.an || !e) return;
      switch (e.type) {
        case 'message_update': {
          for (const c of e.changes ?? []) if (c.type === 'text_delta' && c.delta) this.live.set(id, kurz(`${this.live.get(id) ?? ''}${c.delta}`, 4000));
          break;
        }
        case 'message_start':
          this.live.set(id, '');
          break;
        case 'message_end': {
          this.#eingang(id, e.entry);
          const s = this.#sammler(id);
          const t = this.live.get(id) ?? '';
          if (t.trim()) {
            s.ergebnis = t;
            s.geaendert = true;
          }
          this.live.delete(id);
          break;
        }
        case 'entry_appended':
          this.#eingang(id, e.entry);
          break;
        case 'tool_execution_end': {
          const s = this.#sammler(id);
          const name = String(e.toolName ?? 'unbekannt').slice(0, 60);
          s.werkzeuge[name] = (s.werkzeuge[name] ?? 0) + 1;
          if (e.entry?.data?.isError || e.entry?.model?.some?.((m) => m?.isError)) {
            s.fehler += 1;
            if (s.fehlerIds.length < 10 && e.toolCallId) s.fehlerIds.push(String(e.toolCallId).slice(0, 60));
          }
          s.geaendert = true;
          break;
        }
        case 'run_end': {
          const s = this.#sammler(id);
          s.zuege += 1;
          s.geaendert = true;
          this.#merken(this.#schreiben(s));
          break;
        }
        default:
          break;
      }
    } catch (f) {
      this.log(`[fyos-gedaechtnis] Protokoll: ${f?.message ?? f}`);
    }
  }

  #eingang(id, entry) {
    if (entry?.kind !== 'fyos.eingang' || !entry.data?.stromId) return;
    const s = this.#sammler(id);
    const d = entry.data;
    if (s.quellen.has(String(d.stromId))) return;
    s.quellen.add(String(d.stromId).slice(0, 80));
    s.mit.add(d.klasse === 'max' ? 'Besitzer' : String(d.von ?? d.quelle ?? 'hub').slice(0, 40));
    if (s.eingaenge.length < 6) s.eingaenge.push({ quelle: String(d.quelle ?? 'hub').slice(0, 30), text: kurz(einzeilig(d.text), 160) });
    s.geaendert = true;
  }

  /** Der Fließtext einer Episode; ohne Geheimnisse (Redaktion), ohne Werkzeugargumente. */
  text(s) {
    const teile = [`Am ${s.tag} im Gespräch ${s.id}: ${s.zuege} ${s.zuege === 1 ? 'Zug' : 'Züge'}.`];
    if (s.mit.size) teile.push(`Mit: ${[...s.mit].join(', ')}.`);
    if (s.eingaenge.length) teile.push(`Anlass: ${s.eingaenge.map((x) => `${x.quelle}: „${x.text}“`).join('; ')}.`);
    if (Object.keys(s.werkzeuge).length) teile.push(`Werkzeuge: ${liste(s.werkzeuge)}.`);
    if (s.fehler) teile.push(`Fehlgeschlagene Werkzeugaufrufe: ${s.fehler}.`);
    if (s.ergebnis) teile.push(`Zuletzt gesagt: „${kurz(einzeilig(s.ergebnis), 300)}“`);
    return schwaerzen(teile.join(' '));
  }

  async #schreiben(s) {
    if (!s.geaendert) return null;
    s.geaendert = false;
    return this.g.episodeSchreiben({
      tag: s.tag,
      gespraech: s.id,
      text: this.text(s),
      zaehler: { zuege: s.zuege, eingaenge: s.quellen.size, werkzeuge: s.werkzeuge, fehler: s.fehler },
      quellen: [...s.quellen, ...s.fehlerIds.map((x) => `aufruf:${x}`)],
    });
  }

  /** Schreibt alles Offene aus (z. B. beim Beenden). */
  async leeren() {
    for (const s of this.k.values()) await this.#schreiben(s).catch((f) => this.log(`[fyos-gedaechtnis] Protokoll: ${f?.message ?? f}`));
  }

  /** Die Tageszeile aus der Aufzeichnung als Episode „tag“; null, wenn es keine Aufzeichnung gab. */
  async tagAbschliessen(tag) {
    if (!this.g?.an || !this.aufzeichnung?.ordner) return null;
    const z = aufzeichnungZaehlen(this.aufzeichnung.ordner, tag);
    if (!z) return null;
    const text = schwaerzen(
      `Tag ${tag} laut Aufzeichnung: ${z.zeilen} Zeilen. Eingänge${Object.keys(z.eingang_quellen).length ? ` (${liste(z.eingang_quellen)})` : ': keine'}; ` +
        `${z.art.zug ?? 0} Züge, ${z.art.entscheidung ?? 0} Reflex-Entscheidungen, ${z.art.welt ?? 0} Weltbilder.`,
    );
    return this.g.episodeSchreiben({ tag, gespraech: 'tag', text, zaehler: z.art, quellen: [`aufzeichnung-${tag}.jsonl`] });
  }
}
