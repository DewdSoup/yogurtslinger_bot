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
import type { PumpSwapGlobalConfig } from '../decode/programs/pumpswap.js';

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
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const MINT_PROGRAM_OVERRIDES = new Map<string, PublicKey>();
let _cachedGlobalConfig: PumpSwapGlobalConfig | null = null;

/** Set the PumpSwap GlobalConfig for PDA derivation in bundle building. */
export function setPumpSwapGlobalConfig(config: PumpSwapGlobalConfig): void {
    _cachedGlobalConfig = config;
}

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

export interface PumpRemainingAccountMeta {
    pubkey: Uint8Array;
    isSigner: boolean;
    isWritable: boolean;
}

/** Parameters for a single swap instruction */
export interface SwapParams {
    direction: SwapDirection;
    inputAmount: bigint;
    minOutput: bigint;
    pool: PumpSwapPool | RaydiumV4Pool | MeteoraDlmmPool;
    dlmm?: DlmmSwapMeta;
    pumpRemainingAccounts?: PumpRemainingAccountMeta[];
}

export function setMintProgramOverride(
    mint: Uint8Array | PublicKey,
    tokenProgram: Uint8Array | PublicKey,
): void {
    const mintPk = mint instanceof PublicKey ? mint : new PublicKey(mint);
    const programPk = tokenProgram instanceof PublicKey ? tokenProgram : new PublicKey(tokenProgram);
    MINT_PROGRAM_OVERRIDES.set(mintPk.toBase58(), programPk);
}

// ============================================================================
// ATA Derivation
// ============================================================================

function deriveATA(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
    const [ata] = PublicKey.findProgramAddressSync(
        [owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()],
        ASSOC_TOKEN_PROGRAM,
    );
    return ata;
}

interface UserAtaSpec {
    mint: PublicKey;
    tokenProgram: PublicKey;
}

function toPublicKey(bytes: Uint8Array | undefined, fallback: PublicKey): PublicKey {
    if (!bytes || bytes.length !== 32) return fallback;
    return new PublicKey(bytes);
}

function defaultTokenProgramForMint(mint: PublicKey): PublicKey | null {
    const override = MINT_PROGRAM_OVERRIDES.get(mint.toBase58());
    if (override) return override;
    if (mint.equals(WSOL_MINT)) return TOKEN_PROGRAM;
    // No heuristic — return null if not resolved via gRPC or RPC override.
    return null;
}

/** Resolve token program or throw if unknown (caught by buildBundle). */
function requireTokenProgram(mint: PublicKey): PublicKey {
    const program = defaultTokenProgramForMint(mint);
    if (!program) {
        throw new Error(`mint_program_unknown:${mint.toBase58()}`);
    }
    return program;
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
    const baseTokenProgram = requireTokenProgram(baseMint);
    const quoteTokenProgram = requireTokenProgram(quoteMint);
    const userBaseATA = deriveATA(payer, baseMint, baseTokenProgram);
    const userQuoteATA = deriveATA(payer, quoteMint, quoteTokenProgram);

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

    // Core account ordering per PumpSwap IDL
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
    ];

    // Prefer victim-observed trailing accounts when available.
    if (params.pumpRemainingAccounts && params.pumpRemainingAccounts.length > 0) {
        for (const meta of params.pumpRemainingAccounts) {
            if (!meta?.pubkey || meta.pubkey.length !== 32) continue;
            keys.push({
                pubkey: new PublicKey(meta.pubkey),
                isSigner: meta.isSigner,
                isWritable: meta.isWritable,
            });
        }
    } else {
        // Derive remaining accounts from cached pool state + GlobalConfig.
        if (!_cachedGlobalConfig || _cachedGlobalConfig.protocolFeeRecipients.length === 0) {
            throw new Error('pumpswap_global_config_not_available');
        }

        // Use first non-zero protocol fee recipient
        const feeRecipientBytes = _cachedGlobalConfig.protocolFeeRecipients[0]!;
        const protocolFeeRecipient = new PublicKey(feeRecipientBytes);
        const protocolFeeRecipientAta = deriveATA(protocolFeeRecipient, quoteMint, quoteTokenProgram);

        // coinCreatorVaultAuthority = PDA(["creator_vault", pool.coinCreator], PumpSwap)
        const [coinCreatorVaultAuthority] = PublicKey.findProgramAddressSync(
            [Buffer.from('creator_vault'), Buffer.from(pool.coinCreator)],
            PUMPSWAP_PROGRAM,
        );
        const coinCreatorVaultAta = deriveATA(coinCreatorVaultAuthority, quoteMint, quoteTokenProgram);

        keys.push(
            { pubkey: protocolFeeRecipient, isSigner: false, isWritable: false },              // 9
            { pubkey: protocolFeeRecipientAta, isSigner: false, isWritable: true },             // 10
            { pubkey: baseTokenProgram, isSigner: false, isWritable: false },                   // 11
            { pubkey: quoteTokenProgram, isSigner: false, isWritable: false },                  // 12
            { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },                     // 13
            { pubkey: ASSOC_TOKEN_PROGRAM, isSigner: false, isWritable: false },                // 14
            { pubkey: getPumpEventAuthority(), isSigner: false, isWritable: false },            // 15
            { pubkey: PUMPSWAP_PROGRAM, isSigner: false, isWritable: false },                   // 16
            { pubkey: coinCreatorVaultAta, isSigner: false, isWritable: true },                 // 17
            { pubkey: coinCreatorVaultAuthority, isSigner: false, isWritable: false },          // 18
        );
    }

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

    const userBaseATA = deriveATA(payer, baseMint, TOKEN_PROGRAM);
    const userQuoteATA = deriveATA(payer, quoteMint, TOKEN_PROGRAM);

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
    const tokenXProgram = toPublicKey(params.dlmm?.tokenXProgram, requireTokenProgram(tokenXMint));
    const tokenYProgram = toPublicKey(params.dlmm?.tokenYProgram, requireTokenProgram(tokenYMint));

    const userTokenX = deriveATA(payer, tokenXMint, tokenXProgram);
    const userTokenY = deriveATA(payer, tokenYMint, tokenYProgram);

    // AtoB means X->Y, BtoA means Y->X in this codebase.
    const swapForY = params.direction === Dir.AtoB;
    const userTokenIn = swapForY ? userTokenX : userTokenY;
    const userTokenOut = swapForY ? userTokenY : userTokenX;

    const oracle = toPublicKey(params.dlmm?.oracle ?? pool.oracle, lbPair);
    const eventAuthority = toPublicKey(params.dlmm?.eventAuthority, getDlmmEventAuthority());
    const bitmapExtension = toPublicKey(params.dlmm?.binArrayBitmapExtension, SYSTEM_PROGRAM);
    const hostFeeIn = toPublicKey(params.dlmm?.hostFeeIn, userTokenIn);

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

