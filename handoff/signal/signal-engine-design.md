# Signal Engine — Design Doc

**Status:** Draft v1 · **Date:** 2026-06-15 · **Owner:** charon maintainer
**Goal:** Build a self-owned signal engine to replace the third-party provider
(`api.thecharon.xyz`) that currently feeds charon via `GET /api/signals`.

---

## 1. Context & Motivation

### 1.1 What the third-party provider does today

Charon consumes signals from an external aggregation service. The full contract
is reverse-engineered from the consumer (`src/signals/serverClient.js`):

```
GET {SIGNAL_SERVER_URL}/api/signals?limit=100&minSources=2
Headers: x-api-key: {SIGNAL_SERVER_KEY}
→ 200 { signals: CanonicalSignal[] }
```

The provider performs five jobs:

| # | Job | Evidence in charon | Local equivalent already owned |
|---|-----|--------------------|--------------------------------|
| 1 | **Ingestion** — pull from many sources | `signal.sources[]`, `sourceCount` | `src/signals/graduated.js`, `trending.js`, `feeClaim.js` |
| 2 | **Fusion** — merge one mint seen by N sources | `minSources=2`, `signalKey = mint:sources` | ❌ **missing — must build** |
| 3 | **Enrichment** — holders, vol5m/24h, mcap, liq, age, ATH dist | `signal.holders`, `volume5m`, `distanceFromAthPercent` | partial: `src/enrichment/{gmgn,jupiter,wallets}.js` |
| 4 | **Dedup + TTL** | server-side, opaque | pattern owned: `seenSignals` / `prune` |
| 5 | **Serving** — HTTP + API key + paging | `GET /api/signals?limit&minSources` | ❌ **missing — must build** |

**Conclusion:** this is not a from-scratch build. ~80% of ingestion/enrichment
already exists in charon's standalone mode (`src/app.js:44-61`). The genuinely
new work is **Fusion** + **Serving**.

### 1.2 Design decisions (locked)

From requirements review:

| Decision | Choice | Consequence |
|----------|--------|-------------|
| **Scale** | Self-hosted, several of my own bots/strategies | Separate service + static API key. No billing, no tenant isolation, no per-user rate limiting. |
| **Latency** | Polling 30–60s acceptable | **No** stream processing, backpressure, WS *server*, or message queue in v1. Engine polls sources; charon polls engine. |
| **Deployment** | Separate service (drop-in) | Own container exposing `/api/signals`. Swap `SIGNAL_SERVER_URL` → my instance. `serverClient.js` is **not modified**. Independent scale/restart. |

### 1.3 Guiding principle: **preserve the contract, replace the body**

The single most important architectural decision is that the engine is a
**drop-in replacement** that reproduces the `/api/signals` contract
byte-compatibly. Charon already branches on server-mode vs standalone-mode
(`src/app.js:22`), so the seam exists. Cutover is one env var:
`SIGNAL_SERVER_URL=https://my-engine.internal/api`.

This also means "single-tenant v1" produces **zero throwaway work**: if this
later becomes a product (multi-tenant), Fusion + Normalize + Store + Enrich are
all reused; only the serving/auth layer grows.

---

## 2. Architecture Overview

```
┌─────────────────────── SIGNAL ENGINE (new service) ───────────────────────┐
│                                                                            │
│  INGESTION          NORMALIZE        FUSION          ENRICH       SERVE     │
│  ┌──────────┐       ┌─────────┐    ┌──────────┐   ┌─────────┐  ┌────────┐  │
│  │ pump.fun │──┐    │ map to  │    │ group by │   │ holders │  │ GET    │  │
│  │ graduated│  │    │ canon   │    │ mint     │   │ vol/liq │  │ /api/  │  │
│  ├──────────┤  ├──▶ │ schema  │──▶ │ +        │──▶│ mcap    │─▶│ signals│  │
│  │ trending │  │    │ (1 row) │    │ sourceCnt│   │ age/ATH │  │        │  │
│  │ jup/gmgn │  │    └─────────┘    │ + dedup  │   │ rug/bndl│  │ +cache │  │
│  ├──────────┤  │                   └──────────┘   └─────────┘  └────────┘  │
│  │ fee claim│──┘         raw store ──▶ [signal_events (SQLite)]            │
│  │ (WS→poll)│                                                              │
│  └──────────┘                                                              │
└────────────────────────────────────────────────────────────────────────────┘
                                                          │
                                                          ▼  HTTP (same contract)
                                              ┌────────────────────────┐
                                              │  CHARON (unchanged)     │
                                              │  serverClient.js → LLM  │
                                              │  → scoring → execution  │
                                              └────────────────────────┘
```

