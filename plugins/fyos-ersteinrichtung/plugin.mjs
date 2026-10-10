import { TOOL, offen, schliesse_ab } from './einrichtung.mjs';

export { TOOL };

const BESCHREIBUNG = [
  'Finish the first-run setup conversation (BOOTSTRAP.md). Call it exactly once, after the owner has answered the',
  'setup questions or declined them (then pass the proposed defaults). It writes the owner\'s form of address,',
  'language, time zone, purpose, extra limits and the agent\'s name into USER.md and IDENTITY.md and ends the setup,',
  'which never repeats. Do not write those files yourself. It changes no permissions and never loosens the',
  'standing limits.',
].join(' ');

const PARAMETER = {
  type: 'object',
  properties: {
    anrede: {type: 'string', description: 'How the owner wants to be addressed (name or form of address), as the owner said it.'},
    sprache: {type: 'string', description: 'Language of the conversation, e.g. Deutsch or English.'},
    zeitzone: {type: 'string', description: 'IANA time zone name, e.g. Europe/Berlin. Convert a city or common name to it.'},
    agentenname: {type: 'string', description: 'The name the owner chose for the agent.'},
    zweck: {type: 'string', description: 'What the agent is mainly for, in the owner\'s words. Omit if not given.'},
    grenzen: {type: 'string', description: 'Extra limits the owner set, in the owner\'s words. Omit if none. They only add to the standing limits.'},
  },
  required: ['anrede', 'sprache', 'zeitzone', 'agentenname'],
  additionalProperties: false,
};

export function registerErsteinrichtung(api, dependencies = {}) {
  // Das Werkzeug gibt es nur, solange BOOTSTRAP.md im Workspace des Agenten liegt; danach liefert die Fabrik nichts.
  api.registerTool((ctx) => offen(ctx?.workspaceDir) ? {
    name: TOOL,
    label: 'First-run setup',
    // Nicht hinter tool_search verstecken: der Agent soll es nach dem Gespräch direkt aufrufen können.
    catalogMode: 'direct-only',
    description: BESCHREIBUNG,
    parameters: PARAMETER,
    async execute(_toolCallId, params) {
      // `jetzt` setzen nur die Tests; sonst gilt die aktuelle Zeit.
      const jetzt = dependencies?.jetzt instanceof Date ? dependencies.jetzt : undefined;
      const ergebnis = await schliesse_ab(ctx.workspaceDir, params, {jetzt});
      if (!ergebnis.erledigt) {
        return {content: [{type: 'text', text: 'The first-run setup was already finished; nothing changed. Do not ask the setup questions again.'}]};
      }
      // Keine Angaben des Besitzers ins Log: nur, dass die Einrichtung abgeschlossen ist.
      api.logger?.info?.('fyos-ersteinrichtung: setup finished');
      return {content: [{type: 'text', text: 'Setup recorded: USER.md and IDENTITY.md are updated and the first-run setup is finished. '
        + 'Confirm in one short sentence, in the owner\'s language, what you noted (form of address, language, time zone, your name). '
        + 'Never ask the setup questions again.'}]};
    },
  } : null, {name: TOOL});
}
