# fyos-kontext-edit (Experiment)

Der Agent löscht oder verdichtet seine eigenen früheren Werkzeugergebnisse, statt nur auf
die Kompaktion durch den Zusammenfasser zu warten. Die Idee stammt aus „Context Language
Models“ (Shao u. a., arXiv 2609.37725): das Modell editiert seinen Kontext selbst. Kein
Code aus dem Paper-Repo, alles hier selbst geschrieben.

**Standard: aus.** Ohne `aktiv: true` und ohne `plugins.slots.contextEngine: "fyos-kontext-edit"`
ändert sich nichts. `fyos.yaml` schaltet beides über `kontext_edit.aktiv`.

| Teil | Aufgabe |
|---|---|
| `kern.mjs` | reine Logik: Kennungen `[#wN]` über `toolCallId`, Edits prüfen und vormerken, Ersetzungsplan, Arm je Sitzung |
| `plugin.mjs` | OpenClaw: Werkzeug `kontext_bearbeiten` (nur im Arm `edit`), Context Engine `fyos-kontext-edit` |
| `index.mjs` | Einstieg, bindet `delegateCompactionToRuntime` und `readVisibleSessionTranscriptMessageEntries` |

- `assemble()` setzt `[#wN]` vor jedes Werkzeugergebnis, wendet offene Edits als Projektion
  an und hängt die Anleitung an den Systemprompt. Im Arm `kontrolle` bleibt der Verlauf unverändert.
- `maintain()` schreibt offene Edits dauerhaft ins Transkript (`runtimeContext.rewriteTranscriptEntries`).
- `compact()` delegiert an die Standardkompaktion (`ownsCompaction: false`).
- Bearbeitbar sind nur Werkzeugergebnisse; Nutzer- und Assistententexte bleiben unangetastet.

## Konfiguration

| Schlüssel | Bedeutung |
|---|---|
| `aktiv` | Hauptschalter (Standard aus) |
| `editAnteil` | Anteil der Sitzungen im Arm `edit` (Standard 0,5), deterministisch nach `sessionKey` |
| `auftragAb` | Anteil am Kontextbudget, ab dem das Harness die Bereinigung verlangt (Standard 0 = der Agent entscheidet selbst) |
| `protokoll` | JSONL-Datei für A/B-Auswertung |
| `budget` | Ersatz-Tokenbudget, falls der Host keines liefert |

Messung bei kleinen lokalen Modellen: von sich aus editieren sie selten (1 von 10 Läufen);
mit `auftragAb: 0.6` verlangt das Harness die Bereinigung (4 von 4).

Tests: `node --test *.test.mjs`
