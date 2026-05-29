'use strict';

const { jsonResponse } = require('../_shared/azureOpenAI');
const { optionalAuthenticatedPrincipal, publicAccessState, isDeveloperPrincipal } = require('../_shared/appAuth');

module.exports = async function (context, req) {
  const clientPrincipal = optionalAuthenticatedPrincipal(req);
  jsonResponse(context, {
    clientPrincipal,
    publicAccess: publicAccessState(clientPrincipal),
    developerToolsEnabled: Boolean(clientPrincipal && isDeveloperPrincipal(clientPrincipal))
  });
};
