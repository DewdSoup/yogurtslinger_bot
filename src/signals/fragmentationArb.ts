// src/signals/fragmentationArb.ts
// FragmentationArbDetector: Spot price-based arbitrage detection
// 
// v3 FIX (Dec 2024):
// - ✅ CRITICAL: Fixed Meteora DLMM price calculation
//   - Was using reserve ratios (WRONG for concentrated liquidity)
//   - Now uses computeMeteoraPrice(activeId, binStep, decX, decY) from meteora.ts
// - ✅ CRITICAL: Fixed Raydium CLMM price calculation
//   - Was using reserve ratios (WRONG for concentrated liquidity)
//   - Now uses sqrtPriceX64 for accurate price derivation
// - ✅ Added deduplication to prevent thousands of duplicate detections
// - ✅ Use isSolMint() to check BOTH wrapped SOL and native SOL
//
// SIMGATE ARCHITECTURE: This is the detection layer only.
// - Uses spot prices for quick filtering
// - NO RPC calls (zero latency)
// - NO profit simulation (that's SimGate's job)
//
// VENUES SUPPORTED:
//   - PumpSwap (CPMM) - Reserve ratio pricing ✓
//   - Raydium V4 (CPMM) - Reserve ratio pricing ✓
//   - Raydium CLMM (Concentrated Liquidity) - sqrtPriceX64 pricing ✓
//   - Meteora DLMM (Concentrated Liquidity) - activeId/binStep pricing ✓

import { MarketCache } from "../brain/marketCache.js";
import { computeMeteoraPrice } from "../decoders/meteora.js";

// ============================================================================
// TYPES
// ============================================================================

export type VenueName = "PumpSwap" | "Raydium" | "RaydiumCLMM" | "Meteora";

export interface ArbSignal {
    tokenMint: string;
    buyVenue: VenueName;
    sellVenue: VenueName;
    buyPrice: number;
    sellPrice: number;
    grossSpreadBps: number;
    estimatedNetSpreadBps: number;
    buyPoolPubkey: string;
    sellPoolPubkey: string;
    detectedAt: number;
}

interface VenuePrice {
    venue: VenueName;
    price: number;
    pubkey: string;
    feeRate: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const SOL_MINT = "So11111111111111111111111111111111111111112";
const NATIVE_SOL_MINT = "11111111111111111111111111111111";

// Decimal constants
const SOL_DECIMALS = 9;
const MEMECOIN_DECIMALS = 6;  // Pump.fun standard

// Deduplication: minimum ms between detections for same token
const DEDUP_WINDOW_MS = 100;

// ✅ Check both wrapped and native SOL
function isSolMint(mint: string): boolean {
    return mint === SOL_MINT || mint === NATIVE_SOL_MINT;
}

// Default fee rates for spread estimation
const DEFAULT_FEES: Record<VenueName, number> = {
    PumpSwap: 0.0030,      // 0.30% (verified Dec 2024)
    Raydium: 0.0025,       // 0.25%
    RaydiumCLMM: 0.0025,   // 0.25% (varies by AmmConfig)
    Meteora: 0.003,        // 0.3% (dynamic, use state.totalFeeRate when available)
};

// ============================================================================
// DETECTOR CLASS
// ============================================================================

export class FragmentationArbDetector {
    private readonly cache: MarketCache;
    private readonly minSpreadBps: number;

    // Deduplication: track last detection time per token
    private readonly lastDetectionTs = new Map<string, number>();

    /**
     * @param cache MarketCache instance for pool data
     * @param _connection Unused - kept for API compatibility (SimGate handles RPC)
     * @param minSpreadBps Minimum spread in bps to consider (default: 55)
     * @param _bulletSizeSol Unused - kept for API compatibility (SimGate handles sizing)
     */
    constructor(
        cache: MarketCache,
        _connection: unknown,
        minSpreadBps: number = 55,
        _bulletSizeSol: number = 0.1
    ) {
        this.cache = cache;
        this.minSpreadBps = minSpreadBps;
        // _connection and _bulletSizeSol are intentionally unused
        // SimGate architecture handles RPC simulation and trade sizing
    }

