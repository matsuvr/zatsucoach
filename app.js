import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import * as THREE_VRM from '@pixiv/three-vrm';

const defaultSettings = Object.freeze({
  realtimeDeployment: 'gpt-realtime-2',
  advisorDeployment: 'gpt-5.4-nano',
  avatarTextDeployment: 'gpt-5.4-nano',
  voice: 'marin',
  voiceSpeed: 1.25,
  vadSilenceMs: 650,
  vadThreshold: 0.55,
  maxResponseTokens: 96,
  advisorMaxTokens: 1024,
  reasoningEffort: 'none',
  webrtcFilter: 'on',
  benchmarkAdvisorDeployments: 'gpt-5.4-nano,gpt-5-nano',
  realtimeInstructions: `あなたは企業の雑談訓練用アバターです。目的は、在宅勤務に慣れた社員がオフィスで自然に短い雑談をできるようにすることです。\n\n制約:\n- 日本語で話す。\n- 返答は原則1文、長くても2文。\n- 最初の反応は短い相づち、共感、軽い質問を優先する。\n- 相手を評価しすぎない。\n- ビジネス上の機密、医療、法律、金融の助言は避ける。\n- 会話のテンポを最優先し、考え込まない。`,
  advisorInstructions: `あなたは会話練習のリアルタイム助言AIです。Realtimeのユーザー発話文字起こし、アバター応答、会話履歴から、直前の会話状態を推定して助言します。\n\n出力形式:\n{ "label": "good|warn|risk", "advice": "1〜3文の日本語助言", "reason": "短い理由" }\n\n評価軸:\n- ユーザー発話が会話として成立しているか。\n- ぶつ切り、未完、文脈不足に見えないか。\n- 次にユーザーが足すと自然な一言があるか。\n- 相手の話を受ける余地があるか。\n\n制約:\n- 返答はJSONのみ。\n- ユーザー発話文字起こしがない場合は、Realtimeアバター応答から推定し、断定しすぎない。\n- 速度優先。`
});

const ADVISOR_MIN_INTERVAL_MS = 3000;
const ADVISOR_BACKOFF_MS = 60000;
const ADVISOR_ERROR_MUTE_MS = 60000;
const ADVISOR_TRANSCRIPT_GRACE_MS = 1200;
const ASSISTANT_RESPONSE_FLUSH_MS = 700;

const serverSettingKeys = Object.freeze([
  'realtimeDeployment',
  'advisorDeployment',
  'avatarTextDeployment'
]);

const els = {
  stage: document.getElementById('vrmStage'),
  connectionStatus: document.getElementById('connectionStatus'),
  avatarStatus: document.getElementById('avatarStatus'),
  latencyStatus: document.getElementById('latencyStatus'),
  remoteAudio: document.getElementById('remoteAudio'),
  adviceFeed: document.getElementById('adviceFeed'),
  transcriptFeed: document.getElementById('transcriptFeed'),
  metricsFeed: document.getElementById('metricsFeed'),
  eventFeed: document.getElementById('eventFeed'),
  settingsDialog: document.getElementById('settingsDialog'),
  settingsForm: document.getElementById('settingsForm'),
  btnSettings: document.getElementById('btnSettings'),
  btnConnect: document.getElementById('btnConnect'),
  btnDisconnect: document.getElementById('btnDisconnect'),
  btnSendText: document.getElementById('btnSendText'),
  btnHealth: document.getElementById('btnHealth'),
  btnBenchAdvisor: document.getElementById('btnBenchAdvisor'),
  btnClearAdvice: document.getElementById('btnClearAdvice'),
  btnClearTranscript: document.getElementById('btnClearTranscript'),
  btnClearEvents: document.getElementById('btnClearEvents'),
  btnResetSettings: document.getElementById('btnResetSettings'),
  textInput: document.getElementById('textInput')
};

const state = {
  settings: loadSettings(),
  pc: null,
  dataChannel: null,
  mediaStream: null,
  activeRealtimeSessionId: 0,
  realtimeStarting: false,
  expectedRealtimeVoice: '',
  clientSessionUpdateRequired: false,
  realtimeCounters: {
    tokenRequests: 0,
    sdpExchanges: 0,
    advisorRequests: 0,
    chatFallbackRequests: 0
  },
  transcript: [],
  currentAssistantText: '',
  assistantTextByResponse: new Map(),
  assistantResponseParts: new Map(),
  assistantResponseTimers: new Map(),
  processedAssistantResponseKeys: new Set(),
  processedAssistantResponses: new Set(),
  userTextByItem: new Map(),
  userItemSpeechStoppedAt: new Map(),
  processedUserTranscriptKeys: new Set(),
  lastSpeechStoppedAt: 0,
  lastResponseStartedAt: 0,
  latencySamples: [],
  avatarSpeaking: false,
  localUserSpeaking: false,
  adviceCounter: 0,
  sessionStartedAt: 0,
  advisorInFlight: false,
  queuedAdvice: null,
  advisorQueueTimer: null,
  advisorBackoffUntil: 0,
  advisorErrorMutedUntil: 0,
  lastAdvisorStartedAt: 0,
  realtimeSessionConfigured: false,
  sessionUpdateFallbackTimer: null,
  sessionUpdateWatchdogTimer: null
};

const sceneState = {
  renderer: null,
  scene: null,
  camera: null,
  controls: null,
  vrm: null,
  clock: new THREE.Clock(),
  blinkTimer: 0,
  mouthTimer: 0
};

initTabs();
initSettingsDialog();
initScene();
wireEvents();
addAdvice('app', 'まず「接続開始」を押してください。マイク許可後、アバターとの音声対話が始まります。', 'good');
syncServerSettings();

