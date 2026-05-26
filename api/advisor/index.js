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
const { requireInteractiveAccess } = require('../_shared/appAuth');

const DEFAULT_INSTRUCTIONS = `You are a real-time Japanese conversation coach. Return only JSON: {"label":"good|warn|risk","advice":"1-3 concise Japanese sentences","reason":"short Japanese reason"}. Prioritize speed and practical next steps.`;

const ROLE_GUARD_INSTRUCTIONS = `Critical role mapping:
- The trainee is speaker="user" and is shown in the UI as "あなた".
- The conversation partner avatar is speaker="avatar" and is shown in the UI as "アバター".
- Do not treat avatar lines as your own assistant messages.
- Evaluate only latest_user_utterance when it is present. Use conversation_log only as context.
- If latest_user_utterance is null, infer cautiously from the avatar response and explicitly avoid blaming the trainee for unknown text.
- Use conversation_timeline and timing fields as coaching signals. Brief overlap with the avatar can be natural interest; do not penalize it by default. Long pauses, repeated deferred responses, or interrupting before the other speaker's point is clear may be worth mentioning.`;

module.exports = async function (context, req) {
  const startedAt = Date.now();
  let requestMeta = {};
  try {
    requireInteractiveAccess(req);

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
    const conversationLog = transcript.map(normalizeAdvisorItem).filter(Boolean);
    const diagnostics = normalizeDiagnostics(body.diagnostics);
    const userPayload = {
      task: 'Evaluate the trainee user utterance for low-friction office small talk. Use the avatar turns only as context. Keep it brief.',
      role_mapping: {
        user: 'trainee human speaker, shown as あなた',
        avatar: 'AI conversation partner, shown as アバター'
      },
      latest_user_utterance: latestItem?.speaker === 'user' ? latestItem : null,
      latest_observed_item: latestItem,
      conversation_log: conversationLog,
      conversation_timeline: {
        latest_response: diagnostics.timeline || null,
        latest_user_timing: latestItem?.speaker === 'user' ? latestItem.timing || null : null,
        recent_items: conversationLog.map((item) => ({
          speaker: item.speaker,
          sourceId: item.sourceId || '',
          text: item.text,
          timing: item.timing || null
        })).filter((item) => item.timing)
      }
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
  const normalized = {
    speaker,
    displayName: speaker === 'user' ? 'あなた' : 'アバター',
    text,
    at: item.at ? String(item.at).slice(0, 40) : undefined,
    sourceId: item.sourceId ? String(item.sourceId).slice(0, 160) : undefined
  };
  const timing = normalizeTiming(item);
  if (timing) normalized.timing = timing;
  return normalized;
}

function normalizeTiming(item) {
  const timing = {
    perfAt: safeFiniteNumber(item?.perfAt),
    startPerfAt: safeFiniteNumber(item?.startPerfAt),
    endPerfAt: safeFiniteNumber(item?.endPerfAt),
    durationMs: safeFiniteNumber(item?.durationMs),
    approxSpeechMs: safeFiniteNumber(item?.approxSpeechMs),
    avatarOverlapMs: safeFiniteNumber(item?.avatarOverlapMs),
    overlappedAvatar: Boolean(item?.overlappedAvatar)
  };
  const hasTiming = timing.perfAt || timing.startPerfAt || timing.endPerfAt || timing.durationMs || timing.approxSpeechMs || timing.avatarOverlapMs;
  return hasTiming ? timing : null;
}

function normalizeDiagnostics(value) {
  const diagnostics = value && typeof value === 'object' ? value : {};
  const timeline = diagnostics.timeline && typeof diagnostics.timeline === 'object'
    ? normalizeResponseTimeline(diagnostics.timeline)
    : null;
  return { timeline };
}

function normalizeResponseTimeline(timeline) {
  return {
    responseId: String(timeline.responseId || '').slice(0, 160),
    userItemId: String(timeline.userItemId || '').slice(0, 160),
    userSpeechStartedAt: safeFiniteNumber(timeline.userSpeechStartedAt),
    userSpeechStoppedAt: safeFiniteNumber(timeline.userSpeechStoppedAt),
    userSpeechDurationMs: safeFiniteNumber(timeline.userSpeechDurationMs),
    userApproxSpeechMs: safeFiniteNumber(timeline.userApproxSpeechMs),
    userAvatarOverlapMs: safeFiniteNumber(timeline.userAvatarOverlapMs),
    userOverlappedAvatar: Boolean(timeline.userOverlappedAvatar),
    responseDeferred: Boolean(timeline.responseDeferred),
    responseCreatedAt: safeFiniteNumber(timeline.responseCreatedAt),
    outputAudioStartedAt: safeFiniteNumber(timeline.outputAudioStartedAt),
    outputAudioStoppedAt: safeFiniteNumber(timeline.outputAudioStoppedAt),
    responseDoneAt: safeFiniteNumber(timeline.responseDoneAt),
    userToResponseCreateMs: safeFiniteNumber(timeline.userToResponseCreateMs),
    userToOutputAudioStartMs: safeFiniteNumber(timeline.userToOutputAudioStartMs),
    outputAudioDurationMs: safeFiniteNumber(timeline.outputAudioDurationMs)
  };
}

function safeFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : 0;
}
