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
const { requireInteractiveAccess } = require('../_shared/appAuth');

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

const ALLOWED_NOISE_REDUCTION = new Set(['far_field', 'near_field', 'off']);
const DEFAULT_REALTIME_DEPLOYMENT = 'gpt-realtime-1.5';
const MAX_REALTIME_INSTRUCTIONS_CHARS = 12000;
const REALTIME_INSTRUCTION_SUFFIX = `補足制約:
- 暑さ、冷房、日差し、席、植物、においなどの雑談では、医療・安全・健康指導に寄せず、職場環境や好みの軽い会話として返す。
- 水分補給、体調不良、危険、つらさを強調しない。必要なら「過ごしやすい場所」程度に言い換える。
- 相手の発話に含まれない深刻なリスクを推測しない。`;

function safeVoice(value, fallback = 'marin') {
  const voice = String(value || fallback).trim().toLowerCase();
  if (!ALLOWED_VOICES.has(voice)) {
    throw new Error(`unsupported realtime voice: ${voice}`);
  }
  return voice;
}

function safeNoiseReduction(value, fallback = 'far_field') {
  const mode = String(value || fallback).trim().toLowerCase();
  if (!ALLOWED_NOISE_REDUCTION.has(mode)) {
    throw new Error(`unsupported realtime noise reduction: ${mode}`);
  }
  return mode;
}

function safeInstructions(value) {
  const base = String(value || process.env.REALTIME_INSTRUCTIONS || '').trim();
  const suffix = REALTIME_INSTRUCTION_SUFFIX;
  if (base.includes(suffix)) return base.slice(0, MAX_REALTIME_INSTRUCTIONS_CHARS);
  const separator = base ? '\n\n' : '';
  const maxBaseChars = Math.max(0, MAX_REALTIME_INSTRUCTIONS_CHARS - separator.length - suffix.length);
  return `${base.slice(0, maxBaseChars)}${separator}${suffix}`;
}

function buildRealtimeSession(body, deployment) {
  const voice = safeVoice(body.voice, process.env.REALTIME_VOICE || 'marin');
  const noiseReduction = safeNoiseReduction(body.noiseReduction, process.env.REALTIME_NOISE_REDUCTION || 'far_field');
  const transcriptionDeployment = safeDeployment(
    body.transcriptionDeployment,
    process.env.TRANSCRIPTION_DEPLOYMENT || 'gpt-4o-mini-transcribe'
  );
  const vadThreshold = clampNumber(body.vadThreshold, 0.65, 0.05, 0.95);
  const vadSilenceMs = clampNumber(body.vadSilenceMs, 500, 120, 1200);
  const instructions = safeInstructions(body.instructions);

  return {
    type: 'realtime',
    model: deployment,
    instructions,
    output_modalities: ['audio'],
    max_output_tokens: 'inf',
    audio: {
      input: {
        noise_reduction: noiseReduction === 'off' ? null : { type: noiseReduction },
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
          create_response: false,
          interrupt_response: true
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

async function realtimeTokenHandler(context, req) {
  try {
    requireInteractiveAccess(req);

    const endpoint = endpointBase();
    if (!endpoint) throw new Error('AZURE_OPENAI_ENDPOINT or AZURE_OPENAI_RESOURCE is not set');

    const body = parseJsonBody(req);
    const deployment = safeDeployment(body.realtimeDeployment, process.env.REALTIME_DEPLOYMENT || DEFAULT_REALTIME_DEPLOYMENT);
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
        max_output_tokens: session.max_output_tokens,
        turn_detection: session.audio.input.turn_detection,
        transcription: {
          model: session.audio.input.transcription.model,
          language: session.audio.input.transcription.language
        },
        noise_reduction: session.audio.input.noise_reduction,
        voice: session.audio.output.voice
      }
    });
  } catch (error) {
    errorResponse(context, error, 500);
  }
}

module.exports = realtimeTokenHandler;
module.exports._private = {
  DEFAULT_REALTIME_DEPLOYMENT,
  REALTIME_INSTRUCTION_SUFFIX,
  buildRealtimeSession,
  safeInstructions
};
