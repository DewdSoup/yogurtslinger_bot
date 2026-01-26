#!/usr/bin/env tsx

/**
 * Sandwich Simulation Validation
 *
 * Tests sequential swap simulation against actual 2-leg sandwich transactions
 * from the evidence database.
 *
 * Usage:
 *   pnpm exec tsx scripts/validate-sandwich.ts --db data/evidence/capture.db --limit 100
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
    simulateSandwich,
    simulateSwapStep,
    getReservesAfterSwap,
    type PoolReserves,
    type SandwichSimResult,
} from '../src/sim/sequentialSwap.js';
import { SwapDirection } from '../src/types.js';

// ============================================================================
// TYPES
// ============================================================================

interface CliOpts {
    db: string;
    limit: number;
    toleranceBps: number;
    out?: string;
    help: boolean;
}

interface SandwichTxRow {
    signature: string;
    slot: number;
    pool_pubkey: string;
    leg1_direction: number;
    leg1_input: string;
    leg1_output: string;
    leg2_direction: number;
    leg2_input: string;
    leg2_output: string;
    pre_base_reserve: string;
    pre_quote_reserve: string;
    post_base_reserve: string;
    post_quote_reserve: string;
}

interface ValidationResult {
    signature: string;
    pool: string;
    simulated: {
        leg1Output: bigint;
        leg2Output: bigint;
        midReserves: PoolReserves;
    };
    actual: {
        leg1Output: bigint;
        leg2Output: bigint;
    };
    errors: {
        leg1Bps: number;
        leg2Bps: number;
    };
    pass: boolean;
}

// ============================================================================
// CLI
// ============================================================================

function usage(): string {
    return `
validate-sandwich - Validate sequential swap simulation against actual sandwiches

Usage:
  pnpm exec tsx scripts/validate-sandwich.ts --db data/evidence/capture.db --limit 100

Options:
  --db <path>            Evidence DB path (default: data/evidence/capture.db)
  --limit <n>            Max sandwiches to validate (default: 100)
  --tolerance-bps <n>    Pass threshold in bps (default: 10)
  --out <path>           Write JSON report to this path
  -h, --help             Show help
`.trim();
}

function parseArgs(argv: string[]): CliOpts {
    const out: CliOpts = {
        db: 'data/evidence/capture.db',
        limit: 100,
        toleranceBps: 10,
        out: undefined,
        help: false,
    };

    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--db') out.db = String(argv[++i] ?? '');
        else if (a === '--limit') out.limit = Number(argv[++i] ?? '');
        else if (a === '--tolerance-bps') out.toleranceBps = Number(argv[++i] ?? '');
        else if (a === '--out') out.out = String(argv[++i] ?? '');
        else if (a === '-h' || a === '--help') out.help = true;
    }

    return out;
}

// ============================================================================
// DATABASE QUERIES
// ============================================================================

function getLatestSessionId(db: Database.Database): string | undefined {
    const row = db
        .prepare(
            `SELECT session_id as sessionId FROM parsed_swaps
             GROUP BY session_id ORDER BY MAX(confirm_ts) DESC LIMIT 1`
        )
        .get() as { sessionId?: string } | undefined;
    return row?.sessionId;
}

/**
 * Get 2-leg sandwich transactions with pre/post reserves
 * These are same-pool, same-signature txs with opposite directions
 */
function getSandwichTransactions(
    db: Database.Database,
    sessionId: string,
    limit: number
): SandwichTxRow[] {
    // Optimized query - direct join without CTEs for better performance
    const sql = `
    SELECT
        p1.signature,
        p1.slot,
        p1.pool_pubkey,
        p1.direction as leg1_direction,
        p1.input_amount as leg1_input,
        p1.actual_output_amount as leg1_output,
        p2.direction as leg2_direction,
        p2.input_amount as leg2_input,
        p2.actual_output_amount as leg2_output
    FROM parsed_swaps p1
    JOIN parsed_swaps p2
        ON p1.signature = p2.signature
        AND p1.pool_pubkey = p2.pool_pubkey
        AND p1.id < p2.id
    WHERE p1.session_id = ?
      AND p1.venue = 'pumpswap'
      AND p2.venue = 'pumpswap'
      AND p1.direction != p2.direction
      AND p1.actual_output_amount IS NOT NULL
      AND p1.actual_output_amount != ''
      AND p2.actual_output_amount IS NOT NULL
      AND p2.actual_output_amount != ''
    ORDER BY p1.slot DESC
    LIMIT ?;
    `;

    const stmt = db.prepare(sql);
    return stmt.all(sessionId, limit) as SandwichTxRow[];
}

/**
 * Get pre/post vault balances for a transaction
 */
