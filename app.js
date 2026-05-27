import { createAvatarStage } from './avatarStage.mjs';
import {
  ADVISOR_TRANSCRIPT_GRACE_MS,
  DEVELOPER_ONLY_TABS,
  DIAGNOSTIC_LOG_LIMIT,
  PUBLIC_PERIOD_ENDED_MESSAGE,
  canUseDeveloperTools,
  canUseInteractiveFeatures,
  canWriteLogs,
  compactEvent,
  escapeHtml,
  finiteNumber,
  formatApiError,
  formatLogDate,
  isActiveRealtimeSession,
  isDeveloperAccount,
  labelToClass,
  latestTranscriptByRole,
  microphoneAudioConstraints,
  normalizeAdvisorDeploymentSetting,
  normalizeNoiseReductionSetting,
  normalizePublicAccess,
  safeJson,
  safeTrackSettings,
  scrollToBottom,
  setHidden,
  shouldShowStageAdvice,
  transcriptBySourceId,
  transcriptTimingMeta
} from './appUtils.mjs';
import { createCoachAdviceClient } from './coachAdviceClient.mjs';
import { createConversationLogClient, defaultTitleSummary } from './conversationLogClient.mjs';
import { createDiagnosticEventClient } from './diagnosticEventClient.mjs';
import { createRealtimeConversationEngine } from './realtimeConversationEngine.mjs';

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
  publicClosedNotice: document.getElementById('publicClosedNotice'),
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
  realtimeCounters: {
    tokenRequests: 0,
    sdpExchanges: 0,
    chatFallbackRequests: 0
  },
  authUser: null,
  authChecked: false,
  publicAccess: {
    ended: false,
    exempt: false,
    canUseInteractiveFeatures: true,
    logAccess: 'none',
    message: ''
  },
  developerToolsEnabled: false,
  avatarStageStarted: false,
  selectedSavedSessionId: '',
  transcript: [],
  latencySamples: [],
  avatarSpeaking: false,
  localUserSpeaking: false,
  sessionStartedAt: 0,
  diagnosticEvents: []
};

const avatarStage = createAvatarStage({
  elements: {
    stage: els.stage,
    stageLoading: els.stageLoading,
    stageLoadingText: els.stageLoadingText,
    avatarStatus: els.avatarStatus,
    stageChatOverlay: els.stageChatOverlay,
    stageAdviceOverlay: els.stageAdviceOverlay
  },
  onAdvice: addAdvice,
  onDiagnosticEvent: logEvent,
  onLoadingChange: setAvatarLoading,
  onVRSessionRequested: ensureRealtimeForVR,
  onVRSessionStart: ensureRealtimeForVR
});

const realtimeEngine = createRealtimeConversationEngine({
  getSettings: () => state.settings,
  emit: handleRealtimeEffect
});

const conversationLog = createConversationLogClient({
  canPersist: () => canWriteLogs(state.authUser, state.publicAccess),
  getTranscript: () => state.transcript,
  summarizeTitle: defaultTitleSummary,
  onError: (event) => logEvent(event)
});

const diagnosticEvents = createDiagnosticEventClient({
  canPersist: () => canWriteLogs(state.authUser, state.publicAccess),
  getContext: () => ({
    sessionId: state.activeRealtimeSessionId,
    logSessionId: conversationLog.snapshot().sessionId,
    deployment: state.settings.realtimeDeployment,
    voice: state.settings.voice,
    connectionState: state.pc?.connectionState || '',
    iceConnectionState: state.pc?.iceConnectionState || '',
    dataChannelState: state.dataChannel?.readyState || ''
  }),
  onError: (event) => console.warn(event.error || event)
});

const coachAdvice = createCoachAdviceClient({
  getSettings: () => state.settings,
  getTranscript: () => state.transcript,
  isActiveSession: (sessionId) => isActiveRealtimeSession(sessionId, state.activeRealtimeSessionId),
  canBenchmark: () => canUseDeveloperTools(state.developerToolsEnabled),
  confirm: (message) => window.confirm(message),
  addAdvice,
  addMetric,
  logEvent
});

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
    settings.noiseReduction = normalizeNoiseReductionSetting(settings.noiseReduction, defaultSettings.noiseReduction);
    return settings;
  } catch {
    return { ...defaultSettings };
  }
}