    /**
     * Detect arbitrage opportunities across all fragmented tokens.
     * Returns signals for tokens with positive spread after fees.
     * Includes deduplication to prevent spam.
     */
    async detectArbs(): Promise<ArbSignal[]> {
        const signals: ArbSignal[] = [];
        const fragmented = this.cache.getFragmentedTokens();
        const tokenAccountCache = this.cache.getTokenAccountCache();
        const now = Date.now();

        for (const [tokenMint, venues] of fragmented) {
            // ✅ DEDUPLICATION: Skip if we detected this token recently
            const lastTs = this.lastDetectionTs.get(tokenMint);
            if (lastTs && now - lastTs < DEDUP_WINDOW_MS) {
                continue;
            }

            const prices: VenuePrice[] = [];

            // Get PumpSwap price (CPMM - reserve ratio is correct)
            if (venues.pumpSwap) {
                const price = this.getPumpSwapPrice(venues.pumpSwap, tokenAccountCache);
                if (price !== null) {
                    prices.push({
                        venue: "PumpSwap",
                        price,
                        pubkey: venues.pumpSwap.pubkey,
                        feeRate: DEFAULT_FEES.PumpSwap,
                    });
                }
            }

            // Get Raydium V4 price (CPMM - reserve ratio is correct)
            if (venues.raydiumV4) {
                const price = this.getRaydiumPrice(venues.raydiumV4, tokenAccountCache);
                if (price !== null) {
                    prices.push({
                        venue: "Raydium",
                        price,
                        pubkey: venues.raydiumV4.pubkey,
                        feeRate: DEFAULT_FEES.Raydium,
                    });
                }
            }

            // Get Raydium CLMM price (Concentrated - use sqrtPriceX64)
            if (venues.raydiumClmm) {
                const price = this.getRaydiumCLMMPrice(venues.raydiumClmm);
                if (price !== null) {
                    prices.push({
                        venue: "RaydiumCLMM",
                        price,
                        pubkey: venues.raydiumClmm.pubkey,
                        feeRate: DEFAULT_FEES.RaydiumCLMM,
                    });
                }
            }

            // Get Meteora price (DLMM - use activeId/binStep)
            if (venues.meteora) {
                const price = this.getMeteoraPrice(venues.meteora);
                if (price !== null) {
                    prices.push({
                        venue: "Meteora",
                        price,
                        pubkey: venues.meteora.pubkey,
                        feeRate: venues.meteora.state.totalFeeRate ?? DEFAULT_FEES.Meteora,
                    });
                }
            }

            // Need at least 2 venues with prices
            if (prices.length < 2) continue;

            // Find best arb opportunity
            const signal = this.findBestArb(tokenMint, prices);
            if (signal && signal.estimatedNetSpreadBps >= this.minSpreadBps) {
                // ✅ DEDUPLICATION: Update last detection time
                this.lastDetectionTs.set(tokenMint, now);
                signals.push(signal);
            }
        }

        // Periodic cleanup of old dedup entries (every 1000 calls)
        if (Math.random() < 0.001) {
            this.cleanupDedupMap(now);
        }

        return signals;
    }

