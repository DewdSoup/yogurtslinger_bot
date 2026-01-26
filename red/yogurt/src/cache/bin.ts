/**
 * Bin Array Cache (Phase 3)
 * 
 * Caches bin arrays for Meteora DLMM simulation.
 * 
 * Gate requirements:
 * - ≥99% of sims have required bin arrays
 * - dependency.slot ≥ pool.slot at sim time
 */

import type { CacheEntry, BinArray } from '../types.js';
import type { IBinCache, CacheStats, CacheTraceHandler, CacheUpdateResult } from './types.js';
import { BIN_ARRAY_SIZE } from '../decode/programs/binArray.js';
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

/** Composite key: pool + index */
function toKey(pool: Uint8Array, index: number): string {
    return toHex(pool) + ':' + index.toString();
}

/** Bin account index entry - maps actual account pubkey to composite key */
interface BinAccountIndexEntry {
    pool: Uint8Array;
    index: number;
    slot: number;
    writeVersion: bigint;
}

/** Bins per array constant */
const BINS_PER_ARRAY = 70;

/**
 * Virtual zero-liquidity bin array (FIX 3)
 * Returned when array is known to not exist on-chain
 */
const VIRTUAL_ZERO_BINS = Array.from({ length: BINS_PER_ARRAY }, () => ({
    amountX: 0n,
    amountY: 0n,
}));

/**
 * Phase 3.2: Maximum bin array entries before eviction triggers
 * Conservative reduction from 7000 → 6000 to test eviction engagement
 * ~18MB memory budget (6,000 × ~2,970 bytes per entry)
 */
export const MAX_BIN_ENTRIES = 6000;

/** Phase 3.2: Rate-limited eviction block logging (first 10 only) */
let evictBlockLogCount = 0;
const MAX_EVICT_BLOCK_LOGS = 10;

/** Phase 4.6: One-time log when no evictable entries exist */
let evictionFullyBlockedLogged = false;

export class BinCache implements IBinCache {
    private cache: Map<string, CacheEntry<BinArray>> = new Map();
    /** Secondary index: actual bin array account pubkey -> composite key info */
    private binAccountIndex: Map<string, BinAccountIndexEntry> = new Map();
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
     * Get bin array
     */
    get(pool: Uint8Array, index: number): CacheEntry<BinArray> | null {
        const key = toKey(pool, index);
        const entry = this.cache.get(key);
        if (entry) {
            this.hitCount++;
            return entry;
        }
        this.missCount++;
        return null;
    }

