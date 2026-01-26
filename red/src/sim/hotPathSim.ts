// src/sim/hotPathSim.ts
//
// Hot path simulations - minimal allocation, maximum speed.
//
// Each simulate* function reads directly from cached buffers,
// avoiding object allocations in the critical path.

import type { AccountStore, PubkeyStr } from "../state/accountStore";
import {
    HotPathCache,
    CachedPumpSwapPool,
    CachedRaydiumV4Pool,
    CachedClmmPool,
    CachedDlmmPool,
    readTokenAmount,
    readClmmLiquidity,
    readClmmSqrtPriceX64,
} from "../state/hotPathCache";

// Re-export cache types for convenience
export { HotPathCache, CachedPumpSwapPool, CachedRaydiumV4Pool, CachedClmmPool, CachedDlmmPool };

// ============================================================================
// PumpSwap Hot Path
// ============================================================================

const PUMPSWAP_FEE_DENOM = BigInt(10000);

export interface PumpSwapQuickQuote {
    amountOut: bigint;
    newBaseReserve: bigint;
    newQuoteReserve: bigint;
}

/**
 * Compute net input after fee deduction for BUY direction.
 * MATCHES VALIDATED pumpswapFees.ts applyFeesOnInput() EXACTLY.
 *
 * Formula: net = floor(grossIn * 10000 / (10000 + feeBps))
 * Then verify with ceiling check and adjust if needed.
 */
function pumpswapNetInputAfterFee(grossIn: bigint, feeBps: bigint): bigint {
    if (grossIn <= BigInt(0)) return grossIn;
    if (feeBps <= BigInt(0)) return grossIn;

    // net = floor(grossIn * 10000 / (10000 + feeBps))
    let net = (grossIn * PUMPSWAP_FEE_DENOM) / (PUMPSWAP_FEE_DENOM + feeBps);

    // Ceiling fee check: fee = ceil(net * feeBps / 10000)
    const feeCheck = (net * feeBps + PUMPSWAP_FEE_DENOM - BigInt(1)) / PUMPSWAP_FEE_DENOM;

    // Adjust if needed to account for ceiling
    if (net + feeCheck < grossIn) {
        net = net + BigInt(1);
    }

    return net;
}

/**
 * Ultra-fast PumpSwap simulation.
 * VALIDATED: Matches pumpswapSim.ts exactly (100% regression accuracy).
 *
 * @param store - Account store with raw buffers
 * @param pool - Cached pool metadata (vault addresses, fees)
 * @param amountIn - Input amount
 * @param isBaseToQuote - true = sell base for quote, false = buy base with quote
 */
export function simulatePumpSwapQuick(
    store: AccountStore,
    pool: CachedPumpSwapPool,
    amountIn: bigint,
    isBaseToQuote: boolean
): PumpSwapQuickQuote | null {
    // Direct buffer reads - zero allocation
    const baseData = (store as any).getData?.(pool.baseVault);
    const quoteData = (store as any).getData?.(pool.quoteVault);

    if (!baseData || !quoteData) return null;

    const baseReserve = readTokenAmount(baseData);
    const quoteReserve = readTokenAmount(quoteData);

    if (baseReserve === undefined || quoteReserve === undefined) return null;

    const totalFeeBps = BigInt(pool.lpFeeBps + pool.protocolFeeBps);

    if (isBaseToQuote) {
        // SELL: base in, quote out
        // Fee on OUTPUT (quote) - floor division matches validated sim
        const grossOut = (quoteReserve * amountIn) / (baseReserve + amountIn);
        const fee = (grossOut * totalFeeBps) / PUMPSWAP_FEE_DENOM;
        const amountOut = grossOut - fee;

        return {
            amountOut,
            newBaseReserve: baseReserve + amountIn,
            newQuoteReserve: quoteReserve - grossOut,
        };
    } else {
        // BUY: quote in, base out
        // Fee on INPUT (quote) - ceiling-adjusted formula matches validated sim
        const netIn = pumpswapNetInputAfterFee(amountIn, totalFeeBps);
        const amountOut = (baseReserve * netIn) / (quoteReserve + netIn);

        return {
            amountOut,
            newBaseReserve: baseReserve - amountOut,
            newQuoteReserve: quoteReserve + amountIn,
        };
    }
}

// ============================================================================
// Raydium V4 Hot Path
// ============================================================================

export interface RaydiumV4QuickQuote {
    amountOut: bigint;
    newBaseReserve: bigint;
    newQuoteReserve: bigint;
}

/**
 * Ultra-fast Raydium V4 simulation.
 * VALIDATED: Matches raydiumV4Sim.ts exactly (100% regression accuracy).
 *
 * Fee calculation MUST match validated sim:
 *   feeAmount = floor(amountIn * feeNum / feeDenom)
 *   amountInAfterFee = amountIn - feeAmount
 *
 * NOT the shortcut: floor(amountIn * (feeDenom - feeNum) / feeDenom)
 * which has different rounding for small amounts.
 */
