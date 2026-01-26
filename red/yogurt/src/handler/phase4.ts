/**
 * Phase 4 Handler — Pending Transaction Pipeline
 *
 * Production boot sequence:
 * 1. Bootstrap ALT cache from hotlist + recent block scan
 * 2. ShredStream delivers pending tx (t0 captured)
 * 3. Decode tx (v0 ALT resolution or legacy)
 * 4. On ALT miss: async fetch → cache → append to hotlist
 * 5. Emit decoded tx for downstream processing (Phase 5)
 *
 * WBS Gates:
 * - G4.1: ALT hit rate ≥99.9%
 * - G4.2: Shred recv → tx decoded p99 < 500μs
 * - G4.3: Decoded key accuracy 100%
 */

import { Connection } from '@solana/web3.js';
import type { IngestEvent, TxUpdate, DecodedTx } from '../types.js';
import type { PendingTxEvent } from '../ingest/types.js';
import type { AltCache } from '../cache/alt.js';
import { decodeTx } from '../decode/tx.js';
import {
    shredstreamWarmup,
    bootstrapAltCache,
    createHotlistUpdater,
    wireAltFetcher,
    type WarmupResult,
    type BootstrapResult,
} from '../pending/altFetcher.js';
import {
    wireAltGrpcFetcher,
    type AltGrpcFetcher,
} from '../pending/altGrpcFetcher.js';

// ============================================================================
// TYPES
// ============================================================================

export interface Phase4HandlerConfig {
    altCache: AltCache;
    /** Path to hotlist file for ALT persistence (optional) */
    hotlistPath?: string;
    /**
     * ALT fetcher mode:
     * - 'grpc': Use Yellowstone gRPC (production, no RPC dependency)
     * - 'rpc': Use RPC (for validation/testing only)
     * - 'none': No async fetching (bootstrap-only mode)
     * Default: 'grpc'
     */
    altFetcherMode?: 'grpc' | 'rpc' | 'none';
    /** gRPC endpoint for ALT fetching (default: 127.0.0.1:10000) */
    grpcEndpoint?: string;
    /** RPC endpoint for ALT fetching when mode='rpc' (default: 127.0.0.1:8899) */
    rpcEndpoint?: string;
    onDecoded?: (decoded: DecodedTx, t0: bigint, t1: bigint) => void;
    onDecodeFailed?: (update: TxUpdate, error: string, altMisses?: Uint8Array[]) => void;
}

export interface Phase4Stats {
    txsReceived: bigint;
    txsDecoded: bigint;
    txsFailedDecode: bigint;
    altHits: bigint;
    altMisses: bigint;
    altHitRate: number;
    decodeLatencyP99Us: number;
}

// ============================================================================
// HANDLER
// ============================================================================

export interface Phase4Handler {
    handle: (event: IngestEvent) => void;
    getStats: () => Phase4Stats;
    resetStats: () => void;
    /** Start the ALT fetcher (required for gRPC mode) */
    startAltFetcher: () => Promise<void>;
    /** Stop the ALT fetcher */
    stopAltFetcher: () => Promise<void>;
    /** Bootstrap ALT cache from hotlist + RPC block scan (recommended) */
    bootstrap: (
        connection: Connection,
        blocksToScan?: number,
        onProgress?: (stage: string, detail: string) => void
    ) => Promise<BootstrapResult>;
    /** @deprecated Use bootstrap() instead */
    warmup: (
        shredstreamEndpoint: string,
        durationMs?: number,
        onProgress?: (stats: { txs: number; alts: number; hitRate: number }) => void
    ) => Promise<WarmupResult>;
}

