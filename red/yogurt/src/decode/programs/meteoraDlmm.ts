/**
 * Meteora DLMM (LbPair) Pool Decoder (Phase 2) + Swap Instruction Decoder (Phase 5)
 * Program: LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo
 *
 * Anchor discriminator: 210b3162b565b10d
 *
 * Layout (904 bytes):
 *   [0..8]     discriminator
 *   --- StaticParameters (offset 8) ---
 *   [8..10]    baseFactor (u16)
 *   [32..34]   protocolShare (u16)
 *   --- VariableParameters (offset 40) ---
 *   [40..44]   volatilityAccumulator (u32)
 *   [44..48]   volatilityReference (u32)
 *   --- Main fields (offset 72) ---
 *   [76..80]   activeId (i32)
 *   [80..82]   binStep (u16)
 *   [82]       status (u8)
 *   --- Pubkeys (offset 88) ---
 *   [88..120]  tokenXMint (pubkey)
 *   [120..152] tokenYMint (pubkey)
 *   [152..184] reserveX (pubkey) - vault
 *   [184..216] reserveY (pubkey) - vault
 *
 * Swap Instructions (Anchor):
 *   swap:                  f8c69e91e17587c8
 *   swap_exact_out:        80493441b7f749c7
 *   swap_with_price_impact: 6d29e38e870a7a9d
 */

import type { MeteoraDlmmPool, CompiledInstruction, SwapLeg } from '../../types.js';
import { VenueId, SwapDirection } from '../../types.js';

// Pool discriminator: 210b3162b565b10d
const POOL_DISC_0 = 0x21;
const POOL_DISC_1 = 0x0b;
const POOL_DISC_2 = 0x31;
const POOL_DISC_3 = 0x62;
const POOL_DISC_4 = 0xb5;
const POOL_DISC_5 = 0x65;
const POOL_DISC_6 = 0xb1;
const POOL_DISC_7 = 0x0d;

const MIN_SIZE = 904;

// Swap instruction discriminators (Anchor sighash, 8 bytes)
// sha256("global:swap")[0..8]
const SWAP_DISC = new Uint8Array([0xf8, 0xc6, 0x9e, 0x91, 0xe1, 0x75, 0x87, 0xc8]);
// sha256("global:swap2")[0..8] - Most common swap instruction on mainnet
const SWAP2_DISC = new Uint8Array([0x41, 0x4b, 0x3f, 0x4c, 0xeb, 0x5b, 0x5b, 0x88]);
// sha256("global:swap_exact_out")[0..8]
const SWAP_EXACT_OUT_DISC = new Uint8Array([0xfa, 0x49, 0x65, 0x21, 0x26, 0xcf, 0x4b, 0xb8]);
// sha256("global:swap_with_price_impact")[0..8]
const SWAP_PRICE_IMPACT_DISC = new Uint8Array([0x38, 0xad, 0xe6, 0xd0, 0xad, 0xe4, 0x9c, 0xcd]);
// sha256("global:swap2_exact_out")[0..8] - Missing v2 variant
const SWAP2_EXACT_OUT_DISC = new Uint8Array([0x2b, 0xd7, 0xf7, 0x84, 0x89, 0x3c, 0xf3, 0x51]);
// sha256("global:swap2_with_price_impact")[0..8] - Missing v2 variant
const SWAP2_PRICE_IMPACT_DISC = new Uint8Array([0x4a, 0x62, 0xc0, 0xd6, 0xb1, 0x33, 0x4b, 0x33]);

// Swap instruction account indices
const IDX_LB_PAIR = 0;
const IDX_RESERVE_X = 2;
const IDX_RESERVE_Y = 3;
const IDX_USER_TOKEN_IN = 4;
const IDX_USER_TOKEN_OUT = 5;
const IDX_TOKEN_X_MINT = 6;
const IDX_TOKEN_Y_MINT = 7;

const SWAP_MIN_DATA_LEN = 25; // disc(8) + amount(8) + threshold(8) + swapForY(1)
const SWAP_MIN_ACCOUNTS = 15;

