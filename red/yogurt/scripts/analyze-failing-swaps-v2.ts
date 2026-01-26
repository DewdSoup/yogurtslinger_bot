#!/usr/bin/env tsx
/**
 * Analyze failing swaps - match the exact logic from validate-simulation.ts
 */
import Database from 'better-sqlite3';

const db = new Database('data/evidence/capture.db', { readonly: true });

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

const sessionRow = db.prepare(`
  SELECT session_id as sessionId
  FROM parsed_swaps
  GROUP BY session_id
  ORDER BY MAX(confirm_ts) DESC
  LIMIT 1
`).get() as { sessionId: string };

const sessionId = sessionRow.sessionId;
console.log('Session:', sessionId);

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

function getBalanceInfo(balancesJson: string, accountsJson: string, vaultHex: string): { amount: bigint; mint: string; index: number } | null {
  const balances = JSON.parse(balancesJson);
  const accounts = JSON.parse(accountsJson);
  const vaultIdx = accounts.indexOf(vaultHex);
  if (vaultIdx < 0) return null;
  const b = balances.find((x: any) => x.account_index === vaultIdx);
  return b ? { amount: BigInt(b.ui_token_amount.amount), mint: b.mint, index: vaultIdx } : null;
}

// Use the EXACT same formula as validate-simulation.ts
function amountOutInputFee(reserveIn: bigint, reserveOut: bigint, amountIn: bigint, feeBps: bigint): bigint {
  if (reserveIn <= 0n || reserveOut <= 0n || amountIn <= 0n) return 0n;
  const amountInWithFee = amountIn * (10000n - feeBps);
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 10000n + amountInWithFee;
  return numerator / denominator;
}

function errorBps(pred: bigint, actual: bigint): number {
  if (actual <= 0n) return Infinity;
  const absErr = pred > actual ? pred - actual : actual - pred;
  return Number((absErr * 10000n) / actual);
}

const swapCountBySig = new Map<string, number>();
for (const s of swaps) {
  swapCountBySig.set(s.signature, (swapCountBySig.get(s.signature) ?? 0) + 1);
}

const MIN_AMOUNT_IN = 10000n;
const MAX_RESERVE_RATIO = 10000n;
const TOLERANCE_BPS = 10;
const FEE_BPS = 25n;  // Fixed fee like validate-simulation default

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
  passed: boolean;
};

const results: SwapResult[] = [];
let skipped = { multiSwap: 0, dust: 0, weirdFlow: 0, bondingCurve: 0, missingBalance: 0 };

for (const swap of swaps) {
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

  // Normalize vault assignment - quote should be WSOL
  let baseVaultHex = swap.vault_base;
  let quoteVaultHex = swap.vault_quote;
  let basePre = baseInfo.amount;
  let quotePre = quoteInfo.amount;
  let basePost = basePostInfo.amount;
  let quotePost = quotePostInfo.amount;

  if (baseInfo.mint === WSOL_MINT) {
    // Swap them
    [baseVaultHex, quoteVaultHex] = [quoteVaultHex, baseVaultHex];
    [basePre, quotePre] = [quotePre, basePre];
    [basePost, quotePost] = [quotePost, basePost];
  }

  const baseDelta = basePost - basePre;
  const quoteDelta = quotePost - quotePre;

  let reserveIn: bigint;
  let reserveOut: bigint;
  let amountIn: bigint;
  let actualOut: bigint;

  if (baseDelta > 0n && quoteDelta < 0n) {
    reserveIn = basePre;
    reserveOut = quotePre;
    amountIn = baseDelta;
    actualOut = -quoteDelta;
  } else if (baseDelta < 0n && quoteDelta > 0n) {
    reserveIn = quotePre;
    reserveOut = basePre;
    amountIn = quoteDelta;
    actualOut = -baseDelta;
  } else {
    skipped.weirdFlow++;
    continue;
  }

  if (amountIn < MIN_AMOUNT_IN) {
    skipped.dust++;
    continue;
  }

  const reserveRatio = reserveIn > reserveOut
    ? reserveIn / (reserveOut > 0n ? reserveOut : 1n)
    : reserveOut / (reserveIn > 0n ? reserveIn : 1n);

  if (reserveRatio > MAX_RESERVE_RATIO) {
    skipped.bondingCurve++;
    continue;
  }

  const ratio = reserveIn > reserveOut
    ? Number(reserveIn) / Number(reserveOut)
    : Number(reserveOut) / Number(reserveIn);

  // Use FIXED fee (25 bps) - this is what validate-simulation uses by default for model comparison
  const pred = amountOutInputFee(reserveIn, reserveOut, amountIn, FEE_BPS);
  const err = errorBps(pred, actualOut);

  results.push({
    pool: swap.pool_pubkey,
    signature: swap.signature,
    ratio,
    reserveIn,
    reserveOut,
    amountIn,
    actualOut,
    predictedOut: pred,
    errorBps: err,
    passed: err <= TOLERANCE_BPS,
  });
}

console.log(`\nProcessed ${results.length} swaps`);
console.log('Skipped:', skipped);

const passing = results.filter(r => r.passed);
const failing = results.filter(r => !r.passed);

