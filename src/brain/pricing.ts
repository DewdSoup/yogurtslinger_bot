// src/brain/pricing.ts
// REFACTORED: Removed local CPMM simulation - now using RPC simulation
// This file now contains ONLY spot price calculation functions for the detection layer
// All profit simulation is done via RPC simulateTransaction in executionEngine.ts
//
// IMPORTANT: RaydiumPoolState does NOT contain reserve balances directly.
// Reserves must be fetched from vault token accounts separately.
// Use computeRaydiumPriceSync() with pre-fetched vault balances for hot-path pricing.

import { createRequire } from "node:module";
import type { PumpBondingCurveState } from "../decoders/pump.js";
import type { RaydiumPoolState, RaydiumCLMMPool } from "../decoders/raydium.js";
import type { PumpSwapPoolState } from "../decoders/pumpswap.js";
import { Connection } from "@solana/web3.js";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Decimal = require("decimal.js") as any;

// Pump.fun uses a fixed 6-decimals internal token for the curve math.
const TOKEN_DECIMALS = 6;

// 1e9 lamports per SOL.
const LAMPORTS_PER_SOL = new Decimal("1000000000");
const TEN = new Decimal(10);
const TOKEN_SCALE = TEN.pow(TOKEN_DECIMALS);

const SOL_MINT_STR = "So11111111111111111111111111111111111111112";
const NATIVE_SOL_MINT_STR = "11111111111111111111111111111111";

// ============================================================================
// SPOT PRICE INTERFACES (Used for detection layer)
// ============================================================================

export interface PumpPriceView {
    /**
     * Approx price in SOL per token, as a string.
     * null means "cannot compute" (degenerate reserves or error).
     */
    priceSolPerToken: string | null;
}

export interface CPMMPriceView {
    /**
     * Price in SOL per token, as a string.
     * null means "cannot compute" (degenerate reserves or error).
     */
    priceSolPerToken: string | null;
    /**
     * Base reserve (the token, not SOL)
     */
    baseReserve: string | null;
    /**
     * Quote reserve (SOL)
     */
    quoteReserve: string | null;
}

export interface CLMMPriceView {
    /**
     * Price in SOL per token, as a string.
     * Derived from sqrtPriceX64.
     */
    priceSolPerToken: string | null;
    /**
     * Current tick
     */
    tickCurrent: number | null;
    /**
     * Active liquidity around current tick
     */
    liquidity: string | null;
}

// ============================================================================
// SPOT PRICE FUNCTIONS (Used for quick detection filtering)
// ============================================================================

/**
 * Pump.fun price in SOL per token, matching the frontend formula:
 *
 *   tokenPriceSol =
 *      (virtualSolReserves / LAMPORTS_PER_SOL)
 *      /
 *      (virtualTokenReserves / 10^TOKEN_DECIMALS)
 *
 * See: community findings / Pump frontend source mirrored in public gists.
 */
export function computePumpPrice(
    state: PumpBondingCurveState
): PumpPriceView {
    try {
        const virtualToken = new Decimal(state.virtualTokenReserves.toString());
        const virtualSol = new Decimal(state.virtualSolReserves.toString());

        // Degenerate curve – cannot compute a price.
        if (virtualToken.lte(0) || virtualSol.lte(0)) {
            return { priceSolPerToken: null };
        }

        const solSide = virtualSol.div(LAMPORTS_PER_SOL);
        const tokenSide = virtualToken.div(TOKEN_SCALE);

        const price = solSide.div(tokenSide);
        return { priceSolPerToken: price.toString() };
    } catch {
        return { priceSolPerToken: null };
    }
}

