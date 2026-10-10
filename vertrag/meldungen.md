# Meldungen: Fortschritt, Budget, Ruhezeiten

## Fortschrittsmeldungen

Bei mehrstufiger Arbeit sagt der Agent vorab in einem Satz, was er prüft oder umsetzt, und
nach jedem Werkzeugblock knapp: erledigt, Befund, nächster Schritt. Keine leeren
Statusnachrichten. Ein Fehler nach erfolgreichem Werkzeuglauf wird offen benannt, ohne einen
Abschluss zu behaupten und ohne eine ausgeführte Wirkung blind zu wiederholen.

Abschluss: Der Agent erklärt mit `fyos_conversation_status` (`completed` oder
`input_needed`) erst nach dem gesamten Auftrag, dass er fertig ist oder auf eine Antwort wartet,
und liefert danach das Ergebnis oder die Frage. Werkzeugpausen und Modellturns schließen keinen
Auftrag; neue Arbeit hebt einen Abschluss auf. Nach der Schlussübergabe läuft ein Nachlauf von
15 Minuten, bevor reservierte Kapazität freigegeben wird (`plugins/fyos-prioritaet`).

## Meldebudget

Proaktive Meldungen (der Agent meldet sich von selbst) sind knapp, selten und begründet. Der
Host setzt das durch, nicht der Prompt (`plugins/fyos-meldebudget`, Hook `message_sending`):

- höchstens `tagesbudget` proaktive Meldungen pro Tag (Vorgabe 5),
- Ruhezeit `ruhe_von` bis `ruhe_bis` (Vorgabe 22:00 bis 07:00 in `zeitzone`),
- Antworten auf Nachrichten des Besitzers zählen nicht und sind jederzeit erlaubt,
- Meldungen derselben Sitzung innerhalb von `buendelMinuten` zählen als eine,
- Vorgangs-, Zeitplan-, Heartbeat- und Subagent-Sitzungen sind nie Antworten,
- fail-closed: scheitert die Entscheidung bei einer proaktiven Sendung, wird sie gesperrt.

Gespeichert werden nur Zähler und Entscheidungen, nie Inhalte.

**Dringendes** darf Ruhezeit und Budget durchbrechen, aber nur über eine Freigabe, die ein
Wächter ohne Modell schreibt (`dringend.json`); ein Prompt kann sie nicht erzeugen.

## Heartbeat

Kein Zeitimpuls erfindet Arbeit: Der Standard-Heartbeat ist aus. Reaktionen auf Ereignisse
sind erlaubt, Abgleichläufe nur gegen bekannte Arbeit.
