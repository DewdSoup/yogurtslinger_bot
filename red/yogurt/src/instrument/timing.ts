/**
 * Timing Instrumentation (Phase 7)
 * 
 * Captures t0-t4 timestamps for latency measurement.
 * 
 * Timing boundaries (pending path):
 *   t0: Shred UDP recv (kernel timestamp)
 *   t1: Tx decoded (accounts resolved, instructions parsed)
 *   t2: Sim complete
 *   t3: Decision rendered (opportunity or skip)
 *   t4: Bundle bytes ready
 */

import type { TimingTrace, LatencyHistogram } from '../types.js';

/**
 * Timing context for a single transaction
 */
export class TxTiming {
    signature: Uint8Array;
    t0_recvNs: bigint = 0n;
    t1_decodeNs: bigint = 0n;
    t2_simNs: bigint = 0n;
    t3_decisionNs: bigint = 0n;
    t4_bundleNs: bigint = 0n;
    isOpportunity: boolean = false;

    constructor(signature: Uint8Array) {
        this.signature = signature;
    }

    markRecv(): void {
        this.t0_recvNs = process.hrtime.bigint();
    }

    markDecode(): void {
        this.t1_decodeNs = process.hrtime.bigint();
    }

    markSim(): void {
        this.t2_simNs = process.hrtime.bigint();
    }

    markDecision(isOpportunity: boolean): void {
        this.t3_decisionNs = process.hrtime.bigint();
        this.isOpportunity = isOpportunity;
    }

    markBundle(): void {
        this.t4_bundleNs = process.hrtime.bigint();
    }

    toTrace(): TimingTrace {
        return {
            signature: this.signature,
            t0_recvNs: this.t0_recvNs,
            t1_decodeNs: this.t1_decodeNs,
            t2_simNs: this.t2_simNs,
            t3_decisionNs: this.t3_decisionNs,
            t4_bundleNs: this.isOpportunity ? this.t4_bundleNs : undefined,
            isOpportunity: this.isOpportunity,
        };
    }

    // Latency getters (microseconds)
    get decodeLatencyUs(): number {
        return Number(this.t1_decodeNs - this.t0_recvNs) / 1000;
    }

    get simLatencyUs(): number {
        return Number(this.t2_simNs - this.t1_decodeNs) / 1000;
    }

    get decisionLatencyUs(): number {
        return Number(this.t3_decisionNs - this.t2_simNs) / 1000;
    }

    get bundleLatencyUs(): number {
        return Number(this.t4_bundleNs - this.t3_decisionNs) / 1000;
    }

    get totalLatencyUs(): number {
        const end = this.isOpportunity ? this.t4_bundleNs : this.t3_decisionNs;
        return Number(end - this.t0_recvNs) / 1000;
    }
}

/**
 * Histogram accumulator for latency measurements
 */
export class LatencyAccumulator {
    private samples: number[] = [];
    private maxSamples: number;

    constructor(maxSamples: number = 10000) {
        this.maxSamples = maxSamples;
    }

    add(latencyUs: number): void {
        if (this.samples.length >= this.maxSamples) {
            // Circular buffer - overwrite oldest
            this.samples.shift();
        }
        this.samples.push(latencyUs);
    }

    getHistogram(): LatencyHistogram {
        if (this.samples.length === 0) {
            return { count: 0, p50Us: 0, p95Us: 0, p99Us: 0, maxUs: 0 };
        }

        const sorted = [...this.samples].sort((a, b) => a - b);
        const count = sorted.length;

        return {
            count,
            p50Us: sorted[Math.floor(count * 0.50)] ?? 0,
            p95Us: sorted[Math.floor(count * 0.95)] ?? 0,
            p99Us: sorted[Math.floor(count * 0.99)] ?? 0,
            maxUs: sorted[count - 1] ?? 0,
        };
    }

    clear(): void {
        this.samples = [];
    }
}

/**
 * Global timing collector
 */
export class TimingCollector {
    private decodeLatency = new LatencyAccumulator();
    private simLatency = new LatencyAccumulator();
    private decisionLatency = new LatencyAccumulator();
    private bundleLatency = new LatencyAccumulator();
    private totalLatency = new LatencyAccumulator();

    record(timing: TxTiming): void {
        this.decodeLatency.add(timing.decodeLatencyUs);
        this.simLatency.add(timing.simLatencyUs);
        this.decisionLatency.add(timing.decisionLatencyUs);

        if (timing.isOpportunity) {
            this.bundleLatency.add(timing.bundleLatencyUs);
        }

        this.totalLatency.add(timing.totalLatencyUs);
    }

    getHistograms() {
        return {
            decode: this.decodeLatency.getHistogram(),
            sim: this.simLatency.getHistogram(),
            decision: this.decisionLatency.getHistogram(),
            bundle: this.bundleLatency.getHistogram(),
            total: this.totalLatency.getHistogram(),
        };
    }

    /**
     * Check if latencies meet Phase 7 gates
     */
    checkGates(): {
        passing: boolean;
        violations: string[];
    } {
        const h = this.getHistograms();
        const violations: string[] = [];

        if (h.decode.p99Us > 200) {
            violations.push(`decode p99 ${h.decode.p99Us}μs > 200μs`);
        }
        if (h.sim.p99Us > 500) {
            violations.push(`sim p99 ${h.sim.p99Us}μs > 500μs (single-hop target)`);
        }
        if (h.decision.p99Us > 50) {
            violations.push(`decision p99 ${h.decision.p99Us}μs > 50μs`);
        }
        if (h.bundle.p99Us > 200) {
            violations.push(`bundle p99 ${h.bundle.p99Us}μs > 200μs`);
        }
        if (h.total.p99Us > 1000) {
            violations.push(`total p99 ${h.total.p99Us}μs > 1000μs`);
        }

        return {
            passing: violations.length === 0,
            violations,
        };
    }

    clear(): void {
        this.decodeLatency.clear();
        this.simLatency.clear();
        this.decisionLatency.clear();
        this.bundleLatency.clear();
        this.totalLatency.clear();
    }
}

/**
 * Create timing collector instance
 */
export function createTimingCollector(): TimingCollector {
    return new TimingCollector();
}