/**
 * Compute SPOT price for a standard x*y=k CPMM pool (Raydium V4 style)
 * using pre-fetched vault balances.
 *
 * Formula (spot price, ignoring fee/slippage for infinitesimal trade):
 *      Price = Quote Reserve / Base Reserve
 *
 * Where Quote is SOL and Base is the Token.
 *
 * NOTE: This is for DETECTION only. Actual profit is computed via RPC simulation.
 *
 * IMPORTANT: RaydiumPoolState does NOT contain reserves directly.
 * Use this sync version with balances from TokenAccountCache.
 *
 * @param state - Raydium pool state (for mint identification)
 * @param baseVaultBalance - Cached balance of base vault (raw units)
 * @param quoteVaultBalance - Cached balance of quote vault (raw units)
 * @returns Price in SOL per token
 */
export function computeRaydiumPriceSync(
    state: RaydiumPoolState,
    baseVaultBalance: bigint,
    quoteVaultBalance: bigint
): CPMMPriceView {
    try {
        const baseMint = state.baseMint.toBase58();
        const quoteMint = state.quoteMint.toBase58();

        // Determine which side is SOL
        const baseIsSol = baseMint === SOL_MINT_STR || baseMint === NATIVE_SOL_MINT_STR;
        const quoteIsSol = quoteMint === SOL_MINT_STR || quoteMint === NATIVE_SOL_MINT_STR;

        if (!baseIsSol && !quoteIsSol) {
            // Not a SOL pair
            return { priceSolPerToken: null, baseReserve: null, quoteReserve: null };
        }

        const baseReserve = new Decimal(baseVaultBalance.toString());
        const quoteReserve = new Decimal(quoteVaultBalance.toString());

        if (baseReserve.lte(0) || quoteReserve.lte(0)) {
            return { priceSolPerToken: null, baseReserve: null, quoteReserve: null };
        }

        let price: any;

        if (quoteIsSol && !baseIsSol) {
            // Standard: Quote is SOL, Base is Token
            // Price = SOL / Token
            price = quoteReserve.div(baseReserve);
            return {
                priceSolPerToken: price.toString(),
                baseReserve: baseReserve.toString(),
                quoteReserve: quoteReserve.toString()
            };
        } else if (baseIsSol && !quoteIsSol) {
            // Inverted: Base is SOL, Quote is Token
            // Price = Base / Quote
            price = baseReserve.div(quoteReserve);
            return {
                // We still want "baseReserve" to mean "token", "quoteReserve" to mean "SOL"
                priceSolPerToken: price.toString(),
                baseReserve: quoteReserve.toString(), // Token is quote in this case
                quoteReserve: baseReserve.toString()  // SOL is base in this case
            };
        }

        return { priceSolPerToken: null, baseReserve: null, quoteReserve: null };
    } catch {
        return { priceSolPerToken: null, baseReserve: null, quoteReserve: null };
    }
}

/**
 * @deprecated Use computeRaydiumPriceSync with pre-fetched vault balances.
 * This function exists for API compatibility but RaydiumPoolState does not
 * contain reserve balances. Returns null.
 */
export function computeRaydiumPrice(
    _state: RaydiumPoolState
): CPMMPriceView {
    // RaydiumPoolState has vault addresses (baseVault, quoteVault) but NOT balances.
    // Balances must be fetched from token accounts separately.
    // Use computeRaydiumPriceSync() with TokenAccountCache balances instead.
    console.warn(
        "[pricing] computeRaydiumPrice called but RaydiumPoolState has no reserves. " +
        "Use computeRaydiumPriceSync() with vault balances."
    );
    return { priceSolPerToken: null, baseReserve: null, quoteReserve: null };
}

/**
 * Compute SPOT price for Raydium CLMM (Concentrated Liquidity) pool.
 *
 * CLMM price is derived from sqrtPriceX64:
 *   price = (sqrtPriceX64 / 2^64)^2
 *
 * This gives price of token1 in terms of token0.
 * For SOL-paired pools, we adjust to get SOL per token.
 *
 * @param state - Raydium CLMM pool state
 * @returns Price view with current price and tick
 */
