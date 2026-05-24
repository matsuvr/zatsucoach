'use strict';

const {
  endpointBase,
  advisorEndpointBase,
  hasConfig,
  hasAdvisorConfig,
  advisorApiKey,
  advisorDeployment,
  advisorEndpointRoute,
  jsonResponse,
  errorResponse
} = require('../_shared/azureOpenAI');

module.exports = async function (context) {
  try {
    const endpoint = endpointBase();
    const advisorEndpoint = advisorEndpointBase();
    jsonResponse(context, {
      ready: hasConfig(),
      endpointHost: endpoint ? new URL(endpoint).host : null,
      hasApiKey: Boolean(process.env.AZURE_OPENAI_API_KEY),
      realtimeDeployment: process.env.REALTIME_DEPLOYMENT || null,
      advisorDeployment: process.env.ADVISOR_DEPLOYMENT ? advisorDeployment(process.env.ADVISOR_DEPLOYMENT) : null,
      advisorRoute: advisorEndpointRoute(),
      advisorReady: hasAdvisorConfig(),
      advisorEndpointHost: advisorEndpoint ? new URL(advisorEndpoint).host : null,
      hasAdvisorApiKey: Boolean(advisorApiKey()),
      avatarTextDeployment: process.env.AVATAR_TEXT_DEPLOYMENT || null,
      transcribeDiagnosticEnabled: String(process.env.ENABLE_TRANSCRIBE_DIAGNOSTIC || '').toLowerCase() === 'true',
      codeVersion: '2026-05-24-realtime-manual-vad-noise-gate',
      node: process.version
    });
  } catch (error) {
    errorResponse(context, error, 500);
  }
};
