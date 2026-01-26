// src/sim/raydiumV4Sim.ts
// Integer-only Raydium V4 constant-product simulation with variable fee support.

import type { RaydiumV4PoolState } from "../decoders/raydiumV4Pool";

export const BPS_DENOM = 10_000n;

export interface RaydiumV4EffectiveReserves {
    // Effective reserves used by swap math
    baseReserve: bigint;
    quoteReserve: bigint;

    // For transparency/debugging
    baseVault: bigint;
    quoteVault: bigint;
    openOrdersBase: bigint;
    openOrdersQuote: bigint;
    baseNeedTakePnl: bigint;
    quoteNeedTakePnl: bigint;
}

export interface RaydiumV4SwapQuote {
    amountIn: bigint;
    amountInAfterFee: bigint;
    amountOut: bigint;
    feeAmount: bigint;

    // Which side was input/output
    baseToQuote: boolean;

    // Reserves used
    reserveIn: bigint;
    reserveOut: bigint;

    // Fee fraction used
    feeNumerator: bigint;
    feeDenominator: bigint;
}

/**
 * SPL (Tokenkeg / Token-2022) token account `amount` is at offset 64, u64 LE.
 * This is safe for both Token Program and Token-2022 token accounts.
 */
export function readSplTokenAccountAmount(data: Buffer | Uint8Array): bigint {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 72) return 0n;
    return buf.readBigUInt64LE(64);
}

export function computeRaydiumV4Fee(amountIn: bigint, feeNumerator: bigint, feeDenominator: bigint): bigint {
    if (amountIn <= 0n) return 0n;
    if (feeDenominator === 0n || feeNumerator === 0n) return 0n;
    return (amountIn * feeNumerator) / feeDenominator; // floor
}

function saturatingSub(a: bigint, b: bigint): bigint {
    return a > b ? a - b : 0n;
}

/**
 * Compute effective reserves:
 *   reserve = vaultBalance + openOrdersTotal - needTakePnl
 *
 * This matches the typical Raydium SDK approach and protects against PnL-reserved amounts
 * being mistakenly treated as swap liquidity.
 */
export function computeEffectiveReserves(
    pool: RaydiumV4PoolState,
    baseVaultBalance: bigint,
    quoteVaultBalance: bigint,
    openOrdersBaseTotal: bigint = 0n,
    openOrdersQuoteTotal: bigint = 0n
): RaydiumV4EffectiveReserves {
    const baseReserveRaw = baseVaultBalance + openOrdersBaseTotal;
    const quoteReserveRaw = quoteVaultBalance + openOrdersQuoteTotal;

    const baseReserve = saturatingSub(baseReserveRaw, pool.baseNeedTakePnl);
    const quoteReserve = saturatingSub(quoteReserveRaw, pool.quoteNeedTakePnl);

    return {
        baseReserve,
        quoteReserve,
        baseVault: baseVaultBalance,
        quoteVault: quoteVaultBalance,
        openOrdersBase: openOrdersBaseTotal,
        openOrdersQuote: openOrdersQuoteTotal,
        baseNeedTakePnl: pool.baseNeedTakePnl,
        quoteNeedTakePnl: pool.quoteNeedTakePnl,
    };
}

/**
 * Constant product amount out:
 *   out = (reserveOut * inAfterFee) / (reserveIn + inAfterFee)
 */
export function getAmountOutConstantProduct(
    amountInAfterFee: bigint,
    reserveIn: bigint,
    reserveOut: bigint
): bigint {
    if (amountInAfterFee <= 0n) return 0n;
    if (reserveIn <= 0n || reserveOut <= 0n) return 0n;

    const denom = reserveIn + amountInAfterFee;
    if (denom === 0n) return 0n;

    return (reserveOut * amountInAfterFee) / denom; // floor
}

/**
 * Simulate a Raydium V4 swap.
 *
 * Inputs:
 * - pool: decoded pool state (fee numerator/denom, needTakePnl, etc.)
 * - amountIn: amount of token in (raw units)
 * - baseToQuote: true for base->quote, false for quote->base
 * - balances: pass effective vault balances from SPL token accounts
 * - openOrders totals optional (often 0, but include when you want exact parity)
 */
export function simulateRaydiumV4Swap(params: {
    pool: RaydiumV4PoolState;
    amountIn: bigint;
    baseToQuote: boolean;
    baseVaultBalance: bigint;
    quoteVaultBalance: bigint;
    openOrdersBaseTotal?: bigint | undefined;
    openOrdersQuoteTotal?: bigint | undefined;
}): RaydiumV4SwapQuote {
    const {
        pool,
        amountIn,
        baseToQuote,
        baseVaultBalance,
        quoteVaultBalance,
        openOrdersBaseTotal = 0n,
        openOrdersQuoteTotal = 0n,
    } = params;

    const eff = computeEffectiveReserves(pool, baseVaultBalance, quoteVaultBalance, openOrdersBaseTotal, openOrdersQuoteTotal);

    const baseReserve = eff.baseReserve;
    const quoteReserve = eff.quoteReserve;

    const reserveIn = baseToQuote ? baseReserve : quoteReserve;
    const reserveOut = baseToQuote ? quoteReserve : baseReserve;

    const feeAmount = computeRaydiumV4Fee(amountIn, pool.swapFeeNumerator, pool.swapFeeDenominator);
    const amountInAfterFee = amountIn > feeAmount ? amountIn - feeAmount : 0n;

    const amountOut = getAmountOutConstantProduct(amountInAfterFee, reserveIn, reserveOut);

    return {
        amountIn,
        amountInAfterFee,
        amountOut,
        feeAmount,
        baseToQuote,
        reserveIn,
        reserveOut,
        feeNumerator: pool.swapFeeNumerator,
        feeDenominator: pool.swapFeeDenominator,
    };
}
