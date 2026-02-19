/**
 * Jito Bundle Builder
 *
 * Constructs Jito bundles for backrun execution.
 * Supports PumpSwap, RaydiumV4, and Meteora DLMM swap legs.
 */

import {
    Keypair,
    PublicKey,
    TransactionMessage,
    VersionedTransaction,
    TransactionInstruction,
    SystemProgram,
    ComputeBudgetProgram,
} from '@solana/web3.js';
import type {
    BundleConfig,
    PumpSwapPool,
    RaydiumV4Pool,
    MeteoraDlmmPool,
    SwapDirection,
} from '../types.js';
import { VenueId, SwapDirection as Dir } from '../types.js';
import type { BundleTransaction, BundleRequest } from './types.js';

// ============================================================================
// Constants
// ============================================================================

// Jito tip accounts (mainnet)
const JITO_TIP_ACCOUNTS = [
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

// PumpSwap program
const PUMPSWAP_PROGRAM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

// PumpSwap swap discriminators (Anchor sighash)
const PS_BUY_DISC = Buffer.from('66063d1201daebea', 'hex');
const PS_SELL_DISC = Buffer.from('33e685a4017f83ad', 'hex');

// RaydiumV4 program
const RAYDIUMV4_PROGRAM = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');

// Meteora DLMM program
const METEORA_DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

// RaydiumV4 SwapV2 discriminators (single-byte, native program)
const RV4_SWAP_BASE_IN_V2 = 16;
const RV4_SWAP_BASE_OUT_V2 = 17;

// Meteora DLMM swap discriminator (global:swap)
const DLMM_SWAP_DISC = Buffer.from('f8c69e91e17587c8', 'hex');

// Well-known program IDs
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');
const ASSOC_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const GLOBAL_CONFIG = new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');

// AMM Authority seed for RaydiumV4
const AMM_AUTHORITY_SEED = Buffer.from('amm authority');

// Event authority PDA (cached)
let _pumpEventAuthority: PublicKey | null = null;
function getPumpEventAuthority(): PublicKey {
    if (!_pumpEventAuthority) {
        [_pumpEventAuthority] = PublicKey.findProgramAddressSync(
            [Buffer.from('__event_authority')],
            PUMPSWAP_PROGRAM,
        );
    }
    return _pumpEventAuthority;
}

let _dlmmEventAuthority: PublicKey | null = null;
function getDlmmEventAuthority(): PublicKey {
    if (!_dlmmEventAuthority) {
        [_dlmmEventAuthority] = PublicKey.findProgramAddressSync(
            [Buffer.from('__event_authority')],
            METEORA_DLMM_PROGRAM,
        );
    }
    return _dlmmEventAuthority;
}

// RaydiumV4 AMM Authority PDA (cached per nonce)
const _ammAuthorityCache = new Map<number, PublicKey>();
function getAmmAuthority(nonce: number): PublicKey {
    let auth = _ammAuthorityCache.get(nonce);
    if (!auth) {
        auth = PublicKey.createProgramAddressSync(
            [AMM_AUTHORITY_SEED, Buffer.from([nonce])],
            RAYDIUMV4_PROGRAM,
        );
        _ammAuthorityCache.set(nonce, auth);
    }
    return auth;
}

// ============================================================================
// Types
// ============================================================================

export interface BuildResult {
    success: boolean;
    bundle?: BundleRequest;
    error?: string;
    buildLatencyUs: number;
}

export interface DlmmSwapMeta {
    // Optional accounts and extras needed for full DLMM route execution.
    binArrayBitmapExtension?: Uint8Array;
    hostFeeIn?: Uint8Array;
    tokenXProgram?: Uint8Array;
    tokenYProgram?: Uint8Array;
    eventAuthority?: Uint8Array;
    oracle?: Uint8Array;
    binArrays?: Uint8Array[];
}

/** Parameters for a single swap instruction */
export interface SwapParams {
    direction: SwapDirection;
    inputAmount: bigint;
    minOutput: bigint;
    pool: PumpSwapPool | RaydiumV4Pool | MeteoraDlmmPool;
    dlmm?: DlmmSwapMeta;
}

// ============================================================================
// ATA Derivation
// ============================================================================

function deriveATA(owner: PublicKey, mint: PublicKey): PublicKey {
    const [ata] = PublicKey.findProgramAddressSync(
        [owner.toBytes(), TOKEN_PROGRAM.toBytes(), mint.toBytes()],
        ASSOC_TOKEN_PROGRAM,
    );
    return ata;
}

function toPublicKey(bytes: Uint8Array | undefined, fallback: PublicKey): PublicKey {
    if (!bytes || bytes.length !== 32) return fallback;
    return new PublicKey(bytes);
}

function i64Le(index: number): Buffer {
    const out = Buffer.alloc(8);
    out.writeBigInt64LE(BigInt(index), 0);
    return out;
}

export function deriveDlmmBinArrayPda(lbPair: Uint8Array, index: number): Uint8Array {
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('bin_array'), Buffer.from(lbPair), i64Le(index)],
        METEORA_DLMM_PROGRAM,
    );
    return pda.toBytes();
}

