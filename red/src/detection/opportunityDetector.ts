// src/detection/opportunityDetector.ts
//
// Unified opportunity detection pipeline.
//
// Integrates:
// - Confirmed state (Yellowstone gRPC) → Source of truth
// - Pending transactions (ShredStream) → Early detection
// - Hot path simulators (validated) → Price prediction
// - Bundle builder → Jito submission
//
// The key insight: We use the SAME simulation code paths for both
// confirmed state validation AND speculative opportunity detection.
// This means our accuracy on confirmed data transfers to predictions.

import { EventEmitter } from "events";
import { VersionedTransaction } from "@solana/web3.js";
import type { PubkeyStr, InMemoryAccountStore } from "../state/accountStore";
import {
    SpeculativeStateManager,
    type PendingTransaction,
    type SpeculativeStateDelta,
} from "../state/speculativeState";
import type { SwapDetectedEvent } from "../streams/shredstreamConsumer";
import { decodeSwapInstruction } from "../decoders/swapInstructions";

// Import hot path simulator types
// Note: Actual simulation integration will be completed when strategy is defined
// The hot path functions use store+pool patterns that require strategy-specific wiring
import type { CachedClmmTickList } from "../sim/clmmHotPath";
import type { CachedDlmmBinMap } from "../sim/dlmmHotPath";
import {
    simulatePumpSwapQuick,
    simulateRaydiumV4Quick,
    simulateClmmQuick,
    simulateDlmmQuick,
    type CachedPumpSwapPool,
    type CachedRaydiumV4Pool,
    type CachedClmmPool,
    type CachedDlmmPool,
} from "../sim/hotPathSim";
import { readTokenAmount } from "../state/hotPathCache";

// Suppress unused imports - these are used in type definitions
void (0 as unknown as CachedClmmTickList);
void (0 as unknown as CachedDlmmBinMap);

// ============================================================================
// Types
// ============================================================================

export interface OpportunityConfig {
    /** Minimum profit threshold in lamports */
    minProfitLamports: bigint;
    /** Minimum profit as percentage (0.001 = 0.1%) */
    minProfitPct: number;
    /** Maximum slippage tolerance (0.01 = 1%) */
    maxSlippagePct: number;
    /** Gas budget in lamports */
    gasBudgetLamports: bigint;
    /** Jito tip budget in lamports */
    tipBudgetLamports: bigint;
    /** Maximum position size in lamports */
    maxPositionLamports: bigint;
    /** Venues to consider for arbitrage */
    enabledVenues: Set<VenueType>;
}

export type VenueType = "pumpswap" | "raydium_v4" | "raydium_clmm" | "meteora_dlmm";

export interface ArbitrageOpportunity {
    /** Unique identifier */
    id: string;
    /** Type of opportunity */
    type: "backrun" | "sandwich" | "jit_liquidity" | "pure_arb";
    /** The triggering pending transaction (if applicable) */
    triggerTx?: PendingTransaction;
    /** Path of swaps to execute */
    path: SwapLeg[];
    /** Expected input amount */
    inputAmount: bigint;
    /** Expected output amount (same token as input for arb) */
    expectedOutput: bigint;
    /** Expected profit (output - input - gas - tip) */
    expectedProfit: bigint;
    /** Profit as percentage */
    profitPct: number;
    /** Confidence score (0-1) */
    confidence: number;
    /** Detection timestamp */
    detectedAt: number;
    /** Expiry slot */
    expirySlot: number;
}

export interface SwapLeg {
    venue: VenueType;
    poolAddress: PubkeyStr;
    tokenIn: PubkeyStr;
    tokenOut: PubkeyStr;
    amountIn: bigint;
    expectedAmountOut: bigint;
    direction: string; // venue-specific direction
}

export interface DetectorStats {
    pendingSwapsProcessed: number;
    opportunitiesFound: number;
    opportunitiesSubmitted: number;
    simulationsRun: number;
    avgSimLatencyUs: number;
    lastOpportunityAt: number;
}

// ============================================================================
// Pool State Cache
// ============================================================================

/**
 * Cached pool state for hot path simulation.
 * These are built from confirmed state and updated on gRPC account updates.
 */
