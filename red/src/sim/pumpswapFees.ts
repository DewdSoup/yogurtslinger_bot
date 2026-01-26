// src/sim/pumpswapFees.ts
//
// PumpSwap fee helpers for vault-delta-faithful simulation.
//
// For vault-delta parity, the swap math must include every fee component that is
// charged implicitly (i.e. reduces pool vault outflow or reduces net curve input).
//
// IMPORTANT: On-chain analysis confirms that coinCreatorFee is NOT charged on
// PumpSwap AMM swaps. Only LP (20 bps) + Protocol (5 bps) = 25 bps is deducted
// from vault deltas. The coinCreatorFeeBasisPoints field exists in GlobalConfig
// but is not applied during swap execution.

import type { PumpFeesFeesBps, PumpFeesFeeConfig } from "../decoders/pumpFeesFeeConfig";
import { selectTierFeesLowerBound } from "../decoders/pumpFeesFeeConfig";
import type { PumpSwapGlobalConfig } from "../decoders/pumpswapGlobalConfig";

export const BPS_DENOM = 10_000n;

export type PumpSwapFeesBps = PumpFeesFeesBps;

export interface FeeBreakdown {
    gross: bigint;
    net: bigint;
    totalFee: bigint;

    // Diagnostic attribution only
    lpFee: bigint;
    protocolFee: bigint;
    coinCreatorFee: bigint;

    totalFeeBps: bigint;
}

function mulDivFloor(a: bigint, b: bigint, d: bigint): bigint {
    if (d === 0n) throw new Error("mulDivFloor division by zero");
    return (a * b) / d;
}

function applyOneMinusFee(
    gross: bigint,
    feeBps: bigint,
    lpBps: bigint,
    protBps: bigint,
    creatorBps: bigint
): FeeBreakdown {
    if (gross < 0n) throw new Error("gross < 0");
    if (feeBps < 0n) throw new Error("feeBps < 0");
    if (feeBps > BPS_DENOM) throw new Error(`feeBps > 10000: ${feeBps.toString()}`);

    if (gross === 0n || feeBps === 0n) {
        return {
            gross,
            net: gross,
            totalFee: 0n,
            lpFee: 0n,
            protocolFee: 0n,
            coinCreatorFee: 0n,
            totalFeeBps: feeBps,
        };
    }

    const net = mulDivFloor(gross, BPS_DENOM - feeBps, BPS_DENOM);
    const totalFee = gross - net;

    // Attribute by configured bps using floor; any remainder goes to LP.
    const protocolFee = protBps > 0n ? mulDivFloor(gross, protBps, BPS_DENOM) : 0n;
    const coinCreatorFee = creatorBps > 0n ? mulDivFloor(gross, creatorBps, BPS_DENOM) : 0n;
    const lpFloor = lpBps > 0n ? mulDivFloor(gross, lpBps, BPS_DENOM) : 0n;

    let lpFee = totalFee - protocolFee - coinCreatorFee;
    // Guard against rounding producing negative attribution
    if (lpFee < 0n) lpFee = lpFloor;

    return {
        gross,
        net,
        totalFee,
        lpFee,
        protocolFee,
        coinCreatorFee,
        totalFeeBps: feeBps,
    };
}

/**
 * Vault-delta swap fee bps.
 *
 * IMPORTANT: coinCreatorFee is NOT charged on PumpSwap AMM swaps.
 * On-chain vault delta analysis confirms only LP + Protocol fees are deducted.
 * The coinCreatorFeeBasisPoints field exists in GlobalConfig but is not applied
 * during swap execution — it only applies to bonding curve graduation or other
 * non-swap operations.
 */
export function swapFeeBpsForVaultMath(f: PumpSwapFeesBps): bigint {
    return f.lpFeeBps + f.protocolFeeBps;
}

/**
 * Total configured fee bps (includes creator fee for reporting purposes).
 * Note: This does NOT reflect actual swap fees — use swapFeeBpsForVaultMath for that.
 */
export function totalConfiguredFeeBps(f: PumpSwapFeesBps): bigint {
    return f.lpFeeBps + f.protocolFeeBps + f.coinCreatorFeeBps;
}

/**
 * Apply fees on INPUT (used on BUY quote->base).
 *
 * For BUY, the SDK computes:
 *   fee = ceil(internalQuote * feeBps / 10000)
 *   totalQuote = internalQuote + fee
 *
 * Given totalQuote (vault delta), we solve for internalQuote:
 *   internalQuote = floor(totalQuote * 10000 / (10000 + feeBps))
 *
 * But we need to verify and adjust for ceiling effects.
 *
 * Fee is LP + Protocol (25 bps typically).
 */
export function applyFeesOnInput(grossIn: bigint, f: PumpSwapFeesBps): FeeBreakdown {
    if (grossIn <= 0n) {
        return {
            gross: grossIn,
            net: grossIn,
            totalFee: 0n,
            lpFee: 0n,
            protocolFee: 0n,
            coinCreatorFee: 0n,
            totalFeeBps: 0n,
        };
    }

    const feeBps = swapFeeBpsForVaultMath(f); // LP + Protocol

    // Division formula: net = gross * 10000 / (10000 + fee)
    let net = mulDivFloor(grossIn, BPS_DENOM, BPS_DENOM + feeBps);

    // Verify with ceiling fee calculation and adjust if needed
    // fee = ceil(net * feeBps / 10000)
    const feeCheck = (net * feeBps + BPS_DENOM - 1n) / BPS_DENOM;
    if (net + feeCheck < grossIn) {
        // Adjust net up by 1 to account for ceiling
        net += 1n;
    }

    const totalFee = grossIn - net;

    return {
        gross: grossIn,
        net,
        totalFee,
        lpFee: totalFee, // Simplified attribution
        protocolFee: 0n,
        coinCreatorFee: 0n,
        totalFeeBps: feeBps,
    };
}

/**
 * Apply fees on OUTPUT (used on SELL base->quote).
 *
 * For SELL, both LP and protocol fees are withheld from vault outflow.
 */
export function applyFeesOnOutput(grossOut: bigint, f: PumpSwapFeesBps): FeeBreakdown {
    const feeBps = swapFeeBpsForVaultMath(f); // LP + Protocol
    return applyOneMinusFee(grossOut, feeBps, f.lpFeeBps, f.protocolFeeBps, 0n);
}

export function feesFromGlobalConfig(cfg: PumpSwapGlobalConfig): PumpSwapFeesBps {
    return {
        lpFeeBps: cfg.lpFeeBasisPoints,
        protocolFeeBps: cfg.protocolFeeBasisPoints,
        coinCreatorFeeBps: cfg.coinCreatorFeeBasisPoints,
    };
}

export function feesFromFeeConfigForMarketCap(
    feeConfig: PumpFeesFeeConfig,
    marketCap: bigint
): PumpSwapFeesBps {
    const tierFees = selectTierFeesLowerBound(feeConfig.feeTiers, marketCap);
    if (tierFees) return tierFees;
    return feeConfig.flatFees;
}