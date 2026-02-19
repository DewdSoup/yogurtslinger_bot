/**
 * Discrete Liquidity Market Maker Math (Phase 5)
 * 
 * Meteora DLMM implementation - derived from on-chain source analysis.
 * Uses discrete bins with exponential pricing.
 * 
 * Key formulas:
 * - price(binId) = (1 + binStep/10000)^(binId - 2^23)
 * - Bins contain X and Y reserves
 * - Swap consumes liquidity bin-by-bin
 * 
 * Gate requirements:
 * - Sim accuracy within 0.1% of actual (G5.4)
 * - 100% bin traversal accuracy (G5.6)
 */

import type {
    SimInput,
    SimResult,
    MeteoraDlmmPool,
    BinArray,
    Bin,
} from '../../types.js';
import { SwapDirection, ErrorClass } from '../../types.js';

// Precision constants
const SCALE_OFFSET = 64;
const SCALE = 2n ** BigInt(SCALE_OFFSET);
const BASIS_POINT_MAX = 10000;
const BINS_PER_ARRAY = 70;
// Price precision
const PRICE_PRECISION = 1_000_000_000_000n; // 10^12 for internal math
// DLMM fee constants (from Meteora formula documentation)
const DLMM_FEE_PRECISION = 1_000_000_000n;
const DLMM_MAX_FEE_RATE = 100_000_000n; // 10% in 1e9 fee precision
const DLMM_VAR_FEE_SCALE = 100_000_000_000n;
const DLMM_VAR_FEE_OFFSET = 99_999_999_999n;

/**
 * Fixed-point exponentiation by squaring
 * Computes base^exp where base is in Q64 format
 * Uses binary exponentiation for O(log n) efficiency
 *
 * @param baseQ64 - Base value in Q64 fixed-point (1.0 = SCALE)
 * @param exp - Non-negative exponent
 * @returns Result in Q64 format
 */
function powQ64(baseQ64: bigint, exp: number): bigint {
    if (exp === 0) return SCALE;
    if (exp === 1) return baseQ64;

    let result = SCALE; // Start with 1.0 in Q64
    let base = baseQ64;
    let e = exp;

    // Exponentiation by squaring
    while (e > 0) {
        if (e & 1) {
            // result = result * base / SCALE
            result = (result * base) / SCALE;
        }
        // base = base * base / SCALE
        base = (base * base) / SCALE;
        e >>= 1;
    }

    return result;
}

/**
 * Calculate bin price from bin ID
 * price = (1 + binStep/10000)^binId
 *
 * Meteora DLMM uses activeId directly - no offset subtraction.
 * activeId = 0 → price = 1.0
 * activeId > 0 → price > 1.0
 * activeId < 0 → price < 1.0
 *
 * Uses fixed-point BigInt math throughout to avoid floating-point precision drift.
 * Returns price in Q64 format
 */
export function getPriceFromBinId(binId: number, binStep: number): bigint {
    // Handle identity case
    if (binId === 0) return SCALE;

    // Calculate base = 1 + binStep/10000 in Q64 format
    // base_Q64 = SCALE + (SCALE * binStep) / 10000
    const binStepBigInt = BigInt(binStep);
    const baseQ64 = SCALE + (SCALE * binStepBigInt) / BigInt(BASIS_POINT_MAX);

    // Handle negative exponents: price = 1 / base^|binId|
    if (binId < 0) {
        const positiveExp = -binId;
        const denominator = powQ64(baseQ64, positiveExp);

        // Guard against division by zero (shouldn't happen with valid inputs)
        if (denominator === 0n) return SCALE;

        // result = SCALE^2 / denominator (to maintain Q64 precision)
        return (SCALE * SCALE) / denominator;
    }

    // Positive exponent: price = base^binId
    return powQ64(baseQ64, binId);
}

