import { db } from './connection.js';
import { now } from '../utils.js';

/**
 * Update signal source performance when a position closes
 * Tracks success/failure, PnL, and time-to-close for each signal source
 */
export function updateSourcePerformanceOnClose(position, candidate) {
  if (!position || !candidate) return;

  const source = candidate.signals?.route || 'unknown';
  const signalType = candidate.signals?.label || 'unknown';
  const pnlPercent = Number(position.pnl_percent) || 0;
  const timeToCloseMs = (position.closed_at_ms || now()) - position.opened_at_ms;
  const isSuccess = pnlPercent > 0 ? 1 : 0;

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT * FROM signal_source_performance 
      WHERE source = ? AND signal_type = ?
    `).get(source, signalType);

    if (existing) {
      const newTotal = existing.total_signals + 1;
      const newSuccessful = existing.successful_signals + isSuccess;
      const newFailed = existing.failed_signals + (1 - isSuccess);
      const newAvgTimeMs = existing.avg_time_to_close_ms
        ? (existing.avg_time_to_close_ms * existing.total_signals + timeToCloseMs) / newTotal
        : timeToCloseMs;
      const newAvgPnl = existing.avg_pnl_percent
        ? (existing.avg_pnl_percent * existing.total_signals + pnlPercent) / newTotal
        : pnlPercent;
      const winRate = (newSuccessful / newTotal) * 100;

      db.prepare(`
        UPDATE signal_source_performance
        SET total_signals = ?,
            successful_signals = ?,
            failed_signals = ?,
            avg_time_to_close_ms = ?,
            avg_pnl_percent = ?,
            win_rate_percent = ?,
            last_signal_at_ms = ?,
            last_update_at_ms = ?
        WHERE source = ? AND signal_type = ?
      `).run(
        newTotal,
        newSuccessful,
        newFailed,
        newAvgTimeMs,
        newAvgPnl,
        winRate,
        position.opened_at_ms,
        now(),
        source,
        signalType
      );
    } else {
      db.prepare(`
        INSERT INTO signal_source_performance (
          source, signal_type, total_signals, successful_signals, failed_signals,
          avg_time_to_close_ms, avg_pnl_percent, win_rate_percent,
          last_signal_at_ms, last_update_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        source,
        signalType,
        1,
        isSuccess,
        1 - isSuccess,
        timeToCloseMs,
        pnlPercent,
        isSuccess * 100,
        position.opened_at_ms,
        now()
      );
    }
  })();
}

/**
 * Compute reliability score for a signal source (0-100)
 * Based on win rate, sample size, and consistency
 */
export function computeSourceReliabilityScore(source, signalType = null) {
  let query = `
    SELECT * FROM signal_source_performance 
    WHERE source = ?
  `;
  const params = [source];

  if (signalType) {
    query += ` AND signal_type = ?`;
    params.push(signalType);
  }

  const rows = db.prepare(query).all(...params);
  if (rows.length === 0) return 0;

  // Aggregate across all signal types for this source if not filtering by type
  let totalSignals = 0;
  let totalSuccessful = 0;
  let totalPnl = 0;
  let avgTimeMs = 0;

  for (const row of rows) {
    totalSignals += row.total_signals || 0;
    totalSuccessful += row.successful_signals || 0;
    totalPnl += (row.avg_pnl_percent || 0) * (row.total_signals || 1);
    avgTimeMs += (row.avg_time_to_close_ms || 0) * (row.total_signals || 1);
  }

  if (totalSignals === 0) return 0;

  const winRate = (totalSuccessful / totalSignals) * 100;
  const avgPnl = totalPnl / totalSignals;
  const avgTime = avgTimeMs / totalSignals;

  // Scoring formula:
  // - Win rate: 0-50 points (50% win rate = 25 points, 100% = 50 points)
  // - Average PnL: 0-30 points (5% avg PnL = 30 points, scales linearly)
  // - Sample size: 0-20 points (20+ signals = 20 points)
  // - Time consistency: 0-10 points (lower variance = higher score, but not heavily weighted)

  const winRateScore = Math.min(50, (winRate / 100) * 50);
  const pnlScore = Math.min(30, Math.max(0, (avgPnl / 5) * 30));
  const sampleScore = Math.min(20, (totalSignals / 20) * 20);

  // Time consistency: penalize if very slow (>1 hour) or very fast (<5 min)
  let timeScore = 10;
  if (avgTime > 3600000) timeScore = 5; // >1 hour
  else if (avgTime < 300000) timeScore = 7; // <5 min

  const totalScore = winRateScore + pnlScore + sampleScore + timeScore;
  return Math.round(Math.min(100, totalScore));
}

/**
 * Get all source performance stats
 */
export function getAllSourcePerformance() {
  return db.prepare(`
    SELECT * FROM signal_source_performance
    ORDER BY win_rate_percent DESC, total_signals DESC
  `).all();
}

/**
 * Get performance for a specific source
 */
export function getSourcePerformance(source) {
  return db.prepare(`
    SELECT * FROM signal_source_performance
    WHERE source = ?
    ORDER BY total_signals DESC
  `).all(source);
}
