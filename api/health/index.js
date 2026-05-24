'use strict';

const { endpointBase, hasConfig, jsonResponse, errorResponse } = require('../_shared/azureOpenAI');

module.exports = async function (context) {
  try {
    const endpoint = endpointBase();
    jsonResponse(context, {
      ready: hasConfig(),
      endpointHost: endpoint ? new URL(endpoint).host : null,
      hasApiKey: Boolean(process.env.AZURE_OPENAI_API_KEY),
      realtimeDeployment: process.env.REALTIME_DEPLOYMENT || null,
      advisorDeployment: process.env.ADVISOR_DEPLOYMENT || null,
      avatarTextDeployment: process.env.AVATAR_TEXT_DEPLOYMENT || null,
      transcribeDiagnosticEnabled: String(process.env.ENABLE_TRANSCRIBE_DIAGNOSTIC || '').toLowerCase() === 'true',
      node: process.version
    });
  } catch (error) {
    errorResponse(context, error, 500);
  }
};
