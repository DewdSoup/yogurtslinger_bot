// src/state/unifiedPoolRegistry.ts
//
// Unified cross-venue pool registry with price index.
//
// Purpose: Enable cross-venue arbitrage detection by tracking:
// 1. All pools grouped by token pair (mint pair → pools across venues)
// 2. Current price per pool (updated from confirmed state)
// 3. Price divergence alerts when cross-venue spread exceeds threshold
//
// This is the foundation for the arb detection pipeline.

import type { PubkeyStr } from "./accountStore";

// ============================================================================
// Types
// ============================================================================

export type VenueType = "pumpswap" | "raydium_v4" | "raydium_clmm" | "meteora_dlmm";

export interface PoolInfo {
    poolAddress: PubkeyStr;
    venue: VenueType;
    baseMint: PubkeyStr;
    quoteMint: PubkeyStr;

    // Current state (updated on account updates)
    lastPriceQ64: bigint;       // price in Q64 fixed-point
    lastUpdateSlot: number;
    lastUpdateTs: number;

    // Venue-specific data (opaque to registry)
    venueData: unknown;
}

export interface TokenPairPools {
    baseMint: PubkeyStr;
    quoteMint: PubkeyStr;
    pools: Map<PubkeyStr, PoolInfo>;  // poolAddress → PoolInfo
}

export interface PriceDivergence {
    baseMint: PubkeyStr;
    quoteMint: PubkeyStr;
    cheapPool: PoolInfo;
    expensivePool: PoolInfo;
    spreadBps: number;          // basis points spread
    cheapPriceQ64: bigint;
    expensivePriceQ64: bigint;
}

// ============================================================================
// Constants
// ============================================================================

const Q64 = BigInt(1) << BigInt(64);

// ============================================================================
// Unified Pool Registry
// ============================================================================

export class UnifiedPoolRegistry {
    // Canonical key is sorted pair: `${minMint}|${maxMint}`
    private readonly pairPools = new Map<string, TokenPairPools>();

    // Pool address → PoolInfo for fast lookup
    private readonly poolIndex = new Map<PubkeyStr, PoolInfo>();

    // Mint → all pool addresses containing that mint
    private readonly mintToPools = new Map<PubkeyStr, Set<PubkeyStr>>();

    // Stats
    private stats = {
        poolsRegistered: 0,
        pairsTracked: 0,
        priceUpdates: 0,
        divergenceAlerts: 0,
    };

    /**
     * Register a pool with the registry.
     */
    registerPool(info: Omit<PoolInfo, "lastPriceQ64" | "lastUpdateSlot" | "lastUpdateTs">): void {
        if (this.poolIndex.has(info.poolAddress)) {
            return; // Already registered
        }

        const pool: PoolInfo = {
            ...info,
            lastPriceQ64: BigInt(0),
            lastUpdateSlot: 0,
            lastUpdateTs: 0,
        };

        // Add to pool index
        this.poolIndex.set(info.poolAddress, pool);

        // Add to pair pools
        const pairKey = this.makePairKey(info.baseMint, info.quoteMint);
        let pairPools = this.pairPools.get(pairKey);
        if (!pairPools) {
            pairPools = {
                baseMint: info.baseMint,
                quoteMint: info.quoteMint,
                pools: new Map(),
            };
            this.pairPools.set(pairKey, pairPools);
            this.stats.pairsTracked++;
        }
        pairPools.pools.set(info.poolAddress, pool);

        // Add to mint index
        this.addToMintIndex(info.baseMint, info.poolAddress);
        this.addToMintIndex(info.quoteMint, info.poolAddress);

        this.stats.poolsRegistered++;
    }

    /**
     * Update pool price. Call this after simulating/decoding current reserves.
     */
    updatePrice(poolAddress: PubkeyStr, priceQ64: bigint, slot: number): void {
        const pool = this.poolIndex.get(poolAddress);
        if (!pool) return;

        pool.lastPriceQ64 = priceQ64;
        pool.lastUpdateSlot = slot;
        pool.lastUpdateTs = Date.now();
        this.stats.priceUpdates++;
    }

    /**
     * Get pool info by address.
     */
    getPool(poolAddress: PubkeyStr): PoolInfo | undefined {
        return this.poolIndex.get(poolAddress);
    }

    /**
     * Get all pools for a token pair.
     */
    getPoolsForPair(mintA: PubkeyStr, mintB: PubkeyStr): PoolInfo[] {
        const pairKey = this.makePairKey(mintA, mintB);
        const pair = this.pairPools.get(pairKey);
        return pair ? Array.from(pair.pools.values()) : [];
    }

    /**
     * Get all pools containing a specific mint.
     */
    getPoolsForMint(mint: PubkeyStr): PoolInfo[] {
        const addresses = this.mintToPools.get(mint);
        if (!addresses) return [];

        const pools: PoolInfo[] = [];
        for (const addr of addresses) {
            const pool = this.poolIndex.get(addr);
            if (pool) pools.push(pool);
        }
        return pools;
    }

