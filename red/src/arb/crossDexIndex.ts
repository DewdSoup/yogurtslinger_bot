// src/arb/crossDexIndex.ts
//
// Lean cross-DEX index for PumpSwap fracture arbitrage.
//
// Tracks:
// - Which mints have pools on which venues
// - Price quotes across venues for the same mint
// - Detects new pool creation (fracture events)

import type { PubkeyStr } from "../state/accountStore";

export type Venue = "pumpswap" | "raydium_v4" | "raydium_clmm" | "meteora_dlmm";

export interface PoolInfo {
    venue: Venue;
    poolAddress: PubkeyStr;
    baseMint: PubkeyStr;  // Token mint (non-SOL side)
    quoteMint: PubkeyStr; // Usually SOL/WSOL
    baseVault: PubkeyStr;
    quoteVault: PubkeyStr;
    /** Approximate price in quote per base (for quick comparison) */
    lastPrice?: number;
    lastPriceSlot?: number;
}

export interface CrossDexOpportunity {
    mint: PubkeyStr;
    buyVenue: Venue;
    buyPool: PubkeyStr;
    buyPrice: number;  // Price to buy (quote per base)
    sellVenue: Venue;
    sellPool: PubkeyStr;
    sellPrice: number; // Price to sell
    spreadBps: number; // Profit spread in basis points
    detectedAt: number;
}

/**
 * Cross-DEX index for tracking mints across venues.
 *
 * Strategy: PumpSwap tokens that "fracture" to secondary DEXes
 * create temporary price inefficiencies.
 */
export class CrossDexIndex {
    // mint -> venue -> PoolInfo
    private mintPools = new Map<PubkeyStr, Map<Venue, PoolInfo>>();

    // Track PumpSwap mints (source of fracture opportunities)
    private pumpswapMints = new Set<PubkeyStr>();

    // Callback when a PumpSwap token appears on secondary DEX
    private onFractureDetected?: (mint: PubkeyStr, newVenue: Venue, pool: PoolInfo) => void;

    /**
     * Register a pool for a mint.
     * Returns true if this is a new "fracture" (PumpSwap mint appearing on secondary DEX).
     */
    registerPool(pool: PoolInfo): boolean {
        const { baseMint, venue } = pool;

        let venueMap = this.mintPools.get(baseMint);
        if (!venueMap) {
            venueMap = new Map();
            this.mintPools.set(baseMint, venueMap);
        }

        const isNew = !venueMap.has(venue);
        venueMap.set(venue, pool);

        // Track PumpSwap mints
        if (venue === "pumpswap") {
            this.pumpswapMints.add(baseMint);
        }

        // Detect fracture: PumpSwap mint appearing on secondary DEX
        const isFracture = isNew &&
                          venue !== "pumpswap" &&
                          this.pumpswapMints.has(baseMint);

        if (isFracture && this.onFractureDetected) {
            this.onFractureDetected(baseMint, venue, pool);
        }

        return isFracture;
    }

    /**
     * Update price for a pool.
     */
    updatePrice(poolAddress: PubkeyStr, price: number, slot: number): void {
        // Find pool by address (less efficient but keeps API simple)
        for (const venueMap of this.mintPools.values()) {
            for (const pool of venueMap.values()) {
                if (pool.poolAddress === poolAddress) {
                    pool.lastPrice = price;
                    pool.lastPriceSlot = slot;
                    return;
                }
            }
        }
    }

    /**
     * Get all pools for a mint.
     */
    getPoolsForMint(mint: PubkeyStr): PoolInfo[] {
        const venueMap = this.mintPools.get(mint);
        if (!venueMap) return [];
        return Array.from(venueMap.values());
    }

    /**
     * Get mints that exist on multiple venues (arb candidates).
     */
    getMultiVenueMints(): PubkeyStr[] {
        const results: PubkeyStr[] = [];
        for (const [mint, venueMap] of this.mintPools) {
            if (venueMap.size > 1) {
                results.push(mint);
            }
        }
        return results;
    }

    /**
     * Find cross-DEX arbitrage opportunities.
     * Returns opportunities sorted by spread (highest first).
     */
    findOpportunities(minSpreadBps: number = 50): CrossDexOpportunity[] {
        const opps: CrossDexOpportunity[] = [];
        const now = Date.now();

        for (const [mint, venueMap] of this.mintPools) {
            if (venueMap.size < 2) continue;

            const pools = Array.from(venueMap.values())
                .filter(p => p.lastPrice !== undefined && p.lastPrice > 0);

            if (pools.length < 2) continue;

            // Compare all pairs
            for (let i = 0; i < pools.length; i++) {
                for (let j = i + 1; j < pools.length; j++) {
                    const a = pools[i]!;
                    const b = pools[j]!;

                    // Calculate spread both directions
                    // Direction 1: Buy on A, Sell on B
                    const spread1 = (b.lastPrice! - a.lastPrice!) / a.lastPrice! * 10000;
                    // Direction 2: Buy on B, Sell on A
                    const spread2 = (a.lastPrice! - b.lastPrice!) / b.lastPrice! * 10000;

                    if (spread1 >= minSpreadBps) {
                        opps.push({
                            mint,
                            buyVenue: a.venue,
                            buyPool: a.poolAddress,
                            buyPrice: a.lastPrice!,
                            sellVenue: b.venue,
                            sellPool: b.poolAddress,
                            sellPrice: b.lastPrice!,
                            spreadBps: spread1,
                            detectedAt: now,
                        });
                    }

                    if (spread2 >= minSpreadBps) {
                        opps.push({
                            mint,
                            buyVenue: b.venue,
                            buyPool: b.poolAddress,
                            buyPrice: b.lastPrice!,
                            sellVenue: a.venue,
                            sellPool: a.poolAddress,
                            sellPrice: a.lastPrice!,
                            spreadBps: spread2,
                            detectedAt: now,
                        });
                    }
                }
            }
        }

        // Sort by spread (highest first)
        return opps.sort((a, b) => b.spreadBps - a.spreadBps);
    }

    /**
     * Set callback for fracture detection.
     */
    onFracture(callback: (mint: PubkeyStr, venue: Venue, pool: PoolInfo) => void): void {
        this.onFractureDetected = callback;
    }

    /**
     * Get stats.
     */
    getStats(): { totalMints: number; multiVenueMints: number; pumpswapMints: number } {
        return {
            totalMints: this.mintPools.size,
            multiVenueMints: this.getMultiVenueMints().length,
            pumpswapMints: this.pumpswapMints.size,
        };
    }
}
