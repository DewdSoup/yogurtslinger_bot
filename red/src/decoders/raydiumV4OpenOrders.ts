// src/decoders/raydiumV4OpenOrders.ts
// OpenBook/Serum-style OpenOrders decoder used by Raydium V4
// Layout validated: 13-byte header; market at offset 13; magic "serum" at 0.

import { PublicKey } from "@solana/web3.js";

export const OPEN_ORDERS_SIZE = 3228;
export const OPEN_ORDERS_MAGIC = Buffer.from("serum", "ascii");

export const OPEN_ORDERS_OFFSETS = {
    magic: 0, // 5 bytes
    version: 5, // u8
    // padding: 6..12
    market: 13, // Pubkey
    owner: 45, // Pubkey
    baseTokenFree: 77, // u64
    baseTokenTotal: 85, // u64
    quoteTokenFree: 93, // u64
    quoteTokenTotal: 101, // u64
} as const;

export interface RaydiumV4OpenOrdersState {
    address?: PublicKey | undefined;
    market: PublicKey;
    owner: PublicKey;
    version: number;

    baseTokenFree: bigint;
    baseTokenTotal: bigint;
    quoteTokenFree: bigint;
    quoteTokenTotal: bigint;
}

export function isOpenOrdersAccount(data: Buffer | Uint8Array): boolean {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return buf.length === OPEN_ORDERS_SIZE && buf.subarray(0, 5).equals(OPEN_ORDERS_MAGIC);
}

function readPubkey(buf: Buffer, offset: number): PublicKey {
    return new PublicKey(buf.subarray(offset, offset + 32));
}

function readU64(buf: Buffer, offset: number): bigint {
    return buf.readBigUInt64LE(offset);
}

export function decodeRaydiumV4OpenOrders(
    data: Buffer | Uint8Array,
    address?: PublicKey
): RaydiumV4OpenOrdersState {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

    if (buf.length !== OPEN_ORDERS_SIZE) {
        throw new Error(
            `[decodeRaydiumV4OpenOrders] Invalid size: got ${buf.length}, expected ${OPEN_ORDERS_SIZE}`
        );
    }

    if (!buf.subarray(0, 5).equals(OPEN_ORDERS_MAGIC)) {
        throw new Error(`[decodeRaydiumV4OpenOrders] Invalid magic (not "serum")`);
    }

    const version = buf.readUInt8(OPEN_ORDERS_OFFSETS.version);

    return {
        address,
        version,
        market: readPubkey(buf, OPEN_ORDERS_OFFSETS.market),
        owner: readPubkey(buf, OPEN_ORDERS_OFFSETS.owner),
        baseTokenFree: readU64(buf, OPEN_ORDERS_OFFSETS.baseTokenFree),
        baseTokenTotal: readU64(buf, OPEN_ORDERS_OFFSETS.baseTokenTotal),
        quoteTokenFree: readU64(buf, OPEN_ORDERS_OFFSETS.quoteTokenFree),
        quoteTokenTotal: readU64(buf, OPEN_ORDERS_OFFSETS.quoteTokenTotal),
    };
}
