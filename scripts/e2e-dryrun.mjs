// ============================================================================
// Charon E2E dry-run observation harness
// ----------------------------------------------------------------------------
// Boots the REAL agent components against REAL upstream data (signal server,
// Solana RPC, Jupiter, GMGN, LLM, Telegram) but forces execution into dry_run
// so NO on-chain transaction is ever sent. It is an OBSERVATION harness, not a
// pass/fail test: it drives one full pipeline lifecycle and dumps every stage
// so you and I can inspect what happened.
//
//   signal → buildCandidate → filter → score → LLM decide → dry-run position
//          → monitorPositions (fast/slow) → exit (SL/TP/trailing)
//
// Usage:
//   node scripts/e2e-dryrun.mjs [options]
//
// Options:
//   --cycles N            signal-server poll cycles to run        (default 1)
//   --poll-interval MS    delay between signal polls              (default 30000)
//   --monitor-secs S      how long to run the monitor loop        (default 120)
//   --monitor-interval MS delay between monitor cycles            (default 2500)
//   --db PATH             sqlite db file to use            (default: temp file)
//   --use-prod-db         use ./charon.sqlite instead of a temp db (CAREFUL)
//   --keep-db             do not delete the temp db on exit (for inspection)
//   --no-telegram         fully offline: bot becomes a no-op (no sends, no polling)
//   --telegram-polling    enable Telegram polling (DANGER: 409-conflicts if the
//                         production agent already polls this token). Default is
//                         send-only — alerts are sent but getUpdates is never called.
//   --help                print this help and exit
//
// SAFETY: three independent guards keep this in dry_run —
//   1. a private, throwaway DB by default (prod positions untouched)
//   2. trading_mode is force-set to 'dry_run' in the settings table
//   3. a hard assertion aborts the run if tradingMode() is ever not 'dry_run'
// ============================================================================

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Load .env up front so the prerequisites panel reflects what config.js will see
// (config.js also calls dotenv.config(), which is idempotent).
dotenv.config();

// ── tiny arg parser ────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name) { return argv.includes(`--${name}`); }
function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

