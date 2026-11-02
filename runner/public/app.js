/**
 * app.js — das Fenster in den dauerhaften Lauf.
 *
 * Der Client hält keinen eigenen Verlauf. Er liest den Snapshot aus der SSE-Verbindung,
 * wendet die pi-durable-Ereignisse an und zeichnet daraus das Gespräch. Jede Schaltfläche
 * spricht mit dem Runner; nichts wird nur lokal „gespeichert“ und später verloren.
 * Visible texts go through `t()` (public/i18n.js): German is the key, English comes from the table.
 */
import { t, ortsform, seiteUebersetzen, sprache } from './i18n.js';
const tr = t;
const $ = (auswahl, wurzel = document) => wurzel.querySelector(auswahl);
const $$ = (auswahl, wurzel = document) => [...wurzel.querySelectorAll(auswahl)];

const BASIS = new URL('./', location.href);
const SPEICHER = {
  gespraech: 'fyos.aktuelles.gespraech',
  token: 'fyos.runner.token',
  tab: 'fyos.tab',
  live: 'fyos.live',
};

const S = {
  token: '',
  cfg: null,
  health: null,
  modelle: [],
  bereiche: {},
  gespraeche: [],
  aktuellId: null,
  meta: null,
  usage: null,
  entries: [],
  liveMessage: null,
  tools: new Map(),
  freigaben: [],
  laeufe: [],
  zustand: { werte: {} },
  knoten: [],
  werkzeuge: [],
  werkzeugAktiv: null,
  aufgaben: null,
  sse: null,
  docsSse: null,
  // Live ist die Voreinstellung: wer sich verbindet, sieht die autonome Arbeit. Ausblenden ist
  // eine Anzeigewahl dieses Clients (`/live`); der Agent merkt davon nichts.
  live: true,
  stromSse: null,
  stromZeilen: [],
  stromLetzte: 0,
  busy: false,
  autoScroll: true,
  freigabeId: null,
  zustandSchluessel: null,
  erkennen: null,
  mikroLaeuft: false,
  installPrompt: null,
  laeufeTimer: null,
  gespraecheTimer: null,
  ticker: null,
};

// ---------------------------------------------------------------------------
// Kleine Helfer
// ---------------------------------------------------------------------------

