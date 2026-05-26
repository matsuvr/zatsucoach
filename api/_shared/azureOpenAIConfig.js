'use strict';

function normalizeEndpoint(endpoint) {
  return String(endpoint || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api\/models$/i, '')
    .replace(/\/models$/i, '')
    .replace(/\/openai\/v1$/i, '')
    .replace(/\/openai$/i, '');
}

function endpointBase(endpointOverride = '') {
  let endpoint = endpointOverride || process.env.AZURE_OPENAI_ENDPOINT || '';
  const resource = process.env.AZURE_OPENAI_RESOURCE || '';
  if (!endpoint && resource) endpoint = `https://${resource}.openai.azure.com`;
  return normalizeEndpoint(endpoint);
}

function advisorEndpointBase() {
  return endpointBase(
    process.env.ADVISOR_ENDPOINT ||
    process.env.FOUNDRY_MODELS_ENDPOINT ||
    process.env.AZURE_INFERENCE_ENDPOINT ||
    ''
  ) || endpointBase();
}

function advisorEndpointRaw() {
  return process.env.ADVISOR_ENDPOINT ||
    process.env.FOUNDRY_MODELS_ENDPOINT ||
    process.env.AZURE_INFERENCE_ENDPOINT ||
    '';
}

function normalizeAdvisorRoute(value) {
  const route = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (['foundry', 'foundry_models', 'model_inference', 'models'].includes(route)) return 'foundry_models';
  if (['openai', 'openai_v1', 'v1'].includes(route)) return 'openai_v1';
  return 'auto';
}

function advisorEndpointRoute() {
  const configured = normalizeAdvisorRoute(process.env.ADVISOR_API_ROUTE || process.env.ADVISOR_ROUTE || '');
  if (configured !== 'auto') return configured;
  return /\/(?:api\/)?models\/?$/i.test(String(advisorEndpointRaw()).trim()) ? 'foundry_models' : 'auto';
}

function hasConfig() {
  return Boolean(endpointBase() && process.env.AZURE_OPENAI_API_KEY);
}

function advisorApiKey() {
  return process.env.ADVISOR_API_KEY ||
    process.env.FOUNDRY_MODELS_API_KEY ||
    process.env.AZURE_INFERENCE_CREDENTIAL ||
    process.env.AZURE_OPENAI_API_KEY ||
    '';
}

function hasAdvisorConfig() {
  return Boolean(advisorEndpointBase() && advisorApiKey());
}

function authHeaders(extra = {}, apiKeyOverride = '') {
  const apiKey = apiKeyOverride || process.env.AZURE_OPENAI_API_KEY;
  if (!apiKey) throw new Error('AZURE_OPENAI_API_KEY is not set');
  return { 'api-key': apiKey, ...extra };
}

function safeDeployment(value, fallback) {
  const raw = String(value || fallback || '').trim();
  if (!raw) throw new Error('deployment name is empty');
  if (!/^[\w.:-]+$/.test(raw)) throw new Error(`deployment name has invalid characters: ${raw}`);
  return raw;
}

function advisorDeploymentAlias(value) {
  const raw = String(value || '').trim();
  const key = raw.toLowerCase();
  const aliases = {
    'kimi-2.6': 'Kimi-K2.6',
    'kimi-k2.6': 'Kimi-K2.6',
    'kimi-k2-6': 'Kimi-K2.6',
    'kimi-2.5': 'Kimi-K2.5',
    'kimi-k2.5': 'Kimi-K2.5',
    'kimi-k2-5': 'Kimi-K2.5'
  };
  return aliases[key] || raw;
}

function advisorDeployment(value, fallback) {
  return advisorDeploymentAlias(safeDeployment(value, fallback));
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

module.exports = {
  normalizeEndpoint,
  endpointBase,
  advisorEndpointBase,
  advisorEndpointRoute,
  normalizeAdvisorRoute,
  hasConfig,
  hasAdvisorConfig,
  advisorApiKey,
  authHeaders,
  safeDeployment,
  advisorDeployment,
  advisorDeploymentAlias,
  clampNumber
};
