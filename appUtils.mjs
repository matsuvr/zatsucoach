export const ADVISOR_TRANSCRIPT_GRACE_MS = 1200;
export const DIAGNOSTIC_LOG_LIMIT = 1000;
export const DEVELOPER_ONLY_TABS = Object.freeze(['metrics', 'events']);
export const PUBLIC_PERIOD_ENDED_MESSAGE = '公開期間を終了しました';

export function normalizeAdvisorDeploymentSetting(value) {
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

export function normalizeNoiseReductionSetting(value, defaultValue = 'far_field') {
  const mode = String(value || defaultValue).trim().toLowerCase();
  return ['far_field', 'near_field', 'off'].includes(mode) ? mode : defaultValue;
}

export function normalizePublicAccess(value, principal) {
  const access = value && typeof value === 'object' ? value : {};
  const ended = Boolean(access.ended);
  const exempt = Boolean(access.exempt);
  const authenticated = Boolean(principal);
  const canUse = access.canUseInteractiveFeatures !== undefined
    ? Boolean(access.canUseInteractiveFeatures)
    : authenticated && (!ended || exempt);
  return {
    ended,
    exempt,
    canUseInteractiveFeatures: canUse,
    logAccess: String(access.logAccess || (authenticated ? (ended && !exempt ? 'read-only' : 'read-write') : 'none')),
    message: String(access.message || (ended && !exempt ? PUBLIC_PERIOD_ENDED_MESSAGE : ''))
  };
}

export function canUseInteractiveFeatures(authUser, publicAccess) {
  return Boolean(authUser && publicAccess?.canUseInteractiveFeatures);
}

export function canWriteLogs(authUser, publicAccess) {
  return Boolean(authUser && publicAccess?.logAccess === 'read-write');
}

export function canUseDeveloperTools(developerToolsEnabled) {
  return Boolean(developerToolsEnabled);
}

export function isActiveRealtimeSession(sessionId, activeRealtimeSessionId) {
  return Number(sessionId) === Number(activeRealtimeSessionId);
}

// NOTE: Duplicated in api/_shared/appAuth.js (backend CommonJS). Keep implementations in sync.
export function principalIdentityValues(principal) {
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

// NOTE: Duplicated in api/_shared/appAuth.js (backend CommonJS). Keep implementations in sync.
export function expandIdentityValue(value) {
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

// NOTE: Duplicated in api/_shared/appAuth.js (backend CommonJS). Keep implementations in sync.
export function claimValue(principal, name) {
  const claims = Array.isArray(principal?.claims) ? principal.claims : [];
  const match = claims.find((claim) => {
    const type = String(claim.typ || claim.type || claim.name || '').toLowerCase();
    return type === name || type.endsWith(`/${name}`);
  });
  return match?.val || match?.value || '';
}

export function transcriptBySourceId(transcript, role, sourceId) {
  if (!sourceId) return null;
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const item = transcript[i];
    if (item?.role === role && item?.sourceId === sourceId && item.text) return item;
  }
  return null;
}

export function latestTranscriptByRole(transcript, role, minPerfAt = 0) {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    if (transcript[i]?.role === role && transcript[i]?.text && Number(transcript[i].perfAt || 0) >= minPerfAt) {
      return transcript[i];
    }
  }
  return null;
}

export function transcriptTimingMeta(item) {
  if (!item) return {};
  return {
    latestUserItemId: item.sourceId || '',
    latestUserStartPerfAt: finiteNumber(item.startPerfAt),
    latestUserEndPerfAt: finiteNumber(item.endPerfAt || item.perfAt),
    latestUserDurationMs: finiteNumber(item.durationMs),
    latestUserAvatarOverlapMs: finiteNumber(item.avatarOverlapMs),
    latestUserOverlappedAvatar: Boolean(item.overlappedAvatar)
  };
}

export function formatApiError(data, fallback) {
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

export function formatLogDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ja-JP', { hour12: false });
}

export function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function labelToClass(label) {
  if (label === 'risk') return 'risk';
  if (label === 'warn') return 'warn';
  return 'good';
}

export async function safeJson(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { text }; }
}

export function compactEvent(event) {
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

export function shouldShowStageAdvice(source) {
  return /^LLM\b/.test(source) || /^instant\b/.test(source);
}

export function microphoneAudioConstraints(echoCancellation) {
  return {
    echoCancellation,
    noiseSuppression: true,
    autoGainControl: true
  };
}

export function safeTrackSettings(track) {
  try {
    return track.getSettings?.() || {};
  } catch {
    return {};
  }
}

export function setHidden(el, hidden) {
  if (el) el.hidden = Boolean(hidden);
}

export function scrollToBottom(el) {
  requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
