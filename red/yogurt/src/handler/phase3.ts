/**
 * Phase 3 Handler — Simulation-Ready State
 *
 * Processes:
 * - Pool accounts (all 4 venues)
 * - Tick arrays (CLMM)
 * - Bin arrays (DLMM)
 * - Vault balances (SPL Token) — via gRPC subscription (100% real-time)
 *
 * Cache Strategy:
 * - Pool arrives via gRPC → onPoolDiscovered()
 * - fetchPoolDeps() makes ONE RPC call for tick/bin arrays + ammConfig
 * - TopologyOracle freezes dependencies, then activates pool
 * - After freeze, RPC is blocked — only gRPC updates allowed
 */

import type { IngestEvent, AccountUpdate, PoolState, TickArray, BinArray, RaydiumClmmPool, MeteoraDlmmPool } from '../types.js';
import { VenueId } from '../types.js';
import { PoolCache } from '../cache/pool.js';
import { VaultCache } from '../cache/vault.js';
import { TickCache } from '../cache/tick.js';
import { BinCache } from '../cache/bin.js';
import { AmmConfigCache } from '../cache/ammConfig.js';
import { GlobalConfigCache } from '../cache/globalConfig.js';
import { commitAccountUpdate, type CacheRegistry } from '../cache/commit.js';
import { createLifecycleRegistry, PoolLifecycleState } from '../cache/lifecycle.js';
import { decodeAccount, isTargetProgram } from '../decode/account.js';
import { decodeTokenAccountAmount } from '../decode/vault.js';
import { isTickArray, decodeTickArray } from '../decode/programs/tickArray.js';
import { isBinArray, decodeBinArray } from '../decode/programs/binArray.js';
import { decodePumpSwapGlobalConfig, PUMPSWAP_GLOBAL_CONFIG_PUBKEY } from '../decode/programs/pumpswap.js';
import type { GrpcConsumer } from '../ingest/grpc.js';
import { createTopologyOracle, type TopologyOracleImpl } from '../topology/TopologyOracleImpl.js';
import { fetchPoolDeps } from '../topology/fetchPoolDeps.js';
import { checkPoolBoundary, formatBoundaryReason } from '../topology/boundaryCheck.js';
import { createOrphanBuffer, type OrphanBuffer } from '../cache/orphanBuffer.js';
import { createHealthMonitor, type CacheHealthMonitor } from '../cache/healthMonitor.js';

const DEBUG = process.env.DEBUG === '1';

// Max concurrent RPC calls for fetchPoolDeps (NEW pools discovered AFTER bootstrap)
// With 24+ cores and local RPC, can handle higher concurrency
const MAX_CONCURRENT_RPC = 12;

// Program ID bytes (pre-computed for fast comparison)
const RAYDIUM_CLMM_BYTES = new Uint8Array([
    0xa5, 0xd5, 0xca, 0x9e, 0x04, 0xcf, 0x5d, 0xb5,
    0x90, 0xb7, 0x14, 0xba, 0x2f, 0xe3, 0x2c, 0xb1,
    0x59, 0x13, 0x3f, 0xc1, 0xc1, 0x92, 0xb7, 0x22,
    0x57, 0xfd, 0x07, 0xd3, 0x9c, 0xb0, 0x40, 0x1e,
]);

const METEORA_DLMM_BYTES = new Uint8Array([
    0x04, 0xe9, 0xe1, 0x2f, 0xbc, 0x84, 0xe8, 0x26,
    0xc9, 0x32, 0xcc, 0xe9, 0xe2, 0x64, 0x0c, 0xce,
    0x15, 0x59, 0x0c, 0x1c, 0x62, 0x73, 0xb0, 0x92,
    0x57, 0x08, 0xba, 0x3b, 0x85, 0x20, 0xb0, 0xbc,
]);

const SPL_TOKEN_BYTES = new Uint8Array([
    0x06, 0xdd, 0xf6, 0xe1, 0xd7, 0x65, 0xa1, 0x93,
    0xd9, 0xcb, 0xe1, 0x46, 0xce, 0xeb, 0x79, 0xac,
    0x1c, 0xb4, 0x85, 0xed, 0x5f, 0x5b, 0x37, 0x91,
    0x3a, 0x8c, 0xf5, 0x85, 0x7e, 0xff, 0x00, 0xa9,
]);

