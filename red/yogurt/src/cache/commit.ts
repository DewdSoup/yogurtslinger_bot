/**
 * Canonical Cache Commit Function
 *
 * This is the ONLY function that may mutate canonical cache state.
 * All handlers (phase2, phase3, bootstrap) MUST call this function.
 * Direct cache.set() calls are PROHIBITED.
 *
 * LIFECYCLE ENFORCEMENT:
 * - RPC writes (source: 'bootstrap') are allowed in DISCOVERED or REFRESHING state
 * - Once a pool is TOPOLOGY_FROZEN or ACTIVE, RPC writes are REJECTED
 * - gRPC writes (source: 'grpc') are always allowed (canonical source)
 *
 * REFRESHING state allows RPC writes because:
 * - Epoch transitions (boundary refresh) need to re-fetch tick/bin arrays around new position
 * - Without this, refresh cannot populate new dependencies
 *
 * If it doesn't go through commitAccountUpdate(), it doesn't exist.
 */

import type { PoolState, TickArray, BinArray } from '../types.js';
import type { CacheUpdateResult } from './types.js';
import type { PumpSwapGlobalConfig } from '../decode/programs/pumpswap.js';
import type { PoolCache } from './pool.js';
import type { VaultCache } from './vault.js';
import type { TickCache } from './tick.js';
import type { BinCache } from './bin.js';
import type { AmmConfigCache } from './ammConfig.js';
import type { GlobalConfigCache } from './globalConfig.js';
import { type LifecycleRegistry, PoolLifecycleState } from './lifecycle.js';

// Phase 4.5: DEBUG logging for RPC rejections (forensics only)
const DEBUG = process.env.DEBUG === '1';

/** Phase 4.5: Rate-limited RPC rejection logging (first 10 only) */
let rpcRejectLogCount = 0;
const MAX_RPC_REJECT_LOGS = 10;

/** Convert pubkey to hex string for logging */
function toHexShort(pubkey: Uint8Array): string {
    let hex = '';
    for (let i = 0; i < 8; i++) {  // First 8 bytes = 16 hex chars
        hex += pubkey[i].toString(16).padStart(2, '0');
    }
    return hex + '...';
}

// ============================================================================
// DISCRIMINATED UNION TYPES
// ============================================================================

/**
 * Common fields for all cache commit events
 */
interface BaseCommitEvent {
    slot: number;
    writeVersion: bigint;
    dataLength: number;
    source: 'grpc' | 'bootstrap';
}

/**
 * Pool account update (PumpSwap, RaydiumV4, RaydiumClmm, MeteoraDlmm)
 */
export interface PoolCommitEvent extends BaseCommitEvent {
    type: 'pool';
    pubkey: Uint8Array;
    state: PoolState;
}

/**
 * Vault (SPL Token) account update
 */
export interface VaultCommitEvent extends BaseCommitEvent {
    type: 'vault';
    pubkey: Uint8Array;
    amount: bigint;
}

/**
 * Tick array account update (Raydium CLMM)
 * Uses composite key: (poolPubkey, startTickIndex)
 */
export interface TickCommitEvent extends BaseCommitEvent {
    type: 'tick';
    poolPubkey: Uint8Array;
    startTickIndex: number;
    tickAccountPubkey: Uint8Array;  // Actual account pubkey for trace
    array: TickArray;
}

/**
 * Bin array account update (Meteora DLMM)
 * Uses composite key: (poolPubkey, binArrayIndex)
 */
export interface BinCommitEvent extends BaseCommitEvent {
    type: 'bin';
    poolPubkey: Uint8Array;
    binArrayIndex: number;
    binAccountPubkey: Uint8Array;  // Actual account pubkey for trace
    array: BinArray;
}

/**
 * AmmConfig account update (Raydium CLMM fee rates)
 * WriteVersion: propagated from gRPC, 0n for bootstrap (RPC doesn't provide it)
 */
export interface AmmConfigCommitEvent extends BaseCommitEvent {
    type: 'ammConfig';
    pubkey: Uint8Array;
    feeRate: bigint;
}

