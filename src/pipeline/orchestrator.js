import { now, pruneSeen } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { upsertCandidate, updateCandidateStatus, recentEligibleCandidates, candidateById } from '../db/candidates.js';
import { storeDecision, storeBatchDecision, logDecisionEvent } from '../db/decisions.js';
import { buildCandidate, filterCandidate, signalLabel } from './candidateBuilder.js';
import { decideCandidateBatch } from './llm.js';
import { activeStrategy } from '../db/settings.js';
import { createDryRunPosition, createLivePosition, canOpenMorePositions, openPositionCount, tradingMode } from '../db/positions.js';
import { sendBatchReveal, sendTelegram, sendPositionOpen, sendTradeIntent } from '../telegram/send.js';
import { candidateSummary } from '../telegram/format.js';
import { createTradeIntent } from '../db/intents.js';
import { refreshCandidateForExecution } from '../execution/positions.js';
import { executeLiveBuy } from '../execution/router.js';
import { graduated } from '../signals/graduated.js';
import { setDegenHandler } from '../signals/trending.js';
import { setCandidateHandler } from '../signals/feeClaim.js';
import { short } from '../format.js';
import { escapeHtml } from '../format.js';
import { checkRiskBeforeBuy } from '../execution/riskManager.js';
import { enforceEntryGuards } from '../execution/entryGuards.js';
import { resolveTierProfile, effectivePositionSizeSol } from '../execution/tiers.js';
import { computeSourceReliabilityScore, getSourceSampleCount } from '../db/sourcePerformance.js';

/**
 * Effective confidence threshold adjusted by the selected source's historical
 * reliability. Cold-start safe: below min_samples it returns the base threshold
 * unchanged (reliability 0 from no-data must NOT raise the bar). Neutral by
 * default (source_reliability_enabled=false, k=0).
 */
export function effectiveConfidenceThreshold(candidate) {
  const base = numSetting('llm_min_confidence', 65);
  if (!boolSetting('source_reliability_enabled', false)) return base;
  const route = candidate?.signals?.route;
  const label = candidate?.signals?.label;
  if (!route) return base;
  const samples = getSourceSampleCount(route, label);
  if (samples < numSetting('source_reliability_min_samples', 10)) return base;
  const rel = computeSourceReliabilityScore(route, label); // 0-100, 50 pivot
  const k = numSetting('source_reliability_threshold_k', 0);
  const adj = base - k * (rel - 50) / 50;
  const floor = numSetting('confidence_floor', 40);
  const ceil = numSetting('confidence_ceil', 95);
  return Math.min(ceil, Math.max(floor, adj));
}

export const seenSignalCandidates = new Map();

setDegenHandler(maybeProcessDegenCandidate);
setCandidateHandler(processCandidateFromSignals);

