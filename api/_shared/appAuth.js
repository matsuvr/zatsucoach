'use strict';

const crypto = require('crypto');

const SESSION_COOKIE_NAME = 'zatsucoach_auth';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const DEFAULT_DEMO_EMAIL = 'demo2026@catkawaii.com';
const DEFAULT_DEVELOPER_EMAILS = [
  'developer@example.com'
];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function authenticatedUser(req) {
  const principal = authenticatedPrincipal(req);
  const provider = cleanText(principal.identityProvider || 'aad', 40);
  const userId = cleanText(principal.userId || '', 240);
  if (!userId) throw new HttpError(401, 'authenticated user id is missing');

  const userDetails = cleanText(principal.userDetails || '', 320);
  return {
    provider,
    userId,
    userDetails,
    isDeveloper: isDeveloperPrincipal(principal),
    principal,
    safeUserId: crypto
      .createHash('sha256')
      .update(`${provider}:${userId}`)
      .digest('hex')
  };
}

function authenticatedPrincipal(req) {
  const swaPrincipal = swaAuthenticatedPrincipal(req);
  if (swaPrincipal) return swaPrincipal;

  const sessionPrincipal = sessionAuthenticatedPrincipal(req);
  if (sessionPrincipal) return sessionPrincipal;

  throw new HttpError(401, 'authentication required');
}

function optionalAuthenticatedPrincipal(req) {
  try {
    return authenticatedPrincipal(req);
  } catch (error) {
    if (error?.status === 401) return null;
    throw error;
  }
}

function requireDeveloperUser(req) {
  const user = authenticatedUser(req);
  if (!user.isDeveloper) throw new HttpError(403, 'developer account required');
  return user;
}

function swaAuthenticatedPrincipal(req) {
  const raw = header(req, 'x-ms-client-principal');
  if (!raw) return null;

  let principal = null;
  try {
    principal = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    throw new HttpError(401, 'invalid authentication principal');
  }

  const roles = Array.isArray(principal.userRoles) ? principal.userRoles : [];
  return roles.includes('authenticated') ? principal : null;
}

function sessionAuthenticatedPrincipal(req) {
  const token = cookies(req)[SESSION_COOKIE_NAME];
  if (!token) return null;

  const payload = verifySessionToken(token);
  if (!payload) return null;

  const email = normalizeEmail(payload.email);
  if (!email || payload.provider !== 'password') return null;

  return passwordPrincipal(email, payload.sub || email);
}

function passwordPrincipal(email, sub = email) {
  const normalizedEmail = normalizeEmail(email);
  return {
    identityProvider: 'password',
    userId: cleanText(sub, 240) || stablePasswordUserId(normalizedEmail),
    userDetails: normalizedEmail,
    userRoles: ['anonymous', 'authenticated'],
    claims: [
      { typ: 'email', val: normalizedEmail },
      { typ: 'preferred_username', val: normalizedEmail }
    ]
  };
}

function demoEmail() {
  return normalizeEmail(process.env.ZATSUCOACH_DEMO_EMAIL || DEFAULT_DEMO_EMAIL);
}

function verifyDemoCredentials(email, password) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || normalizedEmail !== demoEmail()) return false;
  return verifyPasswordHash(password, process.env.ZATSUCOACH_DEMO_PASSWORD_HASH || '');
}

function createSessionCookie(req, email) {
  const normalizedEmail = normalizeEmail(email);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    provider: 'password',
    sub: stablePasswordUserId(normalizedEmail),
    email: normalizedEmail,
    iat: now,
    exp: now + SESSION_MAX_AGE_SECONDS
  };
  return cookieHeader(req, SESSION_COOKIE_NAME, signPayload(payload), SESSION_MAX_AGE_SECONDS);
}

function clearSessionCookie(req) {
  return cookieHeader(req, SESSION_COOKIE_NAME, '', 0);
}

function signPayload(payload) {
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = hmac(encoded);
  return `${encoded}.${signature}`;
}

