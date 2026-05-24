'use strict';

const {
  endpointBase,
  safeDeployment,
  clampNumber,
  postJson,
  errorResponse,
  jsonResponse,
  parseJsonBody
} = require('../_shared/azureOpenAI');

const ALLOWED_VOICES = new Set([
  'alloy',
  'ash',
  'ballad',
  'cedar',
  'coral',
  'echo',
  'marin',
  'sage',
  'shimmer',
  'verse'
]);

function safeVoice(value, fallback = 'marin') {
  const voice = String(value || fallback).trim().toLowerCase();
  if (!ALLOWED_VOICES.has(voice)) {
    throw new Error(`unsupported realtime voice: ${voice}`);
  }
  return voice;
}

function buildRealtimeSession(body, deployment) {
  const voice = safeVoice(body.voice, process.env.REALTIME_VOICE || 'marin');
  const transcriptionDeployment = safeDeployment(
    body.transcriptionDeployment,
    process.env.TRANSCRIPTION_DEPLOYMENT || 'gpt-4o-mini-transcribe'
  );
  const vadThreshold = clampNumber(body.vadThreshold, 0.55, 0.05, 0.95);
  const vadSilenceMs = clampNumber(body.vadSilenceMs, 650, 120, 1200);
  const maxResponseTokens = clampNumber(body.maxResponseTokens, 96, 16, 4096);
  const instructions = String(body.instructions || process.env.REALTIME_INSTRUCTIONS || '').slice(0, 12000);

  return {
    type: 'realtime',
    model: deployment,
    instructions,
    output_modalities: ['audio'],
    max_response_output_tokens: maxResponseTokens,
    audio: {
      input: {
        format: {
          type: 'audio/pcm',
          rate: 24000
        },
        transcription: {
          model: transcriptionDeployment,
          language: 'ja'
        },
        turn_detection: {
          type: 'server_vad',
          threshold: vadThreshold,
          prefix_padding_ms: 300,
          silence_duration_ms: vadSilenceMs,
          create_response: true
        }
      },
      output: {
        voice,
        format: {
          type: 'audio/pcm',
          rate: 24000
        }
      }
    }
  };
}

function clientSessionUpdate(session) {
  const { model, ...updatable } = session;
  return updatable;
}

module.exports = async function (context, req) {
  try {
    const endpoint = endpointBase();
    if (!endpoint) throw new Error('AZURE_OPENAI_ENDPOINT or AZURE_OPENAI_RESOURCE is not set');

    const body = parseJsonBody(req);
    const deployment = safeDeployment(body.realtimeDeployment, process.env.REALTIME_DEPLOYMENT || 'gpt-realtime-2');
    const session = buildRealtimeSession(body, deployment);
    const configuredPayload = {
      expires_after: { anchor: 'created_at', seconds: 600 },
      session
    };
    const minimalPayload = {
      expires_after: { anchor: 'created_at', seconds: 600 },
      session: {
        type: 'realtime',
        model: deployment
      }
    };

    const url = `${endpoint}/openai/v1/realtime/client_secrets`;
    let configMode = 'client_secret_session';
    let result = await postJson(url, configuredPayload, 30000);

    if (!result.response.ok) {
      configMode = 'client_session_update';
      result = await postJson(url, minimalPayload, 30000);
    }

    if (!result.response.ok) {
      const message = result.data?.error?.message || result.data?.message || result.text || `realtime token failed: ${result.response.status}`;
      throw new Error(message);
    }

    const data = result.data;
    const token = data.value || data.client_secret?.value;
    if (!token) throw new Error('Realtime client secret response did not include value');

    jsonResponse(context, {
      token,
      expires_at: data.expires_at || data.client_secret?.expires_at || null,
      webrtcUrl: `${endpoint}/openai/v1/realtime/calls`,
      deployment,
      voice: session.audio.output.voice,
      endpointHost: new URL(endpoint).host,
      configMode,
      requiresClientSessionUpdate: configMode === 'client_session_update',
      sessionConfig: configMode === 'client_session_update' ? clientSessionUpdate(session) : undefined,
      session: {
        output_modalities: session.output_modalities,
        max_response_output_tokens: session.max_response_output_tokens,
        turn_detection: session.audio.input.turn_detection,
        transcription: {
          model: session.audio.input.transcription.model,
          language: session.audio.input.transcription.language
        },
        voice: session.audio.output.voice
      }
    });
  } catch (error) {
    errorResponse(context, error, 500);
  }
};
