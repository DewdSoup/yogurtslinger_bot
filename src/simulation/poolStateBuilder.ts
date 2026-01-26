// src/simulation/poolStateBuilder.ts
// ═══════════════════════════════════════════════════════════════════════════════
// POOL STATE BUILDER - Convert MarketCache entries to unified PoolState
// ═══════════════════════════════════════════════════════════════════════════════
//
// This bridges MarketCache → PoolState for local simulation.
// Pulls reserves from TokenAccountCache to get real-time balances.
//
// ═══════════════════════════════════════════════════════════════════════════════

import type { PoolState } from "../execution/profitSimulator.js";
import type {
    PumpSwapPoolEntry,
    RaydiumPoolEntry,
    RaydiumCLMMPoolEntry,
    MeteoraPoolEntry,
    MarketCache
} from "../brain/marketCache.js";
import type { TokenAccountCache } from "../brain/tokenAccountCache.js";
import { PUMPSWAP_FEE } from "../decoders/pumpswap.js";

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const SOL_MINT = "So11111111111111111111111111111111111111112";

// Default fee rates when not available from state
const DEFAULT_FEES = {
    PUMPSWAP: PUMPSWAP_FEE,       // 0.003 (0.30%)
    RAYDIUM_V4: 0.0025,           // 0.25%
    RAYDIUM_CLMM: 0.0025,         // 0.25% (varies by AmmConfig)
    METEORA: 0.003,               // 0.30% (dynamic, this is base)
};

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN BUILDER FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

export interface BuildPoolStateOptions {
    cache: MarketCache;
    tokenAccountCache: TokenAccountCache;
}

/**
 * Build PoolState from a venue and pool pubkey
 * Returns null if pool not found or reserves unavailable
 */
export function buildPoolStateByPubkey(
    pubkey: string,
    venue: "PumpSwap" | "Raydium" | "RaydiumCLMM" | "Meteora",
    options: BuildPoolStateOptions
): PoolState | null {
    const { cache, tokenAccountCache } = options;

    switch (venue) {
        case "PumpSwap": {
            const entry = cache.getPumpSwapPool(pubkey);
            if (!entry) return null;
            return buildPumpSwapPoolState(entry, tokenAccountCache);
        }

        case "Raydium": {
            const entry = cache.getRaydiumPool(pubkey);
            if (!entry) return null;
            return buildRaydiumV4PoolState(entry, tokenAccountCache);
        }

        case "RaydiumCLMM": {
            const entry = cache.getRaydiumCLMMPool(pubkey);
            if (!entry) return null;
            return buildRaydiumCLMMPoolState(entry, tokenAccountCache);
        }

        case "Meteora": {
            const entry = cache.getMeteoraPool(pubkey);
            if (!entry) return null;
            return buildMeteoraPoolState(entry, tokenAccountCache);
        }

        default:
            return null;
    }
}

/**
 * Build PoolState for a token from fragmented venues
 * Returns buy and sell pools for arbitrage
 */