    /**
     * FIX 3: Get bin array or virtual zero
     *
     * Returns:
     * - Cached state if present
     * - Virtual zero-liquidity array if known non-existent
     * - null if unknown (needs RPC fetch)
     *
     * This eliminates synthetic cache writes for non-existent arrays.
     */
    getOrVirtual(pool: Uint8Array, index: number): BinArray | null {
        const key = toKey(pool, index);

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
                lbPair: pool,
                index: BigInt(index),
                startBinId: index * BINS_PER_ARRAY,
                bins: VIRTUAL_ZERO_BINS,
            };
        }

        // Unknown - needs fetch
        this.missCount++;
        return null;
    }

    /**
     * FIX 3: Mark bin array as non-existent on-chain
     *
     * Used when RPC confirms account doesn't exist.
     * getOrVirtual() will return zero-liquidity for these.
     *
     * If real data arrives later via gRPC, the cache.set() will
     * override and the non-existent marker will be cleared.
     */
    markNonExistent(pool: Uint8Array, index: number): void {
        const key = toKey(pool, index);
        this.nonExistentArrays.add(key);
    }

    /**
     * FIX 3: Check if bin array is known non-existent
     */
    isNonExistent(pool: Uint8Array, index: number): boolean {
        const key = toKey(pool, index);
        return this.nonExistentArrays.has(key);
    }

    /**
     * Set bin array
     * Only updates if slot/writeVersion is newer
     *
     * INVARIANT ENFORCEMENT:
     * - binAccountPubkey is MANDATORY (no fallback to pool pubkey)
     * - dataLength is MANDATORY and must be >= BIN_ARRAY_SIZE
     * - source is MANDATORY for cross-source consistency checking
     *
     * @param pool - Pool pubkey (composite key part 1)
     * @param index - Bin array index (composite key part 2)
     * @param array - Decoded bin array
     * @param slot - Slot of the update
     * @param writeVersion - Write version for staleness check
     * @param binAccountPubkey - MANDATORY: actual bin array account pubkey
     * @param dataLength - MANDATORY: account data length for invariant validation
     * @param source - MANDATORY: 'grpc' or 'bootstrap'
     * @throws if binAccountPubkey is missing or dataLength < BIN_ARRAY_SIZE
     */
    set(
        pool: Uint8Array,
        index: number,
        array: BinArray,
        slot: number,
        writeVersion: bigint,
        binAccountPubkey: Uint8Array,
        dataLength: number,
        source: 'grpc' | 'bootstrap'
    ): CacheUpdateResult {
        // CONTRACT ENFORCEMENT: binAccountPubkey is mandatory
        if (!binAccountPubkey || binAccountPubkey.length !== 32) {
            throw new Error(
                `[FATAL] BinCache.set() requires binAccountPubkey. ` +
                `pool=${toHex(pool).slice(0, 16)}... index=${index} source=${source}`
            );
        }

        // CONTRACT ENFORCEMENT: dataLength is mandatory
        if (dataLength === undefined || dataLength === null) {
            throw new Error(
                `[FATAL] BinCache.set() requires dataLength. ` +
                `pubkey=${toHex(binAccountPubkey).slice(0, 16)}... source=${source}`
            );
        }

        // INVARIANT ENFORCEMENT: reject truncated data
        if (dataLength < BIN_ARRAY_SIZE) {
            // Log but don't throw - truncated data from gRPC is a protocol issue
            console.warn(
                `[BinCache] Rejecting truncated bin array: ` +
                `dataLength=${dataLength} expected>=${BIN_ARRAY_SIZE} ` +
                `pubkey=${toHex(binAccountPubkey).slice(0, 16)}... source=${source}`
            );
            return { updated: false, wasStale: false };
        }

        // INVARIANT ENFORCEMENT via staleness check
        const key = toKey(pool, index);
        const existing = this.cache.get(key);

        // Staleness check (same logic as PoolCache/VaultCache)
        if (existing) {
            if (slot < existing.slot || (slot === existing.slot && writeVersion <= existing.writeVersion)) {
                // Emit rejection trace for evidence capture
                if (this.traceHandler) {
                    this.traceHandler({
                        cacheType: 'bin',
                        pubkey: binAccountPubkey,
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
        if (this.cache.size >= MAX_BIN_ENTRIES) {
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
        const accountHex = toHex(binAccountPubkey);
        this.binAccountIndex.set(accountHex, {
            pool,
            index,
            slot,
            writeVersion,
        });

        if (slot > this.lastUpdateSlot) {
            this.lastUpdateSlot = slot;
        }

        // Emit trace for evidence capture
        if (this.traceHandler) {
            this.traceHandler({
                cacheType: 'bin',
                pubkey: binAccountPubkey,
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
     * Get bin array entry with full metadata (Phase 2: for convergence check)
     * Returns CacheEntry with source field, or null if not cached
     * Does NOT return virtual arrays - use getOrVirtual() for that
     */
    getEntry(pool: Uint8Array, index: number): CacheEntry<BinArray> | null {
        return this.get(pool, index);
    }

    /**
     * Get multiple bin arrays for a pool
     */
    getMultiple(pool: Uint8Array, indexes: number[]): (CacheEntry<BinArray> | null)[] {
        return indexes.map(idx => this.get(pool, idx));
    }

    /**
     * Check if all required bin arrays are present and fresh
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
     * Get missing bin array indexes
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
     * Get all bin arrays for a given pool
     * @param poolHex - Pool pubkey as hex string
     */
    getForPool(poolHex: string): CacheEntry<BinArray>[] {
        const results: CacheEntry<BinArray>[] = [];
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
     * Get bin array entry by actual account pubkey (for parity checks)
     * @param pubkey - The bin array account pubkey (not the pool pubkey)
     */
    getByAccountPubkey(pubkey: Uint8Array): CacheEntry<BinArray> | null {
        const pubkeyHex = toHex(pubkey);
        const indexEntry = this.binAccountIndex.get(pubkeyHex);
        if (!indexEntry) {
            return null;
        }
        return this.get(indexEntry.pool, indexEntry.index);
    }

    /**
     * Get account index size (for diagnostics)
     */
    getAccountIndexSize(): number {
        return this.binAccountIndex.size;
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
        let evictEntry: CacheEntry<BinArray> | null = null;
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
                console.warn('[eviction] bin: no evictable entries; all pools ACTIVE/REFRESHING');
            }
            return;
        }

        // Find account pubkey in secondary index for trace event
        let accountPubkey: Uint8Array | null = null;
        for (const [accHex, indexEntry] of this.binAccountIndex) {
            const entryKey = toKey(indexEntry.pool, indexEntry.index);
            if (entryKey === evictKey) {
                accountPubkey = new Uint8Array(32);
                for (let i = 0; i < 32; i++) {
                    accountPubkey[i] = parseInt(accHex.slice(i * 2, i * 2 + 2), 16);
                }
                // Remove from secondary index
                this.binAccountIndex.delete(accHex);
                break;
            }
        }

        // Perform eviction
        this.cache.delete(evictKey);
        this.evictionCount++;

        // Emit eviction trace event
        if (this.traceHandler && accountPubkey) {
            this.traceHandler({
                cacheType: 'bin',
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
 * Create bin cache instance
 */
export function createBinCache(): BinCache {
    return new BinCache();
}