function esc(wert) {
  return String(wert ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function el(tag, klasse, text) {
  const e = document.createElement(tag);
  if (klasse) e.className = klasse;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}

function zeit(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(ortsform(), { dateStyle: 'short', timeStyle: 'short' }).format(d);
}

function relativ(ts) {
  if (!ts) return '';
  const ms = Date.now() - Number(ts);
  if (!Number.isFinite(ms) || ms < 0) return zeit(ts);
  if (ms < 60_000) return t('gerade');
  if (ms < 3_600_000) return t('vor {n} min', { n: Math.floor(ms / 60_000) });
  if (ms < 86_400_000) return t('vor {n} h', { n: Math.floor(ms / 3_600_000) });
  if (ms < 7 * 86_400_000) return t('vor {n} d', { n: Math.floor(ms / 86_400_000) });
  return zeit(ts);
}

function dauer(ms) {
  if (!Number.isFinite(Number(ms))) return '';
  const n = Number(ms);
  if (n < 1000) return `${n} ms`;
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} s`;
}

function wertText(wert) {
  if (wert === undefined || wert === null) return '';
  if (typeof wert === 'string') return wert;
  try {
    return JSON.stringify(wert, null, 2);
  } catch {
    return String(wert);
  }
}

function inhaltText(inhalt) {
  if (typeof inhalt === 'string') return inhalt;
  if (!Array.isArray(inhalt)) return wertText(inhalt);
  return inhalt
    .map((block) => {
      if (!block || typeof block !== 'object') return String(block ?? '');
      if (block.type === 'text') return block.text ?? '';
      if (block.type === 'thinking') return '';
      if (block.type === 'image') return t('[Bild]');
      if (block.type === 'toolCall') return t('[Werkzeug {name}]', { name: block.name ?? '?' });
      return wertText(block);
    })
    .filter(Boolean)
    .join('\n');
}

function ergebnisText(wert) {
  if (!wert) return '';
  if (typeof wert === 'string') return wert;
  const msg = wert.model?.[0] ?? wert;
  if (msg && msg.role === 'toolResult') return inhaltText(msg.content);
  if (wert.result !== undefined) return typeof wert.result === 'string' ? wert.result : wertText(wert.result);
  if (wert.output !== undefined) return typeof wert.output === 'string' ? wert.output : wertText(wert.output);
  if (wert.content !== undefined) return inhaltText(wert.content);
  return wertText(wert);
}

function eintragZeit(eintrag) {
  return (
    eintrag?.createdAt ??
    eintrag?.created ??
    eintrag?.time ??
    eintrag?.data?.zeit ??
    eintrag?.model?.[0]?.timestamp ??
    null
  );
}

function fehlerText(fehler) {
  if (!fehler) return t('Unbekannter Fehler');
  const text = String(fehler.message ?? fehler);
  return text.length > 500 ? text.slice(0, 499) + '…' : text;
}

function fehlerMelden(fehler) {
  console.error(fehler);
  const nachricht = fehlerText(fehler);
  toast(nachricht, true);
  if (fehler?.status === 401) {
    S.token = '';
    try {
      localStorage.removeItem(SPEICHER.token);
    } catch {
      /* egal */
    }
    wechsleTab('erweitern');
    setTimeout(() => $('#token-feld')?.focus(), 80);
    $('#token-status').textContent = t('Der Token fehlt oder ist falsch. Bitte hier eintragen.');
  }
}

async function sicher(fn) {
  try {
    return await fn();
  } catch (fehler) {
    fehlerMelden(fehler);
    return undefined;
  }
}

let toastTimer = null;
function toast(text, istFehler = false) {
  const box = $('#toast');
  if (!box) return;
  box.textContent = String(text);
  box.classList.toggle('fehler', !!istFehler);
  box.classList.add('an');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('an'), istFehler ? 6500 : 3800);
}

// ---------------------------------------------------------------------------
// Netz
// ---------------------------------------------------------------------------

function url(pfad, extra = {}) {
  const u = new URL(String(pfad).replace(/^\/+/, ''), BASIS);
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  return u;
}

function sseUrl(pfad) {
  return url(pfad, S.token ? { token: S.token } : {}).href;
}

async function api(pfad, { methode = 'GET', koerper, timeoutMs = 45_000 } = {}) {
  const u = url(pfad, S.token ? { token: S.token } : {});
  const steuerung = new AbortController();
  const timer = setTimeout(() => steuerung.abort(new Error(t('Zeitüberschreitung'))), timeoutMs);
  try {
    const kopf = { Accept: 'application/json' };
    if (S.token) kopf.Authorization = `Bearer ${S.token}`;
    if (koerper !== undefined) kopf['Content-Type'] = 'application/json';
    const antwort = await fetch(u, {
      method: methode,
      headers: kopf,
      body: koerper === undefined ? undefined : JSON.stringify(koerper),
      signal: steuerung.signal,
      cache: 'no-store',
    });
    const roh = await antwort.text();
    let daten = null;
    try {
      daten = roh ? JSON.parse(roh) : {};
    } catch {
      daten = { ok: false, fehler: roh || `HTTP ${antwort.status}` };
    }
    if (!antwort.ok || daten?.ok === false) {
      const f = new Error(daten?.fehler || daten?.error || `HTTP ${antwort.status}`);
      f.status = antwort.status;
      f.daten = daten;
      throw f;
    }
    return daten;
  } catch (fehler) {
    if (fehler?.name === 'AbortError') throw new Error(t('Der Runner antwortet nicht rechtzeitig.'));
    throw fehler;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Markdown (bewusst klein und ohne fremde Bibliothek)
// ---------------------------------------------------------------------------

function markdown(text) {
  const codeBloecke = [];
  let s = esc(text ?? '');
  s = s.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g, (_ganz, sprache, code) => {
    const i = codeBloecke.push(`<pre><code data-sprache="${esc(sprache)}">${code.replace(/\n$/, '')}</code></pre>`) - 1;
    return `\u0000CODE${i}\u0000`;
  });
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

  const zeilen = s.split('\n');
  const aus = [];
  let liste = null;
  const listeSchliessen = () => {
    if (liste) {
      aus.push(`</${liste}>`);
      liste = null;
    }
  };
  for (const roh of zeilen) {
    const z = roh.trimEnd();
    const t = z.trim();
    if (!t) {
      listeSchliessen();
      continue;
    }
    if (/^\u0000CODE\d+\u0000$/.test(t)) {
      listeSchliessen();
      aus.push(t.replace(/\u0000CODE(\d+)\u0000/g, (_g, i) => codeBloecke[Number(i)] ?? ''));
      continue;
    }
    const h = /^(#{1,4})\s+(.+)$/.exec(t);
    if (h) {
      listeSchliessen();
      const stufe = Math.min(4, h[1].length + 2);
      aus.push(`<h${stufe}>${h[2]}</h${stufe}>`);
      continue;
    }
    const ul = /^[-*•]\s+(.+)$/.exec(t);
    if (ul) {
      if (liste !== 'ul') {
        listeSchliessen();
        aus.push('<ul>');
        liste = 'ul';
      }
      aus.push(`<li>${ul[1]}</li>`);
      continue;
    }
    const ol = /^\d+[.)]\s+(.+)$/.exec(t);
    if (ol) {
      if (liste !== 'ol') {
        listeSchliessen();
        aus.push('<ol>');
        liste = 'ol';
      }
      aus.push(`<li>${ol[1]}</li>`);
      continue;
    }
    listeSchliessen();
    if (/^>\s?/.test(t)) aus.push(`<blockquote>${t.replace(/^>\s?/, '')}</blockquote>`);
    else aus.push(`<p>${z}</p>`);
  }
  listeSchliessen();
  return aus
    .join('\n')
    .replace(/\u0000CODE(\d+)\u0000/g, (_g, i) => codeBloecke[Number(i)] ?? '')
    .replace(/\n{3,}/g, '\n\n');
}

// ---------------------------------------------------------------------------
// Verbindung und Kopf
// ---------------------------------------------------------------------------

function setzeVerbindung(art, text, hub = '') {
  const punkt = $('#verbindung-punkt');
  punkt.classList.remove('an', 'aus', 'wartet');
  if (art) punkt.classList.add(art);
  $('#verbindung-text').textContent = text;
  const h = $('#verbindung-hub');
  h.textContent = hub || '';
  h.title = hub || '';
}

function setzeBusy(busy) {
  S.busy = !!busy;
  $('#aktion-abbrechen').hidden = !S.busy;
  renderTop();
}

function renderTop() {
  const meta = S.meta;
  const bereich = meta?.arbeitsbereich ? S.bereiche[meta.arbeitsbereich] : null;
  $('#gespraech-titel').textContent = meta?.titel || 'FYOS Agent';
  const teile = [];
  if (bereich?.titel) teile.push(bereich.titel);
  if (meta?.modell) teile.push(meta.modell);
  else if (S.cfg?.model?.default) teile.push(S.cfg.model.default);
  teile.push(S.busy ? t('arbeitet …') : t('bereit'));
  $('#gespraech-untertitel').textContent = teile.join(' · ');

  const status = $('#top-status');
  status.innerHTML = '';
  const chip = (text, klasse = '') => {
    const s = el('span', `marke ${klasse}`.trim(), text);
    status.appendChild(s);
  };
  if (S.busy) chip(t('arbeitet'), 'laeuft');
  if (S.health?.hub) chip(S.health.hub.ok ? t('Hub ok') : t('Hub offline'), S.health.hub.ok ? 'fertig' : 'fehler');
  if (S.token) chip('Token', '');
  if (S.aufgaben?.tasks?.length) chip(t('{n} Aufgaben', { n: S.aufgaben.tasks.length }), '');
}

function renderGeraet() {
  const box = $('#geraet-daten');
  if (!box) return;
  box.innerHTML = '';
  const cfg = S.cfg;
  if (!cfg) {
    box.appendChild(el('div', 'daten', t('Noch keine Verbindung.')));
    return;
  }
  const d = cfg.device ?? {};
  const daten = [
    ['Gerät', `${d.name ?? '?'} (${d.id ?? '?'})`],
    ['Art', d.kind ?? '?'],
    ['Agent', cfg.agent ?? '?'],
    ['Hub', cfg.hub ?? '?'],
    ['Modell', cfg.model?.default ?? '?'],
    ['Vorfahrt', cfg.model?.max ?? '?'],
    ['Speicher', cfg.storage ?? '?'],
    ['Port', cfg.port ?? '?'],
    ['Token', cfg.tokenGesetzt ? t('gesetzt') : t('nicht gesetzt')],
    ['Version', cfg.version ? `v${cfg.version}` : '?'],
  ];
  for (const [k, v] of daten) {
    const e = el('div', 'daten');
    e.appendChild(el('span', '', t(k)));
    e.appendChild(el('strong', '', v));
    e.title = String(v);
    box.appendChild(e);
  }
}

// ---------------------------------------------------------------------------
// Seitenleiste
// ---------------------------------------------------------------------------

function renderSidebar() {
  const liste = $('#gespraechsliste');
  liste.innerHTML = '';
  const geraet = S.cfg?.device?.name;
  if (geraet) $('#brand-geraet').textContent = geraet;

  const sortiert = [...S.gespraeche].sort((a, b) => {
    if (a.art === 'root' && b.art !== 'root') return -1;
    if (b.art === 'root' && a.art !== 'root') return 1;
    return (b.erstellt ?? 0) - (a.erstellt ?? 0);
  });
  for (const g of sortiert) {
    const b = el('button', `gespraech${g.id === S.aktuellId ? ' aktiv' : ''}`);
    b.type = 'button';
    b.title = g.titel || g.id;
    const zeichen = g.art === 'root' ? 'FY' : g.art === 'zweig' ? '⑂' : 'A';
    b.appendChild(el('span', 'gespraech-zeichen', zeichen));
    const text = el('span', 'gespraech-text');
    text.appendChild(el('span', 'gespraech-name', g.titel || t('Ohne Titel')));
    const unter = [S.bereiche[g.arbeitsbereich]?.titel, relativ(g.erstellt)].filter(Boolean).join(' · ');
    text.appendChild(el('span', 'gespraech-meta', unter || g.id.slice(0, 10)));
    b.appendChild(text);
    b.addEventListener('click', () => {
      void sicher(() => oeffneGespraech(g.id));
      schliesseSidebar();
    });
    liste.appendChild(b);
  }
  if (!sortiert.length) liste.appendChild(el('p', 'mini', t('Noch kein Gespräch.')));

  $('#gespraech-zaehler').textContent = String(sortiert.length);
  const offen = S.freigaben.filter((f) => f.status === 'offen');
  $('#freigabe-zaehler').textContent = String(offen.length);
  $('#freigabe-zaehler').classList.toggle('warn', offen.length > 0);

  const kurz = $('#freigaben-kurz');
  kurz.innerHTML = '';
  for (const f of offen.slice(0, 5)) {
    const b = el('button', 'freigabe-mini');
    b.type = 'button';
    b.appendChild(el('strong', '', f.aktion || t('Freigabe')));
    b.appendChild(el('span', '', t(f.risiko === 'high' ? 'hohes Risiko · {wann}' : f.risiko === 'low' ? 'niedriges Risiko · {wann}' : 'mittleres Risiko · {wann}', { wann: relativ(f.erstellt) })));
    b.addEventListener('click', () => oeffneFreigabe(f.id));
    kurz.appendChild(b);
  }
  if (!offen.length) kurz.appendChild(el('p', 'mini', t('Nichts offen.')));

  $('#version').textContent = S.cfg?.version ? `v${S.cfg.version}` : 'v0.1';
  renderTop();
}

function schliesseSidebar() {
  $('#sidebar')?.classList.remove('offen');
  $('#schleier')?.classList.remove('an');
}

function oeffneSidebar() {
  $('#sidebar')?.classList.add('offen');
  $('#schleier')?.classList.add('an');
}

// ---------------------------------------------------------------------------
// Gespräch
// ---------------------------------------------------------------------------

async function ladeGespraeche() {
  const d = await api('api/gespraeche');
  S.gespraeche = Array.isArray(d.gespraeche) ? d.gespraeche : [];
  if (!S.aktuellId && S.gespraeche.length) {
    const root = S.gespraeche.find((g) => g.art === 'root') ?? S.gespraeche[0];
    S.aktuellId = root.id;
  }
  renderSidebar();
}

async function oeffneGespraech(id) {
  if (!id) return;
  // Gesprächs-IDs sind Zahlen; aus dem Speicher des Browsers kommt ein Text.
  if (/^\d+$/.test(String(id))) id = Number(id);
  if (S.aktuellId === id && S.sse) return;
  schliesseGespraechsSse();
  S.aktuellId = id;
  S.meta = null;
  S.usage = null;
  S.entries = [];
  S.liveMessage = null;
  S.tools.clear();
  S.busy = false;
  S.autoScroll = true;
  try {
    localStorage.setItem(SPEICHER.gespraech, id);
  } catch {
    /* egal */
  }
  renderSidebar();
  renderChat();
  renderStrom();
  setzeVerbindung('wartet', t('lade Gespräch …'));

  try {
    const a = await api(`api/gespraech/${encodeURIComponent(id)}/ansicht?voll=1`);
    S.meta = a.meta ?? null;
    S.usage = a.usage ?? null;
    if (Array.isArray(a.entries)) S.entries = a.entries;
    renderTop();
    renderChat();
  } catch (fehler) {
    fehlerMelden(fehler);
  }
  starteGespraechsSse(id);
}

function schliesseGespraechsSse() {
  if (S.sse) {
    S.sse.close();
    S.sse = null;
  }
}

function starteGespraechsSse(id) {
  schliesseGespraechsSse();
  const es = new EventSource(sseUrl(`api/gespraech/${encodeURIComponent(id)}/ereignisse?voll=1`));
  S.sse = es;
  es.addEventListener('snapshot', (ereignis) => {
    if (S.sse !== es) return;
    let s;
    try {
      s = JSON.parse(ereignis.data);
    } catch {
      return;
    }
    // Vereinigen statt ersetzen: bekannte Einträge behalten ihr Objekt, der feste Teil des Chats bleibt beim Neuverbinden im DOM.
    S.entries = vereinigeEintraege(S.entries, Array.isArray(s.entries) ? s.entries : []);
    S.liveMessage = s.generation?.message ?? null;
    S.busy = !!s.run || !!s.generation;
    S.tools.clear();
    for (const slot of [...(s.tools ?? []), ...(s.nestedTools ?? [])]) {
      const key = slot.callId ?? slot.taskId;
      if (!key) continue;
      S.tools.set(key, {
        id: key,
        name: slot.name ?? t('Werkzeug'),
        args: slot.arguments ?? {},
        output: typeof slot.output === 'string' ? slot.output : '',
        details: slot.details ?? null,
        diagnostics: slot.diagnostics ?? [],
        status: slot.status === 'done' ? 'fertig' : 'running',
      });
    }
    setzeVerbindung('an', t('verbunden'), S.cfg?.hub ?? '');
    renderChat();
    renderTop();
  });
  // Überlauf des Servers: ein Batch mit einem einzigen Snapshot statt der verpassten Ereignisse (pi-durable events.js)
  es.addEventListener('ereignisse', (ereignis) => {
    if (S.sse !== es) return;
    let liste;
    try {
      liste = JSON.parse(ereignis.data);
    } catch {
      return;
    }
    if (Array.isArray(liste)) verarbeiteEreignisse(liste);
  });
  es.onopen = () => {
    if (S.sse === es) setzeVerbindung('an', t('verbunden'), S.cfg?.hub ?? '');
  };
  es.onerror = () => {
    if (S.sse !== es) return;
    setzeVerbindung('wartet', t('unterbrochen · verbinde …'), S.cfg?.hub ?? '');
  };
}

/** Zwei Eintragslisten nach Id vereinigen (Ids sind aufsteigende Zahlen). Einträge sind unveränderlich: bei gleicher Id bleibt das schon bekannte Objekt (der feste Teil des Chats bleibt dann im DOM, siehe renderChat). */
function vereinigeEintraege(alt, neu) {
  const nach = new Map();
  for (const e of alt ?? []) nach.set(e.id, e);
  for (const e of Array.isArray(neu) ? neu : []) if (!nach.has(e.id)) nach.set(e.id, e);
  return [...nach.values()].sort((a, b) => Number(a.id) - Number(b.id)).slice(-5000);
}

/**
 * Zeichnen bündeln: Ereignisse treffen im Takt der Tokens ein, `renderChat` baut den ganzen Verlauf neu (innerHTML = '').
 * Pro Bild höchstens einmal, und nicht öfter als alle 120 ms.
 */
let chatGeplant = 0;
let chatLetzter = 0;
function planeChat() {
  if (chatGeplant) return;
  const warte = Math.max(0, 120 - (Date.now() - chatLetzter));
  chatGeplant = setTimeout(() => {
    chatGeplant = 0;
    chatLetzter = Date.now();
    requestAnimationFrame(renderChat);
  }, warte);
}

function fuegeEintragHinzu(eintrag) {
  if (!eintrag) return;
  const id = eintrag.id;
  if (id !== undefined && S.entries.some((e) => e.id === id)) return;
  S.entries.push(eintrag);
  if (S.entries.length > 5000) S.entries.splice(0, S.entries.length - 5000);
}

function verarbeiteEreignisse(ereignisse) {
  let neu = false;
  let fertig = false;
  for (const ev of ereignisse) {
    switch (ev.type) {
      case 'message_start': {
        const m = ev.message;
        if (m?.role === 'assistant') {
          S.liveMessage = structuredClone(m);
          S.autoScroll = true;
          neu = true;
        } else if (m?.role === 'toolResult' && m.toolCallId) {
          const t = S.tools.get(m.toolCallId);
          if (t) {
            t.output = inhaltText(m.content);
            t.status = m.isError ? 'error' : 'fertig';
          }
        }
        break;
      }
      case 'message_update': {
        if (!S.liveMessage) break;
        const aenderungen = ev.changes ?? [];
        for (const a of aenderungen) {
          if (a.type === 'message') {
            S.liveMessage = structuredClone(a.message);
            continue;
          }
          if (a.type === 'text_start' || a.type === 'thinking_start' || a.type === 'toolcall_start') {
            S.liveMessage.content = Array.isArray(S.liveMessage.content) ? S.liveMessage.content : [];
            if (a.type === 'text_start') S.liveMessage.content[a.contentIndex] = { type: 'text', text: '' };
            else if (a.type === 'thinking_start') S.liveMessage.content[a.contentIndex] = { type: 'thinking', thinking: '' };
            else S.liveMessage.content[a.contentIndex] = { type: 'toolCall', id: a.block?.id, name: a.block?.name, arguments: a.block?.arguments ?? {} };
            continue;
          }
          if (a.type === 'text_delta' || a.type === 'thinking_delta') {
            const block = S.liveMessage.content?.[a.contentIndex];
            if (!block) continue;
            if (a.type === 'text_delta') block.text = String(block.text ?? '') + String(a.delta ?? '');
            else block.thinking = String(block.thinking ?? '') + String(a.delta ?? '');
            continue;
          }
          if (a.type === 'block') {
            S.liveMessage.content = Array.isArray(S.liveMessage.content) ? S.liveMessage.content : [];
            S.liveMessage.content[a.contentIndex] = a.block;
          }
        }
        if (ev.usage) S.liveMessage.usage = ev.usage;
        neu = true;
        break;
      }
      case 'message_end': {
        if (ev.entry) {
          fuegeEintragHinzu(ev.entry);
          const m = ev.entry.model?.[0];
          if (m?.role === 'assistant') S.liveMessage = null;
          if (m?.role === 'toolResult' && m.toolCallId) {
            const t = S.tools.get(m.toolCallId);
            if (t) {
              t.output = inhaltText(m.content);
              t.status = m.isError ? 'error' : 'fertig';
            }
          }
          neu = true;
        }
        break;
      }
      case 'entry_appended': {
        if (ev.entry) {
          fuegeEintragHinzu(ev.entry);
          neu = true;
          if (ev.entry.kind === 'fyos.freigabe-entscheidung') {
            toast(t('Freigabe {entscheidung}.', { entscheidung: t(ev.entry.data?.entscheidung ?? 'entschieden') }));
          }
        }
        break;
      }
      case 'tool_execution_start': {
        const id = ev.toolCallId ?? ev.taskId;
        if (!id) break;
        S.tools.set(id, {
          id,
          name: ev.toolName ?? t('Werkzeug'),
          args: ev.args ?? {},
          output: '',
          details: null,
          diagnostics: [],
          status: 'running',
        });
        neu = true;
        break;
      }
      case 'tool_execution_update': {
        const t = S.tools.get(ev.toolCallId ?? ev.taskId);
        if (!t) break;
        if (ev.output) {
          if (typeof ev.output.set === 'string') t.output = ev.output.set;
          else {
            if (Number(ev.output.trimStart) > 0) t.output = t.output.slice(Number(ev.output.trimStart));
            if (typeof ev.output.append === 'string') t.output += ev.output.append;
          }
        }
        if (ev.details !== undefined) t.details = ev.details;
        if (Array.isArray(ev.diagnostics)) t.diagnostics = ev.diagnostics;
        neu = true;
        break;
      }
      case 'tool_execution_end': {
        const id = ev.toolCallId ?? ev.taskId;
        const t = id ? S.tools.get(id) : null;
        if (t) {
          t.status = 'fertig';
          if (ev.result !== undefined) {
            t.output = ergebnisText(ev.result);
            if (ev.result?.isError) t.status = 'error';
          }
          if (ev.entry) {
            const m = ev.entry.model?.[0];
            if (m?.role === 'toolResult') {
              t.output = inhaltText(m.content);
              t.status = m.isError ? 'error' : 'fertig';
            }
          }
        }
        neu = true;
        break;
      }
      case 'turn_start':
        setzeBusy(true);
        S.autoScroll = true;
        break;
      case 'turn_end':
        S.busy = false;
        if (S.liveMessage?.stopReason && S.liveMessage.stopReason !== 'pending') S.liveMessage = null;
        renderTop();
        fertig = true;
        break;
      case 'run_start':
        setzeBusy(true);
        break;
      case 'run_end':
        setzeBusy(false);
        fertig = true;
        break;
      case 'submission':
        neu = true;
        break;
      case 'inbox_update':
        break;
      case 'task_failed':
        toast(t('Aufgabe fehlgeschlagen: {grund}', { grund: ev.message ?? ev.kind ?? '' }), true);
        break;
      case 'auto_retry_start':
        toast(t('Modell antwortet nicht; neuer Versuch {n}.', { n: ev.attempt ?? '' }));
        break;
      case 'auto_retry_end':
        break;
      case 'compaction_start':
        toast(t('Verdichte Verlauf …'));
        break;
      case 'compaction_end':
        if (ev.error) toast(t('Verdichten fehlgeschlagen: {grund}', { grund: ev.error.message ?? ev.error }), true);
        break;
      case 'agent_changed':
        S.agent = ev.agent;
        break;
      case 'usage_changed':
        S.usage = ev.usage;
        break;
      case 'deferred_poll':
        break;
      case 'snapshot': {
        // Überlauf: der Server ersetzt verpasste Batches durch einen Snapshot (nur das aktive Fenster). Vereinigen statt ersetzen,
        // sonst verschwindet, was die Seite schon zeigt; Lauf und Werkzeuge kommen aus dem Snapshot.
        S.entries = vereinigeEintraege(S.entries, ev.entries);
        S.liveMessage = ev.generation?.message ?? null;
        S.busy = !!ev.run || !!ev.generation;
        S.tools.clear();
        for (const slot of [...(ev.tools ?? []), ...(ev.nestedTools ?? [])]) {
          const key = slot.callId ?? slot.taskId;
          if (!key) continue;
          S.tools.set(key, {
            id: key,
            name: slot.name ?? t('Werkzeug'),
            args: slot.arguments ?? {},
            output: typeof slot.output === 'string' ? slot.output : '',
            details: slot.details ?? null,
            diagnostics: slot.diagnostics ?? [],
            status: slot.status === 'done' ? 'fertig' : 'running',
          });
        }
        neu = true;
        break;
      }
      default:
        break;
    }
  }
  if (neu) planeChat();
  if (fertig) {
    setzeBusy(false);
    setTimeout(() => void sicher(ladeGespraeche), 250);
  }
}

// ---------------------------------------------------------------------------
// Chat zeichnen
// ---------------------------------------------------------------------------

function naheUnten() {
  const chat = $('#chat');
  if (!chat) return true;
  return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 180;
}

function nachricht(rolle, name, inhalt, zeitWert, extraKlasse = '') {
  const wrap = el('div', `nachricht ${rolle} ${extraKlasse}`.trim());
  wrap.appendChild(el('div', 'nachricht-zeichen', rolle === 'mensch' ? t('Du') : rolle === 'system' ? '·' : 'FY'));
  const blase = el('div', 'blase');
  const kopf = el('div', 'blase-kopf');
  kopf.appendChild(el('strong', '', name));
  if (zeitWert) kopf.appendChild(el('span', '', zeit(zeitWert)));
  blase.appendChild(kopf);
  blase.appendChild(inhalt);
  wrap.appendChild(blase);
  return wrap;
}

function textBlock(text) {
  const d = el('div', 'text');
  d.innerHTML = markdown(text);
  return d;
}

function werkzeugKarte({ id, name, args, result }) {
  const t = id ? S.tools.get(id) : null;
  const karte = el('div', 'werkzeug-karte');
  const kopf = el('div', 'werkzeug-kopf');
  if (t?.status === 'running') kopf.appendChild(el('span', 'spinner'));
  kopf.appendChild(el('span', 'name', name || t?.name || tr('Werkzeug')));
  const ausgabe = ergebnisText(result) || t?.output || '';
  const istFehler = !!result?.isError || t?.status === 'error';
  const statusText = tr(istFehler ? 'Fehler' : t?.status === 'running' ? 'läuft' : result || t?.status === 'fertig' ? 'fertig' : 'offen');
  kopf.appendChild(el('span', `status ${istFehler ? 'fehler' : t?.status === 'running' ? 'laeuft' : 'fertig'}`, statusText));
  karte.appendChild(kopf);

  const details = el('details');
  if (istFehler) details.open = true;
  const summary = el('summary', '', tr(ausgabe ? 'Eingabe und Ausgabe' : 'Eingabe'));
  details.appendChild(summary);
  const eingabe = args && Object.keys(args).length ? args : t?.args ?? {};
  details.appendChild(el('pre', '', wertText(eingabe)));
  if (ausgabe) details.appendChild(el('pre', '', ausgabe));
  if (t?.diagnostics?.length) details.appendChild(el('pre', '', wertText(t.diagnostics)));
  karte.appendChild(details);
  return karte;
}

function assistantInhalt(message, results, gerendert) {
  const box = el('div');
  const inhalt = Array.isArray(message?.content) ? message.content : [];
  let hatText = false;
  for (const block of inhalt) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && block.text) {
      box.appendChild(textBlock(block.text));
      hatText = true;
    } else if (block.type === 'thinking' && block.thinking) {
      const d = el('details', 'denken');
      d.appendChild(el('summary', '', t('Gedanken')));
      d.appendChild(el('div', '', block.thinking));
      box.appendChild(d);
    } else if (block.type === 'toolCall') {
      const id = block.id;
      if (id) gerendert.add(id);
      box.appendChild(werkzeugKarte({ id, name: block.name, args: block.arguments, result: id ? results.get(id) : null }));
      hatText = true;
    }
  }
  if (!hatText && !inhalt.length) {
    const w = el('div', 'mini');
    w.appendChild(el('span', 'spinner'));
    w.appendChild(document.createTextNode(` ${t('arbeitet …')}`));
    box.appendChild(w);
  }
  if (message?.usage) {
    const u = message.usage;
    const teile = [];
    if (u.input) teile.push(t('{n} ein', { n: u.input }));
    if (u.output) teile.push(t('{n} aus', { n: u.output }));
    if (u.cacheRead) teile.push(`${u.cacheRead} cache`);
    if (teile.length) box.appendChild(el('div', 'mini', t('Token: {teile}', { teile: teile.join(' · ') })));
  }
  return box;
}

function renderChat() {
  const chat = $('#chat');
  const leer = $('#chat-leer');
  if (!chat || !leer) return;
  const unten = naheUnten();
  let strom = $('#nachrichten');
  if (!strom) {
    strom = el('div');
    strom.id = 'nachrichten';
    chat.appendChild(strom);
  }
  const gemerkteStelle = chat.scrollTop;

  // Inkrementell: Einträge sind unveränderlich. Solange dieselben Einträge (und dieselben Werkzeugstände der gezeigten Karten)
  // vorliegen, bleibt der feste Teil im DOM (aufgeklappte Karten, Auswahl und Scrollstelle bleiben); neu gebaut wird nur der
  // Schwanz (laufende Antwort, laufende Werkzeuge, „arbeitet“).
  const c = chatCache;
  const gleich =
    c &&
    c.agent === (S.cfg?.agent ?? '') &&
    c.refs.length === S.entries.length &&
    S.entries.every((e, i) => e === c.refs[i]) &&
    c.werkzeuge === werkzeugSignatur(c.toolCalls, c.resultate) &&
    strom.children.length >= c.anzahl;
  if (gleich) {
    while (strom.children.length > c.anzahl) strom.lastElementChild.remove();
    return zeichneSchwanz(strom, chat, leer, c.resultate, c.toolCalls, new Set(c.gerendert), unten);
  }
  // Wuchs der Verlauf nur am Ende (gleicher Anfang), bleiben aufgeklappte/zugeklappte Karten, wie der Nutzer sie ließ.
  const kartenStand = c && S.entries.length && c.refs[0] === S.entries[0] ? festeKarten(strom, c.anzahl).map((d) => d.open) : [];
  strom.innerHTML = '';

  const resultate = new Map();
  const toolCalls = new Set();
  const menschenTexte = new Set();
  for (const e of S.entries) {
    if (e.kind === 'fyos.mensch') {
      const t = String(e.data?.text ?? '').trim();
      if (t) menschenTexte.add(t);
    }
    const msgs = Array.isArray(e.model) ? e.model : e.model ? [e.model] : [];
    for (const m of msgs) {
      if (m?.role === 'toolResult' && m.toolCallId) resultate.set(m.toolCallId, m);
      if (m?.role === 'assistant' && Array.isArray(m.content)) {
        for (const b of m.content) if (b?.type === 'toolCall' && b.id) toolCalls.add(b.id);
      }
    }
  }

  const gerendert = new Set();
  for (const e of S.entries) {
    const kind = String(e.kind ?? '');
    const msgs = Array.isArray(e.model) ? e.model : e.model ? [e.model] : [];

    if (kind === 'fyos.mensch') {
      const text = String(e.data?.text ?? '');
      if (text) {
        const inhalt = textBlock(text);
        if (e.data?.art === 'steuern') inhalt.prepend(el('div', 'mini', t('Steuerung')));
        strom.appendChild(nachricht('mensch', t('Du'), inhalt, eintragZeit(e), e.data?.art === 'steuern' ? 'steuern' : ''));
      }
      continue;
    }
    if (kind === 'fyos.freigabe-entscheidung') {
      const d = e.data ?? {};
      const text = `${t('Freigabe {id}: {entscheidung}', { id: d.id ?? '', entscheidung: t(d.entscheidung ?? 'entschieden') })}${d.notiz ? ` · ${d.notiz}` : ''}`;
      strom.appendChild(nachricht('system', t('Freigabe'), textBlock(text), eintragZeit(e)));
      continue;
    }
    if (kind === 'fyos.lauf.auftrag') {
      strom.appendChild(nachricht('system', t('Lauf'), textBlock(t('Auftrag für Lauf {lauf}: {titel}', { lauf: e.data?.lauf ?? '', titel: e.data?.titel ?? '' })), eintragZeit(e)));
      continue;
    }
    if (kind === 'pi.reset' || kind === 'pi.compaction') {
      // Kopf-Marker: neuer Kontext (leeren, /neu) oder Verdichtung. Ohne Zeile wäre der Chat danach scheinbar leer.
      const box = el('div');
      box.appendChild(el('div', 'mini', t(kind === 'pi.reset' ? 'Neuer Kontext begonnen. Das Modell sieht den Verlauf darüber nicht mehr.' : 'Verlauf verdichtet. Das Modell sieht ab hier nur die Zusammenfassung und das Folgende.')));
      const zusammenfassung = inhaltText(msgs[0]?.content).trim();
      if (zusammenfassung) {
        const d = el('details', 'denken');
        d.appendChild(el('summary', '', t(kind === 'pi.reset' ? 'Übergabe' : 'Zusammenfassung')));
        d.appendChild(el('div', '', zusammenfassung));
        box.appendChild(d);
      }
      strom.appendChild(nachricht('system', t(kind === 'pi.reset' ? 'Kontext' : 'Verdichtet'), box, eintragZeit(e)));
      continue;
    }
    if (kind.startsWith('fyos.') && !msgs.length) {
      const text = e.data?.text ?? wertText(e.data ?? e);
      strom.appendChild(nachricht('system', kind.replace(/^fyos\./, ''), textBlock(String(text)), eintragZeit(e)));
      continue;
    }

    for (const m of msgs) {
      if (!m || typeof m !== 'object') continue;
      if (m.role === 'user') {
        const text = inhaltText(m.content);
        if (text && !menschenTexte.has(text.trim())) {
          strom.appendChild(nachricht('mensch', t('Du'), textBlock(text), m.timestamp ?? eintragZeit(e)));
        }
        continue;
      }
      if (m.role === 'assistant') {
        const inhalt = assistantInhalt(m, resultate, gerendert);
        const name = S.cfg?.agent === 'persona' ? 'Persona' : (S.cfg?.agent ?? 'Agent');
        strom.appendChild(nachricht('assistent', name, inhalt, m.timestamp ?? eintragZeit(e)));
        continue;
      }
      if (m.role === 'toolResult') {
        if (m.toolCallId && toolCalls.has(m.toolCallId)) continue;
        if (m.toolCallId) gerendert.add(m.toolCallId);
        const karte = werkzeugKarte({ id: m.toolCallId, name: m.toolName ?? t('Werkzeug'), args: null, result: m });
        const box = el('div');
        box.appendChild(karte);
        strom.appendChild(nachricht('assistent', t('Werkzeug'), box, m.timestamp ?? eintragZeit(e)));
        continue;
      }
    }
  }

  festeKarten(strom, strom.children.length).forEach((d, i) => {
    if (i < kartenStand.length) d.open = kartenStand[i];
  });
  chatCache = {
    agent: S.cfg?.agent ?? '',
    refs: S.entries.slice(),
    anzahl: strom.children.length,
    resultate,
    toolCalls,
    gerendert: new Set(gerendert),
    werkzeuge: werkzeugSignatur(toolCalls, resultate),
  };
  zeichneSchwanz(strom, chat, leer, resultate, toolCalls, gerendert, unten);
  // Nach einem Neuaufbau bleibt die Lesestelle, wo sie war (nur am Ende wird nachgezogen).
  if (!(unten || S.autoScroll)) chat.scrollTop = gemerkteStelle;
}

let chatCache = null;

/** Alle `details` der ersten `anzahl` Kinder des Chatstroms, in Dokumentreihenfolge. */
function festeKarten(strom, anzahl) {
  return [...strom.children].slice(0, anzahl).flatMap((k) => [...k.querySelectorAll('details')]);
}

/** Stand der Werkzeuge, die in festen Karten gezeigt werden (Status, Ausgabe); ändert er sich, wird der feste Teil neu gebaut. */
function werkzeugSignatur(toolCalls, resultate) {
  let s = '';
  for (const t of S.tools.values()) {
    if (!toolCalls.has(t.id) && !resultate.has(t.id)) continue;
    s += `${t.id}:${t.status}:${(t.output ?? '').length}:${t.diagnostics?.length ?? 0};`;
  }
  return s;
}

function zeichneSchwanz(strom, chat, leer, resultate, toolCalls, gerendert, unten) {
  if (S.liveMessage?.role === 'assistant') {
    const inhalt = assistantInhalt(S.liveMessage, resultate, gerendert);
    const name = S.cfg?.agent === 'persona' ? 'Persona' : (S.cfg?.agent ?? 'Agent');
    strom.appendChild(nachricht('assistent', name, inhalt, S.liveMessage.timestamp ?? Date.now(), 'live'));
  }

  for (const t of S.tools.values()) {
    if (gerendert.has(t.id)) continue;
    if (t.status !== 'running' && !t.output && !toolCalls.has(t.id)) continue;
    const box = el('div');
    box.appendChild(werkzeugKarte({ id: t.id, name: t.name, args: t.args, result: null }));
    strom.appendChild(nachricht('assistent', tr('Werkzeug'), box, null));
  }

  if (S.busy && !S.liveMessage) {
    const box = el('div');
    box.appendChild(el('span', 'spinner'));
    box.appendChild(document.createTextNode(` ${t('arbeitet …')}`));
    strom.appendChild(nachricht('system', t('Lauf'), box, null));
  }

  const hatInhalt = strom.children.length > 0;
  leer.hidden = hatInhalt;
  if (unten || S.autoScroll) chat.scrollTop = chat.scrollHeight;
}

// ---------------------------------------------------------------------------
// Freigaben
// ---------------------------------------------------------------------------

function setzeFreigaben(wert) {
  if (Array.isArray(wert)) S.freigaben = wert;
  else if (wert?.eintraege) S.freigaben = Object.values(wert.eintraege);
  else S.freigaben = [];
  renderFreigaben();
  renderSidebar();
}

function renderFreigaben() {
  const offen = S.freigaben.filter((f) => f.status === 'offen');
  const banner = $('#freigabe-banner');
  if (!banner) return;
  if (!offen.length) {
    banner.hidden = true;
    banner.innerHTML = '';
    return;
  }
  banner.hidden = false;
  const f = offen[0];
  banner.innerHTML = '';
  const box = el('div', 'inhalt-klein');
  box.appendChild(el('strong', '', offen.length === 1 ? t('Eine Freigabe wartet') : t('{n} Freigaben warten', { n: offen.length })));
  // Entscheidung 586: Kurzkontext zuerst, dann die Aktion.
  box.appendChild(el('span', '', `${f.kontext ? `${f.kontext} · ` : ''}${f.aktion ?? t('Aktion')}`));
  banner.appendChild(box);
  const ja = el('button', 'primary', t('Freigeben'));
  ja.type = 'button';
  ja.dataset.freigabe = f.id;
  ja.dataset.entscheidung = 'erteilt';
  const nein = el('button', 'ghost gefahr', t('Ablehnen'));
  nein.type = 'button';
  nein.dataset.freigabe = f.id;
  nein.dataset.entscheidung = 'abgelehnt';
  banner.appendChild(ja);
  banner.appendChild(nein);
}

function oeffneFreigabe(id) {
  const f = S.freigaben.find((x) => x.id === id);
  if (!f) return;
  if (f.status !== 'offen') {
    toast(t('Diese Freigabe ist bereits {status}.', { status: t(f.status) }));
    return;
  }
  S.freigabeId = id;
  const frage = $('#freigabe-frage');
  frage.textContent = [
    f.kontext || '',
    t('Aktion: {aktion}', { aktion: f.aktion || '–' }),
    `${t('Risiko: {risiko}', { risiko: f.risiko ?? 'medium' })}${f.zerstoererisch ? t(' · zerstörerisch') : ''}`,
    f.gespraechTitel ? t('Gespräch: {titel}', { titel: f.gespraechTitel }) : '',
  ]
    .filter(Boolean)
    .join('\n');
  const dialog = $('#dialog-freigabe');
  if (!dialog.open) dialog.showModal();
}

// ---------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------

function renderZustand() {
  const box = $('#zustand-liste');
  if (!box) return;
  box.innerHTML = '';
  const werte = S.zustand?.werte ?? {};
  const keys = Object.keys(werte).sort((a, b) => a.localeCompare(b, 'de'));
  if (!keys.length) {
    box.appendChild(el('p', 'mini', t('Noch kein geteilter Wert. Der Agent kann hier Werte ablegen; du kannst sie auch selbst setzen.')));
    return;
  }
  for (const key of keys) {
    const zeile = el('div', 'zustand-zeile');
    zeile.appendChild(el('div', 'zustand-schluessel', key));
    zeile.appendChild(el('pre', 'zustand-wert', typeof werte[key] === 'string' ? werte[key] : wertText(werte[key])));
    const knopf = el('div', 'knopf-zeile');
    const bearbeiten = el('button', 'ghost', t('Bearbeiten'));
    bearbeiten.type = 'button';
    bearbeiten.dataset.zustandEdit = key;
    const loeschen = el('button', 'ghost gefahr', t('Löschen'));
    loeschen.type = 'button';
    loeschen.dataset.zustandDel = key;
    knopf.appendChild(bearbeiten);
    knopf.appendChild(loeschen);
    zeile.appendChild(knopf);
    box.appendChild(zeile);
  }
}

function oeffneZustand(key = null) {
  S.zustandSchluessel = key;
  const form = $('#form-zustand');
  $('#zustand-titel').textContent = key ? t('Wert „{key}“', { key }) : t('Wert setzen');
  form.elements.schluessel.value = key ?? '';
  form.elements.schluessel.readOnly = !!key;
  const wert = key ? S.zustand?.werte?.[key] : '';
  form.elements.wert.value = key && typeof wert === 'object' ? wertText(wert) : String(wert ?? '');
  const dialog = $('#dialog-zustand');
  if (!dialog.open) dialog.showModal();
}

// ---------------------------------------------------------------------------
// Läufe
// ---------------------------------------------------------------------------

function statusKlasse(text) {
  const s = String(text ?? '').toLowerCase();
  if (/abgeschlossen|completed|fertig/.test(s)) return 'fertig';
  if (/fehler|failed|abgebrochen|aborted|abgelehnt/.test(s)) return 'fehler';
  if (/laeuft|running|arbeitet/.test(s)) return 'laeuft';
  return '';
}

function renderLaeufe() {
  const box = $('#lauf-liste');
  if (!box) return;
  box.innerHTML = '';
  if (!S.laeufe.length) {
    box.appendChild(el('p', 'mini', t('Noch kein Lauf. Ein Lauf ist ein dauerhafter Auftrag mit Phasen und eigenem Kindgespräch.')));
    return;
  }
  for (const l of S.laeufe) {
    const karte = el('div', 'lauf');
    const kopf = el('div', 'lauf-kopf');
    kopf.appendChild(el('strong', '', l.titel || t('Lauf')));
    const status = l.status ?? l.taskStatus ?? 'offen';
    kopf.appendChild(el('span', `marke ${statusKlasse(status)}`.trim(), t(status)));
    if (l.phase) kopf.appendChild(el('span', 'marke', l.phase));
    if (l.quelle) kopf.appendChild(el('span', 'marke', l.quelle));
    karte.appendChild(kopf);

    const meta = el('div', 'lauf-meta');
    meta.appendChild(el('span', '', `#${l.id}`));
    if (l.erstellt) meta.appendChild(el('span', '', zeit(l.erstellt)));
    if (l.beendet) meta.appendChild(el('span', '', t('beendet {wann}', { wann: relativ(l.beendet) })));
    if (l.taskStatus) meta.appendChild(el('span', '', l.taskStatus));
    if (l.freigabeId) meta.appendChild(el('span', '', t('Freigabe {id}', { id: l.freigabeId })));
    karte.appendChild(meta);

    if (l.auftrag) karte.appendChild(el('p', 'lauf-text', l.auftrag));
    if (l.antwort) karte.appendChild(el('p', 'lauf-text', t('Antwort: {text}', { text: l.antwort })));
    else if (l.fehler) karte.appendChild(el('p', 'lauf-text', t('Fehler: {text}', { text: l.fehler })));
    else if (l.notiz) karte.appendChild(el('p', 'lauf-text', t('Notiz: {text}', { text: l.notiz })));

    const knoepfe = el('div', 'knopf-zeile');
    knoepfe.style.marginTop = '8px';
    if (l.kindId) {
      const oeffnen = el('button', 'ghost', t('Kindgespräch'));
      oeffnen.type = 'button';
      oeffnen.dataset.laufOeffnen = l.kindId;
      knoepfe.appendChild(oeffnen);
    }
    const laeuft = /laeuft|running|arbeitet/i.test(String(l.status ?? l.taskStatus ?? ''));
    if (laeuft) {
      const abbrechen = el('button', 'ghost gefahr', t('Abbrechen'));
      abbrechen.type = 'button';
      abbrechen.dataset.laufAbbrechen = l.id;
      knoepfe.appendChild(abbrechen);
    }
    karte.appendChild(knoepfe);
    box.appendChild(karte);
  }
}

