// src/brain/opportunityScanner.ts
// In-memory opportunity scanner - NO disk I/O in hot path
// Triggers on vault balance updates, fires Jito bundles
// CORRECTED FEES (Dec 2024)

import { EventEmitter } from "events";

// =============================================================================
// CORRECTED FEE CONSTANTS (Verified Dec 2024)
// =============================================================================
// PumpSwap: 0.30% total (0.20% LP + 0.05% protocol + 0.05% creator)
// Raydium V4: 0.25% (0.22% LP + 0.03% RAY buybacks)
// Meteora: DYNAMIC - must be passed per-pool (no default guessing)

const PUMPSWAP_FEE = 0.0030;  // CORRECTED: 0.30% (was 0.0025)
const RAYDIUM_FEE = 0.0025;   // 0.25%

// NOTE: We do NOT use any default Meteora fee in execution logic.
// This value is only surfaced in getStats() for informational purposes.
const DEFAULT_METEORA_FEE = 0.0;

// Minimum profit threshold to consider execution
const MIN_NET_PROFIT_BPS = 50;  // 0.5% net profit minimum

export interface PricePoint {
    venue: "PumpSwap" | "Raydium" | "Meteora";
    poolPubkey: string;
    priceInSol: number;  // Always normalized to SOL
    quoteType: "SOL" | "USDC" | "USDT";
    fee: number;         // Exact fee for this pool (0.003 = 0.30%)
    slot: bigint;
    timestamp: number;
}

export interface ArbitrageOpportunity {
    tokenMint: string;
    buyVenue: PricePoint;
    sellVenue: PricePoint;
    spreadBps: number;      // Gross spread in basis points
    netProfitBps: number;   // After fees
    totalFeeBps: number;    // Combined fees
    timestamp: number;
}

export interface ExecutionRequest {
    opportunity: ArbitrageOpportunity;
    inputAmountLamports: bigint;
    expectedOutputLamports: bigint;
    minOutputLamports: bigint;  // With slippage
    priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}

/**
 * OpportunityScanner - In-memory arbitrage detection
 * 
 * Architecture:
 * - Maintains price maps per token mint
 * - Updates on every vault balance change
 * - Emits 'opportunity' events when profitable arb detected
 * - Zero disk I/O in hot path
 * 
 * Integration points:
 * - Input: Called from ingest.ts on vault balance updates
 * - Output: Emits ExecutionRequest to JitoExecutor
 */
export class OpportunityScanner extends EventEmitter {
    // Token mint -> venue -> latest price
    private pricesByToken: Map<string, Map<string, PricePoint>> = new Map();

    // Pool pubkey -> token mint (reverse lookup)
    private poolToToken: Map<string, string> = new Map();

    // Graduated tokens (from PumpSwap)
    private graduatedMints: Set<string> = new Set();

    // Stats
    private scanCount = 0;
    private opportunityCount = 0;
    private lastOpportunityTime = 0;

    // SOL price for stablecoin conversion (should be updated from oracle)
    private solPriceUsd = 150;  // Default, update via setSolPrice()

    constructor() {
        super();
    }

    /**
     * Register a graduated token from PumpSwap
     * Must be called when PumpSwap pool is detected
     */
    registerGraduatedToken(tokenMint: string): void {
        this.graduatedMints.add(tokenMint);
    }

    /**
     * Update SOL/USD price for stablecoin conversion
     * Should be called periodically from a price oracle
     */
    setSolPrice(priceUsd: number): void {
        this.solPriceUsd = priceUsd;
    }

    /**
     * Get the default fee for a venue
     * For Meteora, you MUST pass the exact fee via baseFee in registerPool.
     */
    private getDefaultFee(venue: "PumpSwap" | "Raydium" | "Meteora"): number {
        switch (venue) {
            case "PumpSwap":
                return PUMPSWAP_FEE;
            case "Raydium":
                return RAYDIUM_FEE;
            case "Meteora":
                // We never rely on this in execution; Meteora requires explicit per-pool fee.
                return DEFAULT_METEORA_FEE;
        }
    }

