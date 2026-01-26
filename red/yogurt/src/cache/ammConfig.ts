/**
 * CLMM AmmConfig Cache (Phase 5 - INF-3)
 *
 * Caches fee rates from Raydium CLMM ammConfig accounts.
 * AmmConfig accounts contain the tradeFeeRate that varies by pool tier:
 * - 1 bps (0.01%)
 * - 4 bps (0.04%)
 * - 25 bps (0.25%) - most common
 * - 100 bps (1%)
 *
 * These accounts are referenced by pool.ammConfig and rarely change,
 * so we cache them during bootstrap and inject feeRate into pool state.
 */

import type { CacheStats, AmmConfigEntry, CacheTraceHandler, CacheUpdateResult } from './types.js';

/**
 * Key wrapper for Map usage
 */
function toKey(pubkey: Uint8Array): string {
    let key = '';
    for (let i = 0; i < 32; i++) {
        key += pubkey[i].toString(16).padStart(2, '0');
    }
    return key;
}

/**
 * Convert hex key back to Uint8Array
 */
function fromKey(hex: string): Uint8Array {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

export class AmmConfigCache {
    private cache: Map<string, AmmConfigEntry> = new Map();
    private hitCount = 0n;
    private missCount = 0n;
    private lastUpdateSlot = 0;
    private traceHandler?: CacheTraceHandler;

    /**
     * Set trace handler for evidence capture
     */
    setTraceHandler(handler: CacheTraceHandler): void {
        this.traceHandler = handler;
    }

    /**
     * Get fee rate by ammConfig pubkey
     */
    get(pubkey: Uint8Array): AmmConfigEntry | null {
        const key = toKey(pubkey);
        const entry = this.cache.get(key);
        if (entry) {
            this.hitCount++;
            return entry;
        }
        this.missCount++;
        return null;
    }

    /**
     * Set fee rate for ammConfig
     *
     * @param pubkey - AmmConfig account pubkey
     * @param feeRate - Fee rate in basis points (bigint)
     * @param slot - Slot of the update
     * @param writeVersion - Write version (from gRPC, or 0n for bootstrap)
     * @param dataLength - MANDATORY: Account data length for trace metadata
     * @param source - MANDATORY: 'grpc' or 'bootstrap' for trace metadata
     * @returns CacheUpdateResult indicating if update was applied
     */
    set(pubkey: Uint8Array, feeRate: bigint, slot: number, writeVersion: bigint, dataLength: number, source: 'grpc' | 'bootstrap'): CacheUpdateResult {
        const key = toKey(pubkey);
        const existing = this.cache.get(key);

        // Staleness check: (slot, writeVersion) monotonicity
        if (existing) {
            if (slot < existing.slot || (slot === existing.slot && writeVersion <= existing.writeVersion)) {
                if (this.traceHandler) {
                    this.traceHandler({
                        cacheType: 'ammConfig',
                        pubkey,
                        slot,
                        writeVersion,
                        appliedAtMs: Date.now(),
                        dataLength,
                        source,
                        rejected: true,
                        existingSlot: existing.slot,
                        reason: 'stale',
                    });
                }
                return { updated: false, wasStale: true, previousSlot: existing.slot };
            }
        }

        this.cache.set(key, { feeRate, slot, writeVersion, source });
        if (slot > this.lastUpdateSlot) {
            this.lastUpdateSlot = slot;
        }

        // Emit trace for evidence capture
        if (this.traceHandler) {
            this.traceHandler({
                cacheType: 'ammConfig',
                pubkey,
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
            previousSlot: existing?.slot,
        };
    }

    /**
     * Get ammConfig entry with full metadata (Phase 2: for convergence check)
     * Returns same as get() but named for clarity
     */
    getEntry(pubkey: Uint8Array): AmmConfigEntry | null {
        return this.get(pubkey);
    }

    /**
     * Check if ammConfig is cached
     */
    has(pubkey: Uint8Array): boolean {
        return this.cache.has(toKey(pubkey));
    }

    /**
     * Get all cached ammConfig pubkeys
     */
    keys(): Uint8Array[] {
        const result: Uint8Array[] = [];
        for (const key of this.cache.keys()) {
            result.push(fromKey(key));
        }
        return result;
    }

    /**
     * Get all entries with their pubkeys
     * Used for cache snapshots during evidence capture
     */
    getAll(): Array<{ pubkey: Uint8Array; feeRate: bigint; slot: number }> {
        const result: Array<{ pubkey: Uint8Array; feeRate: bigint; slot: number }> = [];
        for (const [key, entry] of this.cache.entries()) {
            result.push({
                pubkey: fromKey(key),
                feeRate: entry.feeRate,
                slot: entry.slot,
            });
        }
        return result;
    }

    /**
     * Iterate over all entries (generator)
     */
    *entries(): Generator<[Uint8Array, AmmConfigEntry]> {
        for (const [key, entry] of this.cache.entries()) {
            yield [fromKey(key), entry];
        }
    }

    /**
     * Get cache size
     */
    get size(): number {
        return this.cache.size;
    }

    /**
     * Get cache statistics
     */
    stats(): CacheStats {
        return {
            size: this.cache.size,
            hitCount: this.hitCount,
            missCount: this.missCount,
            evictionCount: 0n,
            lastUpdateSlot: this.lastUpdateSlot,
        };
    }

    /**
     * Clear all entries
     */
    clear(): void {
        this.cache.clear();
    }
}

/**
 * Create ammConfig cache instance
 */
export function createAmmConfigCache(): AmmConfigCache {
    return new AmmConfigCache();
}