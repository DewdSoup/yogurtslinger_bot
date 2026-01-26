// src/execution/jitoBundleBuilder.ts
//
// Jito bundle builder for atomic MEV execution.
//
// Builds and submits Jito bundles containing:
// 1. (Optional) Trigger transaction to backrun
// 2. Arb transaction(s) to capture the opportunity
// 3. Tip transaction to Jito block engine
//
// Key features:
// - Uses jito-ts SDK for gRPC communication
// - Supports backrun bundles (trigger + arb)
// - Supports standalone bundles (arb only)
// - Handles tip calculation and distribution
// - Tracks bundle status and confirmation

import {
    Connection,
    Keypair,
    PublicKey,
    SystemProgram,
    VersionedTransaction,
    TransactionInstruction,
    TransactionMessage,
    ComputeBudgetProgram,
} from "@solana/web3.js";
import { searcherClient, type SearcherClient } from "jito-ts/dist/sdk/block-engine/searcher";
import { Bundle } from "jito-ts/dist/sdk/block-engine/types";
import type { ArbOpportunity } from "../detection/crossVenueArbDetector";

// Suppress unused variable warning - ArbOpportunity is used in type annotations
void (0 as unknown as ArbOpportunity);

// ============================================================================
// Types
// ============================================================================

export interface JitoBundleConfig {
    /** Block engine gRPC URL */
    blockEngineUrl: string;
    /** Keypair for signing transactions */
    signerKeypair: Keypair;
    /** RPC connection for recent blockhash */
    connection: Connection;
    /** Tip accounts (Jito tip program accounts) */
    tipAccounts: PublicKey[];
    /** Default tip amount in lamports */
    defaultTipLamports: bigint;
    /** Max compute units per transaction */
    maxComputeUnits: number;
    /** Compute unit price in micro-lamports */
    computeUnitPrice: number;
}

export interface BundleSubmitResult {
    success: boolean;
    bundleId?: string;
    error?: string;
    slot?: number;
}

export interface SwapInstructionParams {
    venue: string;
    programId: PublicKey;
    accounts: PublicKey[];
    data: Buffer;
}

// ============================================================================
// Jito Tip Accounts
// ============================================================================

