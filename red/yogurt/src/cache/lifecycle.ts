/**
 * Pool Lifecycle State Machine
 *
 * Enforces the core invariant: RPC AFTER ACTIVATION IS FORBIDDEN (except during refresh).
 *
 * State transitions:
 *   DISCOVERED → TOPOLOGY_FROZEN → ACTIVE
 *                                     ↓
 *                              [boundary crossed]
 *                                     ↓
 *                               REFRESHING → TOPOLOGY_FROZEN → ACTIVE
 *
 * Rules:
 *   - RPC writes allowed ONLY in DISCOVERED or REFRESHING state
 *   - Once TOPOLOGY_FROZEN, pool topology is immutable from RPC
 *   - gRPC can update in any state (canonical source)
 *   - If topology incomplete at freeze → pool never becomes ACTIVE
 *   - REFRESHING is triggered when price approaches frozen window boundary
 *   - Each freeze creates a new "epoch" for the pool
 *
 * If it's not in DISCOVERED or REFRESHING state, RPC cannot touch it.
 */

// ============================================================================
// LIFECYCLE EVENT TYPES
// ============================================================================

/**
 * Lifecycle event emitted on state transitions
 * Used by capture-evidence.ts to record topology lifecycle for validation
 */
export interface LifecycleEvent {
    /** Pool this event relates to */
    poolPubkey: Uint8Array;
    /** Slot when event occurred */
    slot: number;
    /** Type of lifecycle transition */
    type: 'discover' | 'freeze' | 'activate' | 'incomplete' | 'refresh_start' | 'deactivate';
    /** State before transition (null for discover) */
    prevState: PoolLifecycleState | null;
    /** State after transition */
    newState: PoolLifecycleState;
    /** Frozen topology (only present on freeze events) */
    topology?: FrozenTopology;
    /** Reason for incomplete or refresh (only present on incomplete/refresh events) */
    reason?: string;
    /** Epoch number (increments on each freeze) */
    epoch?: number;
}

/**
 * Handler function for lifecycle events
 */
export type LifecycleEventHandler = (event: LifecycleEvent) => void;

// ============================================================================
// LIFECYCLE STATE ENUM
// ============================================================================

/**
 * Pool lifecycle states
 *
 * DISCOVERED:
 *   - Pool just seen via gRPC
 *   - RPC bootstrap allowed to fetch dependencies
 *   - Topology not yet frozen
 *
 * TOPOLOGY_FROZEN:
 *   - TopologyOracle has run
 *   - All required dependencies identified
 *   - RPC paths DISABLED for this pool
 *   - gRPC still updates canonical state
 *
 * ACTIVE:
 *   - Topology complete
 *   - Ready for simulation
 *   - Only gRPC updates allowed
 *
 * REFRESHING:
 *   - Price approached frozen window boundary
 *   - RPC bootstrap allowed to fetch new window
 *   - Will transition to TOPOLOGY_FROZEN → ACTIVE when complete
 */
export enum PoolLifecycleState {
    DISCOVERED = 'DISCOVERED',
    TOPOLOGY_FROZEN = 'TOPOLOGY_FROZEN',
    ACTIVE = 'ACTIVE',
    REFRESHING = 'REFRESHING',
}

// ============================================================================
// FROZEN TOPOLOGY
// ============================================================================

/**
 * Captured topology at freeze time
 *
 * This is the EXACT set of dependencies that must exist for simulation.
 * Once frozen, this set is immutable.
 */
export interface FrozenTopology {
    /** Pool pubkey this topology belongs to */
    poolPubkey: Uint8Array;

    /** Venue for routing */
    venue: number;

    /** Base and quote vault pubkeys */
    vaults: {
        base: Uint8Array;
        quote: Uint8Array;
    };

    /**
     * CLMM: Required tick array start indexes
     * Empty for non-CLMM venues
     */
    requiredTickArrays: number[];

    /**
     * DLMM: Required bin array indexes
     * Empty for non-DLMM venues
     */
    requiredBinArrays: number[];

    /**
     * CLMM: AmmConfig pubkey for fee rate
     * Null for non-CLMM venues
     */
    ammConfigPubkey: Uint8Array | null;

    /** Slot when topology was frozen */
    frozenAtSlot: number;

