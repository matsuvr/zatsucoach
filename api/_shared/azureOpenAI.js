'use strict';

function endpointBase() {
  let endpoint = process.env.AZURE_OPENAI_ENDPOINT || '';
  const resource = process.env.AZURE_OPENAI_RESOURCE || '';
  if (!endpoint && resource) endpoint = `https://${resource}.openai.azure.com`;
  endpoint = endpoint.trim().replace(/\/+$/, '');
  endpoint = endpoint.replace(/\/openai\/v1$/i, '').replace(/\/openai$/i, '');
  return endpoint;
}

function hasConfig() {
  return Boolean(endpointBase() && process.env.AZURE_OPENAI_API_KEY);
}

function authHeaders(extra = {}) {
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  if (!apiKey) throw new Error('AZURE_OPENAI_API_KEY is not set');
  return { 'api-key': apiKey, ...extra };
}

function safeDeployment(value, fallback) {
  const raw = String(value || fallback || '').trim();
  if (!raw) throw new Error('deployment name is empty');
  if (!/^[\w.:-]+$/.test(raw)) throw new Error(`deployment name has invalid characters: ${raw}`);
  return raw;
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function postJson(url, body, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    let data = {};
    if (text) {
      try { data = JSON.parse(text); } catch { data = { text }; }
    }
    return { response, data, text };
  } finally {
    clearTimeout(timer);
  }
}

function errorResponse(context, error, status = 500, extra = {}) {
  context.log.error(error);
  context.res = {
    status: error?.status || status,
    headers: { 'Content-Type': 'application/json' },
    body: {
      error: error && error.message ? error.message : String(error),
      attempts: Array.isArray(error?.attempts) ? error.attempts : undefined,
      retryAfterMs: Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : undefined,
      ...extra
    }
  };
}

function jsonResponse(context, body, status = 200) {
  context.res = {
    status,
    headers: { 'Content-Type': 'application/json' },
    body
  };
}

function parseJsonBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body); } catch { return {}; }
}

function extractChatText(data) {
  return data?.choices?.[0]?.message?.content || data?.choices?.[0]?.delta?.content || data?.output_text || '';
}

class AzureOpenAIRequestError extends Error {
  constructor(message, { status = 500, attempts = [], retryAfterMs = 0 } = {}) {
    super(message);
    this.name = 'AzureOpenAIRequestError';
    this.status = status;
    this.attempts = attempts;
    this.retryAfterMs = retryAfterMs;
  }
}

function apiErrorMessage(result) {
  return result.data?.error?.message || result.data?.message || result.text || `chat completion failed: ${result.response.status}`;
}

function retryAfterMs(headers) {
  const retryAfter = headers?.get?.('retry-after');
  if (!retryAfter) return 0;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return 0;
}

function isParameterError(message, parameterName) {
  const text = String(message || '').toLowerCase();
  const parameter = parameterName.toLowerCase();
  return text.includes(parameter) && (
    text.includes('unsupported parameter') ||
    text.includes('unsupported value') ||
    text.includes('invalid parameter') ||
    text.includes('invalid value') ||
    text.includes('not supported')
  );
}

function isReasoningDeployment(model) {
  const name = String(model || '').toLowerCase();
  return /^o[1-9]/.test(name) || name.includes('gpt-5') || name.includes('codex');
}

function summarizeChatBody(body) {
  return {
    model: body.model,
    messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
    messageChars: Array.isArray(body.messages)
      ? body.messages.reduce((sum, item) => sum + String(item.content || '').length, 0)
      : 0,
    parameters: Object.keys(body)
      .filter((key) => key !== 'messages')
      .sort()
      .reduce((acc, key) => {
        acc[key] = body[key];
        return acc;
      }, {})
  };
}

function recordAttempt(attempts, name, body, result) {
  attempts.push({
    name,
    status: result.response.status,
    message: apiErrorMessage(result),
    retryAfterMs: retryAfterMs(result.response.headers),
    request: summarizeChatBody(body)
  });
}