function collectUserAtaSpecs(params: SwapParams): UserAtaSpec[] {
    if (params.pool.venue === VenueId.MeteoraDlmm) {
        const pool = params.pool as MeteoraDlmmPool;
        const tokenXMint = new PublicKey(pool.tokenXMint);
        const tokenYMint = new PublicKey(pool.tokenYMint);
        const tokenXProgram = toPublicKey(params.dlmm?.tokenXProgram, requireTokenProgram(tokenXMint));
        const tokenYProgram = toPublicKey(params.dlmm?.tokenYProgram, requireTokenProgram(tokenYMint));
        return [
            { mint: tokenXMint, tokenProgram: tokenXProgram },
            { mint: tokenYMint, tokenProgram: tokenYProgram },
        ];
    }

    const pool = params.pool as PumpSwapPool | RaydiumV4Pool;
    const baseMint = new PublicKey(pool.baseMint);
    const quoteMint = new PublicKey(pool.quoteMint);
    const baseTokenProgram = params.pool.venue === VenueId.PumpSwap
        ? requireTokenProgram(baseMint)
        : TOKEN_PROGRAM;
    const quoteTokenProgram = params.pool.venue === VenueId.PumpSwap
        ? requireTokenProgram(quoteMint)
        : TOKEN_PROGRAM;
    return [
        { mint: baseMint, tokenProgram: baseTokenProgram },
        { mint: quoteMint, tokenProgram: quoteTokenProgram },
    ];
}

function buildCreateAtaIdempotentIx(
    payer: PublicKey,
    owner: PublicKey,
    mint: PublicKey,
    tokenProgram: PublicKey,
): TransactionInstruction {
    const ata = deriveATA(owner, mint, tokenProgram);
    return new TransactionInstruction({
        programId: ASSOC_TOKEN_PROGRAM,
        keys: [
            { pubkey: payer, isSigner: true, isWritable: true },
            { pubkey: ata, isSigner: false, isWritable: true },
            { pubkey: owner, isSigner: false, isWritable: false },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
            { pubkey: tokenProgram, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([1]), // create_idempotent
    });
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

        // Ensure user token accounts exist for all swap mints.
        const ataSpecs = [...collectUserAtaSpecs(swap1), ...collectUserAtaSpecs(swap2)];
        const seenAtas = new Set<string>();
        for (const spec of ataSpecs) {
            const ata = deriveATA(payer.publicKey, spec.mint, spec.tokenProgram);
            const ataKey = ata.toBase58();
            if (seenAtas.has(ataKey)) continue;
            seenAtas.add(ataKey);
            instructions.push(
                buildCreateAtaIdempotentIx(
                    payer.publicKey,
                    payer.publicKey,
                    spec.mint,
                    spec.tokenProgram,
                ),
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
