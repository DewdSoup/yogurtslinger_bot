/**
 * Pending Transaction Queue (Phase 4 - Deliverable 4.7)
 *
 * Tracks pending transactions for speculative state calculation.
 *
 * Key behaviors:
 * - Ordered by (slot, signature) for deterministic replay
 * - Expires entries on confirmation or timeout
 * - Deduplicates by signature
 * - Provides iteration in order for speculative state building
 *
 * Hot path considerations:
 * - O(1) insert (Map + linked list)
 * - O(1) lookup by signature
 * - O(n) ordered iteration (unavoidable for state building)
 */

import type { DecodedTx, TxUpdate } from '../types.js';

// ============================================================================
// TYPES
// ============================================================================

export interface PendingTxEntry {
    signature: Uint8Array;
    slot: number;
    decoded: DecodedTx;
    rawUpdate: TxUpdate;
    receivedAtNs: bigint;
    // Computed deltas for speculative state
    deltas?: PoolDelta[];
}

export interface PoolDelta {
    pool: Uint8Array;
    vaultADelta: bigint;  // Positive = inflow, negative = outflow
    vaultBDelta: bigint;
}

export interface PendingQueueConfig {
    maxSize: number;           // Max pending txs to track
    expirationSlots: number;   // Expire after N slots behind head
    expirationMs: number;      // Expire after N ms (backup)
}

export interface PendingQueueStats {
    size: number;
    inserted: bigint;
    expired: bigint;
    confirmed: bigint;
    duplicates: bigint;
    headSlot: number;
}

// ============================================================================
// IMPLEMENTATION
// ============================================================================

export class PendingTxQueue {
    private readonly config: PendingQueueConfig;

    // Primary storage: signature hex → entry
    private entries: Map<string, PendingTxEntry> = new Map();

    // Ordered list for iteration (sorted by slot, then signature)
    private ordered: PendingTxEntry[] = [];
    private orderDirty = false;

    // Tracking
    private headSlot = 0;
    private insertedCount = 0n;
    private expiredCount = 0n;
    private confirmedCount = 0n;
    private duplicateCount = 0n;

    constructor(config?: Partial<PendingQueueConfig>) {
        this.config = {
            maxSize: config?.maxSize ?? 10000,
            expirationSlots: config?.expirationSlots ?? 150,  // ~1 minute at 400ms slots
            expirationMs: config?.expirationMs ?? 60000,      // 60 seconds
        };
    }

    /**
     * Add a pending transaction to the queue
     * Returns true if added, false if duplicate
     */
    insert(entry: PendingTxEntry): boolean {
        const key = this.toKey(entry.signature);

        // Check for duplicate
        if (this.entries.has(key)) {
            this.duplicateCount++;
            return false;
        }

        // Update head slot
        if (entry.slot > this.headSlot) {
            this.headSlot = entry.slot;
            // Trigger expiration check on slot advance
            this.expireOld();
        }

        // Check capacity
        if (this.entries.size >= this.config.maxSize) {
            this.evictOldest();
        }

        // Insert
        this.entries.set(key, entry);
        this.ordered.push(entry);
        this.orderDirty = true;
        this.insertedCount++;

        return true;
    }

    /**
     * Mark a transaction as confirmed (remove from pending)
     */
    confirm(signature: Uint8Array): boolean {
        const key = this.toKey(signature);
        const entry = this.entries.get(key);

        if (!entry) {
            return false;
        }

        this.entries.delete(key);
        this.confirmedCount++;
        this.orderDirty = true;

        return true;
    }

    /**
     * Check if a transaction is pending
     */
    has(signature: Uint8Array): boolean {
        return this.entries.has(this.toKey(signature));
    }

    /**
     * Get a pending transaction by signature
     */
    get(signature: Uint8Array): PendingTxEntry | null {
        return this.entries.get(this.toKey(signature)) ?? null;
    }

    /**
     * Get all pending transactions in order (slot, signature)
     * Used for building speculative state
     */
    getOrdered(): PendingTxEntry[] {
        if (this.orderDirty) {
            this.rebuildOrdered();
        }
        return this.ordered;
    }

    /**
     * Get pending transactions that affect a specific pool
     */
    getForPool(pool: Uint8Array): PendingTxEntry[] {
        const poolKey = this.toKey(pool);
        const result: PendingTxEntry[] = [];

        for (const entry of this.entries.values()) {
            if (entry.deltas) {
                for (const delta of entry.deltas) {
                    if (this.toKey(delta.pool) === poolKey) {
                        result.push(entry);
                        break;
                    }
                }
            }
        }

        return result;
    }

    /**
     * Get statistics
     */
    stats(): PendingQueueStats {
        return {
            size: this.entries.size,
            inserted: this.insertedCount,
            expired: this.expiredCount,
            confirmed: this.confirmedCount,
            duplicates: this.duplicateCount,
            headSlot: this.headSlot,
        };
    }

    /**
     * Clear all entries
     */
    clear(): void {
        this.entries.clear();
        this.ordered = [];
        this.orderDirty = false;
    }

    // ========================================================================
    // PRIVATE
    // ========================================================================

    private toKey(bytes: Uint8Array): string {
        let key = '';
        for (let i = 0; i < bytes.length; i++) {
            key += bytes[i]!.toString(16).padStart(2, '0');
        }
        return key;
    }

    private expireOld(): void {
        const now = process.hrtime.bigint();
        const nowMs = Number(now / 1_000_000n);
        const cutoffSlot = this.headSlot - this.config.expirationSlots;

        const toDelete: string[] = [];

        for (const [key, entry] of this.entries) {
            const entryAgeMs = nowMs - Number(entry.receivedAtNs / 1_000_000n);

            if (entry.slot < cutoffSlot || entryAgeMs > this.config.expirationMs) {
                toDelete.push(key);
            }
        }

        for (const key of toDelete) {
            this.entries.delete(key);
            this.expiredCount++;
        }

        if (toDelete.length > 0) {
            this.orderDirty = true;
        }
    }

    private evictOldest(): void {
        if (this.orderDirty) {
            this.rebuildOrdered();
        }

        // Remove oldest 10% to avoid frequent evictions
        const evictCount = Math.max(1, Math.floor(this.config.maxSize * 0.1));

        for (let i = 0; i < evictCount && this.ordered.length > 0; i++) {
            const oldest = this.ordered.shift();
            if (oldest) {
                this.entries.delete(this.toKey(oldest.signature));
                this.expiredCount++;
            }
        }
    }

    private rebuildOrdered(): void {
        this.ordered = Array.from(this.entries.values());

        // Sort by (slot ASC, signature ASC)
        this.ordered.sort((a, b) => {
            if (a.slot !== b.slot) {
                return a.slot - b.slot;
            }
            // Compare signatures lexicographically
            for (let i = 0; i < 64; i++) {
                const diff = (a.signature[i] ?? 0) - (b.signature[i] ?? 0);
                if (diff !== 0) return diff;
            }
            return 0;
        });

        this.orderDirty = false;
    }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createPendingQueue(config?: Partial<PendingQueueConfig>): PendingTxQueue {
    return new PendingTxQueue(config);
}