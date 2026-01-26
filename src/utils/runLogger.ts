// src/utils/runLogger.ts
// =============================================================================
// UNIFIED RUN LOGGER
// =============================================================================
// Saves all logs to data/<runtime_id>/ folder with structured output
// Usage: Initialize at startup, all console.log calls get captured
//
// Files created per run:
//   data/<runtime_id>/
//     ├── run.log          # All console output
//     ├── opportunities.jsonl  # Detected opportunities (JSON lines)
//     ├── executions.jsonl     # Execution attempts
//     ├── errors.jsonl         # Errors only
//     ├── stats.json           # Final run statistics
//     └── config.json          # Run configuration snapshot

import { mkdirSync, appendFileSync, writeFileSync } from "fs";
import { join } from "path";

// =============================================================================
// TYPES
// =============================================================================

export interface RunConfig {
    rpcEndpoint: string;
    geyserEndpoint: string;
    walletPath: string;
    dryRun: boolean;
    paperTrade: boolean;
    minSpreadBps: number;
    maxTradeSol: number;
    totalCapitalSol: number;
    startedAt: string;
    nodeVersion: string;
    gitCommit?: string;
}

export interface OpportunityLog {
    ts: number;
    type: "FRAG_ARB" | "FEE_DECAY" | "BACKRUN" | "JIT";
    tokenMint: string;
    buyVenue: string;
    sellVenue: string;
    spreadBps: number;
    estimatedProfitLamports: bigint | number;
    confidence: "HIGH" | "MEDIUM" | "LOW";
    action: "DETECTED" | "SIMULATED" | "EXECUTED" | "REJECTED";
    reason?: string;
    details?: Record<string, unknown>;
}

export interface ExecutionLog {
    ts: number;
    opportunityType: string;
    tokenMint: string;
    inputLamports: bigint | number;
    expectedOutputLamports: bigint | number;
    actualOutputLamports?: bigint | number;
    profitLamports?: bigint | number;
    txSignature?: string;
    bundleId?: string;
    status: "PENDING" | "SUBMITTED" | "LANDED" | "FAILED" | "SKIPPED";
    error?: string;
    latencyMs: number;
}

export interface StatsSnapshot {
    runtime: string;
    uptimeSeconds: number;
    messagesProcessed: number;
    poolsTracked: {
        pumpCurves: number;
        pumpSwap: number;
        raydium: number;
        meteora: number;
    };
    opportunities: {
        detected: number;
        simulated: number;
        profitable: number;
        executed: number;
        failed: number;
    };
    profitSummary: {
        grossProfitLamports: bigint | number;
        netProfitLamports: bigint | number;
        totalGasLamports: bigint | number;
        totalTipsLamports: bigint | number;
    };
    edgeStats: {
        feeDecaySpikes: number;
        feeDecayOpportunities: number;
        backrunMoves: number;
        backrunOpportunities: number;
    };
}

// =============================================================================
// RUN LOGGER CLASS
// =============================================================================

export class RunLogger {
    private readonly runDir: string;
    private readonly runId: string;
    private readonly startTs: number;

    private readonly logFile: string;
    private readonly opportunitiesFile: string;
    private readonly executionsFile: string;
    private readonly errorsFile: string;
    private readonly statsFile: string;
    private readonly configFile: string;

    private originalConsoleLog: typeof console.log;
    private originalConsoleError: typeof console.error;
    private originalConsoleWarn: typeof console.warn;

    // Counters
    public stats = {
        messagesProcessed: 0,
        opportunitiesDetected: 0,
        opportunitiesSimulated: 0,
        opportunitiesProfitable: 0,
        opportunitiesExecuted: 0,
        opportunitiesFailed: 0,
        grossProfitLamports: 0n,
        netProfitLamports: 0n,
        totalGasLamports: 0n,
        totalTipsLamports: 0n,
    };

