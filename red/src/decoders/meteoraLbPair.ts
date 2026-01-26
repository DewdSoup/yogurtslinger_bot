import { PublicKey } from "@solana/web3.js";

/**
 * Meteora DLMM program id (Liquidity Book / DLMM).
 * Mainnet program id commonly used by Meteora DLMM.
 */
export const METEORA_DLMM_PROGRAM_ID = new PublicKey(
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
);

/**
 * Anchor discriminator for LbPair account.
 * First 8 bytes of account data.
 */
export const METEORA_LB_PAIR_DISCRIMINATOR = Buffer.from(
    "210b3162b565b10d",
    "hex"
);

/**
 * Expected on-chain size (from your audit notes).
 * Some deployments may pad/extend; accept >= this size.
 */
export const METEORA_LB_PAIR_SIZE = 904;

/**
 * Offsets based on the Meteora DLMM LbPair layout (v2).
 *
 * Layout:
 * - [0..8]: discriminator
 * - [8..40]: StaticParameters (32 bytes)
 * - [40..72]: VariableParameters (32 bytes)
 * - [72..88]: misc fields (bumpSeed, binStepSeed, pairType, activeId, binStep, status, etc.)
 * - [88..216]: pubkeys (tokenXMint, tokenYMint, reserveX, reserveY, ...)
 */
export const METEORA_LB_PAIR_OFFSETS = {
    // StaticParameters (offset 8)
    baseFactor: 8, // u16
    filterPeriod: 10, // u16
    decayPeriod: 12, // u16
    reductionFactor: 14, // u16
    variableFeeControl: 16, // u32
    maxVolatilityAccumulator: 20, // u32
    minBinId: 24, // i32
    maxBinId: 28, // i32
    protocolShare: 32, // u16
    baseFeePowerFactor: 34, // u8
    // padding: 35-39

    // VariableParameters (offset 40)
    volatilityAccumulator: 40, // u32
    volatilityReference: 44, // u32
    indexReference: 48, // i32
    // padding: 52-55
    lastUpdateTimestamp: 56, // i64
    // padding1: 64-71

    // Fields after embedded structs (offset 72)
    bumpSeed: 72, // u8
    binStepSeed: 73, // [u8;2]
    pairType: 75, // u8
    activeId: 76, // i32
    binStep: 80, // u16
    status: 82, // u8
    requireBaseFactorSeed: 83, // u8
    baseFactorSeed: 84, // [u8;2]
    activationType: 86, // u8
    creatorPoolOnOffControl: 87, // u8

    // Pubkeys (offset 88)
    tokenXMint: 88, // pubkey (32 bytes)
    tokenYMint: 120, // pubkey
    reserveX: 152, // pubkey
    reserveY: 184, // pubkey
    // protocolFee struct: 216
    // padding1: 232
    // rewardInfos: 264
    oracle: 408, // pubkey (approx - after rewardInfos)

    // binArrayBitmap is 16 u64s = 128 bytes
    binArrayBitmap: 440, // [u64;16]

    // Remaining fields near end
    // lastUpdatedAt, padding, preActivationSwapAddress, baseKey, etc.
} as const;

export type MeteoraLbPairState = {
    address?: PublicKey | undefined;

    // StaticParameters
    baseFactor: number; // u16
    filterPeriod: number; // u16
    decayPeriod: number; // u16
    reductionFactor: number; // u16
    variableFeeControl: number; // u32
    maxVolatilityAccumulator: number; // u32
    minBinId: number; // i32
    maxBinId: number; // i32
    protocolShare: number; // u16 (bps)
    baseFeePowerFactor: number; // u8

    // VariableParameters
    volatilityAccumulator: number; // u32
    volatilityReference: number; // u32
    indexReference: number; // i32
    lastUpdateTimestamp: bigint; // i64

    // Main fields
    bumpSeed: number; // u8
    pairType: number; // u8
    activeId: number; // i32
    binStep: number; // u16
    status: number; // u8

    tokenXMint: PublicKey;
    tokenYMint: PublicKey;
    reserveX: PublicKey;
    reserveY: PublicKey;
    oracle: PublicKey;

    binArrayBitmap: Buffer;
};

function readU8(buf: Buffer, o: number): number {
    return buf.readUInt8(o);
}
function readU16LE(buf: Buffer, o: number): number {
    return buf.readUInt16LE(o);
}
function readU32LE(buf: Buffer, o: number): number {
    return buf.readUInt32LE(o);
}
function readI32LE(buf: Buffer, o: number): number {
    return buf.readInt32LE(o);
}
function readPubkey(buf: Buffer, o: number): PublicKey {
    return new PublicKey(buf.subarray(o, o + 32));
}