    /**
     * Detect arbitrage for a specific token.
     * Used for targeted rescans (e.g., when Meteora fees drop).
     * Includes deduplication.
     */
    async detectArbForToken(tokenMint: string): Promise<ArbSignal | null> {
        const now = Date.now();

        // ✅ DEDUPLICATION: Skip if we detected this token recently
        const lastTs = this.lastDetectionTs.get(tokenMint);
        if (lastTs && now - lastTs < DEDUP_WINDOW_MS) {
            return null;
        }

        const fragmented = this.cache.getFragmentedTokens();
        const venues = fragmented.get(tokenMint);

        if (!venues) return null;

        const tokenAccountCache = this.cache.getTokenAccountCache();
        const prices: VenuePrice[] = [];

        // Collect prices from all available venues
        if (venues.pumpSwap) {
            const price = this.getPumpSwapPrice(venues.pumpSwap, tokenAccountCache);
            if (price !== null) {
                prices.push({
                    venue: "PumpSwap",
                    price,
                    pubkey: venues.pumpSwap.pubkey,
                    feeRate: DEFAULT_FEES.PumpSwap,
                });
            }
        }

        if (venues.raydiumV4) {
            const price = this.getRaydiumPrice(venues.raydiumV4, tokenAccountCache);
            if (price !== null) {
                prices.push({
                    venue: "Raydium",
                    price,
                    pubkey: venues.raydiumV4.pubkey,
                    feeRate: DEFAULT_FEES.Raydium,
                });
            }
        }

        if (venues.raydiumClmm) {
            const price = this.getRaydiumCLMMPrice(venues.raydiumClmm);
            if (price !== null) {
                prices.push({
                    venue: "RaydiumCLMM",
                    price,
                    pubkey: venues.raydiumClmm.pubkey,
                    feeRate: DEFAULT_FEES.RaydiumCLMM,
                });
            }
        }

        if (venues.meteora) {
            const price = this.getMeteoraPrice(venues.meteora);
            if (price !== null) {
                prices.push({
                    venue: "Meteora",
                    price,
                    pubkey: venues.meteora.pubkey,
                    feeRate: venues.meteora.state.totalFeeRate ?? DEFAULT_FEES.Meteora,
                });
            }
        }

        if (prices.length < 2) return null;

        const signal = this.findBestArb(tokenMint, prices);
        if (signal && signal.estimatedNetSpreadBps >= this.minSpreadBps) {
            // ✅ DEDUPLICATION: Update last detection time
            this.lastDetectionTs.set(tokenMint, now);
            return signal;
        }

        return null;
    }

    // ========================================================================
    // PRICE EXTRACTION - CPMM (PumpSwap, Raydium V4)
    // Reserve ratio pricing is CORRECT for constant product AMMs
    // ========================================================================

    private getPumpSwapPrice(
        entry: NonNullable<ReturnType<MarketCache["getFragmentedTokens"]> extends Map<string, infer V> ? V : never>["pumpSwap"],
        tokenAccountCache: ReturnType<MarketCache["getTokenAccountCache"]>
    ): number | null {
        if (!entry) return null;

        const baseVault = entry.state.poolBaseTokenAccount.toBase58();
        const quoteVault = entry.state.poolQuoteTokenAccount.toBase58();

        const baseBalance = tokenAccountCache.getBalance(baseVault);
        const quoteBalance = tokenAccountCache.getBalance(quoteVault);

        if (baseBalance === undefined || quoteBalance === undefined) {
            return null;
        }

        if (baseBalance === 0n || quoteBalance === 0n) return null;

        const baseMint = entry.state.baseMint.toBase58();
        const quoteMint = entry.state.quoteMint.toBase58();

        // CPMM: Price = Reserve_SOL / Reserve_Token (in lamports, so decimals cancel)
        if (isSolMint(quoteMint)) {
            // Quote is SOL, Base is Token → Price = SOL / Token
            return Number(quoteBalance) / Number(baseBalance);
        } else if (isSolMint(baseMint)) {
            // Base is SOL, Quote is Token → Price = SOL / Token
            return Number(baseBalance) / Number(quoteBalance);
        }

        return null;
    }

    private getRaydiumPrice(
        entry: NonNullable<ReturnType<MarketCache["getFragmentedTokens"]> extends Map<string, infer V> ? V : never>["raydiumV4"],
        tokenAccountCache: ReturnType<MarketCache["getTokenAccountCache"]>
    ): number | null {
        if (!entry) return null;

        const baseVault = entry.state.baseVault?.toBase58();
        const quoteVault = entry.state.quoteVault?.toBase58();

        if (!baseVault || !quoteVault) return null;

        const baseBalance = tokenAccountCache.getBalance(baseVault);
        const quoteBalance = tokenAccountCache.getBalance(quoteVault);

        if (baseBalance === undefined || quoteBalance === undefined) {
            return null;
        }

        if (baseBalance === 0n || quoteBalance === 0n) return null;

        const baseMint = entry.state.baseMint.toBase58();
        const quoteMint = entry.state.quoteMint.toBase58();

        // CPMM: Price = Reserve_SOL / Reserve_Token
        if (isSolMint(quoteMint)) {
            return Number(quoteBalance) / Number(baseBalance);
        } else if (isSolMint(baseMint)) {
            return Number(baseBalance) / Number(quoteBalance);
        }

        return null;
    }

