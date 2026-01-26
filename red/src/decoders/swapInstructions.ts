// src/decoders/swapInstructions.ts
//
// Swap instruction decoders for extracting parameters from pending transactions.
//
// Verified discriminators from transaction analysis:
// - PumpSwap: 66063d1201daebea (lengths 24, 25, 26, 32)
// - Raydium V4: 09 (native instruction #9 = swap)
// - Raydium CLMM: 2b04ed0b1ac91e62 (Anchor swap discriminator)
// - Meteora DLMM: f8c69e91e17587c8 / 414b3f4ceb5b5b88 (swap variants in capture)
// - Jupiter: e445a52e51cb9a1d (aggregator route)
//
// These decoders enable pre-confirmation arb detection from ShredStream.

import type { PubkeyStr } from "../state/accountStore";

// ============================================================================
// Types
// ============================================================================

export type VenueType = "pumpswap" | "raydium_v4" | "raydium_clmm" | "meteora_dlmm" | "jupiter";

export interface DecodedSwapInstruction {
    venue: VenueType;
    poolAddress: PubkeyStr;
    amountIn: bigint;
    minAmountOut: bigint;
    direction: SwapDirection;
    tokenInMint?: PubkeyStr;
    tokenOutMint?: PubkeyStr;
    // Exact-out variants (PumpSwap)
    isExactOut?: boolean;
    exactOut?: bigint;
    maxIn?: bigint;
}

export type SwapDirection = "baseToQuote" | "quoteToBase" | "zeroForOne" | "oneForZero" | "xToY" | "yToX";

// ============================================================================
// Discriminator Constants
// ============================================================================

// Anchor discriminators (first 8 bytes of SHA256("global:<method_name>"))
const PUMPSWAP_SWAP_DISC = Buffer.from("66063d1201daebea", "hex");
const CLMM_SWAP_DISC = Buffer.from("2b04ed0b1ac91e62", "hex");
const DLMM_SWAP_DISCS = [
    Buffer.from("f8c69e91e17587c8", "hex"),
    Buffer.from("414b3f4ceb5b5b88", "hex"),
    // Legacy/other variants observed in older captures
    Buffer.from("235613b94ed44bd3", "hex"),
];
const JUPITER_ROUTE_DISC = Buffer.from("e445a52e51cb9a1d", "hex");

// Raydium V4 is native (no Anchor), instruction index 9 = swap
const RAYDIUM_V4_SWAP_IX = 9;

// Program IDs
export const PROGRAM_IDS = {
    pumpswap: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    raydiumV4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    raydiumClmm: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    meteoraDlmm: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    jupiter: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
} as const;

// ============================================================================
// Main Decoder
// ============================================================================

/**
 * Decode a swap instruction from raw instruction data.
 *
 * @param programId - The program ID of the instruction
 * @param data - Raw instruction data
 * @param accounts - Account keys from the transaction (resolved)
 */
export function decodeSwapInstruction(
    programId: PubkeyStr,
    data: Buffer,
    accounts: PubkeyStr[]
): DecodedSwapInstruction | null {
    switch (programId) {
        case PROGRAM_IDS.pumpswap:
            return decodePumpSwapSwap(data, accounts);

        case PROGRAM_IDS.raydiumV4:
            return decodeRaydiumV4Swap(data, accounts);

        case PROGRAM_IDS.raydiumClmm:
            return decodeRaydiumClmmSwap(data, accounts);

        case PROGRAM_IDS.meteoraDlmm:
            return decodeMeteoraDlmmSwap(data, accounts);

        case PROGRAM_IDS.jupiter:
            return decodeJupiterRoute(data, accounts);

        default:
            return null;
    }
}

// ============================================================================
// PumpSwap Decoder
// ============================================================================

/**
 * PumpSwap swap instruction layout (exact-out):
 * - [0:8] discriminator: 66063d1201daebea
 * - [8:16] amount_out: u64 (exact)
 * - [16:24] max_amount_in: u64
 * - [24] direction byte (optional)
 *
 * Account layout (from IDL):
 * 0: pool
 * 1: user
 * 2: globalConfig
 * 3: baseMint
 * 4: quoteMint
 * 5: userBaseTokenAccount
 * 6: userQuoteTokenAccount
 * 7: poolBaseTokenAccount
 * 8: poolQuoteTokenAccount
 * ...
 *
 * Direction determined by which vault receives tokens (buy = quote in, sell = base in)
 */
