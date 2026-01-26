// src/brain/jitBrain.ts
// =============================================================================
// JIT LIQUIDITY BRAIN
// =============================================================================
// Detects opportunities to provide just-in-time liquidity on Meteora DLMM
// by analyzing pending swaps and identifying empty bin gaps.
//
// STATUS: Detection logic complete, needs transaction stream to activate
// =============================================================================

import { MarketCache, MeteoraPoolEntry } from "./marketCache.js";
import { BinArrayCache } from "./binArrayCache.js";
import { logOpportunity } from "../utils/logger.js";

// Meteora DLMM Program ID
const METEORA_DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

// Meteora swap instruction discriminator
const SWAP_DISCRIMINATOR = Buffer.from([0xf8, 0xc6, 0x9e, 0x91, 0xe1, 0x75, 0x87, 0xc8]);

interface PendingSwap {
    signature: string;
    poolPubkey: string;
    amountIn: bigint;
    direction: "X_TO_Y" | "Y_TO_X";
    detectedAt: number;
    expectedSlot: number;
}

interface JITOpportunity {
    swap: PendingSwap;
    pool: MeteoraPoolEntry;
    emptyBins: number[];
    expectedFeeCapture: number;
    estimatedProfitLamports: bigint;
    confidence: "HIGH" | "MEDIUM" | "LOW";
}

export class JITBrain {
    private readonly pendingSwaps = new Map<string, PendingSwap>();
    private readonly recentlyProcessed = new Set<string>();

    // Thresholds
    private readonly MIN_SWAP_SIZE_LAMPORTS = BigInt(100_000_000); // 0.1 SOL
    private readonly MIN_FEE_CAPTURE_BPS = 50; // 0.5%
    private readonly MAX_SWAP_AGE_MS = 2000; // 2 seconds
    private readonly MIN_EMPTY_BINS = 1;

    constructor(
        private readonly cache: MarketCache,
        private readonly binArrayCache: BinArrayCache
    ) { }

    /**
     * Process incoming transaction from Geyser stream
     */
    processTransaction(txData: unknown): JITOpportunity | null {
        // Parse the transaction
        const swap = this.parseMeteoraSwap(txData);
        if (!swap) return null;

        // Check if we've already processed this
        if (this.recentlyProcessed.has(swap.signature)) {
            return null;
        }

        // Get pool data
        const pool = this.cache.getMeteoraPool(swap.poolPubkey);
        if (!pool) {
            logOpportunity({
                type: "JIT",
                token: swap.poolPubkey,
                action: "REJECTED",
                reason: "pool_not_in_cache"
            });
            return null;
        }

        // Check swap size
        if (swap.amountIn < this.MIN_SWAP_SIZE_LAMPORTS) {
            logOpportunity({
                type: "JIT",
                token: pool.state.tokenXMint.toBase58().slice(0, 8),
                action: "REJECTED",
                reason: `swap_too_small: ${Number(swap.amountIn) / 1e9} SOL`
            });
            return null;
        }

        // Analyze bins for empty gaps
        const emptyBins = this.findEmptyBinsInPath(
            pool,
            swap.direction,
            swap.amountIn
        );

        if (emptyBins.length < this.MIN_EMPTY_BINS) {
            logOpportunity({
                type: "JIT",
                token: pool.state.tokenXMint.toBase58().slice(0, 8),
                action: "REJECTED",
                reason: "no_empty_bins"
            });
            return null;
        }

        // Calculate expected fee capture
        const feeCapture = this.calculateFeeCapture(pool, swap, emptyBins);

        if (feeCapture.netProfitBps < this.MIN_FEE_CAPTURE_BPS) {
            logOpportunity({
                type: "JIT",
                token: pool.state.tokenXMint.toBase58().slice(0, 8),
                action: "REJECTED",
                reason: `fee_capture_too_low: ${feeCapture.netProfitBps}bps`,
                netProfitBps: feeCapture.netProfitBps
            });
            return null;
        }

        // Build opportunity
        const opportunity: JITOpportunity = {
            swap,
            pool,
            emptyBins,
            expectedFeeCapture: feeCapture.feeRate,
            estimatedProfitLamports: feeCapture.profitLamports,
            confidence: this.assessConfidence(pool, swap, emptyBins)
        };

        logOpportunity({
            type: "JIT",
            token: pool.state.tokenXMint.toBase58().slice(0, 8),
            action: "DETECTED",
            estimatedProfitSol: Number(feeCapture.profitLamports) / 1e9,
            netProfitBps: feeCapture.netProfitBps,
            reason: `${emptyBins.length} empty bins, ${feeCapture.feeRate * 100}% fee`
        });

        // Track as pending
        this.pendingSwaps.set(swap.signature, swap);

        // Mark as processed (with TTL cleanup)
        this.recentlyProcessed.add(swap.signature);
        setTimeout(() => this.recentlyProcessed.delete(swap.signature), 60000);

        return opportunity;
    }

