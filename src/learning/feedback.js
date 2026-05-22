import { bot } from '../telegram/bot.js';
import { escapeHtml, fmtPct } from '../format.js';
import { db } from '../db/connection.js';
import { now, json } from '../utils.js';
import { strategyById, allStrategies, updateStrategyConfig } from '../db/settings.js';
import { logConfigChange } from '../db/configChanges.js';

/**
 * Apply a lesson to a strategy by modifying strategy config based on lesson text.
 * Usage: /apply_lesson <lesson_id> <strategy_id> <key> <value>
 */
export async function applyLesson(chatId, text) {
  const parts = text.split(/\s+/);
  // /apply_lesson <lesson_id> <strategy_id> <key> <value>
  const [, lessonIdStr, strategyId, key, ...rest] = parts;
  const value = rest.join(' ');

  if (!lessonIdStr || !strategyId || !key || !value) {
    return bot.sendMessage(chatId, [
      '📝 <b>Apply Lesson to Strategy</b>',
      '',
      'Usage: <code>/apply_lesson &lt;lesson_id&gt; &lt;strategy_id&gt; &lt;key&gt; &lt;value&gt;</code>',
      '',
      'Example: <code>/apply_lesson 5 sniper min_mcap_usd 10000</code>',
      '',
      'This modifies a strategy config key based on a learning lesson,',
      'logs the config change, and tracks the lesson application.',
      '',
      'Use <code>/lessons</code> to see active lesson IDs.',
      'Use <code>/strategy</code> to see strategy IDs and current config.',
    ].join('\n'), { parse_mode: 'HTML' });
  }

  const lessonId = Number(lessonIdStr);
  if (!Number.isFinite(lessonId) || lessonId <= 0) {
    return bot.sendMessage(chatId, '❌ Invalid lesson ID.');
  }

  // Verify lesson exists
  const lesson = db.prepare('SELECT * FROM learning_lessons WHERE id = ?').get(lessonId);
  if (!lesson) {
    return bot.sendMessage(chatId, `❌ Lesson #${lessonId} not found.`);
  }

  // Verify strategy exists
  const strat = strategyById(strategyId);
  if (!strat) {
    return bot.sendMessage(chatId, `❌ Strategy "${escapeHtml(strategyId)}" not found.`, { parse_mode: 'HTML' });
  }

  // Determine value type
  const numKeys = new Set([
    'tp_percent', 'sl_percent', 'position_size_sol', 'max_open_positions',
    'min_mcap_usd', 'max_mcap_usd', 'min_holders', 'max_top20_holder_percent',
    'trailing_percent', 'partial_tp_at_percent', 'partial_tp_sell_percent',
    'max_hold_ms', 'llm_min_confidence', 'min_source_count',
    'min_fee_claim_sol', 'min_gmgn_total_fee_sol', 'max_ath_distance_pct',
    'token_age_max_ms', 'trending_min_volume_usd', 'trending_min_swaps',
    'trending_max_rug_ratio', 'trending_max_bundler_rate',
    'min_saved_wallet_holders', 'min_graduated_volume_usd',
  ]);
  const boolKeys = new Set(['trailing_enabled', 'partial_tp', 'use_llm', 'require_fee_claim']);

  const oldValue = strat[key];
  const newConfig = { ...strat };
  delete newConfig.id;
  delete newConfig.name;

  if (numKeys.has(key)) {
    newConfig[key] = Number(value);
  } else if (boolKeys.has(key)) {
    newConfig[key] = value === 'true' || value === '1' || value === 'yes';
  } else {
    newConfig[key] = value;
  }

  // Apply the config change
  updateStrategyConfig(strategyId, newConfig);

  // Log the config change linked to lesson
  logConfigChange(strategyId, key, oldValue, newConfig[key], lessonId, lesson.lesson, 'apply_lesson');

  // Track which strategies lesson was applied to
  const existingApplied = lesson.applied_to_strategies ? JSON.parse(lesson.applied_to_strategies) : [];
  if (!existingApplied.includes(strategyId)) {
    existingApplied.push(strategyId);
    db.prepare('UPDATE learning_lessons SET applied_to_strategies = ? WHERE id = ?')
      .run(json(existingApplied), lessonId);
  }

  // Schedule 7-day performance review
  scheduleLessonReview(lessonId, strategyId);

  return bot.sendMessage(chatId, [
    '✅ <b>Lesson Applied</b>',
    '',
    `Lesson: #${lessonId}`,
    `Strategy: <b>${escapeHtml(strategyId)}</b>`,
    `Changed: <code>${escapeHtml(key)}</code>`,
    `Old: <code>${oldValue ?? 'unset'}</code> → New: <code>${newConfig[key]}</code>`,
    '',
    `📌 ${escapeHtml(lesson.lesson.slice(0, 200))}`,
    '',
    'A 7-day performance check has been scheduled.',
    `Use <code>/lesson_results ${lessonId}</code> to check later.`,
  ].join('\n'), { parse_mode: 'HTML' });
}

