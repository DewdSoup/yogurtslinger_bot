#!/usr/bin/env tsx

/**
 * Backrun Executor
 *
 * End-to-end: gRPC L1 cache + ShredStream pending txs → backrun detection → Jito submission.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

import { PROGRAM_IDS } from '../src/types.js';
import { createGrpcConsumer } from '../src/ingest/grpc.js';
import { createShredStreamConsumer } from '../src/ingest/shred.js';
import { createPhase3Handler } from '../src/handler/phase3.js';
import { createBackrunEngine, type StrategyMode } from '../src/execute/backrun.js';
import { createJitoClient } from '../src/execute/submit.js';
import { setMintProgramOverride } from '../src/execute/bundle.js';
import { createAltCache } from '../src/cache/alt.js';
import { createAltGrpcFetcher } from '../src/pending/altGrpcFetcher.js';

const CANONICAL_KEY_DIR = '/home/dudesoup/jito/keys';
const DEFAULT_HOT_KEY = `${CANONICAL_KEY_DIR}/yogurtslinger-hot.json`;
const DEFAULT_BUNDLE_KEY = `${CANONICAL_KEY_DIR}/jito-bundles.json`;
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// ============================================================================
// Config from env
// ============================================================================

const GRPC_ENDPOINT = process.env.GRPC_ENDPOINT ?? '127.0.0.1:10000';
const SHRED_ENDPOINT = process.env.SHRED_ENDPOINT ?? '127.0.0.1:11000';
const RPC_ENDPOINT = process.env.RPC_ENDPOINT ?? 'http://127.0.0.1:8899';
const BLOCKHASH_RPC_ENDPOINT = process.env.BLOCKHASH_RPC_ENDPOINT ?? RPC_ENDPOINT;
const JITO_ENDPOINT = process.env.JITO_ENDPOINT ?? 'mainnet.block-engine.jito.wtf';

const ALLOW_NON_CANONICAL_KEYS = process.env.ALLOW_NON_CANONICAL_KEYS === '1';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const KEYPAIR_PATH = process.env.KEYPAIR_PATH ?? DEFAULT_HOT_KEY;
const JITO_AUTH_PATH = process.env.JITO_AUTH_KEYPAIR_PATH ?? (DRY_RUN ? '' : DEFAULT_BUNDLE_KEY);

const STRATEGY_MODE = (process.env.STRATEGY_MODE ?? 'cross_venue_ps_dlmm') as StrategyMode;
const SHADOW_LEDGER_PATH = process.env.SHADOW_LEDGER_PATH ?? 'data/evidence';
const LIVE_DATA_PATH = process.env.LIVE_DATA_PATH ?? 'data/live';

const MIN_PROFIT_SOL = Number(process.env.MIN_PROFIT_SOL ?? '0.001');
const TIP_SOL = Number(process.env.TIP_SOL ?? '0.001');
const CU_PRICE = BigInt(process.env.CU_PRICE_MICROLAMPORTS ?? '1000');
const CU_LIMIT = Number(process.env.CU_LIMIT ?? '500000');
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? '100');
const EXECUTION_SLIPPAGE_BPS = Number(process.env.EXECUTION_SLIPPAGE_BPS ?? `${SLIPPAGE_BPS}`);
const MAX_STATE_LAG_SLOTS = Number(process.env.MAX_STATE_LAG_SLOTS ?? '8');
const HAIRCUT_BPS = Number(process.env.CONSERVATIVE_HAIRCUT_BPS ?? '30');
const MAX_NET_TO_INPUT_BPS = Number(process.env.MAX_NET_TO_INPUT_BPS ?? '20000');
const MAX_ABS_NET_SOL = Number(process.env.MAX_ABS_NET_SOL ?? '5');
const CANARY_MAX_INPUT_SOL = Number(process.env.CANARY_MAX_INPUT_SOL ?? '0');
const CANARY_MAX_SUBMISSIONS_PER_HOUR = Number(process.env.CANARY_MAX_SUBMISSIONS_PER_HOUR ?? '0');
const MAX_WALLET_DRAWDOWN_SOL = Number(process.env.MAX_WALLET_DRAWDOWN_SOL ?? '0');
const PHASE3_TICK_ARRAY_RADIUS = Number(process.env.PHASE3_TICK_ARRAY_RADIUS ?? '7');
const PHASE3_BIN_ARRAY_RADIUS = Number(process.env.PHASE3_BIN_ARRAY_RADIUS ?? '7');
const INCLUDE_TOPOLOGY_FROZEN_POOLS = process.env.INCLUDE_TOPOLOGY_FROZEN_POOLS === '1';
const BACKRUN_SIZE_CANDIDATES_SOL = process.env.BACKRUN_SIZE_CANDIDATES_SOL ?? '';
const INCLUDE_VICTIM_TX = process.env.INCLUDE_VICTIM_TX === '1';
const ALT_GRPC_LOG_LEVEL = process.env.ALT_GRPC_LOG_LEVEL ?? 'info';
const ALT_GRPC_SUMMARY_INTERVAL_MS = Number(process.env.ALT_GRPC_SUMMARY_INTERVAL_MS ?? '30000');
const BLOCKHASH_SLOT_LAG_WARN = Number(process.env.BLOCKHASH_SLOT_LAG_WARN ?? '150');
const BLOCKHASH_REFRESH_INTERVAL_MS = Number(process.env.BLOCKHASH_REFRESH_INTERVAL_MS ?? '2000');
const BLOCKHASH_MIN_REFRESH_INTERVAL_MS = Number(process.env.BLOCKHASH_MIN_REFRESH_INTERVAL_MS ?? '1200');

function installPipeErrorGuards(): void {
    const onStreamError = (err: NodeJS.ErrnoException) => {
        if (err?.code === 'EPIPE') {
            process.exit(0);
        }
    };
    process.stdout.on('error', onStreamError);
    process.stderr.on('error', onStreamError);
}

function validateKeyPath(rawPath: string, label: string): string {
    const resolved = path.resolve(rawPath);
    const usesLegacyConfig = resolved.includes('/.config/solana/');
    const isCanonical = resolved.startsWith(`${CANONICAL_KEY_DIR}/`);

    if ((usesLegacyConfig || !isCanonical) && !ALLOW_NON_CANONICAL_KEYS) {
        throw new Error(
            `${label} must use canonical key dir (${CANONICAL_KEY_DIR}). ` +
            `resolved=${resolved}. Set ALLOW_NON_CANONICAL_KEYS=1 to override.`,
        );
    }

    if ((usesLegacyConfig || !isCanonical) && ALLOW_NON_CANONICAL_KEYS) {
        console.warn(`[backrun:key] WARNING non-canonical ${label}: ${resolved}`);
    }

    return resolved;
}

function loadKeypair(keyPath: string, label: string): Keypair {
    const secret = Uint8Array.from(JSON.parse(readFileSync(keyPath, 'utf-8')));
    const kp = Keypair.fromSecretKey(secret);
    console.log(`[backrun:key] ${label} path=${keyPath}`);
    console.log(`[backrun:key] ${label} pubkey=${kp.publicKey.toBase58()}`);
    return kp;
}

function writeJsonAtomic(filePath: string, payload: unknown): void {
    const temp = `${filePath}.tmp`;
    writeFileSync(temp, JSON.stringify(payload, null, 2));
    renameSync(temp, filePath);
}

function appendJsonl(filePath: string, payload: unknown): void {
    appendFileSync(filePath, `${JSON.stringify(payload)}\n`);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    installPipeErrorGuards();

    const payerPath = validateKeyPath(KEYPAIR_PATH, 'KEYPAIR_PATH');
    const payer = loadKeypair(payerPath, 'payer');
    const runId = `${Date.now()}-${process.pid}`;
    const liveRunDir = path.resolve(LIVE_DATA_PATH, `run-${runId}`);
    const ledgerPath = DRY_RUN ? SHADOW_LEDGER_PATH : liveRunDir;
    const maxWalletDrawdownLamports = BigInt(Math.floor(Math.max(0, MAX_WALLET_DRAWDOWN_SOL) * 1e9));
    const rpcConn = !DRY_RUN
        ? new Connection(RPC_ENDPOINT, 'processed')
        : null;
    const blockhashConn = !DRY_RUN
        ? new Connection(BLOCKHASH_RPC_ENDPOINT, 'processed')
        : null;
    let startWalletBalanceLamports: bigint | null = null;
    let latestWalletBalanceLamports: bigint | null = null;
    let latestRpcBlockhash: string | null = null;
    let latestRpcBlockhashUpdatedAtMs = 0;

    const setLatestBlockhash = (blockhash: string): void => {
        latestRpcBlockhash = blockhash;
        latestRpcBlockhashUpdatedAtMs = Date.now();
    };

    const runBundleResultsJsonl = !DRY_RUN ? path.join(liveRunDir, 'bundle-results.jsonl') : '';
    if (!DRY_RUN) {
        mkdirSync(liveRunDir, { recursive: true });
        console.log(`[backrun] live run dir=${liveRunDir}`);
    }

    if (DRY_RUN) {
        console.log('[backrun] *** DRY RUN MODE — bundles will NOT be submitted to Jito ***');
    }

    let jitoAuthKeypair: Keypair | undefined;
    if (!DRY_RUN) {
        if (!JITO_AUTH_PATH) {
            throw new Error('JITO_AUTH_KEYPAIR_PATH is required in live mode');
        }
        const authPath = validateKeyPath(JITO_AUTH_PATH, 'JITO_AUTH_KEYPAIR_PATH');
        jitoAuthKeypair = loadKeypair(authPath, 'jito_auth');
    } else if (JITO_AUTH_PATH) {
        const authPath = validateKeyPath(JITO_AUTH_PATH, 'JITO_AUTH_KEYPAIR_PATH');
        jitoAuthKeypair = loadKeypair(authPath, 'jito_auth');
    }

    const grpcConsumer = createGrpcConsumer(
        Object.values(PROGRAM_IDS),
        GRPC_ENDPOINT,
    );

    const phase3 = createPhase3Handler({
        rpcEndpoint: RPC_ENDPOINT,
        grpcConsumer,
        tickArrayRadius: PHASE3_TICK_ARRAY_RADIUS,
        binArrayRadius: PHASE3_BIN_ARRAY_RADIUS,
    });

    // Wire gRPC events → phase3 cache handler first.
    grpcConsumer.onEvent(phase3.handle);

    console.log('[backrun] starting L1 cache (gRPC)...');
    await phase3.start();
    console.log('[backrun] L1 cache active');

    const bhWaitStart = Date.now();
    while (!grpcConsumer.getCachedBlockhash()) {
        if (Date.now() - bhWaitStart > 15_000) {
            console.error('[backrun] FATAL: no blockhash from gRPC blocks_meta after 15s');
            process.exit(1);
        }
        await new Promise(r => setTimeout(r, 100));
    }
    const bh = grpcConsumer.getCachedBlockhash()!;
    console.log(`[backrun] blockhash from L1 cache: ${bh.blockhash.slice(0, 12)}... (slot=${bh.slot})`);
    setLatestBlockhash(bh.blockhash);

    const altCache = createAltCache();
    const altFetcher = createAltGrpcFetcher({
        endpoint: GRPC_ENDPOINT,
        altCache,
    });
    altCache.setFetcher(async (pubkey: Uint8Array) => {
        altFetcher.requestAlt(pubkey);
        return null;
    });
    await altFetcher.start();
    console.log('[backrun] ALT fetcher active (gRPC, non-blocking)');

    const jitoClient = createJitoClient({
        endpoint: JITO_ENDPOINT,
        timeoutMs: 5000,
        maxRetries: 3,
    });
    if (!DRY_RUN) {
        jitoClient.connect(jitoAuthKeypair ?? payer);
        jitoClient.setBundleResultListener((event) => {
            if (!runBundleResultsJsonl) return;
            appendJsonl(runBundleResultsJsonl, {
                ts: new Date().toISOString(),
                runId,
                ...event,
            });
        });
        jitoClient.subscribeBundleResults();
        console.log(`[backrun] jito connected → ${JITO_ENDPOINT}`);
    } else {
        console.log('[backrun] jito skipped (dry-run)');
    }

    if (!DRY_RUN && rpcConn) {
        try {
            const bal = await rpcConn.getBalance(payer.publicKey, 'processed');
            startWalletBalanceLamports = BigInt(bal);
            latestWalletBalanceLamports = startWalletBalanceLamports;
            console.log(
                `[backrun] wallet start balance=${(Number(startWalletBalanceLamports) / 1e9).toFixed(6)}SOL ` +
                `drawdownCap=${MAX_WALLET_DRAWDOWN_SOL}`,
            );
        } catch (err) {
            console.warn(`[backrun] wallet drawdown guard disabled (balance fetch failed): ${String(err)}`);
        }
        try {
            const latest = await blockhashConn!.getLatestBlockhash('processed');
            setLatestBlockhash(latest.blockhash);
            console.log(
                `[backrun] blockhash source warm=${latestRpcBlockhash.slice(0, 12)}... ` +
                `endpoint=${BLOCKHASH_RPC_ENDPOINT}`,
            );
        } catch (err) {
            console.warn(`[backrun] blockhash source warm failed (${BLOCKHASH_RPC_ENDPOINT}): ${String(err)}`);
        }
        if (BLOCKHASH_RPC_ENDPOINT !== RPC_ENDPOINT) {
            try {
                const [localSlot, blockhashSlot] = await Promise.all([
                    rpcConn.getSlot('processed'),
                    blockhashConn!.getSlot('processed'),
                ]);
                const lag = blockhashSlot - localSlot;
                if (lag > BLOCKHASH_SLOT_LAG_WARN) {
                    console.warn(
                        `[backrun] WARNING local RPC is behind blockhash source: localSlot=${localSlot} ` +
                        `blockhashSlot=${blockhashSlot} lag=${lag}`,
                    );
                }
            } catch {}
        }
    }

    const runStatsJsonl = !DRY_RUN ? path.join(liveRunDir, 'stats.jsonl') : '';
    const runStatsLatest = !DRY_RUN ? path.join(liveRunDir, 'stats-latest.json') : '';
    const runConfigJson = !DRY_RUN ? path.join(liveRunDir, 'run-config.json') : '';
    const resolvedMintPrograms = new Set<string>();

    async function refreshMintProgramOverrides(): Promise<void> {
        if (!rpcConn) return;
        const allPools = phase3.poolCache.getAll();
        const mintHexes = new Set<string>();
        for (const entry of allPools) {
            const p = entry.state as any;
            if (p.baseMint) mintHexes.add(Buffer.from(p.baseMint).toString('hex'));
            if (p.quoteMint) mintHexes.add(Buffer.from(p.quoteMint).toString('hex'));
            if (p.tokenXMint) mintHexes.add(Buffer.from(p.tokenXMint).toString('hex'));
            if (p.tokenYMint) mintHexes.add(Buffer.from(p.tokenYMint).toString('hex'));
        }
        const unresolved = [...mintHexes]
            .filter(h => !resolvedMintPrograms.has(h))
            .map(h => Buffer.from(h, 'hex'));
        if (unresolved.length === 0) return;

        const chunkSize = 100;
        let resolvedNow = 0;
        for (let i = 0; i < unresolved.length; i += chunkSize) {
            const chunk = unresolved.slice(i, i + chunkSize);
            const pubkeys = chunk.map(b => new PublicKey(b));
            const infos = await rpcConn.getMultipleAccountsInfo(pubkeys, 'processed');
            for (let j = 0; j < chunk.length; j++) {
                const mintBytes = chunk[j]!;
                const mintHex = mintBytes.toString('hex');
                const info = infos[j];
                if (!info?.owner) continue;
                const owner = info.owner.toBase58();
                if (owner !== TOKEN_PROGRAM_ID && owner !== TOKEN_2022_PROGRAM_ID) continue;
                setMintProgramOverride(new Uint8Array(mintBytes), info.owner.toBytes());
                resolvedMintPrograms.add(mintHex);
                resolvedNow++;
            }
        }
        if (resolvedNow > 0) {
            console.log(`[backrun] mint program map refreshed: +${resolvedNow} (total=${resolvedMintPrograms.size})`);
        }
    }
    if (!DRY_RUN) {
        writeJsonAtomic(runConfigJson, {
            runId,
            startedAt: new Date().toISOString(),
            mode: 'live',
            strategyMode: STRATEGY_MODE,
            execution: {
                dryRun: DRY_RUN,
                ledgerPath,
                includeVictimTx: INCLUDE_VICTIM_TX,
                altGrpcLogLevel: ALT_GRPC_LOG_LEVEL,
                altGrpcSummaryIntervalMs: ALT_GRPC_SUMMARY_INTERVAL_MS,
                blockhashRefreshIntervalMs: BLOCKHASH_REFRESH_INTERVAL_MS,
                blockhashMinRefreshIntervalMs: BLOCKHASH_MIN_REFRESH_INTERVAL_MS,
                bundleResultsPath: runBundleResultsJsonl,
                includeTopologyFrozenPools: INCLUDE_TOPOLOGY_FROZEN_POOLS,
                phase3TickArrayRadius: PHASE3_TICK_ARRAY_RADIUS,
                phase3BinArrayRadius: PHASE3_BIN_ARRAY_RADIUS,
                backrunSizeCandidatesSol: BACKRUN_SIZE_CANDIDATES_SOL || 'default_internal',
            },
            endpoints: {
                grpc: GRPC_ENDPOINT,
                shred: SHRED_ENDPOINT,
                rpc: RPC_ENDPOINT,
                blockhashRpc: BLOCKHASH_RPC_ENDPOINT,
                jito: JITO_ENDPOINT,
            },
            keys: {
                payerPath,
                payerPubkey: payer.publicKey.toBase58(),
                jitoAuthPath: JITO_AUTH_PATH || null,
                jitoAuthPubkey: (jitoAuthKeypair ?? payer).publicKey.toBase58(),
            },
            risk: {
                minProfitSol: MIN_PROFIT_SOL,
                tipSol: TIP_SOL,
                computeUnitLimit: CU_LIMIT,
                slippageBps: SLIPPAGE_BPS,
                executionSlippageBps: EXECUTION_SLIPPAGE_BPS,
                conservativeHaircutBps: HAIRCUT_BPS,
                maxNetToInputBps: MAX_NET_TO_INPUT_BPS,
                maxAbsNetSol: MAX_ABS_NET_SOL,
                canaryMaxInputSol: CANARY_MAX_INPUT_SOL,
                canaryMaxSubmissionsPerHour: CANARY_MAX_SUBMISSIONS_PER_HOUR,
                maxWalletDrawdownSol: MAX_WALLET_DRAWDOWN_SOL,
                maxStateLagSlots: MAX_STATE_LAG_SLOTS,
            },
            startWalletBalanceLamports: startWalletBalanceLamports?.toString() ?? null,
            startWalletBalanceSol: startWalletBalanceLamports !== null ? Number(startWalletBalanceLamports) / 1e9 : null,
        });
    }

    const engine = createBackrunEngine({
        poolCache: phase3.poolCache,
        vaultCache: phase3.vaultCache,
        tickCache: phase3.tickCache,
        binCache: phase3.binCache,
        ammConfigCache: phase3.ammConfigCache,
        globalConfigCache: phase3.registry.globalConfig,
        lifecycle: phase3.registry.lifecycle,
        altCache,
        payerKeypair: payer,
        jitoClient,
        strategyMode: STRATEGY_MODE,
        includeTopologyFrozenPools: INCLUDE_TOPOLOGY_FROZEN_POOLS,
        shadowLedgerPath: ledgerPath,
        minProfitLamports: BigInt(Math.floor(MIN_PROFIT_SOL * 1e9)),
        tipLamports: BigInt(Math.floor(TIP_SOL * 1e9)),
        computeUnitLimit: CU_LIMIT,
        computeUnitPrice: CU_PRICE,
        slippageBps: SLIPPAGE_BPS,
        executionSlippageBps: EXECUTION_SLIPPAGE_BPS,
        conservativeHaircutBps: HAIRCUT_BPS,
        maxStateLagSlots: MAX_STATE_LAG_SLOTS,
        maxNetToInputBps: MAX_NET_TO_INPUT_BPS,
        maxAbsoluteNetLamports: BigInt(Math.floor(MAX_ABS_NET_SOL * 1e9)),
        canaryMaxInputLamports: BigInt(Math.floor(Math.max(0, CANARY_MAX_INPUT_SOL) * 1e9)),
        canaryMaxSubmissionsPerHour: Math.max(0, Math.floor(CANARY_MAX_SUBMISSIONS_PER_HOUR)),
        strictSlotConsistency: true,
        includeVictimTx: INCLUDE_VICTIM_TX,
        getRecentBlockhash: () => {
            if (!DRY_RUN && latestRpcBlockhash) return latestRpcBlockhash;
            const cached = grpcConsumer.getCachedBlockhash();
            return cached ? cached.blockhash : bh.blockhash;
        },
        refreshRecentBlockhash: !DRY_RUN && blockhashConn
            ? async (force?: boolean) => {
                if (
                    !force &&
                    latestRpcBlockhash &&
                    latestRpcBlockhashUpdatedAtMs > 0 &&
                    Date.now() - latestRpcBlockhashUpdatedAtMs < BLOCKHASH_MIN_REFRESH_INTERVAL_MS
                ) {
                    return latestRpcBlockhash;
                }
                try {
                    const latest = await blockhashConn.getLatestBlockhash('processed');
                    setLatestBlockhash(latest.blockhash);
                    return latestRpcBlockhash;
                } catch {
                    return null;
                }
            }
            : undefined,
        dryRun: DRY_RUN,
    });

    // Keep pair index live from gRPC account stream.
    grpcConsumer.onEvent(engine.handleCacheEvent);

    if (!DRY_RUN && rpcConn) {
        try {
            await refreshMintProgramOverrides();
        } catch (err) {
            console.warn(`[backrun] mint program preload failed: ${String(err)}`);
        }
        const mintRefreshInterval = setInterval(() => {
            void refreshMintProgramOverrides().catch(() => {});
        }, 60_000);
        mintRefreshInterval.unref();

        if (BLOCKHASH_REFRESH_INTERVAL_MS > 0) {
            const blockhashRefreshInterval = setInterval(() => {
                void (async () => {
                    try {
                        const latest = await blockhashConn!.getLatestBlockhash('processed');
                        setLatestBlockhash(latest.blockhash);
                    } catch {}
                })();
            }, BLOCKHASH_REFRESH_INTERVAL_MS);
            blockhashRefreshInterval.unref();
        }
    }

    const shredConsumer = createShredStreamConsumer(SHRED_ENDPOINT);
    shredConsumer.onEvent(engine.handleShredEvent);
    await shredConsumer.start();

    console.log(`[backrun] shredstream connected → ${SHRED_ENDPOINT}`);
    console.log(`[backrun] strategy=${STRATEGY_MODE} dryRun=${DRY_RUN ? '1' : '0'}`);
    console.log(`[backrun] includeVictimTx=${INCLUDE_VICTIM_TX ? '1' : '0'}`);
    console.log(`[backrun] blockhashRpc=${BLOCKHASH_RPC_ENDPOINT}`);
    console.log(`[backrun] blockhashRefreshIntervalMs=${BLOCKHASH_REFRESH_INTERVAL_MS}`);
    console.log(`[backrun] blockhashMinRefreshIntervalMs=${BLOCKHASH_MIN_REFRESH_INTERVAL_MS}`);
    console.log(`[backrun] altGrpcLogLevel=${ALT_GRPC_LOG_LEVEL} altGrpcSummaryIntervalMs=${ALT_GRPC_SUMMARY_INTERVAL_MS}`);
    console.log(
        `[backrun] phase3 radii tick=${PHASE3_TICK_ARRAY_RADIUS} bin=${PHASE3_BIN_ARRAY_RADIUS} ` +
        `pairIndexIncludeFrozen=${INCLUDE_TOPOLOGY_FROZEN_POOLS ? '1' : '0'}`,
    );
    console.log(
        `[backrun] sanity gates maxNetToInputBps=${MAX_NET_TO_INPUT_BPS} ` +
        `maxAbsNetSol=${MAX_ABS_NET_SOL}`,
    );
    console.log(`[backrun] slippage decision=${SLIPPAGE_BPS}bps execution=${EXECUTION_SLIPPAGE_BPS}bps`);
    console.log(
        `[backrun] canary gates maxInputSol=${CANARY_MAX_INPUT_SOL} ` +
        `maxSubmissionsPerHour=${CANARY_MAX_SUBMISSIONS_PER_HOUR}`,
    );
    if (!DRY_RUN) {
        console.log(`[backrun] live risk guard maxWalletDrawdownSol=${MAX_WALLET_DRAWDOWN_SOL}`);
    }
    if (BACKRUN_SIZE_CANDIDATES_SOL) {
        console.log(`[backrun] size candidates (SOL)=${BACKRUN_SIZE_CANDIDATES_SOL}`);
    }
    console.log(`[backrun] live — watching for opportunities (${DRY_RUN ? 'shadow' : 'submit'})`);

    let shuttingDown = false;
    const shutdown = async (sig: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`\n[backrun] ${sig} — shutting down`);
        clearInterval(statsInterval);

        try { await shredConsumer.stop(); } catch {}
        try { await altFetcher.stop(); } catch {}

        engine.flushShadowSummary();

        const final = engine.getStats();
        const j = DRY_RUN
            ? {
                bundlesLanded: 0n,
                bundlesSent: 0n,
                bundlesFailed: 0n,
                bundlesAccepted: 0n,
                bundlesRejected: 0n,
                bundlesProcessed: 0n,
                bundlesFinalized: 0n,
                bundlesDropped: 0n,
                landingRate: 0,
            }
            : jitoClient.getStats();
        const walletNetLamports = (
            !DRY_RUN &&
            startWalletBalanceLamports !== null &&
            latestWalletBalanceLamports !== null
        )
            ? (latestWalletBalanceLamports - startWalletBalanceLamports)
            : null;
        console.log(
            `[backrun] final: strategy=${final.strategyMode} decode_fail=${final.pendingDecodeFailures} ` +
            `opps=${final.opportunitiesFound} built=${final.bundlesBuilt} submitted=${final.bundlesSubmitted} ` +
            `finalized=${j.bundlesLanded} accepted=${j.bundlesAccepted} rejected=${j.bundlesRejected} dropped=${j.bundlesDropped} ` +
            `pred_profit=${(Number(final.totalProfitLamports) / 1e9).toFixed(6)}SOL ` +
            `wallet_net=${walletNetLamports !== null ? (Number(walletNetLamports) / 1e9).toFixed(6) : 'n/a'}SOL`,
        );
        if (final.shadowFiles) {
            console.log(
                `[backrun] run files: jsonl=${final.shadowFiles.jsonl} ` +
                `opportunities=${final.shadowFiles.opportunitiesJsonl} latest=${final.shadowFiles.latest}` +
                `${!DRY_RUN && runBundleResultsJsonl ? ` bundle_results=${runBundleResultsJsonl}` : ''}`,
            );
        }
        if (!DRY_RUN && runStatsLatest) {
            writeJsonAtomic(runStatsLatest, {
                updatedAt: new Date().toISOString(),
                runId,
                status: 'stopped',
                signal: sig,
                final: {
                    strategy: final.strategyMode,
                    shredTxs: final.shredTxsReceived.toString(),
                    swaps: final.swapsDetected.toString(),
                    opportunities: final.opportunitiesFound.toString(),
                    built: final.bundlesBuilt.toString(),
                    submitted: final.bundlesSubmitted.toString(),
                    landed: j.bundlesLanded.toString(),
                    finalized: j.bundlesLanded.toString(),
                    accepted: j.bundlesAccepted.toString(),
                    rejected: j.bundlesRejected.toString(),
                    dropped: j.bundlesDropped.toString(),
                    predictedProfitLamports: final.totalProfitLamports.toString(),
                    walletBalanceLamports: latestWalletBalanceLamports?.toString() ?? null,
                    startWalletBalanceLamports: startWalletBalanceLamports?.toString() ?? null,
                    walletNetLamports: walletNetLamports?.toString() ?? null,
                },
            });
        }

        process.exit(0);
    };

    let statsTickInFlight = false;
    const statsInterval = setInterval(() => {
        if (statsTickInFlight) return;
        statsTickInFlight = true;
        void (async () => {
        const s = engine.getStats();
        const p3 = phase3.getStats();
        const alt = altFetcher.getStats();
        const submitFailed = s.skipReasons.submit_failed ?? 0n;
        const submitExpiredBh = s.skipReasons.submit_expired_blockhash ?? 0n;
        const submitRateLimited = s.skipReasons.submit_rate_limited ?? 0n;
        const submitRetryFreshOk = s.skipReasons.submit_retry_fresh_blockhash_success ?? 0n;
        const submitRetryFreshFail = s.skipReasons.submit_retry_fresh_blockhash_failed ?? 0n;
        const j = DRY_RUN
            ? {
                bundlesLanded: 0n,
                bundlesSent: 0n,
                bundlesFailed: 0n,
                bundlesAccepted: 0n,
                bundlesRejected: 0n,
                bundlesProcessed: 0n,
                bundlesFinalized: 0n,
                bundlesDropped: 0n,
                landingRate: 0,
            }
            : jitoClient.getStats();
        let drawdownLamports: bigint | null = null;
        let walletNetLamports: bigint | null = null;
        if (!DRY_RUN && rpcConn && startWalletBalanceLamports !== null) {
            try {
                const bal = await rpcConn.getBalance(payer.publicKey, 'processed');
                latestWalletBalanceLamports = BigInt(bal);
                drawdownLamports = startWalletBalanceLamports - latestWalletBalanceLamports;
                walletNetLamports = latestWalletBalanceLamports - startWalletBalanceLamports;
            } catch {}
        }
        console.log(
            `[stats] strategy=${s.strategyMode} shred_txs=${s.shredTxsReceived} decode_fail=${s.pendingDecodeFailures} ` +
            `swaps=${s.swapsDetected} candidates=${s.candidateEvaluations} routes=${s.routeEvaluations} ` +
            `opps=${s.opportunitiesFound} built=${s.bundlesBuilt} submitted=${s.bundlesSubmitted} finalized=${j.bundlesLanded} ` +
            `accepted=${j.bundlesAccepted} rejected=${j.bundlesRejected} dropped=${j.bundlesDropped} ` +
            `submit_fail=${submitFailed} exp_bh=${submitExpiredBh} rl=${submitRateLimited} ` +
            `retry_bh_ok=${submitRetryFreshOk} retry_bh_fail=${submitRetryFreshFail} ` +
            `pred_profit=${(Number(s.totalProfitLamports) / 1e9).toFixed(6)}SOL ` +
            `wallet_net=${walletNetLamports !== null ? (Number(walletNetLamports) / 1e9).toFixed(6) : 'n/a'}SOL ` +
            `pairs=${s.pairIndex.trackedPairs} pools=${s.pairIndex.trackedPools} ` +
            `cachePools=${p3.poolCacheSize} cacheVaults=${p3.vaultCacheSize} ` +
            `alt_req=${alt.altsRequested} alt_ok=${alt.altsFetched} alt_pending=${alt.pendingRequests}`,
        );
        if (!DRY_RUN && runStatsJsonl && runStatsLatest) {
            const payload = {
                ts: new Date().toISOString(),
                runId,
                strategyMode: s.strategyMode,
                counters: {
                    shredTxsReceived: s.shredTxsReceived.toString(),
                    decodeFailures: s.pendingDecodeFailures.toString(),
                    swapsDetected: s.swapsDetected.toString(),
                    candidateEvaluations: s.candidateEvaluations.toString(),
                    routeEvaluations: s.routeEvaluations.toString(),
                    opportunitiesFound: s.opportunitiesFound.toString(),
                    bundlesBuilt: s.bundlesBuilt.toString(),
                    bundlesSubmitted: s.bundlesSubmitted.toString(),
                    predictedProfitLamports: s.totalProfitLamports.toString(),
                },
                infra: {
                    pairIndexPairs: s.pairIndex.trackedPairs,
                    pairIndexPools: s.pairIndex.trackedPools,
                    cachePools: p3.poolCacheSize,
                    cacheVaults: p3.vaultCacheSize,
                    altsRequested: alt.altsRequested.toString(),
                    altsFetched: alt.altsFetched.toString(),
                },
                jito: {
                    bundlesSent: j.bundlesSent.toString(),
                    bundlesLanded: j.bundlesLanded.toString(),
                    bundlesFinalizedAsLanded: j.bundlesLanded.toString(),
                    bundlesFailed: j.bundlesFailed.toString(),
                    bundlesAccepted: j.bundlesAccepted.toString(),
                    bundlesRejected: j.bundlesRejected.toString(),
                    bundlesProcessed: j.bundlesProcessed.toString(),
                    bundlesFinalized: j.bundlesFinalized.toString(),
                    bundlesDropped: j.bundlesDropped.toString(),
                    landingRate: j.landingRate,
                },
                wallet: {
                    startLamports: startWalletBalanceLamports?.toString() ?? null,
                    currentLamports: latestWalletBalanceLamports?.toString() ?? null,
                    drawdownLamports: drawdownLamports?.toString() ?? null,
                    netLamports: walletNetLamports?.toString() ?? null,
                },
                skipReasons: Object.fromEntries(Object.entries(s.skipReasons).map(([k, v]) => [k, v.toString()])),
            };
            appendJsonl(runStatsJsonl, payload);
            writeJsonAtomic(runStatsLatest, payload);
        }
        if (
            !DRY_RUN &&
            maxWalletDrawdownLamports > 0n &&
            drawdownLamports !== null &&
            drawdownLamports > maxWalletDrawdownLamports
        ) {
            console.error(
                `[backrun] drawdown guard triggered: drawdown=${(Number(drawdownLamports) / 1e9).toFixed(6)}SOL ` +
                `cap=${MAX_WALLET_DRAWDOWN_SOL}SOL`,
            );
            void shutdown('DRAWDOWN_GUARD');
            return;
        }
        })().finally(() => {
            statsTickInFlight = false;
        });
    }, 10_000);
    statsInterval.unref();

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(err => {
    console.error('[backrun] fatal:', err);
    process.exit(1);
});
