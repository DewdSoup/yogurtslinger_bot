#!/usr/bin/env tsx

/**
 * Sprint 1 / S1-T1 + S1-T3 (initial)
 * Simulation Accuracy Validation
 *
 * Design goals:
 * - Evidence-driven (reads capture.db)
 * - Low-risk (no runtime coupling; no writes)
 * - High-signal (quickly tells you whether sim math + fee semantics match chain)
 *
 * Current scope:
 * - PumpSwap constant-product swaps using tx pre/post token balances as ground truth.
 *
 * Why token balances?
 * - capture-evidence.ts stores Solana Tx meta pre_token_balances/post_token_balances
 *   into mainnet_txs.pre_balances_json / post_balances_json.
 * - That gives the exact vault reserves at execution, avoiding snapshot reconstruction
 *   and eliminating ambiguity about “what the state was”.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { SwapDirection } from '../src/types.js';

/**
 * =====================================================================
 * FEE TIER TESTING (PS-002 Investigation)
 * =====================================================================
 *
 * This section tests whether dynamic fee tiers based on market cap
 * explain the 7.63% failure rate we see with fixed 25 bps fees.
 *
 * PumpSwap fee structure (per public docs):
 * - LP fee: 20 bps (fixed)
 * - Protocol fee: 5 bps (fixed)
 * - Creator fee: 0-95 bps (variable based on market cap)
 *   - Higher market cap = lower creator fee
 *
 * Market cap formula: marketCap = (quoteReserve * baseMintSupply) / baseReserve
 *
 * If this test shows improvement, we need to implement proper fee tier
 * resolution in Layer 1 (data pipeline + math engines).
 * =====================================================================
 */

// WSOL mint pubkey hex
const WSOL_MINT_HEX = '069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001';

// Cache for mint supplies (keyed by mint hex)
const mintSupplyCache = new Map<string, bigint | null>();

// RPC endpoint (defaults to localhost)
const RPC_ENDPOINT = process.env.RPC_ENDPOINT ?? 'http://127.0.0.1:8899';

// Fee Program ID
const FEE_PROGRAM_ID = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';

// PumpSwap Program ID (for PDA derivation)
const PUMPSWAP_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

/**
 * Fee tier from FeeConfig account
 */
interface FeeTier {
    marketCapLamportsThreshold: bigint;
    lpFeeBps: bigint;
    protocolFeeBps: bigint;
    creatorFeeBps: bigint;
}

// Cache for FeeConfig
let feeConfigCache: {
    tiers: FeeTier[];
    flatFees: { lpFeeBps: bigint; protocolFeeBps: bigint; creatorFeeBps: bigint };
} | null = null;

/**
 * Derive FeeConfig PDA for PumpSwap
 * Seeds: ['fee_config', venueSwapswap_program_id]
 */
async function deriveFeeConfigPDA(): Promise<string> {
    // Simple PDA derivation for our purposes
    // In practice, we'd use @solana/web3.js, but let's just use the known address
    // The FeeConfig PDA can be computed or fetched from a known address

    // For now, let's fetch the account directly since it's a singleton
    // We need to compute the PDA with seeds ['fee_config', program_id]
    // This is complex without proper libs, so let's try fetching account info instead

    // Actually, let's use a simpler approach: fetch by getProgramAccounts
    // or use a known address if we can find it
    return ''; // Placeholder - will implement properly
}

/**
 * Fetch and parse FeeConfig account from Fee Program
 */
async function fetchFeeConfig(): Promise<typeof feeConfigCache> {
    if (feeConfigCache) return feeConfigCache;

    try {
        // Get program accounts for Fee Program to find FeeConfig
        const response = await fetch(RPC_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getProgramAccounts',
                params: [
                    FEE_PROGRAM_ID,
                    {
                        encoding: 'base64',
                        filters: [
                            { dataSize: 320 } // Approximate size of FeeConfig
                        ]
                    }
                ],
            }),
        });

        const json = await response.json() as any;

        if (json.result && json.result.length > 0) {
            // Parse the first FeeConfig account found
            const accountData = Buffer.from(json.result[0].account.data[0], 'base64');
            const parsed = parseFeeConfig(accountData);
            if (parsed) {
                feeConfigCache = parsed;
                return parsed;
            }
        }
    } catch (e) {
        console.warn('Failed to fetch FeeConfig:', e);
    }

    // Return default fees if fetch fails
    feeConfigCache = {
        tiers: [],
        flatFees: { lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 0n }
    };
    return feeConfigCache;
}

/**
 * Parse FeeConfig account data
 * Structure (approximate):
 * - 8 bytes: discriminator
 * - 32 bytes: admin pubkey
 * - 4 bytes: fee_tiers length
 * - N * (16 + 24) bytes: fee tiers (u128 threshold + 3x u64 fees)
 * - 24 bytes: flat fees (3x u64)
 */
function parseFeeConfig(data: Buffer): typeof feeConfigCache | null {
    try {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

        // Skip discriminator (8 bytes) and admin (32 bytes)
        let offset = 40;

        // Read fee_tiers length (4 bytes, u32)
        const tiersLen = view.getUint32(offset, true);
        offset += 4;

        const tiers: FeeTier[] = [];

        // Each tier: u128 threshold + 3x u64 fees = 16 + 24 = 40 bytes
        for (let i = 0; i < tiersLen && offset + 40 <= data.length; i++) {
            // Read u128 threshold as two u64s
            const thresholdLow = view.getBigUint64(offset, true);
            const thresholdHigh = view.getBigUint64(offset + 8, true);
            const threshold = thresholdLow + (thresholdHigh << 64n);
            offset += 16;

            const lpFeeBps = view.getBigUint64(offset, true);
            offset += 8;
            const protocolFeeBps = view.getBigUint64(offset, true);
            offset += 8;
            const creatorFeeBps = view.getBigUint64(offset, true);
            offset += 8;

            tiers.push({
                marketCapLamportsThreshold: threshold,
                lpFeeBps,
                protocolFeeBps,
                creatorFeeBps
            });
        }

        // Read flat fees
        const flatLpFeeBps = view.getBigUint64(offset, true);
        offset += 8;
        const flatProtocolFeeBps = view.getBigUint64(offset, true);
        offset += 8;
        const flatCreatorFeeBps = view.getBigUint64(offset, true);

        return {
            tiers,
            flatFees: {
                lpFeeBps: flatLpFeeBps,
                protocolFeeBps: flatProtocolFeeBps,
                creatorFeeBps: flatCreatorFeeBps
            }
        };
    } catch (e) {
        return null;
    }
}

/**
 * Get fee BPS for a given market cap using tiered fees
 */
function getTieredFeeBps(marketCapLamports: bigint, config: typeof feeConfigCache): bigint {
    if (!config || config.tiers.length === 0) {
        // Fall back to flat fees
        const flat = config?.flatFees ?? { lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 0n };
        return flat.lpFeeBps + flat.protocolFeeBps + flat.creatorFeeBps;
    }

    // Find matching tier (tiers are sorted by threshold ascending)
    for (const tier of config.tiers) {
        if (marketCapLamports <= tier.marketCapLamportsThreshold) {
            return tier.lpFeeBps + tier.protocolFeeBps + tier.creatorFeeBps;
        }
    }

    // No tier matched, use flat fees
    const flat = config.flatFees;
    return flat.lpFeeBps + flat.protocolFeeBps + flat.creatorFeeBps;
}

/**
 * Fetch mint supply via RPC (cached per mint)
 * Returns null if fetch fails or mint not found
 */
async function getMintSupply(mintHex: string): Promise<bigint | null> {
    // Check cache first
    if (mintSupplyCache.has(mintHex)) {
        return mintSupplyCache.get(mintHex)!;
    }

    // Convert hex to base58
    const mintBytes = Buffer.from(mintHex, 'hex');
    const mintBase58 = encodeBase58(mintBytes);

    try {
        const response = await fetch(RPC_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getTokenSupply',
                params: [mintBase58],
            }),
        });

        const json = await response.json() as any;
        if (json.result?.value?.amount) {
            const supply = BigInt(json.result.value.amount);
            mintSupplyCache.set(mintHex, supply);
            return supply;
        }
    } catch (e) {
        // Silently fail - cache null to avoid repeated failures
    }

    mintSupplyCache.set(mintHex, null);
    return null;
}

/**
 * Simple base58 encoder for Solana pubkeys
 */
function encodeBase58(bytes: Buffer): string {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let num = BigInt('0x' + bytes.toString('hex'));
    let result = '';
    while (num > 0n) {
        const mod = Number(num % 58n);
        result = ALPHABET[mod] + result;
        num = num / 58n;
    }
    // Add leading zeros
    for (const byte of bytes) {
        if (byte === 0) result = '1' + result;
        else break;
    }
    return result || '1';
}

/**
 * Simple base58 decoder for Solana pubkeys
 */