// ============================================================================
// Instruction Builders
// ============================================================================

function buildPumpSwapSwapIx(
    payer: PublicKey,
    params: SwapParams,
): TransactionInstruction {
    const pool = params.pool as PumpSwapPool;
    const poolPk = new PublicKey(pool.pool);
    const baseMint = new PublicKey(pool.baseMint);
    const quoteMint = new PublicKey(pool.quoteMint);
    const baseVault = new PublicKey(pool.baseVault);
    const quoteVault = new PublicKey(pool.quoteVault);
    const userBaseATA = deriveATA(payer, baseMint);
    const userQuoteATA = deriveATA(payer, quoteMint);

    // Build instruction data (24 bytes)
    const data = Buffer.alloc(24);
    if (params.direction === Dir.BtoA) {
        // BUY: [disc, baseAmountOut (desired output), maxQuoteAmountIn]
        PS_BUY_DISC.copy(data, 0);
        data.writeBigUInt64LE(params.minOutput, 8);   // desired base out
        data.writeBigUInt64LE(params.inputAmount, 16); // max quote in
    } else {
        // SELL: [disc, baseAmountIn (exact input), minQuoteAmountOut]
        PS_SELL_DISC.copy(data, 0);
        data.writeBigUInt64LE(params.inputAmount, 8);  // exact base in
        data.writeBigUInt64LE(params.minOutput, 16);   // min quote out
    }

    // Account ordering per PumpSwap IDL
    const keys = [
        { pubkey: poolPk, isSigner: false, isWritable: true },
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: GLOBAL_CONFIG, isSigner: false, isWritable: false },
        { pubkey: baseMint, isSigner: false, isWritable: false },
        { pubkey: quoteMint, isSigner: false, isWritable: false },
        { pubkey: userBaseATA, isSigner: false, isWritable: true },
        { pubkey: userQuoteATA, isSigner: false, isWritable: true },
        { pubkey: baseVault, isSigner: false, isWritable: true },
        { pubkey: quoteVault, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: ASSOC_TOKEN_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: getPumpEventAuthority(), isSigner: false, isWritable: false },
        { pubkey: PUMPSWAP_PROGRAM, isSigner: false, isWritable: false },
    ];

    return new TransactionInstruction({
        programId: PUMPSWAP_PROGRAM,
        keys,
        data,
    });
}

/**
 * Build RaydiumV4 SwapV2 instruction (8 accounts, no OpenBook dependency).
 */