async function ladeLaeufe() {
  const d = await api('api/laeufe');
  S.laeufe = Array.isArray(d.laeufe) ? d.laeufe : [];
  renderLaeufe();
  renderTop();
}

function planeLaeufe() {
  clearTimeout(S.laeufeTimer);
  S.laeufeTimer = setTimeout(() => void sicher(ladeLaeufe), 350);
}

// ---------------------------------------------------------------------------
// Werkzeuge
// ---------------------------------------------------------------------------

function renderWerkzeuge() {
  const box = $('#werkzeug-liste');
  if (!box) return;
  box.innerHTML = '';
  if (!S.werkzeuge.length) {
    box.appendChild(el('p', 'mini', t('Keine Werkzeuge gefunden. Ist der Hub erreichbar?')));
    return;
  }
  for (const w of S.werkzeuge) {
    const b = el('button', `werkzeug-eintrag${w.name === S.werkzeugAktiv ? ' aktiv' : ''}`);
    b.type = 'button';
    b.appendChild(el('strong', '', w.name ?? '?'));
    const beschreibung = String(w.description ?? '').replace(/\s+/g, ' ').trim();
    b.appendChild(el('span', '', beschreibung.length > 180 ? beschreibung.slice(0, 179) + '…' : beschreibung));
    b.addEventListener('click', () => void sicher(async () => {
      S.werkzeugAktiv = w.name;
      renderWerkzeuge();
      const d = await api(`api/werkzeuge/${encodeURIComponent(w.name)}`);
      $('#werkzeug-schema').textContent = wertText(d.werkzeug ?? d);
    }));
    box.appendChild(b);
  }
}

