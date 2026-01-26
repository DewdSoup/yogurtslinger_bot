// src/state/speculativeState.ts
//
// Dual-layer state management for pre-confirmation strategies.
//
// Architecture:
// ┌─────────────────────────────────────────────────────────────────────┐
// │                     SPECULATIVE STATE MANAGER                       │
// ├─────────────────────────────────────────────────────────────────────┤
// │                                                                     │
// │  Layer 1: CONFIRMED STATE (Source of Truth)                        │
// │  ┌─────────────────────────────────────────────────────────────┐   │
// │  │ InMemoryAccountStore                                         │   │
// │  │ • Fed by Yellowstone gRPC (confirmed commitment)            │   │
// │  │ • Used for validation, regression, accuracy verification    │   │
// │  │ • NEVER modified by speculative data                        │   │
// │  └─────────────────────────────────────────────────────────────┘   │
// │                          │                                          │
// │                          │ clone on demand                          │
// │                          ▼                                          │
// │  Layer 2: SPECULATIVE STATE (Prediction Layer)                     │
// │  ┌─────────────────────────────────────────────────────────────┐   │
// │  │ PendingTransactionQueue                                      │   │
// │  │ • Fed by ShredStream (pre-confirmation entries)             │   │
// │  │ • Transactions applied in order to predict post-state       │   │
// │  │ • Invalidated when confirmed state advances                 │   │
// │  └─────────────────────────────────────────────────────────────┘   │
// │                          │                                          │
// │                          ▼                                          │
// │  Layer 3: OPPORTUNITY DETECTION                                    │
// │  ┌─────────────────────────────────────────────────────────────┐   │
// │  │ • Simulate pending swap → get predicted post-state          │   │
// │  │ • Run arb detection on predicted state                      │   │
// │  │ • If profitable: build bundle, submit to Jito               │   │
// │  └─────────────────────────────────────────────────────────────┘   │
// │                                                                     │
// └─────────────────────────────────────────────────────────────────────┘
//
// Accuracy guarantee: Simulations use the SAME decoder/sim code paths
// that are validated against confirmed transactions. The only difference
// is we're predicting what state WILL BE after pending txs land.

import type { PubkeyStr } from "./accountStore";

// ============================================================================
// Pending Transaction Types
// ============================================================================

export interface PendingTransaction {
    /** Transaction signature (base58) */
    signature: string;
    /** Slot the transaction was seen in ShredStream */
    seenSlot: number;
    /** Timestamp when received from ShredStream */
    seenAt: number;
    /** Raw transaction bytes */
    rawTx: Buffer;
    /** Decoded instruction data for quick filtering */
    instructions: PendingInstruction[];
    /** Which accounts this tx reads */
    readAccounts: PubkeyStr[];
    /** Which accounts this tx writes */
    writeAccounts: PubkeyStr[];
    /** Processing status */
    status: "pending" | "confirmed" | "failed" | "expired";
}

export interface PendingInstruction {
    programId: PubkeyStr;
    /** First 8 bytes - instruction discriminator */
    discriminator: Buffer;
    /** Full instruction data */
    data: Buffer;
    /** Account indices in the transaction */
    accountIndices: number[];
}

// ============================================================================
// Speculative State Delta
// ============================================================================

/**
 * Represents predicted state changes from a pending transaction.
 * These are applied on top of confirmed state for opportunity detection.
 */
export interface SpeculativeStateDelta {
    /** The pending transaction that causes this delta */
    sourceTx: string; // signature
    /** Predicted account state changes */
    accountDeltas: Map<PubkeyStr, SpeculativeAccountDelta>;
    /** Predicted token balance changes (for quick arb detection) */
    tokenDeltas: Map<PubkeyStr, bigint>; // mint -> delta
    /** Confidence score (0-1) based on simulation success */
    confidence: number;
    /** Expiry slot - invalidate if confirmed slot passes this */
    expirySlot: number;
}

