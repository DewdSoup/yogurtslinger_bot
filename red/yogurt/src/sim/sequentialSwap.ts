/**
 * Sequential Swap Simulation (S4.5 Enhancement)
 *
 * Enables:
 * 1. Multi-hop routing: A → B → C → D
 * 2. Sandwich simulation: frontrun → victim → backrun
 * 3. Atomic arbitrage: multiple swaps in one tx
 *
 * Key insight: CPMM swaps are ORDER-DEPENDENT.
 * You cannot sum deltas - you must replay sequentially.
 *
 * Example sandwich:
 *   Initial: baseReserve=1000, quoteReserve=100
 *   Frontrun: buy 10 SOL → get X tokens, new reserves
 *   Victim: buy 5 SOL → get Y tokens (LESS than without frontrun!)
 *   Backrun: sell X tokens → get Z SOL (profit = Z - 10)
 */

import type { PoolState, VenueId, SwapDirection } from '../types.js';
import {
    getAmountOut,
    getAmountIn,
    calculatePriceImpact,
} from './math/constantProduct.js';

// ============================================================================
// TYPES
// ============================================================================

export interface SwapStep {
    pool: Uint8Array;
    venue: VenueId;
    direction: SwapDirection;
    inputMint: Uint8Array;
    outputMint: Uint8Array;
    inputAmount: bigint;
    feeBps: bigint;
}

export interface SwapStepResult {
    inputAmount: bigint;
    outputAmount: bigint;
    priceImpactBps: number;
    reserveInBefore: bigint;
    reserveOutBefore: bigint;
    reserveInAfter: bigint;
    reserveOutAfter: bigint;
}

export interface SequentialSwapResult {
    success: boolean;
    steps: SwapStepResult[];
    totalInputAmount: bigint;
    totalOutputAmount: bigint;
    totalPriceImpactBps: number;
    finalPoolStates: Map<string, PoolReserves>;
    error?: string;
}

export interface PoolReserves {
    baseReserve: bigint;
    quoteReserve: bigint;
}

export interface SandwichSimInput {
    pool: Uint8Array;
    venue: VenueId;
    feeBps: bigint;
    initialReserves: PoolReserves;

    // Victim's pending swap
    victimDirection: SwapDirection;
    victimInputAmount: bigint;

    // Our frontrun parameters
    frontrunDirection: SwapDirection;
    frontrunInputAmount: bigint;
}

export interface SandwichSimResult {
    success: boolean;

    // Without sandwich (victim alone)
    victimOutputWithout: bigint;

    // With sandwich
    frontrunOutput: bigint;
    victimOutputWith: bigint;
    backrunOutput: bigint;

    // Profit calculation
    grossProfit: bigint;           // backrunOutput - frontrunInput
    victimSlippage: bigint;        // victimOutputWithout - victimOutputWith
    victimSlippageBps: number;

    // Final state
    finalReserves: PoolReserves;

    // Breakdown
    steps: {
        frontrun: SwapStepResult;
        victim: SwapStepResult;
        backrun: SwapStepResult;
    };

    error?: string;
}

export interface MultiHopInput {
    route: SwapStep[];
    initialPoolStates: Map<string, PoolReserves>;
}

// ============================================================================
// CORE SEQUENTIAL SIMULATION
// ============================================================================

/**
 * Simulate a single swap and return new reserves
 */
export function simulateSwapStep(
    reserves: PoolReserves,
    direction: SwapDirection,
    inputAmount: bigint,
    feeBps: bigint
): SwapStepResult {
    const [reserveIn, reserveOut] = direction === 0 // AtoB
        ? [reserves.baseReserve, reserves.quoteReserve]
        : [reserves.quoteReserve, reserves.baseReserve];

    const outputAmount = getAmountOut(inputAmount, reserveIn, reserveOut, feeBps);

    // Calculate new reserves
    // IMPORTANT: Full input amount enters the pool reserve.
    // The fee affects the swap calculation (via getAmountOut) but the
    // entire inputAmount stays in the pool - fee is not removed.
    let newBaseReserve: bigint;
    let newQuoteReserve: bigint;

    if (direction === 0) { // AtoB: base in, quote out
        newBaseReserve = reserves.baseReserve + inputAmount;
        newQuoteReserve = reserves.quoteReserve - outputAmount;
    } else { // BtoA: quote in, base out
        newQuoteReserve = reserves.quoteReserve + inputAmount;
        newBaseReserve = reserves.baseReserve - outputAmount;
    }

    const priceImpactBps = calculatePriceImpact(
        inputAmount,
        outputAmount,
        reserveIn,
        reserveOut
    );

    return {
        inputAmount,
        outputAmount,
        priceImpactBps,
        reserveInBefore: reserveIn,
        reserveOutBefore: reserveOut,
        reserveInAfter: direction === 0 ? newBaseReserve : newQuoteReserve,
        reserveOutAfter: direction === 0 ? newQuoteReserve : newBaseReserve,
    };
}

/**
 * Get reserves after a swap step
 */
