// src/arb/fractureArbScanner.ts
//
// PumpSwap Fracture Arbitrage Scanner
//
// Detects when PumpSwap tokens migrate to secondary DEXes and
// captures cross-DEX arbitrage opportunities in the retail-heavy
// memecoin market.
//
// Strategy:
// 1. Track all PumpSwap pools and their mints
// 2. Detect "fracture" events (mint appears on Raydium/Meteora)
// 3. Compare prices across venues
// 4. Execute profitable arbs via Jito bundles

import { EventEmitter } from "events";
import type { PubkeyStr, InMemoryAccountStore } from "../state/accountStore";
import type { HotPathCache } from "../state/hotPathCache";
import { CrossDexIndex, type CrossDexOpportunity, type PoolInfo } from "./crossDexIndex";
import { PriceQuoter } from "./priceQuoter";

// Pool decoders
import { decodePumpSwapPool } from "../decoders/pumpswapPool";
import { decodeRaydiumV4Pool } from "../decoders/raydiumV4Pool";
import { decodeRaydiumClmmPool } from "../decoders/raydiumCLMMPool";
import { decodeMeteoraLbPair } from "../decoders/meteoraLbPair";

// Discriminators for account type detection
const PUMPSWAP_POOL_DISC = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
const RAYDIUM_V4_SIZE = 752;
const CLMM_POOL_DISC = Buffer.from("f7ede3f5d7c3de46", "hex");
const DLMM_LB_PAIR_DISC = Buffer.from("210b3162b565b10d", "hex");

// WSOL mint
const WSOL_MINT = "So11111111111111111111111111111111111111112";

export interface FractureArbConfig {
    /** Minimum spread in basis points to consider (default: 50 = 0.5%) */
    minSpreadBps: number;
    /** Probe amount in lamports for price quotes (default: 0.1 SOL) */
    probeAmountLamports: bigint;
    /** Maximum position size in lamports */
    maxPositionLamports: bigint;
    /** Jito tip in lamports */
    jitoTipLamports: bigint;
    /** Scan interval in ms */
    scanIntervalMs: number;
}

export const DEFAULT_FRACTURE_CONFIG: FractureArbConfig = {
    minSpreadBps: 50, // 0.5% minimum
    probeAmountLamports: BigInt(100_000_000), // 0.1 SOL
    maxPositionLamports: BigInt(500_000_000), // 0.5 SOL max
    jitoTipLamports: BigInt(1_000_000), // 0.001 SOL tip
    scanIntervalMs: 100, // 100ms scan interval
};

export interface ArbOpportunity extends CrossDexOpportunity {
    /** Optimal input amount in lamports */
    optimalInputLamports: bigint;
    /** Expected output in lamports */
    expectedOutputLamports: bigint;
    /** Expected profit after fees and tip */
    expectedProfitLamports: bigint;
}

export class FractureArbScanner extends EventEmitter {
    private config: FractureArbConfig;
    private index: CrossDexIndex;
    private quoter: PriceQuoter;
    private scanTimer: NodeJS.Timeout | null = null;
    private running = false;

    // Stats
    private stats = {
        poolsTracked: 0,
        fracturesDetected: 0,
        opportunitiesFound: 0,
        scansRun: 0,
        lastScanMs: 0,
    };

    constructor(
        store: InMemoryAccountStore,
        cache: HotPathCache,
        config: Partial<FractureArbConfig> = {}
    ) {
        super();
        this.config = { ...DEFAULT_FRACTURE_CONFIG, ...config };
        this.index = new CrossDexIndex();
        this.quoter = new PriceQuoter(store, cache);

        // Wire up fracture detection
        this.index.onFracture((mint, venue, pool) => {
            this.stats.fracturesDetected++;
            console.log(`[fracture] ${mint.slice(0, 12)}... appeared on ${venue}`);
            this.emit("fracture", { mint, venue, pool });

            // Immediately scan for arb
            this.scanMint(mint);
        });
    }

