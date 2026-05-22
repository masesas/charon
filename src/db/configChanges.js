import { db } from './connection.js';
import { now } from '../utils.js';

export function initConfigChanges() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS config_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at_ms INTEGER NOT NULL,
      strategy_id TEXT NOT NULL,
      change_type TEXT NOT NULL,
      key TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      lesson_id INTEGER,
      reason TEXT,
      created_by TEXT DEFAULT 'system'
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_config_changes_strategy ON config_changes(strategy_id, at_ms)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_config_changes_lesson ON config_changes(lesson_id)');
}

export function logConfigChange(strategyId, key, oldValue, newValue, lessonId = null, reason = null, createdBy = 'system') {
  db.prepare(`
    INSERT INTO config_changes (at_ms, strategy_id, change_type, key, old_value, new_value, lesson_id, reason, created_by)
    VALUES (?, ?, 'update', ?, ?, ?, ?, ?, ?)
  `).run(now(), strategyId, key, oldValue ? String(oldValue) : null, newValue ? String(newValue) : null, lessonId, reason, createdBy);
  return db.prepare('SELECT last_insert_rowid() as id').get().id;
}

export function configChangesByLesson(lessonId) {
  return db.prepare('SELECT * FROM config_changes WHERE lesson_id = ? ORDER BY at_ms').all(lessonId);
}

export function recentConfigChanges(limit = 50) {
  return db.prepare('SELECT * FROM config_changes ORDER BY at_ms DESC LIMIT ?').all(limit);
}
