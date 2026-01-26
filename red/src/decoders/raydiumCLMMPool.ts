import { PublicKey } from "@solana/web3.js";

/**
 * Raydium CLMM (Concentrated Liquidity) program id.
 * Canonical:
 *   CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK
 */
export const RAYDIUM_CLMM_PROGRAM_ID = new PublicKey(
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"
);

/**
 * Anchor discriminator for PoolState (Raydium CLMM pool).
 */
export const RAYDIUM_CLMM_POOL_DISCRIMINATOR = Buffer.from(
    "f7ede3f5d7c3de46",
    "hex"
);

/**
 * Expected on-chain size for Raydium CLMM pool accounts.
 * Raydium PoolState::LEN == 1544 currently. :contentReference[oaicite:2]{index=2}
 */
export const RAYDIUM_CLMM_POOL_SIZE = 1544;

/**
 * Decode-only offsets for Raydium CLMM PoolState.
 *
 * IMPORTANT:
 * Raydium's PoolState includes explicit padding fields after `tick_current`:
 *   tick_current: i32
 *   padding3: u16
 *   padding4: u16
 * so fee_growth_global_* starts at tickCurrent+8, not tickCurrent+4. :contentReference[oaicite:3]{index=3}
 */
export const RAYDIUM_CLMM_POOL_OFFSETS = {
    // discriminator: 0..8
    bump: 8, // [u8;1]
    ammConfig: 9, // Pubkey (32)
    creator: 41, // Pubkey (32)  (named "owner" in on-chain struct)
    tokenMint0: 73, // Pubkey (32)
    tokenMint1: 105, // Pubkey (32)
    tokenVault0: 137, // Pubkey (32)
    tokenVault1: 169, // Pubkey (32)
    observationKey: 201, // Pubkey (32)

    mintDecimals0: 233, // u8
    mintDecimals1: 234, // u8
    tickSpacing: 235, // u16

    liquidity: 237, // u128
    sqrtPriceX64: 253, // u128 (Q64.64)
    tickCurrent: 269, // i32

    // explicit padding in PoolState :contentReference[oaicite:4]{index=4}
    padding3: 273, // u16
    padding4: 275, // u16

    feeGrowthGlobal0X64: 277, // u128
    feeGrowthGlobal1X64: 293, // u128
    protocolFeesToken0: 309, // u64
    protocolFeesToken1: 317, // u64

    // cumulative swap counters (order matches on-chain struct)
    swapInAmountToken0: 325, // u128
    swapOutAmountToken1: 341, // u128
    swapInAmountToken1: 357, // u128
    swapOutAmountToken0: 373, // u128

    status: 389, // u8
    // padding: [u8;7] at 390..397
    // reward_infos: 396..840 (3 * 148 bytes) - not decoded here by default

    // tick_array_bitmap: [u64;16] at 840..968 :contentReference[oaicite:5]{index=5}
    tickArrayBitmap: 840, // u64[16]

    // fees/fund/open-time region (8-byte fields)
    totalFeesToken0: 968, // u64
    totalFeesClaimedToken0: 976, // u64
    totalFeesToken1: 984, // u64
    totalFeesClaimedToken1: 992, // u64
    fundFeesToken0: 1000, // u64
    fundFeesToken1: 1008, // u64
    openTime: 1016, // u64
    recentEpoch: 1024, // u64

    // padding tail starts at 1032 (512 bytes)
    paddingTail: 1032,
} as const;

export type RaydiumClmmPoolState = {
    address?: PublicKey;

    bump: number;

    ammConfig: PublicKey;
    creator: PublicKey;

    tokenMint0: PublicKey;
    tokenMint1: PublicKey;

    tokenVault0: PublicKey;
    tokenVault1: PublicKey;

    observationKey: PublicKey;

    mintDecimals0: number;
    mintDecimals1: number;

    tickSpacing: number;

    liquidity: bigint; // u128
    sqrtPriceX64: bigint; // u128 Q64.64
    tickCurrent: number; // i32

    feeGrowthGlobal0X64: bigint; // u128
    feeGrowthGlobal1X64: bigint; // u128
    protocolFeesToken0: bigint; // u64
    protocolFeesToken1: bigint; // u64

    // Optional counters (still useful for analytics)
    swapInAmountToken0: bigint; // u128
    swapOutAmountToken1: bigint; // u128
    swapInAmountToken1: bigint; // u128
    swapOutAmountToken0: bigint; // u128

    status: number;

    // tick array bitmap (16 u64s)
    tickArrayBitmap: bigint[];

    // totals
    totalFeesToken0: bigint;
    totalFeesClaimedToken0: bigint;
    totalFeesToken1: bigint;
    totalFeesClaimedToken1: bigint;
    fundFeesToken0: bigint;
    fundFeesToken1: bigint;

    openTime: bigint;
    recentEpoch: bigint;
};

function assertRange(buf: Buffer, o: number, n: number, label: string): void {
    if (o < 0 || o + n > buf.length) {
        throw new Error(
            `Raydium CLMM Pool decode OOB for ${label}: offset=${o} size=${n} len=${buf.length}`
        );
    }
}