export function simulateRaydiumV4Quick(
    store: AccountStore,
    pool: CachedRaydiumV4Pool,
    amountIn: bigint,
    isBaseToQuote: boolean
): RaydiumV4QuickQuote | null {
    const baseData = (store as any).getData?.(pool.baseVault);
    const quoteData = (store as any).getData?.(pool.quoteVault);

    if (!baseData || !quoteData) return null;

    const baseReserve = readTokenAmount(baseData);
    const quoteReserve = readTokenAmount(quoteData);

    if (baseReserve === undefined || quoteReserve === undefined) return null;

    // Raydium V4 fee calculation - MATCHES VALIDATED SIM EXACTLY
    // feeAmount = floor(amountIn * feeNum / feeDenom)
    // amountInAfterFee = amountIn - feeAmount
    const feeNum = pool.swapFeeNumerator;
    const feeDenom = pool.swapFeeDenominator;

    if (amountIn <= BigInt(0) || feeDenom === BigInt(0)) {
        return {
            amountOut: BigInt(0),
            newBaseReserve: baseReserve,
            newQuoteReserve: quoteReserve,
        };
    }

    const feeAmount = (amountIn * feeNum) / feeDenom;
    const amountInAfterFee = amountIn - feeAmount;

    if (isBaseToQuote) {
        // Sell base for quote
        const amountOut = (quoteReserve * amountInAfterFee) / (baseReserve + amountInAfterFee);
        return {
            amountOut,
            newBaseReserve: baseReserve + amountIn,
            newQuoteReserve: quoteReserve - amountOut,
        };
    } else {
        // Buy base with quote
        const amountOut = (baseReserve * amountInAfterFee) / (quoteReserve + amountInAfterFee);
        return {
            amountOut,
            newBaseReserve: baseReserve - amountOut,
            newQuoteReserve: quoteReserve + amountIn,
        };
    }
}

// ============================================================================
// CLMM Hot Path
// ============================================================================

// Re-export the validated CLMM simulator for exact calculations
export { simulateRaydiumCLMMSwapExactIn, CLMMSwapResult } from "./raydiumCLMMSim";
export type { RaydiumTickArrayState } from "../decoders/raydiumTickArray";
export type { RaydiumAmmConfigState } from "../decoders/raydiumAmmConfig";
export type { RaydiumCLMMPoolState } from "../decoders/raydiumCLMMPool";

// Import and re-export accurate hot path simulators
import {
    simulateClmmHotPath,
    simulateClmmFromBuffers,
    type CachedClmmTickList,
    type ClmmHotPathResult,
} from "./clmmHotPath";

import {
    simulateDlmmHotPath,
    simulateDlmmFromBuffers,
    type CachedDlmmBinMap,
    type DlmmHotPathResult,
    type DlmmSwapDirection,
} from "./dlmmHotPath";

export {
    simulateClmmHotPath,
    simulateClmmFromBuffers,
    type CachedClmmTickList,
    type ClmmHotPathResult,
    simulateDlmmHotPath,
    simulateDlmmFromBuffers,
    type CachedDlmmBinMap,
    type DlmmHotPathResult,
    type DlmmSwapDirection,
};

const Q64 = BigInt(1) << BigInt(64);

export interface ClmmQuickQuote {
    amountOut: bigint;
    feeAmount: bigint;
    ticksCrossed: number;
    priceImpactBps: number;
}

/**
 * ACCURATE CLMM hot path simulation with tick traversal.
 *
 * Uses pre-cached tick list for ~10-50µs latency.
 * This is the recommended function for execution accuracy.
 *
 * @param store - Account store for buffer reads
 * @param pool - Cached pool metadata
 * @param tickList - Pre-cached initialized tick list
 * @param amountIn - Input amount
 * @param zeroForOne - Direction (true = token0 in, token1 out)
 * @param tradeFeeRate - Fee rate from AmmConfig (per 1_000_000)
 */
export function simulateClmmQuick(
    store: AccountStore,
    pool: CachedClmmPool,
    tickList: CachedClmmTickList,
    amountIn: bigint,
    zeroForOne: boolean,
    tradeFeeRate: number
): ClmmQuickQuote | null {
    const poolData = (store as any).getData?.(pool.poolAddress);
    if (!poolData) return null;

    const result = simulateClmmFromBuffers(poolData, tickList, tradeFeeRate, amountIn, zeroForOne);
    if (!result) return null;

    const liquidity = readClmmLiquidity(poolData);
    const priceImpactBps = liquidity && liquidity > BigInt(0)
        ? Number((amountIn * BigInt(10000)) / liquidity)
        : 10000;

    return {
        amountOut: result.amountOut,
        feeAmount: result.feeAmount,
        ticksCrossed: result.ticksCrossed,
        priceImpactBps,
    };
}

export interface DlmmQuickQuote {
    amountOut: bigint;
    feeAmount: bigint;
    binsTraversed: number;
}

