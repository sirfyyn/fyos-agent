# Freigabeweg

Eine Freigabe ist die Frage „darf der Agent diese Handlung ausführen?“. Sie hat genau eine
Kennung (den Vorgang) und mehrere Sichten (Chat, Reaktion, Oberfläche), die alle denselben
Gegenstand entscheiden. Die erste gültige Antwort entscheidet; alle Sichten werden danach
aktualisiert.

## Ablauf

1. Der Agent erkennt eine schwere Handlung (siehe `betriebskonzept.md`) und legt am Vorgang
   die Entscheidung an: Begründung, Ziel, Umfang, Beleg, erwartete Wirkung. Der Vorgang geht
   auf `waiting_approval`, `waiting_for` nennt den Besitzer. Der Modellturn endet; die Sitzung
   belegt keinen Modellslot, solange sie wartet.
2. Der Besitzer entscheidet in einer Sicht: Antwort im Chat (`genehmigt`, `abgelehnt`,
   `kommentar …`), Reaktion (✅ ❌ ➕) oder Karte in der Oberfläche.
3. **Der Statuswechsel ist die Freigabe**: `in_progress` heißt genehmigt, `triage` heißt
   abgelehnt (nie `closed`: eine abgelehnte Handlung ist nicht erledigt, es wird eine
   Alternative gesucht). Der Agent führt nach `in_progress` genau den gebundenen Schritt aus
   und dokumentiert das Ergebnis.
4. Fehlt eine eindeutige Entscheidung, bleibt die Frage offen. Der Text ist ein Kommentar.

## Fail-closed

Der gefährliche Ausgang ist die Genehmigung. Deshalb gilt ein Text nur dann als „ja“, wenn der
**ganze** Text eine Zustimmung ist (`ja`, `ok`, `genehmigt PRB-12`). Fragen, Vorbehalte,
Verneinungen („nicht genehmigt“), Widersprüche und zwei Kennungen sind nie eine Genehmigung.
Bei mehreren offenen Freigaben ohne Kennung wird nachgefragt, nie geraten. Ein fehlendes
Besitzer-Merkmal des Absenders (`senderIsOwner`) heißt: nicht handeln.

## Uhren

Keine Uhr macht aus ausbleibender Antwort eine Zustimmung oder Ablehnung. Die aktive
Hervorhebung endet nach 30 Minuten, die Frage selbst steht bis Entscheidung oder Frist
(72 Stunden), die Sitzung wartet ohne Ressourcen.

## Form

`freigabe_vertrag.json` ist die eine Wahrheit über Kennung, Antworten, Zielstatus, Uhren und
Ereignisströme. Dienst und Plugin (`plugins/fyos-freigabe-chat`) lesen dieselbe Datei.
Eine Freigabe ist ein kurzer Entscheidungsbrief (wer, was, wo, warum und Umfang, erwartete
Wirkung); Befehle, Diffs und Logs bleiben als Anhang am Vorgang.
