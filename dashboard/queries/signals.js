// Signal volume bucketed by hour, split by source, plus source-performance
// table. signal_events has 700k+ rows — queries are always time-bounded and
// aggregated in SQL (never row-streamed to the client).
import { roDb, hasTable } from '../db.js';
import { windowToMs } from '../config.js';

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const HOUR_MS = 60 * 60 * 1000;

export function getSignalVolume(window = '24h') {
  if (!hasTable('signal_events')) {
    return { window, buckets: [], sources: [] };
  }
  const cutoff = Date.now() - windowToMs(window);

  // Bucket by hour (integer division on at_ms) and group by source — all in SQL.
  const rows = roDb
    .prepare(
      `SELECT (at_ms / ${HOUR_MS}) AS bucket, source, COUNT(*) AS count
       FROM signal_events
       WHERE at_ms >= ?
       GROUP BY bucket, source
       ORDER BY bucket ASC`,
    )
    .all(cutoff);

  const sources = [...new Set(rows.map((r) => r.source))].sort();
  const bucketMap = new Map();
  for (const r of rows) {
    const ms = num(r.bucket) * HOUR_MS;
    if (!bucketMap.has(ms)) bucketMap.set(ms, { atMs: ms });
    bucketMap.get(ms)[r.source] = num(r.count);
  }
  const buckets = [...bucketMap.values()].map((b) => {
    for (const s of sources) if (b[s] === undefined) b[s] = 0;
    return b;
  });

  return { window, buckets, sources };
}

export function getSourcePerformance() {
  if (!hasTable('signal_source_performance')) {
    return { available: false, rows: [] };
  }
  const rows = roDb
    .prepare('SELECT * FROM signal_source_performance ORDER BY win_rate_percent DESC, total_signals DESC')
    .all()
    .map((r) => ({
      source: r.source,
      signalType: r.signal_type,
      total: num(r.total_signals),
      successful: num(r.successful_signals),
      failed: num(r.failed_signals),
      winRatePercent: r.win_rate_percent == null ? null : num(r.win_rate_percent),
      avgPnlPercent: r.avg_pnl_percent == null ? null : num(r.avg_pnl_percent),
      lastSignalAtMs: r.last_signal_at_ms == null ? null : num(r.last_signal_at_ms),
    }));
  return { available: true, rows };
}
