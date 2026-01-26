// src/execution/jitoBundle.ts
// Jito bundle construction and submission
// CRITICAL: Jito bundles ARE ATOMIC - all TXs execute OR none execute

import {
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    TransactionInstruction,
    SystemProgram,
    VersionedTransaction,
    TransactionMessage,
} from "@solana/web3.js";

// ============================================================================
// JITO CONFIGURATION
// ============================================================================

export const JITO_CONFIG = {
    ENDPOINTS: [
        "https://mainnet.block-engine.jito.wtf",
        "https://amsterdam.mainnet.block-engine.jito.wtf",
        "https://frankfurt.mainnet.block-engine.jito.wtf",
        "https://ny.mainnet.block-engine.jito.wtf",
        "https://tokyo.mainnet.block-engine.jito.wtf",
    ],
    // Jito tip accounts - randomly select one for load balancing
    TIP_ACCOUNTS: [
        "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
        "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
        "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
        "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
        "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
        "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
        "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
        "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
    ],
    MAX_BUNDLE_SIZE: 5,
    DEFAULT_TIP_LAMPORTS: 1000n,
};

// ============================================================================
// BUNDLE TYPES
// ============================================================================

export interface ArbitrageBundle {
    id: string;
    transactions: VersionedTransaction[];
    tipAmountLamports: bigint;
    tipAccountPubkey: string;
    createdAt: number;
    blockhash: string;
}

export interface BundleSubmitResult {
    success: boolean;
    bundleId?: string;
    error?: string;
    endpoint?: string;
}

export interface BundleStatusResult {
    status: "pending" | "landed" | "failed" | "not_found";
    slot?: number;
    error?: string;
}

// ============================================================================
// TIP INSTRUCTION
// ============================================================================

function getRandomTipAccount(): string {
    const index = Math.floor(Math.random() * JITO_CONFIG.TIP_ACCOUNTS.length);
    const account = JITO_CONFIG.TIP_ACCOUNTS[index];
    if (!account) {
        // Fallback to first account if somehow index is out of bounds
        return JITO_CONFIG.TIP_ACCOUNTS[0]!;
    }
    return account;
}

export function createTipInstruction(
    payer: PublicKey,
    tipAmountLamports: bigint
): { instruction: TransactionInstruction; tipAccount: string } {
    const tipAccount = getRandomTipAccount();

    const instruction = SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: new PublicKey(tipAccount),
        lamports: tipAmountLamports,
    });

    return { instruction, tipAccount };
}

// ============================================================================
// JITO BUNDLE EXECUTOR CLASS
// ============================================================================

/**
 * Class wrapper for Jito bundle operations.
 * Used by bot.ts for high-level bundle submission.
 * 
 * NOTE: This is a Phase 3 component. Current implementation is minimal
 * and will need refinement when wiring up actual execution.
 */
export class JitoBundleExecutor {
    private connection: Connection;
    private wallet: Keypair;

    constructor(connection: Connection, wallet: Keypair) {
        this.connection = connection;
        this.wallet = wallet;
    }

