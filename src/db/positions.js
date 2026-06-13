import { db } from './connection.js';
import { now, json, computeStrategyHash } from '../utils.js';
import { numSetting, boolSetting, setting, activeStrategy } from './settings.js';
import { fetchSolUsdPrice } from '../enrichment/jupiter.js';
import { resolveTierProfile } from '../execution/tiers.js';

export function openPositions() {
  return db.prepare('SELECT * FROM dry_run_positions WHERE status = ? ORDER BY opened_at_ms DESC').all('open');
}

export function openPositionCount() {
  return db.prepare('SELECT COUNT(*) AS count FROM dry_run_positions WHERE status = ?').get('open').count;
}

export function tierOpenCount(tier) {
  return db.prepare("SELECT COUNT(*) AS count FROM dry_run_positions WHERE tier = ? AND status = 'open'").get(tier).count;
}

export function hasOpenPositionForMint(mint) {
  return Boolean(db.prepare("SELECT 1 FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1").get(mint));
}

export function canOpenMorePositions() {
  const strat = activeStrategy();
  const max = strat.max_open_positions ?? numSetting('max_open_positions', 3);
  if (max <= 0) return true;
  return openPositionCount() < max;
}

export function tradingMode() {
  const mode = setting('trading_mode', 'dry_run');
  return ['dry_run', 'confirm', 'live'].includes(mode) ? mode : 'dry_run';
}

export function allPositions(limit = 10) {
  return db.prepare('SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT ?').all(limit);
}

export function createDryRunPosition(candidateId, candidate, decision, reason = 'llm_buy') {
  const strat = activeStrategy();
  const strategyVersionHash = computeStrategyHash(strat);
  // Tier execution profile drives sizing/TP/SL/trailing/partial. Defensive
  // classification covers paths that skip refreshCandidateForExecution.
  const { tier, profile } = resolveTierProfile(candidate);
  const sizeSol = profile.position_size_sol ?? strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
  // Guard 4: prefer slippage-aware entry from the pre-trade buy quote when available
  // (attached as candidate.executionQuote by enforceEntryGuards); fall back to snapshot.
  const eq = candidate.executionQuote || null;
  const entryPrice = Number(eq?.entryPriceWithSlippage || candidate.metrics.priceUsd || 0) || null;
  const tokenAmountEst = eq?.tokenAmountRaw != null && Number.isFinite(Number(eq.tokenAmountRaw))
    ? Number(eq.tokenAmountRaw)
    : null;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  const tp = Number(profile.tp_percent ?? decision.suggested_tp_percent ?? strat.tp_percent ?? numSetting('default_tp_percent', 50));
  const sl = Number(profile.sl_percent ?? decision.suggested_sl_percent ?? strat.sl_percent ?? numSetting('default_sl_percent', -25));
  const trailingEnabled = (profile.trailing_enabled ?? strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = profile.trailing_percent ?? strat.trailing_percent ?? numSetting('default_trailing_percent', 20);
  const partialTp = profile.partial_tp ? 1 : 0;
  const partialTpAt = Number(profile.partial_tp_at_percent ?? 0);
  const partialTpSell = Number(profile.partial_tp_sell_percent ?? 0);

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return existing.id;

    // Per-tier slot cap (race-safe inside the transaction). Returns null sentinel
    // so callers can distinguish "tier full" from "duplicate mint".
    if (profile.max_open_positions > 0) {
      const tierOpen = db.prepare("SELECT COUNT(*) AS c FROM dry_run_positions WHERE tier = ? AND status = 'open'").get(tier).c;
      if (tierOpen >= profile.max_open_positions) return null;
    }

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id, strategy_id, strategy_version_hash,
        tier, partial_tp, partial_tp_at_percent, partial_tp_sell_percent, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      tokenAmountEst,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      decision.id || null,
      strat.id,
      strategyVersionHash,
      tier,
      partialTp,
      partialTpAt,
      partialTpSell,
      json({ candidate, decision, reason, strategy: strat.id, tier, tierProfile: profile }),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, tokenAmountEst, reason, json({ candidateId, decision, tier }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return positionId;
  })();
}

