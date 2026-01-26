// src/detection/crossVenueArbDetector.ts
//
// Cross-venue arbitrage detector.
//
// Detects profitable arbitrage opportunities when the same token pair
// has different prices on different venues.
//
// Flow:
// 1. ShredStream detects pending swap on venue A
// 2. Simulate the swap to predict post-state price on venue A
// 3. Check if predicted price creates arb vs venue B
// 4. If profitable after fees+gas+tip: emit opportunity
//
// Key insight: We use VALIDATED simulators for all venues, so our
// profit predictions are accurate to on-chain execution.

import type { PubkeyStr, AccountStore } from "../state/accountStore";
import {
    UnifiedPoolRegistry,
    type PoolInfo,
    type VenueType,
    priceFromReserves,
    priceFromSqrtPriceX64,
    priceFromDlmmActiveId,
} from "../state/unifiedPoolRegistry";
import {
    simulatePumpSwapQuick,
    simulateRaydiumV4Quick,
    simulateClmmQuick,
    simulateDlmmQuick,
    type CachedPumpSwapPool,
    type CachedRaydiumV4Pool,
    type CachedClmmPool,
    type CachedDlmmPool,
    type CachedClmmTickList,
    type CachedDlmmBinMap,
} from "../sim/hotPathSim";
import {
    readTokenAmount,
    readClmmSqrtPriceX64,
    readDlmmActiveId,
    readDlmmBinStep,
} from "../state/hotPathCache";

// ============================================================================
// Types
// ============================================================================

export interface ArbOpportunity {
    id: string;
    type: "cross_venue_arb";

    // Path: buy on cheap venue, sell on expensive venue
    buyVenue: VenueType;
    buyPool: PubkeyStr;
    sellVenue: VenueType;
    sellPool: PubkeyStr;

    // Token pair
    baseMint: PubkeyStr;
    quoteMint: PubkeyStr;

    // Amounts
    inputAmount: bigint;        // Quote tokens to spend buying base
    expectedBaseOut: bigint;    // Base tokens received from buy
    expectedQuoteOut: bigint;   // Quote tokens received from sell
    expectedProfit: bigint;     // quoteOut - inputAmount - gasBudget - tipBudget
    profitBps: number;          // Profit in basis points

    // Price info
    buyPriceQ64: bigint;
    sellPriceQ64: bigint;
    spreadBps: number;

    // Metadata
    confidence: number;
    detectedAt: number;
    expirySlot: number;
}

export interface ArbDetectorConfig {
    minProfitLamports: bigint;
    minProfitBps: number;
    gasBudgetLamports: bigint;
    tipBudgetLamports: bigint;
    maxInputLamports: bigint;
    minSpreadBps: number;
}

export const DEFAULT_ARB_DETECTOR_CONFIG: ArbDetectorConfig = {
    minProfitLamports: BigInt(10_000_000),  // 0.01 SOL minimum profit
    minProfitBps: 10,                        // 0.1% minimum
    gasBudgetLamports: BigInt(5_000),        // ~0.000005 SOL compute
    tipBudgetLamports: BigInt(1_000_000),    // 0.001 SOL Jito tip
    maxInputLamports: BigInt(5_000_000_000), // 5 SOL max position
    minSpreadBps: 20,                        // 0.2% minimum spread
};

// ============================================================================
// Arb Detector
// ============================================================================

export class CrossVenueArbDetector {
    private readonly config: ArbDetectorConfig;
    private readonly poolRegistry: UnifiedPoolRegistry;
    private readonly store: AccountStore;

    // Cached tick/bin data for CLMM/DLMM
    private readonly clmmTickLists = new Map<PubkeyStr, CachedClmmTickList>();
    private readonly dlmmBinMaps = new Map<PubkeyStr, CachedDlmmBinMap>();
    private readonly clmmFeeRates = new Map<PubkeyStr, number>();

    // Stats
    private stats = {
        checksRun: 0,
        opportunitiesFound: 0,
        lastOpportunityAt: 0,
    };

