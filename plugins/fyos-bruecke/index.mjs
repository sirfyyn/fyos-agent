import {definePluginEntry} from 'openclaw/plugin-sdk/plugin-entry';
import {dispatchGatewayMethod} from 'openclaw/plugin-sdk/gateway-method-runtime';
import {getPluginRuntimeGatewayRequestScope} from 'openclaw/plugin-sdk/plugin-runtime';
import {PLUGIN_ID, registerBruecke} from './bruecke.mjs';

export default definePluginEntry({
  id: PLUGIN_ID,
  name: 'FYOS Brücke',
  description: 'Koppelt das Gateway an den FYOS-Hub: Ereignisse ohne Inhalte hin, Abfragen einer festen Methodenliste her',
  register(api) {
    registerBruecke(api, {
      // Nur innerhalb der angemeldeten Route erlaubt (Manifest: contracts.gatewayMethodDispatch).
      dispatch: (methode, params) => dispatchGatewayMethod(methode, params),
      revalidate: () => getPluginRuntimeGatewayRequestScope()?.revalidate?.(),
    });
  },
});