    /**
     * Send a bundle of transactions with a Jito tip.
     * 
     * IMPORTANT: The input transactions should NOT include a tip instruction.
     * This method will create a separate tip transaction and append it to the bundle.
     * 
     * For atomic arb execution, pass [buyTx, sellTx] - the tip will be added as TX3.
     * 
     * @param transactions - Pre-built Transaction objects (will be converted to VersionedTransaction)
     * @param tipLamports - Tip amount in lamports (will be converted to bigint)
     * @returns Bundle ID string
     * @throws Error if submission fails
     */
    async sendBundle(
        transactions: Transaction[],
        tipLamports: number
    ): Promise<string> {
        const { blockhash } = await this.connection.getLatestBlockhash("confirmed");

        // Convert legacy transactions to versioned transactions
        const versionedTxs: VersionedTransaction[] = transactions.map(tx => {
            // Extract instructions from legacy transaction
            const message = new TransactionMessage({
                payerKey: this.wallet.publicKey,
                recentBlockhash: blockhash,
                instructions: tx.instructions,
            }).compileToV0Message();

            const vTx = new VersionedTransaction(message);
            vTx.sign([this.wallet]);
            return vTx;
        });

        // Create tip instruction
        const { instruction: tipInstruction, tipAccount } = createTipInstruction(
            this.wallet.publicKey,
            BigInt(tipLamports)
        );

        // Build tip transaction
        const tipMessage = new TransactionMessage({
            payerKey: this.wallet.publicKey,
            recentBlockhash: blockhash,
            instructions: [tipInstruction],
        }).compileToV0Message();

        const tipTx = new VersionedTransaction(tipMessage);
        tipTx.sign([this.wallet]);

        // Create bundle
        const bundleId = `bundle_${Date.now()}_${Math.random().toString(36).substring(7)}`;

        const bundle: ArbitrageBundle = {
            id: bundleId,
            transactions: [...versionedTxs, tipTx],
            tipAmountLamports: BigInt(tipLamports),
            tipAccountPubkey: tipAccount,
            createdAt: Date.now(),
            blockhash,
        };

        // Validate before submission
        const validation = validateBundle(bundle);
        if (!validation.valid) {
            throw new Error(`Bundle validation failed: ${validation.error}`);
        }

        // Submit with retry
        const result = await submitBundleWithRetry(bundle);

        // Track for monitoring
        trackBundle(bundle, result);

        if (!result.success) {
            throw new Error(result.error || "Bundle submission failed");
        }

        return result.bundleId || bundleId;
    }

    /**
     * Build and send an arbitrage bundle from swap instructions.
     * This is a convenience method that handles transaction construction internally.
     */
    async sendArbBundle(
        buyInstruction: TransactionInstruction,
        sellInstruction: TransactionInstruction,
        tipLamports: number
    ): Promise<string> {
        const bundle = await buildArbitrageBundle(
            this.connection,
            this.wallet,
            buyInstruction,
            sellInstruction,
            BigInt(tipLamports)
        );

        const validation = validateBundle(bundle);
        if (!validation.valid) {
            throw new Error(`Bundle validation failed: ${validation.error}`);
        }

        const result = await submitBundleWithRetry(bundle);
        trackBundle(bundle, result);

        if (!result.success) {
            throw new Error(result.error || "Bundle submission failed");
        }

        return result.bundleId || bundle.id;
    }

    /**
     * Check the status of a previously submitted bundle.
     */
    async checkBundleStatus(bundleId: string): Promise<BundleStatusResult> {
        return getBundleStatus(bundleId);
    }

    /**
     * Wait for a bundle to confirm or fail.
     */
    async waitForConfirmation(
        bundleId: string,
        timeoutMs: number = 30000
    ): Promise<BundleStatusResult> {
        return waitForBundleConfirmation(bundleId, timeoutMs);
    }
}

// ============================================================================
// BUNDLE CONSTRUCTION
// ============================================================================

export async function buildArbitrageBundle(
    connection: Connection,
    wallet: Keypair,
    buyInstruction: TransactionInstruction,
    sellInstruction: TransactionInstruction,
    tipAmountLamports: bigint
): Promise<ArbitrageBundle> {
    const { blockhash } = await connection.getLatestBlockhash("confirmed");

    const { instruction: tipInstruction, tipAccount } = createTipInstruction(
        wallet.publicKey,
        tipAmountLamports
    );

    // TX1: Buy tokens
    const buyMessage = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: [buyInstruction],
    }).compileToV0Message();

    const buyTx = new VersionedTransaction(buyMessage);
    buyTx.sign([wallet]);

    // TX2: Sell tokens + tip
    const sellMessage = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: [sellInstruction, tipInstruction],
    }).compileToV0Message();

    const sellTx = new VersionedTransaction(sellMessage);
    sellTx.sign([wallet]);

    const bundleId = `bundle_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    return {
        id: bundleId,
        transactions: [buyTx, sellTx],
        tipAmountLamports,
        tipAccountPubkey: tipAccount,
        createdAt: Date.now(),
        blockhash,
    };
}

export async function buildSingleTxBundle(
    connection: Connection,
    wallet: Keypair,
    instructions: TransactionInstruction[],
    tipAmountLamports: bigint
): Promise<ArbitrageBundle> {
    const { blockhash } = await connection.getLatestBlockhash("confirmed");

    const { instruction: tipInstruction, tipAccount } = createTipInstruction(
        wallet.publicKey,
        tipAmountLamports
    );

    const message = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: [...instructions, tipInstruction],
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([wallet]);

    const bundleId = `bundle_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    return {
        id: bundleId,
        transactions: [tx],
        tipAmountLamports,
        tipAccountPubkey: tipAccount,
        createdAt: Date.now(),
        blockhash,
    };
}

