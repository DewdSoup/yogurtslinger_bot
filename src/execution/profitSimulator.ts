// src/execution/profitSimulator.ts
// Profit simulation utilities for arbitrage detection
// SIMGATE ARCHITECTURE: This provides quick spread checks before RPC simulation
//
// Fee constants and PoolState interface for all supported venues:
//   - PumpSwap (CPMM)
//   - Raydium V4 (CPMM)
//   - Raydium CLMM (Concentrated Liquidity)
//   - Meteora DLMM (Concentrated Liquidity)

import { PublicKey } from "@solana/web3.js";

// ============================================================================
// FEE CONSTANTS
// ============================================================================

/**
 * Fee rates as decimals (e.g., 0.0025 = 0.25%)
 * 
 * NOTE: Meteora and Raydium CLMM have DYNAMIC fees that vary per pool.
 * These constants are defaults/minimums for quick filtering.
 * Actual fees should be read from pool state for accurate simulation.
 */
export const FEES = {
    // PumpSwap: Fixed 0.25% fee
    PUMPSWAP: 0.0025,
    PUMPSWAP_BPS: 25,

    // Raydium V4: Fixed 0.25% fee (most pools)
    RAYDIUM: 0.0025,
    RAYDIUM_BPS: 25,

    // Raydium CLMM: Dynamic fees via AmmConfig
    // Common tiers: 0.01%, 0.05%, 0.25%, 1%
    // Using 0.25% as conservative default
    RAYDIUM_CLMM: 0.0025,
    RAYDIUM_CLMM_BPS: 25,
    RAYDIUM_CLMM_MIN: 0.0001,      // 0.01% (1 bps)
    RAYDIUM_CLMM_MAX: 0.01,        // 1% (100 bps)

    // Meteora DLMM: Dynamic fees (base + variable)
    // Base fee depends on binStep and baseFactor
    // Variable fee spikes during volatility
    METEORA_DEFAULT: 0.003,        // 0.3% typical
    METEORA_DEFAULT_BPS: 30,
    METEORA_MIN: 0.001,            // 0.1% minimum
    METEORA_MAX: 0.10,             // 10% cap during high volatility
} as const;

// ============================================================================
// POOL STATE INTERFACE
// ============================================================================

/**
 * Tip calculation strategy for Jito bundles
 */
export const TIP_STRATEGY = {
    BASE_TIP_LAMPORTS: 10_000n,           // 0.00001 SOL base
    PROFIT_SHARE_PERCENT: 50,             // 50% of profit as tip
    FRESH_POOL_MULTIPLIER: 1.5,           // 1.5x for fresh pools
    HIGH_SPREAD_MULTIPLIER: 1.2,          // 1.2x for high spreads (>100bps)
    MIN_TIP_LAMPORTS: 100_000n,           // 0.0001 SOL minimum
    MAX_TIP_LAMPORTS: 10_000_000n,        // 0.01 SOL maximum
    MIN_NET_PROFIT_LAMPORTS: 50_000n,     // Minimum profit after tip
} as const;

/**
 * Unified pool state for arbitrage detection and execution.
 * Supports all venue types with venue-specific optional fields.
 * 
 * NOTE: Optional properties use `| undefined` for exactOptionalPropertyTypes compatibility.
 */
export interface PoolState {
    /** Pool account pubkey */
    pubkey: string;

    /** Venue identifier */
    venue: "PumpSwap" | "Raydium" | "RaydiumCLMM" | "Meteora";

    /** Token mint (non-SOL side) */
    tokenMint: string;

    /** Base reserve (token side) in raw units */
    baseReserve: bigint;

    /** Quote reserve (SOL side) in raw units */
    quoteReserve: bigint;

    /** Base token mint */
    baseMint: string;

    /** Quote token mint (usually SOL) */
    quoteMint: string;

    /** Fee rate as decimal (0.0025 = 0.25%) */
    feeRate: number;

    // ---- Concentrated Liquidity Fields (Meteora DLMM, Raydium CLMM) ----

    /** Bin step / tick spacing (Meteora: binStep, CLMM: tickSpacing) */
    binStep?: number | undefined;

    /** Active bin ID / current tick (Meteora: activeId, CLMM: tickCurrent) */
    activeId?: number | undefined;

    // ---- Metadata ----

    /** Last update slot */
    lastSlot: bigint;

    /** Last update timestamp (ms) */
    lastUpdatedTs: number;

    /** Pool creation timestamp (ms), null if unknown */
    createdTs: number | null;

    // ---- Extended Data (venue-specific) ----

