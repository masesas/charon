// Dashboard configuration. Reads from the same .env the agent uses.
import dotenv from 'dotenv';

dotenv.config();

export const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 3000);
// Bind loopback by default so the process is unreachable except via the
// Cloudflare Tunnel / reverse proxy, even if a container port leaks.
export const DASHBOARD_HOST = process.env.DASHBOARD_HOST || '127.0.0.1';
export const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || '';

// List/pagination guards. signal_events has 700k+ rows — never full-scan.
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 200;

// UI poll cadence (ms) for the auto-refreshing Overview.
export const POLL_INTERVAL_MS = 5000;

export function validateDashboardConfig() {
  if (!DASHBOARD_TOKEN || DASHBOARD_TOKEN.length < 16) {
    throw new Error(
      'DASHBOARD_TOKEN is required and must be at least 16 characters. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
}

/** Clamp a requested limit into [1, MAX_LIMIT]. */
export function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)));
}

/** Window string → milliseconds. */
export function windowToMs(window) {
  switch (window) {
    case '1h': return 60 * 60 * 1000;
    case '7d': return 7 * 24 * 60 * 60 * 1000;
    case '24h':
    default: return 24 * 60 * 60 * 1000;
  }
}
