// Overview aggregate: agent state, today's risk metrics, provider health,
// LLM health. Every section degrades gracefully if its table is missing on
// the live (older) schema.
import { roDb, hasTable, hasColumn } from '../db.js';

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

function settingsMap() {
  if (!hasTable('settings')) return {};
  const rows = roDb.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function activeStrategy() {
  if (!hasTable('strategies')) return null;
  const row = roDb.prepare('SELECT id, name FROM strategies WHERE enabled = 1 LIMIT 1').get();
  return row || null;
}

function openPositionStats() {
  if (!hasTable('dry_run_positions')) return { open: 0, totalOpenSizeSol: 0 };
  const open = roDb
    .prepare("SELECT COUNT(*) AS c, COALESCE(SUM(size_sol), 0) AS s FROM dry_run_positions WHERE status = 'open'")
    .get();
  return { open: num(open?.c), totalOpenSizeSol: num(open?.s) };
}

function todayRiskMetrics() {
  if (!hasTable('daily_risk_metrics')) return null;
  // date column stored as 'YYYY-MM-DD' in local time by the agent. We match
  // the most recent row rather than computing today's string to avoid TZ skew.
  const row = roDb
    .prepare('SELECT * FROM daily_risk_metrics ORDER BY date DESC LIMIT 1')
    .get();
  if (!row) return null;
  return {
    date: row.date,
    trades: num(row.trades_count),
    wins: num(row.wins_count),
    losses: num(row.losses_count),
    totalPnlSol: num(row.total_pnl_sol),
    totalPnlPercent: num(row.total_pnl_percent),
    maxDrawdownPercent: num(row.max_drawdown_percent),
    lossStreak: num(row.loss_streak),
    maxLossStreak: num(row.max_loss_streak),
    dailyLossLimitTriggered: Boolean(row.daily_loss_limit_triggered),
  };
}

// Fallback when daily_risk_metrics is absent: derive today's PnL from closed
// positions in the last 24h.
function fallbackTodayPnl() {
  if (!hasTable('dry_run_positions')) return null;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const rows = roDb
    .prepare("SELECT pnl_percent, pnl_sol FROM dry_run_positions WHERE status = 'closed' AND closed_at_ms >= ?")
    .all(cutoff);
  if (!rows.length) return { trades: 0, wins: 0, losses: 0, totalPnlSol: 0, totalPnlPercent: 0, derived: true };
  const wins = rows.filter((r) => num(r.pnl_percent) > 0).length;
  return {
    trades: rows.length,
    wins,
    losses: rows.length - wins,
    totalPnlSol: rows.reduce((s, r) => s + num(r.pnl_sol), 0),
    totalPnlPercent: rows.reduce((s, r) => s + num(r.pnl_percent), 0),
    derived: true,
  };
}

function providerHealth() {
  if (!hasTable('provider_health')) return { available: false, providers: [] };
  const rows = roDb.prepare('SELECT * FROM provider_health ORDER BY provider').all();
  const providers = rows.map((r) => {
    const total = num(r.success_count) + num(r.failure_count);
    return {
      provider: r.provider,
      endpoint: r.endpoint || '(default)',
      status: r.status,
      successRate: total > 0 ? (num(r.success_count) / total) * 100 : null,
      avgLatencyMs: r.avg_latency_ms == null ? null : num(r.avg_latency_ms),
      lastError: r.last_error || null,
      degraded: r.status !== 'healthy',
    };
  });
  return { available: true, providers };
}

function llmHealth(settings) {
  const out = {
    lastBatchAtMs: null,
    lastVerdict: null,
    failStreak: null,
    alertThreshold: num(settings.llm_alert_fail_streak, 5),
    fallbackEnabled: settings.llm_fallback_enabled === 'true',
  };
  if (hasTable('llm_batches')) {
    const last = roDb.prepare('SELECT created_at_ms, verdict, confidence FROM llm_batches ORDER BY created_at_ms DESC LIMIT 1').get();
    if (last) {
      out.lastBatchAtMs = num(last.created_at_ms);
      out.lastVerdict = last.verdict;
      out.lastConfidence = num(last.confidence);
    }
    // Best-effort fail streak: count consecutive most-recent non-BUY/ERROR-ish
    // batches is not stored, so expose recent verdict mix instead.
    const recent = roDb.prepare('SELECT verdict FROM llm_batches ORDER BY created_at_ms DESC LIMIT 20').all();
    out.recentVerdicts = recent.map((r) => r.verdict);
  }
  return out;
}

export function getOverview() {
  const settings = settingsMap();
  const strategy = activeStrategy();
  const positions = openPositionStats();
  const today = todayRiskMetrics() || fallbackTodayPnl();

  return {
    agent: {
      enabled: settings.agent_enabled !== 'false',
      tradingMode: settings.trading_mode || 'dry_run',
      activeStrategyId: strategy?.id || null,
      activeStrategyName: strategy?.name || null,
      maxOpenPositions: num(settings.max_open_positions, 0),
      openPositions: positions.open,
      totalOpenSizeSol: positions.totalOpenSizeSol,
    },
    today,
    providerHealth: providerHealth(),
    llm: llmHealth(settings),
    serverTimeMs: Date.now(),
  };
}
