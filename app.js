import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import * as THREE_VRM from '@pixiv/three-vrm';
import { createVRMAnimationClip, VRMAnimationLoaderPlugin, VRMLookAtQuaternionProxy } from '@pixiv/three-vrm-animation';

const defaultSettings = Object.freeze({
  realtimeDeployment: 'gpt-realtime-2',
  advisorDeployment: 'grok-4-20-non-reasoning',
  avatarTextDeployment: 'gpt-5.4-nano',
  voice: 'marin',
  voiceSpeed: 1.25,
  vadSilenceMs: 650,
  vadThreshold: 0.65,
  vadMinSpeechMs: 450,
  noiseReduction: 'far_field',
  advisorMaxTokens: 2048,
  reasoningEffort: 'none',
  benchmarkAdvisorDeployments: 'grok-4-20-non-reasoning,gpt-5.4-nano',
  realtimeInstructions: `あなたは雑談訓練用アバターです。目的は、在宅勤務に慣れた社員がオフィスで自然に短い雑談をできるようにすることです。\n\n制約:\n- 日本語で話す。\n- 返答は原則1文、長くても2文。\n- 最初の反応は短い相づち、共感、軽い質問を優先する。\n- 相手を評価しすぎない。\n- ビジネス上の機密、医療、法律、金融の助言は避ける。\n- 会話のテンポを最優先し、考え込まない。`,
  advisorInstructions: `あなたは会話練習のリアルタイム助言AIです。入力JSONの speaker="user" は訓練者本人で、画面では「あなた」と表示されます。speaker="avatar" は会話相手のAIアバターで、画面では「アバター」と表示されます。アバター発話をあなた自身の返答や訓練者発話として扱わないでください。\n\n助言対象:\n- latest_user_utterance がある場合、その user 発話だけを評価する。\n- conversation_log の avatar 発話は文脈としてだけ使う。\n- latest_user_utterance が null の場合だけ、アバター応答から状況を控えめに推定し、訓練者の発話内容を断定しない。\n\n出力形式:\n{ "label": "good|warn|risk", "advice": "1〜3文の日本語助言", "reason": "短い理由" }\n\n評価軸:\n- ユーザー発話が会話として成立しているか。\n- なごやかで居心地の良い雰囲気を維持しようとしているか。\n- ユーザーが自分の話したいことだけを話していないか。\n- 相手の話題に反復できているか。\n\n制約:\n- 返答はJSONのみ。\n- 速度優先。`
});

const ADVISOR_MIN_INTERVAL_MS = 3000;
const ADVISOR_BACKOFF_MS = 60000;
const ADVISOR_ERROR_MUTE_MS = 60000;
const ADVISOR_TRANSCRIPT_GRACE_MS = 1200;
const ASSISTANT_RESPONSE_FALLBACK_FLUSH_MS = 2500;
const AVATAR_AUDIO_RELEASE_DELAY_MS = 800;
const VAD_PREFIX_PADDING_MS = 300;
const USER_TURN_TRANSCRIPT_WAIT_MS = 800;
const DIAGNOSTIC_LOG_LIMIT = 1000;
const STAGE_TRANSCRIPT_LIMIT = 4;
const STAGE_ADVICE_TEXT_LIMIT = 96;
const LOG_FLUSH_DELAY_MS = 900;
const AVATAR_VRM_URL = './assets/8590256991748008892.vrm';
const AVATAR_VRMA_URL = './assets/relaxed_stand_idle_1s_skeleton_only_human_breath.vrma';
const DEVELOPER_ACCOUNT_EMAILS = Object.freeze(['developer@example.com']);
const DEVELOPER_ONLY_TABS = Object.freeze(['metrics', 'events']);

const serverSettingKeys = Object.freeze([
  'realtimeDeployment',
  'advisorDeployment',
  'avatarTextDeployment'
]);

const els = {
  pageLoading: document.getElementById('pageLoading'),
  pageLoadingText: document.getElementById('pageLoadingText'),
  stage: document.getElementById('vrmStage'),
  stageLoading: document.getElementById('stageLoading'),
  stageLoadingText: document.getElementById('stageLoadingText'),
  loginView: document.getElementById('loginView'),
  emailLoginForm: document.getElementById('emailLoginForm'),
  loginEmail: document.getElementById('loginEmail'),
  loginPassword: document.getElementById('loginPassword'),
  loginError: document.getElementById('loginError'),
  accountStatus: document.getElementById('accountStatus'),
  connectionStatus: document.getElementById('connectionStatus'),
  avatarStatus: document.getElementById('avatarStatus'),
  latencyStatus: document.getElementById('latencyStatus'),
  remoteAudio: document.getElementById('remoteAudio'),
  stageChatOverlay: document.getElementById('stageChatOverlay'),
  stageAdviceOverlay: document.getElementById('stageAdviceOverlay'),
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
  btnLogin: document.getElementById('btnLogin'),
  btnLogout: document.getElementById('btnLogout'),
  btnBenchAdvisor: document.getElementById('btnBenchAdvisor'),
  btnRefreshLogs: document.getElementById('btnRefreshLogs'),
  btnDeleteLog: document.getElementById('btnDeleteLog'),
  btnClearAdvice: document.getElementById('btnClearAdvice'),
  btnClearTranscript: document.getElementById('btnClearTranscript'),
  btnClearEvents: document.getElementById('btnClearEvents'),
  btnExportEvents: document.getElementById('btnExportEvents'),
  btnResetSettings: document.getElementById('btnResetSettings'),
  textInput: document.getElementById('textInput'),
  savedSessionsFeed: document.getElementById('savedSessionsFeed'),
  savedLogFeed: document.getElementById('savedLogFeed')
};

const state = {
  settings: loadSettings(),
  pc: null,
  dataChannel: null,
  mediaStream: null,
  microphoneEnabled: false,
  activeRealtimeSessionId: 0,
  realtimeStarting: false,
  connectionLoading: false,
  connectionLoadingText: '',
  avatarLoading: true,
  avatarLoadingText: 'アバターを読み込んでいます',
  expectedRealtimeVoice: '',
  clientSessionUpdateRequired: false,
  realtimeCounters: {
    tokenRequests: 0,
    sdpExchanges: 0,
    advisorRequests: 0,
    chatFallbackRequests: 0
  },
  authUser: null,
  authChecked: false,
  developerToolsEnabled: false,
  logSessionId: '',
  logSessionStartedAt: '',
  logSequence: 0,
  logFlushTimer: null,
  logFlushInFlight: false,
  pendingLogItems: [],
  persistedLogItemCount: 0,
  persistedTranscriptCount: 0,
  persistedAdviceCount: 0,
  selectedSavedSessionId: '',
  transcript: [],
  currentAssistantText: '',
  assistantTextByResponse: new Map(),
  assistantResponseParts: new Map(),
  assistantResponseTimers: new Map(),
  assistantResponseMeta: new Map(),
  activeAssistantAudioResponseIds: new Set(),
  microphoneRestoreTimer: null,
  processedAssistantResponseKeys: new Set(),
  processedAssistantResponses: new Set(),
  userTextByItem: new Map(),
  userTurnByItem: new Map(),
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
  sessionUpdateWatchdogTimer: null,
  diagnosticEvents: []
};

const sceneState = {
  renderer: null,
  scene: null,
  camera: null,
  controls: null,
  resizeObserver: null,
  frontKeyLight: null,
  vrConversationGroup: null,
  vrHudGroup: null,
  vrConversationMeshes: [],
  vrAdviceMesh: null,
  latestVRAdviceText: 'アドバイス',
  vrm: null,
  animationMixer: null,
  clock: new THREE.Clock(),
  blinkTimer: 0.4 + Math.random() * 1.6,
  blinkProgress: 0,
  blinkDuration: 0.12,
  mouthTimer: 0,
  mouthValue: 0,
  mouthExpressionIndex: 0,
  audioContext: null,
  lipSource: null,
  lipAnalyser: null,
  lipData: null
};

initTabs();
initSettingsDialog();
initScene();
wireEvents();
renderDeveloperControls();
addAdvice('app', 'まず「接続開始」を押してください。マイク許可後、アバターとの音声対話が始まります。', 'good');
loadAuthState();
syncServerSettings();

function loadSettings() {
  const raw = localStorage.getItem('zatsucoach.settings.v1');
  if (!raw) return { ...defaultSettings };
  try {
    const settings = { ...defaultSettings, ...JSON.parse(raw) };
    delete settings.maxResponseTokens;
    delete settings.webrtcFilter;
    if (!Number.isFinite(Number(settings.advisorMaxTokens)) || Number(settings.advisorMaxTokens) < 512) {
      settings.advisorMaxTokens = defaultSettings.advisorMaxTokens;
    }
    settings.advisorDeployment = normalizeAdvisorDeploymentSetting(settings.advisorDeployment);
    if (settings.advisorDeployment === 'gpt-5.4-nano') settings.advisorDeployment = defaultSettings.advisorDeployment;
    settings.benchmarkAdvisorDeployments = String(settings.benchmarkAdvisorDeployments || defaultSettings.benchmarkAdvisorDeployments)
      .split(',')
      .map((name) => normalizeAdvisorDeploymentSetting(name.trim()))
      .filter(Boolean)
      .join(',');
    if (settings.benchmarkAdvisorDeployments === 'gpt-5.4-nano,gpt-5-nano') {
      settings.benchmarkAdvisorDeployments = defaultSettings.benchmarkAdvisorDeployments;
    }
    if (Number(settings.advisorMaxTokens) <= 1024) settings.advisorMaxTokens = defaultSettings.advisorMaxTokens;
    if (Number(settings.advisorMaxTokens) > 4096) {
      settings.advisorMaxTokens = defaultSettings.advisorMaxTokens;
    }
    if (Number(settings.vadSilenceMs) < 500) {
      settings.vadSilenceMs = defaultSettings.vadSilenceMs;
    }
    if (Number(settings.vadThreshold) === 0.55) settings.vadThreshold = defaultSettings.vadThreshold;
    if (!Number.isFinite(Number(settings.vadThreshold))) settings.vadThreshold = defaultSettings.vadThreshold;
    if (!Number.isFinite(Number(settings.vadMinSpeechMs)) || Number(settings.vadMinSpeechMs) < 0 || Number(settings.vadMinSpeechMs) > 2000) {
      settings.vadMinSpeechMs = defaultSettings.vadMinSpeechMs;
    }
    settings.noiseReduction = normalizeNoiseReductionSetting(settings.noiseReduction);
    return settings;
  } catch {
    return { ...defaultSettings };
  }
}