export function getReservesAfterSwap(
    result: SwapStepResult,
    direction: SwapDirection
): PoolReserves {
    if (direction === 0) { // AtoB
        return {
            baseReserve: result.reserveInAfter,
            quoteReserve: result.reserveOutAfter,
        };
    } else { // BtoA
        return {
            baseReserve: result.reserveOutAfter,
            quoteReserve: result.reserveInAfter,
        };
    }
}

// ============================================================================
// SANDWICH SIMULATION
// ============================================================================

/**
 * Simulate a complete sandwich attack
 *
 * Flow:
 * 1. Frontrun: We swap BEFORE victim (direction matches victim)
 * 2. Victim: Their swap executes at worse price
 * 3. Backrun: We swap in OPPOSITE direction to extract profit
 *
 * Returns profit analysis and all intermediate states
 */
export function simulateSandwich(input: SandwichSimInput): SandwichSimResult {
    const {
        feeBps,
        initialReserves,
        victimDirection,
        victimInputAmount,
        frontrunDirection,
        frontrunInputAmount,
    } = input;

    // Validate: frontrun should be same direction as victim for sandwich
    if (frontrunDirection !== victimDirection) {
        return {
            success: false,
            victimOutputWithout: 0n,
            frontrunOutput: 0n,
            victimOutputWith: 0n,
            backrunOutput: 0n,
            grossProfit: 0n,
            victimSlippage: 0n,
            victimSlippageBps: 0,
            finalReserves: initialReserves,
            steps: {
                frontrun: emptyStepResult(),
                victim: emptyStepResult(),
                backrun: emptyStepResult(),
            },
            error: 'Frontrun direction must match victim for sandwich',
        };
    }

    // Step 0: What would victim get WITHOUT sandwich?
    const victimAlone = simulateSwapStep(
        initialReserves,
        victimDirection,
        victimInputAmount,
        feeBps
    );
    const victimOutputWithout = victimAlone.outputAmount;

    // Step 1: FRONTRUN - we swap first
    const frontrunResult = simulateSwapStep(
        initialReserves,
        frontrunDirection,
        frontrunInputAmount,
        feeBps
    );
    const reservesAfterFrontrun = getReservesAfterSwap(frontrunResult, frontrunDirection);

    // Step 2: VICTIM - swaps at degraded price
    const victimResult = simulateSwapStep(
        reservesAfterFrontrun,
        victimDirection,
        victimInputAmount,
        feeBps
    );
    const reservesAfterVictim = getReservesAfterSwap(victimResult, victimDirection);

    // Step 3: BACKRUN - we swap in opposite direction
    // Input for backrun = output from frontrun
    const backrunDirection = frontrunDirection === 0 ? 1 : 0;
    const backrunInputAmount = frontrunResult.outputAmount;

    const backrunResult = simulateSwapStep(
        reservesAfterVictim,
        backrunDirection,
        backrunInputAmount,
        feeBps
    );
    const finalReserves = getReservesAfterSwap(backrunResult, backrunDirection);

    // Calculate profit
    const grossProfit = backrunResult.outputAmount - frontrunInputAmount;
    const victimSlippage = victimOutputWithout - victimResult.outputAmount;
    const victimSlippageBps = victimOutputWithout > 0n
        ? Number((victimSlippage * 10000n) / victimOutputWithout)
        : 0;

    return {
        success: true,
        victimOutputWithout,
        frontrunOutput: frontrunResult.outputAmount,
        victimOutputWith: victimResult.outputAmount,
        backrunOutput: backrunResult.outputAmount,
        grossProfit,
        victimSlippage,
        victimSlippageBps,
        finalReserves,
        steps: {
            frontrun: frontrunResult,
            victim: victimResult,
            backrun: backrunResult,
        },
    };
}

/**
 * Find optimal frontrun amount for maximum profit
 * Uses binary search within [minAmount, maxAmount]
 */
export function findOptimalFrontrunAmount(
    input: Omit<SandwichSimInput, 'frontrunInputAmount'>,
    minAmount: bigint,
    maxAmount: bigint,
    iterations: number = 20
): { optimalAmount: bigint; expectedProfit: bigint; result: SandwichSimResult } {
    let lo = minAmount;
    let hi = maxAmount;
    let bestAmount = minAmount;
    let bestProfit = -BigInt(Number.MAX_SAFE_INTEGER);
    let bestResult: SandwichSimResult | null = null;

    for (let i = 0; i < iterations; i++) {
        const mid1 = lo + (hi - lo) / 3n;
        const mid2 = hi - (hi - lo) / 3n;

        const result1 = simulateSandwich({ ...input, frontrunInputAmount: mid1 });
        const result2 = simulateSandwich({ ...input, frontrunInputAmount: mid2 });

        if (result1.grossProfit > bestProfit) {
            bestProfit = result1.grossProfit;
            bestAmount = mid1;
            bestResult = result1;
        }
        if (result2.grossProfit > bestProfit) {
            bestProfit = result2.grossProfit;
            bestAmount = mid2;
            bestResult = result2;
        }

        if (result1.grossProfit < result2.grossProfit) {
            lo = mid1;
        } else {
            hi = mid2;
        }
    }

    return {
        optimalAmount: bestAmount,
        expectedProfit: bestProfit,
        result: bestResult!,
    };
}