    /** Timestamp when frozen */
    frozenAtMs: number;
}

// ============================================================================
// LIFECYCLE ENTRY
// ============================================================================

/**
 * Per-pool lifecycle tracking
 */
export interface PoolLifecycleEntry {
    /** Current lifecycle state */
    state: PoolLifecycleState;

    /** When pool was discovered */
    discoveredAtSlot: number;
    discoveredAtMs: number;

    /** Frozen topology (only if state >= TOPOLOGY_FROZEN) */
    topology: FrozenTopology | null;

    /** When topology was frozen (only if state >= TOPOLOGY_FROZEN) */
    frozenAtSlot: number | null;
    frozenAtMs: number | null;

    /** When pool became active (only if state === ACTIVE) */
    activatedAtSlot: number | null;
    activatedAtMs: number | null;

    /** If frozen but never activated, this explains why */
    incompleteReason: string | null;

    /** Epoch number - increments on each freeze (0 = first freeze) */
    epoch: number;

    /** Last refresh timestamp (for rate limiting) */
    lastRefreshAtMs: number | null;
}

// ============================================================================
// LIFECYCLE REGISTRY
// ============================================================================

/**
 * Convert pubkey to hex key for Map storage
 */
function toKey(pubkey: Uint8Array): string {
    let key = '';
    for (let i = 0; i < 32; i++) {
        key += pubkey[i].toString(16).padStart(2, '0');
    }
    return key;
}

/**
 * Lifecycle registry - tracks state per pool
 */
export class LifecycleRegistry {
    private entries: Map<string, PoolLifecycleEntry> = new Map();
    private eventHandler?: LifecycleEventHandler;

    /**
     * Reverse mappings for dependency blocking (B7 hardening)
     * These map dependency pubkeys back to their pool, so we can block
     * bootstrap writes for vaults/ammConfig after their pool is frozen.
     */
    private vaultToPool: Map<string, string> = new Map();
    private ammConfigToPool: Map<string, string> = new Map();

    /**
     * Set event handler for lifecycle transitions
     * Used by capture-evidence.ts to record topology lifecycle
     */
    setEventHandler(handler: LifecycleEventHandler): void {
        this.eventHandler = handler;
    }

    /**
     * Emit lifecycle event if handler is registered
     */
    private emit(event: LifecycleEvent): void {
        if (this.eventHandler) {
            try {
                this.eventHandler(event);
            } catch (err) {
                // Don't let handler errors break lifecycle operations
                console.error('[lifecycle] Event handler error:', err);
            }
        }
    }

    /**
     * Register a newly discovered pool
     * Called when pool first enters the system via gRPC
     */
    discover(poolPubkey: Uint8Array, slot: number): void {
        const key = toKey(poolPubkey);

        // Don't re-discover already known pools
        if (this.entries.has(key)) {
            return;
        }

        this.entries.set(key, {
            state: PoolLifecycleState.DISCOVERED,
            discoveredAtSlot: slot,
            discoveredAtMs: Date.now(),
            topology: null,
            frozenAtSlot: null,
            frozenAtMs: null,
            activatedAtSlot: null,
            activatedAtMs: null,
            incompleteReason: null,
            epoch: 0,
            lastRefreshAtMs: null,
        });

        // Emit discover event
        this.emit({
            poolPubkey,
            slot,
            type: 'discover',
            prevState: null,
            newState: PoolLifecycleState.DISCOVERED,
            epoch: 0,
        });
    }