function saveSettings(next) {
  state.settings = { ...defaultSettings, ...next };
  state.settings.advisorDeployment = normalizeAdvisorDeploymentSetting(state.settings.advisorDeployment);
  state.settings.noiseReduction = normalizeNoiseReductionSetting(state.settings.noiseReduction, defaultSettings.noiseReduction);
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
    state.publicAccess = normalizePublicAccess(data?.publicAccess, state.authUser);
  } catch {
    state.authUser = null;
    state.publicAccess = normalizePublicAccess(null, null);
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
  const interactiveAllowed = canUseInteractiveFeatures(state.authUser, state.publicAccess);
  const publicClosed = state.authUser && !interactiveAllowed;
  if (els.accountStatus) {
    els.accountStatus.textContent = details ? `account: ${details}` : 'account: local/anonymous';
    els.accountStatus.title = details || 'local/anonymous';
  }
  if (els.publicClosedNotice) {
    els.publicClosedNotice.hidden = !publicClosed;
    els.publicClosedNotice.textContent = state.publicAccess.message || PUBLIC_PERIOD_ENDED_MESSAGE;
  }
  if (els.btnLogin) els.btnLogin.style.display = state.authUser ? 'none' : '';
  if (els.btnLogout) els.btnLogout.style.display = state.authUser ? '' : 'none';
  if (els.loginView) els.loginView.hidden = Boolean(state.authUser);
  const main = document.querySelector('main.layout');
  if (main) {
    main.hidden = !state.authUser;
    main.classList.toggle('logsOnly', Boolean(publicClosed));
  }
  setHidden(document.querySelector('.stagePanel'), publicClosed);
  for (const name of ['advice', 'transcript']) {
    setHidden(document.querySelector(`.tab[data-tab="${name}"]`), publicClosed);
    setHidden(document.getElementById(`${name}Tab`), publicClosed);
  }
  if (publicClosed) activateTab('logs');
  if (state.authUser && interactiveAllowed) initScene();
  if (state.authUser) scheduleStageResize();
  if (els.btnConnect) els.btnConnect.disabled = !state.authUser || !interactiveAllowed || state.realtimeStarting || state.connectionLoading || Boolean(state.pc || state.dataChannel);
  if (els.btnSendText) els.btnSendText.disabled = !state.authUser || !interactiveAllowed;
  if (els.textInput) {
    els.textInput.disabled = !state.authUser || !interactiveAllowed;
    els.textInput.placeholder = publicClosed
      ? PUBLIC_PERIOD_ENDED_MESSAGE
      : 'テキストでも試せます。例: 最近オフィスに戻って疲れますね。';
  }
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
  const enabled = canUseDeveloperTools(state.developerToolsEnabled);
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
    els.btnConnect.disabled = !state.authUser || !canUseInteractiveFeatures(state.authUser, state.publicAccess) || state.realtimeStarting || state.connectionLoading || Boolean(state.pc || state.dataChannel);
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
    realtimeEngine.clearUserTranscriptState();
    els.transcriptFeed.innerHTML = '';
    renderStageTranscript();
  });
  els.btnClearEvents.addEventListener('click', () => {
    state.diagnosticEvents = [];
    els.eventFeed.innerHTML = '';
  });
  els.btnExportEvents.addEventListener('click', exportDiagnosticEvents);
  window.addEventListener('beforeunload', () => {
    flushLogItems();
    flushDiagnosticEvents();
    stopRealtime(false);
  });
}

function initScene() {
  if (state.avatarStageStarted) return;
  if (!state.authUser || !canUseInteractiveFeatures(state.authUser, state.publicAccess)) return;
  state.avatarStageStarted = true;
  avatarStage.init().catch((error) => {
    state.avatarStageStarted = false;
    console.error(error);
    addAdvice('app', `アバター初期化に失敗しました: ${error.message || error}`, 'risk');
  });
}

function scheduleStageResize() {
  avatarStage.resize();
}

function setAvatarMood(mood) {
  avatarStage.setMood(mood);
}

