#!/usr/bin/env tsx
/**
 * Analyze specifically the FAILING swaps to understand why they fail
 * and whether they have bonding curve signatures
 */
import Database from 'better-sqlite3';

const db = new Database('data/evidence/capture.db', { readonly: true });

// WSOL mint
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Get the latest session
const sessionRow = db.prepare(`
  SELECT session_id as sessionId
  FROM parsed_swaps
  GROUP BY session_id
  ORDER BY MAX(confirm_ts) DESC
  LIMIT 1
`).get() as { sessionId: string };

const sessionId = sessionRow.sessionId;
console.log('Session:', sessionId);

// Load swaps with topology
const swaps = db.prepare(`
  SELECT
    ps.signature,
    ps.pool_pubkey,
    ps.input_amount,
    ps.actual_output_amount,
    ps.direction,
    mt.pre_balances_json,
    mt.post_balances_json,
    mt.accounts_json,
    ft.vault_base,
    ft.vault_quote
  FROM parsed_swaps ps
  JOIN mainnet_txs mt ON mt.signature = ps.signature AND mt.session_id = ps.session_id
  JOIN frozen_topologies ft ON ft.pool_pubkey = ps.pool_pubkey AND ft.session_id = ps.session_id
  WHERE ps.venue = 'pumpswap' AND ps.session_id = ?
  LIMIT 10000
`).all(sessionId) as any[];

console.log(`Loaded ${swaps.length} swaps`);

// Parse balance JSON
function getBalanceInfo(balancesJson: string, accountsJson: string, vaultHex: string): { amount: bigint; mint: string } | null {
  const balances = JSON.parse(balancesJson);
  const accounts = JSON.parse(accountsJson);
  const vaultIdx = accounts.indexOf(vaultHex);
  if (vaultIdx < 0) return null;
  const b = balances.find((x: any) => x.account_index === vaultIdx);
  return b ? { amount: BigInt(b.ui_token_amount.amount), mint: b.mint } : null;
}

// CPMM formula with input fee
function amountOutInputFee(reserveIn: bigint, reserveOut: bigint, amountIn: bigint, feeBps: bigint): bigint {
  if (reserveIn <= 0n || reserveOut <= 0n || amountIn <= 0n) return 0n;
  const amountInWithFee = amountIn * (10000n - feeBps);
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 10000n + amountInWithFee;
  return numerator / denominator;
}

// Error calculation
function errorBps(pred: bigint, actual: bigint): number {
  if (actual <= 0n) return Infinity;
  const absErr = pred > actual ? pred - actual : actual - pred;
  return Number((absErr * 10000n) / actual);
}

// Multi-swap detection
const swapCountBySig = new Map<string, number>();
for (const s of swaps) {
  swapCountBySig.set(s.signature, (swapCountBySig.get(s.signature) ?? 0) + 1);
}

const MIN_AMOUNT_IN = 10000n;
const MAX_RESERVE_RATIO = 10000n;
const TOLERANCE_BPS = 10;

type SwapResult = {
  pool: string;
  signature: string;
  ratio: number;
  reserveIn: bigint;
  reserveOut: bigint;
  amountIn: bigint;
  actualOut: bigint;
  predictedOut: bigint;
  errorBps: number;
  kPre: bigint;
  kPost: bigint;
  kChange: number;
  passed: boolean;
  skipReason?: string;
};

const results: SwapResult[] = [];
let skipped = { multiSwap: 0, dust: 0, weirdFlow: 0, bondingCurve: 0, missingBalance: 0 };

