const DEFAULTS = Object.freeze({
  vadSilenceMs: 650,
  vadMinSpeechMs: 450
});

const VAD_PREFIX_PADDING_MS = 300;
const USER_TURN_TRANSCRIPT_WAIT_MS = 800;
const ASSISTANT_RESPONSE_FALLBACK_FLUSH_MS = 2500;
const REALTIME_CONTEXT_PRUNE_AFTER_ITEMS = 34;
const REALTIME_CONTEXT_KEEP_ITEMS = 28;
const REALTIME_CONTEXT_MAX_DELETES_PER_TURN = 8;
const REALTIME_RESPONSE_CREATE_TIMEOUT_MS = 8000;
const REALTIME_RESPONSE_TIMEOUT_MS = 45000;
const OUTPUT_AUDIO_STOP_TIMEOUT_MS = 20000;
const TIMELINE_INTERVAL_KEEP_ITEMS = 60;

export function createRealtimeConversationEngine({
  getSettings = () => ({}),
  emit = () => {},
  now = () => performance.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  const state = createInitialState();

  function effect(type, payload = {}) {
    emit({ type, ...payload });
  }

  function beginSession({ sessionId, expectedVoice, tokenData }) {
    resetRuntimeState();
    state.active = true;
    state.sessionId = Number(sessionId) || 0;
    state.expectedVoice = String(expectedVoice || '').trim().toLowerCase();
    state.clientSessionUpdateRequired = Boolean(tokenData?.requiresClientSessionUpdate);
    state.tokenData = tokenData || null;
  }

  function handleDataChannelOpen() {
    if (!isActive()) return;
    const tokenData = state.tokenData || {};
    effect('setConnectionLoading', { loading: true, text: '接続設定を確認しています' });
    effect('setConnectionStatus', { text: 'configuring session' });
    effect('addAdvice', {
      source: 'app',
      text: 'Realtime接続を確立しました。サーバー側で固定した音声設定を確認しています。',
      label: 'good'
    });
    scheduleRealtimeSessionWatchdog();
    if (tokenData.requiresClientSessionUpdate) {
      sendClientSessionUpdate(tokenData.sessionConfig);
    } else {
      confirmRealtimeSession({ session: tokenData.session }, 'client_secret_session');
    }
    effect('logEvent', {
      event: {
        type: 'client.data_channel_open',
        sessionId: state.sessionId,
        configMode: tokenData.configMode || 'unknown'
      }
    });
  }

  function handleDataChannelClose() {
    if (!isActive()) return;
    effect('logEvent', { event: { type: 'client.data_channel_close', sessionId: state.sessionId } });
    if (!state.realtimeSessionConfigured) effect('setConnectionLoading', { loading: false });
    effect('setConnectionStatus', { text: 'closed' });
  }

  function handleDataChannelError(error) {
    if (!isActive()) return;
    effect('logEvent', {
      event: {
        type: 'client.data_channel_error',
        sessionId: state.sessionId,
        error: String(error?.message || error)
      }
    });
  }

  function handleServerEvent(event) {
    if (!isActive()) return;
    effect('logEvent', { event: { ...event, sessionId: state.sessionId } });
    switch (event.type) {
      case 'session.created':
        confirmRealtimeSession(event, 'session_created');
        break;
      case 'session.updated':
        confirmRealtimeSession(event, 'session_updated');
        break;
      case 'input_audio_buffer.speech_started':
        startUserTurn(event);
        break;
      case 'input_audio_buffer.speech_stopped':
        stopUserTurn(event);
        break;
      case 'input_audio_buffer.committed':
        markUserTurnCommitted(event);
        break;
      case 'response.created':
        handleResponseCreated(event);
        break;
      case 'response.content_part.added':
        markAssistantAudioExpected(event);
        break;
      case 'conversation.item.created':
      case 'conversation.item.added':
      case 'conversation.item.retrieved':
      case 'conversation.item.done':
        handleConversationItem(event);
        break;
      case 'conversation.item.deleted':
        forgetRealtimeConversationItem(event.item_id);
        break;
      case 'conversation.item.input_audio_transcription.delta':
      case 'conversation.item.audio_transcription.delta':
        appendUserTranscriptDelta(event);
        break;
      case 'conversation.item.input_audio_transcription.completed':
      case 'conversation.item.audio_transcription.completed':
        completeUserTranscript(event);
        break;
      case 'conversation.item.input_audio_transcription.failed':
      case 'conversation.item.audio_transcription.failed':
        effect('logEvent', {
          event: {
            type: 'client.user_transcription_failed',
            sessionId: state.sessionId,
            item_id: event.item_id || null,
            error: event.error?.message || event.error || null
          }
        });
        break;
      case 'output_audio_buffer.started':
        markOutputAudioStarted(event);
        break;
      case 'output_audio_buffer.stopped':
        markOutputAudioStopped(event);
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
      case 'response.output_text.delta':
      case 'response.text.delta':
        recordAssistantTextDelta(event);
        break;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
      case 'response.output_text.done':
      case 'response.text.done':
        recordAssistantTextDone(event);
        break;
      case 'response.done':
        markRealtimeResponseDone(event.response?.id || event.response_id);
        updateAssistantResponseMeta(event.response?.id || event.response_id, responseMetaFromDoneEvent(event));
        flushAssistantResponse(event.response?.id || event.response_id, 'response_done');
        finishAvatarAudioOutput('response_done');
        break;
      case 'error':
      case 'session.error':
        clearPendingResponseCreate();
        effect('addAdvice', {
          source: 'app',
          text: `Realtime error: ${event.error?.message || JSON.stringify(event.error || event)}`,
          label: 'risk'
        });
        effect('setAvatarMood', { mood: 'caution' });
        finishAvatarAudioOutput('realtime_error');
        break;
      default:
        break;
    }
  }

  function sendTextTurn(text) {
    if (!isActive()) return;
    state.lastSpeechStoppedAt = now();
    effect('sendClientEvent', {
      event: {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }]
        }
      }
    });
    effect('sendClientEvent', { event: { type: 'response.create' } });
    effect('logEvent', {
      event: {
        type: 'client.text_sent_to_realtime',
        sessionId: state.sessionId
      }
    });
  }

  function stop() {
    resetRuntimeState();
  }

  function clearUserTranscriptState() {
    clearUserTurnState();
    state.userTextByItem.clear();
    state.userItemSpeechStoppedAt.clear();
    state.processedUserTranscriptKeys.clear();
  }

  function hasActiveResponse() {
    return state.pendingRealtimeResponseCreate
      || state.activeRealtimeResponseIds.size > 0
      || state.activeAssistantAudioResponseIds.size > 0
      || state.avatarSpeaking;
  }

  function isConfigured() {
    return Boolean(state.realtimeSessionConfigured);
  }

  function isActive() {
    return state.active && state.sessionId > 0;
  }

  function sendClientSessionUpdate(sessionConfig) {
    if (!isActive() || !sessionConfig) return;
    effect('sendClientEvent', { event: { type: 'session.update', session: sessionConfig } });
    effect('logEvent', {
      event: {
        type: 'client.session_update_sent',
        sessionId: state.sessionId,
        advisorSource: 'realtime_response_transcript',
        voice: sessionConfig.audio?.output?.voice || null
      }
    });
  }

  function scheduleRealtimeSessionWatchdog() {
    state.realtimeSessionConfigured = false;
    clearStoredTimer('sessionUpdateWatchdogTimer');
    state.sessionUpdateWatchdogTimer = setTimer(() => {
      if (!isActive() || state.realtimeSessionConfigured) return;
      effect('logEvent', {
        event: {
          type: 'client.session_ready_timeout',
          sessionId: state.sessionId,
          voice: state.expectedVoice
        }
      });
      effect('addAdvice', {
        source: 'app',
        text: 'Realtimeの音声設定を確認できないため、マイク入力を開始せず接続を閉じます。',
        label: 'risk'
      });
      effect('stopRealtime', { showMessage: false, sessionId: state.sessionId });
    }, 4000);
  }

  function confirmRealtimeSession(event, source) {
    if (source === 'session_created' && state.clientSessionUpdateRequired) {
      effect('logEvent', {
        event: {
          type: 'client.session_created_before_update_ack',
          sessionId: state.sessionId,
          expectedVoice: state.expectedVoice
        }
      });
      return;
    }

    const voice = event.session?.audio?.output?.voice || event.session?.voice || null;
    if (voice && state.expectedVoice && voice !== state.expectedVoice) {
      effect('logEvent', {
        event: {
          type: 'client.realtime_voice_mismatch',
          sessionId: state.sessionId,
          source,
          expected: state.expectedVoice,
          actual: voice
        }
      });
      effect('addAdvice', {
        source: 'app',
        text: `Realtime voice mismatch: expected=${state.expectedVoice}, actual=${voice}`,
        label: 'risk'
      });
      effect('stopRealtime', { showMessage: false, sessionId: state.sessionId });
      return;
    }

    if (state.realtimeSessionConfigured) return;
    state.clientSessionUpdateRequired = false;
    state.realtimeSessionConfigured = true;
    effect('setConnectionLoading', { loading: false });
    clearStoredTimer('sessionUpdateWatchdogTimer');
    effect('setMicrophoneEnabled', {
      enabled: true,
      reason: 'session_configured',
      sessionId: state.sessionId
    });
    effect('setConnectionStatus', { text: 'connected' });
    effect('addAdvice', {
      source: 'app',
      text: '接続しました。短い雑談を話しかけてください。',
      label: 'good'
    });
    effect('logEvent', {
      event: {
        type: 'client.session_configured',
        sessionId: state.sessionId,
        source,
        advisorSource: 'realtime_response_transcript',
        voice: voice || state.expectedVoice || null
      }
    });
  }

  function markOutputAudioStarted(event) {
    markAssistantAudioExpected(event);
    state.avatarSpeaking = true;
    if (!state.activeAvatarAudioStartedAt) state.activeAvatarAudioStartedAt = now();
    effect('setAvatarSpeaking', { speaking: true });
    effect('setAvatarMood', { mood: 'speaking' });
    effect('setConnectionStatus', { text: 'avatar speaking' });
    updateAssistantResponseMeta(event.response_id, { outputAudioStartedAt: now() });
    if (state.lastSpeechStoppedAt) {
      const ms = Math.round(now() - state.lastSpeechStoppedAt);
      effect('recordFirstAudioLatency', {
        ms,
        deployment: getSettings().realtimeDeployment
      });
    }
  }

  function markOutputAudioStopped(event) {
    if (event.response_id || event.item_id) {
      state.activeAssistantAudioResponseIds.delete(audioOutputKey(event));
      clearOutputAudioStopWatchdog(audioOutputKey(event));
    } else {
      state.activeAssistantAudioResponseIds.clear();
      clearAllOutputAudioStopWatchdogs();
    }
    finishAvatarAudioOutput('avatar_finished');
    updateAssistantResponseMeta(event.response_id, { outputAudioStoppedAt: now() });
    if (event.response_id) scheduleAssistantResponseFlush(event.response_id, 300, 'output_audio_buffer_stopped');
  }

  function recordAssistantTextDelta(event) {
    if (event.type.includes('audio_transcript')) markAssistantAudioExpected(event);
    const key = responseContentKey(event);
    const nextText = `${state.assistantTextByResponse.get(key) || ''}${event.delta || ''}`;
    state.assistantTextByResponse.set(key, nextText);
    state.currentAssistantText += event.delta || '';
  }

  function recordAssistantTextDone(event) {
    if (event.type.includes('audio_transcript')) markAssistantAudioExpected(event);
    const contentKey = responseContentKey(event);
    const doneKey = responseDoneKey(event, contentKey);
    if (state.processedAssistantResponseKeys.has(doneKey)) {
      effect('logEvent', {
        event: {
          type: 'client.advisor_skipped',
          sessionId: state.sessionId,
          reason: 'duplicate_done',
          key: doneKey
        }
      });
      return;
    }
    state.processedAssistantResponseKeys.add(doneKey);
    trimSet(state.processedAssistantResponseKeys, 80, 40);
    const text = (event.transcript || event.text || state.assistantTextByResponse.get(contentKey) || state.currentAssistantText || '').trim();
    state.assistantTextByResponse.delete(contentKey);
    if (text) {
      recordAssistantResponsePart(event, contentKey, text);
      scheduleAssistantResponseFlush(event.response_id || contentKey, ASSISTANT_RESPONSE_FALLBACK_FLUSH_MS, 'transcript_done_fallback');
    }
    state.currentAssistantText = '';
  }

  function responseContentKey(event) {
    return [
      event.response_id || 'no-response',
      event.item_id || 'no-item',
      event.output_index ?? 0,
      event.content_index ?? 0
    ].join(':');
  }

  function responseDoneKey(event, contentKey) {
    return [
      contentKey,
      event.type || 'done'
    ].join(':');
  }

  function audioOutputKey(event) {
    return event.response_id || event.item_id || 'active-output-audio';
  }

  function markAssistantAudioExpected(event) {
    const partType = event.part?.type || event.content?.type || '';
    const isAudioEvent = String(event.type || '').includes('audio') || partType === 'audio' || partType === 'output_audio';
    if (!isAudioEvent) return;
    const key = audioOutputKey(event);
    if (!key || key === 'active-output-audio') return;
    state.activeAssistantAudioResponseIds.add(key);
    if (String(event.type || '').includes('started')) return;
    scheduleOutputAudioStopWatchdog(key);
  }

  function scheduleOutputAudioStopWatchdog(key) {
    if (!key) return;
    clearTimer(state.outputAudioStopWatchdogTimers.get(key));
    state.outputAudioStopWatchdogTimers.set(key, setTimer(() => {
      if (!isActive() || !state.activeAssistantAudioResponseIds.has(key)) return;
      state.activeAssistantAudioResponseIds.delete(key);
      state.outputAudioStopWatchdogTimers.delete(key);
      effect('logEvent', {
        event: {
          type: 'client.output_audio_stop_watchdog_released',
          sessionId: state.sessionId,
          key,
          timeoutMs: OUTPUT_AUDIO_STOP_TIMEOUT_MS
        }
      });
      finishAvatarAudioOutput('output_audio_stop_watchdog');
    }, OUTPUT_AUDIO_STOP_TIMEOUT_MS));
  }

  function clearOutputAudioStopWatchdog(key) {
    clearTimer(state.outputAudioStopWatchdogTimers.get(key));
    state.outputAudioStopWatchdogTimers.delete(key);
  }

  function clearAllOutputAudioStopWatchdogs() {
    for (const timer of state.outputAudioStopWatchdogTimers.values()) clearTimer(timer);
    state.outputAudioStopWatchdogTimers.clear();
  }

  function startUserTurn(event) {
    state.localUserSpeaking = true;
    effect('setLocalUserSpeaking', { speaking: true });
    effect('setAvatarMood', { mood: 'listening' });
    effect('setConnectionStatus', { text: 'listening' });

    const itemId = event.item_id || `pending-${event.event_id || Date.now().toString(36)}`;
    const previous = state.userTurnByItem.get(itemId) || {};
    clearTimer(previous.decisionTimer);
    state.userTurnByItem.set(itemId, {
      ...previous,
      itemId,
      audioStartMs: Number(event.audio_start_ms),
      perfStartedAt: now(),
      perfStoppedAt: 0,
      transcriptText: previous.transcriptText || '',
      finalTranscriptText: previous.finalTranscriptText || '',
      provisionalTranscriptText: previous.provisionalTranscriptText || '',
      transcriptFinal: Boolean(previous.transcriptFinal),
      transcriptContentIndex: previous.transcriptContentIndex ?? 0,
      committed: Boolean(previous.committed),
      accepted: false,
      ignored: false,
      responseSent: false,
      avatarSpeakingAtStart: Boolean(state.avatarSpeaking),
      avatarOverlapMs: Number(previous.avatarOverlapMs) || 0,
      decisionTimer: null
    });
  }

  function stopUserTurn(event) {
    state.localUserSpeaking = false;
    effect('setLocalUserSpeaking', { speaking: false });
    effect('setConnectionStatus', { text: 'checking input' });

    const itemId = event.item_id || `pending-${event.event_id || Date.now().toString(36)}`;
    const turn = ensureUserTurn(itemId);
    turn.audioEndMs = Number(event.audio_end_ms);
    turn.perfStoppedAt = now();
    turn.approxSpeechMs = estimateSpeechDurationMs(turn, getSettings());
    turn.avatarSpeakingAtStop = Boolean(state.avatarSpeaking);
    turn.avatarOverlapMs = overlapMs(turn.perfStartedAt, turn.perfStoppedAt, currentAvatarAudioIntervals());
    state.userTurnByItem.set(itemId, turn);
    scheduleUserTurnDecision(itemId, USER_TURN_TRANSCRIPT_WAIT_MS, 'speech_stopped');
  }

  function markUserTurnCommitted(event) {
    if (!event.item_id) return;
    const turn = ensureUserTurn(event.item_id);
    turn.committed = true;
    turn.previousItemId = event.previous_item_id || '';
    state.userTurnByItem.set(event.item_id, turn);
  }

  function ensureUserTurn(itemId) {
    return state.userTurnByItem.get(itemId) || {
      itemId,
      audioStartMs: NaN,
      audioEndMs: NaN,
      perfStartedAt: 0,
      perfStoppedAt: 0,
      approxSpeechMs: 0,
      transcriptText: '',
      finalTranscriptText: '',
      provisionalTranscriptText: '',
      transcriptFinal: false,
      transcriptContentIndex: 0,
      committed: false,
      accepted: false,
      ignored: false,
      responseSent: false,
      avatarSpeakingAtStart: false,
      avatarSpeakingAtStop: false,
      avatarOverlapMs: 0,
      decisionTimer: null
    };
  }

  function scheduleUserTurnDecision(itemId, delayMs, reason) {
    const turn = state.userTurnByItem.get(itemId);
    if (!turn || turn.accepted || turn.ignored) return;
    clearTimer(turn.decisionTimer);
    turn.decisionTimer = setTimer(() => {
      decideUserTurn(itemId, reason);
    }, delayMs);
  }

  function decideUserTurn(itemId, reason) {
    if (!isActive()) return;
    const turn = state.userTurnByItem.get(itemId);
    if (!turn || turn.accepted || turn.ignored) return;

    const decision = userTurnDecision(turn, getSettings());
    if (decision.accept) {
      acceptUserTurn(turn, decision.reason || reason);
      return;
    }
    ignoreUserTurn(turn, decision.reason || reason);
  }

  function acceptUserTurn(turn, reason) {
    clearTimer(turn.decisionTimer);
    turn.accepted = true;
    state.userTurnByItem.set(turn.itemId, turn);
    const stoppedAt = turn.perfStoppedAt || now();
    state.lastSpeechStoppedAt = stoppedAt;
    if (turn.itemId) state.userItemSpeechStoppedAt.set(turn.itemId, stoppedAt);
    effect('setConnectionStatus', { text: 'thinking' });
    effect('logEvent', {
      event: {
        type: 'client.user_turn_accepted',
        sessionId: state.sessionId,
        item_id: turn.itemId,
        reason,
        approxSpeechMs: Number(turn.approxSpeechMs) || 0,
        transcriptChars: String(turn.transcriptText || '').trim().length,
        finalTranscriptChars: String(turn.finalTranscriptText || '').trim().length,
        transcriptFinal: Boolean(turn.transcriptFinal),
        avatarOverlapMs: Number(turn.avatarOverlapMs) || 0,
        overlappedAvatar: Number(turn.avatarOverlapMs) > 0
      }
    });
    publishFinalUserTranscriptForTurn(turn, 'accepted_with_final_transcript');
    sendManualResponseCreate(turn, reason);
  }

  function ignoreUserTurn(turn, reason) {
    clearTimer(turn.decisionTimer);
    turn.ignored = true;
    state.userTurnByItem.set(turn.itemId, turn);
    deleteUserTextForItem(turn.itemId);
    effect('setConnectionStatus', { text: state.avatarSpeaking ? 'avatar speaking' : 'connected' });
    effect('logEvent', {
      event: {
        type: 'client.noise_turn_ignored',
        sessionId: state.sessionId,
        item_id: turn.itemId,
        reason,
        approxSpeechMs: Number(turn.approxSpeechMs) || 0,
        transcriptChars: String(turn.transcriptText || '').trim().length
      }
    });
    deleteConversationItem(turn.itemId, reason);
  }

  function sendManualResponseCreate(turn, reason) {
    if (turn.responseSent || !isActive()) return;
    if (hasActiveResponse()) {
      turn.responseDeferred = true;
      state.userTurnByItem.set(turn.itemId, turn);
      state.deferredUserResponseTurnId = turn.itemId;
      effect('logEvent', {
        event: {
          type: 'client.manual_response_create_deferred',
          sessionId: state.sessionId,
          item_id: turn.itemId,
          reason,
          pendingCreate: Boolean(state.pendingRealtimeResponseCreate),
          activeResponses: state.activeRealtimeResponseIds.size,
          avatarSpeaking: Boolean(state.avatarSpeaking),
          avatarOverlapMs: Number(turn.avatarOverlapMs) || 0
        }
      });
      return;
    }
    turn.responseSent = true;
    turn.responseDeferred = false;
    state.userTurnByItem.set(turn.itemId, turn);
    state.lastResponseStartedAt = now();
    state.pendingAssistantResponseUserItems.push({
      itemId: turn.itemId,
      perfAt: state.userItemSpeechStoppedAt.get(turn.itemId) || turn.perfStoppedAt || now(),
      speechStartedAt: Number(turn.perfStartedAt) || 0,
      speechStoppedAt: Number(turn.perfStoppedAt) || 0,
      speechDurationMs: Math.max(0, Math.round((Number(turn.perfStoppedAt) || 0) - (Number(turn.perfStartedAt) || 0))),
      approxSpeechMs: Number(turn.approxSpeechMs) || 0,
      avatarOverlapMs: Number(turn.avatarOverlapMs) || 0,
      overlappedAvatar: Number(turn.avatarOverlapMs) > 0,
      responseDeferred: Boolean(turn.responseDeferred)
    });
    if (state.pendingAssistantResponseUserItems.length > 20) state.pendingAssistantResponseUserItems.shift();
    pruneRealtimeConversationBeforeResponse(turn.itemId);
    state.pendingRealtimeResponseCreate = true;
    clearStoredTimer('pendingRealtimeResponseCreateTimer');
    state.pendingRealtimeResponseCreateTimer = setTimer(() => {
      if (!isActive() || !state.pendingRealtimeResponseCreate) return;
      state.pendingRealtimeResponseCreate = false;
      state.pendingRealtimeResponseCreateTimer = null;
      effect('logEvent', {
        event: {
          type: 'client.realtime_response_create_timeout',
          sessionId: state.sessionId,
          item_id: turn.itemId,
          timeoutMs: REALTIME_RESPONSE_CREATE_TIMEOUT_MS
        }
      });
      effect('addAdvice', {
        source: 'app',
        text: 'Realtime応答の開始イベントが返らなかったため、入力待ちへ戻しました。',
        label: 'warn'
      });
      finishAvatarAudioOutput('response_create_timeout');
    }, REALTIME_RESPONSE_CREATE_TIMEOUT_MS);
    effect('sendClientEvent', { event: { type: 'response.create' } });
    effect('logEvent', {
      event: {
        type: 'client.manual_response_create_sent',
        sessionId: state.sessionId,
        item_id: turn.itemId,
        reason
      }
    });
  }

  function sendDeferredManualResponseCreate(reason) {
    if (!isActive() || !state.deferredUserResponseTurnId || hasActiveResponse()) return false;
    const itemId = state.deferredUserResponseTurnId;
    state.deferredUserResponseTurnId = '';
    const turn = state.userTurnByItem.get(itemId);
    if (!turn || turn.ignored || turn.responseSent) return false;
    sendManualResponseCreate(turn, reason);
    return true;
  }

  function pruneRealtimeConversationBeforeResponse(currentItemId) {
    if (!isActive()) return;
    const candidates = Array.from(state.realtimeConversationItems.values())
      .filter((item) => !item.deleteRequested)
      .filter((item) => item.id && item.id !== currentItemId)
      .filter((item) => item.role === 'user' || item.role === 'assistant')
      .sort((a, b) => a.seq - b.seq);

    if (candidates.length <= REALTIME_CONTEXT_PRUNE_AFTER_ITEMS) return;

    const keepIds = new Set(candidates.slice(-REALTIME_CONTEXT_KEEP_ITEMS).map((item) => item.id));
    keepIds.add(currentItemId);
    const deleteItems = candidates
      .filter((item) => !keepIds.has(item.id))
      .filter((item) => !item.status || item.status === 'completed')
      .slice(0, REALTIME_CONTEXT_MAX_DELETES_PER_TURN);

    for (const item of deleteItems) {
      const tracked = state.realtimeConversationItems.get(item.id);
      if (tracked) {
        tracked.deleteRequested = true;
        state.realtimeConversationItems.set(item.id, tracked);
      }
      effect('sendClientEvent', { event: { type: 'conversation.item.delete', item_id: item.id } });
    }

    if (deleteItems.length) {
      effect('logEvent', {
        event: {
          type: 'client.realtime_context_prune_sent',
          sessionId: state.sessionId,
          currentItemId,
          trackedItems: candidates.length,
          deleteItems: deleteItems.length,
          keepItems: REALTIME_CONTEXT_KEEP_ITEMS
        }
      });
    }
  }

  function deleteConversationItem(itemId, reason) {
    if (!itemId || itemId.startsWith('pending-') || !isActive()) return;
    effect('sendClientEvent', { event: { type: 'conversation.item.delete', item_id: itemId } });
    effect('logEvent', {
      event: {
        type: 'client.conversation_item_delete_sent',
        sessionId: state.sessionId,
        item_id: itemId,
        reason
      }
    });
  }

  function clearUserTurnState() {
    for (const turn of state.userTurnByItem.values()) clearTimer(turn.decisionTimer);
    state.userTurnByItem.clear();
  }

  function deleteUserTextForItem(itemId) {
    if (!itemId) return;
    for (const key of state.userTextByItem.keys()) {
      if (key === itemId || key.startsWith(`${itemId}:`)) state.userTextByItem.delete(key);
    }
  }

  function userTranscriptKey(event) {
    return [
      event.item_id || 'no-item',
      event.content_index ?? 0
    ].join(':');
  }

  function handleConversationItem(event) {
    const item = event.item || {};
    trackRealtimeConversationItem(event);
    if (item.role !== 'user' || !Array.isArray(item.content)) return;
    if (item.id) {
      const turn = ensureUserTurn(item.id);
      turn.conversationItemCreated = true;
      state.userTurnByItem.set(item.id, turn);
    }
    for (let index = 0; index < item.content.length; index += 1) {
      const content = item.content[index];
      if (content?.type !== 'input_audio') continue;
      const transcript = String(content.transcript || '').trim();
      if (transcript) {
        completeUserTranscript({
          item_id: item.id,
          content_index: index,
          transcript
        });
      } else {
        effect('logEvent', {
          event: {
            type: 'client.user_audio_pending_transcript',
            item_id: item.id || null,
            content_index: index
          }
        });
      }
    }
  }

  function trackRealtimeConversationItem(event) {
    const item = event.item || {};
    if (!item.id) return;
    const previous = state.realtimeConversationItems.get(item.id) || {};
    state.realtimeConversationItems.set(item.id, {
      ...previous,
      id: item.id,
      role: item.role || previous.role || '',
      type: item.type || previous.type || '',
      status: item.status || previous.status || '',
      previousItemId: event.previous_item_id || previous.previousItemId || '',
      seq: previous.seq || ++state.realtimeConversationSeq,
      deleteRequested: Boolean(previous.deleteRequested)
    });
  }

  function forgetRealtimeConversationItem(itemId) {
    if (!itemId) return;
    state.realtimeConversationItems.delete(itemId);
  }

  function appendUserTranscriptDelta(event) {
    const key = userTranscriptKey(event);
    const nextText = `${state.userTextByItem.get(key) || ''}${event.delta || ''}`;
    state.userTextByItem.set(key, nextText);
    if (event.item_id && state.userTurnByItem.has(event.item_id)) {
      const turn = ensureUserTurn(event.item_id);
      turn.provisionalTranscriptText = nextText.trim();
      if (!turn.transcriptFinal) turn.transcriptText = turn.provisionalTranscriptText;
      state.userTurnByItem.set(event.item_id, turn);
    }
  }

  function completeUserTranscript(event) {
    const key = userTranscriptKey(event);
    if (state.processedUserTranscriptKeys.has(key)) return;
    const text = String(event.transcript || state.userTextByItem.get(key) || '').trim();
    state.userTextByItem.delete(key);
    if (!text) return;
    const turn = event.item_id ? state.userTurnByItem.get(event.item_id) : null;
    if (turn) {
      const provisionalText = String(turn.provisionalTranscriptText || turn.transcriptText || '').trim();
      turn.finalTranscriptText = text;
      turn.transcriptText = text;
      turn.provisionalTranscriptText = provisionalText;
      turn.transcriptFinal = true;
      turn.transcriptContentIndex = event.content_index ?? 0;
      state.userTurnByItem.set(event.item_id, turn);
      if (turn.ignored) {
        effect('logEvent', {
          event: {
            type: 'client.user_transcript_ignored',
            item_id: event.item_id || null,
            textChars: text.length,
            provisionalChars: provisionalText.length
          }
        });
        return;
      }
      if (!turn.accepted) {
        if (hasUsefulTranscript(text) && turn.perfStoppedAt) {
          decideUserTurn(event.item_id, 'transcript_completed');
        }
        const updatedTurn = state.userTurnByItem.get(event.item_id);
        if (!updatedTurn?.accepted) return;
      }
      publishFinalUserTranscriptForTurn(state.userTurnByItem.get(event.item_id) || turn, 'transcript_completed');
      return;
    }
    publishUserTranscript(key, event.item_id || '', text, 'transcript_completed');
  }

  function publishFinalUserTranscriptForTurn(turn, reason) {
    if (!turn?.itemId || !turn.transcriptFinal) return false;
    const text = String(turn.finalTranscriptText || turn.transcriptText || '').trim();
    if (!text) return false;
    const key = [
      turn.itemId,
      turn.transcriptContentIndex ?? 0
    ].join(':');
    return publishUserTranscript(key, turn.itemId, text, reason, {
      provisionalChars: String(turn.provisionalTranscriptText || '').trim().length,
      approxSpeechMs: Number(turn.approxSpeechMs) || 0,
      startPerfAt: Number(turn.perfStartedAt) || 0,
      endPerfAt: Number(turn.perfStoppedAt) || 0,
      durationMs: Math.max(0, Math.round((Number(turn.perfStoppedAt) || 0) - (Number(turn.perfStartedAt) || 0))),
      avatarOverlapMs: Number(turn.avatarOverlapMs) || 0,
      overlappedAvatar: Number(turn.avatarOverlapMs) > 0,
      audioStartMs: Number(turn.audioStartMs),
      audioEndMs: Number(turn.audioEndMs)
    });
  }

  function publishUserTranscript(key, itemId, text, reason, diagnostics = {}) {
    if (state.processedUserTranscriptKeys.has(key)) return true;
    state.processedUserTranscriptKeys.add(key);
    trimSet(state.processedUserTranscriptKeys, 120, 60);
    effect('addTranscript', {
      role: 'user',
      text,
      options: {
        perfAt: state.userItemSpeechStoppedAt.get(itemId) || now(),
        sourceId: itemId || '',
        startPerfAt: Number(diagnostics.startPerfAt) || 0,
        endPerfAt: Number(diagnostics.endPerfAt) || 0,
        durationMs: Number(diagnostics.durationMs) || 0,
        approxSpeechMs: Number(diagnostics.approxSpeechMs) || 0,
        avatarOverlapMs: Number(diagnostics.avatarOverlapMs) || 0,
        overlappedAvatar: Boolean(diagnostics.overlappedAvatar),
        audioStartMs: Number(diagnostics.audioStartMs),
        audioEndMs: Number(diagnostics.audioEndMs)
      }
    });
    effect('logEvent', {
      event: {
        type: 'client.user_transcript_added',
        sessionId: state.sessionId,
        item_id: itemId || null,
        reason,
        textChars: text.length,
        finalChars: text.length,
        provisionalChars: Number(diagnostics.provisionalChars) || 0,
        approxSpeechMs: Number(diagnostics.approxSpeechMs) || 0,
        avatarOverlapMs: Number(diagnostics.avatarOverlapMs) || 0,
        overlappedAvatar: Boolean(diagnostics.overlappedAvatar)
      }
    });
    return true;
  }

  function handleResponseCreated(event) {
    const responseId = event.response?.id || event.response_id;
    if (!responseId) return;
    clearPendingResponseCreate();
    state.activeRealtimeResponseIds.add(responseId);
    scheduleRealtimeResponseWatchdog(responseId);
    const pending = state.pendingAssistantResponseUserItems.shift() || {};
    updateAssistantResponseMeta(responseId, {
      userItemId: pending.itemId || '',
      userPerfAt: Number(pending.perfAt) || state.lastSpeechStoppedAt || 0,
      userSpeechStartedAt: Number(pending.speechStartedAt) || 0,
      userSpeechStoppedAt: Number(pending.speechStoppedAt) || 0,
      userSpeechDurationMs: Number(pending.speechDurationMs) || 0,
      userApproxSpeechMs: Number(pending.approxSpeechMs) || 0,
      userAvatarOverlapMs: Number(pending.avatarOverlapMs) || 0,
      userOverlappedAvatar: Boolean(pending.overlappedAvatar),
      responseDeferred: Boolean(pending.responseDeferred),
      responseCreatedAt: now()
    });
  }

  function markRealtimeResponseDone(responseId) {
    if (responseId) state.activeRealtimeResponseIds.delete(responseId);
    clearPendingResponseCreate();
    if (responseId) {
      clearTimer(state.realtimeResponseWatchdogTimers.get(responseId));
      state.realtimeResponseWatchdogTimers.delete(responseId);
    }
  }

  function scheduleRealtimeResponseWatchdog(responseId) {
    clearTimer(state.realtimeResponseWatchdogTimers.get(responseId));
    state.realtimeResponseWatchdogTimers.set(responseId, setTimer(() => {
      if (!isActive() || !state.activeRealtimeResponseIds.has(responseId)) return;
      state.activeRealtimeResponseIds.delete(responseId);
      state.activeAssistantAudioResponseIds.delete(responseId);
      clearOutputAudioStopWatchdog(responseId);
      state.realtimeResponseWatchdogTimers.delete(responseId);
      effect('logEvent', {
        event: {
          type: 'client.realtime_response_watchdog_released',
          sessionId: state.sessionId,
          responseId,
          timeoutMs: REALTIME_RESPONSE_TIMEOUT_MS
        }
      });
      effect('addAdvice', {
        source: 'app',
        text: 'Realtime応答が完了イベントを返さないまま停止したため、入力待ちへ戻しました。',
        label: 'warn'
      });
      finishAvatarAudioOutput('response_watchdog');
    }, REALTIME_RESPONSE_TIMEOUT_MS));
  }

  function recordAssistantResponsePart(event, contentKey, text) {
    const responseId = event.response_id || contentKey;
    const parts = state.assistantResponseParts.get(responseId) || new Map();
    parts.set(contentKey, {
      outputIndex: Number(event.output_index) || 0,
      contentIndex: Number(event.content_index) || 0,
      itemId: event.item_id || '',
      text
    });
    state.assistantResponseParts.set(responseId, parts);
  }

  function updateAssistantResponseMeta(responseId, patch) {
    if (!responseId) return;
    state.assistantResponseMeta.set(responseId, {
      ...(state.assistantResponseMeta.get(responseId) || {}),
      ...patch
    });
  }

  function responseMetaFromDoneEvent(event) {
    const response = event.response || {};
    return {
      status: response.status || event.status || '',
      statusDetails: response.status_details || event.status_details || null,
      usage: response.usage || event.usage || null,
      responseDoneAt: now()
    };
  }

  function scheduleAssistantResponseFlush(responseId, delayMs, reason = 'flush_timeout') {
    if (!responseId) return;
    clearTimer(state.assistantResponseTimers.get(responseId));
    state.assistantResponseTimers.set(responseId, setTimer(() => {
      flushAssistantResponse(responseId, reason);
    }, delayMs));
  }

  function flushAssistantResponse(responseId, reason) {
    if (!responseId || state.processedAssistantResponses.has(responseId)) return;
    const parts = state.assistantResponseParts.get(responseId);
    const meta = state.assistantResponseMeta.get(responseId) || {};
    if (!parts?.size) {
      const incompleteReason = assistantIncompleteReason(meta);
      if (incompleteReason) {
        clearTimer(state.assistantResponseTimers.get(responseId));
        state.assistantResponseTimers.delete(responseId);
        state.assistantResponseMeta.delete(responseId);
        state.processedAssistantResponses.add(responseId);
        effect('logEvent', {
          event: {
            type: 'client.assistant_response_flushed',
            sessionId: state.sessionId,
            responseId,
            reason,
            status: meta.status || 'unknown',
            statusDetails: summarizeStatusDetails(meta.statusDetails),
            usage: summarizeUsage(meta.usage),
            incompleteReason,
            parts: 0,
            textChars: 0,
            userItemId: meta.userItemId || null,
            userPerfAt: Number(meta.userPerfAt) || null
          }
        });
        effect('addMetric', { text: `Realtime incomplete response: ${incompleteReason}` });
        effect('addAdvice', {
          source: 'app',
          text: `Realtime応答が途中終了しました: ${incompleteReason}`,
          label: 'warn'
        });
      }
      return;
    }

    clearTimer(state.assistantResponseTimers.get(responseId));
    state.assistantResponseTimers.delete(responseId);
    state.assistantResponseParts.delete(responseId);
    state.processedAssistantResponses.add(responseId);
    trimSet(state.processedAssistantResponses, 80, 40);
    state.assistantResponseMeta.delete(responseId);

    const text = Array.from(parts.values())
      .sort((a, b) => a.outputIndex - b.outputIndex || a.contentIndex - b.contentIndex || a.itemId.localeCompare(b.itemId))
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join('\n')
      .trim();

    if (!text) return;
    const incompleteReason = assistantIncompleteReason(meta);
    if (!incompleteReason) {
      effect('addTranscript', {
        role: 'assistant',
        text,
        options: {
          sourceId: responseId,
          startPerfAt: Number(meta.outputAudioStartedAt) || Number(meta.responseCreatedAt) || 0,
          endPerfAt: Number(meta.outputAudioStoppedAt) || Number(meta.responseDoneAt) || 0,
          durationMs: durationBetween(meta.outputAudioStartedAt || meta.responseCreatedAt, meta.outputAudioStoppedAt || meta.responseDoneAt)
        }
      });
    }
    effect('logEvent', {
      event: {
        type: 'client.assistant_response_flushed',
        sessionId: state.sessionId,
        responseId,
        reason,
        status: meta.status || 'unknown',
        statusDetails: summarizeStatusDetails(meta.statusDetails),
        usage: summarizeUsage(meta.usage),
        incompleteReason,
        parts: parts.size,
        textChars: text.length,
        userItemId: meta.userItemId || null,
        userPerfAt: Number(meta.userPerfAt) || null
      }
    });
    if (incompleteReason) {
      effect('addMetric', { text: `Realtime incomplete response: ${incompleteReason}` });
      effect('addAdvice', {
        source: 'app',
        text: `Realtime応答が途中終了しました: ${incompleteReason}`,
        label: 'warn'
      });
      return;
    }
    effect('scheduleAdvisorFromRealtimeResponse', {
      sessionId: state.sessionId,
      responseId,
      assistantText: text,
      diagnostics: {
        incompleteReason,
        userItemId: meta.userItemId || '',
        userPerfAt: Number(meta.userPerfAt) || 0,
        timeline: assistantResponseTimeline(responseId, meta)
      }
    });
  }

  function finishAvatarAudioOutput(reason) {
    if (!isActive()) return;
    if (state.activeAssistantAudioResponseIds.size) {
      state.avatarSpeaking = true;
      effect('setAvatarSpeaking', { speaking: true });
      effect('setAvatarMood', { mood: 'speaking' });
      effect('setConnectionStatus', { text: 'avatar speaking' });
      return;
    }

    closeActiveAvatarAudioInterval(now());
    state.avatarSpeaking = false;
    effect('setAvatarSpeaking', { speaking: false });
    effect('setAvatarMood', { mood: 'neutral' });
    effect('setConnectionStatus', { text: 'connected' });
    if (sendDeferredManualResponseCreate(reason)) return;
  }

  function currentAvatarAudioIntervals() {
    const intervals = state.avatarAudioIntervals.slice();
    if (state.activeAvatarAudioStartedAt) {
      intervals.push({ start: state.activeAvatarAudioStartedAt, end: now() });
    }
    return intervals;
  }

  function closeActiveAvatarAudioInterval(endAt) {
    const start = Number(state.activeAvatarAudioStartedAt) || 0;
    if (!start) return;
    const end = Math.max(start, Number(endAt) || start);
    state.avatarAudioIntervals.push({ start, end });
    if (state.avatarAudioIntervals.length > TIMELINE_INTERVAL_KEEP_ITEMS) {
      state.avatarAudioIntervals = state.avatarAudioIntervals.slice(-TIMELINE_INTERVAL_KEEP_ITEMS);
    }
    state.activeAvatarAudioStartedAt = 0;
  }

  function assistantResponseTimeline(responseId, meta) {
    return {
      responseId,
      userItemId: meta.userItemId || '',
      userSpeechStartedAt: Number(meta.userSpeechStartedAt) || 0,
      userSpeechStoppedAt: Number(meta.userSpeechStoppedAt) || Number(meta.userPerfAt) || 0,
      userSpeechDurationMs: Number(meta.userSpeechDurationMs) || 0,
      userApproxSpeechMs: Number(meta.userApproxSpeechMs) || 0,
      userAvatarOverlapMs: Number(meta.userAvatarOverlapMs) || 0,
      userOverlappedAvatar: Boolean(meta.userOverlappedAvatar),
      responseDeferred: Boolean(meta.responseDeferred),
      responseCreatedAt: Number(meta.responseCreatedAt) || 0,
      outputAudioStartedAt: Number(meta.outputAudioStartedAt) || 0,
      outputAudioStoppedAt: Number(meta.outputAudioStoppedAt) || 0,
      responseDoneAt: Number(meta.responseDoneAt) || 0,
      userToResponseCreateMs: durationBetween(meta.userSpeechStoppedAt || meta.userPerfAt, meta.responseCreatedAt),
      userToOutputAudioStartMs: durationBetween(meta.userSpeechStoppedAt || meta.userPerfAt, meta.outputAudioStartedAt),
      outputAudioDurationMs: durationBetween(meta.outputAudioStartedAt, meta.outputAudioStoppedAt || meta.responseDoneAt)
    };
  }

  function clearPendingResponseCreate() {
    state.pendingRealtimeResponseCreate = false;
    clearStoredTimer('pendingRealtimeResponseCreateTimer');
  }

  function clearStoredTimer(name) {
    if (!state[name]) return;
    clearTimer(state[name]);
    state[name] = null;
  }

  function resetRuntimeState() {
    state.active = false;
    state.sessionId = 0;
    state.expectedVoice = '';
    state.clientSessionUpdateRequired = false;
    state.realtimeSessionConfigured = false;
    state.tokenData = null;
    state.avatarSpeaking = false;
    state.localUserSpeaking = false;
    state.currentAssistantText = '';
    state.assistantTextByResponse.clear();
    clearTimerMap(state.assistantResponseTimers);
    state.assistantResponseParts.clear();
    state.assistantResponseMeta.clear();
    state.pendingAssistantResponseUserItems = [];
    state.pendingRealtimeResponseCreate = false;
    clearStoredTimer('pendingRealtimeResponseCreateTimer');
    clearTimerMap(state.realtimeResponseWatchdogTimers);
    state.activeRealtimeResponseIds.clear();
    state.deferredUserResponseTurnId = '';
    state.activeAssistantAudioResponseIds.clear();
    clearAllOutputAudioStopWatchdogs();
    state.activeAvatarAudioStartedAt = 0;
    state.avatarAudioIntervals = [];
    state.realtimeConversationItems.clear();
    state.realtimeConversationSeq = 0;
    state.processedAssistantResponseKeys.clear();
    state.processedAssistantResponses.clear();
    clearUserTranscriptState();
    state.lastSpeechStoppedAt = 0;
    state.lastResponseStartedAt = 0;
    clearStoredTimer('sessionUpdateWatchdogTimer');
  }

  function clearTimerMap(map) {
    for (const timer of map.values()) clearTimer(timer);
    map.clear();
  }

  return {
    beginSession,
    handleDataChannelOpen,
    handleDataChannelClose,
    handleDataChannelError,
    handleServerEvent,
    sendTextTurn,
    stop,
    clearUserTranscriptState,
    hasActiveResponse,
    isConfigured,
    _state: state
  };
}

