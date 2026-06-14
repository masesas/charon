// Single shared-token auth. Accepts the token via Authorization: Bearer header
// (programmatic) or an HttpOnly cookie set by the login page (browser). No
// session store — the cookie IS the token. Constant-time comparison + a simple
// in-memory rate limit on failed attempts.
import { timingSafeEqual, createHash } from 'crypto';
import { DASHBOARD_TOKEN } from './config.js';

const COOKIE_NAME = 'charon_dash';

// Pre-hash the expected token once so timingSafeEqual always compares equal-
// length buffers regardless of the supplied value.
const expectedHash = createHash('sha256').update(DASHBOARD_TOKEN).digest();

function tokenMatches(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const candidateHash = createHash('sha256').update(candidate).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

// ── Rate limiting (per remote address) ──────────────────────────────────────
const attempts = new Map(); // ip -> { count, resetAt }
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 60_000;

export function rateLimited(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now > rec.resetAt) {
    attempts.set(ip, { count: 0, resetAt: now + WINDOW_MS });
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

export function recordFailure(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { count: 0, resetAt: now + WINDOW_MS };
  rec.count += 1;
  attempts.set(ip, rec);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/** Extract a candidate token from the request (header first, then cookie). */
export function extractToken(req) {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookies = parseCookies(req.headers['cookie']);
  return cookies[COOKIE_NAME] || null;
}

export function isAuthed(req) {
  return tokenMatches(extractToken(req));
}

/** Set-Cookie value for a successful login. Secure + HttpOnly + SameSite=Strict. */
export function loginCookie(token) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`;
}

export function logoutCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

export { tokenMatches };
