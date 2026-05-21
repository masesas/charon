# Charon Enhancement Implementation Plan

> For executor: implement on a feature branch from the fork. Do not enable live trading by default. Keep `.env` secrets out of git.

**Goal:** Harden Charon from a useful trench bot into a safer, auditable, dockerized trading engine with better screening, execution guardrails, and position recovery.

**Architecture:** Keep the current modular split: `signals -> pipeline -> execution -> positions -> learning -> telegram`. Add small focused modules for risk, provider health, wallet reconciliation, scoring, and Docker runtime. Prefer deterministic guardrails before LLM/strategy decisions.

**Tech Stack:** Node.js ESM, SQLite/better-sqlite3, Telegram Bot API, Solana web3.js, Jupiter API, Docker Compose.

---

## Phase 1 — Safety correctness

### Task 1: Enforce strategy-specific LLM confidence

**Objective:** Make buy approval respect `strat.llm_min_confidence` instead of only global settings.

**Files:**
- Modify: `src/pipeline/orchestrator.js`
- Test/verify: `npm run check`

**Implementation:**
- Locate the approval gate comparing `batchDecision.confidence >= numSetting('llm_min_confidence', 75)`.
- Replace with strategy-aware fallback:

```js
const minConfidence = Number.isFinite(Number(strat?.llm_min_confidence))
  ? Number(strat.llm_min_confidence)
  : numSetting('llm_min_confidence', 75);
```

- Store/log `minConfidence` in the decision log payload so future audits can explain why BUY/WATCH happened.

**Acceptance:**
- `sniper`, `dip_buy`, `smart_money`, and `degen` can use different confidence thresholds.
- `npm run check` passes.

### Task 2: Add Telegram authorization guard

**Objective:** Prevent unauthorized chats/users from issuing commands or callbacks.

**Files:**
- Modify: `src/telegram/commands.js`
- Modify: `src/telegram/callbacks.js`
- Optional create: `src/telegram/auth.js`

**Implementation:**
- Create helper:

```js
import { config } from '../config.js';

export function isAuthorizedTelegramChat(chatId) {
  const allowed = String(config.telegramChatId || '').trim();
  return allowed && String(chatId) === allowed;
}
```

- At the top of every message/callback handler, reject if chat ID mismatch.
- For callback queries, answer callback with a generic unauthorized message and do not execute action.

**Acceptance:**
- Only configured `TELEGRAM_CHAT_ID` can control the bot.
- Unauthorized commands do not alter strategy, positions, wallets, or intents.

### Task 3: Add duplicate guard for open positions + pending intents

**Objective:** Avoid double-buy paths when a token has an open position or pending confirm intent.

**Files:**
- Modify: `src/db/positions.js`
- Modify: `src/db/intents.js`
- Modify: `src/pipeline/orchestrator.js`

**Implementation:**
- Add query helper for open position by mint.
- Add query helper for pending intent by mint.
- Before creating buy intent/live/dry-run position, reject if either exists.

**Acceptance:**
- A repeated signal for the same mint cannot create parallel intents or duplicate entries.

### Task 4: Add stale intent expiration

**Objective:** Expire pending confirmations that are no longer safe to execute.

**Files:**
- Modify: `src/db/intents.js`
- Modify: `src/telegram/callbacks.js`
- Modify: `src/config.js`

**Implementation:**
- Add config `TRADE_INTENT_TTL_MS`, default 300000.
- On confirm callback, reject if `Date.now() - created_at > ttl`.
- Mark intent status `expired`.

**Acceptance:**
- Old Telegram confirm buttons cannot trigger stale buys.

---

## Phase 2 — Execution guardrails

### Task 5: Wire Jupiter slippage into order request

**Objective:** Ensure configured slippage is actually used during swap order creation.

**Files:**
- Modify: `src/liveExecutor.js`
- Modify: `src/config.js`

**Implementation:**
- Pass `JUPITER_SLIPPAGE_BPS` into Jupiter `/order` request using the API-supported field.
- Persist effective slippage in execution log payload.

**Acceptance:**
- Execution logs show slippage used for every live buy/sell.

### Task 6: Add pre-trade route quality guard

**Objective:** Reject live trades with bad price impact, missing output, stale quote, or unstable route.

**Files:**
- Create: `src/execution/routeGuard.js`
- Modify: `src/liveExecutor.js`
- Modify: `src/pipeline/orchestrator.js`

**Implementation:**
- Add thresholds:
  - `MAX_PRICE_IMPACT_PCT`
  - `MIN_ROUTE_OUT_USD`
  - `MAX_QUOTE_AGE_MS`
- Validate Jupiter route/order response before signing.
- Return structured rejection reason.

**Acceptance:**
- Live buy cannot execute without valid quote/output and acceptable route quality.