    /**
     * Process an account update.
     * Call this from gRPC subscription handler.
     */
    onAccountUpdate(pubkey: PubkeyStr, owner: PubkeyStr, data: Buffer, slot: number): void {
        const poolInfo = this.parsePoolAccount(pubkey, owner, data);
        if (!poolInfo) return;

        // Register in index
        this.index.registerPool(poolInfo);
        this.stats.poolsTracked = this.index.getStats().totalMints;

        // Update price
        const quote = this.quoter.quote(pubkey, this.config.probeAmountLamports, "buy");
        if (quote) {
            this.index.updatePrice(pubkey, quote.effectivePrice, slot);
        }
    }

    /**
     * Start scanning for opportunities.
     */
    start(): void {
        if (this.running) return;
        this.running = true;

        this.scanTimer = setInterval(() => {
            this.scan();
        }, this.config.scanIntervalMs);

        console.log(`[scanner] Started with ${this.config.minSpreadBps}bps min spread`);
        this.emit("started");
    }

    /**
     * Stop scanning.
     */
    stop(): void {
        this.running = false;
        if (this.scanTimer) {
            clearInterval(this.scanTimer);
            this.scanTimer = null;
        }
        this.emit("stopped");
    }

    /**
     * Run a single scan for opportunities.
     */
    scan(): ArbOpportunity[] {
        const startTime = performance.now();
        this.stats.scansRun++;

        const rawOpps = this.index.findOpportunities(this.config.minSpreadBps);

        // Enhance with execution details
        const enhanced: ArbOpportunity[] = [];

        for (const opp of rawOpps) {
            const detailed = this.enhanceOpportunity(opp);
            if (detailed && detailed.expectedProfitLamports > this.config.jitoTipLamports) {
                enhanced.push(detailed);
                this.stats.opportunitiesFound++;
                this.emit("opportunity", detailed);
            }
        }

        this.stats.lastScanMs = performance.now() - startTime;

        return enhanced;
    }

    /**
     * Scan a specific mint for opportunities.
     */
    scanMint(mint: PubkeyStr): ArbOpportunity | null {
        const pools = this.index.getPoolsForMint(mint);
        if (pools.length < 2) return null;

        // Find best arb pair
        let bestOpp: ArbOpportunity | null = null;

        for (let i = 0; i < pools.length; i++) {
            for (let j = i + 1; j < pools.length; j++) {
                const arb = this.quoter.compareArb(
                    pools[i]!.poolAddress,
                    pools[j]!.poolAddress,
                    this.config.probeAmountLamports
                );

                if (arb && arb.profitBps >= this.config.minSpreadBps) {
                    const opp: CrossDexOpportunity = {
                        mint,
                        buyVenue: pools[arb.buyPool === pools[i]!.poolAddress ? i : j]!.venue,
                        buyPool: arb.buyPool,
                        buyPrice: 0, // Will be filled by enhanceOpportunity
                        sellVenue: pools[arb.buyPool === pools[i]!.poolAddress ? j : i]!.venue,
                        sellPool: arb.sellPool,
                        sellPrice: 0,
                        spreadBps: arb.profitBps,
                        detectedAt: Date.now(),
                    };

                    const enhanced = this.enhanceOpportunity(opp);
                    if (enhanced && (!bestOpp || enhanced.expectedProfitLamports > bestOpp.expectedProfitLamports)) {
                        bestOpp = enhanced;
                    }
                }
            }
        }

        if (bestOpp) {
            this.emit("opportunity", bestOpp);
        }

        return bestOpp;
    }

    /**
     * Get current stats.
     */
    getStats() {
        return {
            ...this.stats,
            indexStats: this.index.getStats(),
        };
    }

    // ========================================================================
    // Private Methods
    // ========================================================================