async function ladeWerkzeuge(q = '') {
  $('#werkzeug-schema').textContent = t('Suche …');
  const d = await api(`api/werkzeuge?q=${encodeURIComponent(q)}`, { timeoutMs: 60_000 });
  S.werkzeuge = Array.isArray(d.werkzeuge) ? d.werkzeuge : [];
  renderWerkzeuge();
  $('#werkzeug-schema').textContent = S.werkzeuge.length ? t('Wähle ein Werkzeug.') : t('Keine Treffer.');
}

// ---------------------------------------------------------------------------
// Knoten
// ---------------------------------------------------------------------------

function renderKnoten() {
  const box = $('#knoten-liste');
  if (!box) return;
  box.innerHTML = '';
  if (!S.knoten.length) {
    box.appendChild(el('p', 'mini', t('Keine Knoten konfiguriert.')));
    return;
  }
  for (const k of S.knoten) {
    const zeile = el('div', 'knoten');
    const punkt = el('span', 'punkt');
    if (k.ok === true) punkt.classList.add('an');
    else if (k.ok === false) punkt.classList.add('aus');
    zeile.appendChild(punkt);
    const text = el('div', 'knoten-text');
    text.appendChild(el('strong', '', k.titel || k.id));
    text.appendChild(el('span', '', `${k.weg || k.host || '?'}${k.art ? ` · ${k.art}` : ''}${k.local ? t(' · lokal') : ''}`));
    if (k.antwort) text.appendChild(el('span', '', String(k.antwort).replace(/\s+/g, ' ').slice(0, 220)));
    zeile.appendChild(text);
    const status = el('div', 'knoten-status');
    if (k.ok === true) status.textContent = `${t('erreichbar')}${k.ms ? ` · ${dauer(k.ms)}` : ''}`;
    else if (k.ok === false) status.textContent = t('nicht erreichbar');
    else status.textContent = t('nicht geprüft');
    zeile.appendChild(status);
    box.appendChild(zeile);
  }
}

