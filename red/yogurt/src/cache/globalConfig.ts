/**
 * PumpSwap GlobalConfig Cache (Phase 5)
 *
 * Caches fee parameters from the PumpSwap GlobalConfig singleton account.
 *
 * GlobalConfig is a single PDA at ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw
 * containing:
 * - lpFeeBps: LP fee in basis points (typically 20 bps)
 * - protocolFeeBps: Protocol fee (typically 5 bps)
 * - coinCreatorFeeBps: Creator fee (0-5 bps variable)
 *
 * Total fee = lpFeeBps + protocolFeeBps + coinCreatorFeeBps = 25-30 bps
 *
 * This cache stores the decoded GlobalConfig so simulation can use
 * accurate fees without RPC calls in the hot path.
 */

import type { CacheStats, CacheTraceHandler, CacheUpdateResult } from './types.js';
import type { PumpSwapGlobalConfig } from '../decode/programs/pumpswap.js';
import { getDefaultPumpSwapFees } from '../decode/programs/pumpswap.js';

// GlobalConfig PDA address (for trace events)
const GLOBAL_CONFIG_PUBKEY = new Uint8Array([
    0xad, 0xf7, 0xa8, 0x1e, 0xbd, 0xef, 0x2d, 0xbf, 0x47, 0x47, 0xb6, 0x5f, 0x04, 0xac, 0xd3, 0xb8,
    0x3f, 0xf8, 0x3c, 0x52, 0x6c, 0x8f, 0x26, 0x42, 0x2f, 0x4d, 0x36, 0x1a, 0x93, 0x6a, 0x64, 0xf9
]); // ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw

export interface GlobalConfigEntry {
    config: PumpSwapGlobalConfig;
    slot: number;
    writeVersion: bigint;
    /** Phase 2: Source of update for convergence validation */
    source: 'grpc' | 'bootstrap';
}

/**
 * GlobalConfig cache for PumpSwap fees
 *
 * Since GlobalConfig is a singleton, this cache is simple:
 * - Only one entry (the GlobalConfig)
 * - Rarely changes (admin-only updates)
 * - If not cached, use defaults
 */
export class GlobalConfigCache {
    private entry: GlobalConfigEntry | null = null;
    private hitCount = 0n;
    private missCount = 0n;
    private traceHandler?: CacheTraceHandler;

    /**
     * Set trace handler for evidence capture
     */
    setTraceHandler(handler: CacheTraceHandler): void {
        this.traceHandler = handler;
    }

    /**
     * Get the cached GlobalConfig
     * Returns null if not cached
     */
    get(): GlobalConfigEntry | null {
        if (this.entry) {
            this.hitCount++;
            return this.entry;
        }
        this.missCount++;
        return null;
    }

    /**
     * Get entry for snapshotting (doesn't affect hit/miss counts)
     * Used by evidence capture to snapshot without side effects
     */
    getEntry(): GlobalConfigEntry | null {
        return this.entry;
    }

    /**
     * Get fees, falling back to defaults if not cached
     */
    getFees(): PumpSwapGlobalConfig {
        return this.entry?.config ?? getDefaultPumpSwapFees();
    }

    /**
     * Get total fee in basis points
     */
    getTotalFeeBps(): bigint {
        const config = this.getFees();
        return config.lpFeeBps + config.protocolFeeBps + config.coinCreatorFeeBps;
    }

    /**
     * Set the GlobalConfig
     *
     * @param config - Decoded GlobalConfig
     * @param slot - Slot of the update
     * @param writeVersion - Write version (from gRPC, or 0n for bootstrap)
     * @param dataLength - MANDATORY: Account data length for trace metadata
     * @param source - MANDATORY: 'grpc' or 'bootstrap' for trace metadata
     * @returns CacheUpdateResult indicating if update was applied
     */
    set(config: PumpSwapGlobalConfig, slot: number, writeVersion: bigint, dataLength: number, source: 'grpc' | 'bootstrap'): CacheUpdateResult {
        const previousSlot = this.entry?.slot;

        // Staleness check: (slot, writeVersion) monotonicity
        if (this.entry) {
            if (slot < this.entry.slot || (slot === this.entry.slot && writeVersion <= this.entry.writeVersion)) {
                if (this.traceHandler) {
                    this.traceHandler({
                        cacheType: 'globalConfig',
                        pubkey: GLOBAL_CONFIG_PUBKEY,
                        slot,
                        writeVersion,
                        appliedAtMs: Date.now(),
                        dataLength,
                        source,
                        rejected: true,
                        existingSlot: this.entry.slot,
                        reason: 'stale',
                    });
                }
                return { updated: false, wasStale: true, previousSlot };
            }
        }

        this.entry = { config, slot, writeVersion, source };

        // Emit trace for evidence capture
        if (this.traceHandler) {
            this.traceHandler({
                cacheType: 'globalConfig',
                pubkey: GLOBAL_CONFIG_PUBKEY,
                slot,
                writeVersion,
                appliedAtMs: Date.now(),
                dataLength,
                source,
            });
        }

        return {
            updated: true,
            wasStale: false,
            previousSlot,
        };
    }

    /**
     * Check if GlobalConfig is cached
     */
    has(): boolean {
        return this.entry !== null;
    }

    /**
     * Get cache statistics
     */
    stats(): CacheStats {
        return {
            size: this.entry ? 1 : 0,
            hitCount: this.hitCount,
            missCount: this.missCount,
            evictionCount: 0n,
            lastUpdateSlot: this.entry?.slot ?? 0,
        };
    }

    /**
     * Clear the cache
     */
    clear(): void {
        this.entry = null;
    }
}

/**
 * Create GlobalConfig cache instance
 */
export function createGlobalConfigCache(): GlobalConfigCache {
    return new GlobalConfigCache();
}