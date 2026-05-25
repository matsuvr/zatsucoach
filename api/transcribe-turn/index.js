'use strict';

const {
  endpointBase,
  authHeaders,
  safeDeployment,
  errorResponse,
  jsonResponse,
  parseJsonBody
} = require('../_shared/azureOpenAI');
const { authenticatedUser } = require('../_shared/appAuth');

const MIME_EXTENSIONS = {
  'audio/webm': 'webm',
  'audio/webm;codecs=opus': 'webm',
  'audio/ogg': 'ogg',
  'audio/ogg;codecs=opus': 'ogg',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav'
};

function compactHeaders(headers) {
  return {
    'apim-request-id': headers.get('apim-request-id') || null,
    'x-ms-request-id': headers.get('x-ms-request-id') || null,
    'x-ms-region': headers.get('x-ms-region') || null
  };
}

function parseResponseText(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

module.exports = async function (context, req) {
  try {
    authenticatedUser(req);

    if (String(process.env.ENABLE_TRANSCRIBE_DIAGNOSTIC || '').toLowerCase() !== 'true') {
      jsonResponse(context, {
        error: 'transcribe-turn is disabled. Set ENABLE_TRANSCRIBE_DIAGNOSTIC=true only for explicit diagnostic smoke tests.'
      }, 403);
      return;
    }

    const endpoint = endpointBase();
    if (!endpoint) throw new Error('AZURE_OPENAI_ENDPOINT or AZURE_OPENAI_RESOURCE is not set');

    const body = parseJsonBody(req);
    const deployment = safeDeployment(body.deployment, process.env.TRANSCRIPTION_DEPLOYMENT || 'gpt-4o-mini-transcribe');
    const apiVersion = String(process.env.AZURE_OPENAI_AUDIO_API_VERSION || '2025-04-01-preview');
    const mimeType = String(body.mimeType || 'audio/webm').split(',')[0].trim();
    const audioBase64 = String(body.audioBase64 || '');
    if (!audioBase64) throw new Error('audioBase64 is required');

    const audio = Buffer.from(audioBase64, 'base64');
    if (!audio.length) throw new Error('audio payload is empty');
    if (audio.length > 8 * 1024 * 1024) throw new Error('audio payload is too large');

    const ext = MIME_EXTENSIONS[mimeType] || 'webm';
    const form = new FormData();
    form.append('language', 'ja');
    form.append('file', new Blob([audio], { type: mimeType }), `turn.${ext}`);

    const started = Date.now();
    const url = `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/audio/transcriptions?api-version=${encodeURIComponent(apiVersion)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: authHeaders(),
      body: form
    });
    const text = await response.text();
    const data = parseResponseText(text);
    if (!response.ok) {
      const message = data?.error?.message || data?.message || text || `transcription failed: ${response.status}`;
      context.log.error('transcribe-turn failed', {
        status: response.status,
        statusText: response.statusText,
        deployment,
        endpointHost: new URL(endpoint).host,
        apiVersion,
        response: data,
        headers: compactHeaders(response.headers)
      });
      context.res = {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
        body: {
          error: message,
          status: response.status,
          statusText: response.statusText,
          deployment,
          endpointHost: new URL(endpoint).host,
          apiVersion,
          azureError: data?.error || data,
          requestIds: compactHeaders(response.headers)
        }
      };
      return;
    }

    jsonResponse(context, {
      text: String(data.text || data.output_text || '').trim(),
      deployment,
      endpointHost: new URL(endpoint).host,
      apiVersion,
      latencyMs: Date.now() - started
    });
  } catch (error) {
    errorResponse(context, error, 500);
  }
};