function buildRaydiumV4SwapIx(
    payer: PublicKey,
    params: SwapParams,
): TransactionInstruction {
    const pool = params.pool as RaydiumV4Pool;
    const poolPk = new PublicKey(pool.pool);
    const baseMint = new PublicKey(pool.baseMint);
    const quoteMint = new PublicKey(pool.quoteMint);
    const baseVault = new PublicKey(pool.baseVault);
    const quoteVault = new PublicKey(pool.quoteVault);
    const ammAuthority = getAmmAuthority(pool.nonce);

    const userBaseATA = deriveATA(payer, baseMint);
    const userQuoteATA = deriveATA(payer, quoteMint);

    let userSource: PublicKey;
    let userDest: PublicKey;
    if (params.direction === Dir.AtoB) {
        userSource = userBaseATA;
        userDest = userQuoteATA;
    } else {
        userSource = userQuoteATA;
        userDest = userBaseATA;
    }

    // Build instruction data (17 bytes): disc(1) + amount1(8) + amount2(8)
    const data = Buffer.alloc(17);
    if (params.direction === Dir.AtoB) {
        data[0] = RV4_SWAP_BASE_IN_V2;
        data.writeBigUInt64LE(params.inputAmount, 1);
        data.writeBigUInt64LE(params.minOutput, 9);
    } else {
        data[0] = RV4_SWAP_BASE_OUT_V2;
        data.writeBigUInt64LE(params.inputAmount, 1);
        data.writeBigUInt64LE(params.minOutput, 9);
    }

    const keys = [
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: poolPk, isSigner: false, isWritable: true },
        { pubkey: ammAuthority, isSigner: false, isWritable: false },
        { pubkey: baseVault, isSigner: false, isWritable: true },
        { pubkey: quoteVault, isSigner: false, isWritable: true },
        { pubkey: userSource, isSigner: false, isWritable: true },
        { pubkey: userDest, isSigner: false, isWritable: true },
        { pubkey: payer, isSigner: true, isWritable: true },
    ];

    return new TransactionInstruction({
        programId: RAYDIUMV4_PROGRAM,
        keys,
        data,
    });
}

export function buildMeteoraDlmmSwapIx(
    payer: PublicKey,
    params: SwapParams,
): TransactionInstruction {
    const pool = params.pool as MeteoraDlmmPool;

    const lbPair = new PublicKey(pool.pool);
    const tokenXMint = new PublicKey(pool.tokenXMint);
    const tokenYMint = new PublicKey(pool.tokenYMint);
    const reserveX = new PublicKey(pool.vaultX);
    const reserveY = new PublicKey(pool.vaultY);

    const userTokenX = deriveATA(payer, tokenXMint);
    const userTokenY = deriveATA(payer, tokenYMint);

    // AtoB means X->Y, BtoA means Y->X in this codebase.
    const swapForY = params.direction === Dir.AtoB;
    const userTokenIn = swapForY ? userTokenX : userTokenY;
    const userTokenOut = swapForY ? userTokenY : userTokenX;

    const oracle = toPublicKey(params.dlmm?.oracle ?? pool.oracle, lbPair);
    const eventAuthority = toPublicKey(params.dlmm?.eventAuthority, getDlmmEventAuthority());
    const bitmapExtension = toPublicKey(params.dlmm?.binArrayBitmapExtension, SYSTEM_PROGRAM);
    const hostFeeIn = toPublicKey(params.dlmm?.hostFeeIn, userTokenIn);
    const tokenXProgram = toPublicKey(params.dlmm?.tokenXProgram, TOKEN_PROGRAM);
    const tokenYProgram = toPublicKey(params.dlmm?.tokenYProgram, TOKEN_PROGRAM);

    const data = Buffer.alloc(25);
    DLMM_SWAP_DISC.copy(data, 0);
    data.writeBigUInt64LE(params.inputAmount, 8);
    data.writeBigUInt64LE(params.minOutput, 16);
    data[24] = swapForY ? 1 : 0;

    // Keep account ordering aligned with decode/programs/meteoraDlmm.ts assumptions.
    const keys = [
        { pubkey: lbPair, isSigner: false, isWritable: true },              // 0 lbPair
        { pubkey: bitmapExtension, isSigner: false, isWritable: false },    // 1 bitmap extension (optional)
        { pubkey: reserveX, isSigner: false, isWritable: true },            // 2 reserveX
        { pubkey: reserveY, isSigner: false, isWritable: true },            // 3 reserveY
        { pubkey: userTokenIn, isSigner: false, isWritable: true },         // 4 userTokenIn
        { pubkey: userTokenOut, isSigner: false, isWritable: true },        // 5 userTokenOut
        { pubkey: tokenXMint, isSigner: false, isWritable: false },         // 6 tokenXMint
        { pubkey: tokenYMint, isSigner: false, isWritable: false },         // 7 tokenYMint
        { pubkey: oracle, isSigner: false, isWritable: true },              // 8 oracle
        { pubkey: hostFeeIn, isSigner: false, isWritable: true },           // 9 hostFeeIn (optional)
        { pubkey: payer, isSigner: true, isWritable: true },                // 10 user
        { pubkey: tokenXProgram, isSigner: false, isWritable: false },      // 11 tokenXProgram
        { pubkey: tokenYProgram, isSigner: false, isWritable: false },      // 12 tokenYProgram
        { pubkey: eventAuthority, isSigner: false, isWritable: false },     // 13 eventAuthority
        { pubkey: METEORA_DLMM_PROGRAM, isSigner: false, isWritable: false }, // 14 program
    ];

    for (const acct of params.dlmm?.binArrays ?? []) {
        if (acct.length !== 32) continue;
        keys.push({
            pubkey: new PublicKey(acct),
            isSigner: false,
            isWritable: true,
        });
    }

    return new TransactionInstruction({
        programId: METEORA_DLMM_PROGRAM,
        keys,
        data,
    });
}