for (const swap of swaps) {
  // Skip multi-swap
  if (swapCountBySig.get(swap.signature)! > 1) {
    skipped.multiSwap++;
    continue;
  }

  const baseInfo = getBalanceInfo(swap.pre_balances_json, swap.accounts_json, swap.vault_base);
  const quoteInfo = getBalanceInfo(swap.pre_balances_json, swap.accounts_json, swap.vault_quote);
  const basePostInfo = getBalanceInfo(swap.post_balances_json, swap.accounts_json, swap.vault_base);
  const quotePostInfo = getBalanceInfo(swap.post_balances_json, swap.accounts_json, swap.vault_quote);

  if (!baseInfo || !quoteInfo || !basePostInfo || !quotePostInfo) {
    skipped.missingBalance++;
    continue;
  }

  // Normalize: quote is SOL
  let basePre = baseInfo.amount;
  let quotePre = quoteInfo.amount;
  let basePost = basePostInfo.amount;
  let quotePost = quotePostInfo.amount;

  if (baseInfo.mint === WSOL_MINT) {
    [basePre, quotePre] = [quotePre, basePre];
    [basePost, quotePost] = [quotePost, basePost];
  }

  // Derive direction from vault deltas
  const baseDelta = basePost - basePre;
  const quoteDelta = quotePost - quotePre;

  let reserveIn: bigint;
  let reserveOut: bigint;
  let amountIn: bigint;
  let actualOut: bigint;

  if (baseDelta > 0n && quoteDelta < 0n) {
    // Token in, SOL out
    reserveIn = basePre;
    reserveOut = quotePre;
    amountIn = baseDelta;
    actualOut = -quoteDelta;
  } else if (baseDelta < 0n && quoteDelta > 0n) {
    // SOL in, Token out
    reserveIn = quotePre;
    reserveOut = basePre;
    amountIn = quoteDelta;
    actualOut = -baseDelta;
  } else {
    skipped.weirdFlow++;
    continue;
  }

  // Dust filter
  if (amountIn < MIN_AMOUNT_IN) {
    skipped.dust++;
    continue;
  }

  // Reserve ratio
  const ratio = reserveIn > reserveOut
    ? Number(reserveIn) / Number(reserveOut)
    : Number(reserveOut) / Number(reserveIn);

  // Bonding curve filter
  const reserveRatio = reserveIn > reserveOut
    ? reserveIn / (reserveOut > 0n ? reserveOut : 1n)
    : reserveOut / (reserveIn > 0n ? reserveIn : 1n);

  if (reserveRatio > MAX_RESERVE_RATIO) {
    skipped.bondingCurve++;
    continue;
  }

  // K-constant analysis
  const kPre = basePre * quotePre;
  const kPost = basePost * quotePost;
  const kChange = kPre > 0n ? (Number(kPost - kPre) / Number(kPre)) * 100 : 0;

  // Try different fee levels
  const feeLevels = [0n, 25n, 30n];
  let bestErr = Infinity;
  let bestPred = 0n;

  for (const fee of feeLevels) {
    const pred = amountOutInputFee(reserveIn, reserveOut, amountIn, fee);
    const err = errorBps(pred, actualOut);
    if (err < bestErr) {
      bestErr = err;
      bestPred = pred;
    }
  }

  results.push({
    pool: swap.pool_pubkey,
    signature: swap.signature,
    ratio,
    reserveIn,
    reserveOut,
    amountIn,
    actualOut,
    predictedOut: bestPred,
    errorBps: bestErr,
    kPre,
    kPost,
    kChange,
    passed: bestErr <= TOLERANCE_BPS,
  });
}

console.log(`\nProcessed ${results.length} swaps`);
console.log('Skipped:', skipped);

// Separate passing vs failing
const passing = results.filter(r => r.passed);
const failing = results.filter(r => !r.passed);

console.log(`\nPassing: ${passing.length} (${(passing.length / results.length * 100).toFixed(2)}%)`);
console.log(`Failing: ${failing.length} (${(failing.length / results.length * 100).toFixed(2)}%)`);

// Analyze failing swaps
console.log('\n=== FAILING SWAPS ANALYSIS ===');

// 1. Reserve ratio distribution of failing swaps
failing.sort((a, b) => b.ratio - a.ratio);
console.log('\nTop 20 failing swaps by reserve ratio:');
for (const f of failing.slice(0, 20)) {
  console.log(`  ratio=${f.ratio.toFixed(0).padStart(8)}:1  err=${f.errorBps.toFixed(0).padStart(4)}bps  kChange=${f.kChange.toFixed(4).padStart(8)}%  amtIn=${f.amountIn}  pool=${f.pool.slice(0, 16)}...`);
}

// 2. K-constant changes in failing swaps
console.log('\nK-constant changes in failing swaps:');
const failKChanges = failing.map(f => f.kChange);
failKChanges.sort((a, b) => a - b);
console.log(`  min:  ${failKChanges[0]?.toFixed(4)}%`);
console.log(`  p25:  ${failKChanges[Math.floor(failKChanges.length * 0.25)]?.toFixed(4)}%`);
console.log(`  p50:  ${failKChanges[Math.floor(failKChanges.length * 0.5)]?.toFixed(4)}%`);
console.log(`  p75:  ${failKChanges[Math.floor(failKChanges.length * 0.75)]?.toFixed(4)}%`);
console.log(`  max:  ${failKChanges[failKChanges.length - 1]?.toFixed(4)}%`);

// 3. Pool distribution of failing swaps
const failPoolCounts = new Map<string, number>();
for (const f of failing) {
  failPoolCounts.set(f.pool, (failPoolCounts.get(f.pool) ?? 0) + 1);
}
const failPoolArray = [...failPoolCounts.entries()].sort((a, b) => b[1] - a[1]);

console.log('\nPools with most failing swaps:');
for (const [pool, count] of failPoolArray.slice(0, 10)) {
  // Get pass count for this pool
  const passCount = passing.filter(p => p.pool === pool).length;
  const passRate = passCount / (passCount + count) * 100;
  console.log(`  ${pool.slice(0, 16)}...  fail=${count.toString().padStart(3)}  pass=${passCount.toString().padStart(3)}  passRate=${passRate.toFixed(0)}%`);
}

