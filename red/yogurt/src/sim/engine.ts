/**
 * Simulation Engine (Phase 5)
 *
 * Dispatches simulation requests to venue-specific math modules.
 * Handles single-hop and multi-hop simulations.
 *
 * Gate requirements:
 * - Sim accuracy: output within 0.1% of actual
 * - p99 < 500μs single-hop, p99 < 1.5ms multi-hop
 */

import type {
    SimInput,
    SimResult,
    MultiSimResult,
    PoolState,
    VenueId,
    SwapLeg,
    CacheEntry,
    TickArray,
    BinArray,
} from '../types.js';
import { VenueId as V, ErrorClass } from '../types.js';

// Import venue math modules
import { simulateConstantProduct } from './math/constantProduct.js';
import { simulateClmm } from './math/clmm.js';
import { simulateDlmm } from './math/dlmm.js';

// Import revenue logger
import { RevenueLogger } from '../execute/revenue.js';

// ============================================================================
// LATENCY INSTRUMENTATION
// ============================================================================

const MAX_LATENCY_SAMPLES = 10000;

/** Simulation latency metrics collector */
export interface SimLatencyMetrics {
    simLatencySamples: number[];      // microseconds - simulation execution time
    stalenessSamples: number[];       // milliseconds - age of pool state data
}

const simMetrics: SimLatencyMetrics = {
    simLatencySamples: [],
    stalenessSamples: [],
};

function recordSimLatency(latencyUs: number): void {
    simMetrics.simLatencySamples.push(latencyUs);
    if (simMetrics.simLatencySamples.length > MAX_LATENCY_SAMPLES) {
        simMetrics.simLatencySamples.shift();
    }
}

function recordStaleness(stalenessMs: number): void {
    // Only record valid staleness values (skip negative or absurdly large values)
    if (stalenessMs >= 0 && stalenessMs < 60000) {
        simMetrics.stalenessSamples.push(stalenessMs);
        if (simMetrics.stalenessSamples.length > MAX_LATENCY_SAMPLES) {
            simMetrics.stalenessSamples.shift();
        }
    }
}

/**
 * Get current simulation latency metrics
 * Returns copies to avoid mutation
 */
export function getSimLatencyMetrics(): SimLatencyMetrics {
    return {
        simLatencySamples: [...simMetrics.simLatencySamples],
        stalenessSamples: [...simMetrics.stalenessSamples],
    };
}

/**
 * Clear simulation latency metrics
 */
export function clearSimLatencyMetrics(): void {
    simMetrics.simLatencySamples.length = 0;
    simMetrics.stalenessSamples.length = 0;
}

/**
 * Simulate single swap
 */
export function simulate(input: SimInput): SimResult {
    const startNs = process.hrtime.bigint();

    try {
        let result: SimResult;

        switch (input.venue) {
            case V.PumpSwap:
            case V.RaydiumV4:
                result = simulateConstantProduct(input);
                break;

            case V.RaydiumClmm:
                // FIX 4: No defensive guards — caller guarantees topology complete
                // Snapshot builder gates simulation; if we're here, arrays exist
                result = simulateClmm(input, input.tickArrays!);
                break;

            case V.MeteoraDlmm:
                // FIX 4: No defensive guards — caller guarantees topology complete
                // Snapshot builder gates simulation; if we're here, arrays exist
                result = simulateDlmm(input, input.binArrays!);
                break;

            default:
                return {
                    success: false,
                    outputAmount: 0n,
                    newPoolState: input.poolState,
                    priceImpactBps: 0,
                    feePaid: 0n,
                    error: ErrorClass.Unknown,
                    latencyUs: Number(process.hrtime.bigint() - startNs) / 1000,
                };
        }

        const latencyUs = Number(process.hrtime.bigint() - startNs) / 1000;
        result.latencyUs = latencyUs;

        // Record simulation latency for instrumentation
        recordSimLatency(latencyUs);

        return result;

    } catch (e) {
        const latencyUs = Number(process.hrtime.bigint() - startNs) / 1000;
        recordSimLatency(latencyUs);
        return {
            success: false,
            outputAmount: 0n,
            newPoolState: input.poolState,
            priceImpactBps: 0,
            feePaid: 0n,
            error: ErrorClass.Unknown,
            latencyUs,
        };
    }
}