export async function processCandidateFromSignals(signals) {
  // Skip if max positions reached — don't waste enrichment/LLM calls
  if (!canOpenMorePositions()) {
    const max = numSetting('max_open_positions', 3);
    console.log(`[agent] max positions reached (${openPositionCount()}/${max}), skipping ${signals.mint.slice(0, 8)}...`);
    return;
  }

  const candidate = await buildCandidate(signals);
  const signature = signals.signature || null;
  const candidateId = upsertCandidate(candidate, signature);
  if (!candidate.filters.passed) {
    console.log(`[candidate] filtered ${candidate.token.mint.slice(0, 8)}... ${candidate.filters.failures.join('; ')}`);
    return;
  }

  const strat = activeStrategy();
  let rows, batchDecision, batchId;

  if (!strat.use_llm) {
    const selfRow = candidateById(candidateId);
    rows = selfRow ? [selfRow] : [];
    batchId = null;
    batchDecision = {
      verdict: 'BUY',
      confidence: 100,
      selected_candidate_id: candidateId,
      selected_mint: candidate.token.mint,
      selected_row: selfRow,
      reason: `Strategy '${strat.id}' is rule-based (use_llm: false); filters passed.`,
      risks: [],
      suggested_tp_percent: strat.tp_percent ?? numSetting('default_tp_percent', 50),
      suggested_sl_percent: strat.sl_percent ?? numSetting('default_sl_percent', -25),
      raw: null,
    };
  } else {
    rows = recentEligibleCandidates(numSetting('llm_candidate_pick_count', 10));
    batchDecision = await decideCandidateBatch(rows, candidateId);
    batchId = storeBatchDecision(candidateId, rows, batchDecision);
  }
  const selectedRow = batchDecision.selected_row;
  const selectedThisCandidate = selectedRow?.id === candidateId;
  const currentDecision = selectedThisCandidate
    ? batchDecision
    : {
        ...batchDecision,
        verdict: 'WATCH',
        reason: selectedRow
          ? `Batch #${batchId} screened ${rows.length}; selected ${short(selectedRow.candidate.token.mint)} instead. ${batchDecision.reason || ''}`.trim()
          : `Batch #${batchId} screened ${rows.length}; no buy selected. ${batchDecision.reason || ''}`.trim(),
      };
  const currentDecisionId = storeDecision(candidateId, candidate, currentDecision);
  currentDecision.id = currentDecisionId;
  updateCandidateStatus(candidateId, currentDecision.verdict.toLowerCase());

  if (selectedRow && !selectedThisCandidate) {
    const selectedDecisionId = storeDecision(selectedRow.id, selectedRow.candidate, batchDecision);
    batchDecision.id = selectedDecisionId;
    updateCandidateStatus(selectedRow.id, batchDecision.verdict.toLowerCase());
  } else if (selectedThisCandidate) {
    batchDecision.id = currentDecisionId;
  }

  if (batchId) await sendBatchReveal(batchId, rows, batchDecision, candidateId);

  if (selectedRow && boolSetting('agent_enabled', true) && batchDecision.verdict === 'BUY' && batchDecision.confidence >= effectiveConfidenceThreshold(selectedRow.candidate)) {
    if (!canOpenMorePositions()) {
      const max = numSetting('max_open_positions', 3);
      console.log(`[agent] max open positions reached (${openPositionCount()}/${max}), skipping buy ${selectedRow.candidate.token.mint}`);
      logDecisionEvent({
        batchId,
        triggerCandidateId: candidateId,
        selectedRow,
        rows,
        decision: batchDecision,
        action: 'entry_skipped_max_positions',
        guardrails: { maxOpenPositions: max, openPositions: openPositionCount() },
      });
      return;
    }

    const strat = activeStrategy();
    // Use the SAME effective size the trade will use (tier base × score modifier),
    // so the exposure check matches the actual position, not the strategy default.
    const { profile: preProfile } = resolveTierProfile(selectedRow.candidate);
    const positionSizeSol = effectivePositionSizeSol(selectedRow.candidate, preProfile)
      ?? strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
    const riskCheck = checkRiskBeforeBuy(positionSizeSol);
    if (!riskCheck.allowed) {
      console.log(`[risk] blocked buy ${selectedRow.candidate.token.mint}: ${riskCheck.reason}`);
      logDecisionEvent({
        batchId,
        triggerCandidateId: candidateId,
        selectedRow,
        rows,
        decision: batchDecision,
        action: 'entry_blocked_risk',
        guardrails: { riskReason: riskCheck.reason, positionSizeSol },
      });
      await sendTelegram([
        '🛑 <b>Risk manager blocked buy</b>',
        '',
        candidateSummary(selectedRow.candidate, batchDecision),
        '',
        escapeHtml(riskCheck.reason),
      ].join('\n'));
      return;
    }

    await handleApprovedBuy(selectedRow, batchDecision, batchId, rows, candidateId);
  } else {
    logDecisionEvent({
      batchId,
      triggerCandidateId: candidateId,
      selectedRow,
      rows,
      decision: batchDecision,
      action: selectedRow ? 'entry_not_approved' : 'no_candidate_selected',
      guardrails: {
        agentEnabled: boolSetting('agent_enabled', true),
        confidenceThreshold: numSetting('llm_min_confidence', 65),
        openPositions: openPositionCount(),
        maxOpenPositions: numSetting('max_open_positions', 3),
      },
    });
  }
}