    /**
     * Find cross-venue price divergences.
     * Returns pairs where the same token pair has different prices on different venues.
     *
     * @param minSpreadBps - Minimum spread to report (default 10 = 0.1%)
     */
    findDivergences(minSpreadBps: number = 10): PriceDivergence[] {
        const divergences: PriceDivergence[] = [];

        for (const pair of this.pairPools.values()) {
            if (pair.pools.size < 2) continue;

            const pools = Array.from(pair.pools.values())
                .filter(p => p.lastPriceQ64 > BigInt(0)); // Only pools with price data

            if (pools.length < 2) continue;

            // Find min and max prices
            let minPool: PoolInfo | null = null;
            let maxPool: PoolInfo | null = null;
            let minPrice = BigInt(0);
            let maxPrice = BigInt(0);

            for (const pool of pools) {
                if (minPool === null || pool.lastPriceQ64 < minPrice) {
                    minPool = pool;
                    minPrice = pool.lastPriceQ64;
                }
                if (maxPool === null || pool.lastPriceQ64 > maxPrice) {
                    maxPool = pool;
                    maxPrice = pool.lastPriceQ64;
                }
            }

            if (!minPool || !maxPool || minPool === maxPool) continue;
            if (minPrice === BigInt(0)) continue;

            // Calculate spread in basis points
            // spread = (max - min) / min * 10000
            const spreadQ64 = ((maxPrice - minPrice) * BigInt(10000)) / minPrice;
            const spreadBps = Number(spreadQ64);

            if (spreadBps >= minSpreadBps) {
                this.stats.divergenceAlerts++;
                divergences.push({
                    baseMint: pair.baseMint,
                    quoteMint: pair.quoteMint,
                    cheapPool: minPool,
                    expensivePool: maxPool,
                    spreadBps,
                    cheapPriceQ64: minPrice,
                    expensivePriceQ64: maxPrice,
                });
            }
        }

        return divergences;
    }

    /**
     * Get all token pairs that have pools on multiple venues.
     * These are the cross-venue arbitrage candidates.
     */
    getCrossVenuePairs(): { baseMint: PubkeyStr; quoteMint: PubkeyStr; venues: VenueType[] }[] {
        const result: { baseMint: PubkeyStr; quoteMint: PubkeyStr; venues: VenueType[] }[] = [];

        for (const pair of this.pairPools.values()) {
            const venues = new Set<VenueType>();
            for (const pool of pair.pools.values()) {
                venues.add(pool.venue);
            }

            if (venues.size >= 2) {
                result.push({
                    baseMint: pair.baseMint,
                    quoteMint: pair.quoteMint,
                    venues: Array.from(venues),
                });
            }
        }

        return result;
    }

    /**
     * Get stats.
     */
    getStats(): typeof this.stats {
        return { ...this.stats };
    }

    /**
     * Get total registered pools.
     */
    size(): number {
        return this.poolIndex.size;
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    private makePairKey(mintA: PubkeyStr, mintB: PubkeyStr): string {
        // Canonical ordering: lexicographically sorted
        return mintA < mintB ? `${mintA}|${mintB}` : `${mintB}|${mintA}`;
    }

    private addToMintIndex(mint: PubkeyStr, poolAddress: PubkeyStr): void {
        let pools = this.mintToPools.get(mint);
        if (!pools) {
            pools = new Set();
            this.mintToPools.set(mint, pools);
        }
        pools.add(poolAddress);
    }
}

// ============================================================================
// Price Calculation Helpers
// ============================================================================

/**
 * Calculate price from AMM reserves (constant product).
 * Returns price in Q64 fixed-point: priceQ64 = (quoteReserve / baseReserve) << 64
 */
export function priceFromReserves(baseReserve: bigint, quoteReserve: bigint): bigint {
    if (baseReserve === BigInt(0)) return BigInt(0);
    return (quoteReserve * Q64) / baseReserve;
}

/**
 * Calculate price from CLMM sqrtPriceX64.
 * Returns price in Q64 fixed-point.
 */
export function priceFromSqrtPriceX64(sqrtPriceX64: bigint): bigint {
    return (sqrtPriceX64 * sqrtPriceX64) / Q64;
}

/**
 * Calculate price from DLMM activeId and binStep.
 * Returns price in Q64 fixed-point.
 */
export function priceFromDlmmActiveId(activeId: number, binStep: number): bigint {
    // Price = (1 + binStep/10000)^activeId
    // For precision, we use the same formula as in dlmmHotPath.ts
    const basis = (BigInt(10000 + binStep) * Q64) / BigInt(10000);

    if (activeId === 0) return Q64;

    const abs = Math.abs(activeId);
    let result = Q64;
    let base = basis;
    let exp = abs;

    while (exp > 0) {
        if (exp & 1) {
            result = (result * base) >> BigInt(64);
        }
        exp >>= 1;
        if (exp > 0) {
            base = (base * base) >> BigInt(64);
        }
    }

    if (activeId > 0) return result;
    return (Q64 * Q64) / result;
}
