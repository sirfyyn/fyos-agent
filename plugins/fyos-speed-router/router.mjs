// Tempo-Router: kurze, klar gespraechsartige Direktnachrichten laufen ueber ein kleines,
// schnelles Modell ohne Werkzeuge; alles andere bleibt auf dem Hauptmodell mit allen Werkzeugen.
//
// Absichtlich ein konservativer Klassifizierer und kein zweiter Modellaufruf. Ohne
// `targetModel` (Standard) ist der Router aus. Mehrdeutiges geht immer auf das Hauptmodell.
const DEFAULT_MAX_CHARS = 240;
const DEFAULT_AGENT = 'main';

const operational = /\b[a-z]{2,6}-\d+\b|(?:freigab|genehm|genehmigt|erlaubt|zugestimmt|akzept|ablehn|entscheidung|ticket|vorgang|matrix|openclaw|cluster|kubernetes|kubectl|pod|deploy|deployment|build|push|merge|git|github|gitlab|gitea|ssh|secret|vault|memory|rag|browser|code|coding|datei|file|test|debug|install|config|konfig|patch|rollout|produktion|main|branch|runner|queue|service|status|live|aktuell|problem|fehler|down|gateway|verbindung|funktioniert|langsam|schnell|latenz|timeout|prüf|pruef|check|arbeite|ändere|aendere|anpass|starte|stoppe|mach|erstell|schreib|lösche|loesche|öffne|oeffne|weiter|go|run)\b/i;
const directLead = /^(?:hallo|hi|hey|moin|guten\s+(?:morgen|tag|abend)|danke|vielen\s+dank|thx|wie\s+geht(?:'s|s)?|wer\s+bist\s+du|wie\s+heißt\s+du|wie\s+heisst\s+du|was\b|wer\s+ist|wie\b|warum\b|wann\b|wo\b|wie\s+funktioniert|erklär(?:e)?|erklaer(?:e)?|definier(?:e)?|tell\s+me|what\s+is|who\s+is|how\s+does|explain|und\s+(?=(?:was|wer|wie|warum|wann|wo|wieviel|welch|wie\s+geht|wie\s+funktioniert|erklär|erklaer|definier|tell|what|who|how|explain)\b))\b/i;
// Kurze Bestaetigungen sind bewusst eng: "ja", "okay", "weiter" koennen eine Freigabe oder
// eine Fortsetzung sein und bleiben deshalb auf dem Hauptmodell.
const directAck = /^(?:super|perfekt|prima|danke|vielen\s+dank|thx|👍|🙂|😊)[!. ]*$/iu;

function textOf(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function directSession(sessionKey, agentId) {
  if (typeof sessionKey !== 'string') return false;
  const kopf = `agent:${agentId}:`.toLowerCase();
  if (!sessionKey.toLowerCase().startsWith(kopf)) return false;
  // Vorgangs-, Zeitplan-, System- und Kind-Sitzungen werden nie umgeleitet. Dashboard-Sitzungen
  // sind das direkte Gespraech in der Oberflaeche, `main` der direkte Nachrichtenweg.
  const rest = sessionKey.slice(kopf.length);
  return rest.toLowerCase() === 'main' || /^dashboard:[^:]+$/i.test(rest);
}

function hasAttachments(attachments) {
  return Array.isArray(attachments) && attachments.length > 0;
}

export function classifyReflexTurn({prompt, attachments, sessionKey, agentId = DEFAULT_AGENT} = {}, options = {}) {
  const text = textOf(prompt);
  const zielAgent = options.agentId || DEFAULT_AGENT;
  const maxChars = Number.isInteger(options.maxChars) ? options.maxChars : DEFAULT_MAX_CHARS;
  if (options.enabled === false || !options.targetModel) return {route: 'main', reason: 'disabled'};
  if (agentId !== zielAgent) return {route: 'main', reason: 'other-agent'};
  if (!directSession(sessionKey, zielAgent)) return {route: 'main', reason: 'non-direct-session'};
  if (!text) return {route: 'main', reason: 'empty-prompt'};
  if (text.length > maxChars) return {route: 'main', reason: 'prompt-too-long'};
  if (hasAttachments(attachments)) return {route: 'main', reason: 'attachment-present'};
  if (operational.test(text)) return {route: 'main', reason: 'operational-intent'};
  if (!(directLead.test(text) || directAck.test(text))) return {route: 'main', reason: 'not-clearly-conversational'};
  return {route: 'reflex', model: options.targetModel, reason: 'short-direct-conversation'};
}

function currentPrompt(event) {
  if (typeof event?.prompt === 'string') return event.prompt;
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const lastUser = [...messages].reverse().find((message) => message?.role === 'user');
  return typeof lastUser?.content === 'string' ? lastUser.content : '';
}

function classifyEvent(event, ctx, options) {
  return classifyReflexTurn({
    prompt: currentPrompt(event),
    attachments: event?.attachments,
    sessionKey: typeof ctx?.sessionKey === 'string' ? ctx.sessionKey : '',
    agentId: ctx?.agentId ?? options.agentId ?? DEFAULT_AGENT,
  }, options);
}

function modelSelection(model) {
  const separator = model.indexOf('/');
  if (separator <= 0 || separator === model.length - 1) return {modelOverride: model};
  // OpenClaw loest Anbieter und Modell getrennt auf. Ein anbieterqualifizierter String als
  // modelOverride liesse den aktiven Anbieter stehen und erzeugte eine zweite, langsame Anfrage.
  return {providerOverride: model.slice(0, separator), modelOverride: model.slice(separator + 1)};
}

export function registerSpeedRouter(api, dependencies = {}) {
  const config = dependencies.config ?? api.pluginConfig ?? {};
  const options = {
    enabled: config.enabled === true,
    targetModel: typeof config.targetModel === 'string' ? config.targetModel.trim() : '',
    maxChars: Number.isInteger(config.maxChars) ? config.maxChars : DEFAULT_MAX_CHARS,
    agentId: typeof config.agentId === 'string' && config.agentId ? config.agentId : DEFAULT_AGENT,
  };
  api.on('before_model_resolve', (event, ctx) => {
    const decision = classifyEvent(event, ctx, options);
    return decision.route === 'reflex' ? modelSelection(decision.model) : undefined;
  });
  // Die Reflexbahn ist ausdruecklich werkzeuglos. Die volle Werkzeugrichtlinie bleibt fuer
  // jeden mehrdeutigen oder operativen Turn unberuehrt, es geht also keine Faehigkeit verloren.
  api.on('before_prompt_build', (event, ctx) => {
    const decision = classifyEvent(event, ctx, options);
    return decision.route === 'reflex' ? {toolsAllow: []} : undefined;
  });
}

export const _internals = {directSession, hasAttachments, textOf};
