/**
 * Metrics Collection (Phase 0-8)
 * 
 * Centralized metrics for all phase gates.
 */

import type { Metrics, LatencyHistogram } from '../types.js';
import { TimingCollector } from './timing.js';

/**
 * Global metrics instance
 */
class MetricsCollector {
    // Phase 1 - Ingest
    accountUpdatesReceived = 0n;
    accountUpdatesProcessed = 0n;
    backpressureDrops = 0n;
    orderingViolations = 0n;

    // Phase 2 - Decode
    decodeSuccessCount = 0n;
    decodeFailureCount = 0n;
    cacheSize = 0;

    // Phase 4 - ALT + Pending
    altHits = 0n;
    altMisses = 0n;
    pendingTxsReceived = 0n;
    pendingTxsDecoded = 0n;

    // Phase 5 - Simulation
    simsExecuted = 0n;
    simsSucceeded = 0n;
    simsFailed = 0n;
    multiHopCount = 0n;

    // Phase 6 - Errors
    errorsClassified = 0n;
    errorsUnknown = 0n;

    // Phase 7 - Timing
    private timing = new TimingCollector();

    // Phase 8 - Execution
    bundlesSubmitted = 0n;
    bundlesLanded = 0n;
    bundlesFailed = 0n;

    // --- Increment methods ---

    incrAccountReceived(): void { this.accountUpdatesReceived++; }
    incrAccountProcessed(): void { this.accountUpdatesProcessed++; }
    incrBackpressureDrop(): void { this.backpressureDrops++; }
    incrOrderingViolation(): void { this.orderingViolations++; }

    incrDecodeSuccess(): void { this.decodeSuccessCount++; }
    incrDecodeFailure(): void { this.decodeFailureCount++; }
    setCacheSize(size: number): void { this.cacheSize = size; }

    incrAltHit(): void { this.altHits++; }
    incrAltMiss(): void { this.altMisses++; }
    incrPendingReceived(): void { this.pendingTxsReceived++; }
    incrPendingDecoded(): void { this.pendingTxsDecoded++; }

    incrSimExecuted(): void { this.simsExecuted++; }
    incrSimSuccess(): void { this.simsSucceeded++; }
    incrSimFailure(): void { this.simsFailed++; }
    incrMultiHop(): void { this.multiHopCount++; }

    incrErrorClassified(): void { this.errorsClassified++; }
    incrErrorUnknown(): void { this.errorsUnknown++; }

    incrBundleSubmitted(): void { this.bundlesSubmitted++; }
    incrBundleLanded(): void { this.bundlesLanded++; }
    incrBundleFailed(): void { this.bundlesFailed++; }

    // --- Timing ---

    getTimingCollector(): TimingCollector {
        return this.timing;
    }

    // --- Snapshot ---

    snapshot(): Metrics {
        const histograms = this.timing.getHistograms();

        return {
            accountUpdatesReceived: this.accountUpdatesReceived,
            accountUpdatesProcessed: this.accountUpdatesProcessed,
            backpressureDrops: this.backpressureDrops,
            orderingViolations: this.orderingViolations,

            decodeSuccessCount: this.decodeSuccessCount,
            decodeFailureCount: this.decodeFailureCount,
            cacheSize: this.cacheSize,

            altHits: this.altHits,
            altMisses: this.altMisses,
            pendingTxsReceived: this.pendingTxsReceived,
            pendingTxsDecoded: this.pendingTxsDecoded,

            simsExecuted: this.simsExecuted,
            simsSucceeded: this.simsSucceeded,
            simsFailed: this.simsFailed,
            multiHopCount: this.multiHopCount,

            errorsClassified: this.errorsClassified,
            errorsUnknown: this.errorsUnknown,

            decodeLatency: histograms.decode,
            simLatency: histograms.sim,
            decisionLatency: histograms.decision,
            bundleLatency: histograms.bundle,
            totalLatency: histograms.total,

            bundlesSubmitted: this.bundlesSubmitted,
            bundlesLanded: this.bundlesLanded,
            bundlesFailed: this.bundlesFailed,
        };
    }

    // --- Computed metrics ---

    decodeSuccessRate(): number {
        const total = this.decodeSuccessCount + this.decodeFailureCount;
        if (total === 0n) return 100;
        return Number((this.decodeSuccessCount * 10000n) / total) / 100;
    }

    altHitRate(): number {
        const total = this.altHits + this.altMisses;
        if (total === 0n) return 100;
        return Number((this.altHits * 10000n) / total) / 100;
    }

    simSuccessRate(): number {
        if (this.simsExecuted === 0n) return 100;
        return Number((this.simsSucceeded * 10000n) / this.simsExecuted) / 100;
    }

    errorClassificationRate(): number {
        const total = this.errorsClassified + this.errorsUnknown;
        if (total === 0n) return 100;
        return Number((this.errorsClassified * 10000n) / total) / 100;
    }

    bundleLandingRate(): number {
        if (this.bundlesSubmitted === 0n) return 0;
        return Number((this.bundlesLanded * 10000n) / this.bundlesSubmitted) / 100;
    }

    // --- Phase gate checks ---

    checkPhase1Gate(): { passing: boolean; violations: string[] } {
        const violations: string[] = [];
        if (this.backpressureDrops > 0n) {
            violations.push(`Backpressure drops: ${this.backpressureDrops}`);
        }
        if (this.orderingViolations > 0n) {
            violations.push(`Ordering violations: ${this.orderingViolations}`);
        }
        return { passing: violations.length === 0, violations };
    }

    checkPhase2Gate(): { passing: boolean; violations: string[] } {
        const violations: string[] = [];
        const rate = this.decodeSuccessRate();
        if (rate < 99.5) {
            violations.push(`Decode success rate ${rate}% < 99.5%`);
        }
        return { passing: violations.length === 0, violations };
    }

    checkPhase4Gate(): { passing: boolean; violations: string[] } {
        const violations: string[] = [];
        const rate = this.altHitRate();
        if (rate < 99.9) {
            violations.push(`ALT hit rate ${rate}% < 99.9%`);
        }
        return { passing: violations.length === 0, violations };
    }

    checkPhase5Gate(): { passing: boolean; violations: string[] } {
        const violations: string[] = [];
        const rate = this.simSuccessRate();
        if (rate < 99) {
            violations.push(`Sim success rate ${rate}% < 99%`);
        }
        return { passing: violations.length === 0, violations };
    }

    checkPhase6Gate(): { passing: boolean; violations: string[] } {
        const violations: string[] = [];
        const rate = this.errorClassificationRate();
        if (rate < 95) {
            violations.push(`Error classification rate ${rate}% < 95%`);
        }
        return { passing: violations.length === 0, violations };
    }

    // --- Reset ---

    reset(): void {
        this.accountUpdatesReceived = 0n;
        this.accountUpdatesProcessed = 0n;
        this.backpressureDrops = 0n;
        this.orderingViolations = 0n;
        this.decodeSuccessCount = 0n;
        this.decodeFailureCount = 0n;
        this.cacheSize = 0;
        this.altHits = 0n;
        this.altMisses = 0n;
        this.pendingTxsReceived = 0n;
        this.pendingTxsDecoded = 0n;
        this.simsExecuted = 0n;
        this.simsSucceeded = 0n;
        this.simsFailed = 0n;
        this.multiHopCount = 0n;
        this.errorsClassified = 0n;
        this.errorsUnknown = 0n;
        this.bundlesSubmitted = 0n;
        this.bundlesLanded = 0n;
        this.bundlesFailed = 0n;
        this.timing.clear();
    }
}

// Global singleton
export const metrics = new MetricsCollector();