function normalizeAdvisorDeploymentSetting(value) {
  const raw = String(value || '').trim();
  const aliases = {
    'kimi-2.6': 'Kimi-K2.6',
    'kimi-k2.6': 'Kimi-K2.6',
    'kimi-k2-6': 'Kimi-K2.6',
    'kimi-2.5': 'Kimi-K2.5',
    'kimi-k2.5': 'Kimi-K2.5',
    'kimi-k2-5': 'Kimi-K2.5'
  };
  return aliases[raw.toLowerCase()] || raw;
}

function normalizeNoiseReductionSetting(value) {
  const mode = String(value || defaultSettings.noiseReduction).trim().toLowerCase();
  return ['far_field', 'near_field', 'off'].includes(mode) ? mode : defaultSettings.noiseReduction;
}

function saveSettings(next) {
  state.settings = { ...defaultSettings, ...next };
  state.settings.advisorDeployment = normalizeAdvisorDeploymentSetting(state.settings.advisorDeployment);
  state.settings.noiseReduction = normalizeNoiseReductionSetting(state.settings.noiseReduction);
  state.settings.benchmarkAdvisorDeployments = String(state.settings.benchmarkAdvisorDeployments || '')
    .split(',')
    .map((name) => normalizeAdvisorDeploymentSetting(name.trim()))
    .filter(Boolean)
    .join(',');
  delete state.settings.maxResponseTokens;
  delete state.settings.webrtcFilter;
  localStorage.setItem('zatsucoach.settings.v1', JSON.stringify(state.settings));
}

async function syncServerSettings() {
  if (!state.authUser) return;
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

async function loadAuthState() {
  try {
    const response = await fetch('/api/auth/me', { cache: 'no-store' });
    if (!response.ok) throw new Error(`auth check failed: ${response.status}`);
    const data = await safeJson(response);
    const principal = data?.clientPrincipal || null;
    const roles = Array.isArray(principal?.userRoles) ? principal.userRoles : [];
    state.authUser = principal && roles.includes('authenticated') ? principal : null;
  } catch {
    state.authUser = null;
  } finally {
    state.authChecked = true;
    state.developerToolsEnabled = isDeveloperAccount(state.authUser);
    renderAuthState();
    renderDeveloperControls();
    if (state.authUser) {
      loadSavedSessions();
    } else {
      resetCurrentLogSession();
    }
    if (state.authUser) syncServerSettings();
    setPageLoading(false);
  }
}

function renderAuthState() {
  const details = state.authUser?.userDetails || '';
  if (els.accountStatus) {
    els.accountStatus.textContent = details ? `account: ${details}` : 'account: local/anonymous';
    els.accountStatus.title = details || 'local/anonymous';
  }
  if (els.btnLogin) els.btnLogin.style.display = state.authUser ? 'none' : '';
  if (els.btnLogout) els.btnLogout.style.display = state.authUser ? '' : 'none';
  if (els.loginView) els.loginView.hidden = Boolean(state.authUser);
  const main = document.querySelector('main.layout');
  if (main) main.hidden = !state.authUser;
  if (state.authUser) scheduleStageResize();
  if (els.btnConnect) els.btnConnect.disabled = !state.authUser || state.realtimeStarting || state.connectionLoading || Boolean(state.pc || state.dataChannel);
  if (!state.authUser && location.pathname !== '/login') {
    history.replaceState(null, '', '/login');
  } else if (state.authUser && location.pathname === '/login') {
    history.replaceState(null, '', '/');
  }
}

async function loginWithEmail(event) {
  event.preventDefault();
  const email = els.loginEmail.value.trim();
  const password = els.loginPassword.value;
  if (els.loginError) els.loginError.textContent = '';

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await safeJson(response);
    if (!response.ok) throw new Error(data.error || `login failed: ${response.status}`);
    els.loginPassword.value = '';
    await loadAuthState();
  } catch (error) {
    if (els.loginError) els.loginError.textContent = 'ログインできません。Email と Password を確認してください。';
  }
}

function initTabs() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      activateTab(tab.dataset.tab);
    });
  }
}

function activateTab(name) {
  const tab = document.querySelector(`.tab[data-tab="${name}"]`);
  const body = document.getElementById(`${name}Tab`);
  if (!tab || !body || tab.hidden || body.hidden) return;
  document.querySelectorAll('.tab').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('.tabBody').forEach((el) => el.classList.remove('active'));
  tab.classList.add('active');
  body.classList.add('active');
}

function renderDeveloperControls() {
  const enabled = canUseDeveloperTools();
  setHidden(els.btnHealth, !enabled);
  setHidden(els.btnSettings, !enabled);
  for (const name of DEVELOPER_ONLY_TABS) {
    setHidden(document.querySelector(`.tab[data-tab="${name}"]`), !enabled);
    setHidden(document.getElementById(`${name}Tab`), !enabled);
  }
  if (!enabled) {
    if (els.settingsDialog?.open) els.settingsDialog.close();
    if (els.metricsFeed) els.metricsFeed.innerHTML = '';
    if (els.eventFeed) els.eventFeed.innerHTML = '';
    state.diagnosticEvents = [];
    const activeTab = document.querySelector('.tab.active');
    if (!activeTab || activeTab.hidden || DEVELOPER_ONLY_TABS.includes(activeTab.dataset.tab)) {
      activateTab('advice');
    }
  }
}

function setHidden(el, hidden) {
  if (el) el.hidden = Boolean(hidden);
}

function setPageLoading(loading, text = 'ページを読み込んでいます') {
  if (!els.pageLoading) return;
  if (els.pageLoadingText && text) els.pageLoadingText.textContent = text;
  els.pageLoading.classList.toggle('is-hidden', !loading);
  els.pageLoading.setAttribute('aria-hidden', loading ? 'false' : 'true');
}

function setAvatarLoading(loading, text = '') {
  state.avatarLoading = Boolean(loading);
  if (text) state.avatarLoadingText = text;
  renderStageLoading();
}

function setConnectionLoading(loading, text = '') {
  state.connectionLoading = Boolean(loading);
  if (text) state.connectionLoadingText = text;
  if (els.btnConnect) {
    els.btnConnect.classList.toggle('busy', state.connectionLoading);
    els.btnConnect.textContent = state.connectionLoading ? '接続中' : '接続開始';
    els.btnConnect.disabled = !state.authUser || state.realtimeStarting || state.connectionLoading || Boolean(state.pc || state.dataChannel);
  }
  if (els.connectionStatus) {
    els.connectionStatus.classList.toggle('busy', state.connectionLoading);
  }
  renderStageLoading();
}

function renderStageLoading() {
  if (!els.stageLoading) return;
  const text = state.connectionLoading
    ? (state.connectionLoadingText || '接続しています')
    : state.avatarLoading
      ? (state.avatarLoadingText || 'アバターを読み込んでいます')
      : '';
  const visible = Boolean(text);
  if (els.stageLoadingText && text) els.stageLoadingText.textContent = text;
  els.stageLoading.classList.toggle('is-hidden', !visible);
  els.stageLoading.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

function canUseDeveloperTools() {
  return Boolean(state.developerToolsEnabled);
}

function isDeveloperAccount(principal) {
  const allowed = new Set(DEVELOPER_ACCOUNT_EMAILS);
  return principalIdentityValues(principal).some((value) => allowed.has(value));
}

function principalIdentityValues(principal) {
  if (!principal) return [];
  const values = [
    principal.userDetails,
    claimValue(principal, 'email'),
    claimValue(principal, 'emailaddress'),
    claimValue(principal, 'emails'),
    claimValue(principal, 'preferred_username'),
    claimValue(principal, 'upn'),
    claimValue(principal, 'unique_name')
  ];
  return values
    .flatMap(expandIdentityValue)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function expandIdentityValue(value) {
  if (Array.isArray(value)) return value.flatMap(expandIdentityValue);
  const text = String(value || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.flatMap(expandIdentityValue);
  } catch {
    // Not JSON; split common multi-value claim formats below.
  }
  return text.split(/[;,]/);
}

function claimValue(principal, name) {
  const claims = Array.isArray(principal?.claims) ? principal.claims : [];
  const match = claims.find((claim) => {
    const type = String(claim.typ || claim.type || claim.name || '').toLowerCase();
    return type === name || type.endsWith(`/${name}`);
  });
  return match?.val || match?.value || '';
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
    for (const key of ['voiceSpeed', 'vadSilenceMs', 'vadThreshold', 'vadMinSpeechMs', 'advisorMaxTokens']) {
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
  els.emailLoginForm.addEventListener('submit', loginWithEmail);
  els.btnConnect.addEventListener('click', startRealtime);
  els.btnDisconnect.addEventListener('click', stopRealtime);
  els.btnSendText.addEventListener('click', sendText);
  els.textInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') sendText();
  });
  els.btnHealth.addEventListener('click', checkHealth);
  els.btnBenchAdvisor.addEventListener('click', benchmarkAdvisorModels);
  els.btnRefreshLogs.addEventListener('click', loadSavedSessions);
  els.btnDeleteLog.addEventListener('click', deleteSelectedSavedSession);
  els.btnClearAdvice.addEventListener('click', () => {
    els.adviceFeed.innerHTML = '';
    setStageAdvice('アドバイス');
  });
  els.btnClearTranscript.addEventListener('click', () => {
    closeCurrentLogSession('cleared');
    state.transcript = [];
    state.userTextByItem.clear();
    clearUserTurnState();
    state.userItemSpeechStoppedAt.clear();
    state.processedUserTranscriptKeys.clear();
    els.transcriptFeed.innerHTML = '';
    renderStageTranscript();
    updateVRConversationPanels();
  });
  els.btnClearEvents.addEventListener('click', () => {
    state.diagnosticEvents = [];
    els.eventFeed.innerHTML = '';
  });
  els.btnExportEvents.addEventListener('click', exportDiagnosticEvents);
  window.addEventListener('beforeunload', () => {
    flushLogItems();
    stopRealtime(false);
  });
}

function initScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x10151f);

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 1.35, 3.1);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.xr.enabled = true;
  els.stage.appendChild(renderer.domElement);
  els.stage.appendChild(VRButton.createButton(renderer));

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.25, 0);
  controls.enableDamping = true;
  controls.minDistance = 1.5;
  controls.maxDistance = 6;

  setupAvatarLighting(scene, camera);

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
  setupVRTextPanels(scene, camera);

  window.addEventListener('resize', resizeStageRenderer);
  if ('ResizeObserver' in window) {
    sceneState.resizeObserver = new ResizeObserver(resizeStageRenderer);
    sceneState.resizeObserver.observe(els.stage);
  }
  resizeStageRenderer();

  loadVRM(AVATAR_VRM_URL);
  renderer.setAnimationLoop(renderLoop);
}

