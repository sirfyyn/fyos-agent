/**
 * tools.js — die Werkzeuge, die das Modell wirklich hat.
 *
 * Alles hier ist ein normaler pi-durable-Tool-Aufruf: eigener Task, eigener Checkpoint,
 * eigene Wiederholungsregel. Lesende Hub-Aufrufe sind `replay: "safe"`; schreibende und
 * zerstörende sind es nicht — nach einem Absturz werden sie nicht blind wiederholt.
 */
import { randomUUID } from 'node:crypto';
import { Schema as Type, werkzeug as defineTool } from './lauf/index.js';
import { Freigaben, HubAufgaben, LaufListe, Register, Zustand, neueFreigabe, neueHubAufgabe } from './documents.js';
import { kontextPruefen, kontextZaehler } from './freigabe-kontext.js';
import { Hub } from './hub.js';
import { FREIGABE_SATZ, STIMME_BEZUG } from './stimme.js';
import { tx } from './i18n.js';

const KURZ = (s, n = 240) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

const textErgebnis = (text) => ({ output: [{ type: 'text', text: String(text ?? '') }] });

export function hubWerkzeuge({ cfg, hub = new Hub({ url: cfg.hub, agent: cfg.agent }), zugKontext = null }) {
  const grenze = cfg.pi_durable.limits.maxToolOutput;
  const pflicht = new Set(
    // Besitzer 24.10.2026: nur Destruktives geht durch eine Freigabe. Wer mehr will, trägt es in
    // `security.freigabePflicht` ein.
    (cfg.pi_durable.security.freigabePflicht ?? ['DESTRUCTIVE']).map((s) => String(s).toUpperCase()),
  );

  const suchen = defineTool({
    name: 'hub_suchen',
    description: tx(
      'Sucht Werkzeuge im FYOS-Hub (Cluster, Haus, ITSM, Hauptserver, Wissen, Apps). ' +
        'Immer zuerst suchen, dann hub_schema lesen, dann hub_aufrufen. Leere Suche listet das Verzeichnis.',
      'Searches tools in the FYOS hub (cluster, home, ITSM, servers, knowledge, apps). ' +
        'Always search first, then read hub_schema, then hub_aufrufen. An empty search lists the directory.',
    ),
    parameters: Type.Object({
      suche: Type.String({ description: tx('Suchwörter, z. B. „vorgang anlegen“ oder „cluster knoten“', 'Search words, e.g. “create ticket” or “cluster nodes”') }),
      voll: Type.Optional(Type.Boolean({ description: tx('Beschreibung und Eingabeschema mitliefern (Vorgabe: true)', 'Include description and input schema (default: true)') })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
    }),
    replay: 'safe',
    execute: async ({ suche: q, voll = true, limit = 200 }, _api, context) => {
      const treffer = await hub.suchen(q, { voll, limit, signal: context.signal });
      const schmal = treffer.map((t) => ({
        name: t.name,
        beschreibung: KURZ(t.description ?? t.kurz ?? '', 300),
        pflicht: t.inputSchema?.required ?? t.pflicht ?? [],
        scope: t.scope ?? undefined,
        tags: t.tags ?? undefined,
      }));
      return textErgebnis(JSON.stringify({ anzahl: schmal.length, werkzeuge: schmal }, null, 2));
    },
  });

  const schema = defineTool({
    name: 'hub_schema',
    description: tx('Liest das vollständige Eingabeschema eines Hub-Werkzeugs. Nach hub_suchen, vor hub_aufrufen.', 'Reads the full input schema of a hub tool. After hub_suchen, before hub_aufrufen.'),
    parameters: Type.Object({
      werkzeug: Type.String({ description: tx('Vollständiger Name, z. B. „vorgaenge.zeigen“', 'Full name, e.g. “vorgaenge.zeigen”') }),
    }),
    replay: 'safe',
    execute: async ({ werkzeug }, _api, context) => {
      const s = await hub.schema(werkzeug, { signal: context.signal });
      return textErgebnis(
        JSON.stringify(
          {
            werkzeug: s.name,
            scope: s.scope,
            beschreibung: s.description,
            eingabe: s.inputSchema,
          },
          null,
          2,
        ),
      );
    },
  });

  const aufrufen = defineTool({
    name: 'hub_aufrufen',
    description: tx(
      'Ruft ein Hub-Werkzeug auf. Nur zerstörende Werkzeuge brauchen vorher eine Freigabe ' +
        '(freigabe_bitten) und deren Kennung in freigabe_id. Nie einen Werkzeugnamen raten.',
      'Calls a hub tool. Only destructive tools need an approval first ' +
        '(freigabe_bitten) and its id in freigabe_id. Never guess a tool name.',
    ),
    parameters: Type.Object({
      werkzeug: Type.String({ description: tx('Vollständiger Name aus hub_suchen, z. B. „vorgaenge.zeigen“', 'Full name from hub_suchen, e.g. “vorgaenge.zeigen”') }),
      argumente: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: tx('Argumente passend zum Schema', 'Arguments matching the schema') })),
      ansicht: Type.Optional(
        Type.Union([Type.Literal('kurz'), Type.Literal('voll')], {
          description: tx('kurz (Vorgabe) kürzt große Ergebnisse für das Modell', 'kurz (default) shortens large results for the model; voll returns them in full'),
        }),
      ),
      freigabe_id: Type.Optional(Type.String({ description: tx('Kennung einer erteilten Freigabe', 'Id of a granted approval') })),
      aufgabe: Type.Optional(
        Type.Boolean({
          description: tx(
            'true = lange Werkzeuge (medien_bild, Bauten, Experimente) als Hub-Aufgabe starten: der Aufruf kehrt sofort ' +
              'zurück, du beendest deinen Zug, das Ergebnis kommt später als Eingang „aufgabe“ (Bezug = Kennung) in dieses ' +
              'Gespräch. Werkzeuge ohne Aufgabenfähigkeit laufen normal weiter. Nur setzen, wenn du das Ergebnis nicht jetzt brauchst.',
            'true = start long tools (image generation, builds, experiments) as a hub task: the call returns at once, ' +
              'you end your turn, the result arrives later as inbox item “aufgabe” (reference = id) in this conversation. ' +
              'Tools without task support run normally. Set it only when you do not need the result now.',
          ),
        }),
      ),
    }),
    execute: async ({ werkzeug, argumente = {}, ansicht = 'kurz', freigabe_id, aufgabe = false }, api, context) => {
      const scope = await hub.scope(werkzeug, { signal: context.signal });
      const brauchtFreigabe = pflicht.has(scope);
      let freigabe = null;
      if (brauchtFreigabe) {
        if (!freigabe_id) {
          throw new Error(
            tx(
              `„${werkzeug}“ hat den Wirkungsgrad ${scope}. Vor dem Aufruf freigabe_bitten(aktion, risiko, kontext, werkzeug) ` +
                'aufrufen und die Kennung als freigabe_id mitgeben.',
              `“${werkzeug}” has the scope ${scope}. Before the call, run freigabe_bitten(aktion, risiko, kontext, werkzeug) ` +
                'and pass its id as freigabe_id.',
            ) +
              (zugKontext?.istStimme(api.conversationId)
                ? tx(` Per Sprache: danach nur den einen Satz „${FREIGABE_SATZ}“ sagen.`, ` By voice: then say only the one sentence “${FREIGABE_SATZ}”.`)
                : ''),
          );
        }
        const liste = await api.snapshot(Freigaben, context);
        const f = liste?.eintraege?.[freigabe_id];
        if (!f) throw new Error(tx(`Freigabe ${freigabe_id} ist unbekannt.`, `Approval ${freigabe_id} is unknown.`));
        if (f.status !== 'erteilt') throw new Error(tx(`Freigabe ${freigabe_id} ist ${f.status}, nicht erteilt.`, `Approval ${freigabe_id} is ${f.status}, not granted.`));
        if (f.conversationId !== api.conversationId) {
          throw new Error(tx(`Freigabe ${freigabe_id} gehört zu einem anderen Gespräch.`, `Approval ${freigabe_id} belongs to another conversation.`));
        }
        if (f.werkzeug && f.werkzeug !== werkzeug) {
          throw new Error(tx(`Freigabe ${freigabe_id} gilt für „${f.werkzeug}“, nicht für „${werkzeug}“.`, `Approval ${freigabe_id} applies to “${f.werkzeug}”, not to “${werkzeug}”.`));
        }
        if (f.verbraucht) throw new Error(tx(`Freigabe ${freigabe_id} wurde bereits verbraucht.`, `Approval ${freigabe_id} has already been used.`));
        if (Date.now() - Number(f.entschieden ?? 0) > 60 * 60 * 1000) {
          throw new Error(tx(`Freigabe ${freigabe_id} ist älter als eine Stunde. Bitte neu bitten.`, `Approval ${freigabe_id} is older than one hour. Please ask again.`));
        }
        freigabe = f;
      }

      const antwort = await hub.aufrufen(werkzeug, argumente, {
        ansicht,
        signal: context.signal,
        timeoutMs: aufgabe ? 30_000 : 120_000,
        aufgabe,
      });

      if (freigabe) {
        await api.commit(async (tx) => {
          const doc = await tx.doc(Freigaben);
          const e = doc.eintraege[freigabe.id];
          if (e) {
            e.verbraucht = true;
            e.verbrauchtAm = Date.now();
          }
        }, context);
      }

      if (!antwort.ok) {
        throw new Error(tx(`Hub-Werkzeug „${werkzeug}“ meldet: ${antwort.fehler}`, `Hub tool “${werkzeug}” reports: ${antwort.fehler}`));
      }
      if (antwort.aufgabe) {
        // Der Hub hat eine Aufgabe angelegt: dauerhaft vermerken, der Wächter (aufgaben.js) stellt das Ergebnis zu.
        const t = antwort.aufgabe;
        await api.commit(async (tx) => {
          const doc = await tx.doc(HubAufgaben);
          doc.eintraege[t.taskId] = neueHubAufgabe({
            taskId: t.taskId,
            werkzeug,
            conversationId: api.conversationId,
            status: t.status,
            ttlMs: t.ttlMs,
            pollIntervalMs: t.pollIntervalMs,
          });
          await tx.appendEntry(api.conversationId, {
            kind: 'fyos.aufgabe-gestartet',
            data: { taskId: t.taskId, werkzeug, status: t.status },
          });
        }, context);
        return {
          output: [
            {
              type: 'text',
              text: tx(
                `Hub-Aufgabe ${t.taskId} läuft („${werkzeug}“). Das Ergebnis kommt später als Eingang „aufgabe“ (Bezug ${t.taskId}) ` +
                  'in dieses Gespräch. Beende deinen Zug jetzt, statt zu warten; den Stand liest hub_aufgabe.',
                `Hub task ${t.taskId} is running (“${werkzeug}”). The result arrives later as inbox item “aufgabe” (reference ${t.taskId}) ` +
                  'in this conversation. End your turn now instead of waiting; hub_aufgabe reads the status.',
              ),
            },
          ],
          details: { werkzeug, scope, freigabe: freigabe?.id ?? null, aufgabe: t.taskId },
        };
      }
      const text = Hub.alsText(antwort.result, grenze);
      return {
        output: [{ type: 'text', text: text || tx('(leeres Ergebnis)', '(empty result)') }],
        details: { werkzeug, scope, freigabe: freigabe?.id ?? null },
      };
    },
  });

  const aufgabeWerkzeug = defineTool({
    name: 'hub_aufgabe',
    description: tx(
      'Hub-Aufgaben (mit hub_aufrufen aufgabe=true gestartet): „stand“ liest den Zustand einer Aufgabe, „abbrechen“ bricht sie ab ' +
        '(kooperativ: das Werkzeug kann zu Ende laufen), „antworten“ reicht verlangte Eingaben nach (Zustand input_required), ' +
        '„liste“ zeigt die Aufgaben dieses Geräts. Das fertige Ergebnis kommt von selbst als Eingang „aufgabe“.',
      'Hub tasks (started with hub_aufrufen aufgabe=true): “stand” reads the status of a task, “abbrechen” cancels it ' +
        '(cooperative: the tool may run to its end), “antworten” supplies requested input (status input_required), ' +
        '“liste” lists the tasks of this device. The finished result arrives by itself as inbox item “aufgabe”.',
    ),
    parameters: Type.Object({
      aktion: Type.Union([Type.Literal('stand'), Type.Literal('abbrechen'), Type.Literal('antworten'), Type.Literal('liste')]),
      taskId: Type.Optional(Type.String({ description: tx('Kennung der Aufgabe (nicht bei „liste“)', 'Id of the task (not for “liste”)') })),
      antworten: Type.Optional(
        Type.Record(Type.String(), Type.Any(), {
          description: tx('Nur „antworten“: {schluessel: {action: "accept"|"decline"|"cancel", content: {...}}}', 'Only “antworten”: {key: {action: "accept"|"decline"|"cancel", content: {...}}}'),
        }),
      ),
    }),
    replay: 'safe',
    execute: async ({ aktion, taskId, antworten }, api, context) => {
      if (aktion === 'liste') {
        const doc = (await api.snapshot(HubAufgaben, context)) ?? { eintraege: {} };
        const liste = Object.values(doc.eintraege ?? {}).map((e) => ({
          taskId: e.taskId,
          werkzeug: e.werkzeug,
          status: e.status,
          zugestellt: e.zugestellt,
          gespraech: e.conversationId,
          fehler: e.fehler || undefined,
        }));
        return textErgebnis(JSON.stringify({ anzahl: liste.length, aufgaben: liste }, null, 2));
      }
      if (!taskId) throw new Error(tx(`hub_aufgabe ${aktion} braucht taskId.`, `hub_aufgabe ${aktion} needs taskId.`));
      if (aktion === 'stand') {
        const a = await hub.aufgabeStand(taskId, { signal: context.signal });
        return textErgebnis(Hub.alsText(a, grenze));
      }
      if (aktion === 'abbrechen') {
        await hub.aufgabeAbbrechen(taskId, { signal: context.signal });
        return textErgebnis(tx(`Abbruch für ${taskId} gemeldet (kooperativ: das Werkzeug kann zu Ende laufen).`, `Cancellation of ${taskId} reported (cooperative: the tool may run to its end).`));
      }
      if (!antworten || typeof antworten !== 'object') throw new Error(tx('hub_aufgabe antworten braucht „antworten“.', 'hub_aufgabe antworten needs “antworten”.'));
      await hub.aufgabeAntworten(taskId, antworten, { signal: context.signal });
      return textErgebnis(tx(`Antwort für ${taskId} übergeben. Das Ergebnis kommt als Eingang „aufgabe“.`, `Answer for ${taskId} handed over. The result arrives as inbox item “aufgabe”.`));
    },
  });

  const freigabeBitten = defineTool({
    name: 'freigabe_bitten',
    description: tx(
      'Bittet einen Menschen um Freigabe für eine Aktion. Blockiert nicht: die Anfrage erscheint im Client, ' +
        'die Antwort kommt als neue Nachricht in dieses Gespräch. Nur für Zerstörendes (Löschen, Überschreiben, nicht Rückholbares).',
      'Asks a human to approve an action. Does not block: the request appears in the client, ' +
        'the answer arrives as a new message in this conversation. Only for destructive actions (deleting, overwriting, anything irreversible).',
    ),
    parameters: Type.Object({
      aktion: Type.String({ description: tx('Was getan werden soll, kurz und konkret (≤ 200 Zeichen)', 'What should be done, short and concrete (≤ 200 characters)') }),
      risiko: Type.Optional(
        Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')], { description: tx('Vorgabe: medium', 'Default: medium') }),
      ),
      // Im Schema bewusst nicht „erforderlich“: Ein vom Harness abgewiesener Aufruf ließe die Freigabe still ausfallen. Fehlt das Feld,
      // erzeugt der Runner den Rückfalltext und zählt die Abweichung (freigabe-kontext.js).
      kontext: Type.Optional(Type.String({
        description: tx(
          'PFLICHT: Kurzkontext von 3 bis 5 Sätzen auf Deutsch (höchstens 600 Zeichen), den ein Mensch in 10 Sekunden versteht: ' +
            '1. Was soll geschehen und wo? 2. Warum jetzt, für welchen Auftrag oder Vorgang? 3. Wirkung. 4. Risiko. 5. Rückweg: wie macht man es rückgängig? ' +
            'Keine Zugangsdaten und nicht den rohen Befehl (der steht im Feld befehl).',
          'REQUIRED: short context of 3 to 5 sentences in English (at most 600 characters) that a human understands in 10 seconds: ' +
            '1. What should happen and where? 2. Why now, for which task or ticket? 3. Effect. 4. Risk. 5. Way back: how is it undone? ' +
            'No credentials and not the raw command (that goes into the field befehl).',
        ),
      })),
      werkzeug: Type.Optional(Type.String({ description: tx('Hub-Werkzeug, für das die Freigabe gilt', 'Hub tool the approval applies to') })),
      zerstoererisch: Type.Optional(Type.Boolean()),
      befehl: Type.Optional(
        Type.String({ description: tx('Bei werkzeug "bash": genau der Befehl, der freigegeben werden soll. Nach der Zustimmung läuft derselbe Befehl durch.', 'With werkzeug "bash": exactly the command to approve. After approval the same command runs.') }),
      ),
    }),
    replay: 'safe',
    execute: async ({ aktion, risiko = 'medium', kontext = '', werkzeug, zerstoererisch = false, befehl }, api, context) => {
      const id = await api.memo('freigabe_id', `fr-${randomUUID().slice(0, 12)}`, context);
      // Antwortet dieser Zug auf einen Sprachsatz? Dann vermerkt die Freigabe den Bezug, und Persona sagt genau einen Satz.
      const stimme = Boolean(zugKontext?.istStimme(api.conversationId));
      // Entscheidung 586: jede Freigabe trägt 3–5 Sätze Kontext. Vom Modell, sonst deterministischer Rückfall; nie leer.
      const reg = await Promise.resolve(api.snapshot(Register, context)).catch(() => null);
      const meta = (reg?.agents ?? []).find((a) => a.id === api.conversationId) ?? null;
      const geprueft = kontextPruefen(kontext, {
        aktion,
        risiko,
        zerstoererisch: zerstoererisch || risiko === 'high',
        werkzeug,
        befehl,
        titel: meta?.titel && meta.titel !== 'Neuer Agent' ? meta.titel : '',
        quelle: meta?.art && meta.art !== 'mensch' ? meta.art : '',
      });
      let neu = false;
      await api.commit(async (tx) => {
        const doc = await tx.doc(Freigaben);
        if (!doc.eintraege[id]) {
          doc.eintraege[id] = neueFreigabe({
            id,
            conversationId: api.conversationId,
            taskId: api.taskId,
            aktion,
            risiko,
            kontext: geprueft.text,
            kontextHerkunft: geprueft.herkunft,
            zerstoererisch: zerstoererisch || risiko === 'high',
            befehl,
            werkzeug,
            bezug: stimme ? STIMME_BEZUG : null,
          });
          neu = true;
          await tx.appendEntry(api.conversationId, {
            kind: 'fyos.freigabe',
            data: { id, aktion, risiko, kontext: geprueft.text, werkzeug: werkzeug ?? null, status: 'offen' },
          });
        }
      }, context);
      const ansage = stimme
        ? tx(
          ` Das kam per Sprache: Entscheiden kann nur Besitzer in der App, kein Sprachsatz. Sag jetzt nur diesen einen Satz: „${FREIGABE_SATZ}“`,
          ` This came by voice: only your owner can decide, in the app, not by a spoken sentence. Now say only this one sentence: “${FREIGABE_SATZ}”`,
        )
        : '';
      if (neu) kontextZaehler.zaehlen(geprueft);
      return textErgebnis(
        neu
          ? tx(`Freigabe ${id} liegt bereit. Ich warte auf die Entscheidung; danach geht es hier weiter.`, `Approval ${id} is pending. Waiting for the decision; work continues here afterwards.`) + ansage
          : tx(`Freigabe ${id} bestand bereits.`, `Approval ${id} already existed.`) + ansage,
      );
    },
  });

  return [suchen, schema, aufrufen, aufgabeWerkzeug, freigabeBitten];
}

