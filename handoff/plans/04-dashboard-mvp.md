# Plan 04 — Charon Mobile Dashboard (MVP)

> **Status:** Draft for review
> **Author:** AI agent session 2026-06-14
> **Depends on:** existing SQLite schema (`src/db/connection.js`), no code changes to the trading loop required for read paths.
> **Companion docs:** `00-overview.md`, `01-tier1-llm-resilience.md`, `02-tier2-adaptive-monitor.md`, `03-tier3-param-consistency.md`

---

## 1. Goal & Non-Goals

### Goal
A **mobile-first**, low-footprint web dashboard that lets the operator monitor Charon from a phone and perform a small set of **guarded controls** — without opening the Telegram app. It runs **alongside** the live agent and never destabilizes the trading loop.

### Decisions locked (from review)
| Decision | Choice |
|---|---|
| Scope | **Monitoring + light controls** |
| Exposure / Auth | **Cloudflare Tunnel + shared bearer token** (no open inbound port) |
| Tech stack | **Minimal: Node `http` + server-rendered HTML + Alpine.js/HTMX + uPlot** |
| Deployment | **Separate read-mostly sidecar process / container** |

### Non-Goals (v1)
- No full strategy/tier parameter editing from web (stays in Telegram `/stratset`).
- No `confirm`-mode trade approval from web (Telegram inline buttons remain authoritative).
- No wallet management (`/walletadd`, `/walletremove`) from web.
- No multi-user accounts / RBAC — single shared token.
- No historical re-charting beyond what SQLite already stores.

---

## 2. Context: What the agent already exposes

Charon is a single-process Node.js (ESM) agent. **Source of truth is one SQLite DB** (`DB_PATH`, default `data/charon.db`, **WAL mode**). There is **no HTTP server today**; control is Telegram-only. `docker-compose.yml` already reserves a commented-out `ports:` mapping.

Live tables and their dashboard value (row counts from the live DB at planning time):

| Table | Rows | Surfaced as |
|---|---|---|
| `dry_run_positions` (+ `dry_run_trades`) | 4 / 8 | Open & closed positions, PnL, TP/SL, tier, exit reason |
| `decision_logs` | 4,095 | Decision funnel (94% `no_candidate_selected`), why we did/didn't trade |
| `candidates` | 9,171 | Screening funnel + confidence/risk/quality scores |
| `llm_batches` / `llm_decisions` | 4,102 / 4,108 | LLM verdicts, avg confidence, fail-streak |
| `signal_events` | 737,043 | Signal volume by source/kind over time |
| `provider_health` | live | GMGN / Jupiter / Helius / LLM success-rate + latency |
| `daily_risk_metrics` | live | Daily PnL, win/loss, drawdown, loss-streak, daily-loss-limit state |
| `signal_source_performance` | live | Per-source win-rate (learning loop) |
| `learning_runs` / `learning_lessons` | live | Latest learning summary + active lessons |
| `strategies` / `tier_profiles` / `settings` | live | Active strategy, tier configs, runtime flags |

WAL mode means a **second process can read concurrently and safely** while the agent writes.

---

## 3. MVP Feature Set (mobile-first screens)

Five screens, each a single scrollable mobile card-stack. Default landing = **Overview**.

### 3.1 Overview (landing)
- **Hero status row:** Agent `on/off` (from `settings.agent_enabled`), `TRADING_MODE`, active strategy name, open-position count / cap.
- **Today PnL card:** from `daily_risk_metrics` for today's date — total PnL (SOL + %), wins/losses, win-rate, loss-streak, drawdown, **daily-loss-limit triggered** flag (red banner if true).
- **Provider health strip:** one chip per provider (✅/⚠️) mirroring `sendStatus()` logic — reuse `getAllProviderHealth()` / `getDegradedProviders()`.
- **LLM health card:** last batch time, current fail-streak vs `llm_alert_fail_streak`, fallback-enabled flag. (Directly tied to Plan 01.)

### 3.2 Positions
- **Open positions list:** mint/symbol, tier, size SOL, entry mcap, current unrealized PnL (from latest `position_price_snapshots` row), TP/SL/trailing state, age.
- **Closed positions list (paginated):** symbol, PnL %/SOL, exit reason, hold time, route.
- **Per-position detail (drawer):** price/mcap sparkline from `position_price_snapshots` (uPlot), TP/SL lines, near-miss markers.
- **Control:** `Force close` button → enqueues a command (see §5.2). Disabled in `dry_run` (closes are simulated by the agent anyway).