    /**
     * Register a pool for a token
     * Must be called when pool is discovered
     * 
     * @param poolPubkey - Pool address
     * @param tokenMint - Token mint address
     * @param venue - Which DEX
     * @param quoteType - Quote token type
     * @param baseFee - EXACT fee for this pool (required for Meteora, optional for others)
     */
    registerPool(
        poolPubkey: string,
        tokenMint: string,
        venue: "PumpSwap" | "Raydium" | "Meteora",
        quoteType: "SOL" | "USDC" | "USDT",
        baseFee?: number
    ): void {
        this.poolToToken.set(poolPubkey, tokenMint);

        // Initialize price map for token if needed
        if (!this.pricesByToken.has(tokenMint)) {
            this.pricesByToken.set(tokenMint, new Map());
        }

        // Determine fee:
        // - PumpSwap / Raydium: use corrected constants unless explicitly overridden.
        // - Meteora: MUST have baseFee; otherwise we skip the pool entirely. No guessing.
        let fee: number;

        if (venue === "Meteora") {
            if (baseFee === undefined) {
                console.warn(
                    `[OpportunityScanner] Skipping Meteora pool ${poolPubkey.slice(
                        0,
                        8
                    )} – exact fee is required (no default used).`
                );
                return;
            }
            fee = baseFee;
        } else {
            fee = baseFee ?? this.getDefaultFee(venue);
        }

        const priceMap = this.pricesByToken.get(tokenMint)!;
        priceMap.set(venue, {
            venue,
            poolPubkey,
            priceInSol: 0,
            quoteType,
            fee,
            slot: BigInt(0),
            timestamp: 0
        });
    }

    /**
     * Update the fee for a registered pool
     * Use when Meteora pool fee changes or is initially unknown
     */
    updatePoolFee(poolPubkey: string, newFee: number): void {
        const tokenMint = this.poolToToken.get(poolPubkey);
        if (!tokenMint) return;

        const priceMap = this.pricesByToken.get(tokenMint);
        if (!priceMap) return;

        for (const point of priceMap.values()) {
            if (point.poolPubkey === poolPubkey) {
                point.fee = newFee;
                break;
            }
        }
    }

    /**
     * Update price for a pool
     * Called on every vault balance update
     * This is the HOT PATH - no blocking operations
     */
    updatePrice(
        poolPubkey: string,
        priceInQuote: number,
        slot: bigint
    ): ArbitrageOpportunity | null {
        this.scanCount++;

        const tokenMint = this.poolToToken.get(poolPubkey);
        if (!tokenMint) return null;

        // Only scan graduated tokens
        if (!this.graduatedMints.has(tokenMint)) return null;

        const priceMap = this.pricesByToken.get(tokenMint);
        if (!priceMap) return null;

        // Find which venue this pool belongs to
        let targetVenue: PricePoint | null = null;
        for (const point of priceMap.values()) {
            if (point.poolPubkey === poolPubkey) {
                targetVenue = point;
                break;
            }
        }
        if (!targetVenue) return null;

        // Convert to SOL-denominated price
        let priceInSol: number;
        if (targetVenue.quoteType === "SOL") {
            priceInSol = priceInQuote;
        } else {
            // Stablecoin - convert to SOL
            priceInSol = priceInQuote / this.solPriceUsd;
        }

        // Update price point
        targetVenue.priceInSol = priceInSol;
        targetVenue.slot = slot;
        targetVenue.timestamp = Date.now();

        // Scan for opportunities
        return this.scanForOpportunity(tokenMint);
    }

    /**
     * Scan all venues for a token to find arbitrage
     * Returns opportunity if profitable, null otherwise
     */
    private scanForOpportunity(tokenMint: string): ArbitrageOpportunity | null {
        const priceMap = this.pricesByToken.get(tokenMint);
        if (!priceMap || priceMap.size < 2) return null;

        // Get all valid prices
        const prices: PricePoint[] = [];
        for (const point of priceMap.values()) {
            if (point.priceInSol > 0 && point.timestamp > 0) {
                prices.push(point);
            }
        }

        if (prices.length < 2) return null;

        // Find best buy (lowest price) and best sell (highest price)
        let bestBuy: PricePoint = prices[0]!;
        let bestSell: PricePoint = prices[0]!;

        for (const p of prices) {
            if (p.priceInSol < bestBuy.priceInSol) bestBuy = p;
            if (p.priceInSol > bestSell.priceInSol) bestSell = p;
        }

        // Same venue = no opportunity
        if (bestBuy.venue === bestSell.venue) return null;

        // Calculate spread
        const spread = (bestSell.priceInSol - bestBuy.priceInSol) / bestBuy.priceInSol;
        const spreadBps = Math.round(spread * 10000);

        // Calculate net profit after fees (using exact fees from each pool)
        const totalFees = bestBuy.fee + bestSell.fee;
        const totalFeeBps = Math.round(totalFees * 10000);
        const netProfit = spread - totalFees;
        const netProfitBps = Math.round(netProfit * 10000);

        // Check minimum threshold
        if (netProfitBps < MIN_NET_PROFIT_BPS) return null;

        // Create opportunity with explicit copies
        const opportunity: ArbitrageOpportunity = {
            tokenMint,
            buyVenue: {
                venue: bestBuy.venue,
                poolPubkey: bestBuy.poolPubkey,
                priceInSol: bestBuy.priceInSol,
                quoteType: bestBuy.quoteType,
                fee: bestBuy.fee,
                slot: bestBuy.slot,
                timestamp: bestBuy.timestamp
            },
            sellVenue: {
                venue: bestSell.venue,
                poolPubkey: bestSell.poolPubkey,
                priceInSol: bestSell.priceInSol,
                quoteType: bestSell.quoteType,
                fee: bestSell.fee,
                slot: bestSell.slot,
                timestamp: bestSell.timestamp
            },
            spreadBps,
            totalFeeBps,
            netProfitBps,
            timestamp: Date.now()
        };

        this.opportunityCount++;
        this.lastOpportunityTime = Date.now();

        // Emit for execution
        this.emit("opportunity", opportunity);

        return opportunity;
    }