    /** Raydium CLMM extended data for swap simulation */
    clmmData?: {
        sqrtPriceX64: bigint;
        liquidity: bigint;
        tickCurrent: number;
        tickSpacing: number;
        tokenVault0: PublicKey;
        tokenVault1: PublicKey;
        tokenMint0: PublicKey;
        tokenMint1: PublicKey;
        ammConfig: PublicKey;
        observationKey: PublicKey;
    } | undefined;

    /** Meteora DLMM extended data for swap simulation */
    meteoraData?: {
        baseFactor: number;
        variableFeeControl: number;
        volatilityAccumulator: number;
        protocolShare: number;
        filterPeriod: number;
        decayPeriod: number;
        reductionFactor: number;
    } | undefined;
}

// ============================================================================
// QUICK SPREAD CHECK
// ============================================================================

export interface SpreadCheckResult {
    /** Whether spread exceeds combined fees */
    hasSpread: boolean;

    /** Estimated spread in basis points */
    estimatedSpreadBps: number;

    /** Combined fee rate (buy + sell) */
    combinedFeeRate: number;

    /** Buy price (SOL per token) */
    buyPrice: number;

    /** Sell price (SOL per token) */
    sellPrice: number;
}

/**
 * Quick spread check between two pools.
 * Used for fast filtering before expensive RPC simulation.
 * 
 * Does NOT account for:
 *   - Slippage from trade size
 *   - Concentrated liquidity bin traversal
 *   - Dynamic fees (uses pool's current feeRate)
 *   - Priority fees / Jito tips
 * 
 * @param buyPool Pool to buy token from (lower price)
 * @param sellPool Pool to sell token to (higher price)
 * @returns Spread check result
 */
export function quickSpreadCheck(
    buyPool: PoolState,
    sellPool: PoolState
): SpreadCheckResult {
    // Calculate spot prices (SOL per token)
    // Price = quoteReserve / baseReserve
    const buyPrice = Number(buyPool.quoteReserve) / Number(buyPool.baseReserve);
    const sellPrice = Number(sellPool.quoteReserve) / Number(sellPool.baseReserve);

    // Gross spread (before fees)
    const grossSpread = (sellPrice - buyPrice) / buyPrice;
    const grossSpreadBps = Math.round(grossSpread * 10000);

    // Combined fees (buy fee + sell fee)
    const combinedFeeRate = buyPool.feeRate + sellPool.feeRate;
    const combinedFeeBps = Math.round(combinedFeeRate * 10000);

    // Net spread after fees
    const netSpreadBps = grossSpreadBps - combinedFeeBps;

    return {
        hasSpread: netSpreadBps > 0,
        estimatedSpreadBps: netSpreadBps,
        combinedFeeRate,
        buyPrice,
        sellPrice,
    };
}

// ============================================================================
// TIP CALCULATION
// ============================================================================

/**
 * Calculate dynamic Jito tip based on profit and conditions
 */
export function calculateDynamicTip(
    grossProfitLamports: bigint,
    isFreshPool: boolean,
    spreadBps: number
): bigint {
    // Base tip is percentage of profit
    let tip = (grossProfitLamports * BigInt(TIP_STRATEGY.PROFIT_SHARE_PERCENT)) / 100n;

    // Add base tip
    tip += TIP_STRATEGY.BASE_TIP_LAMPORTS;

    // Apply multipliers
    if (isFreshPool) {
        tip = (tip * BigInt(Math.floor(TIP_STRATEGY.FRESH_POOL_MULTIPLIER * 100))) / 100n;
    }
    if (spreadBps > 100) {
        tip = (tip * BigInt(Math.floor(TIP_STRATEGY.HIGH_SPREAD_MULTIPLIER * 100))) / 100n;
    }

    // Clamp to bounds
    if (tip < TIP_STRATEGY.MIN_TIP_LAMPORTS) tip = TIP_STRATEGY.MIN_TIP_LAMPORTS;
    if (tip > TIP_STRATEGY.MAX_TIP_LAMPORTS) tip = TIP_STRATEGY.MAX_TIP_LAMPORTS;

    return tip;
}

// ============================================================================
// LIQUIDITY ANALYSIS
// ============================================================================

export interface LiquidityConstraint {
    minLiquidity: bigint;
    recommendedMaxSize: bigint;
    buyLiquidity: bigint;
    sellLiquidity: bigint;
}

/**
 * Get constraining liquidity for position sizing
 * Returns the minimum liquidity and recommended max trade size
 */
export function getConstrainingLiquidity(
    buyPool: PoolState,
    sellPool: PoolState
): LiquidityConstraint {
    // Use quote reserves (SOL side) as liquidity measure
    const buyLiquidity = buyPool.quoteReserve;
    const sellLiquidity = sellPool.quoteReserve;
    const minLiquidity = buyLiquidity < sellLiquidity ? buyLiquidity : sellLiquidity;

    // Recommend max 2% of constraining liquidity to avoid excessive slippage
    const recommendedMaxSize = minLiquidity / 50n;

    return {
        minLiquidity,
        recommendedMaxSize,
        buyLiquidity,
        sellLiquidity,
    };
}

