/**
 * Tick Array Cache (Phase 3)
 * 
 * Caches tick arrays for Raydium CLMM simulation.
 * 
 * Gate requirements:
 * - ≥99% of sims have required tick arrays
 * - dependency.slot ≥ pool.slot at sim time
 */

import type { CacheEntry, TickArray } from '../types.js';
import type { ITickCache, CacheStats, CacheTraceHandler, CacheUpdateResult } from './types.js';
import { TICK_ARRAY_SIZE } from '../decode/programs/tickArray.js';
import { LifecycleRegistry, PoolLifecycleState } from './lifecycle.js';

// Phase 4.5: DEBUG logging for eviction blocks (forensics only)
const DEBUG = process.env.DEBUG === '1';

/** Convert pubkey to hex string */
function toHex(pubkey: Uint8Array): string {
    let hex = '';
    for (let i = 0; i < 32; i++) {
        hex += pubkey[i].toString(16).padStart(2, '0');
    }
    return hex;
}

/** Composite key: pool + startTickIndex */
function toKey(pool: Uint8Array, startTickIndex: number): string {
    return toHex(pool) + ':' + startTickIndex.toString();
}

/** Tick account index entry - maps actual account pubkey to composite key */
interface TickAccountIndexEntry {
    pool: Uint8Array;
    startTickIndex: number;
    slot: number;
    writeVersion: bigint;
}

/**
 * Virtual zero-liquidity tick array (FIX 3)
 * Returned when array is known to not exist on-chain
 */
const VIRTUAL_ZERO_TICKS = Array.from({ length: 60 }, () => ({
    tick: 0,  // Will be computed on demand if needed
    liquidityNet: 0n,
    liquidityGross: 0n,
    initialized: false,
}));

/**
 * Phase 3.2: Maximum tick array entries before eviction triggers
 * Conservative reduction from 20000 → 18000 to test eviction engagement
 * ~79MB memory budget (18,000 × ~4,400 bytes per entry)
 */
export const MAX_TICK_ENTRIES = 18000;

/** Phase 3.2: Rate-limited eviction block logging (first 10 only) */
let evictBlockLogCount = 0;
const MAX_EVICT_BLOCK_LOGS = 10;

/** Phase 4.6: One-time log when no evictable entries exist */
let evictionFullyBlockedLogged = false;

export class TickCache implements ITickCache {
    private cache: Map<string, CacheEntry<TickArray>> = new Map();
    /** Secondary index: actual tick array account pubkey -> composite key info */
    private tickAccountIndex: Map<string, TickAccountIndexEntry> = new Map();
    /** FIX 3: Track arrays known to not exist on-chain (virtual zero) */
    private nonExistentArrays: Set<string> = new Set();
    private hitCount = 0n;
    private missCount = 0n;
    private evictionCount = 0n;
    private lastUpdateSlot = 0;
    private traceHandler?: CacheTraceHandler;
    /** Phase 3.1: Lifecycle registry for topology-aware eviction */
    private lifecycle?: LifecycleRegistry;

    /**
     * Set trace handler for evidence capture
     */
    setTraceHandler(handler: CacheTraceHandler): void {
        this.traceHandler = handler;
    }

    /**
     * Get tick array
     */
    get(pool: Uint8Array, startTickIndex: number): CacheEntry<TickArray> | null {
        const key = toKey(pool, startTickIndex);
        const entry = this.cache.get(key);
        if (entry) {
            this.hitCount++;
            return entry;
        }
        this.missCount++;
        return null;
    }

    /**
     * FIX 3: Get tick array or virtual zero
     *
     * Returns:
     * - Cached state if present
     * - Virtual zero-liquidity array if known non-existent
     * - null if unknown (needs RPC fetch)
     *
     * This eliminates synthetic cache writes for non-existent arrays.
     */
    getOrVirtual(pool: Uint8Array, startTickIndex: number): TickArray | null {
        const key = toKey(pool, startTickIndex);

        // Check cache first
        const entry = this.cache.get(key);
        if (entry) {
            this.hitCount++;
            return entry.state;
        }

        // Check if known non-existent (virtual zero)
        if (this.nonExistentArrays.has(key)) {
            this.hitCount++;  // Count virtual hit
            // Return virtual zero-liquidity array
            return {
                poolId: pool,
                startTickIndex,
                ticks: VIRTUAL_ZERO_TICKS.map((t, i) => ({
                    ...t,
                    tick: startTickIndex + i,
                })),
            };
        }

        // Unknown - needs fetch
        this.missCount++;
        return null;
    }