export function createPhase4Handler(config: Phase4HandlerConfig): Phase4Handler {
    const {
        altCache,
        onDecoded,
        onDecodeFailed,
        hotlistPath,
        altFetcherMode = 'grpc',
        grpcEndpoint = '127.0.0.1:10000',
        rpcEndpoint = '127.0.0.1:8899',
    } = config;

    // Create hotlist updater if path provided
    const updateHotlist = hotlistPath ? createHotlistUpdater(hotlistPath) : null;

    // ALT fetcher instance (gRPC mode only)
    let altGrpcFetcher: AltGrpcFetcher | null = null;

    // Wire up the appropriate fetcher
    if (altFetcherMode === 'grpc') {
        altGrpcFetcher = wireAltGrpcFetcher(altCache, grpcEndpoint, hotlistPath);
        console.log(`[phase4] ALT fetcher mode: gRPC (${grpcEndpoint})`);
    } else if (altFetcherMode === 'rpc') {
        wireAltFetcher(altCache, rpcEndpoint);
        console.log(`[phase4] ALT fetcher mode: RPC (${rpcEndpoint}) - for validation only`);
    } else {
        console.log(`[phase4] ALT fetcher mode: none (bootstrap-only)`);
    }

    let txsReceived = 0n;
    let txsDecoded = 0n;
    let txsFailedDecode = 0n;

    // Latency tracking
    let latencySamples: bigint[] = [];
    const maxSamples = 10000;

    function handle(event: IngestEvent): void {
        if (event.type !== 'tx') return;
        if (event.source !== 'pending') return;

        txsReceived++;

        const update = event.update;
        const t0 = (event as PendingTxEvent).t0 ?? process.hrtime.bigint();

        const result = decodeTx(update, altCache);
        const t1 = process.hrtime.bigint();

        recordLatency(t1 - t0);

        if (result.success && result.tx) {
            txsDecoded++;
            if (onDecoded) {
                onDecoded(result.tx, t0, t1);
            }
        } else {
            txsFailedDecode++;
            if (onDecodeFailed) {
                onDecodeFailed(update, result.error ?? 'Unknown error', result.altMisses);
            }

            // Trigger async ALT fetch for misses + persist to hotlist
            if (result.altMisses) {
                for (const altPubkey of result.altMisses) {
                    altCache.getAsync(altPubkey).catch(() => { });
                    // Persist newly discovered ALT to hotlist
                    if (updateHotlist) updateHotlist(altPubkey);
                }
            }
        }
    }

    function recordLatency(ns: bigint): void {
        latencySamples.push(ns);
        if (latencySamples.length > maxSamples) {
            latencySamples.shift();
        }
    }

    function calculateP99Us(): number {
        if (latencySamples.length === 0) return 0;
        const sorted = [...latencySamples].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const idx = Math.floor(sorted.length * 0.99);
        const p99Ns = sorted[idx] ?? sorted[sorted.length - 1]!;
        return Number(p99Ns / 1000n);
    }

    function getStats(): Phase4Stats {
        const cacheStats = altCache.stats();
        const total = cacheStats.hitCount + cacheStats.missCount;
        const hitRate = total > 0n
            ? Number((cacheStats.hitCount * 10000n) / total) / 100
            : 100;

        return {
            txsReceived,
            txsDecoded,
            txsFailedDecode,
            altHits: cacheStats.hitCount,
            altMisses: cacheStats.missCount,
            altHitRate: hitRate,
            decodeLatencyP99Us: calculateP99Us(),
        };
    }

    function resetStats(): void {
        txsReceived = 0n;
        txsDecoded = 0n;
        txsFailedDecode = 0n;
        latencySamples = [];
        altCache.resetMetrics();
    }

    async function bootstrap(
        connection: Connection,
        blocksToScan: number = 500,
        onProgress?: (stage: string, detail: string) => void
    ): Promise<BootstrapResult> {
        if (!hotlistPath) {
            throw new Error('hotlistPath must be set in config to use bootstrap');
        }

        console.log(`[phase4] Starting ALT bootstrap...`);

        const result = await bootstrapAltCache(altCache, connection, {
            hotlistPath,
            blocksToScan,
            onProgress,
        });

        console.log(`[phase4] Bootstrap complete: ${result.totalAltsCached} ALTs cached`);

        // Reset metrics after bootstrap
        altCache.resetMetrics();

        return result;
    }

    /** @deprecated Use bootstrap() instead */
    async function warmup(
        shredstreamEndpoint: string,
        durationMs: number = 300_000,
        onProgress?: (stats: { txs: number; alts: number; hitRate: number }) => void
    ): Promise<WarmupResult> {
        console.log(`[phase4] Starting ALT cache warmup (${durationMs / 1000}s)...`);

        const result = await shredstreamWarmup(altCache, shredstreamEndpoint, durationMs, onProgress);

        console.log(`[phase4] Warmup complete: ${result.altsDiscovered} ALTs, ${result.finalHitRate.toFixed(1)}% hit rate`);

        // Reset metrics after warmup
        altCache.resetMetrics();

        return result;
    }

    async function startAltFetcher(): Promise<void> {
        if (altGrpcFetcher) {
            await altGrpcFetcher.start();
            console.log('[phase4] gRPC ALT fetcher started');
        }
    }

    async function stopAltFetcher(): Promise<void> {
        if (altGrpcFetcher) {
            await altGrpcFetcher.stop();
            console.log('[phase4] gRPC ALT fetcher stopped');
        }
    }

    return { handle, getStats, resetStats, startAltFetcher, stopAltFetcher, bootstrap, warmup };
}