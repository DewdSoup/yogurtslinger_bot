/**
 * Raydium V4 Pool Decoder (Phase 2) + Swap Instruction Decoder (Phase 5)
 * Program: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
 *
 * Native program (no Anchor discriminator).
 * Identified by: owner + exact size 752 bytes
 *
 * Layout (752 bytes):
 *   [0..8]     status (u64)
 *   [32..40]   baseDecimal (u64)
 *   [40..48]   quoteDecimal (u64)
 *   [176..184] swapFeeNumerator (u64)
 *   [184..192] swapFeeDenominator (u64)
 *   [192..200] baseNeedTakePnl (u64)
 *   [200..208] quoteNeedTakePnl (u64)
 *   [336..368] baseVault (pubkey)
 *   [368..400] quoteVault (pubkey)
 *   [400..432] baseMint (pubkey)
 *   [432..464] quoteMint (pubkey)
 *   [464..496] lpMint (pubkey)
 *   [496..528] openOrders (pubkey)
 *   [592..624] targetOrders (pubkey)
 *
 * Swap Instructions (native, single-byte discriminator):
 *   9  = swapBaseIn  (exact input)
 *   11 = swapBaseOut (exact output)
 */

import type { RaydiumV4Pool, CompiledInstruction, SwapLeg } from '../../types.js';
import { VenueId, SwapDirection } from '../../types.js';

const EXACT_SIZE = 752;

// Swap instruction discriminators (single byte, native program)
const SWAP_BASE_IN = 9;
const SWAP_BASE_OUT = 11;

// Swap instruction account indices
const IDX_AMM = 1;
const IDX_POOL_COIN_VAULT = 5;
const IDX_POOL_PC_VAULT = 6;
const IDX_USER_SOURCE = 15;
const IDX_USER_DEST = 16;

const SWAP_MIN_DATA_LEN = 17; // disc(1) + amountIn(8) + amountOut(8)
const SWAP_MIN_ACCOUNTS = 18;

/**
 * Fast size check (V4 has no discriminator)
 */
export function isRaydiumV4Pool(data: Uint8Array): boolean {
    return data.length === EXACT_SIZE;
}

/**
 * Decode Raydium V4 pool account
 * Returns null on invalid data (no throw in hot path)
 */
export function decodeRaydiumV4Pool(
    pubkey: Uint8Array,
    data: Uint8Array
): RaydiumV4Pool | null {
    if (!isRaydiumV4Pool(data)) return null;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    const baseDecimalU64 = view.getBigUint64(32, true);
    const quoteDecimalU64 = view.getBigUint64(40, true);

    // Sanity check decimals
    if (baseDecimalU64 > 18n || quoteDecimalU64 > 18n) return null;

    return {
        venue: VenueId.RaydiumV4,
        pool: pubkey,
        baseMint: data.slice(400, 432),
        quoteMint: data.slice(432, 464),
        baseVault: data.slice(336, 368),
        quoteVault: data.slice(368, 400),
        lpMint: data.slice(464, 496),
        openOrders: data.slice(496, 528),
        targetOrders: data.slice(592, 624),
        nonce: Number(view.getBigUint64(8, true)),
        baseDecimal: Number(baseDecimalU64),
        quoteDecimal: Number(quoteDecimalU64),
        status: view.getBigUint64(0, true),
        swapFeeNumerator: view.getBigUint64(176, true),
        swapFeeDenominator: view.getBigUint64(184, true),
        baseNeedTakePnl: view.getBigUint64(192, true),
        quoteNeedTakePnl: view.getBigUint64(200, true),
    };
}

// ============================================================================
// SWAP INSTRUCTION DECODER (Phase 5)
// ============================================================================

/**
 * Check if instruction is a Raydium V4 swap
 */
export function isRaydiumV4Swap(data: Uint8Array): boolean {
    if (data.length < SWAP_MIN_DATA_LEN) return false;
    const disc = data[0];
    return disc === SWAP_BASE_IN || disc === SWAP_BASE_OUT;
}

/**
 * Check if instruction is swapBaseIn (exact input)
 */
export function isSwapBaseIn(data: Uint8Array): boolean {
    return data.length >= 1 && data[0] === SWAP_BASE_IN;
}

