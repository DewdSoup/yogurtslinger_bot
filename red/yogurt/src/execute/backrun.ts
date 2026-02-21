/**
 * Backrun Detection + Execution Engine
 *
 * Supports two strategy modes:
 * - legacy_cpmm_same_pool: historical same-pool CPMM round-trip
 * - cross_venue_ps_dlmm: PumpSwap ↔ Meteora DLMM cross-venue strategy
 *
 * All strategy decisions and simulations are local-cache only.
 */

import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { VersionedMessage } from '@solana/web3.js';
import type { Keypair } from '@solana/web3.js';
import type {
    IngestEvent,
    TxUpdate,
    SwapLeg,
    PumpSwapPool,
    RaydiumV4Pool,
    MeteoraDlmmPool,
    BundleConfig,
    PoolState,
    SimResult,
    SwapDirection,
} from '../types.js';
import { VenueId, SwapDirection as Dir } from '../types.js';
import {
    simulateConstantProduct,
    getAmountIn,
} from '../sim/math/constantProduct.js';
import { simulateDlmm } from '../sim/math/dlmm.js';
import { decodeTx, type AltCache as TxAltCache } from '../decode/tx.js';
import { extractSwapLegs } from '../decode/swap.js';
import { decodePumpSwapInstruction } from '../decode/programs/pumpswap.js';
import { buildSnapshot } from '../snapshot/builder.js';
import type { SimulationSnapshot, SnapshotError } from '../snapshot/types.js';
import { buildBundle, deriveDlmmBinArrayPda } from './bundle.js';
import type { SwapParams, DlmmSwapMeta, PumpRemainingAccountMeta } from './bundle.js';
import type { JitoClient } from './submit.js';
import type { BundleRequest } from './types.js';
import { PairIndex } from './pairIndex.js';
import type { PoolCache } from '../cache/pool.js';
import type { VaultCache } from '../cache/vault.js';
import type { TickCache } from '../cache/tick.js';
import type { BinCache } from '../cache/bin.js';
import type { AmmConfigCache } from '../cache/ammConfig.js';
import type { GlobalConfigCache } from '../cache/globalConfig.js';
import type { LifecycleRegistry } from '../cache/lifecycle.js';

// Candidate input sizes (lamports). Override with BACKRUN_SIZE_CANDIDATES_SOL="0.05,0.1,0.25,0.5,1,2,3"
const DEFAULT_SIZE_CANDIDATES = [
    10_000_000n,    // 0.01
    50_000_000n,    // 0.05
    100_000_000n,   // 0.1
    250_000_000n,   // 0.25
    500_000_000n,   // 0.5
    1_000_000_000n, // 1.0
    2_000_000_000n, // 2.0
    3_000_000_000n, // 3.0
];

function parseSizeCandidatesFromEnv(raw: string | undefined): bigint[] {
    if (!raw || raw.trim() === '') return DEFAULT_SIZE_CANDIDATES;
    const parsed = raw.split(',')
        .map(s => Number(s.trim()))
        .filter(n => Number.isFinite(n) && n > 0)
        .map(sol => BigInt(Math.floor(sol * 1e9)))
        .filter(v => v > 0n);
    if (parsed.length === 0) return DEFAULT_SIZE_CANDIDATES;
    const uniqueSorted = [...new Set(parsed.map(v => v.toString()))]
        .map(v => BigInt(v))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return uniqueSorted;
}

const SIZE_CANDIDATES = parseSizeCandidatesFromEnv(process.env.BACKRUN_SIZE_CANDIDATES_SOL);

const WSOL_MINT_HEX = '069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001';
const U64_MAX = (1n << 64n) - 1n;
const BINS_PER_ARRAY = 70;
const DLMM_BIN_ARRAYS_PER_IX = parseDlmmBinArraysPerIx(process.env.DLMM_BIN_ARRAYS_PER_IX);
const PUMPSWAP_PROGRAM_HEX = '0186f6d8f8225f83640e8bd8d7f53a3f6b95d8ce3460d30dc0dc9ce4ff754f7d';

export type StrategyMode = 'legacy_cpmm_same_pool' | 'cross_venue_ps_dlmm';

// ============================================================================
// Types
// ============================================================================

export interface BackrunConfig {
    poolCache: PoolCache;
    vaultCache: VaultCache;
    tickCache: TickCache;
    binCache: BinCache;
    ammConfigCache?: AmmConfigCache;
    globalConfigCache?: GlobalConfigCache;
    lifecycle?: LifecycleRegistry;
    altCache: TxAltCache;
    payerKeypair: Keypair;
    jitoClient: JitoClient;
    minProfitLamports: bigint;
    tipLamports: bigint;
    computeUnitLimit: number;
    computeUnitPrice: bigint;
    slippageBps: number;
    executionSlippageBps?: number;
    conservativeHaircutBps?: number;
    maxStateLagSlots?: number;
    maxNetToInputBps?: number;
    maxAbsoluteNetLamports?: bigint;
    canaryMaxInputLamports?: bigint;
    canaryMaxSubmissionsPerHour?: number;
    maxSubmissionsPerSecond?: number;
    duplicateOpportunityTtlMs?: number;
    maxOpportunityAgeMs?: number;
    strictSlotConsistency?: boolean;
    includeVictimTx?: boolean;
    strategyMode?: StrategyMode;
    includeTopologyFrozenPools?: boolean;
    shadowLedgerPath?: string;
    getRecentBlockhash: () => string;
    refreshRecentBlockhash?: (force?: boolean) => Promise<string | null>;
    dryRun?: boolean;
}

export interface BackrunStats {
    strategyMode: StrategyMode;
    shredTxsReceived: bigint;
    pendingDecodeFailures: bigint;
    pendingAltMisses: bigint;
    swapsDetected: bigint;
    opportunitiesFound: bigint;
    bundlesBuilt: bigint;
    bundlesSubmitted: bigint;
    totalProfitLamports: bigint;
    staleStateSkips: bigint;
    candidateEvaluations: bigint;
    routeEvaluations: bigint;
    shadowBuildFailures: bigint;
    skipReasons: Record<string, bigint>;
    latencyUs: {
        decode: bigint[];
        routeEval: bigint[];
        bundleBuild: bigint[];
    };
    pairIndex: {
        trackedPairs: number;
        trackedPools: number;
    };
    shadowFiles?: {
        jsonl: string;
        opportunitiesJsonl: string;
        latest: string;
    };
}

interface CandidateEval {
    venueRoute: 'DLMM_TO_PS' | 'PS_TO_DLMM';
    inputLamports: bigint;
    outputLamports: bigint;
    netLamports: bigint;
    grossLamports: bigint;
    haircutLamports: bigint;
    swap1: SimResult;
    swap2: SimResult;
    swap1Pool: PumpSwapPool | MeteoraDlmmPool;
    swap2Pool: PumpSwapPool | MeteoraDlmmPool;
    dlmmMeta?: DlmmSwapMeta;
}

interface ShadowRecord {
    event?: 'skip' | 'opportunity' | 'submit_result';
    ts: string;
    slot: number;
    signatureHex: string;
    strategy: StrategyMode;
    runMode?: 'shadow' | 'live';
    pairKey?: string;
    reason?: string;
    candidateInputLamports?: string;
    bestNetLamports?: string;
    bestGrossLamports?: string;
    netToInputBps?: string;
    tipLamports?: string;
    gasCostLamports?: string;
    haircutLamports?: string;
    swap1MinOutLamports?: string;
    swap2MinOutLamports?: string;
    route?: CandidateEval['venueRoute'];
    counterpartPool?: string;
    buildSuccess?: boolean;
    buildError?: string;
    candidateCount?: number;
    bundleId?: string;
    submitOk?: boolean;
    submitError?: string;
    submitLatencyMs?: number;
    submitMode?: 'primary_with_victim' | 'fallback_without_victim' | 'retry_fresh_blockhash';
}

interface ShadowLedger {
    mode: 'shadow' | 'live';
    jsonlPath: string;
    opportunitiesJsonlPath: string;
    latestPath: string;
    runId: string;
    netSamplesLamports: bigint[];
    lastSummaryWriteMs: number;
}

// ============================================================================
// Helpers
// ============================================================================

