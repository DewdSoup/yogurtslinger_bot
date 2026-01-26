/**
 * Fee Calculation Module (Phase 5)
 * 
 * Handles per-venue fee structures.
 * 
 * Fee variations by venue:
 * - Raydium V4: Fixed LP + protocol fees (0-100 bps typical)
 * - PumpSwap: Fixed LP + protocol fees
 * - CLMM: Fee rate stored in pool config (1-100 bps typical)
 * - DLMM: Dynamic fees based on volatility + base fee
 * 
 * Critical: Fee application order varies by venue!
 * - Constant product: Fee deducted from input BEFORE swap
 * - CLMM: Fee collected during swap step calculation
 * - DLMM: Fee deducted from input at start of swap
 */

import type { PoolState } from '../../types.js';
import { VenueId } from '../../types.js';

// Constants
const FEE_DENOMINATOR = 10000n;
const MAX_FEE_BPS = 10000; // 100% max

export interface FeeParams {
    lpFeeBps: bigint;
    protocolFeeBps: bigint;
    // For DLMM dynamic fees
    baseFactor?: bigint;
    variableFeeFactor?: bigint;
    binStep?: number;  // Not economic, keep as number
}

export interface FeeResult {
    amountAfterFee: bigint;
    feePaid: bigint;
    lpFee: bigint;
    protocolFee: bigint;
}

export interface DetailedFeeResult extends FeeResult {
    baseFee: bigint;
    variableFee: bigint;
}

/**
 * Calculate fee for constant product AMMs (Raydium V4, PumpSwap)
 * Fee is deducted from input amount
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

    // Validate fee bounds
    if (totalFeeBps > BigInt(MAX_FEE_BPS)) {
        throw new Error(`Fee ${totalFeeBps} exceeds maximum ${MAX_FEE_BPS}`);
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
 * Calculate fee for output amount (reverse direction)
 * Given desired output, calculate required input including fees
 */
export function calculateFeeForOutput(outputAmount: bigint, params: FeeParams): FeeResult {
    const totalFeeBps = params.lpFeeBps + params.protocolFeeBps;

    if (totalFeeBps === 0n) {
        return {
            amountAfterFee: outputAmount,
            feePaid: 0n,
            lpFee: 0n,
            protocolFee: 0n,
        };
    }

    // amountBeforeFee = amountAfterFee * 10000 / (10000 - feeBps)
    const amountBeforeFee = (outputAmount * 10000n) / (10000n - totalFeeBps);
    const feePaid = amountBeforeFee - outputAmount;
    const lpFee = (amountBeforeFee * params.lpFeeBps) / FEE_DENOMINATOR;
    const protocolFee = feePaid - lpFee;

    return {
        amountAfterFee: outputAmount,
        feePaid,
        lpFee,
        protocolFee,
    };
}

/**
 * Calculate CLMM fee
 * CLMM uses a single fee rate from pool config
 */
export function calculateClmmFee(
    amount: bigint,
    feeRate: bigint
): { amountAfterFee: bigint; feePaid: bigint } {
    const feePaid = (amount * feeRate) / FEE_DENOMINATOR;
    return {
        amountAfterFee: amount - feePaid,
        feePaid,
    };
}

/**
 * Calculate DLMM dynamic fee
 *
 * DLMM fee = baseFee + variableFee
 * baseFee = baseFactor * binStep / 10000
 * variableFee = f(volatilityAccumulator)
 */
export function calculateDlmmFee(
    amount: bigint,
    baseFactor: bigint,
    binStep: number,
    variableFeeFactor: bigint,
    volatilityAccumulator: bigint
): DetailedFeeResult {
    // Base fee in bps: (baseFactor * binStep) / 10000
    // But we need to be careful with the scaling
    const binStepBig = BigInt(binStep);
    const baseFeeRate = (baseFactor * binStepBig) / 100n; // Result in bps
    const baseFee = (amount * baseFeeRate) / FEE_DENOMINATOR;

    // Variable fee based on volatility
    // The formula depends on protocol specifics
    // variableFee = (volatilityAccumulator * variableFeeFactor * binStep^2) / scale
    let variableFee = 0n;
    if (volatilityAccumulator > 0n && variableFeeFactor > 0n) {
        const binStepSq = binStepBig * binStepBig;
        const scale = 10000n * 10000n; // Double scale for precision
        variableFee = (volatilityAccumulator * variableFeeFactor * binStepSq) / scale;
        variableFee = (amount * variableFee) / FEE_DENOMINATOR;
    }

    const totalFee = baseFee + variableFee;

    // Cap at 10% (1000 bps)
    const cappedFee = totalFee > (amount * 1000n / FEE_DENOMINATOR)
        ? (amount * 1000n / FEE_DENOMINATOR)
        : totalFee;

    return {
        amountAfterFee: amount - cappedFee,
        feePaid: cappedFee,
        lpFee: cappedFee, // DLMM fees go to LPs
        protocolFee: 0n,
        baseFee,
        variableFee: cappedFee - baseFee,
    };
}