### 3.3 Decision Funnel
- **Funnel bars** over a selectable window (1h / 24h / 7d): candidates → passed filters → LLM BUY → entries, derived from `decision_logs.action` GROUP BY (`no_candidate_selected`, `entry_not_approved`, `entry_rejected_fresh_filters`, `dry_run_entry`, `live_entry`).
- **Recent decisions table:** time, action, selected mint, verdict, confidence, short reason.
- **LLM verdict mix:** BUY/PASS/HOLD counts + avg confidence from `llm_batches` (reuse `summarizeLearningWindow` shape).

### 3.4 Signals & Sources
- **Signal volume chart:** `signal_events` count bucketed by hour, split by `source`/`kind` (uPlot stacked). Query is bounded by time window + `LIMIT` (737k rows — must not full-scan; see §6, §10).
- **Source performance table:** `signal_source_performance` — win-rate, avg PnL, sample count, reliability score (`computeSourceReliabilityScore`).

### 3.5 Learning & Config
- **Latest learning run:** summary + **active lessons** from `learning_lessons WHERE status='active'`.
- **Active strategy snapshot:** key params of the enabled strategy (read-only display).
- **Controls (guarded):** `Pause / Resume agent`, `Switch active strategy` (dropdown of `allStrategies()`).

---

## 4. Architecture

```
                       Cloudflare Tunnel (HTTPS, no inbound port)
                                     │
                                     ▼
          ┌──────────────────────────────────────────────┐
          │  charon-dashboard  (separate Node process)     │
          │  ─ node:http server (mobile-first SSR)         │
          │  ─ Bearer-token auth middleware                │
          │  ─ SQLite handle: readonly: true               │ ◄── heavy reads
          │  ─ Separate SQLite handle: read-write,         │ ──► settings/strategies
          │    busy_timeout, ONLY settings + command queue │ ──► dashboard_commands
          └──────────────────────────────────────────────┘
                                     │  (same DB file, WAL)
                                     ▼
          ┌──────────────────────────────────────────────┐
          │  charon  (trading agent, unchanged loop)        │
          │  ─ drains dashboard_commands each monitor tick │ ◄── executes force-close
          │  ─ hot-reads settings every loop (already does)│
          └──────────────────────────────────────────────┘
```

### 4.1 Why read-mostly, not pure read-only
The operator chose **both** "light controls" and "read-only sidecar." These are reconciled, not in conflict:

- **Heavy/analytics reads** use a `readonly: true` SQLite handle — a dashboard query bug can never corrupt or lock trading data destructively.
- **Pause/resume + strategy switch** are *idempotent settings writes* that the agent already hot-reads every loop (`boolSetting('agent_enabled')`, `activeStrategy()` with a 5s cache). The dashboard writes these directly through a **second, write-enabled handle scoped by code discipline to only `settings`/`strategies`**.
- **Force-close** requires wallet + RPC and therefore **must run inside the trading process**. The dashboard only **enqueues** an intent into a new `dashboard_commands` table; the agent drains and executes it. The dashboard never imports `execution/router.js`, wallet, or RPC code → crash isolation preserved.

### 4.2 Crash isolation guarantee
Dashboard and agent are separate processes/containers. Dashboard OOM, unhandled rejection, or hang **cannot** stop position monitoring. The only shared surface is the SQLite file (WAL) + the command queue.

---

## 5. Write paths (the only mutations the dashboard performs)

### 5.1 Direct settings writes (low risk, hot-read)
| Action | DB effect | Agent pickup |
|---|---|---|
| Pause / Resume | `setSetting('agent_enabled', 'false'\|'true')` | `boolSetting('agent_enabled')` read at `orchestrator.js:116` each batch |
| Switch strategy | `setActiveStrategy(id)` (flips `strategies.enabled`) | `activeStrategy()` 5s-cached read across pipeline |

These mirror exactly what Telegram callbacks already do (`callbacks.js:51`, `setActiveStrategy`). No new agent code needed.

### 5.2 Command queue (force-close — needs the trading process)
New table (created by the **agent** in `initDb()`, not the dashboard):

