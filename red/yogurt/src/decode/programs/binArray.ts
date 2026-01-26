/**
 * Meteora DLMM BinArray Decoder (Phase 3)
 * Program: LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo
 *
 * Discriminator: 5c8e5cdc059446b5
 * Size: 10136 bytes (56 header + 70 bins × 144 bytes)
 *
 * Layout:
 *   [0..8]    discriminator
 *   [8..16]   index (i64) - bin array index
 *   [16..24]  version (i64)
 *   [24..56]  lbPair (pubkey)
 *   [56..]    bins array (70 × 144 bytes)
 *
 * Bin layout (144 bytes):
 *   [0..8]    amountX (u64)
 *   [8..16]   amountY (u64)
 *   [16..32]  liquiditySupply (u128)
 *   ... other fields not needed for swap sim
 */

export const BIN_ARRAY_SIZE = 10136;
export const BINS_PER_ARRAY = 70;
export const BIN_SIZE = 144;
export const BIN_ARRAY_HEADER_SIZE = 56;

// Discriminator bytes
const DISC_0 = 0x5c;
const DISC_1 = 0x8e;
const DISC_2 = 0x5c;
const DISC_3 = 0xdc;
const DISC_4 = 0x05;
const DISC_5 = 0x94;
const DISC_6 = 0x46;
const DISC_7 = 0xb5;

/** Single bin data needed for simulation */
export interface Bin {
    amountX: bigint;  // u64 - token X in this bin
    amountY: bigint;  // u64 - token Y in this bin
}

/** Decoded BinArray */
export interface BinArray {
    lbPair: Uint8Array;
    index: bigint;        // i64 - array index
    startBinId: number;   // index * 70 (converted to number for bin lookup)
    bins: Bin[];
}

/**
 * Fast discriminator check
 */
export function isBinArray(data: Uint8Array): boolean {
    return data.length >= BIN_ARRAY_SIZE &&
        data[0] === DISC_0 &&
        data[1] === DISC_1 &&
        data[2] === DISC_2 &&
        data[3] === DISC_3 &&
        data[4] === DISC_4 &&
        data[5] === DISC_5 &&
        data[6] === DISC_6 &&
        data[7] === DISC_7;
}

/**
 * Decode BinArray account
 * Returns null on invalid data
 */
export function decodeBinArray(data: Uint8Array): BinArray | null {
    if (!isBinArray(data)) return null;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    const index = view.getBigInt64(8, true);
    const lbPair = data.slice(24, 56);

    // startBinId = index * 70
    // For normal pools, index fits in i32 range
    const startBinId = Number(index) * BINS_PER_ARRAY;

    const bins: Bin[] = new Array(BINS_PER_ARRAY);
    const binsOffset = BIN_ARRAY_HEADER_SIZE;

    for (let i = 0; i < BINS_PER_ARRAY; i++) {
        const base = binsOffset + i * BIN_SIZE;

        bins[i] = {
            amountX: view.getBigUint64(base, true),
            amountY: view.getBigUint64(base + 8, true),
        };
    }

    return {
        lbPair,
        index,
        startBinId,
        bins,
    };
}

/**
 * Get BinArray index from a bin ID
 */
export function getBinArrayIndex(binId: number): number {
    return Math.floor(binId / BINS_PER_ARRAY);
}

/**
 * Get the position of a bin within its array
 */
export function getBinPositionInArray(binId: number): number {
    const idx = binId % BINS_PER_ARRAY;
    return idx < 0 ? idx + BINS_PER_ARRAY : idx;
}