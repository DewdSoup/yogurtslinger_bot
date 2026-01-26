/**
 * Speculative State Layer (Phase 4 - Deliverable 4.6)
 *
 * Applies pending transaction deltas to confirmed state for accurate
 * backrun/sandwich simulation.
 *
 * Architecture:
 * ```
 * Confirmed State (Phase 2/3)     Pending Txs (Phase 4)
 *         │                              │
 *         └──────────┬───────────────────┘
 *                    │
 *                    ▼
 *           Speculative State
 *                    │
 *                    ▼
 *           Backrun Simulation
 * ```
 *
 * Key insight: For backrun MEV, we must simulate against POST-pending state,
 * not confirmed state. If victim buys 10 SOL of token X, our backrun must
 * account for the price impact of their pending tx.
 *
 * WBS Gate G4.4: Speculative state accuracy ≥99%
 * Validation: Compare speculative prediction vs actual post-confirmation
 */

import type { PoolState, VenueId } from '../types.js';
import type { PendingTxEntry, PoolDelta } from './queue.js';

// ============================================================================
// TYPES
// ============================================================================

export interface SpeculativeVaultState {
    pubkey: Uint8Array;
    confirmedBalance: bigint;
    speculativeDelta: bigint;
    speculativeBalance: bigint;
    pendingTxCount: number;
    lastPendingSlot: number;
}

export interface SpeculativePoolState {
    pool: Uint8Array;
    venue: VenueId;
    confirmedState: PoolState;
    vaultA: SpeculativeVaultState;
    vaultB: SpeculativeVaultState;
    pendingTxCount: number;
    speculativeSlot: number;  // Highest pending slot affecting this pool
}

export interface SpeculativeSnapshot {
    pool: Uint8Array;
    confirmedSlot: number;
    speculativeSlot: number;
    reserveA: bigint;         // Speculative reserve A
    reserveB: bigint;         // Speculative reserve B
    pendingTxCount: number;
    pendingSignatures: Uint8Array[];
}

export interface SpeculativeLayerConfig {
    // Function to get confirmed pool state
    getPoolState: (pool: Uint8Array) => PoolState | null;
    // Function to get confirmed vault balance
    getVaultBalance: (vault: Uint8Array) => bigint | null;
    // Function to get confirmed slot for a vault
    getVaultSlot: (vault: Uint8Array) => number;
}

export interface SpeculativeLayerStats {
    poolsTracked: number;
    pendingDeltasApplied: bigint;
    snapshotsBuilt: bigint;
    validationSamples: number;
    validationAccuracy: number;
}

export interface ValidationSample {
    pool: Uint8Array;
    signature: Uint8Array;
    predictedReserveA: bigint;
    predictedReserveB: bigint;
    actualReserveA: bigint;
    actualReserveB: bigint;
    errorA: number;  // Percentage error
    errorB: number;
    accurate: boolean;  // Within tolerance
}

// ============================================================================
// IMPLEMENTATION
// ============================================================================

export class SpeculativeStateLayer {
    private readonly config: SpeculativeLayerConfig;

    // Pool -> accumulated deltas from pending txs
    private poolDeltas: Map<string, {
        vaultADelta: bigint;
        vaultBDelta: bigint;
        pendingTxs: Set<string>;
        lastSlot: number;
    }> = new Map();

    // Validation tracking
    private validationSamples: ValidationSample[] = [];
    private readonly maxValidationSamples = 1000;

    // Stats
    private deltasApplied = 0n;
    private snapshotsBuilt = 0n;

    constructor(config: SpeculativeLayerConfig) {
        this.config = config;
    }

    /**
     * Apply a pending transaction's deltas to speculative state
     */
    applyPendingTx(entry: PendingTxEntry): void {
        if (!entry.deltas || entry.deltas.length === 0) {
            return;
        }

        const sigKey = this.toKey(entry.signature);

        for (const delta of entry.deltas) {
            const poolKey = this.toKey(delta.pool);

            let poolDelta = this.poolDeltas.get(poolKey);
            if (!poolDelta) {
                poolDelta = {
                    vaultADelta: 0n,
                    vaultBDelta: 0n,
                    pendingTxs: new Set(),
                    lastSlot: 0,
                };
                this.poolDeltas.set(poolKey, poolDelta);
            }

            // Don't double-apply same tx
            if (poolDelta.pendingTxs.has(sigKey)) {
                continue;
            }

            poolDelta.vaultADelta += delta.vaultADelta;
            poolDelta.vaultBDelta += delta.vaultBDelta;
            poolDelta.pendingTxs.add(sigKey);
            poolDelta.lastSlot = Math.max(poolDelta.lastSlot, entry.slot);

            this.deltasApplied++;
        }
    }

