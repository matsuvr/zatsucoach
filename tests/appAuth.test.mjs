import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  PUBLIC_PERIOD_ENDED_MESSAGE,
  canUseInteractiveFeatures,
  publicAccessState,
  requireInteractiveAccess,
  requireLogWriteAccess
} = require('../api/_shared/appAuth');

const beforeEnd = Date.parse('2026-06-09T14:59:59Z');
const afterEnd = Date.parse('2026-06-09T15:00:00Z');

function principal(overrides = {}) {
  const email = overrides.email || 'guest@example.com';
  return {
    identityProvider: overrides.identityProvider || 'aad',
    userId: overrides.userId || `uid-${email}`,
    userDetails: email,
    userRoles: ['anonymous', 'authenticated'],
    claims: [
      { typ: 'email', val: email },
      { typ: 'preferred_username', val: email }
    ]
  };
}

function reqForPrincipal(clientPrincipal) {
  return {
    headers: {
      'x-ms-client-principal': Buffer.from(JSON.stringify(clientPrincipal)).toString('base64')
    }
  };
}

function withAccessEnd(value, fn) {
  const previous = process.env.ZATSUCOACH_PUBLIC_ACCESS_ENDS_AT;
  process.env.ZATSUCOACH_PUBLIC_ACCESS_ENDS_AT = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.ZATSUCOACH_PUBLIC_ACCESS_ENDS_AT;
    } else {
      process.env.ZATSUCOACH_PUBLIC_ACCESS_ENDS_AT = previous;
    }
  }
}

function withDemoEmail(value, fn) {
  const previous = process.env.ZATSUCOACH_DEMO_EMAIL;
  process.env.ZATSUCOACH_DEMO_EMAIL = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.ZATSUCOACH_DEMO_EMAIL;
    } else {
      process.env.ZATSUCOACH_DEMO_EMAIL = previous;
    }
  }
}

test('public access ends at June 10 2026 JST for ordinary users', () => {
  withAccessEnd('2026-06-10T00:00:00+09:00', () => {
    const guest = principal();

    assert.equal(canUseInteractiveFeatures(guest, beforeEnd), true);
    assert.equal(canUseInteractiveFeatures(guest, afterEnd), false);
    assert.deepEqual(publicAccessState(guest, afterEnd), {
      ended: true,
      exempt: false,
      canUseInteractiveFeatures: false,
      logAccess: 'read-only',
      message: PUBLIC_PERIOD_ENDED_MESSAGE
    });
  });
});

test('developer Microsoft account remains exempt after public access ends', () => {
  withAccessEnd('2026-06-10T00:00:00+09:00', () => {
    const developer = principal({ email: 'developer@example.com', identityProvider: 'aad' });

    assert.equal(canUseInteractiveFeatures(developer, afterEnd), true);
    assert.deepEqual(publicAccessState(developer, afterEnd), {
      ended: true,
      exempt: true,
      canUseInteractiveFeatures: true,
      logAccess: 'read-write',
      message: ''
    });
  });
});

test('developer email is not exempt after public access ends without Microsoft provider', () => {
  withAccessEnd('2026-06-10T00:00:00+09:00', () => {
    const developerViaPassword = principal({ email: 'developer@example.com', identityProvider: 'password' });

    assert.equal(canUseInteractiveFeatures(developerViaPassword, afterEnd), false);
  });
});

test('demo Email/Password account remains exempt after public access ends', () => {
  withDemoEmail('judge-demo@example.com', () => withAccessEnd('2026-06-10T00:00:00+09:00', () => {
    const demo = principal({ email: 'judge-demo@example.com', identityProvider: 'password' });

    assert.equal(canUseInteractiveFeatures(demo, afterEnd), true);
  }));
});

test('demo email is not exempt when it comes from Microsoft login', () => {
  withDemoEmail('judge-demo@example.com', () => withAccessEnd('2026-06-10T00:00:00+09:00', () => {
    const demoViaMicrosoft = principal({ email: 'judge-demo@example.com', identityProvider: 'aad' });

    assert.equal(canUseInteractiveFeatures(demoViaMicrosoft, afterEnd), false);
  }));
});

test('interactive and log write guards reject ordinary users after public access ends', () => {
  withAccessEnd('2020-01-01T00:00:00Z', () => {
    const req = reqForPrincipal(principal());

    assert.throws(
      () => requireInteractiveAccess(req),
      (error) => error.status === 403 && error.code === 'public_period_ended' && error.message === PUBLIC_PERIOD_ENDED_MESSAGE
    );
    assert.throws(
      () => requireLogWriteAccess(req),
      (error) => error.status === 403 && error.code === 'public_period_ended' && error.message === PUBLIC_PERIOD_ENDED_MESSAGE
    );
  });
});
