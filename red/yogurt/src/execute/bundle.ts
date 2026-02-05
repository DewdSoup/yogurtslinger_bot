/**
 * Jito Bundle Builder (Phase 8)
 *
 * Constructs Jito bundles for PumpSwap backrun execution.
 * Builds swap instructions, tip, and assembles into V0 transactions.
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
    Opportunity,
    BundleConfig,
    PoolState,
    PumpSwapPool,
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
const BUY_DISC = Buffer.from('66063d1201daebea', 'hex');
const SELL_DISC = Buffer.from('33e685a4017f83ad', 'hex');

// Well-known program IDs
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');
const ASSOC_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const GLOBAL_CONFIG = new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');

// Event authority PDA (cached)
let _eventAuthority: PublicKey | null = null;
function getEventAuthority(): PublicKey {
    if (!_eventAuthority) {
        [_eventAuthority] = PublicKey.findProgramAddressSync(
            [Buffer.from('__event_authority')],
            PUMPSWAP_PROGRAM,
        );
    }
    return _eventAuthority;
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

/** Parameters for a single PumpSwap swap instruction */
export interface SwapParams {
    direction: SwapDirection;
    inputAmount: bigint;
    minOutput: bigint;
    pool: PumpSwapPool;
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

// ============================================================================
// Instruction Builders
// ============================================================================

function buildPumpSwapSwapIx(
    payer: PublicKey,
    params: SwapParams,
): TransactionInstruction {
    const pool = params.pool;
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
        BUY_DISC.copy(data, 0);
        data.writeBigUInt64LE(params.minOutput, 8);   // desired base out
        data.writeBigUInt64LE(params.inputAmount, 16); // max quote in
    } else {
        // SELL: [disc, baseAmountIn (exact input), minQuoteAmountOut]
        SELL_DISC.copy(data, 0);
        data.writeBigUInt64LE(params.inputAmount, 8);  // exact base in
        data.writeBigUInt64LE(params.minOutput, 16);   // min quote out
    }

    // Account ordering per PumpSwap IDL
    const keys = [
        { pubkey: poolPk, isSigner: false, isWritable: true },           // 0 pool
        { pubkey: payer, isSigner: true, isWritable: true },             // 1 user
        { pubkey: GLOBAL_CONFIG, isSigner: false, isWritable: false },   // 2 globalConfig
        { pubkey: baseMint, isSigner: false, isWritable: false },        // 3 baseMint
        { pubkey: quoteMint, isSigner: false, isWritable: false },       // 4 quoteMint
        { pubkey: userBaseATA, isSigner: false, isWritable: true },      // 5 userBaseTokenAccount
        { pubkey: userQuoteATA, isSigner: false, isWritable: true },     // 6 userQuoteTokenAccount
        { pubkey: baseVault, isSigner: false, isWritable: true },        // 7 poolBaseTokenAccount
        { pubkey: quoteVault, isSigner: false, isWritable: true },       // 8 poolQuoteTokenAccount
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },   // 9 tokenProgram
        { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false }, // 10 token2022Program
        { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },  // 11 systemProgram
        { pubkey: ASSOC_TOKEN_PROGRAM, isSigner: false, isWritable: false }, // 12 associatedTokenProgram
        { pubkey: getEventAuthority(), isSigner: false, isWritable: false }, // 13 eventAuthority
        { pubkey: PUMPSWAP_PROGRAM, isSigner: false, isWritable: false },   // 14 program
    ];

    return new TransactionInstruction({
        programId: PUMPSWAP_PROGRAM,
        keys,
        data,
    });
}

// ============================================================================
// Bundle Assembly
// ============================================================================

/**
 * Build Jito bundle for PumpSwap backrun.
 *
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

        // Compute budget
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

        // Swap 1 (opposite of victim — enter position)
        instructions.push(buildPumpSwapSwapIx(payer.publicKey, swap1));

        // Swap 2 (same as victim — close position)
        instructions.push(buildPumpSwapSwapIx(payer.publicKey, swap2));

        // Tip (inline in same tx)
        const tipAccount = selectTipAccount();
        instructions.push(
            SystemProgram.transfer({
                fromPubkey: payer.publicKey,
                toPubkey: new PublicKey(tipAccount),
                lamports: config.tipLamports,
            }),
        );

        // Build V0 transaction
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

        // Assemble bundle
        const transactions: BundleTransaction[] = [];

        if (victimTxBytes) {
            transactions.push({
                transaction: victimTxBytes,
                signers: [], // victim's tx is already signed
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
        return {
            success: false,
            error: String(e),
            buildLatencyUs: Number(process.hrtime.bigint() - startNs) / 1000,
        };
    }
}

/**
 * Select random Jito tip account
 */
export function selectTipAccount(): string {
    const index = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
    return JITO_TIP_ACCOUNTS[index];
}

/**
 * Estimate compute units for backrun (2 PumpSwap swaps + tip)
 */
export function estimateComputeUnits(venue: number): number {
    const baseEstimates: Record<number, number> = {
        0: 120000,  // PumpSwap (2 swaps + tip)
        1: 200000,  // Raydium V4
        2: 400000,  // Raydium CLMM
        3: 300000,  // Meteora DLMM
    };
    return baseEstimates[venue] ?? 200000;
}