export function computeRaydiumCLMMPrice(
    state: RaydiumCLMMPool
): CLMMPriceView {
    try {
        const mint0 = state.tokenMint0.toBase58();
        const mint1 = state.tokenMint1.toBase58();

        // Determine which side is SOL
        const mint0IsSol = mint0 === SOL_MINT_STR || mint0 === NATIVE_SOL_MINT_STR;
        const mint1IsSol = mint1 === SOL_MINT_STR || mint1 === NATIVE_SOL_MINT_STR;

        if (!mint0IsSol && !mint1IsSol) {
            // Not a SOL pair
            return { priceSolPerToken: null, tickCurrent: null, liquidity: null };
        }

        // Derive price from sqrtPriceX64
        // price = (sqrtPriceX64 / 2^64)^2
        const sqrtPrice = new Decimal(state.sqrtPriceX64.toString());
        const divisor = new Decimal(2).pow(64);
        const priceRatio = sqrtPrice.div(divisor).pow(2);

        // priceRatio is price of token1 in terms of token0
        // If mint0 is SOL: priceRatio = token1/SOL → we want SOL/token1 = 1/priceRatio
        // If mint1 is SOL: priceRatio = SOL/token0 → we want SOL/token0 = priceRatio

        let priceSolPerToken: any;
        if (mint0IsSol && !mint1IsSol) {
            // mint0=SOL, mint1=Token
            // priceRatio = Token/SOL, so SOL/Token = 1/priceRatio
            if (priceRatio.lte(0)) {
                return { priceSolPerToken: null, tickCurrent: null, liquidity: null };
            }
            priceSolPerToken = new Decimal(1).div(priceRatio);
        } else if (mint1IsSol && !mint0IsSol) {
            // mint0=Token, mint1=SOL
            // priceRatio = SOL/Token → directly what we want
            priceSolPerToken = priceRatio;
        } else {
            return { priceSolPerToken: null, tickCurrent: null, liquidity: null };
        }

        return {
            priceSolPerToken: priceSolPerToken.toString(),
            tickCurrent: state.tickCurrent,
            liquidity: state.liquidity.toString()
        };
    } catch {
        return { priceSolPerToken: null, tickCurrent: null, liquidity: null };
    }
}

/**
 * Compute SPOT price for PumpSwap CPMM pool by fetching vault balances via RPC.
 *
 * PumpSwap uses standard x*y=k AMM with vault ATAs holding reserves.
 * Price = SOL Reserve / Token Reserve
 *
 * NOTE: This is FOR OFFLINE / DIAGNOSTIC USE ONLY.
 *       Hot-path code (ingest / arb) should use computePumpSwapPriceSync
 *       with balances from TokenAccountCache, not RPC.
 *
 * @param state - PumpSwap pool state
 * @param connection - Solana RPC connection to fetch token account balances
 * @returns Price in SOL per token
 */
