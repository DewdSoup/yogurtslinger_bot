/**
 * Snapshot Builder (Phase 3)
 * 
 * Assembles SimulationSnapshot from caches with slot consistency validation.
 * This is the final gate before simulation can proceed.
 */

import type { PoolState, TickArray, BinArray, RaydiumClmmPool, PumpSwapPool } from '../types.js';
import { VenueId } from '../types.js';
import type { PoolCache } from '../cache/pool.js';
import type { VaultCache } from '../cache/vault.js';
import type { TickCache } from '../cache/tick.js';
import type { BinCache } from '../cache/bin.js';
import type { AmmConfigCache } from '../cache/ammConfig.js';
import type { GlobalConfigCache } from '../cache/globalConfig.js';
import type {
    SimulationSnapshot,
    SnapshotResult,
    SnapshotError,
    VaultSnapshot,
} from './types.js';
import { isSlotConsistent, computeWatermarkSlot } from './types.js';
import { getRequiredTickArrays, getRequiredBinArrays } from './derive.js';

export interface SnapshotBuilderConfig {
    poolCache: PoolCache;
    vaultCache: VaultCache;
    tickCache: TickCache;
    binCache: BinCache;
    ammConfigCache?: AmmConfigCache;  // Optional for CLMM feeRate injection (INF-3)
    globalConfigCache?: GlobalConfigCache;  // Optional for PumpSwap fee injection
    strictSlotConsistency: boolean;
}

interface VaultsSuccess {
    success: true;
    vaults: { base: VaultSnapshot; quote: VaultSnapshot };
}

interface VaultsFailure {
    success: false;
    details: string;
    missing: Uint8Array[];
}

type VaultsResult = VaultsSuccess | VaultsFailure;

interface TickArraysSuccess {
    success: true;
    arrays: Map<number, TickArray>;
    minSlot: number;
}

interface TickArraysFailure {
    success: false;
    details: string;
    missing: number[];
}

type TickArraysResult = TickArraysSuccess | TickArraysFailure;

interface BinArraysSuccess {
    success: true;
    arrays: Map<number, BinArray>;
    minSlot: number;
}

interface BinArraysFailure {
    success: false;
    details: string;
    missing: number[];
}

type BinArraysResult = BinArraysSuccess | BinArraysFailure;

/**
 * Build a simulation-ready snapshot for a pool
 */
