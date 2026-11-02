import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAYA, mayaBeitrag, mayaRegistrieren } from '../src/persona/maya.js';

test('Maya-S ist beschrieben wie im alten Stand und registriert nur zum Schein', () => {
  assert.equal(MAYA.id, 'fyos-maya');
  assert.equal(MAYA.modelPort, 18425);
  assert.equal(MAYA.modelName, 'deepseek-v4.1-flash');
  assert.equal(MAYA.engineType, 'cli');
  assert.equal(MAYA.maxContext, 262144);
  assert.equal(MAYA.bridgePath, '/tmp/maya_bridge.py');
  assert.deepEqual(mayaRegistrieren(), { status: 'registered', modelPort: 18425 });
});

test('Maya trägt nichts bei', () => {
  assert.deepEqual(mayaBeitrag(), { sections: [], hooks: [], tools: [] });
});
