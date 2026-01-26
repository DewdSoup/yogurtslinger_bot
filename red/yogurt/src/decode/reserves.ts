/**
 * Transaction Reserve Extractor (Phase 5 Infrastructure)
 *
 * Extracts pool reserves from transaction pre/post token balances.
 * Used for validation to get reserves at the exact execution slot,
 * avoiding cache staleness issues.
 *
 * This is infrastructure - production uses cached reserves for pending txs,
 * but validation needs transaction-specific reserves for accurate measurement.
 */

import type { PumpSwapPool, RaydiumV4Pool, PoolState, VenueId } from '../types.js';
import { VenueId as V } from '../types.js';

/** Token balance entry from transaction meta */
export interface TxTokenBalance {
    accountIndex: number;
    mint: Uint8Array;
    amount: bigint;
}

/** Extracted reserves */
export interface ExtractedReserves {
    baseReserve: bigint;
    quoteReserve: bigint;
    slot?: number;
}

/**
 * Convert pubkey to hex string for comparison
 */
function toHex(pubkey: Uint8Array): string {
    let hex = '';
    for (let i = 0; i < pubkey.length; i++) {
        hex += pubkey[i].toString(16).padStart(2, '0');
    }
    return hex;
}

/**
 * Extract vault reserves from transaction pre-token-balances
 *
 * For PumpSwap/RaydiumV4 pools, finds the vault accounts in the transaction's
 * pre-token-balances to get the exact reserves at execution time.
 *
 * @param pool Pool state with vault addresses
 * @param accountKeys Transaction account keys (resolved)
 * @param preTokenBalances Token balances before execution
 * @returns Extracted reserves or null if vaults not found
 */
export function extractReservesFromTx(
    pool: PoolState,
    accountKeys: Uint8Array[],
    preTokenBalances: TxTokenBalance[]
): ExtractedReserves | null {
    // Get vault pubkeys - both PumpSwap and RaydiumV4 use baseVault/quoteVault
    let baseVaultPubkey: Uint8Array | undefined;
    let quoteVaultPubkey: Uint8Array | undefined;

    if ('baseVault' in pool && 'quoteVault' in pool) {
        // PumpSwap or RaydiumV4 pool
        const p = pool as PumpSwapPool | RaydiumV4Pool;
        baseVaultPubkey = p.baseVault;
        quoteVaultPubkey = p.quoteVault;
    }

    if (!baseVaultPubkey || !quoteVaultPubkey) {
        return null;
    }

    // Find vault account indices in the transaction
    const baseVaultHex = toHex(baseVaultPubkey);
    const quoteVaultHex = toHex(quoteVaultPubkey);

    let baseVaultIndex = -1;
    let quoteVaultIndex = -1;

    for (let i = 0; i < accountKeys.length; i++) {
        const keyHex = toHex(accountKeys[i]);
        if (keyHex === baseVaultHex) baseVaultIndex = i;
        if (keyHex === quoteVaultHex) quoteVaultIndex = i;
    }

    if (baseVaultIndex === -1 || quoteVaultIndex === -1) {
        // Vaults not in transaction - can't extract reserves
        return null;
    }

    // Find balances for these account indices
    let baseReserve: bigint | null = null;
    let quoteReserve: bigint | null = null;

    for (const balance of preTokenBalances) {
        if (balance.accountIndex === baseVaultIndex) {
            baseReserve = balance.amount;
        }
        if (balance.accountIndex === quoteVaultIndex) {
            quoteReserve = balance.amount;
        }
    }

    if (baseReserve === null || quoteReserve === null) {
        return null;
    }

    return { baseReserve, quoteReserve };
}

/**
 * Inject extracted reserves into pool state
 * Returns new pool state with reserves populated
 */
export function injectReserves(
    pool: PoolState,
    reserves: ExtractedReserves
): PoolState {
    return {
        ...pool,
        baseReserve: reserves.baseReserve,
        quoteReserve: reserves.quoteReserve,
    } as PoolState;
}

/**
 * Check if pool is a constant product pool (needs vault reserves)
 */
export function isConstantProductPool(pool: PoolState): boolean {
    return 'baseVault' in pool || 'poolCoinTokenAccount' in pool;
}
