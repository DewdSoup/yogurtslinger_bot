/**
 * Pool State Cache (Phase 2)
 * 
 * Stores decoded pool state for all target venues.
 * Keyed by pool pubkey (32 bytes).
 * 
 * Gate requirements:
 * - Cache vs RPC match: 100% (1k sample)
 * - Memory footprint documented
 */

import type { CacheEntry, PoolState } from '../types.js';
import type { IPoolCache, CacheUpdateResult, CacheStats, CacheTraceHandler } from './types.js';

/**
 * Key wrapper for Map usage
 * Uses hex string as key since Uint8Array equality doesn't work in Map
 */
function toKey(pubkey: Uint8Array): string {
    // Hot path: avoid base58, use hex
    let key = '';
    for (let i = 0; i < 32; i++) {
        key += pubkey[i].toString(16).padStart(2, '0');
    }
    return key;
}

export class PoolCache implements IPoolCache {
    private cache: Map<string, CacheEntry<PoolState>> = new Map();
    private hitCount = 0n;
    private missCount = 0n;
    private evictionCount = 0n;
    private lastUpdateSlot = 0;
    private traceHandler?: CacheTraceHandler;

    /**
     * Set trace handler for evidence capture
     */
    setTraceHandler(handler: CacheTraceHandler): void {
        this.traceHandler = handler;
    }

    /**
     * Get pool state by pubkey
     */
    get(pubkey: Uint8Array): CacheEntry<PoolState> | null {
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
     * Update pool state
     * Only updates if slot/writeVersion is newer
     *
     * INVARIANT ENFORCEMENT:
     * - dataLength is MANDATORY for invariant validation
     * - source is MANDATORY for cross-source consistency checking
     * - Pool accounts must NOT have tick/bin array sizes
     *
     * @param pubkey - Pool account pubkey
     * @param state - Decoded pool state
     * @param slot - Slot of the update
     * @param writeVersion - Write version for staleness check
     * @param dataLength - MANDATORY: account data length for invariant validation
     * @param source - MANDATORY: 'grpc' or 'bootstrap'
     * @throws if dataLength matches tick/bin array sizes
     */
    set(
        pubkey: Uint8Array,
        state: PoolState,
        slot: number,
        writeVersion: bigint,
        dataLength: number,
        source: 'grpc' | 'bootstrap'
    ): CacheUpdateResult {
        // CONTRACT ENFORCEMENT: dataLength is mandatory
        if (dataLength === undefined || dataLength === null) {
            throw new Error(
                `[FATAL] PoolCache.set() requires dataLength. ` +
                `pubkey=${toKey(pubkey).slice(0, 16)}... source=${source}`
            );
        }

        // INVARIANT ENFORCEMENT via tracker (throws on violation)
        const key = toKey(pubkey);
        const existing = this.cache.get(key);

        // Check if this update is stale
        if (existing) {
            if (slot < existing.slot || (slot === existing.slot && writeVersion <= existing.writeVersion)) {
                // Emit rejection trace for evidence capture
                if (this.traceHandler) {
                    this.traceHandler({
                        cacheType: 'pool',
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

        const entry: CacheEntry<PoolState> = {
            state,
            slot,
            writeVersion,
            updatedAtNs: process.hrtime.bigint(),
            source,  // Phase 2: Store source for convergence validation
        };

        this.cache.set(key, entry);
        if (slot > this.lastUpdateSlot) {
            this.lastUpdateSlot = slot;
        }

        // Emit trace for evidence capture
        if (this.traceHandler) {
            this.traceHandler({
                cacheType: 'pool',
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
     * Get pool entry with full metadata (Phase 2: for convergence check)
     * Returns same as get() but named for clarity
     */
    getEntry(pubkey: Uint8Array): CacheEntry<PoolState> | null {
        return this.get(pubkey);
    }

    /**
     * Delete pool from cache
     */
    delete(pubkey: Uint8Array): boolean {
        const key = toKey(pubkey);
        const existed = this.cache.has(key);
        this.cache.delete(key);
        if (existed) this.evictionCount++;
        return existed;
    }

    /**
     * Check if pool exists in cache
     */
    has(pubkey: Uint8Array): boolean {
        return this.cache.has(toKey(pubkey));
    }

    /**
     * Get all cached pool pubkeys
     */
    keys(): Uint8Array[] {
        const result: Uint8Array[] = [];
        for (const key of this.cache.keys()) {
            // Convert hex back to bytes
            const bytes = new Uint8Array(32);
            for (let i = 0; i < 32; i++) {
                bytes[i] = parseInt(key.slice(i * 2, i * 2 + 2), 16);
            }
            result.push(bytes);
        }
        return result;
    }

    /**
     * Alias for keys() - get all pool pubkeys
     */
    getAllPubkeys(): Uint8Array[] {
        return this.keys();
    }

    /**
     * Get all entries with their pubkeys
     */
    getAll(): Array<{ pubkey: Uint8Array; state: PoolState; slot: number; writeVersion: bigint; updatedAtNs: bigint }> {
        const result: Array<{ pubkey: Uint8Array; state: PoolState; slot: number; writeVersion: bigint; updatedAtNs: bigint }> = [];
        for (const [key, entry] of this.cache.entries()) {
            // Convert hex back to bytes
            const bytes = new Uint8Array(32);
            for (let i = 0; i < 32; i++) {
                bytes[i] = parseInt(key.slice(i * 2, i * 2 + 2), 16);
            }
            result.push({
                pubkey: bytes,
                state: entry.state,
                slot: entry.slot,
                writeVersion: entry.writeVersion,
                updatedAtNs: entry.updatedAtNs,
            });
        }
        return result;
    }

    /**
     * Get cache statistics
     */
    stats(): CacheStats {
        return {
            size: this.cache.size,
            hitCount: this.hitCount,
            missCount: this.missCount,
            evictionCount: this.evictionCount,
            lastUpdateSlot: this.lastUpdateSlot,
        };
    }

    /**
     * Clear all entries
     */
    clear(): void {
        this.cache.clear();
        this.evictionCount += BigInt(this.cache.size);
    }

    /**
     * Get all entries for a specific venue
     */
    getByVenue(venueId: number): CacheEntry<PoolState>[] {
        const result: CacheEntry<PoolState>[] = [];
        for (const entry of this.cache.values()) {
            if (entry.state.venue === venueId) {
                result.push(entry);
            }
        }
        return result;
    }

    /**
     * Memory footprint estimation
     */
    estimateMemoryBytes(): number {
        // Rough estimate per entry:
        // - Key: 64 bytes (hex string)
        // - CacheEntry overhead: ~100 bytes
        // - PoolState: ~200-500 bytes depending on venue
        // Conservative estimate: 700 bytes per entry
        return this.cache.size * 700;
    }
}

/**
 * Create pool cache instance
 */
export function createPoolCache(): PoolCache {
    return new PoolCache();
}