export async function computePumpSwapPrice(
    state: PumpSwapPoolState,
    connection: Connection
): Promise<CPMMPriceView> {
    try {
        const baseMint = state.baseMint.toBase58();
        const quoteMint = state.quoteMint.toBase58();

        // Determine which side is SOL
        const baseIsSol = baseMint === SOL_MINT_STR || baseMint === NATIVE_SOL_MINT_STR;
        const quoteIsSol = quoteMint === SOL_MINT_STR || quoteMint === NATIVE_SOL_MINT_STR;

        if (!baseIsSol && !quoteIsSol) {
            // Not a SOL pair
            return { priceSolPerToken: null, baseReserve: null, quoteReserve: null };
        }

        // Fetch vault balances
        const baseVaultInfo = await connection.getTokenAccountBalance(
            state.poolBaseTokenAccount
        );
        const quoteVaultInfo = await connection.getTokenAccountBalance(
            state.poolQuoteTokenAccount
        );

        if (!baseVaultInfo.value || !quoteVaultInfo.value) {
            return { priceSolPerToken: null, baseReserve: null, quoteReserve: null };
        }

        const baseReserve = new Decimal(baseVaultInfo.value.amount);
        const quoteReserve = new Decimal(quoteVaultInfo.value.amount);

        if (baseReserve.lte(0) || quoteReserve.lte(0)) {
            return { priceSolPerToken: null, baseReserve: null, quoteReserve: null };
        }

        let price: any;

        if (quoteIsSol && !baseIsSol) {
            // Standard: Quote is SOL, Base is Token
            // Price = SOL / Token
            price = quoteReserve.div(baseReserve);
            return {
                priceSolPerToken: price.toString(),
                baseReserve: baseReserve.toString(),
                quoteReserve: quoteReserve.toString()
            };
        } else if (baseIsSol && !quoteIsSol) {
            // Inverted: Base is SOL, Quote is Token
            // Price = Base / Quote
            price = baseReserve.div(quoteReserve);
            return {
                priceSolPerToken: price.toString(),
                baseReserve: quoteReserve.toString(), // Token is quote in this case
                quoteReserve: baseReserve.toString()  // SOL is base in this case
            };
        }

        return { priceSolPerToken: null, baseReserve: null, quoteReserve: null };
    } catch (error) {
        console.error("[pricing] Failed to compute PumpSwap price (RPC):", error);
        return { priceSolPerToken: null, baseReserve: null, quoteReserve: null };
    }
}

/**
 * Synchronous version of PumpSwap SPOT pricing using cached reserve data.
 * Use this in the hot path when you already have the vault balances from
 * Yellowstone / TokenAccountCache.
 *
 * NOTE: This is for DETECTION only. Actual profit is computed via RPC simulation.
 *
 * @param state - PumpSwap pool state
 * @param baseVaultBalance - Cached balance of base token vault (raw units)
 * @param quoteVaultBalance - Cached balance of quote token vault (raw units)
 */
export function computePumpSwapPriceSync(
    state: PumpSwapPoolState,
    baseVaultBalance: bigint,
    quoteVaultBalance: bigint
): CPMMPriceView {
    try {
        const baseMint = state.baseMint.toBase58();
        const quoteMint = state.quoteMint.toBase58();

        const baseIsSol = baseMint === SOL_MINT_STR || baseMint === NATIVE_SOL_MINT_STR;
        const quoteIsSol = quoteMint === SOL_MINT_STR || quoteMint === NATIVE_SOL_MINT_STR;

        if (!baseIsSol && !quoteIsSol) {
            return { priceSolPerToken: null, baseReserve: null, quoteReserve: null };
        }

        const baseReserve = new Decimal(baseVaultBalance.toString());
        const quoteReserve = new Decimal(quoteVaultBalance.toString());

        if (baseReserve.lte(0) || quoteReserve.lte(0)) {
            return { priceSolPerToken: null, baseReserve: null, quoteReserve: null };
        }

        let price: any;

        if (quoteIsSol && !baseIsSol) {
            // Standard orientation: Quote is SOL, Base is Token
            price = quoteReserve.div(baseReserve);
            return {
                priceSolPerToken: price.toString(),
                baseReserve: baseReserve.toString(),
                quoteReserve: quoteReserve.toString()
            };
        } else if (baseIsSol && !quoteIsSol) {
            // Inverted: Base is SOL, Quote is Token
            price = baseReserve.div(quoteReserve);
            return {
                priceSolPerToken: price.toString(),
                baseReserve: quoteReserve.toString(), // Token is quote in this case
                quoteReserve: baseReserve.toString()  // SOL is base in this case
            };
        }

        return { priceSolPerToken: null, baseReserve: null, quoteReserve: null };
    } catch {
        return { priceSolPerToken: null, baseReserve: null, quoteReserve: null };
    }
}

// ============================================================================
// DELETED FUNCTIONS (Now handled by RPC simulation in executionEngine.ts):
// - computeCpmmSwapExactIn()
// - simulateArbRoundTrip()
// - CpmmSwapQuote interface
// - ArbSimulationResult interface
// ============================================================================