// ============================================================================
// FEE UTILITIES
// ============================================================================

/**
 * Get fee rate for a venue.
 * For dynamic-fee venues (Meteora, CLMM), returns the default.
 * Use pool state's feeRate for accurate values.
 */
export function getDefaultFeeRate(venue: PoolState["venue"]): number {
    switch (venue) {
        case "PumpSwap":
            return FEES.PUMPSWAP;
        case "Raydium":
            return FEES.RAYDIUM;
        case "RaydiumCLMM":
            return FEES.RAYDIUM_CLMM;
        case "Meteora":
            return FEES.METEORA_DEFAULT;
        default:
            return 0.003; // Conservative 0.3% default
    }
}

/**
 * Check if a fee rate is within expected bounds for a venue.
 * Useful for detecting anomalous/manipulated pools.
 */
export function isFeeRateReasonable(
    venue: PoolState["venue"],
    feeRate: number
): boolean {
    switch (venue) {
        case "PumpSwap":
            return feeRate === FEES.PUMPSWAP;
        case "Raydium":
            return feeRate >= 0.001 && feeRate <= 0.01; // 0.1% - 1%
        case "RaydiumCLMM":
            return feeRate >= FEES.RAYDIUM_CLMM_MIN && feeRate <= FEES.RAYDIUM_CLMM_MAX;
        case "Meteora":
            return feeRate >= FEES.METEORA_MIN && feeRate <= FEES.METEORA_MAX;
        default:
            return feeRate >= 0 && feeRate <= 0.10;
    }
}

// ============================================================================
// PRICE UTILITIES
// ============================================================================

/**
 * Calculate spot price (SOL per token) from reserves.
 */
export function calculateSpotPrice(pool: PoolState): number {
    if (pool.baseReserve === 0n) return 0;
    return Number(pool.quoteReserve) / Number(pool.baseReserve);
}

/**
 * Calculate price impact for a given trade size.
 * Uses constant product formula: impact ≈ tradeSize / reserve
 * 
 * NOTE: This is approximate. For CLMM/DLMM, actual impact depends on
 * liquidity distribution across ticks/bins.
 */
export function estimatePriceImpact(
    pool: PoolState,
    tradeSizeLamports: bigint,
    isBuy: boolean
): number {
    const relevantReserve = isBuy ? pool.quoteReserve : pool.baseReserve;
    if (relevantReserve === 0n) return 1; // 100% impact (empty pool)
    return Number(tradeSizeLamports) / Number(relevantReserve);
}

/**
 * Estimate minimum profitable trade size given spread and fees.
 * Returns lamports of SOL needed to cover priority fees.
 */
export function estimateMinProfitableSize(
    spreadBps: number,
    priorityFeeLamports: bigint = 10000n, // 0.00001 SOL default
    jitoTipLamports: bigint = 1000000n    // 0.001 SOL default
): bigint {
    if (spreadBps <= 0) return 0n;

    // Profit = tradeSize * (spreadBps / 10000)
    // We need: tradeSize * (spreadBps / 10000) > priorityFee + jitoTip
    // tradeSize > (priorityFee + jitoTip) * 10000 / spreadBps
    const totalFees = priorityFeeLamports + jitoTipLamports;
    const minSize = (totalFees * 10000n) / BigInt(spreadBps);

    return minSize;
}

// ============================================================================
// VENUE TYPE GUARDS
// ============================================================================

export function isPumpSwap(pool: PoolState): boolean {
    return pool.venue === "PumpSwap";
}

export function isRaydiumV4(pool: PoolState): boolean {
    return pool.venue === "Raydium";
}

export function isRaydiumCLMM(pool: PoolState): boolean {
    return pool.venue === "RaydiumCLMM";
}

export function isMeteora(pool: PoolState): boolean {
    return pool.venue === "Meteora";
}

export function isConcentratedLiquidity(pool: PoolState): boolean {
    return pool.venue === "RaydiumCLMM" || pool.venue === "Meteora";
}

export function isConstantProduct(pool: PoolState): boolean {
    return pool.venue === "PumpSwap" || pool.venue === "Raydium";
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
    FEES,
    TIP_STRATEGY,
    quickSpreadCheck,
    calculateDynamicTip,
    getConstrainingLiquidity,
    getDefaultFeeRate,
    isFeeRateReasonable,
    calculateSpotPrice,
    estimatePriceImpact,
    estimateMinProfitableSize,
    isPumpSwap,
    isRaydiumV4,
    isRaydiumCLMM,
    isMeteora,
    isConcentratedLiquidity,
    isConstantProduct,
};