function scheduleStageResize() {
  requestAnimationFrame(() => {
    resizeStageRenderer();
    requestAnimationFrame(resizeStageRenderer);
  });
}

function resizeStageRenderer() {
  if (!sceneState.renderer || !sceneState.camera || !els.stage) return;
  const rect = els.stage.getBoundingClientRect();
  const width = Math.floor(rect.width);
  const height = Math.floor(rect.height);
  if (width <= 0 || height <= 0) return;

  sceneState.renderer.setSize(width, height, false);
  sceneState.camera.aspect = Math.max(width / height, 0.1);
  sceneState.camera.updateProjectionMatrix();
}

function loadVRM(url) {
  setAvatarLoading(true, 'アバターを読み込んでいます');
  els.avatarStatus.textContent = 'avatar: loading VRM';
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  loader.load(url, (gltf) => {
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('VRM not found in glTF userData.');
    THREE_VRM.VRMUtils?.rotateVRM0?.(vrm);
    sceneState.scene.add(vrm.scene);
    sceneState.vrm = vrm;
    tuneAvatarMaterials(vrm.scene);
    fitVRM(vrm);
    addLookAtProxy(vrm);
    els.avatarStatus.textContent = 'avatar: ready';
    setAvatarMood('neutral');
    loadVRMA(AVATAR_VRMA_URL, vrm);
  }, (progress) => {
    if (progress.total) {
      const pct = Math.round((progress.loaded / progress.total) * 100);
      els.avatarStatus.textContent = `avatar: loading ${pct}%`;
      setAvatarLoading(true, `アバターを読み込んでいます (${pct}%)`);
    }
  }, (error) => {
    console.error(error);
    setAvatarLoading(false);
    els.avatarStatus.textContent = 'avatar: load failed';
    addAdvice('app', `VRMの読み込みに失敗しました: ${error.message || error}`, 'risk');
  });
}

function loadVRMA(url, vrm) {
  setAvatarLoading(true, 'アバターの待機モーションを読み込んでいます');
  els.avatarStatus.textContent = 'avatar: loading animation';
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  loader.load(url, (gltf) => {
    const vrmAnimation = gltf.userData.vrmAnimations?.[0];
    if (!vrmAnimation) throw new Error('VRMA not found in glTF userData.');
    const clip = createVRMAnimationClip(vrmAnimation, vrm);
    sceneState.animationMixer?.stopAllAction();
    sceneState.animationMixer = new THREE.AnimationMixer(vrm.scene);
    sceneState.animationMixer
      .clipAction(clip)
      .reset()
      .setLoop(THREE.LoopRepeat, Infinity)
      .play();
    vrm.humanoid?.resetNormalizedPose?.();
    els.avatarStatus.textContent = 'avatar: ready + reading loop';
    setAvatarLoading(false);
  }, (progress) => {
    if (progress.total) {
      const pct = Math.round((progress.loaded / progress.total) * 100);
      els.avatarStatus.textContent = `avatar: animation ${pct}%`;
      setAvatarLoading(true, `アバターの待機モーションを読み込んでいます (${pct}%)`);
    }
  }, (error) => {
    console.error(error);
    setAvatarLoading(false);
    els.avatarStatus.textContent = 'avatar: ready, animation failed';
    addAdvice('app', `VRMAの読み込みに失敗しました: ${error.message || error}`, 'warn');
  });
}

function addLookAtProxy(vrm) {
  if (!vrm.lookAt || vrm.scene.getObjectByName('lookAtQuaternionProxy')) return;
  const lookAtQuatProxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
  lookAtQuatProxy.name = 'lookAtQuaternionProxy';
  vrm.scene.add(lookAtQuatProxy);
}

function setupAvatarLighting(scene, camera) {
  scene.add(camera);

  const hemi = new THREE.HemisphereLight(0xf7f0ff, 0x243045, 0.48);
  scene.add(hemi);

  const frontKey = new THREE.DirectionalLight(0xfff1df, 3.25);
  frontKey.position.copy(camera.position);
  frontKey.target.position.set(0, 1.18, 0);
  scene.add(frontKey);
  scene.add(frontKey.target);

  const cameraFill = new THREE.PointLight(0xffe6d2, 0.95, 5, 1.25);
  cameraFill.position.set(0, 0, 0);
  camera.add(cameraFill);

  const rim = new THREE.DirectionalLight(0xb9ccff, 0.8);
  rim.position.set(-1.8, 2.5, -1.9);
  rim.target.position.set(0, 1.05, 0);
  scene.add(rim);
  scene.add(rim.target);

  sceneState.frontKeyLight = frontKey;
}

function syncCameraLighting() {
  if (!sceneState.frontKeyLight || !sceneState.camera) return;
  sceneState.frontKeyLight.position.copy(sceneState.camera.position);
}

