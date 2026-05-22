import { db } from '../db/connection.js';
import { now, json } from '../utils.js';
import { liveWalletPubkey } from '../liveExecutor.js';
import { fetchJupiterAsset } from '../enrichment/jupiter.js';
import { Connection, PublicKey } from '@solana/web3.js';

const RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC_ENDPOINT);

/**
 * Reconcile wallet balances against open positions
 * Detects orphaned tokens and balance mismatches
 */
export async function reconcileWallet() {
  const walletAddress = liveWalletPubkey();
  if (!walletAddress) {
    console.log('[reconcile] No live wallet configured, skipping reconciliation');
    return null;
  }

  const reconciliationAtMs = now();
  const openPositions = db.prepare(`
    SELECT id, mint, size_sol, status, opened_at_ms
    FROM dry_run_positions
    WHERE status = 'open' AND execution_mode = 'live'
  `).all();

  const mints = openPositions.map(p => p.mint);
  const walletTokens = await fetchWalletTokens(walletAddress);
  const tokenBalances = new Map();

  // Fetch current balances for all tokens
  for (const mint of mints) {
    try {
      const balance = await getTokenBalance(walletAddress, mint);
      tokenBalances.set(mint, balance);
    } catch (err) {
      console.log(`[reconcile] Failed to fetch balance for ${mint}: ${err.message}`);
      tokenBalances.set(mint, null);
    }
  }

  // Detect orphaned tokens (in wallet but not in open positions)
  const orphanedTokens = [];
  for (const token of walletTokens) {
    if (!mints.includes(token.mint) && Number(token.amount) > 0) {
      orphanedTokens.push(token);
    }
  }

  // Check for balance mismatches
  const mismatches = [];
  for (const position of openPositions) {
    const walletBalance = tokenBalances.get(position.mint);
    if (walletBalance === null) continue;

    const expectedTokens = Number(position.token_amount_est || 0);
    const actualTokens = Number(walletBalance);
    const mismatchTokens = Math.abs(expectedTokens - actualTokens);

    if (mismatchTokens > 0) {
      mismatches.push({
        position_id: position.id,
        mint: position.mint,
        expected_tokens: expectedTokens,
        actual_tokens: actualTokens,
        mismatch_tokens: mismatchTokens,
      });

      // Update position with mismatch info
      const asset = await fetchJupiterAsset(position.mint);
      const mismatchSol = (mismatchTokens / (actualTokens || 1)) * Number(position.size_sol);
      db.prepare(`
        UPDATE dry_run_positions
        SET balance_mismatch_sol = ?, last_reconciled_at_ms = ?
        WHERE id = ?
      `).run(mismatchSol, reconciliationAtMs, position.id);
    } else {
      // No mismatch, update reconciliation timestamp
      db.prepare(`
        UPDATE dry_run_positions
        SET last_reconciled_at_ms = ?, balance_mismatch_sol = 0
        WHERE id = ?
      `).run(reconciliationAtMs, position.id);
    }
  }

  // Mark orphaned positions
  for (const orphan of orphanedTokens) {
    const position = openPositions.find(p => p.mint === orphan.mint);
    if (position) {
      db.prepare(`
        UPDATE dry_run_positions
        SET is_orphaned = 1, last_reconciled_at_ms = ?
        WHERE id = ?
      `).run(reconciliationAtMs, position.id);
    }
  }

  // Calculate totals
  let totalBalanceSol = 0;
  let totalBalanceUsd = 0;
  for (const position of openPositions) {
    totalBalanceSol += Number(position.size_sol || 0);
    const asset = await fetchJupiterAsset(position.mint).catch(() => null);
    if (asset?.usdPrice) {
      const tokenBalance = tokenBalances.get(position.mint) || 0;
      totalBalanceUsd += tokenBalance * asset.usdPrice;
    }
  }

  // Log reconciliation result
  const summary = {
    wallet_address: walletAddress,
    positions_count: openPositions.length,
    orphaned_tokens_count: orphanedTokens.length,
    mismatches_count: mismatches.length,
    total_balance_sol: totalBalanceSol,
    total_balance_usd: totalBalanceUsd,
    orphaned_tokens: orphanedTokens.map(t => ({ mint: t.mint, amount: t.amount })),
    mismatches: mismatches,
  };

  db.prepare(`
    INSERT INTO wallet_reconciliation_logs
    (reconciliation_at_ms, wallet_address, total_balance_sol, total_balance_usd, positions_count, orphaned_tokens_count, mismatches_count, status, summary_json, created_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)
  `).run(
    reconciliationAtMs,
    walletAddress,
    totalBalanceSol,
    totalBalanceUsd,
    openPositions.length,
    orphanedTokens.length,
    mismatches.length,
    json(summary),
    now()
  );

  console.log(`[reconcile] Wallet reconciliation complete: ${openPositions.length} positions, ${orphanedTokens.length} orphaned, ${mismatches.length} mismatches`);
  return summary;
}

/**
 * Fetch all token accounts for a wallet
 */
async function fetchWalletTokens(walletAddress) {
  try {
    const pubkey = new PublicKey(walletAddress);
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubkey, {
      programId: new PublicKey('TokenkegQfeZyiNwAJsyFbPVwwQQfփ'),
    });

    return tokenAccounts.value
      .filter(acc => acc.account.data.parsed?.info?.tokenAmount?.uiAmount > 0)
      .map(acc => ({
        mint: acc.account.data.parsed.info.mint,
        amount: acc.account.data.parsed.info.tokenAmount.uiAmount,
        decimals: acc.account.data.parsed.info.tokenAmount.decimals,
      }));
  } catch (err) {
    console.log(`[reconcile] Failed to fetch wallet tokens: ${err.message}`);
    return [];
  }
}

/**
 * Get token balance for a specific mint
 */
async function getTokenBalance(walletAddress, mint) {
  try {
    const pubkey = new PublicKey(walletAddress);
    const mintPubkey = new PublicKey(mint);
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubkey, {
      mint: mintPubkey,
    });

    if (tokenAccounts.value.length === 0) return 0;
    return tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
  } catch (err) {
    console.log(`[reconcile] Failed to get balance for ${mint}: ${err.message}`);
    return null;
  }
}

/**
 * Check if a position is orphaned (token no longer in wallet)
 */
export function isPositionOrphaned(position) {
  return position.is_orphaned === 1;
}

/**
 * Check if a position has a balance mismatch
 */
export function hasBalanceMismatch(position) {
  return Number(position.balance_mismatch_sol || 0) !== 0;
}