export interface PoolStateCache {
    // PumpSwap pools
    pumpswap: Map<PubkeyStr, CachedPumpSwapPool>;
    // Raydium V4 pools
    raydiumV4: Map<PubkeyStr, CachedRaydiumV4Pool>;
    // Raydium CLMM pools with pre-cached tick lists
    raydiumClmm: Map<PubkeyStr, { pool: CachedClmmPool; tickList: CachedClmmTickList; feeRate: number }>;
    // Meteora DLMM pools with pre-cached bin maps
    meteoraDlmm: Map<PubkeyStr, { pool: CachedDlmmPool; binMap: CachedDlmmBinMap }>;
}

// ============================================================================
// Opportunity Detector
// ============================================================================

export class OpportunityDetector extends EventEmitter {
    private config: OpportunityConfig;
    private specManager: SpeculativeStateManager;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    private confirmedStore: InMemoryAccountStore; // Used by hot path sims when wired
    private poolCache: PoolStateCache;

    private stats: DetectorStats = {
        pendingSwapsProcessed: 0,
        opportunitiesFound: 0,
        opportunitiesSubmitted: 0,
        simulationsRun: 0,
        avgSimLatencyUs: 0,
        lastOpportunityAt: 0,
    };

    private simLatencies: number[] = [];
    private readonly MAX_LATENCY_SAMPLES = 1000;

    constructor(
        config: OpportunityConfig,
        specManager: SpeculativeStateManager,
        confirmedStore: InMemoryAccountStore
    ) {
        super();
        this.config = config;
        this.specManager = specManager;
        this.confirmedStore = confirmedStore;
        this.poolCache = {
            pumpswap: new Map(),
            raydiumV4: new Map(),
            raydiumClmm: new Map(),
            meteoraDlmm: new Map(),
        };
    }

    /**
     * Handle a detected pending swap from ShredStream.
     * This is the main entry point for pre-confirmation detection.
     */
    async onPendingSwap(event: SwapDetectedEvent): Promise<void> {
        this.stats.pendingSwapsProcessed++;

        const { tx, programId } = event;

        // Determine venue
        const venue = this.programIdToVenue(programId);
        if (!venue || !this.config.enabledVenues.has(venue)) {
            return;
        }

        // Get affected pool addresses from transaction
        const affectedPools = this.getAffectedPools(tx, venue);
        if (affectedPools.length === 0) return;

        // For each affected pool, simulate the pending swap and detect opportunities
        for (const poolAddress of affectedPools) {
            try {
                const opportunity = await this.detectBackrunOpportunity(
                    tx,
                    venue,
                    poolAddress
                );

                if (opportunity && this.isViable(opportunity)) {
                    this.stats.opportunitiesFound++;
                    this.stats.lastOpportunityAt = Date.now();
                    this.specManager.recordOpportunity();

                    this.emit("opportunityDetected", opportunity);
                }
            } catch (err) {
                // Log but don't crash on simulation errors
                this.emit("simulationError", { tx: tx.signature, error: err });
            }
        }
    }

    /**
     * Detect backrun arbitrage opportunity after a pending swap.
     *
     * Strategy:
     * 1. Simulate the pending swap to get predicted post-state
     * 2. Check if any arb paths become profitable at predicted state
     * 3. If profitable, build the arb opportunity
     */
    private async detectBackrunOpportunity(
        triggerTx: PendingTransaction,
        venue: VenueType,
        poolAddress: PubkeyStr
    ): Promise<ArbitrageOpportunity | null> {
        const simStart = performance.now();

        // Get current confirmed pool state
        const poolState = this.getPoolState(venue, poolAddress);
        if (!poolState) return null;

        // Simulate the trigger swap to get predicted post-state
        const predictedState = await this.simulateTriggerSwap(
            triggerTx,
            venue,
            poolState
        );

        if (!predictedState) return null;

        // Store speculative delta for later use
        this.specManager.setSpeculativeDelta(predictedState);

        // Check for arbitrage opportunities at predicted state
        const arbPath = this.findArbPath(venue, poolAddress, predictedState);

        const simEnd = performance.now();
        this.recordSimLatency((simEnd - simStart) * 1000); // Convert to µs

        if (!arbPath) return null;

        // Build opportunity
        const opportunity: ArbitrageOpportunity = {
            id: `backrun-${triggerTx.signature.slice(0, 16)}-${Date.now()}`,
            type: "backrun",
            triggerTx,
            path: arbPath.legs,
            inputAmount: arbPath.inputAmount,
            expectedOutput: arbPath.expectedOutput,
            expectedProfit: arbPath.expectedOutput - arbPath.inputAmount -
                this.config.gasBudgetLamports - this.config.tipBudgetLamports,
            profitPct: Number(arbPath.expectedOutput - arbPath.inputAmount) /
                Number(arbPath.inputAmount),
            confidence: predictedState.confidence,
            detectedAt: Date.now(),
            expirySlot: predictedState.expirySlot,
        };

        return opportunity;
    }

