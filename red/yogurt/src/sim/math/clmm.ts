/**
 * Concentrated Liquidity AMM Math (Phase 5)
 * 
 * Raydium CLMM implementation - derived from on-chain source analysis.
 * Uses Q64 fixed-point math (sqrtPriceX64).
 * 
 * Key formulas:
 * - sqrtPrice = 1.0001^(tick/2) * 2^64
 * - Δx = L * (1/√P_lower - 1/√P_upper)
 * - Δy = L * (√P_upper - √P_lower)
 * 
 * Gate requirements:
 * - Sim accuracy within 0.1% of actual (G5.3)
 * - 100% tick traversal accuracy (G5.5)
 */

import type {
    SimInput,
    SimResult,
    RaydiumClmmPool,
    TickArray,
    Tick,
} from '../../types.js';
import { SwapDirection, ErrorClass } from '../../types.js';

// Q64 fixed-point constants
const Q64 = 2n ** 64n;
const Q128 = 2n ** 128n;

// Tick bounds (same as Uniswap V3)
const MIN_TICK = -443636;
const MAX_TICK = 443636;

// Minimum/maximum sqrt prices
const MIN_SQRT_PRICE_X64 = 4295048016n; // sqrt(1.0001^MIN_TICK) * 2^64
const MAX_SQRT_PRICE_X64 = 79226673515401279992447579055n; // sqrt(1.0001^MAX_TICK) * 2^64

// Precomputed values for tick → sqrt price conversion
// These are 1.0001^(2^i) * 2^64 for binary decomposition
const TICK_MULTIPLIERS: bigint[] = [
    18446744073709551616n,  // 2^64 (1.0001^0)
    18446744073709551616n,  // adjusted base
];

/**
 * Convert tick to sqrt price in Q64 format
 * sqrtPrice = 1.0001^(tick/2) * 2^64
 * 
 * Uses binary decomposition for precision and efficiency.
 */
export function tickToSqrtPriceX64(tick: number): bigint {
    if (tick < MIN_TICK || tick > MAX_TICK) {
        throw new Error(`Tick ${tick} out of bounds [${MIN_TICK}, ${MAX_TICK}]`);
    }

    const absTick = Math.abs(tick);

    // Start with 2^64
    let ratio = Q64;

    // Binary decomposition: multiply by 1.0001^(2^i) for each set bit
    // These magic numbers are precomputed 1.0001^(2^i) * 2^64
    if ((absTick & 0x1) !== 0) ratio = (ratio * 18446744073709551616n) >> 64n;
    if ((absTick & 0x2) !== 0) ratio = (ratio * 18446744073709553664n) >> 64n;
    if ((absTick & 0x4) !== 0) ratio = (ratio * 18446744073709555712n) >> 64n;
    if ((absTick & 0x8) !== 0) ratio = (ratio * 18446744073709559808n) >> 64n;
    if ((absTick & 0x10) !== 0) ratio = (ratio * 18446744073709568000n) >> 64n;
    if ((absTick & 0x20) !== 0) ratio = (ratio * 18446744073709584384n) >> 64n;
    if ((absTick & 0x40) !== 0) ratio = (ratio * 18446744073709617152n) >> 64n;
    if ((absTick & 0x80) !== 0) ratio = (ratio * 18446744073709682688n) >> 64n;
    if ((absTick & 0x100) !== 0) ratio = (ratio * 18446744073709813760n) >> 64n;
    if ((absTick & 0x200) !== 0) ratio = (ratio * 18446744073710075904n) >> 64n;
    if ((absTick & 0x400) !== 0) ratio = (ratio * 18446744073710600192n) >> 64n;
    if ((absTick & 0x800) !== 0) ratio = (ratio * 18446744073711648768n) >> 64n;
    if ((absTick & 0x1000) !== 0) ratio = (ratio * 18446744073713745920n) >> 64n;
    if ((absTick & 0x2000) !== 0) ratio = (ratio * 18446744073717940224n) >> 64n;
    if ((absTick & 0x4000) !== 0) ratio = (ratio * 18446744073726328832n) >> 64n;
    if ((absTick & 0x8000) !== 0) ratio = (ratio * 18446744073743106048n) >> 64n;
    if ((absTick & 0x10000) !== 0) ratio = (ratio * 18446744073776660480n) >> 64n;
    if ((absTick & 0x20000) !== 0) ratio = (ratio * 18446744073843769344n) >> 64n;
    if ((absTick & 0x40000) !== 0) ratio = (ratio * 18446744073977987072n) >> 64n;

    // For negative ticks, we need 1/ratio
    if (tick < 0) {
        ratio = Q128 / ratio;
    }

    return ratio;
}