    /**
     * Freeze pool topology
     * Called by TopologyOracle when dependencies are identified
     *
     * After this call, RPC is FORBIDDEN for this pool.
     * Can be called from DISCOVERED (initial) or REFRESHING (epoch transition).
     */
    freezeTopology(poolPubkey: Uint8Array, topology: FrozenTopology, slot: number): boolean {
        const key = toKey(poolPubkey);
        const entry = this.entries.get(key);

        if (!entry) {
            // Pool not discovered yet - cannot freeze
            return false;
        }

        // Allow freeze from DISCOVERED (initial) or REFRESHING (epoch transition)
        if (entry.state !== PoolLifecycleState.DISCOVERED &&
            entry.state !== PoolLifecycleState.REFRESHING) {
            // Already frozen or active - no-op
            return false;
        }

        const prevState = entry.state;
        const isRefresh = prevState === PoolLifecycleState.REFRESHING;

        // Increment epoch on refresh, keep at 0 for initial freeze
        if (isRefresh) {
            entry.epoch++;
        }

        entry.state = PoolLifecycleState.TOPOLOGY_FROZEN;
        entry.topology = topology;
        entry.frozenAtSlot = slot;
        entry.frozenAtMs = Date.now();
        entry.incompleteReason = null; // Clear any previous incomplete reason

        // B7: Populate reverse mappings for dependency blocking
        // Map vaults back to this pool
        if (topology.vaults.base.length === 32) {
            this.vaultToPool.set(toKey(topology.vaults.base), key);
        }
        if (topology.vaults.quote.length === 32) {
            this.vaultToPool.set(toKey(topology.vaults.quote), key);
        }
        // Map ammConfig back to this pool (CLMM only)
        if (topology.ammConfigPubkey && topology.ammConfigPubkey.length === 32) {
            this.ammConfigToPool.set(toKey(topology.ammConfigPubkey), key);
        }

        // Emit freeze event with topology snapshot
        this.emit({
            poolPubkey,
            slot,
            type: 'freeze',
            prevState,
            newState: PoolLifecycleState.TOPOLOGY_FROZEN,
            topology,
            epoch: entry.epoch,
        });

        return true;
    }

    /**
     * Activate pool for simulation
     * Called when all frozen topology dependencies are present
     */
    activate(poolPubkey: Uint8Array, slot: number): boolean {
        const key = toKey(poolPubkey);
        const entry = this.entries.get(key);

        if (!entry) {
            return false;
        }

        if (entry.state !== PoolLifecycleState.TOPOLOGY_FROZEN) {
            // Must be frozen before activation
            return false;
        }

        entry.state = PoolLifecycleState.ACTIVE;
        entry.activatedAtSlot = slot;
        entry.activatedAtMs = Date.now();

        // Emit activate event
        this.emit({
            poolPubkey,
            slot,
            type: 'activate',
            prevState: PoolLifecycleState.TOPOLOGY_FROZEN,
            newState: PoolLifecycleState.ACTIVE,
        });

        return true;
    }

    /**
     * Mark pool as incomplete (frozen but will never activate)
     */
    markIncomplete(poolPubkey: Uint8Array, reason: string, slot?: number): void {
        const key = toKey(poolPubkey);
        const entry = this.entries.get(key);

        if (entry && entry.state === PoolLifecycleState.TOPOLOGY_FROZEN) {
            entry.incompleteReason = reason;

            // Emit incomplete event
            this.emit({
                poolPubkey,
                slot: slot ?? entry.frozenAtSlot ?? 0,
                type: 'incomplete',
                prevState: PoolLifecycleState.TOPOLOGY_FROZEN,
                newState: PoolLifecycleState.TOPOLOGY_FROZEN, // State doesn't change, just marked
                reason,
            });
        }
    }

    /**
     * Start topology refresh (ACTIVE → REFRESHING)
     * Called when price approaches frozen window boundary
     *
     * @param poolPubkey - Pool to refresh
     * @param slot - Current slot
     * @param reason - Why refresh is being triggered
     * @param minIntervalMs - Minimum time between refreshes (rate limiting)
     * @returns true if refresh started, false if not allowed or rate limited
     */
    startRefresh(
        poolPubkey: Uint8Array,
        slot: number,
        reason: string,
        minIntervalMs: number = 5000
    ): boolean {
        const key = toKey(poolPubkey);
        const entry = this.entries.get(key);

        if (!entry) {
            return false;
        }

        // Can only refresh from ACTIVE state
        if (entry.state !== PoolLifecycleState.ACTIVE) {
            return false;
        }

        // Rate limiting: check if we refreshed recently
        const now = Date.now();
        if (entry.lastRefreshAtMs && (now - entry.lastRefreshAtMs) < minIntervalMs) {
            return false;
        }

        // Transition to REFRESHING
        entry.state = PoolLifecycleState.REFRESHING;
        entry.lastRefreshAtMs = now;

        // Emit refresh_start event
        this.emit({
            poolPubkey,
            slot,
            type: 'refresh_start',
            prevState: PoolLifecycleState.ACTIVE,
            newState: PoolLifecycleState.REFRESHING,
            reason,
            epoch: entry.epoch + 1, // Next epoch number
        });

        return true;
    }

