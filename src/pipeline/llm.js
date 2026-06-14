import axios from 'axios';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS } from '../config.js';
import { now, sleep, stripThinking, strictJsonFromText } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { db } from '../db/connection.js';
import { computeSourceReliabilityScore } from '../db/sourcePerformance.js';
import { recordHealthSuccess, recordHealthFailure } from '../health/providerHealth.js';
import { sendTelegram } from '../telegram/send.js';
import { escapeHtml } from '../format.js';

// In-memory failure tracking for the LLM endpoint. Reset on any success. Used to
// fire a single Telegram alert when the endpoint is down for N consecutive batches
// (edge-trigger via llmAlerted so we don't spam every failure after the threshold).
let llmFailStreak = 0;
let llmAlerted = false;

/**
 * Build a human-readable description of an axios/LLM error. NEVER returns an empty
 * string — the original bug recorded `err.message === ''` (empty SSE body), making
 * the failure invisible. Falls back to error code or a generic label.
 */
export function describeAxiosError(err) {
  if (err?.response) {
    const data = err.response.data;
    const body = typeof data === 'string'
      ? data.slice(0, 300)
      : JSON.stringify(data || {}).slice(0, 300);
    return `HTTP ${err.response.status} ${err.response.statusText || ''}: ${body}`.trim();
  }
  if (err?.code) return `${err.code}: ${err.message || 'no message'}`;
  return err?.message || 'unknown_llm_error';
}

/**
 * Decide whether a failure is worth retrying. Transient: connection aborts/refusals,
 * HTTP 5xx, HTTP 429, or an empty/stream response (flagged via __parseEmpty). A 4xx
 * (other than 429) is a request bug — retrying wastes time, so it is NOT retried.
 */
export function isRetryableLlmError(err) {
  if (err?.code === 'ECONNABORTED' || err?.code === 'ECONNREFUSED' || err?.code === 'ETIMEDOUT') return true;
  const status = err?.response?.status;
  if (status && (status >= 500 || status === 429)) return true;
  if (err?.__parseEmpty) return true;
  return false;
}

/**
 * Neutral WATCH decision (no buy). Used when the LLM is disabled or the deterministic
 * fallback finds no eligible candidate.
 */
function baseWatchDecision(reason, risks = ['llm_unavailable']) {
  return {
    verdict: 'WATCH',
    confidence: 0,
    selected_candidate_id: null,
    selected_mint: null,
    selected_row: null,
    reason,
    risks,
    suggested_tp_percent: numSetting('default_tp_percent', 50),
    suggested_sl_percent: numSetting('default_sl_percent', -25),
    raw: null,
  };
}

/**
 * Deterministic score-based fallback used when the LLM is unreachable. Picks the
 * candidate with the best (quality_score - risk_score) among those passing the
 * quality/risk gates. The synthetic confidence is deliberately conservative
 * (default 55 < llm_min_confidence) so restoring the LLM does not silently make the
 * agent trade on heuristics — operators must opt in by raising llm_fallback_confidence.
 *
 * @param {Array<{id:number, candidate:object}>} rows
 * @returns {object} decision shaped like decideCandidateBatch's return
 */
export function deterministicFallbackDecision(rows) {
  if (!boolSetting('llm_fallback_enabled', true)) {
    return baseWatchDecision('LLM unavailable — deterministic fallback disabled.', ['llm_unavailable']);
  }
  const minQuality = numSetting('llm_fallback_min_quality', 60);
  const maxRisk = numSetting('llm_fallback_max_risk', 45);
  const eligible = (rows || [])
    .map(row => ({
      row,
      mint: row?.candidate?.token?.mint,
      quality: Number(row?.candidate?.scores?.quality_score ?? 0),
      risk: Number(row?.candidate?.scores?.risk_score ?? 100),
    }))
    // Require a usable mint — a malformed candidate (bad candidate_json) must not be
    // selectable, or the BUY path below would throw on token.mint.
    .filter(x => x.mint && Number.isFinite(x.quality) && Number.isFinite(x.risk)
      && x.quality >= minQuality && x.risk <= maxRisk)
    // Highest (quality - risk) wins; tie-break by candidate id (deterministic).
    .sort((a, b) => (b.quality - b.risk) - (a.quality - a.risk) || a.row.id - b.row.id);

  if (!eligible.length) {
    return baseWatchDecision('LLM unavailable — no candidate passed deterministic score gate.', ['llm_fallback']);
  }
  const winner = eligible[0];
  return {
    verdict: 'BUY',
    confidence: numSetting('llm_fallback_confidence', 55),
    selected_candidate_id: winner.row.id,
    selected_mint: winner.mint,
    selected_row: winner.row,
    reason: `LLM unavailable — deterministic score fallback (quality=${winner.quality}, risk=${winner.risk}).`,
    risks: ['llm_fallback'],
    suggested_tp_percent: numSetting('default_tp_percent', 50),
    suggested_sl_percent: numSetting('default_sl_percent', -25),
    raw: { fallback: true },
  };
}