function decodeBase58(str: string): Uint8Array {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const ALPHABET_MAP = new Map<string, number>();
    for (let i = 0; i < ALPHABET.length; i++) {
        ALPHABET_MAP.set(ALPHABET[i]!, i);
    }

    let num = 0n;
    for (const char of str) {
        const val = ALPHABET_MAP.get(char);
        if (val === undefined) throw new Error(`Invalid base58 character: ${char}`);
        num = num * 58n + BigInt(val);
    }

    // Convert to bytes
    let hex = num.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }

    // Count leading '1's (zeros in base58)
    let leadingZeros = 0;
    for (const char of str) {
        if (char === '1') leadingZeros++;
        else break;
    }

    // Prepend leading zeros
    if (leadingZeros > 0) {
        const result = new Uint8Array(leadingZeros + bytes.length);
        result.set(bytes, leadingZeros);
        return result;
    }
    return bytes;
}

// WSOL mint in base58 format (for comparison)
const WSOL_MINT_BASE58 = 'So11111111111111111111111111111111111111112';

/**
 * PumpSwap fee tiers based on market cap (in lamports)
 *
 * These are approximate thresholds based on public documentation.
 * The actual thresholds are stored on-chain in the FeeConfig account.
 *
 * Fee structure:
 * - LP fee: 20 bps (fixed)
 * - Protocol fee: 5 bps (fixed)
 * - Creator fee: varies by market cap tier
 *
 * Source: pump.fun Dynamic Fee V1 documentation
 * Higher market cap = lower creator fee (incentivizes growth)
 */
interface FeeTier {
    maxMarketCapLamports: bigint;  // Market cap threshold (inclusive)
    creatorFeeBps: bigint;         // Creator fee for this tier
}

// Fee tiers (sorted by market cap ascending)
// Based on Dynamic Fee V1 - creator fees range from 95 bps to 5 bps
// These thresholds are estimates - actual values from FeeConfig on-chain
const FEE_TIERS: FeeTier[] = [
    // Very small market cap - highest creator fee
    { maxMarketCapLamports: 500_000_000n,        creatorFeeBps: 95n },  // < 0.5 SOL
    { maxMarketCapLamports: 1_000_000_000n,      creatorFeeBps: 90n },  // < 1 SOL
    { maxMarketCapLamports: 2_000_000_000n,      creatorFeeBps: 85n },  // < 2 SOL
    { maxMarketCapLamports: 5_000_000_000n,      creatorFeeBps: 80n },  // < 5 SOL
    { maxMarketCapLamports: 10_000_000_000n,     creatorFeeBps: 70n },  // < 10 SOL
    { maxMarketCapLamports: 20_000_000_000n,     creatorFeeBps: 60n },  // < 20 SOL
    { maxMarketCapLamports: 50_000_000_000n,     creatorFeeBps: 50n },  // < 50 SOL
    { maxMarketCapLamports: 100_000_000_000n,    creatorFeeBps: 40n },  // < 100 SOL
    { maxMarketCapLamports: 200_000_000_000n,    creatorFeeBps: 30n },  // < 200 SOL
    { maxMarketCapLamports: 420_000_000_000n,    creatorFeeBps: 20n },  // < 420 SOL (meme number)
    { maxMarketCapLamports: 1_000_000_000_000n,  creatorFeeBps: 10n },  // < 1000 SOL
    { maxMarketCapLamports: BigInt('0x' + 'f'.repeat(32)), creatorFeeBps: 5n },  // >= 1000 SOL (max)
];

// Fixed fees (LP + Protocol)
const LP_FEE_BPS = 20n;
const PROTOCOL_FEE_BPS = 5n;

/**
 * Get total fee in bps based on market cap
 */
function getFeeBpsForMarketCap(marketCapLamports: bigint): bigint {
    for (const tier of FEE_TIERS) {
        if (marketCapLamports <= tier.maxMarketCapLamports) {
            return LP_FEE_BPS + PROTOCOL_FEE_BPS + tier.creatorFeeBps;
        }
    }
    // Fallback to minimum creator fee
    return LP_FEE_BPS + PROTOCOL_FEE_BPS + 5n;
}

/**
 * Calculate market cap in lamports
 * Formula: marketCap = (quoteReserve * baseMintSupply) / baseReserve
 */
function calculateMarketCap(quoteReserve: bigint, baseReserve: bigint, baseMintSupply: bigint): bigint {
    if (baseReserve <= 0n) return 0n;
    return (quoteReserve * baseMintSupply) / baseReserve;
}

type VenueText = 'venueSwapswap' | 'raydiumV4' | 'raydiumClmm' | 'meteoraDlmm';

type TokenBalanceRow = {
    account_index: number;
    mint: string;
    ui_token_amount: { amount: string };
};

type SwapRow = {
    signature: string;
    slot: number;
    venue: VenueText;
    pool_pubkey: string; // hex
    direction: number;
    input_amount: string;
    actual_output_amount: string;
    instruction_index: number;
    // tx meta
    accounts_json: string;
    pre_balances_json: string;
    post_balances_json: string;
};

type TopologyRow = {
    venue: number;
    vault_base: string; // hex
    vault_quote: string; // hex
};

type CliOpts = {
    db: string;
    swapDb?: string;
    cacheDb?: string;
    session?: string;
    venue: VenueText | 'all';
    limit: number;
    noLimit: boolean;       // Evaluate all swaps (no SQL LIMIT)
    feeBps: number;
    toleranceBps: number;
    out?: string;
    help: boolean;
    dynamicFees: boolean;   // Enable dynamic fee tier testing (PS-002)
    allSwaps: boolean;      // Skip only invalid data, not conservative filters
    stratified?: number;    // N swaps per pool for stratified sampling
    multiSwap: boolean;     // Enable multi-swap sequential evaluation
    tieredFees: boolean;    // Use FeeConfig tiered fees (PS-005)
};

const DEFAULT_DB_PATH = 'data/evidence/capture.db';

function usage(): string {
    return `
prove-infrastructure

Proves Layer 1 infrastructure accuracy by comparing math output to on-chain results.
NO WORKAROUNDS - fees must be resolved in Layer 1, not learned at runtime.

Usage:
  npx tsx scripts/prove-infrastructure.ts --db data/evidence/capture.db --venue venueSwapswap
  npx tsx scripts/prove-infrastructure.ts --no-limit  # Evaluate all swaps

Options:
  --db <path>           Combined evidence DB path (default: ${DEFAULT_DB_PATH})
  --swap-db <path>      Swap/tx DB path (if split)
  --cache-db <path>     Cache/topology DB path (if split)
  --session <id>        Capture session id (default: latest in parsed_swaps)
  --venue <name>        venueSwapswap | raydiumV4 | raydiumClmm | meteoraDlmm | all (default: venueSwapswap)
  --limit <n>           Max swaps to evaluate (default: 100000, use --no-limit for all)
  --no-limit            Evaluate all swaps (no limit)
  --fee-bps <n>         PumpSwap total fee in bps (default: 25 from GlobalConfig)
  --tolerance-bps <n>   Pass threshold in bps error vs actual (default: 10)  # 10 bps = 0.1%
  --out <path>          Write JSON report to this path
  --dynamic-fees        Enable dynamic fee tier testing (PS-002 investigation)
                        Fetches mint supplies via RPC to calculate market cap
                        and determines fee tier. Uses RPC_ENDPOINT env var.
  --all-swaps           Skip only invalid data (NULL balances), not conservative filters.
                        Useful for understanding true error distribution.
  --stratified <n>      Enable stratified sampling: take N swaps per pool.
                        Ensures all pools get coverage regardless of volume.
  --multi-swap          Enable multi-swap sequential evaluation. Evaluates TXs with
                        multiple swaps by simulating them in instruction order.
  --tiered-fees         Fetch FeeConfig from Fee Program and use market-cap-based
                        tiered fees (PS-005 validation). Requires RPC_ENDPOINT.
  -h, --help            Show help

Environment:
  RPC_ENDPOINT          RPC URL for fetching mint supplies (default: http://127.0.0.1:8899)
`.trim();
}

function parseArgs(argv: string[]): CliOpts {
    const out: CliOpts = {
        db: DEFAULT_DB_PATH,
        swapDb: undefined,
        cacheDb: undefined,
        session: undefined,
        venue: 'venueSwapswap',
        limit: 100000,       // Default to 100k (use --no-limit for all)
        noLimit: false,
        feeBps: 25,
        toleranceBps: 10,
        out: undefined,
        help: false,
        dynamicFees: false,
        allSwaps: false,
        multiSwap: false,
        tieredFees: false,
    };

    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--db') out.db = String(argv[++i] ?? '');
        else if (a === '--swap-db') out.swapDb = String(argv[++i] ?? '');
        else if (a === '--cache-db') out.cacheDb = String(argv[++i] ?? '');
        else if (a === '--session') out.session = String(argv[++i] ?? '');
        else if (a === '--venue') out.venue = String(argv[++i] ?? '') as any;
        else if (a === '--limit') out.limit = Number(argv[++i] ?? '');
        else if (a === '--no-limit') out.noLimit = true;
        else if (a === '--fee-bps') out.feeBps = Number(argv[++i] ?? '');
        else if (a === '--tolerance-bps') out.toleranceBps = Number(argv[++i] ?? '');
        else if (a === '--out') out.out = String(argv[++i] ?? '');
        else if (a === '--dynamic-fees') out.dynamicFees = true;
        else if (a === '--all-swaps') out.allSwaps = true;
        else if (a === '--stratified') out.stratified = Number(argv[++i] ?? '100');
        else if (a === '--multi-swap') out.multiSwap = true;
        else if (a === '--tiered-fees') out.tieredFees = true;
        else if (a === '-h' || a === '--help') out.help = true;
        else {
            console.error(`Unknown argument: ${a}`);
            out.help = true;
        }
    }

    return out;
}

