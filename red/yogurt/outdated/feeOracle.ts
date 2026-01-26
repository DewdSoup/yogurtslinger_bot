/**
 * PumpSwap Fee Oracle (Sprint 1 - Fee Discovery)
 *
 * Learns swap fees from observed on-chain swaps and caches by pool+direction.
 *
 * Why this exists:
 * - PumpSwap has dynamic fees (1-25 bps observed range)
 * - Fees can differ by direction within the same pool
 * - GlobalConfig gives a global default, but real fees vary per pool
 *
 * How it works:
 * - When gRPC delivers confirmed swaps, we observe vault deltas
 * - Back-calculate implied fee from: reserveIn, reserveOut, amountIn, actualOut
 * - Cache the fee by pool+direction key
 * - Hot path simulation uses cached fee (O(1) lookup, zero RPC)
 *
 * Formula (solving CPMM for fee):
 *   actualOut = reserveOut * amountIn * (10000 - fee) / (reserveIn * 10000 + amountIn * (10000 - fee))
 *   Rearranging: amountInWithFee = actualOut * reserveIn * 10000 / (reserveOut - actualOut)
 *   Then: feeBps = (10000 * amountIn - amountInWithFee) * 10000 / (amountIn * 10000)
 */

import type { CacheStats, CacheTraceHandler } from './types.js';
import { SwapDirection } from '../types.js';

/** Fee entry for a pool+direction combination */
export interface FeeEntry {
    feeBps: bigint;
    /** Slot when this fee was observed */
    slot: number;
    /** Number of observations that confirmed this fee */
    observations: number;
    /** Last observation timestamp */
    lastSeenMs: number;
}

/** Key for fee cache: hex(pool) + ':' + direction */
export type FeeKey = string;

/**
 * Calculate the implied fee (in bps) from actual swap data.
 *
 * Uses input-fee model (fee deducted from input before swap):
 *   actualOut = reserveOut * amountIn * (10000-fee) / (reserveIn * 10000 + amountIn * (10000-fee))
 *
 * Solving for fee:
 *   amountInWithFee = actualOut * reserveIn * 10000 / (reserveOut - actualOut)
 *   feeBps = 10000 - amountInWithFee / amountIn
 *
 * @returns Fee in basis points, or -1 if calculation is invalid
 */
export function calculateImpliedFeeBps(
    reserveIn: bigint,
    reserveOut: bigint,
    amountIn: bigint,
    actualOut: bigint
): number {
    // Sanity checks
    if (actualOut >= reserveOut || actualOut <= 0n || amountIn <= 0n || reserveIn <= 0n) {
        return -1;
    }

    // amountInWithFee = actualOut * reserveIn * 10000 / (reserveOut - actualOut)
    const amountInWithFee = (actualOut * reserveIn * 10000n) / (reserveOut - actualOut);

    // feeBps = (10000 * amountIn - amountInWithFee) * 10000 / (amountIn * 10000)
    // Simplified: feeBps = 10000 - (amountInWithFee * 10000) / (amountIn * 10000)
    const feeBpsScaled = ((10000n * amountIn - amountInWithFee) * 10000n) / (amountIn * 10000n);

    return Number(feeBpsScaled);
}

/**
 * Create fee cache key from pool pubkey and direction
 */
export function makeFeeKey(poolPubkey: Uint8Array, direction: SwapDirection): FeeKey {
    const hex = Buffer.from(poolPubkey).toString('hex');
    return `${hex}:${direction}`;
}

/**
 * PumpSwap Fee Oracle
 *
 * Zero-latency fee lookup for simulation hot path.
 * Learns fees from observed confirmed swaps via gRPC.
 */
export class FeeOracle {
    private cache = new Map<FeeKey, FeeEntry>();
    private hitCount = 0n;
    private missCount = 0n;
    private traceHandler?: CacheTraceHandler;

    /** Default fee when no observation available (from GlobalConfig typical) */
    private defaultFeeBps = 25n;

    /** Minimum fee to accept (filter noise) */
    private minFeeBps = 0n;

    /** Maximum fee to accept (filter outliers) */
    private maxFeeBps = 200n;

    /**
     * Set the default fee to use when no observation is available
     */
    setDefaultFee(feeBps: bigint): void {
        this.defaultFeeBps = feeBps;
    }

    /**
     * Set trace handler for evidence capture
     */
    setTraceHandler(handler: CacheTraceHandler): void {
        this.traceHandler = handler;
    }

