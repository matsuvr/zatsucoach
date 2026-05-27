import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canUseInteractiveFeatures,
  compactEvent,
  escapeHtml,
  finiteNumber,
  formatApiError,
  isActiveRealtimeSession,
  labelToClass,
  latestTranscriptByRole,
  microphoneAudioConstraints,
  normalizeAdvisorDeploymentSetting,
  normalizeNoiseReductionSetting,
  normalizePublicAccess,
  safeJson,
  shouldShowStageAdvice,
  transcriptBySourceId,
  transcriptTimingMeta
} from '../appUtils.mjs';

test('setting normalizers preserve supported values and aliases', () => {
  assert.equal(normalizeAdvisorDeploymentSetting('kimi-k2-6'), 'Kimi-K2.6');
  assert.equal(normalizeAdvisorDeploymentSetting('gpt-realtime-2'), 'gpt-realtime-2');
  assert.equal(normalizeNoiseReductionSetting('near_field'), 'near_field');
  assert.equal(normalizeNoiseReductionSetting('bad-mode'), 'far_field');
});

test('public access predicates depend only on explicit inputs', () => {
  const principal = { userDetails: 'user@example.test' };
  assert.deepEqual(normalizePublicAccess({ ended: true }, principal), {
    ended: true,
    exempt: false,
    canUseInteractiveFeatures: false,
    logAccess: 'read-only',
    message: '公開期間を終了しました'
  });
  assert.equal(canUseInteractiveFeatures(principal, { canUseInteractiveFeatures: true }), true);
  assert.equal(canUseInteractiveFeatures(null, { canUseInteractiveFeatures: true }), false);
});

test('transcript lookups are pure scans over provided transcript', () => {
  const transcript = [
    { role: 'user', text: 'old', sourceId: 'u1', perfAt: 10 },
    { role: 'assistant', text: 'avatar', sourceId: 'a1', perfAt: 20 },
    { role: 'user', text: 'new', sourceId: 'u2', perfAt: 30, durationMs: 12 }
  ];
  assert.equal(transcriptBySourceId(transcript, 'user', 'u2').text, 'new');
  assert.equal(latestTranscriptByRole(transcript, 'user', 20).sourceId, 'u2');
  assert.deepEqual(transcriptTimingMeta(transcript[2]), {
    latestUserItemId: 'u2',
    latestUserStartPerfAt: 0,
    latestUserEndPerfAt: 30,
    latestUserDurationMs: 12,
    latestUserAvatarOverlapMs: 0,
    latestUserOverlappedAvatar: false
  });
});

test('formatting utilities keep unsafe or noisy data contained', async () => {
  assert.equal(escapeHtml('<x a="b">&'), '&lt;x a=&quot;b&quot;&gt;&amp;');
  assert.equal(labelToClass('risk'), 'risk');
  assert.equal(labelToClass('unknown'), 'good');
  assert.equal(finiteNumber('12.5'), 12.5);
  assert.equal(finiteNumber('nan'), 0);
  assert.deepEqual(await safeJson({ text: async () => '{"ok":true}' }), { ok: true });
  assert.deepEqual(await safeJson({ text: async () => 'plain' }), { text: 'plain' });
});

test('event compaction removes secrets and abbreviates large payloads', () => {
  const compact = compactEvent({
    type: 'x',
    token: 'secret',
    instructions: 'a'.repeat(4),
    delta: 'b'.repeat(130),
    request: { messages: [{}, {}] }
  });
  assert.equal('token' in compact, false);
  assert.equal(compact.instructions, '[4 chars]');
  assert.equal(compact.delta.endsWith('…'), true);
  assert.equal(compact.request.messages, '[2 messages]');
});

test('small pure predicates and payload builders are deterministic', () => {
  assert.equal(isActiveRealtimeSession(2, '2'), true);
  assert.equal(shouldShowStageAdvice('LLM advisor'), true);
  assert.equal(shouldShowStageAdvice('app'), false);
  assert.deepEqual(microphoneAudioConstraints('remote-only'), {
    echoCancellation: 'remote-only',
    noiseSuppression: true,
    autoGainControl: true
  });
  assert.equal(
    formatApiError({ error: 'failed', status: 429, deployment: 'dep' }, 'fallback'),
    'failed (status=429, deployment=dep)'
  );
});
