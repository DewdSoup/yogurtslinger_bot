/**
 * Constant Product AMM Math (Phase 5)
 * 
 * x * y = k
 * 
 * Used by: Raydium V4, PumpSwap
 * 
 * Key formulas:
 * - dy = (y * dx) / (x + dx)  [exact output for input]
 * - dx = (x * dy) / (y - dy)  [exact input for output]
 * - Fee applied BEFORE swap calculation
 * 
 * Gate requirements:
 * - Sim accuracy within 0.01% of actual (G5.2)
 */

import type {
    SimInput,
    SimResult,
    PoolState,
    PumpSwapPool,
    RaydiumV4Pool,
} from '../../types.js';
import { VenueId, SwapDirection, ErrorClass } from '../../types.js';

// Fee calculation constants
const FEE_DENOMINATOR = 10000n;

/**
 * Type guard to assert reserves are defined
 */
function assertReserves(
    p: { baseReserve?: bigint; quoteReserve?: bigint }
): asserts p is { baseReserve: bigint; quoteReserve: bigint } {
    if (p.baseReserve === undefined || p.quoteReserve === undefined) {
        throw new Error('ConstantProduct: missing reserves');
    }
}

export interface FeeParams {
    lpFeeBps: bigint;
    protocolFeeBps: bigint;
}

export interface FeeResult {
    amountAfterFee: bigint;
    feePaid: bigint;
    lpFee: bigint;
    protocolFee: bigint;
}

/**
 * Calculate fee for input amount
 * Fee is deducted from input BEFORE the swap
 */
export function calculateFee(amount: bigint, params: FeeParams): FeeResult {
    const totalFeeBps = params.lpFeeBps + params.protocolFeeBps;

    if (totalFeeBps === 0n) {
        return {
            amountAfterFee: amount,
            feePaid: 0n,
            lpFee: 0n,
            protocolFee: 0n,
        };
    }

    const feePaid = (amount * totalFeeBps) / FEE_DENOMINATOR;
    const lpFee = (amount * params.lpFeeBps) / FEE_DENOMINATOR;
    const protocolFee = feePaid - lpFee;

    return {
        amountAfterFee: amount - feePaid,
        feePaid,
        lpFee,
        protocolFee,
    };
}

/**
 * Pure constant product: get output amount for input
 * dy = (y * dx) / (x + dx)
 * 
 * This does NOT include fees - call calculateFee separately
 */
export function getAmountOutPure(
    amountIn: bigint,
    reserveIn: bigint,
    reserveOut: bigint
): bigint {
    if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) {
        return 0n;
    }

    const numerator = reserveOut * amountIn;
    const denominator = reserveIn + amountIn;

    return numerator / denominator;
}

/**
 * Get output amount WITH fees applied to input
 * This matches on-chain behavior where fee is deducted first
 */
export function getAmountOut(
    amountIn: bigint,
    reserveIn: bigint,
    reserveOut: bigint,
    feeBps: bigint
): bigint {
    if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) {
        return 0n;
    }

    // Apply fee to input (multiply by (10000 - fee))
    const amountInWithFee = amountIn * (10000n - feeBps);
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn * 10000n + amountInWithFee;

    return numerator / denominator;
}

/**
 * Calculate input amount required for desired output
 * dx = (x * dy * 10000) / ((y - dy) * (10000 - fee))
 */
export function getAmountIn(
    amountOut: bigint,
    reserveIn: bigint,
    reserveOut: bigint,
    feeBps: bigint
): bigint {
    if (amountOut <= 0n || reserveIn <= 0n || reserveOut <= 0n) {
        return 0n;
    }

    if (amountOut >= reserveOut) {
        // Can't get more than reserve
        return BigInt(Number.MAX_SAFE_INTEGER);
    }

    const numerator = reserveIn * amountOut * 10000n;
    const denominator = (reserveOut - amountOut) * (10000n - feeBps);

    // Round up
    return numerator / denominator + 1n;
}

