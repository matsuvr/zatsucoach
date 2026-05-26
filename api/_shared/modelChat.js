'use strict';

const {
  endpointBase,
  advisorDeployment,
  authHeaders,
  clampNumber,
  normalizeAdvisorRoute
} = require('./azureOpenAIConfig');

async function postJson(url, body, timeoutMs = 30000, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }, options.apiKey),
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

function extractChatText(data) {
  return data?.choices?.[0]?.message?.content || data?.choices?.[0]?.delta?.content || data?.output_text || '';
}

function summarizeChoiceMessage(data) {
  const message = data?.choices?.[0]?.message || {};
  return {
    role: message.role || null,
    contentChars: String(message.content || '').length,
    reasoningContentChars: String(message.reasoning_content || '').length,
    finishReason: data?.choices?.[0]?.finish_reason || null,
    usage: data?.usage || null
  };
}

class AzureOpenAIRequestError extends Error {
  constructor(message, { status = 500, attempts = [], retryAfterMs = 0, rateLimits = {}, requestIds = {}, endpoint = null, responseHeaders = {}, serviceResponseText = '', serviceResponseBody = null } = {}) {
    super(message);
    this.name = 'AzureOpenAIRequestError';
    this.status = status;
    this.attempts = attempts;
    this.retryAfterMs = retryAfterMs;
    this.rateLimits = rateLimits;
    this.requestIds = requestIds;
    this.endpoint = endpoint;
    this.responseHeaders = responseHeaders;
    this.serviceResponseText = serviceResponseText;
    this.serviceResponseBody = serviceResponseBody;
  }
}

function apiErrorMessage(result) {
  if (!result) return '';
  return result.data?.error?.message || result.data?.message || result.text || `HTTP ${result.response.status}`;
}

function retryAfterMs(headers) {
  const retryAfterMsValue = headers?.get?.('retry-after-ms');
  if (retryAfterMsValue) {
    const ms = Number(retryAfterMsValue);
    if (Number.isFinite(ms)) return Math.max(0, Math.round(ms));
  }
  const retryAfter = headers?.get?.('retry-after');
  if (!retryAfter) return 0;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return 0;
}

function rateLimitHeaders(headers) {
  if (!headers?.get) return {};
  const names = [
    'x-ratelimit-limit-requests',
    'x-ratelimit-limit-tokens',
    'x-ratelimit-remaining-requests',
    'x-ratelimit-remaining-tokens',
    'x-ratelimit-reset-requests',
    'x-ratelimit-reset-tokens',
    'retry-after-ms',
    'retry-after'
  ];
  return names.reduce((acc, name) => {
    const value = headers.get(name);
    if (value) acc[name] = value;
    return acc;
  }, {});
}

function requestIdHeaders(headers) {
  if (!headers?.get) return {};
  const names = ['apim-request-id', 'x-ms-request-id', 'x-request-id'];
  return names.reduce((acc, name) => {
    const value = headers.get(name);
    if (value) acc[name] = value;
    return acc;
  }, {});
}