// Token-2022 program ID: TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
const SPL_TOKEN_2022_BYTES = new Uint8Array([
    0x06, 0xdd, 0xf6, 0xe1, 0xee, 0x75, 0x8f, 0xde,
    0x18, 0x42, 0x5d, 0xbc, 0xe4, 0x6c, 0xcd, 0xda,
    0xb6, 0x1a, 0xfc, 0x4d, 0x83, 0xb9, 0x0d, 0x27,
    0xfe, 0xbd, 0xf9, 0x28, 0xd8, 0xa1, 0x8b, 0xfc,
]);

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function toHex(pubkey: Uint8Array): string {
    let key = '';
    for (let i = 0; i < 32; i++) {
        key += pubkey[i]!.toString(16).padStart(2, '0');
    }
    return key;
}

export interface Phase3HandlerConfig {
    rpcEndpoint: string;
    /** gRPC consumer for dynamic vault subscription (100% real-time) */
    grpcConsumer?: GrpcConsumer;
    /** Number of tick arrays to prefetch on each side of current tick */
    tickArrayRadius?: number;
    /** Number of bin arrays to prefetch on each side of active bin */
    binArrayRadius?: number;
    /** Number of arrays from edge to trigger refresh (default: 1) */
    boundaryBuffer?: number;
    /** Minimum time between refreshes per pool in ms (default: 5000) */
    refreshIntervalMs?: number;
}

export interface Phase3Handler {
    registry: CacheRegistry;
    poolCache: PoolCache;
    vaultCache: VaultCache;
    tickCache: TickCache;
    binCache: BinCache;
    ammConfigCache: AmmConfigCache;  // INF-3: CLMM fee rate cache
    topologyOracle: TopologyOracleImpl;  // Freeze pool dependencies for determinism
    handle: (event: IngestEvent) => void;
    getStats: () => Phase3Stats;
    /**
     * Start the handler - connects gRPC, then ready.
     * This is the main entry point for production use.
     */
    start: () => Promise<void>;
}

export interface Phase3Stats {
    // Cache sizes
    poolCacheSize: number;
    vaultCacheSize: number;
    tickCacheSize: number;
    binCacheSize: number;
    // Updates processed
    poolUpdates: bigint;
    vaultUpdates: bigint;
    tickArrayUpdates: bigint;
    binArrayUpdates: bigint;
    // Lifecycle stats
    lifecycleDiscovered: number;
    lifecycleFrozen: number;
    lifecycleActive: number;
    lifecycleIncomplete: number;
    // Activation stats
    activationAttempts: number;
    activationSuccesses: number;
    // Bootstrap stats (RPC)
    tickArraysFetched: number;
    binArraysFetched: number;
    ammConfigsFetched: number;
    vaultsFetched: number;
    // Refresh stats (topology epoch transitions)
    lifecycleRefreshing: number;
    refreshTriggered: number;
    refreshCompleted: number;
    // Orphan buffer stats
    orphanBufferSize: number;
    orphanTicksClaimed: number;
    orphanBinsClaimed: number;
    orphanReclaimRate: number;
    // Health monitoring
    cacheHealthy: boolean;
}

/**
 * Create Phase 3 handler with TopologyOracle for deterministic cache
 *
 * Flow:
 * 1. Pool arrives via gRPC → lifecycle.discover() + onPoolDiscovered()
 * 2. fetchPoolDeps() makes ONE RPC call for tick/bin arrays + ammConfig
 * 3. TopologyOracle freezes pool dependencies
 * 4. tryActivate() checks completeness and transitions to ACTIVE
 * 5. After freeze, RPC is blocked — only gRPC updates allowed
 *
 * grpcConsumer is required for vault subscription (100% real-time)
 */
