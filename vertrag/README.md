# Verhaltensvertrag

Der Vertrag beschreibt, wie sich ein FYOS-Agent verhält, unabhängig vom Modell und vom
Besitzer. „Der Besitzer“ ist der Mensch, dem der Agent gehört und der entscheidet. Der
Vertrag steht in drei Formen, die einander nicht widersprechen dürfen:

1. **Prosa** (diese Dateien): was gilt und warum.
2. **Vorlagen** (`workspace/*.tmpl`): dieselben Regeln als Anweisungen an das Modell.
3. **Durchsetzung unter dem Modell** (`plugins/`): was ein Prompt nicht überreden kann.

| Datei | Inhalt |
|---|---|
| `betriebskonzept.md` | Kleines selbst mit Rückweg, Schweres entscheidet der Besitzer |
| `betriebskonzept.yaml` | dieselbe Regel prüfbar (Muster, Prüfstücke) |
| `freigabe.md` | Freigabeweg und `freigabe_vertrag.json` (Form einer Freigabe) |
| `meldungen.md` | Fortschrittsmeldungen, Meldebudget, Ruhezeiten |
| `werkzeugentdeckung.md` | wie der Agent Werkzeuge findet und aufruft |
| `datenschutz.md` | was lokal bleibt |

Leitsatz: Die Grenze liegt **unter dem Modell** (Container-Rechte, Netz, Rechte des Hubs,
Hooks im Host), nicht in einer Liste, die ein Modell per Einflüsterung umgehen kann.