function tuneAvatarMaterials(root) {
  root.traverse((object) => {
    if (!object.isMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material) continue;
      material.toneMapped = false;
      if ('roughness' in material) material.roughness = Math.max(material.roughness ?? 0.85, 0.9);
      if ('metalness' in material) material.metalness = 0;
      if ('envMapIntensity' in material) material.envMapIntensity = Math.min(material.envMapIntensity ?? 0.2, 0.2);
      if ('shadingShiftFactor' in material) material.shadingShiftFactor = -0.08;
      if ('shadingToonyFactor' in material) material.shadingToonyFactor = 0.92;
      if ('rimLightingMixFactor' in material) material.rimLightingMixFactor = 0.25;
      material.needsUpdate = true;
    }
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

function setupVRTextPanels(scene, camera) {
  const conversationGroup = new THREE.Group();
  conversationGroup.name = 'vrConversationBubbles';
  conversationGroup.visible = false;
  scene.add(conversationGroup);

  const hudGroup = new THREE.Group();
  hudGroup.name = 'vrConversationHud';
  hudGroup.visible = false;
  camera.add(hudGroup);

  sceneState.vrConversationGroup = conversationGroup;
  sceneState.vrHudGroup = hudGroup;
  updateVRConversationPanels();
  updateVRAdvicePanel(sceneState.latestVRAdviceText);
}

function updateVRConversationPanels() {
  if (!sceneState.vrConversationGroup || !sceneState.vrHudGroup) return;
  clearVRConversationPanels();

  let avatarRow = 0;
  let userRow = 0;
  for (const item of state.transcript.slice(-STAGE_TRANSCRIPT_LIMIT)) {
    const role = item.role === 'user' ? 'user' : 'assistant';
    const mesh = createVRTextPanel(normalizeStageText(item.text), {
      role,
      width: 0.82,
      height: 0.24,
      fontSize: 46,
      truncate: false,
      tail: role === 'user' ? 'user' : 'avatar',
      background: role === 'user' ? '#b8f20d' : '#f7f8f4',
      color: '#141820'
    });
    mesh.renderOrder = 30;

    if (role === 'user') {
      mesh.position.set(0.48, 0.25 - userRow * 0.22, -1.35);
      sceneState.vrHudGroup.add(mesh);
      userRow += 1;
    } else {
      mesh.position.set(-0.82, 1.72 - avatarRow * 0.28, 0.06);
      mesh.userData.billboardToCamera = true;
      sceneState.vrConversationGroup.add(mesh);
      avatarRow += 1;
    }
    sceneState.vrConversationMeshes.push(mesh);
  }
}

function clearVRConversationPanels() {
  for (const mesh of sceneState.vrConversationMeshes) {
    mesh.parent?.remove(mesh);
    disposeVRTextPanel(mesh);
  }
  sceneState.vrConversationMeshes = [];
}

function updateVRAdvicePanel(text) {
  sceneState.latestVRAdviceText = text || 'アドバイス';
  if (!sceneState.vrHudGroup) return;
  if (sceneState.vrAdviceMesh) {
    sceneState.vrHudGroup.remove(sceneState.vrAdviceMesh);
    disposeVRTextPanel(sceneState.vrAdviceMesh);
    sceneState.vrAdviceMesh = null;
  }

  const mesh = createVRTextPanel(sceneState.latestVRAdviceText, {
    role: 'advice',
    width: 1.25,
    height: 0.23,
    fontSize: 50,
    tail: 'none',
    background: '#fbfbf6',
    color: '#151922'
  });
  mesh.position.set(0, -0.43, -1.45);
  mesh.renderOrder = 40;
  sceneState.vrHudGroup.add(mesh);
  sceneState.vrAdviceMesh = mesh;
}

function createVRTextPanel(text, options) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  const minCanvasHeight = Math.round(canvas.width * (options.height / options.width));
  let ctx = canvas.getContext('2d');
  const paddingX = 78;
  const paddingY = 38;
  const sideTail = options.tail === 'left' || options.tail === 'right';
  const bottomTail = options.tail === 'avatar' || options.tail === 'user';
  const tailSize = options.tail === 'none' ? 0 : 54;
  const bottomTailSize = bottomTail ? tailSize : 0;
  const rectX = options.tail === 'left' ? tailSize : 0;
  const rectWidth = canvas.width - (sideTail ? tailSize : 0);
  const maxTextWidth = rectWidth - paddingX * 2;
  const lineHeight = options.fontSize * 1.24;
  const maxLines = options.truncate === false ? Infinity : (options.role === 'advice' ? 2 : 3);

  ctx.font = `600 ${options.fontSize}px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  const lines = wrapCanvasText(ctx, text, maxTextWidth, maxLines, options.truncate !== false);
  const bodyCanvasHeight = Math.max(minCanvasHeight, Math.ceil(paddingY * 2 + lines.length * lineHeight + 28));
  canvas.height = bodyCanvasHeight + bottomTailSize;
  ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = options.background;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
  ctx.shadowBlur = 26;
  ctx.shadowOffsetY = 10;
  drawBubbleShape(ctx, rectX + 8, 8, rectWidth - 16, bodyCanvasHeight - 24, 42, options.tail, tailSize);
  ctx.fill();

  ctx.shadowColor = 'transparent';
  ctx.fillStyle = options.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${options.fontSize}px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;

  const textCenterX = rectX + rectWidth / 2;
  const textBlockHeight = (lines.length - 1) * lineHeight;
  const textStartY = paddingY + (bodyCanvasHeight - paddingY * 2 - textBlockHeight) / 2;
  lines.forEach((line, index) => {
    ctx.fillText(line, textCenterX, textStartY + index * lineHeight);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(options.width, options.width * (canvas.height / canvas.width)),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  );
  mesh.userData.texture = texture;
  return mesh;
}

function drawBubbleShape(ctx, x, y, width, height, radius, tail, tailSize) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  if (tail === 'right') {
    ctx.lineTo(x + width, y + height - 78);
    ctx.lineTo(x + width + tailSize - 8, y + height - 48);
    ctx.lineTo(x + width, y + height - 26);
  } else {
    ctx.lineTo(x + width, y + height - radius);
  }
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  if (tail === 'avatar' || tail === 'user') {
    const baseCenter = tail === 'avatar' ? x + width * 0.72 : x + width * 0.68;
    const tipX = tail === 'avatar' ? baseCenter + tailSize * 0.42 : baseCenter - tailSize * 0.34;
    const tipY = y + height + tailSize - 8;
    const baseHalf = tailSize * 0.48;
    ctx.lineTo(baseCenter + baseHalf, y + height);
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(baseCenter - baseHalf, y + height);
  }
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  if (tail === 'left') {
    ctx.lineTo(x, y + height - 26);
    ctx.lineTo(x - tailSize + 8, y + height - 48);
    ctx.lineTo(x, y + height - 78);
  }
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function wrapCanvasText(ctx, text, maxWidth, maxLines, truncate = true) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (!source) return [''];
  const units = Array.from(source);
  const lines = [];
  let line = '';

  for (const unit of units) {
    const next = `${line}${unit}`;
    if (ctx.measureText(next).width <= maxWidth || !line) {
      line = next;
      continue;
    }
    lines.push(line.trim());
    line = unit;
    if (truncate && lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line.trim());
  if (truncate && lines.length > maxLines) lines.length = maxLines;

  const consumed = lines.join('');
  if (truncate && consumed.length < source.length && lines.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/…$/, '').slice(0, -1)}…`;
  }
  return lines;
}

function disposeVRTextPanel(mesh) {
  mesh.geometry?.dispose();
  mesh.material?.map?.dispose?.();
  mesh.material?.dispose?.();
}

function syncVRTextPanels() {
  if (!sceneState.renderer || !sceneState.vrConversationGroup || !sceneState.vrHudGroup) return;
  const presenting = sceneState.renderer.xr.isPresenting;
  sceneState.vrConversationGroup.visible = presenting;
  sceneState.vrHudGroup.visible = presenting;
  if (!presenting) return;

  const xrCamera = sceneState.renderer.xr.getCamera(sceneState.camera) || sceneState.camera;
  const cameraQuaternion = new THREE.Quaternion();
  xrCamera.getWorldQuaternion(cameraQuaternion);
  for (const mesh of sceneState.vrConversationMeshes) {
    if (mesh.userData.billboardToCamera) mesh.quaternion.copy(cameraQuaternion);
  }
}

function renderLoop() {
  const delta = sceneState.clock.getDelta();
  sceneState.controls?.update();
  syncCameraLighting();
  syncVRTextPanels();
  sceneState.animationMixer?.update(delta);
  animateAvatar(delta);
  sceneState.vrm?.update(delta);
  sceneState.renderer.render(sceneState.scene, sceneState.camera);
}

function animateAvatar(delta) {
  const vrm = sceneState.vrm;
  if (!vrm?.expressionManager) return;

  animateBlink(delta);
  animateMouth(delta);
}

function animateBlink(delta) {
  sceneState.blinkTimer -= delta;
  if (sceneState.blinkTimer > 0) return;

  sceneState.blinkProgress += delta / sceneState.blinkDuration;
  const blinkValue = Math.sin(Math.min(sceneState.blinkProgress, 1) * Math.PI);
  setExpressionMany(['blink', 'Blink'], blinkValue);

  if (sceneState.blinkProgress >= 1) {
    setExpressionMany(['blink', 'Blink'], 0);
    sceneState.blinkProgress = 0;
    sceneState.blinkDuration = 0.1 + Math.random() * 0.07;
    sceneState.blinkTimer = 1.8 + Math.random() * 4.2;
  }
}

function animateMouth(delta) {
  const audioLevel = getAvatarAudioLevel();
  const talking = state.avatarSpeaking || audioLevel > 0.02;
  const target = talking ? Math.min(1, audioLevel * 2.8 + 0.08) : 0;
  sceneState.mouthValue = THREE.MathUtils.lerp(sceneState.mouthValue, target, talking ? 0.55 : 0.28);
  sceneState.mouthTimer += delta;
  if (sceneState.mouthTimer > 0.09) {
    sceneState.mouthTimer = 0;
    sceneState.mouthExpressionIndex = (sceneState.mouthExpressionIndex + 1 + Math.floor(Math.random() * 2)) % 5;
  }
  setLipSyncExpressions(sceneState.mouthValue, sceneState.mouthExpressionIndex, talking);
}

function setLipSyncExpressions(level, expressionIndex, talking) {
  const damped = talking ? level : 0;
  const vowels = [
    { names: ['aa', 'A'], value: damped },
    { names: ['ih', 'I'], value: damped * 0.38 },
    { names: ['ee', 'E'], value: damped * 0.34 },
    { names: ['ou', 'U'], value: damped * 0.42 },
    { names: ['oh', 'O'], value: damped * 0.48 }
  ];
  for (let i = 0; i < vowels.length; i += 1) {
    const vowel = vowels[i];
    setExpressionMany(vowel.names, i === expressionIndex ? vowel.value : Math.min(vowel.value * 0.18, 0.16));
  }
}

function getAvatarAudioLevel() {
  const analyser = sceneState.lipAnalyser;
  const data = sceneState.lipData;
  if (!analyser || !data) return state.avatarSpeaking ? 0.18 + Math.random() * 0.18 : 0;
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const value of data) {
    const centered = (value - 128) / 128;
    sum += centered * centered;
  }
  const rms = Math.sqrt(sum / data.length);
  return Number.isFinite(rms) ? rms : 0;
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

function attachLipSyncAudioStream(stream) {
  try {
    if (!ensureLipSyncAudioContext()) return;
    sceneState.lipSource?.disconnect?.();
    sceneState.lipAnalyser = sceneState.audioContext.createAnalyser();
    sceneState.lipAnalyser.fftSize = 512;
    sceneState.lipAnalyser.smoothingTimeConstant = 0.38;
    sceneState.lipData = new Uint8Array(sceneState.lipAnalyser.fftSize);
    sceneState.lipSource = sceneState.audioContext.createMediaStreamSource(stream);
    sceneState.lipSource.connect(sceneState.lipAnalyser);
  } catch (error) {
    console.warn('Lip sync analyser setup failed', error);
    sceneState.lipSource = null;
    sceneState.lipAnalyser = null;
    sceneState.lipData = null;
  }
}

function ensureLipSyncAudioContext() {
  if (!sceneState.audioContext) {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return null;
    sceneState.audioContext = new AudioContextCtor();
  }
  sceneState.audioContext.resume?.();
  return sceneState.audioContext;
}

