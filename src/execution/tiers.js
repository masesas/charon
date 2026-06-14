import { db } from '../db/connection.js';
import { numSetting, boolSetting } from '../db/settings.js';

/**
 * Tier classification + profile lookup.
 *
 * Tier is an EXECUTION layer on top of the active strategy: the strategy owns
 * filtering/screening/entry_mode/use_llm, while the tier owns execution params
 * (sizing, slippage, TP/SL/trailing, partial TP, price-impact cap, slot cap).
 *
 * Classification uses market cap as the primary axis, with liquidity as a
 * downgrade tie-break (a high mcap with thin liquidity behaves like a lower
 * tier for execution purposes).
 */

export const TIERS = ['lowcap', 'midcap', 'highcap'];

// Default boundaries (USD). Overridable via the tier_profiles table thresholds.
const DEFAULT_LOWCAP_MAX = 50_000;
const DEFAULT_MIDCAP_MAX = 200_000;

/**
 * Classify a candidate into a tier. Total function — never throws, always
 * returns a valid tier. When mcap is unknown, defaults to 'midcap' (neutral).
 */
export function classifyTier(mcapUsd, liquidityUsd) {
  const mcap = Number(mcapUsd);
  if (!Number.isFinite(mcap) || mcap <= 0) return 'midcap';

  let tier = mcap < DEFAULT_LOWCAP_MAX ? 'lowcap'
    : mcap < DEFAULT_MIDCAP_MAX ? 'midcap'
    : 'highcap';

  // Liquidity downgrade: a token priced as highcap/midcap but with thin
  // liquidity relative to mcap is risky to size/exit like its mcap suggests.
  const liq = Number(liquidityUsd);
  if (Number.isFinite(liq) && liq > 0) {
    const ratio = mcap / liq;
    if (tier === 'highcap' && ratio > 30) tier = 'midcap';
    if (tier === 'midcap' && ratio > 40) tier = 'lowcap';
  }
  return tier;
}

const tierCache = new Map(); // tier -> { config, at }
const TIER_CACHE_TTL_MS = 5000;

function defaultTierProfile(tier) {
  const profiles = {
    lowcap: {
      position_size_sol: 0.05, slippage_bps: 800, max_price_impact_pct: 10,
      tp_percent: 80, sl_percent: -35, trailing_enabled: true, trailing_percent: 25,
      partial_tp: true, partial_tp_at_percent: 60, partial_tp_sell_percent: 50,
      max_open_positions: 2,
    },
    midcap: {
      position_size_sol: 0.1, slippage_bps: 300, max_price_impact_pct: 6,
      tp_percent: 50, sl_percent: -25, trailing_enabled: true, trailing_percent: 20,
      partial_tp: false, partial_tp_at_percent: 0, partial_tp_sell_percent: 0,
      max_open_positions: 2,
    },
    highcap: {
      position_size_sol: 0.15, slippage_bps: 150, max_price_impact_pct: 3,
      tp_percent: 30, sl_percent: -15, trailing_enabled: true, trailing_percent: 12,
      partial_tp: false, partial_tp_at_percent: 0, partial_tp_sell_percent: 0,
      max_open_positions: 1,
    },
  };
  return profiles[tier] || profiles.midcap;
}

/**
 * Read a tier profile from the tier_profiles table (5s cache), falling back to
 * the hardcoded default if the row is missing or unparseable.
 */
export function getTierProfile(tier) {
  const key = TIERS.includes(tier) ? tier : 'midcap';
  const cached = tierCache.get(key);
  if (cached && Date.now() - cached.at < TIER_CACHE_TTL_MS) return cached.config;
  let config = defaultTierProfile(key);
  try {
    const row = db.prepare('SELECT config_json FROM tier_profiles WHERE tier = ?').get(key);
    if (row?.config_json) config = { ...config, ...JSON.parse(row.config_json) };
  } catch {
    // table may not exist yet (pre-init) — fall back to defaults
  }
  tierCache.set(key, { config, at: Date.now() });
  return config;
}

export function allTierProfiles() {
  return TIERS.map(tier => ({ tier, ...getTierProfile(tier) }));
}

/**
 * Update a single field on a tier profile and bust the cache.
 */
export function updateTierProfile(tier, key, value) {
  const t = TIERS.includes(tier) ? tier : 'midcap';
  const current = getTierProfile(t);
  const next = { ...current, [key]: value };
  db.prepare('UPDATE tier_profiles SET config_json = ? WHERE tier = ?').run(JSON.stringify(next), t);
  tierCache.delete(t);
  return next;
}

/**
 * Effective position size = tier base size scaled by a deterministic score-based
 * multiplier (quality raises, risk lowers), clamped within [min, max] where max
 * defaults to 1.0 so it never exceeds the tier base. Pure function of scores +
 * profile, so independent reads (live swap amount vs stored size_sol) agree.
 * Neutral (returns base) when sizing_modifier_enabled is false.
 */
export function effectivePositionSizeSol(candidate, profile) {
  const base = Number(profile?.position_size_sol);
  // Return undefined (not NaN) when base is invalid so callers' `?? fallback` works
  // (NaN ?? x === NaN, which would silently corrupt the size).
  if (!Number.isFinite(base) || base <= 0) return undefined;
  if (!boolSetting('sizing_modifier_enabled', false)) return base;
  const q = Number(candidate?.scores?.quality_score ?? 50);
  const r = Number(candidate?.scores?.risk_score ?? 50);
  let m = 1 + ((q - 50) - (r - 50)) / 100; // q===r → 1.0
  const lo = numSetting('sizing_min_multiplier', 0.5);
  const hi = numSetting('sizing_max_multiplier', 1.0);
  m = Math.min(hi, Math.max(lo, m));
  return base * m;
}

export function resolveTierProfile(candidate) {
  if (candidate?.tierProfile && candidate?.tier) {
    return { tier: candidate.tier, profile: candidate.tierProfile };
  }
  const tier = classifyTier(candidate?.metrics?.marketCapUsd, candidate?.metrics?.liquidityUsd);
  return { tier, profile: getTierProfile(tier) };
}