/**
 * GlobalConfig singleton update (PumpSwap fees)
 * WriteVersion: propagated from gRPC, 0n for bootstrap (RPC doesn't provide it)
 */
export interface GlobalConfigCommitEvent extends BaseCommitEvent {
    type: 'globalConfig';
    config: PumpSwapGlobalConfig;
}

/**
 * Discriminated union of all cache commit event types
 */
export type CacheCommitEvent =
    | PoolCommitEvent
    | VaultCommitEvent
    | TickCommitEvent
    | BinCommitEvent
    | AmmConfigCommitEvent
    | GlobalConfigCommitEvent;

// ============================================================================
// CACHE REGISTRY
// ============================================================================

/**
 * Registry holds references to all cache instances.
 * Passed through handler creation so all handlers share the same caches.
 */
export interface CacheRegistry {
    pool: PoolCache;
    vault: VaultCache;
    tick: TickCache;
    bin: BinCache;
    ammConfig: AmmConfigCache;
    globalConfig: GlobalConfigCache;
    /**
     * Lifecycle registry for RPC containment enforcement.
     * Optional for backward compatibility, but REQUIRED for production.
     * If not provided, RPC containment is NOT enforced.
     */
    lifecycle?: LifecycleRegistry;
}

// ============================================================================
// LIFECYCLE BLOCKED RESULT
// ============================================================================

/**
 * Extended result when update is blocked by lifecycle
 */
export interface LifecycleBlockedResult extends CacheUpdateResult {
    /** Whether update was blocked by lifecycle rules */
    blockedByLifecycle: boolean;
    /** Pool state that caused the block */
    poolState?: PoolLifecycleState;
    /** Pool pubkey that was blocked (for debugging) */
    blockedPoolPubkey?: Uint8Array;
}

// ============================================================================
// CANONICAL COMMIT FUNCTION
// ============================================================================

/**
 * Get pool pubkey from event (for lifecycle checks on dependencies)
 */
function getPoolPubkeyFromEvent(event: CacheCommitEvent): Uint8Array | null {
    switch (event.type) {
        case 'pool':
            return event.pubkey;
        case 'tick':
            return event.poolPubkey;
        case 'bin':
            return event.poolPubkey;
        // Vault, ammConfig, globalConfig don't have direct pool association
        // They need separate tracking (handled by caller)
        default:
            return null;
    }
}

/**
 * Check if RPC write should be blocked by lifecycle rules
 *
 * @returns null if allowed, LifecycleBlockedResult if blocked
 */
function checkLifecycleBlock(
    registry: CacheRegistry,
    event: CacheCommitEvent
): LifecycleBlockedResult | null {
    // gRPC is always allowed (canonical source)
    if (event.source === 'grpc') {
        return null;
    }

    // No lifecycle registry = no enforcement (backward compatibility)
    if (!registry.lifecycle) {
        return null;
    }

    // Get pool pubkey for this event (pool, tick, bin)
    const poolPubkey = getPoolPubkeyFromEvent(event);

    if (poolPubkey) {
        // Pool, tick, or bin event - check pool lifecycle state
        const state = registry.lifecycle.getState(poolPubkey);

        // Unknown pool = allow (will be discovered)
        if (state === null) {
            return null;
        }

        // DISCOVERED or REFRESHING = allow RPC (bootstrap writes)
        // REFRESHING allows RPC because epoch transitions need to re-fetch dependencies
        if (state === PoolLifecycleState.DISCOVERED || state === PoolLifecycleState.REFRESHING) {
            return null;
        }

        // TOPOLOGY_FROZEN or ACTIVE = block RPC
        return {
            updated: false,
            wasStale: false,
            blockedByLifecycle: true,
            poolState: state,
            blockedPoolPubkey: poolPubkey,
        };
    }

    // B7 hardening: Check vault and ammConfig using reverse mappings
    if (event.type === 'vault') {
        if (!registry.lifecycle.isRpcAllowedForVault(event.pubkey)) {
            const ownerPool = registry.lifecycle.getPoolForVault(event.pubkey);
            const state = ownerPool ? registry.lifecycle.getState(ownerPool) : null;
            return {
                updated: false,
                wasStale: false,
                blockedByLifecycle: true,
                poolState: state ?? undefined,
                blockedPoolPubkey: ownerPool ?? undefined,
            };
        }
    }

    if (event.type === 'ammConfig') {
        if (!registry.lifecycle.isRpcAllowedForAmmConfig(event.pubkey)) {
            return {
                updated: false,
                wasStale: false,
                blockedByLifecycle: true,
            };
        }
    }

    // globalConfig or unknown dependency - allow
    return null;
}

