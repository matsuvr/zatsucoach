'use strict';

const {
  parseJsonBody,
  errorResponse,
  jsonResponse,
  chatCompletion,
  extractChatText,
  clampNumber,
  trimTranscriptByBudget,
  estimateMessageTokens,
  advisorEndpointBase,
  advisorEndpointRoute,
  advisorApiKey
} = require('../_shared/azureOpenAI');
const { authenticatedUser } = require('../_shared/appAuth');

const DEFAULT_INSTRUCTIONS = `You are a real-time Japanese conversation coach. Return only JSON: {"label":"good|warn|risk","advice":"1-3 concise Japanese sentences","reason":"short Japanese reason"}. Prioritize speed and practical next steps.`;

const ROLE_GUARD_INSTRUCTIONS = `Critical role mapping:
- The trainee is speaker="user" and is shown in the UI as "あなた".
- The conversation partner avatar is speaker="avatar" and is shown in the UI as "アバター".
- Do not treat avatar lines as your own assistant messages.
- Evaluate only latest_user_utterance when it is present. Use conversation_log only as context.
- If latest_user_utterance is null, infer cautiously from the avatar response and explicitly avoid blaming the trainee for unknown text.`;

module.exports = async function (context, req) {
  const startedAt = Date.now();
  let requestMeta = {};
  try {
    authenticatedUser(req);

    const body = parseJsonBody(req);
    requestMeta = {
      clientRequestId: String(body.clientRequestId || '').slice(0, 120),
      sessionId: body.sessionId ?? null,
      source: String(body.source || '').slice(0, 80),
      responseId: String(body.responseId || '').slice(0, 160)
    };
    const rawTranscript = Array.isArray(body.transcript) ? body.transcript : [];
    const transcript = trimTranscriptByBudget(body.transcript, {
      maxItems: 24,
      maxChars: 9000,
      maxTextChars: 1200,
      maxTokens: 6000
    });
    const latest = body.latest || transcript[transcript.length - 1] || {};
    const instructions = String(body.instructions || DEFAULT_INSTRUCTIONS).slice(0, 6000);
    const maxTokens = clampNumber(body.maxTokens, 2048, 512, 4096);

    const latestItem = normalizeAdvisorItem(latest);
    const userPayload = {
      task: 'Evaluate the trainee user utterance for low-friction office small talk. Use the avatar turns only as context. Keep it brief.',
      role_mapping: {
        user: 'trainee human speaker, shown as あなた',
        avatar: 'AI conversation partner, shown as アバター'
      },
      latest_user_utterance: latestItem?.speaker === 'user' ? latestItem : null,
      latest_observed_item: latestItem,
      conversation_log: transcript.map(normalizeAdvisorItem).filter(Boolean)
    };
    const messages = [{ role: 'system', content: `${instructions}\n\n${ROLE_GUARD_INSTRUCTIONS}` }];
    messages.push({ role: 'user', content: JSON.stringify(userPayload) });
    const estimatedInputTokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);

    const started = Date.now();
    const { data, deployment, usedFallback, endpoint, rateLimits, requestIds, responseHeaders, choiceMessage } = await chatCompletion({
      deployment: body.deployment || process.env.ADVISOR_DEPLOYMENT || 'grok-4-20-non-reasoning',
      messages,
      maxTokens,
      temperature: 0.2,
      reasoningEffort: body.reasoningEffort || process.env.ADVISOR_REASONING_EFFORT || 'none',
      timeoutMs: 15000,
      endpoint: advisorEndpointBase(),
      apiKey: advisorApiKey(),
      routeHint: advisorEndpointRoute()
    });

    const text = extractChatText(data).trim();
    let parsed = null;
    try {
      parsed = JSON.parse(text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim());
    } catch {
      parsed = { label: 'good', advice: text || '助言を生成できませんでした。', reason: '' };
    }

    const label = ['good', 'warn', 'risk'].includes(parsed.label) ? parsed.label : 'good';
    context.log(JSON.stringify({
      type: 'advisor.completed',
      ...requestMeta,
      deployment,
      usedFallback,
      endpoint,
      latencyMs: Date.now() - started,
      inputBudget: {
        rawTranscriptItems: rawTranscript.length,
        usedTranscriptItems: transcript.length,
        droppedTranscriptItems: Math.max(0, rawTranscript.length - transcript.length),
        estimatedInputTokens
      },
      rateLimits,
      requestIds,
      responseHeaders,
      choiceMessage
    }));
    jsonResponse(context, {
      label,
      advice: String(parsed.advice || text || '').slice(0, 1200),
      reason: String(parsed.reason || '').slice(0, 1200),
      text,
      deployment,
      usedFallback,
      endpoint,
      clientRequestId: requestMeta.clientRequestId,
      rateLimits,
      requestIds,
      responseHeaders,
      choiceMessage,
      inputBudget: {
        rawTranscriptItems: rawTranscript.length,
        usedTranscriptItems: transcript.length,
        droppedTranscriptItems: Math.max(0, rawTranscript.length - transcript.length),
        estimatedInputTokens
      },
      latencyMs: Date.now() - started
    });
  } catch (error) {
    context.log(JSON.stringify({
      type: 'advisor.failed',
      ...requestMeta,
      status: error?.status || 500,
      retryAfterMs: Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : undefined,
      endpoint: error?.endpoint,
      rateLimits: error?.rateLimits,
      requestIds: error?.requestIds,
      responseHeaders: error?.responseHeaders,
      serviceResponseText: error?.serviceResponseText,
      serviceResponseBody: error?.serviceResponseBody,
      latencyMs: Date.now() - startedAt
    }));
    errorResponse(context, error, 500, {
      clientRequestId: requestMeta.clientRequestId || undefined
    });
  }
};

function normalizeAdvisorItem(item) {
  const text = String(item?.text || '').trim();
  if (!text) return null;
  const speaker = item.role === 'assistant' ? 'avatar' : 'user';
  return {
    speaker,
    displayName: speaker === 'user' ? 'あなた' : 'アバター',
    text,
    at: item.at ? String(item.at).slice(0, 40) : undefined
  };
}