function decodePumpSwapSwap(data: Buffer, accounts: PubkeyStr[]): DecodedSwapInstruction | null {
    // Check discriminator
    if (data.length < 8) return null;
    if (!data.subarray(0, 8).equals(PUMPSWAP_SWAP_DISC)) return null;

    // Need at least 24 bytes for disc + amounts
    if (data.length < 24) return null;

    const amountOut = data.readBigUInt64LE(8);
    const maxIn = data.readBigUInt64LE(16);

    // Pool is account 0
    const poolAddress = accounts[0];
    if (!poolAddress) return null;

    // Direction: we need to determine from the instruction variant
    // In PumpSwap, there are separate buy/sell instructions
    // The discriminator tells us which one
    // For now, we'll parse additional bytes if present
    let direction: SwapDirection = "quoteToBase"; // Default to buy

    // If data length is 25+, byte 24 might indicate direction
    // Based on observed data lengths: 24, 25, 26, 32
    if (data.length >= 25) {
        const dirByte = data.readUInt8(24);
        direction = dirByte === 0 ? "quoteToBase" : "baseToQuote";
    }

    const baseMint = accounts[3];
    const quoteMint = accounts[4];

    const tokenInMint = direction === "baseToQuote" ? baseMint : quoteMint;
    const tokenOutMint = direction === "baseToQuote" ? quoteMint : baseMint;

    return {
        venue: "pumpswap",
        poolAddress,
        amountIn: maxIn, // best-effort fallback (exact-out uses maxIn bound)
        minAmountOut: amountOut,
        direction,
        tokenInMint,
        tokenOutMint,
        isExactOut: true,
        exactOut: amountOut,
        maxIn,
    };
}

// ============================================================================
// Raydium V4 Decoder
// ============================================================================

/**
 * Raydium V4 swap instruction (native, not Anchor):
 * - [0:1] instruction index (9 = swap)
 * - [1:9] amount_in: u64
 * - [9:17] min_amount_out: u64
 *
 * Account layout:
 * 0: tokenProgram
 * 1: amm
 * 2: ammAuthority
 * 3: ammOpenOrders
 * 4: ammTargetOrders (deprecated)
 * 5: poolCoinTokenAccount
 * 6: poolPcTokenAccount
 * 7: serumProgram
 * 8: serumMarket
 * 9: serumBids
 * 10: serumAsks
 * 11: serumEventQueue
 * 12: serumCoinVaultAccount
 * 13: serumPcVaultAccount
 * 14: serumVaultSigner
 * 15: userSourceTokenAccount
 * 16: userDestTokenAccount
 * 17: userOwner
 */
function decodeRaydiumV4Swap(data: Buffer, accounts: PubkeyStr[]): DecodedSwapInstruction | null {
    if (data.length < 17) return null;

    const ixIndex = data.readUInt8(0);
    if (ixIndex !== RAYDIUM_V4_SWAP_IX) return null;

    const amountIn = data.readBigUInt64LE(1);
    const minAmountOut = data.readBigUInt64LE(9);

    // AMM pool is account 1
    const poolAddress = accounts[1];
    if (!poolAddress) return null;

    // Direction determined by which vault is source vs dest
    // Account 15 is user source, account 16 is user dest
    // We'd need pool state to determine if source is base or quote
    // For now, default to baseToQuote (sell)
    const direction: SwapDirection = "baseToQuote";

    return {
        venue: "raydium_v4",
        poolAddress,
        amountIn,
        minAmountOut,
        direction,
    };
}

// ============================================================================
// Raydium CLMM Decoder
// ============================================================================

/**
 * Raydium CLMM swap instruction (Anchor):
 * - [0:8] discriminator: 2b04ed0b1ac91e62
 * - [8:16] amount: u64
 * - [16:24] other_amount_threshold: u64
 * - [24:40] sqrt_price_limit_x64: u128
 * - [40] is_base_input: bool
 *
 * Account layout:
 * 0: payer
 * 1: ammConfig
 * 2: poolState
 * 3: inputTokenAccount
 * 4: outputTokenAccount
 * 5: inputVault
 * 6: outputVault
 * 7: observationState
 * 8: tokenProgram
 * 9: tickArrayLower
 * 10: tickArrayUpper
 * ...
 */
function decodeRaydiumClmmSwap(data: Buffer, accounts: PubkeyStr[]): DecodedSwapInstruction | null {
    if (data.length < 8) return null;
    if (!data.subarray(0, 8).equals(CLMM_SWAP_DISC)) return null;

    // Need at least 41 bytes
    if (data.length < 41) return null;

    const amountIn = data.readBigUInt64LE(8);
    const minAmountOut = data.readBigUInt64LE(16);
    // sqrtPriceLimitX64 at 24:40 (u128)
    const isBaseInput = data.readUInt8(40) !== 0;

    // Pool state is account 2
    const poolAddress = accounts[2];
    if (!poolAddress) return null;

    // Direction based on is_base_input
    // In CLMM: token0 = base, token1 = quote
    // is_base_input=true means token0 in → zeroForOne
    const direction: SwapDirection = isBaseInput ? "zeroForOne" : "oneForZero";

    return {
        venue: "raydium_clmm",
        poolAddress,
        amountIn,
        minAmountOut,
        direction,
    };
}

// ============================================================================
// Meteora DLMM Decoder
// ============================================================================

