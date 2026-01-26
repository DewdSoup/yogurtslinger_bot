// src/signals/meteoraEdge.ts
// =============================================================================
// METEORA EDGE STRATEGIES - USES VALIDATED DECODER + FRESH CACHE STATE
// =============================================================================
//
// Two edges that larger bots skip because Meteora math is "too annoying":
//
// 1. FEE DECAY SNIPING
//    - volatilityAccumulator spikes on trades → fees go UP
//    - It decays over time based on filterPeriod/decayPeriod → fees go DOWN
//    - Other bots see "8% fee" and skip. We know it drops to 0.5% in 30 seconds.
//    - NOW USING: predictMeteoraFeeAfterDecay() from validated decoder
//    - CRITICAL: Pulls FRESH state from MarketCache on recheck (not stale cache)
//
// 2. EMPTY BIN BACKRUN
//    - When trades cross empty bins, slippage is massive
//    - Price displacement = reversion opportunity
//    - Track activeId movements, identify reversion candidates
//
// =============================================================================

import type { MeteoraLbPairState } from "../decoders/meteora.js";
import type { MarketCache, MeteoraPoolEntry } from "../brain/marketCache.js";
import {
    computeMeteoraFee,
    computeMeteoraBaseFee,
    predictMeteoraFeeAfterDecay,
    secondsToBaseFee,
    formatFeePercent,
} from "../decoders/meteora.js";

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
    // Fee Decay
    VOLATILITY_SPIKE_THRESHOLD: 1.5,     // 50% increase = spike
    MIN_VOLATILITY_FOR_TRACKING: 500,    // Ignore tiny spikes
    MAX_TRACKED_POOLS: 200,              // Memory limit
    RECHECK_BUFFER_SLOTS: 5,             // Extra slots before recheck
    MIN_FEE_DROP_FOR_OPPORTUNITY: 0.005, // 0.5% fee drop to trigger

    // Empty Bin Backrun  
    MIN_BINS_MOVED_FOR_BACKRUN: 3,       // Minimum movement to consider
    HIGH_EMPTY_RATIO_THRESHOLD: 0.5,     // >50% empty = high slippage trade
    EXPECTED_REVERSION_RATIO: 0.3,       // Expect 30% price reversion
    BACKRUN_WINDOW_MS: 2000,             // Window to execute backrun

    // Logging
    LOG_SPIKES: true,
    LOG_DECAY_CHECKS: true,
    LOG_BIN_MOVES: true,
    LOG_OPPORTUNITIES: true,
};

// =============================================================================
// TYPES
// =============================================================================

export interface FeeDecayOpportunity {
    poolPubkey: string;
    tokenMint: string;
    currentFee: number;
    predictedFee: number;
    feeDropBps: number;
    slotsUntilLowFee: number;
    msUntilLowFee: number;
    baseFee: number;
    confidence: "HIGH" | "MEDIUM" | "LOW";
    detectedAt: number;
    recheckAt: number;
}

export interface BackrunOpportunity {
    poolPubkey: string;
    tokenMint: string;
    previousActiveId: number;
    newActiveId: number;
    binsMoved: number;
    emptyBinsCrossed: number;
    emptyRatio: number;
    expectedReversionBins: number;
    direction: "UP" | "DOWN";  // Price moved UP or DOWN
    tradeDirection: "BUY" | "SELL";  // To capture reversion, do opposite
    confidence: "HIGH" | "MEDIUM" | "LOW";
    detectedAt: number;
    expiresAt: number;
}

interface TrackedPool {
    poolPubkey: string;
    tokenMint: string;

    // Fee tracking - only track volatility history, not cached params
    lastVolatilityAccumulator: number;
    peakVolatilityAccumulator: number;
    lastUpdateSlot: bigint;
    spikeDetectedAt: number | null;

    // Bin tracking
    lastActiveId: number;
    activeIdHistory: Array<{ activeId: number; slot: bigint; timestamp: number }>;
}

interface PendingRecheck {
    timeout: NodeJS.Timeout;
    peakFee: number;
    baseFee: number;
    tokenMint: string;
}

interface BinLiquidity {
    binId: number;
    amountX: bigint;
    amountY: bigint;
}

// Callback type for bin queries
type BinQueryFn = (poolPubkey: string, binId: number) => BinLiquidity | null;

