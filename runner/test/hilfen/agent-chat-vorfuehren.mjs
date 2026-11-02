/**
 * Startet den Prüfstand (eigener Runner mit Faux-Modell, 127.0.0.1) mit einem festen Drehbuch, damit man den nativen Chat im Browser ansehen kann:
 *   node test/hilfen/agent-chat-vorfuehren.mjs   →   http://127.0.0.1:8777/
 * 1. Nachricht: Datei anlegen, ändern, lesen (Normalpfad ohne Freigabe). 2. Nachricht: zerstörender Befehl → Freigabe-Leiste; danach „Weiter“.
 */
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai';
import { join } from 'node:path';
import { starte } from './agent-chat-pruefstand.js';

const ps = await starte({ port: 8777, tokensProSekunde: 45 });
const datei = join(ps.arbeit, 'notiz.md');
const B = 'git push --force origin main';
ps.faux.setResponses([
  fauxAssistantMessage([fauxThinking('Ich lege die Notiz an, ändere eine Zeile und lese sie zurück.'), fauxText('Ich lege `notiz.md` an und ändere danach eine Zeile:\n\n- Datei schreiben\n- Zeile ersetzen\n- zurücklesen\n'), fauxToolCall('write', { path: datei, content: '# Notiz\nhallo\nwelt\n' })], { stopReason: 'toolUse' }),
  fauxAssistantMessage([fauxToolCall('edit', { path: datei, edits: [{ oldText: 'welt', newText: 'Welt, so gehört sich das' }] })], { stopReason: 'toolUse' }),
  fauxAssistantMessage([fauxToolCall('bash', { command: `cat ${datei}` })], { stopReason: 'toolUse' }),
  fauxAssistantMessage('Fertig. Die Notiz steht, die zweite Zeile ist geändert. **Keine Freigabe nötig**, nichts Zerstörendes.'),
  fauxAssistantMessage([fauxText('Das ist zerstörend, ich versuche es zuerst direkt.'), fauxToolCall('bash', { command: B })], { stopReason: 'toolUse' }),
  fauxAssistantMessage([fauxToolCall('freigabe_bitten', { aktion: 'Force-Push auf main', risiko: 'high', kontext: 'Überschreibt main auf dem Server. Wirkung: die Historie ändert sich. Rückweg: alten Stand per Reflog wiederherstellen.', werkzeug: 'bash', befehl: B })], { stopReason: 'toolUse' }),
  fauxAssistantMessage('Ich warte auf deine Entscheidung.'),
  fauxAssistantMessage([fauxToolCall('bash', { command: B })], { stopReason: 'toolUse' }),
  fauxAssistantMessage('Erledigt (im Prüfstand ohne Repository, der Befehl schlägt dort harmlos fehl).'),
]);
console.log(`Prüfstand: ${ps.basis}/  (Strg+C beendet)`);
process.on('SIGINT', async () => {
  await ps.stopp();
  process.exit(0);
});