function responseHeaders(headers) {
  if (!headers?.forEach) return {};
  const selected = {};
  headers.forEach((value, name) => {
    const key = String(name || '').toLowerCase();
    if (
      key === 'content-type' ||
      key === 'warning' ||
      key.startsWith('x-ms-') ||
      key.startsWith('x-ratelimit-') ||
      key.startsWith('retry-after') ||
      key === 'apim-request-id' ||
      key === 'x-request-id'
    ) {
      selected[key] = value;
    }
  });
  return selected;
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

function serviceResponseText(result) {
  if (!result) return '';
  return result.text || (result.data && Object.keys(result.data).length ? JSON.stringify(result.data) : '');
}

function errorCauseSummary(error) {
  const cause = error?.cause;
  if (!cause || typeof cause !== 'object') return null;
  return {
    name: cause.name || null,
    code: cause.code || null,
    errno: cause.errno || null,
    syscall: cause.syscall || null,
    hostname: cause.hostname || null,
    message: cause.message || null
  };
}

function recordAttempt(attempts, name, body, result, meta = {}) {
  attempts.push({
    name,
    route: meta.route,
    url: meta.url,
    status: result.response.status,
    message: serviceResponseText(result) || apiErrorMessage(result),
    responseText: serviceResponseText(result),
    responseBody: result.data,
    responseHeaders: responseHeaders(result.response.headers),
    retryAfterMs: retryAfterMs(result.response.headers),
    rateLimits: rateLimitHeaders(result.response.headers),
    requestIds: requestIdHeaders(result.response.headers),
    request: summarizeChatBody(body)
  });
}

function recordNetworkAttempt(attempts, name, body, error, meta = {}) {
  attempts.push({
    name,
    route: meta.route,
    url: meta.url,
    status: 0,
    message: error?.message || String(error),
    errorName: error?.name || null,
    errorCause: errorCauseSummary(error),
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
      at: item?.at ? String(item.at).slice(0, 40) : undefined,
      sourceId: item?.sourceId ? String(item.sourceId).slice(0, 160) : undefined,
      startPerfAt: safeFiniteNumber(item?.startPerfAt),
      endPerfAt: safeFiniteNumber(item?.endPerfAt),
      perfAt: safeFiniteNumber(item?.perfAt),
      durationMs: safeFiniteNumber(item?.durationMs),
      approxSpeechMs: safeFiniteNumber(item?.approxSpeechMs),
      avatarOverlapMs: safeFiniteNumber(item?.avatarOverlapMs),
      overlappedAvatar: Boolean(item?.overlappedAvatar)
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

function safeFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function buildChatMessages({ instructions, transcript, maxItems = 60, maxChars = 12000, maxTextChars = 1200, maxTokens = 6000 }) {
  const messages = [{ role: 'system', content: instructions }];
  for (const item of trimTranscriptByBudget(transcript, { maxItems, maxChars, maxTextChars, maxTokens })) {
    messages.push({ role: item.role, content: item.text });
  }
  return messages;
}

function isServicesAiEndpoint(baseEndpoint) {
  try {
    return new URL(baseEndpoint).host.toLowerCase().endsWith('.services.ai.azure.com');
  } catch {
    return false;
  }
}

function isOpenAIEndpoint(baseEndpoint) {
  try {
    return new URL(baseEndpoint).host.toLowerCase().endsWith('.openai.azure.com');
  } catch {
    return false;
  }
}

function derivedServicesEndpoint(baseEndpoint) {
  try {
    const url = new URL(baseEndpoint);
    url.host = url.host.replace(/\.openai\.azure\.com$/i, '.services.ai.azure.com');
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function isKimiDeployment(model) {
  return String(model || '').toLowerCase().includes('kimi');
}

function chatCompletionRoutes(baseEndpoint, routeHint, model) {
  const route = normalizeAdvisorRoute(routeHint);
  if (route === 'foundry_models') return [{ route: 'foundry_models', baseEndpoint }];
  if (route === 'openai_v1') return [{ route: 'openai_v1', baseEndpoint }];
  const routes = isServicesAiEndpoint(baseEndpoint)
    ? [{ route: 'openai_v1', baseEndpoint }, { route: 'foundry_models', baseEndpoint }]
    : [{ route: 'openai_v1', baseEndpoint }];
  const servicesEndpoint = isKimiDeployment(model) && isOpenAIEndpoint(baseEndpoint) ? derivedServicesEndpoint(baseEndpoint) : '';
  if (servicesEndpoint) routes.push({ route: 'foundry_models', baseEndpoint: servicesEndpoint });
  return routes;
}

function chatCompletionUrl(baseEndpoint, route) {
  if (route === 'foundry_models') {
    const apiVersion = process.env.ADVISOR_MODEL_INFERENCE_API_VERSION || '2024-05-01-preview';
    return `${baseEndpoint}/models/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
  }
  return `${baseEndpoint}/openai/v1/chat/completions`;
}

function buildChatCompletionBody(route, { model, messages, maxTokens, temperature, reasoningEffort }) {
  let tokenLimit = clampNumber(maxTokens, 2048, 512, 4096);
  if (route === 'foundry_models') {
    if (isKimiDeployment(model)) tokenLimit = 4096;
    const body = {
      model,
      messages,
      temperature,
      max_tokens: tokenLimit
    };
    if (isKimiDeployment(model)) body.thinking = { type: 'disabled' };
    return body;
  }
  const body = {
    model,
    messages,
    temperature,
    n: 1,
    max_completion_tokens: tokenLimit
  };
  if (reasoningEffort && String(reasoningEffort).toLowerCase() !== 'none') body.reasoning_effort = reasoningEffort;
  return body;
}

function shouldTryNextRoute(result) {
  return [400, 404, 422].includes(result?.response?.status);
}

function successfulChatResult(result, model, route, url, usedFallback) {
  return {
    data: result.data,
    deployment: model,
    usedFallback,
    endpoint: { route, url },
    rateLimits: rateLimitHeaders(result.response.headers),
    requestIds: requestIdHeaders(result.response.headers),
    responseHeaders: responseHeaders(result.response.headers),
    choiceMessage: summarizeChoiceMessage(result.data)
  };
}

function networkRequestError(error, attempts, route, url) {
  return new AzureOpenAIRequestError(error?.message || String(error), {
    status: 502,
    attempts,
    endpoint: { route, url },
    serviceResponseText: error?.message || String(error),
    serviceResponseBody: {
      errorName: error?.name || null,
      errorCause: errorCauseSummary(error)
    }
  });
}

async function chatCompletion({ deployment, messages, maxTokens = 2048, temperature = 0.2, reasoningEffort = '', timeoutMs = 30000, endpoint = '', apiKey = '', routeHint = '' }) {
  const baseEndpoint = endpointBase(endpoint);
  if (!baseEndpoint) throw new Error('AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_RESOURCE, or advisor endpoint is not set');
  const model = advisorDeployment(deployment, process.env.ADVISOR_DEPLOYMENT);
  const attempts = [];
  const routes = chatCompletionRoutes(baseEndpoint, routeHint, model);
  let lastResult = null;
  let lastRoute = routes[0];
  let lastUrl = '';

  for (let i = 0; i < routes.length; i += 1) {
    const routeInfo = routes[i];
    const { route } = routeInfo;
    const url = chatCompletionUrl(routeInfo.baseEndpoint, route);
    const body = buildChatCompletionBody(route, { model, messages, maxTokens, temperature, reasoningEffort });
    const primaryAttemptName = route === 'foundry_models' ? 'foundry_models_max_tokens' : 'openai_v1_max_completion_tokens';
    lastRoute = route;
    lastUrl = url;

    let result = null;
    try {
      result = await postJson(url, body, timeoutMs, { apiKey });
    } catch (error) {
      recordNetworkAttempt(attempts, `${primaryAttemptName}_network_error`, body, error, { route, url });
      if (i < routes.length - 1) continue;
      throw networkRequestError(error, attempts, route, url);
    }
    lastResult = result;
    if (result.response.ok) return successfulChatResult(result, model, route, url, i > 0);
    recordAttempt(attempts, primaryAttemptName, body, result, { route, url });

    if (route === 'openai_v1') {
      const firstError = apiErrorMessage(result);
      if (body.reasoning_effort && isParameterError(firstError, 'reasoning_effort')) {
        const retryBody = { ...body };
        delete retryBody.reasoning_effort;
        try {
          result = await postJson(url, retryBody, timeoutMs, { apiKey });
        } catch (error) {
          recordNetworkAttempt(attempts, 'openai_v1_without_reasoning_effort_network_error', retryBody, error, { route, url });
          if (i < routes.length - 1) break;
          throw networkRequestError(error, attempts, route, url);
        }
        lastResult = result;
        if (result.response.ok) return successfulChatResult(result, model, route, url, true);
        recordAttempt(attempts, 'openai_v1_without_reasoning_effort', retryBody, result, { route, url });
      }

      const secondError = apiErrorMessage(result);
      if (isParameterError(secondError, 'max_completion_tokens') && !isReasoningDeployment(model)) {
        const retryBody = { ...body, max_tokens: body.max_completion_tokens };
        delete retryBody.max_completion_tokens;
        delete retryBody.reasoning_effort;
        try {
          result = await postJson(url, retryBody, timeoutMs, { apiKey });
        } catch (error) {
          recordNetworkAttempt(attempts, 'openai_v1_legacy_max_tokens_network_error', retryBody, error, { route, url });
          if (i < routes.length - 1) break;
          throw networkRequestError(error, attempts, route, url);
        }
        lastResult = result;
        if (result.response.ok) return successfulChatResult(result, model, route, url, true);
        recordAttempt(attempts, 'openai_v1_legacy_max_tokens', retryBody, result, { route, url });
      }
    }

    if (!shouldTryNextRoute(result)) break;
  }

  throw new AzureOpenAIRequestError(serviceResponseText(lastResult) || apiErrorMessage(lastResult), {
    status: lastResult?.response?.status || 500,
    attempts,
    retryAfterMs: retryAfterMs(lastResult?.response?.headers),
    rateLimits: rateLimitHeaders(lastResult?.response?.headers),
    requestIds: requestIdHeaders(lastResult?.response?.headers),
    endpoint: { route: lastRoute, url: lastUrl },
    responseHeaders: responseHeaders(lastResult?.response?.headers),
    serviceResponseText: serviceResponseText(lastResult),
    serviceResponseBody: lastResult?.data
  });
}

module.exports = {
  postJson,
  extractChatText,
  summarizeChoiceMessage,
  AzureOpenAIRequestError,
  rateLimitHeaders,
  requestIdHeaders,
  retryAfterMs,
  estimateTokenCount,
  estimateMessageTokens,
  trimTranscriptByBudget,
  buildChatMessages,
  isServicesAiEndpoint,
  isOpenAIEndpoint,
  derivedServicesEndpoint,
  isKimiDeployment,
  chatCompletionRoutes,
  chatCompletionUrl,
  buildChatCompletionBody,
  chatCompletion
};