function getVaultBalances(
    db: Database.Database,
    signature: string,
    poolPubkey: string
): { basePre: bigint; quotePre: bigint; basePost: bigint; quotePost: bigint } | null {
    // Get the topology for vault addresses
    const topoRow = db.prepare(`
        SELECT vault_base, vault_quote
        FROM frozen_topologies
        WHERE pool_pubkey = ?
        LIMIT 1
    `).get(poolPubkey) as { vault_base: string; vault_quote: string } | undefined;

    if (!topoRow) return null;

    // Get tx meta with balances
    const txRow = db.prepare(`
        SELECT pre_balances_json, post_balances_json, accounts_json
        FROM mainnet_txs
        WHERE signature = ?
        LIMIT 1
    `).get(signature) as { pre_balances_json: string; post_balances_json: string; accounts_json: string } | undefined;

    if (!txRow) return null;

    try {
        const preBalances = JSON.parse(txRow.pre_balances_json) as Array<{
            account_index: number;
            ui_token_amount: { amount: string };
        }>;
        const postBalances = JSON.parse(txRow.post_balances_json) as Array<{
            account_index: number;
            ui_token_amount: { amount: string };
        }>;
        const accounts = JSON.parse(txRow.accounts_json) as string[];

        // Find vault indices
        const baseIdx = accounts.findIndex(a => a.toLowerCase() === topoRow.vault_base.toLowerCase());
        const quoteIdx = accounts.findIndex(a => a.toLowerCase() === topoRow.vault_quote.toLowerCase());

        if (baseIdx === -1 || quoteIdx === -1) return null;

        const basePre = BigInt(preBalances.find(b => b.account_index === baseIdx)?.ui_token_amount?.amount ?? '0');
        const quotePre = BigInt(preBalances.find(b => b.account_index === quoteIdx)?.ui_token_amount?.amount ?? '0');
        const basePost = BigInt(postBalances.find(b => b.account_index === baseIdx)?.ui_token_amount?.amount ?? '0');
        const quotePost = BigInt(postBalances.find(b => b.account_index === quoteIdx)?.ui_token_amount?.amount ?? '0');

        return { basePre, quotePre, basePost, quotePost };
    } catch {
        return null;
    }
}

// ============================================================================
// VALIDATION LOGIC
// ============================================================================

function validateSandwichTx(
    row: SandwichTxRow,
    reserves: { basePre: bigint; quotePre: bigint; basePost: bigint; quotePost: bigint },
    toleranceBps: number
): ValidationResult {
    const { basePre, quotePre } = reserves;

    // Dynamic fee detection: calculate implied fee from leg1
    const leg1Input = BigInt(row.leg1_input);
    const leg1ActualOutput = BigInt(row.leg1_output);
    const leg2Input = BigInt(row.leg2_input);
    const leg2ActualOutput = BigInt(row.leg2_output);

    // Use 30bps as default (most common PumpSwap fee)
    const feeBps = 30n;

    // Simulate leg 1
    const initialReserves: PoolReserves = {
        baseReserve: basePre,
        quoteReserve: quotePre,
    };

    const leg1Result = simulateSwapStep(
        initialReserves,
        row.leg1_direction as SwapDirection,
        leg1Input,
        feeBps
    );

    const midReserves = getReservesAfterSwap(leg1Result, row.leg1_direction as SwapDirection);

    // Simulate leg 2 with updated reserves
    const leg2Result = simulateSwapStep(
        midReserves,
        row.leg2_direction as SwapDirection,
        leg2Input,
        feeBps
    );

    // Calculate errors
    const leg1Err = leg1ActualOutput > 0n
        ? Number(((leg1Result.outputAmount - leg1ActualOutput) * 10000n) / leg1ActualOutput)
        : 0;
    const leg2Err = leg2ActualOutput > 0n
        ? Number(((leg2Result.outputAmount - leg2ActualOutput) * 10000n) / leg2ActualOutput)
        : 0;

    const pass = Math.abs(leg1Err) <= toleranceBps && Math.abs(leg2Err) <= toleranceBps;

    return {
        signature: row.signature,
        pool: row.pool_pubkey,
        simulated: {
            leg1Output: leg1Result.outputAmount,
            leg2Output: leg2Result.outputAmount,
            midReserves,
        },
        actual: {
            leg1Output: leg1ActualOutput,
            leg2Output: leg2ActualOutput,
        },
        errors: {
            leg1Bps: Math.abs(leg1Err),
            leg2Bps: Math.abs(leg2Err),
        },
        pass,
    };
}

// ============================================================================
// MAIN
// ============================================================================