export function isMeteoraLbPairAccount(data: Buffer): boolean {
    return (
        data.length >= METEORA_LB_PAIR_SIZE &&
        data.subarray(0, 8).equals(METEORA_LB_PAIR_DISCRIMINATOR)
    );
}

function readI64LE(buf: Buffer, o: number): bigint {
    return buf.readBigInt64LE(o);
}

/**
 * Decode Meteora LbPair.
 * Decode-only. No simulation logic or derived pricing here.
 */
export function decodeMeteoraLbPair(
    data: Buffer,
    address?: PublicKey
): MeteoraLbPairState {
    if (!isMeteoraLbPairAccount(data)) {
        throw new Error(
            `Not a Meteora LbPair account: len=${data.length}, disc=${data
                .subarray(0, 8)
                .toString("hex")}`
        );
    }

    const O = METEORA_LB_PAIR_OFFSETS;

    return {
        ...(address ? { address } : {}),

        // StaticParameters
        baseFactor: readU16LE(data, O.baseFactor),
        filterPeriod: readU16LE(data, O.filterPeriod),
        decayPeriod: readU16LE(data, O.decayPeriod),
        reductionFactor: readU16LE(data, O.reductionFactor),
        variableFeeControl: readU32LE(data, O.variableFeeControl),
        maxVolatilityAccumulator: readU32LE(data, O.maxVolatilityAccumulator),
        minBinId: readI32LE(data, O.minBinId),
        maxBinId: readI32LE(data, O.maxBinId),
        protocolShare: readU16LE(data, O.protocolShare),
        baseFeePowerFactor: readU8(data, O.baseFeePowerFactor),

        // VariableParameters
        volatilityAccumulator: readU32LE(data, O.volatilityAccumulator),
        volatilityReference: readU32LE(data, O.volatilityReference),
        indexReference: readI32LE(data, O.indexReference),
        lastUpdateTimestamp: readI64LE(data, O.lastUpdateTimestamp),

        // Main fields
        bumpSeed: readU8(data, O.bumpSeed),
        pairType: readU8(data, O.pairType),
        activeId: readI32LE(data, O.activeId),
        binStep: readU16LE(data, O.binStep),
        status: readU8(data, O.status),

        tokenXMint: readPubkey(data, O.tokenXMint),
        tokenYMint: readPubkey(data, O.tokenYMint),
        reserveX: readPubkey(data, O.reserveX),
        reserveY: readPubkey(data, O.reserveY),
        oracle: readPubkey(data, O.oracle),

        binArrayBitmap: data.subarray(O.binArrayBitmap, O.binArrayBitmap + 128), // 16 u64s = 128 bytes
    };
}

/* ------------------------------
   PDA helpers (non-simulation)
   ------------------------------ */

/**
 * Meteora has 70 bins per BinArray (per your audit).
 */
export const METEORA_BINS_PER_ARRAY = 70;

/**
 * floorDiv for JS numbers (correct for negatives).
 */
export function floorDiv(a: number, b: number): number {
    return Math.floor(a / b);
}

export function binIdToBinArrayIndex(binId: number): bigint {
    return BigInt(floorDiv(binId, METEORA_BINS_PER_ARRAY));
}

export function i64ToLE(i: bigint): Buffer {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(i, 0);
    return b;
}

/**
 * BinArray PDA derivation:
 * seeds: ["bin_array", lbPair, i64(index LE)]
 */
export function deriveMeteoraBinArrayPda(
    lbPair: PublicKey,
    index: bigint
): PublicKey {
    return PublicKey.findProgramAddressSync(
        [Buffer.from("bin_array"), lbPair.toBuffer(), i64ToLE(index)],
        METEORA_DLMM_PROGRAM_ID
    )[0];
}

/**
 * Convenience: get a window of bin array PDAs around activeId.
 * This is what you wire into PoolRegistry dependencies.
 */
export function getMeteoraBinArrayWindow(
    lbPair: PublicKey,
    activeId: number,
    radiusArrays: number
): PublicKey[] {
    const activeIndex = binIdToBinArrayIndex(activeId);
    const out: PublicKey[] = [];
    for (let d = -radiusArrays; d <= radiusArrays; d++) {
        out.push(deriveMeteoraBinArrayPda(lbPair, activeIndex + BigInt(d)));
    }
    return out;
}
