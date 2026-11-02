/**
 * nachtwerkstatt.js — die reine Logik der Nachtwerkstatt (Dreaming, Skillsmith, Nodesmith, Morgenbericht).
 *
 * Nichts hier ruft ein Modell oder einen Knoten. Die Aufgaben stehen in `nachtwerkstatt-lauf.js`.
 * Leitsätze (Besitzer, 25.10.2026): nur Vorschläge, nie Auto-Übernahme; nur lesend auf den Knoten; Ruhefenster 22–7;
 * Spielmodus hält an; nur Hausmodell. Persona läuft ohnehin auf GPU0: es gibt keine GPU-Buchung und keine Belegungsprüfung.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { wandZeit } from './takt.js';
import { kurzText } from './zug.js';

export const SCHMIEDEN = ['dreaming', 'skillsmith', 'nodesmith'];
export const DECKEL_VORGABE = 3;
export const SECO_HINWEIS = 'Übernahme ins Wissen erst nach 3 Abrufen aus 3 Fragen (SECO-Regel); bis dahin nur Kandidat.';

const MIN = 60_000;
const TAG = 24 * 60 * MIN;

/** Konfiguration `cfg.nachtwerkstatt` mit Vorgaben. Budgets: harte Obergrenzen je Schmiede (Züge, Token). */
export function nachtKonfig(cfg = {}) {
  const n = cfg.nachtwerkstatt && typeof cfg.nachtwerkstatt === 'object' ? cfg.nachtwerkstatt : {};
  const speicher = cfg.pi_durable?.storage;
  const basis = speicher ? dirname(speicher) : process.cwd();
  const zahl = (w, v) => (Number.isFinite(Number(w)) && Number(w) > 0 ? Math.trunc(Number(w)) : v);
  const budget = (b, zuege, token) => ({ zuege: zahl(b?.zuege, zuege), token: zahl(b?.token, token) });
  return {
    an: n.an !== false,
    zone: String(n.zone || cfg.takt?.zone || 'Europe/Berlin'),
    von: zahl(n.von, 22),
    bis: zahl(n.bis, 7),
    deckel: zahl(n.deckel, DECKEL_VORGABE),
    ausgabe: n.ausgabe ? String(n.ausgabe) : join(basis, 'nachtwerkstatt'),
    repo: n.repo ? String(n.repo) : (cfg.arbeitsbereiche?.standard?.pfad ?? process.cwd()),
    aufzeichnung: n.aufzeichnung_ordner ? String(n.aufzeichnung_ordner) : (cfg.aufzeichnung?.ordner ?? join(basis, 'aufzeichnung')),
    spuren: n.spuren_ordner ? String(n.spuren_ordner) : null,
    lektionen: n.lektionen_ordner ? String(n.lektionen_ordner) : null,
    skillsmithAufgaben: n.skillsmith_aufgaben_ordner ? String(n.skillsmith_aufgaben_ordner) : null,
    modell: n.modell ? String(n.modell) : null,
    dreaming: { an: n.dreaming?.an !== false, budget: budget(n.dreaming?.budget, 6, 400_000) },
    skillsmith: { an: n.skillsmith?.an !== false, budget: budget(n.skillsmith?.budget, 60, 2_000_000), n: zahl(n.skillsmith?.n, 3), k: zahl(n.skillsmith?.k, 1) },
    nodesmith: { an: n.nodesmith?.an !== false, budget: budget(n.nodesmith?.budget, 10, 600_000), timeout_s: zahl(n.nodesmith?.timeout_s, 90) },
  };
}

// ------------------------------------------------------------------------------------------------- Zeit, Tore

/** Liegt `ms` im Ruhefenster (Wanduhr der Zone, von ≤ Stunde oder Stunde < bis)? */
export function ruhefenster(ms, zone = 'Europe/Berlin', von = 22, bis = 7) {
  const stunde = new Date(wandZeit(ms, zone)).getUTCHours();
  return von > bis ? stunde >= von || stunde < bis : stunde >= von && stunde < bis;
}

