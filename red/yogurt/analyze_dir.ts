import Database from 'better-sqlite3';

const db = new Database('data/evidence/capture.db', { readonly: true });

interface TokenBalance {
  account_index: number;
  mint: string;
  ui_token_amount: { amount: string };
}

function parseTokenBalances(json: string): Map<number, bigint> {
  const arr = JSON.parse(json) as TokenBalance[];
  const m = new Map<number, bigint>();
  for (const row of arr) {
    const amt = BigInt(row.ui_token_amount.amount);
    m.set(row.account_index, amt);
  }
  return m;
}

function parseAccountKeys(json: string): string[] {
  return JSON.parse(json);
}

function getAccountIndex(keys: string[], hex: string): number | undefined {
  const idx = keys.indexOf(hex);
  return idx >= 0 ? idx : undefined;
}

function getBalance(balances: Map<number, bigint>, keys: string[], hex: string): bigint | undefined {
  const idx = getAccountIndex(keys, hex);
  if (idx == null) return undefined;
  return balances.get(idx);
}

function getTopology(sessionId: string, poolHex: string): any {
  return db.prepare(`
    SELECT vault_base, vault_quote
    FROM frozen_topologies
    WHERE session_id = ? AND pool_pubkey = ?
    LIMIT 1
  `).get(sessionId, poolHex);
}

const swaps = db.prepare(`
  SELECT 
    ps.signature,
    ps.session_id,
    ps.pool_pubkey,
    ps.direction as parsed_direction,
    ps.input_mint,
    ps.output_mint,
    ps.input_amount,
    ps.actual_output_amount,
    mt.pre_balances_json,
    mt.post_balances_json,
    mt.accounts_json
  FROM parsed_swaps ps
  JOIN mainnet_txs mt ON ps.signature = mt.signature AND ps.session_id = mt.session_id
  WHERE ps.venue = 'pumpswap' 
    AND ps.actual_output_amount IS NOT NULL 
    AND ps.actual_output_amount != ''
  ORDER BY ps.confirm_ts DESC
  LIMIT 150
`).all() as any[];

console.log(`Sample size: ${swaps.length}`);

let matchCount = 0;
let mismatchCount = 0;
const mismatches: any[] = [];

for (const swap of swaps) {
  const topo = getTopology(swap.session_id, swap.pool_pubkey);
  if (!topo) continue;

  try {
    const pre = parseTokenBalances(swap.pre_balances_json);
    const post = parseTokenBalances(swap.post_balances_json);
    const keys = parseAccountKeys(swap.accounts_json);

    const basePre = getBalance(pre, keys, topo.vault_base);
    const quotePre = getBalance(pre, keys, topo.vault_quote);
    const basePost = getBalance(post, keys, topo.vault_base);
    const quotePost = getBalance(post, keys, topo.vault_quote);

    if (basePre == null || quotePre == null || basePost == null || quotePost == null) {
      continue;
    }

    const baseDelta = basePost - basePre;
    const quoteDelta = quotePost - quotePre;

    let derivedDir: number;
    if (baseDelta > 0n && quoteDelta < 0n) {
      derivedDir = 0; // AtoB
    } else if (baseDelta < 0n && quoteDelta > 0n) {
      derivedDir = 1; // BtoA
    } else {
      continue;
    }

    const parsedDir = swap.parsed_direction;
    const isMatch = parsedDir === derivedDir;

    if (isMatch) {
      matchCount++;
    } else {
      mismatchCount++;
      if (mismatches.length < 15) {
        mismatches.push({
          sig: swap.signature.slice(0, 8),
          parsed: parsedDir,
          derived: derivedDir,
          inMint: swap.input_mint.slice(0, 8),
          outMint: swap.output_mint.slice(0, 8),
          baseDelta,
          quoteDelta,
          inputAmount: swap.input_amount,
          actualOutput: swap.actual_output_amount,
        });
      }
    }
  } catch (e) {
    // ignore
  }
}

const total = matchCount + mismatchCount;
const pct = total > 0 ? (100 * matchCount / total).toFixed(1) : '0';

console.log(`Matched: ${matchCount}/${total} (${pct}%)`);
console.log(`Mismatched: ${mismatchCount}`);
console.log();

for (const m of mismatches) {
  console.log(`sig=${m.sig} parsed=${m.parsed} derived=${m.derived}`);
  console.log(`  in=${m.inMint} out=${m.outMint}`);
  console.log(`  base=${m.baseDelta} quote=${m.quoteDelta}`);
  console.log(`  input=${m.inputAmount} actual=${m.actualOutput}`);
  console.log();
}

db.close();
