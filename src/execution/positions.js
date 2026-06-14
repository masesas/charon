import { now, json } from '../utils.js';
import { numSetting, boolSetting, strategyById } from '../db/settings.js';
import { db } from '../db/connection.js';
import { firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn } from '../utils.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext, fetchJupiterWalletPnl } from '../enrichment/jupiter.js';
import { liveWalletPubkey, jupiterQuote } from '../liveExecutor.js';
import { WSOL_MINT, JUPITER_SLIPPAGE_BPS } from '../config.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { filterCandidate } from '../pipeline/candidateBuilder.js';
import { openPositions } from '../db/positions.js';
import { updateCandidateSnapshot } from '../db/candidates.js';
import { trending } from '../signals/trending.js';
import { executeLiveSell } from './router.js';
import { sendPositionExit } from '../telegram/send.js';
import { updateDailyMetricsOnClose, markDailyLossLimitTriggered, isDailyLossLimitExceeded } from './riskManager.js';
import { updateSourcePerformanceOnClose } from '../db/sourcePerformance.js';
import { classifyTier, getTierProfile } from './tiers.js';
import { scoreCandidate } from '../pipeline/scoring.js';

export async function freshEntryMarket(mint, candidate) {
  const gmgn = await fetchGmgnTokenInfo(mint, false);
  const asset = await fetchJupiterAsset(mint, { useCache: false });
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  return { gmgn, asset, priceUsd, marketCapUsd, refreshedAtMs: now() };
}

export async function refreshCandidateForExecution(row) {
  const candidate = row.candidate;
  const mint = candidate.token.mint;
  const gmgn = await fetchGmgnTokenInfo(mint, false);
  const asset = await fetchJupiterAsset(mint, { useCache: false });
  const holders = await fetchJupiterHolders(mint);
  const chart = await fetchJupiterChartContext(mint);
  const selectedTrending = trending.get(mint) || candidate.trending || null;
  const selectedHolders = holders?.holders?.length ? holders : candidate.holders;
  const selectedSavedWalletExposure = selectedHolders
    ? await fetchSavedWalletExposure(mint, selectedHolders)
    : candidate.savedWalletExposure;
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, selectedTrending?.price, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    selectedTrending?.market_cap,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  const refreshed = {
    ...candidate,
    token: {
      ...candidate.token,
      name: gmgn?.name || asset?.name || selectedTrending?.name || candidate.token.name,
      symbol: gmgn?.symbol || asset?.symbol || selectedTrending?.symbol || candidate.token.symbol,
      twitter: candidate.token.twitter || asset?.twitter || gmgn?.link?.twitter_username || selectedTrending?.twitter || '',
      website: candidate.token.website || asset?.website || gmgn?.link?.website || '',
      telegram: candidate.token.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      ...candidate.metrics,
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? candidate.metrics?.liquidityUsd ?? 0),
      holderCount: Number(gmgn?.holder_count ?? asset?.holderCount ?? selectedTrending?.holder_count ?? candidate.metrics?.holderCount ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? asset?.fees ?? candidate.metrics?.gmgnTotalFeesSol ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? candidate.metrics?.gmgnTradeFeesSol ?? 0),
      trendingVolumeUsd: Number(selectedTrending?.volume ?? candidate.metrics?.trendingVolumeUsd ?? 0),
      trendingSwaps: Number(selectedTrending?.swaps ?? candidate.metrics?.trendingSwaps ?? 0),
      trendingHotLevel: Number(selectedTrending?.hot_level ?? candidate.metrics?.trendingHotLevel ?? 0),
      trendingSmartDegenCount: Number(selectedTrending?.smart_degen_count ?? candidate.metrics?.trendingSmartDegenCount ?? 0),
    },
    gmgn,
    jupiterAsset: asset,
    trending: selectedTrending,
    holders: selectedHolders,
    chart,
    savedWalletExposure: selectedSavedWalletExposure,
    executionRefresh: {
      refreshedAtMs: now(),
      source: 'pre_execution',
      marketCapUsd,
      priceUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? 0),
      holdersRefreshed: Boolean(holders?.holders?.length),
    },
  };
  // Classify tier from fresh mcap/liquidity (authoritative point). Attach to the
  // refreshed object so it is persisted in the candidate snapshot and visible to
  // entry guards + position creation.
  refreshed.tier = classifyTier(refreshed.metrics.marketCapUsd, refreshed.metrics.liquidityUsd);
  refreshed.tierProfile = getTierProfile(refreshed.tier);
  refreshed.filters = filterCandidate(refreshed);
  // Recompute scores from FRESH data (holders/mcap/rug just refreshed). Without
  // this the risk gate + sizing modifier would read stale build-time scores.
  const rescored = scoreCandidate(refreshed);
  refreshed.scores = rescored.scores;
  refreshed.confidence_score = rescored.confidence_score;
  refreshed.risk_score = rescored.risk_score;
  refreshed.quality_score = rescored.quality_score;
  const executionFailures = [];
  if (!Number.isFinite(Number(refreshed.metrics.marketCapUsd)) || Number(refreshed.metrics.marketCapUsd) <= 0) {
    executionFailures.push('execution mcap: missing');
  }
  if (!Number.isFinite(Number(refreshed.metrics.priceUsd)) || Number(refreshed.metrics.priceUsd) <= 0) {
    executionFailures.push('execution price: missing');
  }
  if (executionFailures.length) {
    refreshed.filters = {
      ...refreshed.filters,
      passed: false,
      failures: [...(refreshed.filters?.failures || []), ...executionFailures],
    };
  }
  updateCandidateSnapshot(row.id, refreshed, refreshed.filters.passed ? 'candidate' : 'filtered');
  return { ...row, candidate: refreshed };
}

