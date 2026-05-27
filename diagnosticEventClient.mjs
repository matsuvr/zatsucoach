const DEFAULT_FLUSH_DELAY_MS = 1200;
const RETRY_FLUSH_DELAY_MS = 3000;
const MAX_FLUSH_ITEMS = 50;
const MAX_PENDING_ITEMS = 500;

const SERVER_EVENT_TYPES = new Set([
  'response.created',
  'response.done',
  'error',
  'session.error',
  'output_audio_buffer.started',
  'output_audio_buffer.stopped',
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'conversation.item.input_audio_transcription.failed',
  'conversation.item.audio_transcription.failed'
]);

const CLIENT_EVENT_TYPES = new Set([
  'client.assistant_response_flushed',
  'client.connection_state',
  'client.data_channel_open',
  'client.data_channel_close',
  'client.data_channel_error',
  'client.ice_state',
  'client.manual_response_create_deferred',
  'client.manual_response_create_sent',
  'client.microphone_tracks_set',
  'client.noise_turn_ignored',
  'client.output_audio_stop_watchdog_released',
  'client.realtime_context_prune_sent',
  'client.realtime_response_create_timeout',
  'client.realtime_response_watchdog_released',
  'client.realtime_sdp_request',
  'client.realtime_sdp_response',
  'client.realtime_start_skipped',
  'client.realtime_stop_skipped',
  'client.realtime_token_request',
  'client.realtime_voice_mismatch',
  'client.session_configured',
  'client.session_ready_timeout',
  'client.unparsed_message',
  'client.user_transcription_failed',
  'client.user_turn_accepted'
]);

export function createDiagnosticEventClient({
  canPersist = () => false,
  getContext = () => ({}),
  fetchImpl = fetch,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => new Date(),
  onError = () => {}
} = {}) {
  const state = {
    pendingItems: [],
    flushTimer: null,
    flushInFlight: false
  };

  function queue(event) {
    if (!canPersist()) return false;
    const item = sanitizeDiagnosticEvent(event, {
      ...getContext(),
      at: now().toISOString()
    });
    if (!item) return false;
    state.pendingItems.push(item);
    if (state.pendingItems.length > MAX_PENDING_ITEMS) {
      state.pendingItems.splice(0, state.pendingItems.length - MAX_PENDING_ITEMS);
    }
    scheduleFlush();
    return true;
  }

  function scheduleFlush(delayMs = DEFAULT_FLUSH_DELAY_MS) {
    clearTimer(state.flushTimer);
    state.flushTimer = setTimer(flush, delayMs);
  }

  async function flush() {
    clearTimer(state.flushTimer);
    state.flushTimer = null;
    if (!canPersist() || state.flushInFlight || !state.pendingItems.length) return;
    state.flushInFlight = true;
    const events = state.pendingItems.splice(0, MAX_FLUSH_ITEMS);
    try {
      const response = await fetchImpl('/api/diagnostic-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({ events })
      });
      if (!response.ok) throw new Error(`diagnostic events failed: ${response.status}`);
    } catch (error) {
      state.pendingItems.unshift(...events);
      onError({ type: 'client.diagnostic_events_save_failed', error: error.message || String(error), pending: state.pendingItems.length });
    } finally {
      state.flushInFlight = false;
      if (state.pendingItems.length) scheduleFlush(RETRY_FLUSH_DELAY_MS);
    }
  }

  function reset() {
    state.pendingItems = [];
    state.flushInFlight = false;
    clearTimer(state.flushTimer);
    state.flushTimer = null;
  }

  function snapshot() {
    return {
      pendingCount: state.pendingItems.length,
      flushInFlight: state.flushInFlight
    };
  }

  return { queue, flush, reset, snapshot };
}