function loadSettings() {
  const raw = localStorage.getItem('zatsucoach.settings.v1');
  if (!raw) return { ...defaultSettings };
  try {
    const settings = { ...defaultSettings, ...JSON.parse(raw) };
    if (Number(settings.advisorMaxTokens) < defaultSettings.advisorMaxTokens) {
      settings.advisorMaxTokens = defaultSettings.advisorMaxTokens;
    }
    if (Number(settings.advisorMaxTokens) > 4096) {
      settings.advisorMaxTokens = defaultSettings.advisorMaxTokens;
    }
    if (Number(settings.vadSilenceMs) < 500) {
      settings.vadSilenceMs = defaultSettings.vadSilenceMs;
    }
    return settings;
  } catch {
    return { ...defaultSettings };
  }
}

function saveSettings(next) {
  state.settings = { ...defaultSettings, ...next };
  localStorage.setItem('zatsucoach.settings.v1', JSON.stringify(state.settings));
}

async function syncServerSettings() {
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await safeJson(response);
    applyServerSettings(data, false);
  } catch {
    // Offline/static-only local runs can still use the saved settings.
  }
}

function applyServerSettings(data, announce = true) {
  const next = { ...state.settings };
  const serverSettings = {
    realtimeDeployment: data.realtimeDeployment,
    advisorDeployment: data.advisorDeployment,
    avatarTextDeployment: data.avatarTextDeployment
  };
  let changed = false;
  for (const key of serverSettingKeys) {
    if (serverSettings[key] && next[key] !== serverSettings[key]) {
      next[key] = serverSettings[key];
      changed = true;
    }
  }
  if (!changed) return;
  saveSettings(next);
  fillSettingsForm();
  if (announce) {
    addAdvice('app', `デプロイ先設定を反映しました。Realtime=${next.realtimeDeployment}, Advisor=${next.advisorDeployment}`, 'good');
  }
}

function initTabs() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((el) => el.classList.remove('active'));
      document.querySelectorAll('.tabBody').forEach((el) => el.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`${tab.dataset.tab}Tab`).classList.add('active');
    });
  }
}

function initSettingsDialog() {
  fillSettingsForm();
  els.btnSettings.addEventListener('click', () => {
    fillSettingsForm();
    els.settingsDialog.showModal();
  });
  els.settingsForm.addEventListener('submit', () => {
    const data = new FormData(els.settingsForm);
    const next = { ...state.settings };
    for (const [key, value] of data.entries()) next[key] = String(value);
    for (const key of ['voiceSpeed', 'vadSilenceMs', 'vadThreshold', 'maxResponseTokens', 'advisorMaxTokens']) {
      next[key] = Number(next[key]);
    }
    saveSettings(next);
    addAdvice('app', `設定を保存しました。Realtime=${next.realtimeDeployment}, Advisor=${next.advisorDeployment}`, 'good');
  });
  els.btnResetSettings.addEventListener('click', () => {
    saveSettings({ ...defaultSettings });
    fillSettingsForm();
    addAdvice('app', '設定を既定値に戻しました。', 'warn');
  });
}

function fillSettingsForm() {
  const s = state.settings;
  for (const [key, value] of Object.entries(s)) {
    const input = els.settingsForm.elements.namedItem(key);
    if (input) input.value = value;
  }
}

function wireEvents() {
  els.btnConnect.addEventListener('click', startRealtime);
  els.btnDisconnect.addEventListener('click', stopRealtime);
  els.btnSendText.addEventListener('click', sendText);
  els.textInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') sendText();
  });
  els.btnHealth.addEventListener('click', checkHealth);
  els.btnBenchAdvisor.addEventListener('click', benchmarkAdvisorModels);
  els.btnClearAdvice.addEventListener('click', () => els.adviceFeed.innerHTML = '');
  els.btnClearTranscript.addEventListener('click', () => {
    state.transcript = [];
    state.userTextByItem.clear();
    state.userItemSpeechStoppedAt.clear();
    state.processedUserTranscriptKeys.clear();
    els.transcriptFeed.innerHTML = '';
  });
  els.btnClearEvents.addEventListener('click', () => els.eventFeed.innerHTML = '');
  window.addEventListener('beforeunload', stopRealtime);
}

function initScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x10151f);

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 1.35, 3.1);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.xr.enabled = true;
  els.stage.appendChild(renderer.domElement);
  els.stage.appendChild(VRButton.createButton(renderer));

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.25, 0);
  controls.enableDamping = true;
  controls.minDistance = 1.5;
  controls.maxDistance = 6;

  const hemi = new THREE.HemisphereLight(0xffffff, 0x303850, 1.8);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 1.7);
  key.position.set(1.7, 3.1, 2.2);
  scene.add(key);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(1.65, 64),
    new THREE.MeshStandardMaterial({ color: 0x1b2434, roughness: 0.85 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.02;
  scene.add(floor);

  sceneState.scene = scene;
  sceneState.camera = camera;
  sceneState.renderer = renderer;
  sceneState.controls = controls;

  const resize = () => {
    const rect = els.stage.getBoundingClientRect();
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = Math.max(rect.width / Math.max(rect.height, 1), 0.1);
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  loadVRM('./assets/AvatarSample_Y.vrm');
  renderer.setAnimationLoop(renderLoop);
}

function loadVRM(url) {
  els.avatarStatus.textContent = 'avatar: loading VRM';
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  loader.load(url, (gltf) => {
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('VRM not found in glTF userData.');
    THREE_VRM.VRMUtils?.rotateVRM0?.(vrm);
    sceneState.scene.add(vrm.scene);
    sceneState.vrm = vrm;
    fitVRM(vrm);
    els.avatarStatus.textContent = 'avatar: ready';
    setAvatarMood('neutral');
  }, (progress) => {
    if (progress.total) {
      const pct = Math.round((progress.loaded / progress.total) * 100);
      els.avatarStatus.textContent = `avatar: loading ${pct}%`;
    }
  }, (error) => {
    console.error(error);
    els.avatarStatus.textContent = 'avatar: load failed';
    addAdvice('app', `VRMの読み込みに失敗しました: ${error.message || error}`, 'risk');
  });
}

function fitVRM(vrm) {
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  vrm.scene.position.x -= center.x;
  vrm.scene.position.z -= center.z;
  vrm.scene.position.y -= box.min.y;
  const scale = 1.6 / Math.max(size.y, 0.1);
  vrm.scene.scale.setScalar(scale);
}

function renderLoop() {
  const delta = sceneState.clock.getDelta();
  sceneState.controls?.update();
  animateAvatar(delta);
  sceneState.vrm?.update(delta);
  sceneState.renderer.render(sceneState.scene, sceneState.camera);
}

function animateAvatar(delta) {
  const vrm = sceneState.vrm;
  if (!vrm?.expressionManager) return;

  sceneState.blinkTimer -= delta;
  if (sceneState.blinkTimer <= 0) {
    sceneState.blinkTimer = 2.5 + Math.random() * 2.8;
    pulseExpression(['blink', 'Blink'], 1, 120);
  }

  const talking = state.avatarSpeaking;
  const target = talking ? 0.25 + Math.random() * 0.75 : 0;
  sceneState.mouthTimer += delta;
  if (sceneState.mouthTimer > 0.075) {
    sceneState.mouthTimer = 0;
    setExpressionMany(['aa', 'A'], target);
    setExpressionMany(['ih', 'I', 'ee', 'E', 'ou', 'U', 'oh', 'O'], talking ? Math.random() * 0.25 : 0);
  }
}

function setAvatarMood(mood) {
  const values = {
    neutral: { happy: 0.05, relaxed: 0.15, angry: 0, sad: 0 },
    listening: { happy: 0.1, relaxed: 0.2, angry: 0, sad: 0 },
    speaking: { happy: 0.18, relaxed: 0.12, angry: 0, sad: 0 },
    caution: { happy: 0, relaxed: 0.05, angry: 0.08, sad: 0.08 }
  }[mood] || {};
  for (const [name, value] of Object.entries(values)) setExpressionMany([name, capitalize(name)], value);
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function setExpressionMany(names, value) {
  for (const name of names) setExpression(name, value);
}

function setExpression(name, value) {
  try {
    sceneState.vrm?.expressionManager?.setValue(name, value);
  } catch {
    // Some VRM files do not expose every expression preset. Ignore silently.
  }
}

function pulseExpression(names, value, durationMs) {
  setExpressionMany(names, value);
  setTimeout(() => setExpressionMany(names, 0), durationMs);
}

async function startRealtime() {
  if (state.realtimeStarting || state.pc || state.dataChannel) {
    logEvent({ type: 'client.realtime_start_skipped', reason: 'already_active', sessionId: state.activeRealtimeSessionId });
    return;
  }

  const sessionId = state.activeRealtimeSessionId + 1;
  state.activeRealtimeSessionId = sessionId;
  state.realtimeStarting = true;
  state.expectedRealtimeVoice = String(state.settings.voice || '').trim().toLowerCase();
  state.clientSessionUpdateRequired = false;

  try {
    setConnectionStatus('requesting token');
    els.btnConnect.disabled = true;
    const tokenPayload = {
      realtimeDeployment: state.settings.realtimeDeployment,
      instructions: state.settings.realtimeInstructions,
      voice: state.expectedRealtimeVoice,
      voiceSpeed: Number(state.settings.voiceSpeed),
      vadSilenceMs: Number(state.settings.vadSilenceMs),
      vadThreshold: Number(state.settings.vadThreshold),
      maxResponseTokens: Number(state.settings.maxResponseTokens)
    };
    state.realtimeCounters.tokenRequests += 1;
    logEvent({
      type: 'client.realtime_token_request',
      sessionId,
      count: state.realtimeCounters.tokenRequests,
      deployment: tokenPayload.realtimeDeployment,
      voice: tokenPayload.voice
    });
    const tokenResponse = await fetch('/api/realtime-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tokenPayload)
    });
    if (!isActiveRealtimeSession(sessionId)) return;
    const tokenData = await safeJson(tokenResponse);
    if (!tokenResponse.ok) throw new Error(tokenData.error || `token failed: ${tokenResponse.status}`);
    if (!tokenData.token || !tokenData.webrtcUrl) throw new Error('token response is missing token or webrtcUrl');
    if (tokenData.voice && tokenData.voice !== state.expectedRealtimeVoice) {
      throw new Error(`Realtime voice mismatch before WebRTC: expected=${state.expectedRealtimeVoice}, token=${tokenData.voice}`);
    }
    state.clientSessionUpdateRequired = Boolean(tokenData.requiresClientSessionUpdate);

    setConnectionStatus('microphone');
    const mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    if (!isActiveRealtimeSession(sessionId)) {
      mediaStream.getTracks().forEach((track) => track.stop());
      return;
    }

    const pc = new RTCPeerConnection();
    state.pc = pc;
    state.mediaStream = mediaStream;
    state.sessionStartedAt = performance.now();

    pc.ontrack = (event) => {
      if (!isActiveRealtimeSession(sessionId)) return;
      if (event.streams?.[0]) {
        els.remoteAudio.srcObject = event.streams[0];
      }
    };
    pc.onconnectionstatechange = () => {
      if (!isActiveRealtimeSession(sessionId)) return;
      logEvent({ type: 'client.connection_state', sessionId, state: pc.connectionState });
      setConnectionStatus(pc.connectionState);
    };
    pc.oniceconnectionstatechange = () => {
      if (!isActiveRealtimeSession(sessionId)) return;
      logEvent({ type: 'client.ice_state', sessionId, state: pc.iceConnectionState });
    };

    for (const track of mediaStream.getAudioTracks()) {
      track.enabled = false;
      pc.addTrack(track, mediaStream);
    }

    const dc = pc.createDataChannel('realtime-channel');
    state.dataChannel = dc;
    wireDataChannel(dc, sessionId, tokenData);

    const offer = await pc.createOffer();
    if (!isActiveRealtimeSession(sessionId)) return;
    await pc.setLocalDescription(offer);

    const url = new URL(tokenData.webrtcUrl);
    if (state.settings.webrtcFilter === 'on') url.searchParams.set('webrtcfilter', 'on');

    setConnectionStatus('sdp exchange');
    const sdpStarted = performance.now();
    state.realtimeCounters.sdpExchanges += 1;
    logEvent({
      type: 'client.realtime_sdp_request',
      sessionId,
      count: state.realtimeCounters.sdpExchanges,
      deployment: tokenData.deployment,
      voice: tokenData.voice || state.expectedRealtimeVoice
    });
    const sdpResponse = await fetch(url.toString(), {
      method: 'POST',
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${tokenData.token}`,
        'Content-Type': 'application/sdp'
      }
    });
    if (!isActiveRealtimeSession(sessionId)) return;
    const answerSdp = await sdpResponse.text();
    if (!sdpResponse.ok) throw new Error(`SDP failed ${sdpResponse.status}: ${answerSdp.slice(0, 300)}`);

    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    addMetric(`SDP exchange: ${Math.round(performance.now() - sdpStarted)}ms / deployment=${tokenData.deployment} / voice=${tokenData.voice || state.expectedRealtimeVoice}`);
    setConnectionStatus('connecting');
    els.btnDisconnect.disabled = false;
  } catch (error) {
    console.error(error);
    addAdvice('app', `Realtime接続に失敗しました: ${error.message || error}`, 'risk');
    setConnectionStatus('failed');
    els.btnConnect.disabled = false;
    stopRealtime(false, sessionId);
  } finally {
    if (isActiveRealtimeSession(sessionId)) state.realtimeStarting = false;
  }
}

function wireDataChannel(dc, sessionId, tokenData) {
  dc.addEventListener('open', () => {
    if (!isActiveRealtimeSession(sessionId)) return;
    setConnectionStatus('configuring session');
    addAdvice('app', 'Realtime接続を確立しました。サーバー側で固定した音声設定を確認しています。', 'good');
    if (tokenData.requiresClientSessionUpdate) {
      sendClientSessionUpdate(dc, sessionId, tokenData.sessionConfig);
    }
    scheduleRealtimeSessionWatchdog(sessionId);
    logEvent({ type: 'client.data_channel_open', sessionId, configMode: tokenData.configMode || 'unknown' });
  });
  dc.addEventListener('close', () => {
    if (!isActiveRealtimeSession(sessionId)) return;
    logEvent({ type: 'client.data_channel_close', sessionId });
    setConnectionStatus('closed');
  });
  dc.addEventListener('error', (event) => {
    if (!isActiveRealtimeSession(sessionId)) return;
    logEvent({ type: 'client.data_channel_error', sessionId, error: String(event.message || event) });
  });
  dc.addEventListener('message', (event) => {
    if (!isActiveRealtimeSession(sessionId)) return;
    try {
      const realtimeEvent = JSON.parse(event.data);
      handleRealtimeEvent(realtimeEvent, sessionId);
    } catch (error) {
      logEvent({ type: 'client.unparsed_message', sessionId, data: String(event.data).slice(0, 500), error: String(error) });
    }
  });
}

function scheduleRealtimeSessionWatchdog(sessionId) {
  state.realtimeSessionConfigured = false;
  clearTimeout(state.sessionUpdateFallbackTimer);
  clearTimeout(state.sessionUpdateWatchdogTimer);
  state.sessionUpdateWatchdogTimer = setTimeout(() => {
    if (!isActiveRealtimeSession(sessionId) || state.realtimeSessionConfigured) return;
    logEvent({ type: 'client.session_ready_timeout', sessionId, voice: state.expectedRealtimeVoice });
    addAdvice('app', 'Realtimeの音声設定を確認できないため、マイク入力を開始せず接続を閉じます。', 'risk');
    stopRealtime(false, sessionId);
  }, 4000);
}

function isActiveRealtimeSession(sessionId) {
  return Number(sessionId) === state.activeRealtimeSessionId;
}

function sendClientSessionUpdate(dc, sessionId, sessionConfig) {
  if (!isActiveRealtimeSession(sessionId) || dc.readyState !== 'open' || !sessionConfig) return;
  dc.send(JSON.stringify({ type: 'session.update', session: sessionConfig }));
  logEvent({
    type: 'client.session_update_sent',
    sessionId,
    advisorSource: 'realtime_response_transcript',
    voice: sessionConfig.audio?.output?.voice || null
  });
}

function handleRealtimeEvent(event, sessionId) {
  if (!isActiveRealtimeSession(sessionId)) return;
  logEvent({ ...event, sessionId });
  switch (event.type) {
    case 'session.created':
      confirmRealtimeSession(event, sessionId, 'session_created');
      break;
    case 'session.updated':
      confirmRealtimeSession(event, sessionId, 'session_updated');
      break;
    case 'input_audio_buffer.speech_started':
      state.localUserSpeaking = true;
      setAvatarMood('listening');
      setConnectionStatus('listening');
      break;
    case 'input_audio_buffer.speech_stopped':
      state.localUserSpeaking = false;
      state.lastSpeechStoppedAt = performance.now();
      if (event.item_id) state.userItemSpeechStoppedAt.set(event.item_id, state.lastSpeechStoppedAt);
      setConnectionStatus('thinking');
      break;
    case 'conversation.item.created':
    case 'conversation.item.added':
    case 'conversation.item.retrieved': {
      handleConversationItem(event);
      break;
    }
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
      logEvent({
        type: 'client.user_transcription_failed',
        sessionId,
        item_id: event.item_id || null,
        error: event.error?.message || event.error || null
      });
      break;
    case 'output_audio_buffer.started':
      state.avatarSpeaking = true;
      setAvatarMood('speaking');
      setConnectionStatus('avatar speaking');
      if (state.lastSpeechStoppedAt) {
        const ms = Math.round(performance.now() - state.lastSpeechStoppedAt);
        state.latencySamples.push(ms);
        els.latencyStatus.textContent = `first reaction: ${ms}ms`;
        addMetric(`Realtime first audio: ${ms}ms / ${state.settings.realtimeDeployment}`);
      }
      break;
    case 'output_audio_buffer.stopped':
      state.avatarSpeaking = false;
      setAvatarMood('neutral');
      setConnectionStatus('connected');
      break;
    case 'response.output_audio_transcript.delta':
    case 'response.audio_transcript.delta':
    case 'response.output_text.delta':
    case 'response.text.delta': {
      const key = responseContentKey(event);
      const nextText = `${state.assistantTextByResponse.get(key) || ''}${event.delta || ''}`;
      state.assistantTextByResponse.set(key, nextText);
      state.currentAssistantText += event.delta || '';
      break;
    }
    case 'response.output_audio_transcript.done':
    case 'response.audio_transcript.done':
    case 'response.output_text.done':
    case 'response.text.done': {
      const contentKey = responseContentKey(event);
      const doneKey = responseDoneKey(event, contentKey);
      if (state.processedAssistantResponseKeys.has(doneKey)) {
        logEvent({ type: 'client.advisor_skipped', sessionId, reason: 'duplicate_done', key: doneKey });
        break;
      }
      state.processedAssistantResponseKeys.add(doneKey);
      if (state.processedAssistantResponseKeys.size > 80) {
        state.processedAssistantResponseKeys = new Set(Array.from(state.processedAssistantResponseKeys).slice(-40));
      }
      const text = (event.transcript || event.text || state.assistantTextByResponse.get(contentKey) || state.currentAssistantText || '').trim();
      state.assistantTextByResponse.delete(contentKey);
      if (text) {
        recordAssistantResponsePart(event, contentKey, text);
        scheduleAssistantResponseFlush(event.response_id || contentKey, sessionId, ASSISTANT_RESPONSE_FLUSH_MS);
      }
      state.currentAssistantText = '';
      break;
    }
    case 'response.done':
      state.avatarSpeaking = false;
      setAvatarMood('neutral');
      flushAssistantResponse(event.response?.id || event.response_id, sessionId, 'response_done');
      break;
    case 'error':
    case 'session.error':
      addAdvice('app', `Realtime error: ${event.error?.message || JSON.stringify(event.error || event)}`, 'risk');
      setAvatarMood('caution');
      break;
    default:
      break;
  }
}

function confirmRealtimeSession(event, sessionId, source) {
  if (source === 'session_created' && state.clientSessionUpdateRequired) {
    logEvent({
      type: 'client.session_created_before_update_ack',
      sessionId,
      expectedVoice: state.expectedRealtimeVoice
    });
    return;
  }

  const voice = event.session?.audio?.output?.voice || null;
  if (voice && state.expectedRealtimeVoice && voice !== state.expectedRealtimeVoice) {
    logEvent({
      type: 'client.realtime_voice_mismatch',
      sessionId,
      source,
      expected: state.expectedRealtimeVoice,
      actual: voice
    });
    addAdvice('app', `Realtime voice mismatch: expected=${state.expectedRealtimeVoice}, actual=${voice}`, 'risk');
    stopRealtime(false, sessionId);
    return;
  }

  if (state.realtimeSessionConfigured) return;
  state.clientSessionUpdateRequired = false;
  state.realtimeSessionConfigured = true;
  clearTimeout(state.sessionUpdateWatchdogTimer);
  enableMicrophoneTracks(sessionId);
  setConnectionStatus('connected');
  addAdvice('app', '接続しました。短い雑談を話しかけてください。', 'good');
  logEvent({
    type: 'client.session_configured',
    sessionId,
    source,
    advisorSource: 'realtime_response_transcript',
    voice: voice || state.expectedRealtimeVoice || null
  });
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

function userTranscriptKey(event) {
  return [
    event.item_id || 'no-item',
    event.content_index ?? 0
  ].join(':');
}

function handleConversationItem(event) {
  const item = event.item || {};
  if (item.role !== 'user' || !Array.isArray(item.content)) return;
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
      logEvent({ type: 'client.user_audio_pending_transcript', item_id: item.id || null, content_index: index });
    }
  }
}

function appendUserTranscriptDelta(event) {
  const key = userTranscriptKey(event);
  const nextText = `${state.userTextByItem.get(key) || ''}${event.delta || ''}`;
  state.userTextByItem.set(key, nextText);
}

function completeUserTranscript(event) {
  const key = userTranscriptKey(event);
  if (state.processedUserTranscriptKeys.has(key)) return;
  const text = String(event.transcript || state.userTextByItem.get(key) || '').trim();
  state.userTextByItem.delete(key);
  if (!text) return;
  state.processedUserTranscriptKeys.add(key);
  if (state.processedUserTranscriptKeys.size > 120) {
    state.processedUserTranscriptKeys = new Set(Array.from(state.processedUserTranscriptKeys).slice(-60));
  }
  addTranscript('user', text, {
    perfAt: state.userItemSpeechStoppedAt.get(event.item_id) || performance.now(),
    sourceId: event.item_id || ''
  });
  logEvent({ type: 'client.user_transcript_added', item_id: event.item_id || null, textChars: text.length });
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

function scheduleAssistantResponseFlush(responseId, sessionId, delayMs) {
  if (!responseId) return;
  clearTimeout(state.assistantResponseTimers.get(responseId));
  state.assistantResponseTimers.set(responseId, setTimeout(() => {
    flushAssistantResponse(responseId, sessionId, 'transcript_done_timeout');
  }, delayMs));
}

function flushAssistantResponse(responseId, sessionId, reason) {
  if (!responseId || state.processedAssistantResponses.has(responseId)) return;
  const parts = state.assistantResponseParts.get(responseId);
  if (!parts?.size) return;

  clearTimeout(state.assistantResponseTimers.get(responseId));
  state.assistantResponseTimers.delete(responseId);
  state.assistantResponseParts.delete(responseId);
  state.processedAssistantResponses.add(responseId);
  if (state.processedAssistantResponses.size > 80) {
    state.processedAssistantResponses = new Set(Array.from(state.processedAssistantResponses).slice(-40));
  }

  const text = Array.from(parts.values())
    .sort((a, b) => a.outputIndex - b.outputIndex || a.contentIndex - b.contentIndex || a.itemId.localeCompare(b.itemId))
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();

  if (!text) return;
  addTranscript('assistant', text);
  logEvent({ type: 'client.assistant_response_flushed', sessionId, responseId, reason, parts: parts.size, textChars: text.length });
  scheduleAdvisorFromRealtimeResponse(sessionId, responseId, text);
}

function scheduleAdvisorFromRealtimeResponse(sessionId, responseId, assistantText) {
  const speechStoppedAt = state.lastSpeechStoppedAt;
  setTimeout(() => {
    if (!isActiveRealtimeSession(sessionId)) return;
    const latestUser = latestTranscriptByRole('user', speechStoppedAt);
    if (latestUser) {
      requestAdvisor('user', latestUser.text, { sessionId, source: 'realtime_user_transcript', responseId });
    } else {
      requestAdvisor('assistant', `Realtimeアバター応答: ${assistantText}`, { sessionId, source: 'realtime_response_transcript', responseId });
    }
  }, ADVISOR_TRANSCRIPT_GRACE_MS);
}

function latestTranscriptByRole(role, minPerfAt = 0) {
  for (let i = state.transcript.length - 1; i >= 0; i -= 1) {
    if (state.transcript[i]?.role === role && state.transcript[i]?.text && Number(state.transcript[i].perfAt || 0) >= minPerfAt) {
      return state.transcript[i];
    }
  }
  return null;
}

function enableMicrophoneTracks(sessionId = state.activeRealtimeSessionId) {
  if (!isActiveRealtimeSession(sessionId)) return;
  state.mediaStream?.getAudioTracks().forEach((track) => {
    track.enabled = true;
  });
}

function formatApiError(data, fallback) {
  if (!data || typeof data !== 'object') return fallback;
  const parts = [data.error || fallback];
  const details = [];
  if (data.status) details.push(`status=${data.status}`);
  if (data.deployment) details.push(`deployment=${data.deployment}`);
  if (data.endpointHost) details.push(`endpoint=${data.endpointHost}`);
  if (data.apiVersion) details.push(`api=${data.apiVersion}`);
  const requestId = data.requestIds?.['apim-request-id'] || data.requestIds?.['x-ms-request-id'];
  if (requestId) details.push(`requestId=${requestId}`);
  if (data.azureError?.code) details.push(`code=${data.azureError.code}`);
  if (details.length) parts.push(`(${details.join(', ')})`);
  return parts.join(' ');
}

async function stopRealtime(showMessage = true, sessionId = state.activeRealtimeSessionId) {
  if (!isActiveRealtimeSession(sessionId)) {
    logEvent({ type: 'client.realtime_stop_skipped', reason: 'stale_session', sessionId });
    return;
  }
  state.activeRealtimeSessionId += 1;
  try {
    state.dataChannel?.close();
    for (const sender of state.pc?.getSenders?.() || []) {
      sender.track?.stop();
    }
    for (const receiver of state.pc?.getReceivers?.() || []) {
      receiver.track?.stop();
    }
    state.pc?.close();
    state.mediaStream?.getTracks().forEach((track) => track.stop());
    if (els.remoteAudio.srcObject) {
      els.remoteAudio.srcObject.getTracks?.().forEach((track) => track.stop());
      els.remoteAudio.srcObject = null;
    }
  } catch (error) {
    console.warn(error);
  }
  state.pc = null;
  state.dataChannel = null;
  state.mediaStream = null;
  state.realtimeStarting = false;
  state.expectedRealtimeVoice = '';
  state.clientSessionUpdateRequired = false;
  state.avatarSpeaking = false;
  state.localUserSpeaking = false;
  state.assistantTextByResponse.clear();
  for (const timer of state.assistantResponseTimers.values()) clearTimeout(timer);
  state.assistantResponseTimers.clear();
  state.assistantResponseParts.clear();
  state.processedAssistantResponseKeys.clear();
  state.processedAssistantResponses.clear();
  state.userTextByItem.clear();
  state.userItemSpeechStoppedAt.clear();
  state.processedUserTranscriptKeys.clear();
  state.currentAssistantText = '';
  clearTimeout(state.advisorQueueTimer);
  clearTimeout(state.sessionUpdateFallbackTimer);
  clearTimeout(state.sessionUpdateWatchdogTimer);
  state.advisorQueueTimer = null;
  state.sessionUpdateFallbackTimer = null;
  state.sessionUpdateWatchdogTimer = null;
  state.realtimeSessionConfigured = false;
  state.queuedAdvice = null;
  els.btnConnect.disabled = false;
  els.btnDisconnect.disabled = true;
  setConnectionStatus('idle');
  setAvatarMood('neutral');
  if (showMessage) addAdvice('app', '接続を終了しました。', 'warn');
}

async function sendText() {
  const text = els.textInput.value.trim();
  if (!text) return;
  els.textInput.value = '';
  addTranscript('user', text);
  immediateAdvice(text);

  if (state.dataChannel?.readyState === 'open') {
    const itemEvent = {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }]
      }
    };
    state.lastSpeechStoppedAt = performance.now();
    state.dataChannel.send(JSON.stringify(itemEvent));
    state.dataChannel.send(JSON.stringify({ type: 'response.create' }));
    logEvent({ type: 'client.text_sent_to_realtime', sessionId: state.activeRealtimeSessionId });
    return;
  }

  // Text fallback: lets the project work even before Realtime deployment is configured.
  try {
    setConnectionStatus('text fallback');
    const started = performance.now();
    state.realtimeCounters.chatFallbackRequests += 1;
    logEvent({ type: 'client.chat_fallback_request', count: state.realtimeCounters.chatFallbackRequests });
    const response = await fetch('/api/chat-turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deployment: state.settings.avatarTextDeployment || state.settings.advisorDeployment,
        transcript: state.transcript,
        instructions: state.settings.realtimeInstructions,
        maxTokens: state.settings.maxResponseTokens,
        reasoningEffort: state.settings.reasoningEffort
      })
    });
    const data = await safeJson(response);
    if (!response.ok) throw new Error(data.error || `chat-turn failed: ${response.status}`);
    const ms = Math.round(performance.now() - started);
    addTranscript('assistant', data.text || '(no text)');
    addMetric(`Text fallback response: ${ms}ms / ${data.deployment}`);
    setConnectionStatus('idle');
  } catch (error) {
    addAdvice('app', `テキスト応答に失敗しました: ${error.message || error}`, 'risk');
    setConnectionStatus('idle');
  }
}

function addTranscript(role, text, options = {}) {
  state.transcript.push({
    role,
    text,
    at: new Date().toISOString(),
    perfAt: Number(options.perfAt) || performance.now(),
    sourceId: options.sourceId || ''
  });
  state.transcript.sort((a, b) => Number(a.perfAt || 0) - Number(b.perfAt || 0));
  if (state.transcript.length > 80) state.transcript.shift();
  renderTranscriptFeed();
}

function renderTranscriptFeed() {
  els.transcriptFeed.innerHTML = '';
  for (const item of state.transcript) {
    appendTranscriptCard(item.role, item.text);
  }
  scrollToBottom(els.transcriptFeed);
}

function appendTranscriptCard(role, text) {
  const card = document.createElement('div');
  card.className = `card transcript ${role}`;
  card.innerHTML = `<div class="role">${escapeHtml(role === 'user' ? 'あなた' : 'アバター')}</div><div class="body">${escapeHtml(text)}</div>`;
  els.transcriptFeed.appendChild(card);
}

function addAdvice(source, text, label = 'good', meta = '') {
  const card = document.createElement('div');
  card.className = `card ${labelToClass(label)}`;
  const time = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  card.innerHTML = `<div class="meta"><span>${escapeHtml(source)}</span><span>${escapeHtml(meta || time)}</span></div><div class="body">${escapeHtml(text)}</div>`;
  els.adviceFeed.appendChild(card);
  scrollToBottom(els.adviceFeed);
}

function immediateAdvice(text) {
  const t = text.trim();
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
  addAdvice('instant <200ms', message, label);
}

async function requestAdvisor(role, latestText, meta = {}) {
  if (meta.sessionId && !isActiveRealtimeSession(meta.sessionId)) {
    logEvent({ type: 'client.advisor_skipped', reason: 'stale_session', sessionId: meta.sessionId });
    return;
  }
  const now = performance.now();
  if (now < state.advisorBackoffUntil) {
    state.queuedAdvice = { role, latestText, meta };
    const waitMs = Math.ceil(state.advisorBackoffUntil - now);
    logEvent({ type: 'client.advisor_deferred', reason: 'backoff', waitMs });
    scheduleQueuedAdvisor(waitMs);
    return;
  }
  if (state.advisorInFlight || now - state.lastAdvisorStartedAt < ADVISOR_MIN_INTERVAL_MS) {
    state.queuedAdvice = { role, latestText, meta };
    const waitMs = state.advisorInFlight
      ? ADVISOR_MIN_INTERVAL_MS
      : Math.ceil(ADVISOR_MIN_INTERVAL_MS - (now - state.lastAdvisorStartedAt));
    logEvent({ type: 'client.advisor_deferred', reason: state.advisorInFlight ? 'in_flight' : 'rate_limit', waitMs });
    scheduleQueuedAdvisor(waitMs);
    return;
  }

  const id = ++state.adviceCounter;
  const started = performance.now();
  state.advisorInFlight = true;
  state.lastAdvisorStartedAt = started;
  state.realtimeCounters.advisorRequests += 1;
  logEvent({
    type: 'client.advisor_request',
    id,
    count: state.realtimeCounters.advisorRequests,
    sessionId: meta.sessionId || null,
    source: meta.source || 'manual',
    deployment: state.settings.advisorDeployment
  });
  try {
    const response = await fetch('/api/advisor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deployment: state.settings.advisorDeployment,
        instructions: state.settings.advisorInstructions,
        reasoningEffort: state.settings.reasoningEffort,
        maxTokens: state.settings.advisorMaxTokens,
        latest: { role, text: latestText },
        transcript: state.transcript
      })
    });
    if (meta.sessionId && !isActiveRealtimeSession(meta.sessionId)) {
      logEvent({ type: 'client.advisor_result_ignored', reason: 'stale_session', sessionId: meta.sessionId, id });
      return;
    }
    const data = await safeJson(response);
    if (!response.ok) {
      const message = formatAdvisorError(data, response.status);
      logEvent({ type: 'client.advisor_error', status: response.status, error: data.error || response.statusText, attempts: data.attempts || [] });
      if (response.status === 429) {
        const serverRetryMs = Number(data.retryAfterMs) || 0;
        const attemptRetryMs = Math.max(0, ...(data.attempts || []).map((attempt) => Number(attempt.retryAfterMs) || 0));
        const backoffMs = Math.max(ADVISOR_BACKOFF_MS, serverRetryMs, attemptRetryMs);
        state.advisorBackoffUntil = performance.now() + backoffMs;
        state.advisorErrorMutedUntil = performance.now() + ADVISOR_ERROR_MUTE_MS;
        state.queuedAdvice = null;
        addAdvice('app', `Advisorが429を返したため、約${Math.ceil(backoffMs / 1000)}秒間LLM助言を停止します。即時助言だけ継続します。`, 'warn');
        return;
      }
      throw new Error(message);
    }
    const ms = Math.round(performance.now() - started);
    const label = data.label || 'good';
    const text = data.advice ? `${data.advice}${data.reason ? `\n理由: ${data.reason}` : ''}` : (data.text || '(no advice)');
    addAdvice(`LLM #${id}`, text, label, `${ms}ms / ${data.deployment || state.settings.advisorDeployment}`);
    addMetric(`Advisor: ${ms}ms / ${data.deployment || state.settings.advisorDeployment}`);
  } catch (error) {
    if (meta.sessionId && !isActiveRealtimeSession(meta.sessionId)) {
      logEvent({ type: 'client.advisor_error_ignored', reason: 'stale_session', sessionId: meta.sessionId, id });
      return;
    }
    if (performance.now() >= state.advisorErrorMutedUntil) {
      addAdvice(`LLM #${id}`, `助言生成に失敗しました: ${error.message || error}`, 'risk');
    }
  } finally {
    state.advisorInFlight = false;
    runQueuedAdvisor();
  }
}

function scheduleQueuedAdvisor(waitMs) {
  clearTimeout(state.advisorQueueTimer);
  state.advisorQueueTimer = setTimeout(runQueuedAdvisor, waitMs);
}

function runQueuedAdvisor() {
  if (!state.queuedAdvice || state.advisorInFlight) return;
  const now = performance.now();
  const nextAllowedAt = Math.max(state.advisorBackoffUntil, state.lastAdvisorStartedAt + ADVISOR_MIN_INTERVAL_MS);
  if (now < nextAllowedAt) {
    scheduleQueuedAdvisor(Math.ceil(nextAllowedAt - now));
    return;
  }
  const next = state.queuedAdvice;
  state.queuedAdvice = null;
  requestAdvisor(next.role, next.latestText, next.meta || {});
}

function formatAdvisorError(data, status) {
  const lines = [data.error || `advisor failed: ${status}`];
  if (Array.isArray(data.attempts) && data.attempts.length) {
    lines.push('試行詳細:');
    for (const attempt of data.attempts) {
      const params = attempt.request?.parameters || {};
      const tokenParam = Object.prototype.hasOwnProperty.call(params, 'max_completion_tokens')
        ? `max_completion_tokens=${params.max_completion_tokens}`
        : `max_tokens=${params.max_tokens}`;
      const reasoning = Object.prototype.hasOwnProperty.call(params, 'reasoning_effort')
        ? `, reasoning_effort=${params.reasoning_effort}`
        : '';
      lines.push(`- ${attempt.name}: HTTP ${attempt.status}, ${tokenParam}${reasoning}, ${attempt.message}`);
    }
  }
  return lines.join('\n');
}

async function benchmarkAdvisorModels() {
  const models = String(state.settings.benchmarkAdvisorDeployments || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (!models.length) {
    addMetric('Benchmark: モデル名が空です。設定で benchmark deployments を入力してください。');
    return;
  }
  const plannedCalls = models.length * 3;
  if (!window.confirm(`助言LLMベンチは /api/advisor を ${plannedCalls} 回呼びます。実行しますか？`)) {
    addMetric(`Benchmark cancelled: planned advisor calls=${plannedCalls}`);
    return;
  }
  addMetric(`Benchmark start: ${models.join(', ')}`);
  const probeTranscript = [
    { role: 'assistant', text: '最近、出社が増えてきましたね。どうですか？' },
    { role: 'user', text: '正直、移動が面倒で集中もしにくいですね。' }
  ];
  for (const model of models) {
    const samples = [];
    for (let i = 0; i < 3; i += 1) {
      const started = performance.now();
      try {
        const response = await fetch('/api/advisor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deployment: model,
            instructions: state.settings.advisorInstructions,
            reasoningEffort: state.settings.reasoningEffort,
            maxTokens: state.settings.advisorMaxTokens,
            latest: probeTranscript[1],
            transcript: probeTranscript
          })
        });
        const data = await safeJson(response);
        if (!response.ok) throw new Error(data.error || response.statusText);
        samples.push(Math.round(performance.now() - started));
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

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

async function checkHealth() {
  try {
    const response = await fetch('/api/health');
    const data = await safeJson(response);
    applyServerSettings(data);
    addMetric(`Health: ${JSON.stringify(data)}`);
    addAdvice('app', data.ready ? 'API設定は最低限そろっています。' : 'API設定が不足しています。READMEのApp Settingsを確認してください。', data.ready ? 'good' : 'warn');
  } catch (error) {
    addAdvice('app', `API確認に失敗しました: ${error.message || error}`, 'risk');
  }
}

function addMetric(text) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `<div class="meta"><span>metric</span><span>${new Date().toLocaleTimeString('ja-JP', { hour12: false })}</span></div><div class="body">${escapeHtml(text)}</div>`;
  els.metricsFeed.appendChild(card);
  scrollToBottom(els.metricsFeed);
}

function logEvent(event) {
  const card = document.createElement('div');
  card.className = 'card';
  const compact = compactEvent(event);
  card.innerHTML = `<div class="meta"><span>${escapeHtml(event.type || 'event')}</span><span>${new Date().toLocaleTimeString('ja-JP', { hour12: false })}</span></div><div class="body">${escapeHtml(JSON.stringify(compact, null, 2))}</div>`;
  els.eventFeed.appendChild(card);
  if (els.eventFeed.children.length > 120) els.eventFeed.removeChild(els.eventFeed.firstChild);
  scrollToBottom(els.eventFeed);
}

function compactEvent(event) {
  const clone = { ...event };
  if (typeof clone.delta === 'string' && clone.delta.length > 120) clone.delta = `${clone.delta.slice(0, 120)}…`;
  if (typeof clone.transcript === 'string' && clone.transcript.length > 160) clone.transcript = `${clone.transcript.slice(0, 160)}…`;
  return clone;
}

function setConnectionStatus(text) {
  els.connectionStatus.textContent = text;
}

function labelToClass(label) {
  if (label === 'risk') return 'risk';
  if (label === 'warn') return 'warn';
  return 'good';
}

async function safeJson(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { text }; }
}

function scrollToBottom(el) {
  requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
