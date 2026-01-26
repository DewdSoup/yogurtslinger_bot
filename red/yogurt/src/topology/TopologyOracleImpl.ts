/**
 * TopologyOracleImpl — Minimal Topology Freeze Implementation
 *
 * Purpose:
 * Freezes pool lifecycle after required dependencies are known.
 * Uses existing derive.ts logic to determine required tick/bin arrays.
 *
 * This is NOT a full state space enumeration.
 * It freezes the specific dependencies needed for simulation at current position.
 *
 * Flow:
 * 1. Pool discovered → lifecycle.discover() [already happening]
 * 2. Bootstrap fetches dependencies → tick/bin arrays populated
 * 3. TopologyOracle.freezePool() → captures required deps, freezes lifecycle
 * 4. TopologyOracle.tryActivate() → if complete, activates pool
 *
 * After freeze: RPC writes BLOCKED. Only gRPC updates allowed.
 */

import type { CacheRegistry } from '../cache/commit.js';
import type { FrozenTopology, TopologyOracle } from '../cache/lifecycle.js';
import { PoolLifecycleState } from '../cache/lifecycle.js';
import type { PoolState, RaydiumClmmPool, MeteoraDlmmPool } from '../types.js';
import { VenueId } from '../types.js';
import { derivePoolDependencies, type DeriveConfig } from '../snapshot/derive.js';

const DEBUG = process.env.DEBUG === '1';

/** Rate-limiter: log static-bypass breadcrumb once per process */
let staticBypassLogged = false;

/**
 * Result of freeze operation
 */
export interface FreezeResult {
    frozen: boolean;
    reason?: 'already_frozen' | 'pool_not_found' | 'pool_not_discovered' | 'success';
    topology?: FrozenTopology;
}

/**
 * Result of activation attempt
 */
export interface ActivationResult {
    activated: boolean;
    reason?: 'not_frozen' | 'incomplete' | 'already_active' | 'success';
    missing?: {
        vaults: Uint8Array[];
        tickArrays: number[];
        binArrays: number[];
    };
}

/**
 * TopologyOracleImpl — Uses existing derive.ts logic to freeze dependencies
 *
 * Phase 2 Addition:
 * - Accepts grpcSubscriptionStartSlot for convergence validation
 * - Gates activation on dependency convergence (all deps have gRPC source OR bootstrap slot >= startSlot)
 * - Bypasses static accounts (ammConfig) that never receive gRPC updates
 */
export class TopologyOracleImpl implements TopologyOracle {
    /**
     * Phase 2: gRPC subscription start slot for convergence validation
     * If null, convergence validation is disabled (legacy mode)
     */
    private readonly grpcSubscriptionStartSlot: number | null;

    constructor(
        private registry: CacheRegistry,
        private config: DeriveConfig = {},
        grpcSubscriptionStartSlot: number | null = null
    ) {
        this.grpcSubscriptionStartSlot = grpcSubscriptionStartSlot;
        if (grpcSubscriptionStartSlot !== null) {
            DEBUG && console.log(`[TopologyOracle] Convergence validation enabled (startSlot: ${grpcSubscriptionStartSlot})`);
        }
    }

    /**
     * Freeze pool topology based on current pool state.
     * After this call, RPC writes are BLOCKED for this pool.
     *
     * @param poolPubkey - Pool to freeze
     * @returns FreezeResult with topology if successful
     */
    freezePool(poolPubkey: Uint8Array, slot: number): FreezeResult {
        const lifecycle = this.registry.lifecycle;
        if (!lifecycle) {
            return { frozen: false, reason: 'pool_not_found' };
        }

        // Check current state
        const state = lifecycle.getState(poolPubkey);
        if (state === null) {
            return { frozen: false, reason: 'pool_not_discovered' };
        }
        // Allow freeze from DISCOVERED (initial) or REFRESHING (epoch transition)
        // This ensures refresh cycles work: ACTIVE → REFRESHING → freezePool → tryActivate
        if (state !== PoolLifecycleState.DISCOVERED && state !== PoolLifecycleState.REFRESHING) {
            return { frozen: false, reason: 'already_frozen' };
        }

        // Get pool from cache
        const poolEntry = this.registry.pool.get(poolPubkey);
        if (!poolEntry) {
            return { frozen: false, reason: 'pool_not_found' };
        }

        const pool = poolEntry.state;

        // Derive required dependencies using existing logic
        const deps = derivePoolDependencies(poolPubkey, pool, this.config);

        // Build FrozenTopology
        const topology = this.buildFrozenTopology(poolPubkey, pool, deps, slot);

        // Freeze lifecycle - RPC blocked after this
        const froze = lifecycle.freezeTopology(poolPubkey, topology, slot);
        if (!froze) {
            return { frozen: false, reason: 'already_frozen' };
        }

        return { frozen: true, reason: 'success', topology };
    }

