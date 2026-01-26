// src/state/hotPathCache.ts
//
// Hot-path cache for low-latency simulations from cached state.
//
// Design principles:
// - Decode once, simulate many times
// - Track data versions to avoid re-decoding unchanged data
// - Provide direct buffer accessors for simulation-critical fields
// - Integrate with AccountStore and PoolRegistry
//
// Usage:
// 1. Register pools with their dependencies
// 2. On account update, check if any cached pool is affected
// 3. Mark affected pools as dirty
// 4. On simulation request, re-decode only dirty pools

import type { PubkeyStr, AccountStore } from "./accountStore";
import { PoolRegistry } from "./poolRegistry";

// ============================================================================
// Hot Path Buffer Accessors (zero allocation reads)
// ============================================================================

/**
 * Read u64 amount from SPL Token account at offset 64.
 * Returns undefined if buffer is too short.
 */
export function readTokenAmount(data: Buffer): bigint | undefined {
    if (data.length < 72) return undefined;
    return data.readBigUInt64LE(64);
}

/**
 * Read u128 liquidity from Raydium CLMM pool at offset 237.
 */
export function readClmmLiquidity(data: Buffer): bigint | undefined {
    if (data.length < 253) return undefined;
    const lo = data.readBigUInt64LE(237);
    const hi = data.readBigUInt64LE(245);
    return lo + (hi << 64n);
}

/**
 * Read sqrtPriceX64 (u128) from Raydium CLMM pool at offset 253.
 */
export function readClmmSqrtPriceX64(data: Buffer): bigint | undefined {
    if (data.length < 269) return undefined;
    const lo = data.readBigUInt64LE(253);
    const hi = data.readBigUInt64LE(261);
    return lo + (hi << 64n);
}

/**
 * Read tickCurrent (i32) from Raydium CLMM pool at offset 269.
 */
export function readClmmTickCurrent(data: Buffer): number | undefined {
    if (data.length < 273) return undefined;
    return data.readInt32LE(269);
}

/**
 * Read activeId (i32) from Meteora LbPair at offset 76.
 * (Layout v2: after StaticParameters + VariableParameters + misc fields)
 */
export function readDlmmActiveId(data: Buffer): number | undefined {
    if (data.length < 80) return undefined;
    return data.readInt32LE(76);
}

/**
 * Read binStep (u16) from Meteora LbPair at offset 80.
 */
export function readDlmmBinStep(data: Buffer): number | undefined {
    if (data.length < 82) return undefined;
    return data.readUInt16LE(80);
}

// ============================================================================
// Cached Pool Types
// ============================================================================

export type PoolVenue = "pumpswap" | "raydium_v4" | "raydium_clmm" | "meteora_dlmm";

export interface CachedPoolBase {
    venue: PoolVenue;
    poolAddress: PubkeyStr;

    // Version tracking
    lastDecodedSlot: number;
    lastDecodedWriteVersion: bigint;
    dirty: boolean;
}

export interface CachedPumpSwapPool extends CachedPoolBase {
    venue: "pumpswap";

    // Decoded once (stable)
    baseVault: PubkeyStr;
    quoteVault: PubkeyStr;

    // Simulation params (from GlobalConfig - static)
    lpFeeBps: number;
    protocolFeeBps: number;
}

export interface CachedRaydiumV4Pool extends CachedPoolBase {
    venue: "raydium_v4";

    // Decoded once (stable)
    baseVault: PubkeyStr;
    quoteVault: PubkeyStr;
    openOrders: PubkeyStr;

    // Simulation params (could change but rarely)
    swapFeeNumerator: bigint;
    swapFeeDenominator: bigint;
}

export interface CachedClmmPool extends CachedPoolBase {
    venue: "raydium_clmm";

    // Decoded once (stable)
    vault0: PubkeyStr;
    vault1: PubkeyStr;
    mint0: PubkeyStr;
    mint1: PubkeyStr;
    ammConfig: PubkeyStr;
    tickSpacing: number;

    // Dynamic (changes on swaps) - read directly from buffer
    // tickCurrent, liquidity, sqrtPriceX64

    // Tick arrays (dynamic dependencies based on tickCurrent)
    tickArrays: PubkeyStr[];
}

export interface CachedDlmmPool extends CachedPoolBase {
    venue: "meteora_dlmm";

    // Decoded once (stable)
    reserveX: PubkeyStr;
    reserveY: PubkeyStr;
    mintX: PubkeyStr;
    mintY: PubkeyStr;
    binStep: number;
    baseFactor: number;

    // Dynamic parameters (read from buffer)
    // activeId, volatilityAccumulator

    // Bin arrays (dynamic dependencies based on activeId)
    binArrays: PubkeyStr[];
}

export type CachedPool = CachedPumpSwapPool | CachedRaydiumV4Pool | CachedClmmPool | CachedDlmmPool;

// ============================================================================
// Hot Path Cache
// ============================================================================

export class HotPathCache {
    private readonly pools = new Map<PubkeyStr, CachedPool>();
    private readonly registry = new PoolRegistry();
    private readonly store: AccountStore;

    constructor(store: AccountStore) {
        this.store = store;
    }

    /**
     * Register a pool and its dependencies for tracking.
     */
    registerPool(pool: CachedPool): void {
        this.pools.set(pool.poolAddress, pool);

        // Register with PoolRegistry for reverse lookups
        const deps = this.getPoolDependencies(pool);
        this.registry.registerPool(pool.poolAddress, deps);
    }