function createInitialState() {
  return {
    active: false,
    sessionId: 0,
    expectedVoice: '',
    clientSessionUpdateRequired: false,
    realtimeSessionConfigured: false,
    tokenData: null,
    avatarSpeaking: false,
    localUserSpeaking: false,
    currentAssistantText: '',
    assistantTextByResponse: new Map(),
    assistantResponseParts: new Map(),
    assistantResponseTimers: new Map(),
    assistantResponseMeta: new Map(),
    pendingAssistantResponseUserItems: [],
    pendingRealtimeResponseCreate: false,
    pendingRealtimeResponseCreateTimer: null,
    activeRealtimeResponseIds: new Set(),
    realtimeResponseWatchdogTimers: new Map(),
    deferredUserResponseTurnId: '',
    activeAssistantAudioResponseIds: new Set(),
    outputAudioStopWatchdogTimers: new Map(),
    activeAvatarAudioStartedAt: 0,
    avatarAudioIntervals: [],
    realtimeConversationItems: new Map(),
    realtimeConversationSeq: 0,
    processedAssistantResponseKeys: new Set(),
    processedAssistantResponses: new Set(),
    userTextByItem: new Map(),
    userTurnByItem: new Map(),
    userItemSpeechStoppedAt: new Map(),
    processedUserTranscriptKeys: new Set(),
    lastSpeechStoppedAt: 0,
    lastResponseStartedAt: 0,
    sessionUpdateWatchdogTimer: null
  };
}

