// src/utils/arbLogger.ts
// =============================================================================
// ARBITRAGE LOGGER - Enhanced logging for rapid iteration
// =============================================================================
// Provides real-time insight into:
//   - Arb detection rates by venue pair
//   - Rejection reasons and frequency
//   - Spread distribution histograms
//   - Latency tracking
//   - Pool coverage and data quality metrics
//
// Usage:
//   import { arbLogger } from './utils/arbLogger.js';
//   arbLogger.logDetection(signal);
//   arbLogger.logRejection(tokenMint, reason, details);
//   arbLogger.printSummary(); // Call periodically (e.g., every 30s)

import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

// ============================================================================
// TYPES
// ============================================================================

export type VenueName = "PumpSwap" | "Raydium" | "RaydiumCLMM" | "Meteora";
export type VenuePair = `${VenueName}→${VenueName}`;

export interface DetectionEvent {
    ts: number;
    tokenMint: string;
    buyVenue: VenueName;
    sellVenue: VenueName;
    buyPrice: number;
    sellPrice: number;
    grossSpreadBps: number;
    netSpreadBps: number;
    buyPoolPubkey: string;
    sellPoolPubkey: string;
    latencyMs?: number | undefined;
}

export interface RejectionEvent {
    ts: number;
    tokenMint: string;
    reason: RejectionReason;
    venue?: VenueName | undefined;
    spreadBps?: number | undefined;
    details?: string | undefined;
}

export type RejectionReason =
    | "NO_SPREAD"           // Spread doesn't cover fees
    | "BELOW_THRESHOLD"     // Spread below min threshold
    | "STALE_DATA"          // Pool data too old
    | "MISSING_VAULT"       // Vault balance not in cache
    | "EMPTY_POOL"          // Zero reserves
    | "INACTIVE_POOL"       // Pool status != active
    | "SIMGATE_REJECT"      // SimGate unprofitable
    | "SIMGATE_ERROR"       // SimGate simulation failed
    | "EXECUTION_FAIL"      // Bundle/tx failed
    | "AGE_FILTER"          // Pool too new/old
    | "CONCURRENCY"         // Already processing
    | "UNKNOWN";

export interface ExecutionEvent {
    ts: number;
    tokenMint: string;
    buyVenue: VenueName;
    sellVenue: VenueName;
    inputLamports: bigint;
    expectedProfitLamports: bigint;
    actualProfitLamports?: bigint | undefined;
    status: "SUBMITTED" | "LANDED" | "FAILED";
    bundleId?: string | undefined;
    txSignature?: string | undefined;
    latencyMs: number;
    error?: string | undefined;
}

// ============================================================================
// METRICS TRACKING
// ============================================================================

interface VenuePairStats {
    detections: number;
    executions: number;
    successes: number;
    totalSpreadBps: number;
    maxSpreadBps: number;
    minSpreadBps: number;
}

interface RejectionStats {
    count: number;
    lastSeen: number;
    examples: string[]; // Last 3 token mints
}

// ============================================================================
// ARB LOGGER CLASS
// ============================================================================

class ArbLogger {
    private readonly startTs: number;
    private readonly logDir: string;
    private readonly detectionsFile: string;
    private readonly rejectionsFile: string;
    private readonly executionsFile: string;

    // Real-time metrics
    private venuePairStats: Map<VenuePair, VenuePairStats> = new Map();
    private rejectionStats: Map<RejectionReason, RejectionStats> = new Map();
    private spreadHistogram: Map<string, number> = new Map(); // "50-100" → count

    // Counters
    private totalDetections = 0;
    private totalRejections = 0;
    private totalExecutions = 0;
    private totalSuccesses = 0;
    private totalProfitLamports = 0n;
    private totalLossLamports = 0n;

    // Rolling window for rate calculation
    private recentDetections: number[] = []; // timestamps
    private recentRejections: number[] = [];

    // Pool coverage tracking
    private poolsWithPrices: Set<string> = new Set();
    private poolsMissingVaults: Set<string> = new Set();