    /**
     * Remove a confirmed transaction's deltas
     * Called when pending tx confirms (no longer speculative)
     */
    removePendingTx(signature: Uint8Array, deltas: PoolDelta[]): void {
        const sigKey = this.toKey(signature);

        for (const delta of deltas) {
            const poolKey = this.toKey(delta.pool);
            const poolDelta = this.poolDeltas.get(poolKey);

            if (!poolDelta || !poolDelta.pendingTxs.has(sigKey)) {
                continue;
            }

            poolDelta.vaultADelta -= delta.vaultADelta;
            poolDelta.vaultBDelta -= delta.vaultBDelta;
            poolDelta.pendingTxs.delete(sigKey);

            // Clean up if no more pending txs
            if (poolDelta.pendingTxs.size === 0) {
                this.poolDeltas.delete(poolKey);
            }
        }
    }

    /**
     * Get speculative snapshot for a pool
     * Returns confirmed state + pending deltas
     */
    getSpeculativeSnapshot(pool: Uint8Array): SpeculativeSnapshot | null {
        const poolState = this.config.getPoolState(pool);
        if (!poolState) {
            return null;
        }

        // Get vault pubkeys from pool state
        const [vaultA, vaultB] = this.getVaults(poolState);
        if (!vaultA || !vaultB) {
            return null;
        }

        // Get confirmed balances
        const confirmedA = this.config.getVaultBalance(vaultA);
        const confirmedB = this.config.getVaultBalance(vaultB);
        if (confirmedA === null || confirmedB === null) {
            return null;
        }

        const confirmedSlot = Math.max(
            this.config.getVaultSlot(vaultA),
            this.config.getVaultSlot(vaultB)
        );

        // Apply pending deltas
        const poolKey = this.toKey(pool);
        const poolDelta = this.poolDeltas.get(poolKey);

        const speculativeA = confirmedA + (poolDelta?.vaultADelta ?? 0n);
        const speculativeB = confirmedB + (poolDelta?.vaultBDelta ?? 0n);

        this.snapshotsBuilt++;

        return {
            pool,
            confirmedSlot,
            speculativeSlot: poolDelta?.lastSlot ?? confirmedSlot,
            reserveA: speculativeA,
            reserveB: speculativeB,
            pendingTxCount: poolDelta?.pendingTxs.size ?? 0,
            pendingSignatures: poolDelta
                ? Array.from(poolDelta.pendingTxs).map(hex => this.fromKey(hex))
                : [],
        };
    }

    /**
     * Check if pool has pending transactions affecting it
     */
    hasPendingTxs(pool: Uint8Array): boolean {
        const poolKey = this.toKey(pool);
        const delta = this.poolDeltas.get(poolKey);
        return delta !== undefined && delta.pendingTxs.size > 0;
    }

    /**
     * Get pending tx count for a pool
     */
    getPendingTxCount(pool: Uint8Array): number {
        const poolKey = this.toKey(pool);
        return this.poolDeltas.get(poolKey)?.pendingTxs.size ?? 0;
    }

    /**
     * Record validation sample (for G4.4)
     * Called after pending tx confirms to compare prediction vs actual
     */
    recordValidation(sample: ValidationSample): void {
        this.validationSamples.push(sample);
        if (this.validationSamples.length > this.maxValidationSamples) {
            this.validationSamples.shift();
        }
    }

    /**
     * Get validation accuracy (for G4.4)
     */
    getValidationAccuracy(): { accuracy: number; sampleCount: number } {
        if (this.validationSamples.length === 0) {
            return { accuracy: 0, sampleCount: 0 };
        }

        const accurate = this.validationSamples.filter(s => s.accurate).length;
        return {
            accuracy: accurate / this.validationSamples.length,
            sampleCount: this.validationSamples.length,
        };
    }

    /**
     * Get validation samples for analysis
     */
    getValidationSamples(): ValidationSample[] {
        return [...this.validationSamples];
    }