// ============================================================================
// BUNDLE SUBMISSION
// ============================================================================

export async function submitBundle(
    bundle: ArbitrageBundle,
    endpoint: string = JITO_CONFIG.ENDPOINTS[0]!
): Promise<BundleSubmitResult> {
    try {
        const serializedTxs = bundle.transactions.map(tx =>
            Buffer.from(tx.serialize()).toString("base64")
        );

        const response = await fetch(`${endpoint}/api/v1/bundles`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "sendBundle",
                params: [serializedTxs],
            }),
        });

        if (!response.ok) {
            return {
                success: false,
                error: `HTTP ${response.status}: ${response.statusText}`,
                endpoint,
            };
        }

        const data = await response.json();

        if (data.error) {
            return {
                success: false,
                error: data.error.message || JSON.stringify(data.error),
                endpoint,
            };
        }

        return {
            success: true,
            bundleId: data.result,
            endpoint,
        };
    } catch (error) {
        return {
            success: false,
            error: `Network error: ${error}`,
            endpoint,
        };
    }
}

export async function submitBundleWithRetry(
    bundle: ArbitrageBundle,
    maxRetries: number = 2
): Promise<BundleSubmitResult> {
    for (const endpoint of JITO_CONFIG.ENDPOINTS) {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const result = await submitBundle(bundle, endpoint);
            if (result.success) {
                return result;
            }

            // Don't retry on certain errors
            if (result.error?.includes("already processed") ||
                result.error?.includes("blockhash not found")) {
                return result;
            }

            // Wait before retry
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
            }
        }
    }

    return {
        success: false,
        error: "All endpoints and retries exhausted",
    };
}

// ============================================================================
// BUNDLE STATUS
// ============================================================================

export async function getBundleStatus(
    bundleId: string,
    endpoint: string = JITO_CONFIG.ENDPOINTS[0]!
): Promise<BundleStatusResult> {
    try {
        const response = await fetch(`${endpoint}/api/v1/bundles`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "getBundleStatuses",
                params: [[bundleId]],
            }),
        });

        if (!response.ok) {
            return { status: "not_found", error: `HTTP ${response.status}` };
        }

        const data = await response.json();

        if (data.error) {
            return { status: "not_found", error: data.error.message };
        }

        const statuses = data.result?.value || [];
        if (statuses.length === 0) {
            return { status: "pending" };
        }

        const bundleStatus = statuses[0];
        if (!bundleStatus) {
            return { status: "pending" };
        }

        if (bundleStatus.confirmation_status === "finalized" ||
            bundleStatus.confirmation_status === "confirmed") {
            return {
                status: "landed",
                slot: bundleStatus.slot,
            };
        }

        if (bundleStatus.err) {
            return {
                status: "failed",
                error: JSON.stringify(bundleStatus.err),
            };
        }

        return { status: "pending" };
    } catch (error) {
        return { status: "not_found", error: `Network error: ${error}` };
    }
}

export async function waitForBundleConfirmation(
    bundleId: string,
    timeoutMs: number = 30000,
    pollIntervalMs: number = 500
): Promise<BundleStatusResult> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        const status = await getBundleStatus(bundleId);

        if (status.status === "landed" || status.status === "failed") {
            return status;
        }

        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    return { status: "failed", error: "Timeout waiting for confirmation" };
}

