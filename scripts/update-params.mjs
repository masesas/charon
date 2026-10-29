#!/usr/bin/env node
// Update strategy / settings parameters directly in the live DB — with type
// validation, an audit trail (config_changes), and a dry-run mode.
//
// WHY a script: editing config_json by hand risks shape/type drift and skips the
// audit log. This goes through the same updateStrategyConfig + logConfigChange
// path the agent uses, so the engine picks changes up via its 5s strategy cache
// and every change is reversible from the config_changes table.
//
// Usage:
//   DB_PATH=./data/charon.db node scripts/update-params.mjs <target> <key=value>... [flags]
//
//   <target>           Strategy id (smart_money|sniper|dip_buy|degen) OR "settings"
//   <key=value>        One or more parameter assignments (repeatable)
//
// Flags:
//   --dry-run          Show what would change; write nothing.
//   --reason "<text>"  Audit reason recorded for every change (default: "manual update").
//   --by "<name>"      created_by label in config_changes (default: "manual").
//   --yes / -y         Skip the confirmation prompt (non-interactive).
//   --list             Print the current config for <target> and exit.
//
// Examples:
//   # Preview a strategy change
//   node scripts/update-params.mjs smart_money sl_percent=-15 trailing_percent=20 --dry-run
//   # Apply with an audit reason
//   node scripts/update-params.mjs smart_money sl_percent=-15 --reason "tighten SL" --yes
//   # Update a global setting (settings table)
//   node scripts/update-params.mjs settings llm_min_confidence=60 --yes
//   # Inspect current values
//   node scripts/update-params.mjs smart_money --list

import { createInterface } from 'node:readline';

// ── DB_PATH must be set before importing connection.js (it opens at import) ──
if (!process.env.DB_PATH) process.env.DB_PATH = './data/charon.db';

const { db } = await import('../src/db/connection.js');
const { strategyById, updateStrategyConfig, setSetting, setting } = await import('../src/db/settings.js');
const { initConfigChanges, logConfigChange } = await import('../src/db/configChanges.js');

// Canonical key → type map for strategy config. Keys not listed are rejected to
// prevent typos silently injecting junk fields into config_json.
const STRATEGY_TYPES = {
  entry_mode: 'string', min_source_count: 'number', require_fee_claim: 'boolean',
  token_age_max_ms: 'number', min_mcap_usd: 'number', max_mcap_usd: 'number',
  min_fee_claim_sol: 'number', min_gmgn_total_fee_sol: 'number', min_holders: 'number',
  max_top20_holder_percent: 'number', min_saved_wallet_holders: 'number',
  max_ath_distance_pct: 'number', min_graduated_volume_usd: 'number',
  trending_min_volume_usd: 'number', trending_min_swaps: 'number',
  trending_max_rug_ratio: 'number', trending_max_bundler_rate: 'number',
  position_size_sol: 'number', max_open_positions: 'number', tp_percent: 'number',
  sl_percent: 'number', trailing_enabled: 'boolean', trailing_percent: 'number',
  partial_tp: 'boolean', partial_tp_at_percent: 'number', partial_tp_sell_percent: 'number',
  max_hold_ms: 'number', use_llm: 'boolean', llm_min_confidence: 'number',
  min_liquidity_usd: 'number', max_mcap_to_liq_ratio: 'number',
};

const VALID_ENTRY_MODES = new Set(['immediate', 'wait_for_dip']);

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

// Coerce a CLI string to the declared type, validating as we go.
function coerce(key, raw, type) {
  if (type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) die(`${key}: "${raw}" is not a valid number`);
    return n;
  }
  if (type === 'boolean') {
    const v = raw.toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(v)) return true;
    if (['false', '0', 'no', 'off'].includes(v)) return false;
    die(`${key}: "${raw}" is not a valid boolean (use true/false)`);
  }
  if (type === 'string') {
    if (key === 'entry_mode' && !VALID_ENTRY_MODES.has(raw)) {
      die(`entry_mode: "${raw}" invalid (allowed: ${[...VALID_ENTRY_MODES].join(', ')})`);
    }
    return raw;
  }
  die(`${key}: unknown type ${type}`);
}

function parseArgs(argv) {
  const positional = [];
  const assignments = [];
  const flags = { dryRun: false, yes: false, list: false, reason: 'manual update', by: 'manual' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--yes' || a === '-y') flags.yes = true;
    else if (a === '--list') flags.list = true;
    else if (a === '--reason') flags.reason = argv[++i] ?? flags.reason;
    else if (a === '--by') flags.by = argv[++i] ?? flags.by;
    else if (a.startsWith('--')) die(`unknown flag: ${a}`);
    else if (a.includes('=')) {
      const idx = a.indexOf('=');
      assignments.push([a.slice(0, idx), a.slice(idx + 1)]);
    } else positional.push(a);
  }
  return { positional, assignments, flags };
}

