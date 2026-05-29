import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const authLogin = require('../api/auth-login');

function context() {
  return {
    log: {
      error() {}
    },
    res: null
  };
}

test('email login requires trial notice acceptance', async () => {
  const ctx = context();

  await authLogin(ctx, {
    body: {
      email: 'judge-demo@example.com',
      password: 'password'
    }
  });

  assert.equal(ctx.res.status, 400);
  assert.equal(ctx.res.body.code, 'trial_notice_required');
});