    /**
     * Try to activate a frozen pool.
     * Checks if all required dependencies are present (cached or marked non-existent).
     *
     * @param poolPubkey - Pool to activate
     * @returns ActivationResult with missing deps if incomplete
     */
    tryActivate(poolPubkey: Uint8Array, slot: number): ActivationResult {
        const lifecycle = this.registry.lifecycle;
        if (!lifecycle) {
            return { activated: false, reason: 'not_frozen' };
        }

        const state = lifecycle.getState(poolPubkey);
        if (state === PoolLifecycleState.ACTIVE) {
            return { activated: false, reason: 'already_active' };
        }
        if (state !== PoolLifecycleState.TOPOLOGY_FROZEN) {
            return { activated: false, reason: 'not_frozen' };
        }

        const topology = lifecycle.getTopology(poolPubkey);
        if (!topology) {
            return { activated: false, reason: 'not_frozen' };
        }

        // Check completeness
        const missing = this.getMissingDependencies(topology);
        const isComplete =
            missing.vaults.length === 0 &&
            missing.tickArrays.length === 0 &&
            missing.binArrays.length === 0 &&
            !missing.ammConfig;

        if (!isComplete) {
            lifecycle.markIncomplete(poolPubkey, this.formatMissingReason(missing), slot);
            return { activated: false, reason: 'incomplete', missing };
        }

        // CRITICAL: Block activation if all tick/bin arrays are virtual (zero liquidity)
        // Virtual arrays have no real liquidity data - simulations WILL be wrong.
        // This happens when:
        // 1. Bitmap says arrays don't exist (legitimate - no liquidity at current price)
        // 2. RPC errors caused all arrays to be marked non-existent (bad - should retry)
        const hasRealArrays = this.hasAnyRealArrays(topology);
        const requiresArrays = topology.requiredTickArrays.length > 0 || topology.requiredBinArrays.length > 0;

        if (!hasRealArrays && requiresArrays) {
            const poolHex = this.toPoolHex(poolPubkey);
            DEBUG && console.warn(
                `[topology] Pool ${poolHex} BLOCKED - only virtual arrays ` +
                `(${topology.requiredTickArrays.length} tick, ${topology.requiredBinArrays.length} bin). ` +
                `Cannot simulate without real liquidity data.`
            );
            lifecycle.markIncomplete(
                poolPubkey,
                `No real tick/bin arrays - all ${topology.requiredTickArrays.length + topology.requiredBinArrays.length} are virtual`,
                slot
            );
            return {
                activated: false,
                reason: 'incomplete',
                missing: {
                    vaults: [],
                    tickArrays: topology.requiredTickArrays,
                    binArrays: topology.requiredBinArrays,
                }
            };
        }

        // Phase 2: Check convergence before activation
        // All dependencies must have gRPC confirmation OR valid bootstrap slot
        if (!this.allDepsConverged(topology)) {
            const poolHex = this.toPoolHex(poolPubkey);
            DEBUG && console.log(`[topology] Pool ${poolHex} waiting for convergence`);
            lifecycle.markIncomplete(
                poolPubkey,
                'Waiting for dependency convergence (gRPC confirmation)',
                slot
            );
            return {
                activated: false,
                reason: 'incomplete',
                missing: {
                    vaults: [],
                    tickArrays: [],
                    binArrays: [],
                }
            };
        }

        // Activate
        const activated = lifecycle.activate(poolPubkey, slot);
        if (!activated) {
            return { activated: false, reason: 'not_frozen' };
        }

        return { activated: true, reason: 'success' };
    }

    /**
     * Freeze and try to activate in one call.
     * Convenience method for when dependencies are expected to be ready.
     */
    freezeAndActivate(poolPubkey: Uint8Array, slot: number): {
        freeze: FreezeResult;
        activation?: ActivationResult;
    } {
        const freeze = this.freezePool(poolPubkey, slot);
        if (!freeze.frozen) {
            return { freeze };
        }

        const activation = this.tryActivate(poolPubkey, slot);
        return { freeze, activation };
    }

    // =========================================================================
    // TopologyOracle interface implementation
    // =========================================================================

    computeTopology(poolPubkey: Uint8Array): FrozenTopology | null {
        const poolEntry = this.registry.pool.get(poolPubkey);
        if (!poolEntry) return null;

        const pool = poolEntry.state;
        const deps = derivePoolDependencies(poolPubkey, pool, this.config);

        return this.buildFrozenTopology(poolPubkey, pool, deps, poolEntry.slot);
    }