### 2.1 Stack

**Node 20 + better-sqlite3 + axios + ws** — identical to charon. Zero new
dependencies, zero learning curve. Three source adapters copy directly from
`src/signals/`. Consistent with the zero-deps discipline already held in
`dashboard/`.

### 2.2 Module layout

```
charon-signals/                  # separate folder/repo, deployed as 2nd container
├── index.js                     # boot: schedule pollers + start HTTP server
├── config.js                    # env: API key, poll intervals, source toggles, TTL
├── sources/                     # ADAPTERS — one file per source, uniform interface
│   ├── _registry.js             #   active adapters (env-toggled)
│   ├── pumpGraduated.js         #   ← port of src/signals/graduated.js
│   ├── jupTrending.js           #   ← port of src/signals/trending.js
│   ├── feeClaim.js              #   ← port of src/signals/feeClaim.js (WS, internal)
│   └── (axiom.js, birdeye.js…   #   adding a source = adding one file here)
├── normalize.js                 # each RawSignal → CanonicalSignal fields
├── fusion.js                    # ★ NEW: group-by-mint, sourceCount, TTL window
├── enrich.js                    # holders/vol5m/mcap/liq/ageMs/athDist (+ cache)
├── store.js                     # SQLite: raw signal_events + fusion snapshot
└── server.js                    # GET /api/signals?limit&minSources (+ x-api-key)
```

File-size budget per repo convention: 200–400 lines typical, 800 max. Fusion and
enrich are the only modules likely to approach 300.

---

## 3. The Contract (authoritative)

This is the law. Every field below is consumed by `serverClient.js`; a missing
or misnamed field causes charon to **silently skip or misroute** — not throw.
Field references cite the exact consumer line.

### 3.1 CanonicalSignal schema

```js
// GET /api/signals?limit=100&minSources=2  →  { signals: CanonicalSignal[] }
CanonicalSignal = {
  // ── identity ──
  mint:            string,      // REQUIRED. serverClient.js:56 skips if absent
  name:            string,      // serverClient.js:67,77
  symbol:          string,      // serverClient.js:68,78 (→ ticker/symbol)

  // ── fusion output (★ engine-computed, not from any single source) ──
  sources:         string[],    // serverClient.js:86,98 — e.g. ['jup_trending','pump_fee']
  sourceCount:     number,      // serverClient.js:106,109 — gate: min_source_count

  // ── market metrics (enrichment) ──
  priceUsd:        number,      // serverClient.js:79,156
  marketCapUsd:    number,      // serverClient.js:69,80
  liquidityUsd:    number,      // serverClient.js:81
  volume5m:        number,      // serverClient.js:83 (preferred for trending.volume)
  volume24h:       number,      // serverClient.js:69,83 (fallback)
  holders:         number,      // serverClient.js:82 (→ holder_count)
  ageMs:           number,      // serverClient.js:116 — gate: token_age_max_ms

  // ── per-source sub-objects (null when that source didn't fire) ──
  trending: {                   // serverClient.js:74-90
    buys:          number,      // serverClient.js:85 — swaps = buys + sells
    sells:         number,      // serverClient.js:85
    // …any extra trending fields spread last (serverClient.js:88)
  } | null,

  graduated: {                  // serverClient.js:60-71
    distanceFromAthPercent: number,  // serverClient.js:148 — wait_for_dip strategy
    // …other graduated fields preserved verbatim
  } | null,

  feeClaim: {                   // serverClient.js:105,133-143
    distributedSol: number,     // serverClient.js:136 — *SOL units*, engine converts
    signature:      string,     // serverClient.js:142
    shareholders: [{ address: string, bps: number }],  // serverClient.js:137-140
  } | null,
}
```

