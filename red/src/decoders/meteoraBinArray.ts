import { PublicKey } from "@solana/web3.js";
import { METEORA_BINS_PER_ARRAY } from "./meteoraLbPair";

/**
 * Anchor discriminator for BinArray.
 */
export const METEORA_BIN_ARRAY_DISCRIMINATOR = Buffer.from(
    "5c8e5cdc059446b5",
    "hex"
);

/**
 * Header (56) + 70 bins * 144 bytes (per your audit notes)
 */
export const METEORA_BIN_ARRAY_HEADER_SIZE = 56;
export const METEORA_BIN_SIZE = 144;
export const METEORA_BIN_ARRAY_SIZE =
    METEORA_BIN_ARRAY_HEADER_SIZE + METEORA_BINS_PER_ARRAY * METEORA_BIN_SIZE;

/**
 * BinArray layout (v2):
 * - [0..8]: discriminator
 * - [8..16]: index (i64) - the bin array index
 * - [16..24]: version (i64)
 * - [24..56]: lbPair (pubkey)
 * - [56..]: bins array
 */
export const METEORA_BIN_ARRAY_OFFSETS = {
    index: 8, // i64
    version: 16, // i64
    lbPair: 24, // pubkey
    bins: 56, // start of bins array
} as const;

export type MeteoraBin = {
    /** raw amounts in smallest units */
    amountX: bigint; // u64
    amountY: bigint; // u64

    /** optional fields useful for debugging (not required for swaps) */
    liquiditySupply?: bigint; // u128
    feeAmountX?: bigint; // u64
    feeAmountY?: bigint; // u64
};

export type MeteoraBinArray = {
    address?: PublicKey | undefined;

    lbPair: PublicKey;
    index: bigint; // i64 (array index)
    startBinId: bigint; // index * 70
    bins: MeteoraBin[]; // length 70
};

function readPubkey(buf: Buffer, o: number): PublicKey {
    return new PublicKey(buf.subarray(o, o + 32));
}
function readI64LE(buf: Buffer, o: number): bigint {
    return buf.readBigInt64LE(o);
}
function readU64LE(buf: Buffer, o: number): bigint {
    return buf.readBigUInt64LE(o);
}
function readU128LE(buf: Buffer, o: number): bigint {
    const lo = buf.readBigUInt64LE(o);
    const hi = buf.readBigUInt64LE(o + 8);
    return lo + (hi << 64n);
}

export function isMeteoraBinArrayAccount(data: Buffer): boolean {
    return (
        data.length >= METEORA_BIN_ARRAY_SIZE &&
        data.subarray(0, 8).equals(METEORA_BIN_ARRAY_DISCRIMINATOR)
    );
}

/**
 * Decode Meteora BinArray.
 * Decode-only. Swap traversal and fee logic belong in sim.
 */
export function decodeMeteoraBinArray(
    data: Buffer,
    address?: PublicKey
): MeteoraBinArray {
    if (!isMeteoraBinArrayAccount(data)) {
        throw new Error(
            `Not a Meteora BinArray account: len=${data.length}, disc=${data
                .subarray(0, 8)
                .toString("hex")}`
        );
    }

    const O = METEORA_BIN_ARRAY_OFFSETS;

    const index = readI64LE(data, O.index);
    const lbPair = readPubkey(data, O.lbPair);
    const startBinId = index * BigInt(METEORA_BINS_PER_ARRAY);

    const bins: MeteoraBin[] = new Array(METEORA_BINS_PER_ARRAY);

    for (let i = 0; i < METEORA_BINS_PER_ARRAY; i++) {
        const base = O.bins + i * METEORA_BIN_SIZE;

        // Bin fields (subset) — these offsets match the bin struct layout you were using:
        const amountX = readU64LE(data, base + 0);
        const amountY = readU64LE(data, base + 8);

        // Optional-but-useful:
        const liquiditySupply = readU128LE(data, base + 16);

        // Fee accumulators (commonly present in Meteora bin structs)
        const feeAmountX = readU64LE(data, base + 48);
        const feeAmountY = readU64LE(data, base + 56);

        bins[i] = {
            amountX,
            amountY,
            liquiditySupply,
            feeAmountX,
            feeAmountY,
        };
    }

    return {
        ...(address ? { address } : {}),
        lbPair,
        index,
        startBinId,
        bins,
    };
}

/**
 * Convenience: flatten decoded bin arrays into a binId -> bin liquidity map.
 * This is very practical for sim; it avoids repeated “which array contains binId” logic.
 */
export type MeteoraBinLiquidity = { amountX: bigint; amountY: bigint };

export function buildMeteoraBinLiquidityMap(
    arrays: MeteoraBinArray[]
): Map<number, MeteoraBinLiquidity> {
    const out = new Map<number, MeteoraBinLiquidity>();

    for (const a of arrays) {
        // startBinId should fit i32-range in normal pools; convert carefully.
        const start = Number(a.startBinId);
        if (!Number.isFinite(start)) {
            throw new Error(`startBinId not finite: ${a.startBinId.toString()}`);
        }

        for (let i = 0; i < a.bins.length; i++) {
            const binId = start + i;
            const b = a.bins[i]!;
            out.set(binId, { amountX: b.amountX, amountY: b.amountY });
        }
    }

    return out;
}