function estimateTokenCount(text) {
  const value = String(text || '');
  const cjk = (value.match(/[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/g) || []).length;
  const nonCjk = Math.max(0, value.length - cjk);
  const words = (value.match(/[A-Za-z0-9_]+/g) || []).length;
  return Math.ceil(cjk * 1.1 + Math.max(words, nonCjk / 4) + 4);
}

function estimateMessageTokens(message) {
  return estimateTokenCount(message?.role || '') + estimateTokenCount(message?.content || '') + 6;
}

function trimTranscriptByBudget(transcript, { maxItems = 60, maxChars = 12000, maxTextChars = 1200, maxTokens = 6000 } = {}) {
  if (!Array.isArray(transcript)) return [];

  const normalized = transcript
    .map((item) => ({
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      text: String(item?.text || '').trim().slice(0, maxTextChars),
      at: item?.at ? String(item.at).slice(0, 40) : undefined
    }))
    .filter((item) => item.text)
    .map((item) => ({
      ...item,
      estimatedTokens: estimateMessageTokens({ role: item.role, content: item.text })
    }));

  const selected = [];
  let usedChars = 0;
  let usedTokens = 0;
  for (let i = normalized.length - 1; i >= 0 && selected.length < maxItems; i -= 1) {
    const item = normalized[i];
    const cost = item.role.length + item.text.length + 4;
    if (selected.length && (usedChars + cost > maxChars || usedTokens + item.estimatedTokens > maxTokens)) break;
    selected.push(item);
    usedChars += cost;
    usedTokens += item.estimatedTokens;
  }
  return selected.reverse().map(({ estimatedTokens, ...item }) => item);
}

function buildChatMessages({ instructions, transcript, maxItems = 60, maxChars = 12000, maxTextChars = 1200, maxTokens = 6000 }) {
  const messages = [{ role: 'system', content: instructions }];
  for (const item of trimTranscriptByBudget(transcript, { maxItems, maxChars, maxTextChars, maxTokens })) {
    messages.push({ role: item.role, content: item.text });
  }
  return messages;
}

async function chatCompletion({ deployment, messages, maxTokens = 96, temperature = 0.2, reasoningEffort = '', timeoutMs = 30000 }) {
  const endpoint = endpointBase();
  if (!endpoint) throw new Error('AZURE_OPENAI_ENDPOINT or AZURE_OPENAI_RESOURCE is not set');
  const model = safeDeployment(deployment, process.env.ADVISOR_DEPLOYMENT);
  const url = `${endpoint}/openai/v1/chat/completions`;
  const attempts = [];
  const body = {
    model,
    messages,
    temperature,
    n: 1,
    max_completion_tokens: clampNumber(maxTokens, 96, 16, 4096)
  };
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;

  let result = await postJson(url, body, timeoutMs);
  if (result.response.ok) return { data: result.data, deployment: model, usedFallback: false };
  recordAttempt(attempts, 'max_completion_tokens', body, result);

  const firstError = apiErrorMessage(result);
  if (body.reasoning_effort && isParameterError(firstError, 'reasoning_effort')) {
    const retryBody = { ...body };
    delete retryBody.reasoning_effort;
    result = await postJson(url, retryBody, timeoutMs);
    if (result.response.ok) return { data: result.data, deployment: model, usedFallback: true };
    recordAttempt(attempts, 'without_reasoning_effort', retryBody, result);
  }

  const secondError = apiErrorMessage(result);
  if (isParameterError(secondError, 'max_completion_tokens')) {
    if (isReasoningDeployment(model)) {
      throw new AzureOpenAIRequestError(
        `Azure OpenAI request failed before legacy fallback. Reasoning deployments must use max_completion_tokens with Chat Completions; not retrying with max_tokens. Last error: ${secondError}`,
        { status: result.response.status, attempts, retryAfterMs: retryAfterMs(result.response.headers) }
      );
    }
    const retryBody = { ...body, max_tokens: body.max_completion_tokens };
    delete retryBody.max_completion_tokens;
    delete retryBody.reasoning_effort;
    result = await postJson(url, retryBody, timeoutMs);
    if (result.response.ok) return { data: result.data, deployment: model, usedFallback: true };
    recordAttempt(attempts, 'legacy_max_tokens', retryBody, result);
  }

  throw new AzureOpenAIRequestError(apiErrorMessage(result), {
    status: result.response.status,
    attempts,
    retryAfterMs: retryAfterMs(result.response.headers)
  });
}

module.exports = {
  endpointBase,
  hasConfig,
  authHeaders,
  safeDeployment,
  clampNumber,
  postJson,
  errorResponse,
  jsonResponse,
  parseJsonBody,
  extractChatText,
  AzureOpenAIRequestError,
  estimateTokenCount,
  estimateMessageTokens,
  trimTranscriptByBudget,
  buildChatMessages,
  chatCompletion
};