async function ladeKnoten(pruefen = false) {
  if (pruefen) toast(t('Prüfe alle Knoten per ssh …'));
  const d = await api(`api/knoten${pruefen ? '?pruefen=1' : ''}`, { timeoutMs: 120_000 });
  S.knoten = Array.isArray(d.knoten) ? d.knoten : [];
  renderKnoten();
}

// ---------------------------------------------------------------------------
// Dokumente/SSE
// ---------------------------------------------------------------------------

function starteDokumenteSse() {
  if (S.docsSse) return;
  const es = new EventSource(sseUrl('api/dokumente'));
  S.docsSse = es;
  es.addEventListener('dokumente', (ereignis) => {
    let d;
    try {
      d = JSON.parse(ereignis.data);
    } catch {
      return;
    }
    for (const [name, wert] of Object.entries(d.dokumente ?? {})) wendeDokumentAn(name, wert);
    if (d.aufgaben) {
      S.aufgaben = d.aufgaben;
      renderTop();
    }
  });
  es.addEventListener('dokument', (ereignis) => {
    let d;
    try {
      d = JSON.parse(ereignis.data);
    } catch {
      return;
    }
    wendeDokumentAn(d.name, d.wert);
  });
  es.addEventListener('aufgaben', (ereignis) => {
    try {
      S.aufgaben = JSON.parse(ereignis.data);
    } catch {
      return;
    }
    renderTop();
  });
  es.onerror = () => {
    // EventSource verbindet selbst neu; der Zustand bleibt sichtbar.
  };
}

