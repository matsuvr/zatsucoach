import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiagnosticEventClient, sanitizeDiagnosticEvent } from '../diagnosticEventClient.mjs';

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body)
  };
}

test('sanitizeDiagnosticEvent keeps response diagnostics without transcript or secrets', () => {
  const item = sanitizeDiagnosticEvent({
    type: 'response.done',
    token: 'secret',
    transcript: '保存しない',
    response: {
      id: 'r1',
      status: 'incomplete',
      status_details: {
        type: 'incomplete',
        reason: 'content_filter',
        error: { code: 'x', message: 'blocked' }
      },
      usage: { total_tokens: 10, input_tokens: 7, output_tokens: 3 }
    }
  }, {
    at: '2026-05-27T05:58:27.000Z',
    sessionId: 1,
    deployment: 'gpt-realtime-2',
    connectionState: 'connected'
  });

  assert.equal(item.type, 'response.done');
  assert.equal(item.responseId, 'r1');
  assert.equal(item.status, 'incomplete');
  assert.equal(item.reason, 'content_filter');
  assert.equal(item.errorCode, 'x');
  assert.equal(item.details.usage.total_tokens, 10);
  assert.equal('transcript' in item, false);
  assert.equal('token' in item, false);
});

test('diagnostic client batches only allowlisted events', async () => {
  const calls = [];
  const client = createDiagnosticEventClient({
    canPersist: () => true,
    getContext: () => ({ sessionId: 3, deployment: 'gpt-realtime-2' }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return jsonResponse({ saved: 1 });
    },
    setTimer: () => 1,
    clearTimer: () => {},
    now: () => new Date('2026-05-27T05:58:27.000Z')
  });

  assert.equal(client.queue({ type: 'response.done', response: { id: 'r1', status: 'completed' } }), true);
  assert.equal(client.queue({ type: 'response.output_audio_transcript.done', transcript: '保存しない' }), false);
  await client.flush();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/diagnostic-events');
  assert.equal(calls[0].body.events.length, 1);
  assert.equal(calls[0].body.events[0].sessionId, '3');
});
