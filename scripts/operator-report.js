// Operator Telegram report for Charon dry_run.
// Local operator enhancement only, not for upstream.
// Reads Telegram bot token and chat id from .env (never logs them),
// reads the SQLite DB read-only, and sends a plain-text summary.
// Usage: node scripts/operator-report.js "optional note"
// Exit 0 on Telegram ok, 1 otherwise. No credentials are printed.
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'node:fs';

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN || '';
const chatId = process.env.TELEGRAM_CHAT_ID || '';
const dbPath = process.env.DB_PATH || './data/charon.db';
const note = process.argv.slice(2).join(' ').slice(0, 1000);

if (!token || !chatId) {
  console.error('operator-report: missing Telegram config in .env');
  process.exit(1);
}

function count(db, sql) {
  try {
    return db.prepare(sql).get()?.c ?? 0;
  } catch {
    return 0;
  }
}

let summary = {
  tradingMode: 'unknown',
  agentEnabled: 'unknown',
  signalEvents: 0,
  candidates: 0,
  llmBatches: 0,
  llmDecisions: 0,
  openPositions: 0,
  closedPositions: 0,
  dryRunTrades: 0,
  signalHealth: 'unknown',
};

try {
  const db = new Database(dbPath, { readonly: true });
  summary.signalEvents = count(db, 'SELECT COUNT(*) AS c FROM signal_events');
  summary.candidates = count(db, 'SELECT COUNT(*) AS c FROM candidates');
  summary.llmBatches = count(db, 'SELECT COUNT(*) AS c FROM llm_batches');
  summary.llmDecisions = count(db, 'SELECT COUNT(*) AS c FROM llm_decisions');
  summary.openPositions = count(db, "SELECT COUNT(*) AS c FROM dry_run_positions WHERE status = 'open'");
  summary.closedPositions = count(db, "SELECT COUNT(*) AS c FROM dry_run_positions WHERE status != 'open'");
  summary.dryRunTrades = count(db, 'SELECT COUNT(*) AS c FROM dry_run_trades');
  try {
    const mode = db.prepare("SELECT value FROM settings WHERE key = 'trading_mode'").get();
    if (mode?.value) summary.tradingMode = String(mode.value);
    const enabled = db.prepare("SELECT value FROM settings WHERE key = 'agent_enabled'").get();
    if (enabled?.value) summary.agentEnabled = String(enabled.value);
  } catch {}
  try {
    const h = db.prepare("SELECT status, success_count, failure_count FROM provider_health WHERE provider = 'signal_server' ORDER BY id DESC LIMIT 1").get();
    if (h) summary.signalHealth = `${h.status} (ok ${h.success_count}, fail ${h.failure_count})`;
  } catch {}
  db.close();
} catch (e) {
  console.error('operator-report: DB read failed:', String(e?.message || e).slice(0, 200));
}

if (summary.tradingMode !== 'dry_run') {
  console.error('operator-report: refusing to report as operator while trading_mode is not dry_run');
  process.exit(1);
}

const lines = [
  'Charon operator report (dry_run)',
  `Waktu: ${new Date().toISOString()}`,
  `Mode: ${summary.tradingMode} | Agent: ${summary.agentEnabled}`,
  `Signal server: ${summary.signalHealth}`,
  `Signal events: ${summary.signalEvents} | Kandidat: ${summary.candidates}`,
  `LLM batch: ${summary.llmBatches} | LLM decision: ${summary.llmDecisions}`,
  `Posisi dry_run: open ${summary.openPositions}, closed ${summary.closedPositions} | Trade: ${summary.dryRunTrades}`,
];
if (note) lines.push('', `Catatan: ${note}`);
const text = lines.join('\n');

const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok || !body.ok) {
  console.error('operator-report: Telegram send failed, status', res.status);
  process.exit(1);
}
console.log('operator-report: sent, message_id', body.result?.message_id ?? 'unknown');