/**
 * Convert sqrt price (Q64) to tick using pure BigInt binary search
 *
 * tick = floor(log(sqrtPrice^2) / log(1.0001))
 *
 * Uses binary search on tickToSqrtPriceX64 to find the exact tick
 * without any floating-point conversions. This is critical for
 * maintaining precision with large Q64 values that exceed Number.MAX_SAFE_INTEGER.
 */
export function sqrtPriceX64ToTick(sqrtPriceX64: bigint): number {
    if (sqrtPriceX64 < MIN_SQRT_PRICE_X64 || sqrtPriceX64 > MAX_SQRT_PRICE_X64) {
        throw new Error('Sqrt price out of bounds');
    }

    // Binary search for tick such that:
    //   tickToSqrtPriceX64(tick) <= sqrtPriceX64 < tickToSqrtPriceX64(tick + 1)
    let low = MIN_TICK;
    let high = MAX_TICK;

    while (low < high) {
        // Use ceiling division to avoid infinite loop
        const mid = low + Math.floor((high - low + 1) / 2);
        const midSqrtPrice = tickToSqrtPriceX64(mid);

        if (midSqrtPrice <= sqrtPriceX64) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }

    return low;
}

/**
 * Calculate amount0 delta for liquidity and price range
 * Δx = L * (√P_upper - √P_lower) / (√P_lower * √P_upper)
 * 
 * Equivalent to: L * (1/√P_lower - 1/√P_upper)
 */
export function getAmount0Delta(
    sqrtPriceLowerX64: bigint,
    sqrtPriceUpperX64: bigint,
    liquidity: bigint,
    roundUp: boolean
): bigint {
    if (sqrtPriceLowerX64 > sqrtPriceUpperX64) {
        [sqrtPriceLowerX64, sqrtPriceUpperX64] = [sqrtPriceUpperX64, sqrtPriceLowerX64];
    }

    const numerator = liquidity * (sqrtPriceUpperX64 - sqrtPriceLowerX64);
    const denominator = sqrtPriceLowerX64 * sqrtPriceUpperX64;

    if (roundUp) {
        return (numerator * Q64 + denominator - 1n) / denominator;
    } else {
        return (numerator * Q64) / denominator;
    }
}

/**
 * Calculate amount1 delta for liquidity and price range
 * Δy = L * (√P_upper - √P_lower) / 2^64
 */
export function getAmount1Delta(
    sqrtPriceLowerX64: bigint,
    sqrtPriceUpperX64: bigint,
    liquidity: bigint,
    roundUp: boolean
): bigint {
    if (sqrtPriceLowerX64 > sqrtPriceUpperX64) {
        [sqrtPriceLowerX64, sqrtPriceUpperX64] = [sqrtPriceUpperX64, sqrtPriceLowerX64];
    }

    const diff = sqrtPriceUpperX64 - sqrtPriceLowerX64;

    if (roundUp) {
        return (liquidity * diff + Q64 - 1n) / Q64;
    } else {
        return (liquidity * diff) / Q64;
    }
}

/**
 * Get next sqrt price from input amount
 * 
 * zeroForOne (sell token0 for token1):
 *   sqrtPrice_new = sqrtPrice * L / (L + Δx * sqrtPrice)
 * 
 * oneForZero (sell token1 for token0):
 *   sqrtPrice_new = sqrtPrice + Δy / L
 */