// ============================================================================
// BUNDLE VALIDATION
// ============================================================================

export function validateBundle(bundle: ArbitrageBundle): { valid: boolean; error?: string } {
    // Check age
    const ageMs = Date.now() - bundle.createdAt;
    if (ageMs > 60000) {
        return { valid: false, error: `Bundle too old: ${ageMs}ms` };
    }

    // Check transaction count
    if (bundle.transactions.length === 0) {
        return { valid: false, error: "Bundle has no transactions" };
    }
    if (bundle.transactions.length > JITO_CONFIG.MAX_BUNDLE_SIZE) {
        return { valid: false, error: `Bundle too large: ${bundle.transactions.length} transactions` };
    }

    // Check tip
    if (bundle.tipAmountLamports < JITO_CONFIG.DEFAULT_TIP_LAMPORTS) {
        return { valid: false, error: `Tip too low: ${bundle.tipAmountLamports}` };
    }

    // Check signatures
    for (let i = 0; i < bundle.transactions.length; i++) {
        const tx = bundle.transactions[i];
        if (!tx || tx.signatures.length === 0) {
            return { valid: false, error: `Transaction ${i} has no signatures` };
        }
    }

    return { valid: true };
}

// ============================================================================
// BUNDLE TRACKING
// ============================================================================

interface BundleRecord {
    bundle: ArbitrageBundle;
    submitResult?: BundleSubmitResult | undefined;
    statusResult?: BundleStatusResult | undefined;
    submittedAt?: number | undefined;
    confirmedAt?: number | undefined;
}

const bundleHistory: Map<string, BundleRecord> = new Map();
const MAX_HISTORY_SIZE = 1000;

export function trackBundle(
    bundle: ArbitrageBundle,
    submitResult?: BundleSubmitResult,
    statusResult?: BundleStatusResult
): void {
    const existing = bundleHistory.get(bundle.id);

    if (existing) {
        if (submitResult) {
            existing.submitResult = submitResult;
            existing.submittedAt = Date.now();
        }
        if (statusResult) {
            existing.statusResult = statusResult;
            if (statusResult.status === "landed") {
                existing.confirmedAt = Date.now();
            }
        }
    } else {
        bundleHistory.set(bundle.id, {
            bundle,
            submitResult,
            statusResult,
            submittedAt: submitResult ? Date.now() : undefined,
            confirmedAt: statusResult?.status === "landed" ? Date.now() : undefined,
        });
    }

    // Prune old entries
    if (bundleHistory.size > MAX_HISTORY_SIZE) {
        const oldest = Array.from(bundleHistory.keys()).slice(0, 100);
        for (const key of oldest) {
            bundleHistory.delete(key);
        }
    }
}

export function getBundleRecord(bundleId: string): BundleRecord | undefined {
    return bundleHistory.get(bundleId);
}

export function getBundleStats(): {
    total: number;
    submitted: number;
    landed: number;
    failed: number;
    pending: number;
} {
    let submitted = 0;
    let landed = 0;
    let failed = 0;
    let pending = 0;

    for (const record of bundleHistory.values()) {
        if (record.submitResult?.success) {
            submitted++;
            if (record.statusResult?.status === "landed") {
                landed++;
            } else if (record.statusResult?.status === "failed") {
                failed++;
            } else {
                pending++;
            }
        }
    }

    return {
        total: bundleHistory.size,
        submitted,
        landed,
        failed,
        pending,
    };
}

export function clearBundleHistory(): void {
    bundleHistory.clear();
}

export default {
    JITO_CONFIG,
    createTipInstruction,
    buildArbitrageBundle,
    buildSingleTxBundle,
    submitBundle,
    submitBundleWithRetry,
    getBundleStatus,
    waitForBundleConfirmation,
    validateBundle,
    trackBundle,
    getBundleRecord,
    getBundleStats,
    clearBundleHistory,
    JitoBundleExecutor,
};