/**
 * Canonical cache commit function
 *
 * This is the ONLY entry point for cache mutations.
 *
 * Responsibilities:
 * 1. Check lifecycle rules for RPC sources (BLOCK if frozen/active)
 * 2. Route to correct cache based on event type
 * 3. Delegate staleness checking to underlying cache
 * 4. Let caches emit their own trace events
 * 5. Return unified result (with lifecycle blocking info if applicable)
 *
 * LIFECYCLE ENFORCEMENT:
 * - source: 'grpc' → always allowed
 * - source: 'bootstrap' + pool in DISCOVERED → allowed
 * - source: 'bootstrap' + pool in REFRESHING → allowed (epoch transition)
 * - source: 'bootstrap' + pool in TOPOLOGY_FROZEN → BLOCKED
 * - source: 'bootstrap' + pool in ACTIVE → BLOCKED
 *
 * @param registry - Cache registry containing all cache instances
 * @param event - Discriminated union event describing the update
 * @returns CacheUpdateResult or LifecycleBlockedResult
 */
export function commitAccountUpdate(
    registry: CacheRegistry,
    event: CacheCommitEvent
): CacheUpdateResult | LifecycleBlockedResult {
    // Check lifecycle rules for RPC sources
    const blocked = checkLifecycleBlock(registry, event);
    if (blocked) {
        // Phase 4.5: DEBUG logging for RPC rejections (forensics only)
        if (DEBUG && rpcRejectLogCount < MAX_RPC_REJECT_LOGS) {
            rpcRejectLogCount++;
            const pubkey = 'pubkey' in event ? toHexShort(event.pubkey)
                : 'poolPubkey' in event ? toHexShort(event.poolPubkey)
                : 'unknown';
            console.debug(
                '[rpc-reject]',
                JSON.stringify({
                    cacheType: event.type,
                    pubkey,
                    slot: event.slot,
                    lifecycleState: blocked.poolState ?? 'unknown',
                    reason: 'RPC rejected: pool not DISCOVERED/REFRESHING',
                })
            );
        }
        return blocked;
    }

    // Proceed with cache update
    switch (event.type) {
        case 'pool':
            return registry.pool.set(
                event.pubkey,
                event.state,
                event.slot,
                event.writeVersion,
                event.dataLength,
                event.source
            );

        case 'vault':
            return registry.vault.set(
                event.pubkey,
                event.amount,
                event.slot,
                event.writeVersion,
                event.dataLength,
                event.source
            );

        case 'tick':
            return registry.tick.set(
                event.poolPubkey,
                event.startTickIndex,
                event.array,
                event.slot,
                event.writeVersion,
                event.tickAccountPubkey,
                event.dataLength,
                event.source
            );

        case 'bin':
            return registry.bin.set(
                event.poolPubkey,
                event.binArrayIndex,
                event.array,
                event.slot,
                event.writeVersion,
                event.binAccountPubkey,
                event.dataLength,
                event.source
            );

        case 'ammConfig':
            return registry.ammConfig.set(
                event.pubkey,
                event.feeRate,
                event.slot,
                event.writeVersion,
                event.dataLength,
                event.source
            );

        case 'globalConfig':
            return registry.globalConfig.set(
                event.config,
                event.slot,
                event.writeVersion,
                event.dataLength,
                event.source
            );
    }
}

/**
 * Check if a commit result was blocked by lifecycle
 */
export function wasBlockedByLifecycle(
    result: CacheUpdateResult | LifecycleBlockedResult
): result is LifecycleBlockedResult {
    return 'blockedByLifecycle' in result && result.blockedByLifecycle === true;
}
