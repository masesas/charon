/**
 * Scoring module for token candidates
 * Computes confidence, risk, and quality scores based on multiple factors
 */

/**
 * Calculate confidence score (0-100) based on signal strength and data quality
 * Higher score = more confidence in the trade decision
 */
export function calculateConfidenceScore(candidate) {
  let score = 0;
  let factors = 0;

  // Fee claim signal (strong signal) - up to 25 points
  if (candidate.feeClaim?.distributedSol) {
    const feeSol = candidate.feeClaim.distributedSol;
    if (feeSol >= 10) score += 25;
    else if (feeSol >= 5) score += 20;
    else if (feeSol >= 2) score += 15;
    else if (feeSol >= 0.5) score += 10;
    else score += 5;
    factors++;
  }

  // Trending signal - up to 20 points
  if (candidate.trending) {
    const volume = Number(candidate.trending.volume ?? 0);
    const swaps = Number(candidate.trending.swaps ?? 0);
    const rugRatio = Number(candidate.trending.rug_ratio ?? 1);
    const bundlerRate = Number(candidate.trending.bundler_rate ?? 1);

    if (rugRatio < 0.1 && bundlerRate < 0.2) score += 20;
    else if (rugRatio < 0.2 && bundlerRate < 0.3) score += 15;
    else if (rugRatio < 0.3 && bundlerRate < 0.5) score += 10;
    else score += 5;

    if (volume >= 10000) score += 5;
    if (swaps >= 100) score += 5;
    factors++;
  }

  // Graduated token - up to 15 points
  if (candidate.graduation) {
    score += 15;
    factors++;
  }

  // Multiple signal sources - up to 15 points
  const signalCount = [
    candidate.feeClaim,
    candidate.trending,
    candidate.graduation,
  ].filter(Boolean).length;
  if (signalCount >= 3) score += 15;
  else if (signalCount >= 2) score += 10;
  else if (signalCount >= 1) score += 5;

  // Saved wallet exposure - up to 15 points
  if (candidate.savedWalletExposure?.holderCount > 0) {
    const count = candidate.savedWalletExposure.holderCount;
    if (count >= 5) score += 15;
    else if (count >= 3) score += 10;
    else score += 5;
    factors++;
  }

  // Holder count - up to 10 points
  const holderCount = Number(candidate.metrics?.holderCount ?? 0);
  if (holderCount >= 1000) score += 10;
  else if (holderCount >= 500) score += 7;
  else if (holderCount >= 100) score += 5;
  else if (holderCount >= 50) score += 3;

  // Normalize to 0-100
  return Math.min(100, Math.max(0, score));
}

/**
 * Calculate risk score (0-100) where lower is safer
 * Higher score = higher risk
 */
export function calculateRiskScore(candidate) {
  let risk = 50; // Start at neutral

  // Holder concentration - higher concentration = higher risk
  const maxHolder = candidate.holders?.maxHolderPercent ?? 100;
  if (maxHolder > 50) risk += 20;
  else if (maxHolder > 30) risk += 10;
  else if (maxHolder > 20) risk += 5;
  else risk -= 10;

  // Top 20 holder concentration
  const top20 = candidate.holders?.top20Percent ?? 100;
  if (top20 > 80) risk += 15;
  else if (top20 > 60) risk += 8;
  else if (top20 > 40) risk += 3;
  else risk -= 5;

  // Rug ratio from trending data
  if (candidate.trending) {
    const rugRatio = Number(candidate.trending.rug_ratio ?? 0);
    if (rugRatio > 0.5) risk += 25;
    else if (rugRatio > 0.3) risk += 15;
    else if (rugRatio > 0.2) risk += 8;
    else risk -= 5;
  }

  // Bundler rate
  if (candidate.trending) {
    const bundlerRate = Number(candidate.trending.bundler_rate ?? 0);
    if (bundlerRate > 0.5) risk += 20;
    else if (bundlerRate > 0.3) risk += 12;
    else if (bundlerRate > 0.2) risk += 5;
    else risk -= 5;
  }

  // Wash trading flag
  if (candidate.trending?.is_wash_trading) {
    risk += 30;
  }

  // Market cap risk - very low mcap = higher risk
  const mcap = candidate.metrics?.marketCapUsd ?? 0;
  if (mcap < 5000) risk += 15;
  else if (mcap < 10000) risk += 10;
  else if (mcap > 500000) risk += 5; // High mcap also risky for pump tokens

  // Fee claim reduces risk (proven interest)
  if (candidate.feeClaim?.distributedSol >= 2) {
    risk -= 10;
  }

  // Graduation status reduces risk
  if (candidate.graduation) {
    risk -= 15;
  }

  // Normalize to 0-100
  return Math.min(100, Math.max(0, risk));
}

