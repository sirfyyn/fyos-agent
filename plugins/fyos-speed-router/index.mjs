import {definePluginEntry} from 'openclaw/plugin-sdk/plugin-entry';
import {registerSpeedRouter} from './router.mjs';

export default definePluginEntry({
  id: 'fyos-speed-router',
  name: 'FYOS speed router',
  description: 'Short, clearly conversational direct turns use a small fast model without tools; work stays on the main model.',
  register: registerSpeedRouter,
});
