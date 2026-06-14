// Learning-knob readiness report — READ ONLY. Writes nothing.
// Run: DB_PATH=data/charon.db node scripts/learning-readiness.mjs
//
// Reports whether enough clean data exists to activate each learning knob
// (risk_gate, sizing_modifier, source_reliability). See handoff/learning-knobs.md.
import Database from 'better-sqlite3';

const dbPath = process.env.DB_PATH || 'data/charon.db';
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

function tableExists(name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function columnExists(table, col) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === col); }
  catch { return false; }
}
function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * s.length)));
  return s[idx];
}
function fmt(n, d = 1) { return n == null ? 'n/a' : Number(n).toFixed(d); }

console.log(`\n=== Learning-knob readiness (${dbPath}) ===\n`);

// ── Closed positions ────────────────────────────────────────────────────────
const closed = tableExists('dry_run_positions')
  ? db.prepare("SELECT * FROM dry_run_positions WHERE status='closed' AND pnl_percent IS NOT NULL").all()
  : [];
const withPnl = closed.filter(p => Number.isFinite(Number(p.pnl_percent)));
const wins = withPnl.filter(p => Number(p.pnl_percent) > 0);
const losses = withPnl.filter(p => Number(p.pnl_percent) <= 0);

console.log('[Global]');
console.log(`  closed positions with PnL: ${withPnl.length}`);
console.log(`  wins / losses: ${wins.length} / ${losses.length}`);
console.log(`  win-rate: ${withPnl.length ? fmt((wins.length / withPnl.length) * 100) + '%' : 'n/a'}`);
const GLOBAL_MIN = 30;
const globalReady = withPnl.length >= GLOBAL_MIN;
console.log(`  -> ${globalReady ? 'OK' : 'NOT READY'} (need >= ${GLOBAL_MIN} for score-based knobs)\n`);

// Extract scores from snapshot_json where present.
function scoresOf(p) {
  if (!p.snapshot_json) return null;
  let snap; try { snap = JSON.parse(p.snapshot_json); } catch { return null; }
  const s = snap?.candidate?.scores;
  if (!s) return null;
  const risk = Number(s.risk_score), quality = Number(s.quality_score);
  return { risk: Number.isFinite(risk) ? risk : null, quality: Number.isFinite(quality) ? quality : null };
}
const scored = withPnl.map(p => ({ p, s: scoresOf(p) })).filter(x => x.s);
const scoredWins = scored.filter(x => Number(x.p.pnl_percent) > 0);
const scoredLosses = scored.filter(x => Number(x.p.pnl_percent) <= 0);

// ── Knob 1: risk_gate ────────────────────────────────────────────────────────
console.log('[Knob 1: risk_gate_enabled / risk_score_max_gate]');
console.log(`  positions carrying risk_score: ${scored.filter(x => x.s.risk != null).length} / ${withPnl.length}`);
if (scoredLosses.length && scoredWins.length) {
  const lossRisk = scoredLosses.map(x => x.s.risk).filter(Number.isFinite);
  const winRisk = scoredWins.map(x => x.s.risk).filter(Number.isFinite);
  console.log(`  risk_score losses  p50/p75: ${fmt(pct(lossRisk, 50))} / ${fmt(pct(lossRisk, 75))}`);
  console.log(`  risk_score wins    p50/p75: ${fmt(pct(winRisk, 50))} / ${fmt(pct(winRisk, 75))}`);
  console.log(`  suggested initial risk_score_max_gate ~ p75(losses) = ${fmt(pct(lossRisk, 75))}`);
} else {
  console.log('  insufficient scored win/loss split to suggest a gate.');
}
console.log(`  -> ${globalReady && scored.length >= GLOBAL_MIN ? 'READY to calibrate' : 'NOT READY (need >=30 scored closed positions)'}\n`);

// ── Knob 2: sizing_modifier ──────────────────────────────────────────────────
console.log('[Knob 2: sizing_modifier_enabled]');
if (scoredWins.length && scoredLosses.length) {
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const winQ = avg(scoredWins.map(x => x.s.quality).filter(Number.isFinite));
  const lossQ = avg(scoredLosses.map(x => x.s.quality).filter(Number.isFinite));
  console.log(`  avg quality_score  wins / losses: ${fmt(winQ)} / ${fmt(lossQ)}`);
  const predictive = winQ != null && lossQ != null && winQ > lossQ;
  console.log(`  quality predictive of wins? ${predictive ? 'yes (wins > losses)' : 'NOT clearly'}`);
  console.log(`  -> ${globalReady && predictive ? 'READY (start band 0.8-1.0)' : 'NOT READY (need >=30 scored + quality predictive)'}\n`);
} else {
  console.log('  insufficient scored win/loss split.');
  console.log('  -> NOT READY\n');
}

// ── Knob 3: source_reliability ───────────────────────────────────────────────
console.log('[Knob 3: source_reliability_enabled / threshold_k]');
const MIN_SAMPLES = 10;
if (tableExists('signal_source_performance')) {
  const rows = db.prepare('SELECT source, signal_type, total_signals, win_rate_percent, avg_pnl_percent FROM signal_source_performance ORDER BY total_signals DESC').all();
  if (!rows.length) {
    console.log('  table exists but empty — no closed trades recorded per source yet.');
  } else {
    console.log(`  ${'source'.padEnd(22)} ${'label'.padEnd(20)} n   win%  avgPnl`);
    for (const r of rows) {
      console.log(`  ${String(r.source).padEnd(22)} ${String(r.signal_type).padEnd(20)} ${String(r.total_signals).padEnd(3)} ${fmt(r.win_rate_percent, 0).padStart(4)}  ${fmt(r.avg_pnl_percent)}`);
    }
    const qualified = rows.filter(r => r.total_signals >= MIN_SAMPLES);
    console.log(`  sources with >= ${MIN_SAMPLES} samples: ${qualified.length}`);
    console.log(`  -> ${qualified.length >= 2 ? 'READY (start k=10)' : `NOT READY (need >=2 sources with >=${MIN_SAMPLES} samples)`}`);
  }
} else {
  console.log('  signal_source_performance table not present (old schema / created on next initDb).');
  console.log('  -> NOT READY');
}

console.log('\n=== End. No data was modified. ===\n');
db.close();
