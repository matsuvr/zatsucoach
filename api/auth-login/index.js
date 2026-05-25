'use strict';

const {
  parseJsonBody,
  errorResponse
} = require('../_shared/azureOpenAI');
const {
  HttpError,
  createSessionCookie,
  demoEmail,
  verifyDemoCredentials
} = require('../_shared/appAuth');

module.exports = async function (context, req) {
  try {
    const body = parseJsonBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (!email || !password) throw new HttpError(400, 'email and password are required');
    if (!verifyDemoCredentials(email, password)) throw new HttpError(401, 'invalid email or password');

    context.res = {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': createSessionCookie(req, email)
      },
      body: {
        clientPrincipal: {
          identityProvider: 'password',
          userDetails: demoEmail(),
          userRoles: ['anonymous', 'authenticated']
        }
      }
    };
  } catch (error) {
    errorResponse(context, error, 500);
  }
};
