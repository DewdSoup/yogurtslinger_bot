#!/usr/bin/env tsx
/**
 * Analyze reserve ratios to validate bonding curve detection
 */
import Database from 'better-sqlite3';

const db = new Database('data/evidence/capture.db', { readonly: true });

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

// Analyze a sample of swaps with their reserve data
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
  LIMIT 5000
`).all(sessionId) as any[];

console.log(`Loaded ${swaps.length} swaps`);

// WSOL mint
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Parse balance JSON to extract amounts
function getBalanceInfo(balancesJson: string, accountsJson: string, vaultHex: string): { amount: bigint; mint: string } | null {
  const balances = JSON.parse(balancesJson);
  const accounts = JSON.parse(accountsJson);
  const vaultIdx = accounts.indexOf(vaultHex);
  if (vaultIdx < 0) return null;
  const b = balances.find((x: any) => x.account_index === vaultIdx);
  return b ? { amount: BigInt(b.ui_token_amount.amount), mint: b.mint } : null;
}

type SwapAnalysis = {
  pool: string;
  signature: string;
  ratio: number;
  baseAmount: bigint;
  quoteAmount: bigint;  // SOL side
  baseMint: string;
  quoteMint: string;
  kPre: bigint;
  kPost: bigint;
  kChange: number;  // percentage
};

const analyses: SwapAnalysis[] = [];

for (const swap of swaps) {
  const baseInfo = getBalanceInfo(swap.pre_balances_json, swap.accounts_json, swap.vault_base);
  const quoteInfo = getBalanceInfo(swap.pre_balances_json, swap.accounts_json, swap.vault_quote);
  const basePostInfo = getBalanceInfo(swap.post_balances_json, swap.accounts_json, swap.vault_base);
  const quotePostInfo = getBalanceInfo(swap.post_balances_json, swap.accounts_json, swap.vault_quote);

  if (!baseInfo || !quoteInfo || !basePostInfo || !quotePostInfo) continue;
  if (baseInfo.amount <= 0n || quoteInfo.amount <= 0n) continue;

  // Normalize: quote should be SOL
  let baseAmount = baseInfo.amount;
  let quoteAmount = quoteInfo.amount;
  let baseMint = baseInfo.mint;
  let quoteMint = quoteInfo.mint;
  let basePostAmount = basePostInfo.amount;
  let quotePostAmount = quotePostInfo.amount;

  // If base is WSOL, swap them
  if (baseMint === WSOL_MINT) {
    [baseAmount, quoteAmount] = [quoteAmount, baseAmount];
    [baseMint, quoteMint] = [quoteMint, baseMint];
    [basePostAmount, quotePostAmount] = [quotePostAmount, basePostAmount];
  }

  const ratio = Number(baseAmount) / Number(quoteAmount);
  const kPre = baseAmount * quoteAmount;
  const kPost = basePostAmount * quotePostAmount;
  const kChange = kPre > 0n ? (Number(kPost - kPre) / Number(kPre)) * 100 : 0;

  analyses.push({
    pool: swap.pool_pubkey,
    signature: swap.signature,
    ratio,
    baseAmount,
    quoteAmount,
    baseMint,
    quoteMint,
    kPre,
    kPost,
    kChange,
  });
}

console.log(`\nAnalyzed ${analyses.length} swaps with valid balances`);

// Sort by ratio to find extremes
analyses.sort((a, b) => b.ratio - a.ratio);

console.log('\n=== Top 20 Highest Reserve Ratios (Token/SOL) ===');
console.log('(Bonding curve filter threshold: 10000:1)');
for (const a of analyses.slice(0, 20)) {
  const ratioStr = a.ratio.toFixed(0).padStart(12);
  console.log(`  ratio=${ratioStr}:1  K_change=${a.kChange.toFixed(4).padStart(8)}%  base=${a.baseAmount.toString().padStart(18)}  quote=${a.quoteAmount.toString().padStart(14)}  pool=${a.pool.slice(0, 16)}...`);
}

// Histogram of ratios
console.log('\n=== Ratio Distribution Histogram ===');
const buckets = [
  { max: 10, label: '<=10:1' },
  { max: 100, label: '<=100:1' },
  { max: 1000, label: '<=1k:1' },
  { max: 5000, label: '<=5k:1' },
  { max: 10000, label: '<=10k:1' },
  { max: 50000, label: '<=50k:1' },
  { max: 100000, label: '<=100k:1' },
  { max: 500000, label: '<=500k:1' },
  { max: Infinity, label: '>500k:1' },
];

for (const bucket of buckets) {
  const count = analyses.filter(a => a.ratio <= bucket.max &&
    (bucket.max === 10 || a.ratio > (buckets[buckets.indexOf(bucket) - 1]?.max || 0))).length;
  console.log(`  ${bucket.label.padEnd(12)}: ${count.toString().padStart(5)} (${(count / analyses.length * 100).toFixed(1)}%)`);
}

// K-constant analysis
console.log('\n=== K-Constant Change Analysis ===');
console.log('(CPMM should have K slightly increase due to fees)');

// Group by K change magnitude
const kChanges = analyses.map(a => a.kChange);
kChanges.sort((a, b) => a - b);

const percentile = (arr: number[], p: number) => arr[Math.floor(arr.length * p / 100)];
console.log(`  p1:   ${percentile(kChanges, 1)?.toFixed(4)}%`);
console.log(`  p5:   ${percentile(kChanges, 5)?.toFixed(4)}%`);
console.log(`  p50:  ${percentile(kChanges, 50)?.toFixed(4)}%`);
console.log(`  p95:  ${percentile(kChanges, 95)?.toFixed(4)}%`);
console.log(`  p99:  ${percentile(kChanges, 99)?.toFixed(4)}%`);

// Find swaps where K decreased significantly (shouldn't happen in CPMM)
const kDecrease = analyses.filter(a => a.kChange < -0.1);
console.log(`\n  Swaps with K decrease >0.1%: ${kDecrease.length}`);

// Find swaps where K increased significantly (shouldn't happen in pure CPMM either)
const kIncrease = analyses.filter(a => a.kChange > 1.0);
console.log(`  Swaps with K increase >1%:   ${kIncrease.length}`);

// Analyze swaps with extreme K changes (likely non-CPMM behavior)
const extremeK = analyses.filter(a => Math.abs(a.kChange) > 0.5);
console.log(`\n  Swaps with |K change| > 0.5%: ${extremeK.length}`);

if (extremeK.length > 0) {
  console.log('\n=== Extreme K-Change Swaps (sample) ===');
  for (const a of extremeK.slice(0, 10)) {
    console.log(`  K_change=${a.kChange.toFixed(4).padStart(8)}%  ratio=${a.ratio.toFixed(0).padStart(10)}:1  pool=${a.pool.slice(0, 16)}...`);
  }
}

// Analyze by pool - find pools with consistently strange behavior
console.log('\n=== Pool-Level Analysis ===');
const poolStats = new Map<string, { count: number; avgRatio: number; avgKChange: number; ratios: number[] }>();

for (const a of analyses) {
  const stat = poolStats.get(a.pool) || { count: 0, avgRatio: 0, avgKChange: 0, ratios: [] };
  stat.count++;
  stat.avgRatio += a.ratio;
  stat.avgKChange += a.kChange;
  stat.ratios.push(a.ratio);
  poolStats.set(a.pool, stat);
}

// Finalize averages
for (const stat of poolStats.values()) {
  stat.avgRatio /= stat.count;
  stat.avgKChange /= stat.count;
}

// Find pools with high average ratios
const poolArray = [...poolStats.entries()].map(([pool, stat]) => ({ pool, ...stat }));
poolArray.sort((a, b) => b.avgRatio - a.avgRatio);

console.log('\nPools with highest average reserve ratios:');
for (const p of poolArray.slice(0, 10)) {
  console.log(`  pool=${p.pool.slice(0, 16)}...  swaps=${p.count.toString().padStart(4)}  avgRatio=${p.avgRatio.toFixed(0).padStart(12)}:1  avgKChange=${p.avgKChange.toFixed(4)}%`);
}

// Recommendation
console.log('\n=== RECOMMENDATION ===');
const above10k = analyses.filter(a => a.ratio > 10000).length;
const above5k = analyses.filter(a => a.ratio > 5000).length;
const above1k = analyses.filter(a => a.ratio > 1000).length;

console.log(`Swaps with ratio > 10000:1 (current filter):  ${above10k} (${(above10k/analyses.length*100).toFixed(1)}%)`);
console.log(`Swaps with ratio > 5000:1:                    ${above5k} (${(above5k/analyses.length*100).toFixed(1)}%)`);
console.log(`Swaps with ratio > 1000:1:                    ${above1k} (${(above1k/analyses.length*100).toFixed(1)}%)`);

// Check K-constant for high-ratio swaps vs low-ratio swaps
const highRatioKChanges = analyses.filter(a => a.ratio > 10000).map(a => a.kChange);
const normalRatioKChanges = analyses.filter(a => a.ratio <= 1000).map(a => a.kChange);

if (highRatioKChanges.length > 0 && normalRatioKChanges.length > 0) {
  console.log('\nK-change comparison:');
  console.log(`  High ratio (>10k:1) avg K-change:   ${(highRatioKChanges.reduce((a, b) => a + b, 0) / highRatioKChanges.length).toFixed(4)}%`);
  console.log(`  Normal ratio (<=1k:1) avg K-change: ${(normalRatioKChanges.reduce((a, b) => a + b, 0) / normalRatioKChanges.length).toFixed(4)}%`);
}

db.close();