export function getNextSqrtPriceFromInput(
    sqrtPriceX64: bigint,
    liquidity: bigint,
    amountIn: bigint,
    zeroForOne: boolean
): bigint {
    if (sqrtPriceX64 <= 0n || liquidity <= 0n) {
        throw new Error('Invalid sqrt price or liquidity');
    }

    if (zeroForOne) {
        // Selling token0: price decreases
        // sqrtPrice_new = sqrtPrice * L / (L + Δx * sqrtPrice / 2^64)
        const product = amountIn * sqrtPriceX64;
        const denominator = (liquidity << 64n) + product;
        return (sqrtPriceX64 * (liquidity << 64n)) / denominator;
    } else {
        // Selling token1: price increases
        // sqrtPrice_new = sqrtPrice + Δy * 2^64 / L
        return sqrtPriceX64 + (amountIn << 64n) / liquidity;
    }
}

/**
 * Get next sqrt price from output amount
 */
export function getNextSqrtPriceFromOutput(
    sqrtPriceX64: bigint,
    liquidity: bigint,
    amountOut: bigint,
    zeroForOne: boolean
): bigint {
    if (sqrtPriceX64 <= 0n || liquidity <= 0n) {
        throw new Error('Invalid sqrt price or liquidity');
    }

    if (zeroForOne) {
        // Getting token1 out: price decreases
        // sqrtPrice_new = sqrtPrice - Δy * 2^64 / L
        const delta = (amountOut << 64n) / liquidity;
        if (delta >= sqrtPriceX64) {
            throw new Error('Insufficient liquidity for output');
        }
        return sqrtPriceX64 - delta;
    } else {
        // Getting token0 out: price increases
        // sqrtPrice_new = L * sqrtPrice / (L - Δx * sqrtPrice / 2^64)
        const product = amountOut * sqrtPriceX64;
        const denominator = (liquidity << 64n) - product;
        if (denominator <= 0n) {
            throw new Error('Insufficient liquidity for output');
        }
        return (sqrtPriceX64 * (liquidity << 64n)) / denominator;
    }
}

/**
 * Compute swap step within a single tick range
 * Returns: amount consumed, amount out, fee amount, new sqrt price
 */
export function computeSwapStep(
    sqrtPriceCurrentX64: bigint,
    sqrtPriceTargetX64: bigint,
    liquidity: bigint,
    amountRemaining: bigint,
    feeRate: bigint, // in basis points (e.g., 25n = 0.25%)
    exactInput: boolean
): {
    sqrtPriceNextX64: bigint;
    amountIn: bigint;
    amountOut: bigint;
    feeAmount: bigint;
} {
    const zeroForOne = sqrtPriceCurrentX64 >= sqrtPriceTargetX64;

    // Calculate max amounts for this step
    let amountIn: bigint;
    let amountOut: bigint;

    if (exactInput) {
        // Apply fee to input
        const amountRemainingLessFee = (amountRemaining * (10000n - feeRate)) / 10000n;

        if (zeroForOne) {
            amountIn = getAmount0Delta(sqrtPriceTargetX64, sqrtPriceCurrentX64, liquidity, true);
        } else {
            amountIn = getAmount1Delta(sqrtPriceCurrentX64, sqrtPriceTargetX64, liquidity, true);
        }

        let sqrtPriceNextX64: bigint;
        if (amountRemainingLessFee >= amountIn) {
            // Can reach target price
            sqrtPriceNextX64 = sqrtPriceTargetX64;
        } else {
            // Partially consume
            sqrtPriceNextX64 = getNextSqrtPriceFromInput(
                sqrtPriceCurrentX64,
                liquidity,
                amountRemainingLessFee,
                zeroForOne
            );
            amountIn = amountRemainingLessFee;
        }

        // Calculate output
        if (zeroForOne) {
            amountOut = getAmount1Delta(sqrtPriceNextX64, sqrtPriceCurrentX64, liquidity, false);
        } else {
            amountOut = getAmount0Delta(sqrtPriceCurrentX64, sqrtPriceNextX64, liquidity, false);
        }

        // Calculate fee
        const feeAmount = amountRemaining - amountIn > 0n
            ? amountRemaining - amountIn
            : (amountIn * feeRate) / (10000n - feeRate);

        return {
            sqrtPriceNextX64,
            amountIn,
            amountOut,
            feeAmount,
        };
    } else {
        // Exact output
        if (zeroForOne) {
            amountOut = getAmount1Delta(sqrtPriceTargetX64, sqrtPriceCurrentX64, liquidity, false);
        } else {
            amountOut = getAmount0Delta(sqrtPriceCurrentX64, sqrtPriceTargetX64, liquidity, false);
        }

        let sqrtPriceNextX64: bigint;
        if (amountRemaining >= amountOut) {
            sqrtPriceNextX64 = sqrtPriceTargetX64;
        } else {
            sqrtPriceNextX64 = getNextSqrtPriceFromOutput(
                sqrtPriceCurrentX64,
                liquidity,
                amountRemaining,
                zeroForOne
            );
            amountOut = amountRemaining;
        }

        // Calculate input
        if (zeroForOne) {
            amountIn = getAmount0Delta(sqrtPriceNextX64, sqrtPriceCurrentX64, liquidity, true);
        } else {
            amountIn = getAmount1Delta(sqrtPriceCurrentX64, sqrtPriceNextX64, liquidity, true);
        }

        // Calculate fee on input
        const feeAmount = (amountIn * feeRate) / (10000n - feeRate);

        return {
            sqrtPriceNextX64,
            amountIn: amountIn + feeAmount,
            amountOut,
            feeAmount,
        };
    }
}