/**
 * Show lesson application results — config changes + performance since applying.
 * Usage: /lesson_results [lesson_id]
 */
export async function lessonResults(chatId, text) {
  const parts = text.split(/\s+/);
  const lessonIdStr = parts[1];

  if (!lessonIdStr) {
    // Show all applied lessons summary
    const applied = db.prepare(`
      SELECT l.*, COUNT(c.id) AS change_count
      FROM learning_lessons l
      LEFT JOIN config_changes c ON c.lesson_id = l.id
      WHERE l.applied_to_strategies IS NOT NULL
      GROUP BY l.id
      ORDER BY l.id DESC
      LIMIT 20
    `).all();

    if (!applied.length) {
      return bot.sendMessage(chatId, '📊 No lessons have been applied yet. Use <code>/apply_lesson</code> to apply one.', { parse_mode: 'HTML' });
    }

    const lines = ['📊 <b>Applied Lessons</b>', ''];
    for (const row of applied) {
      const strategies = row.applied_to_strategies ? JSON.parse(row.applied_to_strategies) : [];
      const age = Math.floor((now() - row.created_at_ms) / 86400000);
      lines.push(`#${row.id} (${age}d ago) → ${strategies.join(', ')} [${row.change_count} changes]`);
      lines.push(`  ${escapeHtml(row.lesson.slice(0, 100))}`);
      lines.push('');
    }
    lines.push('Use <code>/lesson_results &lt;id&gt;</code> for details.');
    return bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
  }

  const lessonId = Number(lessonIdStr);
  const lesson = db.prepare('SELECT * FROM learning_lessons WHERE id = ?').get(lessonId);
  if (!lesson) {
    return bot.sendMessage(chatId, `❌ Lesson #${lessonId} not found.`);
  }

  // Get config changes for this lesson
  const changes = db.prepare('SELECT * FROM config_changes WHERE lesson_id = ? ORDER BY at_ms').all(lessonId);
  const strategies = lesson.applied_to_strategies ? JSON.parse(lesson.applied_to_strategies) : [];

  // Performance since lesson was applied (positions opened after earliest config change)
  const earliestChange = changes.length ? Math.min(...changes.map(c => c.at_ms)) : lesson.created_at_ms;
  const positions = db.prepare(`
    SELECT * FROM dry_run_positions
    WHERE opened_at_ms >= ? AND status = 'closed'
      AND strategy_id IN (${strategies.map(() => '?').join(',') || "''"})
    ORDER BY closed_at_ms DESC
  `).all(earliestChange, ...strategies);

  const wins = positions.filter(p => Number(p.pnl_percent || 0) > 0).length;
  const losses = positions.filter(p => Number(p.pnl_percent || 0) < 0).length;
  const totalPnl = positions.reduce((s, p) => s + Number(p.pnl_sol || 0), 0);
  const avgPnl = positions.length ? positions.reduce((s, p) => s + Number(p.pnl_percent || 0), 0) / positions.length : 0;
  const daysSince = Math.floor((now() - earliestChange) / 86400000);

  const lines = [
    '📊 <b>Lesson Results</b>',
    '',
    `Lesson #${lessonId}: ${escapeHtml(lesson.lesson.slice(0, 200))}`,
    `Status: <b>${lesson.status}</b>`,
    `Applied to: ${strategies.join(', ') || 'none'}`,
    `Days since: ${daysSince}`,
    '',
    '<b>Config Changes</b>',
  ];

  if (changes.length) {
    for (const c of changes) {
      lines.push(`• ${escapeHtml(c.strategy_id)}.${escapeHtml(c.key)}: ${c.old_value ?? '—'} → ${c.new_value}`);
    }
  } else {
    lines.push('No config changes recorded.');
  }

  lines.push('');
  lines.push('<b>Performance Since Applied</b>');
  if (positions.length) {
    lines.push(`Closed: ${positions.length} (${wins}W / ${losses}L)`);
    lines.push(`Win rate: ${fmtPct(positions.length ? wins / positions.length * 100 : 0)}`);
    lines.push(`Avg PnL: ${fmtPct(avgPnl)}`);
    lines.push(`Total PnL: ${totalPnl.toFixed(4)} SOL`);
  } else {
    lines.push('No closed positions since lesson was applied.');
  }

  // Check for scheduled performance review
  const review = db.prepare(`
    SELECT * FROM lesson_performance_reviews
    WHERE lesson_id = ?
    ORDER BY scheduled_at_ms DESC
    LIMIT 1
  `).all(lessonId).catch?.(() => []);

  return bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
}