function resolveDbPath(dbPath: string): string {
    return path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath);
}

function openDb(dbPath: string): Database.Database {
    const resolved = resolveDbPath(dbPath);
    if (!fs.existsSync(resolved)) throw new Error(`DB not found: ${resolved}`);
    return new Database(resolved, { readonly: true, fileMustExist: true });
}

function toBigIntStrict(s: string, label: string): bigint {
    if (s === '' || s == null) throw new Error(`${label} is empty`);
    // handle accidental scientific notation etc
    if (!/^\d+$/.test(s)) throw new Error(`${label} not an integer string: ${s}`);
    return BigInt(s);
}

function percentile(values: number[], p: number): number {
    if (values.length === 0) return NaN;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.floor((p / 100) * (sorted.length - 1));
    return sorted[idx]!;
}

function parseTokenBalances(json: string): Map<number, bigint> {
    const arr = JSON.parse(json) as TokenBalanceRow[];
    const m = new Map<number, bigint>();
    for (const row of arr) {
        const amt = BigInt(row.ui_token_amount.amount);
        m.set(row.account_index, amt);
    }
    return m;
}

function parseAccountKeysHex(json: string): string[] {
    const arr = JSON.parse(json) as string[];
    return arr;
}

function getAccountIndex(accountKeysHex: string[], pubkeyHex: string): number | undefined {
    const idx = accountKeysHex.indexOf(pubkeyHex);
    return idx >= 0 ? idx : undefined;
}

function getBalanceForPubkeyHex(balances: Map<number, bigint>, accountKeysHex: string[], pubkeyHex: string): bigint | undefined {
    const idx = getAccountIndex(accountKeysHex, pubkeyHex);
    if (idx == null) return undefined;
    return balances.get(idx);
}

function getLatestSessionId(db: Database.Database): string | undefined {
    // Prefer parsed_swaps since that's what this sprint consumes.
    const row = db
        .prepare(
            `SELECT session_id as sessionId, MAX(confirm_ts) AS lastTs
       FROM parsed_swaps
       GROUP BY session_id
       ORDER BY lastTs DESC
       LIMIT 1`,
        )
        .get() as { sessionId?: string } | undefined;
    return row?.sessionId;
}

function readSwapRows(db: Database.Database, sessionId: string, venue: VenueText | 'all', limit: number, noLimit: boolean): SwapRow[] {
    const venueFilter = venue === 'all' ? '' : 'AND ps.venue = @venue';
    const venueFilterNoAlias = venue === 'all' ? '' : 'AND venue = @venue';
    const limitClause = noLimit ? '' : 'LIMIT @limit';
    const sql = `
    SELECT
      ps.signature,
      ps.slot,
      ps.venue,
      ps.pool_pubkey,
      ps.direction,
      ps.input_amount,
      ps.actual_output_amount,
      ps.instruction_index,
      mt.accounts_json,
      mt.pre_balances_json,
      mt.post_balances_json
    FROM parsed_swaps ps
    JOIN mainnet_txs mt
      ON mt.signature = ps.signature AND mt.session_id = ps.session_id
    WHERE ps.session_id = @sessionId
      AND ps.decode_success = 1
      AND ps.actual_output_amount IS NOT NULL
      AND ps.actual_output_amount != ''
      ${venueFilterNoAlias}
    ORDER BY ps.confirm_ts DESC
    ${limitClause};
  `;
    const stmt = db.prepare(sql);
    const rows = stmt.all({
        sessionId,
        venue: venue === 'all' ? undefined : venue,
        limit: noLimit ? undefined : limit,
    }) as SwapRow[];
    return rows;
}

/**
 * Read swaps using stratified sampling - N swaps per pool.
 * Ensures all pools get coverage regardless of volume.
 */
function readSwapRowsStratified(db: Database.Database, sessionId: string, venue: VenueText | 'all', perPool: number): SwapRow[] {
    const venueFilter = venue === 'all' ? '' : 'AND ps.venue = @venue';
    const venueFilterNoAlias = venue === 'all' ? '' : 'AND venue = @venue';

    // Get unique pools first
    const poolsSql = `
    SELECT DISTINCT pool_pubkey
    FROM parsed_swaps
    WHERE session_id = @sessionId
      AND decode_success = 1
      AND actual_output_amount IS NOT NULL
      AND actual_output_amount != ''
      ${venueFilterNoAlias};
  `;
    const poolsStmt = db.prepare(poolsSql);
    const pools = poolsStmt.all({
        sessionId,
        venue: venue === 'all' ? undefined : venue,
    }) as Array<{ pool_pubkey: string }>;

    console.log(`Stratified sampling: ${pools.length} unique pools, ${perPool} swaps per pool`);

    // Now get N swaps per pool
    const sql = `
    SELECT
      ps.signature,
      ps.slot,
      ps.venue,
      ps.pool_pubkey,
      ps.direction,
      ps.input_amount,
      ps.actual_output_amount,
      ps.instruction_index,
      mt.accounts_json,
      mt.pre_balances_json,
      mt.post_balances_json
    FROM parsed_swaps ps
    JOIN mainnet_txs mt
      ON mt.signature = ps.signature AND mt.session_id = ps.session_id
    WHERE ps.session_id = @sessionId
      AND ps.decode_success = 1
      AND ps.actual_output_amount IS NOT NULL
      AND ps.actual_output_amount != ''
      AND ps.pool_pubkey = @poolPubkey
      ${venueFilterNoAlias}
    ORDER BY ps.confirm_ts DESC
    LIMIT @perPool;
  `;
    const stmt = db.prepare(sql);

    const allRows: SwapRow[] = [];
    for (const p of pools) {
        const rows = stmt.all({
            sessionId,
            venue: venue === 'all' ? undefined : venue,
            poolPubkey: p.pool_pubkey,
            perPool,
        }) as SwapRow[];
        allRows.push(...rows);
    }

    console.log(`Stratified sampling: ${allRows.length} total swaps`);
    return allRows;
}

/**
 * Read multi-swap transactions for sequential evaluation.
 * Returns transactions with 2+ swaps, ordered by instruction_index.
 */
function readMultiSwapRows(db: Database.Database, sessionId: string, venue: VenueText | 'all', limit: number): Map<string, SwapRow[]> {
    const venueFilter = venue === 'all' ? '' : 'AND ps.venue = @venue';
    const venueFilterNoAlias = venue === 'all' ? '' : 'AND venue = @venue';

    // Get signatures with multiple swaps
    const sigsSql = `
    SELECT signature, COUNT(*) as cnt
    FROM parsed_swaps
    WHERE session_id = @sessionId
      AND decode_success = 1
      AND actual_output_amount IS NOT NULL
      AND actual_output_amount != ''
      ${venueFilterNoAlias}
    GROUP BY signature
    HAVING COUNT(*) >= 2
    ORDER BY confirm_ts DESC
    LIMIT @limit;
  `;
    const sigsStmt = db.prepare(sigsSql);
    const sigs = sigsStmt.all({
        sessionId,
        venue: venue === 'all' ? undefined : venue,
        limit,
    }) as Array<{ signature: string; cnt: number }>;

    console.log(`Multi-swap transactions: ${sigs.length} TXs with 2+ swaps`);

    // Now get all swaps for these signatures, ordered by instruction_index
    const sql = `
    SELECT
      ps.signature,
      ps.slot,
      ps.venue,
      ps.pool_pubkey,
      ps.direction,
      ps.input_amount,
      ps.actual_output_amount,
      ps.instruction_index,
      mt.accounts_json,
      mt.pre_balances_json,
      mt.post_balances_json
    FROM parsed_swaps ps
    JOIN mainnet_txs mt
      ON mt.signature = ps.signature AND mt.session_id = ps.session_id
    WHERE ps.session_id = @sessionId
      AND ps.signature = @sig
      AND ps.decode_success = 1
      AND ps.actual_output_amount IS NOT NULL
      AND ps.actual_output_amount != ''
      ${venueFilterNoAlias}
    ORDER BY ps.instruction_index ASC;
  `;
    const stmt = db.prepare(sql);

    const result = new Map<string, SwapRow[]>();
    for (const s of sigs) {
        const rows = stmt.all({
            sessionId,
            venue: venue === 'all' ? undefined : venue,
            sig: s.signature,
        }) as SwapRow[];
        if (rows.length >= 2) {
            result.set(s.signature, rows);
        }
    }

    console.log(`Multi-swap transactions: ${result.size} TXs loaded`);
    return result;
}