    /**
     * Get fee for a pool+direction combination
     *
     * @returns Fee in basis points (uses default if not cached)
     */
    getFee(poolPubkey: Uint8Array, direction: SwapDirection): bigint {
        const key = makeFeeKey(poolPubkey, direction);
        const entry = this.cache.get(key);

        if (entry) {
            this.hitCount++;
            return entry.feeBps;
        }

        this.missCount++;
        return this.defaultFeeBps;
    }

    /**
     * Get fee entry (includes metadata)
     *
     * @returns Entry or null if not cached
     */
    getEntry(poolPubkey: Uint8Array, direction: SwapDirection): FeeEntry | null {
        const key = makeFeeKey(poolPubkey, direction);
        return this.cache.get(key) ?? null;
    }

    /**
     * Check if we have an observed fee for this pool+direction
     */
    has(poolPubkey: Uint8Array, direction: SwapDirection): boolean {
        const key = makeFeeKey(poolPubkey, direction);
        return this.cache.has(key);
    }

    /**
     * Learn fee from an observed swap
     *
     * Called when gRPC delivers confirmed swap with vault deltas.
     *
     * @param poolPubkey - Pool account pubkey
     * @param direction - Swap direction (AtoB or BtoA)
     * @param reserveIn - Input reserve before swap
     * @param reserveOut - Output reserve before swap
     * @param amountIn - Input amount
     * @param actualOut - Actual output amount (from vault delta)
     * @param slot - Slot of the observation
     * @returns true if fee was learned/updated, false if calculation failed
     */
    learnFromSwap(
        poolPubkey: Uint8Array,
        direction: SwapDirection,
        reserveIn: bigint,
        reserveOut: bigint,
        amountIn: bigint,
        actualOut: bigint,
        slot: number
    ): boolean {
        // Calculate implied fee
        const impliedFee = calculateImpliedFeeBps(reserveIn, reserveOut, amountIn, actualOut);

        // Validate fee is in reasonable range
        if (impliedFee < Number(this.minFeeBps) || impliedFee > Number(this.maxFeeBps)) {
            return false;
        }

        const key = makeFeeKey(poolPubkey, direction);
        const existing = this.cache.get(key);
        const feeBps = BigInt(impliedFee);
        const now = Date.now();

        if (existing) {
            // Update existing entry
            // If slot is newer, use new fee; otherwise just increment observations
            if (slot >= existing.slot) {
                this.cache.set(key, {
                    feeBps,
                    slot,
                    observations: existing.observations + 1,
                    lastSeenMs: now,
                });
            } else {
                // Just increment observations count
                existing.observations++;
                existing.lastSeenMs = now;
            }
        } else {
            // New entry
            this.cache.set(key, {
                feeBps,
                slot,
                observations: 1,
                lastSeenMs: now,
            });
        }

        return true;
    }

    /**
     * Manually set fee for a pool+direction (e.g., from bootstrap)
     */
    setFee(poolPubkey: Uint8Array, direction: SwapDirection, feeBps: bigint, slot: number): void {
        const key = makeFeeKey(poolPubkey, direction);
        this.cache.set(key, {
            feeBps,
            slot,
            observations: 1,
            lastSeenMs: Date.now(),
        });
    }

    /**
     * Get cache statistics
     */
    stats(): CacheStats & { uniquePools: number; uniquePoolDirs: number } {
        // Count unique pools (ignoring direction)
        const pools = new Set<string>();
        for (const key of this.cache.keys()) {
            const pool = key.split(':')[0]!;
            pools.add(pool);
        }

        return {
            size: this.cache.size,
            hitCount: this.hitCount,
            missCount: this.missCount,
            evictionCount: 0n,
            lastUpdateSlot: 0,
            uniquePools: pools.size,
            uniquePoolDirs: this.cache.size,
        };
    }

    /**
     * Get all cached fees (for debugging/reporting)
     */
    getAllEntries(): Map<FeeKey, FeeEntry> {
        return new Map(this.cache);
    }

    /**
     * Get fee distribution summary
     */
    getFeeDistribution(): Map<number, number> {
        const dist = new Map<number, number>();
        for (const entry of this.cache.values()) {
            const fee = Number(entry.feeBps);
            dist.set(fee, (dist.get(fee) ?? 0) + 1);
        }
        return dist;
    }

    /**
     * Clear the cache
     */
    clear(): void {
        this.cache.clear();
        this.hitCount = 0n;
        this.missCount = 0n;
    }
}

/**
 * Create FeeOracle instance
 */
export function createFeeOracle(): FeeOracle {
    return new FeeOracle();
}
