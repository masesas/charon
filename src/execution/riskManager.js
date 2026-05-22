import { db } from '../db/connection.js';
import { now } from '../utils.js';
import {
  RISK_MAX_DAILY_LOSS_SOL,
  RISK_MAX_LOSS_STREAK,
  RISK_MAX_POSITION_SIZE_PERCENT,
  RISK_MAX_TOTAL_EXPOSURE_SOL,
} from '../config.js';

/**
 * Get today's date in YYYY-MM-DD format
 */
function getTodayDate() {
  const d = new Date();
  return d.toISOString().split('T')[0];
}

/**
 * Get or create today's daily_risk_metrics record
 */
export function getTodayMetrics() {
  const date = getTodayDate();
  let metrics = db.prepare('SELECT * FROM daily_risk_metrics WHERE date = ?').get(date);
  
  if (!metrics) {
    const ts = now();
    db.prepare(`
      INSERT INTO daily_risk_metrics (
        date, trades_count, wins_count, losses_count,
        total_pnl_sol, total_pnl_percent, max_drawdown_percent,
        loss_streak, max_loss_streak, daily_loss_limit_sol,
        daily_loss_limit_triggered, created_at_ms, updated_at_ms
      ) VALUES (?, 0, 0, 0, 0, 0, 0, 0, 0, ?, 0, ?, ?)
    `).run(date, RISK_MAX_DAILY_LOSS_SOL, ts, ts);
    
    metrics = db.prepare('SELECT * FROM daily_risk_metrics WHERE date = ?').get(date);
  }
  
  return metrics;
}

/**
 * Update daily metrics when a position closes
 */
export function updateDailyMetricsOnClose(position) {
  if (!position.pnl_sol) return;
  
  const metrics = getTodayMetrics();
  const isPnlPositive = position.pnl_sol > 0;
  const newWins = metrics.wins_count + (isPnlPositive ? 1 : 0);
  const newLosses = metrics.losses_count + (isPnlPositive ? 0 : 1);
  const newLossStreak = isPnlPositive ? 0 : metrics.loss_streak + 1;
  const newMaxLossStreak = Math.max(metrics.max_loss_streak, newLossStreak);
  const newTotalPnl = metrics.total_pnl_sol + position.pnl_sol;
  
  db.prepare(`
    UPDATE daily_risk_metrics SET
      trades_count = ?,
      wins_count = ?,
      losses_count = ?,
      total_pnl_sol = ?,
      loss_streak = ?,
      max_loss_streak = ?,
      updated_at_ms = ?
    WHERE date = ?
  `).run(
    metrics.trades_count + 1,
    newWins,
    newLosses,
    newTotalPnl,
    newLossStreak,
    newMaxLossStreak,
    now(),
    getTodayDate()
  );
}

/**
 * Check if daily loss limit has been exceeded
 */
export function isDailyLossLimitExceeded() {
  const metrics = getTodayMetrics();
  return metrics.total_pnl_sol <= -RISK_MAX_DAILY_LOSS_SOL;
}

/**
 * Check if loss streak limit has been exceeded
 */
export function isLossStreakExceeded() {
  const metrics = getTodayMetrics();
  return metrics.loss_streak >= RISK_MAX_LOSS_STREAK;
}

/**
 * Get total exposure (sum of all open position sizes in SOL)
 */
export function getTotalExposureSol() {
  const result = db.prepare(`
    SELECT COALESCE(SUM(size_sol), 0) as total
    FROM dry_run_positions
    WHERE status = 'open'
  `).get();
  return result?.total || 0;
}

/**
 * Check if adding a new position would exceed total exposure limit
 */
export function wouldExceedTotalExposure(newPositionSizeSol) {
  const current = getTotalExposureSol();
  return (current + newPositionSizeSol) > RISK_MAX_TOTAL_EXPOSURE_SOL;
}

/**
 * Comprehensive risk check before allowing a buy
 * Returns { allowed: boolean, reason?: string }
 */
export function checkRiskBeforeBuy(positionSizeSol) {
  // Check 1: Daily loss limit
  if (isDailyLossLimitExceeded()) {
    return {
      allowed: false,
      reason: `Daily loss limit exceeded (${RISK_MAX_DAILY_LOSS_SOL} SOL). No more trades today.`,
    };
  }

  // Check 2: Loss streak
  if (isLossStreakExceeded()) {
    const metrics = getTodayMetrics();
    return {
      allowed: false,
      reason: `Loss streak limit exceeded (${metrics.loss_streak}/${RISK_MAX_LOSS_STREAK}). Pause trading.`,
    };
  }

  // Check 3: Total exposure
  if (wouldExceedTotalExposure(positionSizeSol)) {
    const current = getTotalExposureSol();
    return {
      allowed: false,
      reason: `Total exposure would exceed limit (${current.toFixed(3)} + ${positionSizeSol.toFixed(3)} > ${RISK_MAX_TOTAL_EXPOSURE_SOL} SOL).`,
    };
  }

  return { allowed: true };
}

/**
 * Mark daily loss limit as triggered (for Telegram alerts)
 */
export function markDailyLossLimitTriggered() {
  const date = getTodayDate();
  db.prepare(`
    UPDATE daily_risk_metrics SET
      daily_loss_limit_triggered = 1,
      updated_at_ms = ?
    WHERE date = ?
  `).run(now(), date);
}

/**
 * Get risk status summary for /risk_status command
 */
export function getRiskStatus() {
  const metrics = getTodayMetrics();
  const totalExposure = getTotalExposureSol();
  
  return {
    date: metrics.date,
    trades_count: metrics.trades_count,
    wins_count: metrics.wins_count,
    losses_count: metrics.losses_count,
    win_rate_percent: metrics.trades_count > 0 
      ? Math.round((metrics.wins_count / metrics.trades_count) * 100)
      : 0,
    total_pnl_sol: metrics.total_pnl_sol,
    loss_streak: metrics.loss_streak,
    max_loss_streak: metrics.max_loss_streak,
    daily_loss_limit_sol: RISK_MAX_DAILY_LOSS_SOL,
    daily_loss_limit_remaining_sol: Math.max(0, RISK_MAX_DAILY_LOSS_SOL + metrics.total_pnl_sol),
    daily_loss_limit_triggered: metrics.daily_loss_limit_triggered === 1,
    loss_streak_limit: RISK_MAX_LOSS_STREAK,
    total_exposure_sol: totalExposure,
    total_exposure_limit_sol: RISK_MAX_TOTAL_EXPOSURE_SOL,
    exposure_remaining_sol: Math.max(0, RISK_MAX_TOTAL_EXPOSURE_SOL - totalExposure),
  };
}