// Official Jito tip accounts (8 accounts, randomly select one)
const JITO_TIP_ACCOUNTS = [
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
    "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
    "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

// ============================================================================
// Bundle Builder
// ============================================================================

export class JitoBundleBuilder {
    private config: JitoBundleConfig;
    private client: SearcherClient | null = null;

    // Stats
    private stats = {
        bundlesSubmitted: 0,
        bundlesAccepted: 0,
        bundlesRejected: 0,
        totalTipsPaid: BigInt(0),
    };

    constructor(config: JitoBundleConfig) {
        this.config = config;
    }

    /**
     * Initialize the Jito searcher client.
     */
    async connect(): Promise<void> {
        this.client = searcherClient(this.config.blockEngineUrl);
    }

    /**
     * Build and submit a bundle for a cross-venue arb opportunity.
     *
     * @param opportunity - The detected arb opportunity
     * @param buyInstructions - Instructions for the buy leg
     * @param sellInstructions - Instructions for the sell leg
     * @param triggerTx - Optional trigger transaction to backrun
     */
    async submitArbBundle(
        opportunity: ArbOpportunity,
        buyInstructions: SwapInstructionParams,
        sellInstructions: SwapInstructionParams,
        triggerTx?: VersionedTransaction
    ): Promise<BundleSubmitResult> {
        if (!this.client) {
            return { success: false, error: "Client not connected" };
        }

        try {
            // Get recent blockhash
            const { blockhash } = await this.config.connection.getLatestBlockhash("confirmed");

            // Build the arb transaction
            const arbTx = await this.buildArbTransaction(
                buyInstructions,
                sellInstructions,
                opportunity.inputAmount,
                blockhash
            );

            // Build the tip transaction
            const tipTx = await this.buildTipTransaction(
                this.config.defaultTipLamports,
                blockhash
            );

            // Assemble the bundle
            const transactions: VersionedTransaction[] = [];

            // Add trigger tx if backrunning
            if (triggerTx) {
                transactions.push(triggerTx);
            }

            // Add arb tx
            transactions.push(arbTx);

            // Add tip tx
            transactions.push(tipTx);

            // Submit to Jito
            const bundleId = await this.submitBundle(transactions);

            this.stats.bundlesSubmitted++;
            this.stats.bundlesAccepted++;
            this.stats.totalTipsPaid += this.config.defaultTipLamports;

            return { success: true, bundleId };

        } catch (error: any) {
            this.stats.bundlesRejected++;
            return { success: false, error: error?.message ?? "Unknown error" };
        }
    }

    /**
     * Submit a standalone bundle (no backrun trigger).
     */
    async submitStandaloneBundle(
        instructions: TransactionInstruction[],
        tipLamports?: bigint
    ): Promise<BundleSubmitResult> {
        if (!this.client) {
            return { success: false, error: "Client not connected" };
        }

        try {
            const { blockhash } = await this.config.connection.getLatestBlockhash("confirmed");

            // Build main transaction
            const mainTx = await this.buildTransaction(instructions, blockhash);

            // Build tip transaction
            const tipTx = await this.buildTipTransaction(
                tipLamports ?? this.config.defaultTipLamports,
                blockhash
            );

            const bundleId = await this.submitBundle([mainTx, tipTx]);

            this.stats.bundlesSubmitted++;
            this.stats.bundlesAccepted++;
            this.stats.totalTipsPaid += tipLamports ?? this.config.defaultTipLamports;

            return { success: true, bundleId };

        } catch (error: any) {
            this.stats.bundlesRejected++;
            return { success: false, error: error?.message ?? "Unknown error" };
        }
    }

    /**
     * Get stats.
     */
    getStats(): { bundlesSubmitted: number; bundlesAccepted: number; bundlesRejected: number; totalTipsPaid: string } {
        return {
            bundlesSubmitted: this.stats.bundlesSubmitted,
            bundlesAccepted: this.stats.bundlesAccepted,
            bundlesRejected: this.stats.bundlesRejected,
            totalTipsPaid: this.stats.totalTipsPaid.toString(),
        };
    }

    // ========================================================================
    // Internal: Transaction Building
    // ========================================================================

    private async buildArbTransaction(
        buyInstructions: SwapInstructionParams,
        sellInstructions: SwapInstructionParams,
        _inputAmount: bigint,
        blockhash: string
    ): Promise<VersionedTransaction> {
        const instructions: TransactionInstruction[] = [];

        // Compute budget
        instructions.push(
            ComputeBudgetProgram.setComputeUnitLimit({
                units: this.config.maxComputeUnits,
            }),
            ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: this.config.computeUnitPrice,
            })
        );

        // Buy instruction
        instructions.push(
            new TransactionInstruction({
                programId: buyInstructions.programId,
                keys: buyInstructions.accounts.map(pk => ({
                    pubkey: pk,
                    isSigner: pk.equals(this.config.signerKeypair.publicKey),
                    isWritable: true, // Conservative: mark all writable
                })),
                data: buyInstructions.data,
            })
        );

        // Sell instruction
        instructions.push(
            new TransactionInstruction({
                programId: sellInstructions.programId,
                keys: sellInstructions.accounts.map(pk => ({
                    pubkey: pk,
                    isSigner: pk.equals(this.config.signerKeypair.publicKey),
                    isWritable: true,
                })),
                data: sellInstructions.data,
            })
        );

        return this.buildTransaction(instructions, blockhash);
    }

    private async buildTipTransaction(
        tipLamports: bigint,
        blockhash: string
    ): Promise<VersionedTransaction> {
        // Randomly select a tip account
        const tipAccountStr = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]!;
        const tipAccount = new PublicKey(tipAccountStr);

        const instruction = SystemProgram.transfer({
            fromPubkey: this.config.signerKeypair.publicKey,
            toPubkey: tipAccount,
            lamports: Number(tipLamports),
        });

        return this.buildTransaction([instruction], blockhash);
    }

    private async buildTransaction(
        instructions: TransactionInstruction[],
        blockhash: string
    ): Promise<VersionedTransaction> {
        const messageV0 = new TransactionMessage({
            payerKey: this.config.signerKeypair.publicKey,
            recentBlockhash: blockhash,
            instructions,
        }).compileToV0Message();

        const tx = new VersionedTransaction(messageV0);
        tx.sign([this.config.signerKeypair]);

        return tx;
    }

    private async submitBundle(transactions: VersionedTransaction[]): Promise<string> {
        if (!this.client) {
            throw new Error("Client not connected");
        }

        // Create Bundle using the jito-ts Bundle class
        // The Bundle class handles the proper protobuf serialization
        const bundle = new Bundle(transactions, 5); // 5 transaction limit per bundle

        // Add tip transaction using Bundle's built-in method
        const tipAccountStr = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]!;
        const tipAccount = new PublicKey(tipAccountStr);
        const { blockhash } = await this.config.connection.getLatestBlockhash("confirmed");

        const bundleWithTip = bundle.addTipTx(
            this.config.signerKeypair,
            Number(this.config.defaultTipLamports),
            tipAccount,
            blockhash
        );

        if (bundleWithTip instanceof Error) {
            throw bundleWithTip;
        }

        // Submit via gRPC
        const result = await this.client.sendBundle(bundleWithTip);

        if (!result.ok) {
            throw new Error(`Bundle submission failed: ${result.error?.message}`);
        }

        return result.value;
    }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a Jito bundle builder with default configuration.
 */
