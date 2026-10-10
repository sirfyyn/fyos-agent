import {definePluginEntry} from 'openclaw/plugin-sdk/plugin-entry';
import {registerErsteinrichtung} from './plugin.mjs';

export default definePluginEntry({
  id: 'fyos-ersteinrichtung',
  name: 'FYOS Ersteinrichtung',
  description: 'Werkzeug für die Ersteinrichtung als Gespräch: trägt Anrede, Sprache, Zeitzone und Agentenname in USER.md und IDENTITY.md ein',
  register: registerErsteinrichtung,
});
