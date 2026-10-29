# Charon Operator Notes (local, VM only)

This file documents Muse's operator role for this local dry_run deployment.
It is not part of upstream trading logic and must not be pushed upstream
without the owner's explicit approval.

## Safety limits (hard)
- Mode is dry_run only. Never switch to live or confirm without the owner's
  explicit approval in chat.
- Runtime .env in this VM must not contain a private-key line. The bot is
  started via run-operator.sh, which checks for an already-running process.
- Never copy, print, or reveal credentials from .env in chat, logs, or reports.
  Telegram reports contain counts and health only, never tokens or chat ids.

## Local VM enhancements so far
- index.js: axios.defaults.proxy = false. The VM egress proxy breaks axios'
  default proxy handling, while direct/fetch requests succeed. Without this,
  signal-server polling fails with a Host-authority error.
- run-operator.sh: idempotent starter for the dry_run bot, logs to
  logs/operator-run.log.
- scripts/operator-report.js: read-only DB summary sent to Telegram using
  the bot token and chat id already present in .env. Run it with a short
  note argument to report an enhancement. It refuses to run if the DB
  trading_mode is not dry_run.

## Operator cadence
- Bot polls the signal server continuously in-process.
- Muse reviews health, logs, DB counts, and simulated PnL every 6 hours
  via the scheduled operator review, restarts the bot if it is down, and
  reports to the owner only for meaningful events: a new dry_run trade,
  bot-down/restart failure, repeated provider failures, or a concrete,
  evidence-based tuning proposal.
- Enhancement reports are also sent to Telegram via operator-report.js,
  using the same bot/chat configuration as the Charon bot itself.

## Why strategy tuning is not blind
With 0 signals, 0 candidates, and 0 dry_run trades so far, changing
confidence thresholds, TP/SL, or position size would be guessing, not
enhancement. Strategy tuning waits for dry_run evidence: signal volume,
candidate quality, LLM/fallback decisions, and simulated PnL.