    /**
     * FIX 3: Mark tick array as non-existent on-chain
     *
     * Used when RPC confirms account doesn't exist.
     * getOrVirtual() will return zero-liquidity for these.
     *
     * If real data arrives later via gRPC, the cache.set() will
     * override and the non-existent marker will be cleared.
     */
    markNonExistent(pool: Uint8Array, startTickIndex: number): void {
        const key = toKey(pool, startTickIndex);
        this.nonExistentArrays.add(key);
    }

    /**
     * FIX 3: Check if tick array is known non-existent
     */
    isNonExistent(pool: Uint8Array, startTickIndex: number): boolean {
        const key = toKey(pool, startTickIndex);
        return this.nonExistentArrays.has(key);
    }

    /**
     * Set tick array
     * Only updates if slot/writeVersion is newer
     *
     * INVARIANT ENFORCEMENT:
     * - tickAccountPubkey is MANDATORY (no fallback to pool pubkey)
     * - dataLength is MANDATORY and must be >= TICK_ARRAY_SIZE
     * - source is MANDATORY for cross-source consistency checking
     *
     * @param pool - Pool pubkey (composite key part 1)
     * @param startTickIndex - Start tick index (composite key part 2)
     * @param array - Decoded tick array
     * @param slot - Slot of the update
     * @param writeVersion - Write version for staleness check
     * @param tickAccountPubkey - MANDATORY: actual tick array account pubkey
     * @param dataLength - MANDATORY: account data length for invariant validation
     * @param source - MANDATORY: 'grpc' or 'bootstrap'
     * @throws if tickAccountPubkey is missing or dataLength < TICK_ARRAY_SIZE
     */
    set(
        pool: Uint8Array,
        startTickIndex: number,
        array: TickArray,
        slot: number,
        writeVersion: bigint,
        tickAccountPubkey: Uint8Array,
        dataLength: number,
        source: 'grpc' | 'bootstrap'
    ): CacheUpdateResult {
        // CONTRACT ENFORCEMENT: tickAccountPubkey is mandatory
        if (!tickAccountPubkey || tickAccountPubkey.length !== 32) {
            throw new Error(
                `[FATAL] TickCache.set() requires tickAccountPubkey. ` +
                `pool=${toHex(pool).slice(0, 16)}... startTickIndex=${startTickIndex} source=${source}`
            );
        }

        // CONTRACT ENFORCEMENT: dataLength is mandatory
        if (dataLength === undefined || dataLength === null) {
            throw new Error(
                `[FATAL] TickCache.set() requires dataLength. ` +
                `pubkey=${toHex(tickAccountPubkey).slice(0, 16)}... source=${source}`
            );
        }

        // INVARIANT ENFORCEMENT: reject truncated data
        if (dataLength < TICK_ARRAY_SIZE) {
            // Log but don't throw - truncated data from gRPC is a protocol issue
            console.warn(
                `[TickCache] Rejecting truncated tick array: ` +
                `dataLength=${dataLength} expected>=${TICK_ARRAY_SIZE} ` +
                `pubkey=${toHex(tickAccountPubkey).slice(0, 16)}... source=${source}`
            );
            return { updated: false, wasStale: false };
        }

        // INVARIANT ENFORCEMENT via staleness check
        const key = toKey(pool, startTickIndex);
        const existing = this.cache.get(key);

        // Staleness check (same logic as PoolCache/VaultCache)
        if (existing) {
            if (slot < existing.slot || (slot === existing.slot && writeVersion <= existing.writeVersion)) {
                // Emit rejection trace for evidence capture
                if (this.traceHandler) {
                    this.traceHandler({
                        cacheType: 'tick',
                        pubkey: tickAccountPubkey,
                        slot,
                        writeVersion,
                        appliedAtMs: Date.now(),
                        cacheKey: key,
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

        // Phase 3.1: Eviction check before insert
        if (this.cache.size >= MAX_TICK_ENTRIES) {
            this.evictIfSafe();
        }

        this.cache.set(key, {
            state: array,
            slot,
            writeVersion,
            updatedAtNs: process.hrtime.bigint(),
            source,  // Phase 2: Store source for convergence validation
        });

        // FIX 3: Clear non-existent marker when real data arrives
        this.nonExistentArrays.delete(key);

        // Update secondary index with actual account pubkey
        const accountHex = toHex(tickAccountPubkey);
        this.tickAccountIndex.set(accountHex, {
            pool,
            startTickIndex,
            slot,
            writeVersion,
        });

        if (slot > this.lastUpdateSlot) {
            this.lastUpdateSlot = slot;
        }

        // Emit trace for evidence capture
        if (this.traceHandler) {
            this.traceHandler({
                cacheType: 'tick',
                pubkey: tickAccountPubkey,
                slot,
                writeVersion,
                appliedAtMs: Date.now(),
                cacheKey: key,
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
     * Get tick array entry with full metadata (Phase 2: for convergence check)
     * Returns CacheEntry with source field, or null if not cached
     * Does NOT return virtual arrays - use getOrVirtual() for that
     */
    getEntry(pool: Uint8Array, startTickIndex: number): CacheEntry<TickArray> | null {
        return this.get(pool, startTickIndex);
    }

    /**
     * Get multiple tick arrays for a pool
     */
    getMultiple(pool: Uint8Array, indexes: number[]): (CacheEntry<TickArray> | null)[] {
        return indexes.map(idx => this.get(pool, idx));
    }

    /**
     * Check if all required tick arrays are present and fresh
     */
    hasRequired(pool: Uint8Array, indexes: number[], minSlot: number): boolean {
        for (const idx of indexes) {
            const entry = this.get(pool, idx);
            if (!entry || entry.slot < minSlot) {
                return false;
            }
        }
        return true;
    }

    /**
     * Get missing tick array indexes
     */
    getMissing(pool: Uint8Array, indexes: number[], minSlot: number): number[] {
        const missing: number[] = [];
        for (const idx of indexes) {
            const entry = this.get(pool, idx);
            if (!entry || entry.slot < minSlot) {
                missing.push(idx);
            }
        }
        return missing;
    }

    /**
     * Get all tick arrays for a given pool
     * @param poolHex - Pool pubkey as hex string
     */
    getForPool(poolHex: string): CacheEntry<TickArray>[] {
        const results: CacheEntry<TickArray>[] = [];
        const prefix = poolHex + ':';

        for (const [key, entry] of this.cache.entries()) {
            if (key.startsWith(prefix)) {
                results.push(entry);
            }
        }

        return results;
    }

    /**
     * Get cache statistics
     */
    stats(): CacheStats & { nonExistentCount: number } {
        return {
            size: this.cache.size,
            hitCount: this.hitCount,
            missCount: this.missCount,
            evictionCount: this.evictionCount,
            lastUpdateSlot: this.lastUpdateSlot,
            nonExistentCount: this.nonExistentArrays.size,  // FIX 3
        };
    }

    /**
     * Get sample cache keys for debugging
     */
    getSampleKeys(limit = 5): string[] {
        const keys: string[] = [];
        for (const key of this.cache.keys()) {
            keys.push(key);
            if (keys.length >= limit) break;
        }
        return keys;
    }

    /**
     * Get unique pool prefixes in cache
     */
    getUniquePoolCount(): number {
        const pools = new Set<string>();
        for (const key of this.cache.keys()) {
            const colonIdx = key.indexOf(':');
            if (colonIdx > 0) {
                pools.add(key.slice(0, colonIdx));
            }
        }
        return pools.size;
    }

    /**
     * Get tick array entry by actual account pubkey (for parity checks)
     * @param pubkey - The tick array account pubkey (not the pool pubkey)
     */
    getByAccountPubkey(pubkey: Uint8Array): CacheEntry<TickArray> | null {
        const pubkeyHex = toHex(pubkey);
        const indexEntry = this.tickAccountIndex.get(pubkeyHex);
        if (!indexEntry) {
            return null;
        }
        return this.get(indexEntry.pool, indexEntry.startTickIndex);
    }

    /**
     * Get account index size (for diagnostics)
     */
    getAccountIndexSize(): number {
        return this.tickAccountIndex.size;
    }

    /**
     * Phase 3: Set lifecycle registry for topology-aware eviction
     * @param registry - Lifecycle registry for checking pool states
     */
    setLifecycleRegistry(registry: LifecycleRegistry): this {
        this.lifecycle = registry;
        return this;
    }

    /**
     * Phase 4.6: Topology-aware eviction — "oldest evictable" strategy
     *
     * Finds the oldest entry whose pool is NOT ACTIVE or REFRESHING.
     * This guarantees progress when any evictable entry exists.
     *
     * - ACTIVE pools: protected (simulation at risk)
     * - REFRESHING pools: protected (epoch transition)
     * - DISCOVERED/TOPOLOGY_FROZEN/null: evictable
     *
     * If no evictable entry exists, returns without evicting (no escalation).
     * Emits trace event with evicted: true on successful eviction.
     */
    private evictIfSafe(): void {
        // Find oldest EVICTABLE entry (pool is NOT ACTIVE or REFRESHING)
        let evictKey: string | null = null;
        let evictEntry: CacheEntry<TickArray> | null = null;
        let evictTime = BigInt(Number.MAX_SAFE_INTEGER);

        for (const [key, entry] of this.cache) {
            // Extract pool pubkey from composite key (first 64 hex chars)
            const colonIdx = key.indexOf(':');
            if (colonIdx !== 64) continue;  // Invalid key format

            // Check lifecycle state - skip ACTIVE/REFRESHING entries
            if (this.lifecycle) {
                const poolHex = key.slice(0, 64);
                const poolPubkey = new Uint8Array(32);
                for (let i = 0; i < 32; i++) {
                    poolPubkey[i] = parseInt(poolHex.slice(i * 2, i * 2 + 2), 16);
                }

                const state = this.lifecycle.getState(poolPubkey);
                if (state === PoolLifecycleState.ACTIVE ||
                    state === PoolLifecycleState.REFRESHING) {
                    continue;  // Skip protected entries
                }
            }
            // If lifecycle registry missing, treat as evictable (existing behavior)

            // Track oldest evictable entry
            if (entry.updatedAtNs < evictTime) {
                evictTime = entry.updatedAtNs;
                evictKey = key;
                evictEntry = entry;
            }
        }

        // No evictable entry found
        if (!evictKey || !evictEntry) {
            // DEBUG-only log (once per process)
            if (DEBUG && !evictionFullyBlockedLogged) {
                evictionFullyBlockedLogged = true;
                console.warn('[eviction] tick: no evictable entries; all pools ACTIVE/REFRESHING');
            }
            return;
        }

        // Find account pubkey in secondary index for trace event
        let accountPubkey: Uint8Array | null = null;
        for (const [accHex, indexEntry] of this.tickAccountIndex) {
            const entryKey = toKey(indexEntry.pool, indexEntry.startTickIndex);
            if (entryKey === evictKey) {
                accountPubkey = new Uint8Array(32);
                for (let i = 0; i < 32; i++) {
                    accountPubkey[i] = parseInt(accHex.slice(i * 2, i * 2 + 2), 16);
                }
                // Remove from secondary index
                this.tickAccountIndex.delete(accHex);
                break;
            }
        }

        // Perform eviction
        this.cache.delete(evictKey);
        this.evictionCount++;

        // Emit eviction trace event
        if (this.traceHandler && accountPubkey) {
            this.traceHandler({
                cacheType: 'tick',
                pubkey: accountPubkey,
                slot: evictEntry.slot,
                writeVersion: evictEntry.writeVersion,
                appliedAtMs: Date.now(),
                cacheKey: evictKey,
                dataLength: 0,  // Unknown after eviction
                source: evictEntry.source ?? 'grpc',
                evicted: true,
            });
        }
    }
}

/**
 * Create tick cache instance
 */
export function createTickCache(): TickCache {
    return new TickCache();
}