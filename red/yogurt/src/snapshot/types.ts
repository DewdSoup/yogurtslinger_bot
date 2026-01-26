/**
 * SimulationSnapshot Types (Phase 3)
 * 
 * Core structure for slot-consistent simulation state.
 * All dependencies must have slot >= pool.slot for validity.
 */

import type { PoolState, TickArray, BinArray } from '../types.js';

/** Vault balance with slot tracking */
export interface VaultSnapshot {
    pubkey: Uint8Array;
    amount: bigint;
    slot: number;
}

/** Complete simulation-ready state */
export interface SimulationSnapshot {
    // Pool state
    pool: PoolState;
    poolPubkey: Uint8Array;
    poolSlot: number;

    // Vault balances (required for all venues)
    vaults: {
        base: VaultSnapshot;
        quote: VaultSnapshot;
    };

    // Tick arrays (CLMM only)
    tickArrays?: Map<number, TickArray>; // startTickIndex -> array
    tickArraysSlot?: number; // minimum slot across all arrays

    // Bin arrays (DLMM only)
    binArrays?: Map<number, BinArray>; // arrayIndex -> array
    binArraysSlot?: number; // minimum slot across all arrays

    // Slot coherence watermark: min(pool, vaults, ticks, bins, config)
    asOfSlot: number;
}

/** Snapshot build result */
export type SnapshotResult =
    | { success: true; snapshot: SimulationSnapshot }
    | { success: false; error: SnapshotError };

/** Detailed error for missing dependencies */
export interface SnapshotError {
    poolPubkey: Uint8Array;
    reason: 'missing_pool' | 'missing_vaults' | 'missing_tick_arrays' | 'missing_bin_arrays' | 'slot_inconsistent';
    details: string;
    missing?: {
        vaults?: Uint8Array[];
        tickArrays?: number[]; // missing startTickIndexes
        binArrays?: number[];  // missing array indexes
    };
    slotInfo?: {
        poolSlot: number;
        vaultSlot?: number;
        dependencySlot?: number;
    };
}

/** Required dependencies for a pool */
export interface PoolDependencies {
    poolPubkey: Uint8Array;
    vaults: Uint8Array[]; // 2 vault pubkeys
    // CLMM
    tickArrayIndexes?: number[]; // startTickIndex values needed
    // DLMM
    binArrayIndexes?: number[]; // array index values needed
}

/** Snapshot validity check */
export function isSlotConsistent(snapshot: SimulationSnapshot): boolean {
    const poolSlot = snapshot.poolSlot;

    // Vaults must be at or after pool slot
    if (snapshot.vaults.base.slot < poolSlot) return false;
    if (snapshot.vaults.quote.slot < poolSlot) return false;

    // Tick arrays (if present) must be at or after pool slot
    if (snapshot.tickArraysSlot !== undefined && snapshot.tickArraysSlot < poolSlot) {
        return false;
    }

    // Bin arrays (if present) must be at or after pool slot
    if (snapshot.binArraysSlot !== undefined && snapshot.binArraysSlot < poolSlot) {
        return false;
    }

    return true;
}

/**
 * Compute dependency-scoped slot watermark
 *
 * Returns the minimum slot across all snapshot dependencies:
 *   min(poolSlot, vaults.base.slot, vaults.quote.slot, tickArraysSlot?, binArraysSlot?, configSlot?)
 *
 * This value represents the oldest state in the snapshot.
 * A simulation using this snapshot is valid "as of" this slot.
 */
export function computeWatermarkSlot(
    poolSlot: number,
    baseVaultSlot: number,
    quoteVaultSlot: number,
    tickArraysSlot?: number,
    binArraysSlot?: number,
    configSlot?: number
): number {
    let watermark = poolSlot;
    if (baseVaultSlot < watermark) watermark = baseVaultSlot;
    if (quoteVaultSlot < watermark) watermark = quoteVaultSlot;
    if (tickArraysSlot !== undefined && tickArraysSlot < watermark) watermark = tickArraysSlot;
    if (binArraysSlot !== undefined && binArraysSlot < watermark) watermark = binArraysSlot;
    if (configSlot !== undefined && configSlot < watermark) watermark = configSlot;
    return watermark;
}