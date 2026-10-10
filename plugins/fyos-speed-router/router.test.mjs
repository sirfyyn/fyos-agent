import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyReflexTurn} from './router.mjs';

const opt = {enabled: true, targetModel: 'klein/schnell'};
const direkt = {sessionKey: 'agent:main:main', agentId: 'main'};

test('ohne Zielmodell ist der Router aus', () => {
  const r = classifyReflexTurn({...direkt, prompt: 'Hallo!'}, {enabled: true});
  assert.equal(r.route, 'main');
});

test('kurzer Gruss in der Direktsitzung geht auf die Reflexbahn', () => {
  const r = classifyReflexTurn({...direkt, prompt: 'Hallo, wie geht es dir?'}, opt);
  assert.deepEqual(r, {route: 'reflex', model: 'klein/schnell', reason: 'short-direct-conversation'});
});

test('Operatives, Anhaenge und lange Texte bleiben auf dem Hauptmodell', () => {
  assert.equal(classifyReflexTurn({...direkt, prompt: 'Wie ist der Status von CHG-12?'}, opt).route, 'main');
  assert.equal(classifyReflexTurn({...direkt, prompt: 'Was ist das?', attachments: [{}]}, opt).route, 'main');
  assert.equal(classifyReflexTurn({...direkt, prompt: `Was ${'x'.repeat(300)}`}, opt).route, 'main');
  assert.equal(classifyReflexTurn({...direkt, prompt: 'ja'}, opt).route, 'main');
});

test('Vorgangs-, Cron- und fremde Agenten-Sitzungen werden nie umgeleitet', () => {
  for (const sessionKey of ['agent:main:vorgang-chg-1', 'agent:main:cron:x', 'agent:andere:main']) {
    assert.equal(classifyReflexTurn({sessionKey, agentId: 'main', prompt: 'Hallo'}, opt).route, 'main', sessionKey);
  }
  assert.equal(classifyReflexTurn({sessionKey: 'agent:main:main', agentId: 'andere', prompt: 'Hallo'}, opt).route, 'main');
});
