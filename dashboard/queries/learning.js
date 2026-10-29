// Latest learning run summary + active lessons + active-strategy snapshot.
import { roDb, hasTable } from '../db.js';

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

function safeParse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

// snake_case → camelCase, matching the dashboard's existing label style.
const toCamel = (key) => key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

// Curated keys render first (familiar order); any remaining config fields follow
// alphabetically so newly-tuned params (min_holders, trending_*, etc.) always show.
const PARAM_ORDER = [
  'entry_mode', 'min_source_count', 'min_mcap_usd', 'max_mcap_usd',
  'min_liquidity_usd', 'max_mcap_to_liq_ratio', 'min_holders',
  'max_top20_holder_percent', 'trending_min_volume_usd', 'trending_min_swaps',
  'trending_max_rug_ratio', 'trending_max_bundler_rate',
  'position_size_sol', 'max_open_positions', 'tp_percent', 'sl_percent',
  'trailing_enabled', 'trailing_percent', 'partial_tp', 'use_llm', 'llm_min_confidence',
];

// Build an ordered {camelKey: value} map from the full strategy config_json so the
// view (which iterates params dynamically) shows every parameter, not a subset.
function strategyParams(cfg) {
  const ordered = [
    ...PARAM_ORDER.filter((k) => k in cfg),
    ...Object.keys(cfg).filter((k) => !PARAM_ORDER.includes(k)).sort(),
  ];
  const params = {};
  for (const key of ordered) params[toCamel(key)] = cfg[key];
  return params;
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
        params: strategyParams(cfg),
      };
    }
  }

  return { latestRun, lessons, strategies, activeStrategy: active };
}