export function normalizeDecision(parsed, fallbackReason = '') {
  const verdict = ['BUY', 'WATCH', 'PASS'].includes(String(parsed?.verdict).toUpperCase())
    ? String(parsed.verdict).toUpperCase()
    : 'WATCH';
  return {
    verdict,
    confidence: Math.max(0, Math.min(100, Number(parsed?.confidence) || 0)),
    reason: String(parsed?.reason || fallbackReason).slice(0, 1000),
    risks: Array.isArray(parsed?.risks) ? parsed.risks.map(String).slice(0, 8) : [],
    suggested_tp_percent: Number(parsed?.suggested_tp_percent) || numSetting('default_tp_percent', 50),
    suggested_sl_percent: Number(parsed?.suggested_sl_percent) || numSetting('default_sl_percent', -25),
    raw: parsed,
  };
}

export function activeLessonsForPrompt(limit = 6) {
  return db.prepare(`
    SELECT lesson
    FROM learning_lessons
    WHERE status = 'active'
    ORDER BY id DESC
    LIMIT ?
  `).all(limit).map(row => row.lesson);
}

export function compactCandidateForLlm(row) {
  const c = row.candidate;
  const athWindow = c.chart?.windows?.find(window => window.label === 'ath_context_24h_5m' && window.available)
    || c.chart?.windows?.find(window => window.label === 'recent_24h_5m' && window.available);
  
  // Compute source reliability score (Epic 6)
  const sourceReliability = c.signals?.route 
    ? computeSourceReliabilityScore(c.signals.route, c.signals.label)
    : 0;
  
  return {
    candidate_id: row.id,
    mint: c.token?.mint,
    route: c.signals?.route,
    signals: {
      ...c.signals,
      source_reliability_score: sourceReliability,
    },
    token: c.token,
    metrics: c.metrics,
    feeClaim: c.feeClaim,
    trending: c.trending,
    graduation: c.graduation,
    holders: c.holders,
    chart: {
      purpose: 'ATH/range context only. Do not treat large 24h change as bullish/bearish momentum by itself.',
      currentNative: c.chart?.currentNative,
      rangeHighNative: c.chart?.rangeHighNative,
      distanceFromAthPercent: c.chart?.distanceFromAthPercent ?? c.chart?.belowRangeHighPercent,
      topBlastRisk: c.chart?.topBlastRisk,
      athContext24h: athWindow ? {
        current: athWindow.current,
        high: athWindow.high,
        low: athWindow.low,
        distanceFromHighPercent: athWindow.belowHighPercent,
        aboveLowPercent: athWindow.aboveLowPercent,
      } : null,
      windows: c.chart?.windows,
    },
    savedWalletExposure: c.savedWalletExposure,
    twitterNarrative: c.twitterNarrative,
    filters: c.filters,
    scores: c.scores || null,
  };
}

