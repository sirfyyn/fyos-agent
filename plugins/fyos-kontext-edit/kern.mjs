// Kern des Kontext-Edit-Versuchs: Der Agent bearbeitet seinen eigenen Verlauf selbst, nach der Idee von
// "Context Language Models" (Shao u. a., arXiv 2609.37725), ohne Code aus dem Paper-Repo (CC BY-NC).
// Reine Logik ohne OpenClaw-Abhängigkeit, damit sie einzeln testbar ist.
//
// Bearbeitbar sind nur Werkzeugergebnisse (role "toolResult"): sie machen den Großteil langer Agenten-Kontexte aus und
// tragen mit toolCallId eine Kennung, die einen Transkript-Rewrite überlebt (entryIds ändern sich dabei).

import {createHash} from 'node:crypto';

export const MARKE_GELOESCHT = '[vom Agenten entfernt, nicht mehr gebraucht]';
export const MARKE_VERDICHTET = '[vom Agenten verdichtet] ';

export const ANLEITUNG = [
  'Jedes Werkzeugergebnis in deinem Verlauf trägt eine Kennung wie [#w3]. Dein Kontext ist begrenzt.',
  'Mit dem Werkzeug kontext_bearbeiten kannst du frühere Werkzeugergebnisse löschen oder durch eine kurze eigene',
  'Zusammenfassung ersetzen. Tu das, wenn ein Ergebnis für die weitere Arbeit nicht mehr gebraucht wird oder viel',
  'länger ist als sein nützlicher Inhalt; schreib in die Zusammenfassung alles, was du noch brauchst (Werte, Namen,',
  'Fehlermeldungen wörtlich). Wenn nichts zu bereinigen ist, bearbeite nichts und arbeite einfach weiter.',
].join(' ');

// Messung: von sich aus editiert das Modell kaum (1 von 10 Läufen, auch bei knappem Kontext
// nicht). Darum bestimmt das Harness den Zeitpunkt (dieser Auftrag), das Modell den Inhalt.
export const AUFTRAG = [
  'Dein Kontext ist fast voll. Bereinige ihn jetzt zuerst mit kontext_bearbeiten: lösche Werkzeugergebnisse, die du',
  'nicht mehr brauchst, und verdichte die, die du noch brauchst (Werte, Namen, Fehlermeldungen wörtlich). Danach',
  'arbeite an der Anfrage weiter.',
].join(' ');

/** Neuer Sitzungszustand. aliase: wN -> toolCallId, offen: toolCallId -> Edit, erledigt: Set der toolCallIds. */
export function neuerZustand() {
  return {aliase: new Map(), rueck: new Map(), offen: new Map(), erledigt: new Set(), zaehler: 0, auftragBei: 0};
}

/**
 * Soll das Harness jetzt die Bereinigung verlangen? Nur über der Schwelle (Anteil am Budget), nur wenn es unbearbeitete
 * Werkzeugergebnisse gibt, und erneut erst, wenn der Kontext seit dem letzten Auftrag um weitere 10 % des Budgets wuchs.
 */
export function auftragFaellig(zustand, token, budget, schwelle) {
  if (!(budget > 0) || !(schwelle > 0)) return false;
  if (token < schwelle * budget) return false;
  const unbearbeitet = [...zustand.aliase.values()].some((id) => !zustand.offen.has(id));
  if (!unbearbeitet) return false;
  if (zustand.auftragBei && token < zustand.auftragBei + 0.1 * budget) return false;
  zustand.auftragBei = token;
  return true;
}

/** Versuchsarm je Sitzung, deterministisch aus dem sessionKey: 'edit' mit Wahrscheinlichkeit anteil, sonst 'kontrolle'. */
export function arm(sessionKey, anteil) {
  if (!sessionKey || !(anteil > 0)) return 'kontrolle';
  if (anteil >= 1) return 'edit';
  const h = createHash('sha256').update(String(sessionKey)).digest();
  return h.readUInt32BE(0) / 0x100000000 < anteil ? 'edit' : 'kontrolle';
}

function textVon(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text').map((b) => b.text ?? '').join('\n');
}

/** Grobe Tokenschätzung (Zeichen / 3,5), nur für Protokoll und Hinweis. */
export function schaetzeTokens(messages) {
  let z = 0;
  for (const m of messages ?? []) {
    if (m?.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) z += (b?.text ?? b?.thinking ?? '').length + (b?.arguments ? JSON.stringify(b.arguments).length : 0);
    } else z += textVon(m?.content).length;
  }
  return Math.round(z / 3.5);
}

/** Ersatznachricht für ein bearbeitetes Werkzeugergebnis; Rolle, toolCallId und toolName bleiben. */
export function ersatzNachricht(message, edit) {
  const text = edit.aktion === 'loeschen' ? MARKE_GELOESCHT
    : edit.verweis ? `${MARKE_VERDICHTET}siehe ${edit.verweis}` : MARKE_VERDICHTET + edit.text;
  const {details: _weg, ...rest} = message;
  return {...rest, content: [{type: 'text', text}]};
}

