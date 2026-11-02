/**
 * knoten.js — derselbe Rechner, dieselben Nachbarn.
 *
 * Der Runner darf nicht in einem engen Kästchen leben. Auf dem Gerät arbeitet er mit bash,
 * auf den anderen Knoten über ssh. Jeder Knoten hat einen Namen, einen Weg und einen
 * Prüfbefehl; die Liste steht in der Konfiguration, nicht im Modell.
 *
 * Der Befehl läuft bewusst als echter Befehl: keine Attrappe, kein „nur lesen“. Was ein
 * Mensch auf dem Knoten darf, darf der Agent auch — aber ein zerstörerischer Befehl wird
 * nicht stillschweigend als harmlos ausgegeben. Die Freigabe-Regel für Hub-Werkzeuge bleibt
 * davon unberührt.
 */
import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import { Schema as Type, werkzeug as defineTool } from './lauf/index.js';

const textErgebnis = (text) => ({ output: [{ type: 'text', text: String(text ?? '') }] });

const KURZ = (s, n = 600) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

const LOKAL = new Set(['127.0.0.1', '::1', 'localhost']);

function normalisiere(cfg) {
  const geraet = cfg.pi_durable.device;
  const geraetId = geraet?.id || 'lokal';
  const ausConfig = Array.isArray(cfg.pi_durable.nodes) ? cfg.pi_durable.nodes : [];
  const knoten = [];
  const gesehen = new Set();

  for (const roh of ausConfig) {
    if (!roh || typeof roh !== 'object') continue;
    const id = String(roh.id ?? '').trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,32}$/.test(id) || gesehen.has(id)) continue;
    gesehen.add(id);
    knoten.push({
      id,
      titel: String(roh.titel ?? roh.name ?? id).slice(0, 80),
      art: String(roh.art ?? roh.kind ?? 'linux').slice(0, 24),
      host: roh.host ? String(roh.host).trim() : null,
      user: roh.user ? String(roh.user).trim() : null,
      port: Number.isFinite(Number(roh.port)) ? Number(roh.port) : null,
      alias: roh.alias ? String(roh.alias).trim() : null,
      cwd: roh.cwd ? String(roh.cwd) : null,
      notiz: roh.notiz ? String(roh.notiz).slice(0, 200) : null,
      local: roh.local === true,
    });
  }

  // Das Gerät, auf dem der Runner läuft, ist immer Knoten 0.
  if (!gesehen.has(geraetId)) {
    knoten.unshift({
      id: geraetId,
      titel: geraet?.name ?? 'Dieses Gerät',
      art: geraet?.kind ?? 'lokal',
      host: '127.0.0.1',
      user: userInfo().username,
      port: null,
      alias: null,
      cwd: null,
      notiz: 'lokaler Runner',
      local: true,
    });
  }
  for (const k of knoten) {
    if (k.id === geraetId || LOKAL.has(k.host ?? '') || k.local) {
      k.local = true;
      k.host = k.host ?? '127.0.0.1';
    }
  }
  return knoten;
}

function sshArgumente(knoten) {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
  ];
  if (knoten.port) args.push('-p', String(knoten.port));
  const ziel = knoten.alias || (knoten.user ? `${knoten.user}@${knoten.host}` : knoten.host);
  args.push(ziel);
  return args;
}

function ausfuehren(programm, args, { cwd, env, timeoutMs = 60_000, maxBuffer = 1024 * 1024 }) {
  return new Promise((fertig) => {
    execFile(
      programm,
      args,
      { cwd, env, timeout: timeoutMs, maxBuffer, encoding: 'utf8' },
      (fehler, stdout, stderr) => {
        fertig({
          ok: !fehler,
          code: fehler?.code ?? 0,
          signal: fehler?.signal ?? null,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          timedOut: fehler?.killed === true,
        });
      },
    );
  });
}

export class Knoten {
  constructor(cfg) {
    this.cfg = cfg;
    this.knoten = normalisiere(cfg);
    this.standardCwd = cfg.arbeitsbereiche.standard?.pfad ?? process.cwd();
    this.env = {
      ...process.env,
      ...(cfg.pi_durable.env ?? {}),
      PATH: [
        cfg.pi_durable.env?.PATH,
        process.env.PATH,
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
      ].filter(Boolean).join(':'),
      FYOS_HUB: cfg.hub,
      FYOS_AGENT: cfg.agent,
      FYOS_DEVICE: cfg.pi_durable.device?.id ?? '',
    };
    this.shell = cfg.pi_durable.shellPath || '/bin/bash';
  }

  liste() {
    return this.knoten.map(({ id, titel, art, host, user, port, alias, notiz, local }) => ({
      id,
      titel,
      art,
      host,
      user,
      port,
      alias,
      notiz,
      local: !!local,
      weg: local ? 'lokal' : alias || (host ? `${user ? `${user}@` : ''}${host}${port ? `:${port}` : ''}` : '?'),
    }));
  }