function attachLipSyncAudioStream(stream) {
  avatarStage.attachLipSyncAudioStream(stream);
}

function ensureLipSyncAudioContext() {
  return avatarStage.ensureAudioContext();
}

function resetLipSyncAudio() {
  avatarStage.resetAudio();
}

function ensureRealtimeForVR() {
  if (!canUseInteractiveFeatures(state.authUser, state.publicAccess)) return;
  if (state.realtimeStarting || state.pc || state.dataChannel) return;
  logEvent({ type: 'client.vr_realtime_autostart', sessionId: state.activeRealtimeSessionId });
  void startRealtime();
}

async function startRealtime() {
  if (!state.authUser) {
    renderAuthState();
    if (els.loginError) els.loginError.textContent = 'ログインしてから接続してください。';
    return;
  }
  if (!canUseInteractiveFeatures(state.authUser, state.publicAccess)) {
    addAdvice('app', PUBLIC_PERIOD_ENDED_MESSAGE, 'warn');
    renderAuthState();
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
  const expectedRealtimeVoice = String(state.settings.voice || '').trim().toLowerCase();
  ensureLipSyncAudioContext();

  try {
    setConnectionLoading(true, '接続用トークンを取得しています');
    setConnectionStatus('requesting token');
    els.btnConnect.disabled = true;
    const tokenPayload = {
      realtimeDeployment: state.settings.realtimeDeployment,
      instructions: state.settings.realtimeInstructions,
      voice: expectedRealtimeVoice,
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
    if (!isActiveRealtimeSession(sessionId, state.activeRealtimeSessionId)) return;
    const tokenData = await safeJson(tokenResponse);
    if (!tokenResponse.ok) throw new Error(tokenData.error || `token failed: ${tokenResponse.status}`);
    if (!tokenData.token || !tokenData.webrtcUrl) throw new Error('token response is missing token or webrtcUrl');
    if (tokenData.voice && tokenData.voice !== expectedRealtimeVoice) {
      throw new Error(`Realtime voice mismatch before WebRTC: expected=${expectedRealtimeVoice}, token=${tokenData.voice}`);
    }
    realtimeEngine.beginSession({ sessionId, expectedVoice: expectedRealtimeVoice, tokenData });

    setConnectionLoading(true, 'マイクの許可を待っています');
    setConnectionStatus('microphone');
    const mediaStream = await getMicrophoneMediaStream(sessionId);
    if (!isActiveRealtimeSession(sessionId, state.activeRealtimeSessionId)) {
      mediaStream.getTracks().forEach((track) => track.stop());
      return;
    }

    const pc = new RTCPeerConnection();
    state.pc = pc;
    state.mediaStream = mediaStream;
    state.sessionStartedAt = performance.now();

    pc.ontrack = (event) => {
      if (!isActiveRealtimeSession(sessionId, state.activeRealtimeSessionId)) return;
      if (event.streams?.[0]) {
        els.remoteAudio.srcObject = event.streams[0];
        attachLipSyncAudioStream(event.streams[0]);
      }
    };
    pc.onconnectionstatechange = () => {
      if (!isActiveRealtimeSession(sessionId, state.activeRealtimeSessionId)) return;
      logEvent({ type: 'client.connection_state', sessionId, state: pc.connectionState });
      setConnectionStatus(pc.connectionState);
    };
    pc.oniceconnectionstatechange = () => {
      if (!isActiveRealtimeSession(sessionId, state.activeRealtimeSessionId)) return;
      logEvent({ type: 'client.ice_state', sessionId, state: pc.iceConnectionState });
    };

    for (const track of mediaStream.getAudioTracks()) {
      track.enabled = false;
      pc.addTrack(track, mediaStream);
    }

    const dc = pc.createDataChannel('realtime-channel');
    state.dataChannel = dc;
    wireDataChannel(dc, sessionId);

    const offer = await pc.createOffer();
    if (!isActiveRealtimeSession(sessionId, state.activeRealtimeSessionId)) return;
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
      voice: tokenData.voice || expectedRealtimeVoice,
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
    if (!isActiveRealtimeSession(sessionId, state.activeRealtimeSessionId)) return;
    const answerSdp = await sdpResponse.text();
    if (!sdpResponse.ok) throw new Error(`SDP failed ${sdpResponse.status}: ${answerSdp.slice(0, 300)}`);

    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    addMetric(`SDP exchange: ${Math.round(performance.now() - sdpStarted)}ms / deployment=${tokenData.deployment} / voice=${tokenData.voice || expectedRealtimeVoice}`);
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
    if (isActiveRealtimeSession(sessionId, state.activeRealtimeSessionId)) state.realtimeStarting = false;
  }
}

function wireDataChannel(dc, sessionId) {
  dc.addEventListener('open', () => {
    if (!isActiveRealtimeSession(sessionId, state.activeRealtimeSessionId)) return;
    realtimeEngine.handleDataChannelOpen();
  });
  dc.addEventListener('close', () => {
    if (!isActiveRealtimeSession(sessionId, state.activeRealtimeSessionId)) return;
    realtimeEngine.handleDataChannelClose();
  });
  dc.addEventListener('error', (event) => {
    if (!isActiveRealtimeSession(sessionId, state.activeRealtimeSessionId)) return;
    realtimeEngine.handleDataChannelError(event);
  });
  dc.addEventListener('message', (event) => {
    if (!isActiveRealtimeSession(sessionId, state.activeRealtimeSessionId)) return;
    try {
      const realtimeEvent = JSON.parse(event.data);
      realtimeEngine.handleServerEvent(realtimeEvent);
    } catch (error) {
      logEvent({ type: 'client.unparsed_message', sessionId, data: String(event.data).slice(0, 500), error: String(error) });
    }
  });
}

async function getMicrophoneMediaStream(sessionId) {
  const preferred = microphoneAudioConstraints('remote-only');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: preferred });
    logMicrophoneCaptureSettings(sessionId, 'preferred', preferred, stream);
    return stream;
  } catch (error) {
    const fallback = microphoneAudioConstraints(true);
    logEvent({
      type: 'client.microphone_preferred_constraints_failed',
      sessionId,
      error: error.message || String(error),
      preferred
    });
    const stream = await navigator.mediaDevices.getUserMedia({ audio: fallback });
    logMicrophoneCaptureSettings(sessionId, 'fallback', fallback, stream);
    return stream;
  }
}