    /**
     * Abort refresh and return to ACTIVE state
     * Called when RPC fails during refresh - keeps the old frozen topology/epoch
     *
     * This prevents pools from being stranded in REFRESHING state when:
     * - RPC is down
     * - RPC returns errors
     * - Network timeout occurs
     *
     * The pool returns to ACTIVE with its existing frozen topology intact.
     *
     * @param poolPubkey - Pool to abort refresh for
     * @param slot - Current slot (for logging, not state change)
     * @returns true if abort succeeded, false if pool wasn't in REFRESHING state
     */
    abortRefresh(poolPubkey: Uint8Array, slot: number): boolean {
        const key = toKey(poolPubkey);
        const entry = this.entries.get(key);

        if (!entry) {
            return false;
        }

        // Can only abort from REFRESHING state
        if (entry.state !== PoolLifecycleState.REFRESHING) {
            return false;
        }

        // Return to ACTIVE with existing topology
        entry.state = PoolLifecycleState.ACTIVE;

        return true;
    }

    /**
     * Phase 3: Deactivate pool (ACTIVE/TOPOLOGY_FROZEN → DISCOVERED)
     *
     * Called when memory pressure requires evicting ACTIVE pool dependencies.
     * Clears frozen topology and reverse mappings, allowing re-bootstrap.
     *
     * Operations:
     * 1. Validate state is ACTIVE or TOPOLOGY_FROZEN
     * 2. Clear reverse mappings (vaultToPool, ammConfigToPool)
     * 3. Reset entry fields (topology, timestamps, incompleteReason)
     * 4. Emit 'deactivate' lifecycle event
     *
     * @param poolPubkey - Pool to deactivate
     * @param slot - Current slot for event emission
     * @param reason - Optional reason for deactivation (e.g., "memory_pressure")
     * @returns true if deactivated, false if pool not in valid state
     */
    deactivate(poolPubkey: Uint8Array, slot: number, reason?: string): boolean {
        const key = toKey(poolPubkey);
        const entry = this.entries.get(key);

        if (!entry) {
            return false;
        }

        // Can only deactivate from ACTIVE or TOPOLOGY_FROZEN state
        const prevState = entry.state;
        if (prevState !== PoolLifecycleState.ACTIVE &&
            prevState !== PoolLifecycleState.TOPOLOGY_FROZEN) {
            return false;
        }

        // Clear reverse mappings for this pool's dependencies
        if (entry.topology) {
            const topology = entry.topology;

            // Remove vault mappings
            if (topology.vaults.base.length === 32) {
                this.vaultToPool.delete(toKey(topology.vaults.base));
            }
            if (topology.vaults.quote.length === 32) {
                this.vaultToPool.delete(toKey(topology.vaults.quote));
            }

            // Remove ammConfig mapping (CLMM only)
            if (topology.ammConfigPubkey && topology.ammConfigPubkey.length === 32) {
                this.ammConfigToPool.delete(toKey(topology.ammConfigPubkey));
            }
        }

        // Reset entry to DISCOVERED state
        entry.state = PoolLifecycleState.DISCOVERED;
        entry.topology = null;
        entry.frozenAtSlot = null;
        entry.frozenAtMs = null;
        entry.activatedAtSlot = null;
        entry.activatedAtMs = null;
        entry.incompleteReason = reason || null;
        entry.lastRefreshAtMs = null;
        // Keep epoch for historical tracking

        // Emit deactivate event
        this.emit({
            poolPubkey,
            slot,
            type: 'deactivate',
            prevState,
            newState: PoolLifecycleState.DISCOVERED,
            reason,
            epoch: entry.epoch,
        });

        return true;
    }

    /**
     * Get lifecycle entry for a pool
     */
    get(poolPubkey: Uint8Array): PoolLifecycleEntry | null {
        return this.entries.get(toKey(poolPubkey)) ?? null;
    }