```sql
CREATE TABLE IF NOT EXISTS dashboard_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at_ms INTEGER NOT NULL,
  kind TEXT NOT NULL,              -- 'force_close'
  payload_json TEXT NOT NULL,      -- { positionId, reason: 'DASHBOARD' }
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | done | failed | rejected
  picked_at_ms INTEGER,
  completed_at_ms INTEGER,
  result_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_dashboard_commands_status
  ON dashboard_commands(status, created_at_ms);
```

- **Dashboard:** inserts a `pending` `force_close` row, returns 202 + the command id; UI polls the row's `status`.
- **Agent:** in the existing position-monitor tick (`monitorPositions()` cadence, `POSITION_CHECK_MS`), drains `pending` rows, calls the existing `closePosition(...)` path, writes `done`/`failed` + `result_json`. This is the single new piece of **agent** code (~30 LOC) and is the only Plan-04 change to the trading process.
- **Idempotency:** agent marks `picked` (`status='picked'`, `picked_at_ms`) before executing so a crash mid-execute doesn't double-sell on next tick; a `picked` row older than N ms is surfaced as `failed`, never auto-retried.

---

## 6. API surface (dashboard process)

All under `/api`, all require `Authorization: Bearer <DASHBOARD_TOKEN>`. JSON envelope: `{ success, data?, error?, meta? }`.

| Method | Path | Source | Notes |
|---|---|---|---|
| GET | `/api/overview` | settings + `daily_risk_metrics`(today) + provider health + last `llm_batches` | single aggregate call for landing |
| GET | `/api/positions?status=open\|closed&limit&offset` | `dry_run_positions` | paginated; `LIMIT` enforced |
| GET | `/api/positions/:id` | `dry_run_positions` + `position_price_snapshots` | detail + sparkline series |
| GET | `/api/funnel?window=1h\|24h\|7d` | `decision_logs` GROUP BY action | window→cutoff ms |
| GET | `/api/decisions?limit&offset` | `decision_logs` ORDER BY at_ms DESC | paginated |
| GET | `/api/signals?window=…` | `signal_events` bucketed | **bounded by `at_ms >= cutoff` + index + LIMIT** |
| GET | `/api/sources` | `signal_source_performance` | |
| GET | `/api/learning` | latest `learning_runs` + active `learning_lessons` | |
| POST | `/api/agent/toggle` | `setSetting('agent_enabled')` | body `{ enabled: bool }` |
| POST | `/api/strategy/active` | `setActiveStrategy(id)` | body `{ id }`, validated against `allStrategies()` |
| POST | `/api/positions/:id/close` | enqueue `dashboard_commands` | 202 + command id |
| GET | `/api/commands/:id` | `dashboard_commands` | UI polls status |

**Mutating endpoints additionally require** a same-token check **and** are rejected unless `TRADING_MODE`-appropriate (e.g. close in `dry_run` returns 409 with explanation).

---

## 7. Tech stack & footprint

Honoring the repo's 7-dependency minimalist ethos:

| Layer | Choice | New dep? |
|---|---|---|
| HTTP server | `node:http` (no framework) | **no** |
| DB access | `better-sqlite3` (already a dep) | **no** |
| Templating | template literals → SSR HTML | **no** |
| Interactivity | **Alpine.js** + **HTMX** via CDN `<script>` (no build step) | no (CDN) |
| Charts | **uPlot** via CDN (tiny, ~40KB, mobile-friendly) | no (CDN) |
| Styling | hand-written mobile-first CSS (single `app.css`, system font stack, CSS vars, dark default) | **no** |
| Tunnel | `cloudflared` (infra binary, not an npm dep) | n/a |

**Zero new npm dependencies.** Front-end libs are pinned CDN URLs (with SRI hashes) so there's still no bundler/build pipeline — consistent with a repo that has none today.

> If offline/air-gapped CDN is a concern, vendored copies of Alpine/HTMX/uPlot can be dropped into `dashboard/public/vendor/` and served statically — noted as a fallback, not the default.

---

## 8. File layout (new, additive — no edits to existing trading modules except §5.2)

```
dashboard/
  server.js            # node:http bootstrap, routing, auth, graceful shutdown
  db.js                # two better-sqlite3 handles: roDb (readonly), rwDb (settings/commands only)
  auth.js              # bearer-token middleware (timing-safe compare)
  queries/
    overview.js
    positions.js
    funnel.js
    signals.js
    sources.js
    learning.js
  actions/
    agent.js           # toggle agent_enabled
    strategy.js        # set active strategy
    commands.js        # enqueue force_close
  views/
    layout.js          # mobile shell: header, bottom tab bar, <head> with CDN libs
    overview.js
    positions.js
    funnel.js
    signals.js
    learning.js
  public/
    app.css
    app.js             # Alpine components, polling, uPlot init

src/execution/dashboardCommands.js   # AGENT side: drainDashboardCommands() — the only new src/ file
```