    constructor(
        config: ArbDetectorConfig,
        poolRegistry: UnifiedPoolRegistry,
        store: AccountStore
    ) {
        this.config = config;
        this.poolRegistry = poolRegistry;
        this.store = store;
    }

    /**
     * Update tick list cache for CLMM pool.
     */
    setClmmTickList(poolAddress: PubkeyStr, tickList: CachedClmmTickList): void {
        this.clmmTickLists.set(poolAddress, tickList);
    }

    /**
     * Update bin map cache for DLMM pool.
     */
    setDlmmBinMap(poolAddress: PubkeyStr, binMap: CachedDlmmBinMap): void {
        this.dlmmBinMaps.set(poolAddress, binMap);
    }

    /**
     * Set fee rate for CLMM pool (from AmmConfig).
     */
    setClmmFeeRate(poolAddress: PubkeyStr, feeRate: number): void {
        this.clmmFeeRates.set(poolAddress, feeRate);
    }

    /**
     * Check for cross-venue arb opportunities for a token pair.
     *
     * @param baseMint - Base token mint
     * @param quoteMint - Quote token mint (typically WSOL)
     * @param inputAmount - Amount of quote to use for the arb
     */
    detectOpportunity(
        baseMint: PubkeyStr,
        quoteMint: PubkeyStr,
        inputAmount: bigint
    ): ArbOpportunity | null {
        this.stats.checksRun++;

        const pools = this.poolRegistry.getPoolsForPair(baseMint, quoteMint);
        if (pools.length < 2) return null;

        // Get current prices for all pools
        const poolsWithPrices: { pool: PoolInfo; price: bigint }[] = [];

        for (const pool of pools) {
            const price = this.getCurrentPrice(pool);
            if (price && price > BigInt(0)) {
                poolsWithPrices.push({ pool, price });
            }
        }

        if (poolsWithPrices.length < 2) return null;

        // Sort by price to find cheapest and most expensive
        poolsWithPrices.sort((a, b) => {
            if (a.price < b.price) return -1;
            if (a.price > b.price) return 1;
            return 0;
        });

        const cheapest = poolsWithPrices[0]!;
        const mostExpensive = poolsWithPrices[poolsWithPrices.length - 1]!;

        // Skip if same venue (not cross-venue arb)
        if (cheapest.pool.venue === mostExpensive.pool.venue) return null;

        // Calculate spread
        const spreadBps = Number(
            ((mostExpensive.price - cheapest.price) * BigInt(10000)) / cheapest.price
        );

        if (spreadBps < this.config.minSpreadBps) return null;

        // Simulate the arb: buy on cheap, sell on expensive
        const buyResult = this.simulateBuy(cheapest.pool, inputAmount);
        if (!buyResult) return null;

        const sellResult = this.simulateSell(mostExpensive.pool, buyResult.baseOut);
        if (!sellResult) return null;

        // Calculate profit
        const grossProfit = sellResult.quoteOut - inputAmount;
        const netProfit = grossProfit - this.config.gasBudgetLamports - this.config.tipBudgetLamports;

        if (netProfit < this.config.minProfitLamports) return null;

        const profitBps = Number((netProfit * BigInt(10000)) / inputAmount);
        if (profitBps < this.config.minProfitBps) return null;

        this.stats.opportunitiesFound++;
        this.stats.lastOpportunityAt = Date.now();

        const opportunity: ArbOpportunity = {
            id: `arb-${cheapest.pool.poolAddress.slice(0, 8)}-${mostExpensive.pool.poolAddress.slice(0, 8)}-${Date.now()}`,
            type: "cross_venue_arb",

            buyVenue: cheapest.pool.venue,
            buyPool: cheapest.pool.poolAddress,
            sellVenue: mostExpensive.pool.venue,
            sellPool: mostExpensive.pool.poolAddress,

            baseMint,
            quoteMint,

            inputAmount,
            expectedBaseOut: buyResult.baseOut,
            expectedQuoteOut: sellResult.quoteOut,
            expectedProfit: netProfit,
            profitBps,

            buyPriceQ64: cheapest.price,
            sellPriceQ64: mostExpensive.price,
            spreadBps,

            confidence: 0.95, // High confidence from validated sims
            detectedAt: Date.now(),
            expirySlot: 0, // Set by caller based on current slot
        };

        return opportunity;
    }

