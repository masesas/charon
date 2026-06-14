// Latest learning run summary + active lessons + active-strategy snapshot.
import { roDb, hasTable } from '../db.js';

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

function safeParse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export function getLearning() {
  let latestRun = null;
  if (hasTable('learning_runs')) {
    const row = roDb.prepare('SELECT * FROM learning_runs ORDER BY created_at_ms DESC LIMIT 1').get();
    if (row) {
      latestRun = {
        id: row.id,
        createdAtMs: num(row.created_at_ms),
        windowMs: num(row.window_ms),
        summary: safeParse(row.summary_json, {}),
      };
    }
  }

  let lessons = [];
  if (hasTable('learning_lessons')) {
    lessons = roDb
      .prepare("SELECT id, created_at_ms, lesson, status FROM learning_lessons WHERE status = 'active' ORDER BY created_at_ms DESC LIMIT 50")
      .all()
      .map((r) => ({ id: r.id, createdAtMs: num(r.created_at_ms), lesson: r.lesson, status: r.status }));
  }

  let strategies = [];
  let active = null;
  if (hasTable('strategies')) {
    const rows = roDb.prepare('SELECT id, name, enabled, config_json FROM strategies ORDER BY id').all();
    strategies = rows.map((r) => ({ id: r.id, name: r.name, enabled: Boolean(r.enabled) }));
    const activeRow = rows.find((r) => r.enabled);
    if (activeRow) {
      const cfg = safeParse(activeRow.config_json, {});
      active = {
        id: activeRow.id,
        name: activeRow.name,
        params: {
          entryMode: cfg.entry_mode,
          minSourceCount: cfg.min_source_count,
          minMcapUsd: cfg.min_mcap_usd,
          maxMcapUsd: cfg.max_mcap_usd,
          positionSizeSol: cfg.position_size_sol,
          maxOpenPositions: cfg.max_open_positions,
          tpPercent: cfg.tp_percent,
          slPercent: cfg.sl_percent,
          trailingEnabled: cfg.trailing_enabled,
          trailingPercent: cfg.trailing_percent,
          useLlm: cfg.use_llm,
          llmMinConfidence: cfg.llm_min_confidence,
        },
      };
    }
  }

  return { latestRun, lessons, strategies, activeStrategy: active };
}
