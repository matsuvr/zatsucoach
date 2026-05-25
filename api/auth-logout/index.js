'use strict';

const { clearSessionCookie } = require('../_shared/appAuth');

module.exports = async function (context, req) {
  const redirect = String(req.query?.redirect || '/login');
  const safeRedirect = redirect.startsWith('/') ? redirect : '/login';
  context.res = {
    status: 302,
    headers: {
      'Set-Cookie': clearSessionCookie(req),
      Location: `/.auth/logout?post_logout_redirect_uri=${encodeURIComponent(safeRedirect)}`
    }
  };
};