    /**
     * Get current state for a pool
     */
    getState(poolPubkey: Uint8Array): PoolLifecycleState | null {
        const entry = this.entries.get(toKey(poolPubkey));
        return entry?.state ?? null;
    }

    /**
     * Check if RPC writes are allowed for this pool
     *
     * RPC is allowed in DISCOVERED or REFRESHING state.
     * Once frozen or active, RPC paths are disabled.
     */
    isRpcAllowed(poolPubkey: Uint8Array): boolean {
        const entry = this.entries.get(toKey(poolPubkey));

        // Unknown pool - allow RPC (will be discovered soon)
        if (!entry) {
            return true;
        }

        // DISCOVERED or REFRESHING allows RPC
        return entry.state === PoolLifecycleState.DISCOVERED ||
               entry.state === PoolLifecycleState.REFRESHING;
    }

    /**
     * Check if RPC writes are allowed for a vault pubkey (B7 hardening)
     *
     * Returns false if the vault belongs to a frozen/active pool.
     * Returns true if the vault is unknown or belongs to a DISCOVERED/REFRESHING pool.
     */
    isRpcAllowedForVault(vaultPubkey: Uint8Array): boolean {
        const vaultKey = toKey(vaultPubkey);
        const poolKey = this.vaultToPool.get(vaultKey);

        if (!poolKey) {
            // Unknown vault - allow RPC
            return true;
        }

        const entry = this.entries.get(poolKey);
        if (!entry) {
            return true;
        }

        // DISCOVERED or REFRESHING allows RPC
        return entry.state === PoolLifecycleState.DISCOVERED ||
               entry.state === PoolLifecycleState.REFRESHING;
    }

    /**
     * Check if RPC writes are allowed for an ammConfig pubkey (B7 hardening)
     *
     * Returns false if the ammConfig belongs to a frozen/active pool.
     * Returns true if the ammConfig is unknown or belongs to a DISCOVERED/REFRESHING pool.
     */
    isRpcAllowedForAmmConfig(ammConfigPubkey: Uint8Array): boolean {
        const configKey = toKey(ammConfigPubkey);
        const poolKey = this.ammConfigToPool.get(configKey);

        if (!poolKey) {
            // Unknown ammConfig - allow RPC
            return true;
        }

        const entry = this.entries.get(poolKey);
        if (!entry) {
            return true;
        }

        // DISCOVERED or REFRESHING allows RPC
        return entry.state === PoolLifecycleState.DISCOVERED ||
               entry.state === PoolLifecycleState.REFRESHING;
    }

    /**
     * Get the pool pubkey that a vault belongs to (for debugging/proofs)
     */
    getPoolForVault(vaultPubkey: Uint8Array): Uint8Array | null {
        const vaultKey = toKey(vaultPubkey);
        const poolKey = this.vaultToPool.get(vaultKey);
        if (!poolKey) return null;

        // Convert hex key back to Uint8Array
        const bytes = new Uint8Array(32);
        for (let i = 0; i < 32; i++) {
            bytes[i] = parseInt(poolKey.slice(i * 2, i * 2 + 2), 16);
        }
        return bytes;
    }

    /**
     * Check if pool is active (ready for simulation)
     */
    isActive(poolPubkey: Uint8Array): boolean {
        const entry = this.entries.get(toKey(poolPubkey));
        return entry?.state === PoolLifecycleState.ACTIVE;
    }

    /**
     * Check if pool is frozen (topology captured)
     */
    isFrozen(poolPubkey: Uint8Array): boolean {
        const state = this.getState(poolPubkey);
        return state === PoolLifecycleState.TOPOLOGY_FROZEN ||
               state === PoolLifecycleState.ACTIVE;
    }

    /**
     * Get frozen topology for a pool
     */
    getTopology(poolPubkey: Uint8Array): FrozenTopology | null {
        const entry = this.entries.get(toKey(poolPubkey));
        return entry?.topology ?? null;
    }

    /**
     * Get all pools in a specific state
     */
    getPoolsByState(state: PoolLifecycleState): Uint8Array[] {
        const result: Uint8Array[] = [];
        for (const [key, entry] of this.entries) {
            if (entry.state === state) {
                // Convert hex key back to Uint8Array
                const bytes = new Uint8Array(32);
                for (let i = 0; i < 32; i++) {
                    bytes[i] = parseInt(key.slice(i * 2, i * 2 + 2), 16);
                }
                result.push(bytes);
            }
        }
        return result;
    }