    constructor(baseDir: string = "data") {
        this.startTs = Date.now();
        this.runId = this.generateRunId();
        this.runDir = join(baseDir, this.runId);

        // Create run directory
        mkdirSync(this.runDir, { recursive: true });

        // Set up file paths
        this.logFile = join(this.runDir, "run.log");
        this.opportunitiesFile = join(this.runDir, "opportunities.jsonl");
        this.executionsFile = join(this.runDir, "executions.jsonl");
        this.errorsFile = join(this.runDir, "errors.jsonl");
        this.statsFile = join(this.runDir, "stats.json");
        this.configFile = join(this.runDir, "config.json");

        // Store original console methods
        this.originalConsoleLog = console.log;
        this.originalConsoleError = console.error;
        this.originalConsoleWarn = console.warn;

        // Initialize empty files
        writeFileSync(this.logFile, "");
        writeFileSync(this.opportunitiesFile, "");
        writeFileSync(this.executionsFile, "");
        writeFileSync(this.errorsFile, "");

        console.log(`\n${"═".repeat(70)}`);
        console.log(`RUN LOGGER INITIALIZED`);
        console.log(`Run ID: ${this.runId}`);
        console.log(`Log directory: ${this.runDir}`);
        console.log(`${"═".repeat(70)}\n`);
    }

    private generateRunId(): string {
        const now = new Date();
        const pad = (n: number) => n.toString().padStart(2, "0");
        return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    }

    /**
     * Intercept all console output and save to file
     */
    interceptConsole(): void {
        const self = this;

        console.log = function (...args: unknown[]) {
            const line = self.formatLogLine("INFO", args);
            self.appendToLog(line);
            self.originalConsoleLog.apply(console, args);
        };

        console.warn = function (...args: unknown[]) {
            const line = self.formatLogLine("WARN", args);
            self.appendToLog(line);
            self.originalConsoleWarn.apply(console, args);
        };

        console.error = function (...args: unknown[]) {
            const line = self.formatLogLine("ERROR", args);
            self.appendToLog(line);
            self.appendToErrors({ ts: Date.now(), level: "ERROR", message: args.map(String).join(" ") });
            self.originalConsoleError.apply(console, args);
        };
    }

    private formatLogLine(level: string, args: unknown[]): string {
        const ts = new Date().toISOString();
        const msg = args.map(a => {
            if (typeof a === "object") {
                try {
                    return JSON.stringify(a);
                } catch {
                    return String(a);
                }
            }
            return String(a);
        }).join(" ");
        return `[${ts}] [${level}] ${msg}`;
    }

    private appendToLog(line: string): void {
        try {
            appendFileSync(this.logFile, line + "\n");
        } catch {
            // Silent fail - don't break the app for logging
        }
    }

    private appendToErrors(entry: Record<string, unknown>): void {
        try {
            appendFileSync(this.errorsFile, JSON.stringify(entry) + "\n");
        } catch {
            // Silent fail
        }
    }

    /**
     * Save run configuration
     */
    saveConfig(config: RunConfig): void {
        writeFileSync(this.configFile, JSON.stringify(config, null, 2));
    }

    /**
     * Log an opportunity detection
     */
    logOpportunity(opp: OpportunityLog): void {
        this.stats.opportunitiesDetected++;

        const entry = {
            ...opp,
            estimatedProfitLamports: opp.estimatedProfitLamports.toString(),
        };

        try {
            appendFileSync(this.opportunitiesFile, JSON.stringify(entry) + "\n");
        } catch {
            // Silent fail
        }

        // Also log to console with formatting
        const profitSol = Number(opp.estimatedProfitLamports) / 1e9;
        console.log(
            `[OPP] ${opp.type} | ${opp.action} | ` +
            `${opp.tokenMint.slice(0, 8)}... | ` +
            `${opp.buyVenue}→${opp.sellVenue} | ` +
            `spread=${opp.spreadBps}bps | ` +
            `est=${profitSol.toFixed(6)} SOL | ` +
            `conf=${opp.confidence}` +
            (opp.reason ? ` | ${opp.reason}` : "")
        );
    }