// =============================================================================
// FEE DECAY TRACKER - USES VALIDATED DECODER + FRESH CACHE STATE
// =============================================================================

export class FeeDecayTracker {
    private readonly pools = new Map<string, TrackedPool>();
    private readonly pendingRechecks = new Map<string, PendingRecheck>();
    private readonly opportunities: FeeDecayOpportunity[] = [];

    // CRITICAL: Reference to MarketCache for fresh state
    private cache: MarketCache | null = null;

    // Stats
    public stats = {
        spikesDetected: 0,
        decayOpportunities: 0,
        rechecksFired: 0,
        poolsTracked: 0,
        pendingRechecks: 0,
        staleRechecks: 0,  // Track when cache had stale data
    };

    constructor() {
        console.log("[FeeDecay] Initialized - awaiting MarketCache connection");
    }

    /**
     * CRITICAL: Connect to MarketCache for fresh state on rechecks
     * Must be called before tracking starts
     */
    setMarketCache(cache: MarketCache): void {
        this.cache = cache;
        console.log("[FeeDecay] ✅ Connected to MarketCache for fresh state");
    }

    /**
     * Track a Meteora pool update for fee decay opportunities
     * Call this on every Meteora LbPair account update
     */
    trackUpdate(
        poolPubkey: string,
        state: MeteoraLbPairState,
        slot: bigint,
        tokenMint: string,
        onDecayOpportunity?: (opp: FeeDecayOpportunity) => void
    ): void {
        const existing = this.pools.get(poolPubkey);
        const now = Date.now();

        if (!existing) {
            // First time seeing this pool - just record baseline
            this.pools.set(poolPubkey, {
                poolPubkey,
                tokenMint,
                lastVolatilityAccumulator: state.volatilityAccumulator,
                peakVolatilityAccumulator: state.volatilityAccumulator,
                lastUpdateSlot: slot,
                spikeDetectedAt: null,
                lastActiveId: state.activeId,
                activeIdHistory: [{ activeId: state.activeId, slot, timestamp: now }],
            });
            this.stats.poolsTracked = this.pools.size;
            return;
        }

        const prevVol = existing.lastVolatilityAccumulator;
        const newVol = state.volatilityAccumulator;

        // Detect volatility spike (someone just traded)
        const spikeRatio = prevVol > 0 ? newVol / prevVol : newVol > 0 ? Infinity : 1;
        const isSpike = spikeRatio >= CONFIG.VOLATILITY_SPIKE_THRESHOLD &&
            newVol >= CONFIG.MIN_VOLATILITY_FOR_TRACKING;

        if (isSpike) {
            this.stats.spikesDetected++;
            existing.spikeDetectedAt = now;
            existing.peakVolatilityAccumulator = newVol;

            // Calculate current fee using VALIDATED formula
            const currentFee = computeMeteoraFee(
                state.baseFactor,
                state.binStep,
                state.variableFeeControl,
                newVol
            );

            const baseFee = computeMeteoraBaseFee(state.baseFactor, state.binStep);

            // USE VALIDATED DECAY PREDICTION from full state
            const decayInfo = this.predictDecayValidated(state);

            if (CONFIG.LOG_SPIKES) {
                console.log(
                    `[FEE_SPIKE] 🔥 ${poolPubkey.slice(0, 8)}... | ` +
                    `vol ${prevVol}→${newVol} (+${((spikeRatio - 1) * 100).toFixed(0)}%) | ` +
                    `fee now ${formatFeePercent(currentFee)} → ${formatFeePercent(decayInfo.predictedFee)} in ${decayInfo.slotsUntilLowFee} slots | ` +
                    `timeToBase=${decayInfo.secondsToBase.toFixed(1)}s | ` +
                    `token=${tokenMint.slice(0, 8)}...`
                );
            }

            // Schedule recheck when fee should be low
            this.scheduleRecheck(poolPubkey, decayInfo, currentFee, baseFee, tokenMint, onDecayOpportunity);
        }

        // Update tracking
        existing.lastVolatilityAccumulator = newVol;
        existing.lastUpdateSlot = slot;

        // Prune old pools if at limit
        if (this.pools.size > CONFIG.MAX_TRACKED_POOLS) {
            this.pruneOldest();
        }
    }

