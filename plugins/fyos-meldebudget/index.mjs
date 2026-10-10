import {definePluginEntry} from 'openclaw/plugin-sdk/plugin-entry';
import {PLUGIN_ID, registerMeldebudget} from './budget.mjs';

export default definePluginEntry({
  id: PLUGIN_ID,
  name: 'FYOS Meldebudget',
  description: 'Hoechstens N proaktive Meldungen pro Tag und Ruhezeiten, durchgesetzt vor dem Senden.',
  register: registerMeldebudget,
});