    private parsePoolAccount(pubkey: PubkeyStr, owner: PubkeyStr, data: Buffer): PoolInfo | null {
        try {
            // PumpSwap
            if (data.length >= 8 && data.subarray(0, 8).equals(PUMPSWAP_POOL_DISC)) {
                const pool = decodePumpSwapPool(data);
                return {
                    venue: "pumpswap",
                    poolAddress: pubkey,
                    baseMint: pool.baseMint.toBase58(),
                    quoteMint: pool.quoteMint.toBase58(),
                    baseVault: pool.poolBaseTokenAccount.toBase58(),
                    quoteVault: pool.poolQuoteTokenAccount.toBase58(),
                };
            }

            // Raydium V4 (no discriminator, use size)
            if (data.length === RAYDIUM_V4_SIZE && owner === "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8") {
                const pool = decodeRaydiumV4Pool(data);
                // Determine which is base/quote (non-SOL vs SOL)
                const mint0 = pool.baseMint.toBase58();
                const mint1 = pool.quoteMint.toBase58();
                const isBase0Sol = mint0 === WSOL_MINT;

                return {
                    venue: "raydium_v4",
                    poolAddress: pubkey,
                    baseMint: isBase0Sol ? mint1 : mint0,
                    quoteMint: isBase0Sol ? mint0 : mint1,
                    baseVault: isBase0Sol ? pool.quoteVault.toBase58() : pool.baseVault.toBase58(),
                    quoteVault: isBase0Sol ? pool.baseVault.toBase58() : pool.quoteVault.toBase58(),
                };
            }

            // Raydium CLMM
            if (data.length >= 8 && data.subarray(0, 8).equals(CLMM_POOL_DISC)) {
                const pool = decodeRaydiumClmmPool(data);
                const mint0 = pool.tokenMint0.toBase58();
                const mint1 = pool.tokenMint1.toBase58();
                const isBase0Sol = mint0 === WSOL_MINT;

                return {
                    venue: "raydium_clmm",
                    poolAddress: pubkey,
                    baseMint: isBase0Sol ? mint1 : mint0,
                    quoteMint: isBase0Sol ? mint0 : mint1,
                    baseVault: isBase0Sol ? pool.tokenVault1.toBase58() : pool.tokenVault0.toBase58(),
                    quoteVault: isBase0Sol ? pool.tokenVault0.toBase58() : pool.tokenVault1.toBase58(),
                };
            }

            // Meteora DLMM
            if (data.length >= 8 && data.subarray(0, 8).equals(DLMM_LB_PAIR_DISC)) {
                const pair = decodeMeteoraLbPair(data);
                const mintX = pair.tokenXMint.toBase58();
                const mintY = pair.tokenYMint.toBase58();
                const isXSol = mintX === WSOL_MINT;

                return {
                    venue: "meteora_dlmm",
                    poolAddress: pubkey,
                    baseMint: isXSol ? mintY : mintX,
                    quoteMint: isXSol ? mintX : mintY,
                    baseVault: isXSol ? pair.reserveY.toBase58() : pair.reserveX.toBase58(),
                    quoteVault: isXSol ? pair.reserveX.toBase58() : pair.reserveY.toBase58(),
                };
            }
        } catch {
            // Failed to parse, ignore
        }

        return null;
    }

    private enhanceOpportunity(opp: CrossDexOpportunity): ArbOpportunity | null {
        // Get fresh quotes
        const buyQuote = this.quoter.quote(opp.buyPool, this.config.probeAmountLamports, "buy");
        const sellQuote = this.quoter.quote(opp.sellPool, this.config.probeAmountLamports, "sell");

        if (!buyQuote || !sellQuote) return null;

        // Calculate optimal position size (capped at max)
        const optimalInput = this.config.maxPositionLamports < this.config.probeAmountLamports
            ? this.config.maxPositionLamports
            : this.config.probeAmountLamports;

        // Estimate output (simplified - real impl would simulate full path)
        const tokensOut = buyQuote.outputAmount;
        const solBack = (tokensOut * BigInt(Math.floor(sellQuote.effectivePrice * 1e9))) / BigInt(1e9);

        const grossProfit = solBack - optimalInput;
        const netProfit = grossProfit - this.config.jitoTipLamports;

        return {
            ...opp,
            buyPrice: buyQuote.effectivePrice,
            sellPrice: sellQuote.effectivePrice,
            optimalInputLamports: optimalInput,
            expectedOutputLamports: solBack,
            expectedProfitLamports: netProfit,
        };
    }
}
