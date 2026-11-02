import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defineExtension } from '@earendil-works/pi-durable';
import { konfigurationLaden } from '../src/config.js';
import { ginnyErweiterung } from '../src/persona/index.js';

test('ginnyErweiterung liefert Abschnitte, Hooks und Werkzeuge und lässt sich in defineExtension stecken', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'persona-index-'));
  const system = join(dir, 'system.md');
  writeFileSync(system, 'Hub: `hub__search_tools`.');
  const cfg = konfigurationLaden({ pi_durable: { systemPrompt: system } }, {});
  const teile = ginnyErweiterung({ cfg, hub: {}, runner: undefined, env: { FYOS_KONTEXT_DIR: join(dir, 'k') } });
  assert.deepEqual(Object.keys(teile).sort(), ['hooks', 'sections', 'tools']);
  assert.deepEqual(teile.sections.map((s) => s.key), ['persona-regelwerk',
    'persona-regelwerk-durable', 'kontextbuch', 'repo_regeln']);
  assert.deepEqual(
    teile.tools.map((t) => t.name).sort(),
    ['bereich', 'persona_bericht', 'kontextbuch_lesen', 'kontextbuch_schreiben', 'matrix_senden', 'unteragent'].sort(),
  );
  assert.equal(teile.hooks.length, 3); // Redaktion, Geheimnis-Wache, Wache
  assert.ok(teile.hooks.every((h) => h.task === 'pi.tool'));
  const ext = defineExtension({ name: 'persona', ...teile });
  assert.equal(ext.name, 'persona');
  const text = await teile.sections[0].render({}, {});
  assert.equal(text, 'Hub: `hub_suchen`.');
});

test('ohne Regelwerk-Datei entfällt der Abschnitt; im Unteragenten gibt es kein unteragent', async () => {
  const cfg = konfigurationLaden({ pi_durable: { systemPrompt: '/gibt/es/nicht.md' } }, {});
  const teile = ginnyErweiterung({ cfg, env: { FYOS_UNTERAGENT: '1' } });
  assert.equal(await teile.sections[0].render({}, {}), undefined);
  assert.equal(teile.tools.some((t) => t.name === 'unteragent'), false);
});