    /**
     * Predict when volatility will decay - USES VALIDATED FORMULAS
     * Takes FULL STATE, not cached params
     */
    private predictDecayValidated(
        state: MeteoraLbPairState
    ): { predictedFee: number; slotsUntilLowFee: number; secondsToBase: number } {

        // Use validated secondsToBaseFee() from meteora.ts - takes FULL STATE
        const secondsToBase = secondsToBaseFee(state);

        // Calculate slots until low fee (~90% decay)
        const targetSeconds = secondsToBase * 0.9;  // 90% of the way to base fee
        const slotsUntilLowFee = Math.ceil(targetSeconds / 0.4);

        // Predict fee using validated function - takes FULL STATE
        const predictedFee = predictMeteoraFeeAfterDecay(state, targetSeconds);

        return { predictedFee, slotsUntilLowFee, secondsToBase };
    }

    /**
     * Schedule a recheck when fee should have decayed
     * CRITICAL: Will pull FRESH state from MarketCache when timer fires
     */
    private scheduleRecheck(
        poolPubkey: string,
        decayInfo: { predictedFee: number; slotsUntilLowFee: number; secondsToBase: number },
        peakFee: number,
        baseFee: number,
        tokenMint: string,
        onDecayOpportunity?: (opp: FeeDecayOpportunity) => void
    ): void {
        // Cancel existing recheck
        const existing = this.pendingRechecks.get(poolPubkey);
        if (existing) {
            clearTimeout(existing.timeout);
        }

        // ~400ms per slot on Solana
        const msUntilRecheck = (decayInfo.slotsUntilLowFee + CONFIG.RECHECK_BUFFER_SLOTS) * 400;
        const recheckAt = Date.now() + msUntilRecheck;

        const timeout = setTimeout(() => {
            this.executeRecheck(poolPubkey, peakFee, baseFee, tokenMint, recheckAt, onDecayOpportunity);
        }, msUntilRecheck);

        this.pendingRechecks.set(poolPubkey, { timeout, peakFee, baseFee, tokenMint });
        this.stats.pendingRechecks = this.pendingRechecks.size;
    }

    /**
     * Execute the fee decay recheck
     * CRITICAL: Pulls FRESH state from MarketCache, NOT cached values
     */
    private executeRecheck(
        poolPubkey: string,
        peakFee: number,
        baseFee: number,
        tokenMint: string,
        recheckAt: number,
        onDecayOpportunity?: (opp: FeeDecayOpportunity) => void
    ): void {
        this.stats.rechecksFired++;
        this.pendingRechecks.delete(poolPubkey);
        this.stats.pendingRechecks = this.pendingRechecks.size;

        // CRITICAL: Get FRESH state from MarketCache
        if (!this.cache) {
            console.warn(`[FEE_DECAY] ⚠️ No MarketCache connected - cannot recheck ${poolPubkey.slice(0, 8)}...`);
            return;
        }

        const freshEntry: MeteoraPoolEntry | undefined = this.cache.getMeteoraPool(poolPubkey);
        if (!freshEntry) {
            console.warn(`[FEE_DECAY] ⚠️ Pool ${poolPubkey.slice(0, 8)}... not found in cache`);
            return;
        }

        const freshState = freshEntry.state;
        const cacheAge = Date.now() - freshEntry.lastUpdatedTs;

        // Check if cache data is reasonably fresh (< 5 seconds old)
        if (cacheAge > 5000) {
            this.stats.staleRechecks++;
            console.warn(
                `[FEE_DECAY] ⚠️ Cache data is ${(cacheAge / 1000).toFixed(1)}s old for ${poolPubkey.slice(0, 8)}... - proceeding anyway`
            );
        }

        // Calculate ACTUAL current fee using FRESH state from cache
        const actualFee = computeMeteoraFee(
            freshState.baseFactor,
            freshState.binStep,
            freshState.variableFeeControl,
            freshState.volatilityAccumulator
        );

        const feeDropBps = Math.round((peakFee - actualFee) * 10000);

        if (CONFIG.LOG_DECAY_CHECKS) {
            console.log(
                `[FEE_DECAY] ⏰ ${poolPubkey.slice(0, 8)}... | ` +
                `fee ${formatFeePercent(peakFee)} → ${formatFeePercent(actualFee)} | ` +
                `drop=${feeDropBps}bps | ` +
                `vol=${freshState.volatilityAccumulator} | ` +
                `cacheAge=${(cacheAge / 1000).toFixed(1)}s`
            );
        }

        // Check if fee dropped enough to create opportunity
        if (actualFee < peakFee - CONFIG.MIN_FEE_DROP_FOR_OPPORTUNITY) {
            const confidence: "HIGH" | "MEDIUM" | "LOW" =
                feeDropBps > 200 ? "HIGH" :
                    feeDropBps > 100 ? "MEDIUM" : "LOW";

            const opp: FeeDecayOpportunity = {
                poolPubkey,
                tokenMint,
                currentFee: actualFee,
                predictedFee: baseFee,  // After full decay, will hit base
                feeDropBps,
                slotsUntilLowFee: 0,  // Already decayed
                msUntilLowFee: 0,
                baseFee,
                confidence,
                detectedAt: Date.now(),
                recheckAt,
            };

            this.opportunities.push(opp);
            this.stats.decayOpportunities++;

            if (CONFIG.LOG_OPPORTUNITIES) {
                console.log(
                    `[FEE_DECAY] 💰 OPPORTUNITY: ${poolPubkey.slice(0, 8)}... | ` +
                    `fee now ${formatFeePercent(actualFee)} (was ${formatFeePercent(peakFee)}) | ` +
                    `conf=${confidence} | token=${tokenMint.slice(0, 8)}...`
                );
            }

            if (onDecayOpportunity) {
                onDecayOpportunity(opp);
            }
        }
    }