    constructor(logDirPath: string = "data/arb_logs") {
        this.startTs = Date.now();
        this.logDir = logDirPath;

        // Create log directory
        if (!existsSync(this.logDir)) {
            mkdirSync(this.logDir, { recursive: true });
        }

        // Set up file paths with timestamp
        const runId = this.formatRunId();
        this.detectionsFile = join(this.logDir, `detections_${runId}.jsonl`);
        this.rejectionsFile = join(this.logDir, `rejections_${runId}.jsonl`);
        this.executionsFile = join(this.logDir, `executions_${runId}.jsonl`);

        // Initialize histogram buckets
        const buckets = ["0-25", "25-50", "50-75", "75-100", "100-150", "150-200", "200-300", "300+"];
        buckets.forEach(b => this.spreadHistogram.set(b, 0));

        console.log(`\n${"═".repeat(70)}`);
        console.log(`ARB LOGGER INITIALIZED`);
        console.log(`Log directory: ${this.logDir}`);
        console.log(`Run ID: ${runId}`);
        console.log(`${"═".repeat(70)}\n`);
    }

    private formatRunId(): string {
        const now = new Date();
        const pad = (n: number) => n.toString().padStart(2, "0");
        return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
    }

    // ========================================================================
    // LOGGING METHODS
    // ========================================================================

    /**
     * Log a detected arbitrage opportunity
     */
    logDetection(event: DetectionEvent): void {
        this.totalDetections++;
        const now = Date.now();
        this.recentDetections.push(now);
        this.cleanOldEntries(this.recentDetections, 60000); // Keep last 60s

        // Update venue pair stats
        const pair: VenuePair = `${event.buyVenue}→${event.sellVenue}`;
        const stats = this.venuePairStats.get(pair) ?? {
            detections: 0,
            executions: 0,
            successes: 0,
            totalSpreadBps: 0,
            maxSpreadBps: 0,
            minSpreadBps: Infinity,
        };

        stats.detections++;
        stats.totalSpreadBps += event.netSpreadBps;
        stats.maxSpreadBps = Math.max(stats.maxSpreadBps, event.netSpreadBps);
        stats.minSpreadBps = Math.min(stats.minSpreadBps, event.netSpreadBps);
        this.venuePairStats.set(pair, stats);

        // Update histogram
        this.updateHistogram(event.netSpreadBps);

        // Track pool
        this.poolsWithPrices.add(event.buyPoolPubkey);
        this.poolsWithPrices.add(event.sellPoolPubkey);

        // Write to file
        const line = JSON.stringify({
            ...event,
            pair,
        });
        this.appendToFile(this.detectionsFile, line);

        // Console output
        const latencyStr = event.latencyMs ? ` lat=${event.latencyMs}ms` : "";
        console.log(
            `🎯 [DET] ${pair} | ` +
            `${event.tokenMint.slice(0, 8)}... | ` +
            `gross=${event.grossSpreadBps}bps net=${event.netSpreadBps}bps | ` +
            `buy=${event.buyPrice.toExponential(3)} sell=${event.sellPrice.toExponential(3)}` +
            latencyStr
        );
    }

    /**
     * Log a rejected opportunity with reason
     */
    logRejection(
        tokenMint: string,
        reason: RejectionReason,
        details?: { venue?: VenueName; spreadBps?: number; message?: string }
    ): void {
        this.totalRejections++;
        const now = Date.now();
        this.recentRejections.push(now);
        this.cleanOldEntries(this.recentRejections, 60000);

        // Update rejection stats
        const stats = this.rejectionStats.get(reason) ?? {
            count: 0,
            lastSeen: 0,
            examples: [],
        };
        stats.count++;
        stats.lastSeen = now;
        stats.examples.push(tokenMint.slice(0, 8));
        if (stats.examples.length > 3) stats.examples.shift();
        this.rejectionStats.set(reason, stats);

        // Track missing vaults
        if (reason === "MISSING_VAULT" && details?.venue) {
            this.poolsMissingVaults.add(`${tokenMint}_${details.venue}`);
        }

        // Build event - only include defined properties
        const event: RejectionEvent = {
            ts: now,
            tokenMint,
            reason,
        };
        if (details?.venue !== undefined) event.venue = details.venue;
        if (details?.spreadBps !== undefined) event.spreadBps = details.spreadBps;
        if (details?.message !== undefined) event.details = details.message;

        this.appendToFile(this.rejectionsFile, JSON.stringify(event));

        // Only log verbose rejections in debug mode
        if (process.env.DEBUG === "1" || reason === "SIMGATE_ERROR" || reason === "EXECUTION_FAIL") {
            const venueStr = details?.venue ? ` venue=${details.venue}` : "";
            const spreadStr = details?.spreadBps !== undefined ? ` spread=${details.spreadBps}bps` : "";
            const msgStr = details?.message ? ` (${details.message})` : "";
            console.log(
                `⏭️  [REJ] ${reason} | ${tokenMint.slice(0, 8)}...${venueStr}${spreadStr}${msgStr}`
            );
        }
    }