    isTopologyComplete(topology: FrozenTopology): boolean {
        const missing = this.getMissingDependencies(topology);
        return (
            missing.vaults.length === 0 &&
            missing.tickArrays.length === 0 &&
            missing.binArrays.length === 0 &&
            !missing.ammConfig
        );
    }

    getMissingDependencies(topology: FrozenTopology): {
        vaults: Uint8Array[];
        tickArrays: number[];
        binArrays: number[];
        ammConfig: boolean;
    } {
        const missingVaults: Uint8Array[] = [];
        const missingTickArrays: number[] = [];
        const missingBinArrays: number[] = [];
        let missingAmmConfig = false;

        // Check vaults
        if (!this.registry.vault.get(topology.vaults.base)) {
            missingVaults.push(topology.vaults.base);
        }
        if (!this.registry.vault.get(topology.vaults.quote)) {
            missingVaults.push(topology.vaults.quote);
        }

        // Check tick arrays (CLMM)
        for (const startIdx of topology.requiredTickArrays) {
            const array = this.registry.tick.getOrVirtual(topology.poolPubkey, startIdx);
            if (array === null) {
                // Not cached AND not marked non-existent → truly missing
                missingTickArrays.push(startIdx);
            }
        }

        // Check bin arrays (DLMM)
        for (const idx of topology.requiredBinArrays) {
            const array = this.registry.bin.getOrVirtual(topology.poolPubkey, idx);
            if (array === null) {
                // Not cached AND not marked non-existent → truly missing
                missingBinArrays.push(idx);
            }
        }

        // Check ammConfig (CLMM only)
        if (topology.ammConfigPubkey) {
            if (!this.registry.ammConfig.has(topology.ammConfigPubkey)) {
                missingAmmConfig = true;
            }
        }

        return {
            vaults: missingVaults,
            tickArrays: missingTickArrays,
            binArrays: missingBinArrays,
            ammConfig: missingAmmConfig,
        };
    }

    // =========================================================================
    // Phase 2: Convergence Validation
    // =========================================================================

    /**
     * Phase 2: Check if a dependency entry is valid for activation
     *
     * Valid if:
     * - source === 'grpc' (confirmed by gRPC stream)
     * - source === 'bootstrap' AND slot >= grpcSubscriptionStartSlot (no stale RPC)
     * - isStaticAccount(pubkey) (ammConfig never receives gRPC updates)
     *
     * @param entry - Cache entry with source and slot
     * @param pubkey - Account pubkey (for static account bypass)
     */
    private isDependencyValid(
        entry: { source?: 'grpc' | 'bootstrap'; slot: number } | null,
        pubkey: Uint8Array
    ): boolean {
        if (!entry) return false;

        // gRPC source is always valid (real-time confirmed)
        if (entry.source === 'grpc') return true;

        // Bootstrap source is valid if slot >= startSlot (no stale RPC)
        if (entry.source === 'bootstrap') {
            if (this.grpcSubscriptionStartSlot === null) {
                // Legacy mode: convergence disabled, accept bootstrap
                return true;
            }
            if (entry.slot >= this.grpcSubscriptionStartSlot) {
                return true;
            }
        }

        // BYPASS: Static accounts don't receive gRPC updates
        // ammConfig accounts are protocol constants, rarely change
        // Static-account bypass semantics documented in PHASE4_6_SEMANTIC_CONTRACTS.md
        if (this.isStaticAccount(pubkey)) {
            DEBUG && !staticBypassLogged && (staticBypassLogged = true, console.log('[static-bypass] Static account bypass exercised'));
            return true;
        }

        return false;
    }

    /**
     * STATIC ACCOUNT BYPASS CONTRACT
     * ------------------------------
     * An account may be treated as "static" for convergence purposes ONLY if:
     *
     * 1) It does NOT affect dependency enumeration
     *    (i.e. it does not change which accounts must exist)
     *
     * 2) It does NOT gate pool activation semantics
     *    (i.e. activation does not depend on its dynamic contents)
     *
     * 3) It does NOT change over time in a way that affects correctness
     *
     * This bypass is valid ONLY for:
     *   - CLMM ammConfig (protocol fee configuration, rarely changes)
     *   - PumpSwap globalConfig (protocol constants)
     *
     * This is NOT a general escape hatch.
     * Misclassifying a dynamic account as static is a correctness bug.
     *
     * Phase 2: Check if pubkey is a static account (ammConfig)
     * Static accounts are protocol-level configuration that rarely change
     * and don't receive gRPC updates from the DEX program filter.
     */
    private isStaticAccount(pubkey: Uint8Array): boolean {
        // DEBUG-only validation: Ensure only allowlisted account types use static bypass
        // The static bypass is ONLY valid for ammConfig entries - any other use is a bug.
        DEBUG && console.assert(
            this.registry.ammConfig.has(pubkey),
            `[STATIC_BYPASS_VIOLATION] Account ${this.toPoolHex(pubkey)} used static bypass but is not in ammConfig allowlist`
        );
        return this.registry.ammConfig.has(pubkey);
    }

