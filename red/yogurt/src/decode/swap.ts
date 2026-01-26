/**
 * Swap Instruction Decoder (Phase 5)
 *
 * Extracts ordered swap legs from decoded transactions.
 * Routes to venue-specific instruction decoders.
 *
 * Gate requirements:
 * - Decode coverage ≥99% of swap txs
 */

import type {
    DecodedTx,
    SwapLeg,
    VenueId,
    CompiledInstruction
} from '../types.js';
import { PROGRAM_IDS, VenueId as V } from '../types.js';

import {
    decodePumpSwapInstruction,
    isPumpSwapSwap
} from './programs/pumpswap.js';
import {
    decodeRaydiumV4Instruction,
    decodeRaydiumV4InstructionWithPool,
    isRaydiumV4Swap
} from './programs/raydiumV4.js';
import type { PoolState, RaydiumV4Pool, RaydiumClmmPool } from '../types.js';
import {
    decodeRaydiumClmmInstruction,
    decodeRaydiumClmmInstructionWithPool,
    isRaydiumClmmSwap
} from './programs/raydiumClmm.js';
import {
    decodeMeteoraDlmmInstruction,
    isMeteoraDlmmSwap
} from './programs/meteoraDlmm.js';

// Pre-computed program ID bytes for fast comparison (avoid base58 in hot path)
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

export interface SwapDecodeResult {
    success: boolean;
    legs: SwapLeg[];
    error?: string;
}

/** Metrics for gate validation */
export interface SwapDecodeMetrics {
    txsProcessed: bigint;
    txsWithSwaps: bigint;
    swapLegsDecoded: bigint;
    decodeFailures: bigint;
    byVenue: Map<VenueId, bigint>;
}

let metrics: SwapDecodeMetrics = {
    txsProcessed: 0n,
    txsWithSwaps: 0n,
    swapLegsDecoded: 0n,
    decodeFailures: 0n,
    byVenue: new Map([
        [V.PumpSwap, 0n],
        [V.RaydiumV4, 0n],
        [V.RaydiumClmm, 0n],
        [V.MeteoraDlmm, 0n],
    ]),
};

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

/**
 * Get venue from program ID bytes (fast path)
 */
function getVenueFromProgramId(programId: Uint8Array): VenueId | null {
    if (bytesEqual(programId, PUMPSWAP_BYTES)) return V.PumpSwap;
    if (bytesEqual(programId, RAYDIUM_V4_BYTES)) return V.RaydiumV4;
    if (bytesEqual(programId, RAYDIUM_CLMM_BYTES)) return V.RaydiumClmm;
    if (bytesEqual(programId, METEORA_DLMM_BYTES)) return V.MeteoraDlmm;
    return null;
}

/**
 * Check if instruction data matches any swap discriminator (fast pre-filter)
 */
function isSwapInstruction(data: Uint8Array): boolean {
    return isPumpSwapSwap(data) ||
        isRaydiumV4Swap(data) ||
        isRaydiumClmmSwap(data) ||
        isMeteoraDlmmSwap(data);
}

/** Pool lookup function type - returns pool state if found */
export type PoolLookupFn = (poolPubkey: Uint8Array) => PoolState | null;

/**
 * Decode swap instruction based on venue
 * @param poolLookup Optional pool cache lookup for venues that need pool state (V4)
 */
function decodeSwapByVenue(
    venue: VenueId,
    instruction: CompiledInstruction,
    accountKeys: Uint8Array[],
    poolLookup?: PoolLookupFn
): SwapLeg | null {
    switch (venue) {
        case V.PumpSwap:
            return decodePumpSwapInstruction(instruction, accountKeys);
        case V.RaydiumV4: {
            // For V4, we need pool state to get correct mints and direction
            // Without pool state, mints will be placeholder zeros
            if (poolLookup) {
                // Get pool pubkey from instruction accounts (IDX_AMM = 1)
                const ammIdx = instruction.accountKeyIndexes[1];
                if (ammIdx !== undefined) {
                    const poolPubkey = accountKeys[ammIdx];
                    if (poolPubkey) {
                        const poolState = poolLookup(poolPubkey);
                        if (poolState && poolState.venue === V.RaydiumV4) {
                            return decodeRaydiumV4InstructionWithPool(
                                instruction,
                                accountKeys,
                                poolState as RaydiumV4Pool
                            );
                        }
                    }
                }
            }
            // Fallback to placeholder mints if no pool lookup available
            return decodeRaydiumV4Instruction(instruction, accountKeys);
        }
        case V.RaydiumClmm: {
            // CLMM direction depends on token0/token1 mints in pool state.
            // If we have a pool lookup, decode with pool for accurate direction.
            if (poolLookup) {
                // For CLMM swap_v2, poolState account is at index 2.
                const poolIdx = instruction.accountKeyIndexes[2];
                if (poolIdx !== undefined) {
                    const poolPubkey = accountKeys[poolIdx];
                    if (poolPubkey) {
                        const poolState = poolLookup(poolPubkey);
                        if (poolState && poolState.venue === V.RaydiumClmm) {
                            return decodeRaydiumClmmInstructionWithPool(
                                instruction,
                                accountKeys,
                                poolState as RaydiumClmmPool
                            );
                        }
                    }
                }
            }
            return decodeRaydiumClmmInstruction(instruction, accountKeys);
        }
        case V.MeteoraDlmm:
            return decodeMeteoraDlmmInstruction(instruction, accountKeys);
        default:
            return null;
    }
}