/** Options for multi-hop simulation */
export interface MultiHopOptions {
    /** Slot number for revenue logging */
    slot?: number;
}

/**
 * Simulate multi-hop swap (sequential)
 * Each leg uses the output of the previous as input
 */
export function simulateMultiHop(
    legs: SwapLeg[],
    poolStates: Map<string, CacheEntry<PoolState>>,
    tickArrays: Map<string, CacheEntry<TickArray>[]>,
    binArrays: Map<string, CacheEntry<BinArray>[]>,
    options?: MultiHopOptions
): MultiSimResult {
    const startNs = process.hrtime.bigint();
    const results: SimResult[] = [];

    let currentInput = legs[0]?.inputAmount ?? 0n;

    // Clone pool states for mutation during simulation
    const workingStates = new Map(poolStates);

    for (const leg of legs) {
        const poolKey = toKey(leg.pool);
        const poolEntry = workingStates.get(poolKey);

        if (!poolEntry) {
            return {
                success: false,
                legs: results,
                netInput: legs[0]?.inputAmount ?? 0n,
                netOutput: 0n,
                totalLatencyUs: Number(process.hrtime.bigint() - startNs) / 1000,
            };
        }

        // Calculate staleness: how old is the pool state data
        // updatedAtNs is from process.hrtime.bigint(), convert to ms age
        const currentNs = process.hrtime.bigint();
        const ageNs = currentNs - poolEntry.updatedAtNs;
        const stalenessMs = Number(ageNs) / 1e6;
        recordStaleness(stalenessMs);

        const simInput: SimInput = {
            pool: leg.pool,
            venue: leg.venue,
            direction: leg.direction,
            inputAmount: currentInput,
            poolState: poolEntry.state,
            tickArrays: tickArrays.get(poolKey)?.map(e => e.state),
            binArrays: binArrays.get(poolKey)?.map(e => e.state),
            sqrtPriceLimitX64: leg.sqrtPriceLimitX64,
        };

        const result = simulate(simInput);
        results.push(result);

        if (!result.success) {
            return {
                success: false,
                legs: results,
                netInput: legs[0]?.inputAmount ?? 0n,
                netOutput: 0n,
                totalLatencyUs: Number(process.hrtime.bigint() - startNs) / 1000,
            };
        }

        // Update working state for next leg
        workingStates.set(poolKey, {
            ...poolEntry,
            state: result.newPoolState,
        });

        // Output of this leg is input to next
        currentInput = result.outputAmount;
    }

    const netInput = legs[0]?.inputAmount ?? 0n;
    const netOutput = currentInput;
    const totalLatencyUs = Number(process.hrtime.bigint() - startNs) / 1000;

    // Log profitable opportunities if slot is provided
    if (options?.slot !== undefined && netOutput > netInput) {
        // Extract route (all mints in order: inputMint of first leg, then all outputMints)
        const route: Uint8Array[] = [];
        if (legs.length > 0) {
            route.push(legs[0].inputMint);
            for (const leg of legs) {
                route.push(leg.outputMint);
            }
        }

        // Extract venues from legs
        const venues = legs.map(leg => leg.venue);

        RevenueLogger.logMultiHop({
            slot: options.slot,
            venues,
            route,
            inputAmount: netInput,
            outputAmount: netOutput,
            totalLatencyUs,
        });
    }

    return {
        success: true,
        legs: results,
        netInput,
        netOutput,
        totalLatencyUs,
    };
}

function toKey(pubkey: Uint8Array): string {
    let key = '';
    for (let i = 0; i < 32; i++) {
        key += pubkey[i].toString(16).padStart(2, '0');
    }
    return key;
}