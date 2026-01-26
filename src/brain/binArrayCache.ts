// src/brain/binArrayCache.ts
// =============================================================================
// BINARRAY CACHE - USES VALIDATED DECODER FROM meteora.ts
// =============================================================================
//
// Stores decoded BinArray data for:
// 1. Empty bin detection (MeteoraEdge backrun strategy)
// 2. Liquidity depth analysis
// 3. Slippage estimation
//
// CRITICAL: Uses validated constants from meteora.ts
//   - BIN_ARRAY_HEADER_SIZE = 56
//   - BIN_SIZE = 144  (NOT 48!)
//   - BINS_PER_ARRAY = 70
//   - amountX at offset+0, amountY at offset+8
//
// =============================================================================

import {
    BIN_ARRAY_HEADER_SIZE,
    BIN_SIZE,
    BINS_PER_ARRAY,
    isMeteoraBinArrayAccount,
} from "../decoders/meteora.js";

// =============================================================================
// TYPES
// =============================================================================

interface CachedBin {
    binId: number;
    amountX: bigint;
    amountY: bigint;
    lastUpdated: number;
}

interface CachedBinArray {
    pda: string;
    poolPubkey: string;
    arrayIndex: bigint;
    bins: Map<number, CachedBin>;
    lastUpdated: number;
    binCount: number;      // Total bins in array
    filledCount: number;   // Bins with liquidity
}

// =============================================================================
// BINARRAY CACHE
// =============================================================================

export class BinArrayCache {
    private readonly arrays = new Map<string, CachedBinArray>();
    private readonly poolToArrays = new Map<string, Set<string>>();

    // Stats
    private stats = {
        totalArrays: 0,
        totalBins: 0,
        pools: 0,
        updates: 0,
        decodeErrors: 0,
    };

    constructor() {
        console.log(`[BinArrayCache] Initialized with validated constants: ` +
            `HEADER=${BIN_ARRAY_HEADER_SIZE} BIN_SIZE=${BIN_SIZE} BINS_PER_ARRAY=${BINS_PER_ARRAY}`);
    }

    /**
     * Upsert a bin array from Geyser update
     * Uses validated decoder from meteora.ts
     */
    upsertBinArray(
        pda: string,
        poolPubkey: string,
        arrayIndex: bigint,
        data: Buffer
    ): boolean {
        this.stats.updates++;

        // Validate discriminator using meteora.ts function
        if (!isMeteoraBinArrayAccount(data)) {
            this.stats.decodeErrors++;
            return false;
        }

        try {
            const bins = this.decodeBinArrayValidated(data, arrayIndex);
            const now = Date.now();

            // Count filled bins
            let filledCount = 0;
            for (const bin of bins.values()) {
                if (bin.amountX > 0n || bin.amountY > 0n) {
                    filledCount++;
                }
            }

            const cached: CachedBinArray = {
                pda,
                poolPubkey,
                arrayIndex,
                bins,
                lastUpdated: now,
                binCount: BINS_PER_ARRAY,
                filledCount,
            };

            this.arrays.set(pda, cached);

            // Track pool -> array mapping
            if (!this.poolToArrays.has(poolPubkey)) {
                this.poolToArrays.set(poolPubkey, new Set());
            }
            this.poolToArrays.get(poolPubkey)!.add(pda);

            // Update stats
            this.stats.totalArrays = this.arrays.size;
            this.stats.pools = this.poolToArrays.size;
            this.updateTotalBins();

            return true;
        } catch (err) {
            this.stats.decodeErrors++;
            console.error(`[BinArrayCache] Decode error for ${pda.slice(0, 8)}:`, (err as Error).message);
            return false;
        }
    }

    /**
     * Get all bin arrays for a pool
     */
    getBinArraysForPool(poolPubkey: string): Map<string, CachedBinArray> | null {
        const pdas = this.poolToArrays.get(poolPubkey);
        if (!pdas) return null;

        const result = new Map<string, CachedBinArray>();
        for (const pda of pdas) {
            const arr = this.arrays.get(pda);
            if (arr) result.set(pda, arr);
        }
        return result;
    }

    /**
     * Get a specific bin by ID
     */
    getBin(poolPubkey: string, binId: number): CachedBin | null {
        const arrays = this.getBinArraysForPool(poolPubkey);
        if (!arrays) return null;

        // Find which array contains this bin using validated formula
        const arrayIndex = BigInt(Math.floor(binId / BINS_PER_ARRAY));

        for (const arr of arrays.values()) {
            if (arr.arrayIndex === arrayIndex) {
                return arr.bins.get(binId) ?? null;
            }
        }
        return null;
    }

    /**
     * Check if a bin is empty (no liquidity)
     */
    isBinEmpty(poolPubkey: string, binId: number): boolean | null {
        const bin = this.getBin(poolPubkey, binId);
        if (bin === null) return null;  // Unknown
        return bin.amountX === 0n && bin.amountY === 0n;
    }