    /**
     * Log an execution attempt
     */
    logExecution(event: ExecutionEvent): void {
        this.totalExecutions++;

        // Update venue pair stats
        const pair: VenuePair = `${event.buyVenue}→${event.sellVenue}`;
        const stats = this.venuePairStats.get(pair);
        if (stats) {
            stats.executions++;
            if (event.status === "LANDED") {
                stats.successes++;
            }
        }

        if (event.status === "LANDED") {
            this.totalSuccesses++;
            if (event.actualProfitLamports !== undefined) {
                if (event.actualProfitLamports > 0n) {
                    this.totalProfitLamports += event.actualProfitLamports;
                } else {
                    this.totalLossLamports += -event.actualProfitLamports;
                }
            }
        }

        // Write to file
        const line = JSON.stringify({
            ...event,
            inputLamports: event.inputLamports.toString(),
            expectedProfitLamports: event.expectedProfitLamports.toString(),
            actualProfitLamports: event.actualProfitLamports?.toString(),
        });
        this.appendToFile(this.executionsFile, line);

        // Console output
        const emoji = event.status === "LANDED" ? "✅" : event.status === "FAILED" ? "❌" : "📤";
        const profitStr = event.actualProfitLamports !== undefined
            ? ` profit=${(Number(event.actualProfitLamports) / 1e9).toFixed(6)} SOL`
            : "";
        const errorStr = event.error ? ` err=${event.error.slice(0, 30)}` : "";

        console.log(
            `${emoji} [EXEC] ${event.status} | ${pair} | ` +
            `${event.tokenMint.slice(0, 8)}... | ` +
            `in=${(Number(event.inputLamports) / 1e9).toFixed(4)} SOL | ` +
            `lat=${event.latencyMs}ms${profitStr}${errorStr}`
        );
    }

    // ========================================================================
    // SUMMARY & METRICS
    // ========================================================================

    /**
     * Print periodic summary (call every 30-60s)
     */
    printSummary(): void {
        const uptimeSec = Math.floor((Date.now() - this.startTs) / 1000);
        const detRate = this.recentDetections.length; // per minute
        const rejRate = this.recentRejections.length;

        console.log(`\n${"─".repeat(70)}`);
        console.log(`📊 ARB SUMMARY | Uptime: ${this.formatUptime(uptimeSec)} | Rate: ${detRate}/min det, ${rejRate}/min rej`);
        console.log(`${"─".repeat(70)}`);

        // Overall stats
        console.log(
            `   Detections: ${this.totalDetections} | ` +
            `Executions: ${this.totalExecutions} | ` +
            `Successes: ${this.totalSuccesses} (${this.totalExecutions > 0 ? ((this.totalSuccesses / this.totalExecutions) * 100).toFixed(1) : 0}%)`
        );

        const netProfitSol = Number(this.totalProfitLamports - this.totalLossLamports) / 1e9;
        console.log(
            `   Net P/L: ${netProfitSol >= 0 ? "+" : ""}${netProfitSol.toFixed(6)} SOL | ` +
            `Pools tracked: ${this.poolsWithPrices.size} | ` +
            `Missing vaults: ${this.poolsMissingVaults.size}`
        );

        // Venue pair breakdown
        if (this.venuePairStats.size > 0) {
            console.log(`\n   📈 Venue Pairs:`);
            const sorted = [...this.venuePairStats.entries()]
                .sort((a, b) => b[1].detections - a[1].detections);

            for (const [pair, stats] of sorted.slice(0, 6)) {
                const avgSpread = stats.detections > 0
                    ? (stats.totalSpreadBps / stats.detections).toFixed(0)
                    : "0";
                const execRate = stats.detections > 0
                    ? ((stats.executions / stats.detections) * 100).toFixed(0)
                    : "0";
                console.log(
                    `      ${pair.padEnd(22)} | ` +
                    `det=${stats.detections.toString().padStart(4)} | ` +
                    `exec=${stats.executions.toString().padStart(3)} (${execRate}%) | ` +
                    `avg=${avgSpread}bps | ` +
                    `max=${stats.maxSpreadBps}bps`
                );
            }
        }

        // Spread histogram
        console.log(`\n   📉 Spread Distribution (net bps):`);
        const maxCount = Math.max(...this.spreadHistogram.values(), 1);
        for (const [bucket, count] of this.spreadHistogram) {
            const barLen = Math.round((count / maxCount) * 20);
            const bar = "█".repeat(barLen) + "░".repeat(20 - barLen);
            console.log(`      ${bucket.padStart(7)}: ${bar} ${count}`);
        }

        // Top rejection reasons
        if (this.rejectionStats.size > 0) {
            console.log(`\n   ⏭️  Top Rejections:`);
            const sortedRejects = [...this.rejectionStats.entries()]
                .sort((a, b) => b[1].count - a[1].count);

            for (const [reason, stats] of sortedRejects.slice(0, 5)) {
                const pct = this.totalRejections > 0
                    ? ((stats.count / this.totalRejections) * 100).toFixed(1)
                    : "0";
                console.log(
                    `      ${reason.padEnd(18)} | ${stats.count.toString().padStart(5)} (${pct}%) | ` +
                    `ex: ${stats.examples.join(", ")}`
                );
            }
        }

        console.log(`${"─".repeat(70)}\n`);
    }