export function buildSnapshot(
    poolPubkey: Uint8Array,
    config: SnapshotBuilderConfig
): SnapshotResult {
    // 1. Get pool state
    const poolEntry = config.poolCache.get(poolPubkey);
    if (!poolEntry) {
        return {
            success: false,
            error: {
                poolPubkey,
                reason: 'missing_pool',
                details: 'Pool not found in cache',
            },
        };
    }

    let pool = poolEntry.state;
    const poolSlot = poolEntry.slot;

    // 1b. Inject feeRate for CLMM pools if ammConfigCache available (INF-3)
    if (pool.venue === VenueId.RaydiumClmm && config.ammConfigCache) {
        const clmmPool = pool as RaydiumClmmPool;
        if (clmmPool.feeRate === undefined) {
            const configEntry = config.ammConfigCache.get(clmmPool.ammConfig);
            if (configEntry) {
                // Create a new pool object with feeRate injected
                pool = { ...clmmPool, feeRate: configEntry.feeRate };
            }
            // If ammConfig not cached, simulation will use default 25 bps
        }
    }

    // 1c. Inject fee params for PumpSwap pools if globalConfigCache available
    if (pool.venue === VenueId.PumpSwap && config.globalConfigCache) {
        const pumpPool = pool as PumpSwapPool;
        if (pumpPool.lpFeeBps === undefined) {
            const fees = config.globalConfigCache.getFees();
            // Create a new pool object with fees injected
            pool = {
                ...pumpPool,
                lpFeeBps: fees.lpFeeBps,
                protocolFeeBps: fees.protocolFeeBps + fees.coinCreatorFeeBps,
            };
        }
    }

    // 2. Get vault balances
    const vaultsResult = getVaults(pool, config.vaultCache);
    if (!vaultsResult.success) {
        return {
            success: false,
            error: {
                poolPubkey,
                reason: 'missing_vaults',
                details: vaultsResult.details,
                missing: { vaults: vaultsResult.missing },
            },
        };
    }

    // 3. Get tick arrays (CLMM) or bin arrays (DLMM)
    let tickArrays: Map<number, TickArray> | undefined;
    let tickArraysSlot: number | undefined;
    let binArrays: Map<number, BinArray> | undefined;
    let binArraysSlot: number | undefined;

    if (pool.venue === VenueId.RaydiumClmm) {
        const tickResult = getTickArrays(pool, poolPubkey, poolSlot, config.tickCache);
        if (!tickResult.success) {
            return {
                success: false,
                error: {
                    poolPubkey,
                    reason: 'missing_tick_arrays',
                    details: tickResult.details,
                    missing: { tickArrays: tickResult.missing },
                },
            };
        }
        tickArrays = tickResult.arrays;
        tickArraysSlot = tickResult.minSlot;
    }

    if (pool.venue === VenueId.MeteoraDlmm) {
        const binResult = getBinArrays(pool, poolPubkey, poolSlot, config.binCache);
        if (!binResult.success) {
            return {
                success: false,
                error: {
                    poolPubkey,
                    reason: 'missing_bin_arrays',
                    details: binResult.details,
                    missing: { binArrays: binResult.missing },
                },
            };
        }
        binArrays = binResult.arrays;
        binArraysSlot = binResult.minSlot;
    }

    // 4. Get config slot if applicable
    let configSlot: number | undefined;
    if (pool.venue === VenueId.RaydiumClmm && config.ammConfigCache) {
        const clmmPool = pool as RaydiumClmmPool;
        const configEntry = config.ammConfigCache.get(clmmPool.ammConfig);
        if (configEntry) configSlot = configEntry.slot;
    } else if (pool.venue === VenueId.PumpSwap && config.globalConfigCache) {
        const globalEntry = config.globalConfigCache.getEntry();
        if (globalEntry) configSlot = globalEntry.slot;
    }

    // 5. Compute watermark slot
    const asOfSlot = computeWatermarkSlot(
        poolSlot,
        vaultsResult.vaults.base.slot,
        vaultsResult.vaults.quote.slot,
        tickArraysSlot,
        binArraysSlot,
        configSlot
    );

    // 6. Build snapshot
    const snapshot: SimulationSnapshot = {
        pool,
        poolPubkey,
        poolSlot,
        vaults: vaultsResult.vaults,
        tickArrays,
        tickArraysSlot,
        binArrays,
        binArraysSlot,
        asOfSlot,
    };

    // 7. Validate slot consistency
    if (config.strictSlotConsistency && !isSlotConsistent(snapshot)) {
        return {
            success: false,
            error: {
                poolPubkey,
                reason: 'slot_inconsistent',
                details: 'Dependencies have older slot than pool',
                slotInfo: {
                    poolSlot,
                    vaultSlot: Math.min(
                        vaultsResult.vaults.base.slot,
                        vaultsResult.vaults.quote.slot
                    ),
                    dependencySlot: tickArraysSlot ?? binArraysSlot,
                },
            },
        };
    }

    return { success: true, snapshot };
}

function getVaults(pool: PoolState, vaultCache: VaultCache): VaultsResult {
    let baseVaultPubkey: Uint8Array;
    let quoteVaultPubkey: Uint8Array;

    switch (pool.venue) {
        case VenueId.PumpSwap:
            baseVaultPubkey = pool.baseVault;
            quoteVaultPubkey = pool.quoteVault;
            break;
        case VenueId.RaydiumV4:
            baseVaultPubkey = pool.baseVault;
            quoteVaultPubkey = pool.quoteVault;
            break;
        case VenueId.RaydiumClmm:
            baseVaultPubkey = pool.tokenVault0;
            quoteVaultPubkey = pool.tokenVault1;
            break;
        case VenueId.MeteoraDlmm:
            baseVaultPubkey = pool.vaultX;
            quoteVaultPubkey = pool.vaultY;
            break;
    }

    const baseVault = vaultCache.get(baseVaultPubkey);
    const quoteVault = vaultCache.get(quoteVaultPubkey);

    const missing: Uint8Array[] = [];
    if (!baseVault) missing.push(baseVaultPubkey);
    if (!quoteVault) missing.push(quoteVaultPubkey);

    if (missing.length > 0) {
        return {
            success: false,
            details: `Missing ${missing.length} vault(s)`,
            missing,
        };
    }

    return {
        success: true,
        vaults: {
            base: {
                pubkey: baseVaultPubkey,
                amount: baseVault!.amount,
                slot: baseVault!.slot,
            },
            quote: {
                pubkey: quoteVaultPubkey,
                amount: quoteVault!.amount,
                slot: quoteVault!.slot,
            },
        },
    };
}