    /**
     * Simulate a trigger swap to predict post-state.
     *
     * TODO: Wire up hot path simulators when strategy is defined.
     * The simulators use store+pool patterns that require:
     * 1. Account store with raw buffer access
     * 2. Cached pool metadata structures
     * 3. Strategy-specific swap parameter parsing
     */
    private async simulateTriggerSwap(
        tx: PendingTransaction,
        venue: VenueType,
        _poolState: unknown
    ): Promise<SpeculativeStateDelta | null> {
        this.stats.simulationsRun++;
        this.specManager.recordSimulation();

        const swapParams = this.parseSwapParams(tx, venue);
        if (!swapParams) return null;

        let simulatedAmountIn = swapParams.amountIn;
        let simulatedAmountOut: bigint | null = null;
        let confidence = 0.0;

        switch (venue) {
            case "pumpswap": {
                const pool = this.poolCache.pumpswap.get(swapParams.poolAddress);
                if (!pool) return null;

                if (swapParams.isExactOut && swapParams.exactOut !== null) {
                    const solvedIn = this.solvePumpSwapExactOut(
                        pool,
                        swapParams.exactOut,
                        swapParams.maxIn,
                        swapParams.direction === "baseToQuote"
                    );
                    if (solvedIn === null) return null;
                    simulatedAmountIn = solvedIn;
                }

                const result = simulatePumpSwapQuick(
                    this.confirmedStore,
                    pool,
                    simulatedAmountIn,
                    swapParams.direction === "baseToQuote"
                );
                if (!result) return null;
                simulatedAmountOut = result.amountOut;
                confidence = 0.9;
                break;
            }
            case "raydium_v4": {
                const pool = this.poolCache.raydiumV4.get(swapParams.poolAddress);
                if (!pool) return null;
                const result = simulateRaydiumV4Quick(
                    this.confirmedStore,
                    pool,
                    simulatedAmountIn,
                    swapParams.direction === "baseToQuote"
                );
                if (!result) return null;
                simulatedAmountOut = result.amountOut;
                confidence = 0.9;
                break;
            }
            case "raydium_clmm": {
                const cached = this.poolCache.raydiumClmm.get(swapParams.poolAddress);
                if (!cached) return null;
                const result = simulateClmmQuick(
                    this.confirmedStore,
                    cached.pool,
                    cached.tickList,
                    simulatedAmountIn,
                    swapParams.direction === "zeroForOne",
                    cached.feeRate
                );
                if (!result) return null;
                simulatedAmountOut = result.amountOut;
                confidence = 0.95;
                break;
            }
            case "meteora_dlmm": {
                const cached = this.poolCache.meteoraDlmm.get(swapParams.poolAddress);
                if (!cached) return null;
                const result = simulateDlmmQuick(
                    this.confirmedStore,
                    cached.pool,
                    cached.binMap,
                    simulatedAmountIn,
                    swapParams.direction as "xToY" | "yToX"
                );
                if (!result) return null;
                simulatedAmountOut = result.amountOut;
                confidence = 0.95;
                break;
            }
        }

        if (simulatedAmountOut === null) return null;
        if (swapParams.minOut !== null && simulatedAmountOut < swapParams.minOut) {
            return null;
        }

        const tokenDeltas = new Map<PubkeyStr, bigint>();
        if (swapParams.tokenIn) tokenDeltas.set(swapParams.tokenIn, -simulatedAmountIn);
        if (swapParams.tokenOut) tokenDeltas.set(swapParams.tokenOut, simulatedAmountOut);

        const delta: SpeculativeStateDelta = {
            sourceTx: tx.signature,
            accountDeltas: new Map(),
            tokenDeltas,
            confidence,
            expirySlot: tx.seenSlot + 5,
        };

        return delta;
    }

