#!/usr/bin/env tsx
/**
 * Analyze the swaps that ARE being filtered as bonding curve
 * to verify the 10000:1 threshold is correct
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
  LIMIT 20000
`).all(sessionId) as any[];

console.log(`Loaded ${swaps.length} swaps`);

function getBalanceInfo(balancesJson: string, accountsJson: string, vaultHex: string): { amount: bigint; mint: string } | null {
  const balances = JSON.parse(balancesJson);
  const accounts = JSON.parse(accountsJson);
  const vaultIdx = accounts.indexOf(vaultHex);
  if (vaultIdx < 0) return null;
  const b = balances.find((x: any) => x.account_index === vaultIdx);
  return b ? { amount: BigInt(b.ui_token_amount.amount), mint: b.mint } : null;
}

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

type FilteredSwap = {
  pool: string;
  signature: string;
  ratio: number;
  reserveIn: bigint;
  reserveOut: bigint;
  amountIn: bigint;
  actualOut: bigint;
  kPre: bigint;
  kPost: bigint;
  kChange: number;
  err0: number;
  err25: number;
};

const filteredSwaps: FilteredSwap[] = [];
const passedSwaps: FilteredSwap[] = [];

for (const swap of swaps) {
  if (swapCountBySig.get(swap.signature)! > 1) continue;

  const baseInfo = getBalanceInfo(swap.pre_balances_json, swap.accounts_json, swap.vault_base);
  const quoteInfo = getBalanceInfo(swap.pre_balances_json, swap.accounts_json, swap.vault_quote);
  const basePostInfo = getBalanceInfo(swap.post_balances_json, swap.accounts_json, swap.vault_base);
  const quotePostInfo = getBalanceInfo(swap.post_balances_json, swap.accounts_json, swap.vault_quote);

  if (!baseInfo || !quoteInfo || !basePostInfo || !quotePostInfo) continue;

  let basePre = baseInfo.amount;
  let quotePre = quoteInfo.amount;
  let basePost = basePostInfo.amount;
  let quotePost = quotePostInfo.amount;

  if (baseInfo.mint === WSOL_MINT) {
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
    continue;
  }

  if (amountIn < MIN_AMOUNT_IN) continue;

  const ratio = reserveIn > reserveOut
    ? Number(reserveIn) / Number(reserveOut)
    : Number(reserveOut) / Number(reserveIn);

  const reserveRatio = reserveIn > reserveOut
    ? reserveIn / (reserveOut > 0n ? reserveOut : 1n)
    : reserveOut / (reserveIn > 0n ? reserveIn : 1n);

  const kPre = basePre * quotePre;
  const kPost = basePost * quotePost;
  const kChange = kPre > 0n ? (Number(kPost - kPre) / Number(kPre)) * 100 : 0;

  const pred0 = amountOutInputFee(reserveIn, reserveOut, amountIn, 0n);
  const pred25 = amountOutInputFee(reserveIn, reserveOut, amountIn, 25n);
  const err0 = errorBps(pred0, actualOut);
  const err25 = errorBps(pred25, actualOut);

  const swapData: FilteredSwap = {
    pool: swap.pool_pubkey,
    signature: swap.signature,
    ratio,
    reserveIn,
    reserveOut,
    amountIn,
    actualOut,
    kPre,
    kPost,
    kChange,
    err0,
    err25,
  };

  if (reserveRatio > MAX_RESERVE_RATIO) {
    filteredSwaps.push(swapData);
  } else {
    passedSwaps.push(swapData);
  }
}

console.log(`\nFiltered as bonding curve: ${filteredSwaps.length}`);
console.log(`Passed filter: ${passedSwaps.length}`);

// Analyze K-constant behavior
console.log('\n=== K-CONSTANT ANALYSIS ===');
console.log('(CPMM: K should increase slightly due to fees)');
console.log('(Bonding curve: K changes non-monotonically)');

const filteredKChanges = filteredSwaps.map(s => s.kChange).sort((a, b) => a - b);
const passedKChanges = passedSwaps.map(s => s.kChange).sort((a, b) => a - b);

const percentile = (arr: number[], p: number) => arr[Math.floor(arr.length * p / 100)] || 0;

console.log('\nFiltered swaps (ratio > 10000:1) K-change:');
if (filteredKChanges.length > 0) {
  console.log(`  count: ${filteredKChanges.length}`);
  console.log(`  min:   ${filteredKChanges[0]?.toFixed(4)}%`);
  console.log(`  p25:   ${percentile(filteredKChanges, 25).toFixed(4)}%`);
  console.log(`  p50:   ${percentile(filteredKChanges, 50).toFixed(4)}%`);
  console.log(`  p75:   ${percentile(filteredKChanges, 75).toFixed(4)}%`);
  console.log(`  max:   ${filteredKChanges[filteredKChanges.length - 1]?.toFixed(4)}%`);
}

console.log('\nPassed swaps (ratio <= 10000:1) K-change:');
console.log(`  count: ${passedKChanges.length}`);
console.log(`  min:   ${passedKChanges[0]?.toFixed(4)}%`);
console.log(`  p25:   ${percentile(passedKChanges, 25).toFixed(4)}%`);
console.log(`  p50:   ${percentile(passedKChanges, 50).toFixed(4)}%`);
console.log(`  p75:   ${percentile(passedKChanges, 75).toFixed(4)}%`);
console.log(`  max:   ${passedKChanges[passedKChanges.length - 1]?.toFixed(4)}%`);

// Analyze error rates
console.log('\n=== CPMM ERROR ANALYSIS ===');

// Filtered swaps with CPMM formula
const filteredErrors0 = filteredSwaps.map(s => s.err0);
const filteredErrors25 = filteredSwaps.map(s => s.err25);
const passedErrors0 = passedSwaps.map(s => s.err0);
const passedErrors25 = passedSwaps.map(s => s.err25);

console.log('\nFiltered swaps (ratio > 10000:1):');
console.log(`  CPMM with 0bps  - avg: ${(filteredErrors0.reduce((a, b) => a + b, 0) / filteredErrors0.length).toFixed(1)}bps, p95: ${percentile(filteredErrors0.sort((a, b) => a - b), 95).toFixed(0)}bps`);
console.log(`  CPMM with 25bps - avg: ${(filteredErrors25.reduce((a, b) => a + b, 0) / filteredErrors25.length).toFixed(1)}bps, p95: ${percentile(filteredErrors25.sort((a, b) => a - b), 95).toFixed(0)}bps`);

console.log('\nPassed swaps (ratio <= 10000:1):');
console.log(`  CPMM with 0bps  - avg: ${(passedErrors0.reduce((a, b) => a + b, 0) / passedErrors0.length).toFixed(1)}bps, p95: ${percentile(passedErrors0.sort((a, b) => a - b), 95).toFixed(0)}bps`);
console.log(`  CPMM with 25bps - avg: ${(passedErrors25.reduce((a, b) => a + b, 0) / passedErrors25.length).toFixed(1)}bps, p95: ${percentile(passedErrors25.sort((a, b) => a - b), 95).toFixed(0)}bps`);

// Sample filtered swaps
console.log('\n=== SAMPLE FILTERED SWAPS ===');
filteredSwaps.sort((a, b) => b.ratio - a.ratio);
for (const s of filteredSwaps.slice(0, 20)) {
  console.log(`  ratio=${s.ratio.toFixed(0).padStart(10)}:1  kChange=${s.kChange.toFixed(4).padStart(8)}%  err0=${s.err0.toFixed(0).padStart(5)}  err25=${s.err25.toFixed(0).padStart(5)}  pool=${s.pool.slice(0, 16)}...`);
}

// Check thresholds
console.log('\n=== THRESHOLD ANALYSIS ===');
const thresholds = [1000, 2000, 5000, 7000, 10000, 15000, 20000, 50000];
for (const thresh of thresholds) {
  const belowThresh = [...filteredSwaps, ...passedSwaps].filter(s => s.ratio <= thresh);
  const aboveThresh = [...filteredSwaps, ...passedSwaps].filter(s => s.ratio > thresh);

  const belowAvgErr25 = belowThresh.length > 0
    ? belowThresh.reduce((a, s) => a + s.err25, 0) / belowThresh.length
    : 0;
  const aboveAvgErr25 = aboveThresh.length > 0
    ? aboveThresh.reduce((a, s) => a + s.err25, 0) / aboveThresh.length
    : 0;

  console.log(`Threshold ${thresh.toString().padStart(6)}:1 -> below: ${belowThresh.length.toString().padStart(5)} (avgErr25=${belowAvgErr25.toFixed(1)}bps), above: ${aboveThresh.length.toString().padStart(4)} (avgErr25=${aboveAvgErr25.toFixed(1)}bps)`);
}

db.close();