    /**
     * Get statistics
     */
    stats(): SpeculativeLayerStats {
        const validation = this.getValidationAccuracy();
        return {
            poolsTracked: this.poolDeltas.size,
            pendingDeltasApplied: this.deltasApplied,
            snapshotsBuilt: this.snapshotsBuilt,
            validationSamples: validation.sampleCount,
            validationAccuracy: validation.accuracy,
        };
    }

    /**
     * Clear all speculative state
     */
    clear(): void {
        this.poolDeltas.clear();
    }

    /**
     * Clear validation samples (for measurement phases)
     */
    clearValidation(): void {
        this.validationSamples = [];
    }

    // ========================================================================
    // PRIVATE
    // ========================================================================

    private toKey(bytes: Uint8Array): string {
        let key = '';
        for (let i = 0; i < bytes.length; i++) {
            key += bytes[i]!.toString(16).padStart(2, '0');
        }
        return key;
    }

    private fromKey(hex: string): Uint8Array {
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        }
        return bytes;
    }

    private getVaults(poolState: PoolState): [Uint8Array | null, Uint8Array | null] {
        switch (poolState.venue) {
            case 0: // PumpSwap
                return [(poolState as any).baseVault, (poolState as any).quoteVault];
            case 1: // RaydiumV4
                return [(poolState as any).baseVault, (poolState as any).quoteVault];
            case 2: // RaydiumClmm
                return [(poolState as any).tokenVault0, (poolState as any).tokenVault1];
            case 3: // MeteoraDlmm
                return [(poolState as any).vaultX, (poolState as any).vaultY];
            default:
                return [null, null];
        }
    }
}

// ============================================================================
// DELTA CALCULATOR (Basic - for Phase 4 validation)
// ============================================================================

/**
 * Calculate pool deltas for a constant product swap
 * This is a simplified version for Phase 4 validation.
 * Phase 5 will provide full simulation with tick/bin traversal.
 */
export function calculateConstantProductDelta(
    reserveIn: bigint,
    reserveOut: bigint,
    amountIn: bigint,
    feeBps: number = 25  // Default 0.25%
): { amountOut: bigint; deltaIn: bigint; deltaOut: bigint } {
    // Apply fee
    const feeMultiplier = 10000n - BigInt(feeBps);
    const amountInWithFee = amountIn * feeMultiplier / 10000n;

    // Constant product: (x + dx)(y - dy) = xy
    // dy = y * dx / (x + dx)
    const numerator = reserveOut * amountInWithFee;
    const denominator = reserveIn + amountInWithFee;
    const amountOut = numerator / denominator;

    return {
        amountOut,
        deltaIn: amountIn,      // Inflow to vault
        deltaOut: -amountOut,   // Outflow from vault
    };
}

/**
 * Compute deltas for a pending swap transaction
 * Returns deltas to apply to speculative state
 */
export function computeSwapDeltas(
    pool: Uint8Array,
    direction: 'AtoB' | 'BtoA',
    amountIn: bigint,
    reserveA: bigint,
    reserveB: bigint,
    feeBps: number = 25
): PoolDelta {
    if (direction === 'AtoB') {
        const result = calculateConstantProductDelta(reserveA, reserveB, amountIn, feeBps);
        return {
            pool,
            vaultADelta: result.deltaIn,
            vaultBDelta: result.deltaOut,
        };
    } else {
        const result = calculateConstantProductDelta(reserveB, reserveA, amountIn, feeBps);
        return {
            pool,
            vaultADelta: result.deltaOut,
            vaultBDelta: result.deltaIn,
        };
    }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createSpeculativeLayer(config: SpeculativeLayerConfig): SpeculativeStateLayer {
    return new SpeculativeStateLayer(config);
}

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

/**
 * Compare predicted vs actual reserves and determine if accurate
 * Tolerance: 0.1% error allowed (accounts for rounding, fees)
 */
export function validatePrediction(
    predicted: bigint,
    actual: bigint,
    toleranceBps: number = 10  // 0.1%
): { error: number; accurate: boolean } {
    if (actual === 0n) {
        return { error: predicted === 0n ? 0 : 100, accurate: predicted === 0n };
    }

    const diff = predicted > actual ? predicted - actual : actual - predicted;
    const errorBps = Number((diff * 10000n) / actual);
    const error = errorBps / 100;  // Convert to percentage

    return {
        error,
        accurate: errorBps <= toleranceBps,
    };
}