/**
 * Calculate price impact in basis points
 */
export function calculatePriceImpact(
    amountIn: bigint,
    amountOut: bigint,
    reserveIn: bigint,
    reserveOut: bigint
): number {
    if (amountIn === 0n || reserveIn === 0n) return 0;

    // Spot price = reserveOut / reserveIn
    // Effective price = amountIn / amountOut
    // Price impact = (effective - spot) / spot

    const spotPriceNumerator = reserveOut * amountIn;
    const spotPriceDenominator = reserveIn * amountOut;

    if (spotPriceDenominator === 0n) return 10000; // 100%

    // (effective/spot - 1) * 10000
    const impactBps = Number(
        ((spotPriceNumerator - spotPriceDenominator) * 10000n) / spotPriceDenominator
    );

    return Math.abs(impactBps);
}

/**
 * Get fee parameters from pool based on venue
 *
 * IMPORTANT: Fees MUST be resolved in Layer 1 (pool state).
 * No workarounds or runtime fee learning allowed.
 *
 * @param pool - Pool state (must have lpFeeBps/protocolFeeBps populated)
 * @param venue - Venue ID
 */
function getPoolFeeParams(pool: PoolState, venue: VenueId): FeeParams {
    if (venue === VenueId.PumpSwap) {
        const p = pool as PumpSwapPool;
        // PumpSwap fees MUST come from pool state (resolved in Layer 1)
        // Default 25 bps (LP 20 + Protocol 5) is from GlobalConfig
        // TODO: Implement proper fee tier resolution based on market cap
        return {
            lpFeeBps: p.lpFeeBps ?? 20n,
            protocolFeeBps: p.protocolFeeBps ?? 5n,
        };
    }

    if (venue === VenueId.RaydiumV4) {
        const p = pool as RaydiumV4Pool;
        // Raydium V4 fees from pool account (swapFeeNumerator/swapFeeDenominator)
        return {
            lpFeeBps: p.lpFeeBps ?? 22n,
            protocolFeeBps: p.protocolFeeBps ?? 3n,
        };
    }

    return { lpFeeBps: 0n, protocolFeeBps: 0n };
}

/**
 * Get reserves based on direction
 */
function getReserves(
    pool: PoolState,
    venue: VenueId,
    direction: SwapDirection
): { inputReserve: bigint; outputReserve: bigint } {
    let baseReserve: bigint;
    let quoteReserve: bigint;

    if (venue === VenueId.PumpSwap) {
        const p = pool as PumpSwapPool;
        assertReserves(p);
        baseReserve = p.baseReserve;
        quoteReserve = p.quoteReserve;
    } else if (venue === VenueId.RaydiumV4) {
        const p = pool as RaydiumV4Pool;
        assertReserves(p);
        baseReserve = p.baseReserve;
        quoteReserve = p.quoteReserve;
    } else {
        throw new Error(`Unsupported venue: ${venue}`);
    }

    if (direction === SwapDirection.AtoB) {
        return { inputReserve: baseReserve, outputReserve: quoteReserve };
    } else {
        return { inputReserve: quoteReserve, outputReserve: baseReserve };
    }
}

/**
 * Update pool state after swap
 */
function computeNewState(
    pool: PoolState,
    venue: VenueId,
    direction: SwapDirection,
    amountIn: bigint,
    amountOut: bigint
): PoolState {
    if (venue === VenueId.PumpSwap) {
        const p = pool as PumpSwapPool;
        assertReserves(p);
        if (direction === SwapDirection.AtoB) {
            return {
                ...p,
                baseReserve: p.baseReserve + amountIn,
                quoteReserve: p.quoteReserve - amountOut,
            };
        } else {
            return {
                ...p,
                baseReserve: p.baseReserve - amountOut,
                quoteReserve: p.quoteReserve + amountIn,
            };
        }
    }

    if (venue === VenueId.RaydiumV4) {
        const p = pool as RaydiumV4Pool;
        assertReserves(p);
        if (direction === SwapDirection.AtoB) {
            return {
                ...p,
                baseReserve: p.baseReserve + amountIn,
                quoteReserve: p.quoteReserve - amountOut,
            };
        } else {
            return {
                ...p,
                baseReserve: p.baseReserve - amountOut,
                quoteReserve: p.quoteReserve + amountIn,
            };
        }
    }

    return pool;
}

