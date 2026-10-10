import test from 'node:test';
import assert from 'node:assert/strict';
import {transition, reservation, GRACE_MS} from './state.mjs';

const identity = {sessionId: 'session', runId: 'run-1', lifecycleRevision: 'lifecycle-1'};
const event = (type, extra = {}) => ({type, identity, ...extra});
const begin = () => transition(undefined, event('begin'), 1000);

test('an ordinary completed model turn does not complete the assignment', () => {
  const state = begin();
  assert.equal(transition(state, event('settled', {success: true}), 10000), state);
  assert.equal(reservation(state, 10000000).held, true);
});

for (const outcome of ['completed', 'input_needed']) {
  test(`${outcome} starts grace only at successful handover`, () => {
    const intent = transition(begin(), event('intent', {outcome}), 2000);
    assert.equal(intent.releaseAtMs, null);
    const settled = transition(intent, event('settled', {success: true}), 10000);
    assert.equal(settled.releaseAtMs, 10000 + GRACE_MS);
    assert.equal(transition(settled, event('settled', {success: true}), 20000), settled);
    assert.equal(transition(settled, event('expire'), settled.releaseAtMs - 1), settled);
    const released = transition(settled, event('expire'), settled.releaseAtMs);
    assert.equal(reservation(released, settled.releaseAtMs).held, false);
    assert.equal(released.sessionId, 'session');
  });
}

test('further tool work invalidates a premature completion intent', () => {
  const intent = transition(begin(), event('intent', {outcome: 'completed'}), 2000);
  const work = transition(intent, event('work'), 3000);
  assert.equal(transition(work, event('settled', {success: true}), 4000).releaseAtMs, null);
});

test('late old-run completion and expiry cannot release resumed work', () => {
  const settled = transition(transition(begin(), event('intent', {outcome: 'input_needed'}), 2000),
    event('settled', {success: true}), 3000);
  const next = transition(settled, {type: 'begin', identity: {...identity, runId: 'run-2'}}, 4000);
  assert.equal(transition(next, event('expire', {expectedRevision: settled.revision}), 1000000), next);
  assert.equal(transition(next, event('settled', {success: true}), 1000000), next);
});

test('same-run resumption invalidates an earlier timer revision', () => {
  const settled = transition(transition(begin(), event('intent', {outcome: 'input_needed'}), 2000),
    event('settled', {success: true}), 3000);
  const resumed = transition(settled, event('work'), 4000);
  assert.equal(transition(resumed, event('expire', {expectedRevision: settled.revision}), 1000000), resumed);
});

test('failure and unknown outcomes never pretend the assignment is finished', () => {
  const intent = transition(begin(), event('intent', {outcome: 'completed'}), 2000);
  const failed = transition(intent, event('settled', {success: false}), 3000);
  assert.equal(failed.state, 'unknown');
  assert.equal(reservation(failed, 10000000).held, true);
});
