'use strict';

const { jsonResponse } = require('../_shared/azureOpenAI');
const { optionalAuthenticatedPrincipal } = require('../_shared/appAuth');

module.exports = async function (context, req) {
  jsonResponse(context, {
    clientPrincipal: optionalAuthenticatedPrincipal(req)
  });
};