function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => { rl.close(); resolve(/^y(es)?$/i.test(ans.trim())); });
  });
}

// ── main ─────────────────────────────────────────────────────────────────────
const { positional, assignments, flags } = parseArgs(process.argv.slice(2));
const target = positional[0];

if (!target) {
  die('missing <target>. Usage: update-params.mjs <strategy_id|settings> <key=value>... [--dry-run] [--list]');
}

initConfigChanges();
console.log(`DB: ${process.env.DB_PATH}`);

// ── settings-table target ────────────────────────────────────────────────────
if (target === 'settings') {
  if (flags.list) {
    const rows = db.prepare('SELECT key, value FROM settings ORDER BY key').all();
    console.log(`\n[settings] ${rows.length} keys:`);
    for (const r of rows) console.log(`  ${r.key} = ${r.value}`);
    process.exit(0);
  }
  if (!assignments.length) die('no key=value pairs given for settings');

  const planned = assignments.map(([k, raw]) => ({ key: k, oldV: setting(k, '(unset)'), newV: raw }));
  console.log(`\n[settings] ${flags.dryRun ? 'DRY RUN — ' : ''}${planned.length} change(s):`);
  for (const p of planned) console.log(`  ${p.key}: ${p.oldV} -> ${p.newV}`);

  if (flags.dryRun) { console.log('\nDry run — nothing written.'); process.exit(0); }
  if (!flags.yes && !(await confirm('\nApply to settings table? [y/N] '))) {
    console.log('Aborted.'); process.exit(0);
  }
  for (const p of planned) setSetting(p.key, p.newV);
  console.log('Applied. (Note: settings changes are not written to config_changes audit log.)');
  process.exit(0);
}

// ── strategy target ──────────────────────────────────────────────────────────
const strat = strategyById(target);
if (!strat) {
  const all = db.prepare('SELECT id FROM strategies ORDER BY id').all().map((r) => r.id);
  die(`strategy "${target}" not found. Available: ${all.join(', ')}, or "settings"`);
}

if (flags.list) {
  const { id, name, ...cfg } = strat;
  console.log(`\n[${id}] "${name}" config:`);
  for (const [k, v] of Object.entries(cfg)) console.log(`  ${k} = ${v}`);
  process.exit(0);
}

if (!assignments.length) die('no key=value pairs given. Use --list to inspect current values.');

// Validate + coerce every assignment before touching anything.
const planned = [];
for (const [key, raw] of assignments) {
  const type = STRATEGY_TYPES[key];
  if (!type) {
    die(`unknown strategy key "${key}". Valid keys:\n  ${Object.keys(STRATEGY_TYPES).join(', ')}`);
  }
  planned.push({ key, oldV: strat[key], newV: coerce(key, raw, type) });
}

console.log(`\n[${target}] "${strat.name}" — ${flags.dryRun ? 'DRY RUN — ' : ''}${planned.length} change(s):`);
for (const p of planned) {
  const same = p.oldV === p.newV ? '  (no change)' : '';
  console.log(`  ${p.key}: ${p.oldV} -> ${p.newV}${same}`);
}

if (flags.dryRun) { console.log('\nDry run — nothing written.'); process.exit(0); }
if (!flags.yes && !(await confirm('\nApply to live DB? [y/N] '))) {
  console.log('Aborted.'); process.exit(0);
}

// Build next config immutably, log each change to the audit trail, then persist once.
const next = { ...strat };
for (const p of planned) {
  next[p.key] = p.newV;
  // String() the old/new so booleans/zeros survive the nullish coalescing in logConfigChange.
  logConfigChange(target, p.key, String(p.oldV), String(p.newV), null, flags.reason, flags.by);
}
const { id, name, ...config } = next;
updateStrategyConfig(target, config);

// Verify from DB.
const fresh = JSON.parse(db.prepare('SELECT config_json FROM strategies WHERE id=?').get(target).config_json);
console.log('\nApplied. Verify from DB:');
for (const p of planned) console.log(`  ${p.key} = ${fresh[p.key]}`);
console.log(`\nAudit: ${planned.length} row(s) written to config_changes (created_by="${flags.by}").`);
console.log('Engine picks up via the 5s strategy cache — no restart needed.');