/**
 * Fast discriminator check for pool
 */
export function isMeteoraDlmmPool(data: Uint8Array): boolean {
    return data.length >= MIN_SIZE &&
        data[0] === POOL_DISC_0 &&
        data[1] === POOL_DISC_1 &&
        data[2] === POOL_DISC_2 &&
        data[3] === POOL_DISC_3 &&
        data[4] === POOL_DISC_4 &&
        data[5] === POOL_DISC_5 &&
        data[6] === POOL_DISC_6 &&
        data[7] === POOL_DISC_7;
}

/**
 * Decode Meteora DLMM pool account
 * Returns null on invalid data (no throw in hot path)
 */
export function decodeMeteoraDlmmPool(
    pubkey: Uint8Array,
    data: Uint8Array
): MeteoraDlmmPool | null {
    if (!isMeteoraDlmmPool(data)) return null;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    // Decode binArrayBitmap: 16 × i64 at offset 216-344 (128 bytes)
    const binArrayBitmap = new BigInt64Array(16);
    for (let i = 0; i < 16; i++) {
        binArrayBitmap[i] = view.getBigInt64(216 + i * 8, true);
    }

    return {
        venue: VenueId.MeteoraDlmm,
        pool: pubkey,
        tokenXMint: data.slice(88, 120),
        tokenYMint: data.slice(120, 152),
        vaultX: data.slice(152, 184),
        vaultY: data.slice(184, 216),
        binStep: view.getUint16(80, true),
        activeId: view.getInt32(76, true),
        baseFactor: BigInt(view.getUint16(8, true)),
        protocolShare: BigInt(view.getUint16(32, true)),
        volatilityAccumulator: view.getUint32(40, true),
        volatilityReference: view.getUint32(44, true),
        status: data[82]!,
        binArrayBitmap,
    };
}

// ============================================================================
// BIN ARRAY BITMAP UTILITIES
// ============================================================================

/**
 * HARD RULE FOR BIGINT BITMAPS
 * ============================
 *
 * Anywhere you have:
 *   - BigInt64Array
 *   - getBigInt64()
 *   - bitwise loops (value &= value - 1n, etc.)
 *
 * You MUST mask to unsigned before bit operations:
 *   value = asU64(value)
 *
 * NO EXCEPTIONS.
 *
 * Why BigInt64Array instead of BigUint64Array?
 * Meteora spec defines binArrayBitmap as i64[16]. We keep the type matching
 * the spec, but mask before bit ops. If spec said u64, we'd use BigUint64Array.
 *
 * What happens without masking?
 * V8's BitwiseAnd_NegNeg for negative BigInts is O(∞) - infinite CPU spin.
 * A bitmap word of 0xFFFFFFFFFFFFFFFF becomes -1n when read as signed.
 * Then (value &= value - 1n) never terminates.
 */
const U64_MASK = 0xFFFFFFFFFFFFFFFFn;

/** Convert potentially negative BigInt to unsigned 64-bit representation */
const asU64 = (x: bigint): bigint => x & U64_MASK;

/**
 * Get all initialized bin array indices from the bitmap.
 * Bitmap covers indices -512 to +511 (1024 bits = 16 × i64).
 *
 * @param bitmap - 16-element BigInt64Array from pool state
 * @returns Array of bin array indices that are initialized
 */
export function getAllInitializedBinArrays(bitmap: BigInt64Array): number[] {
    const initialized: number[] = [];

    // Bitmap layout: 16 × i64, each i64 covers 64 bin arrays
    // Total: 1024 bin arrays, indices from -512 to +511
    for (let word = 0; word < 16; word++) {
        const value = asU64(bitmap[word]!);
        if (value === 0n) continue;

        for (let bit = 0; bit < 64; bit++) {
            if ((value & (1n << BigInt(bit))) !== 0n) {
                // Convert flat position to signed index: position - 512
                const flatPos = word * 64 + bit;
                const binArrayIndex = flatPos - 512;
                initialized.push(binArrayIndex);
            }
        }
    }

    return initialized;
}

