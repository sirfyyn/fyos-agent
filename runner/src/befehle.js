/**
 * befehle.js — Slash-Befehle im Runner (Entwurf: docs/current/RUNNER-SLASH-BEFEHLE.md).
 *
 * Eine Nachricht an `POST /api/gespraech/:id/nachricht`, deren Text mit „/“ beginnt und einen bekannten
 * Befehl nennt, wird hier ausgeführt und erreicht das Modell nicht. Ein unbekanntes „/…“ ist normaler Text.
 * Skills (`/skill:name`) und Prompt-Vorlagen (`/name`) sind keine Befehle mit Seiteneffekt, sondern Modell-
 * Eingabe: sie werden zu Text ausgebaut (wie in Pi) und gehen als gewöhnliche Nachricht ans Modell.
 *
 * Befehle kommen nur über diesen Weg (Token, also Besitzer). Hub-Eingänge (Matrix, ITSM, Takt …) laufen über den
 * Ingress und sind nie Befehle, auch wenn ihr Text mit „/“ beginnt.
 *
 * Das Ergebnis steht als Eintrag `fyos.befehl` im Verlauf (nur Anzeige, das Modell sieht ihn nicht).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join, resolve, sep } from 'node:path';
import { KONTEXT, agentVon, eintragSchreiben, gespraechOeffnen, neuesteEintraege } from './lauf/index.js';
import { parse as yamlParse } from 'yaml';
import { AgentMeta, LaufListe, Register } from './documents.js';
import { modellListe } from './models.js';

const CTX = KONTEXT;
const ERGEBNIS_MAX = 8000;
const DATEI_MAX = 200 * 1024;
const NAME_RE = /^[A-Za-z][A-Za-z0-9:_-]{0,63}$/;
const ORDNERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const BESTAETIGUNG = '--ja';
/** Wie weit zurück (Einträge) nach dem Ergebnis einer schon ausgeführten requestId gesucht wird. */
const DEDUP_FENSTER = 200;

const kurz = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// --- Parser ----------------------------------------------------------------------------------

/** `/name rest` → {name, rest} oder `null`, wenn der Text kein Befehlsmuster hat. */
export function befehlParsen(text) {
  const m = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(String(text ?? '').trim());
  if (!m || !NAME_RE.test(m[1])) return null;
  return { name: m[1], rest: (m[2] ?? '').trim() };
}

/** Argumente wie in Pi (bash-artige Anführungszeichen). */
export function argumenteTeilen(s) {
  const out = [];
  let cur = '';
  let drin = false;
  let quote = null;
  for (const c of String(s ?? '')) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      drin = true;
    } else if (/\s/.test(c)) {
      if (drin) {
        out.push(cur);
        cur = '';
        drin = false;
      }
    } else {
      cur += c;
      drin = true;
    }
  }
  if (drin) out.push(cur);
  return out;
}

/** $1, $@, $ARGUMENTS, ${N:-x}, ${@:N}, ${@:N:L} wie in Pi. */
export function platzhalterErsetzen(inhalt, args) {
  const alle = args.join(' ');
  return inhalt.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_m, ziel, vorgabe, von, laenge, einfach) => {
      if (ziel) {
        const w = ziel === '@' || ziel === 'ARGUMENTS' ? alle : args[parseInt(ziel, 10) - 1];
        return w ? w : vorgabe;
      }
      if (von) {
        const start = Math.max(0, parseInt(von, 10) - 1);
        return laenge ? args.slice(start, start + parseInt(laenge, 10)).join(' ') : args.slice(start).join(' ');
      }
      if (einfach === 'ARGUMENTS' || einfach === '@') return alle;
      return args[parseInt(einfach, 10) - 1] ?? '';
    },
  );
}

function kopfTrennen(inhalt) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(inhalt);
  if (!m) return { kopf: {}, rumpf: inhalt };
  let kopf = {};
  try {
    const w = yamlParse(m[1]);
    if (w && typeof w === 'object') kopf = w;
  } catch {
    /* ohne Kopf lesen */
  }
  return { kopf, rumpf: m[2] };
}

/** Datei lesen, nur wenn sie wirklich unter `wurzel` liegt (keine Links hinaus) und klein ist. */
function sichereDatei(wurzel, pfad) {
  try {
    const echteWurzel = realpathSync(wurzel);
    const echt = realpathSync(pfad);
    if (!echt.startsWith(echteWurzel + sep)) return null;
    const st = statSync(echt);
    if (!st.isFile() || st.size > DATEI_MAX) return null;
    return readFileSync(echt, 'utf8');
  } catch {
    return null;
  }
}

