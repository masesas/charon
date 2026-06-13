import { Connection, PublicKey } from '@solana/web3.js';
import { SOLANA_RPC_URL, WSOL_MINT } from '../config.js';
import { now } from '../utils.js';
import { jupiterQuote } from '../liveExecutor.js';
import { recordHealthSuccess, recordHealthFailure } from '../health/providerHealth.js';

/**
 * Read-only Solana connection, independent of the live trading wallet.
 * Available even in pure dry-run (no SOLANA_PRIVATE_KEY), because mint-authority
 * is a read-only account fetch needing no signer. Lazily initialized.
 */
let readOnlyConnection = null;
function getReadOnlyConnection() {
  if (!readOnlyConnection) {
    readOnlyConnection = new Connection(SOLANA_RPC_URL, 'confirmed');
  }
  return readOnlyConnection;
}

/**
 * Cache of mints proven safe (renounced authorities). Renouncement is permanent,
 * so a positive result is cached forever. Negative/failed results are NOT cached
 * (they can be transient network failures or a mint that later renounces).
 */
const safeMintCache = new Set();

/**
 * Check mint & freeze authority via RPC.
 * Rejects if either authority is still set (token can be minted or frozen).
 * FAIL-CLOSED: any RPC failure returns safe:false (an un-verifiable mint is
 * treated as dangerous).
 */
export async function checkMintAuthority(mint) {
  if (safeMintCache.has(mint)) return { safe: true, reasons: [] };
  const start = now();
  try {
    const info = await getReadOnlyConnection().getParsedAccountInfo(new PublicKey(mint));
    const parsed = info?.value?.data?.parsed;
    if (!parsed || parsed.type !== 'mint') {
      recordHealthFailure('rpc', 'getParsedAccountInfo', 'not a mint account');
      return { safe: false, reasons: ['mint account not parseable'] };
    }
    const mintAuthority = parsed.info?.mintAuthority ?? null;
    const freezeAuthority = parsed.info?.freezeAuthority ?? null;
    const reasons = [];
    if (mintAuthority !== null) reasons.push('mint authority not renounced');
    if (freezeAuthority !== null) reasons.push('freeze authority active (freezable)');
    recordHealthSuccess('rpc', 'getParsedAccountInfo', now() - start);
    if (reasons.length === 0) {
      safeMintCache.add(mint);
      return { safe: true, reasons: [] };
    }
    return { safe: false, reasons };
  } catch (err) {
    recordHealthFailure('rpc', 'getParsedAccountInfo', err);
    return { safe: false, reasons: [`authority check failed: ${err.message}`] };
  }
}

/**
 * Sellability check: a reverse quote (token -> WSOL). If no sell route exists,
 * the token is very likely a honeypot.
 * FAIL-CLOSED: a null quote (no route / network failure) returns safe:false.
 */
export async function checkSellable(mint, tokenAmount) {
  const amount = Number(tokenAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    // No token amount to probe with (e.g. dry-run before fill estimate);
    // skip this sub-check rather than block — authority + buy-quote still gate.
    return { safe: true, reasons: [] };
  }
  const quote = await jupiterQuote({ inputMint: mint, outputMint: WSOL_MINT, amount: Math.floor(amount) });
  if (!quote) {
    return { safe: false, reasons: ['no sell route (possible honeypot)'] };
  }
  return { safe: true, reasons: [] };
}

/**
 * Combined token safety check. Authority is always probed; sellability is probed
 * only when a token amount is available. Returns { safe, reasons }.
 */
export async function checkTokenSafety(mint, { tokenAmount = null } = {}) {
  const authority = await checkMintAuthority(mint);
  const reasons = [...authority.reasons];
  let safe = authority.safe;
  if (tokenAmount != null) {
    const sellable = await checkSellable(mint, tokenAmount);
    safe = safe && sellable.safe;
    reasons.push(...sellable.reasons);
  }
  return { safe, reasons };
}