### 3.2 Field precedence rules (when sources disagree)

When two sources report the same field for one mint, the merge MUST be
deterministic. **Do not rely on object-spread order** — that exact bug existed at
`serverClient.js:88` and silently overrode computed `swaps`. Explicit precedence:

| Field | Winner (highest → lowest) | Rationale |
|-------|---------------------------|-----------|
| `priceUsd`, `marketCapUsd`, `liquidityUsd` | Jupiter/GMGN enrichment > trending feed > graduated snapshot | Enrichment is freshest & purpose-built |
| `holders` | GMGN > Jupiter holders > trending | GMGN most complete |
| `volume5m` | trending feed (native window) > enrichment | Source has the real 5m window |
| `ageMs` | graduation timestamp > first-seen | On-chain truth beats observation time |
| `distanceFromAthPercent` | enrichment chart context > graduated payload | Chart is continuously updated |
| `feeClaim.*` | fee-claim source only | Single authoritative source |

Encode precedence as an **explicit ordered merge** in `fusion.js`, not via spread.

### 3.3 Units & conversions (verified against consumer)

- `feeClaim.distributedSol` is **SOL** (float). Charon re-multiplies by 1e9 to
  lamports (`serverClient.js:136`). Engine must emit SOL, not lamports.
- `shareholders[].bps` is **basis points** (h.bps, `serverClient.js:139`).
- `swaps` is **not** sent directly; charon derives it as `buys + sells`
  (`serverClient.js:85`). Engine emits `trending.buys` / `trending.sells`.
- `ageMs` is a **duration**, not a timestamp (`serverClient.js:116` compares to
  `token_age_max_ms`).

### 3.4 Query parameters

| Param | Used by consumer | Engine behavior |
|-------|------------------|-----------------|
| `limit` | `serverClient.js:38` (=100) | Cap returned array length after sort |
| `minSources` | `serverClient.js:39` (=2) | Drop mints with `sourceCount < minSources` **before** limit |

### 3.5 Auth

`x-api-key` header (`serverClient.js:43`). Single static key compared against
`SIGNAL_ENGINE_API_KEY` env. Missing/wrong → `401`. (Consumer sends the header
only when `SIGNAL_SERVER_KEY` is set, so engine must also accept no-key in a
dev/local toggle — gate via `SIGNAL_ENGINE_REQUIRE_KEY=true|false`.)

---

## 4. Component Design

### 4.1 Source adapters — uniform interface

Every source becomes a module with the same contract (mirrors the existing
`setCandidateHandler` inversion in charon):

```js
/**
 * @typedef {Object} SourceAdapter
 * @property {string}  name              // 'pump_graduated' | 'jup_trending' | 'pump_fee'
 * @property {'poll'|'stream'} mode
 * @property {number}  [pollMs]          // required when mode==='poll'
 * @property {() => Promise<RawSignal[]>} fetch   // poll mode
 * @property {(emit: (s: RawSignal) => void) => void} [start]  // stream mode (feeClaim WS)
 */
```

- `pumpGraduated.js` / `jupTrending.js` → `mode:'poll'`, ported from charon
  `graduated.js` / `trending.js` near-verbatim.
- `feeClaim.js` → internally `mode:'stream'` (Helius WS, ported from charon
  `feeClaim.js`), but the **service** still serves over polling. The WS only
  feeds the in-memory fusion store; it does not push to charon.
- `_registry.js` exports the active adapter list, toggled by env
  (`SOURCE_PUMP_GRADUATED=true`, etc.) so a flaky source can be disabled without
  a deploy.

**RawSignal** (adapter output, pre-normalize): whatever the source natively
returns, plus `{ __source: name, __seenAt: now() }`.