function verifySessionToken(token) {
  const [encoded, signature, extra] = String(token || '').split('.');
  if (!encoded || !signature || extra !== undefined) return null;
  const expected = hmac(encoded);
  if (!constantTimeEqual(signature, expected)) return null;

  let payload = null;
  try {
    payload = JSON.parse(base64UrlDecode(encoded).toString('utf8'));
  } catch {
    return null;
  }
  const exp = Number(payload?.exp || 0);
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function hmac(value) {
  const secret = authSecret();
  return base64UrlEncode(crypto.createHmac('sha256', secret).update(value).digest());
}

function authSecret() {
  const secret = String(process.env.ZATSUCOACH_AUTH_SECRET || '').trim();
  if (secret.length < 32) throw new HttpError(500, 'ZATSUCOACH_AUTH_SECRET must be at least 32 characters');
  return secret;
}

function verifyPasswordHash(password, encodedHash) {
  const parts = String(encodedHash || '').split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false;

  const iterations = Number(parts[2]);
  if (!Number.isSafeInteger(iterations) || iterations < 100000) return false;

  const salt = Buffer.from(parts[3], 'base64url');
  const expected = Buffer.from(parts[4], 'base64url');
  if (!salt.length || !expected.length) return false;

  const actual = crypto.pbkdf2Sync(String(password || ''), salt, iterations, expected.length, 'sha256');
  return crypto.timingSafeEqual(actual, expected);
}

function developerEmails() {
  const configured = String(process.env.ZATSUCOACH_DEVELOPER_EMAILS || '')
    .split(',')
    .map(normalizeEmail)
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_DEVELOPER_EMAILS;
}

function isDeveloperPrincipal(principal) {
  const allowed = new Set(developerEmails());
  return principalIdentityValues(principal).some((value) => allowed.has(value));
}

function principalIdentityValues(principal) {
  const values = [
    principal?.userDetails,
    claimValue(principal, 'email'),
    claimValue(principal, 'emailaddress'),
    claimValue(principal, 'emails'),
    claimValue(principal, 'preferred_username'),
    claimValue(principal, 'upn'),
    claimValue(principal, 'unique_name')
  ];
  return values
    .flatMap(expandIdentityValue)
    .map(normalizeEmail)
    .filter(Boolean);
}

function expandIdentityValue(value) {
  if (Array.isArray(value)) return value.flatMap(expandIdentityValue);
  const text = String(value || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.flatMap(expandIdentityValue);
  } catch {
    // Not JSON; split common multi-value claim formats below.
  }
  return text.split(/[;,]/);
}

function claimValue(principal, name) {
  const claims = Array.isArray(principal?.claims) ? principal.claims : [];
  const match = claims.find((claim) => {
    const type = String(claim.typ || claim.type || claim.name || '').toLowerCase();
    return type === name || type.endsWith(`/${name}`);
  });
  return match?.val || match?.value || '';
}

function header(req, name) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(req.headers || {})) {
    if (String(key).toLowerCase() === target) return Array.isArray(value) ? value[0] : value;
  }
  return '';
}

function cookies(req) {
  const raw = header(req, 'cookie');
  const parsed = {};
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) parsed[key] = decodeURIComponent(value);
  }
  return parsed;
}

function cookieHeader(req, name, value, maxAgeSeconds) {
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`
  ];
  if (isSecureRequest(req)) attrs.push('Secure');
  return attrs.join('; ');
}

function isSecureRequest(req) {
  const proto = header(req, 'x-forwarded-proto').toLowerCase();
  const host = header(req, 'host').toLowerCase();
  return proto === 'https' || (!host.startsWith('localhost') && !host.startsWith('127.0.0.1'));
}

function stablePasswordUserId(email) {
  return crypto.createHash('sha256').update(`password:${normalizeEmail(email)}`).digest('hex');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function cleanText(value, maxChars) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(String(value || ''), 'base64url');
}

module.exports = {
  HttpError,
  authenticatedUser,
  authenticatedPrincipal,
  optionalAuthenticatedPrincipal,
  requireDeveloperUser,
  createSessionCookie,
  clearSessionCookie,
  demoEmail,
  verifyDemoCredentials
};
