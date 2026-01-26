// src/decoders/pumpswap.ts
// Decoder for PumpSwap AMM Pool accounts
// Program ID: pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
// FEE: 0.30% (30 bps) - FIXED, not stored in pool state

import { PublicKey } from "@solana/web3.js";

/**
 * PumpSwap Pool account state.
 * 
 * Layout (from IDL):
 * - discriminator: 8 bytes [241, 154, 109, 4, 17, 177, 109, 188]
 * - pool_bump: u8 (1 byte)
 * - index: u16 (2 bytes) - migrated Pump pools use index=0
 * - creator: pubkey (32 bytes)
 * - base_mint: pubkey (32 bytes)
 * - quote_mint: pubkey (32 bytes)
 * - lp_mint: pubkey (32 bytes)
 * - pool_base_token_account: pubkey (32 bytes) - ATA holding base tokens
 * - pool_quote_token_account: pubkey (32 bytes) - ATA holding quote tokens
 * - lp_supply: u64 (8 bytes)
 * 
 * Total: 211 bytes
 * 
 * FEE STRUCTURE (hardcoded in program, NOT in pool state):
 * - Total: 0.30% (30 bps)
 * - LP Fee: 0.20% (20 bps)
 * - Protocol Fee: 0.05% (5 bps)
 * - Creator Fee: 0.05% (5 bps)
 */
export interface PumpSwapPoolState {
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

// Pool account discriminator from IDL
const POOL_DISCRIMINATOR = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);

// Minimum expected size for a Pool account
const MIN_POOL_ACCOUNT_LEN = 211;

// =============================================================================
// FEE CONSTANTS (Verified Dec 2024)
// =============================================================================
// PumpSwap has FIXED fees - NOT stored in pool state
// Total: 0.30% = 0.20% LP + 0.05% protocol + 0.05% creator

/** PumpSwap total fee as decimal (0.0030 = 0.30%) */
export const PUMPSWAP_FEE = 0.0030;

/** PumpSwap total fee in basis points (30 = 0.30%) */
export const PUMPSWAP_FEE_BPS = 30;

/** PumpSwap LP fee as decimal */
export const PUMPSWAP_LP_FEE = 0.0020;

/** PumpSwap protocol fee as decimal */
export const PUMPSWAP_PROTOCOL_FEE = 0.0005;

/** PumpSwap creator fee as decimal */
export const PUMPSWAP_CREATOR_FEE = 0.0005;

/**
 * Check if an account data buffer is a PumpSwap Pool account
 * by verifying the discriminator.
 */
export function isPumpSwapPoolAccount(data: Buffer | Uint8Array): boolean {
    if (data.length < 8) return false;
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return buffer.subarray(0, 8).equals(POOL_DISCRIMINATOR);
}

/**
 * Get the discriminator bytes (for gRPC filtering)
 */
export function getPumpSwapDiscriminator(): Buffer {
    return POOL_DISCRIMINATOR;
}

/**
 * Decode a PumpSwap Pool account from raw account data.
 * 
 * @param data - Raw account data bytes
 * @returns Decoded PumpSwapPoolState
 * @throws Error if buffer is too short or discriminator doesn't match
 */
export function decodePumpSwapPool(
    data: Buffer | Uint8Array
): PumpSwapPoolState {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);

    if (buffer.length < MIN_POOL_ACCOUNT_LEN) {
        throw new Error(
            `[decodePumpSwapPool] Buffer too short: got ${buffer.length}, need at least ${MIN_POOL_ACCOUNT_LEN}`
        );
    }

    // Verify discriminator
    const discriminator = buffer.subarray(0, 8);
    if (!discriminator.equals(POOL_DISCRIMINATOR)) {
        throw new Error(
            `[decodePumpSwapPool] Invalid discriminator: expected [${POOL_DISCRIMINATOR.join(",")}], ` +
            `got [${Array.from(discriminator).join(",")}]`
        );
    }

    let offset = 8; // Skip discriminator

    // pool_bump: u8
    const poolBump = buffer.readUInt8(offset);
    offset += 1;

    // index: u16 (little-endian)
    const index = buffer.readUInt16LE(offset);
    offset += 2;

    // creator: pubkey (32 bytes)
    const creator = new PublicKey(buffer.subarray(offset, offset + 32));
    offset += 32;

    // base_mint: pubkey (32 bytes)
    const baseMint = new PublicKey(buffer.subarray(offset, offset + 32));
    offset += 32;

    // quote_mint: pubkey (32 bytes)
    const quoteMint = new PublicKey(buffer.subarray(offset, offset + 32));
    offset += 32;

    // lp_mint: pubkey (32 bytes)
    const lpMint = new PublicKey(buffer.subarray(offset, offset + 32));
    offset += 32;

    // pool_base_token_account: pubkey (32 bytes)
    const poolBaseTokenAccount = new PublicKey(buffer.subarray(offset, offset + 32));
    offset += 32;

    // pool_quote_token_account: pubkey (32 bytes)
    const poolQuoteTokenAccount = new PublicKey(buffer.subarray(offset, offset + 32));
    offset += 32;

    // lp_supply: u64 (little-endian)
    const lpSupply = buffer.readBigUInt64LE(offset);

    return {
        poolBump,
        index,
        creator,
        baseMint,
        quoteMint,
        lpMint,
        poolBaseTokenAccount,
        poolQuoteTokenAccount,
        lpSupply
    };
}

/**
 * Get the fee for PumpSwap (always 0.30%)
 * PumpSwap has fixed fees, not per-pool
 */
export function getPumpSwapFee(): number {
    return PUMPSWAP_FEE;
}

/**
 * Get PumpSwap fee in basis points
 */
export function getPumpSwapFeeBps(): number {
    return PUMPSWAP_FEE_BPS;
}