function wendeDokumentAn(name, wert) {
  if (name === 'register') {
    if (Array.isArray(wert?.agents)) {
      // Die Register-Einträge sind die Wahrheit für die Seitenleiste; die API ergänzt Meta.
      clearTimeout(S.gespraecheTimer);
      S.gespraecheTimer = setTimeout(() => void sicher(ladeGespraeche), 250);
    }
  } else if (name === 'freigaben') {
    setzeFreigaben(wert);
  } else if (name === 'laeufe') {
    planeLaeufe();
  } else if (name === 'zustand') {
    S.zustand = wert ?? { werte: {} };
    renderZustand();
  }
}

// ---------------------------------------------------------------------------
// Konfiguration und Initialisierung
// ---------------------------------------------------------------------------

async function ladeKonfiguration() {
  const c = await api('api/konfiguration');
  S.cfg = c;
  S.modelle = Array.isArray(c.modelle) ? c.modelle : [];
  S.bereiche = c.arbeitsbereiche ?? {};
  fuelleAuswahl();
  renderGeraet();
  renderSidebar();
  $('#token-hinweis').hidden = !S.token;
  $('#composer-hinweis').textContent = S.token
    ? t('Token gesetzt. Der Lauf ist dauerhaft; alle Clients sehen denselben Stand.')
    : t('Der Lauf ist dauerhaft. Mehrere Clients sehen denselben Stand.');
}

function fuelleAuswahl() {
  const bereiche = Object.entries(S.bereiche);
  const modelle = S.modelle;
  const feld = (id, leer = t('Standard')) => {
    const s = $(id);
    if (!s) return;
    const alt = s.value;
    s.innerHTML = '';
    if (leer !== null) {
      const o = el('option', '', leer);
      o.value = '';
      s.appendChild(o);
    }
    for (const [name, b] of bereiche) {
      const o = el('option', '', b.titel || name);
      o.value = name;
      s.appendChild(o);
    }
    if (alt) s.value = alt;
  };
  const modellFeld = (id) => {
    const s = $(id);
    if (!s) return;
    const alt = s.value;
    s.innerHTML = '';
    const o = el('option', '', t('Standard'));
    o.value = '';
    s.appendChild(o);
    for (const m of modelle) {
      const opt = el('option', '', m.name || m.id);
      opt.value = m.id;
      s.appendChild(opt);
    }
    if (alt) s.value = alt;
  };
  feld('#meta-bereich', null);
  feld('#neu-bereich', null);
  feld('#lauf-bereich', null);
  modellFeld('#meta-modell');
  modellFeld('#neu-modell');
  modellFeld('#lauf-modell');
  if (S.meta) metaInFormular();
}

function metaInFormular() {
  const m = S.meta ?? {};
  const titel = $('#meta-titel');
  if (titel) titel.value = m.titel ?? '';
  const b = $('#meta-bereich');
  if (b) b.value = m.arbeitsbereich ?? 'standard';
  const mo = $('#meta-modell');
  if (mo) mo.value = m.modell ?? '';
}

function tokenAusUrl() {
  try {
    const u = new URL(location.href);
    const t = u.searchParams.get('token');
    if (t) {
      S.token = t;
      localStorage.setItem(SPEICHER.token, t);
      u.searchParams.delete('token');
      history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
    }
  } catch {
    /* egal */
  }
  if (!S.token) {
    try {
      S.token = localStorage.getItem(SPEICHER.token) || '';
    } catch {
      S.token = '';
    }
  }
  const feld = $('#token-feld');
  if (feld) feld.value = S.token;
  $('#token-hinweis').hidden = !S.token;
  $('#token-status').textContent = S.token
    ? t('Ein Token ist gesetzt; er wird nur an den Runner gesendet.')
    : t('Kein Token gesetzt. Das ist nur bei 127.0.0.1 sicher.');
}

async function ladeHealth() {
  try {
    const h = await api('api/health', { timeoutMs: 15_000 });
    S.health = h;
    const hub = h.hub?.ok ? t('Hub ok') : t('Hub offline');
    setzeVerbindung('an', t('verbunden'), hub);
  } catch (fehler) {
    S.health = null;
    setzeVerbindung('aus', t('nicht verbunden'), fehlerText(fehler));
  }
  renderTop();
  renderGeraet();
}

async function ladeFreigaben() {
  const d = await api('api/freigaben');
  setzeFreigaben(d.freigaben ?? []);
}

async function ladeZustand() {
  const d = await api('api/zustand');
  S.zustand = d.zustand ?? { werte: {} };
  renderZustand();
}

async function starteAlles() {
  seiteUebersetzen(document);
  tokenAusUrl();
  bindeEreignisse();
  await sicher(ladeKonfiguration);
  await sicher(ladeHealth);
  await sicher(ladeGespraeche);
  await sicher(ladeFreigaben);
  await sicher(ladeLaeufe);
  await sicher(ladeZustand);
  await sicher(ladeKnoten, false);

  let id = null;
  try {
    id = localStorage.getItem(SPEICHER.gespraech);
  } catch {
    id = null;
  }
  if (!id || !S.gespraeche.some((g) => String(g.id) === String(id))) {
    const root = S.gespraeche.find((g) => g.art === 'root') ?? S.gespraeche[0];
    id = root?.id ?? null;
  }
  if (!id) {
    const d = await sicher(() => api('api/gespraeche', { methode: 'POST', koerper: { titel: t('Hauptgespräch'), arbeitsbereich: 'standard' } }));
    if (d?.gespraech?.id) {
      await sicher(ladeGespraeche);
      id = d.gespraech.id;
    }
  }
  if (id) await sicher(() => oeffneGespraech(id));
  starteDokumenteSse();
  S.live = liesLive();
  if (S.live) starteStromSse();
  renderStrom();
  starteTicker();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((fehler) => console.warn('[fyos] ServiceWorker:', fehler.message));
  }
}

function starteTicker() {
  clearInterval(S.ticker);
  S.ticker = setInterval(() => {
    if (!document.hidden) {
      renderSidebar();
      if (S.busy) renderTop();
    }
  }, 30_000);
}

// ---------------------------------------------------------------------------
// Ereignisse
// ---------------------------------------------------------------------------

