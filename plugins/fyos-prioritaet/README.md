# fyos-prioritaet

Der Agent meldet mit `fyos_conversation_status` (`completed` oder `input_needed`), dass sein
GANZER Auftrag erledigt ist oder auf eine Antwort wartet. Das Plugin hält diesen Zustand in der
nativen Sitzungserweiterung `pluginExtensions.fyos-prioritaet.conversation` der direkten
Gespräche der konfigurierten Agenten (`agenten`, Vorgabe `main`; Vorgangs- und Cron-Sitzungen
sind ausgenommen).

- Ein Modellturn-Ende allein ist kein Abschluss; weitere Arbeit hebt eine Erklärung auf.
- Eine erfolgreiche Schlussübergabe ohne offene Werkzeuge startet 900 Sekunden Nachlauf;
  danach gibt der Host die reservierte Kapazität frei (`released`). Die Sitzung bleibt erhalten.
- Native Freigabe-Wartezeiten werden über Freigabe- und Werkzeug-ID zugeordnet.
- Ein fehlgeschlagener Lauf bleibt reserviert.
- Lesen: Gateway-Methode `fyos.prioritaet.snapshot` (Scope `operator.read`), Änderungen als
  Ereignis `fyos.prioritaet.changed`.

Das Plugin startet keine Modelle, legt keine Agenten an und kopiert keine Transkripte. Es erteilt
nie eine Zustimmung für zerstörerische Arbeit.

Tests ohne Modell: `node --test *.test.mjs`. Hinweis: Der Host muss beim Herunterfahren den
Sitzungszustand bewahren; die Patches unter `openclaw/patches/` ändern daran nichts, die
gepinnte Upstream-Version erfüllt das (siehe `openclaw/README.md`).
