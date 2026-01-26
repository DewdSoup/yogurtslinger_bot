// src/decoders/pumpswapPool.ts

import { PublicKey } from "@solana/web3.js";

/**
 * PumpSwap Pool account (AMM pool)
 * Program ID: pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
 */
export const PUMPSWAP_PROGRAM_ID = new PublicKey(
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);

// Pool account discriminator from IDL
export const PUMPSWAP_POOL_DISCRIMINATOR = Buffer.from([
    241, 154, 109, 4, 17, 177, 109, 188,
]);

export const PUMPSWAP_POOL_MIN_LEN = 211;

export interface PumpSwapPoolState {
    address?: PublicKey;

    poolBump: number;
    index: number;
    creator: PublicKey;
    baseMint: PublicKey;
    quoteMint: PublicKey;
    lpMint: PublicKey;
    poolBaseTokenAccount: PublicKey;
    poolQuoteTokenAccount: PublicKey;
    lpSupply: bigint;
}

export function isPumpSwapPoolAccount(data: Buffer | Uint8Array): boolean {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return (
        buf.length >= 8 &&
        buf.subarray(0, 8).equals(PUMPSWAP_POOL_DISCRIMINATOR)
    );
}

export function decodePumpSwapPool(
    data: Buffer | Uint8Array,
    address?: PublicKey
): PumpSwapPoolState {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

    if (buf.length < PUMPSWAP_POOL_MIN_LEN) {
        throw new Error(
            `[decodePumpSwapPool] Buffer too short: got ${buf.length}, need >= ${PUMPSWAP_POOL_MIN_LEN}`
        );
    }
    if (!buf.subarray(0, 8).equals(PUMPSWAP_POOL_DISCRIMINATOR)) {
        throw new Error(`[decodePumpSwapPool] Invalid discriminator`);
    }

    let offset = 8;

    const poolBump = buf.readUInt8(offset);
    offset += 1;

    const index = buf.readUInt16LE(offset);
    offset += 2;

    const creator = new PublicKey(buf.subarray(offset, offset + 32));
    offset += 32;

    const baseMint = new PublicKey(buf.subarray(offset, offset + 32));
    offset += 32;

    const quoteMint = new PublicKey(buf.subarray(offset, offset + 32));
    offset += 32;

    const lpMint = new PublicKey(buf.subarray(offset, offset + 32));
    offset += 32;

    const poolBaseTokenAccount = new PublicKey(
        buf.subarray(offset, offset + 32)
    );
    offset += 32;

    const poolQuoteTokenAccount = new PublicKey(
        buf.subarray(offset, offset + 32)
    );
    offset += 32;

    const lpSupply = buf.readBigUInt64LE(offset);

    return {
        ...(address ? { address } : {}),
        poolBump,
        index,
        creator,
        baseMint,
        quoteMint,
        lpMint,
        poolBaseTokenAccount,
        poolQuoteTokenAccount,
        lpSupply,
    };
}
