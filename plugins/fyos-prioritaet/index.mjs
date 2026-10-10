import {definePluginEntry} from 'openclaw/plugin-sdk/plugin-entry';
import {registerPriority} from './plugin.mjs';
export default definePluginEntry({id: 'fyos-prioritaet', name: 'FYOS conversation priority',
  description: 'Native durable assignment state and inactivity release', register: registerPriority});
