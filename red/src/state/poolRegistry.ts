// src/state/poolRegistry.ts
// Tracks which pools depend on which accounts, and reverse-indexes account updates to pools.

export type PoolId = string;     // e.g., pool pubkey base58
export type AccountKey = string; // pubkey base58

export class PoolRegistry {
    private readonly poolToAccounts = new Map<PoolId, Set<AccountKey>>();
    private readonly accountToPools = new Map<AccountKey, Set<PoolId>>();

    hasPool(poolId: PoolId): boolean {
        return this.poolToAccounts.has(poolId);
    }

    getAccounts(poolId: PoolId): ReadonlySet<AccountKey> {
        return this.poolToAccounts.get(poolId) ?? new Set();
    }

    getPoolsForAccount(accountKey: AccountKey): ReadonlySet<PoolId> {
        return this.accountToPools.get(accountKey) ?? new Set();
    }

    registerPool(poolId: PoolId, accounts: Iterable<AccountKey>): void {
        if (this.poolToAccounts.has(poolId)) {
            throw new Error(`[PoolRegistry] Pool already registered: ${poolId}`);
        }
        const set = new Set<AccountKey>();
        this.poolToAccounts.set(poolId, set);
        for (const a of accounts) this.link(poolId, a);
    }

    unregisterPool(poolId: PoolId): void {
        const deps = this.poolToAccounts.get(poolId);
        if (!deps) return;

        for (const accountKey of deps) {
            const pools = this.accountToPools.get(accountKey);
            if (!pools) continue;
            pools.delete(poolId);
            if (pools.size === 0) this.accountToPools.delete(accountKey);
        }

        this.poolToAccounts.delete(poolId);
    }

    link(poolId: PoolId, accountKey: AccountKey): void {
        let deps = this.poolToAccounts.get(poolId);
        if (!deps) {
            deps = new Set<AccountKey>();
            this.poolToAccounts.set(poolId, deps);
        }
        if (!deps.has(accountKey)) deps.add(accountKey);

        let pools = this.accountToPools.get(accountKey);
        if (!pools) {
            pools = new Set<PoolId>();
            this.accountToPools.set(accountKey, pools);
        }
        pools.add(poolId);
    }

    unlink(poolId: PoolId, accountKey: AccountKey): void {
        const deps = this.poolToAccounts.get(poolId);
        if (deps) deps.delete(accountKey);

        const pools = this.accountToPools.get(accountKey);
        if (pools) {
            pools.delete(poolId);
            if (pools.size === 0) this.accountToPools.delete(accountKey);
        }
    }

    /**
     * Replace dependencies for a pool with minimal churn.
     * This is the key primitive for:
     * - Raydium CLMM tick arrays when tickCurrent moves
     * - Meteora bin arrays when activeId moves
     */
    replaceDependencies(poolId: PoolId, nextAccounts: Iterable<AccountKey>): void {
        const next = new Set(nextAccounts);
        const prev = this.poolToAccounts.get(poolId) ?? new Set<AccountKey>();

        // Add new links
        for (const a of next) {
            if (!prev.has(a)) this.link(poolId, a);
        }

        // Remove stale links
        for (const a of prev) {
            if (!next.has(a)) this.unlink(poolId, a);
        }
    }
}