export function buildPoolStatesForToken(
    tokenMint: string,
    buyVenue: "PumpSwap" | "Raydium" | "RaydiumCLMM" | "Meteora",
    sellVenue: "PumpSwap" | "Raydium" | "RaydiumCLMM" | "Meteora",
    options: BuildPoolStateOptions
): { buyPool: PoolState | null; sellPool: PoolState | null } {
    const { cache, tokenAccountCache } = options;
    const fragmented = cache.getFragmentedTokens();
    const venues = fragmented.get(tokenMint);

    if (!venues) {
        return { buyPool: null, sellPool: null };
    }

    let buyPool: PoolState | null = null;
    let sellPool: PoolState | null = null;

    // Build buy pool
    switch (buyVenue) {
        case "PumpSwap":
            if (venues.pumpSwap) {
                buyPool = buildPumpSwapPoolState(venues.pumpSwap, tokenAccountCache);
            }
            break;
        case "Raydium":
            if (venues.raydiumV4) {
                buyPool = buildRaydiumV4PoolState(venues.raydiumV4, tokenAccountCache);
            }
            break;
        case "RaydiumCLMM":
            if (venues.raydiumClmm) {
                buyPool = buildRaydiumCLMMPoolState(venues.raydiumClmm, tokenAccountCache);
            }
            break;
        case "Meteora":
            if (venues.meteora) {
                buyPool = buildMeteoraPoolState(venues.meteora, tokenAccountCache);
            }
            break;
    }

    // Build sell pool
    switch (sellVenue) {
        case "PumpSwap":
            if (venues.pumpSwap) {
                sellPool = buildPumpSwapPoolState(venues.pumpSwap, tokenAccountCache);
            }
            break;
        case "Raydium":
            if (venues.raydiumV4) {
                sellPool = buildRaydiumV4PoolState(venues.raydiumV4, tokenAccountCache);
            }
            break;
        case "RaydiumCLMM":
            if (venues.raydiumClmm) {
                sellPool = buildRaydiumCLMMPoolState(venues.raydiumClmm, tokenAccountCache);
            }
            break;
        case "Meteora":
            if (venues.meteora) {
                sellPool = buildMeteoraPoolState(venues.meteora, tokenAccountCache);
            }
            break;
    }

    return { buyPool, sellPool };
}

// ═══════════════════════════════════════════════════════════════════════════════
// VENUE-SPECIFIC BUILDERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build PoolState from PumpSwap pool entry
 */
export function buildPumpSwapPoolState(
    entry: PumpSwapPoolEntry,
    tokenAccountCache: TokenAccountCache
): PoolState | null {
    const baseMint = entry.state.baseMint.toBase58();
    const quoteMint = entry.state.quoteMint.toBase58();
    const baseVault = entry.state.poolBaseTokenAccount.toBase58();
    const quoteVault = entry.state.poolQuoteTokenAccount.toBase58();

    // Get vault balances from cache
    const baseBalance = tokenAccountCache.getBalance(baseVault);
    const quoteBalance = tokenAccountCache.getBalance(quoteVault);

    if (baseBalance === undefined || quoteBalance === undefined) {
        return null;  // Reserves not available
    }

    // Determine which side is SOL
    const quoteMintIsSol = quoteMint === SOL_MINT;
    const baseMintIsSol = baseMint === SOL_MINT;

    // Normalize to: base = token, quote = SOL
    let tokenMint: string;
    let baseReserve: bigint;
    let quoteReserve: bigint;
    let normalizedBaseMint: string;
    let normalizedQuoteMint: string;

    if (quoteMintIsSol) {
        // Standard orientation: base=token, quote=SOL
        tokenMint = baseMint;
        baseReserve = baseBalance;
        quoteReserve = quoteBalance;
        normalizedBaseMint = baseMint;
        normalizedQuoteMint = quoteMint;
    } else if (baseMintIsSol) {
        // Inverted: base=SOL, quote=token → swap
        tokenMint = quoteMint;
        baseReserve = quoteBalance;  // Token balance
        quoteReserve = baseBalance;  // SOL balance
        normalizedBaseMint = quoteMint;
        normalizedQuoteMint = baseMint;
    } else {
        return null;  // Not a SOL pair
    }

    return {
        pubkey: entry.pubkey,
        venue: "PumpSwap",
        tokenMint,
        baseReserve,
        quoteReserve,
        baseMint: normalizedBaseMint,
        quoteMint: normalizedQuoteMint,
        feeRate: DEFAULT_FEES.PUMPSWAP,
        lastSlot: entry.slot,
        lastUpdatedTs: entry.lastUpdatedTs,
        createdTs: entry.createdTs,
    };
}

/**
 * Build PoolState from Raydium V4 pool entry
 */
