/**
 * fetchPoolDeps.ts — Minimal RPC fetch for pool dependencies
 *
 * ONE async function. ONE RPC call per pool. No queues. No timers. No complexity.
 *
 * Flow:
 * 1. Pool arrives via gRPC
 * 2. Derive required tick/bin PDAs (±3)
 * 3. One getMultipleAccountsInfo call
 * 4. For each: exists → commitAccountUpdate, not exists → markNonExistent
 * 5. freezeAndActivate
 * 6. Done
 *
 * Bootstrap Handler:
 * - Call setBootstrapHandler() to capture raw RPC response data
 * - Enables deterministic replay by recording bootstrap bytes
 */

import { PublicKey } from '@solana/web3.js';
import { commitAccountUpdate, type CacheRegistry } from '../cache/commit.js';
import { PoolLifecycleState } from '../cache/lifecycle.js';
import type { TopologyOracleImpl } from './TopologyOracleImpl.js';
import type { DeriveConfig } from '../snapshot/derive.js';
import type { PoolState, RaydiumClmmPool, MeteoraDlmmPool, TickArray, BinArray, PumpSwapPool, RaydiumV4Pool } from '../types.js';
import { VenueId } from '../types.js';
import { decodeTickArray, TICK_ARRAY_SIZE } from '../decode/programs/tickArray.js';
import { decodeBinArray, BIN_ARRAY_SIZE } from '../decode/programs/binArray.js';
import { getAllInitializedBinArrays, countInitializedBinArrays } from '../decode/programs/meteoraDlmm.js';
import {
    decodeRaydiumClmmAmmConfig,
    getClmmFeeRate,
    getAllInitializedTickArrays,
    countInitializedTickArrays,
    decodeTickArrayBitmapExtension,
    getInitializedTickArraysFromExtension,
} from '../decode/programs/raydiumClmm.js';
import { decodeTokenAccountAmount } from '../decode/vault.js';
import bs58 from 'bs58';

const DEBUG = process.env.DEBUG === '1';

// RPC timeout in milliseconds - prevents hanging on slow/unresponsive RPC
const RPC_TIMEOUT_MS = 5000;

// ============================================================================
// BOOTSTRAP EVENT (for deterministic replay capture)
// ============================================================================

/**
 * Bootstrap event emitted when RPC data is fetched for a pool dependency.
 * Used by capture-evidence.ts to record raw RPC bytes for replay proof.
 *
 * Contains full account metadata for deterministic replay:
 * - owner: Real program owner pubkey
 * - lamports: Actual lamports balance
 * - executable: Account executable flag
 * - rentEpoch: Rent epoch for deterministic replay
 */
export interface BootstrapEvent {
    /** Pool this bootstrap relates to */
    poolPubkey: Uint8Array;
    /** Account pubkey that was fetched */
    pubkey: Uint8Array;
    /** Account type for routing */
    accountType: 'tick' | 'bin' | 'vault' | 'ammConfig';
    /** Slot from RPC context */
    slot: number;
    /** Raw account data (null if account doesn't exist) */
    data: Uint8Array | null;
    /** Timestamp when fetched */
    fetchedAtMs: number;
    /** Real program owner pubkey (null if account doesn't exist) */
    owner: Uint8Array | null;
    /** Actual lamports balance */
    lamports: bigint;
    /** Account executable flag */
    executable: boolean;
    /** Rent epoch */
    rentEpoch: bigint;
}

export type BootstrapHandler = (event: BootstrapEvent) => void;

let bootstrapHandler: BootstrapHandler | null = null;

/**
 * Set handler for bootstrap events (for capture-evidence.ts)
 */
export function setBootstrapHandler(handler: BootstrapHandler | null): void {
    bootstrapHandler = handler;
}

/**
 * Emit bootstrap event if handler is registered
 */
function emitBootstrap(event: BootstrapEvent): void {
    if (bootstrapHandler) {
        try {
            bootstrapHandler(event);
        } catch (err) {
            // Don't let handler errors break bootstrap
            console.error('[bootstrap] Handler error:', err);
        }
    }
}