function getTickArrays(
    pool: PoolState & { venue: typeof VenueId.RaydiumClmm },
    poolPubkey: Uint8Array,
    poolSlot: number,
    tickCache: TickCache
): TickArraysResult {
    const requiredIndexes = getRequiredTickArrays(pool.tickCurrent, pool.tickSpacing);
    const arrays = new Map<number, TickArray>();
    const missing: number[] = [];
    let minSlot = Number.MAX_SAFE_INTEGER;

    for (const startTickIndex of requiredIndexes) {
        // FIX 4: Use getOrVirtual() to include virtual zero-liquidity arrays (FIX 3)
        // Returns: cached state, virtual zero if non-existent, or null if unknown
        const array = tickCache.getOrVirtual(poolPubkey, startTickIndex);
        if (array) {
            arrays.set(startTickIndex, array);
            // Track slot from cache entry (virtual arrays don't affect staleness)
            const entry = tickCache.get(poolPubkey, startTickIndex);
            if (entry && entry.slot < minSlot) minSlot = entry.slot;
        } else {
            // Truly missing - unknown array (never fetched, not marked non-existent)
            missing.push(startTickIndex);
        }
    }

    // We require at least the current tick array (middle element)
    const currentStart = requiredIndexes[1]!;
    if (!arrays.has(currentStart)) {
        return {
            success: false,
            details: `Missing current tick array (startTickIndex=${currentStart})`,
            missing,
        };
    }

    return {
        success: true,
        arrays,
        minSlot: minSlot === Number.MAX_SAFE_INTEGER ? poolSlot : minSlot,
    };
}

function getBinArrays(
    pool: PoolState & { venue: typeof VenueId.MeteoraDlmm },
    poolPubkey: Uint8Array,
    poolSlot: number,
    binCache: BinCache
): BinArraysResult {
    const requiredIndexes = getRequiredBinArrays(pool.activeId);
    const arrays = new Map<number, BinArray>();
    const missing: number[] = [];
    let minSlot = Number.MAX_SAFE_INTEGER;

    for (const arrayIndex of requiredIndexes) {
        // FIX 4: Use getOrVirtual() to include virtual zero-liquidity arrays (FIX 3)
        // Returns: cached state, virtual zero if non-existent, or null if unknown
        const array = binCache.getOrVirtual(poolPubkey, arrayIndex);
        if (array) {
            arrays.set(arrayIndex, array);
            // Track slot from cache entry (virtual arrays don't affect staleness)
            const entry = binCache.get(poolPubkey, arrayIndex);
            if (entry && entry.slot < minSlot) minSlot = entry.slot;
        } else {
            // Truly missing - unknown array (never fetched, not marked non-existent)
            missing.push(arrayIndex);
        }
    }

    // We require at least the current bin array (middle element)
    const currentIndex = requiredIndexes[1]!;
    if (!arrays.has(currentIndex)) {
        return {
            success: false,
            details: `Missing current bin array (index=${currentIndex})`,
            missing,
        };
    }

    return {
        success: true,
        arrays,
        minSlot: minSlot === Number.MAX_SAFE_INTEGER ? poolSlot : minSlot,
    };
}

/**
 * Batch build snapshots for multiple pools
 */
export function buildSnapshots(
    poolPubkeys: Uint8Array[],
    config: SnapshotBuilderConfig
): {
    total: number;
    succeeded: number;
    failed: number;
    successRate: number;
    failures: SnapshotError[];
} {
    const failures: SnapshotError[] = [];
    let succeeded = 0;

    for (const pubkey of poolPubkeys) {
        const result = buildSnapshot(pubkey, config);
        if (result.success) {
            succeeded++;
        } else {
            failures.push(result.error);
        }
    }

    return {
        total: poolPubkeys.length,
        succeeded,
        failed: failures.length,
        successRate: poolPubkeys.length > 0 ? succeeded / poolPubkeys.length : 0,
        failures,
    };
}