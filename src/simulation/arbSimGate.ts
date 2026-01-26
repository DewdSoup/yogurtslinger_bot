// src/simulation/arbSimGate.ts
// ═══════════════════════════════════════════════════════════════════════════════
// ARB SIM GATE - LOCAL SIMULATION REPLACEMENT FOR RPC SIMGATE
// ═══════════════════════════════════════════════════════════════════════════════
//
// This module replaces the RPC-based simulateAndValidate() in executionEngine.ts
// with pure local simulation using cached data.
//
// LATENCY COMPARISON:
//   RPC SimGate:   100-500ms (network + VM execution)
//   Local SimGate: <1ms (pure math)
//
// USAGE:
//   Replace executionEngine.ts calls to simulateAndValidate() with:
//   const result = await localSimGate.validate(signal, cache, maxCapital);
//
// ═══════════════════════════════════════════════════════════════════════════════

import type { ArbSignal, VenueName } from "../signals/fragmentationArb.js";
import type { MarketCache } from "../brain/marketCache.js";
import type { BinArrayCache } from "../brain/binArrayCache.js";
import type { PoolState } from "../execution/profitSimulator.js";
import {
    simulateArbitrage,
    findOptimalArbAmount,
    quickProfitCheck,
    getConstrainingLiquidity
} from "./localSimulator.js";
import {
    buildPoolStatesForToken,
    type BuildPoolStateOptions
} from "./poolStateBuilder.js";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface SimGateConfig {
    minNetProfitBps: number;           // Minimum profit in bps (default: 20)
    minNetProfitLamports: bigint;      // Minimum absolute profit (default: 50_000)
    maxPriceImpactBps: number;         // Max acceptable slippage (default: 200)
    slippageTolerance: number;         // Slippage buffer for minOut (default: 0.02)
    minConfidence: number;             // Minimum simulation confidence (default: 0.80)
    useRpcFallback: boolean;           // Fall back to RPC for low confidence (default: false)
}

export const DEFAULT_SIMGATE_CONFIG: SimGateConfig = {
    minNetProfitBps: 20,
    minNetProfitLamports: 50_000n,
    maxPriceImpactBps: 200,
    slippageTolerance: 0.02,
    minConfidence: 0.80,
    useRpcFallback: false,
};

export interface SimGateResult {
    approved: boolean;
    reason: string | null;

    // Optimal trade parameters
    optimalAmountIn: bigint;
    expectedTokensOut: bigint;
    expectedSolOut: bigint;
    expectedProfitLamports: bigint;
    expectedProfitBps: number;

    // Slippage-adjusted minimums for instruction building
    minTokensOut: bigint;
    minSolOut: bigint;

    // Tip calculation
    suggestedTipLamports: bigint;
    netProfitAfterTip: bigint;

    // Metadata
    confidence: number;
    simulationTimeMs: number;
    method: "local" | "rpc" | "rejected";