    /**
     * Get all pending decay opportunities
     */
    getOpportunities(): FeeDecayOpportunity[] {
        // Filter to recent opportunities (last 30s)
        const cutoff = Date.now() - 30000;
        return this.opportunities.filter(o => o.detectedAt > cutoff);
    }

    /**
     * Clear processed opportunity
     */
    clearOpportunity(poolPubkey: string): void {
        const idx = this.opportunities.findIndex(o => o.poolPubkey === poolPubkey);
        if (idx >= 0) {
            this.opportunities.splice(idx, 1);
        }
    }

    private pruneOldest(): void {
        // Remove pools not updated in last 5 minutes
        const cutoff = Date.now() - 5 * 60 * 1000;
        for (const [pubkey, pool] of this.pools) {
            if (pool.spikeDetectedAt && pool.spikeDetectedAt < cutoff) {
                this.pools.delete(pubkey);
                const pending = this.pendingRechecks.get(pubkey);
                if (pending) {
                    clearTimeout(pending.timeout);
                    this.pendingRechecks.delete(pubkey);
                }
            }
        }
        this.stats.poolsTracked = this.pools.size;
        this.stats.pendingRechecks = this.pendingRechecks.size;
    }

    getStats() {
        return {
            ...this.stats,
            pendingRechecks: this.pendingRechecks.size,
            activeOpportunities: this.getOpportunities().length,
        };
    }
}

// =============================================================================
// EMPTY BIN DETECTOR - Tracks activeId movements for backrun opportunities
// =============================================================================

export class EmptyBinDetector {
    private readonly poolHistory = new Map<string, {
        activeIdHistory: Array<{ activeId: number; slot: bigint; timestamp: number }>;
        tokenMint: string;
    }>();

    private readonly opportunities: BackrunOpportunity[] = [];
    private binQueryFn: BinQueryFn | null = null;

    // Stats
    public stats = {
        movesDetected: 0,
        largeMoves: 0,
        backrunOpportunities: 0,
    };

    constructor() {
        console.log("[EmptyBin] Initialized");
    }

    /**
     * Set the function used to query bin liquidity
     * This is called from BinArrayCache
     */
    setBinQueryFn(fn: BinQueryFn): void {
        this.binQueryFn = fn;
        console.log("[EmptyBin] ✅ Bin query function connected");
    }