    /**
     * Print compact one-line status (for frequent updates)
     */
    printStatus(): void {
        const detRate = this.recentDetections.length;
        const netProfitSol = Number(this.totalProfitLamports - this.totalLossLamports) / 1e9;

        console.log(
            `[STATUS] det=${this.totalDetections} exec=${this.totalExecutions} ` +
            `win=${this.totalSuccesses} P/L=${netProfitSol >= 0 ? "+" : ""}${netProfitSol.toFixed(4)} SOL | ` +
            `rate=${detRate}/min | pools=${this.poolsWithPrices.size}`
        );
    }

    // ========================================================================
    // HELPERS
    // ========================================================================

    private updateHistogram(spreadBps: number): void {
        let bucket: string;
        if (spreadBps < 25) bucket = "0-25";
        else if (spreadBps < 50) bucket = "25-50";
        else if (spreadBps < 75) bucket = "50-75";
        else if (spreadBps < 100) bucket = "75-100";
        else if (spreadBps < 150) bucket = "100-150";
        else if (spreadBps < 200) bucket = "150-200";
        else if (spreadBps < 300) bucket = "200-300";
        else bucket = "300+";

        this.spreadHistogram.set(bucket, (this.spreadHistogram.get(bucket) ?? 0) + 1);
    }

    private cleanOldEntries(arr: number[], maxAgeMs: number): void {
        const cutoff = Date.now() - maxAgeMs;
        while (arr.length > 0 && arr[0]! < cutoff) {
            arr.shift();
        }
    }

    private formatUptime(seconds: number): string {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
    }

    private appendToFile(filePath: string, line: string): void {
        try {
            appendFileSync(filePath, line + "\n");
        } catch {
            // Silent fail
        }
    }

    // ========================================================================
    // GETTERS FOR EXTERNAL USE
    // ========================================================================

    getStats() {
        return {
            totalDetections: this.totalDetections,
            totalRejections: this.totalRejections,
            totalExecutions: this.totalExecutions,
            totalSuccesses: this.totalSuccesses,
            netProfitLamports: this.totalProfitLamports - this.totalLossLamports,
            poolsTracked: this.poolsWithPrices.size,
            poolsMissingVaults: this.poolsMissingVaults.size,
            detectionRatePerMin: this.recentDetections.length,
            rejectionRatePerMin: this.recentRejections.length,
            venuePairStats: Object.fromEntries(this.venuePairStats),
            spreadHistogram: Object.fromEntries(this.spreadHistogram),
        };
    }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let arbLoggerInstance: ArbLogger | null = null;

export function initArbLogger(logDirPath?: string): ArbLogger {
    if (!arbLoggerInstance) {
        arbLoggerInstance = new ArbLogger(logDirPath);
    }
    return arbLoggerInstance;
}

export function getArbLogger(): ArbLogger | null {
    return arbLoggerInstance;
}

// Default export for convenience
export const arbLogger = {
    init: initArbLogger,
    get: getArbLogger,
};

export default ArbLogger;