if (flag('help')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('\n').filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const CYCLES = Number(opt('cycles', '1'));
const POLL_INTERVAL_MS = Number(opt('poll-interval', '30000'));
const MONITOR_SECS = Number(opt('monitor-secs', '120'));
const MONITOR_INTERVAL_MS = Number(opt('monitor-interval', '2500'));
const KEEP_DB = flag('keep-db');
const USE_PROD_DB = flag('use-prod-db');
const NO_TELEGRAM = flag('no-telegram');
// Telegram polling is what causes "409 Conflict" when the production agent is
// already polling the same token. The harness never needs to RECEIVE updates,
// only to SEND alerts — so it runs send-only (polling disabled) by default.
// Opt back into polling with --telegram-polling only if no other instance runs.
const TELEGRAM_POLLING = flag('telegram-polling');

const projectRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
const tmpDb = path.join(os.tmpdir(), `charon-e2e-${process.pid}.sqlite`);
const DB_PATH = opt('db', USE_PROD_DB ? path.join(projectRoot, 'charon.sqlite') : tmpDb);
const usingTempDb = DB_PATH === tmpDb;

// ── CRITICAL: env must be set BEFORE importing config.js / connection.js ─────
// config.js reads DB_PATH and TRADING_MODE at import time, and connection.js
// seeds settings from TRADING_MODE. Set both before any agent import resolves.
process.env.DB_PATH = DB_PATH;
process.env.TRADING_MODE = 'dry_run';
if (NO_TELEGRAM) {
  process.env.__E2E_NO_TELEGRAM = '1';                 // bot.js → no-op stub (fully offline)
} else if (!TELEGRAM_POLLING) {
  process.env.__E2E_TELEGRAM_SEND_ONLY = '1';          // bot.js → real send, polling off (no 409)
}

// ── pretty logging ──────────────────────────────────────────────────────────
const t0 = Date.now();
function ts() { return `+${((Date.now() - t0) / 1000).toFixed(1)}s`; }
function banner(title) {
  console.log(`\n${'═'.repeat(72)}\n  ${title}   (${ts()})\n${'═'.repeat(72)}`);
}
function line(label, value) { console.log(`  ${label.padEnd(26)} ${value}`); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ============================================================================
banner('E2E DRY-RUN HARNESS — configuration');
line('DB path', DB_PATH + (usingTempDb ? '  (throwaway temp)' : USE_PROD_DB ? '  (PROD DB — careful)' : ''));
line('Signal poll cycles', `${CYCLES} × ${POLL_INTERVAL_MS}ms`);
line('Monitor window', `${MONITOR_SECS}s × ${MONITOR_INTERVAL_MS}ms cycles`);
line('Telegram', NO_TELEGRAM
  ? 'disabled — no-op (--no-telegram)'
  : TELEGRAM_POLLING
    ? 'enabled WITH polling (--telegram-polling, may 409)'
    : 'send-only — polling off (no 409 conflict)');

// ── prerequisite check (real mode needs upstream creds) ─────────────────────
banner('PREREQUISITES — real upstream access');
const env = process.env;
const reqs = [
  ['SIGNAL_SERVER_URL', env.SIGNAL_SERVER_URL || 'http://localhost:3456 (default)', !!env.SIGNAL_SERVER_URL],
  ['HELIUS / SOLANA_RPC_URL', env.SOLANA_RPC_URL ? 'custom RPC' : (env.HELIUS_API_KEY ? 'via Helius key' : 'MISSING'), !!(env.SOLANA_RPC_URL || env.HELIUS_API_KEY)],
  ['ENABLE_LLM', env.ENABLE_LLM === 'false' ? 'false (LLM off → fallback)' : 'true', true],
  ['LLM_API_KEY', env.LLM_API_KEY ? 'present' : 'missing (LLM → deterministic fallback)', true],
  ['GMGN_ENABLED', env.GMGN_ENABLED === 'false' ? 'false' : 'true', true],
  ['TELEGRAM_BOT_TOKEN', env.TELEGRAM_BOT_TOKEN ? 'present' : 'missing', NO_TELEGRAM || !!env.TELEGRAM_BOT_TOKEN],
];
let missingHard = false;
for (const [name, val, ok] of reqs) {
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(26)} ${val}`);
  if (!ok) missingHard = true;
}
if (missingHard && !env.SOLANA_RPC_URL && !env.HELIUS_API_KEY) {
  console.log('\n  ⚠  No Solana RPC access. buildCandidate enrichment will fail for real mints.');
}
if (!NO_TELEGRAM && !env.TELEGRAM_BOT_TOKEN) {
  console.error('\n  ✗ TELEGRAM_BOT_TOKEN missing but Telegram enabled. Re-run with --no-telegram, or set the token.');
  process.exit(1);
}

// ── boot DB and FORCE dry_run ───────────────────────────────────────────────
banner('BOOT — database + dry_run lockdown');
const { initDb, db } = await import('../src/db/connection.js');
initDb();
line('Tables', db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get().n);

const { setSetting, setting } = await import('../src/db/settings.js');
setSetting('trading_mode', 'dry_run');   // guard #2: override whatever was seeded/persisted
setSetting('agent_enabled', 'true');      // ensure the buy path is reachable

const { tradingMode } = await import('../src/db/positions.js');
const mode = tradingMode();
line('trading_mode (setting)', setting('trading_mode', '?'));
line('tradingMode() resolved', mode);

// guard #3: hard abort if anything resolved to a non-dry_run mode
if (mode !== 'dry_run') {
  console.error(`\n  ✗ ABORT: tradingMode() = '${mode}', refusing to run anything that could touch live execution.`);
  process.exit(1);
}
console.log('  🔒 Locked to dry_run — no on-chain transaction can be sent.');

// ── wire the pipeline (registers signal → orchestrator handlers) ────────────
// Importing the orchestrator transitively imports telegram/send.js → bot.js,
// which starts polling when Telegram is enabled. With --no-telegram we stub the
// bot module first so nothing connects or sends.
banner('WIRE — pipeline handlers');
const orchestrator = await import('../src/pipeline/orchestrator.js');
const { processCandidateFromSignals, maybeProcessDegenCandidate } = orchestrator;
const { initLiveExecution } = await import('../src/liveExecutor.js');
initLiveExecution(); // no-op without SOLANA_PRIVATE_KEY; safe in dry_run regardless

const server = await import('../src/signals/serverClient.js');
server.setCandidateHandler(processCandidateFromSignals);
server.setDegenHandler(maybeProcessDegenCandidate);
line('Candidate handler', 'processCandidateFromSignals (real pipeline)');
line('Signal source', env.SIGNAL_SERVER_URL || 'http://localhost:3456');

// snapshot row counts so we can show deltas after the run
const countRows = (tbl) => { try { return db.prepare(`SELECT count(*) n FROM ${tbl}`).get().n; } catch { return 0; } };
const before = {
  candidates: countRows('candidates'),
  decisions: countRows('llm_decisions'),
  positions: countRows('dry_run_positions'),
  logs: countRows('decision_logs'),
};

// ── PHASE 1: pull real signals through the full entry pipeline ───────────────
banner('PHASE 1 — real signals → candidates → decisions → dry-run entries');
for (let c = 1; c <= CYCLES; c++) {
  console.log(`\n  ── poll cycle ${c}/${CYCLES} ──`);
  try {
    await server.fetchServerSignals();
  } catch (err) {
    console.log(`  [poll] error: ${err.message}`);
  }
  if (c < CYCLES) {
    console.log(`  …waiting ${POLL_INTERVAL_MS}ms before next poll`);
    await sleep(POLL_INTERVAL_MS);
  }
}

// brief settle so any in-flight async entry work finishes
await sleep(1500);

const openCount = db.prepare("SELECT count(*) n FROM dry_run_positions WHERE status='open'").get().n;
line('New candidates', countRows('candidates') - before.candidates);
line('New decisions', countRows('llm_decisions') - before.decisions);
line('New dry-run positions', countRows('dry_run_positions') - before.positions);
line('Open positions now', openCount);

// ── PHASE 2: monitor open positions through their exit lifecycle ─────────────
banner('PHASE 2 — monitor loop (PnL tracking → SL/TP/trailing exit)');
if (openCount === 0) {
  console.log('  No open positions to monitor.');
  console.log('  This is normal if no real signal produced a BUY in the poll window.');
  console.log('  Inspect the decision dump below to see where candidates stopped.');
} else {
  const { monitorPositions } = await import('../src/execution/positions.js');
  const deadline = Date.now() + MONITOR_SECS * 1000;
  let cycle = 0;
  while (Date.now() < deadline) {
    cycle++;
    try {
      // fast lane catches young/near-threshold positions; slow lane the rest
      await monitorPositions('fast');
      await monitorPositions('slow');
    } catch (err) {
      console.log(`  [monitor cycle ${cycle}] error: ${err.message}`);
    }
    const open = db.prepare("SELECT count(*) n FROM dry_run_positions WHERE status='open'").get().n;
    const closed = db.prepare("SELECT count(*) n FROM dry_run_positions WHERE status!='open'").get().n;
    const last = db.prepare("SELECT mint, last_pnl_percent FROM dry_run_positions WHERE status='open' ORDER BY id DESC LIMIT 1").get();
    const pnl = last && last.last_pnl_percent != null ? `${Number(last.last_pnl_percent).toFixed(1)}%` : 'n/a';
    process.stdout.write(`  cycle ${String(cycle).padStart(3)} | open ${open} | closed ${closed} | last pnl ${pnl}        \r`);
    if (open === 0) { console.log('\n  All positions exited.'); break; }
    await sleep(MONITOR_INTERVAL_MS);
  }
  console.log('');
}

// ── PHASE 3: dump every stage for inspection ────────────────────────────────
banner('PHASE 3 — state dump (newest first)');

function dump(title, sql, fmt) {
  console.log(`\n  ▸ ${title}`);
  let rows = [];
  try { rows = db.prepare(sql).all(); } catch (e) { console.log(`    (query failed: ${e.message})`); return; }
  if (rows.length === 0) { console.log('    (none)'); return; }
  for (const r of rows) console.log('    ' + fmt(r));
}

dump('candidates',
  'SELECT id, mint, status, quality_score, risk_score, confidence_score FROM candidates ORDER BY id DESC LIMIT 10',
  r => `#${r.id} ${String(r.mint).slice(0, 8)}… status=${String(r.status).padEnd(10)} quality=${r.quality_score ?? '–'} risk=${r.risk_score ?? '–'} conf=${r.confidence_score ?? '–'}`);

dump('llm_decisions',
  'SELECT id, candidate_id, verdict, confidence, reason FROM llm_decisions ORDER BY id DESC LIMIT 10',
  r => `#${r.id} cand=${r.candidate_id} ${String(r.verdict).padEnd(6)} conf=${r.confidence} — ${String(r.reason || '').slice(0, 80)}`);

dump('decision_logs (pipeline events)',
  'SELECT id, action, trigger_candidate_id FROM decision_logs ORDER BY id DESC LIMIT 15',
  r => `#${r.id} ${String(r.action).padEnd(34)} trigger=${r.trigger_candidate_id ?? '–'}`);

dump('dry_run_positions',
  `SELECT id, symbol, mint, status, size_sol, entry_price, last_pnl_percent, exit_reason, pnl_percent
   FROM dry_run_positions ORDER BY id DESC LIMIT 10`,
  r => `#${r.id} ${(r.symbol || '?').padEnd(8)} ${String(r.mint).slice(0, 8)}… ${String(r.status).padEnd(7)} size=${r.size_sol} entry=${r.entry_price ?? '–'} pnl=${r.last_pnl_percent ?? '–'} exit=${r.exit_reason ?? '–'} realized=${r.pnl_percent ?? '–'}`);

dump('dry_run_trades (fills)',
  'SELECT id, position_id, mint, side, reason FROM dry_run_trades ORDER BY id DESC LIMIT 10',
  r => `#${r.id} pos=${r.position_id} ${String(r.mint).slice(0, 8)}… ${r.side ?? '?'} reason=${r.reason ?? 'entry'}`);

// ── summary verdict ─────────────────────────────────────────────────────────
banner('SUMMARY');
const newPos = countRows('dry_run_positions') - before.positions;
const newDec = countRows('llm_decisions') - before.decisions;
const newCand = countRows('candidates') - before.candidates;
const buys = db.prepare("SELECT count(*) n FROM llm_decisions WHERE verdict='BUY'").get().n;
const exited = db.prepare("SELECT count(*) n FROM dry_run_positions WHERE status!='open'").get().n;

line('Candidates evaluated', newCand);
line('Decisions made', newDec);
line('BUY verdicts (total)', buys);
line('Dry-run positions opened', newPos);
line('Positions exited', exited);
line('Mode at end', tradingMode());
console.log(`\n  ${mode === 'dry_run' ? '✓' : '✗'} Stayed in dry_run for the entire run — no live transaction possible.`);

if (newCand === 0) {
  console.log('  ℹ No candidates entered the pipeline. Check that the signal server returned signals,');
  console.log('    and that strategy gates (min_source_count, token_age_max_ms) did not filter them all.');
}

// ── cleanup + force exit (telegram polling / sockets keep the loop alive) ────
function cleanup() {
  if (usingTempDb && !KEEP_DB) {
    for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(`${DB_PATH}${suffix}`, { force: true }); } catch {} }
    console.log(`\n  Cleaned up temp DB.`);
  } else {
    console.log(`\n  DB retained at: ${DB_PATH}`);
  }
}
cleanup();
console.log(`  Done in ${ts()}.\n`);
process.exit(0);