    /**
     * Statistics
     */
    stats(): {
        discovered: number;
        frozen: number;
        active: number;
        incomplete: number;
        refreshing: number;
    } {
        let discovered = 0;
        let frozen = 0;
        let active = 0;
        let incomplete = 0;
        let refreshing = 0;

        for (const entry of this.entries.values()) {
            switch (entry.state) {
                case PoolLifecycleState.DISCOVERED:
                    discovered++;
                    break;
                case PoolLifecycleState.TOPOLOGY_FROZEN:
                    frozen++;
                    if (entry.incompleteReason) incomplete++;
                    break;
                case PoolLifecycleState.ACTIVE:
                    active++;
                    break;
                case PoolLifecycleState.REFRESHING:
                    refreshing++;
                    break;
            }
        }

        return { discovered, frozen, active, incomplete, refreshing };
    }

    /**
     * Clear all entries and reverse mappings
     */
    clear(): void {
        this.entries.clear();
        this.vaultToPool.clear();
        this.ammConfigToPool.clear();
    }

    /**
     * Get total pool count
     */
    get size(): number {
        return this.entries.size;
    }
}

// ============================================================================
// TOPOLOGY ORACLE INTERFACE
// ============================================================================

/**
 * TopologyOracle interface
 *
 * The oracle is responsible for:
 * 1. Determining what dependencies a pool needs
 * 2. Emitting FrozenTopology when all are identified
 * 3. Checking if topology is complete (all dependencies cached)
 *
 * Implementation can be venue-specific or generic.
 */
export interface TopologyOracle {
    /**
     * Compute required topology for a pool
     * Returns null if pool state is incomplete
     */
    computeTopology(poolPubkey: Uint8Array): FrozenTopology | null;

    /**
     * Check if all dependencies in topology are present in cache
     */
    isTopologyComplete(topology: FrozenTopology): boolean;

    /**
     * Get missing dependencies from topology
     * Returns list of what's needed but not cached
     */
    getMissingDependencies(topology: FrozenTopology): {
        vaults: Uint8Array[];
        tickArrays: number[];
        binArrays: number[];
        ammConfig: boolean;
    };
}

// ============================================================================
// RPC GUARD RESULT
// ============================================================================

/**
 * Result of checking if RPC write is allowed
 */
export interface RpcGuardResult {
    /** Whether RPC write is allowed */
    allowed: boolean;

    /** If not allowed, the reason */
    reason?: 'pool_frozen' | 'pool_active' | 'unknown_pool';

    /** Current pool state if known */
    currentState?: PoolLifecycleState;
}

/**
 * Check if RPC write is allowed for a pool dependency
 *
 * RPC allowed in DISCOVERED or REFRESHING state.
 *
 * @param registry - Lifecycle registry
 * @param poolPubkey - Pool the dependency belongs to
 * @returns Guard result indicating if write is allowed
 */
export function checkRpcAllowed(
    registry: LifecycleRegistry,
    poolPubkey: Uint8Array
): RpcGuardResult {
    const state = registry.getState(poolPubkey);

    if (state === null) {
        // Unknown pool - allow (will be discovered)
        return { allowed: true, reason: 'unknown_pool' };
    }

    // DISCOVERED or REFRESHING allows RPC (bootstrap writes)
    if (state === PoolLifecycleState.DISCOVERED || state === PoolLifecycleState.REFRESHING) {
        return { allowed: true, currentState: state };
    }

    if (state === PoolLifecycleState.TOPOLOGY_FROZEN) {
        return { allowed: false, reason: 'pool_frozen', currentState: state };
    }

    if (state === PoolLifecycleState.ACTIVE) {
        return { allowed: false, reason: 'pool_active', currentState: state };
    }

    // Should never reach here
    return { allowed: false, reason: 'unknown_pool' };
}

// ============================================================================
// EXPORTS
// ============================================================================

/**
 * Create a new lifecycle registry
 */
export function createLifecycleRegistry(): LifecycleRegistry {
    return new LifecycleRegistry();
}