export function createPhase3Handler(config: Phase3HandlerConfig): Phase3Handler {
    // Create lifecycle registry for RPC containment
    const lifecycle = createLifecycleRegistry();

    // Create tick/bin caches with lifecycle registry for Phase 3.1 eviction
    const tickCacheInstance = new TickCache().setLifecycleRegistry(lifecycle);
    const binCacheInstance = new BinCache().setLifecycleRegistry(lifecycle);

    // Create full cache registry with lifecycle enforcement
    const registry: CacheRegistry = {
        pool: new PoolCache(),
        vault: new VaultCache(),
        tick: tickCacheInstance,
        bin: binCacheInstance,
        ammConfig: new AmmConfigCache(),
        globalConfig: new GlobalConfigCache(),
        lifecycle,  // RPC containment enforcement
    };

    // Convenience aliases for compatibility
    const poolCache = registry.pool;
    const vaultCache = registry.vault;
    const tickCache = registry.tick;
    const binCache = registry.bin;
    const ammConfigCache = registry.ammConfig;

    // Orphan buffer for tick/bin arrays that arrive before their pool
    const orphanBuffer = createOrphanBuffer();

    // Health monitor for cache parity validation
    const healthMonitor = createHealthMonitor(
        orphanBuffer,
        poolCache,
        tickCache,
        binCache,
        vaultCache
    );

    const tickArrayRadius = config.tickArrayRadius ?? 3;
    const binArrayRadius = config.binArrayRadius ?? 3;
    const deriveConfig = { tickArrayRadius, binArrayRadius };

    // Boundary check config for refresh triggers
    const boundaryBuffer = config.boundaryBuffer ?? 1;
    const refreshIntervalMs = config.refreshIntervalMs ?? 5000;
    const boundaryConfig = { bufferArrays: boundaryBuffer };

    // Concurrency limiter state (per-handler instance)
    let activeRpcCalls = 0;
    const pendingRpcQueue: Array<() => void> = [];

    function acquireRpcSlot(): Promise<void> {
        if (activeRpcCalls < MAX_CONCURRENT_RPC) {
            activeRpcCalls++;
            return Promise.resolve();
        }
        return new Promise<void>(resolve => {
            pendingRpcQueue.push(resolve);
        });
    }

    function releaseRpcSlot(): void {
        activeRpcCalls--;
        const next = pendingRpcQueue.shift();
        if (next) {
            activeRpcCalls++;
            next();
        }
    }

    // gRPC consumer for vault subscription
    const grpcConsumer = config.grpcConsumer ?? null;
    if (grpcConsumer) {
        grpcConsumer.enableVaultSubscription();
        DEBUG && console.log('[phase3] Vault subscription enabled via gRPC');
    }

    // Phase 2: TopologyOracle created in start() after gRPC captures startSlot
    // This ensures convergence check has immutable startSlot snapshot
    let topologyOracle: TopologyOracleImpl | null = null;
    let grpcSubscriptionStartSlot: number | null = null;  // Captured in start()
    const rpcEndpoint = config.rpcEndpoint;

    // Phase 2: Queue for pools discovered before topologyOracle is ready
    const pendingPoolDiscoveries: Array<{ poolPubkey: Uint8Array; pool: PoolState; slot: number }> = [];
    let topologyOracleReady = false;

    // Counters
    let poolUpdates = 0n;
    let vaultUpdates = 0n;
    let tickArrayUpdates = 0n;
    let binArrayUpdates = 0n;
    let activationAttempts = 0;
    let activationSuccesses = 0;
    // Bootstrap stats (RPC)
    let tickArraysFetched = 0;
    let binArraysFetched = 0;
    let ammConfigsFetched = 0;
    let vaultsFetched = 0;
    // Refresh stats
    let refreshTriggered = 0;
    let refreshCompleted = 0;

    // Track vaults for gRPC subscription
    const trackedVaults = new Set<string>();

    /**
     * Called when pool is discovered - subscribe vaults, fetch deps, freeze/activate
     * Uses concurrency limiter to prevent event loop stall from too many parallel RPC calls
     */
    async function onPoolDiscovered(poolPubkey: Uint8Array, pool: PoolState, slot: number): Promise<void> {
        // Phase 2: Queue if topologyOracle isn't ready yet (during startSlot wait)
        if (!topologyOracleReady) {
            // Subscribe vaults immediately (no oracle needed)
            subscribeVaults(pool);
            // Queue for later processing
            pendingPoolDiscoveries.push({ poolPubkey, pool, slot });
            return;
        }

        // Phase 2: Ensure topologyOracle is initialized
        if (!topologyOracle) {
            console.error('[phase3] FATAL: onPoolDiscovered called with topologyOracleReady=true but oracle is null');
            return;
        }

        // Subscribe vaults via gRPC for real-time updates (no RPC, instant)
        subscribeVaults(pool);

        // Wait for RPC slot (concurrency limited to MAX_CONCURRENT_RPC)
        await acquireRpcSlot();

        try {
            // Fetch tick/bin arrays, ammConfig, AND vaults via ONE RPC call, then freeze/activate
            const result = await fetchPoolDeps(poolPubkey, pool, slot, rpcEndpoint, registry, topologyOracle, deriveConfig);

            // Aggregate bootstrap stats
            tickArraysFetched += result.tickArraysFetched;
            binArraysFetched += result.binArraysFetched;
            if (result.ammConfigFetched) ammConfigsFetched++;
            vaultsFetched += result.vaultsFetched;

            if (result.activated) {
                activationSuccesses++;
            }
            activationAttempts++;
        } finally {
            // Always release slot, even on error
            releaseRpcSlot();
        }
    }

    /**
     * Try to activate after gRPC delivers a dependency
     */
    function tryActivatePool(poolPubkey: Uint8Array, slot: number): void {
        // Phase 2: Ensure topologyOracle is initialized
        if (!topologyOracle) return;

        const state = lifecycle.getState(poolPubkey);
        if (state === PoolLifecycleState.TOPOLOGY_FROZEN) {
            activationAttempts++;
            const result = topologyOracle.tryActivate(poolPubkey, slot);
            if (result.activated) {
                activationSuccesses++;
            }
        }
    }

    /**
     * Check if pool is approaching boundary and trigger refresh if needed
     */
    function checkAndRefresh(poolPubkey: Uint8Array, pool: PoolState, slot: number): void {
        // Only check ACTIVE pools (CLMM/DLMM only)
        const state = lifecycle.getState(poolPubkey);
        if (state !== PoolLifecycleState.ACTIVE) return;

        // Get frozen topology
        const topology = lifecycle.getTopology(poolPubkey);
        if (!topology) return;

        // Check boundary
        const boundaryResult = checkPoolBoundary(pool, topology, boundaryConfig);
        if (!boundaryResult || !boundaryResult.needsRefresh) return;

        // Trigger refresh
        const reason = formatBoundaryReason(boundaryResult);
        const started = lifecycle.startRefresh(poolPubkey, slot, reason, refreshIntervalMs);
        if (started) {
            refreshTriggered++;
            DEBUG && console.log(`[phase3] Refresh triggered for pool: ${reason}`);

            // Perform refresh (same as initial bootstrap but with REFRESHING state)
            void refreshTopology(poolPubkey, pool, slot);
        }
    }

    /**
     * Refresh topology - re-bootstrap around new position
     * Uses concurrency limiter to prevent event loop stall
     */
    async function refreshTopology(poolPubkey: Uint8Array, pool: PoolState, slot: number): Promise<void> {
        // Phase 2: Ensure topologyOracle is initialized
        if (!topologyOracle) return;

        // Wait for RPC slot (concurrency limited to MAX_CONCURRENT_RPC)
        await acquireRpcSlot();

        try {
            // Fetch new window around current position
            const result = await fetchPoolDeps(poolPubkey, pool, slot, rpcEndpoint, registry, topologyOracle, deriveConfig);

            // Aggregate stats
            tickArraysFetched += result.tickArraysFetched;
            binArraysFetched += result.binArraysFetched;
            if (result.ammConfigFetched) ammConfigsFetched++;
            vaultsFetched += result.vaultsFetched;

            if (result.activated) {
                refreshCompleted++;
            }
        } catch (err) {
            console.error(`[phase3] Refresh failed:`, err);
        } finally {
            // Always release slot, even on error
            releaseRpcSlot();
        }
    }

    function handle(event: IngestEvent): void {
        if (event.type !== 'account') return;

        const update = event.update;
        const owner = update.owner;

        // Route by owner program
        if (bytesEqual(owner, RAYDIUM_CLMM_BYTES)) {
            handleClmmAccount(update);
        } else if (bytesEqual(owner, METEORA_DLMM_BYTES)) {
            handleDlmmAccount(update);
        } else if (isTargetProgram(owner)) {
            handlePoolAccount(update);
        } else if (bytesEqual(owner, SPL_TOKEN_BYTES) || bytesEqual(owner, SPL_TOKEN_2022_BYTES)) {
            handleTokenAccount(update);
        }
    }

    function handlePoolAccount(update: AccountUpdate): void {
        // Special case: GlobalConfig singleton (PumpSwap fees)
        // GlobalConfig is owned by PumpSwap program but is NOT a pool
        if (bytesEqual(update.pubkey, PUMPSWAP_GLOBAL_CONFIG_PUBKEY)) {
            try {
                const config = decodePumpSwapGlobalConfig(update.data);
                commitAccountUpdate(registry, {
                    type: 'globalConfig',
                    config,
                    slot: update.slot,
                    writeVersion: update.writeVersion,
                    dataLength: update.data.length,
                    source: 'grpc',
                });
            } catch {
                // GlobalConfig decode failed, ignore
            }
            return;
        }

        const result = decodeAccount(update);
        if (result.success && result.pool) {
            // Check if this is a newly discovered pool (before calling discover)
            const existingState = lifecycle.getState(update.pubkey);
            const isNew = existingState === null;

            // Register pool discovery with lifecycle (enables RPC for dependencies)
            // This is idempotent - no-op if already discovered
            if (isNew) {
                lifecycle.discover(update.pubkey, update.slot);
            }

            // Use canonical commit function (always commit pool state updates)
            commitAccountUpdate(registry, {
                type: 'pool',
                pubkey: update.pubkey,
                state: result.pool,
                slot: update.slot,
                writeVersion: update.writeVersion,
                dataLength: update.data.length,
                source: 'grpc',
            });
            poolUpdates++;

            // Only trigger onPoolDiscovered for NEW pools
            // This prevents repeat RPC bootstrap on every pool update
            // Claim any orphaned tick arrays BEFORE RPC bootstrap
            const orphanedTicks = orphanBuffer.claimTickArrays(update.pubkey);
            for (const orphan of orphanedTicks) {
                commitAccountUpdate(registry, {
                    type: 'tick',
                    poolPubkey: orphan.array.poolId,
                    startTickIndex: orphan.array.startTickIndex,
                    tickAccountPubkey: orphan.tickAccountPubkey,
                    array: orphan.array,
                    slot: orphan.slot,
                    writeVersion: orphan.writeVersion,
                    dataLength: orphan.dataLength,
                    source: 'grpc',
                });
            }

            if (isNew) {
                void onPoolDiscovered(update.pubkey, result.pool, update.slot);
            } else {
                // For existing pools, check if approaching boundary
                checkAndRefresh(update.pubkey, result.pool, update.slot);
            }
        }
    }

    function handleClmmAccount(update: AccountUpdate): void {
        // Try tick array first (more common updates)
        if (isTickArray(update.data)) {
            const decoded = decodeTickArray(update.data);
            if (decoded) {
                // Track slot for health monitoring
                healthMonitor.updateSlot(update.slot);

                // Check if pool is known
                const poolState = lifecycle.getState(decoded.poolId);
                if (poolState === null) {
                    // Pool not yet known - buffer for later claim
                    orphanBuffer.addTickArray(
                        update.pubkey,
                        { poolId: decoded.poolId, startTickIndex: decoded.startTickIndex, ticks: decoded.ticks },
                        update.slot,
                        update.writeVersion,
                        update.data.length
                    );
                    return;
                }

                const tickArray: TickArray = {
                    poolId: decoded.poolId,
                    startTickIndex: decoded.startTickIndex,
                    ticks: decoded.ticks,
                };
                // Use canonical commit function
                const result = commitAccountUpdate(registry, {
                    type: 'tick',
                    poolPubkey: tickArray.poolId,
                    startTickIndex: tickArray.startTickIndex,
                    tickAccountPubkey: update.pubkey,
                    array: tickArray,
                    slot: update.slot,
                    writeVersion: update.writeVersion,
                    dataLength: update.data.length,
                    source: 'grpc',
                });
                tickArrayUpdates++;

                // Event-driven activation: tick array arrived, try to activate pool
                if (result.updated) {
                    tryActivatePool(tickArray.poolId, update.slot);
                }

                // Log first few tick array ingestions for verification (DEBUG only)
                if (DEBUG && tickArrayUpdates <= 3n) {
                    const poolHex = toHex(decoded.poolId).slice(0, 16);
                    console.log(`[phase3] Tick array ingested via gRPC: pool=${poolHex}... startIdx=${decoded.startTickIndex} slot=${update.slot}`);
                }
            }
            return;
        }

        // Otherwise try pool decode
        const result = decodeAccount(update);
        if (result.success && result.pool) {
            const pool = result.pool as RaydiumClmmPool;

            // Check if this is a newly discovered pool (before calling discover)
            const existingState = lifecycle.getState(update.pubkey);
            const isNew = existingState === null;

            // Register pool discovery with lifecycle (idempotent)
            if (isNew) {
                lifecycle.discover(update.pubkey, update.slot);
            }

            // Use canonical commit function (always commit pool state updates)
            commitAccountUpdate(registry, {
                type: 'pool',
                pubkey: update.pubkey,
                state: pool,
                slot: update.slot,
                writeVersion: update.writeVersion,
                dataLength: update.data.length,
                source: 'grpc',
            });
            poolUpdates++;

            // Only trigger onPoolDiscovered for NEW pools
            if (isNew) {
                // Claim any orphaned tick arrays BEFORE RPC bootstrap
                const orphanedTicks = orphanBuffer.claimTickArrays(update.pubkey);
                for (const orphan of orphanedTicks) {
                    commitAccountUpdate(registry, {
                        type: 'tick',
                        poolPubkey: orphan.array.poolId,
                        startTickIndex: orphan.array.startTickIndex,
                        tickAccountPubkey: orphan.tickAccountPubkey,
                        array: orphan.array,
                        slot: orphan.slot,
                        writeVersion: orphan.writeVersion,
                        dataLength: orphan.dataLength,
                        source: 'grpc',
                    });
                }

                void onPoolDiscovered(update.pubkey, pool, update.slot);
            } else {
                // For existing pools, check if approaching boundary
                checkAndRefresh(update.pubkey, pool, update.slot);
            }
        }
    }

    function handleDlmmAccount(update: AccountUpdate): void {
        // Try bin array first (more common updates)
        if (isBinArray(update.data)) {
            const decoded = decodeBinArray(update.data);
            if (decoded) {
                // Track slot for health monitoring
                healthMonitor.updateSlot(update.slot);

                // Check if pool is known
                const poolState = lifecycle.getState(decoded.lbPair);
                if (poolState === null) {
                    // Pool not yet known - buffer for later claim
                    orphanBuffer.addBinArray(
                        update.pubkey,
                        { lbPair: decoded.lbPair, index: decoded.index, startBinId: decoded.startBinId, bins: decoded.bins },
                        update.slot,
                        update.writeVersion,
                        update.data.length
                    );
                    return;
                }

                const binArray: BinArray = {
                    lbPair: decoded.lbPair,
                    index: decoded.index,
                    startBinId: decoded.startBinId,
                    bins: decoded.bins,
                };
                // Use canonical commit function
                const result = commitAccountUpdate(registry, {
                    type: 'bin',
                    poolPubkey: binArray.lbPair,
                    binArrayIndex: Number(binArray.index),
                    binAccountPubkey: update.pubkey,
                    array: binArray,
                    slot: update.slot,
                    writeVersion: update.writeVersion,
                    dataLength: update.data.length,
                    source: 'grpc',
                });
                binArrayUpdates++;

                // Event-driven activation: bin array arrived, try to activate pool
                if (result.updated) {
                    tryActivatePool(binArray.lbPair, update.slot);
                }
            }
            return;
        }

        // Otherwise try pool decode
        const result = decodeAccount(update);
        if (result.success && result.pool) {
            const pool = result.pool as MeteoraDlmmPool;

            // Check if this is a newly discovered pool (before calling discover)
            const existingState = lifecycle.getState(update.pubkey);
            const isNew = existingState === null;

            // Register pool discovery with lifecycle (idempotent)
            if (isNew) {
                lifecycle.discover(update.pubkey, update.slot);
            }

            // Use canonical commit function (always commit pool state updates)
            commitAccountUpdate(registry, {
                type: 'pool',
                pubkey: update.pubkey,
                state: pool,
                slot: update.slot,
                writeVersion: update.writeVersion,
                dataLength: update.data.length,
                source: 'grpc',
            });
            poolUpdates++;

            // Only trigger onPoolDiscovered for NEW pools
            if (isNew) {
                // Claim any orphaned bin arrays BEFORE RPC bootstrap
                const orphanedBins = orphanBuffer.claimBinArrays(update.pubkey);
                for (const orphan of orphanedBins) {
                    commitAccountUpdate(registry, {
                        type: 'bin',
                        poolPubkey: orphan.array.lbPair,
                        binArrayIndex: Number(orphan.array.index),
                        binAccountPubkey: orphan.binAccountPubkey,
                        array: orphan.array,
                        slot: orphan.slot,
                        writeVersion: orphan.writeVersion,
                        dataLength: orphan.dataLength,
                        source: 'grpc',
                    });
                }

                void onPoolDiscovered(update.pubkey, pool, update.slot);
            } else {
                // For existing pools, check if approaching boundary
                checkAndRefresh(update.pubkey, pool, update.slot);
            }
        }
    }

    function handleTokenAccount(update: AccountUpdate): void {
        const pubkeyHex = toHex(update.pubkey);

        // Only decode if this is a tracked vault
        if (trackedVaults.has(pubkeyHex)) {
            const amount = decodeTokenAccountAmount(update.data);
            if (amount !== null) {
                // Use canonical commit function
                const result = commitAccountUpdate(registry, {
                    type: 'vault',
                    pubkey: update.pubkey,
                    amount,
                    slot: update.slot,
                    writeVersion: update.writeVersion,
                    dataLength: update.data.length,
                    source: 'grpc',
                });
                vaultUpdates++;

                // Try activation if vault was updated
                // This allows pools stuck at TOPOLOGY_FROZEN (waiting for vault) to activate
                if (result.updated) {
                    const ownerPool = lifecycle.getPoolForVault(update.pubkey);
                    if (ownerPool) {
                        tryActivatePool(ownerPool, update.slot);
                    }
                }
            }
        }
    }

    /**
     * Subscribe vaults for a pool via gRPC
     */
    function subscribeVaults(pool: PoolState): void {
        if (!grpcConsumer) return;

        let vaults: Uint8Array[] = [];
        switch (pool.venue) {
            case VenueId.PumpSwap:
                vaults = [pool.baseVault, pool.quoteVault];
                break;
            case VenueId.RaydiumV4:
                vaults = [pool.baseVault, pool.quoteVault];
                break;
            case VenueId.RaydiumClmm: {
                const clmm = pool as RaydiumClmmPool;
                vaults = [clmm.tokenVault0, clmm.tokenVault1];
                break;
            }
            case VenueId.MeteoraDlmm: {
                const dlmm = pool as MeteoraDlmmPool;
                vaults = [dlmm.vaultX, dlmm.vaultY];
                break;
            }
        }

        for (const vault of vaults) {
            trackedVaults.add(toHex(vault));
        }
        grpcConsumer.subscribeVaults(vaults);
    }

    function getStats(): Phase3Stats {
        const lifecycleStats = lifecycle.stats();
        const orphanStats = orphanBuffer.stats();
        const health = healthMonitor.check();

        return {
            poolCacheSize: poolCache.stats().size,
            vaultCacheSize: vaultCache.stats().size,
            tickCacheSize: tickCache.stats().size,
            binCacheSize: binCache.stats().size,
            poolUpdates,
            vaultUpdates,
            tickArrayUpdates,
            binArrayUpdates,
            lifecycleDiscovered: lifecycleStats.discovered,
            lifecycleFrozen: lifecycleStats.frozen,
            lifecycleActive: lifecycleStats.active,
            lifecycleIncomplete: lifecycleStats.incomplete,
            activationAttempts,
            activationSuccesses,
            tickArraysFetched,
            binArraysFetched,
            ammConfigsFetched,
            vaultsFetched,
            lifecycleRefreshing: lifecycleStats.refreshing,
            refreshTriggered,
            refreshCompleted,
            // Orphan buffer stats
            orphanBufferSize: orphanStats.currentOrphans,
            orphanTicksClaimed: orphanStats.ticksClaimed,
            orphanBinsClaimed: orphanStats.binsClaimed,
            orphanReclaimRate: orphanStats.reclaimRate,
            // Health monitoring
            cacheHealthy: health.healthy,
        };
    }

    /**
     * Start the handler - connects gRPC, then ready.
     * This is the main entry point for production use.
     *
     * Phase 2: Captures startSlot snapshot for convergence validation
     */
    async function start(): Promise<void> {
        // Start gRPC FIRST - begin receiving real-time updates
        if (grpcConsumer) {
            await grpcConsumer.start();
            console.log('[phase3] gRPC started - receiving real-time updates');

            // Phase 2 PRE-FLIGHT: Wait for and validate startSlot
            // The slot is captured from the first gRPC response, so we may need to wait
            const maxWaitMs = 10000;  // 10 second timeout
            const pollIntervalMs = 100;
            let waited = 0;
            while (waited < maxWaitMs) {
                grpcSubscriptionStartSlot = grpcConsumer.getGrpcSubscriptionStartSlot();
                if (grpcSubscriptionStartSlot !== null) break;
                await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
                waited += pollIntervalMs;
            }

            if (grpcSubscriptionStartSlot === null) {
                console.error('[FATAL] gRPC subscription failed - no slot captured within 10s');
                console.error('[FATAL] Cannot proceed without startSlot for convergence validation');
                process.exit(1);
            }
            console.log(`[phase3] gRPC subscription start slot captured: ${grpcSubscriptionStartSlot} (waited ${waited}ms)`);

            // Phase 2: Create TopologyOracle with immutable startSlot snapshot
            topologyOracle = createTopologyOracle(registry, deriveConfig, grpcSubscriptionStartSlot);
            topologyOracleReady = true;
            console.log('[phase3] TopologyOracle created with startSlot for convergence validation');

            // Phase 2: Process queued pool discoveries
            if (pendingPoolDiscoveries.length > 0) {
                console.log(`[phase3] Processing ${pendingPoolDiscoveries.length} queued pool discoveries`);
                for (const { poolPubkey, pool, slot } of pendingPoolDiscoveries) {
                    void onPoolDiscovered(poolPubkey, pool, slot);
                }
                pendingPoolDiscoveries.length = 0;  // Clear queue
            }
        } else {
            // No gRPC consumer - create TopologyOracle without convergence (legacy mode)
            console.warn('[phase3] WARNING: No gRPC consumer - convergence validation disabled');
            topologyOracle = createTopologyOracle(registry, deriveConfig, null);
            topologyOracleReady = true;
        }
    }

    // Create handler object - topologyOracle will be set in start()
    const handler: Phase3Handler = {
        registry,
        poolCache,
        vaultCache,
        tickCache,
        binCache,
        ammConfigCache,
        topologyOracle: null as unknown as TopologyOracleImpl,  // Set in start()
        handle,
        getStats,
        start: async () => {
            await start();
            // Update handler.topologyOracle after start() creates it
            handler.topologyOracle = topologyOracle!;
        },
    };

    return handler;
}

/**
 * Reset Phase 3 metrics (for validation scripts)
 */
export function resetPhase3Metrics(): void {
    // Metrics are per-handler instance, no global state to reset
}