    /**
     * Find arbitrage path at predicted state.
     * This is a simplified implementation - real version would check multiple paths.
     */
    private findArbPath(
        _venue: VenueType,
        _poolAddress: PubkeyStr,
        _predictedState: SpeculativeStateDelta
    ): { legs: SwapLeg[]; inputAmount: bigint; expectedOutput: bigint } | null {
        // TODO: Implement multi-venue arbitrage path finding
        // For now, return null - this is where strategy-specific logic goes
        //
        // Real implementation would:
        // 1. Check if the predicted price move creates cross-venue arb
        // 2. Find optimal input amount using binary search
        // 3. Simulate full path to get expected output
        // 4. Return if profitable after gas + tips

        return null;
    }

    /**
     * Check if opportunity meets viability thresholds.
     */
    private isViable(opp: ArbitrageOpportunity): boolean {
        if (opp.expectedProfit < this.config.minProfitLamports) return false;
        if (opp.profitPct < this.config.minProfitPct) return false;
        if (opp.inputAmount > this.config.maxPositionLamports) return false;
        if (opp.confidence < 0.8) return false;
        return true;
    }

    // ========================================================================
    // Helper Methods
    // ========================================================================

    private programIdToVenue(programId: PubkeyStr): VenueType | null {
        const mapping: Record<string, VenueType> = {
            "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA": "pumpswap",
            "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "raydium_v4",
            "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK": "raydium_clmm",
            "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo": "meteora_dlmm",
        };
        return mapping[programId] ?? null;
    }

    private getAffectedPools(tx: PendingTransaction, venue: VenueType): PubkeyStr[] {
        const pools = new Set<PubkeyStr>();
        const accountKeys = this.getAccountKeys(tx);

        if (accountKeys) {
            for (const ix of tx.instructions) {
                if (this.programIdToVenue(ix.programId) !== venue) continue;
                const decoded = decodeSwapInstruction(ix.programId, ix.data, accountKeys);
                if (!decoded) continue;
                if (this.getPoolState(venue, decoded.poolAddress)) {
                    pools.add(decoded.poolAddress);
                }
            }
        }

        if (pools.size === 0) {
            for (const acc of tx.writeAccounts) {
                if (this.getPoolState(venue, acc)) pools.add(acc);
            }
        }

        return [...pools];
    }

    private getPoolState(venue: VenueType, poolAddress: PubkeyStr): any {
        switch (venue) {
            case "pumpswap":
                return this.poolCache.pumpswap.get(poolAddress);
            case "raydium_v4":
                return this.poolCache.raydiumV4.get(poolAddress);
            case "raydium_clmm":
                return this.poolCache.raydiumClmm.get(poolAddress);
            case "meteora_dlmm":
                return this.poolCache.meteoraDlmm.get(poolAddress);
            default:
                return null;
        }
    }

    private parseSwapParams(
        tx: PendingTransaction,
        venue: VenueType
    ): {
        poolAddress: PubkeyStr;
        amountIn: bigint;
        minOut: bigint | null;
        direction: string;
        tokenIn: PubkeyStr | null;
        tokenOut: PubkeyStr | null;
        isExactOut: boolean;
        exactOut: bigint | null;
        maxIn: bigint | null;
    } | null {
        const accountKeys = this.getAccountKeys(tx);
        if (!accountKeys) return null;

        for (const ix of tx.instructions) {
            if (this.programIdToVenue(ix.programId) !== venue) continue;
            const decoded = decodeSwapInstruction(ix.programId, ix.data, accountKeys);
            if (!decoded) continue;

            let tokenIn: PubkeyStr | null = decoded.tokenInMint ?? null;
            let tokenOut: PubkeyStr | null = decoded.tokenOutMint ?? null;

            if ((!tokenIn || !tokenOut) && venue === "raydium_clmm") {
                const cached = this.poolCache.raydiumClmm.get(decoded.poolAddress);
                if (cached) {
                    if (decoded.direction === "zeroForOne") {
                        tokenIn = cached.pool.mint0;
                        tokenOut = cached.pool.mint1;
                    } else if (decoded.direction === "oneForZero") {
                        tokenIn = cached.pool.mint1;
                        tokenOut = cached.pool.mint0;
                    }
                }
            } else if ((!tokenIn || !tokenOut) && venue === "meteora_dlmm") {
                const cached = this.poolCache.meteoraDlmm.get(decoded.poolAddress);
                if (cached) {
                    if (decoded.direction === "xToY") {
                        tokenIn = cached.pool.mintX;
                        tokenOut = cached.pool.mintY;
                    } else if (decoded.direction === "yToX") {
                        tokenIn = cached.pool.mintY;
                        tokenOut = cached.pool.mintX;
                    }
                }
            }

            return {
                poolAddress: decoded.poolAddress,
                amountIn: decoded.amountIn,
                minOut: decoded.minAmountOut ?? null,
                direction: decoded.direction,
                tokenIn,
                tokenOut,
                isExactOut: decoded.isExactOut ?? false,
                exactOut: decoded.exactOut ?? null,
                maxIn: decoded.maxIn ?? null,
            };
        }

        return null;
    }

