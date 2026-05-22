# Epic 6 Result: Signal Quality and Source Performance

## Status: ✅ COMPLETED

## Summary
Implemented all 6 tasks for Epic 6 - Signal Quality and Source Performance tracking system.

## What Was Done

### Task 6.1: Create signal_source_performance table ✅
- Added `signal_source_performance` table in `src/db/connection.js`
- Tracks: total_signals, successful_signals, failed_signals, avg_time_to_close_ms, avg_pnl_percent, win_rate_percent
- Unique constraint on (source, signal_type)
- Index on source for fast lookups

### Task 6.2: Add signal_age_ms to candidates ✅
- Added `signal_age_ms` column to candidates table via `ensureColumn()`
- Column type: INTEGER
- Location: `src/db/connection.js` line 223

### Task 6.3: Update source performance on close ✅
- Created `src/db/sourcePerformance.js` module with:
  - `updateSourcePerformanceOnClose(position, candidate)` - updates metrics when position closes
  - Calculates win rate, average PnL, average time-to-close
  - Handles both new sources and updates to existing ones
- Integrated into `src/execution/positions.js`:
  - Called on live sell (line 211-213)
  - Called on auto-exit (line 229-231)
  - Extracts candidate from position.snapshot_json

### Task 6.4: Compute reliability score ✅
- Implemented `computeSourceReliabilityScore(source, signalType)` in `src/db/sourcePerformance.js`
- Scoring formula (0-100):
  - Win rate: 0-50 points (50% = 25pts, 100% = 50pts)
  - Average PnL: 0-30 points (5% avg = 30pts, scales linearly)
  - Sample size: 0-20 points (20+ signals = 20pts)
  - Time consistency: 0-10 points (penalizes very slow >1h or very fast <5min)
- Aggregates across signal types when not filtering

### Task 6.5: Create /source_stats command ✅
- Added `/source_stats` command in `src/telegram/commands.js`
- Displays for each source:
  - Reliability score (0-100)
  - Total signals (wins/losses)
  - Win rate %
  - Average PnL %
  - Average time to close (hours)
- Shows "No data yet" message if no positions closed

### Task 6.6: Add source reliability to LLM context ✅
- Updated `compactCandidateForLlm()` in `src/pipeline/llm.js`
- Computes `source_reliability_score` for each candidate
- Added to `signals` object in LLM prompt
- LLM now sees reliability score (0-100) for each signal source

## Files Created/Modified

| File | Purpose |
|------|---------|
| src/db/connection.js | Added signal_source_performance table, signal_age_ms column |
| src/db/sourcePerformance.js | NEW - Source performance tracking module |
| src/execution/positions.js | Integrated source performance updates on close |
| src/telegram/commands.js | Added /source_stats command |
| src/pipeline/llm.js | Added source reliability to LLM context |

## Test Output

```bash
✓ All syntax OK
node --check src/db/connection.js src/db/sourcePerformance.js src/execution/positions.js src/telegram/commands.js src/pipeline/llm.js
```

## Git Commits

```
ec3a21d feat(epic-6): Add sourcePerformance module, positions tracking, /source_stats command
3dffc61 feat(epic-6): Signal Quality and Source Performance
```

## Verification

- Schema migration: signal_source_performance table will be created on next bot restart
- signal_age_ms column will be added to candidates table
- Source performance tracking will activate when positions close
- /source_stats command available immediately
- LLM will receive reliability scores in next decision batch

## Notes

- Source performance data accumulates over time as positions close
- Reliability score requires at least 1 closed position per source
- Score formula balances win rate, profitability, and sample size
- LLM can now factor source reliability into buy decisions