// Position ids with an exit in flight. Shared between the monitor loop
// (refreshPosition) and the manual Telegram close (closePosition) to prevent a
// double-close race (duplicate trades + double-counted daily metrics).
export const sellInProgress = new Set();

/**
 * Compute slippage-aware realized PnL for a DRY-RUN exit.
 * PRIMARY: one real sell-quote (token -> WSOL) at the position's tier slippage.
 * FALLBACK (quote unavailable or no token amount): value-based haircut using the
 * tier slippage_bps. The haircut is applied to the exit PROCEEDS, not the return
 * percentage — applying it to the percentage would shrink losses (wrong direction).
 *
 * @param {object} position - dry_run_positions row (carries tier, token_amount_est, size_sol)
 * @param {number} grossPnlPercent - price-based gross PnL% (already buy-slippage-aware via entry_price)
 * @returns {Promise<{pnlSol:number, pnlPercent:number, source:string}>}
 */
export async function computeRealizedExit(position, grossPnlPercent) {
  const sizeSol = Number(position.size_sol);
  // Guard: a zero/invalid size would produce Infinity/NaN PnL (stored as NULL by
  // SQLite). Without a valid size there is nothing meaningful to realize.
  if (!Number.isFinite(sizeSol) || sizeSol <= 0) {
    throw new Error(`computeRealizedExit: invalid size_sol=${position.size_sol} for position ${position.id}`);
  }
  const slipBps = position.tier ? Number(getTierProfile(position.tier).slippage_bps) : JUPITER_SLIPPAGE_BPS;
  const tokenAmt = Number(position.token_amount_est);

  // PRIMARY: real sell-quote. A network throw must NOT propagate — fall through
  // to the deterministic FALLBACK so an exit is never silently skipped.
  if (Number.isFinite(tokenAmt) && tokenAmt > 0) {
    try {
      const quote = await jupiterQuote({
        inputMint: position.mint,
        outputMint: WSOL_MINT,
        amount: Math.floor(tokenAmt),
        slippageBps: slipBps,
      });
      if (quote && Number(quote.outAmount) > 0) {
        const receivedSol = Number(quote.outAmount) / 1_000_000_000;
        return {
          pnlSol: receivedSol - sizeSol,
          pnlPercent: (receivedSol / sizeSol - 1) * 100,
          source: 'sell_quote',
        };
      }
    } catch {
      // fall through to FALLBACK haircut
    }
  }

  // FALLBACK: value-based haircut
  const grossExitValueSol = sizeSol * (1 + Number(grossPnlPercent) / 100);
  const effectiveExitValueSol = grossExitValueSol * (1 - slipBps / 10000);
  return {
    pnlSol: effectiveExitValueSol - sizeSol,
    pnlPercent: (effectiveExitValueSol / sizeSol - 1) * 100,
    source: 'haircut',
  };
}

