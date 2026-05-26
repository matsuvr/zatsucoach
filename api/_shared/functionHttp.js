'use strict';

function parseJsonBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body); } catch { return {}; }
}

function jsonResponse(context, body, status = 200) {
  context.res = {
    status,
    headers: { 'Content-Type': 'application/json' },
    body
  };
}

function errorResponse(context, error, status = 500, extra = {}) {
  context.log.error(error);
  context.res = {
    status: error?.status || status,
    headers: { 'Content-Type': 'application/json' },
    body: {
      error: error && error.message ? error.message : String(error),
      code: error?.code,
      attempts: Array.isArray(error?.attempts) ? error.attempts : undefined,
      retryAfterMs: Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : undefined,
      rateLimits: error?.rateLimits,
      requestIds: error?.requestIds,
      endpoint: error?.endpoint,
      responseHeaders: error?.responseHeaders,
      serviceResponseText: error?.serviceResponseText,
      serviceResponseBody: error?.serviceResponseBody,
      ...extra
    }
  };
}

module.exports = {
  parseJsonBody,
  jsonResponse,
  errorResponse
};
