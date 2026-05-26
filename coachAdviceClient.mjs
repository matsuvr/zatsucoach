const ADVISOR_MIN_INTERVAL_MS = 3000;
const ADVISOR_BACKOFF_MS = 60000;
const ADVISOR_ERROR_MUTE_MS = 60000;

export function createCoachAdviceClient({
  getSettings = () => ({}),
  getTranscript = () => [],
  isActiveSession = () => true,
  canBenchmark = () => false,
  confirm = () => false,
  fetchImpl = fetch,
  now = () => performance.now(),
  wallNow = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  addAdvice = () => {},
  addMetric = () => {},
  logEvent = () => {}
} = {}) {
  const state = {
    adviceCounter: 0,
    advisorInFlight: false,
    queuedAdvice: null,
    advisorQueueTimer: null,
    advisorBackoffUntil: 0,
    advisorErrorMutedUntil: 0,
    lastAdvisorStartedAt: 0,
    requestCount: 0
  };

  function immediateAdvice(text) {
    const result = instantAdviceForText(text);
    addAdvice('instant <200ms', result.message, result.label);
    return result;
  }

  async function request({ role, latestText, meta = {} }) {
    if (meta.sessionId && !isActiveSession(meta.sessionId)) {
      logEvent({ type: 'client.advisor_skipped', reason: 'stale_session', sessionId: meta.sessionId });
      return;
    }
    const currentNow = now();
    if (currentNow < state.advisorBackoffUntil) {
      const waitMs = Math.ceil(state.advisorBackoffUntil - currentNow);
      logEvent({ type: 'client.advisor_skipped', reason: 'backoff', waitMs });
      return;
    }
    if (state.advisorInFlight || currentNow - state.lastAdvisorStartedAt < ADVISOR_MIN_INTERVAL_MS) {
      state.queuedAdvice = { role, latestText, meta };
      const waitMs = state.advisorInFlight
        ? ADVISOR_MIN_INTERVAL_MS
        : Math.ceil(ADVISOR_MIN_INTERVAL_MS - (currentNow - state.lastAdvisorStartedAt));
      logEvent({ type: 'client.advisor_deferred', reason: state.advisorInFlight ? 'in_flight' : 'rate_limit', waitMs });
      scheduleQueuedAdvisor(waitMs);
      return;
    }

    const settings = getSettings();
    const transcript = getTranscript();
    const id = ++state.adviceCounter;
    const clientRequestId = `advisor-${wallNow().toString(36)}-${id}`;
    const started = now();
    state.advisorInFlight = true;
    state.lastAdvisorStartedAt = started;
    state.requestCount += 1;
    logEvent({
      type: 'client.advisor_request',
      id,
      count: state.requestCount,
      sessionId: meta.sessionId || null,
      source: meta.source || 'manual',
      responseId: meta.responseId || null,
      clientRequestId,
      deployment: settings.advisorDeployment,
      latestChars: String(latestText || '').length,
      transcriptItems: transcript.length,
      maxTokens: settings.advisorMaxTokens
    });
    try {
      const response = await fetchImpl('/api/advisor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deployment: settings.advisorDeployment,
          instructions: settings.advisorInstructions,
          reasoningEffort: settings.reasoningEffort,
          maxTokens: settings.advisorMaxTokens,
          latest: { role, text: latestText },
          transcript,
          clientRequestId,
          sessionId: meta.sessionId || null,
          source: meta.source || 'manual',
          responseId: meta.responseId || null,
          diagnostics: meta.diagnostics || {}
        })
      });
      if (meta.sessionId && !isActiveSession(meta.sessionId)) {
        logEvent({ type: 'client.advisor_result_ignored', reason: 'stale_session', sessionId: meta.sessionId, id });
        return;
      }
      const data = await safeJson(response);
      if (!response.ok) {
        const message = formatAdvisorError(data, response.status);
        logEvent({
          type: 'client.advisor_error',
          id,
          sessionId: meta.sessionId || null,
          responseId: meta.responseId || null,
          clientRequestId,
          status: response.status,
          error: data.error || response.statusText,
          endpoint: data.endpoint || null,
          responseHeaders: data.responseHeaders || null,
          serviceResponseText: data.serviceResponseText || null,
          serviceResponseBody: data.serviceResponseBody || null,
          retryAfterMs: data.retryAfterMs || 0,
          rateLimits: data.rateLimits || null,
          requestIds: data.requestIds || null,
          attempts: data.attempts || [],
          response: data
        });
        if (response.status === 429 || isAdvisorUnavailable(data)) {
          const serverRetryMs = Number(data.retryAfterMs) || 0;
          const attemptRetryMs = Math.max(0, ...(data.attempts || []).map((attempt) => Number(attempt.retryAfterMs) || 0));
          const backoffMs = response.status === 429
            ? Math.max(ADVISOR_BACKOFF_MS, serverRetryMs, attemptRetryMs)
            : ADVISOR_BACKOFF_MS * 10;
          state.advisorBackoffUntil = now() + backoffMs;
          state.advisorErrorMutedUntil = now() + ADVISOR_ERROR_MUTE_MS;
          state.queuedAdvice = null;
          addMetric(`Advisor skipped: ${response.status} / backoff=${Math.ceil(backoffMs / 1000)}s / ${settings.advisorDeployment}`);
          return;
        }
        throw new Error(message);
      }
      const ms = Math.round(now() - started);
      const label = data.label || 'good';
      const text = data.advice ? `${data.advice}${data.reason ? `\n理由: ${data.reason}` : ''}` : (data.text || '(no advice)');
      addAdvice(`LLM #${id}`, text, label, `${ms}ms / ${data.deployment || settings.advisorDeployment}`);
      addMetric(`Advisor: ${ms}ms / ${data.deployment || settings.advisorDeployment}`);
      logEvent({
        type: 'client.advisor_result',
        id,
        sessionId: meta.sessionId || null,
        responseId: meta.responseId || null,
        clientRequestId,
        latencyMs: ms,
        endpoint: data.endpoint || null,
        inputBudget: data.inputBudget || null,
        responseHeaders: data.responseHeaders || null,
        rateLimits: data.rateLimits || null
      });
      const rateLimitWaitMs = advisorRateLimitDelayMs(data.rateLimits);
      if (rateLimitWaitMs > ADVISOR_MIN_INTERVAL_MS) {
        state.advisorBackoffUntil = Math.max(state.advisorBackoffUntil, now() + rateLimitWaitMs);
        logEvent({
          type: 'client.advisor_rate_limit_wait',
          reason: 'remaining_requests_exhausted',
          waitMs: Math.ceil(rateLimitWaitMs),
          rateLimits: data.rateLimits || null
        });
      }
    } catch (error) {
      if (meta.sessionId && !isActiveSession(meta.sessionId)) {
        logEvent({ type: 'client.advisor_error_ignored', reason: 'stale_session', sessionId: meta.sessionId, id });
        return;
      }
      if (now() >= state.advisorErrorMutedUntil) {
        addAdvice(`LLM #${id}`, error.message || String(error), 'risk');
      }
    } finally {
      state.advisorInFlight = false;
      runQueuedAdvisor();
    }
  }

  function scheduleQueuedAdvisor(waitMs) {
    clearTimer(state.advisorQueueTimer);
    state.advisorQueueTimer = setTimer(runQueuedAdvisor, waitMs);
  }

  function runQueuedAdvisor() {
    if (!state.queuedAdvice || state.advisorInFlight) return;
    const currentNow = now();
    const nextAllowedAt = Math.max(state.advisorBackoffUntil, state.lastAdvisorStartedAt + ADVISOR_MIN_INTERVAL_MS);
    if (currentNow < nextAllowedAt) {
      scheduleQueuedAdvisor(Math.ceil(nextAllowedAt - currentNow));
      return;
    }
    const next = state.queuedAdvice;
    state.queuedAdvice = null;
    request({ role: next.role, latestText: next.latestText, meta: next.meta || {} });
  }

  function resetQueue() {
    clearTimer(state.advisorQueueTimer);
    state.advisorQueueTimer = null;
    state.queuedAdvice = null;
  }

  async function benchmark(models) {
    if (!canBenchmark()) return;
    const settings = getSettings();
    const deployments = (Array.isArray(models) ? models : String(models || settings.benchmarkAdvisorDeployments || '').split(','))
      .map((x) => String(x).trim())
      .filter(Boolean);
    if (!deployments.length) {
      addMetric('Benchmark: モデル名が空です。設定で benchmark deployments を入力してください。');
      return;
    }
    const plannedCalls = deployments.length * 3;
    if (!confirm(`助言LLMベンチは /api/advisor を ${plannedCalls} 回呼びます。実行しますか？`)) {
      addMetric(`Benchmark cancelled: planned advisor calls=${plannedCalls}`);
      return;
    }
    addMetric(`Benchmark start: ${deployments.join(', ')}`);
    const probeTranscript = [
      { role: 'assistant', text: '最近、出社が増えてきましたね。どうですか？' },
      { role: 'user', text: '正直、移動が面倒で集中もしにくいですね。' }
    ];
    for (const model of deployments) {
      const samples = [];
      for (let i = 0; i < 3; i += 1) {
        const started = now();
        try {
          const response = await fetchImpl('/api/advisor', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              deployment: model,
              instructions: settings.advisorInstructions,
              reasoningEffort: settings.reasoningEffort,
              maxTokens: settings.advisorMaxTokens,
              latest: probeTranscript[1],
              transcript: probeTranscript
            })
          });
          const data = await safeJson(response);
          if (!response.ok) throw new Error(data.error || response.statusText);
          samples.push(Math.round(now() - started));
        } catch (error) {
          addMetric(`Benchmark error / ${model}: ${error.message || error}`);
        }
      }
      if (samples.length) {
        const sorted = samples.slice().sort((a, b) => a - b);
        addMetric(`Benchmark / ${model}: samples=${samples.join(', ')}ms p50=${percentile(sorted, 0.5)}ms max=${sorted[sorted.length - 1]}ms`);
      }
    }
    addMetric('Benchmark done. Realtimeモデルは設定で切り替え、音声ターンの first audio を比較してください。');
  }

  function snapshot() {
    return { ...state };
  }

  return {
    immediateAdvice,
    request,
    benchmark,
    resetQueue,
    snapshot
  };
}