export async function refreshPosition(position, { autoExit = true, jupiterPnl = null } = {}) {
  const asset = await fetchJupiterAsset(position.mint);
  const price = firstPositiveNumber(asset?.usdPrice, position.high_water_price, position.entry_price);
  const mcap = firstPositiveNumber(asset?.mcap, asset?.fdv, position.high_water_mcap, position.entry_mcap);
  if (!Number.isFinite(Number(mcap)) || !Number.isFinite(Number(position.entry_mcap)) || Number(position.entry_mcap) <= 0) {
    return null;
  }
  const highWaterMcap = Math.max(Number(position.high_water_mcap || 0), Number(mcap));
  const highWaterPrice = Math.max(Number(position.high_water_price || 0), Number(price || 0));
  // Price-based PnL using the real (slippage-aware) entry_price. Falls back to the
  // mcap ratio for legacy/invalid entry_price rows so they keep working.
  const entryPriceValid = Number.isFinite(Number(position.entry_price)) && Number(position.entry_price) > 0;
  let pnlPercent = entryPriceValid
    ? (Number(price) / Number(position.entry_price) - 1) * 100
    : (Number(mcap) / Number(position.entry_mcap) - 1) * 100;
  let pnlSol = Number(position.size_sol) * pnlPercent / 100;
  if (jupiterPnl && Number.isFinite(Number(jupiterPnl.totalPnlPercentageNative))) {
    pnlPercent = Number(jupiterPnl.totalPnlPercentageNative);
    pnlSol = Number.isFinite(Number(jupiterPnl.totalPnlNative)) ? Number(jupiterPnl.totalPnlNative) : pnlSol;
  }
  const tpHit = pnlPercent >= Number(position.tp_percent);
  const slHit = pnlPercent <= Number(position.sl_percent);
  const trailingArmed = position.trailing_armed || (position.trailing_enabled && tpHit);
  // Trailing drop on the same basis as PnL (price when valid, else mcap).
  const trailDrop = entryPriceValid
    ? (highWaterPrice > 0 ? (Number(price) / highWaterPrice - 1) * 100 : 0)
    : (highWaterMcap > 0 ? (Number(mcap) / highWaterMcap - 1) * 100 : 0);
  const trailingHit = trailingArmed && position.trailing_enabled && trailDrop <= -Math.abs(Number(position.trailing_percent));
  let exitReason = null;
  let closed = false;

  // Max hold time check
  const strat = strategyById(position.strategy_id);
  if (strat?.max_hold_ms > 0 && (now() - position.opened_at_ms) >= strat.max_hold_ms) {
    exitReason = 'MAX_HOLD';
  }

  // Partial TP check — tier-controlled values persist on the position row; fall
  // back to the strategy for legacy/null-tier positions.
  const partialTpEnabled = position.partial_tp != null ? Boolean(position.partial_tp) : Boolean(strat?.partial_tp);
  const partialTpAt = position.partial_tp_at_percent != null ? Number(position.partial_tp_at_percent) : Number(strat?.partial_tp_at_percent ?? 0);
  const partialTpSell = position.partial_tp_sell_percent != null ? Number(position.partial_tp_sell_percent) : Number(strat?.partial_tp_sell_percent ?? 0);
  // partial_tp_at_percent must be > 0; a 0 threshold means "disabled" even if the flag is on.
  if (!exitReason && partialTpEnabled && partialTpAt > 0 && partialTpSell > 0 && !position.partial_tp_done && pnlPercent >= partialTpAt) {
    db.prepare('UPDATE dry_run_positions SET partial_tp_done = 1 WHERE id = ?').run(position.id);
    console.log(`[position] ${position.id} partial TP at ${pnlPercent.toFixed(1)}% (${partialTpSell}% sell)`);
    if (position.execution_mode === 'live' && position.token_amount_raw) {
      try {
        const sellAmount = Math.floor(Number(position.token_amount_raw) * (partialTpSell / 100));
        if (sellAmount > 0) {
          const sell = await executeLiveSell({ ...position, token_amount_raw: String(sellAmount) }, 'PARTIAL_TP');
          const remaining = Number(position.token_amount_raw) - sellAmount;
          db.prepare('UPDATE dry_run_positions SET token_amount_raw = ? WHERE id = ?').run(String(remaining), position.id);
          db.prepare(`
            INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
            VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, 'PARTIAL_TP', ?)
          `).run(position.id, position.mint, now(), price, mcap,
            position.size_sol * (partialTpSell / 100), sellAmount,
            json({ pnlPercent, sell, partialSellPercent: partialTpSell, remaining }));
          console.log(`[position] ${position.id} partial TP sold ${sellAmount} tokens, ${remaining} remaining`);
        }
      } catch (err) {
        console.log(`[position] ${position.id} partial sell failed: ${err.message}`);
      }
    }
  }

  // Standard exit checks
  if (!exitReason) {
    if (slHit) exitReason = 'SL';
    else if (tpHit && !position.trailing_enabled) exitReason = 'TP';
    else if (trailingHit) exitReason = 'TRAILING_TP';
  }

  // Live exits will override these with realized SOL values
  let finalPnlPercent = pnlPercent;
  let finalPnlSol = pnlSol;

  db.prepare(`
    UPDATE dry_run_positions
    SET high_water_mcap = ?, high_water_price = ?, trailing_armed = ?
    WHERE id = ?
  `).run(highWaterMcap, highWaterPrice, trailingArmed ? 1 : 0, position.id);

  if (exitReason && autoExit && position.execution_mode === 'live') {
    if (sellInProgress.has(position.id)) return { ...position, exitReason: null };
    sellInProgress.add(position.id);
    let sell;
    try {
      sell = await executeLiveSell(position, exitReason);
    } finally {
      sellInProgress.delete(position.id);
    }
    const receivedLamports = Number(sell.outputAmount || 0);
    const receivedSol = receivedLamports > 0 ? receivedLamports / 1_000_000_000 : null;
    if (receivedSol != null) {
      finalPnlSol = receivedSol - Number(position.size_sol);
      finalPnlPercent = (receivedSol / Number(position.size_sol) - 1) * 100;
    }
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
          pnl_percent = ?, pnl_sol = ?, exit_signature = ?
      WHERE id = ?
    `).run(now(), price, mcap, exitReason, finalPnlPercent, finalPnlSol, sell.signature, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(position.id, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est, exitReason, json({ pnlPercent: finalPnlPercent, pnlSol: finalPnlSol, receivedSol: receivedSol ?? null, sell }));
    // Track daily risk metrics
    updateDailyMetricsOnClose({ pnl_sol: finalPnlSol, pnl_percent: finalPnlPercent });
    if (isDailyLossLimitExceeded()) markDailyLossLimitTriggered();
    // Track source performance (Epic 6)
    const closedPosition = { ...position, closed_at_ms: now(), pnl_percent: finalPnlPercent, pnl_sol: finalPnlSol };
    const candidate = position.snapshot_json ? JSON.parse(position.snapshot_json).candidate : null;
    if (candidate) updateSourcePerformanceOnClose(closedPosition, candidate);
    closed = true;
  } else if (exitReason && autoExit) {
    // Dry-run exit: model slippage on the realized PnL (the branch now awaits a
    // sell-quote, so guard against overlapping monitor cycles double-firing).
    if (sellInProgress.has(position.id)) return { ...position, exitReason: null };
    sellInProgress.add(position.id);
    let realized;
    try {
      // Re-check the row is still open (a prior overlapping cycle may have closed it).
      const stillOpen = db.prepare("SELECT status FROM dry_run_positions WHERE id = ?").get(position.id);
      if (!stillOpen || stillOpen.status !== 'open') return { ...position, exitReason: null };
      realized = await computeRealizedExit(position, pnlPercent);
    } finally {
      sellInProgress.delete(position.id);
    }
    finalPnlPercent = realized.pnlPercent;
    finalPnlSol = realized.pnlSol;
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?, pnl_percent = ?, pnl_sol = ?
      WHERE id = ?
    `).run(now(), price, mcap, exitReason, finalPnlPercent, finalPnlSol, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(position.id, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est, exitReason, json({ pnlPercent: finalPnlPercent, pnlSol: finalPnlSol, grossPnlPercent: pnlPercent, slippageSource: realized.source }));
    // Track daily risk metrics
    updateDailyMetricsOnClose({ pnl_sol: finalPnlSol, pnl_percent: finalPnlPercent });
    if (isDailyLossLimitExceeded()) markDailyLossLimitTriggered();
    // Track source performance (Epic 6)
    const closedPosition = { ...position, closed_at_ms: now(), pnl_percent: finalPnlPercent, pnl_sol: finalPnlSol };
    const candidate = position.snapshot_json ? JSON.parse(position.snapshot_json).candidate : null;
    if (candidate) updateSourcePerformanceOnClose(closedPosition, candidate);
    closed = true;
  }
  return {
    ...position,
    status: closed ? 'closed' : position.status,
    closed_at_ms: closed ? now() : position.closed_at_ms,
    asset,
    price,
    mcap,
    highWaterMcap,
    high_water_mcap: highWaterMcap,
    high_water_price: highWaterPrice,
    pnlPercent: finalPnlPercent,
    pnl_percent: finalPnlPercent,
    pnlSol: finalPnlSol,
    pnl_sol: finalPnlSol,
    exitReason: closed ? exitReason : null,
    exit_reason: closed ? exitReason : position.exit_reason,
    exit_mcap: closed ? mcap : position.exit_mcap,
    exit_price: closed ? price : position.exit_price,
  };
}

export async function monitorPositions() {
  const positions = openPositions();
  let walletPnlData = {};
  const pubkey = liveWalletPubkey();
  if (pubkey && positions.some(p => p.execution_mode === 'live')) {
    walletPnlData = await fetchJupiterWalletPnl(pubkey);
  }
  for (const position of positions) {
    const jupiterPnl = position.execution_mode === 'live'
      ? (walletPnlData[position.mint]?.pnl || null)
      : null;
    const result = await refreshPosition(position, { autoExit: true, jupiterPnl }).catch((err) => {
      console.log(`[position] ${position.id} ${err.message}`);
      return null;
    });
    if (result?.exitReason) await sendPositionExit(result);
  }
}