/**
 * Meteora DLMM swap instruction (Anchor variants):
 * - [0:8] discriminator: f8c69e91e17587c8 / 414b3f4ceb5b5b88
 * - [8:16] amount_in: u64
 * - [16:24] min_amount_out: u64
 *
 * Account layout:
 * 0: lbPair
 * 1: binArrayBitmapExtension (optional)
 * 2: reserveX
 * 3: reserveY
 * 4: userTokenIn
 * 5: userTokenOut
 * 6: tokenXMint
 * 7: tokenYMint
 * 8: oracle
 * 9: hostFeeIn
 * 10: user
 * 11: tokenXProgram
 * 12: tokenYProgram
 * 13: eventAuthority
 * 14: program
 * 15+: binArrays...
 */
function decodeMeteoraDlmmSwap(data: Buffer, accounts: PubkeyStr[]): DecodedSwapInstruction | null {
    if (data.length < 8) return null;
    const disc = data.subarray(0, 8);
    if (!DLMM_SWAP_DISCS.some(d => disc.equals(d))) return null;

    // Legacy 2356... variant doesn't carry amounts; skip decoding
    if (disc.equals(DLMM_SWAP_DISCS[2]!) && data.length < 24) return null;

    if (data.length < 16) return null;

    const amountIn = data.readBigUInt64LE(8);
    const minAmountOut = data.length >= 24 ? data.readBigUInt64LE(16) : BigInt(0);

    // LbPair is account 0
    const poolAddress = accounts[0];
    if (!poolAddress) return null;

    // Direction determined by which token account is source
    // We need pool state to determine X vs Y
    // Default to xToY
    const direction: SwapDirection = "xToY";

    const tokenXMint = accounts[6];
    const tokenYMint = accounts[7];
    const tokenInMint = direction === "xToY" ? tokenXMint : tokenYMint;
    const tokenOutMint = direction === "xToY" ? tokenYMint : tokenXMint;

    return {
        venue: "meteora_dlmm",
        poolAddress,
        amountIn,
        minAmountOut,
        direction,
        tokenInMint,
        tokenOutMint,
    };
}

// ============================================================================
// Jupiter Decoder
// ============================================================================

/**
 * Jupiter route instruction (Anchor):
 * - [0:8] discriminator: e445a52e51cb9a1d
 * - [8:16] in_amount: u64
 * - [16:24] quoted_out_amount: u64
 * - [24:26] slippage_bps: u16
 * - [26] platform_fee_bps: u8
 * ...
 *
 * Jupiter is an aggregator - the actual swaps are inner CPI calls.
 * We decode the outer instruction to get the total input/output.
 */
function decodeJupiterRoute(data: Buffer, accounts: PubkeyStr[]): DecodedSwapInstruction | null {
    if (data.length < 8) return null;
    if (!data.subarray(0, 8).equals(JUPITER_ROUTE_DISC)) return null;

    if (data.length < 24) return null;

    const amountIn = data.readBigUInt64LE(8);
    const quotedAmountOut = data.readBigUInt64LE(16);

    // Jupiter routes through multiple pools; use first account as a stable marker if present
    const poolAddress = accounts[0] ?? ("jupiter_aggregator" as PubkeyStr);

    return {
        venue: "jupiter",
        poolAddress,
        amountIn,
        minAmountOut: quotedAmountOut,
        direction: "baseToQuote", // Generic
    };
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Check if instruction data matches a known swap discriminator.
 */
export function isSwapInstruction(programId: PubkeyStr, data: Buffer): boolean {
    if (data.length < 1) return false;

    switch (programId) {
        case PROGRAM_IDS.pumpswap:
            return data.length >= 8 && data.subarray(0, 8).equals(PUMPSWAP_SWAP_DISC);

        case PROGRAM_IDS.raydiumV4:
            return data.readUInt8(0) === RAYDIUM_V4_SWAP_IX;

        case PROGRAM_IDS.raydiumClmm:
            return data.length >= 8 && data.subarray(0, 8).equals(CLMM_SWAP_DISC);

        case PROGRAM_IDS.meteoraDlmm:
            return data.length >= 8 && DLMM_SWAP_DISCS.some(d => data.subarray(0, 8).equals(d));

        case PROGRAM_IDS.jupiter:
            return data.length >= 8 && data.subarray(0, 8).equals(JUPITER_ROUTE_DISC);

        default:
            return false;
    }
}

/**
 * Get the venue type from a program ID.
 */
export function getVenueFromProgramId(programId: PubkeyStr): VenueType | null {
    switch (programId) {
        case PROGRAM_IDS.pumpswap:
            return "pumpswap";
        case PROGRAM_IDS.raydiumV4:
            return "raydium_v4";
        case PROGRAM_IDS.raydiumClmm:
            return "raydium_clmm";
        case PROGRAM_IDS.meteoraDlmm:
            return "meteora_dlmm";
        case PROGRAM_IDS.jupiter:
            return "jupiter";
        default:
            return null;
    }
}