function resetLipSyncAudio() {
  try {
    sceneState.lipSource?.disconnect?.();
  } catch {
    // Ignore disconnect races during WebRTC teardown.
  }
  sceneState.lipSource = null;
  sceneState.lipAnalyser = null;
  sceneState.lipData = null;
  sceneState.mouthValue = 0;
  setLipSyncExpressions(0, sceneState.mouthExpressionIndex, false);
}

async function startRealtime() {
  if (!state.authUser) {
    renderAuthState();
    if (els.loginError) els.loginError.textContent = 'ログインしてから接続してください。';
    return;
  }
  if (state.realtimeStarting || state.pc || state.dataChannel) {
    logEvent({ type: 'client.realtime_start_skipped', reason: 'already_active', sessionId: state.activeRealtimeSessionId });
    return;
  }

  const sessionId = state.activeRealtimeSessionId + 1;
  state.activeRealtimeSessionId = sessionId;
  state.realtimeStarting = true;
  setConnectionLoading(true, '接続の準備をしています');
  state.expectedRealtimeVoice = String(state.settings.voice || '').trim().toLowerCase();
  state.clientSessionUpdateRequired = false;
  ensureLipSyncAudioContext();

  try {
    setConnectionLoading(true, '接続用トークンを取得しています');
    setConnectionStatus('requesting token');
    els.btnConnect.disabled = true;
    const tokenPayload = {
      realtimeDeployment: state.settings.realtimeDeployment,
      instructions: state.settings.realtimeInstructions,
      voice: state.expectedRealtimeVoice,
      voiceSpeed: Number(state.settings.voiceSpeed),
      vadSilenceMs: Number(state.settings.vadSilenceMs),
      vadThreshold: Number(state.settings.vadThreshold),
      noiseReduction: state.settings.noiseReduction
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

    setConnectionLoading(true, 'マイクの許可を待っています');
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
        attachLipSyncAudioStream(event.streams[0]);
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

    setConnectionLoading(true, 'Realtime に接続しています');
    setConnectionStatus('sdp exchange');
    const sdpStarted = performance.now();
    state.realtimeCounters.sdpExchanges += 1;
    logEvent({
      type: 'client.realtime_sdp_request',
      sessionId,
      count: state.realtimeCounters.sdpExchanges,
      deployment: tokenData.deployment,
      voice: tokenData.voice || state.expectedRealtimeVoice,
      eventStream: 'full',
      configMode: tokenData.configMode || 'unknown'
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
    setConnectionLoading(true, '接続の確立を待っています');
    setConnectionStatus('connecting');
    els.btnDisconnect.disabled = false;
  } catch (error) {
    console.error(error);
    setConnectionLoading(false);
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
    setConnectionLoading(true, '接続設定を確認しています');
    setConnectionStatus('configuring session');
    addAdvice('app', 'Realtime接続を確立しました。サーバー側で固定した音声設定を確認しています。', 'good');
    scheduleRealtimeSessionWatchdog(sessionId);
    if (tokenData.requiresClientSessionUpdate) {
      sendClientSessionUpdate(dc, sessionId, tokenData.sessionConfig);
    } else {
      confirmRealtimeSession({ session: tokenData.session }, sessionId, 'client_secret_session');
    }
    logEvent({ type: 'client.data_channel_open', sessionId, configMode: tokenData.configMode || 'unknown' });
  });
  dc.addEventListener('close', () => {
    if (!isActiveRealtimeSession(sessionId)) return;
    logEvent({ type: 'client.data_channel_close', sessionId });
    if (!state.realtimeSessionConfigured) setConnectionLoading(false);
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
      startUserTurn(event);
      break;
    case 'input_audio_buffer.speech_stopped':
      stopUserTurn(event, sessionId);
      break;
    case 'input_audio_buffer.committed':
      markUserTurnCommitted(event);
      break;
    case 'conversation.item.created':
    case 'conversation.item.added':
    case 'conversation.item.retrieved': {
      handleConversationItem(event, sessionId);
      break;
    }
    case 'conversation.item.input_audio_transcription.delta':
    case 'conversation.item.audio_transcription.delta':
      appendUserTranscriptDelta(event);
      break;
    case 'conversation.item.input_audio_transcription.completed':
    case 'conversation.item.audio_transcription.completed':
      completeUserTranscript(event, sessionId);
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
      clearTimeout(state.microphoneRestoreTimer);
      state.activeAssistantAudioResponseIds.add(audioOutputKey(event));
      setMicrophoneTracksEnabled(false, 'avatar_speaking');
      setAvatarMood('speaking');
      setConnectionStatus('avatar speaking');
      updateAssistantResponseMeta(event.response_id, {
        outputAudioStartedAt: performance.now()
      });
      if (state.lastSpeechStoppedAt) {
        const ms = Math.round(performance.now() - state.lastSpeechStoppedAt);
        state.latencySamples.push(ms);
        els.latencyStatus.textContent = `first reaction: ${ms}ms`;
        addMetric(`Realtime first audio: ${ms}ms / ${state.settings.realtimeDeployment}`);
      }
      break;
    case 'output_audio_buffer.stopped':
      if (event.response_id || event.item_id) {
        state.activeAssistantAudioResponseIds.delete(audioOutputKey(event));
      } else {
        state.activeAssistantAudioResponseIds.clear();
      }
      finishAvatarAudioOutput(sessionId, 'avatar_finished');
      updateAssistantResponseMeta(event.response_id, {
        outputAudioStoppedAt: performance.now()
      });
      if (event.response_id) scheduleAssistantResponseFlush(event.response_id, sessionId, 300, 'output_audio_buffer_stopped');
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
        scheduleAssistantResponseFlush(event.response_id || contentKey, sessionId, ASSISTANT_RESPONSE_FALLBACK_FLUSH_MS, 'transcript_done_fallback');
      }
      state.currentAssistantText = '';
      break;
    }
    case 'response.done':
      updateAssistantResponseMeta(event.response?.id || event.response_id, responseMetaFromDoneEvent(event));
      flushAssistantResponse(event.response?.id || event.response_id, sessionId, 'response_done');
      finishAvatarAudioOutput(sessionId, 'response_done');
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

  const voice = event.session?.audio?.output?.voice || event.session?.voice || null;
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
  setConnectionLoading(false);
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

function audioOutputKey(event) {
  return event.response_id || event.item_id || 'active-output-audio';
}

function startUserTurn(event) {
  state.localUserSpeaking = true;
  setAvatarMood('listening');
  setConnectionStatus('listening');

  const itemId = event.item_id || `pending-${event.event_id || Date.now().toString(36)}`;
  const previous = state.userTurnByItem.get(itemId) || {};
  clearTimeout(previous.decisionTimer);
  state.userTurnByItem.set(itemId, {
    ...previous,
    itemId,
    audioStartMs: Number(event.audio_start_ms),
    perfStartedAt: performance.now(),
    perfStoppedAt: 0,
    transcriptText: previous.transcriptText || '',
    committed: Boolean(previous.committed),
    accepted: false,
    ignored: false,
    responseSent: false,
    decisionTimer: null
  });
}

function stopUserTurn(event, sessionId) {
  state.localUserSpeaking = false;
  setConnectionStatus('checking input');

  const itemId = event.item_id || `pending-${event.event_id || Date.now().toString(36)}`;
  const turn = ensureUserTurn(itemId);
  turn.audioEndMs = Number(event.audio_end_ms);
  turn.perfStoppedAt = performance.now();
  turn.approxSpeechMs = estimateSpeechDurationMs(turn);
  state.userTurnByItem.set(itemId, turn);
  scheduleUserTurnDecision(itemId, sessionId, USER_TURN_TRANSCRIPT_WAIT_MS, 'speech_stopped');
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
    committed: false,
    accepted: false,
    ignored: false,
    responseSent: false,
    decisionTimer: null
  };
}

function estimateSpeechDurationMs(turn) {
  const start = Number(turn.audioStartMs);
  const end = Number(turn.audioEndMs);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  const silenceMs = Number(state.settings.vadSilenceMs) || defaultSettings.vadSilenceMs;
  return Math.max(0, Math.round(end - start - VAD_PREFIX_PADDING_MS - silenceMs));
}

function scheduleUserTurnDecision(itemId, sessionId, delayMs, reason) {
  const turn = state.userTurnByItem.get(itemId);
  if (!turn || turn.accepted || turn.ignored) return;
  clearTimeout(turn.decisionTimer);
  turn.decisionTimer = setTimeout(() => {
    decideUserTurn(itemId, sessionId, reason);
  }, delayMs);
}

function decideUserTurn(itemId, sessionId, reason) {
  if (!isActiveRealtimeSession(sessionId)) return;
  const turn = state.userTurnByItem.get(itemId);
  if (!turn || turn.accepted || turn.ignored) return;

  const decision = userTurnDecision(turn);
  if (decision.accept) {
    acceptUserTurn(turn, sessionId, decision.reason || reason);
    return;
  }
  ignoreUserTurn(turn, sessionId, decision.reason || reason);
}

function userTurnDecision(turn) {
  const text = String(turn.transcriptText || '').trim();
  if (hasUsefulTranscript(text)) {
    return { accept: true, reason: 'transcript' };
  }
  const configuredGateMs = Number(state.settings.vadMinSpeechMs);
  const gateMs = Number.isFinite(configuredGateMs) ? Math.max(0, configuredGateMs) : defaultSettings.vadMinSpeechMs;
  if (Number(turn.approxSpeechMs) >= gateMs) {
    return { accept: true, reason: 'duration' };
  }
  return { accept: false, reason: 'short_noise' };
}

function hasUsefulTranscript(text) {
  const normalized = String(text || '')
    .replace(/[、。！？!?.,，．・「」『』（）()\[\]\s]/g, '')
    .trim();
  if (!normalized) return false;
  if (/^(ありがとう|ありがとうございました|ご視聴ありがとうございました|ご清聴ありがとうございました)$/.test(normalized)) return false;
  if (/^(ピン|ポン|ピロン|カチ|カチャ|カタカタ|チーン|通知音|着信音|バイブ|ding|beep)$/i.test(normalized)) return false;
  if (/^(はい|うん|ええ|そう|そうですね|ですね|いや|まあ|なるほど)$/.test(normalized)) return true;
  return normalized.length >= 2 && /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}A-Za-z0-9]/u.test(normalized);
}