function wechsleTab(name) {
  for (const b of $$('#tabs button')) b.classList.toggle('aktiv', b.dataset.tab === name);
  for (const id of ['chat', 'zustand', 'aufgaben', 'werkzeuge', 'erweitern']) {
    $(`#inhalt-${id}`).hidden = id !== name;
  }
  try {
    localStorage.setItem(SPEICHER.tab, name);
  } catch {
    /* egal */
  }
  if (name === 'werkzeuge' && !S.werkzeuge.length) void sicher(() => ladeWerkzeuge(''));
  if (name === 'erweitern') {
    renderGeraet();
    renderKnoten();
    metaInFormular();
  }
  if (name === 'aufgaben') void sicher(ladeLaeufe);
  if (name === 'zustand') void sicher(ladeZustand);
}

function bindeEreignisse() {
  $('#neu-gespraech')?.addEventListener('click', () => {
    const dialog = $('#dialog-neu');
    if (!dialog.open) dialog.showModal();
  });
  $('#einstellungen-knopf')?.addEventListener('click', () => {
    wechsleTab('erweitern');
    schliesseSidebar();
  });
  $('#sidebar-auf')?.addEventListener('click', oeffneSidebar);
  $('#sidebar-zu')?.addEventListener('click', schliesseSidebar);
  $('#schleier')?.addEventListener('click', schliesseSidebar);

  for (const b of $$('#tabs button')) b.addEventListener('click', () => wechsleTab(b.dataset.tab));

  const eingabe = $('#eingabe');
  const senden = $('#senden');
  const autoGroesse = () => {
    eingabe.style.height = 'auto';
    eingabe.style.height = `${Math.min(180, eingabe.scrollHeight)}px`;
  };
  eingabe.addEventListener('input', () => {
    autoGroesse();
    senden.disabled = !eingabe.value.trim() || !S.aktuellId;
  });
  eingabe.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void sendeNachricht();
    }
  });
  senden.addEventListener('click', () => void sendeNachricht());
  $('#chat').addEventListener('scroll', () => {
    S.autoScroll = naheUnten();
  });

  $('#mikro')?.addEventListener('click', starteMikrofon);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    S.erkennen = SR;
    $('#mikro').hidden = false;
  } else {
    $('#mikro').hidden = true;
    $('#mikro-status').textContent = t('keine Spracheingabe im Browser');
    setTimeout(() => {
      $('#mikro-status').textContent = '';
    }, 5000);
  }

  $('#aktion-live')?.addEventListener('click', () => setzeLive(!S.live));
  $('#wirken-aus')?.addEventListener('click', () => setzeLive(false));
  // Klick auf eine Zeile verschiebt nur den Fokus; der Strom läuft weiter.
  $('#wirken-liste')?.addEventListener('click', (e) => {
    const id = e.target.closest('li')?.dataset.gespraech;
    const g = S.gespraeche.find((x) => String(x.id) === id);
    if (g) void sicher(() => oeffneGespraech(g.id));
  });
  $('#aktion-abbrechen')?.addEventListener('click', () => void sicher(async () => {
    if (!S.aktuellId) return;
    await api(`api/gespraech/${encodeURIComponent(S.aktuellId)}/abbrechen`, { methode: 'POST', koerper: {} });
    toast(t('Abbruch angefordert.'));
  }));
  $('#aktion-zweig')?.addEventListener('click', () => void sicher(async () => {
    if (!S.aktuellId) return;
    const titel = t('{titel} · Zweig', { titel: S.meta?.titel ?? t('Gespräch') });
    const d = await api(`api/gespraech/${encodeURIComponent(S.aktuellId)}/zweig`, { methode: 'POST', koerper: { titel } });
    await ladeGespraeche();
    if (d.gespraech?.id) await oeffneGespraech(d.gespraech.id);
    toast(t('Zweig angelegt.'));
  }));
  $('#aktion-verdichten')?.addEventListener('click', () => void sicher(async () => {
    if (!S.aktuellId) return;
    await api(`api/gespraech/${encodeURIComponent(S.aktuellId)}/verdichten`, { methode: 'POST', koerper: {} });
    toast(t('Verdichten gestartet.'));
  }));

  $('#meta-speichern')?.addEventListener('click', () => void sicher(async () => {
    if (!S.aktuellId) return;
    const d = await api(`api/gespraech/${encodeURIComponent(S.aktuellId)}`, {
      methode: 'PATCH',
      koerper: {
        titel: $('#meta-titel').value.trim() || t('Gespräch'),
        arbeitsbereich: $('#meta-bereich').value || 'standard',
        modell: $('#meta-modell').value || null,
      },
    });
    S.meta = d.gespraech?.meta ?? S.meta;
    await ladeGespraeche();
    renderTop();
    metaInFormular();
    toast(t('Gespräch gespeichert.'));
  }));
  $('#aktion-leeren')?.addEventListener('click', () => void sicher(async () => {
    if (!S.aktuellId) return;
    if (!confirm(t('Verlauf dieses Gesprächs leeren? Das lässt sich nicht zurücknehmen.'))) return;
    await api(`api/gespraech/${encodeURIComponent(S.aktuellId)}/leeren`, { methode: 'POST', koerper: {} });
    toast(t('Verlauf geleert.'));
  }));

  $('#zustand-neu')?.addEventListener('click', () => oeffneZustand());
  $('#zustand-liste')?.addEventListener('click', (e) => {
    const edit = e.target.closest('[data-zustand-edit]');
    if (edit) {
      oeffneZustand(edit.dataset.zustandEdit);
      return;
    }
    const del = e.target.closest('[data-zustand-del]');
    if (del) {
      const key = del.dataset.zustandDel;
      if (!confirm(t('Wert „{key}“ löschen?', { key }))) return;
      void sicher(async () => {
        await api(`api/zustand/${encodeURIComponent(key)}`, { methode: 'DELETE' });
        await ladeZustand();
        toast(t('Wert gelöscht.'));
      });
    }
  });

  $('#lauf-neu')?.addEventListener('click', () => {
    const dialog = $('#dialog-lauf');
    if (!dialog.open) dialog.showModal();
  });
  $('#lauf-liste')?.addEventListener('click', (e) => {
    const oeffnen = e.target.closest('[data-lauf-oeffnen]');
    if (oeffnen) {
      void sicher(() => oeffneGespraech(oeffnen.dataset.laufOeffnen));
      return;
    }
    const abbrechen = e.target.closest('[data-lauf-abbrechen]');
    if (abbrechen) {
      const id = abbrechen.dataset.laufAbbrechen;
      if (!confirm(t('Lauf #{id} abbrechen?', { id }))) return;
      void sicher(async () => {
        await api(`api/laeufe/${encodeURIComponent(id)}/abbrechen`, { methode: 'POST', koerper: {} });
        await ladeLaeufe();
        toast(t('Lauf abgebrochen.'));
      });
    }
  });

  $('#werkzeug-suchen')?.addEventListener('click', () => void sicher(() => ladeWerkzeuge($('#werkzeug-suche').value.trim())));
  $('#werkzeug-suche')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void sicher(() => ladeWerkzeuge($('#werkzeug-suche').value.trim()));
    }
  });

  $('#knoten-pruefen')?.addEventListener('click', () => void sicher(async () => {
    await ladeKnoten(true);
    toast(t('Knotenprüfung fertig.'));
  }));
  $('#config-neu-laden')?.addEventListener('click', () => void sicher(async () => {
    await ladeKonfiguration();
    await ladeHealth();
    await ladeKnoten(false);
    toast(t('Konfiguration neu geladen.'));
  }));

  $('#token-speichern')?.addEventListener('click', () => void sicher(async () => {
    const t = $('#token-feld').value.trim();
    if (!t) throw new Error(tr('Token ist leer. Zum Löschen den Knopf „Löschen“ verwenden.'));
    S.token = t;
    try {
      localStorage.setItem(SPEICHER.token, t);
    } catch {
      /* egal */
    }
    await api('api/health');
    location.reload();
  }));
  $('#token-loeschen')?.addEventListener('click', () => {
    S.token = '';
    try {
      localStorage.removeItem(SPEICHER.token);
    } catch {
      /* egal */
    }
    document.cookie = 'fyos_runner=; Besitzer-Age=0; Path=/; SameSite=Strict';
    location.reload();
  });

  $('#freigabe-banner')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-freigabe]');
    if (!b) return;
    if (b.dataset.entscheidung) {
      void entscheideFreigabe(b.dataset.freigabe, b.dataset.entscheidung, '');
    } else {
      oeffneFreigabe(b.dataset.freigabe);
    }
  });

  $('#form-neu')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const wert = e.submitter?.value;
    const dialog = $('#dialog-neu');
    if (wert === 'abbrechen' || !wert) {
      dialog.close();
      return;
    }
    const form = e.target;
    void sicher(async () => {
      const d = await api('api/gespraeche', {
        methode: 'POST',
        koerper: {
          titel: form.elements.titel.value.trim() || t('Neuer Agent'),
          arbeitsbereich: form.elements.arbeitsbereich.value || 'standard',
          modell: form.elements.modell.value || null,
        },
      });
      dialog.close();
      await ladeGespraeche();
      if (d.gespraech?.id) await oeffneGespraech(d.gespraech.id);
      toast(t('Agent angelegt.'));
    });
  });

  $('#form-lauf')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const wert = e.submitter?.value;
    const dialog = $('#dialog-lauf');
    if (wert === 'abbrechen' || !wert) {
      dialog.close();
      return;
    }
    const form = e.target;
    void sicher(async () => {
      if (!S.aktuellId) throw new Error(t('Kein Gespräch geöffnet.'));
      const d = await api(`api/gespraech/${encodeURIComponent(S.aktuellId)}/laeufe`, {
        methode: 'POST',
        koerper: {
          titel: form.elements.titel.value.trim() || t('Lauf'),
          auftrag: form.elements.auftrag.value.trim(),
          arbeitsbereich: form.elements.arbeitsbereich.value || 'standard',
          modell: form.elements.modell.value || null,
          freigabe: !!form.elements.freigabe.checked,
        },
      });
      dialog.close();
      form.reset();
      await ladeLaeufe();
      wechsleTab('aufgaben');
      toast(t('Lauf #{id} gestartet.', { id: d.lauf?.id ?? '' }));
    });
  });

  $('#form-freigabe')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const wert = e.submitter?.value;
    const dialog = $('#dialog-freigabe');
    if (wert === 'abbrechen' || !wert) {
      dialog.close();
      return;
    }
    const notiz = e.target.elements.notiz.value.trim();
    const id = S.freigabeId;
    dialog.close();
    if (!id) return;
    void entscheideFreigabe(id, wert, notiz);
  });

  $('#form-zustand')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const wert = e.submitter?.value;
    const dialog = $('#dialog-zustand');
    if (wert === 'abbrechen' || !wert) {
      dialog.close();
      return;
    }
    const form = e.target;
    const key = form.elements.schluessel.value.trim();
    const roh = form.elements.wert.value;
    let inhalt = roh;
    try {
      inhalt = JSON.parse(roh);
    } catch {
      /* Text bleibt Text */
    }
    dialog.close();
    void sicher(async () => {
      await api(`api/zustand/${encodeURIComponent(key)}`, { methode: 'PUT', koerper: { wert: inhalt } });
      await ladeZustand();
      toast(t('Wert gespeichert.'));
    });
  });

  $('#pwa-installieren')?.addEventListener('click', async () => {
    if (!S.installPrompt) return;
    S.installPrompt.prompt();
    await S.installPrompt.userChoice;
    S.installPrompt = null;
    $('#pwa-installieren').hidden = true;
  });
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    S.installPrompt = e;
    $('#pwa-installieren').hidden = false;
  });

  $('#aktion-export')?.addEventListener('click', () => {
    const daten = {
      gespraech: S.meta,
      exportiert: new Date().toISOString(),
      eintraege: S.entries,
    };
    const blob = new Blob([JSON.stringify(daten, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fyos-gespraech-${S.aktuellId ?? 'export'}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#aktion-zurueck')?.addEventListener('click', () => void sicher(async () => {
    const root = S.gespraeche.find((g) => g.art === 'root') ?? S.gespraeche[0];
    if (root) await oeffneGespraech(root.id);
  }));

  for (const dialog of $$('dialog')) {
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
  }
}

// ---------------------------------------------------------------------------
// Live: der Strom der autonomen Arbeit
// ---------------------------------------------------------------------------

const STROM_MAX = 200;
const hhmmss = (ts) => new Date(ts).toLocaleTimeString(ortsform(), { hour12: false });

function liesLive() {
  try {
    return localStorage.getItem(SPEICHER.live) !== 'aus';
  } catch {
    return true;
  }
}

function schreibeLive(an) {
  try {
    localStorage.setItem(SPEICHER.live, an ? 'an' : 'aus');
  } catch {
    /* egal */
  }
}

function renderStrom() {
  const kasten = $('#wirken');
  const schalter = $('#aktion-live');
  if (schalter) {
    schalter.setAttribute('aria-pressed', String(S.live));
    schalter.textContent = S.live ? 'Live' : t('Live aus');
  }
  if (!kasten) return;
  kasten.hidden = !S.live;
  if (!S.live) return;
  const liste = $('#wirken-liste');
  liste.replaceChildren();
  if (!S.stromZeilen.length) {
    const leer = el('li', 'wirken-leer', t('Gerade ruhig. Neue Arbeit erscheint hier von selbst.'));
    leer.style.display = 'block';
    liste.append(leer);
  }
  for (const z of S.stromZeilen) {
    const li = el('li', `typ-${z.typ}${z.gespraech === S.aktuellId ? ' fokus' : ''}`);
    li.title = t('{titel} · Klick: Fokus hierher', { titel: z.titel ?? '' });
    li.dataset.gespraech = z.gespraech;
    li.append(el('span', 'zeit', hhmmss(z.t)));
    const was = el('span', 'was');
    if (z.gespraech !== S.aktuellId && z.titel) was.append(el('span', 'wo', `${z.titel} · `));
    was.append(document.createTextNode(z.text));
    li.append(was);
    liste.append(li);
  }
  liste.scrollTop = liste.scrollHeight;
  const jung = Date.now() - S.stromLetzte < 30_000;
  kasten.classList.toggle('ruhig', !jung);
  const zaehler = $('#wirken-zaehler');
  if (zaehler) zaehler.textContent = S.stromLetzte ? t('zuletzt {wann}', { wann: relativ(S.stromLetzte) }) : '';
}

function schliesseStromSse() {
  if (S.stromSse) {
    S.stromSse.close();
    S.stromSse = null;
  }
}

function starteStromSse() {
  schliesseStromSse();
  const es = new EventSource(sseUrl('api/strom'));
  S.stromSse = es;
  es.addEventListener('zeile', (ereignis) => {
    if (S.stromSse !== es) return;
    let z;
    try {
      z = JSON.parse(ereignis.data);
    } catch {
      return;
    }
    S.stromZeilen.push(z);
    if (S.stromZeilen.length > STROM_MAX) S.stromZeilen.splice(0, S.stromZeilen.length - STROM_MAX);
    S.stromLetzte = z.t ?? Date.now();
    // Ein neues Gespräch (z. B. ein Lauf) in der Seitenleiste nachführen, ohne den Fokus zu ändern.
    if (z.gespraech && !S.gespraeche.some((g) => g.id === z.gespraech) && z.art !== 'lauf') {
      void sicher(ladeGespraeche);
    }
    renderStrom();
  });
  es.onerror = () => {
    /* EventSource verbindet selbst neu; der Strom ist nur eine Anzeige. */
  };
}

/** Live ein- oder ausblenden. Der Agent arbeitet unverändert weiter. */
function setzeLive(an) {
  S.live = !!an;
  schreibeLive(S.live);
  if (S.live) starteStromSse();
  else schliesseStromSse();
  renderStrom();
}

/** `/live`, `/live an`, `/live aus` — gibt `true` zurück, wenn der Text ein Befehl war. */
function liveBefehl(text) {
  const m = /^\/live(?:\s+(an|aus|ein))?\s*$/i.exec(text);
  if (!m) return false;
  const wunsch = m[1]?.toLowerCase();
  setzeLive(wunsch ? wunsch !== 'aus' : !S.live);
  toast(S.live ? t('Live an: du siehst die autonome Arbeit.') : t('Live aus: Strom ausgeblendet. /live blendet ihn wieder ein.'));
  return true;
}

async function sendeNachricht() {
  if (!S.aktuellId) return;
  const eingabe = $('#eingabe');
  const text = eingabe.value.trim();
  if (!text) return;
  if (liveBefehl(text)) {
    eingabe.value = '';
    eingabe.style.height = 'auto';
    $('#senden').disabled = true;
    return;
  }
  const art = $('#sende-art').value;
  const senden = $('#senden');
  senden.disabled = true;
  S.autoScroll = true;
  try {
    await api(`api/gespraech/${encodeURIComponent(S.aktuellId)}/nachricht`, {
      methode: 'POST',
      koerper: { text, art, requestId: `web:${crypto.randomUUID?.() ?? Date.now()}` },
    });
    eingabe.value = '';
    eingabe.style.height = 'auto';
  } catch (fehler) {
    fehlerMelden(fehler);
    eingabe.value = text;
  } finally {
    senden.disabled = !eingabe.value.trim();
    eingabe.focus();
  }
}

async function entscheideFreigabe(id, entscheidung, notiz) {
  await sicher(async () => {
    await api(`api/freigaben/${encodeURIComponent(id)}`, {
      methode: 'POST',
      koerper: { entscheidung, notiz, von: 'mensch' },
    });
    await ladeFreigaben();
    toast(entscheidung === 'erteilt' ? t('Freigabe erteilt.') : t('Freigabe abgelehnt.'));
  });
}

function starteMikrofon() {
  if (!S.erkennen) {
    toast(t('Dieser Browser hat keine Spracheingabe. Tippen funktioniert weiter.'), true);
    return;
  }
  if (S.mikroLaeuft) {
    S.mikroLaeuft = false;
    $('#mikro').classList.remove('an');
    $('#mikro-status').textContent = '';
    return;
  }
  const erkennen = new S.erkennen();
  erkennen.lang = sprache() === 'en' ? 'en-US' : 'de-DE';
  erkennen.interimResults = true;
  erkennen.continuous = false;
  const basis = $('#eingabe').value;
  let fertigText = '';
  erkennen.onresult = (ereignis) => {
    let zwischen = '';
    let endgueltig = '';
    for (let i = ereignis.resultIndex; i < ereignis.results.length; i++) {
      const r = ereignis.results[i];
      if (r.isFinal) endgueltig += r[0].transcript;
      else zwischen += r[0].transcript;
    }
    if (endgueltig) fertigText += endgueltig;
    const text = `${basis} ${fertigText} ${zwischen}`.replace(/\s+/g, ' ').trim();
    $('#eingabe').value = text;
    $('#eingabe').dispatchEvent(new Event('input'));
    $('#mikro-status').textContent = zwischen ? t('höre …') : t('erkannt');
  };
  erkennen.onerror = (e) => {
    S.mikroLaeuft = false;
    $('#mikro').classList.remove('an');
    $('#mikro-status').textContent = '';
    const text =
      e.error === 'not-allowed'
        ? t('Mikrofon nicht erlaubt. Tippen funktioniert weiter.')
        : e.error === 'no-speech'
          ? t('Nichts gehört. Noch einmal versuchen.')
          : t('Spracheingabe: {fehler}', { fehler: e.error });
    toast(text, e.error !== 'no-speech');
  };
  erkennen.onend = () => {
    S.mikroLaeuft = false;
    $('#mikro').classList.remove('an');
    $('#mikro-status').textContent = '';
  };
  S.mikroLaeuft = true;
  $('#mikro').classList.add('an');
  $('#mikro-status').textContent = t('höre …');
  try {
    erkennen.start();
  } catch (fehler) {
    S.mikroLaeuft = false;
    $('#mikro').classList.remove('an');
    fehlerMelden(fehler);
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

starteAlles().catch((fehler) => {
  fehlerMelden(fehler);
  setzeVerbindung('aus', t('Start fehlgeschlagen'), '');
});
