'use strict';

const {
  parseJsonBody,
  errorResponse,
  jsonResponse,
  chatCompletion,
  extractChatText,
  clampNumber,
  trimTranscriptByBudget,
  estimateMessageTokens
} = require('../_shared/azureOpenAI');

const DEFAULT_INSTRUCTIONS = `You are a real-time Japanese conversation coach. Return only JSON: {"label":"good|warn|risk","advice":"1-3 concise Japanese sentences","reason":"short Japanese reason"}. Prioritize speed and practical next steps.`;

module.exports = async function (context, req) {
  try {
    const body = parseJsonBody(req);
    const rawTranscript = Array.isArray(body.transcript) ? body.transcript : [];
    const transcript = trimTranscriptByBudget(body.transcript, {
      maxItems: 24,
      maxChars: 9000,
      maxTextChars: 1200,
      maxTokens: 6000
    });
    const latest = body.latest || transcript[transcript.length - 1] || {};
    const instructions = String(body.instructions || DEFAULT_INSTRUCTIONS).slice(0, 6000);
    const maxTokens = clampNumber(body.maxTokens, 1024, 64, 4096);

    const userPayload = {
      latest,
      task: 'Evaluate the latest user utterance for low-friction office small talk. Use the prior conversation for context. Keep it brief.'
    };
    const messages = [{ role: 'system', content: instructions }];
    for (const item of transcript) {
      messages.push({ role: item.role, content: item.text });
    }
    messages.push({ role: 'user', content: JSON.stringify(userPayload) });
    const estimatedInputTokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);

    const started = Date.now();
    const { data, deployment, usedFallback } = await chatCompletion({
      deployment: body.deployment || process.env.ADVISOR_DEPLOYMENT || 'gpt-5.4-nano',
      messages,
      maxTokens,
      temperature: 0.2,
      reasoningEffort: body.reasoningEffort || process.env.ADVISOR_REASONING_EFFORT || 'none',
      timeoutMs: 15000
    });

    const text = extractChatText(data).trim();
    let parsed = null;
    try {
      parsed = JSON.parse(text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim());
    } catch {
      parsed = { label: 'good', advice: text || '助言を生成できませんでした。', reason: '' };
    }

    const label = ['good', 'warn', 'risk'].includes(parsed.label) ? parsed.label : 'good';
    jsonResponse(context, {
      label,
      advice: String(parsed.advice || text || '').slice(0, 1200),
      reason: String(parsed.reason || '').slice(0, 1200),
      text,
      deployment,
      usedFallback,
      inputBudget: {
        rawTranscriptItems: rawTranscript.length,
        usedTranscriptItems: transcript.length,
        droppedTranscriptItems: Math.max(0, rawTranscript.length - transcript.length),
        estimatedInputTokens
      },
      latencyMs: Date.now() - started
    });
  } catch (error) {
    errorResponse(context, error, 500);
  }
};