export async function handleApprovedBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  const mode = tradingMode();
  const freshSelectedRow = await refreshCandidateForExecution(selectedRow);
  const executionRows = rows.map(row => row.id === freshSelectedRow.id ? freshSelectedRow : row);
  if (!freshSelectedRow.candidate.filters?.passed) {
    updateCandidateStatus(freshSelectedRow.id, 'stale_rejected');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'entry_rejected_fresh_filters',
      guardrails: {
        failures: freshSelectedRow.candidate.filters?.failures || [],
        refreshedAtMs: freshSelectedRow.candidate.executionRefresh?.refreshedAtMs,
      },
    });
    await sendTelegram([
      '🛑 <b>Execution rejected on fresh check</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Failures: ${escapeHtml((freshSelectedRow.candidate.filters?.failures || []).join('; ') || 'fresh execution guard failed')}`,
    ].join('\n'));
    return;
  }

  // Execution-stage entry guards (Tier 0): Guard 2 (sellability/authority) +
  // Guard 3 (price-impact). Single buy-quote also feeds the dry-run fill estimate.
  // Fail-closed. The live branch is guarded inside executeLiveBuy instead (so the
  // manual live-buy path is also covered), so we only gate dry_run + confirm here.
  if (mode !== 'live') {
    const strat = activeStrategy();
    const { profile: tierProfile } = resolveTierProfile(freshSelectedRow.candidate);
    // Quote at the EFFECTIVE size (tier base × score modifier) so the dry-run fill
    // estimate matches the size_sol that createDryRunPosition will record.
    const positionSizeSol = effectivePositionSizeSol(freshSelectedRow.candidate, tierProfile)
      ?? strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
    const amountLamports = Math.floor(positionSizeSol * 1_000_000_000);
    const guard = await enforceEntryGuards({ candidate: freshSelectedRow.candidate, amountLamports, tierProfile });
    if (!guard.allowed) {
      updateCandidateStatus(freshSelectedRow.id, 'guard_rejected');
      logDecisionEvent({
        batchId,
        triggerCandidateId,
        selectedRow: freshSelectedRow,
        rows: executionRows,
        decision,
        mode,
        action: 'entry_rejected_safety',
        guardrails: { reasons: guard.reasons, priceImpactPct: guard.priceImpactPct },
      });
      await sendTelegram([
        '🛑 <b>Entry blocked by safety guard</b>',
        '',
        candidateSummary(freshSelectedRow.candidate, decision),
        '',
        `Reasons: ${escapeHtml(guard.reasons.join('; '))}`,
      ].join('\n'));
      return;
    }
    // Attach fill estimate so createDryRunPosition records slippage-aware entry + token amount (Guard 4).
    if (guard.fillEstimate) freshSelectedRow.candidate.executionQuote = guard.fillEstimate;
  }

  if (mode === 'dry_run') {
    const positionId = await createDryRunPosition(freshSelectedRow.id, freshSelectedRow.candidate, decision, `llm_batch_${batchId}`);
    if (positionId == null) {
      const tier = freshSelectedRow.candidate.tier || 'unknown';
      logDecisionEvent({
        batchId,
        triggerCandidateId,
        selectedRow: freshSelectedRow,
        rows: executionRows,
        decision,
        mode,
        action: 'entry_skipped_max_positions_tier',
        guardrails: { tier, openPositions: openPositionCount() },
      });
      console.log(`[agent] tier ${tier} full, skipping dry-run buy ${freshSelectedRow.candidate.token.mint.slice(0, 8)}...`);
      return;
    }
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'dry_run_entry',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount(), tier: freshSelectedRow.candidate.tier },
      execution: { positionId },
    });
    await sendPositionOpen(positionId);
    return;
  }

  if (mode === 'confirm') {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'pending_confirmation');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'confirm_intent_created',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { intentId },
    });
    await sendTradeIntent(intentId, freshSelectedRow.candidate, decision);
    return;
  }

  try {
    await executeLiveBuy(freshSelectedRow, decision, batchId, executionRows, triggerCandidateId);
  } catch (err) {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'execution_failed');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'live_entry_failed',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { intentId, error: err.message },
    });
    await sendTelegram([
      '🛑 <b>Live trade failed</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Intent #${intentId} stored.`,
      `Error: ${escapeHtml(err.message)}`,
    ].join('\n'));
  }
}

export async function maybeProcessDegenCandidate(mint, trendingToken) {
  if (!boolSetting('trending_allow_degen', false)) return;
  const graduatedCoin = graduated.get(mint);
  if (!graduatedCoin) return;
  pruneSeen(seenSignalCandidates, 10 * 60 * 1000);
  const bucket = Math.floor(now() / (5 * 60 * 1000));
  const key = `graduated_trending:${mint}:${bucket}`;
  if (seenSignalCandidates.has(key)) return;
  seenSignalCandidates.set(key, now());
  await processCandidateFromSignals({
    mint,
    graduatedCoin,
    trendingToken,
    route: 'graduated_trending',
  });
}