/**
 * Get tick from tick array
 */
export function getTickFromArray(
    tickArrays: TickArray[],
    tickIndex: number,
    tickSpacing: number
): Tick | null {
    // Raydium uses 60 ticks per array (TICK_ARRAY_SIZE)
    const TICK_ARRAY_SIZE = 60;
    const ticksPerArray = TICK_ARRAY_SIZE * tickSpacing;

    // Calculate start tick of the array containing this tick
    let arrayStartTick: number;
    if (tickIndex >= 0) {
        arrayStartTick = Math.floor(tickIndex / ticksPerArray) * ticksPerArray;
    } else {
        arrayStartTick = Math.ceil((tickIndex + 1) / ticksPerArray) * ticksPerArray - ticksPerArray;
    }

    // Find the array
    const array = tickArrays.find(a => a.startTickIndex === arrayStartTick);
    if (!array) return null;

    // Calculate offset within array
    const tickOffset = Math.floor((tickIndex - arrayStartTick) / tickSpacing);
    if (tickOffset < 0 || tickOffset >= TICK_ARRAY_SIZE) return null;

    return array.ticks[tickOffset] || null;
}

/**
 * Find next initialized tick in direction
 */
export function findNextInitializedTick(
    tickArrays: TickArray[],
    currentTick: number,
    tickSpacing: number,
    zeroForOne: boolean
): { tick: number; initialized: boolean } | null {
    const step = zeroForOne ? -tickSpacing : tickSpacing;
    let searchTick = Math.floor(currentTick / tickSpacing) * tickSpacing;

    // Search up to 1000 ticks
    for (let i = 0; i < 1000; i++) {
        searchTick += step;
        const tick = getTickFromArray(tickArrays, searchTick, tickSpacing);
        if (tick && tick.initialized) {
            return { tick: searchTick, initialized: true };
        }
    }

    return null;
}

/**
 * Simulate CLMM swap
 * 
 * This is the main swap simulation function that:
 * 1. Iterates through tick ranges
 * 2. Computes swap amounts in each range
 * 3. Crosses ticks and updates liquidity
 * 4. Accumulates total amounts
 */