// ============================================================================
// MULTI-HOP SIMULATION
// ============================================================================

/**
 * Simulate a multi-hop route (e.g., SOL → USDC → TOKEN → SOL)
 * Each step uses the output of the previous step as input
 */
export function simulateMultiHop(input: MultiHopInput): SequentialSwapResult {
    const { route, initialPoolStates } = input;

    if (route.length === 0) {
        return {
            success: false,
            steps: [],
            totalInputAmount: 0n,
            totalOutputAmount: 0n,
            totalPriceImpactBps: 0,
            finalPoolStates: initialPoolStates,
            error: 'Empty route',
        };
    }

    const poolStates = new Map(initialPoolStates);
    const steps: SwapStepResult[] = [];

    let currentAmount = route[0]!.inputAmount;
    let totalPriceImpact = 0;

    for (let i = 0; i < route.length; i++) {
        const step = route[i]!;
        const poolKey = toPoolKey(step.pool);
        const reserves = poolStates.get(poolKey);

        if (!reserves) {
            return {
                success: false,
                steps,
                totalInputAmount: route[0]!.inputAmount,
                totalOutputAmount: 0n,
                totalPriceImpactBps: totalPriceImpact,
                finalPoolStates: poolStates,
                error: `Missing pool state for step ${i}`,
            };
        }

        const result = simulateSwapStep(
            reserves,
            step.direction,
            currentAmount,
            step.feeBps
        );

        if (result.outputAmount === 0n) {
            return {
                success: false,
                steps,
                totalInputAmount: route[0]!.inputAmount,
                totalOutputAmount: 0n,
                totalPriceImpactBps: totalPriceImpact,
                finalPoolStates: poolStates,
                error: `Zero output at step ${i}`,
            };
        }

        steps.push(result);
        totalPriceImpact += result.priceImpactBps;

        // Update pool state for this pool
        poolStates.set(poolKey, getReservesAfterSwap(result, step.direction));

        // Next step uses this step's output
        currentAmount = result.outputAmount;
    }

    return {
        success: true,
        steps,
        totalInputAmount: route[0]!.inputAmount,
        totalOutputAmount: currentAmount,
        totalPriceImpactBps: totalPriceImpact,
        finalPoolStates: poolStates,
    };
}

// ============================================================================
// ARBITRAGE DETECTION
// ============================================================================

/**
 * Check if a circular route is profitable
 * Route must start and end with same token
 */
export function checkCircularArbitrage(
    input: MultiHopInput
): { profitable: boolean; profit: bigint; profitBps: number } {
    const result = simulateMultiHop(input);

    if (!result.success) {
        return { profitable: false, profit: 0n, profitBps: 0 };
    }

    const profit = result.totalOutputAmount - result.totalInputAmount;
    const profitBps = result.totalInputAmount > 0n
        ? Number((profit * 10000n) / result.totalInputAmount)
        : 0;

    return {
        profitable: profit > 0n,
        profit,
        profitBps,
    };
}

// ============================================================================
// HELPERS
// ============================================================================

function toPoolKey(pool: Uint8Array): string {
    let key = '';
    for (let i = 0; i < pool.length; i++) {
        key += pool[i]!.toString(16).padStart(2, '0');
    }
    return key;
}

function emptyStepResult(): SwapStepResult {
    return {
        inputAmount: 0n,
        outputAmount: 0n,
        priceImpactBps: 0,
        reserveInBefore: 0n,
        reserveOutBefore: 0n,
        reserveInAfter: 0n,
        reserveOutAfter: 0n,
    };
}

// ============================================================================
// VALIDATION HELPERS (for evidence-based testing)
// ============================================================================

/**
 * Compare simulated sandwich vs actual on-chain sandwich
 * Used for validating simulation accuracy against captured evidence
 */
export interface SandwichValidationInput {
    // On-chain data
    actualFrontrunOutput: bigint;
    actualVictimOutput: bigint;
    actualBackrunOutput: bigint;

    // Simulated
    simulated: SandwichSimResult;
}

export function validateSandwichSimulation(
    input: SandwichValidationInput,
    toleranceBps: number = 10
): { valid: boolean; errors: { frontrun: number; victim: number; backrun: number } } {
    const { actualFrontrunOutput, actualVictimOutput, actualBackrunOutput, simulated } = input;

    const calcError = (actual: bigint, simulated: bigint): number => {
        if (actual === 0n) return simulated === 0n ? 0 : 10000;
        const diff = actual > simulated ? actual - simulated : simulated - actual;
        return Number((diff * 10000n) / actual);
    };

    const frontrunErr = calcError(actualFrontrunOutput, simulated.frontrunOutput);
    const victimErr = calcError(actualVictimOutput, simulated.victimOutputWith);
    const backrunErr = calcError(actualBackrunOutput, simulated.backrunOutput);

    return {
        valid: frontrunErr <= toleranceBps && victimErr <= toleranceBps && backrunErr <= toleranceBps,
        errors: {
            frontrun: frontrunErr,
            victim: victimErr,
            backrun: backrunErr,
        },
    };
}