/**
 * ACCURATE DLMM hot path simulation with bin traversal.
 *
 * Uses pre-cached bin map for ~10-50µs latency.
 *
 * @param store - Account store for buffer reads
 * @param pool - Cached pool metadata
 * @param binMap - Pre-cached bin liquidity map
 * @param amountIn - Input amount
 * @param direction - Swap direction (xToY or yToX)
 */
export function simulateDlmmQuick(
    store: AccountStore,
    pool: CachedDlmmPool,
    binMap: CachedDlmmBinMap,
    amountIn: bigint,
    direction: DlmmSwapDirection
): DlmmQuickQuote | null {
    const pairData = (store as any).getData?.(pool.poolAddress);
    if (!pairData) return null;

    const result = simulateDlmmFromBuffers(pairData, binMap, amountIn, direction);
    if (!result) return null;

    return {
        amountOut: result.amountOut,
        feeAmount: result.feeTotal,
        binsTraversed: result.binsTraversed,
    };
}

/**
 * ⚠️ DEPRECATED: Use simulateClmmQuick with tick list instead.
 *
 * Quick CLMM quote using current liquidity (NO tick traversal).
 * Use ONLY for rough routing decisions when comparing pools.
 *
 * Limitations:
 * - Assumes no tick crossing (small swaps only)
 * - Uses spot price approximation
 * - Error can be 5-50% or more for large swaps
 */
export function estimateClmmQuickForRouting(
    store: AccountStore,
    pool: CachedClmmPool,
    amountIn: bigint,
    zeroForOne: boolean,
    feeRateBps: number
): ClmmQuickQuote | null {
    const poolData = (store as any).getData?.(pool.poolAddress);
    if (!poolData) return null;

    const liquidity = readClmmLiquidity(poolData);
    const sqrtPriceX64 = readClmmSqrtPriceX64(poolData);

    if (!liquidity || !sqrtPriceX64 || liquidity === BigInt(0)) return null;

    const feeRate = BigInt(feeRateBps);
    const FEE_DENOM = BigInt(1_000_000);
    const feeAmount = (amountIn * feeRate) / FEE_DENOM;
    const amountInAfterFee = amountIn - feeAmount;

    let amountOut: bigint;

    if (zeroForOne) {
        const priceX128 = (sqrtPriceX64 * sqrtPriceX64) / Q64;
        amountOut = (amountInAfterFee * priceX128) / Q64;
    } else {
        const priceX128 = (sqrtPriceX64 * sqrtPriceX64) / Q64;
        if (priceX128 === BigInt(0)) return null;
        amountOut = (amountInAfterFee * Q64) / priceX128;
    }

    const priceImpactBps = liquidity > BigInt(0)
        ? Number((amountIn * BigInt(10000)) / liquidity)
        : 10000;

    return { amountOut, feeAmount, ticksCrossed: 0, priceImpactBps };
}

// Backward compatibility - prefer simulateClmmQuick for accuracy
export const estimateClmmQuick = estimateClmmQuickForRouting;

// ============================================================================
// Batch Simulation Helper
// ============================================================================

export interface BatchQuoteResult {
    poolAddress: PubkeyStr;
    venue: string;
    amountOut: bigint | null;
    error?: string;
}

/**
 * Run quick quotes on multiple pools in one pass.
 * Useful for routing across many pools.
 */
export function batchQuote(
    store: AccountStore,
    cache: HotPathCache,
    poolAddresses: PubkeyStr[],
    amountIn: bigint,
    direction: "buy" | "sell"
): BatchQuoteResult[] {
    const results: BatchQuoteResult[] = [];

    for (const addr of poolAddresses) {
        const pool = cache.getPool(addr);
        if (!pool) {
            results.push({ poolAddress: addr, venue: "unknown", amountOut: null, error: "not cached" });
            continue;
        }

        let amountOut: bigint | null = null;
        let error: string | undefined;

        try {
            switch (pool.venue) {
                case "pumpswap": {
                    const quote = simulatePumpSwapQuick(store, pool, amountIn, direction === "sell");
                    amountOut = quote?.amountOut ?? null;
                    break;
                }
                case "raydium_v4": {
                    const quote = simulateRaydiumV4Quick(store, pool, amountIn, direction === "sell");
                    amountOut = quote?.amountOut ?? null;
                    break;
                }
                case "raydium_clmm": {
                    // CLMM needs fee rate from AmmConfig
                    // For quick estimate, use 0.25% default
                    const quote = estimateClmmQuick(store, pool, amountIn, direction === "sell", 2500);
                    amountOut = quote?.amountOut ?? null;
                    break;
                }
                case "meteora_dlmm": {
                    // DLMM quick path not implemented yet
                    error = "DLMM quick path not implemented";
                    break;
                }
            }
        } catch (e: any) {
            error = e?.message ?? "unknown error";
        }

        const result: BatchQuoteResult = { poolAddress: addr, venue: pool.venue, amountOut };
        if (error) result.error = error;
        results.push(result);
    }

    return results;
}
