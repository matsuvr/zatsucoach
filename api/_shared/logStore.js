'use strict';

const crypto = require('crypto');
const { TableClient } = require('@azure/data-tables');
const {
  HttpError,
  authenticatedUser
} = require('./appAuth');

const DEFAULT_SESSIONS_TABLE = 'ZatsucoachSessions';
const DEFAULT_ITEMS_TABLE = 'ZatsucoachItems';
const DEFAULT_DIAGNOSTICS_TABLE = 'ZatsucoachDiagnostics';
const MAX_TITLE_CHARS = 120;
const MAX_TEXT_CHARS = 4000;
const MAX_META_CHARS = 8000;
const MAX_BATCH_ITEMS = 50;
const MAX_DIAGNOSTIC_EVENTS = 50;
const MAX_DIAGNOSTIC_JSON_CHARS = 12000;

let sessionsClientPromise = null;
let itemsClientPromise = null;
let diagnosticsClientPromise = null;

function storageConnectionString() {
  return process.env.ZATSUCOACH_LOG_STORAGE_CONNECTION_STRING ||
    process.env.AzureWebJobsStorage ||
    '';
}

function sessionsTableName() {
  return safeTableName(process.env.ZATSUCOACH_LOG_SESSIONS_TABLE || DEFAULT_SESSIONS_TABLE);
}

function itemsTableName() {
  return safeTableName(process.env.ZATSUCOACH_LOG_ITEMS_TABLE || DEFAULT_ITEMS_TABLE);
}

function diagnosticsTableName() {
  return safeTableName(process.env.ZATSUCOACH_DIAGNOSTIC_EVENTS_TABLE || DEFAULT_DIAGNOSTICS_TABLE);
}

function safeTableName(value) {
  const name = String(value || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9]{2,62}$/.test(name)) {
    throw new Error(`invalid Azure Table name: ${name}`);
  }
  return name;
}

function tableClient(tableName) {
  const connectionString = storageConnectionString();
  if (!connectionString) {
    throw new Error('ZATSUCOACH_LOG_STORAGE_CONNECTION_STRING or AzureWebJobsStorage is not set');
  }
  return TableClient.fromConnectionString(connectionString, tableName);
}

async function ensureTable(client) {
  try {
    await client.createTable();
  } catch (error) {
    if (error.statusCode !== 409) throw error;
  }
  return client;
}

function sessionsClient() {
  if (!sessionsClientPromise) {
    sessionsClientPromise = ensureTable(tableClient(sessionsTableName()));
  }
  return sessionsClientPromise;
}

function itemsClient() {
  if (!itemsClientPromise) {
    itemsClientPromise = ensureTable(tableClient(itemsTableName()));
  }
  return itemsClientPromise;
}

function diagnosticsClient() {
  if (!diagnosticsClientPromise) {
    diagnosticsClientPromise = ensureTable(tableClient(diagnosticsTableName()));
  }
  return diagnosticsClientPromise;
}

function hasLogStorageConfig() {
  return Boolean(storageConnectionString());
}

function cleanText(value, maxChars) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

function safeSessionId(value = '') {
  const raw = cleanText(value, 80);
  if (!raw) return crypto.randomUUID();
  if (!/^[A-Za-z0-9_.:-]{8,80}$/.test(raw)) throw new HttpError(400, 'invalid sessionId');
  return raw;
}

function itemPartitionKey(user, sessionId) {
  return `${user.safeUserId}_${safeSessionId(sessionId)}`;
}