export function instantAdviceForText(text) {
  const t = String(text || '').trim();
  let label = 'good';
  let message = '相手に返す材料があります。次は一つだけ質問を足すと自然です。';

  if (/^(いや|違|でも|それは|だから|結論|要するに)/.test(t)) {
    label = 'risk';
    message = '否定や結論から入っています。先に一拍、受け止めを置くと摩擦が減ります。';
  } else if (/[？?]$/.test(t) || /(どう|どんな|最近|何か|ですか)/.test(t)) {
    label = 'good';
    message = '質問で相手に話す余地を作れています。長くしすぎなければ良い流れです。';
  } else if (t.length <= 8) {
    label = 'warn';
    message = '短すぎて会話が止まりやすいです。感想か軽い質問を一つ足すと続きます。';
  } else if (t.length > 90) {
    label = 'warn';
    message = '少し長いです。雑談では一文を短く切ると相手が入りやすくなります。';
  }
  return { label, message };
}

export function advisorRateLimitDelayMs(rateLimits) {
  if (!rateLimits || typeof rateLimits !== 'object') return 0;
  const remainingRequests = Number(rateLimits['x-ratelimit-remaining-requests']);
  if (!Number.isFinite(remainingRequests) || remainingRequests > 0) return 0;

  const retryAfterMs = Number(rateLimits['retry-after-ms']);
  const retryAfterSeconds = Number(rateLimits['retry-after']);
  const resetRequestsSeconds = Number(rateLimits['x-ratelimit-reset-requests']);
  const candidates = [
    Number.isFinite(retryAfterMs) ? retryAfterMs : 0,
    Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 0,
    Number.isFinite(resetRequestsSeconds) ? resetRequestsSeconds * 1000 : 0
  ].filter((value) => value > 0);
  if (!candidates.length) return 0;
  return Math.min(Math.max(...candidates), ADVISOR_BACKOFF_MS * 2);
}

export function isAdvisorUnavailable(data) {
  const code = String(data?.serviceResponseBody?.error?.code || data?.azureError?.code || data?.code || '').toLowerCase();
  const message = String(data?.serviceResponseText || data?.error || '').toLowerCase();
  return code.includes('unavailable_model') || message.includes('unavailable model');
}

export function formatAdvisorError(data, status) {
  const lines = [];
  if (data.serviceResponseText) lines.push(data.serviceResponseText);
  else if (data.error) lines.push(data.error);
  else lines.push(`HTTP ${status}`);

  const raw = {
    endpoint: data.endpoint || null,
    responseHeaders: data.responseHeaders || null,
    serviceResponseBody: data.serviceResponseBody || null,
    attempts: data.attempts || []
  };
  lines.push(JSON.stringify(raw, null, 2));
  return lines.join('\n');
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

async function safeJson(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { text }; }
}
