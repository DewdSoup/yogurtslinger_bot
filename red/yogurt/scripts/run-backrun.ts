/**
 * CPMM Backrun Executor (PumpSwap + RaydiumV4)
 *
 * End-to-end: gRPC L1 cache + ShredStream pending txs → backrun detection → Jito submission.
 *
 * Usage:
 *   KEYPAIR_PATH=./keypair.json npx tsx scripts/run-backrun.ts
 *
 * Env vars:
 *   GRPC_ENDPOINT          gRPC endpoint (default: 127.0.0.1:10000)
 *   SHRED_ENDPOINT         ShredStream endpoint (default: 127.0.0.1:11000)
 *   JITO_ENDPOINT          Jito block engine (default: mainnet.block-engine.jito.wtf)
 *   KEYPAIR_PATH           Path to JSON keypair file (required)
 *   JITO_AUTH_KEYPAIR_PATH Path to Jito auth keypair (optional, uses KEYPAIR_PATH if unset)
 *   MIN_PROFIT_SOL         Min profit threshold (default: 0.001)
 *   TIP_SOL                Jito tip amount (default: 0.001)
 *   CU_PRICE_MICROLAMPORTS Priority fee (default: 1000)
 *   SLIPPAGE_BPS           Slippage tolerance (default: 100 = 1%)
 *   DRY_RUN                Log opportunities without submitting to Jito (default: 0)
 *   DEBUG                  Enable verbose logging (default: 0)
 */

import { readFileSync } from 'fs';
import { Keypair } from '@solana/web3.js';
import { PROGRAM_IDS } from '../src/types.js';
import { createGrpcConsumer } from '../src/ingest/grpc.js';
import { createShredStreamConsumer } from '../src/ingest/shred.js';
import { createPhase3Handler } from '../src/handler/phase3.js';
import { createBackrunEngine } from '../src/execute/backrun.js';
import { createJitoClient } from '../src/execute/submit.js';

// ============================================================================
// Config from env
// ============================================================================

const GRPC_ENDPOINT = process.env.GRPC_ENDPOINT ?? '127.0.0.1:10000';
const SHRED_ENDPOINT = process.env.SHRED_ENDPOINT ?? '127.0.0.1:11000';
const JITO_ENDPOINT = process.env.JITO_ENDPOINT ?? 'mainnet.block-engine.jito.wtf';
const KEYPAIR_PATH = process.env.KEYPAIR_PATH;
const JITO_AUTH_PATH = process.env.JITO_AUTH_KEYPAIR_PATH;
const MIN_PROFIT_SOL = Number(process.env.MIN_PROFIT_SOL ?? '0.001');
const TIP_SOL = Number(process.env.TIP_SOL ?? '0.001');
const CU_PRICE = BigInt(process.env.CU_PRICE_MICROLAMPORTS ?? '1000');
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? '100');
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

// ============================================================================
// Main
// ============================================================================

async function main() {
    // 1. Load keypairs
    if (!KEYPAIR_PATH) {
        console.error('KEYPAIR_PATH is required');
        process.exit(1);
    }
    const payer = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_PATH, 'utf-8'))),
    );
    console.log(`[backrun] payer=${payer.publicKey.toBase58()}`);
    if (DRY_RUN) {
        console.log('[backrun] *** DRY RUN MODE — bundles will NOT be submitted to Jito ***');
    }

    let jitoAuthKeypair: Keypair | undefined;
    if (JITO_AUTH_PATH) {
        jitoAuthKeypair = Keypair.fromSecretKey(
            Uint8Array.from(JSON.parse(readFileSync(JITO_AUTH_PATH, 'utf-8'))),
        );
    }

    // 2. Start gRPC consumer → L1 cache (all 4 venues for full coverage)
    //    blocks_meta subscription provides blockhash as L1 local state.
    //    ZERO RPC — everything comes from the gRPC stream.
    const grpcConsumer = createGrpcConsumer(
        Object.values(PROGRAM_IDS),
        GRPC_ENDPOINT,
    );

    const phase3 = createPhase3Handler({
        rpcEndpoint: GRPC_ENDPOINT,
        grpcConsumer,
    });

    // Wire gRPC events → phase3 cache handler
    grpcConsumer.onEvent(phase3.handle);

    console.log('[backrun] starting L1 cache (gRPC)...');
    await phase3.start();
    console.log('[backrun] L1 cache active');

    // 3. Wait for blockhash from L1 (blocks_meta stream)
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

    // 4. Create Jito client (connect even in dry-run for stats tracking)
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

    // 5. Create backrun engine
    const engine = createBackrunEngine({
        poolCache: phase3.poolCache,
        vaultCache: phase3.vaultCache,
        payerKeypair: payer,
        jitoClient,
        minProfitLamports: BigInt(Math.floor(MIN_PROFIT_SOL * 1e9)),
        tipLamports: BigInt(Math.floor(TIP_SOL * 1e9)),
        computeUnitLimit: 200_000,
        computeUnitPrice: CU_PRICE,
        slippageBps: SLIPPAGE_BPS,
        getRecentBlockhash: () => {
            const cached = grpcConsumer.getCachedBlockhash();
            return cached ? cached.blockhash : bh.blockhash;
        },
        dryRun: DRY_RUN,
    });

    // 6. Start ShredStream → wire to backrun engine
    const shredConsumer = createShredStreamConsumer(SHRED_ENDPOINT);
    shredConsumer.onEvent(engine.handleShredEvent);
    await shredConsumer.start();
    console.log(`[backrun] shredstream connected → ${SHRED_ENDPOINT}`);
    console.log(`[backrun] LIVE — watching for PumpSwap + RaydiumV4 backrun opportunities${DRY_RUN ? ' (DRY RUN)' : ''}`);

    // 7. Stats every 10s
    const statsInterval = setInterval(() => {
        const s = engine.getStats();
        const p3 = phase3.getStats();
        const j = DRY_RUN ? { bundlesLanded: 0n } : jitoClient.getStats();
        console.log(
            `[stats] shred_txs=${s.shredTxsReceived} swaps=${s.swapsDetected} ` +
            `opps=${s.opportunitiesFound} bundles_built=${s.bundlesBuilt} ` +
            `submitted=${s.bundlesSubmitted} jito_landed=${j.bundlesLanded} ` +
            `profit=${(Number(s.totalProfitLamports) / 1e9).toFixed(6)}SOL ` +
            `pools=${p3.poolCacheSize} vaults=${p3.vaultCacheSize}`,
        );
    }, 10_000);
    statsInterval.unref();

    // 8. Graceful shutdown
    let shuttingDown = false;
    const shutdown = async (sig: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`\n[backrun] ${sig} — shutting down`);
        clearInterval(statsInterval);
        try { await shredConsumer.stop(); } catch {}
        const final = engine.getStats();
        console.log(
            `[backrun] final: opps=${final.opportunitiesFound} submitted=${final.bundlesSubmitted} ` +
            `profit=${(Number(final.totalProfitLamports) / 1e9).toFixed(6)}SOL`,
        );
        process.exit(0);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(err => {
    console.error('[backrun] fatal:', err);
    process.exit(1);
});