/**
 * Get fee parameters from pool state
 * Auto-detects venue and extracts appropriate fee params
 *
 * PumpSwap fees:
 *   - Injected from GlobalConfig via snapshot builder (lpFeeBps + protocolFeeBps)
 *   - GlobalConfig contains: lpFeeBps (20), protocolFeeBps (5), coinCreatorFeeBps (0-5)
 *   - Total = 25-30 bps depending on creator fee tier
 *   - Default fallback: 25 bps (20 + 5, no creator fee)
 */
export function getFeeParams(pool: PoolState): FeeParams {
    switch (pool.venue) {
        case VenueId.PumpSwap: {
            // Use injected fees from GlobalConfig if available
            // These are set by snapshot builder from GlobalConfigCache
            const p = pool as any;
            if (p.lpFeeBps !== undefined) {
                return {
                    lpFeeBps: p.lpFeeBps,
                    protocolFeeBps: p.protocolFeeBps ?? 0n,
                };
            }
            // Fallback: default PumpSwap fees (20 + 5 = 25 bps)
            // This matches the base GlobalConfig without creator fee
            return {
                lpFeeBps: 20n,
                protocolFeeBps: 5n,
            };
        }

        case VenueId.RaydiumV4: {
            // Convert numerator/denominator to basis points
            const p = pool as any;
            const feeBps = p.swapFeeDenominator > 0n
                ? (p.swapFeeNumerator * 10000n) / p.swapFeeDenominator
                : 25n; // Default 0.25%
            return {
                lpFeeBps: feeBps,
                protocolFeeBps: 0n,
            };
        }

        case VenueId.RaydiumClmm:
            // CLMM stores fee in ammConfig, injected as feeRate
            // Default to 25 bps (most common tier) if not populated
            return {
                lpFeeBps: (pool as any).feeRate ?? 25n,
                protocolFeeBps: 0n, // Protocol fees taken separately
            };

        case VenueId.MeteoraDlmm:
            // DLMM has dynamic fees - return base params
            const dlmm = pool as any;
            const baseFactor = dlmm.baseFactor ?? 0n;
            const binStep = dlmm.binStep ?? 0;
            return {
                lpFeeBps: (baseFactor * BigInt(binStep)) / 100n,
                protocolFeeBps: dlmm.protocolShare ?? 0n,
                baseFactor,
                variableFeeFactor: dlmm.variableFeeFactor,
                binStep,
            };

        default:
            return { lpFeeBps: 0n, protocolFeeBps: 0n };
    }
}

/**
 * Get total fee in basis points for a venue
 * Useful for quick estimates
 */
export function getTotalFeeBps(pool: PoolState): bigint {
    const params = getFeeParams(pool);
    return params.lpFeeBps + params.protocolFeeBps;
}

/**
 * Validate fee parameters are within expected bounds
 */
export function validateFeeParams(params: FeeParams): boolean {
    const maxFeeBps = BigInt(MAX_FEE_BPS);
    // Check individual bounds
    if (params.lpFeeBps < 0n || params.lpFeeBps > maxFeeBps) return false;
    if (params.protocolFeeBps < 0n || params.protocolFeeBps > maxFeeBps) return false;

    // Check total
    if (params.lpFeeBps + params.protocolFeeBps > maxFeeBps) return false;

    return true;
}

/**
 * Calculate minimum output after maximum expected fee
 * Useful for slippage protection
 */
export function calculateMinOutput(
    expectedOutput: bigint,
    maxFeeBps: number,
    slippageBps: number
): bigint {
    const totalDeduction = BigInt(maxFeeBps + slippageBps);
    return (expectedOutput * (10000n - totalDeduction)) / 10000n;
}

/**
 * Estimate effective fee rate from actual swap
 * Useful for analytics and debugging
 */
export function estimateEffectiveFeeRate(
    inputAmount: bigint,
    outputAmount: bigint,
    spotPrice: bigint
): number {
    if (inputAmount === 0n) return 0;

    // Expected output at spot price (in output token)
    // expectedOutput = inputAmount * spotPrice / SCALE
    const SCALE = 2n ** 64n; // Q64 for price
    const expectedOutput = (inputAmount * spotPrice) / SCALE;

    if (expectedOutput <= outputAmount) return 0;

    // Fee = (expected - actual) / expected * 10000
    const feeBps = Number(
        ((expectedOutput - outputAmount) * 10000n) / expectedOutput
    );

    return Math.min(feeBps, MAX_FEE_BPS);
}

// Export constants
export const CONSTANTS = {
    FEE_DENOMINATOR,
    MAX_FEE_BPS,
};