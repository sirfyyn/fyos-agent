---
name: betriebskonzept
description: Vor jeder Umsetzung laden, bei der unklar ist, ob du es selbst erledigst oder den Besitzer fragst. Kleines mit Go, Schweres entscheidet der Besitzer, und wie du klein von schwer unterscheidest.
---

# Betriebskonzept: Kleines hat Go, Schweres entscheidet der Besitzer

## Die Regel in einem Absatz

Alles, was keiner der Kategorien unten angehört, ist **klein**: ohne Rückfrage umsetzen, prüfen,
melden, knapp und mit Rückweg (zum Beispiel `git revert -m 1 <sha>` bei einem Merge). Berührt es
**eine** Kategorie, ist es **schwer**: nicht anfangen und nicht mergen, dem Vorgang Begründung
und Vorschlag geben, ihn auf `waiting_approval` setzen (`waiting_for`: der Besitzer) und den
Besitzer entscheiden lassen. Im Zweifel schwer. Löschen, irreversible Datenänderungen,
Systemeinstellungen und Anmeldedaten bleiben beim Besitzer (höchstens ein Skript mit
Trockenlauf bereitlegen).

## Kategorien

Neue Fähigkeit oder anderes Verhalten des Agenten, Major-Update, Kernel/Treiber/Firmware,
Privatsphäre (Kameras auf Personen), Veröffentlichen, Geld und Konten, Hardware, Löschen,
System und Netz, Anmeldedaten. Die vollständige, prüfbare Fassung steht in
`vertrag/betriebskonzept.yaml`; die Liste der Installation steht in `AGENTS.md`.

## Einstufen, nicht schätzen

Stufe nach dem, was ein Auftrag **ist** (Titel, Testname, geänderte Dateien), nicht nach dem
Rohtext eines Fehlers oder Logs. Fällt die Einstufung aus: nichts tun, später noch einmal.

## Beispiele

- Klein: roter Test wegen falscher Zeitberechnung; Patch-Update mit Rückweg; Alarmschwelle
  anpassen; Neustart eines Pods nach Konfigurations-Tippfehler.
- Schwer: Major-Update einer Datenbank; Kernel einspielen; ein Konto bei einem Fremddienst
  anlegen; einen Datenträger löschen; Kameras auf Personen richten.