export function sanitizeDiagnosticEvent(event, context = {}) {
  const type = String(event?.type || '').trim();
  if (!isDiagnosticEventType(type)) return null;

  const response = event.response && typeof event.response === 'object' ? event.response : {};
  const error = event.error && typeof event.error === 'object' ? event.error : {};
  const statusDetails = response.status_details || event.statusDetails || event.status_details || null;
  const usage = response.usage || event.usage || null;
  const incompleteDiagnostic = event.incompleteDiagnostic || null;

  return dropEmpty({
    type,
    at: String(context.at || new Date().toISOString()).slice(0, 40),
    perfAt: finiteNumber(event.perfAt ?? context.perfAt),
    sessionId: safeText(event.sessionId ?? context.sessionId, 80),
    logSessionId: safeText(context.logSessionId, 80),
    deployment: safeText(context.deployment, 120),
    voice: safeText(context.voice, 40),
    connectionState: safeText(context.connectionState, 40),
    iceConnectionState: safeText(context.iceConnectionState, 40),
    dataChannelState: safeText(context.dataChannelState, 40),
    eventId: safeText(event.event_id || event.eventId, 120),
    responseId: safeText(response.id || event.response_id || event.responseId, 120),
    itemId: safeText(event.item_id || event.itemId, 120),
    status: safeText(response.status || event.status, 40),
    reason: safeText(event.reason || statusDetails?.reason || statusDetails?.type, 120),
    errorCode: safeText(error.code || statusDetails?.error?.code || statusDetails?.code, 120),
    errorMessage: safeText(error.message || statusDetails?.error?.message || statusDetails?.message, 240),
    details: dropEmpty({
      statusDetails: summarizeStatusDetails(statusDetails),
      usage: summarizeUsage(usage),
      incompleteReason: safeText(event.incompleteReason, 120),
      incompleteDiagnostic: summarizeIncompleteDiagnostic(incompleteDiagnostic),
      approxSpeechMs: finiteNumber(event.approxSpeechMs),
      avatarOverlapMs: finiteNumber(event.avatarOverlapMs),
      overlappedAvatar: booleanOrNull(event.overlappedAvatar),
      pendingCreate: booleanOrNull(event.pendingCreate),
      activeResponses: finiteNumber(event.activeResponses),
      avatarSpeaking: booleanOrNull(event.avatarSpeaking),
      parts: finiteNumber(event.parts),
      textChars: finiteNumber(event.textChars),
      timeoutMs: finiteNumber(event.timeoutMs),
      outputAudioDurationMs: finiteNumber(event.outputAudioDurationMs),
      audioStartMs: finiteNumber(event.audio_start_ms ?? event.audioStartMs),
      audioEndMs: finiteNumber(event.audio_end_ms ?? event.audioEndMs),
      enabled: booleanOrNull(event.enabled),
      state: safeText(event.state, 80)
    })
  });
}

export function isDiagnosticEventType(type) {
  return SERVER_EVENT_TYPES.has(type) || CLIENT_EVENT_TYPES.has(type);
}

function summarizeStatusDetails(details) {
  if (!details || typeof details !== 'object') return null;
  return dropEmpty({
    type: safeText(details.type, 80),
    reason: safeText(details.reason, 120),
    code: safeText(details.error?.code || details.code, 120),
    message: safeText(details.error?.message || details.message, 240)
  });
}

function summarizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return dropEmpty({
    total_tokens: finiteNumber(usage.total_tokens),
    input_tokens: finiteNumber(usage.input_tokens),
    output_tokens: finiteNumber(usage.output_tokens)
  });
}

function summarizeIncompleteDiagnostic(diagnostic) {
  if (!diagnostic || typeof diagnostic !== 'object') return null;
  return dropEmpty({
    status: safeText(diagnostic.status, 40),
    type: safeText(diagnostic.type, 80),
    reason: safeText(diagnostic.reason, 120),
    code: safeText(diagnostic.code, 120),
    message: safeText(diagnostic.message, 240),
    usage: summarizeUsage(diagnostic.usage)
  });
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function safeText(value, maxChars) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

function dropEmpty(value) {
  const next = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (item === null || item === undefined || item === '') continue;
    if (typeof item === 'object' && !Array.isArray(item) && !Object.keys(item).length) continue;
    next[key] = item;
  }
  return next;
}