export function buildRaydiumV4PoolState(
    entry: RaydiumPoolEntry,
    tokenAccountCache: TokenAccountCache
): PoolState | null {
    const baseMint = entry.state.baseMint.toBase58();
    const quoteMint = entry.state.quoteMint.toBase58();
    const baseVault = entry.state.baseVault?.toBase58();
    const quoteVault = entry.state.quoteVault?.toBase58();

    if (!baseVault || !quoteVault) {
        return null;
    }

    // Get vault balances from cache
    const baseBalance = tokenAccountCache.getBalance(baseVault);
    const quoteBalance = tokenAccountCache.getBalance(quoteVault);

    if (baseBalance === undefined || quoteBalance === undefined) {
        return null;
    }

    // Determine which side is SOL
    const quoteMintIsSol = quoteMint === SOL_MINT;
    const baseMintIsSol = baseMint === SOL_MINT;

    let tokenMint: string;
    let baseReserve: bigint;
    let quoteReserve: bigint;
    let normalizedBaseMint: string;
    let normalizedQuoteMint: string;

    if (quoteMintIsSol) {
        tokenMint = baseMint;
        baseReserve = baseBalance;
        quoteReserve = quoteBalance;
        normalizedBaseMint = baseMint;
        normalizedQuoteMint = quoteMint;
    } else if (baseMintIsSol) {
        tokenMint = quoteMint;
        baseReserve = quoteBalance;
        quoteReserve = baseBalance;
        normalizedBaseMint = quoteMint;
        normalizedQuoteMint = baseMint;
    } else {
        return null;
    }

    // Get fee from pool state if available
    let feeRate = DEFAULT_FEES.RAYDIUM_V4;
    if (entry.state.swapFeeNumerator !== undefined && entry.state.swapFeeDenominator !== undefined) {
        if (entry.state.swapFeeDenominator > 0n) {
            feeRate = Number(entry.state.swapFeeNumerator) / Number(entry.state.swapFeeDenominator);
        }
    }

    return {
        pubkey: entry.pubkey,
        venue: "Raydium",
        tokenMint,
        baseReserve,
        quoteReserve,
        baseMint: normalizedBaseMint,
        quoteMint: normalizedQuoteMint,
        feeRate,
        lastSlot: entry.slot,
        lastUpdatedTs: entry.lastUpdatedTs,
        createdTs: entry.createdTs,
    };
}

/**
 * Build PoolState from Raydium CLMM pool entry
 */
export function buildRaydiumCLMMPoolState(
    entry: RaydiumCLMMPoolEntry,
    tokenAccountCache: TokenAccountCache
): PoolState | null {
    const mint0 = entry.state.tokenMint0.toBase58();
    const mint1 = entry.state.tokenMint1.toBase58();
    const vault0 = entry.state.tokenVault0.toBase58();
    const vault1 = entry.state.tokenVault1.toBase58();

    // Get vault balances
    const balance0 = tokenAccountCache.getBalance(vault0);
    const balance1 = tokenAccountCache.getBalance(vault1);

    if (balance0 === undefined || balance1 === undefined) {
        return null;
    }

    // Determine which side is SOL
    const mint0IsSol = mint0 === SOL_MINT;
    const mint1IsSol = mint1 === SOL_MINT;

    let tokenMint: string;
    let baseReserve: bigint;
    let quoteReserve: bigint;
    let normalizedBaseMint: string;
    let normalizedQuoteMint: string;

    if (mint1IsSol) {
        // mint0=token, mint1=SOL (most common)
        tokenMint = mint0;
        baseReserve = balance0;
        quoteReserve = balance1;
        normalizedBaseMint = mint0;
        normalizedQuoteMint = mint1;
    } else if (mint0IsSol) {
        // mint0=SOL, mint1=token
        tokenMint = mint1;
        baseReserve = balance1;
        quoteReserve = balance0;
        normalizedBaseMint = mint1;
        normalizedQuoteMint = mint0;
    } else {
        return null;
    }

    // Build CLMM-specific data
    const clmmData = {
        sqrtPriceX64: entry.state.sqrtPriceX64,
        liquidity: entry.state.liquidity,
        tickCurrent: entry.state.tickCurrent,
        tickSpacing: entry.state.tickSpacing,
        tokenVault0: entry.state.tokenVault0,
        tokenVault1: entry.state.tokenVault1,
        tokenMint0: entry.state.tokenMint0,
        tokenMint1: entry.state.tokenMint1,
        ammConfig: entry.state.ammConfig,
        observationKey: entry.state.observationKey,
    };

    // TODO: Get actual fee from AmmConfig
    // For now, use default
    const feeRate = DEFAULT_FEES.RAYDIUM_CLMM;

    return {
        pubkey: entry.pubkey,
        venue: "RaydiumCLMM",
        tokenMint,
        baseReserve,
        quoteReserve,
        baseMint: normalizedBaseMint,
        quoteMint: normalizedQuoteMint,
        feeRate,
        binStep: entry.state.tickSpacing,  // tickSpacing analogous to binStep
        activeId: entry.state.tickCurrent,
        lastSlot: entry.slot,
        lastUpdatedTs: entry.lastUpdatedTs,
        createdTs: entry.createdTs,
        clmmData,
    };
}

