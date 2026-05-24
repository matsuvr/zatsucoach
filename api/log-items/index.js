'use strict';

const {
  errorResponse,
  jsonResponse,
  parseJsonBody
} = require('../_shared/azureOpenAI');
const {
  HttpError,
  authenticatedUser,
  sessionsClient,
  itemsClient,
  safeSessionId,
  itemPartitionKey,
  odataString,
  patchSessionEntity,
  normalizeItems,
  normalizeLogItem,
  itemDto
} = require('../_shared/logStore');

module.exports = async function (context, req) {
  try {
    const user = authenticatedUser(req);
    const method = String(req.method || 'GET').toUpperCase();

    if (method === 'GET') {
      return await listItems(context, req, user);
    }
    if (method === 'POST') {
      return await saveItems(context, req, user);
    }

    jsonResponse(context, { error: 'method not allowed' }, 405);
  } catch (error) {
    errorResponse(context, error, error?.status || 500);
  }
};

async function listItems(context, req, user) {
  if (!req.query?.sessionId) throw new HttpError(400, 'sessionId is required');
  const sessionId = safeSessionId(req.query.sessionId);
  const client = await itemsClient();
  const partitionKey = itemPartitionKey(user, sessionId);
  const filter = `PartitionKey eq '${odataString(partitionKey)}'`;
  const items = [];

  for await (const entity of client.listEntities({ queryOptions: { filter } })) {
    items.push(itemDto(entity));
    if (items.length >= 1000) break;
  }

  items.sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0) || String(a.id).localeCompare(String(b.id)));
  jsonResponse(context, { sessionId, items });
}

async function saveItems(context, req, user) {
  const body = parseJsonBody(req);
  if (!body.sessionId) throw new HttpError(400, 'sessionId is required');
  const sessionId = safeSessionId(body.sessionId);
  const rawItems = normalizeItems(body);
  const client = await itemsClient();
  const entities = rawItems
    .map((item, index) => normalizeLogItem(user, sessionId, item, index))
    .filter((item) => item.text);

  for (const entity of entities) {
    await client.upsertEntity(entity, 'Merge');
  }

  if (body.summary && typeof body.summary === 'object') {
    const sessionClient = await sessionsClient();
    await sessionClient.upsertEntity(patchSessionEntity(user, {
      sessionId,
      ...body.summary
    }), 'Merge');
  }

  jsonResponse(context, { sessionId, saved: entities.length });
}
