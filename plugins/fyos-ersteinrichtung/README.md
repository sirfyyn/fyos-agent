# fyos-ersteinrichtung

Die Ersteinrichtung als Gespräch: Beim allerersten Gespräch interviewt der Agent den Besitzer kurz (Anrede,
Sprache, Zeitzone, wofür, Grenzen, Name des Agenten) und trägt die Antworten in USER.md und IDENTITY.md ein.
Danach endet das Ritual und kommt nie wieder.

Das Plugin liefert nur das Werkzeug `fyos_ersteinrichtung`. Das Gespräch selbst steht in `BOOTSTRAP.md`; die
Datei legt der Renderer (`fyos_agent/einrichtung.py`) beim ersten Start in den Workspace, und OpenClaw reicht sie
dem Agenten als offene Ersteinrichtung ins Gespräch. Die Vorlage hat kein Schreibwerkzeug, deshalb ist dieses
Werkzeug der einzige Weg, die Dateien zu füllen.

- Das Werkzeug gibt es nur, solange `BOOTSTRAP.md` im Workspace des Agenten liegt. Danach liefert die Fabrik
  nichts, und ein späterer Aufruf (etwa aus einer Fremdquelle) ändert nichts.
- Pflicht: `anrede`, `sprache`, `zeitzone` (Name aus der IANA-Zeitzonen-Datenbank, geprüft), `agentenname`.
  Freiwillig: `zweck`, `grenzen`. Alle Werte werden zu einer kurzen Zeile bereinigt (keine Umbrüche, keine
  Steuerzeichen), damit keine Überschrift oder Regel in USER.md hineinrutscht.
- USER.md: Titel und Abschnitt `## Steckbrief` werden ersetzt (samt Vermerk „Ersteinrichtung: abgeschlossen am …“),
  übrige Abschnitte bleiben. IDENTITY.md: Titel und `- Name:` wechseln, Creature und Vibe bleiben.
- Die Dateien werden atomar geschrieben, `BOOTSTRAP.md` zuletzt gelöscht. Bricht etwas vorher ab, bleibt die
  Einrichtung offen und der Aufruf lässt sich wiederholen.
- Zusätzliche Grenzen aus der Einrichtung lockern nichts: Die festen Grenzen stehen in AGENTS.md, und diese Datei
  sagt ausdrücklich, dass zusätzliche Grenzen in USER.md nur hinzukommen.
- Ins Log kommt nur „setup finished“, nie eine Angabe des Besitzers. Das Plugin hat keinen Einblick ins Gespräch
  und kein Prompt-Recht (`hooks` beide aus).

Eingeschaltet wird es vom Renderer nur bei offener Einrichtung (`plugins.entries.fyos-ersteinrichtung.enabled`);
mit `faehigkeiten.ersteinrichtung: false` in `fyos.yaml` bleibt es aus. Tests ohne Gateway:
`node --test *.test.mjs`.
