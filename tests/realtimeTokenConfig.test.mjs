import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _private } = require('../api/realtime-token');

test('realtime token defaults to stable realtime deployment', () => {
  assert.equal(_private.DEFAULT_REALTIME_DEPLOYMENT, 'gpt-realtime-1.5');
});

test('server-side realtime instructions append workplace chat guardrails', () => {
  const instructions = _private.safeInstructions('短く返してください。');

  assert.match(instructions, /短く返してください。/);
  assert.match(instructions, /暑さ、冷房、日差し、席、植物、におい/);
  assert.match(instructions, /医療・安全・健康指導に寄せず/);
  assert.ok(instructions.length <= 12000);
});

test('realtime session builder includes fixed guardrails even with client instructions', () => {
  const session = _private.buildRealtimeSession({
    voice: 'marin',
    instructions: '日本語で一文だけ。',
    realtimeDeployment: 'gpt-realtime-2'
  }, 'gpt-realtime-1.5');

  assert.equal(session.model, 'gpt-realtime-1.5');
  assert.match(session.instructions, /日本語で一文だけ。/);
  assert.match(session.instructions, /相手の発話に含まれない深刻なリスクを推測しない/);
});