Agent wiring (minimal):
- `src/db/connection.js`: add `dashboard_commands` table to `initDb()`.
- `src/app.js`: call `drainDashboardCommands()` inside the position-monitor interval (reuses `trackPositions` failure tracker).

Reused (imported by dashboard for parity, read-only): `src/format.js` (`fmtSol`, `fmtUsd`, `fmtPct`, `short`), `src/health/providerHealth.js`, `src/db/sourcePerformance.js`, `src/learning/summary.js`.

---

## 9. Auth & exposure detail

- **Token:** `DASHBOARD_TOKEN` env var (≥32 random bytes). Validated at startup (`validateConfig`-style) — process refuses to boot without it. Compared with `crypto.timingSafeEqual`.
- **Login:** a single password screen sets an HttpOnly, `Secure`, `SameSite=Strict` cookie holding the token; API also accepts the `Authorization` header for programmatic checks. No session store — the cookie *is* the token.
- **Transport:** Cloudflare Tunnel terminates TLS; the dashboard binds `127.0.0.1` only, so it is **unreachable except via the tunnel** even if the container port leaks.
- **Hardening:** rate-limit auth attempts (in-memory token-bucket), `Cache-Control: no-store` on API, no secrets/keys ever rendered (env values are never sent to the client; only derived booleans like "GMGN: on").
- **Secrets:** `DASHBOARD_TOKEN` lives in `.env` (gitignored) and `.env.example` gets a placeholder. Never logged.

---

## 10. Performance & safety constraints

- `signal_events` has **737k+ rows** — every query against it **must** include `at_ms >= cutoff` and rely on a time path. Add `CREATE INDEX IF NOT EXISTS idx_signal_events_at ON signal_events(at_ms)` (additive migration in `initDb()`); existing index is on `mint` only. All list endpoints enforce a hard `LIMIT` (≤200) + offset pagination.
- Dashboard read handle: `new Database(DB_PATH, { readonly: true, fileMustExist: true })` + `db.pragma('busy_timeout = 5000')`.
- Dashboard write handle (settings/commands only): `busy_timeout = 5000`; writes are single-row, sub-millisecond — they cannot block the agent meaningfully under WAL.
- Polling, not websockets, for v1: Overview refreshes every 5s, lists on demand. Keeps the server stateless and the footprint tiny.
- Graceful shutdown: close both DB handles on `SIGTERM`/`SIGINT`.

---

## 11. Deployment

Add a second service to `docker-compose.yml` (uncomment/extend the reserved block):

```yaml
  charon-dashboard:
    build: { context: ., dockerfile: Dockerfile }
    command: node dashboard/server.js
    container_name: charon-dashboard
    restart: unless-stopped
    env_file: [.env]
    environment:
      - DB_PATH=/app/data/charon.db
      - DASHBOARD_PORT=3000
    volumes:
      - charon-data:/app/data    # SAME named volume → same SQLite file, WAL-safe
    networks: [charon-net]

  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel --no-autoupdate run
    environment:
      - TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN}
    depends_on: [charon-dashboard]
    networks: [charon-net]
    restart: unless-stopped
```

- Both containers mount the **same `charon-data` volume** → same DB file. WAL allows the concurrent reader + the agent writer.
- Local/PM2 alternative: `pm2 start dashboard/server.js --name charon-dashboard`.
- `package.json` script: `"dashboard": "node dashboard/server.js"` and extend `check` to `node --check dashboard/server.js`.

---

## 12. Audit (per implementation-plan rules)

### Layer 1 — Correctness / immutability
- [ ] All query functions return **new** plain objects; no mutation of better-sqlite3 row objects.
- [ ] Optional numeric fields (`pnl_percent`, `avg_latency_ms`, `entry_mcap`) guarded with `Number.isFinite` / `?? 0` before arithmetic — mirror existing `commands.js` PnL handling.
- [ ] No secret env value crosses the API boundary; only derived booleans.