    private getAccountKeys(tx: PendingTransaction): PubkeyStr[] | null {
        try {
            const message = VersionedTransaction.deserialize(tx.rawTx).message;
            return message.staticAccountKeys.map(k => k.toBase58() as PubkeyStr);
        } catch {
            return null;
        }
    }

    private solvePumpSwapExactOut(
        pool: CachedPumpSwapPool,
        exactOut: bigint,
        maxIn: bigint | null,
        isBaseToQuote: boolean
    ): bigint | null {
        const maxInput = maxIn ?? BigInt(0);
        if (exactOut <= 0n || maxInput <= 0n) return null;

        const baseData = this.confirmedStore.getData(pool.baseVault);
        const quoteData = this.confirmedStore.getData(pool.quoteVault);
        if (!baseData || !quoteData) return null;

        if (readTokenAmount(baseData) === undefined || readTokenAmount(quoteData) === undefined) {
            return null;
        }

        // Binary search for the smallest input that yields >= exactOut
        let lo = 0n;
        let hi = maxInput;
        let best: bigint | null = null;

        for (let i = 0; i < 64 && lo <= hi; i++) {
            const mid = (lo + hi) / 2n;
            const quote = simulatePumpSwapQuick(this.confirmedStore, pool, mid, isBaseToQuote);
            if (!quote) return null;

            if (quote.amountOut >= exactOut) {
                best = mid;
                if (mid === 0n) break;
                hi = mid - 1n;
            } else {
                lo = mid + 1n;
            }
        }

        return best;
    }

    private recordSimLatency(latencyUs: number): void {
        this.simLatencies.push(latencyUs);
        if (this.simLatencies.length > this.MAX_LATENCY_SAMPLES) {
            this.simLatencies.shift();
        }
        this.stats.avgSimLatencyUs =
            this.simLatencies.reduce((a, b) => a + b, 0) / this.simLatencies.length;
    }

    /**
     * Update pool cache from confirmed state.
     * Call this when gRPC delivers new account updates.
     */
    updatePoolCache(
        venue: VenueType,
        poolAddress: PubkeyStr,
        state:
            | CachedPumpSwapPool
            | CachedRaydiumV4Pool
            | { pool: CachedClmmPool; tickList: CachedClmmTickList; feeRate: number }
            | { pool: CachedDlmmPool; binMap: CachedDlmmBinMap }
    ): void {
        switch (venue) {
            case "pumpswap":
                this.poolCache.pumpswap.set(poolAddress, state as CachedPumpSwapPool);
                break;
            case "raydium_v4":
                this.poolCache.raydiumV4.set(poolAddress, state as CachedRaydiumV4Pool);
                break;
            case "raydium_clmm":
                this.poolCache.raydiumClmm.set(
                    poolAddress,
                    state as { pool: CachedClmmPool; tickList: CachedClmmTickList; feeRate: number }
                );
                break;
            case "meteora_dlmm":
                this.poolCache.meteoraDlmm.set(
                    poolAddress,
                    state as { pool: CachedDlmmPool; binMap: CachedDlmmBinMap }
                );
                break;
        }
    }

    /**
     * Get current stats.
     */
    getStats(): DetectorStats {
        return { ...this.stats };
    }
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_OPPORTUNITY_CONFIG: OpportunityConfig = {
    minProfitLamports: BigInt(100_000), // 0.0001 SOL minimum
    minProfitPct: 0.001, // 0.1% minimum
    maxSlippagePct: 0.01, // 1% max slippage
    gasBudgetLamports: BigInt(5_000), // 0.000005 SOL for compute
    tipBudgetLamports: BigInt(10_000), // 0.00001 SOL Jito tip
    maxPositionLamports: BigInt(1_000_000_000), // 1 SOL max position
    enabledVenues: new Set(["pumpswap", "raydium_v4", "raydium_clmm", "meteora_dlmm"] as VenueType[]),
};
