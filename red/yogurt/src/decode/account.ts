/**
 * Account Decoder Dispatcher (Phase 2)
 *
 * Routes account updates to venue-specific decoders.
 * Optimized: Uses byte comparison, no base58 conversion in hot path.
 *
 * Gate requirements:
 * - Decode success ≥99.5% for target programs
 */

import type { AccountUpdate, PoolState, VenueId } from '../types.js';
import { VenueId as V } from '../types.js';

import { isPumpSwapPool, decodePumpSwapPool } from './programs/pumpswap.js';
import { isRaydiumV4Pool, decodeRaydiumV4Pool } from './programs/raydiumV4.js';
import { isRaydiumClmmPool, decodeRaydiumClmmPool } from './programs/raydiumClmm.js';
import { isMeteoraDlmmPool, decodeMeteoraDlmmPool } from './programs/meteoraDlmm.js';

// Pre-computed program ID bytes (avoid base58 decode in hot path)
// PumpSwap: pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
const PUMPSWAP_BYTES = new Uint8Array([
    0x0c, 0x14, 0xde, 0xfc, 0x82, 0x5e, 0xc6, 0x76,
    0x94, 0x25, 0x08, 0x18, 0xbb, 0x65, 0x40, 0x65,
    0xf4, 0x29, 0x8d, 0x31, 0x56, 0xd5, 0x71, 0xb4,
    0xd4, 0xf8, 0x09, 0x0c, 0x18, 0xe9, 0xa8, 0x63,
]);

// Raydium V4: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
const RAYDIUM_V4_BYTES = new Uint8Array([
    0x4b, 0xd9, 0x49, 0xc4, 0x36, 0x02, 0xc3, 0x3f,
    0x20, 0x77, 0x90, 0xed, 0x16, 0xa3, 0x52, 0x4c,
    0xa1, 0xb9, 0x97, 0x5c, 0xf1, 0x21, 0xa2, 0xa9,
    0x0c, 0xff, 0xec, 0x7d, 0xf8, 0xb6, 0x8a, 0xcd,
]);

// Raydium CLMM: CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK
const RAYDIUM_CLMM_BYTES = new Uint8Array([
    0xa5, 0xd5, 0xca, 0x9e, 0x04, 0xcf, 0x5d, 0xb5,
    0x90, 0xb7, 0x14, 0xba, 0x2f, 0xe3, 0x2c, 0xb1,
    0x59, 0x13, 0x3f, 0xc1, 0xc1, 0x92, 0xb7, 0x22,
    0x57, 0xfd, 0x07, 0xd3, 0x9c, 0xb0, 0x40, 0x1e,
]);

// Meteora DLMM: LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo
const METEORA_DLMM_BYTES = new Uint8Array([
    0x04, 0xe9, 0xe1, 0x2f, 0xbc, 0x84, 0xe8, 0x26,
    0xc9, 0x32, 0xcc, 0xe9, 0xe2, 0x64, 0x0c, 0xce,
    0x15, 0x59, 0x0c, 0x1c, 0x62, 0x73, 0xb0, 0x92,
    0x57, 0x08, 0xba, 0x3b, 0x85, 0x20, 0xb0, 0xbc,
]);

/**
 * Fast 32-byte comparison
 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== 32 || b.length !== 32) return false;
    for (let i = 0; i < 32; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/** Decode result */
export interface DecodeResult {
    success: boolean;
    pool?: PoolState;
    venue?: VenueId;
    error?: string;
}

/** Metrics for gate validation */
export interface DecodeMetrics {
    attempts: bigint;          // Accounts from target programs
    poolsIdentified: bigint;   // Passed discriminator/size check
    poolsDecoded: bigint;      // Successfully decoded
    poolDecodeFailed: bigint;  // Matched discriminator but decode failed
    skippedNonPool: bigint;    // Not a pool account (expected)
    byVenue: Map<VenueId, { attempts: bigint; identified: bigint; decoded: bigint }>;
}

let metrics: DecodeMetrics = {
    attempts: 0n,
    poolsIdentified: 0n,
    poolsDecoded: 0n,
    poolDecodeFailed: 0n,
    skippedNonPool: 0n,
    byVenue: new Map([
        [V.PumpSwap, { attempts: 0n, identified: 0n, decoded: 0n }],
        [V.RaydiumV4, { attempts: 0n, identified: 0n, decoded: 0n }],
        [V.RaydiumClmm, { attempts: 0n, identified: 0n, decoded: 0n }],
        [V.MeteoraDlmm, { attempts: 0n, identified: 0n, decoded: 0n }],
    ]),
};

