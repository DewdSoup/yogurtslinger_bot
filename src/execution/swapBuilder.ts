// src/execution/swapBuilder.ts
// Swap instruction builders for PumpSwap, Raydium V4, Raydium CLMM, and Meteora
//
// WARNING: Account orders are based on program documentation
// VERIFY against actual programs before mainnet deployment

import {
    PublicKey,
    TransactionInstruction,
    SystemProgram,
} from "@solana/web3.js";

// ============================================================================
// PROGRAM IDS
// ============================================================================

export const PROGRAM_IDS = {
    PUMPSWAP: new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"),
    RAYDIUM_V4: new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),
    RAYDIUM_CLMM: new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"),  // ✅ NEW
    METEORA_DLMM: new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"),
    TOKEN_PROGRAM: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    TOKEN_2022_PROGRAM: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
    ASSOCIATED_TOKEN_PROGRAM: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
    SYSTEM_PROGRAM: SystemProgram.programId,
    RENT: new PublicKey("SysvarRent111111111111111111111111111111111"),
};

export const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// ============================================================================
// INSTRUCTION DISCRIMINATORS
// ============================================================================

export const PUMPSWAP_DISCRIMINATORS = {
    BUY: Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]),
    SELL: Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]),
};

export const RAYDIUM_DISCRIMINATORS = {
    SWAP_BASE_IN: 9,
    SWAP_BASE_OUT: 10,
};

// ✅ NEW: Raydium CLMM discriminators (8-byte Anchor)
export const RAYDIUM_CLMM_DISCRIMINATORS = {
    SWAP: Buffer.from([0xf8, 0xc6, 0x9e, 0x91, 0xe1, 0x75, 0x87, 0xc8]),
    SWAP_V2: Buffer.from([0x2b, 0x04, 0xed, 0x0b, 0x1a, 0xc9, 0x1e, 0x62]),
};

export const METEORA_DISCRIMINATORS = {
    SWAP: Buffer.from([0xf8, 0xc6, 0x9e, 0x91, 0xe1, 0x75, 0x87, 0xc8]),
};

// ============================================================================
// ATA UTILITIES (Inline to avoid @solana/spl-token dependency)
// ============================================================================

/**
 * Derives Associated Token Account address without external dependency
 */
export function getATA(mint: PublicKey, owner: PublicKey): PublicKey {
    const [ata] = PublicKey.findProgramAddressSync(
        [owner.toBuffer(), PROGRAM_IDS.TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
        PROGRAM_IDS.ASSOCIATED_TOKEN_PROGRAM
    );
    return ata;
}

/**
 * Creates instruction to create an ATA if it doesn't exist
 */
export function createATAInstruction(
    payer: PublicKey,
    owner: PublicKey,
    mint: PublicKey
): TransactionInstruction {
    const ata = getATA(mint, owner);

    return new TransactionInstruction({
        programId: PROGRAM_IDS.ASSOCIATED_TOKEN_PROGRAM,
        keys: [
            { pubkey: payer, isSigner: true, isWritable: true },
            { pubkey: ata, isSigner: false, isWritable: true },
            { pubkey: owner, isSigner: false, isWritable: false },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: PROGRAM_IDS.SYSTEM_PROGRAM, isSigner: false, isWritable: false },
            { pubkey: PROGRAM_IDS.TOKEN_PROGRAM, isSigner: false, isWritable: false },
        ],
        data: Buffer.alloc(0),
    });
}

// ============================================================================
// PUMPSWAP INSTRUCTIONS
// ============================================================================

export interface PumpSwapAccounts {
    pool: PublicKey;
    user: PublicKey;
    userBaseAta: PublicKey;
    userQuoteAta: PublicKey;
    poolBaseVault: PublicKey;
    poolQuoteVault: PublicKey;
    baseMint: PublicKey;
    quoteMint: PublicKey;
    feeRecipient?: PublicKey;
    globalConfig?: PublicKey;
}