    /**
     * Get empty bins in a range
     */
    getEmptyBinsInRange(
        poolPubkey: string,
        startBin: number,
        endBin: number
    ): { emptyBins: number[]; knownBins: number; unknownBins: number } {
        const emptyBins: number[] = [];
        let knownBins = 0;
        let unknownBins = 0;

        const step = startBin < endBin ? 1 : -1;

        for (let binId = startBin; binId !== endBin; binId += step) {
            const isEmpty = this.isBinEmpty(poolPubkey, binId);
            if (isEmpty === null) {
                unknownBins++;
            } else {
                knownBins++;
                if (isEmpty) {
                    emptyBins.push(binId);
                }
            }
        }

        return { emptyBins, knownBins, unknownBins };
    }

    /**
     * Get liquidity depth around active bin
     */
    getLiquidityDepth(
        poolPubkey: string,
        activeId: number,
        radius: number = 10
    ): { totalX: bigint; totalY: bigint; filledBins: number; emptyBins: number } {
        let totalX = 0n;
        let totalY = 0n;
        let filledBins = 0;
        let emptyBins = 0;

        for (let offset = -radius; offset <= radius; offset++) {
            const binId = activeId + offset;
            const bin = this.getBin(poolPubkey, binId);

            if (bin) {
                totalX += bin.amountX;
                totalY += bin.amountY;
                if (bin.amountX > 0n || bin.amountY > 0n) {
                    filledBins++;
                } else {
                    emptyBins++;
                }
            }
        }

        return { totalX, totalY, filledBins, emptyBins };
    }

    /**
     * Get empty bin ratio around active bin
     */
    getEmptyBinRatio(poolPubkey: string, activeId: number, radius: number = 10): number {
        const depth = this.getLiquidityDepth(poolPubkey, activeId, radius);
        const total = depth.filledBins + depth.emptyBins;
        if (total === 0) return 0.3;  // Conservative default
        return depth.emptyBins / total;
    }

    /**
     * Decode bin array data using VALIDATED layout
     * 
     * BinArray Layout (validated against 280+ PDAs):
     *   [0-7]     discriminator (8 bytes) - 5c8e5cdc059446b5
     *   [8-15]    index (i64) - which chunk of bins
     *   [16-23]   version + padding
     *   [24-55]   lbPair pubkey (32 bytes)
     *   [56+]     bins[70] array
     * 
     * Each Bin (144 bytes):
     *   [0-7]     amountX (u64)
     *   [8-15]    amountY (u64)
     *   [16-143]  price Q64.64, accumulators, etc (unused for liquidity check)
     */
    private decodeBinArrayValidated(data: Buffer, arrayIndex: bigint): Map<number, CachedBin> {
        const bins = new Map<number, CachedBin>();
        const baseBinId = Number(arrayIndex) * BINS_PER_ARRAY;
        const now = Date.now();

        // Validate minimum size
        const expectedSize = BIN_ARRAY_HEADER_SIZE + (BINS_PER_ARRAY * BIN_SIZE);
        if (data.length < expectedSize) {
            throw new Error(`BinArray too small: ${data.length} < ${expectedSize}`);
        }

        for (let i = 0; i < BINS_PER_ARRAY; i++) {
            const offset = BIN_ARRAY_HEADER_SIZE + (i * BIN_SIZE);

            // Read amountX and amountY (CORRECT offsets: +0 and +8)
            const amountX = data.readBigUInt64LE(offset);
            const amountY = data.readBigUInt64LE(offset + 8);

            const binId = baseBinId + i;

            // Store all bins (even empty ones for accurate ratio calculation)
            bins.set(binId, {
                binId,
                amountX,
                amountY,
                lastUpdated: now
            });
        }

        return bins;
    }

    private updateTotalBins(): void {
        let total = 0;
        for (const arr of this.arrays.values()) {
            total += arr.bins.size;
        }
        this.stats.totalBins = total;
    }

    /**
     * Get cache stats
     */
    getStats(): {
        totalArrays: number;
        totalBins: number;
        pools: number;
        updates: number;
        decodeErrors: number;
    } {
        return { ...this.stats };
    }

    /**
     * Clear old entries (for memory management)
     */
    pruneOld(maxAgeMs: number = 5 * 60 * 1000): number {
        const cutoff = Date.now() - maxAgeMs;
        let pruned = 0;

        for (const [pda, arr] of this.arrays) {
            if (arr.lastUpdated < cutoff) {
                this.arrays.delete(pda);

                // Clean up pool mapping
                const poolArrays = this.poolToArrays.get(arr.poolPubkey);
                if (poolArrays) {
                    poolArrays.delete(pda);
                    if (poolArrays.size === 0) {
                        this.poolToArrays.delete(arr.poolPubkey);
                    }
                }

                pruned++;
            }
        }

        if (pruned > 0) {
            this.stats.totalArrays = this.arrays.size;
            this.stats.pools = this.poolToArrays.size;
            this.updateTotalBins();
            console.log(`[BinArrayCache] Pruned ${pruned} old arrays`);
        }

        return pruned;
    }
}

// =============================================================================
// SINGLETON INSTANCE (Optional - can also instantiate directly)
// =============================================================================

export const binArrayCache = new BinArrayCache();

export default BinArrayCache;