export async function decideCandidateBatch(rows, triggerCandidateId) {
  if (!ENABLE_LLM || !LLM_API_KEY) {
    return baseWatchDecision('LLM disabled or LLM_API_KEY missing.', ['no_llm_decision']);
  }

  const system = [
    'You are Charon, a Solana meme coin trench analyst.',
    'Return strict JSON only.',
    'You will receive up to 10 recently matched candidates.',
    'Pick at most one candidate to buy through the configured execution mode.',
    'Use verdict BUY only for the single best unusually strong asymmetric opportunity.',
    'Use WATCH if candidates are interesting but none deserves a buy.',
    'Use PASS if the set is weak or unsafe.',
    'Chart data is ATH/range context. Do not penalize or reward a token only because 24h change is huge; new Pump tokens often do that.',
    'Use distance from ATH/range high and top-blast risk to decide whether entry is late.',
    'Confidence is your conviction from 0 to 100, not probability.',
  ].join(' ');
  const user = {
    task: 'Pick the best dry-run buy candidate from this recent batch, or choose none.',
    recent_lessons: activeLessonsForPrompt(),
    output_schema: {
      verdict: 'BUY|WATCH|PASS',
      selected_candidate_id: 'integer candidate_id when verdict is BUY, otherwise null',
      selected_mint: 'mint string when verdict is BUY, otherwise null',
      confidence: 'number 0-100',
      reason: 'short string',
      risks: ['short strings'],
      suggested_tp_percent: 'positive number',
      suggested_sl_percent: 'negative number',
    },
    trigger_candidate_id: triggerCandidateId,
    candidates: rows.map(compactCandidateForLlm),
  };

  // Support both OpenAI-style (/v1/chat/completions) and 9router-style (/api/v1/chat/completions)
  const baseUrl = LLM_BASE_URL.replace(/\/$/, '');
  const endpoint = baseUrl.includes('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
  const maxRetries = numSetting('llm_max_retries', 2);
  const backoffMs = numSetting('llm_retry_backoff_ms', 1000);

  let lastErr = null;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const start = now();
      const res = await axios.post(endpoint, {
        model: LLM_MODEL,
        temperature: 0.2,
        // stream:false is REQUIRED — the proxy defaults to SSE streaming, which makes
        // res.data raw event-stream text (choices undefined → empty content → the
        // historical silent "LLM failed: " bug). Forcing a non-streaming JSON body
        // restores choices[0].message.content.
        stream: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(user) },
        ],
      }, {
        timeout: LLM_TIMEOUT_MS,
        headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
      });
      const content = res.data?.choices?.[0]?.message?.content;
      if (!content || typeof content !== 'string' || content.trim() === '') {
        // Empty or unexpected (e.g. leftover SSE) body — flag as retryable so a
        // momentarily flaky endpoint gets another attempt before falling back.
        const e = new Error('empty/stream response from LLM');
        e.__parseEmpty = true;
        throw e;
      }
      const parsed = strictJsonFromText(content);
      const decision = normalizeDecision(parsed);
      const selectedId = Number(parsed.selected_candidate_id);
      const selectedMint = String(parsed.selected_mint || '');
      const row = rows.find(item => item.id === selectedId || item.candidate.token?.mint === selectedMint);
      recordHealthSuccess('llm', 'chat_completion', now() - start);
      llmFailStreak = 0;
      llmAlerted = false;
      return {
        ...decision,
        selected_candidate_id: decision.verdict === 'BUY' && row ? row.id : null,
        selected_mint: decision.verdict === 'BUY' && row ? row.candidate.token.mint : null,
        selected_row: decision.verdict === 'BUY' && row ? row : null,
      };
    } catch (err) {
      lastErr = err;
      if (attempt <= maxRetries && isRetryableLlmError(err)) {
        await sleep(backoffMs * attempt);
        continue;
      }
      break;
    }
  }

  // Retries exhausted (or non-retryable error). Surface a descriptive reason — never
  // an empty string — then fall back to a deterministic score-based decision so the
  // agent keeps operating instead of going silent.
  const desc = describeAxiosError(lastErr);
  recordHealthFailure('llm', 'chat_completion', new Error(desc));
  console.log(`[llm] batch failed after retries: ${desc}`);
  llmFailStreak++;
  const alertThreshold = numSetting('llm_alert_fail_streak', 5);
  if (llmFailStreak >= alertThreshold && !llmAlerted) {
    llmAlerted = true;
    try {
      await sendTelegram([
        '⚠️ <b>LLM endpoint down</b>',
        `${llmFailStreak} consecutive failures.`,
        `Error: ${escapeHtml(desc)}`,
        'Falling back to deterministic scoring.',
      ].join('\n'));
    } catch {
      // Alert delivery is best-effort; must never block the trading decision.
    }
  }
  return deterministicFallbackDecision(rows);
}

export async function decideCandidate(candidate) {
  const pseudoRow = { id: 0, candidate };
  const decision = await decideCandidateBatch([pseudoRow], 0);
  // decision is already a normalized decision shape (from a successful parse, the
  // fallback, or a WATCH). Re-normalizing decision.raw would discard the verdict for
  // fallback/error decisions (raw is metadata like {fallback:true}, not the LLM body),
  // silently turning a fallback BUY into WATCH. Normalize the decision itself.
  return normalizeDecision(decision, decision.reason);
}
