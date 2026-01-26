/**
 * Vault Balance Cache (Phase 2)
 *
 * Stores decoded token account balances for pool vaults.
 * Used to compute effective reserves at simulation time.
 *
 * Design:
 * - Keyed by vault pubkey (hex string for Map compatibility)
 * - Tracks slot/writeVersion for staleness detection
 * - No expiration (validator provides real-time updates)
 */

import type { IVaultCache, VaultBalance, CacheStats, CacheUpdateResult, CacheTraceHandler } from './types.js';

/**
 * Convert pubkey to hex key (hot path optimized)
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

export class VaultCache implements IVaultCache {
    private cache: Map<string, VaultBalance> = new Map();
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
     * Get vault balance
     */
    get(pubkey: Uint8Array): VaultBalance | null {
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
     * Update vault balance
     * Only updates if slot/writeVersion is newer
     *
     * @param pubkey - Vault account pubkey
     * @param amount - Token balance
     * @param slot - Slot of the update
     * @param writeVersion - Write version for staleness check
     * @param dataLength - MANDATORY: Account data length for trace metadata
     * @param source - MANDATORY: 'grpc' or 'bootstrap' for trace metadata
     */
    set(
        pubkey: Uint8Array,
        amount: bigint,
        slot: number,
        writeVersion: bigint,
        dataLength: number,
        source: 'grpc' | 'bootstrap'
    ): CacheUpdateResult {
        const key = toKey(pubkey);
        const existing = this.cache.get(key);

        // Staleness check
        if (existing) {
            if (slot < existing.slot || (slot === existing.slot && writeVersion <= existing.writeVersion)) {
                // Emit rejection trace for evidence capture
                if (this.traceHandler) {
                    this.traceHandler({
                        cacheType: 'vault',
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

        this.cache.set(key, { amount, slot, writeVersion, source });  // Phase 2: Store source for convergence validation
        if (slot > this.lastUpdateSlot) {
            this.lastUpdateSlot = slot;
        }

        // Emit trace for evidence capture
        if (this.traceHandler) {
            this.traceHandler({
                cacheType: 'vault',
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
     * Get vault entry with full metadata (Phase 2: for convergence check)
     * Returns same as get() but named for clarity
     */
    getEntry(pubkey: Uint8Array): VaultBalance | null {
        return this.get(pubkey);
    }

    /**
     * Check if vault exists
     */
    has(pubkey: Uint8Array): boolean {
        return this.cache.has(toKey(pubkey));
    }

    /**
     * Get all vault pubkeys
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
    getAll(): Array<{ pubkey: Uint8Array; amount: bigint; slot: number; writeVersion: bigint }> {
        const result: Array<{ pubkey: Uint8Array; amount: bigint; slot: number; writeVersion: bigint }> = [];
        for (const [key, entry] of this.cache.entries()) {
            result.push({
                pubkey: fromKey(key),
                amount: entry.amount,
                slot: entry.slot,
                writeVersion: entry.writeVersion,
            });
        }
        return result;
    }

    /**
     * Iterate over all entries (generator)
     */
    *entries(): Generator<[Uint8Array, VaultBalance]> {
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
     * Cache statistics
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
     * Clear cache
     */
    clear(): void {
        this.cache.clear();
    }
}

/**
 * Create vault cache instance
 */
export function createVaultCache(): VaultCache {
    return new VaultCache();
}