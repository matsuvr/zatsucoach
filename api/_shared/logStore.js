'use strict';

const crypto = require('crypto');
const { TableClient } = require('@azure/data-tables');

const DEFAULT_SESSIONS_TABLE = 'ZatsucoachSessions';
const DEFAULT_ITEMS_TABLE = 'ZatsucoachItems';
const MAX_TITLE_CHARS = 120;
const MAX_TEXT_CHARS = 4000;
const MAX_META_CHARS = 8000;
const MAX_BATCH_ITEMS = 50;

let sessionsClientPromise = null;
let itemsClientPromise = null;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

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

function hasLogStorageConfig() {
  return Boolean(storageConnectionString());
}

function authenticatedUser(req) {
  const raw = header(req, 'x-ms-client-principal');
  if (!raw) throw new HttpError(401, 'authentication required');

  let principal = null;
  try {
    principal = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    throw new HttpError(401, 'invalid authentication principal');
  }

  const roles = Array.isArray(principal.userRoles) ? principal.userRoles : [];
  if (!roles.includes('authenticated')) throw new HttpError(401, 'authentication required');

  const provider = cleanText(principal.identityProvider || 'aad', 40);
  const userId = cleanText(principal.userId || '', 240);
  if (!userId) throw new HttpError(401, 'authenticated user id is missing');

  const userDetails = cleanText(principal.userDetails || '', 320);
  return {
    provider,
    userId,
    userDetails,
    safeUserId: crypto
      .createHash('sha256')
      .update(`${provider}:${userId}`)
      .digest('hex')
  };
}

function header(req, name) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(req.headers || {})) {
    if (String(key).toLowerCase() === target) return Array.isArray(value) ? value[0] : value;
  }
  return '';
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
  safeSessionId,
  itemPartitionKey,
  odataString,
  sessionEntity,
  patchSessionEntity,
  normalizeItems,
  normalizeLogItem,
  sessionDto,
  itemDto
};
