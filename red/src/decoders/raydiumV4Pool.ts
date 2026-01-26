// src/decoders/raydiumV4Pool.ts
// Raydium V4 AMM pool decoder (decode-only; no simulation logic)
// Program: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8

import { PublicKey } from "@solana/web3.js";

export const RAYDIUM_V4_PROGRAM = new PublicKey(
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
);

export const V4_POOL_SIZE = 752;

// Raydium V4 pool is not Anchor; there is no 8-byte discriminator.
// Practically you filter by:
//   - account.owner == RAYDIUM_V4_PROGRAM
//   - account.data.length == 752
export function isRaydiumV4PoolAccount(data: Buffer | Uint8Array): boolean {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return buf.length === V4_POOL_SIZE;
}

// Offsets validated in your audit notes (carry forward as-is).
export const V4_OFFSETS = {
    status: 0, // u64
    baseDecimal: 32, // u64
    quoteDecimal: 40, // u64

    swapFeeNumerator: 176, // u64
    swapFeeDenominator: 184, // u64

    baseNeedTakePnl: 192, // u64
    quoteNeedTakePnl: 200, // u64

    poolOpenTime: 224, // u64

    baseVault: 336, // Pubkey
    quoteVault: 368, // Pubkey
    baseMint: 400, // Pubkey
    quoteMint: 432, // Pubkey
    lpMint: 464, // Pubkey
    openOrders: 496, // Pubkey
    marketId: 528, // Pubkey
    marketProgramId: 560, // Pubkey
    targetOrders: 592, // Pubkey
    owner: 688, // Pubkey

    lpReserve: 720, // u64
} as const;

export interface RaydiumV4PoolState {
    // Identity
    address?: PublicKey | undefined;

    // Token accounts/mints
    baseMint: PublicKey;
    quoteMint: PublicKey;
    baseVault: PublicKey;
    quoteVault: PublicKey;
    lpMint: PublicKey;

    // Optional integrations
    openOrders: PublicKey;
    marketId: PublicKey;
    marketProgramId: PublicKey;
    targetOrders: PublicKey;

    // Parameters
    status: bigint; // u64 on-chain
    openTime: bigint; // u64 on-chain

    baseDecimal: number;
    quoteDecimal: number;

    // Fee (can be 0!)
    swapFeeNumerator: bigint;
    swapFeeDenominator: bigint;

    // PnL adjustments (important for “effective reserves”)
    baseNeedTakePnl: bigint;
    quoteNeedTakePnl: bigint;

    // Misc
    lpReserve: bigint;

    // Provenance
    slot?: number | undefined;
    fetchedAt?: number | undefined;
}

function readPubkey(buf: Buffer, offset: number): PublicKey {
    return new PublicKey(buf.subarray(offset, offset + 32));
}

function readU64(buf: Buffer, offset: number): bigint {
    return buf.readBigUInt64LE(offset);
}

export function decodeRaydiumV4Pool(
    data: Buffer | Uint8Array,
    address?: PublicKey,
    slot?: number
): RaydiumV4PoolState {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

    if (buf.length !== V4_POOL_SIZE) {
        throw new Error(
            `[decodeRaydiumV4Pool] Invalid size: got ${buf.length}, expected ${V4_POOL_SIZE}`
        );
    }

    const status = readU64(buf, V4_OFFSETS.status);
    const openTime = readU64(buf, V4_OFFSETS.poolOpenTime);

    const baseDecimalU64 = readU64(buf, V4_OFFSETS.baseDecimal);
    const quoteDecimalU64 = readU64(buf, V4_OFFSETS.quoteDecimal);

    // Defensive: decimals should be in a small range.
    const baseDecimal = Number(baseDecimalU64);
    const quoteDecimal = Number(quoteDecimalU64);

    if (!Number.isFinite(baseDecimal) || baseDecimal < 0 || baseDecimal > 18) {
        throw new Error(`[decodeRaydiumV4Pool] Invalid baseDecimal: ${baseDecimalU64.toString()}`);
    }
    if (!Number.isFinite(quoteDecimal) || quoteDecimal < 0 || quoteDecimal > 18) {
        throw new Error(`[decodeRaydiumV4Pool] Invalid quoteDecimal: ${quoteDecimalU64.toString()}`);
    }

    const decoded: RaydiumV4PoolState = {
        address,

        baseMint: readPubkey(buf, V4_OFFSETS.baseMint),
        quoteMint: readPubkey(buf, V4_OFFSETS.quoteMint),
        baseVault: readPubkey(buf, V4_OFFSETS.baseVault),
        quoteVault: readPubkey(buf, V4_OFFSETS.quoteVault),
        lpMint: readPubkey(buf, V4_OFFSETS.lpMint),

        openOrders: readPubkey(buf, V4_OFFSETS.openOrders),
        marketId: readPubkey(buf, V4_OFFSETS.marketId),
        marketProgramId: readPubkey(buf, V4_OFFSETS.marketProgramId),
        targetOrders: readPubkey(buf, V4_OFFSETS.targetOrders),

        status,
        openTime,

        baseDecimal,
        quoteDecimal,

        swapFeeNumerator: readU64(buf, V4_OFFSETS.swapFeeNumerator),
        swapFeeDenominator: readU64(buf, V4_OFFSETS.swapFeeDenominator),

        baseNeedTakePnl: readU64(buf, V4_OFFSETS.baseNeedTakePnl),
        quoteNeedTakePnl: readU64(buf, V4_OFFSETS.quoteNeedTakePnl),

        lpReserve: readU64(buf, V4_OFFSETS.lpReserve),

        slot,
        fetchedAt: Date.now(),
    };

    return decoded;
}