/**
 * Calculate quality score (0-100) based on token fundamentals
 * Higher score = better quality token
 */
export function calculateQualityScore(candidate) {
  let score = 0;

  // Holder count quality
  const holderCount = Number(candidate.metrics?.holderCount ?? 0);
  if (holderCount >= 1000) score += 20;
  else if (holderCount >= 500) score += 15;
  else if (holderCount >= 200) score += 10;
  else if (holderCount >= 100) score += 5;

  // Liquidity (via market cap as proxy)
  const mcap = candidate.metrics?.marketCapUsd ?? 0;
  if (mcap >= 100000) score += 15;
  else if (mcap >= 50000) score += 12;
  else if (mcap >= 20000) score += 8;
  else if (mcap >= 10000) score += 5;

  // GMGN fees (indicates trading activity)
  const fees = candidate.metrics?.gmgnTotalFeesSol ?? 0;
  if (fees >= 50) score += 15;
  else if (fees >= 20) score += 10;
  else if (fees >= 10) score += 7;
  else if (fees >= 5) score += 4;

  // Social links presence
  const hasTwitter = Boolean(candidate.token?.twitter);
  const hasWebsite = Boolean(candidate.token?.website);
  const hasTelegram = Boolean(candidate.token?.telegram);
  const socialCount = [hasTwitter, hasWebsite, hasTelegram].filter(Boolean).length;
  score += socialCount * 3;

  // Holder distribution quality
  const maxHolder = candidate.holders?.maxHolderPercent ?? 100;
  if (maxHolder < 10) score += 15;
  else if (maxHolder < 20) score += 10;
  else if (maxHolder < 30) score += 5;

  // Graduated token quality
  if (candidate.graduation) {
    score += 10;
    const gradVolume = candidate.metrics?.graduatedVolumeUsd ?? 0;
    if (gradVolume >= 100000) score += 10;
    else if (gradVolume >= 50000) score += 5;
  }

  // Trending quality indicators
  if (candidate.trending) {
    const volume = Number(candidate.trending.volume ?? 0);
    const swaps = Number(candidate.trending.swaps ?? 0);
    if (volume >= 50000) score += 10;
    else if (volume >= 20000) score += 5;
    if (swaps >= 500) score += 5;
    else if (swaps >= 200) score += 3;
  }

  // Normalize to 0-100
  return Math.min(100, Math.max(0, score));
}

/**
 * Calculate all scores for a candidate
 * Returns object with confidence, risk, and quality scores
 */
export function calculateScores(candidate) {
  return {
    confidence_score: calculateConfidenceScore(candidate),
    risk_score: calculateRiskScore(candidate),
    quality_score: calculateQualityScore(candidate),
  };
}

/**
 * Update candidate with computed scores
 * Adds scores to candidate object
 */
export function scoreCandidate(candidate) {
  const scores = calculateScores(candidate);
  return {
    ...candidate,
    scores,
    confidence_score: scores.confidence_score,
    risk_score: scores.risk_score,
    quality_score: scores.quality_score,
  };
}