function logMicrophoneCaptureSettings(sessionId, mode, constraints, stream) {
  const tracks = stream.getAudioTracks().map((track) => ({
    label: track.label || '',
    enabled: track.enabled,
    muted: track.muted,
    settings: safeTrackSettings(track)
  }));
  logEvent({
    type: 'client.microphone_capture_settings',
    sessionId,
    mode,
    constraints,
    tracks
  });
}

function handleRealtimeEffect(effect) {
  switch (effect.type) {
    case 'sendClientEvent':
      sendRealtimeClientEvent(effect.event);
      break;
    case 'logEvent':
      logEvent(effect.event || {});
      break;
    case 'addAdvice':
      addAdvice(effect.source, effect.text, effect.label, effect.meta || '');
      break;
    case 'setConnectionStatus':
      setConnectionStatus(effect.text);
      break;
    case 'setConnectionLoading':
      setConnectionLoading(Boolean(effect.loading), effect.text || '');
      break;
    case 'setMicrophoneEnabled':
      setMicrophoneTracksEnabled(Boolean(effect.enabled), effect.reason, effect.sessionId);
      break;
    case 'setAvatarMood':
      setAvatarMood(effect.mood);
      break;
    case 'setAvatarSpeaking':
      state.avatarSpeaking = Boolean(effect.speaking);
      avatarStage.setAvatarSpeaking(effect.speaking);
      break;
    case 'setLocalUserSpeaking':
      state.localUserSpeaking = Boolean(effect.speaking);
      break;
    case 'addMetric':
      addMetric(effect.text);
      break;
    case 'addTranscript':
      addTranscript(effect.role, effect.text, effect.options || {});
      break;
    case 'recordFirstAudioLatency':
      state.latencySamples.push(effect.ms);
      els.latencyStatus.textContent = `first reaction: ${effect.ms}ms`;
      addMetric(`Realtime first audio: ${effect.ms}ms / ${effect.deployment || state.settings.realtimeDeployment}`);
      break;
    case 'scheduleAdvisorFromRealtimeResponse':
      scheduleAdvisorFromRealtimeResponse(effect.sessionId, effect.responseId, effect.assistantText, effect.diagnostics || {});
      break;
    case 'stopRealtime':
      stopRealtime(effect.showMessage, effect.sessionId);
      break;
    default:
      break;
  }
}

