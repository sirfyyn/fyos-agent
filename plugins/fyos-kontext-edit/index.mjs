import {definePluginEntry} from 'openclaw/plugin-sdk/plugin-entry';
import {delegateCompactionToRuntime} from 'openclaw/plugin-sdk/core';
import {readVisibleSessionTranscriptMessageEntries} from 'openclaw/plugin-sdk/session-transcript-runtime';
import {registerKontextEdit} from './plugin.mjs';

export default definePluginEntry({
  id: 'fyos-kontext-edit',
  name: 'FYOS Kontext-Edit',
  description: 'Versuch: Der Agent löscht oder verdichtet eigene Werkzeugergebnisse (Context Language Models), A/B gegen die Kompaktion.',
  register: (api) => registerKontextEdit(api, {delegateCompactionToRuntime, readVisibleSessionTranscriptMessageEntries}),
});