/**
 * Simulate constant product swap
 * 
 * Flow:
 * 1. Extract reserves based on direction
 * 2. Apply fee to input
 * 3. Calculate output using constant product
 * 4. Validate output doesn't exceed reserve
 * 5. Calculate price impact
 * 6. Return result with new state
 */
export function simulateConstantProduct(input: SimInput): SimResult {
    const { venue, direction, inputAmount, poolState } = input;

    // Validate venue
    if (venue !== VenueId.PumpSwap && venue !== VenueId.RaydiumV4) {
        return {
            success: false,
            outputAmount: 0n,
            newPoolState: poolState,
            priceImpactBps: 0,
            feePaid: 0n,
            error: ErrorClass.Unknown,
            latencyUs: 0,
        };
    }

    // Get fee params from pool state (Layer 1 - no workarounds)
    const feeParams = getPoolFeeParams(poolState, venue);
    const totalFeeBps = feeParams.lpFeeBps + feeParams.protocolFeeBps;

    // Get reserves
    const { inputReserve, outputReserve } = getReserves(poolState, venue, direction);

    // Validate reserves
    if (inputReserve <= 0n || outputReserve <= 0n) {
        return {
            success: false,
            outputAmount: 0n,
            newPoolState: poolState,
            priceImpactBps: 0,
            feePaid: 0n,
            error: ErrorClass.InsufficientLiquidity,
            latencyUs: 0,
        };
    }

    // Calculate output using fee-integrated formula (matches on-chain behavior)
    const outputAmount = getAmountOut(inputAmount, inputReserve, outputReserve, totalFeeBps);

    // Calculate fee for reporting
    const feePaid = (inputAmount * totalFeeBps) / FEE_DENOMINATOR;

    // Check for sufficient liquidity
    if (outputAmount >= outputReserve) {
        return {
            success: false,
            outputAmount: 0n,
            newPoolState: poolState,
            priceImpactBps: 10000, // 100%
            feePaid,
            error: ErrorClass.InsufficientLiquidity,
            latencyUs: 0,
        };
    }

    // Check for zero output
    if (outputAmount === 0n) {
        return {
            success: false,
            outputAmount: 0n,
            newPoolState: poolState,
            priceImpactBps: 0,
            feePaid,
            error: ErrorClass.MathOverflow,
            latencyUs: 0,
        };
    }

    // Calculate price impact
    const priceImpactBps = calculatePriceImpact(
        inputAmount,
        outputAmount,
        inputReserve,
        outputReserve
    );

    // Compute new state
    // The amount added to input reserve is amount after fee (fee stays in pool)
    // The amount removed from output reserve is the output
    const amountAfterFee = inputAmount - feePaid;
    const newPoolState = computeNewState(
        poolState,
        venue,
        direction,
        amountAfterFee,
        outputAmount
    );

    return {
        success: true,
        outputAmount,
        newPoolState,
        priceImpactBps,
        feePaid,
        latencyUs: 0,
    };
}

/**
 * Validate constant product invariant
 * k = x * y should stay constant (or increase due to fees)
 */
export function validateInvariant(
    reserveInBefore: bigint,
    reserveOutBefore: bigint,
    reserveInAfter: bigint,
    reserveOutAfter: bigint
): boolean {
    const kBefore = reserveInBefore * reserveOutBefore;
    const kAfter = reserveInAfter * reserveOutAfter;

    // k should not decrease (it can increase slightly due to fees)
    return kAfter >= kBefore;
}

// Export for testing
export const CONSTANTS = {
    FEE_DENOMINATOR,
};