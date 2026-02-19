#!/usr/bin/env tsx

/**
 * DLMM Layer 2 proving pass (capture.db-backed).
 *
 * Goals:
 * - Validate topology/cache completeness for Meteora DLMM swaps.
 * - Run local DLMM simulation when pre-state is complete.
 * - Compare predicted output vs on-chain vault delta output.
 *
 * Scope:
 * - Read-only analysis over evidence DB.
 * - No runtime/hot-path coupling.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';
import { decodeMeteoraDlmmPool, isBinArrayInitialized } from '../src/decode/programs/meteoraDlmm.js';
import { decodeBinArray, BINS_PER_ARRAY } from '../src/decode/programs/binArray.js';
import { simulateDlmm } from '../src/sim/math/dlmm.js';
import { SwapDirection, VenueId, type BinArray, type MeteoraDlmmPool, type SimInput } from '../src/types.js';

const DEFAULT_DB_PATH = 'data/evidence/capture.db';

interface Args {
    db: string;
    session?: string;
    limit?: number;
    toleranceBps: number;
    out?: string;
    help: boolean;
}

interface SwapRow {
    slot: number;
    signature: string;
    poolPubkey: string;
    accountsJson: string;
    preBalancesJson: string;
    postBalancesJson: string;
}

interface TopologyRow {
    frozenAtSlot: number;
    vaultBase: string;
    vaultQuote: string;
    requiredBinArrays: number[];
}

interface BalanceRow {
    account_index: number;
    ui_token_amount?: { amount?: string };
}

interface Flow {
    direction: SwapDirection;
    inputAmount: bigint;
    actualOutput: bigint;
    basePre: bigint;
    quotePre: bigint;
}

function usage(): string {
    return `
prove-dlmm-l2

Usage:
  pnpm exec tsx scripts/prove-dlmm-l2.ts [options]

Options:
  --db <path>             Evidence DB path (default: ${DEFAULT_DB_PATH})
  --session <id>          Capture session id (default: latest with meteoraDlmm swaps)
  --limit <n>             Max swaps to process (default: all)
  --tolerance-bps <n>     Pass threshold for sim error (default: 100)
  --out <path>            JSON report output path (default: data/evidence/prove-dlmm-l2-<session>.json)
  --help                  Show this help
`.trim();
}

function parseArgs(argv: string[]): Args {
    const out: Args = {
        db: DEFAULT_DB_PATH,
        toleranceBps: 100,
        help: false,
    };

    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') out.help = true;
        else if (a === '--db') out.db = String(argv[++i] ?? out.db);
        else if (a === '--session') out.session = String(argv[++i] ?? '');
        else if (a === '--limit') out.limit = Number(argv[++i] ?? '');
        else if (a === '--tolerance-bps') out.toleranceBps = Number(argv[++i] ?? out.toleranceBps);
        else if (a === '--out') out.out = String(argv[++i] ?? '');
    }

    return out;
}

function toBytes(hex: string): Uint8Array {
    return new Uint8Array(Buffer.from(hex, 'hex'));
}

function parseBalances(json: string): Map<number, bigint> {
    const rows = JSON.parse(json) as BalanceRow[];
    const out = new Map<number, bigint>();
    for (const r of rows) {
        if (typeof r.account_index !== 'number') continue;
        const amount = r.ui_token_amount?.amount;
        if (!amount) continue;
        out.set(r.account_index, BigInt(amount));
    }
    return out;
}

function errorBps(pred: bigint, actual: bigint): number {
    if (actual <= 0n) return Number.POSITIVE_INFINITY;
    const diff = pred >= actual ? pred - actual : actual - pred;
    return Number((diff * 10000n) / actual);
}

function percentile(values: number[], p: number): number {
    if (values.length === 0) return NaN;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
    return sorted[idx]!;
}

function findTopology(rows: TopologyRow[] | undefined, slot: number): TopologyRow | null {
    if (!rows || rows.length === 0) return null;
    let best: TopologyRow | null = null;
    for (const r of rows) {
        if (r.frozenAtSlot <= slot) best = r;
        else break;
    }
    return best;
}

function deriveFlow(
    accountsJson: string,
    preBalancesJson: string,
    postBalancesJson: string,
    vaultBase: string,
    vaultQuote: string
): Flow | null {
    const accounts = JSON.parse(accountsJson) as string[];
    const baseIdx = accounts.indexOf(vaultBase);
    const quoteIdx = accounts.indexOf(vaultQuote);
    if (baseIdx < 0 || quoteIdx < 0) return null;

    const pre = parseBalances(preBalancesJson);
    const post = parseBalances(postBalancesJson);

    const basePre = pre.get(baseIdx);
    const quotePre = pre.get(quoteIdx);
    const basePost = post.get(baseIdx);
    const quotePost = post.get(quoteIdx);
    if (basePre === undefined || quotePre === undefined || basePost === undefined || quotePost === undefined) {
        return null;
    }

    const baseDelta = basePost - basePre;
    const quoteDelta = quotePost - quotePre;

    if (baseDelta > 0n && quoteDelta < 0n) {
        return {
            direction: SwapDirection.AtoB,
            inputAmount: baseDelta,
            actualOutput: -quoteDelta,
            basePre,
            quotePre,
        };
    }

    if (baseDelta < 0n && quoteDelta > 0n) {
        return {
            direction: SwapDirection.BtoA,
            inputAmount: quoteDelta,
            actualOutput: -baseDelta,
            basePre,
            quotePre,
        };
    }

    return null;
}

interface SlotDataRow {
    slot: number;
    data_b64: string;
}

interface BinTraceRow {
    pubkey: string;
    slot: number;
    source: string;
}

const ZERO_BINS = Array.from({ length: BINS_PER_ARRAY }, () => ({ amountX: 0n, amountY: 0n }));

function main(): void {
    const opts = parseArgs(process.argv);
    if (opts.help) {
        console.log(usage());
        process.exit(0);
    }

    const dbPath = path.isAbsolute(opts.db) ? opts.db : path.resolve(process.cwd(), opts.db);
    const db = new Database(dbPath, { readonly: true });

    const sessionId = opts.session || (db.prepare(`
        SELECT session_id
        FROM parsed_swaps
        WHERE venue = 'meteoraDlmm'
        GROUP BY session_id
        ORDER BY MAX(confirm_ts) DESC
        LIMIT 1
    `).get() as { session_id?: string } | undefined)?.session_id;

    if (!sessionId) {
        throw new Error('No session with meteoraDlmm swaps found.');
    }

    const swapSql = `
        SELECT
            ps.slot AS slot,
            ps.signature AS signature,
            ps.pool_pubkey AS poolPubkey,
            tx.accounts_json AS accountsJson,
            tx.pre_balances_json AS preBalancesJson,
            tx.post_balances_json AS postBalancesJson
        FROM parsed_swaps ps
        JOIN mainnet_txs tx
          ON tx.session_id = ps.session_id
         AND tx.signature = ps.signature
        WHERE ps.session_id = ?
          AND ps.venue = 'meteoraDlmm'
        ORDER BY ps.slot ASC, ps.confirm_ts ASC, ps.instruction_index ASC
        ${opts.limit && opts.limit > 0 ? `LIMIT ${Math.floor(opts.limit)}` : ''}
    `;
    const swaps = db.prepare(swapSql).all(sessionId) as SwapRow[];

    if (swaps.length === 0) {
        console.log('No DLMM swaps found for this session.');
        process.exit(0);
    }

    const topologyRows = db.prepare(`
        SELECT
            pool_pubkey AS poolPubkey,
            frozen_at_slot AS frozenAtSlot,
            vault_base AS vaultBase,
            vault_quote AS vaultQuote,
            required_bin_arrays AS requiredBinArrays
        FROM frozen_topologies
        WHERE session_id = ?
          AND venue = 3
        ORDER BY pool_pubkey ASC, frozen_at_slot ASC
    `).all(sessionId) as Array<{
        poolPubkey: string;
        frozenAtSlot: number;
        vaultBase: string;
        vaultQuote: string;
        requiredBinArrays: string | null;
    }>;

    const topologiesByPool = new Map<string, TopologyRow[]>();
    for (const r of topologyRows) {
        const required = r.requiredBinArrays ? JSON.parse(r.requiredBinArrays) as number[] : [];
        const row: TopologyRow = {
            frozenAtSlot: Number(r.frozenAtSlot),
            vaultBase: r.vaultBase,
            vaultQuote: r.vaultQuote,
            requiredBinArrays: required,
        };
        const list = topologiesByPool.get(r.poolPubkey) ?? [];
        list.push(row);
        topologiesByPool.set(r.poolPubkey, list);
    }

    const loadPoolStateStmt = db.prepare(`
        SELECT slot, data_b64
        FROM mainnet_updates
        WHERE session_id = ?
          AND pubkey = ?
        ORDER BY slot ASC, CAST(write_version AS INTEGER) ASC
    `);

    const loadBinTraceStmt = db.prepare(`
        SELECT pubkey, slot, source
        FROM cache_traces
        WHERE session_id = ?
          AND cache_type = 'bin'
          AND rejected = 0
          AND cache_key = ?
        ORDER BY slot ASC, CAST(write_version AS INTEGER) ASC
    `);

    const loadMainnetAccountStmt = db.prepare(`
        SELECT slot, data_b64
        FROM mainnet_updates
        WHERE session_id = ?
          AND pubkey = ?
        ORDER BY slot ASC, CAST(write_version AS INTEGER) ASC
    `);

    const loadBootstrapAccountStmt = db.prepare(`
        SELECT slot, data_b64
        FROM bootstrap_updates
        WHERE session_id = ?
          AND pubkey = ?
        ORDER BY slot ASC
    `);

    function findLatestBefore<T extends { slot: number }>(rows: T[], slotExclusive: number): T | null {
        let lo = 0;
        let hi = rows.length - 1;
        let best = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const row = rows[mid]!;
            if (row.slot < slotExclusive) {
                best = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return best >= 0 ? rows[best]! : null;
    }

    function findLatestAtOrBefore<T extends { slot: number }>(rows: T[], slotInclusive: number): T | null {
        let lo = 0;
        let hi = rows.length - 1;
        let best = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const row = rows[mid]!;
            if (row.slot <= slotInclusive) {
                best = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return best >= 0 ? rows[best]! : null;
    }

    const poolStatesByPool = new Map<string, SlotDataRow[]>();
    const bootstrapPoolStatesByPool = new Map<string, SlotDataRow[]>();
    const binTracesByKey = new Map<string, BinTraceRow[]>();
    const mainnetAccountByPubkey = new Map<string, SlotDataRow[]>();
    const bootstrapAccountByPubkey = new Map<string, SlotDataRow[]>();

    function getPoolStateBefore(poolPubkey: string, slot: number): SlotDataRow | null {
        let mainnetRows = poolStatesByPool.get(poolPubkey);
        if (!mainnetRows) {
            mainnetRows = loadPoolStateStmt.all(sessionId, poolPubkey) as SlotDataRow[];
            poolStatesByPool.set(poolPubkey, mainnetRows);
        }
        const mainnetRow = findLatestBefore(mainnetRows, slot);
        if (mainnetRow) return mainnetRow;

        // Fallback: bootstrap snapshot if no prior live update exists.
        let bootstrapRows = bootstrapPoolStatesByPool.get(poolPubkey);
        if (!bootstrapRows) {
            bootstrapRows = loadBootstrapAccountStmt.all(sessionId, poolPubkey) as SlotDataRow[];
            bootstrapPoolStatesByPool.set(poolPubkey, bootstrapRows);
        }
        return findLatestAtOrBefore(bootstrapRows, slot);
    }

    function getBinTraceBefore(cacheKey: string, slot: number): BinTraceRow | null {
        let rows = binTracesByKey.get(cacheKey);
        if (!rows) {
            rows = loadBinTraceStmt.all(sessionId, cacheKey) as BinTraceRow[];
            binTracesByKey.set(cacheKey, rows);
        }
        return findLatestBefore(rows, slot);
    }

    function getAccountDataAtOrBefore(pubkey: string, slot: number, source: string): string | null {
        if (source === 'bootstrap') {
            let rows = bootstrapAccountByPubkey.get(pubkey);
            if (!rows) {
                rows = loadBootstrapAccountStmt.all(sessionId, pubkey) as SlotDataRow[];
                bootstrapAccountByPubkey.set(pubkey, rows);
            }
            const row = findLatestAtOrBefore(rows, slot);
            return row?.data_b64 ?? null;
        }

        let rows = mainnetAccountByPubkey.get(pubkey);
        if (!rows) {
            rows = loadMainnetAccountStmt.all(sessionId, pubkey) as SlotDataRow[];
            mainnetAccountByPubkey.set(pubkey, rows);
        }
        const row = findLatestAtOrBefore(rows, slot);
        return row?.data_b64 ?? null;
    }

    let withTopology = 0;
    let withFlow = 0;
    let withPoolState = 0;
    let withBinArrays = 0;
    let simEvaluated = 0;
    let simSuccess = 0;
    let simPass = 0;

    let skippedNoTopology = 0;
    let skippedNoFlow = 0;
    let skippedNoPoolState = 0;
    let skippedMissingBins = 0;
    let skippedSimFailure = 0;
    let virtualBinsSynthesized = 0;
    let missingBinInitializedNoTrace = 0;
    let missingBinOutsideBitmapNoTrace = 0;
    let missingBinTraceNoAccountData = 0;
    let missingBinDecodeMismatch = 0;

    const simErrorsBps: number[] = [];
    const poolLagSlots: number[] = [];
    const minBinLagSlots: number[] = [];

    const worst: Array<{ signature: string; slot: number; errBps: number; pred: string; actual: string }> = [];

    for (const s of swaps) {
        const topology = findTopology(topologiesByPool.get(s.poolPubkey), s.slot);
        if (!topology) {
            skippedNoTopology++;
            continue;
        }
        withTopology++;

        const flow = deriveFlow(
            s.accountsJson,
            s.preBalancesJson,
            s.postBalancesJson,
            topology.vaultBase,
            topology.vaultQuote
        );
        if (!flow) {
            skippedNoFlow++;
            continue;
        }
        withFlow++;

        const poolStateRow = getPoolStateBefore(s.poolPubkey, s.slot);
        if (!poolStateRow) {
            skippedNoPoolState++;
            continue;
        }

        const poolState = decodeMeteoraDlmmPool(toBytes(s.poolPubkey), new Uint8Array(Buffer.from(poolStateRow.data_b64, 'base64')));
        if (!poolState) {
            skippedNoPoolState++;
            continue;
        }
        withPoolState++;
        poolLagSlots.push(Math.max(0, s.slot - Number(poolStateRow.slot)));

        const requiredIndexes = topology.requiredBinArrays.length > 0
            ? topology.requiredBinArrays
            : [Math.floor(poolState.activeId / 70)];

        const binArrays: BinArray[] = [];
        let missingAnyBin = false;
        let minBinSlot = Number.MAX_SAFE_INTEGER;

        for (const idx of requiredIndexes) {
            const cacheKey = `${s.poolPubkey}:${idx}`;
            const trace = getBinTraceBefore(cacheKey, s.slot);

            if (!trace) {
                // Runtime-equivalent behavior: non-initialized arrays are virtual zero-liquidity.
                if (idx >= -512 && idx <= 511 && !isBinArrayInitialized(poolState.binArrayBitmap, idx)) {
                    binArrays.push({
                        lbPair: poolState.pool,
                        index: BigInt(idx),
                        startBinId: idx * BINS_PER_ARRAY,
                        bins: ZERO_BINS,
                    });
                    virtualBinsSynthesized++;
                    continue;
                }
                if (idx < -512 || idx > 511) {
                    missingBinOutsideBitmapNoTrace++;
                } else {
                    missingBinInitializedNoTrace++;
                }
                missingAnyBin = true;
                break;
            }

            const accountData = getAccountDataAtOrBefore(trace.pubkey, trace.slot, trace.source);

            if (!accountData) {
                missingBinTraceNoAccountData++;
                missingAnyBin = true;
                break;
            }

            const decoded = decodeBinArray(new Uint8Array(Buffer.from(accountData, 'base64')));
            if (!decoded || Number(decoded.index) !== idx) {
                missingBinDecodeMismatch++;
                missingAnyBin = true;
                break;
            }

            binArrays.push(decoded);
            if (trace.slot < minBinSlot) minBinSlot = trace.slot;
        }

        if (missingAnyBin || binArrays.length === 0) {
            skippedMissingBins++;
            continue;
        }
        withBinArrays++;
        minBinLagSlots.push(Math.max(0, s.slot - minBinSlot));

        simEvaluated++;
        const simInput: SimInput = {
            pool: poolState.pool,
            venue: VenueId.MeteoraDlmm,
            direction: flow.direction,
            inputAmount: flow.inputAmount,
            poolState: poolState as MeteoraDlmmPool,
        };

        const sim = simulateDlmm(simInput, binArrays);
        if (!sim.success || sim.outputAmount <= 0n || flow.actualOutput <= 0n) {
            skippedSimFailure++;
            continue;
        }
        simSuccess++;

        const e = errorBps(sim.outputAmount, flow.actualOutput);
        simErrorsBps.push(e);
        if (e <= opts.toleranceBps) simPass++;

        if (worst.length < 10) {
            worst.push({
                signature: s.signature,
                slot: s.slot,
                errBps: e,
                pred: sim.outputAmount.toString(),
                actual: flow.actualOutput.toString(),
            });
        } else {
            let minErrIdx = 0;
            for (let i = 1; i < worst.length; i++) {
                if (worst[i]!.errBps < worst[minErrIdx]!.errBps) minErrIdx = i;
            }
            if (e > worst[minErrIdx]!.errBps) {
                worst[minErrIdx] = {
                    signature: s.signature,
                    slot: s.slot,
                    errBps: e,
                    pred: sim.outputAmount.toString(),
                    actual: flow.actualOutput.toString(),
                };
            }
        }
    }

    const report = {
        meta: {
            sessionId,
            dbPath,
            venue: 'meteoraDlmm',
            totalSwaps: swaps.length,
            toleranceBps: opts.toleranceBps,
        },
        pipeline: {
            withTopology,
            withFlow,
            withPoolState,
            withBinArrays,
            topologyCoveragePct: (withTopology / swaps.length) * 100,
            flowCoveragePct: (withFlow / swaps.length) * 100,
            poolStateCoveragePct: (withPoolState / swaps.length) * 100,
            binCoveragePct: (withBinArrays / swaps.length) * 100,
        },
        simulation: {
            evaluated: simEvaluated,
            success: simSuccess,
            pass: simPass,
            successPct: simEvaluated > 0 ? (simSuccess / simEvaluated) * 100 : 0,
            passPct: simSuccess > 0 ? (simPass / simSuccess) * 100 : 0,
            errP50Bps: percentile(simErrorsBps, 0.5),
            errP95Bps: percentile(simErrorsBps, 0.95),
            errMaxBps: simErrorsBps.length > 0 ? Math.max(...simErrorsBps) : NaN,
        },
        staleness: {
            poolLagP50Slots: percentile(poolLagSlots, 0.5),
            poolLagP95Slots: percentile(poolLagSlots, 0.95),
            binLagP50Slots: percentile(minBinLagSlots, 0.5),
            binLagP95Slots: percentile(minBinLagSlots, 0.95),
        },
        skipped: {
            noTopology: skippedNoTopology,
            noFlow: skippedNoFlow,
            noPoolState: skippedNoPoolState,
            missingBins: skippedMissingBins,
            simFailure: skippedSimFailure,
            missingBinReasons: {
                initializedNoTrace: missingBinInitializedNoTrace,
                outsideBitmapNoTrace: missingBinOutsideBitmapNoTrace,
                traceButNoAccountData: missingBinTraceNoAccountData,
                decodeMismatch: missingBinDecodeMismatch,
            },
            virtualBinsSynthesized,
        },
        worst: worst.sort((a, b) => b.errBps - a.errBps),
    };

    const outPath = opts.out
        ? (path.isAbsolute(opts.out) ? opts.out : path.resolve(process.cwd(), opts.out))
        : path.resolve(process.cwd(), `data/evidence/prove-dlmm-l2-${sessionId}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

    console.log('DLMM L2 proving report');
    console.log(`  session      : ${sessionId}`);
    console.log(`  swaps        : ${swaps.length}`);
    console.log(`  topology ok  : ${withTopology} (${((withTopology / swaps.length) * 100).toFixed(2)}%)`);
    console.log(`  flow ok      : ${withFlow} (${((withFlow / swaps.length) * 100).toFixed(2)}%)`);
    console.log(`  pool ok      : ${withPoolState} (${((withPoolState / swaps.length) * 100).toFixed(2)}%)`);
    console.log(`  bins ok      : ${withBinArrays} (${((withBinArrays / swaps.length) * 100).toFixed(2)}%)`);
    console.log(`  sim success  : ${simSuccess}/${simEvaluated} (${(simEvaluated > 0 ? (simSuccess / simEvaluated) * 100 : 0).toFixed(2)}%)`);
    console.log(`  sim pass     : ${simPass}/${simSuccess} (${(simSuccess > 0 ? (simPass / simSuccess) * 100 : 0).toFixed(2)}%) @ ${opts.toleranceBps}bps`);
    if (simErrorsBps.length > 0) {
        console.log(`  err p50/p95  : ${percentile(simErrorsBps, 0.5).toFixed(1)} / ${percentile(simErrorsBps, 0.95).toFixed(1)} bps`);
    }
    console.log(`  virtual bins : ${virtualBinsSynthesized}`);
    console.log(`  miss bins    : init_no_trace=${missingBinInitializedNoTrace} out_bitmap_no_trace=${missingBinOutsideBitmapNoTrace} trace_no_data=${missingBinTraceNoAccountData} decode_mismatch=${missingBinDecodeMismatch}`);
    console.log(`  report       : ${outPath}`);

    db.close();
}

main();
