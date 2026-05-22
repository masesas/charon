import { db } from '../db/connection.js';
import { now } from '../utils.js';

const PROVIDER_NAMES = ['gmgn', 'jupiter', 'rpc', 'signal_server', 'telegram', 'llm'];

export function recordHealthSuccess(provider, endpoint, latencyMs) {
  const ts = now();
  const stmt = db.prepare(`
    INSERT INTO provider_health (provider, endpoint, status, success_count, last_success_at_ms, avg_latency_ms, updated_at_ms)
    VALUES (?, ?, 'healthy', 1, ?, ?, ?)
    ON CONFLICT(provider, endpoint) DO UPDATE SET
      status = 'healthy',
      success_count = success_count + 1,
      last_success_at_ms = ?,
      avg_latency_ms = CASE WHEN avg_latency_ms IS NULL THEN ? ELSE (avg_latency_ms * 0.8 + ? * 0.2) END,
      updated_at_ms = ?
  `);
  stmt.run(provider, endpoint || '', ts, latencyMs, ts, ts, latencyMs, latencyMs, ts);
}

export function recordHealthFailure(provider, endpoint, error) {
  const ts = now();
  const errorMsg = String(error?.message || error || 'Unknown error').slice(0, 500);
  const stmt = db.prepare(`
    INSERT INTO provider_health (provider, endpoint, status, failure_count, last_failure_at_ms, last_error, updated_at_ms)
    VALUES (?, ?, 'degraded', 1, ?, ?, ?)
    ON CONFLICT(provider, endpoint) DO UPDATE SET
      status = 'degraded',
      failure_count = failure_count + 1,
      last_failure_at_ms = ?,
      last_error = ?,
      updated_at_ms = ?
  `);
  stmt.run(provider, endpoint || '', ts, errorMsg, ts, ts, errorMsg, ts);
}

export function getProviderHealth(provider) {
  return db.prepare('SELECT * FROM provider_health WHERE provider = ?').get(provider);
}

export function getAllProviderHealth() {
  return db.prepare('SELECT * FROM provider_health ORDER BY provider, endpoint').all();
}

export function getDegradedProviders() {
  return db.prepare("SELECT * FROM provider_health WHERE status = 'degraded'").all();
}

export function isProviderHealthy(provider, options = {}) {
  const { minSuccessRate = 0.5, maxFailures = 5 } = options;
  const row = getProviderHealth(provider);
  if (!row) return true; // No data = assume healthy
  if (row.failure_count >= maxFailures) return false;
  const total = row.success_count + row.failure_count;
  if (total === 0) return true;
  return row.success_count / total >= minSuccessRate;
}

export function withHealthTracking(provider, endpoint, fn) {
  return async (...args) => {
    const start = now();
    try {
      const result = await fn(...args);
      const latency = now() - start;
      recordHealthSuccess(provider, endpoint, latency);
      return result;
    } catch (error) {
      recordHealthFailure(provider, endpoint, error);
      throw error;
    }
  };
}