function readU8(buf: Buffer, o: number, label: string): number {
    assertRange(buf, o, 1, label);
    return buf.readUInt8(o);
}
function readU16LE(buf: Buffer, o: number, label: string): number {
    assertRange(buf, o, 2, label);
    return buf.readUInt16LE(o);
}
function readI32LE(buf: Buffer, o: number, label: string): number {
    assertRange(buf, o, 4, label);
    return buf.readInt32LE(o);
}
function readU64LE(buf: Buffer, o: number, label: string): bigint {
    assertRange(buf, o, 8, label);
    return buf.readBigUInt64LE(o);
}
function readU128LE(buf: Buffer, o: number, label: string): bigint {
    assertRange(buf, o, 16, label);
    const lo = buf.readBigUInt64LE(o);
    const hi = buf.readBigUInt64LE(o + 8);
    return lo + (hi << 64n);
}
function readPubkey(buf: Buffer, o: number, label: string): PublicKey {
    assertRange(buf, o, 32, label);
    return new PublicKey(buf.subarray(o, o + 32));
}

export function isRaydiumClmmPoolAccount(data: Buffer): boolean {
    return (
        data.length >= RAYDIUM_CLMM_POOL_SIZE &&
        data.subarray(0, 8).equals(RAYDIUM_CLMM_POOL_DISCRIMINATOR)
    );
}

/**
 * Decode Raydium CLMM PoolState (decode-only).
 */
export function decodeRaydiumClmmPool(
    data: Buffer,
    address?: PublicKey
): RaydiumClmmPoolState {
    if (!isRaydiumClmmPoolAccount(data)) {
        throw new Error(
            `Not a Raydium CLMM pool account: len=${data.length}, disc=${data
                .subarray(0, 8)
                .toString("hex")}`
        );
    }

    const O = RAYDIUM_CLMM_POOL_OFFSETS;

    const tickArrayBitmap: bigint[] = new Array(16);
    for (let i = 0; i < 16; i++) {
        tickArrayBitmap[i] = readU64LE(
            data,
            O.tickArrayBitmap + i * 8,
            `tickArrayBitmap[${i}]`
        );
    }

    return {
        ...(address ? { address } : {}),

        bump: readU8(data, O.bump, "bump"),

        ammConfig: readPubkey(data, O.ammConfig, "ammConfig"),
        creator: readPubkey(data, O.creator, "creator"),

        tokenMint0: readPubkey(data, O.tokenMint0, "tokenMint0"),
        tokenMint1: readPubkey(data, O.tokenMint1, "tokenMint1"),

        tokenVault0: readPubkey(data, O.tokenVault0, "tokenVault0"),
        tokenVault1: readPubkey(data, O.tokenVault1, "tokenVault1"),

        observationKey: readPubkey(data, O.observationKey, "observationKey"),

        mintDecimals0: readU8(data, O.mintDecimals0, "mintDecimals0"),
        mintDecimals1: readU8(data, O.mintDecimals1, "mintDecimals1"),

        tickSpacing: readU16LE(data, O.tickSpacing, "tickSpacing"),

        liquidity: readU128LE(data, O.liquidity, "liquidity"),
        sqrtPriceX64: readU128LE(data, O.sqrtPriceX64, "sqrtPriceX64"),
        tickCurrent: readI32LE(data, O.tickCurrent, "tickCurrent"),

        // padding3/padding4 are intentionally not returned (but offsets assume them)

        feeGrowthGlobal0X64: readU128LE(data, O.feeGrowthGlobal0X64, "feeGrowthGlobal0X64"),
        feeGrowthGlobal1X64: readU128LE(data, O.feeGrowthGlobal1X64, "feeGrowthGlobal1X64"),
        protocolFeesToken0: readU64LE(data, O.protocolFeesToken0, "protocolFeesToken0"),
        protocolFeesToken1: readU64LE(data, O.protocolFeesToken1, "protocolFeesToken1"),

        swapInAmountToken0: readU128LE(data, O.swapInAmountToken0, "swapInAmountToken0"),
        swapOutAmountToken1: readU128LE(data, O.swapOutAmountToken1, "swapOutAmountToken1"),
        swapInAmountToken1: readU128LE(data, O.swapInAmountToken1, "swapInAmountToken1"),
        swapOutAmountToken0: readU128LE(data, O.swapOutAmountToken0, "swapOutAmountToken0"),

        status: readU8(data, O.status, "status"),

        tickArrayBitmap,

        totalFeesToken0: readU64LE(data, O.totalFeesToken0, "totalFeesToken0"),
        totalFeesClaimedToken0: readU64LE(data, O.totalFeesClaimedToken0, "totalFeesClaimedToken0"),
        totalFeesToken1: readU64LE(data, O.totalFeesToken1, "totalFeesToken1"),
        totalFeesClaimedToken1: readU64LE(data, O.totalFeesClaimedToken1, "totalFeesClaimedToken1"),
        fundFeesToken0: readU64LE(data, O.fundFeesToken0, "fundFeesToken0"),
        fundFeesToken1: readU64LE(data, O.fundFeesToken1, "fundFeesToken1"),

        openTime: readU64LE(data, O.openTime, "openTime"),
        recentEpoch: readU64LE(data, O.recentEpoch, "recentEpoch"),
    };
}

/**
 * Non-throwing decode helper.
 */
export function tryDecodeRaydiumClmmPool(
    data: Buffer,
    address?: PublicKey
): RaydiumClmmPoolState | null {
    try {
        return decodeRaydiumClmmPool(data, address);
    } catch {
        return null;
    }
}

// Back-compat / naming-stability alias (so sims can import a consistent name)
export type RaydiumCLMMPoolState = RaydiumClmmPoolState;