/**
 * Build swap instruction for the appropriate venue
 */
function buildSwapIx(payer: PublicKey, params: SwapParams): TransactionInstruction {
    if (params.pool.venue === VenueId.RaydiumV4) {
        return buildRaydiumV4SwapIx(payer, params);
    }
    if (params.pool.venue === VenueId.MeteoraDlmm) {
        return buildMeteoraDlmmSwapIx(payer, params);
    }
    return buildPumpSwapSwapIx(payer, params);
}

// ============================================================================
// Bundle Assembly
// ============================================================================

/**
 * Build Jito bundle for backrun.
 * Bundle structure: [victimTx, ourTx(CU + swap1 + swap2 + tip)]
 */
export function buildBundle(
    swap1: SwapParams,
    swap2: SwapParams,
    payer: Keypair,
    config: BundleConfig,
    recentBlockhash: string,
    victimTxBytes?: Uint8Array,
): BuildResult {
    const startNs = process.hrtime.bigint();

    try {
        const instructions: TransactionInstruction[] = [];

        instructions.push(
            ComputeBudgetProgram.setComputeUnitLimit({ units: config.computeUnitLimit }),
        );
        if (config.computeUnitPrice > 0n) {
            instructions.push(
                ComputeBudgetProgram.setComputeUnitPrice({
                    microLamports: Number(config.computeUnitPrice),
                }),
            );
        }

        instructions.push(buildSwapIx(payer.publicKey, swap1));
        instructions.push(buildSwapIx(payer.publicKey, swap2));

        const tipAccount = selectTipAccount();
        instructions.push(
            SystemProgram.transfer({
                fromPubkey: payer.publicKey,
                toPubkey: new PublicKey(tipAccount),
                lamports: config.tipLamports,
            }),
        );

        const message = new TransactionMessage({
            payerKey: payer.publicKey,
            recentBlockhash,
            instructions,
        }).compileToV0Message();

        const tx = new VersionedTransaction(message);
        tx.sign([payer]);

        const ourTx: BundleTransaction = {
            transaction: Buffer.from(tx.serialize()),
            signers: [Buffer.from(payer.secretKey)],
        };

        const transactions: BundleTransaction[] = [];

        if (victimTxBytes) {
            transactions.push({
                transaction: victimTxBytes,
                signers: [],
            });
        }

        transactions.push(ourTx);

        const bundle: BundleRequest = {
            transactions,
            tipLamports: config.tipLamports,
        };

        return {
            success: true,
            bundle,
            buildLatencyUs: Number(process.hrtime.bigint() - startNs) / 1000,
        };

    } catch (e) {
        const errText = e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e);
        return {
            success: false,
            error: errText,
            buildLatencyUs: Number(process.hrtime.bigint() - startNs) / 1000,
        };
    }
}

/** Select random Jito tip account */
export function selectTipAccount(): string {
    const index = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
    return JITO_TIP_ACCOUNTS[index]!;
}

/** Estimate compute units for backrun */
export function estimateComputeUnits(venue: number): number {
    const baseEstimates: Record<number, number> = {
        0: 120000,  // PumpSwap
        1: 200000,  // Raydium V4
        2: 400000,  // Raydium CLMM
        3: 300000,  // Meteora DLMM
    };
    return baseEstimates[venue] ?? 200000;
}