/** Datum der Nacht: vor 12 Uhr gehört die Zeit noch zur Nacht des Vortags. */
export function nachtDatum(ms, zone = 'Europe/Berlin') {
  const wand = wandZeit(ms, zone);
  const d = new Date(new Date(wand).getUTCHours() < 12 ? wand - TAG : wand);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Echte Millisekunden des nächsten Fensterbeginns (für den Schlaf außerhalb des Fensters). */
export function naechsterFensterbeginn(ms, zone = 'Europe/Berlin', von = 22) {
  const wand = wandZeit(ms, zone);
  const t = new Date(wand);
  let ziel = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), von, 0);
  if (ziel <= wand) ziel += TAG;
  return ms + (ziel - wand);
}

/**
 * Das Nachttor, das vor jedem neuen Zug gefragt wird: `null` = offen, sonst { art: 'pause', grund, bis? }.
 * Reihenfolge: Ruhefenster, Spielmodus (und Pause-Marken, das ist dieselbe Quelle), `schleifen.darf`.
 * Keine GPU-Prüfung: Persona läuft standardmäßig auf GPU0, Nebenarbeit und Co. weichen ihr.
 */
export function erstelleNachtTor({ hub, spielmodus, nk, jetzt = () => Date.now(), hubLesen, schleife = 'gedaechtnis' }) {
  return async function nachtTor() {
    const t = jetzt();
    if (!ruhefenster(t, nk.zone, nk.von, nk.bis)) {
      return { art: 'pause', grund: 'ausserhalb-ruhefenster', bis: naechsterFensterbeginn(t, nk.zone, nk.von) };
    }
    if (spielmodus?.an?.()) return { art: 'pause', grund: 'spielmodus' };
    try {
      const d = await hubLesen(hub, 'schleifen.darf', { schleife, art: 'schreiben' });
      if (!d || d.darf !== true) return { art: 'pause', grund: `schleife-zu: ${kurzText(d?.warum ?? '', 80)}` };
    } catch (fehler) {
      return { art: 'pause', grund: `hub-nicht-lesbar: ${kurzText(fehler?.message ?? fehler, 80)}` };
    }
    return null;
  };
}

/** Offene Vorschläge aus dem Dokument; der Deckel zählt sie. */
export function offeneVorschlaege(doc) {
  return Object.values(doc?.vorschlaege ?? {}).filter((v) => v.status === 'offen');
}

// -------------------------------------------------------------------------------------------- Knoten, lesend

/**
 * Jeder Befehl ist ein einzelner, nur lesender Aufruf. `nurLesend` prüft das Muster (Netz, kein Beweis): kein sudo,
 * keine Schreib-Umleitung, keine Dienst- oder Clusteränderung, kein Löschen, kein Neustart.
 */