export interface SpeculativeAccountDelta {
    /** Account pubkey */
    pubkey: PubkeyStr;
    /** Predicted new data (full account data after tx) */
    predictedData: Buffer;
    /** Which fields changed (for efficient diffing) */
    changedOffsets: Array<{ start: number; end: number }>;
}

// ============================================================================
// Pending Transaction Queue
// ============================================================================

export class PendingTransactionQueue {
    private pending: Map<string, PendingTransaction> = new Map();
    private byWriteAccount: Map<PubkeyStr, Set<string>> = new Map();
    private maxAge: number;
    private maxSize: number;

    constructor(opts: { maxAgeMs?: number; maxSize?: number } = {}) {
        this.maxAge = opts.maxAgeMs ?? 5000; // 5 seconds default
        this.maxSize = opts.maxSize ?? 10000;
    }

    /**
     * Add a pending transaction from ShredStream.
     */
    add(tx: PendingTransaction): void {
        // Evict old/confirmed txs first
        this.evictStale();

        if (this.pending.size >= this.maxSize) {
            // Evict oldest
            const oldest = [...this.pending.values()]
                .sort((a, b) => a.seenAt - b.seenAt)[0];
            if (oldest) this.remove(oldest.signature);
        }

        this.pending.set(tx.signature, tx);

        // Index by write accounts for conflict detection
        for (const acc of tx.writeAccounts) {
            let set = this.byWriteAccount.get(acc);
            if (!set) {
                set = new Set();
                this.byWriteAccount.set(acc, set);
            }
            set.add(tx.signature);
        }
    }

    /**
     * Mark transaction as confirmed (landed on-chain).
     */
    confirm(signature: string): void {
        const tx = this.pending.get(signature);
        if (tx) {
            tx.status = "confirmed";
            // Keep briefly for dedup, then remove
            setTimeout(() => this.remove(signature), 1000);
        }
    }

    /**
     * Mark transaction as failed.
     */
    fail(signature: string): void {
        const tx = this.pending.get(signature);
        if (tx) {
            tx.status = "failed";
            this.remove(signature);
        }
    }

    /**
     * Get all pending transactions that write to a specific account.
     * Used for conflict detection and ordering.
     */
    getPendingWritersTo(account: PubkeyStr): PendingTransaction[] {
        const sigs = this.byWriteAccount.get(account);
        if (!sigs) return [];
        return [...sigs]
            .map(sig => this.pending.get(sig))
            .filter((tx): tx is PendingTransaction =>
                tx !== undefined && tx.status === "pending"
            )
            .sort((a, b) => a.seenAt - b.seenAt);
    }

    /**
     * Get all pending transactions (for batch processing).
     */
    getAllPending(): PendingTransaction[] {
        return [...this.pending.values()]
            .filter(tx => tx.status === "pending")
            .sort((a, b) => a.seenAt - b.seenAt);
    }

    /**
     * Check if we've already seen this transaction.
     */
    has(signature: string): boolean {
        return this.pending.has(signature);
    }

    private remove(signature: string): void {
        const tx = this.pending.get(signature);
        if (!tx) return;

        for (const acc of tx.writeAccounts) {
            const set = this.byWriteAccount.get(acc);
            if (set) {
                set.delete(signature);
                if (set.size === 0) this.byWriteAccount.delete(acc);
            }
        }
        this.pending.delete(signature);
    }

    private evictStale(): void {
        const now = Date.now();
        for (const [sig, tx] of this.pending) {
            if (now - tx.seenAt > this.maxAge) {
                tx.status = "expired";
                this.remove(sig);
            }
        }
    }

    get size(): number {
        return this.pending.size;
    }

    get pendingCount(): number {
        return [...this.pending.values()].filter(tx => tx.status === "pending").length;
    }
}

// ============================================================================
// Speculative State Manager
// ============================================================================