    /**
     * Log an execution attempt
     */
    logExecution(exec: ExecutionLog): void {
        if (exec.status === "LANDED") {
            this.stats.opportunitiesExecuted++;
            if (exec.profitLamports) {
                this.stats.grossProfitLamports += BigInt(exec.profitLamports.toString());
            }
        } else if (exec.status === "FAILED") {
            this.stats.opportunitiesFailed++;
        }

        const entry = {
            ...exec,
            inputLamports: exec.inputLamports.toString(),
            expectedOutputLamports: exec.expectedOutputLamports.toString(),
            actualOutputLamports: exec.actualOutputLamports?.toString(),
            profitLamports: exec.profitLamports?.toString(),
        };

        try {
            appendFileSync(this.executionsFile, JSON.stringify(entry) + "\n");
        } catch {
            // Silent fail
        }

        // Console output
        const inputSol = Number(exec.inputLamports) / 1e9;
        console.log(
            `[EXEC] ${exec.status} | ${exec.opportunityType} | ` +
            `${exec.tokenMint.slice(0, 8)}... | ` +
            `in=${inputSol.toFixed(4)} SOL | ` +
            `latency=${exec.latencyMs}ms` +
            (exec.txSignature ? ` | tx=${exec.txSignature.slice(0, 16)}...` : "") +
            (exec.error ? ` | err=${exec.error}` : "")
        );
    }

    /**
     * Log periodic stats snapshot
     */
    logStats(poolStats: { pumpCurves: number; pumpSwap: number; raydium: number; meteora: number }, edgeStats?: { feeDecaySpikes: number; feeDecayOpportunities: number; backrunMoves: number; backrunOpportunities: number }): void {
        const uptimeSeconds = Math.floor((Date.now() - this.startTs) / 1000);

        const snapshot: StatsSnapshot = {
            runtime: this.runId,
            uptimeSeconds,
            messagesProcessed: this.stats.messagesProcessed,
            poolsTracked: poolStats,
            opportunities: {
                detected: this.stats.opportunitiesDetected,
                simulated: this.stats.opportunitiesSimulated,
                profitable: this.stats.opportunitiesProfitable,
                executed: this.stats.opportunitiesExecuted,
                failed: this.stats.opportunitiesFailed,
            },
            profitSummary: {
                grossProfitLamports: this.stats.grossProfitLamports.toString() as unknown as number,
                netProfitLamports: this.stats.netProfitLamports.toString() as unknown as number,
                totalGasLamports: this.stats.totalGasLamports.toString() as unknown as number,
                totalTipsLamports: this.stats.totalTipsLamports.toString() as unknown as number,
            },
            edgeStats: edgeStats ?? {
                feeDecaySpikes: 0,
                feeDecayOpportunities: 0,
                backrunMoves: 0,
                backrunOpportunities: 0,
            },
        };

        writeFileSync(this.statsFile, JSON.stringify(snapshot, null, 2));
    }

    /**
     * Increment message counter
     */
    incrementMessages(count: number = 1): void {
        this.stats.messagesProcessed += count;
    }

    /**
     * Get run directory path
     */
    getRunDir(): string {
        return this.runDir;
    }

    /**
     * Get run ID
     */
    getRunId(): string {
        return this.runId;
    }

    /**
     * Get uptime in seconds
     */
    getUptimeSeconds(): number {
        return Math.floor((Date.now() - this.startTs) / 1000);
    }

    /**
     * Final cleanup - save final stats
     */
    finalize(): void {
        console.log(`\n${"═".repeat(70)}`);
        console.log(`RUN COMPLETED: ${this.runId}`);
        console.log(`Duration: ${this.getUptimeSeconds()} seconds`);
        console.log(`Messages: ${this.stats.messagesProcessed}`);
        console.log(`Opportunities: ${this.stats.opportunitiesDetected} detected, ${this.stats.opportunitiesExecuted} executed`);
        console.log(`Logs saved to: ${this.runDir}`);
        console.log(`${"═".repeat(70)}\n`);
    }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

let runLoggerInstance: RunLogger | null = null;

export function initRunLogger(baseDir: string = "data"): RunLogger {
    if (!runLoggerInstance) {
        runLoggerInstance = new RunLogger(baseDir);
        runLoggerInstance.interceptConsole();
    }
    return runLoggerInstance;
}

export function getRunLogger(): RunLogger | null {
    return runLoggerInstance;
}

export default {
    RunLogger,
    initRunLogger,
    getRunLogger,
};