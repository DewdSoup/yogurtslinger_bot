/**
 * Dependency Derivation (Phase 3)
 * 
 * Derives required tick/bin arrays from pool state.
 * Used for bootstrap fetching and snapshot validation.
 */

import type { PoolState, RaydiumClmmPool, MeteoraDlmmPool } from '../types.js';
import { VenueId } from '../types.js';
import type { PoolDependencies } from './types.js';

const TICKS_PER_ARRAY = 60;
const BINS_PER_ARRAY = 70;

/**
 * Get tick array start index containing a tick
 */
export function getTickArrayStartIndex(tickCurrent: number, tickSpacing: number): number {
    const ticksPerArray = tickSpacing * TICKS_PER_ARRAY;
    // Handle negative ticks correctly
    if (tickCurrent >= 0) {
        return Math.floor(tickCurrent / ticksPerArray) * ticksPerArray;
    } else {
        // For negative: floor division rounds toward -infinity
        return Math.floor(tickCurrent / ticksPerArray) * ticksPerArray;
    }
}

/**
 * Get adjacent tick array start indexes for potential traversal
 * Returns array of start indexes covering ±radius arrays from current position
 *
 * With 60 ticks per array and typical tick spacings (1, 4, 10, 60),
 * radius=7 covers 840 ticks minimum (15 arrays × 60 ticks).
 * Large swaps crossing many ticks need expanded coverage.
 *
 * NOTE: This function returns the EXPECTED indexes. The actual tick arrays
 * that exist on-chain are determined by the pool's tickArrayBitmap.
 * Use getInitializedTickArraysInRange() from raydiumClmm.ts for that.
 *
 * @param tickCurrent - Current tick position
 * @param tickSpacing - Tick spacing for the pool
 * @param radius - Number of arrays on each side (default: 7)
 */
export function getRequiredTickArrays(
    tickCurrent: number,
    tickSpacing: number,
    radius: number = 7
): number[] {
    const ticksPerArray = tickSpacing * TICKS_PER_ARRAY;
    const currentStart = getTickArrayStartIndex(tickCurrent, tickSpacing);

    const result: number[] = [];
    for (let i = -radius; i <= radius; i++) {
        result.push(currentStart + i * ticksPerArray);
    }
    return result;
}

/**
 * Get bin array index containing a bin ID
 */
export function getBinArrayIndex(binId: number): number {
    if (binId >= 0) {
        return Math.floor(binId / BINS_PER_ARRAY);
    } else {
        // Handle negative bin IDs
        return Math.floor(binId / BINS_PER_ARRAY);
    }
}

/**
 * Get required bin array indexes for potential traversal
 * Returns array of indexes covering ±radius arrays from current position
 *
 * With 70 bins per array, radius=7 covers 1050 bins (15 arrays × 70 bins).
 * Large swaps (e.g., 14+ bins crossed) need expanded coverage.
 * Evidence showed swaps failing at 14 bins with only ±1 array coverage (G5.6).
 *
 * @param activeId - Current active bin ID
 * @param radius - Number of arrays on each side (default: 7)
 */
export function getRequiredBinArrays(activeId: number, radius: number = 7): number[] {
    const currentIndex = getBinArrayIndex(activeId);

    const result: number[] = [];
    for (let i = -radius; i <= radius; i++) {
        result.push(currentIndex + i);
    }
    return result;
}

/**
 * Configuration for dependency derivation
 */
export interface DeriveConfig {
    /** Number of tick arrays on each side of current position (default: 7) */
    tickArrayRadius?: number;
    /** Number of bin arrays on each side of active bin (default: 7) */
    binArrayRadius?: number;
}

/**
 * Derive all dependencies for a pool
 *
 * @param poolPubkey - Pool public key
 * @param pool - Pool state
 * @param config - Optional configuration for radius settings
 */
export function derivePoolDependencies(
    poolPubkey: Uint8Array,
    pool: PoolState,
    config?: DeriveConfig
): PoolDependencies {
    const tickArrayRadius = config?.tickArrayRadius ?? 7;
    const binArrayRadius = config?.binArrayRadius ?? 7;

    const deps: PoolDependencies = {
        poolPubkey,
        vaults: [],
    };

    switch (pool.venue) {
        case VenueId.PumpSwap:
            deps.vaults = [pool.baseVault, pool.quoteVault];
            break;

        case VenueId.RaydiumV4:
            deps.vaults = [pool.baseVault, pool.quoteVault];
            break;

        case VenueId.RaydiumClmm: {
            const clmm = pool as RaydiumClmmPool;
            deps.vaults = [clmm.tokenVault0, clmm.tokenVault1];
            deps.tickArrayIndexes = getRequiredTickArrays(clmm.tickCurrent, clmm.tickSpacing, tickArrayRadius);
            break;
        }

        case VenueId.MeteoraDlmm: {
            const dlmm = pool as MeteoraDlmmPool;
            deps.vaults = [dlmm.vaultX, dlmm.vaultY];
            deps.binArrayIndexes = getRequiredBinArrays(dlmm.activeId, binArrayRadius);
            break;
        }
    }

    return deps;
}