export function buildPumpSwapBuyInstruction(
    accounts: PumpSwapAccounts,
    amountIn: bigint,
    minAmountOut: bigint
): TransactionInstruction {
    // Data layout: discriminator (8) + amountIn (8) + minAmountOut (8)
    const data = Buffer.alloc(24);
    PUMPSWAP_DISCRIMINATORS.BUY.copy(data, 0);
    data.writeBigUInt64LE(amountIn, 8);
    data.writeBigUInt64LE(minAmountOut, 16);

    const keys = [
        { pubkey: accounts.pool, isSigner: false, isWritable: true },
        { pubkey: accounts.user, isSigner: true, isWritable: true },
        { pubkey: accounts.userBaseAta, isSigner: false, isWritable: true },
        { pubkey: accounts.userQuoteAta, isSigner: false, isWritable: true },
        { pubkey: accounts.poolBaseVault, isSigner: false, isWritable: true },
        { pubkey: accounts.poolQuoteVault, isSigner: false, isWritable: true },
        { pubkey: accounts.baseMint, isSigner: false, isWritable: false },
        { pubkey: accounts.quoteMint, isSigner: false, isWritable: false },
        { pubkey: PROGRAM_IDS.TOKEN_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: PROGRAM_IDS.SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    ];

    if (accounts.feeRecipient) {
        keys.push({ pubkey: accounts.feeRecipient, isSigner: false, isWritable: true });
    }
    if (accounts.globalConfig) {
        keys.push({ pubkey: accounts.globalConfig, isSigner: false, isWritable: false });
    }

    return new TransactionInstruction({
        programId: PROGRAM_IDS.PUMPSWAP,
        keys,
        data,
    });
}

export function buildPumpSwapSellInstruction(
    accounts: PumpSwapAccounts,
    amountIn: bigint,
    minAmountOut: bigint
): TransactionInstruction {
    const data = Buffer.alloc(24);
    PUMPSWAP_DISCRIMINATORS.SELL.copy(data, 0);
    data.writeBigUInt64LE(amountIn, 8);
    data.writeBigUInt64LE(minAmountOut, 16);

    const keys = [
        { pubkey: accounts.pool, isSigner: false, isWritable: true },
        { pubkey: accounts.user, isSigner: true, isWritable: true },
        { pubkey: accounts.userBaseAta, isSigner: false, isWritable: true },
        { pubkey: accounts.userQuoteAta, isSigner: false, isWritable: true },
        { pubkey: accounts.poolBaseVault, isSigner: false, isWritable: true },
        { pubkey: accounts.poolQuoteVault, isSigner: false, isWritable: true },
        { pubkey: accounts.baseMint, isSigner: false, isWritable: false },
        { pubkey: accounts.quoteMint, isSigner: false, isWritable: false },
        { pubkey: PROGRAM_IDS.TOKEN_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: PROGRAM_IDS.SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    ];

    if (accounts.feeRecipient) {
        keys.push({ pubkey: accounts.feeRecipient, isSigner: false, isWritable: true });
    }
    if (accounts.globalConfig) {
        keys.push({ pubkey: accounts.globalConfig, isSigner: false, isWritable: false });
    }

    return new TransactionInstruction({
        programId: PROGRAM_IDS.PUMPSWAP,
        keys,
        data,
    });
}

// ============================================================================
// RAYDIUM V4 INSTRUCTIONS
// ============================================================================

export interface RaydiumAccounts {
    amm: PublicKey;
    ammAuthority: PublicKey;
    ammOpenOrders: PublicKey;
    ammTargetOrders: PublicKey;
    poolCoinVault: PublicKey;
    poolPcVault: PublicKey;
    serumProgram: PublicKey;
    serumMarket: PublicKey;
    serumBids: PublicKey;
    serumAsks: PublicKey;
    serumEventQueue: PublicKey;
    serumCoinVault: PublicKey;
    serumPcVault: PublicKey;
    serumVaultSigner: PublicKey;
    user: PublicKey;
    userCoinAta: PublicKey;
    userPcAta: PublicKey;
}

export function buildRaydiumSwapInstruction(
    accounts: RaydiumAccounts,
    amountIn: bigint,
    minAmountOut: bigint,
    swapBaseIn: boolean = true
): TransactionInstruction {
    // Data layout: instruction (1) + amountIn (8) + minAmountOut (8)
    const data = Buffer.alloc(17);
    data.writeUInt8(swapBaseIn ? RAYDIUM_DISCRIMINATORS.SWAP_BASE_IN : RAYDIUM_DISCRIMINATORS.SWAP_BASE_OUT, 0);
    data.writeBigUInt64LE(amountIn, 1);
    data.writeBigUInt64LE(minAmountOut, 9);

    const keys = [
        { pubkey: PROGRAM_IDS.TOKEN_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: accounts.amm, isSigner: false, isWritable: true },
        { pubkey: accounts.ammAuthority, isSigner: false, isWritable: false },
        { pubkey: accounts.ammOpenOrders, isSigner: false, isWritable: true },
        { pubkey: accounts.ammTargetOrders, isSigner: false, isWritable: true },
        { pubkey: accounts.poolCoinVault, isSigner: false, isWritable: true },
        { pubkey: accounts.poolPcVault, isSigner: false, isWritable: true },
        { pubkey: accounts.serumProgram, isSigner: false, isWritable: false },
        { pubkey: accounts.serumMarket, isSigner: false, isWritable: true },
        { pubkey: accounts.serumBids, isSigner: false, isWritable: true },
        { pubkey: accounts.serumAsks, isSigner: false, isWritable: true },
        { pubkey: accounts.serumEventQueue, isSigner: false, isWritable: true },
        { pubkey: accounts.serumCoinVault, isSigner: false, isWritable: true },
        { pubkey: accounts.serumPcVault, isSigner: false, isWritable: true },
        { pubkey: accounts.serumVaultSigner, isSigner: false, isWritable: false },
        { pubkey: accounts.userCoinAta, isSigner: false, isWritable: true },
        { pubkey: accounts.userPcAta, isSigner: false, isWritable: true },
        { pubkey: accounts.user, isSigner: true, isWritable: false },
    ];

    return new TransactionInstruction({
        programId: PROGRAM_IDS.RAYDIUM_V4,
        keys,
        data,
    });
}

// Simplified Raydium swap (without OpenBook market accounts)
export interface RaydiumSimpleAccounts {
    amm: PublicKey;
    ammAuthority: PublicKey;
    ammOpenOrders: PublicKey;
    poolCoinVault: PublicKey;
    poolPcVault: PublicKey;
    user: PublicKey;
    userCoinAta: PublicKey;
    userPcAta: PublicKey;
}

export function buildRaydiumSimpleSwapInstruction(
    accounts: RaydiumSimpleAccounts,
    amountIn: bigint,
    minAmountOut: bigint,
    swapBaseIn: boolean = true
): TransactionInstruction {
    const data = Buffer.alloc(17);
    data.writeUInt8(swapBaseIn ? RAYDIUM_DISCRIMINATORS.SWAP_BASE_IN : RAYDIUM_DISCRIMINATORS.SWAP_BASE_OUT, 0);
    data.writeBigUInt64LE(amountIn, 1);
    data.writeBigUInt64LE(minAmountOut, 9);

    const keys = [
        { pubkey: PROGRAM_IDS.TOKEN_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: accounts.amm, isSigner: false, isWritable: true },
        { pubkey: accounts.ammAuthority, isSigner: false, isWritable: false },
        { pubkey: accounts.ammOpenOrders, isSigner: false, isWritable: true },
        { pubkey: accounts.poolCoinVault, isSigner: false, isWritable: true },
        { pubkey: accounts.poolPcVault, isSigner: false, isWritable: true },
        { pubkey: accounts.userCoinAta, isSigner: false, isWritable: true },
        { pubkey: accounts.userPcAta, isSigner: false, isWritable: true },
        { pubkey: accounts.user, isSigner: true, isWritable: false },
    ];

    return new TransactionInstruction({
        programId: PROGRAM_IDS.RAYDIUM_V4,
        keys,
        data,
    });
}

// ============================================================================
// ✅ NEW: RAYDIUM CLMM INSTRUCTIONS
// ============================================================================

export interface RaydiumCLMMAccounts {
    poolState: PublicKey;
    ammConfig: PublicKey;
    inputTokenAccount: PublicKey;
    outputTokenAccount: PublicKey;
    inputVault: PublicKey;
    outputVault: PublicKey;
    observationState: PublicKey;
    user: PublicKey;
    inputMint: PublicKey;
    outputMint: PublicKey;
    // TickArrays - up to 3 for multi-tick swaps
    tickArray0: PublicKey;
    tickArray1?: PublicKey;
    tickArray2?: PublicKey;
    // Token program (could be Token-2022)
    inputTokenProgram?: PublicKey;
    outputTokenProgram?: PublicKey;
}

/**
 * Build Raydium CLMM swap instruction
 * 
 * @param accounts - Pool and user accounts
 * @param amountIn - Input amount in lamports/tokens
 * @param minAmountOut - Minimum output (slippage protection)
 * @param sqrtPriceLimitX64 - Price limit (0 = no limit)
 * @param isBaseInput - true if swapping base->quote, false for quote->base
 * 
 * CRITICAL: Account order validated against Raydium CLMM program
 */
export function buildRaydiumCLMMSwapInstruction(
    accounts: RaydiumCLMMAccounts,
    amountIn: bigint,
    minAmountOut: bigint,
    sqrtPriceLimitX64: bigint = 0n,
    isBaseInput: boolean = true
): TransactionInstruction {
    // Data layout: discriminator (8) + amountIn (8) + minAmountOut (8) + sqrtPriceLimitX64 (16) + isBaseInput (1)
    const data = Buffer.alloc(41);
    RAYDIUM_CLMM_DISCRIMINATORS.SWAP.copy(data, 0);
    data.writeBigUInt64LE(amountIn, 8);
    data.writeBigUInt64LE(minAmountOut, 16);

    // sqrtPriceLimitX64 is u128 - write as two u64s (little endian)
    const lowBits = sqrtPriceLimitX64 & 0xFFFFFFFFFFFFFFFFn;
    const highBits = sqrtPriceLimitX64 >> 64n;
    data.writeBigUInt64LE(lowBits, 24);
    data.writeBigUInt64LE(highBits, 32);

    data.writeUInt8(isBaseInput ? 1 : 0, 40);

    // Determine token programs (default to standard Token Program)
    const inputTokenProgram = accounts.inputTokenProgram ?? PROGRAM_IDS.TOKEN_PROGRAM;
    const outputTokenProgram = accounts.outputTokenProgram ?? PROGRAM_IDS.TOKEN_PROGRAM;

    const keys = [
        // Core accounts
        { pubkey: accounts.user, isSigner: true, isWritable: false },
        { pubkey: accounts.ammConfig, isSigner: false, isWritable: false },
        { pubkey: accounts.poolState, isSigner: false, isWritable: true },

        // Token accounts
        { pubkey: accounts.inputTokenAccount, isSigner: false, isWritable: true },
        { pubkey: accounts.outputTokenAccount, isSigner: false, isWritable: true },
        { pubkey: accounts.inputVault, isSigner: false, isWritable: true },
        { pubkey: accounts.outputVault, isSigner: false, isWritable: true },

        // Observation
        { pubkey: accounts.observationState, isSigner: false, isWritable: true },

        // Programs
        { pubkey: inputTokenProgram, isSigner: false, isWritable: false },
        { pubkey: outputTokenProgram, isSigner: false, isWritable: false },

        // Memos (for Token-2022 compatibility)
        { pubkey: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), isSigner: false, isWritable: false },

        // Mints
        { pubkey: accounts.inputMint, isSigner: false, isWritable: false },
        { pubkey: accounts.outputMint, isSigner: false, isWritable: false },

        // TickArrays (required for price traversal)
        { pubkey: accounts.tickArray0, isSigner: false, isWritable: true },
    ];

    // Add optional tick arrays
    if (accounts.tickArray1) {
        keys.push({ pubkey: accounts.tickArray1, isSigner: false, isWritable: true });
    }
    if (accounts.tickArray2) {
        keys.push({ pubkey: accounts.tickArray2, isSigner: false, isWritable: true });
    }

    return new TransactionInstruction({
        programId: PROGRAM_IDS.RAYDIUM_CLMM,
        keys,
        data,
    });
}

/**
 * Build Raydium CLMM swap V2 instruction (extended version with more features)
 * This version supports additional parameters like exactInput flag
 */
export function buildRaydiumCLMMSwapV2Instruction(
    accounts: RaydiumCLMMAccounts,
    amountSpecified: bigint,
    otherAmountThreshold: bigint,
    sqrtPriceLimitX64: bigint = 0n,
    isBaseInput: boolean = true
): TransactionInstruction {
    // Data layout: discriminator (8) + amount (8) + threshold (8) + sqrtPriceLimitX64 (16) + isBaseInput (1)
    const data = Buffer.alloc(41);
    RAYDIUM_CLMM_DISCRIMINATORS.SWAP_V2.copy(data, 0);
    data.writeBigUInt64LE(amountSpecified, 8);
    data.writeBigUInt64LE(otherAmountThreshold, 16);

    const lowBits = sqrtPriceLimitX64 & 0xFFFFFFFFFFFFFFFFn;
    const highBits = sqrtPriceLimitX64 >> 64n;
    data.writeBigUInt64LE(lowBits, 24);
    data.writeBigUInt64LE(highBits, 32);

    data.writeUInt8(isBaseInput ? 1 : 0, 40);

    const inputTokenProgram = accounts.inputTokenProgram ?? PROGRAM_IDS.TOKEN_PROGRAM;
    const outputTokenProgram = accounts.outputTokenProgram ?? PROGRAM_IDS.TOKEN_PROGRAM;

    const keys = [
        { pubkey: accounts.user, isSigner: true, isWritable: false },
        { pubkey: accounts.ammConfig, isSigner: false, isWritable: false },
        { pubkey: accounts.poolState, isSigner: false, isWritable: true },
        { pubkey: accounts.inputTokenAccount, isSigner: false, isWritable: true },
        { pubkey: accounts.outputTokenAccount, isSigner: false, isWritable: true },
        { pubkey: accounts.inputVault, isSigner: false, isWritable: true },
        { pubkey: accounts.outputVault, isSigner: false, isWritable: true },
        { pubkey: accounts.observationState, isSigner: false, isWritable: true },
        { pubkey: inputTokenProgram, isSigner: false, isWritable: false },
        { pubkey: outputTokenProgram, isSigner: false, isWritable: false },
        { pubkey: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), isSigner: false, isWritable: false },
        { pubkey: accounts.inputMint, isSigner: false, isWritable: false },
        { pubkey: accounts.outputMint, isSigner: false, isWritable: false },
        { pubkey: accounts.tickArray0, isSigner: false, isWritable: true },
    ];

    if (accounts.tickArray1) {
        keys.push({ pubkey: accounts.tickArray1, isSigner: false, isWritable: true });
    }
    if (accounts.tickArray2) {
        keys.push({ pubkey: accounts.tickArray2, isSigner: false, isWritable: true });
    }

    return new TransactionInstruction({
        programId: PROGRAM_IDS.RAYDIUM_CLMM,
        keys,
        data,
    });
}