export async function createLivePosition(candidateId, candidate, decision, swap, reason = 'live_buy') {
  const strat = activeStrategy();
  const strategyVersionHash = computeStrategyHash(strat);
  const { tier, profile } = resolveTierProfile(candidate);
  const sizeSol = profile.position_size_sol ?? strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
  // Guard 4: compute the REAL entry price from the executed swap (SOL spent /
  // tokens received), not the pre-trade snapshot. Falls back to snapshot if the
  // swap or SOL/USD price is unavailable.
  const snapshotPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const tokensReceived = swap?.outputAmount != null && Number.isFinite(Number(swap.outputAmount))
    ? Number(swap.outputAmount)
    : null;
  const solSpent = swap?.inputAmount != null && Number.isFinite(Number(swap.inputAmount))
    ? Number(swap.inputAmount) / 1e9
    : sizeSol;
  let entryPrice = snapshotPrice;
  if (tokensReceived && tokensReceived > 0) {
    const solUsd = await fetchSolUsdPrice();
    if (Number.isFinite(Number(solUsd)) && Number(solUsd) > 0) {
      entryPrice = (solSpent * Number(solUsd)) / tokensReceived;
    }
  }
  const tokenAmountEst = tokensReceived;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  const tp = Number(profile.tp_percent ?? decision.suggested_tp_percent ?? strat.tp_percent ?? numSetting('default_tp_percent', 50));
  const sl = Number(profile.sl_percent ?? decision.suggested_sl_percent ?? strat.sl_percent ?? numSetting('default_sl_percent', -25));
  const trailingEnabled = (profile.trailing_enabled ?? strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = profile.trailing_percent ?? strat.trailing_percent ?? numSetting('default_trailing_percent', 20);
  const partialTp = profile.partial_tp ? 1 : 0;
  const partialTpAt = Number(profile.partial_tp_at_percent ?? 0);
  const partialTpSell = Number(profile.partial_tp_sell_percent ?? 0);

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return existing.id;

    if (profile.max_open_positions > 0) {
      const tierOpen = db.prepare("SELECT COUNT(*) AS c FROM dry_run_positions WHERE tier = ? AND status = 'open'").get(tier).c;
      if (tierOpen >= profile.max_open_positions) return null;
    }

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id,
        execution_mode, entry_signature, token_amount_raw, strategy_id, strategy_version_hash,
        tier, partial_tp, partial_tp_at_percent, partial_tp_sell_percent, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'live', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      tokenAmountEst,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      decision.id || null,
      swap.signature,
      swap.outputAmount || null,
      strat.id,
      strategyVersionHash,
      tier,
      partialTp,
      partialTpAt,
      partialTpSell,
      json({ candidate, decision, reason, swap, strategy: strat.id, tier, tierProfile: profile }),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, tokenAmountEst, reason, json({ candidateId, decision, swap, tier }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return positionId;
  })();
}

/**
 * Check and update near-miss tracking for a position
 * A near-miss is when price came within 5% of TP or SL but didn't trigger
 */
export function updateNearMiss(positionId, currentPrice) {
  const position = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(positionId);
  if (!position || position.status !== 'open' || !position.entry_price || !currentPrice) return;

  const entryPrice = Number(position.entry_price);
  const tpPercent = Number(position.tp_percent);
  const slPercent = Number(position.sl_percent);
  
  const currentGainPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
  
  // TP near-miss: within 5% of TP target
  const tpThreshold = tpPercent * 0.95;
  if (currentGainPercent >= tpThreshold && currentGainPercent < tpPercent) {
    const existing = position.near_miss_tp_percent;
    if (!existing || currentGainPercent > existing) {
      db.prepare(`
        UPDATE dry_run_positions 
        SET near_miss_tp_percent = ?, near_miss_tp_at_ms = ?
        WHERE id = ?
      `).run(currentGainPercent, now(), positionId);
    }
  }
  
  // SL near-miss: within 5% of SL target (SL is negative)
  const slThreshold = slPercent * 0.95; // e.g., -25% * 0.95 = -23.75%
  if (currentGainPercent <= slThreshold && currentGainPercent > slPercent) {
    const existing = position.near_miss_sl_percent;
    if (!existing || currentGainPercent < existing) {
      db.prepare(`
        UPDATE dry_run_positions 
        SET near_miss_sl_percent = ?, near_miss_sl_at_ms = ?
        WHERE id = ?
      `).run(currentGainPercent, now(), positionId);
    }
  }
}

/**
 * Get positions with near-miss events
 */
export function getPositionsWithNearMiss(limit = 20) {
  return db.prepare(`
    SELECT * FROM dry_run_positions 
    WHERE near_miss_tp_percent IS NOT NULL OR near_miss_sl_percent IS NOT NULL
    ORDER BY closed_at_ms DESC, opened_at_ms DESC
    LIMIT ?
  `).all(limit);
}