    /**
     * Track an activeId change for potential backrun opportunity
     */
    trackActiveIdMove(
        poolPubkey: string,
        state: MeteoraLbPairState,
        slot: bigint,
        tokenMint: string,
        onBackrunOpportunity?: (opp: BackrunOpportunity) => void
    ): void {
        const now = Date.now();
        const newActiveId = state.activeId;

        let history = this.poolHistory.get(poolPubkey);
        if (!history) {
            history = {
                activeIdHistory: [],
                tokenMint,
            };
            this.poolHistory.set(poolPubkey, history);
        }

        // Add to history
        history.activeIdHistory.push({ activeId: newActiveId, slot, timestamp: now });

        // Keep only last 50 entries
        if (history.activeIdHistory.length > 50) {
            history.activeIdHistory = history.activeIdHistory.slice(-50);
        }

        // Check if there's a previous entry to compare
        if (history.activeIdHistory.length < 2) return;

        const previousEntry = history.activeIdHistory[history.activeIdHistory.length - 2]!;
        const previousActiveId = previousEntry.activeId;
        const binsMoved = Math.abs(newActiveId - previousActiveId);

        if (binsMoved === 0) return;

        this.stats.movesDetected++;

        if (binsMoved >= CONFIG.MIN_BINS_MOVED_FOR_BACKRUN) {
            this.stats.largeMoves++;

            // Analyze empty bins in the range
            const emptyAnalysis = this.analyzeEmptyBins(poolPubkey, previousActiveId, newActiveId);

            const direction: "UP" | "DOWN" = newActiveId > previousActiveId ? "UP" : "DOWN";
            const tradeDirection: "BUY" | "SELL" = direction === "UP" ? "SELL" : "BUY";  // Opposite for reversion

            if (CONFIG.LOG_BIN_MOVES) {
                console.log(
                    `[BIN_MOVE] 📊 ${poolPubkey.slice(0, 8)}... | ` +
                    `activeId ${previousActiveId}→${newActiveId} (${direction} ${binsMoved} bins) | ` +
                    `empty=${emptyAnalysis.emptyCount}/${binsMoved} (${(emptyAnalysis.emptyRatio * 100).toFixed(0)}%) | ` +
                    `token=${tokenMint.slice(0, 8)}...`
                );
            }

            // Check for backrun opportunity
            if (emptyAnalysis.emptyRatio >= CONFIG.HIGH_EMPTY_RATIO_THRESHOLD && binsMoved >= CONFIG.MIN_BINS_MOVED_FOR_BACKRUN) {
                const expectedReversionBins = Math.floor(binsMoved * CONFIG.EXPECTED_REVERSION_RATIO);

                const confidence: "HIGH" | "MEDIUM" | "LOW" =
                    emptyAnalysis.emptyRatio > 0.7 && binsMoved >= 5 ? "HIGH" :
                        emptyAnalysis.emptyRatio > 0.5 && binsMoved >= 3 ? "MEDIUM" : "LOW";

                const opp: BackrunOpportunity = {
                    poolPubkey,
                    tokenMint,
                    previousActiveId,
                    newActiveId,
                    binsMoved,
                    emptyBinsCrossed: emptyAnalysis.emptyCount,
                    emptyRatio: emptyAnalysis.emptyRatio,
                    expectedReversionBins,
                    direction,
                    tradeDirection,
                    confidence,
                    detectedAt: now,
                    expiresAt: now + CONFIG.BACKRUN_WINDOW_MS,
                };

                this.opportunities.push(opp);
                this.stats.backrunOpportunities++;

                if (CONFIG.LOG_OPPORTUNITIES) {
                    console.log(
                        `[BACKRUN] 💰 OPPORTUNITY: ${poolPubkey.slice(0, 8)}... | ` +
                        `${binsMoved} bins ${direction}, ${(emptyAnalysis.emptyRatio * 100).toFixed(0)}% empty | ` +
                        `expect ~${expectedReversionBins} bin reversion | ` +
                        `action=${tradeDirection} | conf=${confidence} | ` +
                        `expires in ${CONFIG.BACKRUN_WINDOW_MS}ms`
                    );
                }

                if (onBackrunOpportunity) {
                    onBackrunOpportunity(opp);
                }
            }
        }

        // Prune old opportunities
        this.pruneExpiredOpportunities();
    }

    /**
     * Analyze how many empty bins were crossed
     */
    private analyzeEmptyBins(
        poolPubkey: string,
        startId: number,
        endId: number
    ): { emptyCount: number; emptyRatio: number; emptyBins: number[] } {
        if (!this.binQueryFn) {
            // No bin data - estimate based on typical patterns
            const binsMoved = Math.abs(endId - startId);
            // Conservative estimate: assume 30% empty when we can't verify
            return {
                emptyCount: Math.floor(binsMoved * 0.3),
                emptyRatio: 0.3,
                emptyBins: []
            };
        }

        const emptyBins: number[] = [];
        const step = startId < endId ? 1 : -1;

        for (let binId = startId; binId !== endId; binId += step) {
            const bin = this.binQueryFn(poolPubkey, binId);

            // Bin is empty if no liquidity or null (not in cache)
            if (!bin || (bin.amountX === 0n && bin.amountY === 0n)) {
                emptyBins.push(binId);
            }
        }

        const totalBins = Math.abs(endId - startId);
        const emptyRatio = totalBins > 0 ? emptyBins.length / totalBins : 0;

        return {
            emptyCount: emptyBins.length,
            emptyRatio,
            emptyBins
        };
    }

