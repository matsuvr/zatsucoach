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
  sessionEntity,
  patchSessionEntity,
  sessionDto
} = require('../_shared/logStore');

module.exports = async function (context, req) {
  try {
    const user = authenticatedUser(req);
    const method = String(req.method || 'GET').toUpperCase();

    if (method === 'GET') {
      return await listSessions(context, req, user);
    }
    if (method === 'POST') {
      return await createSession(context, req, user);
    }
    if (method === 'PATCH') {
      return await updateSession(context, req, user);
    }
    if (method === 'DELETE') {
      return await deleteSession(context, req, user);
    }

    jsonResponse(context, { error: 'method not allowed' }, 405);
  } catch (error) {
    errorResponse(context, error, error?.status || 500);
  }
};

async function listSessions(context, req, user) {
  const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 20));
  const client = await sessionsClient();
  const filter = `PartitionKey eq '${odataString(user.safeUserId)}'`;
  const sessions = [];

  for await (const entity of client.listEntities({ queryOptions: { filter } })) {
    sessions.push(sessionDto(entity));
    if (sessions.length >= 250) break;
  }

  sessions.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  jsonResponse(context, { sessions: sessions.slice(0, limit) });
}

async function createSession(context, req, user) {
  const body = parseJsonBody(req);
  const sessionId = safeSessionId(body.sessionId);
  const entity = sessionEntity(user, body, sessionId);
  const client = await sessionsClient();
  await client.upsertEntity(entity, 'Merge');
  jsonResponse(context, { session: sessionDto(entity), sessionId });
}

async function updateSession(context, req, user) {
  const body = parseJsonBody(req);
  const entity = patchSessionEntity(user, body);
  const client = await sessionsClient();
  await client.upsertEntity(entity, 'Merge');
  jsonResponse(context, { session: sessionDto(entity), sessionId: entity.rowKey });
}

async function deleteSession(context, req, user) {
  const body = parseJsonBody(req);
  const rawSessionId = req.query?.sessionId || body.sessionId;
  if (!rawSessionId) throw new HttpError(400, 'sessionId is required');
  const sessionId = safeSessionId(rawSessionId);
  const sessions = await sessionsClient();
  const items = await itemsClient();
  const partitionKey = itemPartitionKey(user, sessionId);
  const filter = `PartitionKey eq '${odataString(partitionKey)}'`;

  let deletedItems = 0;
  for await (const entity of items.listEntities({ queryOptions: { filter } })) {
    try {
      await items.deleteEntity(entity.partitionKey, entity.rowKey);
      deletedItems += 1;
    } catch (error) {
      if (error.statusCode !== 404) throw error;
    }
  }

  try {
    await sessions.deleteEntity(user.safeUserId, sessionId);
  } catch (error) {
    if (error.statusCode !== 404) throw error;
  }

  jsonResponse(context, { sessionId, deletedItems });
}