export interface SpeculativeStateConfig {
    /** Max age for pending transactions (ms) */
    maxPendingAge?: number;
    /** Max pending transactions to track */
    maxPendingSize?: number;
    /** Slots ahead to consider for expiry */
    expirySlotBuffer?: number;
}

/**
 * Manages the dual-layer state for pre-confirmation strategies.
 *
 * Usage:
 * 1. Feed confirmed state updates from Yellowstone gRPC
 * 2. Feed pending transactions from ShredStream
 * 3. Query speculative state for opportunity detection
 * 4. Speculative queries apply pending tx simulations on top of confirmed state
 */
export class SpeculativeStateManager {
    private pendingQueue: PendingTransactionQueue;
    private speculativeDeltas: Map<string, SpeculativeStateDelta> = new Map();
    private confirmedSlot: number = 0;
    private config: Required<SpeculativeStateConfig>;

    // Stats for monitoring
    private stats = {
        pendingReceived: 0,
        pendingConfirmed: 0,
        pendingFailed: 0,
        pendingExpired: 0,
        simulationsRun: 0,
        opportunitiesDetected: 0,
    };

    constructor(config: SpeculativeStateConfig = {}) {
        this.config = {
            maxPendingAge: config.maxPendingAge ?? 5000,
            maxPendingSize: config.maxPendingSize ?? 10000,
            expirySlotBuffer: config.expirySlotBuffer ?? 5,
        };

        this.pendingQueue = new PendingTransactionQueue({
            maxAgeMs: this.config.maxPendingAge,
            maxSize: this.config.maxPendingSize,
        });
    }

    /**
     * Update confirmed slot (from gRPC).
     * Invalidates speculative deltas that are now stale.
     */
    setConfirmedSlot(slot: number): void {
        this.confirmedSlot = slot;

        // Invalidate stale speculative deltas
        for (const [sig, delta] of this.speculativeDeltas) {
            if (delta.expirySlot <= slot) {
                this.speculativeDeltas.delete(sig);
            }
        }
    }

    /**
     * Add a pending transaction from ShredStream.
     */
    addPendingTransaction(tx: PendingTransaction): void {
        if (this.pendingQueue.has(tx.signature)) return; // Dedup

        this.stats.pendingReceived++;
        this.pendingQueue.add(tx);
    }

    /**
     * Mark a transaction as confirmed (from gRPC block confirmation).
     */
    confirmTransaction(signature: string): void {
        this.pendingQueue.confirm(signature);
        this.speculativeDeltas.delete(signature);
        this.stats.pendingConfirmed++;
    }

    /**
     * Mark a transaction as failed.
     */
    failTransaction(signature: string): void {
        this.pendingQueue.fail(signature);
        this.speculativeDeltas.delete(signature);
        this.stats.pendingFailed++;
    }

    /**
     * Store a speculative delta from simulation.
     */
    setSpeculativeDelta(delta: SpeculativeStateDelta): void {
        this.speculativeDeltas.set(delta.sourceTx, delta);
    }

    /**
     * Get pending transactions that affect a specific account.
     */
    getPendingAffecting(account: PubkeyStr): PendingTransaction[] {
        return this.pendingQueue.getPendingWritersTo(account);
    }

    /**
     * Get all pending transactions for batch processing.
     */
    getAllPending(): PendingTransaction[] {
        return this.pendingQueue.getAllPending();
    }

    /**
     * Get speculative delta for a transaction (if simulated).
     */
    getSpeculativeDelta(signature: string): SpeculativeStateDelta | undefined {
        return this.speculativeDeltas.get(signature);
    }

    /**
     * Check if we have pending transactions for any of the given accounts.
     */
    hasPendingFor(accounts: PubkeyStr[]): boolean {
        for (const acc of accounts) {
            if (this.pendingQueue.getPendingWritersTo(acc).length > 0) {
                return true;
            }
        }
        return false;
    }