    /**
     * Phase 2: Check if all dependencies for a topology have converged
     *
     * Convergence means all deps are confirmed valid:
     * - Have gRPC source, OR
     * - Have bootstrap source with slot >= grpcSubscriptionStartSlot, OR
     * - Are static accounts (ammConfig bypass)
     *
     * @returns true if all deps are converged, false otherwise
     */
    allDepsConverged(topology: FrozenTopology): boolean {
        // Skip convergence check if disabled (legacy mode)
        if (this.grpcSubscriptionStartSlot === null) {
            return true;
        }

        // Phase 2.1: Ensure pool account itself is converged
        // The pool account is the primary dependency - if it's stale, all derived state is suspect
        const poolEntry = this.registry.pool.getEntry(topology.poolPubkey);
        if (!this.isDependencyValid(poolEntry, topology.poolPubkey)) {
            DEBUG && console.log(`[TopologyOracle] Convergence failed: pool account not valid`);
            return false;
        }

        // Check vaults
        const baseVault = this.registry.vault.getEntry(topology.vaults.base);
        if (!this.isDependencyValid(baseVault, topology.vaults.base)) {
            DEBUG && console.log(`[TopologyOracle] Convergence failed: base vault not valid`);
            return false;
        }

        const quoteVault = this.registry.vault.getEntry(topology.vaults.quote);
        if (!this.isDependencyValid(quoteVault, topology.vaults.quote)) {
            DEBUG && console.log(`[TopologyOracle] Convergence failed: quote vault not valid`);
            return false;
        }

        // Check tick arrays (CLMM)
        for (const startIdx of topology.requiredTickArrays) {
            const entry = this.registry.tick.getEntry(topology.poolPubkey, startIdx);
            // Virtual arrays (non-existent) are OK - they legitimately don't exist on-chain
            if (entry === null) {
                // Check if marked non-existent (virtual)
                if (this.registry.tick.isNonExistent(topology.poolPubkey, startIdx)) {
                    continue;  // Virtual is OK
                }
                DEBUG && console.log(`[TopologyOracle] Convergence failed: tick array ${startIdx} missing`);
                return false;
            }
            // Create a pseudo-pubkey for the tick array (pool:startIdx)
            // Tick arrays don't need static bypass - they're pool-specific
            if (!this.isDependencyValid(entry, topology.poolPubkey)) {
                DEBUG && console.log(`[TopologyOracle] Convergence failed: tick array ${startIdx} not valid`);
                return false;
            }
        }

        // Check bin arrays (DLMM)
        for (const idx of topology.requiredBinArrays) {
            const entry = this.registry.bin.getEntry(topology.poolPubkey, idx);
            // Virtual arrays (non-existent) are OK
            if (entry === null) {
                if (this.registry.bin.isNonExistent(topology.poolPubkey, idx)) {
                    continue;  // Virtual is OK
                }
                DEBUG && console.log(`[TopologyOracle] Convergence failed: bin array ${idx} missing`);
                return false;
            }
            if (!this.isDependencyValid(entry, topology.poolPubkey)) {
                DEBUG && console.log(`[TopologyOracle] Convergence failed: bin array ${idx} not valid`);
                return false;
            }
        }

        // Check ammConfig (CLMM only) - uses static account bypass
        if (topology.ammConfigPubkey) {
            const entry = this.registry.ammConfig.getEntry(topology.ammConfigPubkey);
            if (!this.isDependencyValid(entry, topology.ammConfigPubkey)) {
                DEBUG && console.log(`[TopologyOracle] Convergence failed: ammConfig not valid`);
                return false;
            }
        }

        return true;
    }

    // =========================================================================
    // Private helpers
    // =========================================================================