function sendRealtimeClientEvent(event) {
  if (!event || state.dataChannel?.readyState !== 'open') return;
  state.dataChannel.send(JSON.stringify(event));
}

function setMicrophoneTracksEnabled(enabled, reason = 'manual', sessionId = state.activeRealtimeSessionId) {
  if (!isActiveRealtimeSession(sessionId, state.activeRealtimeSessionId)) return;
  state.microphoneEnabled = Boolean(enabled);
  state.mediaStream?.getAudioTracks().forEach((track) => {
    track.enabled = Boolean(enabled);
  });
  logEvent({ type: 'client.microphone_tracks_set', sessionId, enabled: Boolean(enabled), reason });
}

function scheduleAdvisorFromRealtimeResponse(sessionId, responseId, assistantText, diagnostics = {}) {
  const speechStoppedAt = Number(diagnostics.userPerfAt) || 0;
  const userItemId = String(diagnostics.userItemId || '');
  setTimeout(() => {
    if (!isActiveRealtimeSession(sessionId, state.activeRealtimeSessionId)) return;
    const latestUser = userItemId
      ? transcriptBySourceId(state.transcript, 'user', userItemId)
      : latestTranscriptByRole(state.transcript, 'user', speechStoppedAt);
    if (latestUser) {
      requestAdvisor('user', latestUser.text, {
        sessionId,
        source: 'realtime_user_transcript_final',
        responseId,
        diagnostics: {
          ...diagnostics,
          ...transcriptTimingMeta(latestUser)
        }
      });
    } else if (diagnostics.incompleteReason) {
      logEvent({ type: 'client.advisor_skipped', sessionId, reason: 'incomplete_assistant_response', responseId, incompleteReason: diagnostics.incompleteReason });
    } else if (userItemId) {
      logEvent({
        type: 'client.advisor_skipped',
        sessionId,
        reason: 'final_user_transcript_unavailable',
        responseId,
        userItemId
      });
    } else {
      requestAdvisor('assistant', `Realtimeアバター応答: ${assistantText}`, { sessionId, source: 'realtime_response_transcript', responseId, diagnostics });
    }
  }, ADVISOR_TRANSCRIPT_GRACE_MS);
}

