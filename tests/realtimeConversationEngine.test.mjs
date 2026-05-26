import assert from 'node:assert/strict';
import test from 'node:test';
import { createRealtimeConversationEngine, hasUsefulTranscript, userTurnDecision } from '../realtimeConversationEngine.mjs';

function createHarness(settings = {}) {
  let currentNow = 1000;
  let nextTimerId = 1;
  const timers = new Map();
  const effects = [];
  const engine = createRealtimeConversationEngine({
    getSettings: () => ({
      realtimeDeployment: 'gpt-realtime-2',
      vadSilenceMs: 650,
      vadMinSpeechMs: 450,
      ...settings
    }),
    emit: (effect) => effects.push(effect),
    now: () => currentNow,
    setTimer: (fn, ms) => {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { fn, ms, cleared: false });
      return id;
    },
    clearTimer: (id) => {
      if (timers.has(id)) timers.get(id).cleared = true;
    }
  });

  function begin(tokenData = {}) {
    engine.beginSession({
      sessionId: 1,
      expectedVoice: 'marin',
      tokenData: {
        configMode: 'client_secret_session',
        requiresClientSessionUpdate: false,
        session: { voice: 'marin' },
        ...tokenData
      }
    });
    engine.handleDataChannelOpen();
  }

  function runTimers(ms) {
    const runnable = Array.from(timers.entries())
      .filter(([, timer]) => !timer.cleared && (ms === undefined || timer.ms === ms));
    for (const [id, timer] of runnable) {
      timer.cleared = true;
      timers.delete(id);
      timer.fn();
    }
  }

  function advance(ms) {
    currentNow += ms;
  }

  function byType(type) {
    return effects.filter((effect) => effect.type === type);
  }

  function sentEvents(type) {
    return byType('sendClientEvent')
      .map((effect) => effect.event)
      .filter((event) => !type || event.type === type);
  }

  return { engine, effects, begin, runTimers, advance, byType, sentEvents };
}