    /**
     * Parse Meteora swap from transaction data
     */
    private parseMeteoraSwap(txData: unknown): PendingSwap | null {
        try {
            const txDataObj = txData as Record<string, unknown>;
            const tx = txDataObj.transaction as Record<string, unknown> | undefined;
            if (!tx || !tx.transaction) return null;

            const txInner = tx.transaction as Record<string, unknown>;
            const message = txInner.message as Record<string, unknown> | undefined;
            if (!message || !message.instructions) return null;

            const accountKeys = message.accountKeys as string[];
            const instructions = message.instructions as Array<{
                programIdIndex: number;
                data: string;
                accounts: number[];
            }>;

            // Find Meteora swap instruction
            for (const ix of instructions) {
                const programIdIndex = ix.programIdIndex;
                if (programIdIndex === undefined || programIdIndex >= accountKeys.length) continue;

                const programId = accountKeys[programIdIndex];
                if (programId !== METEORA_DLMM_PROGRAM_ID) continue;

                const data = Buffer.from(ix.data, "base64");

                // Check discriminator
                if (!data.subarray(0, 8).equals(SWAP_DISCRIMINATOR)) continue;

                // Parse swap instruction data
                // Layout: [8 discriminator][8 amountIn][8 minAmountOut][1 swapForY]
                const amountIn = data.readBigUInt64LE(8);
                const swapForY = data.readUInt8(24) === 1;

                // Get pool account from instruction accounts
                const poolAccountIndex = ix.accounts[0];
                if (poolAccountIndex === undefined || poolAccountIndex >= accountKeys.length) continue;

                const poolPubkey = accountKeys[poolAccountIndex];
                if (poolPubkey === undefined) continue;

                // Extract and validate signature
                const signature = tx.signature;
                if (typeof signature !== "string") continue;

                return {
                    signature,
                    poolPubkey,
                    amountIn,
                    direction: swapForY ? "X_TO_Y" : "Y_TO_X",
                    detectedAt: Date.now(),
                    expectedSlot: Number(txDataObj.slot ?? 0)
                };
            }

            return null;
        } catch (_e) {
            return null;
        }
    }

    /**
     * Find empty bins in the swap path
     */
    private findEmptyBinsInPath(
        pool: MeteoraPoolEntry,
        direction: "X_TO_Y" | "Y_TO_X",
        amountIn: bigint
    ): number[] {
        const activeId = pool.state.activeId;

        // Get cached bin arrays for this pool
        const binArrays = this.binArrayCache.getBinArraysForPool(pool.pubkey);
        if (!binArrays || binArrays.size === 0) {
            return [];
        }

        const emptyBins: number[] = [];
        const step = direction === "X_TO_Y" ? 1 : -1;

        // Estimate bins to check based on swap size and typical liquidity
        const binsToCheck = Math.min(20, Math.ceil(Number(amountIn) / 1e9 * 5));

        for (let i = 0; i < binsToCheck; i++) {
            const binId = activeId + (i * step);
            const bin = this.binArrayCache.getBin(pool.pubkey, binId);

            if (!bin || (bin.amountX === 0n && bin.amountY === 0n)) {
                emptyBins.push(binId);
            }
        }

        return emptyBins;
    }

    /**
     * Calculate expected fee capture from JIT
     */
    private calculateFeeCapture(
        pool: MeteoraPoolEntry,
        swap: PendingSwap,
        emptyBins: number[]
    ): { feeRate: number; profitLamports: bigint; netProfitBps: number } {
        // Current dynamic fee
        const currentFee = pool.state.totalFeeRate;

        // Fee will spike due to volatility from this swap
        // Estimate: fee increases proportional to bins crossed
        const estimatedFeeSpike = Math.min(
            currentFee * (1 + emptyBins.length * 0.1),
            0.10 // 10% cap
        );

        // Amount we can capture (liquidity we'd provide)
        const captureAmount = swap.amountIn / BigInt(emptyBins.length + 1);

        // Gross fee revenue
        const grossFeeLamports = BigInt(
            Math.floor(Number(captureAmount) * estimatedFeeSpike)
        );

        // Costs: gas + jito tip + IL risk
        const gasCost = BigInt(50000); // ~0.00005 SOL for deposit+withdraw
        const jitoTip = BigInt(10000); // 0.00001 SOL base tip
        const ilRisk = captureAmount * BigInt(pool.state.binStep) / BigInt(10000);

        const netProfit = grossFeeLamports - gasCost - jitoTip - ilRisk;
        const netProfitBps = Number(netProfit * 10000n / captureAmount);

        return {
            feeRate: estimatedFeeSpike,
            profitLamports: netProfit > 0n ? netProfit : 0n,
            netProfitBps: Math.max(0, netProfitBps)
        };
    }

    /**
     * Assess confidence in the opportunity
     */
    private assessConfidence(
        pool: MeteoraPoolEntry,
        swap: PendingSwap,
        emptyBins: number[]
    ): "HIGH" | "MEDIUM" | "LOW" {
        const dataAge = Date.now() - pool.lastUpdatedTs;

        if (dataAge > 2000) return "LOW";
        if (emptyBins.length < 2) return "LOW";
        if (swap.amountIn < BigInt(500_000_000)) return "MEDIUM"; // < 0.5 SOL
        if (pool.state.totalFeeRate < 0.01) return "MEDIUM"; // Low fee pool

        return "HIGH";
    }

    /**
     * Clean up old pending swaps
     */
    cleanup(): void {
        const now = Date.now();
        for (const [sig, swap] of this.pendingSwaps) {
            if (now - swap.detectedAt > this.MAX_SWAP_AGE_MS) {
                this.pendingSwaps.delete(sig);
            }
        }
    }

    /**
     * Get stats for monitoring
     */
    getStats(): {
        pendingSwaps: number;
        recentlyProcessed: number;
    } {
        return {
            pendingSwaps: this.pendingSwaps.size,
            recentlyProcessed: this.recentlyProcessed.size
        };
    }
}