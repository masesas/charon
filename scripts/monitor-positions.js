#!/usr/bin/env node
/**
 * Position monitoring script for Charon trading bot
 * Runs on schedule (cron) and reports open positions to Discord
 * 
 * Usage: node scripts/monitor-positions.js
 * Scheduled via: cronjob action='create' with this script
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.join(__dirname, '../charon.sqlite');

// Open DB connection
const db = new Database(dbPath, { readonly: true });

function fmtPct(n) {
  if (!Number.isFinite(n)) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

function fmtSol(n) {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(4) + ' SOL';
}

function fmtUsd(n) {
  if (!Number.isFinite(n)) return '—';
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function short(s, len = 8) {
  if (!s) return '—';
  return s.length > len ? s.slice(0, len) + '…' : s;
}

function formatPosition(row) {
  if (!row) return '';
  
  const pnlPct = row.pnl_percent || 0;
  const pnlSol = row.pnl_sol || 0;
  const pnlEmoji = pnlPct >= 0 ? '📈' : '📉';
  const currentPrice = row.high_water_price || row.entry_price;
  const currentMcap = row.high_water_mcap || row.entry_mcap;
  
  const lines = [
    `${pnlEmoji} <b>${row.symbol}</b> #${row.id}`,
    `Entry: ${fmtUsd(row.entry_price)} @ ${fmtUsd(row.entry_mcap)}`,
    `Current: ${fmtUsd(currentPrice)} @ ${fmtUsd(currentMcap)}`,
    `PnL: ${fmtPct(pnlPct)} (${fmtSol(pnlSol)})`,
    `Size: ${fmtSol(row.size_sol)} | TP: ${fmtPct(row.tp_percent)} | SL: ${fmtPct(row.sl_percent)}`,
    `Opened: <code>${new Date(row.opened_at_ms).toISOString().slice(11, 19)}</code>`,
  ];
  
  return lines.join('\n');
}

function getOpenPositions() {
  try {
    const rows = db.prepare(`
      SELECT * FROM dry_run_positions 
      WHERE status = 'open' 
      ORDER BY opened_at_ms DESC
    `).all();
    return rows || [];
  } catch (err) {
    console.error('DB query error:', err.message);
    return [];
  }
}

function generateReport() {
  const positions = getOpenPositions();
  const count = positions.length;
  
  if (count === 0) {
    return {
      title: '📍 Charon Position Monitor',
      summary: 'No open positions',
      details: '',
      count: 0,
    };
  }
  
  const totalPnl = positions.reduce((sum, p) => sum + (p.pnl_sol || 0), 0);
  const totalPnlPct = positions.reduce((sum, p) => sum + (p.pnl_percent || 0), 0) / count;
  
  const details = positions
    .slice(0, 5) // Show top 5 to avoid message spam
    .map(formatPosition)
    .join('\n\n');
  
  const moreText = count > 5 ? `\n\n... and ${count - 5} more positions` : '';
  
  return {
    title: '📍 Charon Position Monitor',
    summary: `${count} open position${count !== 1 ? 's' : ''} | PnL: ${fmtPct(totalPnlPct)} (${fmtSol(totalPnl)})`,
    details: details + moreText,
    count,
  };
}

// Main execution
const report = generateReport();
console.log(`${report.title}\n${report.summary}\n\n${report.details}`);

// Exit with status for cron monitoring
process.exit(report.count > 0 ? 0 : 1);