    /**
     * Get active backrun opportunities
     */
    getOpportunities(): BackrunOpportunity[] {
        const now = Date.now();
        return this.opportunities.filter(o => o.expiresAt > now);
    }

    /**
     * Clear processed opportunity
     */
    clearOpportunity(poolPubkey: string): void {
        const idx = this.opportunities.findIndex(o => o.poolPubkey === poolPubkey);
        if (idx >= 0) {
            this.opportunities.splice(idx, 1);
        }
    }

    private pruneExpiredOpportunities(): void {
        const now = Date.now();
        this.opportunities.splice(
            0,
            this.opportunities.length,
            ...this.opportunities.filter(o => o.expiresAt > now)
        );
    }

    getStats() {
        return {
            ...this.stats,
            activeOpportunities: this.getOpportunities().length,
        };
    }
}

// =============================================================================
// UNIFIED METEORA EDGE MANAGER - WIRED TO MARKETCACHE
// =============================================================================

export class MeteoraEdgeManager {
    public readonly feeDecay: FeeDecayTracker;
    public readonly emptyBin: EmptyBinDetector;

    constructor() {
        this.feeDecay = new FeeDecayTracker();
        this.emptyBin = new EmptyBinDetector();
        console.log("[MeteoraEdge] Initialized - awaiting MarketCache connection");
    }

    /**
     * CRITICAL: Connect to MarketCache for fresh state
     * Must be called before tracking starts
     */
    setMarketCache(cache: MarketCache): void {
        this.feeDecay.setMarketCache(cache);
        console.log("[MeteoraEdge] ✅ Connected to MarketCache");
    }

    /**
     * Set bin query function for empty bin analysis
     */
    setBinQueryFn(fn: BinQueryFn): void {
        this.emptyBin.setBinQueryFn(fn);
    }

    /**
     * Track a Meteora pool update - checks both edge types
     */
    trackUpdate(
        poolPubkey: string,
        state: MeteoraLbPairState,
        slot: bigint,
        tokenMint: string,
        callbacks?: {
            onFeeDecay?: (opp: FeeDecayOpportunity) => void;
            onBackrun?: (opp: BackrunOpportunity) => void;
        }
    ): void {
        // Fee decay tracking
        this.feeDecay.trackUpdate(
            poolPubkey,
            state,
            slot,
            tokenMint,
            callbacks?.onFeeDecay
        );

        // Empty bin tracking
        this.emptyBin.trackActiveIdMove(
            poolPubkey,
            state,
            slot,
            tokenMint,
            callbacks?.onBackrun
        );
    }

    /**
     * Get all active opportunities
     */
    getAllOpportunities(): {
        feeDecay: FeeDecayOpportunity[];
        backrun: BackrunOpportunity[];
    } {
        return {
            feeDecay: this.feeDecay.getOpportunities(),
            backrun: this.emptyBin.getOpportunities(),
        };
    }

    /**
     * Get combined stats
     */
    getStats() {
        return {
            feeDecay: this.feeDecay.getStats(),
            emptyBin: this.emptyBin.getStats(),
        };
    }

    /**
     * Log periodic summary
     */
    logSummary(): void {
        const stats = this.getStats();
        const opps = this.getAllOpportunities();

        console.log(
            `[METEORA_EDGE] 📈 FeeDecay: spikes=${stats.feeDecay.spikesDetected} ` +
            `pending=${stats.feeDecay.pendingRechecks} opps=${opps.feeDecay.length} stale=${stats.feeDecay.staleRechecks} | ` +
            `EmptyBin: moves=${stats.emptyBin.movesDetected} large=${stats.emptyBin.largeMoves} ` +
            `opps=${opps.backrun.length}`
        );
    }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

export const meteoraEdge = new MeteoraEdgeManager();

export default {
    MeteoraEdgeManager,
    FeeDecayTracker,
    EmptyBinDetector,
    meteoraEdge,
};