### 4.2 Normalizer

`normalize.js` maps each `RawSignal` → partial `CanonicalSignal` (identity +
metrics + the one relevant sub-object). One pure function per source keeps the
messy per-API mapping (cf. `axiomSource.js:24-52` vs `serverClient.js:74-89`) in
one auditable place.

```js
// normalize.js
export function normalize(raw) {
  switch (raw.__source) {
    case 'pump_graduated': return fromGraduated(raw);
    case 'jup_trending':   return fromTrending(raw);
    case 'pump_fee':       return fromFeeClaim(raw);
    default: return null;   // unknown source dropped, logged
  }
}
// each fromX returns { mint, partialFields…, sourceName } — pure, no I/O
```

Validation at this boundary (per coding-style "validate at system boundaries"):
drop rows without `mint`; coerce numerics with `Number.isFinite` guards; never
trust source shape.

### 4.3 Fusion engine — ★ the only genuinely new component

**State** (in-memory, rebuilt from `signal_events` on boot):

```js
// Map<mint, MintAggregate>
MintAggregate = {
  firstSeen: number,
  sources: Map<sourceName, { fields: PartialCanonical, seenAt: number }>,
}
```

**On each normalized signal:**

```
upsert:  agg = state.get(mint) ?? { firstSeen: now, sources: new Map() }
         agg.sources.set(sourceName, { fields, seenAt: now })
         state.set(mint, agg)
```

**Pruning (two levels):**

```
1. source-entry prune: drop sources[s] where now - seenAt > SIGNAL_TTL_MS
2. mint prune:         drop mint where sources.size === 0
```

**On `GET /api/signals?minSources=M&limit=L`:**

```
for each mint in state:
  prune stale source-entries first
  sourceCount = sources.size
  if sourceCount < M: skip                       // makes minSources=2 work
  merged = orderedMerge(sources, PRECEDENCE)     // §3.2 — explicit, not spread
  merged.sources     = [...sources.keys()]
  merged.sourceCount = sourceCount
  merged.ageMs       = computeAgeMs(merged, firstSeen)   // graduation ts > firstSeen
  collect(merged)
sort by (sourceCount desc, volume5m desc, recency desc)
return { signals: collected.slice(0, L) }
```

**Two tuning levers that decide engine quality vs the old provider:**

1. **`SIGNAL_TTL_MS` (the fusion window).** Too short → fusion rarely reaches 2
   sources → dry signal feed → the **0-position symptom** diagnosed on 2026-06-14
   (`.remember`: funnel kills at filter). Too long → stale mints served. **Start
   at 10 min** (aligns with `TRENDING_LOOKBACK_MS=600000`), then tune from
   `signal_events` replay.
2. **Precedence (§3.2).** Wrong winner → charon filters on bad mcap/liq. Encode
   explicitly; unit-test the disagreement cases.

### 4.4 Enrichment layer

`enrich.js` fills fields no single ingestion source provides:
`distanceFromAthPercent`, `volume5m`, `ageMs`, and the metrics needed by
charon's `filterCandidate` (`candidateBuilder.js:31-120`: mcap, liquidityUsd,
holders, rug_ratio, bundler_rate).

- Reuse charon's enrichment code (`enrichment/gmgn.js`, `jupiter.js`) — port,
  don't rewrite.
- **Cache aggressively** (charon already defines `GMGN_CACHE_TTL_MS=300000`).
  Enrichment is the rate-limit risk: GMGN 403/429 backoff already handled in
  `gmgn.js` (`gmgnBackoffActive`/`setGmgnBackoff`) — port that too.
- Enrich **lazily**: only enrich mints that already passed `minSources` in
  fusion, never the whole ingestion firehose. This bounds API spend to the
  multi-source set, which is small.

### 4.5 Store

`store.js` — SQLite via better-sqlite3, schema mirrors charon for replay parity:

```sql
CREATE TABLE IF NOT EXISTS signal_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  kind TEXT NOT NULL,           -- 'trending' | 'fee_claim' | 'graduated'
  at_ms INTEGER NOT NULL,
  source TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signal_events_mint ON signal_events(mint);
CREATE INDEX IF NOT EXISTS idx_signal_events_at   ON signal_events(at_ms);
```

(Identical to `src/db/connection.js:149-156` so existing learning/replay tooling
reads it unchanged.) Raw events are the source of truth; the fusion snapshot is a
derived in-memory view and may also be persisted as a `signal_snapshots` table
for cold-boot warm-up (optional v1).

### 4.6 Serving layer

`server.js` — Node `http` (no Express, zero-deps), one route:

```
GET /api/signals?limit&minSources   → fusion.serve(limit, minSources)
GET /healthz                         → { ok, sources: {name: lastFetchAge}, mints }
```

- API-key check middleware (§3.5).
- Response is the cached fusion snapshot; recompute on a short interval
  (e.g. every 5s) or on-demand with a 5s memo — serving must not block on
  enrichment.
- Bind loopback + reverse proxy, same posture as dashboard
  (`DASHBOARD_HOST=127.0.0.1`).

---

## 5. Configuration (env)

```bash
# Serving
SIGNAL_ENGINE_HOST=127.0.0.1
SIGNAL_ENGINE_PORT=3456
SIGNAL_ENGINE_API_KEY=                 # static key; charon's SIGNAL_SERVER_KEY must match
SIGNAL_ENGINE_REQUIRE_KEY=true

# Fusion
SIGNAL_TTL_MS=600000                   # 10 min fusion window (tune from replay)
SIGNAL_SNAPSHOT_REFRESH_MS=5000        # how often the served snapshot recomputes

# Sources (toggles)
SOURCE_PUMP_GRADUATED=true
SOURCE_JUP_TRENDING=true
SOURCE_PUMP_FEE=true
GRADUATED_POLL_MS=30000
TRENDING_POLL_MS=60000

# Enrichment (reused from charon)
GMGN_ENABLED=true
GMGN_API_KEY=
GMGN_CACHE_TTL_MS=300000
JUPITER_API_KEY=
HELIUS_API_KEY=                        # WS for fee-claim source
DB_PATH=/app/data/signals.db
```

Charon side — the **only** change, no code:

```bash
SIGNAL_SERVER_URL=http://signal-engine:3456   # was https://api.thecharon.xyz/api
SIGNAL_SERVER_KEY=<same as SIGNAL_ENGINE_API_KEY>
```

---

## 6. Build Plan (each phase ships & tests independently)

| Phase | Output | Validation gate |
|-------|--------|-----------------|
| **0. Capture** | Record 1–2h of old provider responses → `fixtures/signals.json` | Have ground-truth shape before touching anything |
| **1. Skeleton serve** | `server.js` serves the static fixture at `/api/signals` | Point charon `SIGNAL_SERVER_URL` at engine → full pipeline runs on recorded data. **Decoupled from provider from here on.** |
| **2. Port adapters** | 3 adapters + `normalize.js` populate `signal_events` live | Mints ingested vs fixture overlap |
| **3. Fusion** | `fusion.js` produces live `sources[]`/`sourceCount` | `minSources=2` returns real multi-source mints |
| **4. Enrich** | Fill `athDist`/`vol5m`/`ageMs`/mcap/liq/holders | **Parity test**: field-by-field diff vs fixture |
| **5. Cutover** | Swap env, disable old provider | Monitor dashboard funnel 24h; compare entry rate |

Phase 1 is the strategic unlock: once the engine serves the fixture, you are
already independent of the provider for testing, and every later phase only adds
realism — there is **never a big-bang risky moment**.

### 6.1 Parity test (Phase 4 gate) — reuse existing harness

`scripts/e2e-dryrun.mjs` already observes the pipeline with a real signal. Extend
it: fetch from old provider AND new engine for the same window, diff each
`CanonicalSignal` field. Any mismatch in §3.1 fields is a blocker. This is the
defense against the silent-skip/misroute risk.

---