/**
 * Result of evaluating a multi-swap transaction
 */
type MultiSwapResult = {
    signature: string;
    legCount: number;
    legsEvaluated: number;
    allPassed: boolean;
    maxErrorBps: number;
    errors: number[];
    skippedReason?: string;
};

function loadTopology(cacheDb: Database.Database, sessionId: string, poolHex: string): TopologyRow | undefined {
    const row = cacheDb
        .prepare(
            `SELECT venue, vault_base, vault_quote
       FROM frozen_topologies
       WHERE session_id = ? AND pool_pubkey = ?
       LIMIT 1`,
        )
        .get(sessionId, poolHex) as TopologyRow | undefined;
    return row;
}

/**
 * Get GLOBAL signature counts to detect multi-swap transactions.
 * This counts ALL swaps per signature in the database (before any filtering),
 * ensuring we catch sandwiches even when one leg has NULL output.
 */
function getGlobalSignatureCounts(db: Database.Database, sessionId: string, venue: VenueText | 'all'): Map<string, number> {
    const venueFilter = venue === 'all' ? '' : 'AND venue = @venue';
    const sql = `
    SELECT signature, COUNT(*) as cnt
    FROM parsed_swaps
    WHERE session_id = @sessionId
      ${venueFilter}
    GROUP BY signature
    HAVING COUNT(*) > 1;
  `;
    const stmt = db.prepare(sql);
    const rows = stmt.all({
        sessionId,
        venue: venue === 'all' ? undefined : venue,
    }) as Array<{ signature: string; cnt: number }>;

    const map = new Map<string, number>();
    for (const r of rows) {
        map.set(r.signature, r.cnt);
    }
    return map;
}

/**
 * Detect which vault contains WSOL and normalize if needed.
 * Returns normalized vault assignments where quote vault always holds WSOL.
 */
function normalizeVaults(
    topo: TopologyRow,
    pre: Map<number, bigint>,
    accountKeysHex: string[],
    preBalances: TokenBalanceRow[]
): { baseVault: string; quoteVault: string; swapped: boolean } {
    // Find which vault contains WSOL by checking the mint in pre_balances
    const baseIdx = getAccountIndex(accountKeysHex, topo.vault_base);
    const quoteIdx = getAccountIndex(accountKeysHex, topo.vault_quote);

    // Find the mint for each vault from pre_balances
    const baseMint = preBalances.find(b => b.account_index === baseIdx)?.mint;
    const quoteMint = preBalances.find(b => b.account_index === quoteIdx)?.mint;

    // Normalize: quote should be WSOL. If base is WSOL, swap them.
    const baseIsWsol = baseMint === WSOL_MINT_BASE58;
    const quoteIsWsol = quoteMint === WSOL_MINT_BASE58;

    if (baseIsWsol && !quoteIsWsol) {
        // Inverted - swap base and quote
        return {
            baseVault: topo.vault_quote,
            quoteVault: topo.vault_base,
            swapped: true
        };
    }

    // Normal order or can't determine
    return {
        baseVault: topo.vault_base,
        quoteVault: topo.vault_quote,
        swapped: false
    };
}

// Constant product helpers for model comparison.
// All are integer math; floors via BigInt division.

function amountOutNoFee(reserveIn: bigint, reserveOut: bigint, amountIn: bigint): bigint {
    // y*dx/(x+dx)
    if (reserveIn <= 0n || reserveOut <= 0n || amountIn <= 0n) return 0n;
    return (reserveOut * amountIn) / (reserveIn + amountIn);
}

function applyFeeOnInput(amountIn: bigint, feeBps: bigint): bigint {
    // matches common on-chain patterns: amountInWithFee = amountIn*(10000-feeBps) (no early division)
    // BUT returns the amountOut, so we use the canonical formula:
    // out = reserveOut * (amountIn*(10000-fee)) / (reserveIn*10000 + amountIn*(10000-fee))
    return amountIn; // placeholder for type symmetry (not used directly)
}

function amountOutInputFee(reserveIn: bigint, reserveOut: bigint, amountIn: bigint, feeBps: bigint): bigint {
    if (reserveIn <= 0n || reserveOut <= 0n || amountIn <= 0n) return 0n;
    const amountInWithFee = amountIn * (10000n - feeBps);
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn * 10000n + amountInWithFee;
    return numerator / denominator;
}

function amountOutOutputFee(reserveIn: bigint, reserveOut: bigint, amountIn: bigint, feeBps: bigint): bigint {
    const gross = amountOutNoFee(reserveIn, reserveOut, amountIn);
    if (gross <= 0n) return 0n;
    const feePaid = (gross * feeBps) / 10000n;
    return gross - feePaid;
}

/**
 * Inverse of amountOutInputFee: given desired output, compute required input.
 * Used for BUY instructions where we know output but not actual input.
 * Formula derived by inverting: out = (in * (10000-fee) * reserveOut) / (reserveIn * 10000 + in * (10000-fee))
 */
function amountInFromOut(reserveIn: bigint, reserveOut: bigint, amountOut: bigint, feeBps: bigint): bigint {
    if (reserveIn <= 0n || reserveOut <= 0n || amountOut <= 0n) return 0n;
    if (amountOut >= reserveOut) return 0n; // Can't withdraw more than reserve
    const feeMultiplier = 10000n - feeBps;
    // in = (reserveIn * amountOut * 10000) / ((reserveOut - amountOut) * feeMultiplier)
    const numerator = reserveIn * amountOut * 10000n;
    const denominator = (reserveOut - amountOut) * feeMultiplier;
    if (denominator <= 0n) return 0n;
    return numerator / denominator + 1n; // +1 to round up
}

function absBigint(x: bigint): bigint {
    return x >= 0n ? x : -x;
}

function errorBps(pred: bigint, actual: bigint): number {
    if (actual <= 0n) return Number.POSITIVE_INFINITY;
    const absErr = absBigint(pred - actual);
    // error_bps = abs(pred-actual) * 10000 / actual
    return Number((absErr * 10000n) / actual);
}

type ModelName = 'inputFee' | 'outputFee' | 'asymAtoB_out' | 'asymAtoB_in' | 'dynamicFee' | 'tieredFee';

function predictByModel(model: ModelName, reserveIn: bigint, reserveOut: bigint, amountIn: bigint, feeBps: bigint, direction: number): bigint {
    // dynamicFee and tieredFee models use a per-swap feeBps passed in, so they're the same as inputFee
    if (model === 'dynamicFee' || model === 'tieredFee') return amountOutInputFee(reserveIn, reserveOut, amountIn, feeBps);
    // direction: SwapDirection.AtoB or BtoA
    if (model === 'inputFee') return amountOutInputFee(reserveIn, reserveOut, amountIn, feeBps);
    if (model === 'outputFee') return amountOutOutputFee(reserveIn, reserveOut, amountIn, feeBps);

    // Asymmetric models:
    // - asymAtoB_out: A->B uses output fee, B->A uses input fee
    if (model === 'asymAtoB_out') {
        return direction === SwapDirection.AtoB
            ? amountOutOutputFee(reserveIn, reserveOut, amountIn, feeBps)
            : amountOutInputFee(reserveIn, reserveOut, amountIn, feeBps);
    }

    // - asymAtoB_in: A->B uses input fee, B->A uses output fee
    return direction === SwapDirection.AtoB
        ? amountOutInputFee(reserveIn, reserveOut, amountIn, feeBps)
        : amountOutOutputFee(reserveIn, reserveOut, amountIn, feeBps);
}