function safeRowKey(value, fallback = crypto.randomUUID()) {
  const raw = cleanText(value || fallback, 160);
  return raw.replace(/[\\/#?\u0000-\u001f\u007f]/g, '_').slice(0, 160) || fallback;
}

function odataString(value) {
  return String(value || '').replace(/'/g, "''");
}

function sessionEntity(user, body = {}, sessionId = safeSessionId(body.sessionId)) {
  const now = new Date().toISOString();
  const title = cleanText(body.title || body.latestUserText || '会話ログ', MAX_TITLE_CHARS);
  return {
    partitionKey: user.safeUserId,
    rowKey: sessionId,
    sessionId,
    title,
    identityProvider: user.provider,
    userDetails: user.userDetails,
    startedAt: cleanText(body.startedAt || now, 40),
    updatedAt: now,
    endedAt: body.endedAt ? cleanText(body.endedAt, 40) : '',
    itemCount: safeCount(body.itemCount),
    transcriptCount: safeCount(body.transcriptCount),
    adviceCount: safeCount(body.adviceCount)
  };
}

function patchSessionEntity(user, body = {}) {
  const sessionId = safeSessionId(body.sessionId);
  const entity = {
    partitionKey: user.safeUserId,
    rowKey: sessionId,
    sessionId,
    updatedAt: new Date().toISOString()
  };
  if (body.title || body.latestUserText) entity.title = cleanText(body.title || body.latestUserText, MAX_TITLE_CHARS);
  if (body.endedAt) entity.endedAt = cleanText(body.endedAt, 40);
  if (body.itemCount !== undefined) entity.itemCount = safeCount(body.itemCount);
  if (body.transcriptCount !== undefined) entity.transcriptCount = safeCount(body.transcriptCount);
  if (body.adviceCount !== undefined) entity.adviceCount = safeCount(body.adviceCount);
  return entity;
}

function normalizeLogItem(user, sessionId, item, index) {
  const kind = ['transcript', 'advice'].includes(item?.kind) ? item.kind : 'transcript';
  const role = ['user', 'assistant', 'system'].includes(item?.role) ? item.role : '';
  const sequence = safeCount(item?.sequence ?? index);
  const itemId = safeRowKey(item?.id, crypto.randomUUID());
  const metaJson = cleanText(JSON.stringify(item?.meta && typeof item.meta === 'object' ? item.meta : {}), MAX_META_CHARS);
  return {
    partitionKey: itemPartitionKey(user, sessionId),
    rowKey: `${String(sequence).padStart(8, '0')}_${itemId}`.slice(0, 160),
    sessionId,
    kind,
    role,
    text: cleanText(item?.text || '', MAX_TEXT_CHARS),
    label: cleanText(item?.label || '', 24),
    source: cleanText(item?.source || '', 80),
    at: cleanText(item?.at || new Date().toISOString(), 40),
    sequence,
    metaJson
  };
}

function normalizeItems(body) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length > MAX_BATCH_ITEMS) throw new HttpError(400, `items length must be <= ${MAX_BATCH_ITEMS}`);
  return items;
}

function normalizeDiagnosticEvents(user, body = {}) {
  const events = Array.isArray(body.events) ? body.events : [];
  if (events.length > MAX_DIAGNOSTIC_EVENTS) throw new HttpError(400, `events length must be <= ${MAX_DIAGNOSTIC_EVENTS}`);
  return events
    .map((event, index) => normalizeDiagnosticEvent(user, event, index))
    .filter(Boolean);
}

function normalizeDiagnosticEvent(user, event = {}, index = 0) {
  const type = cleanText(event.type || '', 120);
  if (!isDiagnosticEventType(type)) return null;

  const at = cleanText(event.at || new Date().toISOString(), 40);
  const dateKey = at.slice(0, 10).replace(/-/g, '') || new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const sessionId = cleanText(event.sessionId || '', 80);
  const responseId = cleanText(event.responseId || '', 120);
  const itemId = cleanText(event.itemId || '', 120);
  const details = safeDiagnosticDetails(event.details);
  return {
    partitionKey: `${user.safeUserId}_${dateKey}`,
    rowKey: safeRowKey(`${at}_${String(index).padStart(3, '0')}_${crypto.randomUUID()}`),
    at,
    type,
    sessionId,
    logSessionId: cleanText(event.logSessionId || '', 80),
    deployment: cleanText(event.deployment || '', 120),
    voice: cleanText(event.voice || '', 40),
    connectionState: cleanText(event.connectionState || '', 40),
    iceConnectionState: cleanText(event.iceConnectionState || '', 40),
    dataChannelState: cleanText(event.dataChannelState || '', 40),
    eventId: cleanText(event.eventId || '', 120),
    responseId,
    itemId,
    status: cleanText(event.status || '', 40),
    reason: cleanText(event.reason || '', 120),
    errorCode: cleanText(event.errorCode || '', 120),
    errorMessage: cleanText(event.errorMessage || '', 240),
    perfAt: safeCount(event.perfAt),
    detailsJson: cleanText(JSON.stringify(details), MAX_DIAGNOSTIC_JSON_CHARS)
  };
}

function safeDiagnosticDetails(value) {
  return stripDiagnosticSecrets(value, 0);
}

function stripDiagnosticSecrets(value, depth) {
  if (depth > 5) return null;
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return cleanText(value, 500);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => stripDiagnosticSecrets(item, depth + 1));
  if (typeof value !== 'object') return null;

  const blocked = new Set([
    'authorization',
    'apikey',
    'api-key',
    'client_secret',
    'data',
    'delta',
    'instructions',
    'messages',
    'sdp',
    'text',
    'token',
    'transcript'
  ]);
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    const safeKey = cleanText(key, 80);
    if (!safeKey || blocked.has(safeKey.toLowerCase())) continue;
    const safeValue = stripDiagnosticSecrets(item, depth + 1);
    if (safeValue === null || safeValue === undefined || safeValue === '') continue;
    next[safeKey] = safeValue;
  }
  return next;
}