    /**
     * Scan all cross-venue pairs for opportunities.
     */
    scanAllPairs(inputAmount: bigint): ArbOpportunity[] {
        const opportunities: ArbOpportunity[] = [];
        const crossVenuePairs = this.poolRegistry.getCrossVenuePairs();

        for (const pair of crossVenuePairs) {
            const opp = this.detectOpportunity(pair.baseMint, pair.quoteMint, inputAmount);
            if (opp) opportunities.push(opp);
        }

        return opportunities;
    }

    /**
     * Get current stats.
     */
    getStats(): typeof this.stats {
        return { ...this.stats };
    }

    // ========================================================================
    // Internal: Price Calculation
    // ========================================================================

    private getCurrentPrice(pool: PoolInfo): bigint | null {
        switch (pool.venue) {
            case "pumpswap":
            case "raydium_v4":
                return this.getAmmPrice(pool);
            case "raydium_clmm":
                return this.getClmmPrice(pool);
            case "meteora_dlmm":
                return this.getDlmmPrice(pool);
            default:
                return null;
        }
    }

    private getAmmPrice(pool: PoolInfo): bigint | null {
        // For AMMs, we need the vault addresses from venueData
        const venueData = pool.venueData as {
            baseVault: PubkeyStr;
            quoteVault: PubkeyStr;
        } | undefined;

        if (!venueData) return null;

        const baseData = (this.store as any).getData?.(venueData.baseVault);
        const quoteData = (this.store as any).getData?.(venueData.quoteVault);

        if (!baseData || !quoteData) return null;

        const baseReserve = readTokenAmount(baseData);
        const quoteReserve = readTokenAmount(quoteData);

        if (baseReserve === undefined || quoteReserve === undefined) return null;

        return priceFromReserves(baseReserve, quoteReserve);
    }

    private getClmmPrice(pool: PoolInfo): bigint | null {
        const poolData = (this.store as any).getData?.(pool.poolAddress);
        if (!poolData) return null;

        const sqrtPriceX64 = readClmmSqrtPriceX64(poolData);
        if (!sqrtPriceX64) return null;

        return priceFromSqrtPriceX64(sqrtPriceX64);
    }

    private getDlmmPrice(pool: PoolInfo): bigint | null {
        const poolData = (this.store as any).getData?.(pool.poolAddress);
        if (!poolData) return null;

        const activeId = readDlmmActiveId(poolData);
        const binStep = readDlmmBinStep(poolData);

        if (activeId === undefined || binStep === undefined) return null;

        return priceFromDlmmActiveId(activeId, binStep);
    }

    // ========================================================================
    // Internal: Simulation
    // ========================================================================

    private simulateBuy(
        pool: PoolInfo,
        quoteIn: bigint
    ): { baseOut: bigint } | null {
        switch (pool.venue) {
            case "pumpswap":
                return this.simulatePumpswapBuy(pool, quoteIn);
            case "raydium_v4":
                return this.simulateRaydiumV4Buy(pool, quoteIn);
            case "raydium_clmm":
                return this.simulateClmmBuy(pool, quoteIn);
            case "meteora_dlmm":
                return this.simulateDlmmBuy(pool, quoteIn);
            default:
                return null;
        }
    }

    private simulateSell(
        pool: PoolInfo,
        baseIn: bigint
    ): { quoteOut: bigint } | null {
        switch (pool.venue) {
            case "pumpswap":
                return this.simulatePumpswapSell(pool, baseIn);
            case "raydium_v4":
                return this.simulateRaydiumV4Sell(pool, baseIn);
            case "raydium_clmm":
                return this.simulateClmmSell(pool, baseIn);
            case "meteora_dlmm":
                return this.simulateDlmmSell(pool, baseIn);
            default:
                return null;
        }
    }