export function zustandWerkzeuge({ cfg }) {
  const lesen = defineTool({
    name: 'zustand_lesen',
    description: tx(
      'Liest den geteilten Anwendungszustand dieses Geräts (ein JSON-Objekt für alle Agenten). ' +
        'Ohne Schlüssel kommt alles; mit Schlüssel nur dieser Eintrag.',
      'Reads the shared application state of this device (one JSON object for all agents). ' +
        'Without a key you get everything; with a key only that entry.',
    ),
    parameters: Type.Object({
      schluessel: Type.Optional(Type.String({ description: tx('Ein Schlüssel, z. B. „letzter_build“', 'A key, e.g. “last_build”') })),
    }),
    replay: 'safe',
    execute: async ({ schluessel }, api, context) => {
      const doc = (await api.snapshot(Zustand, context)) ?? { werte: {} };
      if (schluessel) {
        return textErgebnis(
          JSON.stringify(
            { schluessel, wert: doc.werte?.[schluessel] ?? null, geaendert: doc.geaendert ?? null },
            null,
            2,
          ),
        );
      }
      return textErgebnis(JSON.stringify(doc, null, 2));
    },
  });

  const schreiben = defineTool({
    name: 'zustand_schreiben',
    description: tx(
      'Setzt einen Wert im geteilten Anwendungszustand. `null` löscht den Schlüssel. ' +
        'Der Zustand ist dauerhaft und für alle Agenten dieses Geräts sichtbar.',
      'Sets a value in the shared application state. `null` deletes the key. ' +
        'The state is durable and visible to all agents of this device.',
    ),
    parameters: Type.Object({
      schluessel: Type.String({ description: '^[a-zA-Z0-9_.-]{1,80}$' }),
      wert: Type.Any({ description: tx('JSON-Wert; null löscht', 'JSON value; null deletes') }),
    }),
    replay: 'safe',
    execute: async ({ schluessel, wert }, api, context) => {
      if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(schluessel)) {
        throw new Error(tx('Schlüssel: 1–80 Zeichen aus a–z, A–Z, 0–9, _ . -', 'Key: 1–80 characters from a–z, A–Z, 0–9, _ . -'));
      }
      let anzahl = 0;
      await api.commit(async (tx) => {
        const doc = await tx.doc(Zustand);
        if (wert === null) delete doc.werte[schluessel];
        else doc.werte[schluessel] = wert;
        doc.geaendert = Date.now();
        doc.von = api.conversationId;
        anzahl = Object.keys(doc.werte).length;
      }, context);
      return textErgebnis(
        wert === null
          ? tx(`„${schluessel}“ gelöscht. ${anzahl} Schlüssel im Zustand.`, `“${schluessel}” deleted. ${anzahl} keys in the state.`)
          : tx(`„${schluessel}“ gesetzt. ${anzahl} Schlüssel im Zustand.`, `“${schluessel}” set. ${anzahl} keys in the state.`),
      );
    },
  });

  return [lesen, schreiben];
}

