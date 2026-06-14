// The only mutations the dashboard performs. Scoped by code discipline to:
//   - settings.agent_enabled        (pause/resume; agent hot-reads each loop)
//   - strategies.enabled            (switch active strategy; 5s-cached read)
//   - dashboard_commands            (enqueue force-close for the agent to run)
// Never imports execution/wallet/RPC code → crash isolation preserved.
import { roDb, rwDb, hasTable, ensureDashboardCommands } from '../db.js';

function readSetting(key, fallback = '') {
  if (!hasTable('settings')) return fallback;
  return roDb.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
}

/** Pause/resume the agent. Mirrors Telegram callbacks.js:51. */
export function toggleAgent(enabled) {
  rwDb
    .prepare(
      `INSERT INTO settings (key, value) VALUES ('agent_enabled', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(enabled ? 'true' : 'false');
  return { enabled: Boolean(enabled) };
}

/** Switch the active strategy. Mirrors settings.js setActiveStrategy(). */
export function setActiveStrategy(id) {
  if (!hasTable('strategies')) throw new Error('strategies table not present');
  const exists = roDb.prepare('SELECT 1 FROM strategies WHERE id = ?').get(id);
  if (!exists) throw new Error(`unknown strategy: ${id}`);
  const tx = rwDb.transaction((sid) => {
    rwDb.prepare('UPDATE strategies SET enabled = 0').run();
    rwDb.prepare('UPDATE strategies SET enabled = 1 WHERE id = ?').run(sid);
  });
  tx(id);
  return { activeStrategyId: id };
}

/**
 * Enqueue a force-close. The dashboard cannot sell (no wallet/RPC); the agent
 * drains this queue on its position-monitor tick and runs the real close.
 * Returns the queued command id; the UI polls getCommand(id) for status.
 */
export function enqueueForceClose(positionId) {
  ensureDashboardCommands();
  if (!hasTable('dry_run_positions')) throw new Error('positions table not present');
  const pos = roDb.prepare('SELECT status FROM dry_run_positions WHERE id = ?').get(positionId);
  if (!pos) throw new Error('position not found');
  if (pos.status !== 'open') throw new Error('position is not open');

  // Avoid duplicate pending commands for the same position.
  const existing = rwDb
    .prepare("SELECT id FROM dashboard_commands WHERE kind = 'force_close' AND status IN ('pending','picked') AND payload_json LIKE ?")
    .get(`%"positionId":${Number(positionId)}%`);
  if (existing) return { commandId: existing.id, deduped: true };

  const info = rwDb
    .prepare(
      `INSERT INTO dashboard_commands (created_at_ms, kind, payload_json, status)
       VALUES (?, 'force_close', ?, 'pending')`,
    )
    .run(Date.now(), JSON.stringify({ positionId: Number(positionId), reason: 'DASHBOARD' }));
  return { commandId: info.lastInsertRowid, deduped: false };
}

export function getCommand(id) {
  if (!hasTable('dashboard_commands')) return null;
  const row = roDb.prepare('SELECT * FROM dashboard_commands WHERE id = ?').get(id);
  if (!row) return null;
  let result = null;
  try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch { result = null; }
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    createdAtMs: row.created_at_ms,
    completedAtMs: row.completed_at_ms,
    result,
  };
}