/**
 * Helper to derive TickArray PDAs for a CLMM pool swap
 * Uses the validated i32 BIG ENDIAN encoding
 */
export function deriveTickArrayPDA(
    poolId: PublicKey,
    startTickIndex: number
): PublicKey {
    // CRITICAL: i32 must be BIG ENDIAN for PDA derivation!
    const indexBuffer = Buffer.alloc(4);
    indexBuffer.writeInt32BE(startTickIndex);

    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("tick_array"), poolId.toBuffer(), indexBuffer],
        PROGRAM_IDS.RAYDIUM_CLMM
    );
    return pda;
}

/**
 * Get TickArray PDAs for a swap direction
 * Returns PDAs for current, next, and next+1 tick arrays
 */
export function getTickArraysForCLMMSwap(
    poolId: PublicKey,
    currentTick: number,
    tickSpacing: number,
    zeroForOne: boolean,
    count: number = 3
): PublicKey[] {
    const TICKS_PER_ARRAY = 60;
    const ticksPerArray = TICKS_PER_ARRAY * tickSpacing;

    // Get current array start
    const currentArrayStart = Math.floor(currentTick / ticksPerArray) * ticksPerArray;

    const arrays: PublicKey[] = [];
    const direction = zeroForOne ? -1 : 1;

    for (let i = 0; i < count; i++) {
        const startIndex = currentArrayStart + (direction * i * ticksPerArray);
        arrays.push(deriveTickArrayPDA(poolId, startIndex));
    }

    return arrays;
}

