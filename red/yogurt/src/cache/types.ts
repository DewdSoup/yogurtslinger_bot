/**
 * Cache module types
 */

import type {
    CacheEntry,
    PoolState,
    TickArray,
    BinArray,
    AddressLookupTable
} from '../types.js';

/** Cache update result */
export interface CacheUpdateResult {
    updated: boolean;
    wasStale: boolean;
    previousSlot?: number;
}

/** Cache statistics */
export interface CacheStats {
    size: number;
    hitCount: bigint;
    missCount: bigint;
    evictionCount: bigint;
    lastUpdateSlot: number;
}

/** Cache trace event for evidence capture */
export interface CacheTraceEvent {
    cacheType: 'pool' | 'vault' | 'tick' | 'bin' | 'ammConfig' | 'globalConfig';
    pubkey: Uint8Array;
    slot: number;
    writeVersion: bigint;
    appliedAtMs: number;  // Date.now() for SQLite storage
    cacheKey?: string;    // Additional key info for tick/bin arrays
    /** Account data length for invariant validation (MANDATORY for tick/bin/pool) */
    dataLength: number;
    /** Source of update: 'grpc' for hot path, 'bootstrap' for RPC fetch */
    source: 'grpc' | 'bootstrap';
    /** Whether this update was rejected as stale (slot/writeVersion too old) */
    rejected?: boolean;
    /** For rejected updates: the existing slot that won */
    existingSlot?: number;
    /** Phase 3: Whether this entry was evicted due to memory pressure */
    evicted?: boolean;
    /** Raw account data for hash verification (optional to avoid memory overhead) */
    data?: Uint8Array;
    /** Rejection reason: 'stale', 'lifecycle', or null for applied updates */
    reason?: 'stale' | 'lifecycle' | null;
}

/** Handler for cache trace events (used by capture script) */
export type CacheTraceHandler = (event: CacheTraceEvent) => void;

/** Pool cache interface */
export interface IPoolCache {
    get(pubkey: Uint8Array): Readonly<CacheEntry<PoolState>> | null;
    /**
     * Set pool state with mandatory invariant parameters
     * @param dataLength - MANDATORY: account data length for invariant validation
     * @param source - MANDATORY: 'grpc' or 'bootstrap' for consistency checking
     * @throws on invariant violation (pool with tick/bin array size)
     */
    set(pubkey: Uint8Array, state: PoolState, slot: number, writeVersion: bigint, dataLength: number, source: 'grpc' | 'bootstrap'): CacheUpdateResult;
    delete(pubkey: Uint8Array): boolean;
    has(pubkey: Uint8Array): boolean;
    stats(): CacheStats;
    clear(): void;
}

/** ALT cache interface */
export interface IAltCache {
    get(pubkey: Uint8Array): AddressLookupTable | null;
    set(pubkey: Uint8Array, alt: AddressLookupTable): void;
    prefetch(pubkeys: Uint8Array[]): Promise<void>;
    stats(): CacheStats;
}

/** Tick array cache interface */
export interface ITickCache {
    get(pool: Uint8Array, startTickIndex: number): Readonly<CacheEntry<TickArray>> | null;
    /**
     * Set tick array with mandatory invariant parameters
     * @param tickAccountPubkey - MANDATORY: actual tick array account pubkey (no fallback)
     * @param dataLength - MANDATORY: account data length for invariant validation
     * @param source - MANDATORY: 'grpc' or 'bootstrap' for consistency checking
     * @throws on missing parameters or invariant violation
     * @returns CacheUpdateResult indicating if update was applied
     */
    set(pool: Uint8Array, startTickIndex: number, array: TickArray, slot: number, writeVersion: bigint, tickAccountPubkey: Uint8Array, dataLength: number, source: 'grpc' | 'bootstrap'): CacheUpdateResult;
    getMultiple(pool: Uint8Array, indexes: number[]): (Readonly<CacheEntry<TickArray>> | null)[];
    getByAccountPubkey(pubkey: Uint8Array): Readonly<CacheEntry<TickArray>> | null;
    stats(): CacheStats;
}

/** Bin array cache interface */
export interface IBinCache {
    get(pool: Uint8Array, index: number): Readonly<CacheEntry<BinArray>> | null;
    /**
     * Set bin array with mandatory invariant parameters
     * @param binAccountPubkey - MANDATORY: actual bin array account pubkey (no fallback)
     * @param dataLength - MANDATORY: account data length for invariant validation
     * @param source - MANDATORY: 'grpc' or 'bootstrap' for consistency checking
     * @throws on missing parameters or invariant violation
     * @returns CacheUpdateResult indicating if update was applied
     */
    set(pool: Uint8Array, index: number, array: BinArray, slot: number, writeVersion: bigint, binAccountPubkey: Uint8Array, dataLength: number, source: 'grpc' | 'bootstrap'): CacheUpdateResult;
    getMultiple(pool: Uint8Array, indexes: number[]): (Readonly<CacheEntry<BinArray>> | null)[];
    getByAccountPubkey(pubkey: Uint8Array): Readonly<CacheEntry<BinArray>> | null;
    stats(): CacheStats;
}

/** Vault balance entry */
export interface VaultBalance {
    amount: bigint;
    slot: number;
    writeVersion: bigint;
    /** Phase 2: Source of update for convergence validation */
    source: 'grpc' | 'bootstrap';
}

/** Vault cache interface */
export interface IVaultCache {
    get(pubkey: Uint8Array): Readonly<VaultBalance> | null;
    /**
     * Set vault balance with mandatory trace metadata
     * @param dataLength - MANDATORY: Account data length for trace metadata
     * @param source - MANDATORY: 'grpc' or 'bootstrap' for trace metadata
     */
    set(pubkey: Uint8Array, amount: bigint, slot: number, writeVersion: bigint, dataLength: number, source: 'grpc' | 'bootstrap'): CacheUpdateResult;
    stats(): CacheStats;
}

/** CLMM ammConfig fee rate entry */
export interface AmmConfigEntry {
    feeRate: bigint;  // In basis points
    slot: number;
    writeVersion: bigint;
    /** Phase 2: Source of update for convergence validation */
    source: 'grpc' | 'bootstrap';
}

/** CLMM ammConfig cache interface */
export interface IAmmConfigCache {
    get(pubkey: Uint8Array): Readonly<AmmConfigEntry> | null;
    set(pubkey: Uint8Array, feeRate: bigint, slot: number, writeVersion: bigint, dataLength: number, source: 'grpc' | 'bootstrap'): CacheUpdateResult;
    stats(): CacheStats;
}

/** PumpSwap GlobalConfig fee entry */
export interface GlobalConfigEntry {
    lpFeeBps: bigint;
    protocolFeeBps: bigint;
    coinCreatorFeeBps: bigint;
    slot: number;
    /** Phase 2: Source of update for convergence validation */
    source: 'grpc' | 'bootstrap';
}

/** PumpSwap GlobalConfig cache interface */
export interface IGlobalConfigCache {
    get(): Readonly<GlobalConfigEntry> | null;
    getFees(): Readonly<{ lpFeeBps: bigint; protocolFeeBps: bigint; coinCreatorFeeBps: bigint }>;
    getTotalFeeBps(): bigint;
    set(config: { lpFeeBps: bigint; protocolFeeBps: bigint; coinCreatorFeeBps: bigint }, slot: number): void;
    has(): boolean;
    stats(): CacheStats;
}