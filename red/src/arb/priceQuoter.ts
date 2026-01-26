// src/arb/priceQuoter.ts
//
// Price quoter using hot path simulators.
// Calculates accurate swap outputs for cross-DEX comparison.

import type { InMemoryAccountStore, PubkeyStr } from "../state/accountStore";
import type {
    HotPathCache,
    CachedPumpSwapPool,
    CachedRaydiumV4Pool,
} from "../state/hotPathCache";
import type { Venue } from "./crossDexIndex";

// Hot path simulators - use direct reserve-based simulation
// The hot path sims in hotPathSim.ts require AccountStore interface
// For priceQuoter, we do direct reserve math for speed

const PUMPSWAP_FEE_DENOM = 10000n;

/**
 * Inline PumpSwap simulation (matches validated pumpswapSim.ts).
 */
function simulatePumpSwapQuick(
    baseReserve: bigint,
    quoteReserve: bigint,
    amountIn: bigint,
    isBaseToQuote: boolean,
    lpFeeBps: number,
    protocolFeeBps: number
): bigint {
    const totalFeeBps = BigInt(lpFeeBps + protocolFeeBps);

    if (isBaseToQuote) {
        // SELL: base in, quote out - fee on output
        const grossOut = (quoteReserve * amountIn) / (baseReserve + amountIn);
        const fee = (grossOut * totalFeeBps) / PUMPSWAP_FEE_DENOM;
        return grossOut - fee;
    } else {
        // BUY: quote in, base out - fee on input (ceiling-adjusted)
        let net = (amountIn * PUMPSWAP_FEE_DENOM) / (PUMPSWAP_FEE_DENOM + totalFeeBps);
        const feeCheck = (net * totalFeeBps + PUMPSWAP_FEE_DENOM - 1n) / PUMPSWAP_FEE_DENOM;
        if (net + feeCheck < amountIn) net = net + 1n;
        return (baseReserve * net) / (quoteReserve + net);
    }
}

/**
 * Inline Raydium V4 simulation (matches validated raydiumV4Sim.ts).
 */
function simulateRaydiumV4Quick(
    baseReserve: bigint,
    quoteReserve: bigint,
    amountIn: bigint,
    isBaseToQuote: boolean,
    swapFeeNumerator: bigint,
    swapFeeDenominator: bigint
): bigint {
    if (amountIn <= 0n || swapFeeDenominator === 0n) return 0n;

    const feeAmount = (amountIn * swapFeeNumerator) / swapFeeDenominator;
    const amountInAfterFee = amountIn - feeAmount;

    if (isBaseToQuote) {
        return (quoteReserve * amountInAfterFee) / (baseReserve + amountInAfterFee);
    } else {
        return (baseReserve * amountInAfterFee) / (quoteReserve + amountInAfterFee);
    }
}

export interface PriceQuote {
    venue: Venue;
    poolAddress: PubkeyStr;
    /** Input amount used for quote */
    inputAmount: bigint;
    /** Output amount from simulation */
    outputAmount: bigint;
    /** Effective price (output/input as number) */
    effectivePrice: number;
    /** Whether this is buy (quote->base) or sell (base->quote) */
    direction: "buy" | "sell";
    /** Slot used for quote */
    slot: number;
}

/**
 * Price quoter using hot path simulators.
 * Uses minimal probe amounts to get accurate price ratios.
 */
export class PriceQuoter {
    constructor(
        private store: InMemoryAccountStore,
        private cache: HotPathCache
    ) {}

    /**
     * Get price quote for a pool.
     * Uses a small probe amount to calculate effective price.
     *
     * @param poolAddress Pool to quote
     * @param probeSol Probe amount in lamports (default 0.1 SOL)
     * @param direction "buy" = SOL->Token, "sell" = Token->SOL
     */
    quote(
        poolAddress: PubkeyStr,
        probeSol: bigint = BigInt(100_000_000), // 0.1 SOL
        direction: "buy" | "sell" = "buy"
    ): PriceQuote | null {
        const pool = this.cache.getPool(poolAddress);
        if (!pool) return null;

        switch (pool.venue) {
            case "pumpswap":
                return this.quotePumpSwap(pool, probeSol, direction);
            case "raydium_v4":
                return this.quoteRaydiumV4(pool, probeSol, direction);
            case "raydium_clmm":
                // CLMM requires tick arrays - return null for now
                // TODO: Implement when tick data is available
                return null;
            case "meteora_dlmm":
                // DLMM requires bin arrays - return null for now
                // TODO: Implement when bin data is available
                return null;
        }
    }

