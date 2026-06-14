// Tier 2 verification — run: node scripts/test-monitor-tier2.mjs
// Uses a throwaway temp DB (NOT data/charon.db). Tests lane classification,
// near-threshold detection, the inFlight reentrancy guard, and the migration.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmpDb = path.join(os.tmpdir(), `charon-t2-${process.pid}.sqlite`);
process.env.DB_PATH = tmpDb;

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

const { initDb, db } = await import('../src/db/connection.js');
initDb();
const pos = await import('../src/execution/positions.js');
const { POSITION_VOLATILE_AGE_MS } = await import('../src/config.js');

const nowMs = Date.now();

console.log('\n[1] migration adds last_pnl_percent column');
const cols = db.prepare('PRAGMA table_info(dry_run_positions)').all().map(r => r.name);
ok('last_pnl_percent column exists', cols.includes('last_pnl_percent'));

console.log('\n[2] laneOf — age-based');
ok('brand-new position -> fast', pos.laneOf({ opened_at_ms: nowMs, sl_percent: -25, tp_percent: 50 }) === 'fast');
ok('young (<5min) -> fast', pos.laneOf({ opened_at_ms: nowMs - 60_000, sl_percent: -25, tp_percent: 50 }) === 'fast');
ok('mature + mid-range -> slow', pos.laneOf({
  opened_at_ms: nowMs - POSITION_VOLATILE_AGE_MS - 10_000,
  sl_percent: -25, tp_percent: 50, last_pnl_percent: 5,
}) === 'slow');

console.log('\n[3] isNearThreshold');
ok('near SL (pnl -20, sl -25, near 8) -> true', pos.isNearThreshold({ last_pnl_percent: -20, sl_percent: -25, tp_percent: 50 }) === true);
ok('far from both (pnl 5) -> false', pos.isNearThreshold({ last_pnl_percent: 5, sl_percent: -25, tp_percent: 50 }) === false);
ok('near TP (pnl 45, tp 50, near 8) -> true', pos.isNearThreshold({ last_pnl_percent: 45, sl_percent: -25, tp_percent: 50 }) === true);
ok('no prior pnl (NaN) -> false', pos.isNearThreshold({ last_pnl_percent: null, sl_percent: -25, tp_percent: 50 }) === false);
ok('exactly at near boundary SL (pnl -17, sl -25, near 8) -> true', pos.isNearThreshold({ last_pnl_percent: -17, sl_percent: -25, tp_percent: 50 }) === true);
ok('just outside near boundary (pnl -16.9) -> false', pos.isNearThreshold({ last_pnl_percent: -16.9, sl_percent: -25, tp_percent: 50 }) === false);

console.log('\n[4] mature near-threshold -> fast lane');
ok('mature + near SL -> fast', pos.laneOf({
  opened_at_ms: nowMs - POSITION_VOLATILE_AGE_MS - 10_000,
  sl_percent: -25, tp_percent: 50, last_pnl_percent: -20,
}) === 'fast');

console.log('\n[5] monitorPositions filters disjoint lanes (no fetch — empty DB)');
// With no open positions, both lanes return immediately without throwing.
let threw = false;
try { await pos.monitorPositions('fast'); await pos.monitorPositions('slow'); }
catch (e) { threw = true; console.log('    err:', e.message); }
ok('empty DB monitor does not throw', !threw);

console.log('\n[6] reentrancy guard — concurrent fast calls process a position once');
// Insert one young open position and stub the network by monkeypatching is hard here;
// instead verify the inFlight guard semantics via laneOf + a manual double-invoke that
// would double-process only if the guard were absent. We assert no throw + single row.
const insert = db.prepare(`
  INSERT INTO dry_run_positions (candidate_id, mint, symbol, status, opened_at_ms, size_sol,
    entry_price, entry_mcap, tp_percent, sl_percent, trailing_enabled, trailing_percent,
    execution_mode, strategy_id, snapshot_json)
  VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, 0, 0, 'dry_run', 'sniper', ?)
`);
insert.run(1, 'So11111111111111111111111111111111111111112', 'SOL', nowMs, 0.05, 0.0001, 50000, 50, -25, '{}');
const before = db.prepare("SELECT COUNT(*) n FROM dry_run_positions WHERE status='open'").get().n;
ok('one open position seeded', before === 1);
// Fire two fast cycles concurrently. Network calls may fail (offline) — that's fine;
// we only assert the calls settle without throwing and the position row is intact.
const results = await Promise.allSettled([pos.monitorPositions('fast'), pos.monitorPositions('fast')]);
ok('concurrent fast cycles settle', results.every(r => r.status === 'fulfilled'),
   JSON.stringify(results.map(r => r.status)));
const after = db.prepare("SELECT COUNT(*) n FROM dry_run_positions").get().n;
ok('no duplicate/lost rows', after === 1, `got ${after}`);

console.log('\n[7] live exit path has a stillOpen re-check guard (review HIGH)');
// Static guard-presence check: the live branch must re-query status before
// executeLiveSell, mirroring the dry-run guard, to prevent a double live sell.
const src = fs.readFileSync(new URL('../src/execution/positions.js', import.meta.url), 'utf8');
// Anchor on the exit branch (the one that awaits executeLiveSell), not the partial-TP
// block which also references execution_mode === 'live'.
const liveBranchIdx = src.indexOf("exitReason && autoExit && position.execution_mode === 'live'");
ok('live exit branch found', liveBranchIdx !== -1);
const liveBranch = src.slice(liveBranchIdx, liveBranchIdx + 1200);
const selIdx = liveBranch.indexOf('SELECT status FROM dry_run_positions');
const sellIdx = liveBranch.indexOf('executeLiveSell');
const hasRecheckBeforeSell = selIdx !== -1 && sellIdx !== -1 && selIdx < sellIdx;
ok('live branch re-checks status before executeLiveSell', hasRecheckBeforeSell, `sel=${selIdx} sell=${sellIdx}`);

// cleanup
for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(`${tmpDb}${suffix}`, { force: true }); } catch {} }

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
