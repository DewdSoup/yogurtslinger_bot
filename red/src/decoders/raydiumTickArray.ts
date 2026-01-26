// src/decoders/raydiumTickArray.ts

import { PublicKey } from "@solana/web3.js";

/**
 * Raydium CLMM program id.
 */
export const RAYDIUM_CLMM_PROGRAM_ID = new PublicKey(
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"
);

/**
 * Anchor discriminator for TickArray.
 */
export const RAYDIUM_TICK_ARRAY_DISCRIMINATOR = Buffer.from(
    "c09b55cd31f9812a",
    "hex"
);

export const RAYDIUM_TICK_ARRAY_SIZE = 10240;

export const RAYDIUM_TICK_ARRAY_OFFSETS = {
    // discriminator: 0..8
    poolId: 8, // pubkey
    startTickIndex: 40, // i32
    ticks: 44, // start of ticks array
} as const;

/**
 * Raydium CLMM has 60 ticks per TickArray account.
 */
export const RAYDIUM_TICKS_PER_ARRAY = 60;

/**
 * Tick struct size implied by 10240 layout:
 * header(44) + 60*tickSize = 10240 => tickSize = 170
 */
export const RAYDIUM_TICK_SIZE = 170;

export type RaydiumTick = {
    // Original field you were using:
    index: number; // i32 tick index

    // Alias used by CLMM sim; keep both to avoid breaking anything:
    tick: number;

    initialized: boolean;

    liquidityNet: bigint; // i128
    liquidityGross: bigint; // u128

    feeGrowthOutside0X64: bigint; // u128
    feeGrowthOutside1X64: bigint; // u128
};

export type RaydiumTickArray = {
    address?: PublicKey;

    poolId: PublicKey;
    startTickIndex: number;
    ticks: RaydiumTick[];
};

function readI32LE(buf: Buffer, o: number): number {
    return buf.readInt32LE(o);
}
function readPubkey(buf: Buffer, o: number): PublicKey {
    return new PublicKey(buf.subarray(o, o + 32));
}
function readU128LE(buf: Buffer, o: number): bigint {
    const lo = buf.readBigUInt64LE(o);
    const hi = buf.readBigUInt64LE(o + 8);
    return lo + (hi << 64n);
}
function readI128LE(buf: Buffer, o: number): bigint {
    // Two's complement, little-endian 128-bit
    const u = readU128LE(buf, o);
    const signBit = 1n << 127n;
    return (u & signBit) === 0n ? u : u - (1n << 128n);
}

export function isRaydiumTickArrayAccount(data: Buffer | Uint8Array): boolean {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return (
        buf.length >= RAYDIUM_TICK_ARRAY_SIZE &&
        buf.subarray(0, 8).equals(RAYDIUM_TICK_ARRAY_DISCRIMINATOR)
    );
}

export function decodeRaydiumTickArray(
    data: Buffer | Uint8Array,
    address?: PublicKey
): RaydiumTickArray {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

    if (!isRaydiumTickArrayAccount(buf)) {
        throw new Error(
            `Not a Raydium TickArray account: len=${buf.length}, disc=${buf
                .subarray(0, 8)
                .toString("hex")}`
        );
    }

    const O = RAYDIUM_TICK_ARRAY_OFFSETS;

    const poolId = readPubkey(buf, O.poolId);
    const startTickIndex = readI32LE(buf, O.startTickIndex);

    const ticks: RaydiumTick[] = new Array(RAYDIUM_TICKS_PER_ARRAY);

    for (let i = 0; i < RAYDIUM_TICKS_PER_ARRAY; i++) {
        const base = O.ticks + i * RAYDIUM_TICK_SIZE;

        const index = readI32LE(buf, base + 0);
        const liquidityNet = readI128LE(buf, base + 4);
        const liquidityGross = readU128LE(buf, base + 20);
        const feeGrowthOutside0X64 = readU128LE(buf, base + 36);
        const feeGrowthOutside1X64 = readU128LE(buf, base + 52);

        ticks[i] = {
            index,
            tick: index, // alias for sim
            initialized: liquidityGross !== 0n,
            liquidityNet,
            liquidityGross,
            feeGrowthOutside0X64,
            feeGrowthOutside1X64,
        };
    }

    return {
        ...(address ? { address } : {}),
        poolId,
        startTickIndex,
        ticks,
    };
}

/**
 * IMPORTANT: Raydium CLMM TickArray PDA seed uses i32 BIG-ENDIAN.
 */
export function i32ToBigEndianBuffer(i: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeInt32BE(i, 0);
    return b;
}

export function deriveRaydiumTickArrayPda(
    poolId: PublicKey,
    startTickIndex: number
): PublicKey {
    return PublicKey.findProgramAddressSync(
        [Buffer.from("tick_array"), poolId.toBuffer(), i32ToBigEndianBuffer(startTickIndex)],
        RAYDIUM_CLMM_PROGRAM_ID
    )[0];
}

/**
 * Helper to compute the TickArray start index that contains a given tick.
 */
export function getTickArrayStartIndex(
    tickIndex: number,
    tickSpacing: number
): number {
    const ticksPerArray = tickSpacing * RAYDIUM_TICKS_PER_ARRAY;
    return Math.floor(tickIndex / ticksPerArray) * ticksPerArray;
}

// Back-compat alias
export type RaydiumTickArrayState = RaydiumTickArray;