function acceptUserTurn(turn, sessionId, reason) {
  clearTimeout(turn.decisionTimer);
  turn.accepted = true;
  state.userTurnByItem.set(turn.itemId, turn);
  const stoppedAt = turn.perfStoppedAt || performance.now();
  state.lastSpeechStoppedAt = stoppedAt;
  if (turn.itemId) state.userItemSpeechStoppedAt.set(turn.itemId, stoppedAt);
  setConnectionStatus('thinking');
  logEvent({
    type: 'client.user_turn_accepted',
    sessionId,
    item_id: turn.itemId,
    reason,
    approxSpeechMs: Number(turn.approxSpeechMs) || 0,
    transcriptChars: String(turn.transcriptText || '').trim().length
  });
  flushAcceptedUserTranscript(turn);
  sendManualResponseCreate(turn, sessionId, reason);
}

function ignoreUserTurn(turn, sessionId, reason) {
  clearTimeout(turn.decisionTimer);
  turn.ignored = true;
  state.userTurnByItem.set(turn.itemId, turn);
  deleteUserTextForItem(turn.itemId);
  setConnectionStatus(state.avatarSpeaking ? 'avatar speaking' : 'connected');
  logEvent({
    type: 'client.noise_turn_ignored',
    sessionId,
    item_id: turn.itemId,
    reason,
    approxSpeechMs: Number(turn.approxSpeechMs) || 0,
    transcriptChars: String(turn.transcriptText || '').trim().length
  });
  deleteConversationItem(turn.itemId, sessionId, reason);
}

function flushAcceptedUserTranscript(turn) {
  const text = String(turn.transcriptText || '').trim();
  if (!text) return;
  completeUserTranscript({
    item_id: turn.itemId,
    content_index: 0,
    transcript: text
  }, state.activeRealtimeSessionId);
}

function sendManualResponseCreate(turn, sessionId, reason) {
  if (turn.responseSent || !isActiveRealtimeSession(sessionId) || state.dataChannel?.readyState !== 'open') return;
  turn.responseSent = true;
  state.userTurnByItem.set(turn.itemId, turn);
  state.lastResponseStartedAt = performance.now();
  state.dataChannel.send(JSON.stringify({ type: 'response.create' }));
  logEvent({
    type: 'client.manual_response_create_sent',
    sessionId,
    item_id: turn.itemId,
    reason
  });
}

function deleteConversationItem(itemId, sessionId, reason) {
  if (!itemId || itemId.startsWith('pending-') || !isActiveRealtimeSession(sessionId) || state.dataChannel?.readyState !== 'open') return;
  state.dataChannel.send(JSON.stringify({ type: 'conversation.item.delete', item_id: itemId }));
  logEvent({
    type: 'client.conversation_item_delete_sent',
    sessionId,
    item_id: itemId,
    reason
  });
}

function clearUserTurnState() {
  for (const turn of state.userTurnByItem.values()) clearTimeout(turn.decisionTimer);
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

function handleConversationItem(event, sessionId) {
  const item = event.item || {};
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
      }, sessionId);
    } else {
      logEvent({ type: 'client.user_audio_pending_transcript', item_id: item.id || null, content_index: index });
    }
  }
}

function appendUserTranscriptDelta(event) {
  const key = userTranscriptKey(event);
  const nextText = `${state.userTextByItem.get(key) || ''}${event.delta || ''}`;
  state.userTextByItem.set(key, nextText);
  if (event.item_id && state.userTurnByItem.has(event.item_id)) {
    const turn = ensureUserTurn(event.item_id);
    turn.transcriptText = nextText.trim();
    state.userTurnByItem.set(event.item_id, turn);
  }
}

function completeUserTranscript(event, sessionId = state.activeRealtimeSessionId) {
  const key = userTranscriptKey(event);
  if (state.processedUserTranscriptKeys.has(key)) return;
  const text = String(event.transcript || state.userTextByItem.get(key) || '').trim();
  state.userTextByItem.delete(key);
  if (!text) return;
  const turn = event.item_id ? state.userTurnByItem.get(event.item_id) : null;
  if (turn) {
    turn.transcriptText = text;
    state.userTurnByItem.set(event.item_id, turn);
    if (turn.ignored) {
      logEvent({ type: 'client.user_transcript_ignored', item_id: event.item_id || null, textChars: text.length });
      return;
    }
    if (!turn.accepted) {
      if (hasUsefulTranscript(text) && turn.perfStoppedAt) {
        decideUserTurn(event.item_id, sessionId, 'transcript_completed');
      }
      return;
    }
  }
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
    responseDoneAt: performance.now()
  };
}