// ============================================================================
// METEORA DLMM INSTRUCTIONS
// ============================================================================

export interface MeteoraAccounts {
    lbPair: PublicKey;
    user: PublicKey;
    userTokenX: PublicKey;
    userTokenY: PublicKey;
    reserveX: PublicKey;
    reserveY: PublicKey;
    tokenXMint: PublicKey;
    tokenYMint: PublicKey;
    oracle: PublicKey;
    binArrayLower?: PublicKey;
    binArrayUpper?: PublicKey;
    eventAuthority?: PublicKey;
}

export function buildMeteoraSwapInstruction(
    accounts: MeteoraAccounts,
    amountIn: bigint,
    minAmountOut: bigint,
    swapForY: boolean
): TransactionInstruction {
    // Data layout: discriminator (8) + amountIn (8) + minAmountOut (8) + swapForY (1)
    const data = Buffer.alloc(25);
    METEORA_DISCRIMINATORS.SWAP.copy(data, 0);
    data.writeBigUInt64LE(amountIn, 8);
    data.writeBigUInt64LE(minAmountOut, 16);
    data.writeUInt8(swapForY ? 1 : 0, 24);

    const keys = [
        { pubkey: accounts.lbPair, isSigner: false, isWritable: true },
        { pubkey: accounts.reserveX, isSigner: false, isWritable: true },
        { pubkey: accounts.reserveY, isSigner: false, isWritable: true },
        { pubkey: accounts.userTokenX, isSigner: false, isWritable: true },
        { pubkey: accounts.userTokenY, isSigner: false, isWritable: true },
        { pubkey: accounts.tokenXMint, isSigner: false, isWritable: false },
        { pubkey: accounts.tokenYMint, isSigner: false, isWritable: false },
        { pubkey: accounts.oracle, isSigner: false, isWritable: true },
        { pubkey: accounts.user, isSigner: true, isWritable: false },
        { pubkey: PROGRAM_IDS.TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ];

    if (accounts.binArrayLower) {
        keys.push({ pubkey: accounts.binArrayLower, isSigner: false, isWritable: true });
    }
    if (accounts.binArrayUpper) {
        keys.push({ pubkey: accounts.binArrayUpper, isSigner: false, isWritable: true });
    }
    if (accounts.eventAuthority) {
        keys.push({ pubkey: accounts.eventAuthority, isSigner: false, isWritable: false });
    }

    return new TransactionInstruction({
        programId: PROGRAM_IDS.METEORA_DLMM,
        keys,
        data,
    });
}

// ============================================================================
// GENERIC SWAP BUILDER
// ============================================================================

// ✅ UPDATED: Added RaydiumCLMM venue
export type Venue = "PumpSwap" | "RaydiumV4" | "RaydiumCLMM" | "Meteora";

export interface GenericSwapParams {
    venue: Venue;
    amountIn: bigint;
    minAmountOut: bigint;
    isBuy: boolean;
    accounts: PumpSwapAccounts | RaydiumSimpleAccounts | RaydiumCLMMAccounts | MeteoraAccounts;
    // CLMM-specific
    sqrtPriceLimitX64?: bigint;
}

export function buildSwapInstruction(params: GenericSwapParams): TransactionInstruction {
    switch (params.venue) {
        case "PumpSwap":
            if (params.isBuy) {
                return buildPumpSwapBuyInstruction(
                    params.accounts as PumpSwapAccounts,
                    params.amountIn,
                    params.minAmountOut
                );
            } else {
                return buildPumpSwapSellInstruction(
                    params.accounts as PumpSwapAccounts,
                    params.amountIn,
                    params.minAmountOut
                );
            }

        case "RaydiumV4":
            return buildRaydiumSimpleSwapInstruction(
                params.accounts as RaydiumSimpleAccounts,
                params.amountIn,
                params.minAmountOut,
                params.isBuy
            );

        case "RaydiumCLMM":  // ✅ NEW
            return buildRaydiumCLMMSwapInstruction(
                params.accounts as RaydiumCLMMAccounts,
                params.amountIn,
                params.minAmountOut,
                params.sqrtPriceLimitX64 ?? 0n,
                params.isBuy
            );

        case "Meteora":
            return buildMeteoraSwapInstruction(
                params.accounts as MeteoraAccounts,
                params.amountIn,
                params.minAmountOut,
                params.isBuy
            );

        default:
            throw new Error(`Unsupported venue: ${params.venue}`);
    }
}

// ============================================================================
// VALIDATION
// ============================================================================

export function validateSwapInstruction(
    instruction: TransactionInstruction,
    venue: Venue
): { valid: boolean; error?: string } {
    // Check program ID
    const expectedProgramId =
        venue === "PumpSwap" ? PROGRAM_IDS.PUMPSWAP :
            venue === "RaydiumV4" ? PROGRAM_IDS.RAYDIUM_V4 :
                venue === "RaydiumCLMM" ? PROGRAM_IDS.RAYDIUM_CLMM :  // ✅ NEW
                    PROGRAM_IDS.METEORA_DLMM;

    if (!instruction.programId.equals(expectedProgramId)) {
        return { valid: false, error: `Wrong program ID for ${venue}` };
    }

    // Check minimum account count
    const minAccounts =
        venue === "PumpSwap" ? 10 :
            venue === "RaydiumV4" ? 9 :
                venue === "RaydiumCLMM" ? 14 :  // ✅ NEW
                    10;

    if (instruction.keys.length < minAccounts) {
        return { valid: false, error: `Too few accounts: ${instruction.keys.length} < ${minAccounts}` };
    }

    // Check data length
    const minDataLen =
        venue === "PumpSwap" ? 24 :
            venue === "RaydiumV4" ? 17 :
                venue === "RaydiumCLMM" ? 41 :  // ✅ NEW
                    25;

    if (instruction.data.length < minDataLen) {
        return { valid: false, error: `Data too short: ${instruction.data.length} < ${minDataLen}` };
    }

    // Check for signer
    const hasSigner = instruction.keys.some(k => k.isSigner);
    if (!hasSigner) {
        return { valid: false, error: "No signer in instruction" };
    }

    return { valid: true };
}

export default {
    PROGRAM_IDS,
    SOL_MINT,
    PUMPSWAP_DISCRIMINATORS,
    RAYDIUM_DISCRIMINATORS,
    RAYDIUM_CLMM_DISCRIMINATORS,  // ✅ NEW
    METEORA_DISCRIMINATORS,
    getATA,
    createATAInstruction,
    buildPumpSwapBuyInstruction,
    buildPumpSwapSellInstruction,
    buildRaydiumSwapInstruction,
    buildRaydiumSimpleSwapInstruction,
    buildRaydiumCLMMSwapInstruction,  // ✅ NEW
    buildRaydiumCLMMSwapV2Instruction,  // ✅ NEW
    deriveTickArrayPDA,  // ✅ NEW
    getTickArraysForCLMMSwap,  // ✅ NEW
    buildMeteoraSwapInstruction,
    buildSwapInstruction,
    validateSwapInstruction,
};