/**
 * Extract all swap legs from a decoded transaction
 * Returns legs in instruction order (for sequential simulation)
 *
 * @param tx - Decoded transaction with resolved account keys
 * @param instructions - Compiled instructions (outer instructions from message)
 * @param poolLookup - Optional pool cache lookup for venues that need pool state (V4)
 */
export function extractSwapLegs(
    tx: DecodedTx,
    instructions: CompiledInstruction[],
    poolLookup?: PoolLookupFn
): SwapDecodeResult {
    metrics.txsProcessed++;
    const legs: SwapLeg[] = [];

    for (const ix of instructions) {
        // Get program ID
        const programId = tx.accountKeys[ix.programIdIndex];
        if (!programId) continue;

        // Check if target venue
        const venue = getVenueFromProgramId(programId);
        if (venue === null) continue;

        // Fast discriminator check before full decode
        if (!isSwapInstruction(ix.data)) continue;

        // Decode (pass pool lookup for V4)
        const leg = decodeSwapByVenue(venue, ix, tx.accountKeys, poolLookup);
        if (leg) {
            legs.push(leg);
            metrics.swapLegsDecoded++;
            const venueCount = metrics.byVenue.get(venue) ?? 0n;
            metrics.byVenue.set(venue, venueCount + 1n);
        } else {
            metrics.decodeFailures++;
        }
    }

    if (legs.length > 0) {
        metrics.txsWithSwaps++;
    }

    return {
        success: legs.length > 0,
        legs,
    };
}

/**
 * Extract swap legs from DecodedTx (convenience wrapper)
 * Parses instructions from tx message if not provided
 */
export function extractSwapLegsFromTx(tx: DecodedTx): SwapDecodeResult {
    // tx.legs is populated by this function
    // Instructions need to be parsed from the message
    // For now, return empty - caller should provide instructions
    return {
        success: false,
        legs: [],
        error: 'Instructions must be provided separately',
    };
}

/**
 * Check if transaction contains any swap instructions
 * Fast path to skip non-swap transactions without full decode
 */
export function hasSwapInstructions(
    instructions: CompiledInstruction[],
    accountKeys: Uint8Array[]
): boolean {
    for (const ix of instructions) {
        const programId = accountKeys[ix.programIdIndex];
        if (!programId) continue;

        // Check if target venue
        if (getVenueFromProgramId(programId) === null) continue;

        // Check discriminator
        if (isSwapInstruction(ix.data)) return true;
    }
    return false;
}

/**
 * Get decode metrics
 */
export function getSwapDecodeMetrics(): SwapDecodeMetrics {
    return metrics;
}

/**
 * Reset metrics
 */
export function resetSwapDecodeMetrics(): void {
    metrics = {
        txsProcessed: 0n,
        txsWithSwaps: 0n,
        swapLegsDecoded: 0n,
        decodeFailures: 0n,
        byVenue: new Map([
            [V.PumpSwap, 0n],
            [V.RaydiumV4, 0n],
            [V.RaydiumClmm, 0n],
            [V.MeteoraDlmm, 0n],
        ]),
    };
}

/**
 * Calculate decode success rate
 */
export function getSwapDecodeSuccessRate(): number {
    const total = metrics.swapLegsDecoded + metrics.decodeFailures;
    if (total === 0n) return 1.0;
    return Number((metrics.swapLegsDecoded * 10000n) / total) / 10000;
}