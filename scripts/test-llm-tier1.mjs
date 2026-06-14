// Tier 1 verification — run: node scripts/test-llm-tier1.mjs
// Uses a throwaway temp DB (NOT data/charon.db). Tests pure helpers, the live
// success path (root-cause stream:false fix), and the dead-endpoint fallback path.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Point the DB at a temp file BEFORE importing anything that touches connection.js.
const tmpDb = path.join(os.tmpdir(), `charon-test-${process.pid}.sqlite`);
process.env.DB_PATH = tmpDb;

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

const { initDb } = await import('../src/db/connection.js');
initDb();
const llm = await import('../src/pipeline/llm.js');

console.log('\n[1] describeAxiosError never returns empty');
ok('http error', describeNonEmpty(llm.describeAxiosError({ response: { status: 500, statusText: 'Internal', data: 'boom' } })));
ok('code error', describeNonEmpty(llm.describeAxiosError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' })));
ok('empty message', describeNonEmpty(llm.describeAxiosError({ message: '' })), '(the original bug)');
ok('null error', describeNonEmpty(llm.describeAxiosError(null)));
function describeNonEmpty(s) { return typeof s === 'string' && s.trim().length > 0; }

console.log('\n[2] isRetryableLlmError classification');
ok('timeout retryable', llm.isRetryableLlmError({ code: 'ECONNABORTED' }) === true);
ok('refused retryable', llm.isRetryableLlmError({ code: 'ECONNREFUSED' }) === true);
ok('500 retryable', llm.isRetryableLlmError({ response: { status: 503 } }) === true);
ok('429 retryable', llm.isRetryableLlmError({ response: { status: 429 } }) === true);
ok('400 NOT retryable', llm.isRetryableLlmError({ response: { status: 400 } }) === false);
ok('parseEmpty retryable', llm.isRetryableLlmError({ __parseEmpty: true }) === true);

console.log('\n[3] deterministicFallbackDecision');
const rows = [
  { id: 1, candidate: { token: { mint: 'MintA' }, scores: { quality_score: 70, risk_score: 30 } } },
  { id: 2, candidate: { token: { mint: 'MintB' }, scores: { quality_score: 90, risk_score: 20 } } }, // best q-r=70
  { id: 3, candidate: { token: { mint: 'MintC' }, scores: { quality_score: 40, risk_score: 80 } } }, // fails gates
];
const fb = llm.deterministicFallbackDecision(rows);
ok('picks BUY', fb.verdict === 'BUY', `got ${fb.verdict}`);
ok('picks best q-r (MintB)', fb.selected_mint === 'MintB', `got ${fb.selected_mint}`);
ok('confidence = 55 default', fb.confidence === 55, `got ${fb.confidence}`);
ok('risks tagged llm_fallback', Array.isArray(fb.risks) && fb.risks.includes('llm_fallback'));

const noneRows = [{ id: 9, candidate: { token: { mint: 'X' }, scores: { quality_score: 10, risk_score: 90 } } }];
const fbNone = llm.deterministicFallbackDecision(noneRows);
ok('no eligible -> WATCH', fbNone.verdict === 'WATCH', `got ${fbNone.verdict}`);
ok('no eligible -> confidence 0', fbNone.confidence === 0);

// Malformed candidate (missing token) with otherwise-passing scores must NOT be
// selected (would throw on token.mint). Regression for review HIGH #1.
const malformed = [{ id: 5, candidate: { scores: { quality_score: 95, risk_score: 5 } } }]; // no token
let malformedDecision;
try {
  malformedDecision = llm.deterministicFallbackDecision(malformed);
  ok('malformed candidate does not throw', true);
  ok('malformed candidate -> WATCH (not selected)', malformedDecision.verdict === 'WATCH', `got ${malformedDecision.verdict}`);
} catch (e) {
  ok('malformed candidate does not throw', false, e.message);
}

console.log('\n[3b] decideCandidate preserves fallback verdict (review MEDIUM #2)');
// normalizeDecision applied to a fallback BUY must keep BUY, not collapse to WATCH.
const fbBuy = llm.deterministicFallbackDecision(rows); // picks MintB BUY
ok('precondition: fallback is BUY', fbBuy.verdict === 'BUY');
const reNorm = llm.normalizeDecision(fbBuy, fbBuy.reason);
ok('normalizeDecision(decision) keeps BUY', reNorm.verdict === 'BUY', `got ${reNorm.verdict}`);
ok('normalizeDecision keeps confidence', reNorm.confidence === 55, `got ${reNorm.confidence}`);

console.log('\n[4] live success path (root-cause stream:false fix)');
// Requires the real endpoint to be up; if down, this exercises the fallback path.
const liveRows = [{ id: 100, candidate: {
  token: { mint: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL', symbol: 'SOL' },
  signals: { route: 'test', label: 'test' },
  metrics: { marketCapUsd: 50000, liquidityUsd: 20000, holderCount: 500 },
  scores: { quality_score: 65, risk_score: 35 },
  holders: {}, chart: {}, filters: { passed: true },
} }];
try {
  const decision = await llm.decideCandidateBatch(liveRows, 100);
  const isFallback = decision?.raw?.fallback === true || (decision.risks || []).includes('llm_fallback') || (decision.risks || []).includes('llm_unavailable');
  if (isFallback) {
    console.log('  ⚠ endpoint unreachable — got deterministic fallback (expected if LLM down)');
    ok('fallback reason non-empty', describeNonEmpty(decision.reason));
    ok('fallback never legacy empty "LLM failed: "', decision.reason !== 'LLM failed: ');
  } else {
    ok('live verdict valid', ['BUY', 'WATCH', 'PASS'].includes(decision.verdict), `got ${decision.verdict}`);
    ok('live reason non-empty', describeNonEmpty(decision.reason));
    console.log(`     verdict=${decision.verdict} confidence=${decision.confidence} reason="${String(decision.reason).slice(0, 80)}"`);
  }
} catch (e) {
  fail++; console.log(`  ✗ live call threw (should never throw): ${e.message}`);
}

// cleanup
try { fs.rmSync(tmpDb, { force: true }); } catch {}
try { fs.rmSync(`${tmpDb}-wal`, { force: true }); } catch {}
try { fs.rmSync(`${tmpDb}-shm`, { force: true }); } catch {}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