export function estimateSpeechDurationMs(turn, settings = {}) {
  const start = Number(turn.audioStartMs);
  const end = Number(turn.audioEndMs);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  const silenceMs = Number(settings.vadSilenceMs) || DEFAULTS.vadSilenceMs;
  return Math.max(0, Math.round(end - start - VAD_PREFIX_PADDING_MS - silenceMs));
}

export function userTurnDecision(turn, settings = {}) {
  const text = String(turn.transcriptFinal ? turn.finalTranscriptText : turn.transcriptText || '').trim();
  if (hasUsefulTranscript(text)) {
    return { accept: true, reason: 'transcript' };
  }
  const configuredGateMs = Number(settings.vadMinSpeechMs);
  const gateMs = Number.isFinite(configuredGateMs) ? Math.max(0, configuredGateMs) : DEFAULTS.vadMinSpeechMs;
  if (Number(turn.approxSpeechMs) >= gateMs) {
    return { accept: true, reason: 'duration' };
  }
  return { accept: false, reason: 'short_noise' };
}

export function hasUsefulTranscript(text) {
  const normalized = String(text || '')
    .replace(/[、。！？!?.,，．・「」『』（）()\[\]\s]/g, '')
    .trim();
  if (!normalized) return false;
  if (/^(ありがとう|ありがとうございました|ご視聴ありがとうございました|ご清聴ありがとうございました)$/.test(normalized)) return false;
  if (/^(ピン|ポン|ピロン|カチ|カチャ|カタカタ|チーン|通知音|着信音|バイブ|ding|beep)$/i.test(normalized)) return false;
  if (/^(はい|うん|ええ|そう|そうですね|ですね|いや|まあ|なるほど)$/.test(normalized)) return true;
  return normalized.length >= 2 && /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}A-Za-z0-9]/u.test(normalized);
}