/**
 * Calculate bin ID from price (inverse of getPriceFromBinId)
 *
 * Uses pure BigInt binary search to find binId such that:
 *   getPriceFromBinId(binId) <= priceX64 < getPriceFromBinId(binId + 1)
 *
 * This avoids floating-point precision issues with large Q64 values.
 */
export function getBinIdFromPrice(priceX64: bigint, binStep: number): number {
    // Guard against invalid input
    if (priceX64 <= 0n || binStep <= 0) {
        return 0;
    }

    // Handle identity case
    if (priceX64 === SCALE) {
        return 0;
    }

    // Determine search direction based on whether price is above or below 1.0
    const isAboveOne = priceX64 > SCALE;

    // Binary search bounds - DLMM typically uses reasonable bin ranges
    // Max bins for most pairs is around ±50000
    const MAX_BIN_SEARCH = 100000;

    if (isAboveOne) {
        // Price > 1.0, binId > 0
        let low = 0;
        let high = MAX_BIN_SEARCH;

        while (low < high) {
            const mid = low + Math.floor((high - low + 1) / 2);
            const midPrice = getPriceFromBinId(mid, binStep);

            if (midPrice <= priceX64) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        return low;
    } else {
        // Price < 1.0, binId < 0
        let low = -MAX_BIN_SEARCH;
        let high = 0;

        while (low < high) {
            const mid = low + Math.floor((high - low + 1) / 2);
            const midPrice = getPriceFromBinId(mid, binStep);

            if (midPrice <= priceX64) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        return low;
    }
}

/**
 * Get bin from bin arrays
 */
export function getBinFromArrays(
    binArrays: BinArray[],
    binId: number
): Bin | null {
    // Each bin array covers BINS_PER_ARRAY bins
    // Calculate which array contains this bin
    // Meteora DLMM uses binId directly for array index computation
    const arrayIndex = Math.floor(binId / BINS_PER_ARRAY);
    const binOffset = ((binId % BINS_PER_ARRAY) + BINS_PER_ARRAY) % BINS_PER_ARRAY;

    // Find the array with this index
    const array = binArrays.find(a => Number(a.index) === arrayIndex);
    if (!array) return null;

    if (binOffset < 0 || binOffset >= array.bins.length) return null;

    return array.bins[binOffset] || null;
}

/**
 * Calculate swap output for single bin
 * 
 * In DLMM, each bin has X (token0) and Y (token1) reserves.
 * Price in bin is fixed (determined by binId).
 * 
 * swapForY = true: selling X for Y
 *   outputY = min(inputX * price, binYReserve)
 * 
 * swapForY = false: selling Y for X  
 *   outputX = min(inputY / price, binXReserve)
 */
export function swapInBin(
    bin: Bin,
    inputAmount: bigint,
    swapForY: boolean,
    binPriceX64: bigint
): { outputAmount: bigint; inputConsumed: bigint; binDepleted: boolean } {
    // Guard against null/undefined bin amounts
    const amountX = bin.amountX ?? 0n;
    const amountY = bin.amountY ?? 0n;

    if (swapForY) {
        // Selling X for Y
        // outputY = inputX * price
        const maxOutputY = (inputAmount * binPriceX64) / SCALE;

        if (maxOutputY <= amountY) {
            // Bin has enough Y
            return {
                outputAmount: maxOutputY,
                inputConsumed: inputAmount,
                binDepleted: maxOutputY === amountY,
            };
        } else {
            // Bin depleted - calculate how much X we can actually sell
            const inputConsumed = binPriceX64 > 0n ? (amountY * SCALE) / binPriceX64 : 0n;
            return {
                outputAmount: amountY,
                inputConsumed,
                binDepleted: true,
            };
        }
    } else {
        // Selling Y for X
        // outputX = inputY / price
        const maxOutputX = binPriceX64 > 0n ? (inputAmount * SCALE) / binPriceX64 : 0n;

        if (maxOutputX <= amountX) {
            // Bin has enough X
            return {
                outputAmount: maxOutputX,
                inputConsumed: inputAmount,
                binDepleted: maxOutputX === amountX,
            };
        } else {
            // Bin depleted - calculate how much Y we can actually sell
            const inputConsumed = (amountX * binPriceX64) / SCALE;
            return {
                outputAmount: amountX,
                inputConsumed,
                binDepleted: true,
            };
        }
    }
}

/**
 * Calculate dynamic fee based on volatility
 *
 * Meteora DLMM fee model:
 * - fee precision: 1e9
 * - baseFeeRate = baseFactor * binStep * 10 * 10^baseFeePowerFactor
 * - variableFeeRate = (variableFeeControl * (volatilityAccumulator * binStep)^2 + OFFSET) / SCALE
 * - total fee rate capped at 100,000,000 (10%)
 */
function computeDynamicFeeRate(
    baseFactor: bigint,
    binStep: number,
    variableFeeControl: bigint,
    volatilityAccumulator: bigint,
    maxVolatilityAccumulator?: number,
    baseFeePowerFactor = 0
): bigint {
    const binStepBig = BigInt(binStep);
    const feePower = baseFeePowerFactor < 0 ? 0 : baseFeePowerFactor;
    const baseFeeRate = feePower > 9
        ? DLMM_MAX_FEE_RATE
        : baseFactor * binStepBig * 10n * (10n ** BigInt(feePower));
    const cappedVolatility = maxVolatilityAccumulator !== undefined
        ? (volatilityAccumulator > BigInt(maxVolatilityAccumulator)
            ? BigInt(maxVolatilityAccumulator)
            : volatilityAccumulator)
        : volatilityAccumulator;

    // variableFeeRate = (variableFeeControl * (volatilityAccumulator * binStep)^2 + OFFSET) / SCALE.
    const volatilityStep = cappedVolatility * binStepBig;
    const variableFeeRate = variableFeeControl > 0n
        ? (variableFeeControl * volatilityStep * volatilityStep + DLMM_VAR_FEE_OFFSET) / DLMM_VAR_FEE_SCALE
        : 0n;
    const totalFeeRate = baseFeeRate + variableFeeRate;
    const clampedFeeRate = totalFeeRate > DLMM_MAX_FEE_RATE
        ? DLMM_MAX_FEE_RATE
        : totalFeeRate;

    return clampedFeeRate;
}

export function calculateDynamicFee(
    baseFactor: bigint,
    binStep: number,
    variableFeeControl: bigint,
    volatilityAccumulator: bigint,
    maxVolatilityAccumulator?: number,
    baseFeePowerFactor = 0
): bigint {
    const clampedFeeRate = computeDynamicFeeRate(
        baseFactor,
        binStep,
        variableFeeControl,
        volatilityAccumulator,
        maxVolatilityAccumulator,
        baseFeePowerFactor
    );

    // Convert to basis points for legacy callers.
    return (clampedFeeRate * BigInt(BASIS_POINT_MAX)) / DLMM_FEE_PRECISION;
}

function getPoolFeeRate(pool: MeteoraDlmmPool): bigint {
    const variableFeeControl = pool.variableFeeControl ?? pool.variableFeeFactor ?? 0n;
    const volatilityAccumulator = BigInt(pool.volatilityAccumulator);
    return computeDynamicFeeRate(
        pool.baseFactor,
        pool.binStep,
        variableFeeControl,
        volatilityAccumulator,
        pool.maxVolatilityAccumulator,
        pool.baseFeePowerFactor ?? 0
    );
}

/**
 * Get total fee in basis points from pool state
 */
export function getPoolFee(pool: MeteoraDlmmPool): bigint {
    const feeRate = getPoolFeeRate(pool);
    return (feeRate * BigInt(BASIS_POINT_MAX)) / DLMM_FEE_PRECISION;
}

/**
 * Find next active bin in direction
 */
function findNextActiveBin(
    binArrays: BinArray[],
    currentBinId: number,
    swapForY: boolean
): { binId: number; bin: Bin } | null {
    const direction = swapForY ? -1 : 1; // swapForY = consuming Y (move left toward lower bins), !swapForY = consuming X (move right toward higher bins)
    let searchBinId = currentBinId;

    // Search up to 1000 bins
    for (let i = 0; i < 1000; i++) {
        searchBinId += direction;
        const bin = getBinFromArrays(binArrays, searchBinId);

        if (bin) {
            // Check if bin has liquidity in the direction we're going
            // Guard against undefined amounts
            const amountX = bin.amountX ?? 0n;
            const amountY = bin.amountY ?? 0n;

            if (swapForY && amountY > 0n) {
                return { binId: searchBinId, bin };
            }
            if (!swapForY && amountX > 0n) {
                return { binId: searchBinId, bin };
            }
        }
    }

    return null;
}

/**
 * Simulate DLMM swap
 * 
 * DLMM swaps work by:
 * 1. Starting at active bin
 * 2. Consuming liquidity in current bin
 * 3. Moving to next bin if depleted
 * 4. Repeating until input consumed
 * 5. Applying fees
 */
export function simulateDlmm(
    input: SimInput,
    binArrays: BinArray[]
): SimResult {
    const pool = input.poolState as MeteoraDlmmPool;
    const { direction, inputAmount } = input;

    const swapForY = direction === SwapDirection.AtoB;

    // Apply fee to input (full 1e9 fee-rate precision).
    const feeRate = getPoolFeeRate(pool);
    const feeAmount = (inputAmount * feeRate) / DLMM_FEE_PRECISION;
    let amountRemaining = inputAmount - feeAmount;
    let amountCalculated = 0n;

    // Start at active bin
    let currentBinId = pool.activeId;

    // Get active bin
    let currentBin = getBinFromArrays(binArrays, currentBinId);
    if (!currentBin) {
        return {
            success: false,
            outputAmount: 0n,
            newPoolState: pool,
            priceImpactBps: 0,
            feePaid: feeAmount,
            error: ErrorClass.InsufficientLiquidity,
            latencyUs: 0,
        };
    }

    const maxIterations = 100;
    let iterations = 0;

    // Track bin updates for new state
    const binUpdates: Map<number, { amountX: bigint; amountY: bigint }> = new Map();

    while (amountRemaining > 0n && iterations < maxIterations) {
        iterations++;

        // Get bin price
        const binPriceX64 = getPriceFromBinId(currentBinId, pool.binStep);

        // Guard against undefined bin amounts
        const binAmountX = currentBin.amountX ?? 0n;
        const binAmountY = currentBin.amountY ?? 0n;

        // Check if bin has liquidity in our direction
        const hasLiquidity = swapForY ? binAmountY > 0n : binAmountX > 0n;

        if (hasLiquidity) {
            // Swap in this bin
            const result = swapInBin(currentBin, amountRemaining, swapForY, binPriceX64);

            amountRemaining -= result.inputConsumed;
            amountCalculated += result.outputAmount;

            // Track bin update
            const existingUpdate = binUpdates.get(currentBinId) || {
                amountX: binAmountX,
                amountY: binAmountY,
            };

            if (swapForY) {
                existingUpdate.amountX += result.inputConsumed;
                existingUpdate.amountY -= result.outputAmount;
            } else {
                existingUpdate.amountY += result.inputConsumed;
                existingUpdate.amountX -= result.outputAmount;
            }

            binUpdates.set(currentBinId, existingUpdate);

            if (!result.binDepleted) {
                // Done - bin still has liquidity
                break;
            }
        }

        // Move to next bin
        const nextBin = findNextActiveBin(binArrays, currentBinId, swapForY);

        if (!nextBin) {
            // No more liquidity
            if (amountRemaining > 0n) {
                return {
                    success: false,
                    outputAmount: amountCalculated,
                    newPoolState: pool,
                    priceImpactBps: 0,
                    feePaid: feeAmount,
                    error: ErrorClass.InsufficientLiquidity,
                    latencyUs: 0,
                };
            }
            break;
        }

        currentBinId = nextBin.binId;
        currentBin = nextBin.bin;
    }

    if (iterations >= maxIterations) {
        return {
            success: false,
            outputAmount: amountCalculated,
            newPoolState: pool,
            priceImpactBps: 0,
            feePaid: feeAmount,
            error: ErrorClass.Unknown,
            latencyUs: 0,
        };
    }

    // Calculate price impact using pure BigInt arithmetic
    const priceBefore = getPriceFromBinId(pool.activeId, pool.binStep);
    const priceAfter = getPriceFromBinId(currentBinId, pool.binStep);
    // Compute impact in basis points: |after - before| * 10000 / before
    const absDiff = priceAfter > priceBefore ? priceAfter - priceBefore : priceBefore - priceAfter;
    const priceImpactBps = priceBefore > 0n
        ? Number((absDiff * 10000n) / priceBefore)
        : 0;

    // Create new pool state
    const newPoolState: MeteoraDlmmPool = {
        ...pool,
        activeId: currentBinId,
    };

    return {
        success: true,
        outputAmount: amountCalculated,
        newPoolState,
        priceImpactBps,
        feePaid: feeAmount,
        latencyUs: 0,
    };
}

/**
 * Calculate composition fee for adding liquidity
 * This fee is charged when adding unbalanced liquidity to a bin
 */
export function calculateCompositionFee(
    amountX: bigint,
    amountY: bigint,
    binPriceX64: bigint,
    compositionFeeRate: number
): { feeX: bigint; feeY: bigint } {
    // Guard against division by zero
    if (binPriceX64 === 0n) {
        return { feeX: 0n, feeY: 0n };
    }

    // Convert X to Y value at bin price
    const xValueInY = (amountX * binPriceX64) / SCALE;

    // Total value in Y terms
    const totalValue = xValueInY + amountY;
    if (totalValue === 0n) {
        return { feeX: 0n, feeY: 0n };
    }

    // Ideal balanced amounts
    const idealY = totalValue / 2n;
    const idealXValue = totalValue - idealY;
    const idealX = (idealXValue * SCALE) / binPriceX64;

    // Imbalance
    const imbalanceX = amountX > idealX ? amountX - idealX : 0n;
    const imbalanceY = amountY > idealY ? amountY - idealY : 0n;

    // Composition fee on imbalance
    const feeX = (imbalanceX * BigInt(compositionFeeRate)) / 10000n;
    const feeY = (imbalanceY * BigInt(compositionFeeRate)) / 10000n;

    return { feeX, feeY };
}

/**
 * Estimate output amount (simplified - no bin traversal)
 * Used for quick quotes where precision isn't critical
 */
export function estimateOutputAmount(
    inputAmount: bigint,
    pool: MeteoraDlmmPool,
    swapForY: boolean
): bigint {
    const feeRate = getPoolFeeRate(pool);
    const amountAfterFee = inputAmount - (inputAmount * feeRate) / DLMM_FEE_PRECISION;
    const binPriceX64 = getPriceFromBinId(pool.activeId, pool.binStep);

    // Guard against division by zero
    if (binPriceX64 === 0n) {
        return 0n;
    }

    if (swapForY) {
        // X → Y: output = input * price
        return (amountAfterFee * binPriceX64) / SCALE;
    } else {
        // Y → X: output = input / price
        return (amountAfterFee * SCALE) / binPriceX64;
    }
}

// Export constants for testing
export const CONSTANTS = {
    SCALE,
    SCALE_OFFSET,
    BASIS_POINT_MAX,
    BINS_PER_ARRAY,
    PRICE_PRECISION,
};