/**
 * Build PoolState from Meteora DLMM pool entry
 */
export function buildMeteoraPoolState(
    entry: MeteoraPoolEntry,
    tokenAccountCache: TokenAccountCache
): PoolState | null {
    const tokenXMint = entry.state.tokenXMint.toBase58();
    const tokenYMint = entry.state.tokenYMint.toBase58();
    const reserveX = entry.state.reserveX.toBase58();
    const reserveY = entry.state.reserveY.toBase58();

    // Get reserve balances
    const xBalance = tokenAccountCache.getBalance(reserveX);
    const yBalance = tokenAccountCache.getBalance(reserveY);

    if (xBalance === undefined || yBalance === undefined) {
        return null;
    }

    // Determine which side is SOL
    const xIsSol = tokenXMint === SOL_MINT;
    const yIsSol = tokenYMint === SOL_MINT;

    let tokenMint: string;
    let baseReserve: bigint;
    let quoteReserve: bigint;
    let normalizedBaseMint: string;
    let normalizedQuoteMint: string;

    if (yIsSol) {
        // X=token, Y=SOL (most common in Meteora)
        tokenMint = tokenXMint;
        baseReserve = xBalance;
        quoteReserve = yBalance;
        normalizedBaseMint = tokenXMint;
        normalizedQuoteMint = tokenYMint;
    } else if (xIsSol) {
        // X=SOL, Y=token
        tokenMint = tokenYMint;
        baseReserve = yBalance;
        quoteReserve = xBalance;
        normalizedBaseMint = tokenYMint;
        normalizedQuoteMint = tokenXMint;
    } else {
        return null;
    }

    // Get fee from pool state
    const feeRate = entry.state.totalFeeRate ?? DEFAULT_FEES.METEORA;

    // Build Meteora-specific data
    const meteoraData = {
        baseFactor: entry.state.baseFactor,
        variableFeeControl: entry.state.variableFeeControl,
        volatilityAccumulator: entry.state.volatilityAccumulator,
        protocolShare: entry.state.protocolShare,
        filterPeriod: entry.state.filterPeriod,
        decayPeriod: entry.state.decayPeriod,
        reductionFactor: entry.state.reductionFactor,
    };

    return {
        pubkey: entry.pubkey,
        venue: "Meteora",
        tokenMint,
        baseReserve,
        quoteReserve,
        baseMint: normalizedBaseMint,
        quoteMint: normalizedQuoteMint,
        feeRate,
        binStep: entry.state.binStep,
        activeId: entry.state.activeId,
        lastSlot: entry.slot,
        lastUpdatedTs: entry.lastUpdatedTs,
        createdTs: entry.createdTs,
        meteoraData,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BULK OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build all pool states for all fragmented tokens
 * Useful for scanning all opportunities
 */
export function buildAllFragmentedPoolStates(
    options: BuildPoolStateOptions
): Map<string, {
    pumpSwap?: PoolState;
    raydiumV4?: PoolState;
    raydiumClmm?: PoolState;
    meteora?: PoolState;
}> {
    const { cache, tokenAccountCache } = options;
    const fragmented = cache.getFragmentedTokens();
    const result = new Map<string, {
        pumpSwap?: PoolState;
        raydiumV4?: PoolState;
        raydiumClmm?: PoolState;
        meteora?: PoolState;
    }>();

    for (const [tokenMint, venues] of fragmented) {
        const poolStates: {
            pumpSwap?: PoolState;
            raydiumV4?: PoolState;
            raydiumClmm?: PoolState;
            meteora?: PoolState;
        } = {};

        if (venues.pumpSwap) {
            const ps = buildPumpSwapPoolState(venues.pumpSwap, tokenAccountCache);
            if (ps) poolStates.pumpSwap = ps;
        }

        if (venues.raydiumV4) {
            const ps = buildRaydiumV4PoolState(venues.raydiumV4, tokenAccountCache);
            if (ps) poolStates.raydiumV4 = ps;
        }

        if (venues.raydiumClmm) {
            const ps = buildRaydiumCLMMPoolState(venues.raydiumClmm, tokenAccountCache);
            if (ps) poolStates.raydiumClmm = ps;
        }

        if (venues.meteora) {
            const ps = buildMeteoraPoolState(venues.meteora, tokenAccountCache);
            if (ps) poolStates.meteora = ps;
        }

        // Only include if at least 2 venues have pool states
        const venueCount = Object.keys(poolStates).length;
        if (venueCount >= 2) {
            result.set(tokenMint, poolStates);
        }
    }

    return result;
}

/**
 * Get best buy/sell pair for a token across all venues
 * Returns the pair with the highest spread
 */
export function findBestArbPair(
    tokenMint: string,
    options: BuildPoolStateOptions
): { buyPool: PoolState; sellPool: PoolState; spreadBps: number } | null {
    const { cache, tokenAccountCache } = options;
    const fragmented = cache.getFragmentedTokens();
    const venues = fragmented.get(tokenMint);

    if (!venues) return null;

    // Build all available pool states
    const poolStates: PoolState[] = [];

    if (venues.pumpSwap) {
        const ps = buildPumpSwapPoolState(venues.pumpSwap, tokenAccountCache);
        if (ps) poolStates.push(ps);
    }
    if (venues.raydiumV4) {
        const ps = buildRaydiumV4PoolState(venues.raydiumV4, tokenAccountCache);
        if (ps) poolStates.push(ps);
    }
    if (venues.raydiumClmm) {
        const ps = buildRaydiumCLMMPoolState(venues.raydiumClmm, tokenAccountCache);
        if (ps) poolStates.push(ps);
    }
    if (venues.meteora) {
        const ps = buildMeteoraPoolState(venues.meteora, tokenAccountCache);
        if (ps) poolStates.push(ps);
    }

    if (poolStates.length < 2) return null;

    // Calculate spot price for each pool
    const pricesWithPools = poolStates.map(pool => ({
        pool,
        price: Number(pool.quoteReserve) / Number(pool.baseReserve)
    })).filter(p => p.price > 0 && isFinite(p.price));

    if (pricesWithPools.length < 2) return null;

    // Sort by price
    pricesWithPools.sort((a, b) => a.price - b.price);

    const lowest = pricesWithPools[0]!;
    const highest = pricesWithPools[pricesWithPools.length - 1]!;

    // Calculate spread (gross, before fees)
    const spreadBps = Math.round((highest.price - lowest.price) / lowest.price * 10000);

    if (spreadBps <= 0) return null;

    return {
        buyPool: lowest.pool,
        sellPool: highest.pool,
        spreadBps
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    buildPoolStateByPubkey,
    buildPoolStatesForToken,
    buildPumpSwapPoolState,
    buildRaydiumV4PoolState,
    buildRaydiumCLMMPoolState,
    buildMeteoraPoolState,
    buildAllFragmentedPoolStates,
    findBestArbPair,
};