    /**
     * Get current stats for monitoring.
     */
    getStats(): typeof this.stats & { pendingQueueSize: number; deltasSize: number; confirmedSlot: number } {
        return {
            ...this.stats,
            pendingQueueSize: this.pendingQueue.size,
            deltasSize: this.speculativeDeltas.size,
            confirmedSlot: this.confirmedSlot,
        };
    }

    /**
     * Increment opportunities detected counter.
     */
    recordOpportunity(): void {
        this.stats.opportunitiesDetected++;
    }

    /**
     * Increment simulations run counter.
     */
    recordSimulation(): void {
        this.stats.simulationsRun++;
    }
}

// ============================================================================
// Transaction Parser (for ShredStream entries)
// ============================================================================

import { VersionedTransaction } from "@solana/web3.js";

/**
 * Parse a raw transaction from ShredStream entry.
 * Returns null if parsing fails (malformed tx).
 */
export function parseShredstreamTransaction(
    rawTx: Buffer,
    slot: number
): PendingTransaction | null {
    try {
        const tx = VersionedTransaction.deserialize(rawTx);
        const message = tx.message;

        // Get all account keys
        const accountKeys = message.staticAccountKeys.map(k => k.toBase58() as PubkeyStr);

        // Add lookup table accounts if present (v0 transactions)
        // For now, we'll work with static keys only - lookup tables require
        // additional RPC calls which add latency

        // Parse instructions
        const instructions: PendingInstruction[] = [];
        for (const ix of message.compiledInstructions) {
            const programId = accountKeys[ix.programIdIndex];
            if (!programId) continue;

            instructions.push({
                programId,
                discriminator: Buffer.from(ix.data.slice(0, 8)),
                data: Buffer.from(ix.data),
                accountIndices: [...ix.accountKeyIndexes],
            });
        }

        // Determine read vs write accounts
        // In Solana, accounts are marked writable in the message header
        const numRequiredSignatures = message.header.numRequiredSignatures;
        const numReadonlySignedAccounts = message.header.numReadonlySignedAccounts;
        const numReadonlyUnsignedAccounts = message.header.numReadonlyUnsignedAccounts;

        const writeAccounts: PubkeyStr[] = [];
        const readAccounts: PubkeyStr[] = [];

        for (let i = 0; i < accountKeys.length; i++) {
            const isWritable = i < numRequiredSignatures - numReadonlySignedAccounts ||
                (i >= numRequiredSignatures &&
                 i < accountKeys.length - numReadonlyUnsignedAccounts);

            if (isWritable) {
                writeAccounts.push(accountKeys[i]!);
            } else {
                readAccounts.push(accountKeys[i]!);
            }
        }

        // Get signature
        const signature = tx.signatures[0];
        if (!signature) return null;

        return {
            signature: Buffer.from(signature).toString("base64"), // Convert to string
            seenSlot: slot,
            seenAt: Date.now(),
            rawTx,
            instructions,
            readAccounts,
            writeAccounts,
            status: "pending",
        };
    } catch {
        return null; // Malformed transaction
    }
}

/**
 * Check if a pending transaction is a swap we care about.
 */
export function isPendingSwap(
    tx: PendingTransaction,
    targetPrograms: Set<PubkeyStr>
): { isSwap: boolean; programId?: PubkeyStr; discriminator?: Buffer } {
    for (const ix of tx.instructions) {
        if (targetPrograms.has(ix.programId)) {
            // Check for known swap discriminators
            // These match what we use in grpcCaptureCanonical.ts
            const disc = ix.discriminator;

            // PumpSwap (native, no anchor discriminator - uses instruction index)
            // Raydium V4 (native)
            // Raydium CLMM (anchor)
            // Meteora DLMM (anchor)

            // For now, any instruction to a tracked program is potentially interesting
            // More specific filtering can be added per-program
            return { isSwap: true, programId: ix.programId, discriminator: disc };
        }
    }
    return { isSwap: false };
}