export function createJitoBundleBuilder(
    signerKeypair: Keypair,
    connection: Connection,
    blockEngineUrl: string = "https://mainnet.block-engine.jito.wtf"
): JitoBundleBuilder {
    const config: JitoBundleConfig = {
        blockEngineUrl,
        signerKeypair,
        connection,
        tipAccounts: JITO_TIP_ACCOUNTS.map(s => new PublicKey(s)),
        defaultTipLamports: BigInt(1_000_000), // 0.001 SOL default tip
        maxComputeUnits: 400_000,
        computeUnitPrice: 1_000, // 1000 micro-lamports
    };

    return new JitoBundleBuilder(config);
}

// ============================================================================
// Instruction Builders (venue-specific)
// ============================================================================

/**
 * Build PumpSwap swap instruction data.
 * Layout: [disc: 8][amount_in: u64][min_out: u64]
 */
export function buildPumpSwapSwapData(
    amountIn: bigint,
    minAmountOut: bigint
): Buffer {
    const disc = Buffer.from("66063d1201daebea", "hex");
    const data = Buffer.alloc(24);
    disc.copy(data, 0);
    data.writeBigUInt64LE(amountIn, 8);
    data.writeBigUInt64LE(minAmountOut, 16);
    return data;
}

/**
 * Build Raydium V4 swap instruction data.
 * Layout: [ix_index: u8][amount_in: u64][min_out: u64]
 */
export function buildRaydiumV4SwapData(
    amountIn: bigint,
    minAmountOut: bigint
): Buffer {
    const data = Buffer.alloc(17);
    data.writeUInt8(9, 0); // swap instruction index
    data.writeBigUInt64LE(amountIn, 1);
    data.writeBigUInt64LE(minAmountOut, 9);
    return data;
}

/**
 * Build Raydium CLMM swap instruction data.
 * Layout: [disc: 8][amount: u64][other_threshold: u64][sqrt_limit: u128][is_base_input: u8]
 */
export function buildRaydiumClmmSwapData(
    amount: bigint,
    otherThreshold: bigint,
    sqrtPriceLimitX64: bigint,
    isBaseInput: boolean
): Buffer {
    const disc = Buffer.from("2b04ed0b1ac91e62", "hex");
    const data = Buffer.alloc(41);
    disc.copy(data, 0);
    data.writeBigUInt64LE(amount, 8);
    data.writeBigUInt64LE(otherThreshold, 16);
    // u128 sqrtPriceLimitX64
    data.writeBigUInt64LE(sqrtPriceLimitX64 & BigInt("0xFFFFFFFFFFFFFFFF"), 24);
    data.writeBigUInt64LE(sqrtPriceLimitX64 >> BigInt(64), 32);
    data.writeUInt8(isBaseInput ? 1 : 0, 40);
    return data;
}

/**
 * Build Meteora DLMM swap instruction data.
 * Layout: [disc: 8][amount_in: u64][min_out: u64]
 */
export function buildMeteoraDlmmSwapData(
    amountIn: bigint,
    minAmountOut: bigint
): Buffer {
    const disc = Buffer.from("235613b94ed44bd3", "hex");
    const data = Buffer.alloc(24);
    disc.copy(data, 0);
    data.writeBigUInt64LE(amountIn, 8);
    data.writeBigUInt64LE(minAmountOut, 16);
    return data;
}