test('short noise is deleted without creating a response', () => {
  const h = createHarness();
  h.begin();
  h.effects.length = 0;

  h.engine.handleServerEvent({ type: 'input_audio_buffer.speech_started', item_id: 'u1', audio_start_ms: 0 });
  h.advance(100);
  h.engine.handleServerEvent({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1', audio_end_ms: 1000 });
  h.runTimers(800);

  assert.equal(h.sentEvents('response.create').length, 0);
  assert.deepEqual(h.sentEvents('conversation.item.delete'), [
    { type: 'conversation.item.delete', item_id: 'u1' }
  ]);
  assert.equal(h.byType('logEvent').some((effect) => effect.event.type === 'client.noise_turn_ignored'), true);
});

test('useful transcript publishes once and sends the minimal response.create payload', () => {
  const h = createHarness();
  h.begin();
  h.effects.length = 0;

  h.engine.handleServerEvent({ type: 'input_audio_buffer.speech_started', item_id: 'u1', audio_start_ms: 0 });
  h.advance(100);
  h.engine.handleServerEvent({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1', audio_end_ms: 1000 });
  h.engine.handleServerEvent({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'u1',
    content_index: 0,
    transcript: '最近どうですか'
  });
  h.engine.handleServerEvent({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'u1',
    content_index: 0,
    transcript: '最近どうですか'
  });

  assert.equal(h.byType('addTranscript').filter((effect) => effect.role === 'user').length, 1);
  assert.deepEqual(h.sentEvents('response.create'), [{ type: 'response.create' }]);
});

test('accepted turn is deferred while a response is active and sent after response.done', () => {
  const h = createHarness();
  h.begin();
  h.effects.length = 0;

  acceptTranscriptTurn(h, 'u1', '最初の話です');
  h.engine.handleServerEvent({ type: 'response.created', response: { id: 'r1' } });
  acceptTranscriptTurn(h, 'u2', '次の話です');

  assert.equal(h.sentEvents('response.create').length, 1);
  assert.equal(h.byType('logEvent').some((effect) => effect.event.type === 'client.manual_response_create_deferred'), true);

  h.engine.handleServerEvent({ type: 'response.done', response: { id: 'r1', status: 'completed' } });

  assert.equal(h.sentEvents('response.create').length, 2);
});

test('assistant transcript flushes once and schedules one advisor request', () => {
  const h = createHarness();
  h.begin();
  h.effects.length = 0;

  h.engine.handleServerEvent({ type: 'response.created', response: { id: 'r1' } });
  h.engine.handleServerEvent({
    type: 'response.output_audio_transcript.done',
    response_id: 'r1',
    item_id: 'a1',
    output_index: 0,
    content_index: 0,
    transcript: 'こんにちは'
  });
  h.engine.handleServerEvent({
    type: 'response.output_audio_transcript.done',
    response_id: 'r1',
    item_id: 'a1',
    output_index: 0,
    content_index: 0,
    transcript: 'こんにちは'
  });
  h.engine.handleServerEvent({ type: 'response.done', response: { id: 'r1', status: 'completed' } });

  assert.equal(h.byType('addTranscript').filter((effect) => effect.role === 'assistant').length, 1);
  assert.equal(h.byType('scheduleAdvisorFromRealtimeResponse').length, 1);
  assert.equal(h.byType('logEvent').some((effect) => effect.event.reason === 'duplicate_done'), true);
});

test('avatar audio does not disable microphone capture', () => {
  const h = createHarness();
  h.begin();
  h.effects.length = 0;

  h.engine.handleServerEvent({ type: 'response.created', response: { id: 'r1' } });
  h.engine.handleServerEvent({ type: 'output_audio_buffer.started', response_id: 'r1' });

  assert.equal(h.byType('setMicrophoneEnabled').some((effect) => effect.enabled === false), false);
  assert.equal(h.byType('setAvatarSpeaking').at(-1).speaking, true);
});

test('overlapped user speech is transcribed while avatar response continues', () => {
  const h = createHarness();
  h.begin();
  h.effects.length = 0;

  h.engine.handleServerEvent({ type: 'response.created', response: { id: 'r1' } });
  h.engine.handleServerEvent({ type: 'output_audio_buffer.started', response_id: 'r1' });
  h.advance(100);
  h.engine.handleServerEvent({ type: 'input_audio_buffer.speech_started', item_id: 'u1', audio_start_ms: 0 });
  h.advance(300);
  h.engine.handleServerEvent({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1', audio_end_ms: 1300 });
  h.engine.handleServerEvent({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'u1',
    content_index: 0,
    transcript: 'それ気になります'
  });

  assert.equal(h.byType('addTranscript').filter((effect) => effect.role === 'user').length, 1);
  assert.equal(h.byType('addTranscript').find((effect) => effect.role === 'user').options.avatarOverlapMs, 300);
  assert.equal(h.byType('logEvent').some((effect) => effect.event.type === 'client.manual_response_create_deferred'), true);
  assert.equal(h.sentEvents('response.create').length, 0);

  h.engine.handleServerEvent({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
  h.engine.handleServerEvent({ type: 'output_audio_buffer.stopped', response_id: 'r1' });

  assert.equal(h.sentEvents('response.create').length, 1);
});

test('incomplete response warns and does not schedule advisor', () => {
  const h = createHarness();
  h.begin();
  h.effects.length = 0;

  h.engine.handleServerEvent({ type: 'response.created', response: { id: 'r1' } });
  h.engine.handleServerEvent({
    type: 'response.done',
    response: {
      id: 'r1',
      status: 'incomplete',
      status_details: { reason: 'max_output_tokens' }
    }
  });

  assert.equal(h.byType('scheduleAdvisorFromRealtimeResponse').length, 0);
  assert.equal(h.byType('addAdvice').some((effect) => effect.label === 'warn' && effect.text.includes('max_output_tokens')), true);
});

test('context pruning deletes only older completed conversation items', () => {
  const h = createHarness();
  h.begin();
  h.effects.length = 0;

  for (let i = 0; i < 36; i += 1) {
    h.engine.handleServerEvent({
      type: 'conversation.item.created',
      item: {
        id: `old-${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        type: 'message',
        status: 'completed',
        content: []
      }
    });
  }
  acceptTranscriptTurn(h, 'current', 'これは今の発話です');

  const deletes = h.sentEvents('conversation.item.delete');
  assert.equal(deletes.length, 8);
  assert.equal(deletes.some((event) => event.item_id === 'current'), false);
  assert.deepEqual(deletes.map((event) => event.item_id), [
    'old-0',
    'old-1',
    'old-2',
    'old-3',
    'old-4',
    'old-5',
    'old-6',
    'old-7'
  ]);
});

test('voice mismatch stops session before microphone is enabled', () => {
  const h = createHarness();
  h.begin({ session: { voice: 'cedar' } });

  assert.equal(h.byType('stopRealtime').length, 1);
  assert.equal(h.byType('setMicrophoneEnabled').some((effect) => effect.enabled), false);
});

test('stop clears timers so stale watchdogs do not emit effects', () => {
  const h = createHarness();
  h.begin();
  h.engine.stop();
  h.effects.length = 0;

  h.runTimers();

  assert.equal(h.effects.length, 0);
});

test('transcript and turn helpers capture known noise and useful short replies', () => {
  assert.equal(hasUsefulTranscript('ピン'), false);
  assert.equal(hasUsefulTranscript('はい'), true);
  assert.deepEqual(userTurnDecision({ transcriptText: '', approxSpeechMs: 100 }, { vadMinSpeechMs: 450 }), {
    accept: false,
    reason: 'short_noise'
  });
  assert.deepEqual(userTurnDecision({ transcriptText: '', approxSpeechMs: 600 }, { vadMinSpeechMs: 450 }), {
    accept: true,
    reason: 'duration'
  });
});

function acceptTranscriptTurn(h, itemId, transcript) {
  h.engine.handleServerEvent({ type: 'input_audio_buffer.speech_started', item_id: itemId, audio_start_ms: 0 });
  h.advance(100);
  h.engine.handleServerEvent({ type: 'input_audio_buffer.speech_stopped', item_id: itemId, audio_end_ms: 1000 });
  h.engine.handleServerEvent({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    content_index: 0,
    transcript
  });
}