    private buildFrozenTopology(
        poolPubkey: Uint8Array,
        pool: PoolState,
        deps: { vaults: Uint8Array[]; tickArrayIndexes?: number[]; binArrayIndexes?: number[] },
        slot: number
    ): FrozenTopology {
        let baseVault: Uint8Array;
        let quoteVault: Uint8Array;
        let ammConfigPubkey: Uint8Array | null = null;

        switch (pool.venue) {
            case VenueId.PumpSwap:
                baseVault = pool.baseVault;
                quoteVault = pool.quoteVault;
                break;
            case VenueId.RaydiumV4:
                baseVault = pool.baseVault;
                quoteVault = pool.quoteVault;
                break;
            case VenueId.RaydiumClmm: {
                const clmm = pool as RaydiumClmmPool;
                baseVault = clmm.tokenVault0;
                quoteVault = clmm.tokenVault1;
                ammConfigPubkey = clmm.ammConfig;
                break;
            }
            case VenueId.MeteoraDlmm: {
                const dlmm = pool as MeteoraDlmmPool;
                baseVault = dlmm.vaultX;
                quoteVault = dlmm.vaultY;
                break;
            }
        }

        return {
            poolPubkey,
            venue: pool.venue,
            vaults: { base: baseVault, quote: quoteVault },
            requiredTickArrays: deps.tickArrayIndexes ?? [],
            requiredBinArrays: deps.binArrayIndexes ?? [],
            ammConfigPubkey,
            frozenAtSlot: slot,
            frozenAtMs: Date.now(),
        };
    }

    private formatMissingReason(missing: {
        vaults: Uint8Array[];
        tickArrays: number[];
        binArrays: number[];
        ammConfig: boolean;
    }): string {
        const parts: string[] = [];
        if (missing.vaults.length > 0) {
            parts.push(`${missing.vaults.length} vaults`);
        }
        if (missing.tickArrays.length > 0) {
            parts.push(`${missing.tickArrays.length} tick arrays`);
        }
        if (missing.binArrays.length > 0) {
            parts.push(`${missing.binArrays.length} bin arrays`);
        }
        if (missing.ammConfig) {
            parts.push('ammConfig');
        }
        return `Missing: ${parts.join(', ')}`;
    }

    /**
     * Check if pool has at least one real (non-virtual) tick or bin array.
     * Returns false if all arrays are virtual (marked non-existent).
     * This is a sanity check to detect false activation from RPC errors.
     *
     * CRITICAL FIX: Check what's ACTUALLY cached for this pool, not just what's "required".
     * The bitmap may have liquidity at different positions than derive.ts expects.
     * A pool with liquidity at ANY position is tradeable (within that range).
     */
    private hasAnyRealArrays(topology: FrozenTopology): boolean {
        const poolHex = this.toPoolHex(topology.poolPubkey).slice(0, -3); // Remove trailing "..."
        const fullPoolHex = this.toFullPoolHex(topology.poolPubkey);

        // Check tick arrays - see if ANY real tick arrays exist for this pool
        // (regardless of whether they match the "required" list from derive.ts)
        if (topology.requiredTickArrays.length > 0) {
            const cachedTickArrays = this.registry.tick.getForPool(fullPoolHex);
            if (cachedTickArrays.length > 0) {
                return true; // Has at least one real tick array
            }
        }

        // Check bin arrays - see if ANY real bin arrays exist for this pool
        if (topology.requiredBinArrays.length > 0) {
            const cachedBinArrays = this.registry.bin.getForPool(fullPoolHex);
            if (cachedBinArrays.length > 0) {
                return true; // Has at least one real bin array
            }
        }

        // No required arrays OR truly no arrays exist
        return topology.requiredTickArrays.length === 0 && topology.requiredBinArrays.length === 0;
    }

    /**
     * Convert pool pubkey to full hex string (for cache lookup)
     */
    private toFullPoolHex(poolPubkey: Uint8Array): string {
        let hex = '';
        for (let i = 0; i < poolPubkey.length; i++) {
            hex += poolPubkey[i].toString(16).padStart(2, '0');
        }
        return hex;
    }

    /**
     * Convert pool pubkey to short hex for logging
     */
    private toPoolHex(poolPubkey: Uint8Array): string {
        let hex = '';
        for (let i = 0; i < Math.min(8, poolPubkey.length); i++) {
            hex += poolPubkey[i].toString(16).padStart(2, '0');
        }
        return hex + '...';
    }
}

/**
 * Create TopologyOracle instance
 *
 * @param registry - Cache registry
 * @param config - Optional configuration for tick/bin array radius
 * @param grpcSubscriptionStartSlot - Phase 2: Start slot for convergence validation (null = disabled)
 */
export function createTopologyOracle(
    registry: CacheRegistry,
    config?: DeriveConfig,
    grpcSubscriptionStartSlot?: number | null
): TopologyOracleImpl {
    return new TopologyOracleImpl(registry, config, grpcSubscriptionStartSlot ?? null);
}