    private quotePumpSwap(
        pool: CachedPumpSwapPool,
        probeSol: bigint,
        direction: "buy" | "sell"
    ): PriceQuote | null {
        // Get vault balances
        const baseVaultAcc = this.store.get(pool.baseVault);
        const quoteVaultAcc = this.store.get(pool.quoteVault);

        if (!baseVaultAcc || !quoteVaultAcc) return null;

        // Read token balances (SPL Token account: amount at offset 64)
        const baseBalance = baseVaultAcc.data.readBigUInt64LE(64);
        const quoteBalance = quoteVaultAcc.data.readBigUInt64LE(64);

        // Simulate swap
        const isBaseToQuote = direction === "sell"; // sell token = base->quote
        let inputAmount: bigint;
        let outputAmount: bigint;

        if (isBaseToQuote) {
            // Selling tokens for SOL - need to estimate token amount
            // Use proportional amount based on pool ratio
            inputAmount = (probeSol * baseBalance) / quoteBalance;
            outputAmount = simulatePumpSwapQuick(
                baseBalance,
                quoteBalance,
                inputAmount,
                true, // baseToQuote
                pool.lpFeeBps,
                pool.protocolFeeBps
            );
        } else {
            // Buying tokens with SOL
            inputAmount = probeSol;
            outputAmount = simulatePumpSwapQuick(
                baseBalance,
                quoteBalance,
                inputAmount,
                false, // quoteToBase
                pool.lpFeeBps,
                pool.protocolFeeBps
            );
        }

        // Calculate effective price (SOL per token)
        let effectivePrice: number;
        if (isBaseToQuote) {
            // Sold inputAmount tokens, got outputAmount SOL
            // Price = SOL / tokens
            effectivePrice = Number(outputAmount) / Number(inputAmount);
        } else {
            // Paid inputAmount SOL, got outputAmount tokens
            // Price = SOL / tokens
            effectivePrice = Number(inputAmount) / Number(outputAmount);
        }

        return {
            venue: "pumpswap",
            poolAddress: pool.poolAddress,
            inputAmount,
            outputAmount,
            effectivePrice,
            direction,
            slot: Math.max(baseVaultAcc.meta.slot, quoteVaultAcc.meta.slot),
        };
    }

    private quoteRaydiumV4(
        pool: CachedRaydiumV4Pool,
        probeSol: bigint,
        direction: "buy" | "sell"
    ): PriceQuote | null {
        // Get vault balances
        const baseVaultAcc = this.store.get(pool.baseVault);
        const quoteVaultAcc = this.store.get(pool.quoteVault);

        if (!baseVaultAcc || !quoteVaultAcc) return null;

        // Read token balances
        const baseBalance = baseVaultAcc.data.readBigUInt64LE(64);
        const quoteBalance = quoteVaultAcc.data.readBigUInt64LE(64);

        // Simulate swap
        const isBaseToQuote = direction === "sell";
        let inputAmount: bigint;
        let outputAmount: bigint;

        if (isBaseToQuote) {
            inputAmount = (probeSol * baseBalance) / quoteBalance;
            outputAmount = simulateRaydiumV4Quick(
                baseBalance,
                quoteBalance,
                inputAmount,
                true,
                pool.swapFeeNumerator,
                pool.swapFeeDenominator
            );
        } else {
            inputAmount = probeSol;
            outputAmount = simulateRaydiumV4Quick(
                baseBalance,
                quoteBalance,
                inputAmount,
                false,
                pool.swapFeeNumerator,
                pool.swapFeeDenominator
            );
        }

        let effectivePrice: number;
        if (isBaseToQuote) {
            effectivePrice = Number(outputAmount) / Number(inputAmount);
        } else {
            effectivePrice = Number(inputAmount) / Number(outputAmount);
        }

        return {
            venue: "raydium_v4",
            poolAddress: pool.poolAddress,
            inputAmount,
            outputAmount,
            effectivePrice,
            direction,
            slot: Math.max(baseVaultAcc.meta.slot, quoteVaultAcc.meta.slot),
        };
    }

    /**
     * Compare prices across two pools for the same mint.
     * Returns potential profit in basis points.
     */
    compareArb(
        poolA: PubkeyStr,
        poolB: PubkeyStr,
        amountSol: bigint = BigInt(100_000_000)
    ): { profitBps: number; buyPool: PubkeyStr; sellPool: PubkeyStr } | null {
        const buyA = this.quote(poolA, amountSol, "buy");
        const buyB = this.quote(poolB, amountSol, "buy");

        if (!buyA || !buyB) return null;

        // Arb: Buy cheap, sell expensive
        // Lower price = cheaper to buy
        // Higher price = more SOL when selling

        let buyPool: PubkeyStr;
        let sellPool: PubkeyStr;
        let buyPrice: number;
        let sellPrice: number;

        if (buyA.effectivePrice < buyB.effectivePrice) {
            // Buy on A (cheaper), sell on B
            buyPool = poolA;
            sellPool = poolB;
            buyPrice = buyA.effectivePrice;
            sellPrice = buyB.effectivePrice;
        } else {
            // Buy on B (cheaper), sell on A
            buyPool = poolB;
            sellPool = poolA;
            buyPrice = buyB.effectivePrice;
            sellPrice = buyA.effectivePrice;
        }

        // Profit = (sell - buy) / buy as bps
        const profitBps = ((sellPrice - buyPrice) / buyPrice) * 10000;

        return { profitBps, buyPool, sellPool };
    }
}
