# Datenschutz

- Passwörter, Schlüssel, Tokens, Finanz- und Gesundheitsdaten **bleiben lokal**: sie gehen
  nicht an externe Modelle, nicht in Vorgänge, Logs, Remote-URLs oder Chat.
- Externe Modelle und Dienste erhalten nur ausdrücklich öffentliche, bereinigte Inhalte.
- Zugangsdaten, die der Agent als Transport erhält (zum Beispiel für Git), sind kein
  Freifahrtschein: Werte nie ausgeben, keine anderen Zugangsdaten suchen. Ein schreibender
  Schritt (Push, Merge, Tag) erst nach der Freigabe des jeweiligen Vorgangs.
- Gespeichert werden Zähler und Zustände, nicht Gesprächsinhalte: das Meldebudget schreibt keine
  Inhalte, die Prioritäts-Erweiterung weder Transkript noch Modelltext, Protokolle zeigen
  nur stabile Fehlercodes.
- Anwesenheit, Kameras und Standort: nur anonym und nur soweit der Besitzer es freigegeben hat;
  Kameras auf Personen sind eine schwere Entscheidung (`betriebskonzept.md`).
- Telemetrie ist aus, das Basisbild aktualisiert sich nicht selbst; Ausrollen ist eine
  bewusste Entscheidung.
- Secrets stehen in der Umgebung (`${VARIABLE}` in der Konfiguration), nie in `fyos.yaml`
  und nie im Repo; `tools/sauber.py` prüft das vor jedem Commit.