  async befehl(id, befehl, { timeoutMs = 60_000, cwd } = {}) {
    const knoten = this.knoten.find((k) => k.id === id);
    if (!knoten) throw new Error(`Unbekannter Knoten „${id}“. Bekannt: ${this.knoten.map((k) => k.id).join(', ')}`);
    if (!String(befehl ?? '').trim()) throw new Error('Befehl fehlt');
    const arbeitsordner = cwd ?? knoten.cwd ?? this.standardCwd;
    if (knoten.local) {
      return ausfuehren(this.shell, ['-lc', befehl], {
        cwd: arbeitsordner,
        env: this.env,
        timeoutMs,
      });
    }
    if (!knoten.host && !knoten.alias) throw new Error(`Knoten ${id} hat weder host noch alias`);
    return ausfuehren('ssh', [...sshArgumente(knoten), befehl], {
      cwd: this.standardCwd,
      env: this.env,
      timeoutMs,
    });
  }

  async pruefen(id, { timeoutMs = 15_000 } = {}) {
    const befehl = 'printf "%s|" "$(hostname)"; uname -srm; printf "|"; uptime 2>/dev/null | head -1';
    const start = Date.now();
    const r = await this.befehl(id, befehl, { timeoutMs });
    return {
      id,
      ok: r.ok,
      ms: Date.now() - start,
      ausgabe: KURZ(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`, 500),
    };
  }

  async allePruefen() {
    const ergebnisse = await Promise.all(this.knoten.map((k) => this.pruefen(k.id).catch((e) => ({
      id: k.id,
      ok: false,
      ms: null,
      ausgabe: e.message,
    }))));
    return ergebnisse;
  }
}

export function knotenWerkzeuge({ cfg, knoten = new Knoten(cfg) }) {
  const liste = defineTool({
    name: 'knoten_liste',
    description:
      'Listet alle FYOS-Knoten (dieses Gerät, Hauptserver, TrueNAS, Jetson, Pi4, VPS) mit ihrem Weg. ' +
      'Mit pruefen=true wird jeder Knoten per ssh kurz angerufen; das zeigt, ob Befehle wirklich ankommen.',
    parameters: Type.Object({
      pruefen: Type.Optional(Type.Boolean({ description: 'Jedem Knoten einen kurzen echten Befehl schicken (Vorgabe: false)' })),
    }),
    replay: 'safe',
    execute: async ({ pruefen = false }, _api, context) => {
      const eintraege = knoten.liste().map((k) => ({
        ...k,
        status: pruefen ? undefined : 'nicht geprüft',
      }));
      if (pruefen) {
        const ergebnisse = new Map((await knoten.allePruefen()).map((e) => [e.id, e]));
        for (const e of eintraege) {
          const r = ergebnisse.get(e.id);
          e.status = r?.ok ? 'erreichbar' : 'nicht erreichbar';
          e.ms = r?.ms ?? null;
          e.antwort = r?.ausgabe ?? null;
        }
      }
      return textErgebnis(JSON.stringify({ anzahl: eintraege.length, knoten: eintraege }, null, 2));
    },
  });

  const befehl = defineTool({
    name: 'knoten_befehl',
    description:
      'Führt einen echten Befehl auf einem FYOS-Knoten aus — lokal oder über ssh auf Hauptserver/TrueNAS/Jetson/Pi4/VPS. ' +
      'Für alle Befehle, die die Shell kann: systemctl, docker, kubectl, git, Dateien, Dienste. ' +
      'Zerstörerische Befehle vorher im Auftrag begründen und den Rückweg nennen.',
    parameters: Type.Object({
      knoten: Type.String({ description: 'Knoten-ID aus knoten_liste, z. B. hauptserver, truenas, jetson, pi4, vps, macbook' }),
      befehl: Type.String({ description: 'Vollständiger Shell-Befehl; läuft lokal mit bash -lc oder remote über ssh' }),
      timeout_s: Type.Optional(Type.Number({ minimum: 1, maximum: 1800, description: 'Zeitlimit in Sekunden (Vorgabe: 60)' })),
      cwd: Type.Optional(Type.String({ description: 'Arbeitsordner (nur lokal; Vorgabe: Arbeitsbereich des Gesprächs)' })),
    }),
    replay: 'unsafe',
    execute: async ({ knoten: id, befehl: cmd, timeout_s = 60, cwd }, _api, context) => {
      const r = await knoten.befehl(id, cmd, {
        timeoutMs: Math.max(1, Math.min(1800, Number(timeout_s) || 60)) * 1000,
        cwd,
      });
      const kopf = `Knoten: ${id} · ${r.ok ? 'ok' : `Fehler${r.code ? ` (${r.code})` : ''}`}${r.timedOut ? ' · Zeitlimit' : ''}`;
      const inhalt = [kopf, r.stdout && `--- stdout ---\n${r.stdout}`, r.stderr && `--- stderr ---\n${r.stderr}`]
        .filter(Boolean)
        .join('\n');
      return textErgebnis(KURZ(inhalt, cfg.pi_durable.limits.maxToolOutput));
    },
  });

  return [liste, befehl];
}