async function main(): Promise<void> {
    const opts = parseArgs(process.argv);
    if (opts.help) {
        console.log(usage());
        process.exit(0);
    }

    const swapPath = opts.swapDb ?? opts.db;
    const cachePath = opts.cacheDb ?? opts.db;

    const swapDb = openDb(swapPath);
    const cacheDb = cachePath === swapPath ? swapDb : openDb(cachePath);

    const sessionId = opts.session ?? getLatestSessionId(swapDb);
    if (!sessionId) throw new Error('Could not determine a session_id (parsed_swaps empty?)');

    console.log('Infrastructure Proving (Layer 2)');
    console.log('NO WORKAROUNDS - fees from Layer 1 only');
    console.log(`  session : ${sessionId}`);
    console.log(`  swap-db : ${resolveDbPath(swapPath)}`);
    console.log(`  cache-db: ${resolveDbPath(cachePath)}`);
    console.log(`  venue   : ${opts.venue}`);
    console.log(`  limit   : ${opts.noLimit ? 'unlimited' : opts.limit.toLocaleString()}`);
    console.log(`  PumpSwap feeBps: ${opts.feeBps} (from GlobalConfig default)`);
    console.log(`  tolerance: ${opts.toleranceBps} bps`);
    if (opts.allSwaps) {
        console.log(`  *** ALL-SWAPS MODE: Skipping only NULL balances ***`);
    }
    if (opts.stratified) {
        console.log(`  *** STRATIFIED SAMPLING: ${opts.stratified} swaps per pool ***`);
    }
    if (opts.multiSwap) {
        console.log(`  *** MULTI-SWAP SEQUENTIAL EVALUATION ENABLED ***`);
    }
    if (opts.dynamicFees) {
        console.log(`  *** DYNAMIC FEE TESTING ENABLED (PS-002) ***`);
        console.log(`  RPC endpoint: ${RPC_ENDPOINT}`);
    }
    if (opts.tieredFees) {
        console.log(`  *** TIERED FEES TESTING ENABLED (PS-005) ***`);
        console.log(`  RPC endpoint: ${RPC_ENDPOINT}`);
    }
    console.log('');

    // Choose sampling method
    const rows = opts.stratified
        ? readSwapRowsStratified(swapDb, sessionId, opts.venue, opts.stratified)
        : readSwapRows(swapDb, sessionId, opts.venue, opts.limit, opts.noLimit);

    if (rows.length === 0) {
        console.log('No swaps found for the given filters.');
        process.exit(0);
    }

    // Venue counts (for S1-T1 extraction sanity).
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.venue, (counts.get(r.venue) ?? 0) + 1);

    console.log('Extracted swaps (from parsed_swaps ⨝ mainnet_txs):');
    for (const [v, c] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${v.padEnd(12)} ${c.toLocaleString()}`);
    }
    console.log('');

    // Filter by selected venue (default venueSwapswap, or specified via --venue)
    const targetVenue = opts.venue || 'venueSwapswap';
    const venueSwaps = rows.filter((r) => r.venue === targetVenue);

    if (venueSwaps.length === 0) {
        console.log(`No ${targetVenue} swaps in this sample; nothing to validate yet.`);
        process.exit(0);
    }

    const topoCache = new Map<string, TopologyRow>();

    // Models to test - add dynamicFee/tieredFee if enabled
    let models: ModelName[] = ['inputFee', 'outputFee', 'asymAtoB_out', 'asymAtoB_in'];
    if (opts.dynamicFees) models.push('dynamicFee');
    if (opts.tieredFees) models.push('tieredFee');
    const perModelErrors: Record<ModelName, number[]> = {
        inputFee: [],
        outputFee: [],
        asymAtoB_out: [],
        asymAtoB_in: [],
        dynamicFee: [],
        tieredFee: [],
    };
    const perModelPass: Record<ModelName, number> = {
        inputFee: 0,
        outputFee: 0,
        asymAtoB_out: 0,
        asymAtoB_in: 0,
        dynamicFee: 0,
        tieredFee: 0,
    };

    // Track dynamic fee stats if enabled
    let dynamicFeeSupplyFetched = 0;
    let dynamicFeeSupplyMissing = 0;
    const marketCapDistribution: bigint[] = [];  // For analysis
    const feeDistribution: Map<number, number> = new Map();  // fee bps -> count

    // Track tiered fee stats if enabled
    let tieredFeeConfig: typeof feeConfigCache = null;
    let tieredFeeSupplyFetched = 0;
    let tieredFeeSupplyMissing = 0;
    const tieredFeeDistribution: Map<number, number> = new Map();  // fee bps -> count

    // Fetch FeeConfig if tiered fees enabled
    if (opts.tieredFees) {
        console.log('Fetching FeeConfig from Fee Program...');
        tieredFeeConfig = await fetchFeeConfig();
        if (tieredFeeConfig && tieredFeeConfig.tiers.length > 0) {
            console.log(`  Loaded ${tieredFeeConfig.tiers.length} fee tiers`);
            for (const tier of tieredFeeConfig.tiers) {
                const totalBps = tier.lpFeeBps + tier.protocolFeeBps + tier.creatorFeeBps;
                console.log(`    cap<=${(Number(tier.marketCapLamportsThreshold) / 1e9).toFixed(0)}SOL: ${totalBps}bps (lp=${tier.lpFeeBps} proto=${tier.protocolFeeBps} creator=${tier.creatorFeeBps})`);
            }
            console.log(`  Flat fees: lp=${tieredFeeConfig.flatFees.lpFeeBps} proto=${tieredFeeConfig.flatFees.protocolFeeBps} creator=${tieredFeeConfig.flatFees.creatorFeeBps}`);
        } else {
            console.log('  Using default 25 bps (failed to load FeeConfig)');
        }
        console.log('');
    }

    let evaluated = 0;
    let skippedMissingTopo = 0;
    let skippedMissingVaultBalances = 0;
    let skippedMultiSwap = 0;
    let skippedDust = 0;

    let derivedAtoB = 0;
    let derivedBtoA = 0;
    let skippedWeirdFlow = 0;

    let parsedDirMatches = 0;
    let parsedDirMismatches = 0;

    let parsedOutMatches = 0;
    const parsedOutErrBps: number[] = [];

    // Minimum amount thresholds to filter dust trades that are dominated by rounding
    const MIN_AMOUNT_IN = 10000n; // 10k lamports minimum

    // Maximum reserve ratio - pools with extreme ratios are likely bonding curve (not CPMM)
    // PumpSwap uses a bonding curve until ~$69k market cap, then graduates to AMM
    const MAX_RESERVE_RATIO = 10000n; // 10000:1 max ratio

    let skippedBondingCurve = 0;
    let skippedComplexTx = 0;

    // Get GLOBAL signature counts to detect multi-swap transactions
    // This counts ALL swaps per signature in the DB (before filtering),
    // ensuring we catch sandwiches even when one leg has NULL output.
    const globalMultiSwapSigs = getGlobalSignatureCounts(swapDb, sessionId, opts.venue);
    console.log(`Multi-swap signatures (global): ${globalMultiSwapSigs.size.toLocaleString()}`);
    console.log('');

    // Track per-pool pass/fail stats to identify problematic pools
    const poolStats = new Map<string, { pass: number; fail: number }>();



    const worstSamples: Array<{
        signature: string;
        parsedDirection: number;
        derivedDirection: number;
        reserveIn: string;
        reserveOut: string;
        amountIn: string;
        baseDelta: string;
        quoteDelta: string;
        actualOutVault: string;
        actualOutParsed: string;
        model: ModelName;
        predOut: string;
        errBps: number;
    }> = [];

    // Fee from Layer 1 (GlobalConfig default) - NO WORKAROUNDS
    const feeBps = BigInt(opts.feeBps);

    // Progress reporting
    const PROGRESS_INTERVAL = 1000;
    let processedCount = 0;
    const startTime = Date.now();

    for (const r of venueSwaps) {
        // Progress reporting every N swaps
        processedCount++;
        if (processedCount % PROGRESS_INTERVAL === 0) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const rate = (processedCount / ((Date.now() - startTime) / 1000)).toFixed(0);
            console.log(`  [progress] ${processedCount.toLocaleString()} / ${venueSwaps.length.toLocaleString()} processed (${elapsed}s, ${rate}/s, ${evaluated} evaluated)`);
        }

        // Skip multi-swap transactions - they pollute reserve measurements
        // Uses GLOBAL count (not filtered result count) to catch sandwiches with NULL legs
        // In --all-swaps mode, we still skip these since they need sequential evaluation (Phase 1.3)
        if (globalMultiSwapSigs.has(r.signature)) {
            skippedMultiSwap++;
            continue;
        }

        const topo = topoCache.get(r.pool_pubkey) ?? loadTopology(cacheDb, sessionId, r.pool_pubkey);
        if (!topo) {
            skippedMissingTopo++;
            continue;
        }
        topoCache.set(r.pool_pubkey, topo);

        const accountKeysHex = parseAccountKeysHex(r.accounts_json);
        const pre = parseTokenBalances(r.pre_balances_json);
        const post = parseTokenBalances(r.post_balances_json);
        const preBalances = JSON.parse(r.pre_balances_json) as TokenBalanceRow[];

        // Normalize vault assignments - ensure quote is always WSOL
        const normalized = normalizeVaults(topo, pre, accountKeysHex, preBalances);

        const basePre = getBalanceForPubkeyHex(pre, accountKeysHex, normalized.baseVault);
        const quotePre = getBalanceForPubkeyHex(pre, accountKeysHex, normalized.quoteVault);
        const basePost = getBalanceForPubkeyHex(post, accountKeysHex, normalized.baseVault);
        const quotePost = getBalanceForPubkeyHex(post, accountKeysHex, normalized.quoteVault);

        if (basePre == null || quotePre == null || basePost == null || quotePost == null) {
            skippedMissingVaultBalances++;
            continue;
        }

        // Detect complex transactions with large token movements outside vaults
        // These are MEV/arb transactions that touch multiple DeFi protocols
        const baseIdx = getAccountIndex(accountKeysHex, normalized.baseVault);
        const quoteIdx = getAccountIndex(accountKeysHex, normalized.quoteVault);
        const baseVaultDelta = basePost > basePre ? basePost - basePre : basePre - basePost;
        const quoteVaultDelta = quotePost > quotePre ? quotePost - quotePre : quotePre - quotePost;
        const maxVaultDelta = baseVaultDelta > quoteVaultDelta ? baseVaultDelta : quoteVaultDelta;

        // Check if any non-vault account has a larger delta than the vault movements
        let hasLargeExternalMovement = false;
        for (const [idx, preAmt] of pre.entries()) {
            if (idx === baseIdx || idx === quoteIdx) continue;
            const postAmt = post.get(idx) ?? 0n;
            const delta = postAmt > preAmt ? postAmt - preAmt : preAmt - postAmt;
            // If external movement is 10x larger than vault movement, it's a complex tx
            if (delta > maxVaultDelta * 10n && delta > 1000000000n) {
                hasLargeExternalMovement = true;
                break;
            }
        }
        if (hasLargeExternalMovement) {
            skippedComplexTx++;
            if (!opts.allSwaps) continue;
            // In --all-swaps mode, proceed despite complexity
        }

        const parsedDir = Number(r.direction);
        const actualOutParsed = toBigIntStrict(r.actual_output_amount, 'actual_output_amount');

        // Derive swap direction + in/out amounts from *vault deltas*.
        // This is ground truth for the pool's reserve transition and catches decode-direction bugs.
        const baseDelta = basePost - basePre;
        const quoteDelta = quotePost - quotePre;

        let derivedDir: number;
        let reserveIn: bigint;
        let reserveOut: bigint;
        let amountIn: bigint;
        let actualOutVault: bigint;

        if (baseDelta > 0n && quoteDelta < 0n) {
            // base increased, quote decreased => base in, quote out
            derivedDir = SwapDirection.AtoB;
            reserveIn = basePre;
            reserveOut = quotePre;
            amountIn = baseDelta;
            actualOutVault = -quoteDelta;
            derivedAtoB++;
        } else if (baseDelta < 0n && quoteDelta > 0n) {
            // quote increased, base decreased => quote in, base out
            derivedDir = SwapDirection.BtoA;
            reserveIn = quotePre;
            reserveOut = basePre;
            amountIn = quoteDelta;
            actualOutVault = -baseDelta;
            derivedBtoA++;
        } else {
            // Not a simple swap reserve transition; skip (could be multi-instruction / liquidity / edge case).
            skippedWeirdFlow++;
            continue;
        }

        // Filter dust trades - tiny amounts are dominated by rounding errors
        if (amountIn < MIN_AMOUNT_IN) {
            skippedDust++;
            if (!opts.allSwaps) continue;
            // In --all-swaps mode, proceed despite dust
        }

        // Filter extreme reserve ratios (unlikely to be valid AMM pools)
        const reserveRatio = reserveIn > reserveOut
            ? reserveIn / (reserveOut > 0n ? reserveOut : 1n)
            : reserveOut / (reserveIn > 0n ? reserveIn : 1n);
        if (reserveRatio > MAX_RESERVE_RATIO) {
            skippedBondingCurve++;
            if (!opts.allSwaps) continue;
            // In --all-swaps mode, proceed despite extreme ratio
        }

        if (parsedDir === derivedDir) parsedDirMatches++;
        else parsedDirMismatches++;

        // How well does parsed_swaps.actual_output_amount match vault outflow?
        // If this is consistently off, it means parsed_swaps is measuring a different "actual" (e.g. user delta).
        const parsedVsVaultOutErr = errorBps(actualOutParsed, actualOutVault);
        parsedOutErrBps.push(parsedVsVaultOutErr);
        if (parsedVsVaultOutErr <= opts.toleranceBps) parsedOutMatches++;

        // For sim accuracy, treat vault outflow as ground truth output.
        const dir = derivedDir;
        const actualOut = actualOutVault;

        if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n || actualOut <= 0n) {
            skippedMissingVaultBalances++;
            continue;
        }

        evaluated++;

        // Track pool-level stats
        const poolStat = poolStats.get(r.pool_pubkey) ?? { pass: 0, fail: 0 };
        const testPred = amountOutInputFee(reserveIn, reserveOut, amountIn, feeBps);
        const testErr = errorBps(testPred, actualOut);
        if (testErr <= opts.toleranceBps) poolStat.pass++;
        else poolStat.fail++;
        poolStats.set(r.pool_pubkey, poolStat);

        // Calculate dynamic fee if enabled
        let dynamicFeeBps = feeBps;  // Default to fixed fee
        if (opts.dynamicFees) {
            // Find the base mint (non-WSOL mint) from preBalances
            // basePre is the base vault balance, we need the mint for that vault
            const baseIdx = getAccountIndex(accountKeysHex, normalized.baseVault);
            const baseMintEntry = preBalances.find(b => b.account_index === baseIdx);

            if (baseMintEntry && baseMintEntry.mint !== WSOL_MINT_BASE58) {
                // Convert base58 mint to hex for cache lookup
                const baseMintHex = Buffer.from(decodeBase58(baseMintEntry.mint)).toString('hex');

                // Fetch mint supply (async but cached)
                const baseMintSupply = await getMintSupply(baseMintHex);

                if (baseMintSupply !== null) {
                    dynamicFeeSupplyFetched++;

                    // Calculate market cap in lamports
                    // marketCap = (quoteReserve * baseMintSupply) / baseReserve
                    // Note: quoteReserve is quotePre (WSOL), baseReserve is basePre
                    const marketCap = calculateMarketCap(quotePre, basePre, baseMintSupply);

                    // Track for analysis
                    marketCapDistribution.push(marketCap);

                    // Get fee for this market cap tier
                    dynamicFeeBps = getFeeBpsForMarketCap(marketCap);

                    // Track fee distribution
                    const feeCount = feeDistribution.get(Number(dynamicFeeBps)) ?? 0;
                    feeDistribution.set(Number(dynamicFeeBps), feeCount + 1);
                } else {
                    dynamicFeeSupplyMissing++;
                    // Keep default fee if supply fetch failed
                }
            } else {
                dynamicFeeSupplyMissing++;
            }
        }

        // Calculate tiered fee if enabled
        let tieredFeeBps = feeBps;  // Default to fixed fee
        if (opts.tieredFees) {
            // Find the base mint (non-WSOL mint) from preBalances
            const baseIdx = getAccountIndex(accountKeysHex, normalized.baseVault);
            const baseMintEntry = preBalances.find(b => b.account_index === baseIdx);

            if (baseMintEntry && baseMintEntry.mint !== WSOL_MINT_BASE58) {
                // Convert base58 mint to hex for cache lookup
                const baseMintHex = Buffer.from(decodeBase58(baseMintEntry.mint)).toString('hex');

                // Fetch mint supply (async but cached)
                const baseMintSupply = await getMintSupply(baseMintHex);

                if (baseMintSupply !== null) {
                    tieredFeeSupplyFetched++;

                    // Calculate market cap in lamports
                    // marketCap = (quoteReserve * baseMintSupply) / baseReserve
                    const marketCap = calculateMarketCap(quotePre, basePre, baseMintSupply);

                    // Get fee for this market cap tier using FeeConfig
                    tieredFeeBps = getTieredFeeBps(marketCap, tieredFeeConfig);

                    // Track fee distribution
                    const feeCount = tieredFeeDistribution.get(Number(tieredFeeBps)) ?? 0;
                    tieredFeeDistribution.set(Number(tieredFeeBps), feeCount + 1);
                } else {
                    tieredFeeSupplyMissing++;
                    // Keep default fee if supply fetch failed
                }
            } else {
                tieredFeeSupplyMissing++;
            }
        }

        // Compute each model's error.
        for (const m of models) {
            // Use appropriate fee for each model
            let modelFeeBps = feeBps;
            if (m === 'dynamicFee') modelFeeBps = dynamicFeeBps;
            else if (m === 'tieredFee') modelFeeBps = tieredFeeBps;
            const pred = predictByModel(m, reserveIn, reserveOut, amountIn, modelFeeBps, dir);
            const e = errorBps(pred, actualOut);
            perModelErrors[m].push(e);
            if (e <= opts.toleranceBps) perModelPass[m]++;

            // track worst samples per model (small list)
            if (worstSamples.length < 25) {
                worstSamples.push({
                    signature: r.signature,
                    parsedDirection: parsedDir,
                    derivedDirection: dir,
                    reserveIn: reserveIn.toString(),
                    reserveOut: reserveOut.toString(),
                    amountIn: amountIn.toString(),
                    baseDelta: baseDelta.toString(),
                    quoteDelta: quoteDelta.toString(),
                    actualOutVault: actualOut.toString(),
                    actualOutParsed: actualOutParsed.toString(),
                    model: m,
                    predOut: pred.toString(),
                    errBps: e,
                });
            } else {
                // replace if worse than current best worst
                const minIdx = worstSamples.reduce((best, cur, idx, arr) => (cur.errBps < arr[best]!.errBps ? idx : best), 0);
                if (e > worstSamples[minIdx]!.errBps) {
                    worstSamples[minIdx] = {
                        signature: r.signature,
                        parsedDirection: parsedDir,
                        derivedDirection: dir,
                        reserveIn: reserveIn.toString(),
                        reserveOut: reserveOut.toString(),
                        amountIn: amountIn.toString(),
                        baseDelta: baseDelta.toString(),
                        quoteDelta: quoteDelta.toString(),
                        actualOutVault: actualOut.toString(),
                        actualOutParsed: actualOutParsed.toString(),
                        model: m,
                        predOut: pred.toString(),
                        errBps: e,
                    };
                }
            }
        }
    }

    // Final progress message
    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  [complete] Processed ${venueSwaps.length.toLocaleString()} swaps in ${totalElapsed}s`);
    console.log('');

    console.log('PumpSwap validation sample:');
    console.log(`  evaluated swaps           : ${evaluated.toLocaleString()}`);
    console.log(`  skipped (multi-swap tx)   : ${skippedMultiSwap.toLocaleString()}`);
    console.log(`  skipped (dust < 10k)      : ${skippedDust.toLocaleString()}`);
    console.log(`  skipped (weird flow)      : ${skippedWeirdFlow.toLocaleString()}`);
    console.log(`  skipped (bonding curve)   : ${skippedBondingCurve.toLocaleString()}`);
    console.log(`  skipped (complex tx)      : ${skippedComplexTx.toLocaleString()}`);
    console.log(`  skipped (missing topology): ${skippedMissingTopo.toLocaleString()}`);
    console.log(`  skipped (missing balances): ${skippedMissingVaultBalances.toLocaleString()}`);
    console.log(`  effective evaluated pct    : ${(venueSwaps.length ? (100 * evaluated / venueSwaps.length) : 0).toFixed(2)}% (${evaluated.toLocaleString()} / ${venueSwaps.length.toLocaleString()})`);
    console.log('');

    // Print dynamic fee stats if enabled
    if (opts.dynamicFees) {
        console.log('Dynamic Fee Testing (PS-002):');
        console.log(`  mint supplies fetched     : ${dynamicFeeSupplyFetched.toLocaleString()}`);
        console.log(`  mint supplies missing     : ${dynamicFeeSupplyMissing.toLocaleString()}`);
        console.log(`  unique mints cached       : ${mintSupplyCache.size.toLocaleString()}`);

        // Market cap distribution (in SOL for readability)
        if (marketCapDistribution.length > 0) {
            const sorted = [...marketCapDistribution].sort((a, b) => Number(a - b));
            const toSol = (lamports: bigint) => Number(lamports) / 1_000_000_000;
            console.log(`  market cap p50            : ${toSol(sorted[Math.floor(sorted.length * 0.5)]!).toFixed(2)} SOL`);
            console.log(`  market cap p95            : ${toSol(sorted[Math.floor(sorted.length * 0.95)]!).toFixed(2)} SOL`);
            console.log(`  market cap max            : ${toSol(sorted[sorted.length - 1]!).toFixed(2)} SOL`);
        }

        // Fee tier distribution
        if (feeDistribution.size > 0) {
            console.log('  fee tier distribution:');
            const sortedFees = [...feeDistribution.entries()].sort((a, b) => a[0] - b[0]);
            for (const [fee, count] of sortedFees) {
                const pct = ((count / dynamicFeeSupplyFetched) * 100).toFixed(1);
                console.log(`    ${fee} bps: ${count.toLocaleString()} (${pct}%)`);
            }
        }
        console.log('');
    }

    // Print tiered fee stats if enabled
    if (opts.tieredFees) {
        console.log('Tiered Fee Testing (PS-005):');
        console.log(`  mint supplies fetched     : ${tieredFeeSupplyFetched.toLocaleString()}`);
        console.log(`  mint supplies missing     : ${tieredFeeSupplyMissing.toLocaleString()}`);

        // Fee tier distribution
        if (tieredFeeDistribution.size > 0) {
            console.log('  fee tier distribution:');
            const sortedFees = [...tieredFeeDistribution.entries()].sort((a, b) => a[0] - b[0]);
            for (const [fee, count] of sortedFees) {
                const pct = ((count / tieredFeeSupplyFetched) * 100).toFixed(1);
                console.log(`    ${fee} bps: ${count.toLocaleString()} (${pct}%)`);
            }
        }
        console.log('');
    }

    const derivedTotal = derivedAtoB + derivedBtoA;
    const dirAgreePct = derivedTotal > 0 ? (100 * parsedDirMatches / derivedTotal) : 0;

    const outTotal = parsedOutErrBps.length;
    const outAgreePct = outTotal > 0 ? (100 * parsedOutMatches / outTotal) : 0;
    const outP50 = outTotal > 0 ? percentile(parsedOutErrBps, 0.5) : NaN;
    const outP95 = outTotal > 0 ? percentile(parsedOutErrBps, 0.95) : NaN;

    console.log('PumpSwap derived-flow sanity (from vault deltas):');
    console.log(`  derived AtoB              : ${derivedAtoB.toLocaleString()}`);
    console.log(`  derived BtoA              : ${derivedBtoA.toLocaleString()}`);
    console.log(
        `  parsed direction match    : ${parsedDirMatches.toLocaleString()} / ${derivedTotal.toLocaleString()} (${dirAgreePct.toFixed(2)}%)`
    );
    console.log(
        `  parsed output≈vault out   : ${parsedOutMatches.toLocaleString()} / ${outTotal.toLocaleString()} (${outAgreePct.toFixed(
            2
        )}%)  p50=${Number.isFinite(outP50) ? outP50.toFixed(0) : 'NA'}bps  p95=${Number.isFinite(outP95) ? outP95.toFixed(0) : 'NA'}bps`
    );
    console.log('');

    if (evaluated === 0) {
        console.log('No evaluatable PumpSwap swaps were found (check frozen_topologies and token balance capture).');
        process.exit(1);
    }

    // Summaries per model.
    type ModelSummary = {
        model: ModelName;
        passRate: number;
        p50: number;
        p95: number;
        p99: number;
        max: number;
    };

    const summaries: ModelSummary[] = models.map((m) => {
        const es = perModelErrors[m];
        const passRate = perModelPass[m] / Math.max(1, evaluated);
        return {
            model: m,
            passRate,
            p50: percentile(es, 50),
            p95: percentile(es, 95),
            p99: percentile(es, 99),
            max: Math.max(...es),
        };
    });

    summaries.sort((a, b) => b.passRate - a.passRate || a.p95 - b.p95);

    console.log('PumpSwap fee model comparison (error vs vault outflow):');
    for (const s of summaries) {
        console.log(
            `  ${s.model.padEnd(12)} passRate=${(s.passRate * 100).toFixed(2)}%  p50=${s.p50.toFixed(
                0,
            )}bps  p95=${s.p95.toFixed(0)}bps  p99=${s.p99.toFixed(0)}bps  max=${s.max.toFixed(0)}bps`,
        );
    }
    console.log('');

    const best = summaries[0]!;
    console.log(`Best model (by passRate, then p95): ${best.model}`);
    console.log('');

    const worst = worstSamples
        .filter((w) => w.model === best.model)
        .sort((a, b) => b.errBps - a.errBps)
        .slice(0, 10);

    if (worst.length > 0) {
        console.log('Worst samples (best-model):');
        for (const w of worst) {
            console.log(
                `  sig=${w.signature} parsedDir=${w.parsedDirection} derivedDir=${w.derivedDirection} err=${w.errBps}bps pred=${w.predOut} vaultOut=${w.actualOutVault} parsedOut=${w.actualOutParsed} baseΔ=${w.baseDelta} quoteΔ=${w.quoteDelta}`
            );
        }
        console.log('');
    }

    // Pool stats - find worst and best performing pools
    const poolStatsArray = [...poolStats.entries()].map(([pool, stats]) => ({
        pool,
        ...stats,
        total: stats.pass + stats.fail,
        passRate: stats.pass / (stats.pass + stats.fail),
    }));
    const worstPools = poolStatsArray
        .filter(p => p.total >= 3) // minimum sample size
        .sort((a, b) => a.passRate - b.passRate)
        .slice(0, 5);
    const bestPools = poolStatsArray
        .filter(p => p.total >= 3)
        .sort((a, b) => b.passRate - a.passRate)
        .slice(0, 5);

    if (worstPools.length > 0) {
        console.log(`Pool stats (${poolStats.size} pools):`);
        console.log('  Worst pools:');
        for (const p of worstPools) {
            console.log(`    ${p.pool.slice(0, 16)}... pass=${p.pass}/${p.total} (${(p.passRate * 100).toFixed(0)}%)`);
        }
        console.log('  Best pools:');
        for (const p of bestPools) {
            console.log(`    ${p.pool.slice(0, 16)}... pass=${p.pass}/${p.total} (${(p.passRate * 100).toFixed(0)}%)`);
        }
        console.log('');
    }

    // Multi-swap sequential evaluation (if enabled)
    // NEW APPROACH: Validate total vault change instead of per-leg outputs.
    // Ground truth is vault deltas from mainnet_txs (pre/post balances), NOT parsed_swaps.actual_output_amount.
    let multiSwapResults: MultiSwapResult[] = [];
    if (opts.multiSwap) {
        console.log('=== Multi-Swap Vault Delta Evaluation ===');

        const multiSwapTxs = readMultiSwapRows(swapDb, sessionId, opts.venue, opts.limit);

        let msEvaluated = 0;
        let msPassed = 0;
        let msSkippedMissingTopo = 0;
        let msSkippedMissingBalances = 0;
        let msSkippedMultiPool = 0;
        const msErrors: number[] = [];

        for (const [sig, legs] of multiSwapTxs) {
            // All legs share the same TX metadata
            const firstLeg = legs[0]!;
            const accountKeysHex = parseAccountKeysHex(firstLeg.accounts_json);
            const pre = parseTokenBalances(firstLeg.pre_balances_json);
            const post = parseTokenBalances(firstLeg.post_balances_json);
            const preBalances = JSON.parse(firstLeg.pre_balances_json) as TokenBalanceRow[];
            const postBalances = JSON.parse(firstLeg.post_balances_json) as TokenBalanceRow[];

            // Check if all legs are on the same pool (simplifies validation)
            const uniquePools = new Set(legs.map(l => l.pool_pubkey));
            if (uniquePools.size > 1) {
                // Multi-pool TX - skip for now (complex case)
                msSkippedMultiPool++;
                continue;
            }

            const poolPubkey = legs[0]!.pool_pubkey;
            const topo = topoCache.get(poolPubkey) ?? loadTopology(cacheDb, sessionId, poolPubkey);
            if (!topo) {
                msSkippedMissingTopo++;
                continue;
            }
            topoCache.set(poolPubkey, topo);

            // Normalize vaults (ensure quote = WSOL)
            const normalized = normalizeVaults(topo, pre, accountKeysHex, preBalances);

            // Get pre and post vault balances (ground truth)
            const basePre = getBalanceForPubkeyHex(pre, accountKeysHex, normalized.baseVault);
            const quotePre = getBalanceForPubkeyHex(pre, accountKeysHex, normalized.quoteVault);
            const basePost = getBalanceForPubkeyHex(post, accountKeysHex, normalized.baseVault);
            const quotePost = getBalanceForPubkeyHex(post, accountKeysHex, normalized.quoteVault);

            if (basePre == null || quotePre == null || basePost == null || quotePost == null) {
                msSkippedMissingBalances++;
                continue;
            }

            // Calculate actual vault deltas (ground truth)
            const actualBaseDelta = basePost - basePre;
            const actualQuoteDelta = quotePost - quotePre;

            // CPMM invariant check: k = base * quote should be preserved (or increase due to fees)
            // Multi-leg swaps can't be modeled as single swaps, but k should be consistent.
            const kPre = basePre * quotePre;
            const kPost = basePost * quotePost;

            // k should stay same or increase (fees go to LPs)
            // Calculate how much k changed as a percentage
            // err = |kPost - kPre| / kPre * 10000 (in bps)
            const kDelta = kPost - kPre;

            // For valid CPMM swaps with fees, kPost >= kPre
            // Allow small negative delta for rounding
            const kErr = kPre > 0n
                ? Number((absBigint(kDelta) * 10000n) / kPre)
                : Number.POSITIVE_INFINITY;

            // Additional check: k should not decrease significantly
            const kDecreased = kPost < kPre;
            const significantDecrease = kDecreased && kErr > 10; // More than 0.1% decrease is suspicious

            const err = significantDecrease ? kErr + 10000 : kErr; // Penalize decreases
            msErrors.push(err);
            msEvaluated++;

            const passed = err <= opts.toleranceBps;
            if (passed) {
                msPassed++;
            }

            multiSwapResults.push({
                signature: sig,
                legCount: legs.length,
                legsEvaluated: legs.length,
                allPassed: passed,
                maxErrorBps: err,
                errors: [err],
            });
        }

        console.log('');
        console.log('Multi-swap evaluation results (vault delta method):');
        console.log(`  TXs evaluated           : ${msEvaluated.toLocaleString()}`);
        console.log(`  TXs passed              : ${msPassed.toLocaleString()} (${(msEvaluated > 0 ? (100 * msPassed / msEvaluated) : 0).toFixed(2)}%)`);
        console.log(`  skipped (missing topo)  : ${msSkippedMissingTopo.toLocaleString()}`);
        console.log(`  skipped (missing bal)   : ${msSkippedMissingBalances.toLocaleString()}`);
        console.log(`  skipped (multi-pool)    : ${msSkippedMultiPool.toLocaleString()}`);

        if (msErrors.length > 0) {
            console.log(`  error p50               : ${percentile(msErrors, 50).toFixed(0)} bps`);
            console.log(`  error p95               : ${percentile(msErrors, 95).toFixed(0)} bps`);
            console.log(`  error max               : ${Math.max(...msErrors).toFixed(0)} bps`);
        }
        console.log('');

        // Show worst multi-swap TXs
        const worstMultiSwap = multiSwapResults
            .filter(r => !r.allPassed)
            .sort((a, b) => b.maxErrorBps - a.maxErrorBps)
            .slice(0, 5);

        if (worstMultiSwap.length > 0) {
            console.log('Worst multi-swap TXs:');
            for (const r of worstMultiSwap) {
                console.log(`  sig=${r.signature.slice(0, 32)}... legs=${r.legCount} evaluated=${r.legsEvaluated} maxErr=${r.maxErrorBps}bps`);
            }
            console.log('');
        }
    }

    const report = {
        meta: {
            sessionId,
            swapDb: resolveDbPath(swapPath),
            cacheDb: resolveDbPath(cachePath),
            venue: opts.venue,
            limit: opts.limit,
            toleranceBps: opts.toleranceBps,
            venueSwapswapFeeBps: opts.feeBps,
            dynamicFeesEnabled: opts.dynamicFees,
        },
        dynamicFeeStats: opts.dynamicFees ? {
            supplyFetched: dynamicFeeSupplyFetched,
            supplyMissing: dynamicFeeSupplyMissing,
            uniqueMintsCached: mintSupplyCache.size,
            feeDistribution: Object.fromEntries([...feeDistribution.entries()]),
            marketCapStats: marketCapDistribution.length > 0 ? {
                count: marketCapDistribution.length,
                p50Lamports: marketCapDistribution.sort((a, b) => Number(a - b))[Math.floor(marketCapDistribution.length * 0.5)]?.toString(),
                p95Lamports: marketCapDistribution[Math.floor(marketCapDistribution.length * 0.95)]?.toString(),
                maxLamports: marketCapDistribution[marketCapDistribution.length - 1]?.toString(),
            } : null,
        } : null,
        venueSwapswap: {
            evaluated,
            skipped: {
                multiSwap: skippedMultiSwap,
                dust: skippedDust,
                weirdFlow: skippedWeirdFlow,
                bondingCurve: skippedBondingCurve,
                complexTx: skippedComplexTx,
                missingTopo: skippedMissingTopo,
                missingBalances: skippedMissingVaultBalances,
            },
            sanity: {
                derivedAtoB,
                derivedBtoA,
                parsedDirMatches,
                parsedDirMismatches,
                derivedTotal,
                dirAgreePct,
                parsedOutMatches,
                outTotal,
                outAgreePct,
                outP50,
                outP95,
            },
            modelSummaries: summaries,
            bestModel: best.model,
            worstSamples: worst,
            poolStats: {
                totalPools: poolStats.size,
                worstPools: worstPools.map(p => ({ pool: p.pool, pass: p.pass, fail: p.fail, total: p.total, passRate: p.passRate })),
                bestPools: bestPools.map(p => ({ pool: p.pool, pass: p.pass, fail: p.fail, total: p.total, passRate: p.passRate })),
            },
        },
        multiSwap: opts.multiSwap ? {
            txsEvaluated: multiSwapResults.length,
            txsPassed: multiSwapResults.filter(r => r.allPassed).length,
            passRate: multiSwapResults.length > 0
                ? multiSwapResults.filter(r => r.allPassed).length / multiSwapResults.length
                : 0,
            worstTxs: multiSwapResults
                .filter(r => !r.allPassed)
                .sort((a, b) => b.maxErrorBps - a.maxErrorBps)
                .slice(0, 10)
                .map(r => ({ signature: r.signature, legs: r.legCount, maxErr: r.maxErrorBps })),
        } : null,
        extractedCounts: Object.fromEntries([...counts.entries()]),
        notes: [
            'This report uses tx pre/post token balances as the ground-truth reserve snapshot for vaults.',
            'That avoids ambiguity about intra-slot state and is the fastest path to lock fee/reserve semantics.',
            'Next step after locking the model: align src/sim/math/constantProduct.ts fee placement + reserve update semantics.',
        ],
    };

    if (opts.out) {
        const outPath = path.isAbsolute(opts.out) ? opts.out : path.resolve(process.cwd(), opts.out);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
        console.log(`Wrote report: ${outPath}`);
    }

    if (cacheDb !== swapDb) cacheDb.close();
    swapDb.close();
}

main().catch((err) => {
    console.error('Error:', err);
    process.exit(1);
});
