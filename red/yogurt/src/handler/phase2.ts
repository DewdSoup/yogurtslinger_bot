/**
 * Phase 2 Handler
 *
 * Connects Phase 1 (gRPC ingest) to Phase 2 (pool/vault caches).
 * Routes account updates to decoders and stores results.
 *
 * ALL cache mutations go through commitAccountUpdate() - the single canonical commit function.
 */

import type { IngestEvent, PoolState } from '../types.js';
import { decodeAccount, isTargetProgram, getDecodeMetrics, resetDecodeMetrics } from '../decode/account.js';
import { decodeTokenAccountAmount } from '../decode/vault.js';
import { PoolCache } from '../cache/pool.js';
import { VaultCache } from '../cache/vault.js';
import { TickCache } from '../cache/tick.js';
import { BinCache } from '../cache/bin.js';
import { AmmConfigCache } from '../cache/ammConfig.js';
import { GlobalConfigCache } from '../cache/globalConfig.js';
import { commitAccountUpdate, type CacheRegistry } from '../cache/commit.js';
import { createLifecycleRegistry } from '../cache/lifecycle.js';

// SPL Token program ID bytes
const SPL_TOKEN_BYTES = new Uint8Array([
    0x06, 0xdd, 0xf6, 0xe1, 0xd7, 0x65, 0xa1, 0x93,
    0xd9, 0xcb, 0xe1, 0x46, 0xce, 0xeb, 0x79, 0xac,
    0x1c, 0xb4, 0x85, 0xed, 0x5f, 0x5b, 0x37, 0x91,
    0x3a, 0x8c, 0xf5, 0x85, 0x7e, 0xff, 0x00, 0xa9,
]);

// Token-2022 program ID: TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
const SPL_TOKEN_2022_BYTES = new Uint8Array([
    0x06, 0xdd, 0xf6, 0xe1, 0xee, 0x75, 0x8f, 0xde,
    0x18, 0x42, 0x5d, 0xbc, 0xe4, 0x6c, 0xcd, 0xda,
    0xb6, 0x1a, 0xfc, 0x4d, 0x83, 0xb9, 0x0d, 0x27,
    0xfe, 0xbd, 0xf9, 0x28, 0xd8, 0xa1, 0x8b, 0xfc,
]);

/**
 * Fast byte comparison
 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/**
 * Check if owner is SPL Token or Token-2022
 */
function isTokenProgram(owner: Uint8Array): boolean {
    return bytesEqual(owner, SPL_TOKEN_BYTES) || bytesEqual(owner, SPL_TOKEN_2022_BYTES);
}

export interface Phase2Handler {
    registry: CacheRegistry;
    poolCache: PoolCache;
    vaultCache: VaultCache;
    handle: (event: IngestEvent) => void;
    getStats: () => Phase2Stats;
}

export interface Phase2Stats {
    poolUpdates: bigint;
    vaultUpdates: bigint;
    decodeSuccess: number;
    poolCacheSize: number;
    vaultCacheSize: number;
}

/**
 * Create Phase 2 handler
 */
export function createPhase2Handler(): Phase2Handler {
    // Create lifecycle registry for RPC containment
    const lifecycle = createLifecycleRegistry();

    // Create full cache registry with lifecycle enforcement
    const registry: CacheRegistry = {
        pool: new PoolCache(),
        vault: new VaultCache(),
        tick: new TickCache(),
        bin: new BinCache(),
        ammConfig: new AmmConfigCache(),
        globalConfig: new GlobalConfigCache(),
        lifecycle,  // RPC containment enforcement
    };

    let poolUpdates = 0n;
    let vaultUpdates = 0n;

    // Set of known vault pubkeys (hex) to track
    const trackedVaults = new Set<string>();

    function toHex(pubkey: Uint8Array): string {
        let key = '';
        for (let i = 0; i < 32; i++) {
            key += pubkey[i].toString(16).padStart(2, '0');
        }
        return key;
    }

    function handle(event: IngestEvent): void {
        if (event.type !== 'account') return;

        const update = event.update;

        // Try pool decode first
        if (isTargetProgram(update.owner)) {
            const result = decodeAccount(update);
            if (result.success && result.pool) {
                // Register pool discovery with lifecycle (enables RPC for dependencies)
                lifecycle.discover(update.pubkey, update.slot);

                // Use canonical commit function
                commitAccountUpdate(registry, {
                    type: 'pool',
                    pubkey: update.pubkey,
                    state: result.pool,
                    slot: update.slot,
                    writeVersion: update.writeVersion,
                    dataLength: update.data.length,
                    source: 'grpc',
                });
                poolUpdates++;

                // Track vaults from decoded pool
                trackPoolVaults(result.pool);
            }
            return;
        }

        // Try vault decode (SPL Token accounts)
        if (isTokenProgram(update.owner)) {
            const pubkeyHex = toHex(update.pubkey);

            // Only decode if this is a tracked vault
            if (trackedVaults.has(pubkeyHex)) {
                const amount = decodeTokenAccountAmount(update.data);
                if (amount !== null) {
                    // Use canonical commit function
                    commitAccountUpdate(registry, {
                        type: 'vault',
                        pubkey: update.pubkey,
                        amount,
                        slot: update.slot,
                        writeVersion: update.writeVersion,
                        dataLength: update.data.length,
                        source: 'grpc',
                    });
                    vaultUpdates++;
                }
            }
        }
    }

    function trackPoolVaults(pool: PoolState): void {
        switch (pool.venue) {
            case 0: // PumpSwap
                trackedVaults.add(toHex(pool.baseVault));
                trackedVaults.add(toHex(pool.quoteVault));
                break;
            case 1: // Raydium V4
                trackedVaults.add(toHex(pool.baseVault));
                trackedVaults.add(toHex(pool.quoteVault));
                break;
            case 2: // Raydium CLMM
                trackedVaults.add(toHex(pool.tokenVault0));
                trackedVaults.add(toHex(pool.tokenVault1));
                break;
            case 3: // Meteora DLMM
                trackedVaults.add(toHex(pool.vaultX));
                trackedVaults.add(toHex(pool.vaultY));
                break;
        }
    }

    function getStats(): Phase2Stats {
        const metrics = getDecodeMetrics();
        // Success rate = pools decoded / pools identified (not all accounts)
        const successRate = metrics.poolsIdentified > 0n
            ? Number((metrics.poolsDecoded * 10000n) / metrics.poolsIdentified) / 10000
            : 1.0;

        return {
            poolUpdates,
            vaultUpdates,
            decodeSuccess: successRate,
            poolCacheSize: registry.pool.stats().size,
            vaultCacheSize: registry.vault.stats().size,
        };
    }

    return {
        registry,
        poolCache: registry.pool,
        vaultCache: registry.vault,
        handle,
        getStats,
    };
}

/**
 * Reset handler metrics
 */
export function resetPhase2Metrics(): void {
    resetDecodeMetrics();
}