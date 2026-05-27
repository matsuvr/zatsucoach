import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeDiagnosticEvents } = require('../api/_shared/logStore');

const user = {
  safeUserId: 'userhash'
};

test('normalizeDiagnosticEvents stores safe diagnostic details by user and day', () => {
  const events = normalizeDiagnosticEvents(user, {
    events: [{
      type: 'response.done',
      at: '2026-05-27T05:58:27.000Z',
      sessionId: '12',
      deployment: 'gpt-realtime-2',
      status: 'incomplete',
      reason: 'content_filter',
      details: {
        statusDetails: {
          reason: 'content_filter',
          error: { code: 'policy', message: 'filtered' }
        },
        token: 'secret',
        transcript: '保存しない'
      }
    }]
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].partitionKey, 'userhash_20260527');
  assert.equal(events[0].type, 'response.done');
  assert.equal(events[0].sessionId, '12');
  assert.equal(events[0].reason, 'content_filter');
  assert.match(events[0].detailsJson, /content_filter/);
  assert.doesNotMatch(events[0].detailsJson, /secret|保存しない/);
});

test('normalizeDiagnosticEvents drops unsupported event types', () => {
  const events = normalizeDiagnosticEvents(user, {
    events: [{
      type: 'response.output_audio_transcript.done',
      transcript: '保存しない'
    }]
  });

  assert.equal(events.length, 0);
});