    /**
     * Create execution request from opportunity
     * Calculates amounts and slippage
     */
    createExecutionRequest(
        opportunity: ArbitrageOpportunity,
        inputSol: number,
        slippageBps: number = 50  // 0.5% default slippage
    ): ExecutionRequest {
        const inputLamports = BigInt(Math.floor(inputSol * 1e9));

        // Expected output after arb
        const netMultiplier = 1 + (opportunity.netProfitBps / 10000);

        const expectedOutputLamports = BigInt(Math.floor(inputSol * netMultiplier * 1e9));
        const minOutputLamports = BigInt(Math.floor(
            inputSol * netMultiplier * (1 - slippageBps / 10000) * 1e9
        ));

        // Determine priority based on profit
        let priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
        if (opportunity.netProfitBps >= 200) priority = "CRITICAL";  // 2%+
        else if (opportunity.netProfitBps >= 100) priority = "HIGH"; // 1%+
        else if (opportunity.netProfitBps >= 75) priority = "MEDIUM";
        else priority = "LOW";

        return {
            opportunity,
            inputAmountLamports: inputLamports,
            expectedOutputLamports,
            minOutputLamports,
            priority
        };
    }

    /**
     * Get scanner stats
     */
    getStats(): {
        scanCount: number;
        opportunityCount: number;
        trackedTokens: number;
        trackedPools: number;
        lastOpportunityAge: number | null;
        fees: {
            pumpswap: number;
            raydium: number;
            meteoraDefault: number;
        };
    } {
        return {
            scanCount: this.scanCount,
            opportunityCount: this.opportunityCount,
            trackedTokens: this.pricesByToken.size,
            trackedPools: this.poolToToken.size,
            lastOpportunityAge: this.lastOpportunityTime > 0
                ? Date.now() - this.lastOpportunityTime
                : null,
            fees: {
                pumpswap: PUMPSWAP_FEE,
                raydium: RAYDIUM_FEE,
                // 0 here signals "no default – Meteora fees are per-pool only".
                meteoraDefault: DEFAULT_METEORA_FEE
            }
        };
    }

    /**
     * Reset stats (for testing/monitoring)
     */
    resetStats(): void {
        this.scanCount = 0;
        this.opportunityCount = 0;
    }
}

// Export fee constants for other modules
export const PUMPSWAP_FEE_RATE = PUMPSWAP_FEE;
export const RAYDIUM_FEE_RATE = RAYDIUM_FEE;

/**
 * Example integration with ingest.ts:
 * 
 * const scanner = new OpportunityScanner();
 * 
 * // On PumpSwap pool discovery:
 * scanner.registerGraduatedToken(tokenMint);
 * scanner.registerPool(poolPubkey, tokenMint, "PumpSwap", "SOL");
 * // Fee is automatic: 0.30%
 * 
 * // On Raydium pool discovery:
 * scanner.registerPool(poolPubkey, tokenMint, "Raydium", "SOL");
 * // Fee is automatic: 0.25%
 * 
 * // On Meteora pool discovery - PROVIDE EXACT FEE:
 * const meteoraFee = computeMeteoraFeeFromState(meteoraState); // e.g. 0.0075
 * scanner.registerPool(poolPubkey, tokenMint, "Meteora", "SOL", meteoraFee);
 * 
 * // On vault balance update:
 * const opp = scanner.updatePrice(vaultPubkey, calculatedPrice, slot);
 * if (opp) {
 *     console.log(`[OPPORTUNITY] ${opp.netProfitBps}bps on ${opp.tokenMint}`);
 *     // Trigger Jito execution
 * }
 * 
 * // Listen for opportunities
 * scanner.on("opportunity", (opp: ArbitrageOpportunity) => {
 *     const exec = scanner.createExecutionRequest(opp, 0.1);  // 0.1 SOL
 *     jitoExecutor.submit(exec);
 * });
 */

export default OpportunityScanner;
