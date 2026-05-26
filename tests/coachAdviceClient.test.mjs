import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advisorRateLimitDelayMs,
  createCoachAdviceClient,
  instantAdviceForText,
  isAdvisorUnavailable
} from '../coachAdviceClient.mjs';

function response(body, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: String(status),
    text: async () => JSON.stringify(body)
  };
}

test('instant advice classifies common utterance shapes', () => {
  assert.equal(instantAdviceForText('いや、それは違います').label, 'risk');
  assert.equal(instantAdviceForText('どうですか?').label, 'good');
  assert.equal(instantAdviceForText('はい').label, 'warn');
  assert.equal(instantAdviceForText('あ'.repeat(91)).label, 'warn');
});

test('stale session requests are ignored before fetch', async () => {
  const events = [];
  const client = createCoachAdviceClient({
    isActiveSession: () => false,
    fetchImpl: async () => {
      throw new Error('should not fetch');
    },
    logEvent: (event) => events.push(event)
  });

  await client.request({ role: 'user', latestText: 'x', meta: { sessionId: 2 } });

  assert.equal(events[0].reason, 'stale_session');
});

test('in-flight request queues the latest request', async () => {
  let currentNow = 5000;
  const timers = [];
  const events = [];
  let resolveFetch;
  const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });
  const client = createCoachAdviceClient({
    getSettings: () => ({ advisorDeployment: 'd', advisorInstructions: 'i', reasoningEffort: 'none', advisorMaxTokens: 1024 }),
    getTranscript: () => [],
    fetchImpl: async () => fetchPromise,
    now: () => currentNow,
    wallNow: () => 1,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {},
    logEvent: (event) => events.push(event)
  });

  const first = client.request({ role: 'user', latestText: 'first' });
  await client.request({ role: 'user', latestText: 'second' });

  assert.equal(events.some((event) => event.type === 'client.advisor_deferred' && event.reason === 'in_flight'), true);
  assert.equal(timers[0].ms, 3000);

  resolveFetch(response({ label: 'good', advice: 'ok', deployment: 'd' }));
  currentNow = 5000;
  await first;
});

test('429 and unavailable model responses set mute/backoff without surfacing advice', async () => {
  let currentNow = 5000;
  const advice = [];
  const metrics = [];
  const client = createCoachAdviceClient({
    getSettings: () => ({ advisorDeployment: 'd', advisorInstructions: 'i', reasoningEffort: 'none', advisorMaxTokens: 1024 }),
    getTranscript: () => [],
    fetchImpl: async () => response({ error: 'rate', retryAfterMs: 70000 }, false, 429),
    now: () => currentNow,
    wallNow: () => 1,
    setTimer: () => 1,
    clearTimer: () => {},
    addAdvice: (...args) => advice.push(args),
    addMetric: (text) => metrics.push(text)
  });

  await client.request({ role: 'user', latestText: 'x' });
  assert.equal(advice.length, 0);
  assert.equal(metrics[0].includes('backoff=70s'), true);

  currentNow = 2000;
  await client.request({ role: 'user', latestText: 'x' });
  assert.equal(client.snapshot().advisorBackoffUntil, 75000);
});

test('rate limit headers calculate wait only when requests are exhausted', () => {
  assert.equal(advisorRateLimitDelayMs({ 'x-ratelimit-remaining-requests': '1', 'retry-after': '9' }), 0);
  assert.equal(advisorRateLimitDelayMs({ 'x-ratelimit-remaining-requests': '0', 'retry-after': '9' }), 9000);
  assert.equal(advisorRateLimitDelayMs({ 'x-ratelimit-remaining-requests': '0', 'retry-after-ms': '8000' }), 8000);
});

test('unavailable model detection checks code and message', () => {
  assert.equal(isAdvisorUnavailable({ serviceResponseBody: { error: { code: 'unavailable_model' } } }), true);
  assert.equal(isAdvisorUnavailable({ error: 'Unavailable model in region' }), true);
});