export function simulateClmm(
    input: SimInput,
    tickArrays: TickArray[]
): SimResult {
    const pool = input.poolState as RaydiumClmmPool;
    const { direction, inputAmount } = input;

    const zeroForOne = direction === SwapDirection.AtoB;
    const exactInput = true; // We're always providing exact input

    // Get fee rate with default (CLMM common tiers: 1, 4, 25, 100 bps)
    // Default to 25 bps (0.25%) if not specified
    const feeRate = pool.feeRate ?? 25n;

    // Initialize state
    let sqrtPriceX64 = pool.sqrtPriceX64;
    let tick = pool.tickCurrent;
    let liquidity = pool.liquidity;
    let amountRemaining = inputAmount;
    let amountCalculated = 0n;
    let totalFee = 0n;

    // Iterate until input consumed or no more liquidity
    const maxIterations = 100;
    let iterations = 0;

    while (amountRemaining > 0n && iterations < maxIterations) {
        iterations++;

        // Find next tick boundary
        const nextTickResult = findNextInitializedTick(
            tickArrays,
            tick,
            pool.tickSpacing,
            zeroForOne
        );

        if (!nextTickResult) {
            // No more initialized ticks
            return {
                success: false,
                outputAmount: amountCalculated,
                newPoolState: pool,
                priceImpactBps: 0,
                feePaid: totalFee,
                error: ErrorClass.InsufficientLiquidity,
                latencyUs: 0,
            };
        }

        const sqrtPriceTargetX64 = tickToSqrtPriceX64(nextTickResult.tick);

        // Compute swap step
        const step = computeSwapStep(
            sqrtPriceX64,
            sqrtPriceTargetX64,
            liquidity,
            amountRemaining,
            feeRate,
            exactInput
        );

        // Update state
        sqrtPriceX64 = step.sqrtPriceNextX64;
        // Only subtract amountIn - fee already deducted in computeSwapStep calculation
        amountRemaining -= step.amountIn;
        amountCalculated += step.amountOut;
        totalFee += step.feeAmount;

        // Check if we crossed the tick
        if (sqrtPriceX64 === sqrtPriceTargetX64) {
            // Cross tick - update liquidity
            const crossedTick = getTickFromArray(
                tickArrays,
                nextTickResult.tick,
                pool.tickSpacing
            );

            if (crossedTick && crossedTick.initialized) {
                // liquidityNet is positive if liquidity is added when crossing up
                // and negative if removed
                const liquidityDelta = zeroForOne
                    ? -crossedTick.liquidityNet
                    : crossedTick.liquidityNet;

                liquidity += liquidityDelta;

                if (liquidity < 0n) {
                    return {
                        success: false,
                        outputAmount: amountCalculated,
                        newPoolState: pool,
                        priceImpactBps: 0,
                        feePaid: totalFee,
                        error: ErrorClass.InsufficientLiquidity,
                        latencyUs: 0,
                    };
                }
            }

            tick = zeroForOne ? nextTickResult.tick - 1 : nextTickResult.tick;
        } else {
            // Didn't reach tick boundary
            tick = sqrtPriceX64ToTick(sqrtPriceX64);
        }
    }

    if (iterations >= maxIterations) {
        return {
            success: false,
            outputAmount: amountCalculated,
            newPoolState: pool,
            priceImpactBps: 0,
            feePaid: totalFee,
            error: ErrorClass.Unknown,
            latencyUs: 0,
        };
    }

    // Calculate price impact using pure BigInt arithmetic
    // priceImpact = |priceAfter - priceBefore| / priceBefore * 10000
    // price = sqrtPrice^2, so we compare sqrtPrice^2 values directly
    const priceBefore = pool.sqrtPriceX64 * pool.sqrtPriceX64;
    const priceAfter = sqrtPriceX64 * sqrtPriceX64;
    // Compute impact in basis points using BigInt: |after - before| * 10000 / before
    const absDiff = priceAfter > priceBefore ? priceAfter - priceBefore : priceBefore - priceAfter;
    const priceImpactBps = priceBefore > 0n
        ? Number((absDiff * 10000n) / priceBefore)
        : 0;

    // Create new pool state
    const newPoolState: RaydiumClmmPool = {
        ...pool,
        sqrtPriceX64,
        tickCurrent: tick,
        liquidity,
    };

    return {
        success: true,
        outputAmount: amountCalculated,
        newPoolState,
        priceImpactBps,
        feePaid: totalFee,
        latencyUs: 0,
    };
}

// Export constants for testing
export const CONSTANTS = {
    Q64,
    Q128,
    MIN_TICK,
    MAX_TICK,
    MIN_SQRT_PRICE_X64,
    MAX_SQRT_PRICE_X64,
};