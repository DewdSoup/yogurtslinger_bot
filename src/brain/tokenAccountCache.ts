// src/brain/tokenAccountCache.ts
// High-performance token account balance cache
// CRITICAL: No latency impact - pure in-memory operations

export interface TokenAccountEntry {
    balance: bigint;
    lastUpdatedSlot: bigint;
    lastUpdatedTs: number;
    firstSeenTs: number;
}

export class TokenAccountCache {
    private accounts = new Map<string, TokenAccountEntry>();

    /**
     * Upsert a token account balance
     * O(1) operation - no latency impact
     */
    upsert(pubkey: string, balance: bigint, slot: bigint): void {
        const existing = this.accounts.get(pubkey);
        const now = Date.now();

        this.accounts.set(pubkey, {
            balance,
            lastUpdatedSlot: slot,
            lastUpdatedTs: now,
            firstSeenTs: existing?.firstSeenTs ?? now
        });
    }

    /**
     * Get balance for a single account
     * O(1) operation
     */
    getBalance(pubkey: string): bigint | undefined {
        return this.accounts.get(pubkey)?.balance;
    }

    /**
     * Get full entry for a single account
     * O(1) operation
     */
    getEntry(pubkey: string): TokenAccountEntry | undefined {
        return this.accounts.get(pubkey);
    }

    /**
     * Get all cached accounts
     * O(1) to return the map reference
     */
    getAll(): Map<string, TokenAccountEntry> {
        return this.accounts;
    }

    /**
     * Get the number of cached accounts
     */
    size(): number {
        return this.accounts.size;
    }

    /**
     * Check if an account is cached
     */
    has(pubkey: string): boolean {
        return this.accounts.has(pubkey);
    }

    /**
     * Get multiple balances at once
     * Returns Map of pubkey -> balance (only for found accounts)
     */
    getBalances(pubkeys: string[]): Map<string, bigint> {
        const result = new Map<string, bigint>();
        for (const pubkey of pubkeys) {
            const balance = this.accounts.get(pubkey)?.balance;
            if (balance !== undefined) {
                result.set(pubkey, balance);
            }
        }
        return result;
    }

    /**
     * Get accounts updated after a certain timestamp
     * Useful for getting "recently changed" accounts
     */
    getUpdatedAfter(timestamp: number): Map<string, TokenAccountEntry> {
        const result = new Map<string, TokenAccountEntry>();
        for (const [pubkey, entry] of this.accounts) {
            if (entry.lastUpdatedTs >= timestamp) {
                result.set(pubkey, entry);
            }
        }
        return result;
    }

    /**
     * Get accounts by slot range
     * Useful for consistency checks
     */
    getBySlotRange(minSlot: bigint, maxSlot: bigint): Map<string, TokenAccountEntry> {
        const result = new Map<string, TokenAccountEntry>();
        for (const [pubkey, entry] of this.accounts) {
            if (entry.lastUpdatedSlot >= minSlot && entry.lastUpdatedSlot <= maxSlot) {
                result.set(pubkey, entry);
            }
        }
        return result;
    }

    /**
     * Get cache statistics
     */
    getStats(): {
        totalAccounts: number;
        oldestTs: number | null;
        newestTs: number | null;
        oldestSlot: bigint | null;
        newestSlot: bigint | null;
    } {
        if (this.accounts.size === 0) {
            return {
                totalAccounts: 0,
                oldestTs: null,
                newestTs: null,
                oldestSlot: null,
                newestSlot: null
            };
        }

        let oldestTs = Infinity;
        let newestTs = 0;
        let oldestSlot = BigInt(Number.MAX_SAFE_INTEGER);
        let newestSlot = 0n;

        for (const entry of this.accounts.values()) {
            if (entry.lastUpdatedTs < oldestTs) oldestTs = entry.lastUpdatedTs;
            if (entry.lastUpdatedTs > newestTs) newestTs = entry.lastUpdatedTs;
            if (entry.lastUpdatedSlot < oldestSlot) oldestSlot = entry.lastUpdatedSlot;
            if (entry.lastUpdatedSlot > newestSlot) newestSlot = entry.lastUpdatedSlot;
        }

        return {
            totalAccounts: this.accounts.size,
            oldestTs,
            newestTs,
            oldestSlot,
            newestSlot
        };
    }

    /**
     * Clear all cached data
     * Use with caution - typically only for testing
     */
    clear(): void {
        this.accounts.clear();
    }

    /**
     * Remove stale entries (not updated for a certain duration)
     * Returns number of entries removed
     */
    pruneStale(maxAgeMs: number): number {
        const cutoff = Date.now() - maxAgeMs;
        let removed = 0;

        for (const [pubkey, entry] of this.accounts) {
            if (entry.lastUpdatedTs < cutoff) {
                this.accounts.delete(pubkey);
                removed++;
            }
        }

        return removed;
    }
}