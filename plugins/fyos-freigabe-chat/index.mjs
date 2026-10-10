import {definePluginEntry} from 'openclaw/plugin-sdk/plugin-entry';
import {registerFreigabeChat} from './hook.mjs';
import {registerFanout} from './fanout.mjs';
import {ReaktionsSpeicher, starte_matrix_reaktionen} from './matrix-reaktionen.mjs';

export default definePluginEntry({
  id: 'fyos-freigabe-chat',
  name: 'FYOS Freigabe im Chat',
  description: 'Die Chat-, Matrix- und Telegram-Antwort des Besitzers entscheidet eine offene Freigabe, ohne Modellaufruf',
  register(api, config) {
    // Ohne Vorgangs-Dienst gibt es nichts zu entscheiden: das Plugin bleibt passiv.
    if (!process.env.FYOS_VORGAENGE_URL) {
      api.logger?.info?.('fyos-freigabe-chat: FYOS_VORGAENGE_URL fehlt, Plugin bleibt passiv');
      return;
    }
    const reaktionsspeicher = new ReaktionsSpeicher({datei: '/home/node/.openclaw/fyos-freigabe-chat/matrix-reaktionen.json'});
    const approverId = process.env.FYOS_APPROVER_MATRIX_ID || '';
    const board = {
      kommentiere: (...args) => import('./board.mjs').then((m) => m.kommentiere(...args)),
      setze_status: (...args) => import('./board.mjs').then((m) => m.setze_status(...args)),
      offene_freigaben: (...args) => import('./board.mjs').then((m) => m.offene_freigaben(...args)),
    };
    const gemeinsam = {...config, reaktionsspeicher, approverId};
    registerFreigabeChat(api, gemeinsam);
    registerFanout(api, gemeinsam);
    api.on('gateway_start', (ctx) => {
      starte_matrix_reaktionen({
        api, speicher: reaktionsspeicher,
        board,
        homeserver: api.config?.channels?.matrix?.homeserver,
        accessToken: process.env.OPENCLAW_MATRIX_TOKEN,
        approver: approverId,
        abortSignal: ctx.abortSignal,
      });
    });
  },
});