## 7. Out of Scope (v1) — explicit, to prevent scope creep

Deliberately NOT built, per locked decisions (§1.2):

- WebSocket/SSE **push** to charon (polling only; WS is internal to fee-claim ingest)
- Rate limiter / quota
- Multi-tenant auth, per-user keys, billing
- Horizontal scaling / clustering (single instance, in-memory fusion)
- Historical signal API / backtesting endpoints (raw `signal_events` is enough)

If this later becomes a product (the multi-tenant option), Fusion + Normalize +
Store + Enrich are reused unchanged; only Serving + Auth grow. **No throwaway work.**

---

## 8. Known Risks & Edge Cases

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Field name/shape drift** | Charon silently skips/misroutes — no error | §3 contract is authoritative + Phase-4 parity test (§6.1) |
| **Spread-order override** | Computed field clobbered (real past bug `serverClient.js:88`) | §3.2 explicit ordered merge, unit-tested |
| **TTL too short** | Dry feed → 0 positions (2026-06-14 symptom) | Start 10 min, tune from replay; `/healthz` exposes mint count |
| **GMGN 429/403** | Enrichment stalls | Port `gmgnBackoff`; enrich only post-`minSources` set (§4.4) |
| **Cold boot empty fusion** | First ~TTL minutes serve few multi-source mints | Optional `signal_snapshots` warm-up table; accept short ramp otherwise |
| **WS reconnect gaps (fee-claim)** | Missed fee events | Port charon's auto-reconnect (`feeClaim.js:98-103`) |
| **Snapshot recompute under load** | Serving blocks on enrichment | Serve cached snapshot; recompute off the request path (§4.6) |
| **`ageMs` ambiguity** | Wrong `token_age_max_ms` gating | §3.3: duration not timestamp; graduation ts > first-seen |

### 8.1 Concurrency note

Single Node process, in-memory fusion `Map`. Poll callbacks and the HTTP handler
share `state`. Node is single-threaded per event-loop tick, but an `await` inside
a poll-cycle mutation creates a window where the snapshot reads a half-updated
mint. Mitigation: mutate `state` synchronously per normalized signal (no `await`
between `get` and `set`), do all `await` (enrichment) outside the mutation, and
recompute the served snapshot atomically (build new array, swap reference).

---

## 9. Open Questions (resolve before Phase 3)

1. **Exact `graduated` sub-object fields** the old provider sends beyond
   `distanceFromAthPercent` — capture in Phase 0 to avoid guessing.
2. **`volume5m` source** — does Jupiter trending expose a native 5m window, or
   must it be computed from successive polls? Affects enrich complexity.
3. **Snapshot persistence** — is a ~10-min cold-boot ramp acceptable, or is the
   `signal_snapshots` warm-up table worth building in v1?
4. **Fusion sort tie-break** — confirm charon doesn't depend on a specific order
   beyond what `recentEligibleCandidates` re-sorts anyway.

---

## 10. Self-Audit (implementation-plan rules)

- **Type/shape correctness** — §3.1 every consumed field mapped to its
  `serverClient.js` line; optional sub-objects (`trending`/`graduated`/`feeClaim`)
  explicitly nullable.
- **Library API accuracy** — units verified against consumer (SOL not lamports
  §3.3; `swaps`=buys+sells; `ageMs` duration not timestamp).
- **Error path / lifecycle** — §8 covers WS reconnect, GMGN backoff, cold boot,
  snapshot-under-load; adapter toggles allow disabling a failing source.
- **Internal consistency** — contract (§3) ↔ components (§4) ↔ build phases (§6)
  ↔ risks (§8) cross-reference the same field set.
- **Defaults explicit** — §5 every env has a default value stated.
- **Race conditions** — §8.1 documents the snapshot/poll window and the
  sync-mutate / atomic-swap mitigation.
- **Known limitations** — §7 out-of-scope + §9 open questions.
- **Portability** — engine imports nothing from charon at runtime; shared logic
  is **ported** (copied), dependencies injected via env. Standalone repo.
