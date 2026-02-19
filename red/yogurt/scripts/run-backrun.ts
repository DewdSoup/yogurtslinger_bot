#!/usr/bin/env tsx

/**
 * Backrun Executor
 *
 * End-to-end: gRPC L1 cache + ShredStream pending txs → backrun detection → Jito submission.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';

import { PROGRAM_IDS } from '../src/types.js';
import { createGrpcConsumer } from '../src/ingest/grpc.js';
import { createShredStreamConsumer } from '../src/ingest/shred.js';
import { createPhase3Handler } from '../src/handler/phase3.js';
import { createBackrunEngine, type StrategyMode } from '../src/execute/backrun.js';
import { createJitoClient } from '../src/execute/submit.js';
import { createAltCache } from '../src/cache/alt.js';
import { createAltGrpcFetcher } from '../src/pending/altGrpcFetcher.js';

const CANONICAL_KEY_DIR = '/home/dudesoup/jito/keys';
const DEFAULT_HOT_KEY = `${CANONICAL_KEY_DIR}/yogurtslinger-hot.json`;
const DEFAULT_BUNDLE_KEY = `${CANONICAL_KEY_DIR}/jito-bundles.json`;

// ============================================================================
// Config from env
// ============================================================================

const GRPC_ENDPOINT = process.env.GRPC_ENDPOINT ?? '127.0.0.1:10000';
const SHRED_ENDPOINT = process.env.SHRED_ENDPOINT ?? '127.0.0.1:11000';
const RPC_ENDPOINT = process.env.RPC_ENDPOINT ?? 'http://127.0.0.1:8899';
const JITO_ENDPOINT = process.env.JITO_ENDPOINT ?? 'mainnet.block-engine.jito.wtf';

const ALLOW_NON_CANONICAL_KEYS = process.env.ALLOW_NON_CANONICAL_KEYS === '1';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const KEYPAIR_PATH = process.env.KEYPAIR_PATH ?? DEFAULT_HOT_KEY;
const JITO_AUTH_PATH = process.env.JITO_AUTH_KEYPAIR_PATH ?? (DRY_RUN ? '' : DEFAULT_BUNDLE_KEY);

const STRATEGY_MODE = (process.env.STRATEGY_MODE ?? 'cross_venue_ps_dlmm') as StrategyMode;
const SHADOW_LEDGER_PATH = process.env.SHADOW_LEDGER_PATH ?? 'data/evidence';

const MIN_PROFIT_SOL = Number(process.env.MIN_PROFIT_SOL ?? '0.001');
const TIP_SOL = Number(process.env.TIP_SOL ?? '0.001');
const CU_PRICE = BigInt(process.env.CU_PRICE_MICROLAMPORTS ?? '1000');
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? '100');
const MAX_STATE_LAG_SLOTS = Number(process.env.MAX_STATE_LAG_SLOTS ?? '8');
const HAIRCUT_BPS = Number(process.env.CONSERVATIVE_HAIRCUT_BPS ?? '30');
const MAX_NET_TO_INPUT_BPS = Number(process.env.MAX_NET_TO_INPUT_BPS ?? '20000');
const MAX_ABS_NET_SOL = Number(process.env.MAX_ABS_NET_SOL ?? '5');
const PHASE3_TICK_ARRAY_RADIUS = Number(process.env.PHASE3_TICK_ARRAY_RADIUS ?? '7');
const PHASE3_BIN_ARRAY_RADIUS = Number(process.env.PHASE3_BIN_ARRAY_RADIUS ?? '7');
const INCLUDE_TOPOLOGY_FROZEN_POOLS = process.env.INCLUDE_TOPOLOGY_FROZEN_POOLS === '1';
const BACKRUN_SIZE_CANDIDATES_SOL = process.env.BACKRUN_SIZE_CANDIDATES_SOL ?? '';

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

// ============================================================================
// Main
// ============================================================================

async function main() {
    installPipeErrorGuards();

    const payerPath = validateKeyPath(KEYPAIR_PATH, 'KEYPAIR_PATH');
    const payer = loadKeypair(payerPath, 'payer');

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
        jitoClient.subscribeBundleResults();
        console.log(`[backrun] jito connected → ${JITO_ENDPOINT}`);
    } else {
        console.log('[backrun] jito skipped (dry-run)');
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
        shadowLedgerPath: SHADOW_LEDGER_PATH,
        minProfitLamports: BigInt(Math.floor(MIN_PROFIT_SOL * 1e9)),
        tipLamports: BigInt(Math.floor(TIP_SOL * 1e9)),
        computeUnitLimit: 300_000,
        computeUnitPrice: CU_PRICE,
        slippageBps: SLIPPAGE_BPS,
        conservativeHaircutBps: HAIRCUT_BPS,
        maxStateLagSlots: MAX_STATE_LAG_SLOTS,
        maxNetToInputBps: MAX_NET_TO_INPUT_BPS,
        maxAbsoluteNetLamports: BigInt(Math.floor(MAX_ABS_NET_SOL * 1e9)),
        strictSlotConsistency: true,
        getRecentBlockhash: () => {
            const cached = grpcConsumer.getCachedBlockhash();
            return cached ? cached.blockhash : bh.blockhash;
        },
        dryRun: DRY_RUN,
    });

    // Keep pair index live from gRPC account stream.
    grpcConsumer.onEvent(engine.handleCacheEvent);

    const shredConsumer = createShredStreamConsumer(SHRED_ENDPOINT);
    shredConsumer.onEvent(engine.handleShredEvent);
    await shredConsumer.start();

    console.log(`[backrun] shredstream connected → ${SHRED_ENDPOINT}`);
    console.log(`[backrun] strategy=${STRATEGY_MODE} dryRun=${DRY_RUN ? '1' : '0'}`);
    console.log(
        `[backrun] phase3 radii tick=${PHASE3_TICK_ARRAY_RADIUS} bin=${PHASE3_BIN_ARRAY_RADIUS} ` +
        `pairIndexIncludeFrozen=${INCLUDE_TOPOLOGY_FROZEN_POOLS ? '1' : '0'}`,
    );
    console.log(
        `[backrun] sanity gates maxNetToInputBps=${MAX_NET_TO_INPUT_BPS} ` +
        `maxAbsNetSol=${MAX_ABS_NET_SOL}`,
    );
    if (BACKRUN_SIZE_CANDIDATES_SOL) {
        console.log(`[backrun] size candidates (SOL)=${BACKRUN_SIZE_CANDIDATES_SOL}`);
    }
    console.log(`[backrun] live — watching for opportunities (${DRY_RUN ? 'shadow' : 'submit'})`);

    const statsInterval = setInterval(() => {
        const s = engine.getStats();
        const p3 = phase3.getStats();
        const alt = altFetcher.getStats();
        const j = DRY_RUN ? { bundlesLanded: 0n } : jitoClient.getStats();
        console.log(
            `[stats] strategy=${s.strategyMode} shred_txs=${s.shredTxsReceived} decode_fail=${s.pendingDecodeFailures} ` +
            `swaps=${s.swapsDetected} candidates=${s.candidateEvaluations} routes=${s.routeEvaluations} ` +
            `opps=${s.opportunitiesFound} built=${s.bundlesBuilt} submitted=${s.bundlesSubmitted} landed=${j.bundlesLanded} ` +
            `profit=${(Number(s.totalProfitLamports) / 1e9).toFixed(6)}SOL pairs=${s.pairIndex.trackedPairs} pools=${s.pairIndex.trackedPools} ` +
            `cachePools=${p3.poolCacheSize} cacheVaults=${p3.vaultCacheSize} alt_req=${alt.altsRequested} alt_ok=${alt.altsFetched}`,
        );
    }, 10_000);
    statsInterval.unref();

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
        console.log(
            `[backrun] final: strategy=${final.strategyMode} decode_fail=${final.pendingDecodeFailures} ` +
            `opps=${final.opportunitiesFound} built=${final.bundlesBuilt} submitted=${final.bundlesSubmitted} ` +
            `profit=${(Number(final.totalProfitLamports) / 1e9).toFixed(6)}SOL`,
        );
        if (final.shadowFiles) {
            console.log(
                `[backrun] shadow files: jsonl=${final.shadowFiles.jsonl} ` +
                `opportunities=${final.shadowFiles.opportunitiesJsonl} latest=${final.shadowFiles.latest}`,
            );
        }

        process.exit(0);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(err => {
    console.error('[backrun] fatal:', err);
    process.exit(1);
});