### Layer 2 — Library/API accuracy
- [ ] `better-sqlite3` readonly handle: `new Database(path, { readonly: true, fileMustExist: true })` (verified option names).
- [ ] `busy_timeout` set via `db.pragma('busy_timeout = 5000')` (pragma, not constructor).
- [ ] `crypto.timingSafeEqual` requires equal-length Buffers → hash both sides before compare.
- [ ] uPlot/Alpine/HTMX pinned to specific CDN versions with SRI integrity attributes.

### Layer 3 — Error path & lifecycle
- [ ] Server boots without DB present? No — `fileMustExist: true` → fail fast with clear message.
- [ ] Both DB handles closed on shutdown; partial-failure close still closes the other.
- [ ] Every route wrapped: unknown route → 404 JSON; thrown error → 500 JSON, never leak stack to client.
- [ ] `dashboard_commands`: `picked` guard prevents double-sell on agent crash; stale `picked` → `failed`, no auto-retry.
- [ ] HTTP server `error` event handled (EADDRINUSE → clear message).

### Layer 4 — Internal consistency
- [ ] Every §3 screen maps to a §6 endpoint maps to a §8 query module.
- [ ] Every mutating endpoint (§6) maps to a §5 write path with defined agent pickup.
- [ ] Terminology: "force-close" = `force_close` command kind everywhere.

### Layer 5 — Usage examples valid
- [ ] Compose snippet uses the existing `charon-data` volume name (verified in current `docker-compose.yml`).
- [ ] Env var names match `.env` (`DB_PATH=/app/data/charon.db` confirmed).

### Layer 6 — Defaults explicit
- [ ] `DASHBOARD_PORT` default `3000`, bind host default `127.0.0.1` (documented in code comment).
- [ ] Poll interval `5000ms`, list `LIMIT` `100` (max `200`) — explicit constants.

### Layer 7 — Concurrency
- [ ] Dashboard write + agent write to `settings`: last-write-wins is acceptable (same semantics as Telegram today); documented.
- [ ] `dashboard_commands` drain is single-process (agent only) → no concurrent drain.
- [ ] `activeStrategy()` 5s cache means a web strategy-switch takes ≤5s to take effect — documented as expected.

### Layer 8 — Known limitations
- [ ] Unrealized PnL for open positions is as-of the **last `position_price_snapshots` row**, not live-quoted by the dashboard (dashboard has no RPC). Staleness = `POSITION_CHECK_MS`.
- [ ] Force-close latency = up to one `POSITION_CHECK_MS` tick (queue drain cadence).
- [ ] No web approval for `confirm` mode in v1.
- [ ] Single shared token = no per-user audit trail.

### Layer 9 — Portability
- [ ] Dashboard imports from `src/` are **read-only helpers only** (format, providerHealth, sourcePerformance, summary) — no execution/wallet/RPC imports. Verify with grep before merge.

---

## 13. Build sequence (suggested issues / phases)

1. **DB additive migration** (agent side): `dashboard_commands` table + `idx_signal_events_at` in `initDb()`. Verify `npm run check`.
2. **Dashboard skeleton:** `server.js` + `db.js` (readonly handle) + `auth.js` + health-check route. Boots, serves Overview JSON behind token.
3. **Read endpoints + screens:** Overview → Positions → Funnel → Signals → Learning (in that order; Overview proves the data path).
4. **Mobile shell & charts:** `layout.js`, `app.css`, uPlot sparklines/bars, bottom-tab navigation.
5. **Controls:** agent toggle + strategy switch (settings writes) → force-close queue + agent drain (`dashboardCommands.js`, `app.js` wiring).
6. **Auth hardening:** cookie login, rate-limit, timing-safe compare, `validateConfig` for `DASHBOARD_TOKEN`.
7. **Deploy:** compose services + Cloudflare Tunnel + `.env.example` entries + README section.

Each phase is independently shippable; phases 1–4 deliver a fully useful **read-only** dashboard before any write path exists.

---

## 14. Open questions for next session
- Cloudflare account/tunnel already provisioned, or should the plan include `cloudflared tunnel create` bootstrap steps?
- Confirm `data/charon.db` (1.6GB) is the production DB the dashboard should read (vs `charon.sqlite`) — appears so from `.env` `DB_PATH=/app/data/charon.db`.
- Acceptable to add the **one** agent-side change (§5.2 drain) in this plan, or should force-close ship in a follow-up so v1 is 100% read-only on the agent process?
