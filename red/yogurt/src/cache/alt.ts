/**
 * Address Lookup Table Cache (Phase 4)
 *
 * Optimized for MEV hot path:
 * - Sync get() for hot path (<1μs)
 * - Pending fetch tracking (no double-count misses)
 * - Background prefetch for cache warming
 */

import type { AddressLookupTable } from '../types.js';
import type { CacheStats } from './types.js';

function toKey(pubkey: Uint8Array): string {
    let key = '';
    for (let i = 0; i < 32; i++) {
        key += pubkey[i]!.toString(16).padStart(2, '0');
    }
    return key;
}

export interface AltCache {
    get(pubkey: Uint8Array): AddressLookupTable | null;
    getAsync(pubkey: Uint8Array): Promise<AddressLookupTable | null>;
    set(pubkey: Uint8Array, alt: AddressLookupTable): void;
    setFetcher(fn: (pubkey: Uint8Array) => Promise<AddressLookupTable | null>): void;
    prefetch(pubkeys: Uint8Array[]): Promise<void>;
    stats(): CacheStats;
    hitRate(): number;
    resetMetrics(): void;
    detailedStats(): {
        hits: bigint;
        misses: bigint;
        pending: bigint;
        cacheSize: number;
        pendingFetches: number;
    };
}

export class AltCacheImpl implements AltCache {
    private cache: Map<string, AddressLookupTable> = new Map();
    private pending: Map<string, Promise<AddressLookupTable | null>> = new Map();
    private fetcher: ((pubkey: Uint8Array) => Promise<AddressLookupTable | null>) | null = null;

    // Metrics
    private hitCount = 0n;
    private missCount = 0n;      // True misses (first encounter)
    private pendingCount = 0n;   // Lookups while fetch in progress

    /**
     * Set the ALT fetcher function
     */
    setFetcher(fn: (pubkey: Uint8Array) => Promise<AddressLookupTable | null>): void {
        this.fetcher = fn;
    }

    /**
     * Sync get - returns cached ALT or null
     * Hot path: ~200ns if cached
     *
     * Key behavior:
     * - If cached: return immediately (hit)
     * - If fetch pending: return null but DON'T count as miss
     * - If not cached and no fetch: return null, count as miss, trigger fetch
     */
    get(pubkey: Uint8Array): AddressLookupTable | null {
        const key = toKey(pubkey);

        // Check cache first
        const cached = this.cache.get(key);
        if (cached) {
            this.hitCount++;
            return cached;
        }

        // Check if fetch already in progress
        if (this.pending.has(key)) {
            this.pendingCount++;
            return null;  // Not a new miss - fetch already triggered
        }

        // True miss - trigger background fetch
        this.missCount++;
        this.triggerFetch(pubkey, key);
        return null;
    }

    /**
     * Async get - waits for fetch if pending
     * Use during warmup, NOT on hot path
     */
    async getAsync(pubkey: Uint8Array): Promise<AddressLookupTable | null> {
        const key = toKey(pubkey);

        // Check cache
        const cached = this.cache.get(key);
        if (cached) {
            this.hitCount++;
            return cached;
        }

        // Check pending
        const pendingFetch = this.pending.get(key);
        if (pendingFetch) {
            return pendingFetch;
        }

        // Trigger fetch and wait
        this.missCount++;
        return this.triggerFetch(pubkey, key);
    }

    /**
     * Direct set - for bootstrap loading
     */
    set(pubkey: Uint8Array, alt: AddressLookupTable): void {
        const key = toKey(pubkey);
        this.cache.set(key, alt);
    }

    /**
     * Prefetch multiple ALTs in parallel
     */
    async prefetch(pubkeys: Uint8Array[]): Promise<void> {
        const promises: Promise<AddressLookupTable | null>[] = [];

        for (const pubkey of pubkeys) {
            const key = toKey(pubkey);
            if (!this.cache.has(key) && !this.pending.has(key)) {
                promises.push(this.triggerFetch(pubkey, key));
            }
        }

        await Promise.all(promises);
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
            lastUpdateSlot: 0,
        };
    }

    /**
     * Calculate hit rate
     * Formula: hits / (hits + true misses)
     * Pending lookups don't count against us
     */
    hitRate(): number {
        const total = this.hitCount + this.missCount;
        if (total === 0n) return 100;
        return Number((this.hitCount * 10000n) / total) / 100;
    }

    /**
     * Get detailed metrics
     */
    detailedStats(): {
        hits: bigint;
        misses: bigint;
        pending: bigint;
        cacheSize: number;
        pendingFetches: number;
    } {
        return {
            hits: this.hitCount,
            misses: this.missCount,
            pending: this.pendingCount,
            cacheSize: this.cache.size,
            pendingFetches: this.pending.size,
        };
    }

    /**
     * Reset metrics (for measurement phases)
     */
    resetMetrics(): void {
        this.hitCount = 0n;
        this.missCount = 0n;
        this.pendingCount = 0n;
    }

    // ========================================================================
    // PRIVATE
    // ========================================================================

    private triggerFetch(pubkey: Uint8Array, key: string): Promise<AddressLookupTable | null> {
        if (!this.fetcher) {
            return Promise.resolve(null);
        }

        const fetchPromise = this.fetcher(pubkey)
            .then(alt => {
                this.pending.delete(key);
                if (alt) {
                    this.cache.set(key, alt);
                }
                return alt;
            })
            .catch(() => {
                this.pending.delete(key);
                return null;
            });

        this.pending.set(key, fetchPromise);
        return fetchPromise;
    }
}

/**
 * Create ALT cache instance
 */
export function createAltCache(): AltCacheImpl {
    return new AltCacheImpl();
}