function isDiagnosticEventType(type) {
  return [
    'response.created',
    'response.done',
    'error',
    'session.error',
    'output_audio_buffer.cleared',
    'output_audio_buffer.started',
    'output_audio_buffer.stopped',
    'input_audio_buffer.speech_started',
    'input_audio_buffer.speech_stopped',
    'conversation.item.input_audio_transcription.failed',
    'conversation.item.audio_transcription.failed',
    'client.assistant_response_cancelled_by_barge_in',
    'client.assistant_response_flushed',
    'client.assistant_response_interrupted',
    'client.connection_state',
    'client.data_channel_open',
    'client.data_channel_close',
    'client.data_channel_error',
    'client.ice_state',
    'client.manual_response_create_deferred',
    'client.manual_response_create_sent',
    'client.late_response_created_after_barge_in',
    'client.microphone_tracks_set',
    'client.noise_turn_ignored',
    'client.output_audio_stop_watchdog_released',
    'client.realtime_context_prune_sent',
    'client.realtime_response_create_timeout',
    'client.realtime_response_watchdog_released',
    'client.realtime_sdp_request',
    'client.realtime_sdp_response',
    'client.realtime_start_skipped',
    'client.realtime_stop_skipped',
    'client.realtime_token_request',
    'client.realtime_voice_mismatch',
    'client.session_configured',
    'client.session_ready_timeout',
    'client.unparsed_message',
    'client.user_transcription_failed',
    'client.user_turn_accepted'
  ].includes(type);
}

function safeCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count < 0) return 0;
  return Math.min(1000000, Math.floor(count));
}

function sessionDto(entity) {
  return {
    sessionId: entity.rowKey,
    title: entity.title || '会話ログ',
    startedAt: entity.startedAt || '',
    updatedAt: entity.updatedAt || '',
    endedAt: entity.endedAt || '',
    itemCount: Number(entity.itemCount || 0),
    transcriptCount: Number(entity.transcriptCount || 0),
    adviceCount: Number(entity.adviceCount || 0)
  };
}

function itemDto(entity) {
  let meta = {};
  try {
    meta = entity.metaJson ? JSON.parse(entity.metaJson) : {};
  } catch {
    meta = {};
  }
  return {
    id: entity.rowKey,
    sessionId: entity.sessionId || '',
    kind: entity.kind || 'transcript',
    role: entity.role || '',
    text: entity.text || '',
    label: entity.label || '',
    source: entity.source || '',
    at: entity.at || '',
    sequence: Number(entity.sequence || 0),
    meta
  };
}

module.exports = {
  HttpError,
  authenticatedUser,
  hasLogStorageConfig,
  sessionsClient,
  itemsClient,
  diagnosticsClient,
  safeSessionId,
  itemPartitionKey,
  odataString,
  sessionEntity,
  patchSessionEntity,
  normalizeItems,
  normalizeLogItem,
  normalizeDiagnosticEvents,
  normalizeDiagnosticEvent,
  sessionDto,
  itemDto
};
