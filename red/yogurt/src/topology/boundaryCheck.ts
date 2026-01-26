/**
 * Boundary Check — Detects when pool price approaches frozen window edge
 *
 * Used to trigger topology refresh before the pool becomes unusable for simulation.
 *
 * The boundary check looks at:
 * - Current tick/bin position from pool state
 * - Frozen window (required tick/bin arrays) from topology
 * - Buffer threshold (how close to edge triggers refresh)
 */

import type { FrozenTopology } from '../cache/lifecycle.js';
import type { RaydiumClmmPool, MeteoraDlmmPool, PoolState } from '../types.js';
import { VenueId } from '../types.js';

// Constants matching fetchPoolDeps.ts
const TICKS_PER_ARRAY = 60;
const BINS_PER_ARRAY = 70;

/**
 * Result of boundary check
 */
export interface BoundaryCheckResult {
    /** Whether pool needs refresh */
    needsRefresh: boolean;
    /** Which boundary is being approached */
    boundary: 'lower' | 'upper' | 'both' | 'none';
    /** Current array index (tick start index or bin array index) */
    currentIndex: number;
    /** Minimum frozen array index */
    frozenMin: number;
    /** Maximum frozen array index */
    frozenMax: number;
    /** Distance to nearest boundary (in arrays) */
    distanceToEdge: number;
}

/**
 * Configuration for boundary checking
 */
export interface BoundaryCheckConfig {
    /**
     * Number of arrays from edge to trigger refresh (default: 1)
     * Lower = more aggressive refresh, higher = more buffer before refresh
     */
    bufferArrays: number;
}

const DEFAULT_CONFIG: BoundaryCheckConfig = {
    bufferArrays: 1,
};

/**
 * Get tick array start index for a given tick
 */
function getTickArrayStartIndex(tick: number, tickSpacing: number): number {
    const ticksPerArray = TICKS_PER_ARRAY * tickSpacing;
    return Math.floor(tick / ticksPerArray) * ticksPerArray;
}

/**
 * Get bin array index for a given bin ID
 */
function getBinArrayIndex(binId: number): number {
    return Math.floor(binId / BINS_PER_ARRAY);
}

/**
 * Check if CLMM pool is approaching frozen tick array boundary
 */
export function checkClmmBoundary(
    pool: RaydiumClmmPool,
    topology: FrozenTopology,
    config: BoundaryCheckConfig = DEFAULT_CONFIG
): BoundaryCheckResult {
    if (topology.requiredTickArrays.length === 0) {
        return {
            needsRefresh: false,
            boundary: 'none',
            currentIndex: 0,
            frozenMin: 0,
            frozenMax: 0,
            distanceToEdge: Infinity,
        };
    }

    const currentStart = getTickArrayStartIndex(pool.tickCurrent, pool.tickSpacing);
    const ticksPerArray = TICKS_PER_ARRAY * pool.tickSpacing;

    // Convert start indexes to array positions for comparison
    const frozenMin = Math.min(...topology.requiredTickArrays);
    const frozenMax = Math.max(...topology.requiredTickArrays);

    // Calculate distance to each boundary (in terms of array positions)
    const distanceToLower = (currentStart - frozenMin) / ticksPerArray;
    const distanceToUpper = (frozenMax - currentStart) / ticksPerArray;
    const distanceToEdge = Math.min(distanceToLower, distanceToUpper);

    const nearLower = distanceToLower <= config.bufferArrays;
    const nearUpper = distanceToUpper <= config.bufferArrays;

    let boundary: 'lower' | 'upper' | 'both' | 'none' = 'none';
    if (nearLower && nearUpper) {
        boundary = 'both';
    } else if (nearLower) {
        boundary = 'lower';
    } else if (nearUpper) {
        boundary = 'upper';
    }

    return {
        needsRefresh: nearLower || nearUpper,
        boundary,
        currentIndex: currentStart,
        frozenMin,
        frozenMax,
        distanceToEdge,
    };
}

/**
 * Check if DLMM pool is approaching frozen bin array boundary
 */
export function checkDlmmBoundary(
    pool: MeteoraDlmmPool,
    topology: FrozenTopology,
    config: BoundaryCheckConfig = DEFAULT_CONFIG
): BoundaryCheckResult {
    if (topology.requiredBinArrays.length === 0) {
        return {
            needsRefresh: false,
            boundary: 'none',
            currentIndex: 0,
            frozenMin: 0,
            frozenMax: 0,
            distanceToEdge: Infinity,
        };
    }

    const currentIndex = getBinArrayIndex(pool.activeId);
    const frozenMin = Math.min(...topology.requiredBinArrays);
    const frozenMax = Math.max(...topology.requiredBinArrays);

    const distanceToLower = currentIndex - frozenMin;
    const distanceToUpper = frozenMax - currentIndex;
    const distanceToEdge = Math.min(distanceToLower, distanceToUpper);

    const nearLower = distanceToLower <= config.bufferArrays;
    const nearUpper = distanceToUpper <= config.bufferArrays;

    let boundary: 'lower' | 'upper' | 'both' | 'none' = 'none';
    if (nearLower && nearUpper) {
        boundary = 'both';
    } else if (nearLower) {
        boundary = 'lower';
    } else if (nearUpper) {
        boundary = 'upper';
    }

    return {
        needsRefresh: nearLower || nearUpper,
        boundary,
        currentIndex,
        frozenMin,
        frozenMax,
        distanceToEdge,
    };
}

/**
 * Check if any pool is approaching its frozen boundary
 * Routes to appropriate venue-specific check
 */
export function checkPoolBoundary(
    pool: PoolState,
    topology: FrozenTopology,
    config: BoundaryCheckConfig = DEFAULT_CONFIG
): BoundaryCheckResult | null {
    switch (pool.venue) {
        case VenueId.RaydiumClmm:
            return checkClmmBoundary(pool as RaydiumClmmPool, topology, config);
        case VenueId.MeteoraDlmm:
            return checkDlmmBoundary(pool as MeteoraDlmmPool, topology, config);
        case VenueId.PumpSwap:
        case VenueId.RaydiumV4:
            // INTENTIONAL: Simple venues (constant product AMMs) do NOT refresh.
            //
            // Why? Unlike concentrated liquidity (CLMM/DLMM) which has position-dependent
            // tick/bin arrays that become invalid when price moves outside the frozen window,
            // constant product AMMs have:
            // - No tick/bin arrays - liquidity is distributed across all prices
            // - No position-dependent state - formula works for any price
            // - Only vaults needed - vault balances are tracked via gRPC
            //
            // Therefore, once a simple venue is ACTIVE, it stays valid forever without refresh.
            // The only dependencies (vaults) are updated via gRPC stream, not RPC.
            return null;
        default:
            return null;
    }
}

/**
 * Format boundary check result as human-readable reason string
 */
export function formatBoundaryReason(result: BoundaryCheckResult): string {
    if (!result.needsRefresh) {
        return 'within_window';
    }
    return `${result.boundary}_boundary_distance=${result.distanceToEdge}_current=${result.currentIndex}_range=[${result.frozenMin},${result.frozenMax}]`;
}