/**
 * Count total initialized bin arrays in bitmap
 */
export function countInitializedBinArrays(bitmap: BigInt64Array): number {
    let count = 0;
    for (let word = 0; word < 16; word++) {
        let value = asU64(bitmap[word]!);
        // Brian Kernighan's algorithm for counting set bits
        while (value !== 0n) {
            value &= value - 1n;
            count++;
        }
    }
    return count;
}

/**
 * Check if a specific bin array index is initialized
 */
export function isBinArrayInitialized(bitmap: BigInt64Array, index: number): boolean {
    if (index < -512 || index > 511) {
        // Outside default bitmap range - need BinArrayBitmapExtension
        return false;
    }

    const flatPos = index + 512;
    const word = Math.floor(flatPos / 64);
    const bit = flatPos % 64;

    return (asU64(bitmap[word]!) & (1n << BigInt(bit))) !== 0n;
}

// ============================================================================
// SWAP INSTRUCTION DECODER (Phase 5)
// ============================================================================

/**
 * Check 8-byte discriminator match
 */
function discMatch(data: Uint8Array, disc: Uint8Array): boolean {
    for (let i = 0; i < 8; i++) {
        if (data[i] !== disc[i]) return false;
    }
    return true;
}

/**
 * Check if instruction is a Meteora DLMM swap
 */
export function isMeteoraDlmmSwap(data: Uint8Array): boolean {
    if (data.length < SWAP_MIN_DATA_LEN) return false;
    return discMatch(data, SWAP_DISC) ||
        discMatch(data, SWAP2_DISC) ||
        discMatch(data, SWAP_EXACT_OUT_DISC) ||
        discMatch(data, SWAP_PRICE_IMPACT_DISC) ||
        discMatch(data, SWAP2_EXACT_OUT_DISC) ||
        discMatch(data, SWAP2_PRICE_IMPACT_DISC);
}

/**
 * Get swap variant type
 */
export function getSwapVariant(data: Uint8Array): 'swap' | 'swap2' | 'swapExactOut' | 'swapWithPriceImpact' | 'swap2ExactOut' | 'swap2WithPriceImpact' | null {
    if (data.length < 8) return null;
    if (discMatch(data, SWAP_DISC)) return 'swap';
    if (discMatch(data, SWAP2_DISC)) return 'swap2';
    if (discMatch(data, SWAP_EXACT_OUT_DISC)) return 'swapExactOut';
    if (discMatch(data, SWAP_PRICE_IMPACT_DISC)) return 'swapWithPriceImpact';
    if (discMatch(data, SWAP2_EXACT_OUT_DISC)) return 'swap2ExactOut';
    if (discMatch(data, SWAP2_PRICE_IMPACT_DISC)) return 'swap2WithPriceImpact';
    return null;
}

/**
 * Decode Meteora DLMM swap instruction
 *
 * swap layout (25 bytes):
 *   [0..8]   discriminator
 *   [8..16]  amountIn (u64)
 *   [16..24] minAmountOut (u64)
 *   [24]     swapForY (bool) - true = X->Y (AtoB), false = Y->X (BtoA)
 *
 * swap_exact_out layout (25 bytes):
 *   [0..8]   discriminator
 *   [8..16]  maxAmountIn (u64)
 *   [16..24] amountOut (u64)
 *   [24]     swapForY (bool)
 *
 * swap_with_price_impact layout (27+ bytes):
 *   [0..8]   discriminator
 *   [8..16]  amountIn (u64)
 *   [16..24] minAmountOut (u64)
 *   [24]     swapForY (bool)
 *   [25..27] maxPriceImpactBps (u16)
 *
 * Account layout (15+ accounts):
 *   0  - lbPair (pool)
 *   1  - binArrayBitmapExtension (optional)
 *   2  - reserveX (vault X)
 *   3  - reserveY (vault Y)
 *   4  - userTokenIn
 *   5  - userTokenOut
 *   6  - tokenXMint
 *   7  - tokenYMint
 *   8  - oracle
 *   9  - hostFeeIn (optional)
 *   10 - user
 *   11 - tokenXProgram
 *   12 - tokenYProgram
 *   13 - eventAuthority
 *   14 - program
 *   15+ - binArrays (remaining accounts)
 */