// ============================================================================
// PDA DERIVATION (using @solana/web3.js for correctness)
// ============================================================================

const CLMM_PROGRAM_ID = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
const DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

const TICKS_PER_ARRAY = 60;
const BINS_PER_ARRAY = 70;

/**
 * Derive tick array PDA using correct findProgramAddressSync
 *
 * CRITICAL: Raydium CLMM uses BIG ENDIAN for startTickIndex in PDA seeds!
 * See: https://github.com/raydium-io/raydium-clmm/blob/master/programs/amm/src/states/tick_array.rs
 * The key() method uses: &self.start_tick_index.to_be_bytes()
 */
function deriveTickArrayPDA(poolId: Uint8Array, startTickIndex: number): Uint8Array {
    const seed = Buffer.alloc(4);
    seed.writeInt32BE(startTickIndex, 0);  // BIG ENDIAN - matches Raydium source

    const [pda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from('tick_array'),
            Buffer.from(poolId),
            seed,
        ],
        CLMM_PROGRAM_ID
    );

    return pda.toBytes();
}

/**
 * Derive TickArrayBitmapExtension PDA
 * Seeds: ["pool_tick_array_bitmap_extension", pool_id]
 */
function deriveTickArrayBitmapExtensionPDA(poolId: Uint8Array): Uint8Array {
    const [pda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from('pool_tick_array_bitmap_extension'),
            Buffer.from(poolId),
        ],
        CLMM_PROGRAM_ID
    );
    return pda.toBytes();
}

/**
 * Derive bin array PDA using correct findProgramAddressSync
 */
function deriveBinArrayPDA(lbPair: Uint8Array, index: bigint): Uint8Array {
    const indexBytes = Buffer.alloc(8);
    indexBytes.writeBigInt64LE(index, 0);

    const [pda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from('bin_array'),
            Buffer.from(lbPair),
            indexBytes,
        ],
        DLMM_PROGRAM_ID
    );

    return pda.toBytes();
}

function getTickArrayStartIndex(tick: number, tickSpacing: number): number {
    const ticksPerArray = TICKS_PER_ARRAY * tickSpacing;
    return Math.floor(tick / ticksPerArray) * ticksPerArray;
}

function getBinArrayIndex(binId: number): bigint {
    // floor(binId / BINS_PER_ARRAY) works correctly for both positive and negative
    return BigInt(Math.floor(binId / BINS_PER_ARRAY));
}

// ============================================================================
// RPC ERROR HANDLING
// ============================================================================

/**
 * RPC error class for fail-fast error propagation.
 * When RPC fails, pool stays in DISCOVERED state (not frozen at slot 0).
 */
export class RpcError extends Error {
    constructor(
        message: string,
        public readonly code?: number,
        public readonly poolPubkey?: Uint8Array
    ) {
        super(message);
        this.name = 'RpcError';
    }
}

// ============================================================================
// RPC
// ============================================================================

interface AccountResult {
    exists: boolean;
    data: Uint8Array | null;
    /** Real program owner pubkey */
    owner: Uint8Array | null;
    /** Actual lamports balance */
    lamports: bigint;
    /** Account executable flag */
    executable: boolean;
    /** Rent epoch */
    rentEpoch: bigint;
}

interface RpcResponse {
    contextSlot: number;
    accounts: AccountResult[];
}

/**
 * Fetch multiple accounts with minContextSlot for deterministic bootstrap
 *
 * @param rpcEndpoint - RPC endpoint URL
 * @param pubkeys - Account pubkeys to fetch
 * @param minContextSlot - Minimum slot to ensure RPC snapshot is not older than discovery
 */