const SCHREIBEND =
  /(^|[\s;&|(])(sudo|rm|mv|cp|dd|mkfs\S*|kill|pkill|killall|reboot|shutdown|poweroff|halt|tee|chmod|chown|apt\S*|pip\S*|npm|docker\s+(rm|stop|kill|restart|run)|crontab|passwd|mount|umount|fstrim|swapoff|sysctl\s+-w|ip\s+(link|addr|route)\s+(set|add|del)|nvidia-smi\s+(-pm|-pl|-r|--gpu-reset)|systemctl\s+(start|stop|restart|reload|enable|disable|mask|unmask|kill|set-\S+|daemon-\S+|edit|isolate)|kubectl\s+(delete|apply|patch|edit|drain|cordon|uncordon|rollout|scale|exec|replace|create|label|annotate|taint))(\s|$)/;

export function nurLesend(befehl) {
  const s = String(befehl ?? '');
  if (!s.trim()) return false;
  const ohneUmleitung = s.replace(/\d?>&\d/g, '').replace(/\d?>\s*\/dev\/null/g, '');
  if (/>/.test(ohneUmleitung)) return false;
  if (/`/.test(s) || /\$\(\s*(rm|mv|sudo)/.test(s)) return false;
  // `last -x reboot` liest nur die Neustart-Liste; das Wort „reboot“ ist hier kein Befehl.
  return !SCHREIBEND.test(s.replace(/\blast\s+-x\s+reboot\b/g, 'last'));
}

export const BEFEHLE_GEMEINSAM = [
  ['dienste-fehlgeschlagen', 'systemctl --failed --no-legend --plain 2>&1 | head -n 20'],
  ['journal-fehler-24h', 'out=$(journalctl -p err --since "24 hours ago" --no-pager -q 2>&1); if echo "$out" | grep -qE "insufficient permissions|No journal files"; then echo "journal: nicht lesbar (kein Root) - erwartet, kein Fehler"; else echo "$out" | tail -n 60; fi'],
  ['platz', 'df -h -x tmpfs -x devtmpfs -x overlay 2>&1 | head -n 25'],
  ['laufzeit', 'uptime'],
  ['neustarts', 'if command -v last >/dev/null; then last -x reboot 2>&1 | head -n 5; else echo "neustarts: last (util-linux) fehlt - Neustarthistorie nicht verfügbar, erwartet"; fi'],
  ['temperaturen', 'sensors 2>&1 | head -n 40'],
  ['smart', 'if ! command -v smartctl >/dev/null; then echo "smart: smartctl fehlt - erwartet, kein Fehler"; else out=$(smartctl -H /dev/sda 2>&1); if echo "$out" | grep -qE "Permission denied|Unable to open|failed"; then echo "smart: nicht lesbar (kein Root) - erwartet, kein Fehler"; else echo "$out" | head -n 6; fi; fi'],
  [
    'k3s-pods',
    'if ! command -v kubectl >/dev/null; then echo "k3s: kein kubectl - erwartet"; else out=$(kubectl get pods -A --field-selector spec.nodeName=$(hostname) --no-headers 2>&1 | grep -v -e " Running " -e " Completed "); if [ -z "$out" ]; then echo "k3s: keine Problem-Pods (alles Running/Completed)"; else echo "$out" | head -n 30; fi; fi',
  ],
];

export const BEFEHLE_HAUPTSERVER = [
  ['gpu-xid', 'out=$(journalctl -k --since "24 hours ago" --no-pager -q 2>&1); if echo "$out" | grep -qE "insufficient permissions|No journal files"; then echo "gpu-xid: Kernel-Journal nicht lesbar (kein Root) - erwartet, kein Fehler"; else echo "$out" | grep -i xid | tail -n 20; fi'],
  ['gpu-zustand', 'nvidia-smi --query-gpu=index,name,temperature.gpu,utilization.gpu,memory.used,memory.total --format=csv,noheader 2>&1 | head -n 4'],
  ['hausmodell', 'systemctl is-active hausmodell.service fle.service 2>&1'],
];

export function befehleFuer(id) {
  return id === 'hauptserver' ? [...BEFEHLE_GEMEINSAM, ...BEFEHLE_HAUPTSERVER] : BEFEHLE_GEMEINSAM;
}

/**
 * Ein einziger ssh-Aufruf je Knoten (ein Netzflackern kostet so nur einen Versuch). Hauptserver: Kerne 24–31, nice 19
 * (Skill hauptserver). Im Befehl steht kein einfaches Anführungszeichen, es wird in genau eines gefasst.
 */
export function knotenBuendel(id) {
  const teile = befehleFuer(id).map(([name, cmd]) => `echo "### ${name}"; ${cmd};`);
  const vorsatz = id === 'hauptserver' ? 'nice -n 19 taskset -c 24-31' : 'nice -n 19';
  return `${vorsatz} sh -c '${teile.join(' ')}'`;
}

export function parseAbschnitte(ausgabe) {
  const aus = {};
  let name = null;
  for (const zeile of String(ausgabe ?? '').split(/\r?\n/)) {
    const m = /^### (\S+)$/.exec(zeile);
    if (m) {
      name = m[1];
      aus[name] = [];
    } else if (name) aus[name].push(zeile);
  }
  return Object.fromEntries(Object.entries(aus).map(([k, v]) => [k, v.join('\n').trim()]));
}

/** Erreichbar heißt: der Bündelbefehl hat wenigstens den ersten Abschnitt geliefert. */
export function auswertenKnoten(r) {
  const abschnitte = parseAbschnitte(r?.stdout);
  const erreichbar = Object.keys(abschnitte).length > 0;
  return {
    erreichbar,
    grund: erreichbar ? null : r?.timedOut ? 'Zeitlimit' : r?.code === 255 ? 'ssh 255 (Netzflackern, INC-2698)' : kurzText(r?.stderr || `Code ${r?.code}`, 160),
    abschnitte,
  };
}

export function materialText(abschnitte, grenze = 7000) {
  const kuerzen = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
  const teile = Object.entries(abschnitte).map(([k, v]) => `### ${k}\n${kuerzen(v, 1400)}`);
  return kuerzen(teile.join('\n'), grenze);
}

// ---------------------------------------------------------------------------------------- Antworten lesen

const GESPERRT = /(leitplank|befehlsw[äa]chter|w[äa]chter\s+(aus|ab)|ohne\s+freigabe|(nie|nicht|kein\w*)\s+(nach\s+)?(einer\s+)?freigabe)/i;

/** Dreaming: Zeilen `ART | Titel | Text | Beleg`. Nichts davon ist übernommen. */
export function parseKandidaten(antwort) {
  const arten = ['WISSEN', 'PFLEGELISTE', 'SKILL', 'REGEL'];
  const aus = [];
  const zaehl = {};
  for (const zeile of String(antwort ?? '').split(/\r?\n/)) {
    const teile = zeile.split(' | ').map((t) => t.trim());
    const art = teile[0]?.replace(/^[-*\s]+/, '').toUpperCase();
    if (!arten.includes(art) || teile.length < 3) continue;
    if ((art === 'SKILL' || art === 'REGEL') && GESPERRT.test(zeile)) continue;
    zaehl[art] = (zaehl[art] ?? 0) + 1;
    if (zaehl[art] > 4) continue;
    aus.push({
      art,
      titel: kurzText(teile[1], 80),
      text: kurzText(teile[2], 400),
      beleg: kurzText(teile[3] ?? '', 200),
      status: 'kandidat',
      uebernommen: false,
      hinweis: SECO_HINWEIS,
    });
  }
  return aus;
}

/** Nodesmith: Abschnitte PROBLEME, STECKBRIEF, PRUEFSKRIPTE. Ein Beleg gilt nur, wenn er im Material steht. */
export function parseNodesmith(antwort, material) {
  const s = String(antwort ?? '');
  const abschnitt = (name) => {
    const m = new RegExp(`^##\\s*${name}\\s*$([\\s\\S]*?)(?=^##\\s*[A-ZÄÖÜ]{4,}\\s*$|(?![\\s\\S]))`, 'm').exec(s);
    return m ? m[1].trim() : '';
  };
  const norm = (t) => String(t).toLowerCase().replace(/\s+/g, ' ');
  const mat = norm(material);
  const probleme = [];
  for (const zeile of abschnitt('PROBLEME').split(/\r?\n/)) {
    const t = zeile.replace(/^\s*[-*]\s*/, '').split(' | ').map((x) => x.trim());
    if (t.length < 4 || !t[0]) continue;
    const beleg = t[2].replace(/^["„]|["“]$/g, '');
    probleme.push({
      titel: kurzText(t[0], 100),
      schwere: ['hoch', 'mittel', 'niedrig'].includes(t[1].toLowerCase()) ? t[1].toLowerCase() : 'mittel',
      beleg: kurzText(beleg, 240),
      belegt: beleg.length >= 12 && mat.includes(norm(beleg)),
      hypothese: kurzText(t[3], 300),
      max: /\bMAX:\s*ja\b/i.test(zeile),
    });
  }
  return {
    probleme: probleme.slice(0, 12),
    steckbrief: abschnitt('STECKBRIEF').slice(0, 5000),
    pruefskripte: abschnitt('PRUEFSKRIPTE')
      .split(/\r?\n/)
      .map((z) => z.replace(/^\s*[-*]\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 8),
  };
}

// ----------------------------------------------------------------------------------------- Material lesen

function leseKurz(pfad, n) {
  try {
    return readFileSync(pfad, 'utf8').slice(0, n);
  } catch {
    return '';
  }
}

/** Dreaming: die Tagesspur des Runners (JSONL der Aufzeichnung) zusammengefasst, bleibt klein und enthält keine Rohdaten über 200 Zeichen je Zeile. */
export function liesTagesspur(ordner, datum) {
  const datei = join(ordner, `aufzeichnung-${datum}.jsonl`);
  if (!existsSync(datei)) return { datei, vorhanden: false, zaehlung: {}, proben: [] };
  const zaehlung = {};
  const proben = [];
  for (const zeile of readFileSync(datei, 'utf8').split('\n')) {
    if (!zeile.trim()) continue;
    let e;
    try {
      e = JSON.parse(zeile);
    } catch {
      continue;
    }
    const art = String(e.art ?? '?');
    zaehlung[art] = (zaehlung[art] ?? 0) + 1;
    if (['eingang', 'zug', 'entscheidung', 'bericht', 'unterbrechung'].includes(art)) {
      const teile = ['quelle', 'klasse', 'bezug', 'text', 'urteil'].map((k) => (e[k] !== undefined ? `${k}=${kurzText(JSON.stringify(e[k]), 90)}` : null)).filter(Boolean);
      proben.push(kurzText(`${art} ${teile.join(' ')}`, 200));
    }
  }
  return { datei, vorhanden: true, zaehlung, proben: proben.slice(-60) };
}

/** Auszüge der Entwürfe des Spuren-Auswerters (scripts/persona/lernen), höchstens fünf aus den letzten 36 Stunden. */
export function liesSpuren(ordner, jetzt = Date.now()) {
  if (!ordner || !existsSync(ordner)) return [];
  return readdirSync(ordner)
    .filter((n) => n.endsWith('.md'))
    .map((n) => ({ n, t: statSync(join(ordner, n)).mtimeMs }))
    .filter((x) => jetzt - x.t < 36 * 60 * MIN)
    .sort((a, b) => b.t - a.t)
    .slice(0, 5)
    .map((x) => ({ datei: x.n, auszug: leseKurz(join(ordner, x.n), 1200) }));
}

export function liesLektionen(ordner) {
  if (!ordner || !existsSync(ordner)) return [];
  return readdirSync(ordner)
    .filter((n) => n.endsWith('.yaml'))
    .sort()
    .slice(0, 40)
    .map((n) => ({ id: n.replace(/\.yaml$/, ''), auszug: leseKurz(join(ordner, n), 400) }));
}

export function dreamingAuftraege(material) {
  const kopf = [
    `Nacht ${material.nacht}. Material (Tagesspur des Runners, Spuren-Auswerter, Lektionen). Nichts davon ist geprüft.`,
    `Tagesspur ${material.spur.vorhanden ? 'vorhanden' : 'FEHLT'}; Zählung: ${JSON.stringify(material.spur.zaehlung)}`,
    ...material.spur.proben.map((p) => `- ${p}`),
    ...material.spuren.map((s) => `Spur ${s.datei}: ${kurzText(s.auszug, 500)}`),
    ...material.lektionen.map((l) => `Lektion ${l.id}`),
  ].join('\n');
  return {
    episode: `NACHTWERKSTATT-DREAMING-EPISODE\nFasse den Tag in höchstens zehn Sätzen zusammen: was geschah, was blieb offen. Keine Personennamen, keine Geheimnisse, nichts erfinden; fehlt Material, sag es.\n\n${kopf}`,
    kandidaten: (episode) =>
      `NACHTWERKSTATT-DREAMING-KANDIDATEN\nSchlage aus dem Tag Kandidaten vor, je Zeile genau: ART | Titel | Text | Beleg (wörtlich aus dem Material). ART ist WISSEN, PFLEGELISTE, SKILL oder REGEL, höchstens vier je ART. Nichts davon wird übernommen. Keine Änderungen an Leitplanken, Wächtern oder Freigaben.\n\nEpisode:\n${episode}\n\n${kopf}`,
  };
}

export function nodesmithAuftrag(knotenId, material) {
  return [
    `NACHTWERKSTATT-NODESMITH:${knotenId}`,
    'Du siehst nur lesend gesammelte Fakten eines Knotens. Gruppiere die Probleme, nenne je Problem eine Ursache-Hypothese mit wörtlichem Beleg aus den Fakten, und schreibe den Steckbrief (Runbook-Entwurf) fort. Du handelst nicht: keine Neustarts, kein Löschen, kein sudo.',
    'Format, genau diese drei Abschnitte:',
    '## PROBLEME',
    '- Titel | hoch/mittel/niedrig | wörtlicher Beleg aus den Fakten | Ursache-Hypothese | MAX: ja/nein',
    '## STECKBRIEF',
    '(Markdown: Zugang, Dienste, bekannte Eigenheiten, Prüfungen; fortschreiben, nicht ersetzen)',
    '## PRUEFSKRIPTE',
    '- ein Satz je Vorschlag für ein Prüfskript oder einen Wächter',
    '',
    `Bisheriger Steckbrief:\n${material.vorher || '(noch keiner)'}`,
    '',
    `Fakten:\n${material.text}`,
  ].join('\n');
}

// -------------------------------------------------------------------------------------------- Skillsmith

/** Wählt den Skill dieser Nacht: Gewicht (Schwäche) mal Tage seit dem letzten Lauf, plus Treffer in den Lektionen. */
export function waehleSkill({ kandidaten, verlauf = {}, lektionen = [], offen = [], jetzt = Date.now() }) {
  const bewertet = kandidaten
    .filter((k) => !offen.includes(k.name))
    .map((k) => {
      const letzte = verlauf[k.name];
      const tage = letzte ? Math.max(0, (jetzt - Number(letzte)) / TAG) : 30;
      const treffer = lektionen.filter((l) => l.auszug.includes(k.name) || l.id.includes(k.name)).length;
      return { name: k.name, punkte: Math.round((Number(k.gewicht ?? 1) * tage + treffer * 5) * 100) / 100, treffer };
    })
    .sort((a, b) => b.punkte - a.punkte || a.name.localeCompare(b.name));
  return bewertet[0] ?? null;
}

// ------------------------------------------------------------------------------------------------ Dateien

export function dreamingDateien(input, cp) {
  const laeufe = cp.laeufe ?? {};
  const episode = laeufe.episode?.text ?? '';
  const kandidaten = cp.ergebnis?.kandidaten ?? [];
  const md = [
    `# Dreaming ${input.nacht} (Entwurf)`,
    '',
    'Vorschlag, nichts übernommen. ' + SECO_HINWEIS,
    '',
    '## Episode',
    '',
    episode || '(keine Episode geschrieben)',
    '',
    '## Kandidaten',
    '',
    ...(kandidaten.length
      ? kandidaten.map((k) => `- **${k.art}** ${k.titel}: ${k.text}${k.beleg ? ` (Beleg: ${k.beleg})` : ' (ohne Beleg)'}`)
      : ['(keine)']),
    '',
  ].join('\n');
  return {
    'EPISODE.md': md,
    'vorschlag.json': `${JSON.stringify({ nacht: input.nacht, kandidaten, uebernommen: false }, null, 2)}\n`,
  };
}

export function nodesmithDateien(input, cp) {
  const aus = cp.ergebnis ?? { knoten: {}, itsm: [], pruefskripte: [] };
  const dateien = {};
  const bericht = ['# Nodesmith ' + input.nacht + ' (Entwurf, nur lesend gesammelt)', ''];
  for (const [id, k] of Object.entries(aus.knoten)) {
    bericht.push(`## ${id}`, '');
    if (!k.erreichbar) {
      bericht.push(`nicht erreichbar${k.grund ? ` (${k.grund})` : ''}; nichts repariert.`, '');
      continue;
    }
    if (k.uebersprungen) {
      bericht.push(`nicht gesammelt: ${k.uebersprungen}.`, '');
      continue;
    }
    if (!k.probleme.length) bericht.push('Keine Probleme erkannt.', '');
    for (const p of k.probleme) {
      bericht.push(`- [${p.schwere}] ${p.titel}${p.belegt ? '' : ' (Beleg nicht im Material gefunden, unbelegt)'}`, `  Beleg: ${p.beleg}`, `  Hypothese: ${p.hypothese}`);
    }
    bericht.push('');
    if (k.steckbrief) dateien[`knoten/${id}/SKILL.entwurf.md`] = `${k.steckbrief}\n`;
    dateien[`rohdaten/${id}.txt`] = `${k.rohtext ?? ''}\n`;
  }
  dateien['NODESMITH.md'] = `${bericht.join('\n')}\n`;
  dateien['PRUEFSKRIPT-VORSCHLAEGE.md'] = `# Vorschläge für Prüfskripte und Wächter (${input.nacht})\n\n${aus.pruefskripte.length ? aus.pruefskripte.map((p) => `- ${p}`).join('\n') : '(keine)'}\n`;
  dateien['itsm-vorschlaege.json'] = `${JSON.stringify({ hinweis: 'Vorschläge, nichts angelegt', vorgaenge: aus.itsm }, null, 2)}\n`;
  return dateien;
}

export function skillsmithDateien(input, cp) {
  const e = cp.ergebnis ?? {};
  const md = [
    `# Skillsmith ${input.nacht} (Entwurf)`,
    '',
    `Skill: ${e.skill ?? '(keiner gewählt)'}`,
    `Ergebnis des Harness2-Piloten: **${e.pilotStatus ?? 'nicht gelaufen'}**${e.grund ? ` (${e.grund})` : ''}`,
    e.auswahl ? `Auswahl: ${e.auswahl}` : '',
    e.pilotOrdner ? `Ordner des Piloten: ${e.pilotOrdner}` : '',
    '',
    'Abnahme: Gewinn über der gemessenen Streuung, sonst kein Gewinn. Nichts übernommen, kein Auto-Merge.',
    '',
    e.tabelle ? `\`\`\`\n${e.tabelle}\n\`\`\`` : '',
    '',
  ].join('\n');
  return { 'SKILLSMITH.md': md };
}

export function morgenbericht({ nacht, ergebnisse, offen, deckel }) {
  const z = [`# Morgenbericht der Nachtwerkstatt, Nacht ${nacht}`, '', `Offene Vorschläge: ${offen} von höchstens ${deckel}. Alles hier ist Vorschlag; nichts wurde übernommen oder angelegt.`, ''];
  for (const name of SCHMIEDEN) {
    const e = ergebnisse[name];
    z.push(`## ${name}`, '');
    if (!e) {
      z.push('nicht gelaufen.', '');
      continue;
    }
    z.push(`Status: ${e.status}${e.grund ? ` (${e.grund})` : ''}`);
    if (e.zusammenfassung) z.push(e.zusammenfassung);
    if (e.verbrauch) z.push(`Verbrauch: ${e.verbrauch.zuege} Züge, ${e.verbrauch.token} Token`);
    if (e.ordner) z.push(`Ordner: ${e.ordner}`);
    z.push('');
  }
  return `${z.join('\n')}\n`;
}