/**
 * Schedule a 7-day performance review for a lesson application.
 */
export function scheduleLessonReview(lessonId, strategyId) {
  const reviewAtMs = now() + 7 * 24 * 60 * 60 * 1000; // 7 days from now
  db.prepare(`
    INSERT INTO lesson_performance_reviews (lesson_id, strategy_id, scheduled_at_ms, status, created_at_ms)
    VALUES (?, ?, ?, 'pending', ?)
  `).run(lessonId, strategyId, reviewAtMs, now());
}

/**
 * Check and execute pending lesson performance reviews.
 * Called from the main loop or a cron-like interval.
 */
export async function checkPendingReviews(chatId) {
  const pending = db.prepare(`
    SELECT * FROM lesson_performance_reviews
    WHERE status = 'pending' AND scheduled_at_ms <= ?
  `).all(now());

  if (!pending.length) return;

  for (const review of pending) {
    const lesson = db.prepare('SELECT * FROM learning_lessons WHERE id = ?').get(review.lesson_id);
    if (!lesson) {
      db.prepare('UPDATE lesson_performance_reviews SET status = ? WHERE id = ?').run('skipped', review.id);
      continue;
    }

    const changes = db.prepare('SELECT * FROM config_changes WHERE lesson_id = ? ORDER BY at_ms').all(review.lesson_id);
    const earliestChange = changes.length ? Math.min(...changes.map(c => c.at_ms)) : lesson.created_at_ms;

    const positions = db.prepare(`
      SELECT * FROM dry_run_positions
      WHERE opened_at_ms >= ? AND status = 'closed' AND strategy_id = ?
    `).all(earliestChange, review.strategy_id);

    const wins = positions.filter(p => Number(p.pnl_percent || 0) > 0).length;
    const losses = positions.filter(p => Number(p.pnl_percent || 0) < 0).length;
    const totalPnl = positions.reduce((s, p) => s + Number(p.pnl_sol || 0), 0);
    const avgPnl = positions.length ? positions.reduce((s, p) => s + Number(p.pnl_percent || 0), 0) / positions.length : 0;
    const winRate = positions.length ? wins / positions.length * 100 : 0;

    const resultJson = json({
      positions_count: positions.length,
      wins,
      losses,
      win_rate: winRate,
      avg_pnl_percent: avgPnl,
      total_pnl_sol: totalPnl,
    });

    db.prepare('UPDATE lesson_performance_reviews SET status = ?, completed_at_ms = ?, result_json = ? WHERE id = ?')
      .run('completed', now(), resultJson, review.id);

    if (chatId) {
      const verdict = avgPnl > 0 ? '✅ Positive' : avgPnl < 0 ? '❌ Negative' : '➖ Neutral';
      await bot.sendMessage(chatId, [
        `📊 <b>7-Day Lesson Review</b>`,
        '',
        `Lesson #${review.lesson_id}: ${escapeHtml(lesson.lesson.slice(0, 150))}`,
        `Strategy: <b>${review.strategy_id}</b>`,
        '',
        `Positions: ${positions.length} (${wins}W / ${losses}L)`,
        `Win rate: ${fmtPct(winRate)}`,
        `Avg PnL: ${fmtPct(avgPnl)}`,
        `Total PnL: ${totalPnl.toFixed(4)} SOL`,
        '',
        `Verdict: ${verdict}`,
        avgPnl < -5 ? '⚠️ Consider reverting changes.' : '',
      ].filter(Boolean).join('\n'), { parse_mode: 'HTML' });
    }
  }
}
