'use strict';

const {
  parseJsonBody,
  errorResponse,
  jsonResponse,
  chatCompletion,
  extractChatText,
  clampNumber,
  buildChatMessages
} = require('../_shared/azureOpenAI');
const { authenticatedUser } = require('../_shared/appAuth');

module.exports = async function (context, req) {
  try {
    authenticatedUser(req);

    const body = parseJsonBody(req);
    const instructions = String(body.instructions || 'あなたは雑談練習用のアバターです。日本語で1文だけ返してください。').slice(0, 6000);
    const maxTokens = clampNumber(body.maxTokens, 2048, 512, 4096);
    const messages = buildChatMessages({
      instructions,
      transcript: body.transcript,
      maxItems: 80,
      maxChars: 18000,
      maxTextChars: 1200
    });

    const started = Date.now();
    const { data, deployment, usedFallback } = await chatCompletion({
      deployment: body.deployment || process.env.AVATAR_TEXT_DEPLOYMENT || process.env.ADVISOR_DEPLOYMENT || 'gpt-5.4-nano',
      messages,
      maxTokens,
      temperature: 0.65,
      reasoningEffort: body.reasoningEffort || 'none',
      timeoutMs: 20000
    });

    jsonResponse(context, {
      text: extractChatText(data).trim(),
      deployment,
      usedFallback,
      latencyMs: Date.now() - started
    });
  } catch (error) {
    errorResponse(context, error, 500);
  }
};
