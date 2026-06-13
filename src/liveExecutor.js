import axios from 'axios';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import {
  JUPITER_API_KEY,
  JUPITER_SLIPPAGE_BPS,
  JUPITER_SWAP_BASE_URL,
  JSON_HEADERS,
  SOLANA_PRIVATE_KEY,
  SOLANA_RPC_URL,
  GUARD_QUOTE_TIMEOUT_MS,
} from './config.js';
import { recordHealthSuccess, recordHealthFailure } from './health/providerHealth.js';
import { now } from './utils.js';

let liveWallet = null;
let solanaConnection = null;

function parseKeypair(secret) {
  const value = String(secret || '').trim();
  if (!value) return null;
  if (value.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(value)));
  return Keypair.fromSecretKey(bs58.decode(value));
}

export function initLiveExecution() {
  if (!SOLANA_PRIVATE_KEY) return;
  try {
    liveWallet = parseKeypair(SOLANA_PRIVATE_KEY);
    solanaConnection = new Connection(SOLANA_RPC_URL, 'confirmed');
    console.log(`[live] wallet loaded ${liveWallet.publicKey.toBase58()}`);
  } catch (err) {
    liveWallet = null;
    solanaConnection = null;
    console.log(`[live] wallet load failed: ${err.message}`);
  }
}

export function liveWalletPubkey() {
  return liveWallet?.publicKey?.toBase58() || null;
}

export async function fetchLiveTokenBalance(mint) {
  if (!liveWallet || !solanaConnection) return null;
  const start = now();
  try {
    const accounts = await solanaConnection.getParsedTokenAccountsByOwner(
      liveWallet.publicKey,
      { mint: new PublicKey(mint) },
      'confirmed',
    );
    recordHealthSuccess('rpc', 'getParsedTokenAccountsByOwner', now() - start);
    return accounts.value[0]?.account?.data?.parsed?.info?.tokenAmount?.amount || null;
  } catch (err) {
    recordHealthFailure('rpc', 'getParsedTokenAccountsByOwner', err);
    console.log(`[live] token balance ${mint.slice(0, 8)}... ${err.message}`);
    return null;
  }
}

export function requireLiveExecution() {
  if (!liveWallet || !solanaConnection) throw new Error('SOLANA_PRIVATE_KEY is required for live execution.');
  if (!JUPITER_API_KEY) throw new Error('JUPITER_API_KEY is required for live execution.');
}

export async function liveWalletBalanceLamports() {
  requireLiveExecution();
  const start = now();
  try {
    const balance = await solanaConnection.getBalance(liveWallet.publicKey, 'confirmed');
    recordHealthSuccess('rpc', 'getBalance', now() - start);
    return balance;
  } catch (err) {
    recordHealthFailure('rpc', 'getBalance', err);
    throw err;
  }
}

/**
 * Walletless price quote (no taker required). Works in dry-run with no private key.
 * Used by entry guards for price-impact gating and dry-run fill estimation.
 * Returns the raw Jupiter quote object (incl. outAmount, inAmount, priceImpactPct)
 * or null on failure (callers must fail-closed on null).
 */
export async function jupiterQuote({ inputMint, outputMint, amount, slippageBps = JUPITER_SLIPPAGE_BPS }) {
  const start = now();
  try {
    const url = new URL('https://lite-api.jup.ag/swap/v1/quote');
    url.searchParams.set('inputMint', inputMint);
    url.searchParams.set('outputMint', outputMint);
    url.searchParams.set('amount', String(amount));
    url.searchParams.set('slippageBps', String(slippageBps));
    const res = await axios.get(url.toString(), {
      timeout: GUARD_QUOTE_TIMEOUT_MS,
      headers: JSON_HEADERS,
    });
    const quote = res.data;
    if (!quote || !quote.outAmount || Number(quote.outAmount) <= 0) {
      recordHealthFailure('jupiter', 'quote', 'no route');
      return null;
    }
    recordHealthSuccess('jupiter', 'quote', now() - start);
    return quote;
  } catch (err) {
    recordHealthFailure('jupiter', 'quote', err);
    if (err.response?.status !== 429) console.log(`[quote] ${outputMint.slice(0, 8)}... ${err.response?.status || ''} ${err.message}`);
    return null;
  }
}

async function jupiterOrder({ inputMint, outputMint, amount, slippageBps = null }) {
  requireLiveExecution();
  const url = new URL(`${JUPITER_SWAP_BASE_URL.replace(/\/$/, '')}/order`);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', String(amount));
  url.searchParams.set('taker', liveWallet.publicKey.toBase58());
  // Per-tier slippage. When null, Jupiter auto-determines slippage (prior behavior).
  if (slippageBps != null && Number.isFinite(Number(slippageBps))) {
    url.searchParams.set('slippageBps', String(Math.floor(Number(slippageBps))));
  }
  const res = await axios.get(url.toString(), {
    timeout: 20_000,
    headers: { ...JSON_HEADERS, 'x-api-key': JUPITER_API_KEY },
  });
  const order = res.data;
  if (order.errorCode || order.error) {
    throw new Error(`Jupiter order failed: ${order.errorMessage || order.error || order.errorCode}`);
  }
  return order;
}

function orderTransactionBase64(order) {
  return order?.transaction || order?.swapTransaction || null;
}

function signTransactionBase64(transactionBase64) {
  const tx = VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64'));
  tx.sign([liveWallet]);
  return Buffer.from(tx.serialize()).toString('base64');
}

async function jupiterExecute(order, signedTransaction) {
  requireLiveExecution();
  const body = {
    signedTransaction,
    requestId: order.requestId,
  };
  const res = await axios.post(`${JUPITER_SWAP_BASE_URL.replace(/\/$/, '')}/execute`, body, {
    timeout: 30_000,
    headers: { ...JSON_HEADERS, 'content-type': 'application/json', 'x-api-key': JUPITER_API_KEY },
  });
  return res.data;
}

export async function executeJupiterSwap({ inputMint, outputMint, amount, slippageBps = null }) {
  const start = now();
  try {
    const order = await jupiterOrder({ inputMint, outputMint, amount, slippageBps });
    const transaction = orderTransactionBase64(order);
    if (!transaction) throw new Error('Jupiter order did not include a transaction.');
    const signedTransaction = signTransactionBase64(transaction);
    const executed = await jupiterExecute(order, signedTransaction);
    if (executed?.status && executed.status !== 'Success') {
      throw new Error(`Jupiter execute failed: ${executed.error || executed.code || executed.status}`);
    }
    const signature = executed?.signature || executed?.txid || executed?.transactionId || null;
    if (!signature) {
      throw new Error(`Jupiter execute returned no signature (status: ${executed?.status || 'unknown'})`);
    }
    recordHealthSuccess('rpc', 'swap', now() - start);
    return {
      order,
      executed,
      signature,
      inputAmount: String(amount),
      outputAmount: String(executed?.outputAmountResult || executed?.totalOutputAmount || order?.outAmount || ''),
    };
  } catch (err) {
    recordHealthFailure('rpc', 'swap', err);
    throw err;
  }
}