export function assistantIncompleteReason(meta) {
  const status = String(meta?.status || '').toLowerCase();
  const details = meta?.statusDetails || {};
  const reason = String(details.reason || details.type || details.code || '').toLowerCase();
  if (status === 'incomplete' || status === 'cancelled' || status === 'failed') return reason || status;
  if (reason.includes('max') && reason.includes('token')) return reason;
  if (reason.includes('interrupt') || reason.includes('turn_detected')) return reason;
  return '';
}

function summarizeStatusDetails(details) {
  if (!details || typeof details !== 'object') return details || null;
  return {
    type: details.type || null,
    reason: details.reason || null,
    code: details.error?.code || details.code || null,
    message: details.error?.message || details.message || null
  };
}

function summarizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    total_tokens: usage.total_tokens ?? null,
    input_tokens: usage.input_tokens ?? null,
    output_tokens: usage.output_tokens ?? null
  };
}

function durationBetween(start, end) {
  const startMs = Number(start);
  const endMs = Number(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  return Math.round(endMs - startMs);
}

function overlapMs(start, end, intervals) {
  const startMs = Number(start);
  const endMs = Number(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || !Array.isArray(intervals)) return 0;
  return intervals.reduce((sum, interval) => {
    const intervalStart = Number(interval?.start);
    const intervalEnd = Number(interval?.end);
    if (!Number.isFinite(intervalStart) || !Number.isFinite(intervalEnd) || intervalEnd <= intervalStart) return sum;
    return sum + Math.max(0, Math.min(endMs, intervalEnd) - Math.max(startMs, intervalStart));
  }, 0);
}

function trimSet(set, maxSize, keepSize) {
  if (set.size <= maxSize) return;
  const next = new Set(Array.from(set).slice(-keepSize));
  set.clear();
  for (const value of next) set.add(value);
}