    // ========================================================================
    // PRICE EXTRACTION - CLMM (Raydium Concentrated Liquidity)
    // ✅ FIX: Use sqrtPriceX64 instead of reserve ratios
    // Formula: price = (sqrtPriceX64 / 2^64)^2
    // ========================================================================

    private getRaydiumCLMMPrice(
        entry: NonNullable<ReturnType<MarketCache["getFragmentedTokens"]> extends Map<string, infer V> ? V : never>["raydiumClmm"]
    ): number | null {
        if (!entry) return null;

        // Skip inactive pools
        if (entry.state.status !== 0) return null;

        const mint0 = entry.state.tokenMint0.toBase58();
        const mint1 = entry.state.tokenMint1.toBase58();

        // Validate it's a SOL pair
        const mint0IsSol = isSolMint(mint0);
        const mint1IsSol = isSolMint(mint1);
        if (!mint0IsSol && !mint1IsSol) return null;

        // ✅ CORRECT: Derive price from sqrtPriceX64
        // sqrtPriceX64 = sqrt(price) * 2^64
        // price = (sqrtPriceX64 / 2^64)^2
        // This gives price of token1 in terms of token0
        const sqrtPriceX64 = entry.state.sqrtPriceX64;
        if (!sqrtPriceX64 || sqrtPriceX64 === 0n) return null;

        const Q64 = 2n ** 64n;

        // Use floating point for the final calculation to avoid BigInt precision issues
        const sqrtPriceFloat = Number(sqrtPriceX64) / Number(Q64);
        const priceRatio = sqrtPriceFloat * sqrtPriceFloat;

        if (priceRatio <= 0 || !isFinite(priceRatio)) return null;

        // priceRatio = price of token1 in terms of token0 (without decimal adjustment)
        // For SOL/Token pairs, we need SOL per Token

        // Decimal adjustment: multiply by 10^(dec0 - dec1)
        // This converts raw price to human-readable price
        const dec0 = mint0IsSol ? SOL_DECIMALS : MEMECOIN_DECIMALS;
        const dec1 = mint1IsSol ? SOL_DECIMALS : MEMECOIN_DECIMALS;
        const decimalAdjustment = Math.pow(10, dec0 - dec1);

        const adjustedPrice = priceRatio * decimalAdjustment;

        if (mint0IsSol && !mint1IsSol) {
            // mint0=SOL, mint1=Token
            // priceRatio (adjusted) = Token per SOL
            // We want SOL per Token = 1 / priceRatio
            if (adjustedPrice <= 0) return null;
            return 1 / adjustedPrice;
        } else if (mint1IsSol && !mint0IsSol) {
            // mint0=Token, mint1=SOL
            // priceRatio (adjusted) = SOL per Token ✓
            return adjustedPrice;
        }

        return null;
    }

    // ========================================================================
    // PRICE EXTRACTION - DLMM (Meteora Discrete Liquidity)
    // ✅ FIX: Use activeId/binStep instead of reserve ratios
    // Formula: price = (1 + binStep/10000)^activeId × 10^(decX - decY)
    // ========================================================================

