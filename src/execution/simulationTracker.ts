// src/execution/simulationTracker.ts
// ═══════════════════════════════════════════════════════════════════════════════
// SIMULATION TRACKER - Performance Metrics for Pre-Live Validation
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:
//   Track local simulation performance before going live.
//   Run with `pnpm run ingest` to collect metrics, review logs to validate accuracy.
//
// METRICS TRACKED:
//   - Per-venue simulation accuracy (CPMM vs CLMM vs DLMM)
//   - Latency histograms (detection → simulation → decision)
//   - Confidence distribution per trade
//   - Profit estimation accuracy (when paper trading)
//   - Rejection reasons breakdown
//
// OUTPUT:
//   - Real-time console logs with emojis for quick scanning
//   - JSON summaries every N opportunities
//   - CSV export for spreadsheet analysis
//
// ═══════════════════════════════════════════════════════════════════════════════

import { appendFileSync, existsSync, mkdirSync } from "node:fs";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type VenueType = "PumpSwap" | "Raydium" | "RaydiumCLMM" | "Meteora";
export type SimMethod = "cpmm" | "clmm" | "dlmm" | "mixed";
export type TradeOutcome = "approved" | "rejected" | "executed" | "failed";

export interface SimulationRecord {
    timestamp: number;
    tokenMint: string;
    buyVenue: VenueType;
    sellVenue: VenueType;
    method: SimMethod;

    // Timing (all in ms)
    detectionLatencyMs: number;
    simulationLatencyMs: number;
    totalLatencyMs: number;

    // Amounts
    inputLamports: bigint;
    expectedTokens: bigint;
    expectedSolOut: bigint;
    expectedProfitLamports: bigint;
    expectedProfitBps: number;

    // Quality
    confidence: number;
    buyPriceImpactBps: number;
    sellPriceImpactBps: number;

    // Outcome
    outcome: TradeOutcome;
    rejectionReason: string | null;

    // Liquidity context
    buyLiquiditySol: number;
    sellLiquiditySol: number;

    // For accuracy tracking (filled in after execution)
    actualProfitLamports: bigint | null;
    accuracyPercent: number | null;
}

export interface VenueStats {
    simulations: number;
    approved: number;
    rejected: number;
    executed: number;
    failed: number;
    totalProfitEstimated: bigint;
    totalProfitActual: bigint;
    avgConfidence: number;
    avgSimulationMs: number;
    avgPriceImpactBps: number;
    accuracySamples: number;
    avgAccuracyPercent: number;
}

export interface TrackerSummary {
    startTime: number;
    endTime: number;
    totalOpportunities: number;
    totalApproved: number;
    totalRejected: number;
    totalExecuted: number;
    totalFailed: number;

    byVenuePair: Map<string, VenueStats>;
    byMethod: Map<SimMethod, VenueStats>;

    rejectionReasons: Map<string, number>;

    estimatedProfitSol: number;
    actualProfitSol: number;
    avgAccuracyPercent: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRACKER STATE
// ═══════════════════════════════════════════════════════════════════════════════

interface TrackerState {
    enabled: boolean;
    logDir: string;
    csvPath: string;
    jsonPath: string;
    consoleLogLevel: "verbose" | "normal" | "quiet";

    records: SimulationRecord[];
    maxRecords: number;

    startTime: number;
    lastSummaryTime: number;
    summaryIntervalMs: number;

    // Running stats
    totalOpportunities: number;
    totalApproved: number;
    totalRejected: number;
    totalExecuted: number;
    totalFailed: number;

    byVenuePair: Map<string, VenueStats>;
    byMethod: Map<SimMethod, VenueStats>;
    rejectionReasons: Map<string, number>;

