import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  buildChatCompletionBody,
  buildChatMessages,
  chatCompletionRoutes,
  chatCompletionUrl,
  derivedServicesEndpoint,
  trimTranscriptByBudget
} = require('../api/_shared/modelChat');
const { advisorDeployment } = require('../api/_shared/azureOpenAIConfig');

test('route selection handles Azure OpenAI and Foundry services endpoints', () => {
  assert.deepEqual(chatCompletionRoutes('https://demo.openai.azure.com', 'auto', 'gpt-5'), [
    { route: 'openai_v1', baseEndpoint: 'https://demo.openai.azure.com' }
  ]);
  assert.deepEqual(chatCompletionRoutes('https://demo.services.ai.azure.com', 'auto', 'gpt-5'), [
    { route: 'openai_v1', baseEndpoint: 'https://demo.services.ai.azure.com' },
    { route: 'foundry_models', baseEndpoint: 'https://demo.services.ai.azure.com' }
  ]);
});

test('Kimi aliases and openai endpoints add services.ai.azure.com fallback', () => {
  assert.equal(advisorDeployment('kimi-k2-6'), 'Kimi-K2.6');
  assert.equal(derivedServicesEndpoint('https://demo.openai.azure.com'), 'https://demo.services.ai.azure.com');
  assert.deepEqual(chatCompletionRoutes('https://demo.openai.azure.com', 'auto', 'Kimi-K2.6'), [
    { route: 'openai_v1', baseEndpoint: 'https://demo.openai.azure.com' },
    { route: 'foundry_models', baseEndpoint: 'https://demo.services.ai.azure.com' }
  ]);
});

test('request bodies match OpenAI v1 and Foundry Models route conventions', () => {
  const messages = [{ role: 'user', content: 'hello' }];
  assert.deepEqual(buildChatCompletionBody('openai_v1', {
    model: 'gpt-5',
    messages,
    maxTokens: 9999,
    temperature: 0.2,
    reasoningEffort: 'minimal'
  }), {
    model: 'gpt-5',
    messages,
    temperature: 0.2,
    n: 1,
    max_completion_tokens: 4096,
    reasoning_effort: 'minimal'
  });
  assert.deepEqual(buildChatCompletionBody('foundry_models', {
    model: 'Kimi-K2.6',
    messages,
    maxTokens: 512,
    temperature: 0.2,
    reasoningEffort: 'none'
  }), {
    model: 'Kimi-K2.6',
    messages,
    temperature: 0.2,
    max_tokens: 4096,
    thinking: { type: 'disabled' }
  });
});

test('chat completion urls preserve current API routes', () => {
  process.env.ADVISOR_MODEL_INFERENCE_API_VERSION = '2024-05-01-preview';
  assert.equal(
    chatCompletionUrl('https://demo.openai.azure.com', 'openai_v1'),
    'https://demo.openai.azure.com/openai/v1/chat/completions'
  );
  assert.equal(
    chatCompletionUrl('https://demo.services.ai.azure.com', 'foundry_models'),
    'https://demo.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview'
  );
});

test('token budget trimming keeps newest usable transcript items', () => {
  const transcript = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    text: `message ${index} ${'x'.repeat(20)}`
  }));
  const trimmed = trimTranscriptByBudget(transcript, { maxItems: 4, maxChars: 10000, maxTextChars: 100, maxTokens: 10000 });
  assert.deepEqual(trimmed.map((item) => item.text.slice(0, 9)), ['message 6', 'message 7', 'message 8', 'message 9']);
});

test('token budget trimming preserves compact transcript timing metadata', () => {
  const trimmed = trimTranscriptByBudget([{
    role: 'user',
    text: 'それ気になります',
    sourceId: 'u1',
    perfAt: 1400,
    startPerfAt: 1100,
    endPerfAt: 1400,
    durationMs: 300,
    approxSpeechMs: 250,
    avatarOverlapMs: 300,
    overlappedAvatar: true
  }]);

  assert.equal(trimmed[0].sourceId, 'u1');
  assert.equal(trimmed[0].avatarOverlapMs, 300);
  assert.equal(trimmed[0].overlappedAvatar, true);
});

test('chat messages prepend instructions and normalize transcript roles', () => {
  assert.deepEqual(buildChatMessages({
    instructions: 'system',
    transcript: [{ role: 'assistant', text: 'a' }, { role: 'other', text: 'b' }]
  }), [
    { role: 'system', content: 'system' },
    { role: 'assistant', content: 'a' },
    { role: 'user', content: 'b' }
  ]);
});
