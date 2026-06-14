// Decision funnel + recent decisions + LLM verdict mix over a time window.
import { roDb, hasTable } from '../db.js';
import { clampLimit, windowToMs } from '../config.js';

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

export function getFunnel(window = '24h') {
  const cutoff = Date.now() - windowToMs(window);

  const actions = hasTable('decision_logs')
    ? roDb
        .prepare('SELECT action, COUNT(*) AS count FROM decision_logs WHERE at_ms >= ? GROUP BY action ORDER BY count DESC')
        .all(cutoff)
        .map((r) => ({ action: r.action, count: num(r.count) }))
    : [];

  const verdicts = hasTable('llm_batches')
    ? roDb
        .prepare('SELECT verdict, COUNT(*) AS count, AVG(confidence) AS avg_confidence FROM llm_batches WHERE created_at_ms >= ? GROUP BY verdict')
        .all(cutoff)
        .map((r) => ({ verdict: r.verdict, count: num(r.count), avgConfidence: num(r.avg_confidence) }))
    : [];

  const candidatesSeen = hasTable('candidates')
    ? num(roDb.prepare('SELECT COUNT(*) AS c FROM candidates WHERE created_at_ms >= ?').get(cutoff)?.c)
    : 0;

  // Derive funnel stages from action counts.
  const actionMap = Object.fromEntries(actions.map((a) => [a.action, a.count]));
  const entries =
    num(actionMap.dry_run_entry) + num(actionMap.live_entry) + num(actionMap.confirm_intent);
  const llmBuys = verdicts.filter((v) => v.verdict === 'BUY').reduce((s, v) => s + v.count, 0);

  return {
    window,
    cutoffMs: cutoff,
    stages: [
      { label: 'Candidates', value: candidatesSeen },
      { label: 'LLM BUY', value: llmBuys },
      { label: 'Entries', value: entries },
    ],
    actions,
    verdicts,
  };
}

export function listDecisions({ limit, offset = 0 } = {}) {
  if (!hasTable('decision_logs')) return { rows: [], total: 0 };
  const lim = clampLimit(limit);
  const off = Math.max(0, Number(offset) || 0);
  const total = roDb.prepare('SELECT COUNT(*) AS c FROM decision_logs').get()?.c ?? 0;
  const rows = roDb
    .prepare(
      'SELECT at_ms, action, mode, selected_mint, verdict, confidence, reason FROM decision_logs ORDER BY at_ms DESC LIMIT ? OFFSET ?',
    )
    .all(lim, off)
    .map((r) => ({
      atMs: num(r.at_ms),
      action: r.action,
      mode: r.mode,
      selectedMint: r.selected_mint || null,
      verdict: r.verdict || null,
      confidence: r.confidence == null ? null : num(r.confidence),
      reason: r.reason ? String(r.reason).slice(0, 160) : null,
    }));
  return { rows, total: Number(total) };
}