/**
 * Projektion für assemble(): vergibt Kennungen wN in Verlaufsreihenfolge (stabil über toolCallId), setzt sie vor den
 * Text jedes Werkzeugergebnisses und wendet noch nicht persistierte Edits schon an. Verändert die Eingabe nicht.
 */
export function markiere(messages, zustand) {
  const aus = [];
  for (const m of messages ?? []) {
    if (m?.role !== 'toolResult' || !m.toolCallId) { aus.push(m); continue; }
    let alias = zustand.rueck.get(m.toolCallId);
    if (!alias) {
      alias = `w${++zustand.zaehler}`;
      zustand.aliase.set(alias, m.toolCallId);
      zustand.rueck.set(m.toolCallId, alias);
    }
    const edit = zustand.offen.get(m.toolCallId);
    const basis = edit ? ersatzNachricht(m, edit) : m;
    const content = Array.isArray(basis.content) ? basis.content : [{type: 'text', text: String(basis.content ?? '')}];
    const i = content.findIndex((b) => b?.type === 'text');
    const neu = i < 0 ? [{type: 'text', text: `[#${alias}]`}, ...content]
      : content.map((b, j) => (j === i ? {...b, text: `[#${alias}] ${b.text ?? ''}`} : b));
    aus.push({...basis, content: neu});
  }
  return aus;
}

/**
 * Werkzeugaufruf kontext_bearbeiten prüfen und vormerken. Gibt {ok, text} für das Werkzeugergebnis zurück.
 * ersetzen mit mehreren Zielen: das erste trägt die Zusammenfassung, die übrigen verweisen darauf.
 */
export function bearbeite(zustand, params) {
  const aktion = params?.aktion;
  const ziele = [...new Set((Array.isArray(params?.ziele) ? params.ziele : []).map((z) => String(z).replace(/^#/, '').trim()))];
  const text = typeof params?.text === 'string' ? params.text.trim() : '';
  if (aktion !== 'loeschen' && aktion !== 'ersetzen') return {ok: false, text: 'aktion muss loeschen oder ersetzen sein.'};
  if (!ziele.length) return {ok: false, text: 'ziele fehlt (Kennungen wie w3).'};
  if (aktion === 'ersetzen' && !text) return {ok: false, text: 'Bei ersetzen fehlt der text (die Zusammenfassung).'};
  // Machbarkeit 04.10.: das Modell nennt auch Nutzer-/Assistenteneinträge als Ziel. Gültige anwenden, Rest nur melden.
  const gueltig = ziele.filter((z) => zustand.aliase.has(z));
  const unbekannt = ziele.filter((z) => !zustand.aliase.has(z));
  const hinweis = unbekannt.length ? ` Übersprungen (nur Werkzeugergebnisse [#wN] sind bearbeitbar): ${unbekannt.join(', ')}.` : '';
  if (!gueltig.length) return {ok: false, text: `Keine bearbeitbare Kennung.${hinweis}`};
  gueltig.forEach((z, i) => {
    const id = zustand.aliase.get(z);
    zustand.offen.set(id, aktion === 'loeschen' ? {aktion} : i === 0 ? {aktion, text} : {aktion, verweis: `#${gueltig[0]}`});
    zustand.erledigt.delete(id);
  });
  return {ok: true, text: `${aktion === 'loeschen' ? 'Gelöscht' : 'Ersetzt'}: ${gueltig.map((z) => '#' + z).join(', ')}. Wirkt ab dem nächsten Schritt.${hinweis}`};
}

/**
 * Ersetzungsplan für maintain(): aus den sichtbaren Transkript-Einträgen ({entryId, message}) die offenen Edits.
 * Bereits ersetzte Einträge (Text beginnt mit einer Marke) werden nicht erneut geschrieben.
 */
export function ersatzPlan(eintraege, zustand) {
  const plan = [];
  for (const e of eintraege ?? []) {
    const m = e?.message;
    if (m?.role !== 'toolResult') continue;
    const edit = zustand.offen.get(m.toolCallId);
    if (!edit) continue;
    const t = textVon(m.content);
    if (t.startsWith(MARKE_GELOESCHT) || t.startsWith(MARKE_VERDICHTET)) continue;
    plan.push({entryId: e.entryId, message: ersatzNachricht(m, edit), toolCallId: m.toolCallId, zeichenVorher: t.length});
  }
  return plan;
}

/** Nach erfolgreichem Rewrite: angewandte Edits als erledigt führen (Projektion bleibt gleich). */
export function alsErledigt(zustand, plan) {
  for (const p of plan) zustand.erledigt.add(p.toolCallId);
}
