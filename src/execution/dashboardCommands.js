// Drains commands enqueued by the read-only dashboard. The dashboard has no
// wallet/RPC and cannot sell, so it inserts a `force_close` row here; this
// runs inside the trading process where the real close path lives.
//
// Ordering guard against a crash mid-execute: mark a row `picked` BEFORE doing
// the close so it is never re-run on the next tick. A `picked` row that never
// completed is surfaced as `failed` (never auto-retried — a half-executed sell
// must be inspected, not blindly repeated).
import { db } from '../db/connection.js';
import { now, safeJson, json } from '../utils.js';
import { closePosition } from '../telegram/commands.js';
import { TELEGRAM_CHAT_ID } from '../config.js';

const PICKED_STALE_MS = 2 * 60 * 1000;

export async function drainDashboardCommands() {
  // Table may not exist yet if the dashboard never ran; tolerate that.
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dashboard_commands'").get();
  if (!exists) return;

  // Fail any stale `picked` rows (crashed mid-execute) — do not retry.
  db.prepare(
    "UPDATE dashboard_commands SET status='failed', completed_at_ms=?, result_json=? WHERE status='picked' AND picked_at_ms < ?",
  ).run(now(), json({ error: 'stale picked command failed without completion' }), now() - PICKED_STALE_MS);

  const pending = db
    .prepare("SELECT * FROM dashboard_commands WHERE status='pending' ORDER BY created_at_ms ASC LIMIT 10")
    .all();

  for (const cmd of pending) {
    // Atomically claim it.
    const claim = db
      .prepare("UPDATE dashboard_commands SET status='picked', picked_at_ms=? WHERE id=? AND status='pending'")
      .run(now(), cmd.id);
    if (claim.changes === 0) continue; // someone else (shouldn't happen — single drainer)

    const payload = safeJson(cmd.payload_json, {});
    try {
      if (cmd.kind === 'force_close') {
        await handleForceClose(payload);
        markDone(cmd.id, { ok: true });
      } else {
        markRejected(cmd.id, `unknown command kind: ${cmd.kind}`);
      }
    } catch (err) {
      markFailed(cmd.id, err.message);
    }
  }
}

async function handleForceClose(payload) {
  const positionId = Number(payload.positionId);
  if (!Number.isFinite(positionId)) throw new Error('invalid positionId');
  const row = db.prepare('SELECT status FROM dry_run_positions WHERE id = ?').get(positionId);
  if (!row) throw new Error('position not found');
  if (row.status !== 'open') throw new Error('position is not open');
  // Reuse the exact Telegram close path (handles dry-run slippage + live sell +
  // daily metrics + the sell-in-progress guard against the monitor).
  await closePosition(TELEGRAM_CHAT_ID, positionId, payload.reason || 'DASHBOARD');
}

function markDone(id, result) {
  db.prepare("UPDATE dashboard_commands SET status='done', completed_at_ms=?, result_json=? WHERE id=?")
    .run(now(), json(result), id);
}
function markFailed(id, message) {
  db.prepare("UPDATE dashboard_commands SET status='failed', completed_at_ms=?, result_json=? WHERE id=?")
    .run(now(), json({ error: message }), id);
}
function markRejected(id, message) {
  db.prepare("UPDATE dashboard_commands SET status='rejected', completed_at_ms=?, result_json=? WHERE id=?")
    .run(now(), json({ error: message }), id);
}