function ordnerAusUmgebung(name) {
  return String(process.env[name] ?? '')
    .split(delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Skills eines Ordners: `<ordner>/<name>/SKILL.md`. */
export function skillsLesen(ordner) {
  const out = [];
  let eintraege = [];
  try {
    eintraege = readdirSync(ordner, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of eintraege) {
    if (!ORDNERNAME_RE.test(e.name)) continue;
    const datei = join(ordner, e.name, 'SKILL.md');
    if (!existsSync(datei)) continue;
    const inhalt = sichereDatei(ordner, datei);
    if (inhalt === null) continue;
    const { kopf, rumpf } = kopfTrennen(inhalt);
    const name = ORDNERNAME_RE.test(String(kopf.name ?? '')) ? String(kopf.name) : e.name;
    out.push({ name, beschreibung: kurz(kopf.description ?? '', 200), datei, ordner: join(ordner, e.name), rumpf: rumpf.trim(), wurzel: ordner });
  }
  return out;
}

/** Prompt-Vorlagen eines Ordners: `<ordner>/<name>.md`. */
export function vorlagenLesen(ordner) {
  const out = [];
  let eintraege = [];
  try {
    eintraege = readdirSync(ordner, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of eintraege) {
    if (!e.name.endsWith('.md')) continue;
    const name = e.name.slice(0, -3);
    if (!NAME_RE.test(name) || name.includes(':')) continue;
    const inhalt = sichereDatei(ordner, join(ordner, e.name));
    if (inhalt === null) continue;
    const { kopf, rumpf } = kopfTrennen(inhalt);
    const erste = rumpf.split('\n').find((z) => z.trim()) ?? '';
    out.push({
      name,
      beschreibung: kurz(kopf.description || erste, 120),
      argumente: typeof kopf['argument-hint'] === 'string' ? kopf['argument-hint'] : null,
      rumpf,
    });
  }
  return out;
}

// --- Befehle ---------------------------------------------------------------------------------

const PERSONA_HINWEIS = (name) =>
  `Das ist Ginnys Hauptgespräch. /${name} ändert es für alle Clients und für ihre laufende Arbeit. ` +
  `Zum Ausführen: /${name} ... ${BESTAETIGUNG}`;

export class Befehle {
  constructor({ runner, cfg, bruecken = {} } = {}) {
    this.runner = runner;
    this.cfg = cfg;
    /** Optionale Brücken zu Funktionen, die dieser Runner (noch) nicht selbst hat: { ruhe(args) }. */
    this.bruecken = bruecken;
    this.zaehler = { ausgefuehrt: 0, abgelehnt: 0, fehler: 0, modell: 0, zuletzt: null };
    this.eingebaut = this.#baueEingebaute();
    /** Laufende Befehle je `Gespräch:requestId` (gleichzeitige Doppelsendung). */
    this.#inArbeit = new Map();
  }

  #inArbeit;

  #baueEingebaute() {
    const e = (name, beschreibung, art, handler, extra = {}) => ({ name, beschreibung, art, handler, aliase: [], argumente: null, persona: false, ...extra });
    return [
      e('hilfe', 'Zeigt die Befehle dieses Gesprächs', 'anzeige', (c) => this.#hilfe(c), { aliase: ['help'] }),
      e('neu', 'Beginnt im Gespräch einen neuen Kontext (Verlauf bleibt sichtbar)', 'sitzung', (c) => this.#neu(c), { aliase: ['new'], argumente: '[Übergabe]', persona: true }),
      e('verdichten', 'Verdichtet den Kontext (Zusammenfassung)', 'verlauf', (c) => this.#verdichten(c), { aliase: ['compact'], argumente: '[Hinweis]', persona: true }),
      e('modell', 'Zeigt die Modelle oder wechselt das Modell dieses Gesprächs', 'modell', (c) => this.#modell(c), { aliase: ['model'], argumente: '[modell|standard]', persona: true }),
      e('name', 'Benennt das Gespräch', 'sitzung', (c) => this.#name(c), { argumente: '<Titel>' }),
      e('sitzung', 'Zeigt Modell, Verlauf, Token und Kosten dieses Gesprächs', 'anzeige', (c) => this.#sitzung(c), { aliase: ['session'] }),
      e('baum', 'Zeigt Ursprung und Zweige dieses Gesprächs', 'verlauf', (c) => this.#baum(c), { aliase: ['tree'] }),
      e('fork', 'Zweigt ab einer früheren Nachricht ab (ohne Argument: Liste)', 'verlauf', (c) => this.#fork(c), { argumente: '[Eintrag-Nr|letzte]' }),
      e('klon', 'Doppelt das Gespräch an der aktuellen Stelle', 'verlauf', (c) => this.#fork({ ...c, args: ['letzte'] }), { aliase: ['clone'] }),
      e('export', 'Schreibt den Verlauf als Markdown in den Arbeitsbereich', 'verlauf', (c) => this.#export(c), { argumente: '[name.md]' }),
      e('laden', 'Listet Gespräche; mit Nummer: Client wechselt dorthin', 'sitzung', (c) => this.#laden(c), { aliase: ['resume', 'fortsetzen'], argumente: '[Nr]' }),
      e('reload', 'Liest Skills und Prompt-Vorlagen neu', 'anzeige', (c) => this.#neuLesen(c)),
      e('live', 'Blendet den Strom der autonomen Arbeit im Client ein oder aus', 'bruecke', (c) => this.#live(c), { argumente: '[an|aus]' }),
      e('ruhe', 'Ruhe-Schalter des Agenten', 'bruecke', (c) => this.#ruhe(c), { argumente: '[an|aus]', persona: true }),
      e('stopp', 'Bricht den laufenden Zug dieses Gesprächs ab', 'bruecke', (c) => this.#stopp(c), { aliase: ['abbrechen'] }),
      ...this.#terminalBefehle(),
    ];
  }

  #terminalBefehle() {
    const t = (name, beschreibung, grund) => ({
      name,
      beschreibung,
      art: 'terminal',
      aliase: [],
      argumente: null,
      persona: false,
      handler: () => ({ ok: false, text: `/${name} gibt es im Runner nicht. ${grund}` }),
    });
    return [
      t('settings', 'Pi: Einstellungsmenü', 'Es ist eine Terminal-Oberfläche. Einstellungen stehen in der Runner-Konfiguration (agent-runner.json).'),
      t('scoped-models', 'Pi: Modelle für Strg+P', 'Es gibt keine Tastenfolge zum Durchschalten. /modell zeigt die Auswahl.'),
      t('thinking', 'Pi: Denkstufe', 'Die Hausmodell-Modelle denken nicht stufenweise (reasoning aus).'),
      t('import', 'Pi: Sitzung aus JSONL laden', 'Gespräche liegen in SQLite, nicht in Pi-JSONL-Dateien.'),
      t('share', 'Pi: Sitzung teilen', 'Das Teilen nach außen (Gist, Artefakt) ist im Runner nicht vorgesehen. /export schreibt eine lokale Datei.'),
      t('bug', 'Pi: Fehlerbericht an die Pi-Entwickler', 'Es sendet Daten nach außen; Fehler meldet man als Vorgang im ITSM.'),
      t('copy', 'Pi: letzte Antwort kopieren', 'Das Kopieren macht der Client (Zwischenablage).'),
      t('changelog', 'Pi: Änderungsliste', 'Die Runner-Änderungen stehen in docs/current/PI-DURABLE-RUNNER.md.'),
      t('hotkeys', 'Pi: Tastenkürzel', 'Es ist eine Terminal-Oberfläche; Kürzel gehören zum jeweiligen Client.'),
      t('trust', 'Pi: Projektvertrauen speichern', 'Der Runner fragt nicht nach Projektvertrauen; Grenzen setzen Token und Befehlswächter.'),
      t('login', 'Pi: Anbieter anmelden', 'Anmelden hat Wirkung nach außen und wird nie per Chat ausgeführt. Hausmodell braucht keine Anmeldung.'),
      t('logout', 'Pi: Anbieter abmelden', 'Abmelden hat Wirkung nach außen und wird nie per Chat ausgeführt.'),
      t('quit', 'Pi: Beenden', 'Ein Runner-Dienst wird nicht aus dem Chat beendet. Der Client schließt sich selbst.'),
      t('debug', 'Pi: Debug-Ausgabe', 'Zustand zeigen /sitzung und der Steuerkanal (/zustand).'),
    ];
  }

  // --- Verzeichnis -------------------------------------------------------------------------

  async #cwd(id) {
    try {
      const conv = await gespraechOeffnen(this.runner.harness, id);
      return conv ? ((await agentVon(conv)).cwd ?? null) : null;
    } catch {
      return null;
    }
  }

  #skillOrdner(cwd) {
    const eigene = Array.isArray(this.cfg.befehle?.skillordner) ? this.cfg.befehle.skillordner : [];
    return [
      ...(cwd ? [join(cwd, '.agents', 'skills'), join(cwd, 'skills', 'agenten')] : []),
      ...eigene.map((p) => resolve(String(p))),
      ...ordnerAusUmgebung('FYOS_SKILL_DIRS'),
    ];
  }

  #vorlagenOrdner(cwd) {
    const eigene = Array.isArray(this.cfg.befehle?.vorlagenordner) ? this.cfg.befehle.vorlagenordner : [];
    const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
    return [
      ...(cwd ? [join(cwd, '.pi', 'prompts')] : []),
      join(agentDir, 'prompts'),
      ...eigene.map((p) => resolve(String(p))),
      ...ordnerAusUmgebung('FYOS_PROMPT_DIRS'),
    ];
  }

  async skills(id) {
    const cwd = await this.#cwd(id);
    const gesehen = new Map();
    for (const o of this.#skillOrdner(cwd)) for (const s of skillsLesen(o)) if (!gesehen.has(s.name)) gesehen.set(s.name, s);
    return [...gesehen.values()];
  }

  async vorlagen(id) {
    const cwd = await this.#cwd(id);
    const gesehen = new Map();
    for (const o of this.#vorlagenOrdner(cwd)) for (const v of vorlagenLesen(o)) if (!gesehen.has(v.name)) gesehen.set(v.name, v);
    return [...gesehen.values()];
  }

  #eingebauter(name) {
    const n = name.toLowerCase();
    return this.eingebaut.find((b) => b.name === n || b.aliase.includes(n)) ?? null;
  }

  /** Alle Befehle für `GET /api/befehle` (für das Gespräch `id`, sonst der Standardbereich). */
  async liste(id = null) {
    const rootId = this.runner.root?.id ?? null;
    const basis = this.eingebaut.map((b) => ({
      name: b.name,
      beschreibung: b.beschreibung,
      argumente: b.argumente,
      art: b.art,
      aliase: b.aliase,
      persona_bestaetigung: b.persona,
    }));
    const skills = (await this.skills(id ?? rootId)).map((s) => ({
      name: `skill:${s.name}`,
      beschreibung: s.beschreibung,
      argumente: '[Text]',
      art: 'skill',
      aliase: [],
      persona_bestaetigung: false,
    }));
    const eingebauteNamen = new Set(this.eingebaut.flatMap((b) => [b.name, ...b.aliase]));
    const vorlagen = (await this.vorlagen(id ?? rootId))
      .filter((v) => !eingebauteNamen.has(v.name.toLowerCase()))
      .map((v) => ({
        name: v.name,
        beschreibung: v.beschreibung,
        argumente: v.argumente,
        art: 'vorlage',
        aliase: [],
        persona_bestaetigung: false,
      }));
    return [...basis, ...skills, ...vorlagen];
  }

  async zustand() {
    const l = await this.liste(null).catch(() => []);
    return {
      anzahl: l.length,
      eingebaut: l.filter((b) => !['skill', 'vorlage'].includes(b.art)).length,
      skills: l.filter((b) => b.art === 'skill').length,
      vorlagen: l.filter((b) => b.art === 'vorlage').length,
      ...this.zaehler,
    };
  }

  // --- Ausführen ---------------------------------------------------------------------------

  /**
   * Behandelt `text`, wenn er ein bekannter Befehl ist.
   * @returns {Promise<null | {modell: true, text: string, name: string, art: string} | {modell: false, name, ok, text, aktion?}>}
   *   `null`: kein Befehl, der Text geht unverändert ans Modell.
   */
  async versuche(id, text, { requestId } = {}) {
    const p = befehlParsen(text);
    if (!p) return null;

    const b = this.#eingebauter(p.name);
    if (b) {
      const rid = requestId ? String(requestId).slice(0, 120) : null;
      if (!rid) return this.#ausfuehren(id, text, b, p, null);
      // Idempotenz: dieselbe requestId im selben Gespräch führt den Befehl nicht noch einmal aus.
      // 1. läuft er gerade, bekommt der zweite Aufruf dasselbe Ergebnis; 2. steht sein Ergebnis im Verlauf
      // (Eintrag `fyos.befehl` mit der requestId, SQLite, übersteht Neustarts), kommt dieses zurück.
      const schluessel = `${id}:${rid}`;
      const laeuft = this.#inArbeit.get(schluessel);
      if (laeuft) return { ...(await laeuft), wiederholt: true };
      const arbeit = (async () => {
        const frueher = await this.#frueheresErgebnis(id, rid);
        if (frueher) return { ...frueher, wiederholt: true };
        return this.#ausfuehren(id, text, b, p, rid);
      })();
      this.#inArbeit.set(schluessel, arbeit);
      try {
        return await arbeit;
      } finally {
        this.#inArbeit.delete(schluessel);
      }
    }

    if (p.name.startsWith('skill:')) {
      const name = p.name.slice(6);
      const skill = (await this.skills(id)).find((s) => s.name === name);
      if (!skill) return null; // unbekannter Skill: Pi reicht den Text ebenso weiter
      this.zaehler.modell += 1;
      const block = `<skill name="${skill.name}" location="${skill.datei}">\nReferences are relative to ${skill.ordner}.\n\n${skill.rumpf}\n</skill>`;
      return { modell: true, name: p.name, art: 'skill', text: p.rest ? `${block}\n\n${p.rest}` : block };
    }

    const vorlage = (await this.vorlagen(id)).find((v) => v.name === p.name);
    if (vorlage) {
      this.zaehler.modell += 1;
      return { modell: true, name: p.name, art: 'vorlage', text: platzhalterErsetzen(vorlage.rumpf, argumenteTeilen(p.rest)) };
    }
    return null;
  }

  /** Das gespeicherte Ergebnis eines Befehls mit dieser requestId aus den letzten Einträgen, sonst `null`. */
  async #frueheresErgebnis(id, rid) {
    try {
      const conv = await gespraechOeffnen(this.runner.harness, id);
      if (!conv) return null;
      const e = (await neuesteEintraege(conv, DEDUP_FENSTER)).find((x) => x.kind === 'fyos.befehl' && x.data?.requestId === rid);
      if (!e) return null;
      const d = e.data;
      return { modell: false, name: d.name, ok: d.ok !== false, text: String(d.text ?? ''), ...(d.aktion ? { aktion: d.aktion } : {}) };
    } catch {
      return null;
    }
  }

  async #ausfuehren(id, eingabe, b, p, rid = null) {
    const teile = argumenteTeilen(p.rest);
    const bestaetigt = teile.includes(BESTAETIGUNG);
    const args = teile.filter((t) => t !== BESTAETIGUNG);
    const root = this.runner.root?.id === id;
    const ctx = { id, root, args, rest: args.join(' '), bestaetigt, befehl: b };
    let erg;
    try {
      if (b.persona && root && !bestaetigt && this.#veraendert(b.name, args)) {
        erg = { ok: false, text: PERSONA_HINWEIS(p.name.toLowerCase()), abgelehnt: true };
      } else if (b.persona && (await this.#istLaufKind(id)) && this.#veraendert(b.name, args)) {
        erg = { ok: false, text: 'Ein Lauf wird über „Lauf abbrechen“ gesteuert, nicht über /' + b.name + '.', abgelehnt: true };
      } else {
        erg = await b.handler(ctx);
      }
    } catch (fehler) {
      erg = { ok: false, text: `/${b.name} fehlgeschlagen: ${fehler.message}`, fehler: true };
    }
    if (erg.abgelehnt) this.zaehler.abgelehnt += 1;
    else if (erg.fehler) this.zaehler.fehler += 1;
    else this.zaehler.ausgefuehrt += 1;
    this.zaehler.zuletzt = { name: b.name, ok: erg.ok !== false, zeit: Date.now() };
    const ergebnis = {
      modell: false,
      name: b.name,
      ok: erg.ok !== false,
      text: String(erg.text ?? '').slice(0, ERGEBNIS_MAX),
      ...(erg.aktion ? { aktion: erg.aktion } : {}),
    };
    await this.#imVerlauf(id, eingabe, ergebnis, rid);
    return ergebnis;
  }

  /** Ändert der Aufruf etwas? (Nur dann braucht Ginnys Hauptgespräch die Bestätigung.) */
  #veraendert(name, args) {
    if (name === 'modell') return args.length > 0;
    if (name === 'ruhe') return args.length > 0;
    return true;
  }

  async #istLaufKind(id) {
    const doc = (await this.runner.harness.snapshot(LaufListe, CTX).catch(() => null)) ?? { eintraege: {} };
    return Object.values(doc.eintraege ?? {}).some((e) => String(e.kindId) === String(id));
  }

  async #imVerlauf(id, eingabe, ergebnis, rid = null) {
    try {
      const conv = await gespraechOeffnen(this.runner.harness, id);
      await eintragSchreiben(conv, {
        // Die Anfragekennung macht auch ein doppeltes Schreiben idempotent: kein zweiter Eintrag.
        ...(rid ? { anfrageId: `befehl:${rid}` } : {}),
        eintrag: {
          art: 'fyos.befehl',
          daten: {
            name: ergebnis.name,
            eingabe: kurz(eingabe, 400),
            ok: ergebnis.ok,
            text: ergebnis.text,
            aktion: ergebnis.aktion ?? null,
            requestId: rid,
            zeit: Date.now(),
          },
        },
      });
    } catch (fehler) {
      console.error(`[fyos-befehle] Ergebnis nicht im Verlauf abgelegt: ${fehler.message}`);
    }
  }

  // --- Die Befehle -------------------------------------------------------------------------

  async #hilfe(c) {
    const l = await this.liste(c.id);
    const zeile = (b) => `/${b.name}${b.argumente ? ` ${b.argumente}` : ''} – ${b.beschreibung}`;
    const gruppe = (titel, f) => {
      const z = l.filter(f).map(zeile);
      return z.length ? `**${titel}**\n${z.join('\n')}` : '';
    };
    const text = [
      gruppe('Gespräch und Verlauf', (b) => ['sitzung', 'verlauf', 'modell', 'anzeige'].includes(b.art)),
      gruppe('Brücken zum Runner', (b) => b.art === 'bruecke'),
      gruppe('Skills (gehen als Text ans Modell)', (b) => b.art === 'skill'),
      gruppe('Prompt-Vorlagen (gehen als Text ans Modell)', (b) => b.art === 'vorlage'),
      `Nur im Pi-Terminal: ${l.filter((b) => b.art === 'terminal').map((b) => `/${b.name}`).join(' ')}`,
      `Im Hauptgespräch von Persona verlangen verändernde Befehle ${BESTAETIGUNG} am Ende.`,
    ]
      .filter(Boolean)
      .join('\n\n');
    return { text };
  }

  async #neu(c) {
    await this.runner.leeren(c.id, c.rest || undefined);
    return { text: 'Neuer Kontext begonnen. Der bisherige Verlauf bleibt sichtbar, das Modell sieht ihn nicht mehr.' };
  }

  async #verdichten(c) {
    if (c.root) {
      return {
        ok: false,
        abgelehnt: true,
        text: 'Im Hauptgespräch verdichtet der Runner selbst (Schwelle, Hintergrund). Von Hand verdichtet man ein anderes Gespräch.',
      };
    }
    const task = await this.runner.verdichten(c.id, c.rest || undefined);
    return { text: `Verdichtung gestartet (Aufgabe ${task}). Der Verlauf bleibt nutzbar, die Zusammenfassung wird an der nächsten Grenze eingefügt.` };
  }

  async #modell(c) {
    const liste = modellListe(this.cfg);
    const meta = (await this.runner.harness.snapshot(AgentMeta, c.id, CTX).catch(() => null)) ?? {};
    const conv = await gespraechOeffnen(this.runner.harness, c.id);
    const agent = conv ? await agentVon(conv) : null;
    const aktuell = agent?.model?.modelId ?? meta.modell ?? this.cfg.pi_durable.model.default;
    const zeilen = liste.map((m) => `${m.id === aktuell ? '▸' : ' '} ${m.provider}/${m.id}${m.max ? ' (Vorfahrt)' : ''}`);
    if (c.args.length === 0) {
      return {
        text: `Modell: ${aktuell}${meta.modell ? '' : ' (Vorgabe)'}\n${zeilen.join('\n')}\nWechseln: /modell <Name> · zurück: /modell standard`,
      };
    }
    const wunsch = c.args[0].toLowerCase();
    if (wunsch === 'standard') {
      await this.runner.aendereGespraech(c.id, { modell: null });
      return { text: 'Modell zurück auf die Vorgabe (richtet sich nach der Bahn).' };
    }
    const treffer = liste.filter((m) => m.id.toLowerCase() === wunsch || `${m.provider}/${m.id}`.toLowerCase() === wunsch);
    if (treffer.length !== 1) {
      return { ok: false, text: `Unbekanntes Modell „${c.args[0]}“.\n${zeilen.join('\n')}` };
    }
    await this.runner.aendereGespraech(c.id, { modell: treffer[0].id });
    return { text: `Modell dieses Gesprächs: ${treffer[0].provider}/${treffer[0].id}` };
  }

  async #name(c) {
    if (!c.rest) {
      const meta = (await this.runner.harness.snapshot(AgentMeta, c.id, CTX).catch(() => null)) ?? {};
      return { text: `Name: ${meta.titel ?? '(ohne)'}. Ändern: /name <Titel>` };
    }
    const g = await this.runner.aendereGespraech(c.id, { titel: c.rest });
    return { text: `Gespräch heißt jetzt „${g.meta?.titel ?? c.rest}“.` };
  }

  async #sitzung(c) {
    const g = await this.runner.gespraech(c.id);
    if (!g) return { ok: false, text: 'Gespräch nicht gefunden.' };
    const a = await this.runner.ansicht(c.id);
    const nutzer = a.entries.filter((e) => (e.model ?? []).some((m) => m.role === 'user')).length;
    const antworten = a.entries.filter((e) => (e.model ?? []).some((m) => m.role === 'assistant')).length;
    const werkzeuge = a.entries.filter((e) => (e.model ?? []).some((m) => m.role === 'toolResult')).length;
    const u = g.usage ?? { models: {}, tools: {} };
    const summe = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, kosten: 0 };
    for (const w of Object.values(u.models ?? {})) {
      summe.input += Number(w.input ?? 0);
      summe.output += Number(w.output ?? 0);
      summe.cacheRead += Number(w.cacheRead ?? 0);
      summe.cacheWrite += Number(w.cacheWrite ?? 0);
      summe.kosten += Number(w.cost?.total ?? 0);
    }
    const zeichen = JSON.stringify(a.entries.flatMap((e) => e.model ?? [])).length;
    const fenster = modellListe(this.cfg).length ? 262144 : null;
    const zahl = (n) => n.toLocaleString('de-DE');
    const text = [
      `**${g.meta?.titel ?? 'Gespräch'}** (Nr. ${c.id}${c.root ? ', Hauptgespräch' : ''})`,
      `Modell: ${g.agent?.model ? `${g.agent.model.provider}/${g.agent.model.modelId}` : '–'} · Arbeitsbereich: ${g.meta?.arbeitsbereich ?? '–'}`,
      `Nachrichten: ${a.messages} im Kontext · ${nutzer} Eingaben · ${antworten} Antworten · ${werkzeuge} Werkzeugergebnisse`,
      `Kontext: etwa ${zahl(Math.round(zeichen / 4))} Token${fenster ? ` von ${zahl(fenster)}` : ''} (geschätzt)`,
      `Token gesamt: Eingabe ${zahl(summe.input)} · Ausgabe ${zahl(summe.output)} · Cache gelesen ${zahl(summe.cacheRead)}`,
      `Kosten: ${summe.kosten > 0 ? `$${summe.kosten.toFixed(3)}` : 'keine (lokales Modell)'}`,
    ].join('\n');
    return { text };
  }

  async #baum(c) {
    const reg = (await this.runner.harness.snapshot(Register, CTX).catch(() => null)) ?? { agents: [] };
    const alle = reg.agents ?? [];
    const ich = alle.find((a) => a.id === c.id);
    const eltern = ich?.parent ? alle.find((a) => a.id === ich.parent) : null;
    const kinder = alle.filter((a) => a.parent === c.id && !a.archiviert);
    const z = (a) => `Nr. ${a.id} · ${a.titel}`;
    const text = [
      eltern ? `Ursprung: ${z(eltern)}` : 'Ursprung: keiner (eigenständiges Gespräch)',
      kinder.length ? `Zweige:\n${kinder.map((k) => `  ${z(k)}`).join('\n')}` : 'Zweige: keine',
      'Abzweigen: /fork · wechseln: /laden <Nr>',
    ].join('\n');
    return { text };
  }

  async #nutzerEintraege(id) {
    const a = await this.runner.ansicht(id);
    return a.entries.filter((e) => (e.model ?? []).some((m) => m.role === 'user'));
  }

  async #fork(c) {
    const nutzer = await this.#nutzerEintraege(c.id);
    const arg = c.args[0];
    if (!arg) {
      if (!nutzer.length) return { text: 'Noch keine Nachricht zum Abzweigen.' };
      const text = ['Abzweigen ab (Eintrag-Nr, Anfang der Nachricht):']
        .concat(nutzer.slice(-10).map((e) => `  ${e.id} · ${kurz(textVon(e), 70)}`))
        .concat('/fork <Eintrag-Nr> zweigt nach dieser Nachricht ab, /fork letzte an der aktuellen Stelle.')
        .join('\n');
      return { text };
    }
    let eintragId;
    if (arg === 'letzte') {
      eintragId = undefined; // Runner nimmt den neuesten Eintrag
    } else {
      const ziel = nutzer.find((e) => String(e.id) === arg);
      if (!ziel) return { ok: false, text: `Eintrag ${arg} ist keine Nachricht dieses Gesprächs. /fork zeigt die Liste.` };
      eintragId = ziel.id;
    }
    const g = await this.runner.zweig(c.id, eintragId, undefined);
    return {
      text: `Zweig angelegt: Nr. ${g.id} „${g.meta?.titel ?? ''}“. Der Client wechselt dorthin.`,
      aktion: { art: 'fokus', gespraech: g.id },
    };
  }

  async #export(c) {
    const cwd = await this.#cwd(c.id);
    if (!cwd) return { ok: false, text: 'Dieses Gespräch hat keinen Arbeitsbereich.' };
    let name = c.args[0];
    if (name !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.md$/.test(name)) {
      return { ok: false, text: 'Dateiname: nur Buchstaben, Ziffern, Punkt, Strich, Unterstrich, Endung .md. Ohne Namen vergibt der Runner einen.' };
    }
    name = name ?? `gespraech-${c.id}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`;
    const a = await this.runner.ansicht(c.id);
    const meta = a.meta ?? {};
    const teile = [`# ${meta.titel ?? `Gespräch ${c.id}`}`, `Exportiert ${new Date().toISOString()} · Gespräch ${c.id}`, ''];
    for (const e of a.entries) {
      if (e.kind === 'fyos.befehl') {
        teile.push(`> \`${e.data?.eingabe ?? ''}\`\n> ${String(e.data?.text ?? '').split('\n').join('\n> ')}`, '');
        continue;
      }
      for (const m of e.model ?? []) teile.push(`## ${rolle(m.role)}`, '', blockText(m.content), '');
    }
    const ordner = join(cwd, '.fyos-export');
    mkdirSync(ordner, { recursive: true });
    const ziel = join(ordner, basename(name));
    writeFileSync(ziel, `${teile.join('\n')}\n`, { mode: 0o600 });
    return { text: `Verlauf exportiert: ${ziel}`, aktion: { art: 'datei', pfad: ziel } };
  }

  async #laden(c) {
    const liste = (await this.runner.gespraeche()).filter((g) => !g.archiviert);
    const arg = c.args[0];
    if (!arg) {
      const text = ['Gespräche (Nr · Titel):']
        .concat(liste.map((g) => `${g.id === c.id ? '▸' : ' '} ${g.id} · ${g.titel}${g.art === 'root' ? ' (Hauptgespräch)' : ''}`))
        .concat('/laden <Nr> wechselt dorthin.')
        .join('\n');
      return { text };
    }
    const ziel = liste.find((g) => String(g.id) === arg);
    if (!ziel) return { ok: false, text: `Gespräch ${arg} gibt es nicht. /laden zeigt die Liste.` };
    return { text: `Wechsel zu Nr. ${ziel.id} „${ziel.titel}“.`, aktion: { art: 'fokus', gespraech: ziel.id } };
  }

  async #neuLesen(c) {
    const s = (await this.skills(c.id)).length;
    const v = (await this.vorlagen(c.id)).length;
    return { text: `Skills und Vorlagen neu gelesen: ${s} Skills, ${v} Vorlagen.` };
  }

  #live(c) {
    const w = (c.args[0] ?? '').toLowerCase();
    const wert = ['an', 'ein'].includes(w) ? 'an' : w === 'aus' ? 'aus' : 'umschalten';
    return { text: `Live: Anzeige im Client (${wert}). Der Agent arbeitet unverändert weiter.`, aktion: { art: 'live', wert } };
  }

  async #ruhe(c) {
    if (typeof this.bruecken.ruhe !== 'function') {
      return { ok: false, text: 'Der Ruhe-Schalter ist in diesem Runner noch nicht eingebaut (Zweig feat/ruhe-schalter).' };
    }
    const r = await this.bruecken.ruhe(c.args[0] ?? null, { gespraech: c.id });
    return { text: String(r?.text ?? 'Ruhe gesetzt.') };
  }

  async #stopp(c) {
    await this.runner.abbrechen(c.id);
    return { text: 'Laufenden Zug abgebrochen.' };
  }
}

function rolle(r) {
  return r === 'user' ? 'Du' : r === 'assistant' ? 'Agent' : r === 'toolResult' ? 'Werkzeug' : String(r);
}

function blockText(content) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : [])
    .map((b) => {
      if (b?.type === 'text') return b.text;
      if (b?.type === 'toolCall') return `_Werkzeug ${b.name}_`;
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function textVon(entry) {
  const m = (entry.model ?? []).find((x) => x.role === 'user');
  return blockText(m?.content);
}