async function stopRealtime(showMessage = true, sessionId = state.activeRealtimeSessionId) {
  if (!isActiveRealtimeSession(sessionId, state.activeRealtimeSessionId)) {
    logEvent({ type: 'client.realtime_stop_skipped', reason: 'stale_session', sessionId });
    return;
  }
  state.activeRealtimeSessionId += 1;
  realtimeEngine.stop();
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
  state.avatarSpeaking = false;
  state.localUserSpeaking = false;
  avatarStage.setAvatarSpeaking(false);
  coachAdvice.resetQueue();
  setConnectionLoading(false);
  els.btnConnect.disabled = !canUseInteractiveFeatures(state.authUser, state.publicAccess);
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
  if (!canUseInteractiveFeatures(state.authUser, state.publicAccess)) {
    addAdvice('app', PUBLIC_PERIOD_ENDED_MESSAGE, 'warn');
    renderAuthState();
    return;
  }
  const text = els.textInput.value.trim();
  if (!text) return;
  els.textInput.value = '';
  addTranscript('user', text);
  immediateAdvice(text);

  if (state.dataChannel?.readyState === 'open') {
    realtimeEngine.sendTextTurn(text);
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
    sourceId: options.sourceId || '',
    startPerfAt: finiteNumber(options.startPerfAt),
    endPerfAt: finiteNumber(options.endPerfAt),
    durationMs: finiteNumber(options.durationMs),
    approxSpeechMs: finiteNumber(options.approxSpeechMs),
    avatarOverlapMs: finiteNumber(options.avatarOverlapMs),
    overlappedAvatar: Boolean(options.overlappedAvatar),
    audioStartMs: finiteNumber(options.audioStartMs),
    audioEndMs: finiteNumber(options.audioEndMs)
  };
  state.transcript.push(item);
  state.transcript.sort((a, b) => Number(a.perfAt || 0) - Number(b.perfAt || 0));
  if (state.transcript.length > 80) state.transcript.shift();
  renderTranscriptFeed();
  renderStageTranscript();
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
  avatarStage.updateConversation(state.transcript);
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

function setStageAdvice(text) {
  avatarStage.setAdvice(text);
}

function canPersistLogs() {
  return Boolean(state.authUser);
}

function queueTranscriptLog(role, text, item) {
  conversationLog.queueTranscript({ role, text, ...item });
}

function queueAdviceLog(source, text, label, meta) {
  conversationLog.queueAdvice({ source, text, label, meta });
}

async function flushLogItems() {
  await conversationLog.flush();
}

async function flushDiagnosticEvents() {
  await diagnosticEvents.flush();
}

async function closeCurrentLogSession(reason = 'closed') {
  await flushDiagnosticEvents();
  await conversationLog.close(reason);
  if (canPersistLogs()) {
    loadSavedSessions();
  }
}

function resetCurrentLogSession() {
  conversationLog.reset();
  diagnosticEvents.reset();
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
    const sessions = await conversationLog.loadSessions(30);
    renderSavedSessions(sessions);
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
  if (els.btnDeleteLog) els.btnDeleteLog.disabled = !state.selectedSavedSessionId || !canWriteLogs(state.authUser, state.publicAccess);
}

async function loadSavedLogItems(sessionId) {
  if (!sessionId) return;
  state.selectedSavedSessionId = sessionId;
  if (els.btnDeleteLog) els.btnDeleteLog.disabled = !canWriteLogs(state.authUser, state.publicAccess);
  try {
    const items = await conversationLog.loadItems(sessionId);
    renderSavedLogItems(items);
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
  if (!canWriteLogs(state.authUser, state.publicAccess)) {
    addAdvice('app', PUBLIC_PERIOD_ENDED_MESSAGE, 'warn');
    return;
  }
  if (!sessionId || !window.confirm('選択中の保存ログを削除します。')) return;
  try {
    await conversationLog.deleteSession(sessionId);
    state.selectedSavedSessionId = '';
    if (els.savedLogFeed) els.savedLogFeed.innerHTML = '';
    if (els.btnDeleteLog) els.btnDeleteLog.disabled = true;
    loadSavedSessions();
  } catch (error) {
    addAdvice('app', `保存ログの削除に失敗しました: ${error.message || error}`, 'risk');
  }
}

function immediateAdvice(text) {
  coachAdvice.immediateAdvice(text);
}

async function requestAdvisor(role, latestText, meta = {}) {
  if (!canUseInteractiveFeatures(state.authUser, state.publicAccess)) {
    logEvent({ type: 'client.advisor_skipped', reason: 'public_period_ended', sessionId: meta.sessionId ?? null });
    return;
  }
  return coachAdvice.request({ role, latestText, meta });
}

async function benchmarkAdvisorModels() {
  await coachAdvice.benchmark();
}

async function checkHealth() {
  if (!canUseDeveloperTools(state.developerToolsEnabled)) return;
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
  if (!canUseDeveloperTools(state.developerToolsEnabled)) return;
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `<div class="meta"><span>metric</span><span>${new Date().toLocaleTimeString('ja-JP', { hour12: false })}</span></div><div class="body">${escapeHtml(text)}</div>`;
  els.metricsFeed.appendChild(card);
  scrollToBottom(els.metricsFeed);
}

function logEvent(event) {
  diagnosticEvents.queue({
    ...event,
    perfAt: Math.round(performance.now())
  });
  if (!canUseDeveloperTools(state.developerToolsEnabled)) return;
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

function exportDiagnosticEvents() {
  if (!canUseDeveloperTools(state.developerToolsEnabled)) return;
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
