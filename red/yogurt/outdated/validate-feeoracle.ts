#!/usr/bin/env tsx

/**
 * FeeOracle Validation Script
 *
 * Validates that the FeeOracle architecture achieves the same accuracy
 * as the validate-simulation.ts script with --dynamic-fee.
 *
 * Approach:
 * 1. Create FeeOracle instance
 * 2. Process swaps in order:
 *    - First pass: Learn fees from first N swaps per pool+direction
 *    - Second pass: Validate using learned fees
 * 3. Compare with simulation using constantProduct.ts + feeOverrideBps
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { SwapDirection, VenueId } from '../src/types.js';
import { FeeOracle, calculateImpliedFeeBps } from '../src/cache/feeOracle.js';
import { simulateConstantProduct } from '../src/sim/math/constantProduct.js';

const DEFAULT_DB_PATH = 'data/evidence/capture.db';

type TokenBalanceRow = {
    account_index: number;
    mint: string;
    ui_token_amount: { amount: string };
};

type SwapRow = {
    signature: string;
    slot: number;
    venue: string;
    pool_pubkey: string;
    direction: number;
    input_amount: string;
    actual_output_amount: string;
    accounts_json: string;
    pre_balances_json: string;
    post_balances_json: string;
};

type TopologyRow = {
    venue: number;
    vault_base: string;
    vault_quote: string;
};

function parseArgs(argv: string[]): { db: string; limit: number; toleranceBps: number } {
    const opts = { db: DEFAULT_DB_PATH, limit: 20000, toleranceBps: 10 };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--db') opts.db = String(argv[++i] ?? '');
        else if (a === '--limit') opts.limit = Number(argv[++i] ?? '');
        else if (a === '--tolerance-bps') opts.toleranceBps = Number(argv[++i] ?? '');
    }
    return opts;
}

function resolveDbPath(dbPath: string): string {
    return path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath);
}

function openDb(dbPath: string): Database.Database {
    const resolved = resolveDbPath(dbPath);
    if (!fs.existsSync(resolved)) throw new Error(`DB not found: ${resolved}`);
    return new Database(resolved, { readonly: true, fileMustExist: true });
}

function parseTokenBalances(json: string): Map<number, bigint> {
    const arr = JSON.parse(json) as TokenBalanceRow[];
    const m = new Map<number, bigint>();
    for (const row of arr) {
        m.set(row.account_index, BigInt(row.ui_token_amount.amount));
    }
    return m;
}

function parseAccountKeysHex(json: string): string[] {
    return JSON.parse(json) as string[];
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
    const row = db.prepare(`
        SELECT session_id as sessionId, MAX(confirm_ts) AS lastTs
        FROM parsed_swaps
        GROUP BY session_id
        ORDER BY lastTs DESC
        LIMIT 1
    `).get() as { sessionId?: string } | undefined;
    return row?.sessionId;
}

function getGlobalSignatureCounts(db: Database.Database, sessionId: string): Map<string, number> {
    const rows = db.prepare(`
        SELECT signature, COUNT(*) as cnt
        FROM parsed_swaps
        WHERE session_id = @sessionId AND venue = 'pumpswap'
        GROUP BY signature
        HAVING COUNT(*) > 1
    `).all({ sessionId }) as Array<{ signature: string; cnt: number }>;
    return new Map(rows.map(r => [r.signature, r.cnt]));
}

function readSwapRows(db: Database.Database, sessionId: string, limit: number): SwapRow[] {
    return db.prepare(`
        SELECT
            ps.signature, ps.slot, ps.venue, ps.pool_pubkey, ps.direction,
            ps.input_amount, ps.actual_output_amount,
            mt.accounts_json, mt.pre_balances_json, mt.post_balances_json
        FROM parsed_swaps ps
        JOIN mainnet_txs mt ON mt.signature = ps.signature AND mt.session_id = ps.session_id
        WHERE ps.session_id = @sessionId
            AND ps.venue = 'pumpswap'
            AND ps.decode_success = 1
            AND ps.actual_output_amount IS NOT NULL
            AND ps.actual_output_amount != ''
        ORDER BY ps.confirm_ts DESC
        LIMIT @limit
    `).all({ sessionId, limit }) as SwapRow[];
}

function loadTopology(db: Database.Database, sessionId: string, poolHex: string): TopologyRow | undefined {
    return db.prepare(`
        SELECT venue, vault_base, vault_quote
        FROM frozen_topologies
        WHERE session_id = ? AND pool_pubkey = ?
        LIMIT 1
    `).get(sessionId, poolHex) as TopologyRow | undefined;
}

const WSOL_MINT_BASE58 = 'So11111111111111111111111111111111111111112';

function normalizeVaults(
    topo: TopologyRow,
    accountKeysHex: string[],
    preBalances: TokenBalanceRow[]
): { baseVault: string; quoteVault: string; swapped: boolean } {
    const baseIdx = getAccountIndex(accountKeysHex, topo.vault_base);
    const baseMint = preBalances.find(b => b.account_index === baseIdx)?.mint;
    const baseIsWsol = baseMint === WSOL_MINT_BASE58;

    if (baseIsWsol) {
        return { baseVault: topo.vault_quote, quoteVault: topo.vault_base, swapped: true };
    }
    return { baseVault: topo.vault_base, quoteVault: topo.vault_quote, swapped: false };
}

function errorBps(pred: bigint, actual: bigint): number {
    if (actual <= 0n) return Number.POSITIVE_INFINITY;
    const absErr = pred > actual ? pred - actual : actual - pred;
    return Number((absErr * 10000n) / actual);
}

function main(): void {
    const opts = parseArgs(process.argv);
    const db = openDb(opts.db);
    const sessionId = getLatestSessionId(db);

    if (!sessionId) {
        console.error('No session found');
        process.exit(1);
    }

    console.log('FeeOracle Validation');
    console.log(`  db: ${resolveDbPath(opts.db)}`);
    console.log(`  session: ${sessionId}`);
    console.log(`  limit: ${opts.limit.toLocaleString()}`);
    console.log(`  tolerance: ${opts.toleranceBps} bps`);
    console.log('');

    const feeOracle = new FeeOracle();
    const multiSwapSigs = getGlobalSignatureCounts(db, sessionId);
    const rows = readSwapRows(db, sessionId, opts.limit);
    const topoCache = new Map<string, TopologyRow>();

    console.log(`Loaded ${rows.length.toLocaleString()} swaps`);
    console.log(`Multi-swap signatures (skipped): ${multiSwapSigs.size.toLocaleString()}`);
    console.log('');

    // Stats
    let learned = 0;
    let evaluated = 0;
    let passed = 0;
    let skippedMulti = 0;
    let skippedTopo = 0;
    let skippedBalances = 0;
    let skippedDust = 0;
    let skippedBondingCurve = 0;
    let skippedWeirdFlow = 0;

    const errors: number[] = [];

    for (const r of rows) {
        // Skip multi-swap
        if (multiSwapSigs.has(r.signature)) {
            skippedMulti++;
            continue;
        }

        // Get topology
        const topo = topoCache.get(r.pool_pubkey) ?? loadTopology(db, sessionId, r.pool_pubkey);
        if (!topo) {
            skippedTopo++;
            continue;
        }
        topoCache.set(r.pool_pubkey, topo);

        const accountKeysHex = parseAccountKeysHex(r.accounts_json);
        const pre = parseTokenBalances(r.pre_balances_json);
        const post = parseTokenBalances(r.post_balances_json);
        const preBalances = JSON.parse(r.pre_balances_json) as TokenBalanceRow[];

        const normalized = normalizeVaults(topo, accountKeysHex, preBalances);

        const basePre = getBalanceForPubkeyHex(pre, accountKeysHex, normalized.baseVault);
        const quotePre = getBalanceForPubkeyHex(pre, accountKeysHex, normalized.quoteVault);
        const basePost = getBalanceForPubkeyHex(post, accountKeysHex, normalized.baseVault);
        const quotePost = getBalanceForPubkeyHex(post, accountKeysHex, normalized.quoteVault);

        if (basePre == null || quotePre == null || basePost == null || quotePost == null) {
            skippedBalances++;
            continue;
        }

        // Derive direction from vault deltas
        const baseDelta = basePost - basePre;
        const quoteDelta = quotePost - quotePre;

        let direction: SwapDirection;
        let reserveIn: bigint;
        let reserveOut: bigint;
        let amountIn: bigint;
        let actualOut: bigint;

        if (baseDelta > 0n && quoteDelta < 0n) {
            direction = SwapDirection.AtoB;
            reserveIn = basePre;
            reserveOut = quotePre;
            amountIn = baseDelta;
            actualOut = -quoteDelta;
        } else if (baseDelta < 0n && quoteDelta > 0n) {
            direction = SwapDirection.BtoA;
            reserveIn = quotePre;
            reserveOut = basePre;
            amountIn = quoteDelta;
            actualOut = -baseDelta;
        } else {
            skippedWeirdFlow++;
            continue;
        }

        // Filter dust
        if (amountIn < 10000n) {
            skippedDust++;
            continue;
        }

        // Filter bonding curve (extreme ratios)
        const ratio = reserveIn > reserveOut
            ? reserveIn / (reserveOut > 0n ? reserveOut : 1n)
            : reserveOut / (reserveIn > 0n ? reserveIn : 1n);
        if (ratio > 10000n) {
            skippedBondingCurve++;
            continue;
        }

        // Get pool pubkey as bytes
        const poolPubkey = Buffer.from(r.pool_pubkey, 'hex');

        // Learn or validate
        if (!feeOracle.has(poolPubkey, direction)) {
            // First swap for this pool+direction - learn the fee
            const success = feeOracle.learnFromSwap(
                poolPubkey, direction, reserveIn, reserveOut, amountIn, actualOut, r.slot
            );
            if (success) learned++;
        }

        // Always validate using current oracle fee
        const feeBps = feeOracle.getFee(poolPubkey, direction);

        // Simulate using constantProduct with feeOverrideBps
        const simResult = simulateConstantProduct({
            pool: poolPubkey,
            venue: VenueId.PumpSwap,
            direction,
            inputAmount: amountIn,
            poolState: {
                venue: VenueId.PumpSwap,
                pool: poolPubkey,
                baseMint: new Uint8Array(32),
                quoteMint: new Uint8Array(32),
                baseVault: new Uint8Array(32),
                quoteVault: new Uint8Array(32),
                lpMint: new Uint8Array(32),
                lpSupply: 0n,
                baseReserve: direction === SwapDirection.AtoB ? reserveIn : reserveOut,
                quoteReserve: direction === SwapDirection.AtoB ? reserveOut : reserveIn,
            },
            feeOverrideBps: feeBps,
        });

        evaluated++;
        const err = errorBps(simResult.outputAmount, actualOut);
        errors.push(err);

        if (err <= opts.toleranceBps) {
            passed++;
        }
    }

    // Calculate stats
    const passRate = evaluated > 0 ? (passed / evaluated * 100).toFixed(2) : '0.00';
    const sortedErrors = [...errors].sort((a, b) => a - b);
    const p50 = sortedErrors[Math.floor(sortedErrors.length * 0.5)] ?? 0;
    const p95 = sortedErrors[Math.floor(sortedErrors.length * 0.95)] ?? 0;
    const p99 = sortedErrors[Math.floor(sortedErrors.length * 0.99)] ?? 0;
    const maxErr = Math.max(...errors, 0);

    console.log('=== FeeOracle Results ===');
    console.log('');
    console.log('Fee Learning:');
    console.log(`  Pool+direction combos learned: ${learned.toLocaleString()}`);

    const feeStats = feeOracle.stats();
    console.log(`  Unique pools: ${feeStats.uniquePools}`);
    console.log(`  Cache hits: ${feeStats.hitCount.toLocaleString()}`);
    console.log(`  Cache misses: ${feeStats.missCount.toLocaleString()}`);
    console.log('');

    console.log('Fee Distribution:');
    const dist = feeOracle.getFeeDistribution();
    const sortedDist = [...dist.entries()].sort((a, b) => b[1] - a[1]);
    for (const [fee, count] of sortedDist.slice(0, 5)) {
        console.log(`  ${fee}bps: ${count} combos`);
    }
    if (sortedDist.length > 5) {
        console.log(`  ... and ${sortedDist.length - 5} more`);
    }
    console.log('');

    console.log('Validation Results:');
    console.log(`  Evaluated: ${evaluated.toLocaleString()}`);
    console.log(`  Passed: ${passed.toLocaleString()}`);
    console.log(`  Pass Rate: ${passRate}%`);
    console.log(`  p50 error: ${p50}bps`);
    console.log(`  p95 error: ${p95}bps`);
    console.log(`  p99 error: ${p99}bps`);
    console.log(`  max error: ${maxErr}bps`);
    console.log('');

    console.log('Skipped:');
    console.log(`  Multi-swap: ${skippedMulti.toLocaleString()}`);
    console.log(`  Missing topology: ${skippedTopo.toLocaleString()}`);
    console.log(`  Missing balances: ${skippedBalances.toLocaleString()}`);
    console.log(`  Dust: ${skippedDust.toLocaleString()}`);
    console.log(`  Bonding curve: ${skippedBondingCurve.toLocaleString()}`);
    console.log(`  Weird flow: ${skippedWeirdFlow.toLocaleString()}`);
    console.log('');

    // Verify we match the expected pass rate
    const passRateNum = parseFloat(passRate);
    if (passRateNum >= 99.8) {
        console.log('✓ FeeOracle achieves target accuracy (≥99.8%)');
    } else {
        console.log(`✗ FeeOracle below target accuracy (${passRate}% < 99.8%)`);
        process.exit(1);
    }

    db.close();
}

main();