// 4. Error magnitude distribution
console.log('\nError magnitude distribution of failing swaps:');
failing.sort((a, b) => b.errorBps - a.errorBps);
console.log('Top 20 by error:');
for (const f of failing.slice(0, 20)) {
  const predDiff = f.predictedOut > f.actualOut ? f.predictedOut - f.actualOut : f.actualOut - f.predictedOut;
  console.log(`  err=${f.errorBps.toFixed(0).padStart(5)}bps  pred=${f.predictedOut}  actual=${f.actualOut}  diff=${predDiff}  ratio=${f.ratio.toFixed(0).padStart(6)}:1  pool=${f.pool.slice(0, 16)}...`);
}

// 5. Compare ratios between passing and failing
console.log('\n=== RATIO COMPARISON ===');
const passRatios = passing.map(p => p.ratio);
const failRatios = failing.map(f => f.ratio);

passRatios.sort((a, b) => a - b);
failRatios.sort((a, b) => a - b);

const percentile = (arr: number[], p: number) => arr[Math.floor(arr.length * p / 100)] || 0;

console.log('Passing swaps ratio percentiles:');
console.log(`  p25: ${percentile(passRatios, 25).toFixed(0)}:1`);
console.log(`  p50: ${percentile(passRatios, 50).toFixed(0)}:1`);
console.log(`  p75: ${percentile(passRatios, 75).toFixed(0)}:1`);
console.log(`  p95: ${percentile(passRatios, 95).toFixed(0)}:1`);
console.log(`  max: ${passRatios[passRatios.length - 1]?.toFixed(0)}:1`);

console.log('\nFailing swaps ratio percentiles:');
console.log(`  p25: ${percentile(failRatios, 25).toFixed(0)}:1`);
console.log(`  p50: ${percentile(failRatios, 50).toFixed(0)}:1`);
console.log(`  p75: ${percentile(failRatios, 75).toFixed(0)}:1`);
console.log(`  p95: ${percentile(failRatios, 95).toFixed(0)}:1`);
console.log(`  max: ${failRatios[failRatios.length - 1]?.toFixed(0)}:1`);

// 6. Check if lower threshold would help
console.log('\n=== THRESHOLD ANALYSIS ===');
const thresholds = [1000, 2000, 3000, 5000, 7000, 10000];
for (const thresh of thresholds) {
  const wouldSkip = results.filter(r => r.ratio > thresh);
  const wouldSkipFailing = failing.filter(f => f.ratio > thresh);
  const wouldSkipPassing = passing.filter(p => p.ratio > thresh);

  const newFailing = failing.length - wouldSkipFailing.length;
  const newPassing = passing.length - wouldSkipPassing.length;
  const newPassRate = newPassing / (newPassing + newFailing) * 100;

  console.log(`Threshold ${thresh.toString().padStart(5)}:1 -> skip ${wouldSkip.length.toString().padStart(4)} (${wouldSkipFailing.length} fail, ${wouldSkipPassing.length} pass) -> new passRate=${newPassRate.toFixed(2)}%`);
}

// 7. Deep dive on worst pool
if (failPoolArray.length > 0) {
  const worstPool = failPoolArray[0][0];
  console.log(`\n=== DEEP DIVE: WORST POOL ${worstPool.slice(0, 32)}... ===`);

  const poolSwaps = results.filter(r => r.pool === worstPool);
  poolSwaps.sort((a, b) => b.errorBps - a.errorBps);

  console.log(`Total swaps: ${poolSwaps.length}`);
  console.log(`Failing: ${poolSwaps.filter(s => !s.passed).length}`);
  console.log(`Passing: ${poolSwaps.filter(s => s.passed).length}`);

  console.log('\nSample failing swaps from this pool:');
  for (const s of poolSwaps.filter(x => !x.passed).slice(0, 5)) {
    console.log(`  err=${s.errorBps.toFixed(0).padStart(5)}bps  ratio=${s.ratio.toFixed(0).padStart(6)}:1  kChange=${s.kChange.toFixed(4)}%`);
    console.log(`    reserveIn=${s.reserveIn}  reserveOut=${s.reserveOut}`);
    console.log(`    amtIn=${s.amountIn}  actualOut=${s.actualOut}  predOut=${s.predictedOut}`);
  }

  console.log('\nSample passing swaps from this pool:');
  for (const s of poolSwaps.filter(x => x.passed).slice(0, 3)) {
    console.log(`  err=${s.errorBps.toFixed(0).padStart(5)}bps  ratio=${s.ratio.toFixed(0).padStart(6)}:1  kChange=${s.kChange.toFixed(4)}%`);
    console.log(`    reserveIn=${s.reserveIn}  reserveOut=${s.reserveOut}`);
  }
}

db.close();