    latencyBuckets: number[];
    confidenceBuckets: number[];
}

function createEmptyStats(): VenueStats {
    return {
        simulations: 0,
        approved: 0,
        rejected: 0,
        executed: 0,
        failed: 0,
        totalProfitEstimated: 0n,
        totalProfitActual: 0n,
        avgConfidence: 0,
        avgSimulationMs: 0,
        avgPriceImpactBps: 0,
        accuracySamples: 0,
        avgAccuracyPercent: 0,
    };
}

const state: TrackerState = {
    enabled: true,
    logDir: "./logs/simulation",
    csvPath: "./logs/simulation/simulations.csv",
    jsonPath: "./logs/simulation/summary.json",
    consoleLogLevel: "normal",

    records: [],
    maxRecords: 10000,

    startTime: Date.now(),
    lastSummaryTime: Date.now(),
    summaryIntervalMs: 60000,

    totalOpportunities: 0,
    totalApproved: 0,
    totalRejected: 0,
    totalExecuted: 0,
    totalFailed: 0,

    byVenuePair: new Map(),
    byMethod: new Map(),
    rejectionReasons: new Map(),

    latencyBuckets: [0, 0, 0, 0, 0, 0],
    confidenceBuckets: [0, 0, 0, 0, 0],
};

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

export interface TrackerConfig {
    enabled?: boolean;
    logDir?: string;
    consoleLogLevel?: "verbose" | "normal" | "quiet";
    summaryIntervalMs?: number;
    maxRecords?: number;
}

export function initializeTracker(config: TrackerConfig = {}): void {
    state.enabled = config.enabled ?? true;
    state.logDir = config.logDir ?? "./logs/simulation";
    state.consoleLogLevel = config.consoleLogLevel ?? "normal";
    state.summaryIntervalMs = config.summaryIntervalMs ?? 60000;
    state.maxRecords = config.maxRecords ?? 10000;

    state.csvPath = `${state.logDir}/simulations.csv`;
    state.jsonPath = `${state.logDir}/summary.json`;

    state.startTime = Date.now();
    state.lastSummaryTime = Date.now();

    // Create log directory
    if (!existsSync(state.logDir)) {
        mkdirSync(state.logDir, { recursive: true });
    }

    // Initialize CSV with headers
    if (!existsSync(state.csvPath)) {
        const headers = [
            "timestamp",
            "tokenMint",
            "buyVenue",
            "sellVenue",
            "method",
            "detectionMs",
            "simulationMs",
            "totalMs",
            "inputSol",
            "expectedProfitSol",
            "expectedProfitBps",
            "confidence",
            "buyImpactBps",
            "sellImpactBps",
            "outcome",
            "rejectionReason",
            "buyLiqSol",
            "sellLiqSol",
            "actualProfitSol",
            "accuracyPct"
        ].join(",");
        appendFileSync(state.csvPath, headers + "\n");
    }

    log("📊 SimulationTracker initialized", "INFO");
    log(`   Log dir: ${state.logDir}`, "INFO");
    log(`   Console level: ${state.consoleLogLevel}`, "INFO");
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECORD TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

export function recordSimulation(record: SimulationRecord): void {
    if (!state.enabled) return;

    state.totalOpportunities++;

    // Update outcome counters
    switch (record.outcome) {
        case "approved":
            state.totalApproved++;
            break;
        case "rejected":
            state.totalRejected++;
            if (record.rejectionReason) {
                const count = state.rejectionReasons.get(record.rejectionReason) ?? 0;
                state.rejectionReasons.set(record.rejectionReason, count + 1);
            }
            break;
        case "executed":
            state.totalExecuted++;
            break;
        case "failed":
            state.totalFailed++;
            break;
    }

    // Update venue pair stats
    const venuePair = `${record.buyVenue}→${record.sellVenue}`;
    updateVenueStats(state.byVenuePair, venuePair, record);

    // Update method stats
    updateVenueStats(state.byMethod, record.method, record);

    // Update latency histogram
    updateLatencyBucket(record.simulationLatencyMs);

    // Update confidence histogram
    updateConfidenceBucket(record.confidence);

    // Store record
    state.records.push(record);
    if (state.records.length > state.maxRecords) {
        state.records.shift();
    }

    // Write to CSV
    writeRecordToCsv(record);

    // Console logging
    logRecord(record);

    // Periodic summary
    if (Date.now() - state.lastSummaryTime > state.summaryIntervalMs) {
        printSummary();
        state.lastSummaryTime = Date.now();
    }
}

function updateVenueStats(
    map: Map<string, VenueStats>,
    key: string,
    record: SimulationRecord
): void {
    let stats = map.get(key);
    if (!stats) {
        stats = createEmptyStats();
        map.set(key, stats);
    }

    stats.simulations++;

    switch (record.outcome) {
        case "approved": stats.approved++; break;
        case "rejected": stats.rejected++; break;
        case "executed": stats.executed++; break;
        case "failed": stats.failed++; break;
    }

    if (record.expectedProfitLamports > 0n) {
        stats.totalProfitEstimated += record.expectedProfitLamports;
    }

    if (record.actualProfitLamports !== null) {
        stats.totalProfitActual += record.actualProfitLamports;
        if (record.accuracyPercent !== null) {
            stats.accuracySamples++;
            stats.avgAccuracyPercent = (
                (stats.avgAccuracyPercent * (stats.accuracySamples - 1) + record.accuracyPercent) /
                stats.accuracySamples
            );
        }
    }

    // Rolling averages
    stats.avgConfidence = (
        (stats.avgConfidence * (stats.simulations - 1) + record.confidence) /
        stats.simulations
    );
    stats.avgSimulationMs = (
        (stats.avgSimulationMs * (stats.simulations - 1) + record.simulationLatencyMs) /
        stats.simulations
    );
    const avgImpact = (record.buyPriceImpactBps + record.sellPriceImpactBps) / 2;
    stats.avgPriceImpactBps = (
        (stats.avgPriceImpactBps * (stats.simulations - 1) + avgImpact) /
        stats.simulations
    );
}

function updateLatencyBucket(latencyMs: number): void {
    if (latencyMs < 1) state.latencyBuckets[0]!++;
    else if (latencyMs < 5) state.latencyBuckets[1]!++;
    else if (latencyMs < 10) state.latencyBuckets[2]!++;
    else if (latencyMs < 50) state.latencyBuckets[3]!++;
    else if (latencyMs < 100) state.latencyBuckets[4]!++;
    else state.latencyBuckets[5]!++;
}

function updateConfidenceBucket(confidence: number): void {
    if (confidence < 0.5) state.confidenceBuckets[0]!++;
    else if (confidence < 0.7) state.confidenceBuckets[1]!++;
    else if (confidence < 0.85) state.confidenceBuckets[2]!++;
    else if (confidence < 0.95) state.confidenceBuckets[3]!++;
    else state.confidenceBuckets[4]!++;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACCURACY TRACKING (Post-Execution)
// ═══════════════════════════════════════════════════════════════════════════════

export function recordActualProfit(
    tokenMint: string,
    timestamp: number,
    actualProfitLamports: bigint
): void {
    if (!state.enabled) return;

    // Find matching record
    const record = state.records.find(r =>
        r.tokenMint === tokenMint &&
        Math.abs(r.timestamp - timestamp) < 5000
    );

    if (!record) return;

    record.actualProfitLamports = actualProfitLamports;

    // Calculate accuracy
    if (record.expectedProfitLamports > 0n) {
        const expected = Number(record.expectedProfitLamports);
        const actual = Number(actualProfitLamports);
        record.accuracyPercent = (1 - Math.abs(actual - expected) / expected) * 100;
    }

    // Update venue stats
    const venuePair = `${record.buyVenue}→${record.sellVenue}`;
    const venueStats = state.byVenuePair.get(venuePair);
    if (venueStats) {
        venueStats.totalProfitActual += actualProfitLamports;
        if (record.accuracyPercent !== null) {
            venueStats.accuracySamples++;
            venueStats.avgAccuracyPercent = (
                (venueStats.avgAccuracyPercent * (venueStats.accuracySamples - 1) + record.accuracyPercent) /
                venueStats.accuracySamples
            );
        }
    }

    // Log accuracy
    if (state.consoleLogLevel !== "quiet") {
        const accuracy = record.accuracyPercent?.toFixed(1) ?? "N/A";
        const emoji = (record.accuracyPercent ?? 0) > 90 ? "✅" : (record.accuracyPercent ?? 0) > 70 ? "⚠️" : "❌";
        log(`${emoji} ACCURACY: ${tokenMint.slice(0, 8)}... | ` +
            `expected=${(Number(record.expectedProfitLamports) / 1e9).toFixed(6)} SOL | ` +
            `actual=${(Number(actualProfitLamports) / 1e9).toFixed(6)} SOL | ` +
            `accuracy=${accuracy}%`, "INFO");
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CSV OUTPUT
// ═══════════════════════════════════════════════════════════════════════════════

function writeRecordToCsv(record: SimulationRecord): void {
    const row = [
        new Date(record.timestamp).toISOString(),
        record.tokenMint.slice(0, 12),
        record.buyVenue,
        record.sellVenue,
        record.method,
        record.detectionLatencyMs.toFixed(2),
        record.simulationLatencyMs.toFixed(2),
        record.totalLatencyMs.toFixed(2),
        (Number(record.inputLamports) / 1e9).toFixed(6),
        (Number(record.expectedProfitLamports) / 1e9).toFixed(6),
        record.expectedProfitBps.toString(),
        record.confidence.toFixed(3),
        record.buyPriceImpactBps.toString(),
        record.sellPriceImpactBps.toString(),
        record.outcome,
        record.rejectionReason ?? "",
        record.buyLiquiditySol.toFixed(2),
        record.sellLiquiditySol.toFixed(2),
        record.actualProfitLamports !== null
            ? (Number(record.actualProfitLamports) / 1e9).toFixed(6)
            : "",
        record.accuracyPercent !== null
            ? record.accuracyPercent.toFixed(1)
            : ""
    ].join(",");

    appendFileSync(state.csvPath, row + "\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSOLE LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

function logRecord(record: SimulationRecord): void {
    if (state.consoleLogLevel === "quiet") return;

    const emoji = record.outcome === "approved" ? "✅" :
        record.outcome === "rejected" ? "⏭️" :
            record.outcome === "executed" ? "🎯" : "❌";

    const profitSol = Number(record.expectedProfitLamports) / 1e9;
    const confidence = (record.confidence * 100).toFixed(0);

    if (state.consoleLogLevel === "verbose" || record.outcome === "approved" || record.outcome === "executed") {
        log(
            `${emoji} ${record.outcome.toUpperCase()} | ` +
            `${record.tokenMint.slice(0, 8)}... | ` +
            `${record.buyVenue}→${record.sellVenue} | ` +
            `profit=${profitSol.toFixed(6)} SOL (${record.expectedProfitBps} bps) | ` +
            `conf=${confidence}% | ` +
            `sim=${record.simulationLatencyMs.toFixed(2)}ms` +
            (record.rejectionReason ? ` | reason: ${record.rejectionReason}` : ""),
            "INFO"
        );
    }
}

function log(message: string, level: "INFO" | "WARN" | "ERROR" = "INFO"): void {
    const timestamp = new Date().toISOString().slice(11, 23);
    console.log(`[${timestamp}] [TRACKER] [${level}] ${message}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUMMARY AND REPORTING
// ═══════════════════════════════════════════════════════════════════════════════

export function printSummary(): void {
    if (!state.enabled) return;

    const uptimeMs = Date.now() - state.startTime;
    const uptimeMin = (uptimeMs / 60000).toFixed(1);

    console.log("\n" + "═".repeat(70));
    console.log("📊 SIMULATION TRACKER SUMMARY");
    console.log("═".repeat(70));
    console.log(`Uptime: ${uptimeMin} min | Records: ${state.records.length}`);
    console.log(`Total: ${state.totalOpportunities} | Approved: ${state.totalApproved} | Rejected: ${state.totalRejected}`);
    console.log(`Executed: ${state.totalExecuted} | Failed: ${state.totalFailed}`);

    // Venue pair breakdown
    if (state.byVenuePair.size > 0) {
        console.log("\n--- By Venue Pair ---");
        for (const [pair, stats] of state.byVenuePair) {
            const approvalRate = stats.simulations > 0
                ? ((stats.approved / stats.simulations) * 100).toFixed(1)
                : "0.0";
            const profitSol = Number(stats.totalProfitEstimated) / 1e9;
            console.log(
                `  ${pair}: ${stats.simulations} sim | ` +
                `${approvalRate}% approved | ` +
                `~${profitSol.toFixed(4)} SOL profit | ` +
                `${stats.avgSimulationMs.toFixed(2)}ms avg | ` +
                `${(stats.avgConfidence * 100).toFixed(0)}% conf`
            );
        }
    }

    // Method breakdown
    if (state.byMethod.size > 0) {
        console.log("\n--- By Simulation Method ---");
        for (const [method, stats] of state.byMethod) {
            const accuracy = stats.accuracySamples > 0
                ? `${stats.avgAccuracyPercent.toFixed(1)}% accuracy (${stats.accuracySamples} samples)`
                : "no accuracy data";
            console.log(
                `  ${method}: ${stats.simulations} sim | ` +
                `${stats.avgSimulationMs.toFixed(2)}ms | ` +
                `${(stats.avgConfidence * 100).toFixed(0)}% conf | ` +
                `${accuracy}`
            );
        }
    }

    // Latency histogram
    console.log("\n--- Simulation Latency ---");
    const latencyLabels = ["<1ms", "1-5ms", "5-10ms", "10-50ms", "50-100ms", ">100ms"];
    const latencyBar = (count: number, total: number): string => {
        const pct = total > 0 ? (count / total) * 100 : 0;
        const bars = Math.round(pct / 5);
        return "█".repeat(bars) + "░".repeat(20 - bars) + ` ${pct.toFixed(1)}%`;
    };
    for (let i = 0; i < latencyLabels.length; i++) {
        console.log(`  ${latencyLabels[i]!.padEnd(10)} ${latencyBar(state.latencyBuckets[i] ?? 0, state.totalOpportunities)}`);
    }

    // Top rejection reasons
    if (state.rejectionReasons.size > 0) {
        console.log("\n--- Top Rejection Reasons ---");
        const sorted = Array.from(state.rejectionReasons.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);
        for (const [reason, count] of sorted) {
            const pct = state.totalRejected > 0 ? ((count / state.totalRejected) * 100).toFixed(1) : "0.0";
            console.log(`  ${reason}: ${count} (${pct}%)`);
        }
    }

    console.log("═".repeat(70) + "\n");
}

export function getSummary(): TrackerSummary {
    let totalEstimated = 0n;
    let totalActual = 0n;
    let totalAccuracy = 0;
    let accuracySamples = 0;

    for (const stats of state.byVenuePair.values()) {
        totalEstimated += stats.totalProfitEstimated;
        totalActual += stats.totalProfitActual;
        if (stats.accuracySamples > 0) {
            totalAccuracy += stats.avgAccuracyPercent * stats.accuracySamples;
            accuracySamples += stats.accuracySamples;
        }
    }

    return {
        startTime: state.startTime,
        endTime: Date.now(),
        totalOpportunities: state.totalOpportunities,
        totalApproved: state.totalApproved,
        totalRejected: state.totalRejected,
        totalExecuted: state.totalExecuted,
        totalFailed: state.totalFailed,
        byVenuePair: new Map(state.byVenuePair),
        byMethod: new Map(state.byMethod),
        rejectionReasons: new Map(state.rejectionReasons),
        estimatedProfitSol: Number(totalEstimated) / 1e9,
        actualProfitSol: Number(totalActual) / 1e9,
        avgAccuracyPercent: accuracySamples > 0 ? totalAccuracy / accuracySamples : 0,
    };
}

export function getTrackerStats(): {
    totalOpportunities: number;
    approved: number;
    rejected: number;
    executed: number;
    failed: number;
    approvalRate: number;
    avgSimulationMs: number;
} {
    let totalSimMs = 0;
    for (const r of state.records) {
        totalSimMs += r.simulationLatencyMs;
    }

    return {
        totalOpportunities: state.totalOpportunities,
        approved: state.totalApproved,
        rejected: state.totalRejected,
        executed: state.totalExecuted,
        failed: state.totalFailed,
        approvalRate: state.totalOpportunities > 0
            ? (state.totalApproved / state.totalOpportunities) * 100
            : 0,
        avgSimulationMs: state.records.length > 0
            ? totalSimMs / state.records.length
            : 0,
    };
}

export function resetTracker(): void {
    state.records = [];
    state.totalOpportunities = 0;
    state.totalApproved = 0;
    state.totalRejected = 0;
    state.totalExecuted = 0;
    state.totalFailed = 0;
    state.byVenuePair.clear();
    state.byMethod.clear();
    state.rejectionReasons.clear();
    state.latencyBuckets = [0, 0, 0, 0, 0, 0];
    state.confidenceBuckets = [0, 0, 0, 0, 0];
    state.startTime = Date.now();
    state.lastSummaryTime = Date.now();
}

export function isEnabled(): boolean {
    return state.enabled;
}

export function setEnabled(enabled: boolean): void {
    state.enabled = enabled;
}

export function setLogLevel(level: "verbose" | "normal" | "quiet"): void {
    state.consoleLogLevel = level;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    initializeTracker,
    recordSimulation,
    recordActualProfit,
    printSummary,
    getSummary,
    getTrackerStats,
    resetTracker,
    isEnabled,
    setEnabled,
    setLogLevel,
};