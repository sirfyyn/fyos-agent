// Only explicit whole-conversation outcomes may release personal capacity.
export const GRACE_MS = 15 * 60 * 1000;
export const PLUGIN_ID = 'fyos-prioritaet';
export const NAMESPACE = 'conversation';

// Agenten, deren direkte Gespraeche den Abschluss-Status melden. Wird beim Registrieren
// aus der Plugin-Konfiguration (`agenten`) gesetzt; die Liste wird in place geaendert.
export const PERSONAL_AGENTS = ['main'];
export function setzeAgenten(liste) {
  const sauber = (Array.isArray(liste) ? liste : []).filter((a) => typeof a === 'string' && /^[A-Za-z0-9_-]+$/.test(a));
  if (sauber.length) PERSONAL_AGENTS.splice(0, PERSONAL_AGENTS.length, ...sauber);
}
export function personalAgent(key) {
  if (typeof key !== 'string') return null;
  const match = /^agent:([^:]+):(.+)$/.exec(key);
  // Vorgangs- und Cron-Sitzungen sind keine persoenlichen Gespraeche.
  return match && PERSONAL_AGENTS.includes(match[1]) && !match[2].startsWith('vorgang-') && !key.includes(':cron:')
    ? match[1] : null;
}
export const personal = (key) => personalAgent(key) !== null;

export function current(state, identity) {
  return state?.version === 1 && state.sessionId === identity.sessionId &&
    state.runId === identity.runId && state.lifecycleRevision === identity.lifecycleRevision;
}

export function transition(state, event, now) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid clock');
  const identity = event.identity;
  if (!identity || !['sessionId', 'runId', 'lifecycleRevision'].every(
    (key) => typeof identity[key] === 'string' && identity[key].length > 0
  )) throw new Error('missing conversation identity');
  if (event.type === 'begin') {
    // The caller must verify this run against the authoritative session entry.
    if (current(state, identity) && state.state === 'working' && state.intent === null) return state;
    return {version: 1, ...identity, revision: (state?.revision ?? 0) + 1,
      state: 'working', atMs: now, releaseAtMs: null, intent: null, receipt: null, tools: {}};
  }
  if (!current(state, identity)) return state;
  if (event.expectedRevision !== undefined && event.expectedRevision !== state.revision) return state;
  const changed = (patch) => ({...state, ...patch, revision: state.revision + 1});
  if (event.type === 'prepare') {
    if (!event.toolCallId || !['completed', 'input_needed'].includes(event.outcome)) throw new Error('invalid status receipt');
    return changed({intent: null, receipt: {toolCallId: event.toolCallId, outcome: event.outcome}});
  }
  if (event.type === 'intent') {
    if (!['completed', 'input_needed'].includes(event.outcome)) throw new Error('invalid outcome');
    if (state.state !== 'working') throw new Error('conversation is not working');
    if (Object.keys(state.tools ?? {}).length) throw new Error('conversation still has unfinished tools');
    if (state.intent === event.outcome) return state;
    return changed({intent: event.outcome, receipt: null});
  }
  if (event.type === 'work') {
    if (state.state === 'working' && state.intent === null && !event.toolCallId) return state;
    return changed({state: 'working', intent: null, receipt: null, atMs: now, releaseAtMs: null,
      tools: event.toolCallId ? {...state.tools, [event.toolCallId]: {phase: 'running'}} : state.tools});
  }
  if (['tool_end', 'approval_wait', 'approval_resolved'].includes(event.type)) {
    const tool = state.tools?.[event.toolCallId];
    if (!tool) return state;
    const tools = {...state.tools};
    if (event.type === 'tool_end') delete tools[event.toolCallId];
    else if (event.type === 'approval_wait') {
      if (!event.approvalId) throw new Error('missing approval identity');
      if (tool.approvalId === event.approvalId) return state;
      tools[event.toolCallId] = {phase: 'waiting', approvalId: event.approvalId};
    } else {
      if (tool.approvalId !== event.approvalId) return state;
      tools[event.toolCallId] = {phase: 'running'};
    }
    const waiting = Object.values(tools).length > 0 && Object.values(tools).every((t) => t.phase === 'waiting');
    if (waiting && state.state === 'input_needed') return changed({tools});
    return changed({tools, state: waiting ? 'input_needed' : 'working', intent: null,
      atMs: now, releaseAtMs: waiting ? now + GRACE_MS : null});
  }
  if (event.type === 'settled') {
    // Duplicate end events cannot extend grace, nor can an ordinary final answer
    // infer a completed assignment. Errors keep the reservation unresolved.
    if (state.state !== 'working') return state;
    if (Object.keys(state.tools ?? {}).length) return state;
    if (!event.success) return changed({state: 'unknown', intent: null, releaseAtMs: null, atMs: now});
    if (!state.intent) return state.receipt ? changed({receipt: null}) : state;
    return changed({state: state.intent, intent: null, atMs: now, releaseAtMs: now + GRACE_MS});
  }
  if (event.type === 'expire') {
    if (!['completed', 'input_needed'].includes(state.state) || now < state.releaseAtMs) return state;
    return changed({state: 'released'});
  }
  throw new Error('unknown conversation event');
}

export function reservation(state, now) {
  if (!state || state.version !== 1) return {held: true, reason: 'unknown'};
  if (state.state === 'released') return {held: false, reason: 'released'};
  // A deadline alone is not a release: expiry revalidates the persisted identity.
  return {held: true, reason: state.state,
    remainingMs: state.releaseAtMs === null ? null : Math.max(0, state.releaseAtMs - now)};
}
