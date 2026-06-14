// Positions: open & closed lists (paginated) and per-position detail with a
// price/mcap sparkline series. Tolerant of older schema (no `tier`,
// no `position_price_snapshots`).
import { roDb, hasTable, hasColumn } from '../db.js';
import { clampLimit } from '../config.js';

const num = (v, fallback = null) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

function snapshotCandidate(position) {
  try {
    const parsed = JSON.parse(position.snapshot_json || '{}');
    return parsed?.candidate || {};
  } catch {
    return {};
  }
}

function route(position) {
  const c = snapshotCandidate(position);
  return c.signals?.route || c.signals?.label || 'unknown';
}

function mapPosition(row) {
  const hasTier = hasColumn('dry_run_positions', 'tier');
  return {
    id: row.id,
    mint: row.mint,
    symbol: row.symbol || null,
    status: row.status,
    tier: hasTier ? row.tier || null : null,
    executionMode: row.execution_mode || 'dry_run',
    sizeSol: num(row.size_sol, 0),
    entryMcap: num(row.entry_mcap),
    exitMcap: num(row.exit_mcap),
    highWaterMcap: num(row.high_water_mcap),
    tpPercent: num(row.tp_percent),
    slPercent: num(row.sl_percent),
    trailingEnabled: Boolean(row.trailing_enabled),
    trailingArmed: Boolean(row.trailing_armed),
    pnlPercent: num(row.pnl_percent),
    pnlSol: num(row.pnl_sol),
    exitReason: row.exit_reason || null,
    openedAtMs: num(row.opened_at_ms),
    closedAtMs: num(row.closed_at_ms),
    route: route(row),
  };
}

export function listPositions({ status = 'open', limit, offset = 0 } = {}) {
  if (!hasTable('dry_run_positions')) return { rows: [], total: 0 };
  const lim = clampLimit(limit);
  const off = Math.max(0, Number(offset) || 0);
  const where = status === 'all' ? '' : 'WHERE status = ?';
  const params = status === 'all' ? [] : [status];
  const orderCol = status === 'closed' ? 'closed_at_ms' : 'opened_at_ms';

  const total = roDb
    .prepare(`SELECT COUNT(*) AS c FROM dry_run_positions ${where}`)
    .get(...params)?.c ?? 0;
  const rows = roDb
    .prepare(`SELECT * FROM dry_run_positions ${where} ORDER BY ${orderCol} DESC LIMIT ? OFFSET ?`)
    .all(...params, lim, off);

  return { rows: rows.map(mapPosition), total: Number(total) };
}

export function getPosition(id) {
  if (!hasTable('dry_run_positions')) return null;
  const row = roDb.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row) return null;
  const position = mapPosition(row);

  // Price/mcap series for the sparkline, if snapshots exist on this schema.
  let series = [];
  if (hasTable('position_price_snapshots')) {
    const snaps = roDb
      .prepare(
        'SELECT snapshot_at_ms, price_usd, market_cap_usd FROM position_price_snapshots WHERE position_id = ? ORDER BY snapshot_at_ms ASC LIMIT 500',
      )
      .all(id);
    series = snaps.map((s) => ({
      atMs: num(s.snapshot_at_ms),
      priceUsd: num(s.price_usd),
      mcapUsd: num(s.market_cap_usd),
    }));
  }

  // Trades for this position (entries/exits).
  let trades = [];
  if (hasTable('dry_run_trades')) {
    trades = roDb
      .prepare('SELECT side, at_ms, price, mcap, size_sol, reason FROM dry_run_trades WHERE position_id = ? ORDER BY at_ms ASC')
      .all(id)
      .map((t) => ({
        side: t.side,
        atMs: num(t.at_ms),
        price: num(t.price),
        mcap: num(t.mcap),
        sizeSol: num(t.size_sol),
        reason: t.reason || null,
      }));
  }

  return { ...position, series, trades };
}
