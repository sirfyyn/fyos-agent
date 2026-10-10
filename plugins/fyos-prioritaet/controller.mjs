import {PLUGIN_ID, NAMESPACE, personal, personalAgent, PERSONAL_AGENTS, transition} from './state.mjs';

export const readState = (entry) => entry?.pluginExtensions?.[PLUGIN_ID]?.[NAMESPACE];

export function createController({store, now = Date.now, timers = globalThis, notify = () => {}, onError = () => {}}) {
  const scheduled = new Map();
  let stopped = false;
  function cancel(key) {
    if (scheduled.has(key)) timers.clearTimeout(scheduled.get(key));
    scheduled.delete(key);
  }
  function arm(key, state) {
    cancel(key);
    if (stopped || !['completed', 'input_needed'].includes(state?.state)) return;
    const handle = timers.setTimeout(() => {
      scheduled.delete(key);
      void change(key, {type: 'expire', identity: state, expectedRevision: state.revision}).catch(onError);
    }, Math.max(0, state.releaseAtMs - now()));
    handle?.unref?.();
    scheduled.set(key, handle);
  }
  async function change(key, event) {
    if (stopped || !personal(key)) return null;
    let changed = false;
    let expected;
    let saved;
    try {
      saved = await store.patchSessionEntry({
      agentId: personalAgent(key), sessionKey: key, preserveActivity: true,
      requireWriteSuccess: true, skipMaintenance: true,
      update(entry) {
        try {
          const id = event.identity;
          if (entry.sessionId !== id.sessionId || entry.lifecycleRevision !== id.lifecycleRevision) return null;
          const liveRun = entry.activeWriterRunId ?? entry.lifecycleRunId;
          if (liveRun && liveRun !== id.runId) return null;
          const previous = readState(entry);
          if (event.type === 'begin' && !liveRun && previous?.runId !== id.runId) {
            throw new Error('cannot admit a run without authoritative ownership');
          }
          const next = transition(previous, event, now());
          if (next === previous) return null;
          changed = true;
          expected = next;
          return {pluginExtensions: {...entry.pluginExtensions,
            [PLUGIN_ID]: {...entry.pluginExtensions?.[PLUGIN_ID], [NAMESPACE]: next}}};
        } catch (error) {
          error.fyosPrioritaetTransition = true;
          throw error;
        }
      },
      });
    } catch (error) {
      if (error?.fyosPrioritaetTransition === true) throw error;
      // A deadline failure must be diagnosable without logging any transcript,
      // tool argument, or provider response.  The caller only needs the stable
      // boundary name; the original error can remain in the gateway's own
      // structured error handling.
      const failure = new Error('priority_session_store_patch_failed');
      failure.cause = error;
      throw failure;
    }
    const state = readState(saved);
    if (changed) {
      if (JSON.stringify(state) !== JSON.stringify(expected)) throw new Error('priority state was not persisted');
      arm(key, state);
      notify({sessionKey: key, state});
    }
    return state;
  }
  function restore() {
    stopped = false;
    for (const {sessionKey, entry} of PERSONAL_AGENTS.flatMap((agentId) => store.listSessionEntries({agentId, readOnly: true}))) {
      if (personal(sessionKey)) {
        const state = readState(entry);
        if (state?.sessionId === entry.sessionId && state?.lifecycleRevision === entry.lifecycleRevision) arm(sessionKey, state);
      }
    }
  }
  function snapshot() {
    return PERSONAL_AGENTS.flatMap((agentId) => store.listSessionEntries({agentId, readOnly: true}))
      .filter(({sessionKey}) => personal(sessionKey))
      .map(({sessionKey, entry}) => ({sessionKey, sessionId: entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision, status: entry.status,
        modelProvider: entry.modelProvider, modelOverride: entry.modelOverride,
        activeRunId: entry.activeWriterRunId ?? entry.lifecycleRunId ?? null,
        state: readState(entry) ?? null}));
  }
  function stop() {
    stopped = true;
    for (const key of scheduled.keys()) cancel(key);
  }
  return {change, restore, snapshot, stop};
}
