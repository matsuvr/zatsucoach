'use strict';

const {
  errorResponse,
  jsonResponse,
  parseJsonBody
} = require('../_shared/azureOpenAI');
const {
  diagnosticsClient,
  normalizeDiagnosticEvents
} = require('../_shared/logStore');
const { requireLogWriteAccess } = require('../_shared/appAuth');

module.exports = async function (context, req) {
  try {
    if (String(req.method || '').toUpperCase() !== 'POST') {
      return jsonResponse(context, { error: 'method not allowed' }, 405);
    }

    const user = requireLogWriteAccess(req);
    const body = parseJsonBody(req);
    const events = normalizeDiagnosticEvents(user, body);
    const client = await diagnosticsClient();

    for (const event of events) {
      await client.upsertEntity(event, 'Merge');
    }

    jsonResponse(context, { saved: events.length });
  } catch (error) {
    errorResponse(context, error, error?.status || 500);
  }
};