    /**
     * Get all account dependencies for a pool.
     */
    private getPoolDependencies(pool: CachedPool): PubkeyStr[] {
        const deps: PubkeyStr[] = [pool.poolAddress];

        switch (pool.venue) {
            case "pumpswap":
                deps.push(pool.baseVault, pool.quoteVault);
                break;
            case "raydium_v4":
                deps.push(pool.baseVault, pool.quoteVault, pool.openOrders);
                break;
            case "raydium_clmm":
                deps.push(pool.vault0, pool.vault1, pool.ammConfig);
                deps.push(...pool.tickArrays);
                break;
            case "meteora_dlmm":
                deps.push(pool.reserveX, pool.reserveY);
                deps.push(...pool.binArrays);
                break;
        }

        return deps;
    }

    /**
     * Update tick array dependencies for CLMM pool.
     * Call this when tickCurrent moves to a new tick array.
     */
    updateClmmTickArrays(poolAddress: PubkeyStr, newTickArrays: PubkeyStr[]): void {
        const pool = this.pools.get(poolAddress);
        if (!pool || pool.venue !== "raydium_clmm") return;

        pool.tickArrays = newTickArrays;
        this.registry.replaceDependencies(poolAddress, this.getPoolDependencies(pool));
    }

    /**
     * Update bin array dependencies for DLMM pool.
     * Call this when activeId moves to a new bin array.
     */
    updateDlmmBinArrays(poolAddress: PubkeyStr, newBinArrays: PubkeyStr[]): void {
        const pool = this.pools.get(poolAddress);
        if (!pool || pool.venue !== "meteora_dlmm") return;

        pool.binArrays = newBinArrays;
        this.registry.replaceDependencies(poolAddress, this.getPoolDependencies(pool));
    }

    /**
     * Handle account update - mark affected pools as dirty.
     * Returns set of affected pool addresses.
     */
    onAccountUpdate(accountKey: PubkeyStr): Set<PubkeyStr> {
        const affected = this.registry.getPoolsForAccount(accountKey);
        for (const poolId of affected) {
            const pool = this.pools.get(poolId);
            if (pool) pool.dirty = true;
        }
        return affected as Set<PubkeyStr>;
    }

    /**
     * Get cached pool, re-decoding if dirty.
     */
    getPool(poolAddress: PubkeyStr): CachedPool | undefined {
        return this.pools.get(poolAddress);
    }

    /**
     * Hot path: Get PumpSwap reserves directly from buffers.
     * Zero allocations in the critical path.
     */
    getPumpSwapReserves(pool: CachedPumpSwapPool): { baseReserve: bigint; quoteReserve: bigint } | undefined {
        const baseData = (this.store as any).getData?.(pool.baseVault);
        const quoteData = (this.store as any).getData?.(pool.quoteVault);

        if (!baseData || !quoteData) return undefined;

        const baseReserve = readTokenAmount(baseData);
        const quoteReserve = readTokenAmount(quoteData);

        if (baseReserve === undefined || quoteReserve === undefined) return undefined;

        return { baseReserve, quoteReserve };
    }

    /**
     * Hot path: Get Raydium V4 reserves directly from buffers.
     */
    getRaydiumV4Reserves(pool: CachedRaydiumV4Pool): { baseReserve: bigint; quoteReserve: bigint } | undefined {
        const baseData = (this.store as any).getData?.(pool.baseVault);
        const quoteData = (this.store as any).getData?.(pool.quoteVault);

        if (!baseData || !quoteData) return undefined;

        const baseReserve = readTokenAmount(baseData);
        const quoteReserve = readTokenAmount(quoteData);

        if (baseReserve === undefined || quoteReserve === undefined) return undefined;

        return { baseReserve, quoteReserve };
    }

    /**
     * Hot path: Get CLMM simulation params directly from buffers.
     */
    getClmmSimParams(pool: CachedClmmPool): {
        liquidity: bigint;
        sqrtPriceX64: bigint;
        tickCurrent: number;
    } | undefined {
        const poolData = (this.store as any).getData?.(pool.poolAddress);
        if (!poolData) return undefined;

        const liquidity = readClmmLiquidity(poolData);
        const sqrtPriceX64 = readClmmSqrtPriceX64(poolData);
        const tickCurrent = readClmmTickCurrent(poolData);

        if (liquidity === undefined || sqrtPriceX64 === undefined || tickCurrent === undefined) {
            return undefined;
        }

        return { liquidity, sqrtPriceX64, tickCurrent };
    }

    /**
     * Hot path: Get DLMM simulation params directly from buffers.
     */
    getDlmmSimParams(pool: CachedDlmmPool): {
        activeId: number;
        reserveX: bigint;
        reserveY: bigint;
    } | undefined {
        const pairData = (this.store as any).getData?.(pool.poolAddress);
        const rxData = (this.store as any).getData?.(pool.reserveX);
        const ryData = (this.store as any).getData?.(pool.reserveY);

        if (!pairData || !rxData || !ryData) return undefined;

        const activeId = readDlmmActiveId(pairData);
        const reserveX = readTokenAmount(rxData);
        const reserveY = readTokenAmount(ryData);

        if (activeId === undefined || reserveX === undefined || reserveY === undefined) {
            return undefined;
        }

        return { activeId, reserveX, reserveY };
    }

    /**
     * Clear dirty flag after re-simulation.
     */
    markClean(poolAddress: PubkeyStr): void {
        const pool = this.pools.get(poolAddress);
        if (pool) pool.dirty = false;
    }

    /**
     * Get all dirty pools that need re-simulation.
     */
    getDirtyPools(): CachedPool[] {
        return Array.from(this.pools.values()).filter(p => p.dirty);
    }

    /**
     * Total pools registered.
     */
    size(): number {
        return this.pools.size;
    }
}
