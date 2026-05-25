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
const { authenticatedUser } = require('../_shared/appAuth');
const { hasLogStorageConfig } = require('../_shared/logStore');

module.exports = async function (context, req) {
  try {
    authenticatedUser(req);

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
      logStoreReady: hasLogStorageConfig(),
      logSessionsTable: process.env.ZATSUCOACH_LOG_SESSIONS_TABLE || 'ZatsucoachSessions',
      logItemsTable: process.env.ZATSUCOACH_LOG_ITEMS_TABLE || 'ZatsucoachItems',
      transcribeDiagnosticEnabled: String(process.env.ENABLE_TRANSCRIBE_DIAGNOSTIC || '').toLowerCase() === 'true',
      codeVersion: '2026-05-25-email-password-auth',
      node: process.version
    });
  } catch (error) {
    errorResponse(context, error, 500);
  }
};
