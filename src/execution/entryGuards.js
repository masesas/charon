import { WSOL_MINT, MAX_PRICE_IMPACT_PCT, JUPITER_SLIPPAGE_BPS } from '../config.js';
import { jupiterQuote } from '../liveExecutor.js';
import { fetchSolUsdPrice } from '../enrichment/jupiter.js';
import { checkTokenSafety } from './safetyCheck.js';

/**
 * Build a dry-run fill estimate from the buy-direction quote.
 *
 * entryPriceWithSlippage is derived decimals-free by applying the quote's price
 * impact to the candidate's snapshot price:
 *   effectiveEntry = snapshotPrice * (1 + priceImpactPct/100)
 * This makes the recorded entry reflect the worse price a real buy would pay,
 * so dry-run PnL is not systematically optimistic. tokenAmountRaw is the raw
 * outAmount (token base units) the buy would receive.
 */
function buildFillEstimate(quote, amountLamports, solUsd, snapshotPriceUsd) {
  const tokenAmountRaw = quote?.outAmount ? Number(quote.outAmount) : null;
  const solSpent = Number(amountLamports) / 1e9;
  // priceImpactPct is provided by Jupiter as a fraction string (e.g. "0.0123").
  const priceImpactPct = quote?.priceImpactPct != null ? Number(quote.priceImpactPct) * 100 : null;
  const snap = Number(snapshotPriceUsd);
  const entryPriceWithSlippage = (Number.isFinite(snap) && snap > 0 && Number.isFinite(priceImpactPct))
    ? snap * (1 + priceImpactPct / 100)
    : null;
  return {
    tokenAmountRaw,
    solSpent,
    solUsd: solUsd ?? null,
    priceImpactPct,
    entryPriceWithSlippage,
  };
}

/**
 * Enforce execution-stage entry guards (Guard 2 sellability/authority + Guard 3
 * price-impact). Fetches ONE buy-direction quote that also feeds the dry-run fill
 * estimate (Guard 4).
 *
 * FAIL-CLOSED: a missing quote or unsafe token blocks the entry.
 *
 * @returns {Promise<{allowed: boolean, reasons: string[], quote: object|null, fillEstimate: object|null, priceImpactPct: number|null}>}
 */
export async function enforceEntryGuards({ candidate, amountLamports, tierProfile = null }) {
  const mint = candidate?.token?.mint;
  if (!mint) return { allowed: false, reasons: ['missing mint'], quote: null, fillEstimate: null, priceImpactPct: null };

  // Tier profile drives slippage and the price-impact cap; fall back to globals.
  const slippageBps = tierProfile?.slippage_bps ?? JUPITER_SLIPPAGE_BPS;
  const maxImpactPct = tierProfile?.max_price_impact_pct ?? MAX_PRICE_IMPACT_PCT;

  // Guard 3: single buy-direction quote (WSOL -> token) at the real position size.
  const quote = await jupiterQuote({
    inputMint: WSOL_MINT,
    outputMint: mint,
    amount: amountLamports,
    slippageBps,
  });
  if (!quote) {
    return { allowed: false, reasons: ['no buy route / quote failed'], quote: null, fillEstimate: null, priceImpactPct: null };
  }

  const priceImpactPct = quote.priceImpactPct != null ? Number(quote.priceImpactPct) * 100 : null;
  if (priceImpactPct == null || !Number.isFinite(priceImpactPct)) {
    return { allowed: false, reasons: ['price impact unknown'], quote, fillEstimate: null, priceImpactPct: null };
  }
  if (priceImpactPct > maxImpactPct) {
    return {
      allowed: false,
      reasons: [`price impact ${priceImpactPct.toFixed(1)}% > max ${maxImpactPct}%`],
      quote,
      fillEstimate: null,
      priceImpactPct,
    };
  }

  // Guard 2: token safety (authority + sellability using the quoted token amount).
  const safety = await checkTokenSafety(mint, { tokenAmount: quote.outAmount });
  if (!safety.safe) {
    return { allowed: false, reasons: safety.reasons, quote, fillEstimate: null, priceImpactPct };
  }

  const solUsd = await fetchSolUsdPrice();
  const fillEstimate = buildFillEstimate(quote, amountLamports, solUsd, candidate.metrics?.priceUsd);

  return { allowed: true, reasons: [], quote, fillEstimate, priceImpactPct };
}