function main(): void {
    const opts = parseArgs(process.argv);
    if (opts.help) {
        console.log(usage());
        process.exit(0);
    }

    const dbPath = path.isAbsolute(opts.db) ? opts.db : path.resolve(process.cwd(), opts.db);
    if (!fs.existsSync(dbPath)) {
        console.error(`DB not found: ${dbPath}`);
        process.exit(1);
    }

    const db = new Database(dbPath, { readonly: true });

    const sessionId = getLatestSessionId(db);
    if (!sessionId) {
        console.error('No session found in database');
        process.exit(1);
    }

    console.log('Sandwich Simulation Validation');
    console.log(`  session: ${sessionId}`);
    console.log(`  db: ${dbPath}`);
    console.log(`  limit: ${opts.limit}`);
    console.log(`  tolerance: ${opts.toleranceBps} bps`);
    console.log('');

    // Get sandwich transactions
    console.log('Fetching 2-leg sandwich transactions...');
    const sandwiches = getSandwichTransactions(db, sessionId, opts.limit);
    console.log(`Found ${sandwiches.length} sandwiches to validate`);
    console.log('');

    if (sandwiches.length === 0) {
        console.log('No sandwiches found. Try increasing --limit or check the data.');
        process.exit(0);
    }

    // Validate each sandwich
    const results: ValidationResult[] = [];
    let passed = 0;
    let skipped = 0;

    for (const sandwich of sandwiches) {
        const reserves = getVaultBalances(db, sandwich.signature, sandwich.pool_pubkey);
        if (!reserves) {
            skipped++;
            continue;
        }

        const result = validateSandwichTx(sandwich, reserves, opts.toleranceBps);
        results.push(result);

        if (result.pass) passed++;
    }

    // Print summary
    const evaluated = results.length;
    const passRate = evaluated > 0 ? (100 * passed / evaluated).toFixed(2) : '0.00';

    console.log('Validation Results:');
    console.log(`  Evaluated: ${evaluated}`);
    console.log(`  Skipped (missing data): ${skipped}`);
    console.log(`  Passed: ${passed}`);
    console.log(`  Failed: ${evaluated - passed}`);
    console.log(`  Pass Rate: ${passRate}%`);
    console.log('');

    // Error distribution
    const leg1Errors = results.map(r => r.errors.leg1Bps).sort((a, b) => a - b);
    const leg2Errors = results.map(r => r.errors.leg2Bps).sort((a, b) => a - b);

    if (leg1Errors.length > 0) {
        console.log('Error Distribution (bps):');
        console.log(`  Leg1 - p50: ${leg1Errors[Math.floor(leg1Errors.length * 0.5)]} p95: ${leg1Errors[Math.floor(leg1Errors.length * 0.95)]} max: ${leg1Errors[leg1Errors.length - 1]}`);
        console.log(`  Leg2 - p50: ${leg2Errors[Math.floor(leg2Errors.length * 0.5)]} p95: ${leg2Errors[Math.floor(leg2Errors.length * 0.95)]} max: ${leg2Errors[leg2Errors.length - 1]}`);
    }

    // Show worst samples
    const worst = results
        .filter(r => !r.pass)
        .sort((a, b) => Math.max(b.errors.leg1Bps, b.errors.leg2Bps) - Math.max(a.errors.leg1Bps, a.errors.leg2Bps))
        .slice(0, 5);

    if (worst.length > 0) {
        console.log('');
        console.log('Worst Samples:');
        for (const w of worst) {
            console.log(`  sig=${w.signature.slice(0, 16)}... leg1Err=${w.errors.leg1Bps}bps leg2Err=${w.errors.leg2Bps}bps`);
        }
    }

    // Write report if requested
    if (opts.out) {
        const report = {
            meta: {
                sessionId,
                db: dbPath,
                limit: opts.limit,
                toleranceBps: opts.toleranceBps,
            },
            summary: {
                evaluated,
                skipped,
                passed,
                failed: evaluated - passed,
                passRate: Number(passRate),
            },
            errorDistribution: {
                leg1: {
                    p50: leg1Errors[Math.floor(leg1Errors.length * 0.5)] ?? 0,
                    p95: leg1Errors[Math.floor(leg1Errors.length * 0.95)] ?? 0,
                    max: leg1Errors[leg1Errors.length - 1] ?? 0,
                },
                leg2: {
                    p50: leg2Errors[Math.floor(leg2Errors.length * 0.5)] ?? 0,
                    p95: leg2Errors[Math.floor(leg2Errors.length * 0.95)] ?? 0,
                    max: leg2Errors[leg2Errors.length - 1] ?? 0,
                },
            },
            worstSamples: worst.map(w => ({
                signature: w.signature,
                pool: w.pool,
                leg1Err: w.errors.leg1Bps,
                leg2Err: w.errors.leg2Bps,
            })),
        };

        const outPath = path.isAbsolute(opts.out) ? opts.out : path.resolve(process.cwd(), opts.out);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
        console.log('');
        console.log(`Wrote report: ${outPath}`);
    }
}

main();