function scheduleAssistantResponseFlush(responseId, sessionId, delayMs, reason = 'flush_timeout') {
  if (!responseId) return;
  clearTimeout(state.assistantResponseTimers.get(responseId));
  state.assistantResponseTimers.set(responseId, setTimeout(() => {
    flushAssistantResponse(responseId, sessionId, reason);
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
  const meta = state.assistantResponseMeta.get(responseId) || {};
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
    addTranscript('assistant', text, { sourceId: responseId });
  }
  logEvent({
    type: 'client.assistant_response_flushed',
    sessionId,
    responseId,
    reason,
    status: meta.status || 'unknown',
    statusDetails: summarizeStatusDetails(meta.statusDetails),
    usage: summarizeUsage(meta.usage),
    incompleteReason,
    parts: parts.size,
    textChars: text.length
  });
  if (incompleteReason) {
    addMetric(`Realtime incomplete response: ${incompleteReason}`);
    return;
  }
  scheduleAdvisorFromRealtimeResponse(sessionId, responseId, text, { incompleteReason });
}

function assistantIncompleteReason(meta) {
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

function scheduleAdvisorFromRealtimeResponse(sessionId, responseId, assistantText, diagnostics = {}) {
  const speechStoppedAt = state.lastSpeechStoppedAt;
  setTimeout(() => {
    if (!isActiveRealtimeSession(sessionId)) return;
    const latestUser = latestTranscriptByRole('user', speechStoppedAt);
    if (latestUser) {
      requestAdvisor('user', latestUser.text, { sessionId, source: 'realtime_user_transcript', responseId, diagnostics });
    } else if (diagnostics.incompleteReason) {
      logEvent({ type: 'client.advisor_skipped', sessionId, reason: 'incomplete_assistant_response', responseId, incompleteReason: diagnostics.incompleteReason });
    } else {
      requestAdvisor('assistant', `Realtimeアバター応答: ${assistantText}`, { sessionId, source: 'realtime_response_transcript', responseId, diagnostics });
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

function finishAvatarAudioOutput(sessionId, reason) {
  if (!isActiveRealtimeSession(sessionId)) return;
  if (state.activeAssistantAudioResponseIds.size) {
    state.avatarSpeaking = true;
    setAvatarMood('speaking');
    setConnectionStatus('avatar speaking');
    return;
  }

  state.avatarSpeaking = false;
  setAvatarMood('neutral');
  setConnectionStatus('connected');
  clearTimeout(state.microphoneRestoreTimer);
  state.microphoneRestoreTimer = setTimeout(() => {
    if (!isActiveRealtimeSession(sessionId) || state.activeAssistantAudioResponseIds.size) return;
    setMicrophoneTracksEnabled(true, reason);
  }, AVATAR_AUDIO_RELEASE_DELAY_MS);
}

function setMicrophoneTracksEnabled(enabled, reason = 'manual', sessionId = state.activeRealtimeSessionId) {
  if (!isActiveRealtimeSession(sessionId)) return;
  state.microphoneEnabled = Boolean(enabled);
  state.mediaStream?.getAudioTracks().forEach((track) => {
    track.enabled = Boolean(enabled);
  });
  logEvent({ type: 'client.microphone_tracks_set', sessionId, enabled: Boolean(enabled), reason });
}

function enableMicrophoneTracks(sessionId = state.activeRealtimeSessionId) {
  setMicrophoneTracksEnabled(true, 'session_configured', sessionId);
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
    resetLipSyncAudio();
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
  state.assistantResponseMeta.clear();
  state.activeAssistantAudioResponseIds.clear();
  state.processedAssistantResponseKeys.clear();
  state.processedAssistantResponses.clear();
  state.userTextByItem.clear();
  clearUserTurnState();
  state.userItemSpeechStoppedAt.clear();
  state.processedUserTranscriptKeys.clear();
  state.currentAssistantText = '';
  clearTimeout(state.advisorQueueTimer);
  clearTimeout(state.microphoneRestoreTimer);
  clearTimeout(state.sessionUpdateFallbackTimer);
  clearTimeout(state.sessionUpdateWatchdogTimer);
  state.advisorQueueTimer = null;
  state.microphoneRestoreTimer = null;
  state.sessionUpdateFallbackTimer = null;
  state.sessionUpdateWatchdogTimer = null;
  state.realtimeSessionConfigured = false;
  state.queuedAdvice = null;
  setConnectionLoading(false);
  els.btnConnect.disabled = false;
  els.btnDisconnect.disabled = true;
  setConnectionStatus('idle');
  setAvatarMood('neutral');
  await closeCurrentLogSession('realtime_stopped');
  if (showMessage) addAdvice('app', '接続を終了しました。', 'warn');
}

async function sendText() {
  if (!state.authUser) {
    renderAuthState();
    if (els.loginError) els.loginError.textContent = 'ログインしてから送信してください。';
    return;
  }
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
  const item = {
    role,
    text,
    at: new Date().toISOString(),
    perfAt: Number(options.perfAt) || performance.now(),
    sourceId: options.sourceId || ''
  };
  state.transcript.push(item);
  state.transcript.sort((a, b) => Number(a.perfAt || 0) - Number(b.perfAt || 0));
  if (state.transcript.length > 80) state.transcript.shift();
  renderTranscriptFeed();
  renderStageTranscript();
  updateVRConversationPanels();
  queueTranscriptLog(role, text, item);
}

function renderTranscriptFeed() {
  els.transcriptFeed.innerHTML = '';
  for (const item of state.transcript) {
    appendTranscriptCard(item.role, item.text);
  }
  scrollToBottom(els.transcriptFeed);
}

function renderStageTranscript() {
  if (!els.stageChatOverlay) return;
  els.stageChatOverlay.innerHTML = '';
  for (const item of state.transcript.slice(-STAGE_TRANSCRIPT_LIMIT)) {
    const bubble = document.createElement('div');
    bubble.className = `stageTranscriptBubble ${item.role}`;
    bubble.textContent = normalizeStageText(item.text);
    els.stageChatOverlay.appendChild(bubble);
  }
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
  if (shouldShowStageAdvice(source)) {
    setStageAdvice(text);
  }
  queueAdviceLog(source, text, label, meta);
}

function shouldShowStageAdvice(source) {
  return /^LLM\b/.test(source) || /^instant\b/.test(source);
}

function setStageAdvice(text) {
  const displayText = compactStageText(text, STAGE_ADVICE_TEXT_LIMIT) || 'アドバイス';
  if (els.stageAdviceOverlay) els.stageAdviceOverlay.textContent = displayText;
  updateVRAdvicePanel(displayText);
}

function normalizeStageText(text) {
  return String(text || '')
    .replace(/\s*理由:\s*/g, '\n理由: ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function compactStageText(text, limit) {
  const normalized = normalizeStageText(text);
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trim()}…`;
}

function canPersistLogs() {
  return Boolean(state.authUser);
}

function nextLogSequence() {
  state.logSequence += 1;
  return state.logSequence;
}

function queueTranscriptLog(role, text, item) {
  queueLogItem({
    kind: 'transcript',
    role,
    text,
    at: item.at,
    id: item.sourceId || `transcript-${item.at}-${state.logSequence + 1}`,
    meta: {
      sourceId: item.sourceId || '',
      perfAt: Math.round(Number(item.perfAt || 0))
    }
  });
}

function queueAdviceLog(source, text, label, meta) {
  if (!shouldPersistAdvice(source)) return;
  queueLogItem({
    kind: 'advice',
    role: 'system',
    text,
    label,
    source,
    at: new Date().toISOString(),
    id: `advice-${Date.now().toString(36)}-${state.logSequence + 1}`,
    meta: { displayMeta: meta || '' }
  });
}

function shouldPersistAdvice(source) {
  return /^LLM\b/.test(source) || /^instant\b/.test(source);
}

function queueLogItem(item) {
  if (!canPersistLogs()) return;
  const sequence = nextLogSequence();
  state.pendingLogItems.push({ ...item, sequence });
  if (item.kind === 'transcript') state.persistedTranscriptCount += 1;
  if (item.kind === 'advice') state.persistedAdviceCount += 1;
  state.persistedLogItemCount += 1;
  scheduleLogFlush();
}

function scheduleLogFlush(delayMs = LOG_FLUSH_DELAY_MS) {
  clearTimeout(state.logFlushTimer);
  state.logFlushTimer = setTimeout(flushLogItems, delayMs);
}

async function ensureLogSession() {
  if (!canPersistLogs()) return '';
  if (state.logSessionId) return state.logSessionId;

  const firstUserText = state.transcript.find((item) => item.role === 'user')?.text || '';
  const title = firstUserText ? compactStageText(firstUserText, 48) : '会話ログ';
  const startedAt = new Date().toISOString();
  const response = await fetch('/api/log-sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, startedAt })
  });
  const data = await safeJson(response);
  if (!response.ok) throw new Error(data.error || `log session failed: ${response.status}`);
  state.logSessionId = data.sessionId;
  state.logSessionStartedAt = startedAt;
  return state.logSessionId;
}

async function flushLogItems() {
  clearTimeout(state.logFlushTimer);
  if (!canPersistLogs() || state.logFlushInFlight || !state.pendingLogItems.length) return;
  state.logFlushInFlight = true;
  const items = state.pendingLogItems.splice(0, 50);
  try {
    const sessionId = await ensureLogSession();
    if (!sessionId) return;
    const response = await fetch('/api/log-items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        items,
        summary: logSessionSummary()
      })
    });
    const data = await safeJson(response);
    if (!response.ok) throw new Error(data.error || `log save failed: ${response.status}`);
  } catch (error) {
    state.pendingLogItems.unshift(...items);
    logEvent({ type: 'client.log_save_failed', error: error.message || String(error), pending: state.pendingLogItems.length });
  } finally {
    state.logFlushInFlight = false;
    if (state.pendingLogItems.length) scheduleLogFlush(1500);
  }
}

function logSessionSummary(extra = {}) {
  const firstUserText = state.transcript.find((item) => item.role === 'user')?.text || '';
  return {
    title: firstUserText ? compactStageText(firstUserText, 48) : '会話ログ',
    itemCount: state.persistedLogItemCount,
    transcriptCount: state.persistedTranscriptCount,
    adviceCount: state.persistedAdviceCount,
    ...extra
  };
}

async function closeCurrentLogSession(reason = 'closed') {
  if (!canPersistLogs()) {
    resetCurrentLogSession();
    return;
  }
  await flushLogItems();
  if (!state.logSessionId) {
    resetCurrentLogSession();
    return;
  }
  try {
    await fetch('/api/log-sessions', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: state.logSessionId,
        ...logSessionSummary({ endedAt: new Date().toISOString(), closeReason: reason })
      })
    });
    loadSavedSessions();
  } catch (error) {
    logEvent({ type: 'client.log_session_close_failed', reason, error: error.message || String(error) });
  } finally {
    resetCurrentLogSession();
  }
}

function resetCurrentLogSession() {
  state.logSessionId = '';
  state.logSessionStartedAt = '';
  state.logSequence = 0;
  state.pendingLogItems = [];
  state.persistedLogItemCount = 0;
  state.persistedTranscriptCount = 0;
  state.persistedAdviceCount = 0;
  clearTimeout(state.logFlushTimer);
  state.logFlushTimer = null;
}

async function loadSavedSessions() {
  if (!canPersistLogs()) {
    renderSavedSessions([]);
    if (els.savedLogFeed) {
      els.savedLogFeed.innerHTML = '<div class="card"><div class="body">ログインすると保存ログを表示できます。</div></div>';
    }
    return;
  }
  try {
    const response = await fetch('/api/log-sessions?limit=30', { cache: 'no-store' });
    const data = await safeJson(response);
    if (!response.ok) throw new Error(data.error || `log sessions failed: ${response.status}`);
    renderSavedSessions(data.sessions || []);
  } catch (error) {
    if (els.savedSessionsFeed) {
      els.savedSessionsFeed.innerHTML = `<div class="card risk"><div class="body">${escapeHtml(error.message || String(error))}</div></div>`;
    }
  }
}

function renderSavedSessions(sessions) {
  if (!els.savedSessionsFeed) return;
  els.savedSessionsFeed.innerHTML = '';
  if (!sessions.length) {
    els.savedSessionsFeed.innerHTML = '<div class="card"><div class="body">保存済みログはまだありません。</div></div>';
    if (els.btnDeleteLog) els.btnDeleteLog.disabled = true;
    return;
  }
  for (const session of sessions) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `card session${session.sessionId === state.selectedSavedSessionId ? ' active' : ''}`;
    card.innerHTML = `<div class="meta"><span>${escapeHtml(formatLogDate(session.updatedAt || session.startedAt))}</span><span>${Number(session.itemCount || 0)}</span></div><div class="body">${escapeHtml(session.title || '会話ログ')}</div>`;
    card.addEventListener('click', () => loadSavedLogItems(session.sessionId));
    els.savedSessionsFeed.appendChild(card);
  }
}

async function loadSavedLogItems(sessionId) {
  if (!sessionId) return;
  state.selectedSavedSessionId = sessionId;
  if (els.btnDeleteLog) els.btnDeleteLog.disabled = false;
  try {
    const response = await fetch(`/api/log-items?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
    const data = await safeJson(response);
    if (!response.ok) throw new Error(data.error || `log items failed: ${response.status}`);
    renderSavedLogItems(data.items || []);
    loadSavedSessions();
  } catch (error) {
    if (els.savedLogFeed) {
      els.savedLogFeed.innerHTML = `<div class="card risk"><div class="body">${escapeHtml(error.message || String(error))}</div></div>`;
    }
  }
}

function renderSavedLogItems(items) {
  if (!els.savedLogFeed) return;
  els.savedLogFeed.innerHTML = '';
  if (!items.length) {
    els.savedLogFeed.innerHTML = '<div class="card"><div class="body">このセッションに保存項目はありません。</div></div>';
    return;
  }
  for (const item of items) {
    const label = item.kind === 'advice' ? (item.label || 'good') : '';
    const card = document.createElement('div');
    card.className = `card ${item.kind === 'advice' ? labelToClass(label) : `transcript ${item.role || 'user'}`}`;
    const roleLabel = item.kind === 'advice'
      ? `助言 ${item.source || ''}`.trim()
      : (item.role === 'assistant' ? 'アバター' : 'あなた');
    card.innerHTML = `<div class="meta"><span>${escapeHtml(roleLabel)}</span><span>${escapeHtml(formatLogDate(item.at))}</span></div><div class="body">${escapeHtml(item.text)}</div>`;
    els.savedLogFeed.appendChild(card);
  }
  scrollToBottom(els.savedLogFeed);
}

async function deleteSelectedSavedSession() {
  const sessionId = state.selectedSavedSessionId;
  if (!sessionId || !window.confirm('選択中の保存ログを削除します。')) return;
  try {
    const response = await fetch(`/api/log-sessions?sessionId=${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    const data = await safeJson(response);
    if (!response.ok) throw new Error(data.error || `delete failed: ${response.status}`);
    state.selectedSavedSessionId = '';
    if (els.savedLogFeed) els.savedLogFeed.innerHTML = '';
    if (els.btnDeleteLog) els.btnDeleteLog.disabled = true;
    loadSavedSessions();
  } catch (error) {
    addAdvice('app', `保存ログの削除に失敗しました: ${error.message || error}`, 'risk');
  }
}

function formatLogDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ja-JP', { hour12: false });
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
    const waitMs = Math.ceil(state.advisorBackoffUntil - now);
    logEvent({ type: 'client.advisor_skipped', reason: 'backoff', waitMs });
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
  const clientRequestId = `advisor-${Date.now().toString(36)}-${id}`;
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
    responseId: meta.responseId || null,
    clientRequestId,
    deployment: state.settings.advisorDeployment,
    latestChars: String(latestText || '').length,
    transcriptItems: state.transcript.length,
    maxTokens: state.settings.advisorMaxTokens
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
        transcript: state.transcript,
        clientRequestId,
        sessionId: meta.sessionId || null,
        source: meta.source || 'manual',
        responseId: meta.responseId || null,
        diagnostics: meta.diagnostics || {}
      })
    });
    if (meta.sessionId && !isActiveRealtimeSession(meta.sessionId)) {
      logEvent({ type: 'client.advisor_result_ignored', reason: 'stale_session', sessionId: meta.sessionId, id });
      return;
    }
    const data = await safeJson(response);
    if (!response.ok) {
      const message = formatAdvisorError(data, response.status);
      logEvent({
        type: 'client.advisor_error',
        id,
        sessionId: meta.sessionId || null,
        responseId: meta.responseId || null,
        clientRequestId,
        status: response.status,
        error: data.error || response.statusText,
        endpoint: data.endpoint || null,
        responseHeaders: data.responseHeaders || null,
        serviceResponseText: data.serviceResponseText || null,
        serviceResponseBody: data.serviceResponseBody || null,
        retryAfterMs: data.retryAfterMs || 0,
        rateLimits: data.rateLimits || null,
        requestIds: data.requestIds || null,
        attempts: data.attempts || [],
        response: data
      });
      if (response.status === 429 || isAdvisorUnavailable(data)) {
        const serverRetryMs = Number(data.retryAfterMs) || 0;
        const attemptRetryMs = Math.max(0, ...(data.attempts || []).map((attempt) => Number(attempt.retryAfterMs) || 0));
        const backoffMs = response.status === 429
          ? Math.max(ADVISOR_BACKOFF_MS, serverRetryMs, attemptRetryMs)
          : ADVISOR_BACKOFF_MS * 10;
        state.advisorBackoffUntil = performance.now() + backoffMs;
        state.advisorErrorMutedUntil = performance.now() + ADVISOR_ERROR_MUTE_MS;
        state.queuedAdvice = null;
        addMetric(`Advisor skipped: ${response.status} / backoff=${Math.ceil(backoffMs / 1000)}s / ${state.settings.advisorDeployment}`);
        return;
      }
      throw new Error(message);
    }
    const ms = Math.round(performance.now() - started);
    const label = data.label || 'good';
    const text = data.advice ? `${data.advice}${data.reason ? `\n理由: ${data.reason}` : ''}` : (data.text || '(no advice)');
    addAdvice(`LLM #${id}`, text, label, `${ms}ms / ${data.deployment || state.settings.advisorDeployment}`);
    addMetric(`Advisor: ${ms}ms / ${data.deployment || state.settings.advisorDeployment}`);
    logEvent({
      type: 'client.advisor_result',
      id,
      sessionId: meta.sessionId || null,
      responseId: meta.responseId || null,
      clientRequestId,
      latencyMs: ms,
      endpoint: data.endpoint || null,
      inputBudget: data.inputBudget || null,
      responseHeaders: data.responseHeaders || null,
      rateLimits: data.rateLimits || null
    });
    const rateLimitWaitMs = advisorRateLimitDelayMs(data.rateLimits);
    if (rateLimitWaitMs > ADVISOR_MIN_INTERVAL_MS) {
      state.advisorBackoffUntil = Math.max(state.advisorBackoffUntil, performance.now() + rateLimitWaitMs);
      logEvent({
        type: 'client.advisor_rate_limit_wait',
        reason: 'remaining_requests_exhausted',
        waitMs: Math.ceil(rateLimitWaitMs),
        rateLimits: data.rateLimits || null
      });
    }
  } catch (error) {
    if (meta.sessionId && !isActiveRealtimeSession(meta.sessionId)) {
      logEvent({ type: 'client.advisor_error_ignored', reason: 'stale_session', sessionId: meta.sessionId, id });
      return;
    }
    if (performance.now() >= state.advisorErrorMutedUntil) {
      addAdvice(`LLM #${id}`, error.message || String(error), 'risk');
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

function advisorRateLimitDelayMs(rateLimits) {
  if (!rateLimits || typeof rateLimits !== 'object') return 0;
  const remainingRequests = Number(rateLimits['x-ratelimit-remaining-requests']);
  if (!Number.isFinite(remainingRequests) || remainingRequests > 0) return 0;

  const retryAfterMs = Number(rateLimits['retry-after-ms']);
  const retryAfterSeconds = Number(rateLimits['retry-after']);
  const resetRequestsSeconds = Number(rateLimits['x-ratelimit-reset-requests']);
  const candidates = [
    Number.isFinite(retryAfterMs) ? retryAfterMs : 0,
    Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 0,
    Number.isFinite(resetRequestsSeconds) ? resetRequestsSeconds * 1000 : 0
  ].filter((value) => value > 0);
  if (!candidates.length) return 0;
  return Math.min(Math.max(...candidates), ADVISOR_BACKOFF_MS * 2);
}

function isAdvisorUnavailable(data) {
  const code = String(data?.serviceResponseBody?.error?.code || data?.azureError?.code || data?.code || '').toLowerCase();
  const message = String(data?.serviceResponseText || data?.error || '').toLowerCase();
  return code.includes('unavailable_model') || message.includes('unavailable model');
}

function formatAdvisorError(data, status) {
  const lines = [];
  if (data.serviceResponseText) lines.push(data.serviceResponseText);
  else if (data.error) lines.push(data.error);
  else lines.push(`HTTP ${status}`);

  const raw = {
    endpoint: data.endpoint || null,
    responseHeaders: data.responseHeaders || null,
    serviceResponseBody: data.serviceResponseBody || null,
    attempts: data.attempts || []
  };
  lines.push(JSON.stringify(raw, null, 2));
  return lines.join('\n');
}

async function benchmarkAdvisorModels() {
  if (!canUseDeveloperTools()) return;
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
  if (!canUseDeveloperTools()) return;
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
  if (!canUseDeveloperTools()) return;
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `<div class="meta"><span>metric</span><span>${new Date().toLocaleTimeString('ja-JP', { hour12: false })}</span></div><div class="body">${escapeHtml(text)}</div>`;
  els.metricsFeed.appendChild(card);
  scrollToBottom(els.metricsFeed);
}

function logEvent(event) {
  if (!canUseDeveloperTools()) return;
  const compact = compactEvent(event);
  state.diagnosticEvents.push({
    at: new Date().toISOString(),
    perfAt: Math.round(performance.now()),
    sessionId: event.sessionId ?? state.activeRealtimeSessionId ?? null,
    ...compact
  });
  if (state.diagnosticEvents.length > DIAGNOSTIC_LOG_LIMIT) state.diagnosticEvents.shift();
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `<div class="meta"><span>${escapeHtml(event.type || 'event')}</span><span>${new Date().toLocaleTimeString('ja-JP', { hour12: false })}</span></div><div class="body">${escapeHtml(JSON.stringify(compact, null, 2))}</div>`;
  els.eventFeed.appendChild(card);
  if (els.eventFeed.children.length > 120) els.eventFeed.removeChild(els.eventFeed.firstChild);
  scrollToBottom(els.eventFeed);
}

function compactEvent(event) {
  const clone = { ...event };
  delete clone.token;
  delete clone.client_secret;
  delete clone.apiKey;
  delete clone.Authorization;
  if (typeof clone.instructions === 'string') clone.instructions = `[${clone.instructions.length} chars]`;
  if (clone.session?.instructions) clone.session = { ...clone.session, instructions: `[${clone.session.instructions.length} chars]` };
  if (clone.request?.messages) clone.request = { ...clone.request, messages: `[${clone.request.messages.length} messages]` };
  if (typeof clone.delta === 'string' && clone.delta.length > 120) clone.delta = `${clone.delta.slice(0, 120)}…`;
  if (typeof clone.transcript === 'string' && clone.transcript.length > 160) clone.transcript = `${clone.transcript.slice(0, 160)}…`;
  return clone;
}

function exportDiagnosticEvents() {
  if (!canUseDeveloperTools()) return;
  const lines = state.diagnosticEvents.map((event) => JSON.stringify(event));
  const blob = new Blob([`${lines.join('\n')}\n`], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `zatsucoach-realtime-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
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