async function getMultipleAccounts(
    rpcEndpoint: string,
    pubkeys: Uint8Array[],
    minContextSlot?: number
): Promise<RpcResponse> {
    // Solana RPC expects base58-encoded pubkeys
    const pubkeysB58 = pubkeys.map(pk => bs58.encode(pk));

    // Build RPC config with optional minContextSlot
    const rpcConfig: Record<string, unknown> = {
        encoding: 'base64',
        commitment: 'confirmed',
    };
    if (minContextSlot !== undefined) {
        rpcConfig.minContextSlot = minContextSlot;
    }

    // Use AbortController for timeout to prevent hanging on slow/unresponsive RPC
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

    let response: Response;
    try {
        response = await fetch(rpcEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getMultipleAccounts',
                params: [pubkeysB58, rpcConfig],
            }),
            signal: controller.signal,
        });
    } catch (err: any) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            throw new RpcError(`RPC timeout after ${RPC_TIMEOUT_MS}ms`);
        }
        throw new RpcError(`RPC fetch failed: ${err.message ?? err}`);
    }
    clearTimeout(timeoutId);

    // CRITICAL: Check HTTP status before parsing JSON
    // Prevents cryptic JSON parse errors when RPC returns HTML (e.g., 502)
    if (!response.ok) {
        throw new RpcError(`RPC HTTP ${response.status}: ${response.statusText}`);
    }

    const json = await response.json() as any;

    // CRITICAL: Check for JSON-RPC error BEFORE accessing result
    if (json.error) {
        throw new RpcError(
            `RPC error: ${json.error.message ?? JSON.stringify(json.error)}`,
            json.error.code
        );
    }

    // CRITICAL: Validate result exists
    if (!json.result) {
        throw new RpcError('RPC returned invalid response: missing result');
    }

    // CRITICAL: Validate context slot is non-zero (prevents catastrophic slot-0 freezes)
    const contextSlot = json.result.context?.slot;
    if (contextSlot === undefined || contextSlot === null || contextSlot === 0) {
        throw new RpcError(
            'RPC returned invalid contextSlot (0 or missing) - cannot freeze at slot 0'
        );
    }

    // CRITICAL: Validate minContextSlot was respected (prevents stale data)
    if (minContextSlot !== undefined && contextSlot < minContextSlot) {
        throw new RpcError(
            `RPC returned stale data: contextSlot=${contextSlot} < minContextSlot=${minContextSlot}`
        );
    }

    // Validate response array exists and has correct shape
    const values = json.result.value;
    if (!Array.isArray(values)) {
        throw new RpcError('RPC returned invalid response: value is not an array');
    }

    // Validate array length matches request (prevents partial response issues)
    if (values.length !== pubkeys.length) {
        throw new RpcError(
            `RPC returned ${values.length} accounts but requested ${pubkeys.length}`
        );
    }

    const accounts = pubkeys.map((_, i) => {
        const account = values[i];
        if (!account) {
            return {
                exists: false,
                data: null,
                owner: null,
                lamports: 0n,
                executable: false,
                rentEpoch: 0n,
            };
        }
        const data = account.data?.[0]
            ? new Uint8Array(Buffer.from(account.data[0], 'base64'))
            : null;
        // Parse full account metadata for deterministic replay
        const owner = account.owner
            ? new Uint8Array(bs58.decode(account.owner))
            : null;
        const lamports = BigInt(account.lamports ?? 0);
        const executable = account.executable ?? false;
        const rentEpoch = BigInt(account.rentEpoch ?? 0);

        return { exists: true, data, owner, lamports, executable, rentEpoch };
    });

    return { contextSlot, accounts };
}

/**
 * Batch wrapper for getMultipleAccounts to handle >100 account limit
 * Solana RPC limits getMultipleAccounts to 100 pubkeys per call
 */
// Batch limit for getMultipleAccounts - increased for local RPC with --rpc-max-multiple-accounts 2000
const RPC_BATCH_LIMIT = 2000;

