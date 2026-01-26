// src/execution/executionGate.ts
// REFACTORED: Reduced to configuration and types only
// All evaluation logic has been moved to executionEngine.ts (SimGate)
// This file is kept for configuration compatibility and type exports

import type { PoolState } from "./profitSimulator.js";

const LAMPORTS_PER_SOL = 1_000_000_000n;

// ============================================================================
// GATE CONFIGURATION (Used by ExecutionEngine)
// ============================================================================

export interface GateConfig {
    /** Max age of opportunity before we skip it (ms) */
    maxOpportunityAgeMs: number;
    /** Age threshold for "fresh pool" aggressive tipping (ms) */
    freshPoolThresholdMs: number;
    /** Minimum net profit in basis points */
    minNetProfitBps: number;
    /** Minimum net profit in lamports */
    minNetProfitLamports: bigint;
    /** Maximum total slippage allowed (percent) */
    maxTotalSlippagePercent: number;
    /** Minimum pool liquidity required (lamports) */
    minPoolLiquidityLamports: bigint;
    /** Maximum concurrent trades */
    maxConcurrentTrades: number;
    /** Skip if we already have position for this token */
    skipDuplicateTokens: boolean;
    /** Slippage tolerance for minOut calculation (0.01 = 1%) */
    slippageTolerance: number;
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
    maxOpportunityAgeMs: 5 * 60 * 1000,        // 5 minutes
    freshPoolThresholdMs: 60 * 1000,           // 1 minute
    minNetProfitBps: 10,                       // 0.10%
    minNetProfitLamports: 10000n,              // 0.00001 SOL
    maxTotalSlippagePercent: 5.0,
    minPoolLiquidityLamports: LAMPORTS_PER_SOL, // 1 SOL
    maxConcurrentTrades: 4,
    skipDuplicateTokens: true,
    slippageTolerance: 0.01,                   // 1%
};

// ============================================================================
// OPPORTUNITY INPUT TYPE
// ============================================================================

export interface OpportunityInput {
    tokenMint: string;
    buyPool: PoolState;
    sellPool: PoolState;
    detectedAt: number;
    createdAt?: number | null;
}

// ============================================================================
// GATE STATS (For monitoring)
// ============================================================================

interface GateStats {
    evaluated: number;
    simulated: number;
    executed: number;
    skippedAge: number;
    skippedConcurrency: number;
    skippedSpread: number;
    skippedProfit: number;
    skippedLiquidity: number;
    skippedDuplicate: number;
    skippedSimulation: number;
}

const stats: GateStats = {
    evaluated: 0,
    simulated: 0,
    executed: 0,
    skippedAge: 0,
    skippedConcurrency: 0,
    skippedSpread: 0,
    skippedProfit: 0,
    skippedLiquidity: 0,
    skippedDuplicate: 0,
    skippedSimulation: 0,
};

export function getGateStats(): GateStats {
    return { ...stats };
}

export function incrementStat(stat: keyof GateStats): void {
    stats[stat]++;
}

export function resetGateStats(): void {
    stats.evaluated = 0;
    stats.simulated = 0;
    stats.executed = 0;
    stats.skippedAge = 0;
    stats.skippedConcurrency = 0;
    stats.skippedSpread = 0;
    stats.skippedProfit = 0;
    stats.skippedLiquidity = 0;
    stats.skippedDuplicate = 0;
    stats.skippedSimulation = 0;
}

export function getStatsBreakdown(): {
    totalEvaluated: number;
    simulationRate: number;
    executionRate: number;
    skipReasons: { reason: string; count: number; percent: number }[];
} {
    const total = stats.evaluated || 1;
    const simulated = stats.simulated || 1;

    const skipReasons = [
        { reason: "Too old", count: stats.skippedAge, percent: (stats.skippedAge / total) * 100 },
        { reason: "Concurrency limit", count: stats.skippedConcurrency, percent: (stats.skippedConcurrency / total) * 100 },
        { reason: "Duplicate token", count: stats.skippedDuplicate, percent: (stats.skippedDuplicate / total) * 100 },
        { reason: "Low spread", count: stats.skippedSpread, percent: (stats.skippedSpread / total) * 100 },
        { reason: "Low profit", count: stats.skippedProfit, percent: (stats.skippedProfit / total) * 100 },
        { reason: "Low liquidity", count: stats.skippedLiquidity, percent: (stats.skippedLiquidity / total) * 100 },
        { reason: "Simulation failed", count: stats.skippedSimulation, percent: (stats.skippedSimulation / total) * 100 },
    ].filter(r => r.count > 0);

    return {
        totalEvaluated: stats.evaluated,
        simulationRate: (stats.simulated / total) * 100,
        executionRate: (stats.executed / simulated) * 100,
        skipReasons
    };
}

// ============================================================================
// NOTE: evaluateOpportunity() has been REMOVED
// All evaluation logic is now in executionEngine.ts via the SimGate
// ============================================================================

export default {
    DEFAULT_GATE_CONFIG,
    getGateStats,
    incrementStat,
    resetGateStats,
    getStatsBreakdown
};