import { PublicKey } from "@solana/web3.js";

const BINS_PER_ARRAY = 70;
const METEORA_DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

export interface BinArrayRange {
    left: bigint;
    center: bigint;
    right: bigint;
}

export interface BinArraySubscription {
    index: bigint;
    pda: PublicKey;
}

export class BinTracker {
    private readonly binsPerArray: number;
    private readonly programId: PublicKey;

    constructor(binsPerArray: number = BINS_PER_ARRAY, programId: PublicKey = METEORA_DLMM_PROGRAM) {
        this.binsPerArray = binsPerArray;
        this.programId = programId;
    }

    /**
     * Given an activeId, returns the three BinArray indices needed for subscription:
     * - center: array containing the active bin
     * - left: array containing lower-priced bins
     * - right: array containing higher-priced bins
     */
    getSubscriptionIndices(activeId: number): BinArrayRange {
        const centerIndex = this.binIdToArrayIndex(activeId);

        return {
            left: centerIndex - 1n,
            center: centerIndex,
            right: centerIndex + 1n,
        };
    }

    /**
     * Returns flat array of indices for direct iteration
     */
    getSubscriptionIndicesFlat(activeId: number): bigint[] {
        const { left, center, right } = this.getSubscriptionIndices(activeId);
        return [left, center, right];
    }

    /**
     * Returns subscription objects with both index and derived PDA
     */
    getSubscriptionPdas(activeId: number, pair: PublicKey): BinArraySubscription[] {
        const indices = this.getSubscriptionIndicesFlat(activeId);
        return indices.map((index) => ({
            index,
            pda: this.deriveBinArrayPda(pair, index),
        }));
    }

    /**
     * Convert bin ID to array index (signed floor division)
     */
    binIdToArrayIndex(binId: number): bigint {
        const idx = Math.floor(binId / this.binsPerArray);
        return BigInt(idx);
    }

    /**
     * Get the bin offset within its array (0-69)
     */
    getBinOffset(binId: number): number {
        const arrayIndex = Number(this.binIdToArrayIndex(binId));
        const baseId = arrayIndex * this.binsPerArray;
        return binId - baseId;
    }

    /**
     * Check if a bin ID is at an array boundary (first or last bin)
     * Useful for preemptive neighbor subscription
     */
    isNearBoundary(binId: number, threshold: number = 5): { nearLower: boolean; nearUpper: boolean } {
        const offset = this.getBinOffset(binId);
        return {
            nearLower: offset < threshold,
            nearUpper: offset >= this.binsPerArray - threshold,
        };
    }

    /**
     * Given a price movement direction, returns priority-ordered indices
     */
    getPriorityIndices(activeId: number, direction: "up" | "down" | "neutral"): bigint[] {
        const { left, center, right } = this.getSubscriptionIndices(activeId);

        switch (direction) {
            case "up":
                return [center, right, left];
            case "down":
                return [center, left, right];
            case "neutral":
            default:
                return [center, left, right];
        }
    }

    /**
     * Convert index to 8-byte signed LE buffer for PDA derivation
     */
    indexToBuffer(index: bigint): Buffer {
        const buf = Buffer.alloc(8);
        buf.writeBigInt64LE(index);
        return buf;
    }

    /**
     * Derive the BinArray PDA for a given pair and index
     */
    deriveBinArrayPda(pair: PublicKey, index: bigint): PublicKey {
        const [pda] = PublicKey.findProgramAddressSync(
            [Buffer.from("bin_array"), pair.toBuffer(), this.indexToBuffer(index)],
            this.programId
        );
        return pda;
    }

    /**
     * Get the base bin ID for a given array index
     */
    getArrayBaseBinId(arrayIndex: bigint): number {
        return Number(arrayIndex) * this.binsPerArray;
    }

    /**
     * Get the range of bin IDs contained in a given array index
     */
    getArrayBinRange(arrayIndex: bigint): { min: number; max: number } {
        const base = this.getArrayBaseBinId(arrayIndex);
        return {
            min: base,
            max: base + this.binsPerArray - 1,
        };
    }
}

export const binTracker = new BinTracker();