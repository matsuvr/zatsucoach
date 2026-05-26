import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversationLogClient, defaultTitleSummary, shouldPersistAdvice } from '../conversationLogClient.mjs';

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body
  };
}

test('creates a session on first flush and batches queued items', async () => {
  const calls = [];
  const client = createConversationLogClient({
    canPersist: () => true,
    getTranscript: () => [{ role: 'user', text: '最初の発話です' }],
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: options?.body ? JSON.parse(options.body) : null });
      if (url === '/api/log-sessions') return jsonResponse({ sessionId: 's1' });
      return jsonResponse({});
    },
    setTimer: () => 1,
    clearTimer: () => {}
  });

  client.queueTranscript({
    role: 'user',
    text: 'hello',
    at: '2026-01-01T00:00:00Z',
    perfAt: 12,
    startPerfAt: 10,
    endPerfAt: 40,
    durationMs: 30,
    avatarOverlapMs: 20,
    overlappedAvatar: true
  });
  await client.flush();

  assert.equal(calls[0].url, '/api/log-sessions');
  assert.equal(calls[0].body.title, '最初の発話です');
  assert.equal(calls[1].url, '/api/log-items');
  assert.equal(calls[1].body.sessionId, 's1');
  assert.equal(calls[1].body.items.length, 1);
  assert.equal(calls[1].body.items[0].meta.avatarOverlapMs, 20);
  assert.equal(calls[1].body.items[0].meta.overlappedAvatar, true);
  assert.equal(calls[1].body.summary.transcriptCount, 1);
});

test('retry preserves failed items', async () => {
  const errors = [];
  const client = createConversationLogClient({
    canPersist: () => true,
    getTranscript: () => [{ role: 'user', text: 'first' }],
    fetchImpl: async (url) => {
      if (url === '/api/log-sessions') return jsonResponse({ sessionId: 's1' });
      return jsonResponse({ error: 'fail' }, false, 500);
    },
    setTimer: () => 1,
    clearTimer: () => {},
    onError: (event) => errors.push(event)
  });

  client.queueTranscript({ role: 'user', text: 'hello', at: '2026-01-01T00:00:00Z' });
  await client.flush();

  assert.equal(client.snapshot().pendingCount, 1);
  assert.equal(errors[0].type, 'client.log_save_failed');
});

test('close patches summary and reset clears counters', async () => {
  const calls = [];
  const client = createConversationLogClient({
    canPersist: () => true,
    getTranscript: () => [{ role: 'user', text: 'first' }],
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: options?.body ? JSON.parse(options.body) : null });
      if (url === '/api/log-sessions' && options?.method === 'POST') return jsonResponse({ sessionId: 's1' });
      return jsonResponse({});
    },
    now: () => new Date('2026-01-01T00:00:00Z'),
    setTimer: () => 1,
    clearTimer: () => {}
  });

  client.queueAdvice({ source: 'LLM #1', text: 'advice', label: 'good' });
  await client.close('done');

  const patch = calls.find((call) => call.url === '/api/log-sessions' && call.options.method === 'PATCH');
  assert.equal(patch.body.closeReason, 'done');
  assert.equal(patch.body.adviceCount, 1);
  assert.equal(client.snapshot().itemCount, 0);
});

test('loads and deletes saved sessions through API', async () => {
  const calls = [];
  const client = createConversationLogClient({
    canPersist: () => true,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.startsWith('/api/log-sessions?limit=')) return jsonResponse({ sessions: [{ sessionId: 's1' }] });
      if (url.startsWith('/api/log-items?sessionId=')) return jsonResponse({ items: [{ text: 'x' }] });
      return jsonResponse({});
    }
  });

  assert.deepEqual(await client.loadSessions(5), [{ sessionId: 's1' }]);
  assert.deepEqual(await client.loadItems('s1'), [{ text: 'x' }]);
  assert.equal(await client.deleteSession('s1'), true);
  assert.equal(calls[2].options.method, 'DELETE');
});

test('advice persistence and title helpers match UI rules', () => {
  assert.equal(shouldPersistAdvice('LLM #1'), true);
  assert.equal(shouldPersistAdvice('instant <200ms'), true);
  assert.equal(shouldPersistAdvice('app'), false);
  assert.equal(defaultTitleSummary('1234567890', 6), '12345…');
});
