export const DEFAULTS = Object.freeze({
  vadSilenceMs: 500,
  vadMinSpeechMs: 450
});

export const VAD_PREFIX_PADDING_MS = 300;
export const USER_TURN_TRANSCRIPT_WAIT_MS = 800;
export const USER_TURN_DURATION_DECISION_DELAY_MS = 0;
export const ASSISTANT_RESPONSE_FALLBACK_FLUSH_MS = 2500;
export const REALTIME_CONTEXT_PRUNE_AFTER_ITEMS = 34;
export const REALTIME_CONTEXT_KEEP_ITEMS = 28;
export const REALTIME_CONTEXT_MAX_DELETES_PER_TURN = 8;
export const REALTIME_RESPONSE_CREATE_TIMEOUT_MS = 8000;
export const REALTIME_RESPONSE_TIMEOUT_MS = 45000;
export const OUTPUT_AUDIO_STOP_TIMEOUT_MS = 20000;
export const TIMELINE_INTERVAL_KEEP_ITEMS = 60;

export function createInitialState() {
  return {
    active: false,
    sessionId: 0,
    expectedVoice: '',
    clientSessionUpdateRequired: false,
    realtimeSessionConfigured: false,
    tokenData: null,
    avatarSpeaking: false,
    localUserSpeaking: false,
    currentAssistantText: '',
    assistantTextByResponse: new Map(),
    assistantResponseParts: new Map(),
    assistantResponseTimers: new Map(),
    assistantResponseMeta: new Map(),
    pendingAssistantResponseUserItems: [],
    pendingRealtimeResponseCreate: false,
    pendingRealtimeResponseCreateTimer: null,
    cancelNextCreatedResponseForBargeIn: false,
    activeRealtimeResponseIds: new Set(),
    realtimeResponseWatchdogTimers: new Map(),
    deferredUserResponseTurnId: '',
    activeAssistantAudioResponseIds: new Set(),
    outputAudioStopWatchdogTimers: new Map(),
    bargeInCancelledResponseIds: new Set(),
    activeAvatarAudioStartedAt: 0,
    avatarAudioIntervals: [],
    realtimeConversationItems: new Map(),
    realtimeConversationSeq: 0,
    processedAssistantResponseKeys: new Set(),
    processedAssistantResponses: new Set(),
    userTextByItem: new Map(),
    userTurnByItem: new Map(),
    userItemSpeechStoppedAt: new Map(),
    processedUserTranscriptKeys: new Set(),
    lastSpeechStoppedAt: 0,
    lastResponseStartedAt: 0,
    sessionUpdateWatchdogTimer: null
  };
}

export function estimateSpeechDurationMs(turn, settings = {}) {
  const start = Number(turn.audioStartMs);
  const end = Number(turn.audioEndMs);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  const silenceMs = Number(settings.vadSilenceMs) || DEFAULTS.vadSilenceMs;
  return Math.max(0, Math.round(end - start - VAD_PREFIX_PADDING_MS - silenceMs));
}

export function userTurnDecision(turn, settings = {}) {
  const text = String(turn.transcriptFinal ? turn.finalTranscriptText : turn.transcriptText || '').trim();
  if (hasUsefulTranscript(text)) {
    return { accept: true, reason: 'transcript' };
  }
  const configuredGateMs = Number(settings.vadMinSpeechMs);
  const gateMs = Number.isFinite(configuredGateMs) ? Math.max(0, configuredGateMs) : DEFAULTS.vadMinSpeechMs;
  if (Number(turn.approxSpeechMs) >= gateMs) {
    return { accept: true, reason: 'duration' };
  }
  return { accept: false, reason: 'short_noise' };
}

export function hasUsefulTranscript(text) {
  const normalized = String(text || '')
    .replace(/[、。！？!?.,，．・「」『』（）()\[\]\s]/g, '')
    .trim();
  if (!normalized) return false;
  if (/^(ありがとう|ありがとうございました|ご視聴ありがとうございました|ご清聴ありがとうございました)$/.test(normalized)) return false;
  if (/^(ピン|ポン|ピロン|カチ|カチャ|カタカタ|チーン|通知音|着信音|バイブ|ding|beep)$/i.test(normalized)) return false;
  if (/^(はい|うん|ええ|そう|そうですね|ですね|いや|まあ|なるほど)$/.test(normalized)) return true;
  return normalized.length >= 2 && /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}A-Za-z0-9]/u.test(normalized);
}

export function assistantIncompleteReason(meta) {
  const diagnostic = assistantIncompleteDiagnostic(meta);
  const { status, reason, type, code } = diagnostic;
  if (status === 'incomplete' || status === 'cancelled' || status === 'failed') return reason || code || type || status;
  if (reason.includes('max') && reason.includes('token')) return reason;
  if (reason.includes('interrupt') || reason.includes('turn_detected')) return reason;
  return '';
}

export function assistantIncompleteDiagnostic(meta) {
  const details = meta?.statusDetails && typeof meta.statusDetails === 'object' ? meta.statusDetails : {};
  const error = details.error && typeof details.error === 'object' ? details.error : {};
  return {
    status: String(meta?.status || '').toLowerCase(),
    type: String(details.type || '').toLowerCase(),
    reason: String(details.reason || '').toLowerCase(),
    code: String(error.code || details.code || '').toLowerCase(),
    message: cleanDiagnosticMessage(error.message || details.message || ''),
    usage: summarizeUsage(meta?.usage)
  };
}