async function getMultipleAccountsBatched(
    rpcEndpoint: string,
    pubkeys: Uint8Array[],
    minContextSlot?: number
): Promise<RpcResponse> {
    if (pubkeys.length <= RPC_BATCH_LIMIT) {
        return getMultipleAccounts(rpcEndpoint, pubkeys, minContextSlot);
    }

    const results: AccountResult[] = [];
    let maxSlot = 0;

    for (let i = 0; i < pubkeys.length; i += RPC_BATCH_LIMIT) {
        const chunk = pubkeys.slice(i, i + RPC_BATCH_LIMIT);
        const { contextSlot, accounts } = await getMultipleAccounts(rpcEndpoint, chunk, minContextSlot);
        results.push(...accounts);
        maxSlot = Math.max(maxSlot, contextSlot);
    }

    return { contextSlot: maxSlot, accounts: results };
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

export interface FetchResult {
    success: boolean;
    activated: boolean;
    tickArraysFetched: number;
    binArraysFetched: number;
    ammConfigFetched: boolean;
    vaultsFetched: number;
    /** Actual RPC snapshot slot used for freeze (for proofs) */
    snapshotSlot?: number;
    /** RPC error message if fetch failed (pool stays in DISCOVERED state) */
    rpcError?: string;
}

/**
 * Fetch all dependencies for a pool and freeze/activate.
 * ONE RPC call. No queues. No retries. No complexity.
 *
 * Uses minContextSlot to ensure RPC snapshot is not older than discovery.
 * Freezes at the actual RPC context.slot (not discovery slot) for determinism.
 *
 * @param poolPubkey - Pool public key
 * @param pool - Pool state
 * @param discoverySlot - Slot when pool was discovered via gRPC (used as minContextSlot)
 * @param rpcEndpoint - RPC endpoint for fetching
 * @param registry - Cache registry
 * @param oracle - Topology oracle
 * @param config - Optional configuration for tick/bin array radius
 */
export async function fetchPoolDeps(
    poolPubkey: Uint8Array,
    pool: PoolState,
    discoverySlot: number,
    rpcEndpoint: string,
    registry: CacheRegistry,
    oracle: TopologyOracleImpl,
    config?: DeriveConfig
): Promise<FetchResult> {
    const result: FetchResult = {
        success: false,
        activated: false,
        tickArraysFetched: 0,
        binArraysFetched: 0,
        ammConfigFetched: false,
        vaultsFetched: 0,
    };

    const tickArrayRadius = config?.tickArrayRadius ?? 3;
    const binArrayRadius = config?.binArrayRadius ?? 3;

    let snapshotSlot = discoverySlot; // Fallback to discovery slot

    try {
        if (pool.venue === VenueId.RaydiumClmm) {
            snapshotSlot = await fetchClmmDeps(poolPubkey, pool as RaydiumClmmPool, discoverySlot, rpcEndpoint, registry, result, tickArrayRadius);
        } else if (pool.venue === VenueId.MeteoraDlmm) {
            snapshotSlot = await fetchDlmmDeps(poolPubkey, pool as MeteoraDlmmPool, discoverySlot, rpcEndpoint, registry, result, binArrayRadius);
        } else if (pool.venue === VenueId.PumpSwap) {
            snapshotSlot = await fetchSimpleDeps(poolPubkey, pool as PumpSwapPool, discoverySlot, rpcEndpoint, registry, result);
        } else if (pool.venue === VenueId.RaydiumV4) {
            snapshotSlot = await fetchSimpleDeps(poolPubkey, pool as RaydiumV4Pool, discoverySlot, rpcEndpoint, registry, result);
        }

        // Freeze and activate at the actual RPC snapshot slot (not discovery slot)
        // This ensures lifecycle records the slot where dependencies were actually fetched
        const activation = oracle.freezeAndActivate(poolPubkey, snapshotSlot);

        // Check if freeze succeeded - if not, this is a failure
        if (!activation.freeze.frozen) {
            const poolHex = bs58.encode(poolPubkey).slice(0, 12);
            console.warn(
                `[fetchPoolDeps] Freeze failed for pool ${poolHex}: ${activation.freeze.reason ?? 'unknown'}`
            );
            result.rpcError = `Freeze failed: ${activation.freeze.reason ?? 'unknown'}`;
            // result.success remains false
        } else {
            result.activated = activation.activation?.activated ?? false;
            result.snapshotSlot = snapshotSlot;
            result.success = true;
        }
    } catch (e) {
        if (e instanceof RpcError) {
            // CRITICAL: On RPC error, DO NOT freeze - pool stays in DISCOVERED state
            // This prevents catastrophic slot-0 freezes from RPC failures
            const poolHex = bs58.encode(poolPubkey).slice(0, 12);
            console.error(`[fetchPoolDeps] RPC error for pool ${poolHex}: ${e.message}`);
            result.rpcError = e.message;

            // Edge Case A: If pool was in REFRESHING state, abort refresh to prevent stranding
            // This returns the pool to ACTIVE with its existing frozen topology intact
            if (registry.lifecycle) {
                const state = registry.lifecycle.getState(poolPubkey);
                if (state === PoolLifecycleState.REFRESHING) {
                    const aborted = registry.lifecycle.abortRefresh(poolPubkey, discoverySlot);
                    if (aborted) {
                        console.warn(`[fetchPoolDeps] Aborted refresh for pool ${poolHex}, returning to ACTIVE`);
                    }
                }
            }
            // result.success remains false, pool stays DISCOVERED (if new) or returns to ACTIVE (if refresh)
        } else {
            console.error(`[fetchPoolDeps] Failed for pool: ${e}`);
        }
    }

    return result;
}

/**
 * Fetch CLMM dependencies (tick arrays, ammConfig, vaults)
 * @returns RPC context slot for freeze
 *
 * CRITICAL: Fetches ALL initialized tick arrays from BOTH:
 * 1. Default pool bitmap (±512 arrays from center)
 * 2. TickArrayBitmapExtension account (for liquidity outside default range)
 *
 * This ensures pools with liquidity at distant price ranges are properly supported.
 */
async function fetchClmmDeps(
    poolPubkey: Uint8Array,
    pool: RaydiumClmmPool,
    minContextSlot: number,
    rpcEndpoint: string,
    registry: CacheRegistry,
    result: FetchResult,
    tickArrayRadius: number = 7
): Promise<number> {
    const poolHex = bs58.encode(poolPubkey).slice(0, 12);
    const ticksPerArray = TICKS_PER_ARRAY * pool.tickSpacing;

    // Step 1: Get ALL initialized tick arrays from default bitmap
    const defaultBitmapArrays = getAllInitializedTickArrays(pool.tickArrayBitmap, pool.tickSpacing);
    const totalInDefaultBitmap = countInitializedTickArrays(pool.tickArrayBitmap);

    // Step 2: Try to fetch TickArrayBitmapExtension (may not exist for all pools)
    const extensionPDA = deriveTickArrayBitmapExtensionPDA(poolPubkey);
    let extensionArrays: number[] = [];

    try {
        const { accounts: extAccounts } = await getMultipleAccounts(rpcEndpoint, [extensionPDA], minContextSlot);
        const extAccount = extAccounts[0];
        if (extAccount?.exists && extAccount.data) {
            const extension = decodeTickArrayBitmapExtension(extAccount.data);
            if (extension) {
                extensionArrays = getInitializedTickArraysFromExtension(extension, pool.tickSpacing);
                if (extensionArrays.length > 0 && DEBUG) {
                    console.log(`[fetchClmmDeps] Pool ${poolHex}: Found ${extensionArrays.length} tick arrays in extension bitmap`);
                }
            }
        }
    } catch (e: any) {
        // Extension doesn't exist or RPC failed - not critical, continue with default bitmap
    }

    // Step 3: Combine all initialized tick arrays
    const allInitializedIndexes = [...new Set([...defaultBitmapArrays, ...extensionArrays])].sort((a, b) => a - b);

    // Log stats (only in DEBUG mode)
    if (DEBUG) {
        if (allInitializedIndexes.length === 0) {
            console.warn(`[fetchClmmDeps] Pool ${poolHex}: No initialized tick arrays found in bitmap or extension`);
        } else {
            console.log(
                `[fetchClmmDeps] Pool ${poolHex}: Found ${allInitializedIndexes.length} initialized tick arrays ` +
                `(${totalInDefaultBitmap} in default bitmap, ${extensionArrays.length} in extension)`
            );
        }
    }

    // Step 4: Derive PDAs for all initialized tick arrays
    const tickArrayPDAs: { pda: Uint8Array; startIndex: number }[] = [];
    for (const startIndex of allInitializedIndexes) {
        const pda = deriveTickArrayPDA(poolPubkey, startIndex);
        tickArrayPDAs.push({ pda, startIndex });
    }

    // Also compute expected ±radius range for marking non-existent
    const centerStart = getTickArrayStartIndex(pool.tickCurrent, pool.tickSpacing);
    const expectedIndexes: number[] = [];
    for (let offset = -tickArrayRadius; offset <= tickArrayRadius; offset++) {
        expectedIndexes.push(centerStart + offset * ticksPerArray);
    }
    const nonInitializedIndexes = expectedIndexes.filter(idx => !allInitializedIndexes.includes(idx));

    // Include ammConfig AND vaults in same RPC call (batched to handle >100 accounts)
    const vaults = [pool.tokenVault0, pool.tokenVault1];
    const allPubkeys = [...tickArrayPDAs.map(t => t.pda), pool.ammConfig, ...vaults];
    const { contextSlot, accounts } = await getMultipleAccountsBatched(rpcEndpoint, allPubkeys, minContextSlot);

    const fetchedAtMs = Date.now();

    // Process tick arrays
    for (let i = 0; i < tickArrayPDAs.length; i++) {
        const { pda, startIndex } = tickArrayPDAs[i]!;
        const account = accounts[i]!;

        // Emit bootstrap event for replay capture (includes full account metadata)
        emitBootstrap({
            poolPubkey,
            pubkey: pda,
            accountType: 'tick',
            slot: contextSlot,
            data: account.data,
            fetchedAtMs,
            owner: account.owner,
            lamports: account.lamports,
            executable: account.executable,
            rentEpoch: account.rentEpoch,
        });

        if (account.exists && account.data) {
            const decoded = decodeTickArray(account.data);
            if (decoded) {
                const tickArray: TickArray = {
                    poolId: decoded.poolId,
                    startTickIndex: decoded.startTickIndex,
                    ticks: decoded.ticks,
                };
                commitAccountUpdate(registry, {
                    type: 'tick',
                    poolPubkey,
                    startTickIndex: startIndex,
                    tickAccountPubkey: pda,
                    array: tickArray,
                    slot: contextSlot,
                    writeVersion: 0n,
                    dataLength: account.data.length,
                    source: 'bootstrap',
                });
                result.tickArraysFetched++;
            }
        } else {
            // Bitmap said it exists but RPC returned null - unexpected, mark non-existent
            DEBUG && console.warn(
                `[fetchClmmDeps] Pool ${poolHex}: Tick array at ${startIndex} was in bitmap but RPC returned null`
            );
            registry.tick.markNonExistent(poolPubkey, startIndex);
            result.tickArraysFetched++;
        }
    }

    // Mark non-initialized tick arrays as non-existent (without fetching them)
    // These arrays are in the expected ±radius range but have no liquidity deposited
    for (const startIndex of nonInitializedIndexes) {
        registry.tick.markNonExistent(poolPubkey, startIndex);
    }

    // Process ammConfig
    const ammIdx = tickArrayPDAs.length;
    const ammAccount = accounts[ammIdx]!;

    // Emit bootstrap event for replay capture (includes full account metadata)
    emitBootstrap({
        poolPubkey,
        pubkey: pool.ammConfig,
        accountType: 'ammConfig',
        slot: contextSlot,
        data: ammAccount.data,
        fetchedAtMs,
        owner: ammAccount.owner,
        lamports: ammAccount.lamports,
        executable: ammAccount.executable,
        rentEpoch: ammAccount.rentEpoch,
    });

    if (ammAccount.exists && ammAccount.data) {
        const config = decodeRaydiumClmmAmmConfig(ammAccount.data);
        if (config) {
            const feeRate = getClmmFeeRate(config);
            commitAccountUpdate(registry, {
                type: 'ammConfig',
                pubkey: pool.ammConfig,
                feeRate,
                slot: contextSlot,
                writeVersion: 0n,  // RPC doesn't provide writeVersion
                dataLength: ammAccount.data.length,
                source: 'bootstrap',
            });
            result.ammConfigFetched = true;
        }
    }

    // Process vaults
    for (let i = 0; i < vaults.length; i++) {
        const vaultAccount = accounts[ammIdx + 1 + i]!;

        // Emit bootstrap event for replay capture (includes full account metadata)
        emitBootstrap({
            poolPubkey,
            pubkey: vaults[i]!,
            accountType: 'vault',
            slot: contextSlot,
            data: vaultAccount.data,
            fetchedAtMs,
            owner: vaultAccount.owner,
            lamports: vaultAccount.lamports,
            executable: vaultAccount.executable,
            rentEpoch: vaultAccount.rentEpoch,
        });

        if (vaultAccount.exists && vaultAccount.data) {
            const amount = decodeTokenAccountAmount(vaultAccount.data);
            if (amount !== null) {
                commitAccountUpdate(registry, {
                    type: 'vault',
                    pubkey: vaults[i]!,
                    amount,
                    slot: contextSlot,
                    writeVersion: 0n,
                    dataLength: vaultAccount.data.length,
                    source: 'bootstrap',
                });
                result.vaultsFetched++;
            }
        }
    }

    return contextSlot;
}

/**
 * Fetch DLMM dependencies (bin arrays, vaults)
 * @returns RPC context slot for freeze
 *
 * CRITICAL: Fetches ALL initialized bin arrays from:
 * 1. Default pool bitmap (±512 arrays from center)
 * 2. TODO: BinArrayBitmapExtension account (for liquidity outside default range)
 *
 * This ensures pools with liquidity at distant price ranges are properly supported.
 */
async function fetchDlmmDeps(
    poolPubkey: Uint8Array,
    pool: MeteoraDlmmPool,
    minContextSlot: number,
    rpcEndpoint: string,
    registry: CacheRegistry,
    result: FetchResult,
    binArrayRadius: number = 3
): Promise<number> {
    const poolHex = bs58.encode(poolPubkey).slice(0, 12);

    // Step 1: Get ALL initialized bin arrays from bitmap
    const initializedArrays = getAllInitializedBinArrays(pool.binArrayBitmap);
    const totalInBitmap = countInitializedBinArrays(pool.binArrayBitmap);

    // Log stats (only in DEBUG mode)
    if (DEBUG) {
        if (initializedArrays.length === 0) {
            console.warn(`[fetchDlmmDeps] Pool ${poolHex}: No initialized bin arrays found in bitmap`);
        } else {
            console.log(
                `[fetchDlmmDeps] Pool ${poolHex}: Found ${initializedArrays.length} initialized bin arrays in bitmap`
            );
        }
    }

    // Step 2: Derive PDAs for all initialized bin arrays
    const binArrayPDAs: { pda: Uint8Array; index: bigint }[] = [];
    for (const index of initializedArrays) {
        const pda = deriveBinArrayPDA(poolPubkey, BigInt(index));
        binArrayPDAs.push({ pda, index: BigInt(index) });
    }

    // Also compute expected ±radius range for marking non-existent
    const centerIndex = getBinArrayIndex(pool.activeId);
    const expectedIndexes: number[] = [];
    for (let offset = -binArrayRadius; offset <= binArrayRadius; offset++) {
        expectedIndexes.push(Number(centerIndex) + offset);
    }
    const nonInitializedIndexes = expectedIndexes.filter(idx => !initializedArrays.includes(idx));

    // Include vaults in same RPC call (batched to handle >100 accounts)
    const vaults = [pool.vaultX, pool.vaultY];
    const allPubkeys = [...binArrayPDAs.map(b => b.pda), ...vaults];
    const { contextSlot, accounts } = await getMultipleAccountsBatched(rpcEndpoint, allPubkeys, minContextSlot);

    const fetchedAtMs = Date.now();

    // Process bin arrays
    for (let i = 0; i < binArrayPDAs.length; i++) {
        const { pda, index } = binArrayPDAs[i]!;
        const account = accounts[i]!;

        // Emit bootstrap event for replay capture (includes full account metadata)
        emitBootstrap({
            poolPubkey,
            pubkey: pda,
            accountType: 'bin',
            slot: contextSlot,
            data: account.data,
            fetchedAtMs,
            owner: account.owner,
            lamports: account.lamports,
            executable: account.executable,
            rentEpoch: account.rentEpoch,
        });

        if (account.exists && account.data) {
            const decoded = decodeBinArray(account.data);
            if (decoded) {
                commitAccountUpdate(registry, {
                    type: 'bin',
                    poolPubkey,
                    binArrayIndex: Number(index),
                    binAccountPubkey: pda,
                    array: decoded,
                    slot: contextSlot,
                    writeVersion: 0n,
                    dataLength: account.data.length,
                    source: 'bootstrap',
                });
                result.binArraysFetched++;
            }
        } else {
            // Bitmap said it exists but RPC returned null - unexpected, mark non-existent
            DEBUG && console.warn(
                `[fetchDlmmDeps] Pool ${poolHex}: Bin array at ${index} was in bitmap but RPC returned null`
            );
            registry.bin.markNonExistent(poolPubkey, Number(index));
            result.binArraysFetched++;
        }
    }

    // Mark non-initialized bin arrays as non-existent (without fetching them)
    // These arrays are in the expected ±radius range but have no liquidity deposited
    for (const index of nonInitializedIndexes) {
        registry.bin.markNonExistent(poolPubkey, index);
    }

    // Process vaults
    const vaultStartIdx = binArrayPDAs.length;
    for (let i = 0; i < vaults.length; i++) {
        const vaultAccount = accounts[vaultStartIdx + i]!;

        // Emit bootstrap event for replay capture (includes full account metadata)
        emitBootstrap({
            poolPubkey,
            pubkey: vaults[i]!,
            accountType: 'vault',
            slot: contextSlot,
            data: vaultAccount.data,
            fetchedAtMs,
            owner: vaultAccount.owner,
            lamports: vaultAccount.lamports,
            executable: vaultAccount.executable,
            rentEpoch: vaultAccount.rentEpoch,
        });

        if (vaultAccount.exists && vaultAccount.data) {
            const amount = decodeTokenAccountAmount(vaultAccount.data);
            if (amount !== null) {
                commitAccountUpdate(registry, {
                    type: 'vault',
                    pubkey: vaults[i]!,
                    amount,
                    slot: contextSlot,
                    writeVersion: 0n,
                    dataLength: vaultAccount.data.length,
                    source: 'bootstrap',
                });
                result.vaultsFetched++;
            }
        }
    }

    return contextSlot;
}

/**
 * Fetch simple pool dependencies (PumpSwap, RaydiumV4) - just vaults
 * @returns RPC context slot for freeze
 */
async function fetchSimpleDeps(
    poolPubkey: Uint8Array,
    pool: PumpSwapPool | RaydiumV4Pool,
    minContextSlot: number,
    rpcEndpoint: string,
    registry: CacheRegistry,
    result: FetchResult
): Promise<number> {
    const vaults = [pool.baseVault, pool.quoteVault];
    const { contextSlot, accounts } = await getMultipleAccounts(rpcEndpoint, vaults, minContextSlot);

    const fetchedAtMs = Date.now();

    for (let i = 0; i < vaults.length; i++) {
        const vaultAccount = accounts[i]!;

        // Emit bootstrap event for replay capture (includes full account metadata)
        emitBootstrap({
            poolPubkey,
            pubkey: vaults[i]!,
            accountType: 'vault',
            slot: contextSlot,
            data: vaultAccount.data,
            fetchedAtMs,
            owner: vaultAccount.owner,
            lamports: vaultAccount.lamports,
            executable: vaultAccount.executable,
            rentEpoch: vaultAccount.rentEpoch,
        });

        if (vaultAccount.exists && vaultAccount.data) {
            const amount = decodeTokenAccountAmount(vaultAccount.data);
            if (amount !== null) {
                commitAccountUpdate(registry, {
                    type: 'vault',
                    pubkey: vaults[i]!,
                    amount,
                    slot: contextSlot,
                    writeVersion: 0n,
                    dataLength: vaultAccount.data.length,
                    source: 'bootstrap',
                });
                result.vaultsFetched++;
            }
        }
    }

    return contextSlot;
}