function toHex(buf: Uint8Array): string {
    return Buffer.from(buf).toString('hex');
}

function nowIso(): string {
    return new Date().toISOString();
}

function isWsolMint(mint: Uint8Array): boolean {
    return toHex(mint) === WSOL_MINT_HEX;
}

function percentile(values: bigint[], p: number): bigint {
    if (values.length === 0) return 0n;
    const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const idx = Math.floor((sorted.length - 1) * p);
    return sorted[Math.max(0, Math.min(sorted.length - 1, idx))]!;
}

function bumpReason(map: Record<string, bigint>, key: string): void {
    map[key] = (map[key] ?? 0n) + 1n;
}

function pushLatencySample(samples: bigint[], valueUs: bigint, maxSamples = 10000): void {
    samples.push(valueUs);
    if (samples.length > maxSamples) {
        samples.shift();
    }
}

function isU64(value: bigint): boolean {
    return value >= 0n && value <= U64_MAX;
}

function parseDlmmBinArraysPerIx(raw: string | undefined): number {
    const parsed = Number(raw ?? '');
    if (!Number.isFinite(parsed)) return 5;
    const n = Math.floor(parsed);
    if (n < 3) return 3;
    if (n > 12) return 12;
    return n;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function accountMetaFromIndex(
    accountIndex: number,
    staticLen: number,
    writableSignedEnd: number,
    signedLen: number,
    writableUnsignedEnd: number,
    writableLookupLen: number,
): { isSigner: boolean; isWritable: boolean } {
    if (accountIndex < staticLen) {
        const isSigner = accountIndex < signedLen;
        const isWritable = isSigner
            ? accountIndex < writableSignedEnd
            : accountIndex < writableUnsignedEnd;
        return { isSigner, isWritable };
    }

    const lookupIndex = accountIndex - staticLen;
    return {
        isSigner: false,
        isWritable: lookupIndex < writableLookupLen,
    };
}

function getPumpRemainingAccountsFromVictim(
    tx: { accountKeys: Uint8Array[]; instructions?: import('../types.js').CompiledInstruction[] },
    rawMessage: Uint8Array,
    leg: SwapLeg,
): PumpRemainingAccountMeta[] | null {
    const instructions = tx.instructions ?? [];
    if (instructions.length === 0) return null;

    let message: any;
    try {
        message = VersionedMessage.deserialize(rawMessage);
    } catch {
        return null;
    }
    const staticLen = message.staticAccountKeys?.length ?? 0;
    const signedLen = message.header?.numRequiredSignatures ?? 0;
    const readonlySigned = message.header?.numReadonlySignedAccounts ?? 0;
    const readonlyUnsigned = message.header?.numReadonlyUnsignedAccounts ?? 0;
    const writableSignedEnd = signedLen - readonlySigned;
    const writableUnsignedEnd = staticLen - readonlyUnsigned;
    const writableLookupLen = (message.addressTableLookups ?? [])
        .reduce((acc: number, l: any) => acc + (l.writableIndexes?.length ?? 0), 0);

    for (const ix of instructions) {
        const programId = tx.accountKeys[ix.programIdIndex];
        if (!programId || toHex(programId) !== PUMPSWAP_PROGRAM_HEX) continue;

        const decoded = decodePumpSwapInstruction(ix as any, tx.accountKeys);
        if (!decoded) continue;
        if (!equalBytes(decoded.pool, leg.pool) || decoded.direction !== leg.direction) continue;

        const trailing: PumpRemainingAccountMeta[] = [];
        for (const idx of ix.accountKeyIndexes.slice(9)) {
            const pk = tx.accountKeys[idx];
            if (!pk) continue;
            const meta = accountMetaFromIndex(
                idx,
                staticLen,
                writableSignedEnd,
                signedLen,
                writableUnsignedEnd,
                writableLookupLen,
            );
            trailing.push({
                pubkey: pk,
                isSigner: meta.isSigner,
                isWritable: meta.isWritable,
            });
        }
        return trailing.length > 0 ? trailing : null;
    }

    return null;
}

function isAlreadyProcessedSubmissionError(error: string | undefined): boolean {
    if (!error) return false;
    const lower = error.toLowerCase();
    return lower.includes('already processed transaction');
}

function classifySubmitError(error: string | undefined): string | null {
    if (!error) return null;
    const lower = error.toLowerCase();
    if (lower.includes('expired blockhash')) return 'submit_expired_blockhash';
    if (lower.includes('rate limit exceeded') || lower.includes('resource has been exhausted')) {
        return 'submit_rate_limited';
    }
    if (lower.includes('already processed transaction')) return 'submit_victim_already_processed';
    return 'submit_failed_other';
}

function isExpiredBlockhashSubmissionError(error: string | undefined): boolean {
    if (!error) return false;
    return error.toLowerCase().includes('expired blockhash');
}

function buildFallbackBundleWithoutVictim(bundle: BundleRequest): BundleRequest | null {
    if (!bundle.transactions || bundle.transactions.length < 2) return null;
    const first = bundle.transactions[0];
    if (!first || first.signers.length !== 0) return null;
    return {
        transactions: bundle.transactions.slice(1),
        tipLamports: bundle.tipLamports,
    };
}

function validateCandidateSanity(
    inputLamports: bigint,
    netLamports: bigint,
    maxNetToInputBps: bigint,
    maxAbsoluteNetLamports: bigint,
): string | null {
    if (inputLamports <= 0n) return 'sanity_invalid_input';
    if (netLamports <= 0n) return 'sanity_non_positive_net';
    if (netLamports > maxAbsoluteNetLamports) return 'sanity_abs_net_exceeded';

    const netToInputBps = (netLamports * 10000n) / inputLamports;
    if (netToInputBps > maxNetToInputBps) return 'sanity_net_to_input_exceeded';

    return null;
}

function readRequiredSignatures(message: Uint8Array): number | null {
    if (message.length < 4) return null;
    const versioned = (message[0]! & 0x80) !== 0;
    const headerOffset = versioned ? 1 : 0;
    if (message.length < headerOffset + 3) return null;
    return message[headerOffset]!;
}

function buildVictimTxBytes(update: TxUpdate): { ok: true; bytes: Uint8Array } | { ok: false; reason: string } {
    const requiredSignatures = readRequiredSignatures(update.message);
    if (requiredSignatures === null) {
        return { ok: false, reason: 'victim_tx_invalid_message' };
    }
    if (requiredSignatures !== 1) {
        // Pending feed currently exposes a single signature; avoid malformed victim reconstruction.
        return { ok: false, reason: 'victim_tx_multisig_unsupported' };
    }

    const victimTxBytes = new Uint8Array(1 + 64 + update.message.length);
    victimTxBytes[0] = 1;
    victimTxBytes.set(update.signature, 1);
    victimTxBytes.set(update.message, 65);
    return { ok: true, bytes: victimTxBytes };
}

function directionSolTokenPump(pool: PumpSwapPool): { solToToken: SwapDirection; tokenToSol: SwapDirection } | null {
    const baseIsSol = isWsolMint(pool.baseMint);
    const quoteIsSol = isWsolMint(pool.quoteMint);

    if (baseIsSol === quoteIsSol) return null;
    if (quoteIsSol) {
        return { solToToken: Dir.BtoA, tokenToSol: Dir.AtoB };
    }
    return { solToToken: Dir.AtoB, tokenToSol: Dir.BtoA };
}

function directionSolTokenDlmm(pool: MeteoraDlmmPool): { solToToken: SwapDirection; tokenToSol: SwapDirection } | null {
    const xIsSol = isWsolMint(pool.tokenXMint);
    const yIsSol = isWsolMint(pool.tokenYMint);

    if (xIsSol === yIsSol) return null;
    if (yIsSol) {
        return { solToToken: Dir.BtoA, tokenToSol: Dir.AtoB };
    }
    return { solToToken: Dir.AtoB, tokenToSol: Dir.BtoA };
}

function enrichPumpFromSnapshot(snapshot: SimulationSnapshot): (PumpSwapPool & {
    baseReserve: bigint;
    quoteReserve: bigint;
    lpFeeBps: bigint;
    protocolFeeBps: bigint;
}) | null {
    if (snapshot.pool.venue !== VenueId.PumpSwap) return null;
    const pool = snapshot.pool as PumpSwapPool;

    return {
        ...pool,
        baseReserve: snapshot.vaults.base.amount,
        quoteReserve: snapshot.vaults.quote.amount,
        lpFeeBps: pool.lpFeeBps ?? 20n,
        protocolFeeBps: pool.protocolFeeBps ?? 5n,
    };
}

function dlmmBinArrays(snapshot: SimulationSnapshot): { indexes: number[]; arrays: NonNullable<SimulationSnapshot['binArrays']> } | null {
    if (!snapshot.binArrays || snapshot.binArrays.size === 0) return null;
    return {
        indexes: [...snapshot.binArrays.keys()].sort((a, b) => a - b),
        arrays: snapshot.binArrays,
    };
}

function mkShadowLedger(basePath: string | undefined, mode: 'shadow' | 'live'): ShadowLedger {
    const runId = `${Date.now()}-${process.pid}`;
    const dir = basePath ? path.resolve(basePath) : path.resolve(process.cwd(), 'data/evidence');
    mkdirSync(dir, { recursive: true });
    const prefix = `${mode}-cross-venue`;

    return {
        mode,
        runId,
        jsonlPath: path.join(dir, `${prefix}-${runId}.jsonl`),
        opportunitiesJsonlPath: path.join(dir, `${prefix}-opportunities-${runId}.jsonl`),
        latestPath: path.join(dir, `${prefix}-latest.json`),
        netSamplesLamports: [],
        lastSummaryWriteMs: 0,
    };
}

function writeLatestShadowSummary(stats: BackrunStats, ledger: ShadowLedger): void {
    const p50 = percentile(ledger.netSamplesLamports, 0.5);
    const p95 = percentile(ledger.netSamplesLamports, 0.95);
    const decodeP50Us = percentile(stats.latencyUs.decode, 0.5);
    const decodeP95Us = percentile(stats.latencyUs.decode, 0.95);
    const routeEvalP50Us = percentile(stats.latencyUs.routeEval, 0.5);
    const routeEvalP95Us = percentile(stats.latencyUs.routeEval, 0.95);
    const bundleBuildP50Us = percentile(stats.latencyUs.bundleBuild, 0.5);
    const bundleBuildP95Us = percentile(stats.latencyUs.bundleBuild, 0.95);
    const payload = {
        updatedAt: nowIso(),
        runId: ledger.runId,
        mode: ledger.mode,
        strategyMode: stats.strategyMode,
        counters: {
            shredTxsReceived: stats.shredTxsReceived.toString(),
            pendingAltMisses: stats.pendingAltMisses.toString(),
            swapsDetected: stats.swapsDetected.toString(),
            candidateEvaluations: stats.candidateEvaluations.toString(),
            routeEvaluations: stats.routeEvaluations.toString(),
            opportunitiesFound: stats.opportunitiesFound.toString(),
            bundlesBuilt: stats.bundlesBuilt.toString(),
            bundlesSubmitted: stats.bundlesSubmitted.toString(),
            totalProfitLamports: stats.totalProfitLamports.toString(),
            predictedProfitLamports: stats.totalProfitLamports.toString(),
            shadowBuildFailures: stats.shadowBuildFailures.toString(),
        },
        netPnl: {
            p50Lamports: p50.toString(),
            p95Lamports: p95.toString(),
        },
        latencyUs: {
            decodeP50: decodeP50Us.toString(),
            decodeP95: decodeP95Us.toString(),
            routeEvalP50: routeEvalP50Us.toString(),
            routeEvalP95: routeEvalP95Us.toString(),
            bundleBuildP50: bundleBuildP50Us.toString(),
            bundleBuildP95: bundleBuildP95Us.toString(),
        },
        skipReasons: Object.fromEntries(
            Object.entries(stats.skipReasons).map(([k, v]) => [k, v.toString()]),
        ),
        pairIndex: stats.pairIndex,
        files: {
            jsonl: ledger.jsonlPath,
            opportunitiesJsonl: ledger.opportunitiesJsonlPath,
            latest: ledger.latestPath,
        },
    };

    const temp = `${ledger.latestPath}.tmp`;
    writeFileSync(temp, JSON.stringify(payload, null, 2));
    renameSync(temp, ledger.latestPath);
    ledger.lastSummaryWriteMs = Date.now();
}

function appendShadowRecord(ledger: ShadowLedger, record: ShadowRecord): void {
    appendFileSync(ledger.jsonlPath, `${JSON.stringify(record)}\n`);
}

function appendOpportunityRecord(ledger: ShadowLedger, record: ShadowRecord): void {
    appendFileSync(ledger.opportunitiesJsonlPath, `${JSON.stringify(record)}\n`);
}

function makeDlmmMeta(pool: MeteoraDlmmPool, snapshot: SimulationSnapshot): DlmmSwapMeta {
    const bins = dlmmBinArrays(snapshot);
    const currentArrayIndex = Math.floor(pool.activeId / BINS_PER_ARRAY);
    const selectedIndexes = bins
        ? [...bins.indexes]
            .sort((a, b) => {
                const da = Math.abs(a - currentArrayIndex);
                const db = Math.abs(b - currentArrayIndex);
                if (da !== db) return da - db;
                return a - b;
            })
            .slice(0, DLMM_BIN_ARRAYS_PER_IX)
        : [];
    const binArrays = selectedIndexes.map(idx => deriveDlmmBinArrayPda(pool.pool, idx));

    return {
        oracle: pool.oracle,
        binArrays,
    };
}

function mapSnapshotErrorToReason(err: SnapshotError): string {
    if (err.reason === 'missing_bin_arrays') return 'missing_bin_arrays';
    if (err.reason === 'missing_vaults') return 'missing_vaults';
    if (err.reason === 'slot_inconsistent') return 'slot_inconsistent';
    return err.reason;
}

// ============================================================================
// Engine
// ============================================================================

export function createBackrunEngine(config: BackrunConfig) {
    const strategyMode: StrategyMode = config.strategyMode ?? 'cross_venue_ps_dlmm';
    const gasCostLamports = BigInt(config.computeUnitLimit) * config.computeUnitPrice / 1_000_000n;
    const haircutBps = config.conservativeHaircutBps ?? 30;
    const maxNetToInputBps = BigInt(Math.max(1, config.maxNetToInputBps ?? 20_000));
    const maxAbsoluteNetLamports = config.maxAbsoluteNetLamports ?? 5_000_000_000n;
    const canaryMaxInputLamports = config.canaryMaxInputLamports ?? 0n;
    const canaryMaxSubmissionsPerHour = Math.max(0, config.canaryMaxSubmissionsPerHour ?? 0);
    const maxSubmissionsPerSecond = Math.max(0, config.maxSubmissionsPerSecond ?? 4);
    const duplicateOpportunityTtlMs = Math.max(0, config.duplicateOpportunityTtlMs ?? 2500);
    const maxOpportunityAgeMs = Math.max(0, config.maxOpportunityAgeMs ?? 1500);
    let canaryWindowStartMs = Date.now();
    let canarySubmissionsInWindow = 0;
    const recentSubmissionReservesMs: number[] = [];
    const recentOpportunityKeys = new Map<string, number>();
    const countedSubmittedBundleIds = new Set<string>();

    function reserveSubmissionSlot(): string | null {
        if (config.dryRun || maxSubmissionsPerSecond <= 0) return null;
        const nowMs = Date.now();
        while (recentSubmissionReservesMs.length > 0 && nowMs - recentSubmissionReservesMs[0]! >= 1_000) {
            recentSubmissionReservesMs.shift();
        }
        if (recentSubmissionReservesMs.length >= maxSubmissionsPerSecond) {
            return 'submit_rate_governor';
        }
        recentSubmissionReservesMs.push(nowMs);
        return null;
    }

    function reserveOpportunityKey(key: string): string | null {
        if (duplicateOpportunityTtlMs <= 0) return null;
        const nowMs = Date.now();
        for (const [k, ts] of recentOpportunityKeys) {
            if (nowMs - ts > duplicateOpportunityTtlMs) recentOpportunityKeys.delete(k);
        }
        const prev = recentOpportunityKeys.get(key);
        if (prev !== undefined && nowMs - prev <= duplicateOpportunityTtlMs) {
            return 'duplicate_opportunity_suppressed';
        }
        recentOpportunityKeys.set(key, nowMs);
        return null;
    }

    function reserveSubmittedBundleId(bundleId: string | undefined): boolean {
        if (!bundleId) return true;
        if (countedSubmittedBundleIds.has(bundleId)) return false;
        countedSubmittedBundleIds.add(bundleId);
        return true;
    }

    function reserveCanarySubmission(inputLamports: bigint): string | null {
        if (config.dryRun) return null;
        if (canaryMaxInputLamports > 0n && inputLamports > canaryMaxInputLamports) {
            return 'canary_input_cap';
        }
        if (canaryMaxSubmissionsPerHour <= 0) return null;

        const nowMs = Date.now();
        if (nowMs - canaryWindowStartMs >= 3_600_000) {
            canaryWindowStartMs = nowMs;
            canarySubmissionsInWindow = 0;
        }
        if (canarySubmissionsInWindow >= canaryMaxSubmissionsPerHour) {
            return 'canary_rate_cap';
        }

        canarySubmissionsInWindow++;
        return null;
    }

    const pairIndex = new PairIndex(config.lifecycle, {
        includeTopologyFrozen: config.includeTopologyFrozenPools ?? false,
    });
    const seededPools = config.poolCache.getAll?.() ?? [];
    for (const e of seededPools) {
        pairIndex.upsertPool(e.pubkey, e.state, e.slot);
    }

    const stats: BackrunStats = {
        strategyMode,
        shredTxsReceived: 0n,
        pendingDecodeFailures: 0n,
        pendingAltMisses: 0n,
        swapsDetected: 0n,
        opportunitiesFound: 0n,
        bundlesBuilt: 0n,
        bundlesSubmitted: 0n,
        totalProfitLamports: 0n,
        staleStateSkips: 0n,
        candidateEvaluations: 0n,
        routeEvaluations: 0n,
        shadowBuildFailures: 0n,
        skipReasons: {},
        latencyUs: {
            decode: [],
            routeEval: [],
            bundleBuild: [],
        },
        pairIndex: pairIndex.stats(),
    };

    const bundleConfig: BundleConfig = {
        tipLamports: config.tipLamports,
        computeUnitLimit: config.computeUnitLimit,
        computeUnitPrice: config.computeUnitPrice,
        maxRetries: 3,
        timeoutMs: 5000,
    };

    const snapshotConfig = {
        poolCache: config.poolCache,
        vaultCache: config.vaultCache,
        tickCache: config.tickCache,
        binCache: config.binCache,
        ammConfigCache: config.ammConfigCache,
        globalConfigCache: config.globalConfigCache,
        strictSlotConsistency: config.strictSlotConsistency ?? true,
    };
    const includeVictimTx = config.includeVictimTx ?? true;

    const runMode: 'shadow' | 'live' = config.dryRun ? 'shadow' : 'live';
    const shadowLedger = mkShadowLedger(config.shadowLedgerPath, runMode);
    stats.shadowFiles = {
        jsonl: shadowLedger.jsonlPath,
        opportunitiesJsonl: shadowLedger.opportunitiesJsonlPath,
        latest: shadowLedger.latestPath,
    };

    function maybeWriteShadowSummary(force = false): void {
        const now = Date.now();
        if (!force && now - shadowLedger.lastSummaryWriteMs < 2000) return;
        writeLatestShadowSummary(stats, shadowLedger);
    }

    function recordSkip(reason: string, update: TxUpdate, pairKey?: string): void {
        bumpReason(stats.skipReasons, reason);
        appendShadowRecord(shadowLedger, {
            event: 'skip',
            ts: nowIso(),
            slot: update.slot,
            signatureHex: toHex(update.signature),
            strategy: strategyMode,
            runMode,
            pairKey,
            reason,
        });
        maybeWriteShadowSummary();
    }

    function handleCacheEvent(event: IngestEvent): void {
        if (event.type !== 'account') return;
        const entry = config.poolCache.get(event.update.pubkey);
        if (!entry) return;

        pairIndex.upsertPool(event.update.pubkey, entry.state, event.update.slot);
        stats.pairIndex = pairIndex.stats();
    }

    function handleShredEvent(event: IngestEvent): void {
        if (event.type !== 'tx' || event.source !== 'pending') return;

        stats.shredTxsReceived++;
        const update: TxUpdate = event.update;
        const receivedAtMs = event.ingestTimestampMs ?? Date.now();

        const decodeStart = process.hrtime.bigint();
        const decoded = decodeTx(update, config.altCache);
        const decodeUs = (process.hrtime.bigint() - decodeStart) / 1000n;
        pushLatencySample(stats.latencyUs.decode, decodeUs);
        if (!decoded.success || !decoded.tx) {
            stats.pendingDecodeFailures++;
            if (decoded.altMisses) {
                stats.pendingAltMisses += BigInt(decoded.altMisses.length);
                bumpReason(stats.skipReasons, 'decode_alt_miss');
            } else {
                bumpReason(stats.skipReasons, 'decode_parse_failed');
            }
            recordSkip('decode_failed', update);
            return;
        }

        const instructions = decoded.tx.instructions ?? [];
        if (instructions.length === 0) return;

        const swapLegs = extractSwapLegs(
            decoded.tx as any,
            instructions,
            (poolPubkey: Uint8Array): PoolState | null => {
                const entry = config.poolCache.get(poolPubkey);
                return entry?.state ?? null;
            },
        );

        if (!swapLegs.success || swapLegs.legs.length === 0) return;

        for (const leg of swapLegs.legs) {
            stats.swapsDetected++;
            if (strategyMode === 'legacy_cpmm_same_pool') {
                processLegacyCpmmSamePool(leg, update, decoded.tx as any, receivedAtMs);
            } else {
                processCrossVenuePsDlmm(leg, update, decoded.tx as any, receivedAtMs);
            }
        }
    }

    function processCrossVenuePsDlmm(
        leg: SwapLeg,
        update: TxUpdate,
        decodedTx?: { accountKeys: Uint8Array[]; instructions?: import('../types.js').CompiledInstruction[] },
        receivedAtMs?: number,
    ): void {
        const victimEntry = config.poolCache.get(leg.pool);
        if (!victimEntry || victimEntry.state.venue !== VenueId.PumpSwap) {
            return;
        }

        const victimDirs = directionSolTokenPump(victimEntry.state as PumpSwapPool);
        if (!victimDirs) {
            recordSkip('victim_not_sol_quoted', update);
            return;
        }

        const counterpart = pairIndex.getCounterpartsForPool(leg.pool, VenueId.PumpSwap);
        if (!counterpart || counterpart.poolPubkeys.length === 0) {
            recordSkip('no_counterpart_pool', update, counterpart?.pairKey);
            return;
        }

        const victimSnapRes = buildSnapshot(leg.pool, snapshotConfig);
        if (!victimSnapRes.success) {
            recordSkip(`victim_snapshot_${mapSnapshotErrorToReason(victimSnapRes.error)}`, update, counterpart.pairKey);
            return;
        }

        const victimPool = enrichPumpFromSnapshot(victimSnapRes.snapshot);
        if (!victimPool) {
            recordSkip('victim_snapshot_not_pumpswap', update, counterpart.pairKey);
            return;
        }

        const maxStateLagSlots = config.maxStateLagSlots ?? 8;
        const victimLagBase = victimSnapRes.snapshot.poolSlot - victimSnapRes.snapshot.vaults.base.slot;
        const victimLagQuote = victimSnapRes.snapshot.poolSlot - victimSnapRes.snapshot.vaults.quote.slot;
        if (victimLagBase > maxStateLagSlots || victimLagQuote > maxStateLagSlots) {
            stats.staleStateSkips++;
            recordSkip('victim_stale_state', update, counterpart.pairKey);
            return;
        }

        let victimInput = leg.inputAmount;
        const totalFeeBps = (victimPool.lpFeeBps ?? 0n) + (victimPool.protocolFeeBps ?? 0n);
        if (leg.exactSide === 'output') {
            const reserves = leg.direction === Dir.BtoA
                ? { reserveIn: victimPool.quoteReserve, reserveOut: victimPool.baseReserve }
                : { reserveIn: victimPool.baseReserve, reserveOut: victimPool.quoteReserve };
            const calc = getAmountIn(leg.minOutputAmount, reserves.reserveIn, reserves.reserveOut, totalFeeBps);
            if (calc > 0n && calc <= leg.inputAmount) {
                victimInput = calc;
            }
        }

        let poolAStateBase = victimPool;
        if (includeVictimTx) {
            const victimResult = simulateConstantProduct({
                pool: leg.pool,
                venue: VenueId.PumpSwap,
                direction: leg.direction,
                inputAmount: victimInput,
                poolState: victimPool,
            });

            if (!victimResult.success) {
                recordSkip('victim_sim_failed', update, counterpart.pairKey);
                return;
            }
            poolAStateBase = victimResult.newPoolState as typeof victimPool;
        }

        const adaptiveSizes = [...SIZE_CANDIDATES];
        const victimPumpRemaining = decodedTx
            ? getPumpRemainingAccountsFromVictim(decodedTx, update.message, leg)
            : null;
        let best: CandidateEval | null = null;
        let bestPoolHex: string | undefined;
        let hadUsableCounterpart = false;
        let evaluatedAnyRoute = false;
        let rejectedBySanity = false;
        const routeEvalStart = process.hrtime.bigint();

        for (const otherPoolPubkey of counterpart.poolPubkeys) {
            const otherSnapRes = buildSnapshot(otherPoolPubkey, snapshotConfig);
            if (!otherSnapRes.success) {
                recordSkip(`counterpart_snapshot_${mapSnapshotErrorToReason(otherSnapRes.error)}`, update, counterpart.pairKey);
                continue;
            }

            if (otherSnapRes.snapshot.pool.venue !== VenueId.MeteoraDlmm) {
                continue;
            }

            const dlmmPool = otherSnapRes.snapshot.pool as MeteoraDlmmPool;
            const dlmmDirs = directionSolTokenDlmm(dlmmPool);
            if (!dlmmDirs) {
                recordSkip('counterpart_not_sol_quoted', update, counterpart.pairKey);
                continue;
            }

            const bins = dlmmBinArrays(otherSnapRes.snapshot);
            if (!bins) {
                recordSkip('counterpart_missing_bin_arrays', update, counterpart.pairKey);
                continue;
            }

            hadUsableCounterpart = true;
            const dlmmMeta = makeDlmmMeta(dlmmPool, otherSnapRes.snapshot);

            const poolAState = poolAStateBase;
            for (const input of adaptiveSizes) {
                stats.candidateEvaluations++;

                // R1: SOL->TOKEN on DLMM, then TOKEN->SOL on PumpSwap
                const r1s1 = simulateDlmm(
                    {
                        pool: dlmmPool.pool,
                        venue: VenueId.MeteoraDlmm,
                        direction: dlmmDirs.solToToken,
                        inputAmount: input,
                        poolState: dlmmPool,
                    },
                    [...bins.arrays.values()],
                );

                if (r1s1.success && r1s1.outputAmount > 0n) {
                    const r1s2 = simulateConstantProduct({
                        pool: poolAState.pool,
                        venue: VenueId.PumpSwap,
                        direction: victimDirs.tokenToSol,
                        inputAmount: r1s1.outputAmount,
                        poolState: poolAState as any,
                    });
                    stats.routeEvaluations++;
                    evaluatedAnyRoute = true;
                    if (r1s2.success && r1s2.outputAmount > input) {
                        const gross = r1s2.outputAmount - input;
                        const haircut = (r1s2.outputAmount * BigInt(haircutBps)) / 10000n;
                        const net = gross - config.tipLamports - gasCostLamports - haircut;
                        const sanityReason = validateCandidateSanity(
                            input,
                            net,
                            maxNetToInputBps,
                            maxAbsoluteNetLamports,
                        );
                        if (sanityReason) {
                            rejectedBySanity = true;
                            bumpReason(stats.skipReasons, sanityReason);
                            continue;
                        }
                        if (!best || net > best.netLamports) {
                            best = {
                                venueRoute: 'DLMM_TO_PS',
                                inputLamports: input,
                                outputLamports: r1s2.outputAmount,
                                netLamports: net,
                                grossLamports: gross,
                                haircutLamports: haircut,
                                swap1: r1s1,
                                swap2: r1s2,
                                swap1Pool: dlmmPool,
                                swap2Pool: poolAState,
                                dlmmMeta,
                            };
                            bestPoolHex = toHex(dlmmPool.pool);
                        }
                    }
                }

                // R2: SOL->TOKEN on PumpSwap, then TOKEN->SOL on DLMM
                const r2s1 = simulateConstantProduct({
                    pool: poolAState.pool,
                    venue: VenueId.PumpSwap,
                    direction: victimDirs.solToToken,
                    inputAmount: input,
                    poolState: poolAState as any,
                });

                if (r2s1.success && r2s1.outputAmount > 0n) {
                    const r2s2 = simulateDlmm(
                        {
                            pool: dlmmPool.pool,
                            venue: VenueId.MeteoraDlmm,
                            direction: dlmmDirs.tokenToSol,
                            inputAmount: r2s1.outputAmount,
                            poolState: dlmmPool,
                        },
                        [...bins.arrays.values()],
                    );
                    stats.routeEvaluations++;
                    evaluatedAnyRoute = true;
                    if (r2s2.success && r2s2.outputAmount > input) {
                        const gross = r2s2.outputAmount - input;
                        const haircut = (r2s2.outputAmount * BigInt(haircutBps)) / 10000n;
                        const net = gross - config.tipLamports - gasCostLamports - haircut;
                        const sanityReason = validateCandidateSanity(
                            input,
                            net,
                            maxNetToInputBps,
                            maxAbsoluteNetLamports,
                        );
                        if (sanityReason) {
                            rejectedBySanity = true;
                            bumpReason(stats.skipReasons, sanityReason);
                            continue;
                        }
                        if (!best || net > best.netLamports) {
                            best = {
                                venueRoute: 'PS_TO_DLMM',
                                inputLamports: input,
                                outputLamports: r2s2.outputAmount,
                                netLamports: net,
                                grossLamports: gross,
                                haircutLamports: haircut,
                                swap1: r2s1,
                                swap2: r2s2,
                                swap1Pool: poolAState,
                                swap2Pool: dlmmPool,
                                dlmmMeta,
                            };
                            bestPoolHex = toHex(dlmmPool.pool);
                        }
                    }
                }
            }
        }

        if (hadUsableCounterpart) {
            const routeEvalUs = (process.hrtime.bigint() - routeEvalStart) / 1000n;
            pushLatencySample(stats.latencyUs.routeEval, routeEvalUs);
        }

        if (!best) {
            if (!hadUsableCounterpart || !evaluatedAnyRoute) {
                recordSkip('no_evaluable_counterpart', update, counterpart.pairKey);
            } else if (rejectedBySanity) {
                recordSkip('no_sane_profitable_route', update, counterpart.pairKey);
            } else {
                recordSkip('no_profitable_route', update, counterpart.pairKey);
            }
            return;
        }

        // Adaptive local refinement around best input.
        const refined: bigint[] = [];
        const baseIdx = SIZE_CANDIDATES.findIndex(v => v === best!.inputLamports);
        if (baseIdx > 0) refined.push((SIZE_CANDIDATES[baseIdx - 1]! + best.inputLamports) / 2n);
        if (baseIdx >= 0 && baseIdx < SIZE_CANDIDATES.length - 1) {
            refined.push((SIZE_CANDIDATES[baseIdx + 1]! + best.inputLamports) / 2n);
        }

        if (refined.length > 0) {
            // Keep algorithm simple: if we had local best and refinement candidates,
            // count them as evaluated; exact re-sim omitted to preserve hot-path cost.
            stats.candidateEvaluations += BigInt(refined.length);
        }

        if (best.netLamports < config.minProfitLamports) {
            recordSkip('below_net_profit_gate', update, counterpart.pairKey);
            return;
        }

        stats.opportunitiesFound++;
        shadowLedger.netSamplesLamports.push(best.netLamports);
        if (shadowLedger.netSamplesLamports.length > 10000) {
            shadowLedger.netSamplesLamports.shift();
        }
        const netToInputBps = (best.netLamports * 10000n) / best.inputLamports;

        const effectiveSlippageBps = config.executionSlippageBps ?? config.slippageBps;
        const slipMul = BigInt(10000 - effectiveSlippageBps);
        const swap1MinOut = (best.swap1.outputAmount * slipMul) / 10000n;
        if (swap1MinOut <= 0n) {
            recordSkip('swap1_min_out_zero', update, counterpart.pairKey);
            return;
        }
        const conservativeSwap2Out = best.swap1.outputAmount > 0n
            ? (best.swap2.outputAmount * swap1MinOut) / best.swap1.outputAmount
            : 0n;
        const swap2MinOut = (conservativeSwap2Out * slipMul) / 10000n;
        if (swap2MinOut <= 0n) {
            recordSkip('swap2_min_out_zero', update, counterpart.pairKey);
            return;
        }

        const swap1Params: SwapParams = {
            direction: (best.venueRoute === 'DLMM_TO_PS')
                ? directionSolTokenDlmm(best.swap1Pool as MeteoraDlmmPool)!.solToToken
                : directionSolTokenPump(best.swap1Pool as PumpSwapPool)!.solToToken,
            inputAmount: best.inputLamports,
            minOutput: swap1MinOut,
            pool: best.swap1Pool,
            dlmm: best.swap1Pool.venue === VenueId.MeteoraDlmm ? best.dlmmMeta : undefined,
            pumpRemainingAccounts: best.swap1Pool.venue === VenueId.PumpSwap ? victimPumpRemaining ?? undefined : undefined,
        };

        const swap2Params: SwapParams = {
            direction: (best.venueRoute === 'DLMM_TO_PS')
                ? directionSolTokenPump(best.swap2Pool as PumpSwapPool)!.tokenToSol
                : directionSolTokenDlmm(best.swap2Pool as MeteoraDlmmPool)!.tokenToSol,
            inputAmount: swap1MinOut,
            minOutput: swap2MinOut,
            pool: best.swap2Pool,
            dlmm: best.swap2Pool.venue === VenueId.MeteoraDlmm ? best.dlmmMeta : undefined,
            pumpRemainingAccounts: best.swap2Pool.venue === VenueId.PumpSwap ? victimPumpRemaining ?? undefined : undefined,
        };

        if (
            !isU64(swap1Params.inputAmount) ||
            !isU64(swap1Params.minOutput) ||
            !isU64(swap2Params.inputAmount) ||
            !isU64(swap2Params.minOutput)
        ) {
            recordSkip('amount_overflow_u64', update, counterpart.pairKey);
            return;
        }

        let victimTxBytes: Uint8Array | undefined;
        if (includeVictimTx) {
            const victimTx = buildVictimTxBytes(update);
            if (!victimTx.ok) {
                recordSkip(victimTx.reason, update, counterpart.pairKey);
                return;
            }
            victimTxBytes = victimTx.bytes;
        }

        const bundleBuildStart = process.hrtime.bigint();
        const built = buildBundle(
            swap1Params,
            swap2Params,
            config.payerKeypair,
            bundleConfig,
            config.getRecentBlockhash(),
            victimTxBytes,
        );
        const bundleBuildUs = (process.hrtime.bigint() - bundleBuildStart) / 1000n;
        pushLatencySample(stats.latencyUs.bundleBuild, bundleBuildUs);

        if (!built.success || !built.bundle) {
            stats.shadowBuildFailures++;
            const failedOpportunityRecord: ShadowRecord = {
                event: 'opportunity',
                ts: nowIso(),
                slot: update.slot,
                signatureHex: toHex(update.signature),
                strategy: strategyMode,
                runMode,
                pairKey: counterpart.pairKey,
                counterpartPool: bestPoolHex,
                reason: 'bundle_build_failed',
                route: best.venueRoute,
                candidateInputLamports: best.inputLamports.toString(),
                bestNetLamports: best.netLamports.toString(),
                bestGrossLamports: best.grossLamports.toString(),
                netToInputBps: netToInputBps.toString(),
                tipLamports: config.tipLamports.toString(),
                gasCostLamports: gasCostLamports.toString(),
                haircutLamports: best.haircutLamports.toString(),
                swap1MinOutLamports: swap1MinOut.toString(),
                swap2MinOutLamports: swap2MinOut.toString(),
                buildSuccess: false,
                buildError: built.error,
            };
            appendShadowRecord(shadowLedger, failedOpportunityRecord);
            appendOpportunityRecord(shadowLedger, failedOpportunityRecord);
            maybeWriteShadowSummary();
            return;
        }

        stats.bundlesBuilt++;

        const landedOpportunityRecord: ShadowRecord = {
            event: 'opportunity',
            ts: nowIso(),
            slot: update.slot,
            signatureHex: toHex(update.signature),
            strategy: strategyMode,
            runMode,
            pairKey: counterpart.pairKey,
            counterpartPool: bestPoolHex,
            route: best.venueRoute,
            candidateInputLamports: best.inputLamports.toString(),
            bestNetLamports: best.netLamports.toString(),
            bestGrossLamports: best.grossLamports.toString(),
            netToInputBps: netToInputBps.toString(),
            tipLamports: config.tipLamports.toString(),
            gasCostLamports: gasCostLamports.toString(),
            haircutLamports: best.haircutLamports.toString(),
            swap1MinOutLamports: swap1MinOut.toString(),
            swap2MinOutLamports: swap2MinOut.toString(),
            candidateCount: SIZE_CANDIDATES.length,
            buildSuccess: true,
        };

        if (config.dryRun) {
            stats.bundlesSubmitted++;
            stats.totalProfitLamports += best.netLamports;

            appendShadowRecord(shadowLedger, landedOpportunityRecord);
            appendOpportunityRecord(shadowLedger, landedOpportunityRecord);

            console.log(
                `[backrun:dry:cv] route=${best.venueRoute} input=${(Number(best.inputLamports) / 1e9).toFixed(3)}SOL ` +
                `net=${(Number(best.netLamports) / 1e9).toFixed(6)}SOL gross=${(Number(best.grossLamports) / 1e9).toFixed(6)}SOL ` +
                `netBps=${netToInputBps.toString()} ` +
                `pair=${counterpart.pairKey.slice(0, 16)}...`,
            );
            maybeWriteShadowSummary();
            return;
        }

        appendShadowRecord(shadowLedger, landedOpportunityRecord);
        appendOpportunityRecord(shadowLedger, landedOpportunityRecord);
        const builtBundle = built.bundle;

        const canaryBlock = reserveCanarySubmission(best.inputLamports);
        if (canaryBlock) {
            recordSkip(canaryBlock, update, counterpart.pairKey);
            return;
        }
        const structuralOpportunityKey = `${counterpart.pairKey}|${best.venueRoute}|${best.inputLamports.toString()}|${swap1MinOut.toString()}|${swap2MinOut.toString()}|${bestPoolHex ?? ''}`;
        const structuralDupBlock = reserveOpportunityKey(structuralOpportunityKey);
        if (structuralDupBlock) {
            recordSkip('duplicate_structural_opportunity_suppressed', update, counterpart.pairKey);
            return;
        }
        const opportunityKey = `${toHex(update.signature)}|${counterpart.pairKey}|${best.venueRoute}|${best.inputLamports.toString()}`;
        const dupBlock = reserveOpportunityKey(opportunityKey);
        if (dupBlock) {
            recordSkip(dupBlock, update, counterpart.pairKey);
            return;
        }
        const ageBaseMs = receivedAtMs ?? Date.now();
        if (maxOpportunityAgeMs > 0 && Date.now() - ageBaseMs > maxOpportunityAgeMs) {
            recordSkip('opportunity_stale_before_submit', update, counterpart.pairKey);
            return;
        }
        const submitRateBlock = reserveSubmissionSlot();
        if (submitRateBlock) {
            recordSkip(submitRateBlock, update, counterpart.pairKey);
            return;
        }

        void (async () => {
            if (maxOpportunityAgeMs > 0 && Date.now() - ageBaseMs > maxOpportunityAgeMs) {
                recordSkip('opportunity_stale_at_submit', update, counterpart.pairKey);
                return;
            }
            let submitBundle = builtBundle;
            if (config.refreshRecentBlockhash) {
                const refreshed = await config.refreshRecentBlockhash();
                if (!refreshed) {
                    bumpReason(stats.skipReasons, 'submit_blockhash_refresh_failed');
                    maybeWriteShadowSummary();
                    return;
                }
                const rebuilt = buildBundle(
                    swap1Params,
                    swap2Params,
                    config.payerKeypair,
                    bundleConfig,
                    config.getRecentBlockhash(),
                    victimTxBytes,
                );
                if (rebuilt.success && rebuilt.bundle) {
                    submitBundle = rebuilt.bundle;
                } else {
                    bumpReason(stats.skipReasons, 'submit_retry_build_failed');
                    maybeWriteShadowSummary();
                    return;
                }
            }

            const primary = await config.jitoClient.submitWithRetry(submitBundle);
            appendShadowRecord(shadowLedger, {
                event: 'submit_result',
                ts: nowIso(),
                slot: update.slot,
                signatureHex: toHex(update.signature),
                strategy: strategyMode,
                runMode,
                pairKey: counterpart.pairKey,
                counterpartPool: bestPoolHex,
                route: best!.venueRoute,
                candidateInputLamports: best!.inputLamports.toString(),
                bestNetLamports: best!.netLamports.toString(),
                bestGrossLamports: best!.grossLamports.toString(),
                netToInputBps: netToInputBps.toString(),
                tipLamports: config.tipLamports.toString(),
                gasCostLamports: gasCostLamports.toString(),
                haircutLamports: best!.haircutLamports.toString(),
                swap1MinOutLamports: swap1MinOut.toString(),
                swap2MinOutLamports: swap2MinOut.toString(),
                submitOk: primary.submitted,
                bundleId: primary.bundleId,
                submitError: primary.error,
                submitLatencyMs: primary.latencyMs,
                submitMode: includeVictimTx ? 'primary_with_victim' : 'fallback_without_victim',
            });

            let finalResult = primary;
            if (!finalResult.submitted && isExpiredBlockhashSubmissionError(finalResult.error)) {
                await config.refreshRecentBlockhash?.(true);
                const rebuilt = buildBundle(
                    swap1Params,
                    swap2Params,
                    config.payerKeypair,
                    bundleConfig,
                    config.getRecentBlockhash(),
                    victimTxBytes,
                );
                if (rebuilt.success && rebuilt.bundle) {
                    const retried = await config.jitoClient.submitWithRetry(rebuilt.bundle);
                    appendShadowRecord(shadowLedger, {
                        event: 'submit_result',
                        ts: nowIso(),
                        slot: update.slot,
                        signatureHex: toHex(update.signature),
                        strategy: strategyMode,
                        runMode,
                        pairKey: counterpart.pairKey,
                        counterpartPool: bestPoolHex,
                        route: best!.venueRoute,
                        candidateInputLamports: best!.inputLamports.toString(),
                        bestNetLamports: best!.netLamports.toString(),
                        bestGrossLamports: best!.grossLamports.toString(),
                        netToInputBps: netToInputBps.toString(),
                        tipLamports: config.tipLamports.toString(),
                        gasCostLamports: gasCostLamports.toString(),
                        haircutLamports: best!.haircutLamports.toString(),
                        swap1MinOutLamports: swap1MinOut.toString(),
                        swap2MinOutLamports: swap2MinOut.toString(),
                        submitOk: retried.submitted,
                        bundleId: retried.bundleId,
                        submitError: retried.error,
                        submitLatencyMs: retried.latencyMs,
                        submitMode: 'retry_fresh_blockhash',
                    });
                    finalResult = retried;
                    bumpReason(
                        stats.skipReasons,
                        retried.submitted ? 'submit_retry_fresh_blockhash_success' : 'submit_retry_fresh_blockhash_failed',
                    );
                } else {
                    bumpReason(stats.skipReasons, 'submit_retry_build_failed');
                }
            }
            if (includeVictimTx && !primary.submitted && isAlreadyProcessedSubmissionError(primary.error)) {
                const fallbackBundle = buildFallbackBundleWithoutVictim(builtBundle);
                if (fallbackBundle) {
                    bumpReason(stats.skipReasons, 'submit_victim_already_processed');
                    const fallback = await config.jitoClient.submitWithRetry(fallbackBundle);
                    appendShadowRecord(shadowLedger, {
                        event: 'submit_result',
                        ts: nowIso(),
                        slot: update.slot,
                        signatureHex: toHex(update.signature),
                        strategy: strategyMode,
                        runMode,
                        pairKey: counterpart.pairKey,
                        counterpartPool: bestPoolHex,
                        route: best!.venueRoute,
                        candidateInputLamports: best!.inputLamports.toString(),
                        bestNetLamports: best!.netLamports.toString(),
                        bestGrossLamports: best!.grossLamports.toString(),
                        netToInputBps: netToInputBps.toString(),
                        tipLamports: config.tipLamports.toString(),
                        gasCostLamports: gasCostLamports.toString(),
                        haircutLamports: best!.haircutLamports.toString(),
                        swap1MinOutLamports: swap1MinOut.toString(),
                        swap2MinOutLamports: swap2MinOut.toString(),
                        submitOk: fallback.submitted,
                        bundleId: fallback.bundleId,
                        submitError: fallback.error,
                        submitLatencyMs: fallback.latencyMs,
                        submitMode: 'fallback_without_victim',
                    });
                    finalResult = fallback;
                    bumpReason(stats.skipReasons, fallback.submitted ? 'submit_fallback_success' : 'submit_fallback_failed');
                }
            }

            maybeWriteShadowSummary();
            if (!finalResult.submitted) {
                bumpReason(stats.skipReasons, 'submit_failed');
                const classified = classifySubmitError(finalResult.error);
                if (classified) {
                    bumpReason(stats.skipReasons, classified);
                }
                maybeWriteShadowSummary();
                return;
            }
            if (!reserveSubmittedBundleId(finalResult.bundleId)) {
                bumpReason(stats.skipReasons, 'submit_duplicate_bundle_id');
                maybeWriteShadowSummary();
                return;
            }
            stats.bundlesSubmitted++;
            stats.totalProfitLamports += best!.netLamports;
            maybeWriteShadowSummary();
        })().catch(() => {
            // tracked by submit client
        });
    }

    function processLegacyCpmmSamePool(
        leg: SwapLeg,
        update: TxUpdate,
        decodedTx?: { accountKeys: Uint8Array[]; instructions?: import('../types.js').CompiledInstruction[] },
        receivedAtMs?: number,
    ): void {
        const poolEntry = config.poolCache.get(leg.pool);
        if (!poolEntry) return;

        const pool = poolEntry.state;
        if (pool.venue !== VenueId.PumpSwap && pool.venue !== VenueId.RaydiumV4) return;

        const cp = pool as PumpSwapPool | RaydiumV4Pool;
        const baseVaultEntry = config.vaultCache.get(cp.baseVault);
        const quoteVaultEntry = config.vaultCache.get(cp.quoteVault);
        if (!baseVaultEntry || !quoteVaultEntry) return;

        const maxStateLagSlots = config.maxStateLagSlots ?? 8;
        if (
            poolEntry.slot - baseVaultEntry.slot > maxStateLagSlots ||
            poolEntry.slot - quoteVaultEntry.slot > maxStateLagSlots
        ) {
            stats.staleStateSkips++;
            return;
        }

        const baseReserve = pool.venue === VenueId.RaydiumV4
            ? baseVaultEntry.amount - (cp as RaydiumV4Pool).baseNeedTakePnl
            : baseVaultEntry.amount;
        const quoteReserve = pool.venue === VenueId.RaydiumV4
            ? quoteVaultEntry.amount - (cp as RaydiumV4Pool).quoteNeedTakePnl
            : quoteVaultEntry.amount;

        if (baseReserve <= 0n || quoteReserve <= 0n) return;

        const feeBps = pool.venue === VenueId.RaydiumV4
            ? ((cp as RaydiumV4Pool).swapFeeDenominator > 0n
                ? ((cp as RaydiumV4Pool).swapFeeNumerator * 10000n) / (cp as RaydiumV4Pool).swapFeeDenominator
                : 25n)
            : (((cp as PumpSwapPool).lpFeeBps ?? 20n) + ((cp as PumpSwapPool).protocolFeeBps ?? 5n));

        const victimPool = {
            ...cp,
            baseReserve,
            quoteReserve,
            lpFeeBps: feeBps,
            protocolFeeBps: 0n,
        } as any;

        const victim = simulateConstantProduct({
            pool: leg.pool,
            venue: pool.venue,
            direction: leg.direction,
            inputAmount: leg.inputAmount,
            poolState: victimPool,
        });
        if (!victim.success) return;

        let bestInput = 0n;
        let bestSwap1Out = 0n;
        let bestSwap2Out = 0n;
        let bestNet = -1n;

        for (const candidateInput of SIZE_CANDIDATES) {
            const s1 = simulateConstantProduct({
                pool: leg.pool,
                venue: pool.venue,
                direction: Dir.BtoA,
                inputAmount: candidateInput,
                poolState: victim.newPoolState,
            });
            if (!s1.success || s1.outputAmount <= 0n) continue;

            const s2 = simulateConstantProduct({
                pool: leg.pool,
                venue: pool.venue,
                direction: Dir.AtoB,
                inputAmount: s1.outputAmount,
                poolState: s1.newPoolState,
            });
            if (!s2.success || s2.outputAmount <= candidateInput) continue;

            const gross = s2.outputAmount - candidateInput;
            const net = gross - config.tipLamports - gasCostLamports;
            if (net > bestNet) {
                bestNet = net;
                bestInput = candidateInput;
                bestSwap1Out = s1.outputAmount;
                bestSwap2Out = s2.outputAmount;
            }
        }

        if (bestNet < config.minProfitLamports) return;

        const effectiveSlippageBps = config.executionSlippageBps ?? config.slippageBps;
        const slippageMul = BigInt(10000 - effectiveSlippageBps);
        const swap1MinOut = (bestSwap1Out * slippageMul) / 10000n;
        if (swap1MinOut <= 0n) {
            recordSkip('swap1_min_out_zero', update);
            return;
        }
        const conservativeSwap2Out = bestSwap1Out > 0n
            ? (bestSwap2Out * swap1MinOut) / bestSwap1Out
            : 0n;
        const swap2MinOut = (conservativeSwap2Out * slippageMul) / 10000n;
        if (swap2MinOut <= 0n) {
            recordSkip('swap2_min_out_zero', update);
            return;
        }

        const swap1Params: SwapParams = {
            direction: Dir.BtoA,
            inputAmount: bestInput,
            minOutput: swap1MinOut,
            pool: cp,
        };
        const swap2Params: SwapParams = {
            direction: Dir.AtoB,
            inputAmount: swap1MinOut,
            minOutput: swap2MinOut,
            pool: cp,
        };

        if (
            !isU64(swap1Params.inputAmount) ||
            !isU64(swap1Params.minOutput) ||
            !isU64(swap2Params.inputAmount) ||
            !isU64(swap2Params.minOutput)
        ) {
            recordSkip('amount_overflow_u64', update);
            return;
        }

        let victimTxBytes: Uint8Array | undefined;
        if (includeVictimTx) {
            const victimTx = buildVictimTxBytes(update);
            if (!victimTx.ok) {
                recordSkip(victimTx.reason, update);
                return;
            }
            victimTxBytes = victimTx.bytes;
        }

        const result = buildBundle(
            swap1Params,
            swap2Params,
            config.payerKeypair,
            bundleConfig,
            config.getRecentBlockhash(),
            victimTxBytes,
        );

        if (!result.success || !result.bundle) return;
        const builtBundle = result.bundle;

        stats.opportunitiesFound++;
        stats.bundlesBuilt++;

        if (config.dryRun) {
            stats.bundlesSubmitted++;
            stats.totalProfitLamports += bestNet;
            return;
        }

        const canaryBlock = reserveCanarySubmission(bestInput);
        if (canaryBlock) {
            recordSkip(canaryBlock, update);
            return;
        }
        const opportunityKey = `${toHex(update.signature)}|legacy|${toHex(leg.pool)}|${bestInput.toString()}`;
        const dupBlock = reserveOpportunityKey(opportunityKey);
        if (dupBlock) {
            recordSkip(dupBlock, update);
            return;
        }
        const ageBaseMs = receivedAtMs ?? Date.now();
        if (maxOpportunityAgeMs > 0 && Date.now() - ageBaseMs > maxOpportunityAgeMs) {
            recordSkip('opportunity_stale_before_submit', update);
            return;
        }
        const submitRateBlock = reserveSubmissionSlot();
        if (submitRateBlock) {
            recordSkip(submitRateBlock, update);
            return;
        }

        void (async () => {
            if (maxOpportunityAgeMs > 0 && Date.now() - ageBaseMs > maxOpportunityAgeMs) {
                recordSkip('opportunity_stale_at_submit', update);
                return;
            }
            let submitBundle = builtBundle;
            if (config.refreshRecentBlockhash) {
                const refreshed = await config.refreshRecentBlockhash();
                if (!refreshed) {
                    bumpReason(stats.skipReasons, 'submit_blockhash_refresh_failed');
                    return;
                }
                const victimPumpRemaining = decodedTx
                    ? getPumpRemainingAccountsFromVictim(decodedTx, update.message, leg)
                    : null;
                const rebuiltSwap1: SwapParams = { ...swap1Params, pumpRemainingAccounts: victimPumpRemaining ?? undefined };
                const rebuiltSwap2: SwapParams = { ...swap2Params, pumpRemainingAccounts: victimPumpRemaining ?? undefined };
                const rebuilt = buildBundle(
                    rebuiltSwap1,
                    rebuiltSwap2,
                    config.payerKeypair,
                    bundleConfig,
                    config.getRecentBlockhash(),
                    victimTxBytes,
                );
                if (rebuilt.success && rebuilt.bundle) {
                    submitBundle = rebuilt.bundle;
                } else {
                    bumpReason(stats.skipReasons, 'submit_retry_build_failed');
                    return;
                }
            }

            const primary = await config.jitoClient.submitWithRetry(submitBundle);
            let finalResult = primary;
            if (!finalResult.submitted && isExpiredBlockhashSubmissionError(finalResult.error)) {
                await config.refreshRecentBlockhash?.(true);
                const rebuilt = buildBundle(
                    swap1Params,
                    swap2Params,
                    config.payerKeypair,
                    bundleConfig,
                    config.getRecentBlockhash(),
                    victimTxBytes,
                );
                if (rebuilt.success && rebuilt.bundle) {
                    const retried = await config.jitoClient.submitWithRetry(rebuilt.bundle);
                    finalResult = retried;
                    bumpReason(
                        stats.skipReasons,
                        retried.submitted ? 'submit_retry_fresh_blockhash_success' : 'submit_retry_fresh_blockhash_failed',
                    );
                } else {
                    bumpReason(stats.skipReasons, 'submit_retry_build_failed');
                }
            }
            if (!primary.submitted && isAlreadyProcessedSubmissionError(primary.error)) {
                const fallbackBundle = buildFallbackBundleWithoutVictim(builtBundle);
                if (fallbackBundle) {
                    bumpReason(stats.skipReasons, 'submit_victim_already_processed');
                    const fallback = await config.jitoClient.submitWithRetry(fallbackBundle);
                    finalResult = fallback;
                    bumpReason(stats.skipReasons, fallback.submitted ? 'submit_fallback_success' : 'submit_fallback_failed');
                }
            }
            if (!finalResult.submitted) {
                bumpReason(stats.skipReasons, 'submit_failed');
                const classified = classifySubmitError(finalResult.error);
                if (classified) {
                    bumpReason(stats.skipReasons, classified);
                }
                return;
            }
            if (!reserveSubmittedBundleId(finalResult.bundleId)) {
                bumpReason(stats.skipReasons, 'submit_duplicate_bundle_id');
                return;
            }
            stats.bundlesSubmitted++;
            stats.totalProfitLamports += bestNet;
        })().catch(() => {
            // tracked by submit client
        });
    }

    return {
        handleShredEvent,
        handleCacheEvent,
        flushShadowSummary: () => maybeWriteShadowSummary(true),
        getStats: (): BackrunStats => {
            stats.pairIndex = pairIndex.stats();
            return {
                ...stats,
                skipReasons: { ...stats.skipReasons },
            };
        },
    };
}
