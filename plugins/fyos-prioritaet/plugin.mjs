import {createController, readState} from './controller.mjs';
import {PLUGIN_ID, NAMESPACE, personal, personalAgent, setzeAgenten} from './state.mjs';

// Das Werkzeug, mit dem der Agent seinen GANZEN Auftrag als erledigt oder als wartend
// auf eine Antwort meldet. Ein Modellturn-Ende allein ist kein Abschluss.
export const TOOL = 'fyos_conversation_status';

const statusRelay = (event) => event.toolName === 'tool_call' &&
  [TOOL, `openclaw:${PLUGIN_ID}:${TOOL}`].includes(event.params?.id);

export function registerPriority(api, dependencies = {}) {
  const config = dependencies.config ?? api.pluginConfig ?? {};
  setzeAgenten(config.agenten);
  let gatewayContext;
  const store = dependencies.store ?? api.runtime.agent.session;
  const controller = createController({store, ...dependencies,
    onError: (error) => {
      // Kein Modelltext, keine Werkzeugparameter, kein Anbieterkoerper ins Log: nur ein
      // stabiler Code, der sagt, ob die Frist nicht gespeichert werden konnte.
      const code = error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
        ? error.message
        : 'priority_state_update_failed';
      api.logger.error(`fyos-prioritaet: state update failed (${code}); capacity remains reserved`);
    },
    notify(change) {
      gatewayContext?.broadcastToConnIds('fyos.prioritaet.changed', change,
        gatewayContext.getSessionEventSubscriberConnIds(), {agentId: personalAgent(change.sessionKey)});
      dependencies.notify?.(change);
    },
  });
  const native = api.runtime.agent.session;
  function identity(ctx) {
    if (!personal(ctx.sessionKey) || !ctx.sessionId || !ctx.runId) return null;
    const entry = native.getSessionEntry({agentId: personalAgent(ctx.sessionKey), sessionKey: ctx.sessionKey});
    if (entry?.sessionId !== ctx.sessionId || !entry.lifecycleRevision) return null;
    return {sessionId: ctx.sessionId, runId: ctx.runId, lifecycleRevision: entry.lifecycleRevision};
  }
  api.session.state.registerSessionExtension({namespace: NAMESPACE,
    description: 'Personal assignment state; no transcript or model content'});
  api.on('before_agent_run', async (_event, ctx) => {
    const id = identity(ctx);
    if (id) await controller.change(ctx.sessionKey, {type: 'begin', identity: id});
  });
  api.on('before_tool_call', async (event, ctx) => {
    if (!personal(ctx.sessionKey)) return;
    // Native discovery wraps the status tool; the wrapper is not independent work.
    if (statusRelay(event)) return;
    const id = identity(ctx);
    if (!id) {
      if (event.toolName === TOOL) return {block: true, blockReason: 'Current conversation identity is unavailable'};
      return;
    }
    if (event.toolName !== TOOL) {
      await controller.change(ctx.sessionKey, {type: 'work', identity: id, toolCallId: event.toolCallId});
      return;
    }
    const outcome = event.params?.state;
    if (!['completed', 'input_needed'].includes(outcome) || !event.toolCallId) {
      // Die genaue Form nennen: Modelle raten sonst `status` statt `state` und wiederholen blind (09.10.).
      return {block: true, blockReason: 'Call with {"state":"completed"} or {"state":"input_needed"} (the parameter is named state) for the current assignment'};
    }
    await controller.change(ctx.sessionKey, {type: 'prepare', identity: id,
      toolCallId: event.toolCallId, outcome});
  });
  api.on('after_tool_call', async (event, ctx) => {
    if (event.toolName === TOOL) return;
    if (statusRelay(event)) return;
    const id = identity(ctx);
    if (id) await controller.change(ctx.sessionKey, {type: 'tool_end', identity: id,
      toolCallId: event.toolCallId ?? ctx.toolCallId});
  });
  api.agent.events.registerAgentEventSubscription({id: 'approval-wait', streams: ['lifecycle'],
    async handle(event) {
      const phase = event.data?.phase;
      if (!['waiting-approval', 'approval-resolved'].includes(phase)) return;
      const id = identity(event);
      if (!id) return;
      await controller.change(event.sessionKey, {type: phase === 'waiting-approval' ? 'approval_wait' : 'approval_resolved',
        identity: id, toolCallId: event.data.toolCallId, approvalId: event.data.approvalId});
    },
  });
  api.registerTool((ctx) => personal(ctx.sessionKey) ? {
    name: TOOL, label: 'Conversation status',
    description: 'Declare the WHOLE personal assignment completed, or input_needed when you need the owner to answer. Call only after all work/tools for now are finished, then deliver your final result or question. A model call ending is not completion. Further work invalidates this declaration. This never deletes a session or authorizes destructive work.',
    parameters: {type: 'object', properties: {state: {type: 'string', enum: ['completed', 'input_needed']}}, required: ['state'], additionalProperties: false},
    async execute(toolCallId) {
      // OpenClaw can instantiate a separate tool-discovery registry. Hook and
      // tool must therefore exchange receipts in the native session extension.
      const prepared = readState(native.getSessionEntry({agentId: personalAgent(ctx.sessionKey), sessionKey: ctx.sessionKey}));
      const receipt = prepared?.receipt;
      if (!receipt || receipt.toolCallId !== toolCallId ||
          (ctx.sessionId && prepared.sessionId !== ctx.sessionId)) {
        throw new Error('No current runtime receipt for conversation status');
      }
      // Factory contexts may omit sessionId. The hook receipt carries native
      // ownership; controller.change revalidates it against the current entry.
      const state = await controller.change(ctx.sessionKey,
        {type: 'intent', identity: prepared, outcome: receipt.outcome, expectedRevision: prepared.revision});
      if (state?.intent !== receipt.outcome || state.runId !== prepared.runId) {
        throw new Error('Conversation has changed; status was not accepted');
      }
      return {content: [{type: 'text', text: 'Status intent recorded. The 15-minute grace starts only after successful final handover. Deliver your result or question now.'}]};
    },
  } : null, {name: TOOL});
  api.on('agent_end', async (event, ctx) => {
    const id = identity(ctx);
    if (!id) return;
    // Native hooks append discovery activity cards after the transcript. These
    // are evidence of earlier calls, not messages after the final answer.
    const last = event.messages?.filter((message) => !(message.role === 'custom' &&
      message.customType === 'openclaw.nested-tool.v1' && message.excludeFromContext === true)).at(-1);
    // No release for a yielded tool call or failed/aborted attempt.
    const finalAnswer = last?.role === 'assistant' && Array.isArray(last.content) &&
      last.content.some((part) => part.type === 'text' && part.text?.trim()) &&
      !last.content.some((part) => ['toolCall', 'tool_use'].includes(part.type));
    if (event.success && !finalAnswer) return;
    await controller.change(ctx.sessionKey, {type: 'settled', identity: id, success: event.success === true});
  });
  api.registerGatewayMethod('fyos.prioritaet.snapshot', ({context}) => {
    gatewayContext = context;
    return {version: 1, sessions: controller.snapshot()};
  }, {scope: 'operator.read'});
  api.registerService({id: PLUGIN_ID, start() {controller.restore();}, stop() {
    controller.stop(); gatewayContext = undefined;
  }});
  return controller;
}