/**
 * Decode Raydium V4 swap instruction
 *
 * swapBaseIn layout (17 bytes):
 *   [0]      discriminator (u8) = 9
 *   [1..9]   amountIn (u64 LE)
 *   [9..17]  minAmountOut (u64 LE)
 *
 * swapBaseOut layout (17 bytes):
 *   [0]      discriminator (u8) = 11
 *   [1..9]   maxAmountIn (u64 LE)
 *   [9..17]  amountOut (u64 LE)
 *
 * Account layout (18 accounts):
 *   0  - tokenProgram
 *   1  - amm (pool)
 *   2  - ammAuthority
 *   3  - ammOpenOrders
 *   4  - ammTargetOrders
 *   5  - poolCoinTokenAccount (base vault)
 *   6  - poolPcTokenAccount (quote vault)
 *   7  - serumProgram
 *   8  - serumMarket
 *   9  - serumBids
 *   10 - serumAsks
 *   11 - serumEventQueue
 *   12 - serumCoinVaultAccount
 *   13 - serumPcVaultAccount
 *   14 - serumVaultSigner
 *   15 - userSourceToken
 *   16 - userDestToken
 *   17 - userOwner
 */
export function decodeRaydiumV4Instruction(
    instruction: CompiledInstruction,
    accountKeys: Uint8Array[]
): SwapLeg | null {
    const { data, accountKeyIndexes } = instruction;

    // Validate
    if (!isRaydiumV4Swap(data)) return null;
    if (accountKeyIndexes.length < SWAP_MIN_ACCOUNTS) return null;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const isExactIn = isSwapBaseIn(data);

    // Extract amounts
    let inputAmount: bigint;
    let minOutputAmount: bigint;

    if (isExactIn) {
        inputAmount = view.getBigUint64(1, true);
        minOutputAmount = view.getBigUint64(9, true);
    } else {
        // swapBaseOut: maxAmountIn, amountOut
        inputAmount = view.getBigUint64(1, true);      // maxAmountIn
        minOutputAmount = view.getBigUint64(9, true);  // exact amountOut
    }

    // Extract account pubkeys
    const ammIdx = accountKeyIndexes[IDX_AMM];
    const coinVaultIdx = accountKeyIndexes[IDX_POOL_COIN_VAULT];
    const pcVaultIdx = accountKeyIndexes[IDX_POOL_PC_VAULT];
    const userSourceIdx = accountKeyIndexes[IDX_USER_SOURCE];
    const userDestIdx = accountKeyIndexes[IDX_USER_DEST];

    if (ammIdx === undefined || coinVaultIdx === undefined || pcVaultIdx === undefined ||
        userSourceIdx === undefined || userDestIdx === undefined) {
        return null;
    }

    const pool = accountKeys[ammIdx];
    const poolCoinVault = accountKeys[coinVaultIdx];
    const poolPcVault = accountKeys[pcVaultIdx];

    if (!pool || !poolCoinVault || !poolPcVault) return null;

    // Direction detection from instruction discriminator:
    // swapBaseIn (disc=9): user sells base for quote → AtoB
    // swapBaseOut (disc=11): user buys base with quote → BtoA
    const direction = isExactIn ? SwapDirection.AtoB : SwapDirection.BtoA;

    return {
        venue: VenueId.RaydiumV4,
        pool,
        direction,
        inputMint: new Uint8Array(32),  // Placeholder - resolve from pool state
        outputMint: new Uint8Array(32), // Placeholder - resolve from pool state
        inputAmount,
        minOutputAmount,
    };
}

/**
 * Decode with pool state for accurate direction/mints
 */
export function decodeRaydiumV4InstructionWithPool(
    instruction: CompiledInstruction,
    accountKeys: Uint8Array[],
    poolState: RaydiumV4Pool
): SwapLeg | null {
    const { data, accountKeyIndexes } = instruction;

    if (!isRaydiumV4Swap(data)) return null;
    if (accountKeyIndexes.length < SWAP_MIN_ACCOUNTS) return null;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const isExactIn = isSwapBaseIn(data);

    const inputAmount = view.getBigUint64(1, true);
    const minOutputAmount = view.getBigUint64(9, true);

    const ammIdx = accountKeyIndexes[IDX_AMM];
    const userSourceIdx = accountKeyIndexes[IDX_USER_SOURCE];
    const userDestIdx = accountKeyIndexes[IDX_USER_DEST];

    if (ammIdx === undefined || userSourceIdx === undefined || userDestIdx === undefined) {
        return null;
    }

    const pool = accountKeys[ammIdx];
    if (!pool) return null;

    // Direction detection from instruction discriminator:
    // swapBaseIn (disc=9): user sells base for quote → AtoB
    //   inputMint = baseMint, outputMint = quoteMint
    // swapBaseOut (disc=11): user buys base with quote → BtoA
    //   inputMint = quoteMint, outputMint = baseMint
    const direction = isExactIn ? SwapDirection.AtoB : SwapDirection.BtoA;
    const inputMint = isExactIn ? poolState.baseMint : poolState.quoteMint;
    const outputMint = isExactIn ? poolState.quoteMint : poolState.baseMint;

    return {
        venue: VenueId.RaydiumV4,
        pool,
        direction,
        inputMint,
        outputMint,
        inputAmount,
        minOutputAmount,
    };
}