/** Wird von tools/index.js mit der Aufgaben-Definition verbunden. */
export function aufgabenWerkzeuge({ cfg, Lauf, laufAnlegen }) {
  const starten = defineTool({
    name: 'aufgabe_starten',
    description: tx(
      'Startet einen dauerhaften Lauf mit eigenen Phasen (start → arbeiten → freigabe? → abschluss). ' +
        'Der Lauf bekommt ein eigenes Kindgespräch, überlebt Abstürze und kann an einer Freigabe warten. ' +
        'Für lange, mehrstufige Arbeit — nicht für eine einzelne Antwort.',
      'Starts a durable run with its own phases (start → work → approval? → finish). ' +
        'The run gets its own child conversation, survives crashes and can wait for an approval. ' +
        'For long, multi-step work — not for a single answer.',
    ),
    parameters: Type.Object({
      titel: Type.String({ description: tx('Kurzer Titel (≤ 120 Zeichen)', 'Short title (≤ 120 characters)') }),
      auftrag: Type.String({ description: tx('Der vollständige Auftrag an das Kindgespräch', 'The complete task for the child conversation') }),
      arbeitsbereich: Type.Optional(Type.String({ description: tx('Name aus der Arbeitsbereichsliste', 'Name from the workspace list') })),
      freigabe: Type.Optional(Type.Boolean({ description: tx('Vor dem Abschluss auf menschliche Freigabe warten', 'Wait for human approval before finishing') })),
      modell: Type.Optional(Type.String({ description: tx('Modellkennung, z. B. hausmodell-max', 'Model id, e.g. hausmodell-max') })),
    }),
    execute: async ({ titel, auftrag, arbeitsbereich = 'standard', freigabe = false, modell }, api, context) => {
      const raum = cfg.arbeitsbereiche[arbeitsbereich];
      if (!raum) {
        throw new Error(
          tx(`Arbeitsbereich „${arbeitsbereich}“ ist unbekannt. Bekannt: `, `Workspace “${arbeitsbereich}” is unknown. Known: `) + Object.keys(cfg.arbeitsbereiche).join(', '),
        );
      }
      const id = await api.commit(
        (tx) =>
          laufAnlegen(tx, Lauf, {
            titel,
            auftrag,
            arbeitsbereich,
            cwd: raum.pfad,
            freigabe,
            modell,
            quelle: 'agent',
            elternId: api.conversationId,
          }),
        context,
      );
      return textErgebnis(tx(`Lauf ${id} angelegt (Titel: ${titel}). Der Fortschritt steht im Aufgaben-Register.`, `Run ${id} created (title: ${titel}). Progress is in the task register.`));
    },
  });

  const liste = defineTool({
    name: 'aufgaben_liste',
    description: tx('Listet die dauerhaften Läufe dieses Geräts mit Phase und Status.', 'Lists the durable runs of this device with phase and status.'),
    parameters: Type.Object({}),
    replay: 'safe',
    execute: async (_args, api, context) => {
      const doc = (await api.snapshot(LaufListe, context)) ?? { eintraege: {} };
      const eintraege = Object.values(doc.eintraege ?? {}).map((e) => ({
        id: e.id,
        titel: e.titel,
        phase: e.phase,
        status: e.status,
        gespraech: e.kindId ?? null,
        freigabe: e.freigabeId ?? null,
      }));
      return textErgebnis(JSON.stringify({ anzahl: eintraege.length, laeufe: eintraege }, null, 2));
    },
  });

  return [starten, liste];
}
