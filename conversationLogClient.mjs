const DEFAULT_FLUSH_DELAY_MS = 900;
const RETRY_FLUSH_DELAY_MS = 1500;
const MAX_FLUSH_ITEMS = 50;

export function createConversationLogClient({
  canPersist = () => false,
  getTranscript = () => [],
  fetchImpl = fetch,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => new Date(),
  summarizeTitle = defaultTitleSummary,
  onError = () => {}
} = {}) {
  const state = createInitialState();

  function queueTranscript(item) {
    queueItem({
      kind: 'transcript',
      role: item.role,
      text: item.text,
      at: item.at,
      id: item.sourceId || `transcript-${item.at}-${state.sequence + 1}`,
      meta: {
        sourceId: item.sourceId || '',
        perfAt: Math.round(Number(item.perfAt || 0)),
        startPerfAt: Math.round(Number(item.startPerfAt || 0)),
        endPerfAt: Math.round(Number(item.endPerfAt || 0)),
        durationMs: Math.round(Number(item.durationMs || 0)),
        approxSpeechMs: Math.round(Number(item.approxSpeechMs || 0)),
        avatarOverlapMs: Math.round(Number(item.avatarOverlapMs || 0)),
        overlappedAvatar: Boolean(item.overlappedAvatar)
      }
    });
  }

  function queueAdvice(item) {
    if (!shouldPersistAdvice(item.source)) return;
    queueItem({
      kind: 'advice',
      role: 'system',
      text: item.text,
      label: item.label,
      source: item.source,
      at: item.at || now().toISOString(),
      id: item.id || `advice-${Date.now().toString(36)}-${state.sequence + 1}`,
      meta: { displayMeta: item.meta || '' }
    });
  }

  function queueItem(item) {
    if (!canPersist()) return;
    const sequence = nextSequence();
    state.pendingItems.push({ ...item, sequence });
    if (item.kind === 'transcript') state.transcriptCount += 1;
    if (item.kind === 'advice') state.adviceCount += 1;
    state.itemCount += 1;
    scheduleFlush();
  }

  function nextSequence() {
    state.sequence += 1;
    return state.sequence;
  }

  function scheduleFlush(delayMs = DEFAULT_FLUSH_DELAY_MS) {
    clearTimer(state.flushTimer);
    state.flushTimer = setTimer(flush, delayMs);
  }

  async function ensureSession() {
    if (!canPersist()) return '';
    if (state.sessionId) return state.sessionId;

    const startedAt = now().toISOString();
    const response = await fetchImpl('/api/log-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: logSessionSummary().title, startedAt })
    });
    const data = await safeJson(response);
    if (!response.ok) throw new Error(data.error || `log session failed: ${response.status}`);
    state.sessionId = data.sessionId;
    state.sessionStartedAt = startedAt;
    return state.sessionId;
  }

  async function flush() {
    clearTimer(state.flushTimer);
    state.flushTimer = null;
    if (!canPersist() || state.flushInFlight || !state.pendingItems.length) return;
    state.flushInFlight = true;
    const items = state.pendingItems.splice(0, MAX_FLUSH_ITEMS);
    try {
      const sessionId = await ensureSession();
      if (!sessionId) return;
      const response = await fetchImpl('/api/log-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          items,
          summary: logSessionSummary()
        })
      });
      const data = await safeJson(response);
      if (!response.ok) throw new Error(data.error || `log save failed: ${response.status}`);
    } catch (error) {
      state.pendingItems.unshift(...items);
      onError({ type: 'client.log_save_failed', error: error.message || String(error), pending: state.pendingItems.length });
    } finally {
      state.flushInFlight = false;
      if (state.pendingItems.length) scheduleFlush(RETRY_FLUSH_DELAY_MS);
    }
  }

  function logSessionSummary(extra = {}) {
    const transcript = getTranscript();
    const firstUserText = Array.isArray(transcript)
      ? transcript.find((item) => item.role === 'user')?.text || ''
      : '';
    return {
      title: firstUserText ? summarizeTitle(firstUserText, 48) : '会話ログ',
      itemCount: state.itemCount,
      transcriptCount: state.transcriptCount,
      adviceCount: state.adviceCount,
      ...extra
    };
  }

  async function close(reason = 'closed') {
    if (!canPersist()) {
      reset();
      return;
    }
    await flush();
    if (!state.sessionId) {
      reset();
      return;
    }
    try {
      await fetchImpl('/api/log-sessions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: state.sessionId,
          ...logSessionSummary({ endedAt: now().toISOString(), closeReason: reason })
        })
      });
    } catch (error) {
      onError({ type: 'client.log_session_close_failed', reason, error: error.message || String(error) });
    } finally {
      reset();
    }
  }

  function reset() {
    state.sessionId = '';
    state.sessionStartedAt = '';
    state.sequence = 0;
    state.pendingItems = [];
    state.itemCount = 0;
    state.transcriptCount = 0;
    state.adviceCount = 0;
    state.flushInFlight = false;
    clearTimer(state.flushTimer);
    state.flushTimer = null;
  }

  async function loadSessions(limit = 30) {
    if (!canPersist()) return [];
    const response = await fetchImpl(`/api/log-sessions?limit=${encodeURIComponent(limit)}`, { cache: 'no-store' });
    const data = await safeJson(response);
    if (!response.ok) throw new Error(data.error || `log sessions failed: ${response.status}`);
    return data.sessions || [];
  }

  async function loadItems(sessionId) {
    if (!sessionId) return [];
    const response = await fetchImpl(`/api/log-items?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
    const data = await safeJson(response);
    if (!response.ok) throw new Error(data.error || `log items failed: ${response.status}`);
    return data.items || [];
  }

  async function deleteSession(sessionId) {
    if (!sessionId) return false;
    const response = await fetchImpl(`/api/log-sessions?sessionId=${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    const data = await safeJson(response);
    if (!response.ok) throw new Error(data.error || `delete failed: ${response.status}`);
    return true;
  }

  function snapshot() {
    return {
      sessionId: state.sessionId,
      sequence: state.sequence,
      pendingCount: state.pendingItems.length,
      itemCount: state.itemCount,
      transcriptCount: state.transcriptCount,
      adviceCount: state.adviceCount,
      flushInFlight: state.flushInFlight
    };
  }

  return {
    queueTranscript,
    queueAdvice,
    flush,
    close,
    reset,
    loadSessions,
    loadItems,
    deleteSession,
    snapshot
  };
}

export function shouldPersistAdvice(source) {
  return /^LLM\b/.test(source) || /^instant\b/.test(source);
}

export function defaultTitleSummary(text, limit = 48) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trim()}…`;
}

function createInitialState() {
  return {
    sessionId: '',
    sessionStartedAt: '',
    sequence: 0,
    flushTimer: null,
    flushInFlight: false,
    pendingItems: [],
    itemCount: 0,
    transcriptCount: 0,
    adviceCount: 0
  };
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}