### Task 7: Add global live risk manager

**Objective:** Centralize kill-switch and exposure limits.

**Files:**
- Create: `src/execution/riskManager.js`
- Modify: `src/pipeline/orchestrator.js`
- Modify: `src/telegram/menus.js`
- Modify: `src/telegram/commands.js`

**Implementation:**
- Enforce:
  - `LIVE_KILL_SWITCH`
  - `MAX_TOTAL_LIVE_EXPOSURE_SOL`
  - `MAX_DAILY_TRADES`
  - `MAX_DAILY_REALIZED_LOSS_SOL`
  - `COOLDOWN_AFTER_LOSS_STREAK`
- Check before any live buy.

**Acceptance:**
- Bot can be globally paused from live buys without stopping monitoring/sells.

### Task 8: Startup wallet reconciliation

**Objective:** Align DB open live positions with actual wallet token balances on boot.

**Files:**
- Create: `src/execution/reconcile.js`
- Modify: `src/app.js`
- Modify: `src/db/positions.js`

**Implementation:**
- On startup, query wallet token balances.
- For each open live position, update token amount if balance differs.
- Alert Telegram if DB has position with zero wallet balance or wallet has unknown token balance.

**Acceptance:**
- Restart cannot silently operate on stale live token amounts.

---

## Phase 3 — Screening quality

### Task 9: Add deterministic candidate score

**Objective:** Add auditable score beside LLM decision.

**Files:**
- Create: `src/pipeline/scoring.js`
- Modify: `src/pipeline/candidateBuilder.js`
- Modify: `src/pipeline/llm.js`
- Modify: `src/db/candidates.js`

**Implementation:**
- Compute component scores: source overlap, fee claim, holder quality, liquidity/mcap, trend quality, ATH distance, saved wallet exposure, risk flags.
- Store score and breakdown in candidate snapshot.
- Include compact score breakdown in LLM prompt.

**Acceptance:**
- Every candidate has deterministic score for audit/backtest.

### Task 10: Universal source-count filter

**Objective:** Make `min_source_count` apply consistently across server and standalone modes.

**Files:**
- Modify: `src/pipeline/candidateBuilder.js`
- Modify: `src/pipeline/orchestrator.js`

**Implementation:**
- Normalize candidate sources into `candidate.signals.sources` and `sourceCount`.
- Enforce source count inside `filterCandidate()` regardless of signal mode.

**Acceptance:**
- Strategy source-count behavior is mode-independent.

### Task 11: Improve dry-run partial TP accounting

**Objective:** Make dry-run PnL closer to live behavior.

**Files:**
- Modify: `src/execution/positions.js`
- Modify: `src/db/positions.js`

**Implementation:**
- On dry-run partial TP, insert simulated partial sell trade.
- Reduce remaining notional/exposure.
- Track realized and unrealized PnL separately.

**Acceptance:**
- Dry-run partial TP performance reports are realistic.

---

## Phase 4 — Operations and observability

### Task 12: Provider health status

**Objective:** Show health for GMGN, Jupiter, RPC, signal server, Telegram, and LLM.

**Files:**
- Create: `src/health/providerHealth.js`
- Modify: provider clients to record success/failure
- Modify: `src/telegram/commands.js`

**Implementation:**
- Track last success, last error, consecutive failures, and degraded flag.
- Add `/status` command.

**Acceptance:**
- Operator can see degraded providers from Telegram.

### Task 13: Strategy version/hash in decisions

**Objective:** Make historical performance analysis reliable after config changes.

**Files:**
- Modify: `src/db/settings.js`
- Modify: `src/pipeline/orchestrator.js`

**Implementation:**
- Compute stable hash of active strategy config.
- Store `strategy_version` or `strategy_hash` with candidates, decisions, positions.

**Acceptance:**
- Every trade can be traced to exact strategy settings used at entry.

### Task 14: Add backtest harness skeleton

**Objective:** Replay saved candidate/signal history against strategy filters.

**Files:**
- Create: `scripts/backtest.js`
- Modify: `package.json`

**Implementation:**
- Add `npm run backtest`.
- Read `signal_events`/candidate snapshots from SQLite.
- Apply current or selected strategy filter offline.
- Output pass/fail counts and hypothetical entries.

**Acceptance:**
- Initial backtest runs without hitting live APIs.

---

## Phase 5 — Docker runtime

### Task 15: Add Dockerfile and compose runtime

**Objective:** Run engine and optional infra cleanly with persistent data.

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.dockerignore`
- Create: `.env.docker.example`
- Create: `docker/README.md`

**Acceptance:**
- `docker compose config` passes.
- `docker compose run --rm charon npm run check` passes.
- SQLite data persists in a named volume.