export function formatAssistantIncompleteDiagnostic(meta) {
  const diagnostic = assistantIncompleteDiagnostic(meta);
  const parts = [];
  if (diagnostic.status) parts.push(`status=${diagnostic.status}`);
  if (diagnostic.type) parts.push(`type=${diagnostic.type}`);
  if (diagnostic.reason) parts.push(`reason=${diagnostic.reason}`);
  if (diagnostic.code) parts.push(`code=${diagnostic.code}`);
  if (diagnostic.message) parts.push(`message=${diagnostic.message}`);
  if (diagnostic.usage?.total_tokens !== null && diagnostic.usage?.total_tokens !== undefined) {
    parts.push(`tokens=${diagnostic.usage.total_tokens}/${diagnostic.usage.input_tokens ?? '?'}/${diagnostic.usage.output_tokens ?? '?'}`);
  }
  return parts.join(', ');
}

export function formatAssistantIncompleteMessage(meta) {
  const reason = assistantIncompleteReason(meta);
  if (!reason) return '';
  const detail = formatAssistantIncompleteDiagnostic(meta);
  return detail ? `${reason} (${detail})` : reason;
}

export function formatAssistantIncompleteUserMessage(meta) {
  const reason = assistantIncompleteReason(meta);
  if (reason === 'content_filter') return '安全フィルターで停止しました。別の言い方で続けてください。';
  if (!reason) return '';
  const detail = formatAssistantIncompleteDiagnostic(meta);
  return detail ? `${reason} (${detail})` : reason;
}

function cleanDiagnosticMessage(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

export function summarizeStatusDetails(details) {
  if (!details || typeof details !== 'object') return details || null;
  return {
    type: details.type || null,
    reason: details.reason || null,
    code: details.error?.code || details.code || null,
    message: details.error?.message || details.message || null
  };
}

export function summarizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    total_tokens: usage.total_tokens ?? null,
    input_tokens: usage.input_tokens ?? null,
    output_tokens: usage.output_tokens ?? null
  };
}

export function durationBetween(start, end) {
  const startMs = Number(start);
  const endMs = Number(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  return Math.round(endMs - startMs);
}

export function overlapMs(start, end, intervals) {
  const startMs = Number(start);
  const endMs = Number(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || !Array.isArray(intervals)) return 0;
  return intervals.reduce((sum, interval) => {
    const intervalStart = Number(interval?.start);
    const intervalEnd = Number(interval?.end);
    if (!Number.isFinite(intervalStart) || !Number.isFinite(intervalEnd) || intervalEnd <= intervalStart) return sum;
    return sum + Math.max(0, Math.min(endMs, intervalEnd) - Math.max(startMs, intervalStart));
  }, 0);
}

export function trimSet(set, maxSize, keepSize) {
  if (set.size <= maxSize) return;
  const next = new Set(Array.from(set).slice(-keepSize));
  set.clear();
  for (const value of next) set.add(value);
}

export function responseContentKey(event) {
  return [
    event.response_id || 'no-response',
    event.item_id || 'no-item',
    event.output_index ?? 0,
    event.content_index ?? 0
  ].join(':');
}

export function responseDoneKey(event, contentKey) {
  return [
    contentKey,
    event.type || 'done'
  ].join(':');
}

export function audioOutputKey(event) {
  return event.response_id || event.item_id || 'active-output-audio';
}

export function userTranscriptKey(event) {
  return [
    event.item_id || 'no-item',
    event.content_index ?? 0
  ].join(':');
}

export function assistantResponseTimeline(responseId, meta) {
  return {
    responseId,
    userItemId: meta.userItemId || '',
    userSpeechStartedAt: Number(meta.userSpeechStartedAt) || 0,
    userSpeechStoppedAt: Number(meta.userSpeechStoppedAt) || Number(meta.userPerfAt) || 0,
    userSpeechDurationMs: Number(meta.userSpeechDurationMs) || 0,
    userApproxSpeechMs: Number(meta.userApproxSpeechMs) || 0,
    userAvatarOverlapMs: Number(meta.userAvatarOverlapMs) || 0,
    userOverlappedAvatar: Boolean(meta.userOverlappedAvatar),
    responseDeferred: Boolean(meta.responseDeferred),
    responseCreatedAt: Number(meta.responseCreatedAt) || 0,
    outputAudioStartedAt: Number(meta.outputAudioStartedAt) || 0,
    outputAudioStoppedAt: Number(meta.outputAudioStoppedAt) || 0,
    responseDoneAt: Number(meta.responseDoneAt) || 0,
    userToResponseCreateMs: durationBetween(meta.userSpeechStoppedAt || meta.userPerfAt, meta.responseCreatedAt),
    userToOutputAudioStartMs: durationBetween(meta.userSpeechStoppedAt || meta.userPerfAt, meta.outputAudioStartedAt),
    outputAudioDurationMs: durationBetween(meta.outputAudioStartedAt, meta.outputAudioStoppedAt || meta.responseDoneAt)
  };
}