/**
 * Decode account data to pool state
 * Routes to appropriate venue decoder based on owner
 */
export function decodeAccount(update: AccountUpdate): DecodeResult {
    metrics.attempts++;

    // Route by owner program
    if (bytesEqual(update.owner, PUMPSWAP_BYTES)) {
        return decodeVenue(V.PumpSwap, update, isPumpSwapPool, decodePumpSwapPool);
    }
    if (bytesEqual(update.owner, RAYDIUM_V4_BYTES)) {
        return decodeVenue(V.RaydiumV4, update, isRaydiumV4Pool, decodeRaydiumV4Pool);
    }
    if (bytesEqual(update.owner, RAYDIUM_CLMM_BYTES)) {
        return decodeVenue(V.RaydiumClmm, update, isRaydiumClmmPool, decodeRaydiumClmmPool);
    }
    if (bytesEqual(update.owner, METEORA_DLMM_BYTES)) {
        return decodeVenue(V.MeteoraDlmm, update, isMeteoraDlmmPool, decodeMeteoraDlmmPool);
    }

    // Unknown owner - not a target program
    return { success: false, error: 'not_target_program' };
}

/**
 * Decode with venue-specific decoder
 */
function decodeVenue(
    venue: VenueId,
    update: AccountUpdate,
    isPool: (data: Uint8Array) => boolean,
    decode: (pubkey: Uint8Array, data: Uint8Array) => PoolState | null
): DecodeResult {
    const venueMetrics = metrics.byVenue.get(venue)!;
    venueMetrics.attempts++;

    // Fast discriminator/size check
    if (!isPool(update.data)) {
        // Not a pool account - this is expected (TickArrays, BinArrays, etc.)
        metrics.skippedNonPool++;
        return { success: false, venue, error: 'not_pool_account' };
    }

    // Account IS a pool - try to decode
    metrics.poolsIdentified++;
    venueMetrics.identified++;

    const pool = decode(update.pubkey, update.data);
    if (pool) {
        metrics.poolsDecoded++;
        venueMetrics.decoded++;
        return { success: true, pool, venue };
    }

    // Discriminator matched but decode failed - this IS an error
    metrics.poolDecodeFailed++;
    return { success: false, venue, error: 'decode_failed' };
}

/**
 * Check if owner is a target program
 */
export function isTargetProgram(owner: Uint8Array): boolean {
    return bytesEqual(owner, PUMPSWAP_BYTES) ||
        bytesEqual(owner, RAYDIUM_V4_BYTES) ||
        bytesEqual(owner, RAYDIUM_CLMM_BYTES) ||
        bytesEqual(owner, METEORA_DLMM_BYTES);
}

/**
 * Get venue for owner
 */
export function getVenueForOwner(owner: Uint8Array): VenueId | null {
    if (bytesEqual(owner, PUMPSWAP_BYTES)) return V.PumpSwap;
    if (bytesEqual(owner, RAYDIUM_V4_BYTES)) return V.RaydiumV4;
    if (bytesEqual(owner, RAYDIUM_CLMM_BYTES)) return V.RaydiumClmm;
    if (bytesEqual(owner, METEORA_DLMM_BYTES)) return V.MeteoraDlmm;
    return null;
}

/**
 * Get decode metrics
 */
export function getDecodeMetrics(): DecodeMetrics {
    return metrics;
}

/**
 * Reset metrics
 */
export function resetDecodeMetrics(): void {
    metrics = {
        attempts: 0n,
        poolsIdentified: 0n,
        poolsDecoded: 0n,
        poolDecodeFailed: 0n,
        skippedNonPool: 0n,
        byVenue: new Map([
            [V.PumpSwap, { attempts: 0n, identified: 0n, decoded: 0n }],
            [V.RaydiumV4, { attempts: 0n, identified: 0n, decoded: 0n }],
            [V.RaydiumClmm, { attempts: 0n, identified: 0n, decoded: 0n }],
            [V.MeteoraDlmm, { attempts: 0n, identified: 0n, decoded: 0n }],
        ]),
    };
}

/**
 * Calculate decode success rate (of identified pools, not all accounts)
 */
export function getDecodeSuccessRate(): number {
    if (metrics.poolsIdentified === 0n) return 1.0;
    return Number((metrics.poolsDecoded * 10000n) / metrics.poolsIdentified) / 10000;
}