    // PumpSwap
    private simulatePumpswapBuy(pool: PoolInfo, quoteIn: bigint): { baseOut: bigint } | null {
        const venueData = pool.venueData as CachedPumpSwapPool | undefined;
        if (!venueData) return null;

        const result = simulatePumpSwapQuick(this.store, venueData, quoteIn, false);
        if (!result) return null;

        return { baseOut: result.amountOut };
    }

    private simulatePumpswapSell(pool: PoolInfo, baseIn: bigint): { quoteOut: bigint } | null {
        const venueData = pool.venueData as CachedPumpSwapPool | undefined;
        if (!venueData) return null;

        const result = simulatePumpSwapQuick(this.store, venueData, baseIn, true);
        if (!result) return null;

        return { quoteOut: result.amountOut };
    }

    // Raydium V4
    private simulateRaydiumV4Buy(pool: PoolInfo, quoteIn: bigint): { baseOut: bigint } | null {
        const venueData = pool.venueData as CachedRaydiumV4Pool | undefined;
        if (!venueData) return null;

        const result = simulateRaydiumV4Quick(this.store, venueData, quoteIn, false);
        if (!result) return null;

        return { baseOut: result.amountOut };
    }

    private simulateRaydiumV4Sell(pool: PoolInfo, baseIn: bigint): { quoteOut: bigint } | null {
        const venueData = pool.venueData as CachedRaydiumV4Pool | undefined;
        if (!venueData) return null;

        const result = simulateRaydiumV4Quick(this.store, venueData, baseIn, true);
        if (!result) return null;

        return { quoteOut: result.amountOut };
    }

    // CLMM
    private simulateClmmBuy(pool: PoolInfo, quoteIn: bigint): { baseOut: bigint } | null {
        const venueData = pool.venueData as CachedClmmPool | undefined;
        if (!venueData) return null;

        const tickList = this.clmmTickLists.get(pool.poolAddress);
        if (!tickList) return null;

        const feeRate = this.clmmFeeRates.get(pool.poolAddress);
        if (feeRate === undefined) return null;
        const result = simulateClmmQuick(this.store, venueData, tickList, quoteIn, false, feeRate);
        if (!result) return null;

        return { baseOut: result.amountOut };
    }

    private simulateClmmSell(pool: PoolInfo, baseIn: bigint): { quoteOut: bigint } | null {
        const venueData = pool.venueData as CachedClmmPool | undefined;
        if (!venueData) return null;

        const tickList = this.clmmTickLists.get(pool.poolAddress);
        if (!tickList) return null;

        const feeRate = this.clmmFeeRates.get(pool.poolAddress);
        if (feeRate === undefined) return null;
        const result = simulateClmmQuick(this.store, venueData, tickList, baseIn, true, feeRate);
        if (!result) return null;

        return { quoteOut: result.amountOut };
    }

    // DLMM
    private simulateDlmmBuy(pool: PoolInfo, quoteIn: bigint): { baseOut: bigint } | null {
        const venueData = pool.venueData as CachedDlmmPool | undefined;
        if (!venueData) return null;

        const binMap = this.dlmmBinMaps.get(pool.poolAddress);
        if (!binMap) return null;

        // yToX = Y (quote) in, X (base) out
        const result = simulateDlmmQuick(this.store, venueData, binMap, quoteIn, "yToX");
        if (!result) return null;

        return { baseOut: result.amountOut };
    }

    private simulateDlmmSell(pool: PoolInfo, baseIn: bigint): { quoteOut: bigint } | null {
        const venueData = pool.venueData as CachedDlmmPool | undefined;
        if (!venueData) return null;

        const binMap = this.dlmmBinMaps.get(pool.poolAddress);
        if (!binMap) return null;

        // xToY = X (base) in, Y (quote) out
        const result = simulateDlmmQuick(this.store, venueData, binMap, baseIn, "xToY");
        if (!result) return null;

        return { quoteOut: result.amountOut };
    }
}