console.log(`\nPassing: ${passing.length} (${(passing.length / results.length * 100).toFixed(2)}%)`);
console.log(`Failing: ${failing.length} (${(failing.length / results.length * 100).toFixed(2)}%)`);

if (failing.length > 0) {
  console.log('\n=== FAILING SWAPS ANALYSIS ===');

  // Sort by error
  failing.sort((a, b) => b.errorBps - a.errorBps);

  console.log('\nTop 30 failing swaps by error magnitude:');
  for (const f of failing.slice(0, 30)) {
    const diff = f.predictedOut > f.actualOut ? f.predictedOut - f.actualOut : f.actualOut - f.predictedOut;
    console.log(`  err=${f.errorBps.toFixed(0).padStart(5)}bps  ratio=${f.ratio.toFixed(0).padStart(6)}:1  amtIn=${f.amountIn.toString().padStart(15)}  pred=${f.predictedOut.toString().padStart(15)}  actual=${f.actualOut.toString().padStart(15)}  diff=${diff}  pool=${f.pool.slice(0, 16)}...`);
  }

  // Pool distribution
  const failPoolCounts = new Map<string, number>();
  for (const f of failing) {
    failPoolCounts.set(f.pool, (failPoolCounts.get(f.pool) ?? 0) + 1);
  }
  const failPoolArray = [...failPoolCounts.entries()].sort((a, b) => b[1] - a[1]);

  console.log('\nPools with most failing swaps:');
  for (const [pool, count] of failPoolArray.slice(0, 10)) {
    const passCount = passing.filter(p => p.pool === pool).length;
    const passRate = passCount / (passCount + count) * 100;
    console.log(`  ${pool.slice(0, 24)}...  fail=${count.toString().padStart(4)}  pass=${passCount.toString().padStart(4)}  passRate=${passRate.toFixed(1)}%`);
  }

  // Ratio distribution comparison
  console.log('\n=== RATIO COMPARISON ===');
  const passRatios = passing.map(p => p.ratio).sort((a, b) => a - b);
  const failRatios = failing.map(f => f.ratio).sort((a, b) => a - b);

  const percentile = (arr: number[], p: number) => arr[Math.floor(arr.length * p / 100)] || 0;

  console.log('Passing swaps:');
  console.log(`  count: ${passRatios.length}`);
  console.log(`  p50: ${percentile(passRatios, 50).toFixed(0)}:1`);
  console.log(`  p95: ${percentile(passRatios, 95).toFixed(0)}:1`);
  console.log(`  max: ${passRatios[passRatios.length - 1]?.toFixed(0)}:1`);

  console.log('Failing swaps:');
  console.log(`  count: ${failRatios.length}`);
  console.log(`  p50: ${percentile(failRatios, 50).toFixed(0)}:1`);
  console.log(`  p95: ${percentile(failRatios, 95).toFixed(0)}:1`);
  console.log(`  max: ${failRatios[failRatios.length - 1]?.toFixed(0)}:1`);

  // Check error pattern - is it always ~23 bps over prediction?
  console.log('\n=== ERROR PATTERN ANALYSIS ===');
  const overPredict = failing.filter(f => f.predictedOut > f.actualOut);
  const underPredict = failing.filter(f => f.predictedOut < f.actualOut);
  console.log(`Over-predict:  ${overPredict.length} (prediction too high)`);
  console.log(`Under-predict: ${underPredict.length} (prediction too low)`);

  // Error histogram
  const errBuckets = [11, 15, 20, 25, 30, 50, 100, Infinity];
  console.log('\nError distribution:');
  for (let i = 0; i < errBuckets.length; i++) {
    const prevMax = i > 0 ? errBuckets[i - 1] : 0;
    const count = failing.filter(f => f.errorBps > prevMax && f.errorBps <= errBuckets[i]).length;
    const label = errBuckets[i] === Infinity ? `>${errBuckets[i-1]}` : `${prevMax+1}-${errBuckets[i]}`;
    console.log(`  ${label.padEnd(8)} bps: ${count}`);
  }

  // Analyze if the error is consistent with a different fee
  console.log('\n=== FEE LEVEL ANALYSIS ===');
  // For failing swaps, what fee would make them pass?
  for (const f of failing.slice(0, 10)) {
    const testFees = [0n, 10n, 15n, 20n, 25n, 30n, 35n, 40n, 50n];
    let bestFee = 0n;
    let bestErr = Infinity;
    for (const fee of testFees) {
      const pred = amountOutInputFee(f.reserveIn, f.reserveOut, f.amountIn, fee);
      const err = errorBps(pred, f.actualOut);
      if (err < bestErr) {
        bestErr = err;
        bestFee = fee;
      }
    }
    console.log(`  sig=${f.signature.slice(0, 16)}... bestFee=${bestFee}bps bestErr=${bestErr.toFixed(0)}bps (with 25bps: ${f.errorBps.toFixed(0)}bps)`);
  }

} else {
  console.log('\nAll swaps passed with the current filters!');
}

// Check what swaps were filtered as bonding curve
console.log('\n=== BONDING CURVE FILTER ANALYSIS ===');
console.log(`Swaps filtered as bonding curve: ${skipped.bondingCurve}`);

db.close();