    // Pool states (for instruction building)
    buyPool: PoolState | null;
    sellPool: PoolState | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIP CALCULATION
// ═══════════════════════════════════════════════════════════════════════════════

interface TipStrategy {
    baseTip: bigint;
    profitSharePercent: number;
    freshPoolMultiplier: number;
    highSpreadMultiplier: number;
    minTip: bigint;
    maxTip: bigint;
}

const TIP_STRATEGY: TipStrategy = {
    baseTip: 10_000n,              // 0.00001 SOL base
    profitSharePercent: 50,        // 50% of profit as tip
    freshPoolMultiplier: 1.5,      // 1.5x for fresh pools
    highSpreadMultiplier: 1.2,     // 1.2x for high spreads
    minTip: 100_000n,              // 0.0001 SOL minimum
    maxTip: 10_000_000n,           // 0.01 SOL maximum
};

function calculateTip(
    grossProfit: bigint,
    isFreshPool: boolean,
    spreadBps: number
): bigint {
    // Base tip is percentage of profit
    let tip = (grossProfit * BigInt(TIP_STRATEGY.profitSharePercent)) / 100n;

    // Add base
    tip += TIP_STRATEGY.baseTip;

    // Apply multipliers
    if (isFreshPool) {
        tip = (tip * BigInt(Math.floor(TIP_STRATEGY.freshPoolMultiplier * 100))) / 100n;
    }
    if (spreadBps > 100) {
        tip = (tip * BigInt(Math.floor(TIP_STRATEGY.highSpreadMultiplier * 100))) / 100n;
    }

    // Clamp to bounds
    if (tip < TIP_STRATEGY.minTip) tip = TIP_STRATEGY.minTip;
    if (tip > TIP_STRATEGY.maxTip) tip = TIP_STRATEGY.maxTip;

    return tip;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN VALIDATION FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate an arbitrage signal using local simulation
 * This replaces the RPC-based simulateAndValidate() function
 */
export async function validateSignal(
    signal: ArbSignal,
    cache: MarketCache,
    binArrayCache: BinArrayCache | undefined,
    maxCapitalLamports: bigint,
    config: SimGateConfig = DEFAULT_SIMGATE_CONFIG
): Promise<SimGateResult> {
    const startTime = performance.now();

    // Build pool states from cache
    const tokenAccountCache = cache.getTokenAccountCache();
    const options: BuildPoolStateOptions = { cache, tokenAccountCache };

    const { buyPool, sellPool } = buildPoolStatesForToken(
        signal.tokenMint,
        signal.buyVenue as VenueName,
        signal.sellVenue as VenueName,
        options
    );

    // Check if we have both pools
    if (!buyPool || !sellPool) {
        return createRejectedResult(
            startTime,
            `Missing pool state: buy=${!!buyPool}, sell=${!!sellPool}`,
            buyPool,
            sellPool
        );
    }

    // Quick profit check before full simulation
    const quickCheck = quickProfitCheck(buyPool, sellPool);
    if (!quickCheck.profitable) {
        return createRejectedResult(
            startTime,
            `Quick check: not profitable`,
            buyPool,
            sellPool
        );
    }

    // Get constraining liquidity
    const liquidity = getConstrainingLiquidity(buyPool, sellPool);
    const maxAmount = liquidity.maxRecommendedSize < maxCapitalLamports
        ? liquidity.maxRecommendedSize
        : maxCapitalLamports;

    if (maxAmount < 10_000_000n) {  // 0.01 SOL minimum
        return createRejectedResult(
            startTime,
            `Insufficient liquidity: ${Number(liquidity.minLiquidity) / 1e9} SOL`,
            buyPool,
            sellPool
        );
    }

    // Find optimal amount
    const optimal = findOptimalArbAmount(
        buyPool,
        sellPool,
        maxAmount,
        config.minNetProfitLamports,
        binArrayCache
    );

    if (!optimal) {
        return createRejectedResult(
            startTime,
            `No profitable amount found`,
            buyPool,
            sellPool
        );
    }

    // Run full simulation at optimal amount
    const simResult = simulateArbitrage(
        buyPool,
        sellPool,
        optimal.optimalAmount,
        binArrayCache
    );

    // Check confidence threshold
    if (simResult.confidence < config.minConfidence) {
        return createRejectedResult(
            startTime,
            `Low confidence: ${(simResult.confidence * 100).toFixed(1)}% < ${(config.minConfidence * 100).toFixed(1)}%`,
            buyPool,
            sellPool
        );
    }

    // Check profit thresholds
    if (simResult.netProfitBps < config.minNetProfitBps) {
        return createRejectedResult(
            startTime,
            `Low profit: ${simResult.netProfitBps} bps < ${config.minNetProfitBps} bps`,
            buyPool,
            sellPool
        );
    }

    if (simResult.grossProfitLamports < config.minNetProfitLamports) {
        return createRejectedResult(
            startTime,
            `Low absolute profit: ${Number(simResult.grossProfitLamports) / 1e9} SOL`,
            buyPool,
            sellPool
        );
    }

    // Check price impact
    const maxImpact = Math.max(simResult.buyPriceImpactBps, simResult.sellPriceImpactBps);
    if (maxImpact > config.maxPriceImpactBps) {
        return createRejectedResult(
            startTime,
            `High price impact: ${maxImpact} bps > ${config.maxPriceImpactBps} bps`,
            buyPool,
            sellPool
        );
    }

    // Calculate tip
    const isFreshPool = buyPool.createdTs !== null &&
        (Date.now() - buyPool.createdTs) < 300_000;  // 5 minutes
    const tip = calculateTip(simResult.grossProfitLamports, isFreshPool, signal.grossSpreadBps);
    const netAfterTip = simResult.grossProfitLamports - tip;

    // Calculate slippage-adjusted minimums
    const slippageMultiplier = BigInt(Math.floor((1 - config.slippageTolerance) * 10000));
    const minTokensOut = (simResult.tokensReceived * slippageMultiplier) / 10000n;
    const minSolOut = (simResult.solReceived * slippageMultiplier) / 10000n;

    const simulationTimeMs = performance.now() - startTime;

    return {
        approved: true,
        reason: null,
        optimalAmountIn: optimal.optimalAmount,
        expectedTokensOut: simResult.tokensReceived,
        expectedSolOut: simResult.solReceived,
        expectedProfitLamports: simResult.grossProfitLamports,
        expectedProfitBps: simResult.netProfitBps,
        minTokensOut,
        minSolOut,
        suggestedTipLamports: tip,
        netProfitAfterTip: netAfterTip,
        confidence: simResult.confidence,
        simulationTimeMs,
        method: "local",
        buyPool,
        sellPool,
    };
}

/**
 * Batch validate multiple signals
 * Returns only approved signals, sorted by expected profit
 */
export async function validateSignals(
    signals: ArbSignal[],
    cache: MarketCache,
    binArrayCache: BinArrayCache | undefined,
    maxCapitalLamports: bigint,
    config: SimGateConfig = DEFAULT_SIMGATE_CONFIG
): Promise<SimGateResult[]> {
    const results: SimGateResult[] = [];

    for (const signal of signals) {
        const result = await validateSignal(
            signal,
            cache,
            binArrayCache,
            maxCapitalLamports,
            config
        );

        if (result.approved) {
            results.push(result);
        }
    }

    // Sort by expected profit (descending)
    results.sort((a, b) =>
        Number(b.expectedProfitLamports - a.expectedProfitLamports)
    );

    return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function createRejectedResult(
    startTime: number,
    reason: string,
    buyPool: PoolState | null,
    sellPool: PoolState | null
): SimGateResult {
    return {
        approved: false,
        reason,
        optimalAmountIn: 0n,
        expectedTokensOut: 0n,
        expectedSolOut: 0n,
        expectedProfitLamports: 0n,
        expectedProfitBps: 0,
        minTokensOut: 0n,
        minSolOut: 0n,
        suggestedTipLamports: 0n,
        netProfitAfterTip: 0n,
        confidence: 0,
        simulationTimeMs: performance.now() - startTime,
        method: "rejected",
        buyPool,
        sellPool,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATS TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

interface SimGateStats {
    totalValidations: number;
    approved: number;
    rejected: number;
    avgSimulationTimeMs: number;
    rejectionReasons: Map<string, number>;
}

const stats: SimGateStats = {
    totalValidations: 0,
    approved: 0,
    rejected: 0,
    avgSimulationTimeMs: 0,
    rejectionReasons: new Map(),
};

export function getSimGateStats(): SimGateStats {
    return { ...stats };
}

export function resetSimGateStats(): void {
    stats.totalValidations = 0;
    stats.approved = 0;
    stats.rejected = 0;
    stats.avgSimulationTimeMs = 0;
    stats.rejectionReasons.clear();
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    validateSignal,
    validateSignals,
    getSimGateStats,
    resetSimGateStats,
    DEFAULT_SIMGATE_CONFIG,
};