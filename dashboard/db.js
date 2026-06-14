// Dashboard data layer.
//
// Two handles against the SAME SQLite file the trading agent uses (WAL mode):
//   - roDb: readonly. All analytics/list queries go here. A bug here can never
//     corrupt or destructively lock the trading data.
//   - rwDb: read-write, but by code discipline ONLY touches `settings`,
//     `strategies`, and `dashboard_commands`. Never execution/wallet/RPC.
//
// The live DB may run an OLDER schema than src/db/connection.js defines (e.g.
// no `tier` column, no `daily_risk_metrics` table). The dashboard opens
// readonly and CANNOT migrate, so every query must degrade gracefully. The
// hasTable/hasColumn helpers below make that explicit at call sites.

import Database from 'better-sqlite3';
import { DB_PATH } from '../src/config.js';

export const roDb = new Database(DB_PATH, { readonly: true, fileMustExist: true });
roDb.pragma('busy_timeout = 5000');

export const rwDb = new Database(DB_PATH);
rwDb.pragma('busy_timeout = 5000');

// ── Schema introspection (cached — schema does not change within a process) ──

const tableCache = new Map();
const columnCache = new Map();

/** @param {string} name @returns {boolean} */
export function hasTable(name) {
  if (tableCache.has(name)) return tableCache.get(name);
  const row = roDb
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
  const exists = Boolean(row);
  tableCache.set(name, exists);
  return exists;
}

/** @param {string} table @param {string} column @returns {boolean} */
export function hasColumn(table, column) {
  const key = `${table}.${column}`;
  if (columnCache.has(key)) return columnCache.get(key);
  if (!hasTable(table)) {
    columnCache.set(key, false);
    return false;
  }
  const cols = roDb.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
  const exists = cols.includes(column);
  columnCache.set(key, exists);
  return exists;
}

/**
 * The dashboard's own command queue table. Created here only as a fallback so
 * the dashboard works even if it boots before the agent has migrated. The
 * canonical definition lives in src/db/connection.js (agent side).
 */
export function ensureDashboardCommands() {
  rwDb.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      picked_at_ms INTEGER,
      completed_at_ms INTEGER,
      result_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dashboard_commands_status
      ON dashboard_commands(status, created_at_ms);
  `);
}

export function closeDb() {
  try { roDb.close(); } catch { /* ignore */ }
  try { rwDb.close(); } catch { /* ignore */ }
}