export function decodeMeteoraDlmmInstruction(
    instruction: CompiledInstruction,
    accountKeys: Uint8Array[]
): SwapLeg | null {
    const { data, accountKeyIndexes } = instruction;

    // Validate
    const variant = getSwapVariant(data);
    if (!variant) return null;
    if (accountKeyIndexes.length < SWAP_MIN_ACCOUNTS) return null;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    // Parse amounts and swapForY based on variant
    let inputAmount: bigint;
    let minOutputAmount: bigint;
    let swapForY: boolean;

    if (variant === 'swap' || variant === 'swap2' || variant === 'swapWithPriceImpact' || variant === 'swap2WithPriceImpact') {
        // Exact input variants
        // swap/swapWithPriceImpact: [disc(8), amountIn(8), minAmountOut(8), swapForY(1)]
        // swap2/swap2WithPriceImpact: [disc(8), amountIn(8), minAmountOut(8), remainingAccountsInfo(...)]
        inputAmount = view.getBigUint64(8, true);
        minOutputAmount = view.getBigUint64(16, true);

        if (variant === 'swap2' || variant === 'swap2WithPriceImpact') {
            // swap2/swap2WithPriceImpact have RemainingAccountsInfo after amounts, NOT a swapForY boolean
            // Format: [disc(8), amountIn(8), minAmountOut(8), RemainingAccountsInfo(...)]
            //
            // RemainingAccountsInfo layout:
            //   [length: u8, ...slices]
            //   where each slice is [accountsType: u8, length: u8]
            //
            // To determine direction, we need to look at account positions:
            // If userTokenOut receives from reserveY → user gets Y → swapForY=true (X→Y)
            // If userTokenOut receives from reserveX → user gets X → swapForY=false (Y→X)
            //
            // Account indices: reserveX=2, reserveY=3, userTokenIn=4, userTokenOut=5
            // The transfer pairs are:
            //   swapForY=true:  userTokenIn→reserveX, reserveY→userTokenOut
            //   swapForY=false: userTokenIn→reserveY, reserveX→userTokenOut
            //
            // Without CPI introspection, check RemainingAccountsInfo for hints:
            // If first slice is TransferHookX (0), swap involves X first → swapForY=true
            // If first slice is TransferHookY (1), swap involves Y first → swapForY=false
            const numSlices = data[24];
            if (numSlices === 0) {
                // No transfer hooks - cannot determine from data, default to true
                swapForY = true;
            } else if (data.length >= 26) {
                // First slice's accountsType: 0=TransferHookX, 1=TransferHookY
                const firstSliceType = data[25];
                // If first hook is X, user is inputting X → swapForY=true
                // If first hook is Y, user is inputting Y → swapForY=false
                swapForY = firstSliceType === 0;
            } else {
                swapForY = true; // Default
            }
        } else {
            // Regular swap/swapWithPriceImpact has swapForY at byte 24
            swapForY = data[24] !== 0;
        }
    } else if (variant === 'swapExactOut') {
        // swapExactOut: [disc(8), maxAmountIn(8), amountOut(8), swapForY(1)]
        const maxAmountIn = view.getBigUint64(8, true);
        const amountOut = view.getBigUint64(16, true);
        inputAmount = maxAmountIn;
        minOutputAmount = amountOut;
        // swapForY boolean is at byte 24
        swapForY = data[24] !== 0;
    } else {
        // swap2ExactOut: [disc(8), maxAmountIn(8), amountOut(8), RemainingAccountsInfo(...)]
        const maxAmountIn = view.getBigUint64(8, true);
        const amountOut = view.getBigUint64(16, true);
        inputAmount = maxAmountIn;
        minOutputAmount = amountOut;
        // swap2ExactOut uses RemainingAccountsInfo like swap2
        const numSlices = data[24];
        if (numSlices === 0) {
            swapForY = true;
        } else if (data.length >= 26) {
            const firstSliceType = data[25];
            swapForY = firstSliceType === 0;
        } else {
            swapForY = true;
        }
    }

    // Extract account pubkeys
    const poolIdx = accountKeyIndexes[IDX_LB_PAIR];
    const tokenXMintIdx = accountKeyIndexes[IDX_TOKEN_X_MINT];
    const tokenYMintIdx = accountKeyIndexes[IDX_TOKEN_Y_MINT];

    if (poolIdx === undefined || tokenXMintIdx === undefined || tokenYMintIdx === undefined) {
        return null;
    }

    const pool = accountKeys[poolIdx];
    const tokenXMint = accountKeys[tokenXMintIdx];
    const tokenYMint = accountKeys[tokenYMintIdx];

    if (!pool || !tokenXMint || !tokenYMint) return null;

    // Direction from swapForY:
    // swapForY = true: selling X for Y (AtoB)
    // swapForY = false: selling Y for X (BtoA)
    const direction = swapForY ? SwapDirection.AtoB : SwapDirection.BtoA;

    // Set input/output mints based on direction
    const inputMint = swapForY ? tokenXMint : tokenYMint;
    const outputMint = swapForY ? tokenYMint : tokenXMint;

    return {
        venue: VenueId.MeteoraDlmm,
        pool,
        direction,
        inputMint,
        outputMint,
        inputAmount,
        minOutputAmount,
    };
}

