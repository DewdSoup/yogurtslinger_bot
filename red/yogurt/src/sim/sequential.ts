/**
 * Sequential Multi-Hop Simulator (Phase 5)
 * 
 * Applies swap deltas sequentially across multiple legs.
 * Uses cumulative state mutations for accurate multi-hop simulation.
 */

import type {
    SwapLeg,
    PoolState,
    SimResult,
    MultiSimResult,
    CacheEntry,
    TickArray,
    BinArray,
} from '../types.js';
import { simulate } from './engine.js';

export { simulateMultiHop, type MultiHopOptions } from './engine.js';

/**
 * Validate multi-hop path
 * - Check token continuity (output of leg N = input of leg N+1)
 * - Check for circular paths
 */
export function validatePath(legs: SwapLeg[]): { valid: boolean; error?: string } {
    if (legs.length === 0) {
        return { valid: false, error: 'Empty path' };
    }

    if (legs.length === 1) {
        return { valid: true };
    }

    // Check for placeholder mints (all zeros from failed pool lookup)
    // If any leg has placeholder mints, we can't validate the path
    for (let i = 0; i < legs.length; i++) {
        if (isPlaceholderMint(legs[i].inputMint) || isPlaceholderMint(legs[i].outputMint)) {
            return {
                valid: false,
                error: `Leg ${i} has placeholder mint (pool lookup failed)`,
            };
        }
    }

    // Check token continuity
    for (let i = 0; i < legs.length - 1; i++) {
        const currentOutput = legs[i].outputMint;
        const nextInput = legs[i + 1].inputMint;

        if (!pubkeyEquals(currentOutput, nextInput)) {
            return {
                valid: false,
                error: `Token discontinuity at leg ${i}: output ${toHex(currentOutput)} != input ${toHex(nextInput)}`,
            };
        }
    }

    return { valid: true };
}

/**
 * Check if path is profitable
 * Compares final output to initial input in same token terms
 */
export function isPathProfitable(
    legs: SwapLeg[],
    simResult: MultiSimResult,
    minProfitBps: number = 0
): { profitable: boolean; profitBps: number } {
    if (!simResult.success) {
        return { profitable: false, profitBps: -10000 };
    }

    // Check if circular (same input/output token)
    const firstInput = legs[0].inputMint;
    const lastOutput = legs[legs.length - 1].outputMint;

    if (!pubkeyEquals(firstInput, lastOutput)) {
        // Non-circular path - can't directly compare
        return { profitable: false, profitBps: 0 };
    }

    // Calculate profit in basis points
    const profitBps = Number(
        ((simResult.netOutput - simResult.netInput) * 10000n) / simResult.netInput
    );

    return {
        profitable: profitBps >= minProfitBps,
        profitBps,
    };
}

/**
 * Calculate required input for target output
 * Works backwards through path
 */
export function calculateRequiredInput(
    legs: SwapLeg[],
    targetOutput: bigint,
    poolStates: Map<string, CacheEntry<PoolState>>
): { success: boolean; requiredInput?: bigint; error?: string } {
    // TODO: Implement reverse calculation
    // Start from target output, work backwards through each leg
    throw new Error('calculateRequiredInput not implemented');
}

// Utility functions
function pubkeyEquals(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== 32 || b.length !== 32) return false;
    for (let i = 0; i < 32; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function isPlaceholderMint(mint: Uint8Array): boolean {
    // Check if mint is all zeros (placeholder from failed pool lookup)
    if (mint.length !== 32) return true;
    for (let i = 0; i < 32; i++) {
        if (mint[i] !== 0) return false;
    }
    return true;
}

function toHex(buf: Uint8Array): string {
    return Buffer.from(buf).toString('hex');
}