    private getMeteoraPrice(
        entry: NonNullable<ReturnType<MarketCache["getFragmentedTokens"]> extends Map<string, infer V> ? V : never>["meteora"]
    ): number | null {
        if (!entry) return null;

        // Skip disabled pools
        if (entry.state.status !== 0) return null;

        const tokenXMint = entry.state.tokenXMint.toBase58();
        const tokenYMint = entry.state.tokenYMint.toBase58();

        // Validate it's a SOL pair
        const xIsSol = isSolMint(tokenXMint);
        const yIsSol = isSolMint(tokenYMint);
        if (!xIsSol && !yIsSol) return null;

        // Get activeId and binStep from pool state
        const activeId = entry.state.activeId;
        const binStep = entry.state.binStep;

        // Validate parameters
        if (binStep <= 0 || binStep > 500) return null;
        if (activeId < -100000 || activeId > 100000) return null;

        // ✅ CORRECT: Use computeMeteoraPrice from meteora.ts
        // computeMeteoraPrice returns: (1 + binStep/10000)^binId × 10^(decX - decY)
        // This gives "Y per X" (how many Y tokens per 1 X token)

        // Determine decimals based on which side is SOL
        // X = first token, Y = second token in Meteora's convention
        const decX = xIsSol ? SOL_DECIMALS : MEMECOIN_DECIMALS;
        const decY = yIsSol ? SOL_DECIMALS : MEMECOIN_DECIMALS;

        // computeMeteoraPrice(binId, binStep, tokenXDecimals, tokenYDecimals)
        const priceYPerX = computeMeteoraPrice(activeId, binStep, decX, decY);

        if (priceYPerX <= 0 || !isFinite(priceYPerX)) return null;

        // Convert to "SOL per Token" which is our standard price format
        if (yIsSol && !xIsSol) {
            // X=Token, Y=SOL
            // priceYPerX = SOL per Token ✓ (exactly what we want)
            return priceYPerX;
        } else if (xIsSol && !yIsSol) {
            // X=SOL, Y=Token
            // priceYPerX = Token per SOL
            // We want SOL per Token = 1 / priceYPerX
            return 1 / priceYPerX;
        }

        return null;
    }

    // ========================================================================
    // ARB FINDING
    // ========================================================================

    private findBestArb(tokenMint: string, prices: VenuePrice[]): ArbSignal | null {
        if (prices.length < 2) return null;

        // Sort by price (ascending)
        const sorted = [...prices].sort((a, b) => a.price - b.price);

        // Best arb: buy at lowest, sell at highest
        const buyVenue = sorted[0]!;
        const sellVenue = sorted[sorted.length - 1]!;

        if (buyVenue.price <= 0 || sellVenue.price <= 0) return null;
        if (buyVenue.price >= sellVenue.price) return null;

        // Calculate spreads
        const grossSpread = (sellVenue.price - buyVenue.price) / buyVenue.price;
        const grossSpreadBps = Math.round(grossSpread * 10000);

        // Sanity check: reject impossible spreads (> 1000% likely indicates a bug)
        if (grossSpreadBps > 100000) {
            // Log for debugging but don't emit signal
            console.warn(
                `[fragArb] Rejecting impossible spread: ${tokenMint.slice(0, 8)}... ` +
                `${buyVenue.venue}=${buyVenue.price.toExponential(4)} → ` +
                `${sellVenue.venue}=${sellVenue.price.toExponential(4)} = ${grossSpreadBps}bps`
            );
            return null;
        }

        // Subtract fees
        const totalFeeRate = buyVenue.feeRate + sellVenue.feeRate;
        const totalFeeBps = Math.round(totalFeeRate * 10000);
        const estimatedNetSpreadBps = grossSpreadBps - totalFeeBps;

        return {
            tokenMint,
            buyVenue: buyVenue.venue,
            sellVenue: sellVenue.venue,
            buyPrice: buyVenue.price,
            sellPrice: sellVenue.price,
            grossSpreadBps,
            estimatedNetSpreadBps,
            buyPoolPubkey: buyVenue.pubkey,
            sellPoolPubkey: sellVenue.pubkey,
            detectedAt: Date.now(),
        };
    }

    // ========================================================================
    // DEDUPLICATION CLEANUP
    // ========================================================================

    private cleanupDedupMap(now: number): void {
        const staleThreshold = 60000; // 1 minute
        for (const [tokenMint, ts] of this.lastDetectionTs) {
            if (now - ts > staleThreshold) {
                this.lastDetectionTs.delete(tokenMint);
            }
        }
    }

    /**
     * Get deduplication stats (for debugging)
     */
    getDedupStats(): { trackedTokens: number } {
        return { trackedTokens: this.lastDetectionTs.size };
    }

    /**
     * Clear deduplication map (for testing)
     */
    clearDedupMap(): void {
        this.lastDetectionTs.clear();
    }
}

export default FragmentationArbDetector;