/**
 * Decode with pool state for accurate direction/mints
 * Uses swapForY from instruction data and pool state for canonical mints
 */
export function decodeMeteoraDlmmInstructionWithPool(
    instruction: CompiledInstruction,
    accountKeys: Uint8Array[],
    poolState: MeteoraDlmmPool
): SwapLeg | null {
    const { data, accountKeyIndexes } = instruction;

    const variant = getSwapVariant(data);
    if (!variant) return null;
    if (accountKeyIndexes.length < SWAP_MIN_ACCOUNTS) return null;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    // Parse amounts and swapForY
    let inputAmount: bigint;
    let minOutputAmount: bigint;

    if (variant === 'swap' || variant === 'swapWithPriceImpact') {
        inputAmount = view.getBigUint64(8, true);
        minOutputAmount = view.getBigUint64(16, true);
    } else {
        // swapExactOut
        inputAmount = view.getBigUint64(8, true);
        minOutputAmount = view.getBigUint64(16, true);
    }

    // swapForY boolean at byte 24
    const swapForY = data[24] !== 0;

    const poolIdx = accountKeyIndexes[IDX_LB_PAIR];

    if (poolIdx === undefined) {
        return null;
    }

    const pool = accountKeys[poolIdx];

    if (!pool) return null;

    // Direction from swapForY, mints from pool state (canonical)
    // swapForY = true: X→Y (AtoB)
    // swapForY = false: Y→X (BtoA)
    const direction = swapForY ? SwapDirection.AtoB : SwapDirection.BtoA;
    const inputMint = swapForY ? poolState.tokenXMint : poolState.tokenYMint;
    const outputMint = swapForY ? poolState.tokenYMint : poolState.tokenXMint;

    return {
        venue: VenueId.MeteoraDlmm,
        pool,
        direction,
        inputMint,
        outputMint,
        inputAmount,
        minOutputAmount,
    };
}

/**
 * Extract bin array account pubkeys from remaining accounts
 * These are needed for simulation
 */
export function extractBinArrayAccounts(
    instruction: CompiledInstruction,
    accountKeys: Uint8Array[]
): Uint8Array[] {
    const { accountKeyIndexes } = instruction;
    // Bin arrays start at index 15
    const binArrays: Uint8Array[] = [];
    for (let i = 15; i < accountKeyIndexes.length; i++) {
        const idx = accountKeyIndexes[i];
        if (idx !== undefined) {
            const key = accountKeys[idx];
            if (key) binArrays.push(key);
        }
    }
    return binArrays;
}