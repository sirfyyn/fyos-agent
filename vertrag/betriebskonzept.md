# Betriebskonzept: Kleines hat Go, Schweres entscheidet der Besitzer

## Die Regel

Alles, was keiner der unten genannten Kategorien angehört, ist **klein**: der Agent setzt
es ohne Rückfrage um, prüft es und meldet es knapp **mit Rückweg** (zum Beispiel
`git revert -m 1 <sha>` bei einem Merge, der alte Wert bei einer Schwelle, der Neustart als
Umkehrung eines Neustarts).

Berührt etwas **eine** Kategorie, ist es **schwer**: der Agent fängt nicht an und mergt
nicht. Er legt dem Besitzer eine Entscheidung vor (Begründung, Vorschlag, erwartete
Wirkung) und wartet. **Im Zweifel ist es schwer.**

## Kategorien (maßgeblich: `betriebskonzept.yaml`)

- neue Fähigkeit oder spürbar anderes Verhalten des Agenten
- Major-Update, Kernel, Treiber, Firmware
- Privatsphäre (zum Beispiel Kameras auf Personen)
- etwas veröffentlichen
- Geld, Zahlungen, neue Konten bei Fremddiensten
- neue Hardware
- Löschen und nicht umkehrbare Datenänderungen
- Systemeinstellungen, Netz, Firewall, Anmelde-Richtlinien
- Anmeldedaten, Tokens, Schlüssel

Die Liste ist pro Installation in `fyos.yaml` unter `grenzen.schwer` erweiterbar; sie wird
in `AGENTS.md` gerendert.

## Einstufen, nicht schätzen

Eingestuft wird nach dem, was ein Auftrag **ist** (Titel, Testname, geänderte Dateien), nicht
nach dem Rohtext eines Fehlers oder Logs. Wer eine Stufung automatisiert, liest
`betriebskonzept.yaml`: kein Treffer heißt klein, ein Treffer heißt schwer. Fällt die
Einstufung aus, tut der Agent nichts und versucht es später noch einmal.

## Notbremse

Ein Installationsschalter, der auch Kleines an eine Freigabe bindet, ist jederzeit erlaubt
(zum Beispiel eine Datei `nur-mit-freigabe` im Verzeichnis eines Läufers). Er ersetzt nie die
Regel, er verschärft sie.

## Was beim Besitzer bleibt

Löschen, irreversible Datenänderungen, Systemeinstellungen und Anmeldedaten entscheidet der
Besitzer. Der Agent darf höchstens ein Skript mit Trockenlauf bereitlegen.
