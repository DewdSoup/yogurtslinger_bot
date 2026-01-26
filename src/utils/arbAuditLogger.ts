// src/utils/arbAuditLogger.ts
// ═══════════════════════════════════════════════════════════════════════════════
// ARB AUDIT LOGGER - STRUCTURED FILE LOGGING FOR VALIDATION RUNS
// ═══════════════════════════════════════════════════════════════════════════════
//
// v1.1 CHANGES:
// - Fixed singleton to accept logDir changes (was ignoring path after first init)
// - Logger now recreates if logDir differs from current instance
//

import * as fs from "fs";
import * as path from "path";

// ═══════════════════════════════════════════════════════════════════════════════
// EVENT TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type AuditEventType =
    | "DETECTION"
    | "LOCAL_SIM"
    | "RPC_SIM"
    | "COMPARISON"
    | "EXECUTION"
    | "RPC_FALLBACK"
    | "ERROR"
    | "STARTUP"
    | "SHUTDOWN";

export interface BaseAuditEvent {
    type: AuditEventType;
    timestamp: number;
    isoTime: string;
    tokenMint: string;
    sessionId: string;
}

export interface DetectionEvent extends BaseAuditEvent {
    type: "DETECTION";
    buyVenue: string;
    sellVenue: string;
    grossSpreadBps: number;
    estimatedNetSpreadBps: number;
    detectionLatencyMs: number;
}

export interface LocalSimEvent extends BaseAuditEvent {
    type: "LOCAL_SIM";
    approved: boolean;
    reason: string | null;
    buyVenue: string;
    sellVenue: string;
    optimalAmountIn: string;
    expectedProfitLamports: string;
    expectedProfitBps: number;
    expectedTokensOut: string;
    expectedSolOut: string;
    minTokensOut: string;
    minSolOut: string;
    suggestedTipLamports: string;
    confidence: number;
    simulationTimeMs: number;
    buyPoolLiquidity: string;
    sellPoolLiquidity: string;
}

export interface RpcSimEvent extends BaseAuditEvent {
    type: "RPC_SIM";
    approved: boolean;
    reason: string | null;
    buyVenue: string;
    sellVenue: string;
    profitLamports: string;
    profitBps: number;
    simulationTimeMs: number;
    error: string | null;
}

export interface ComparisonEvent extends BaseAuditEvent {
    type: "COMPARISON";
    buyVenue: string;
    sellVenue: string;
    localApproved: boolean;
    rpcApproved: boolean;
    localProfitLamports: string;
    rpcProfitLamports: string;
    profitDeltaLamports: string;
    profitDeltaBps: number;
    localSimTimeMs: number;
    rpcSimTimeMs: number;
    latencyAdvantageMs: number;
    localConfidence: number;
    agreement: boolean;
    divergenceReason: string | null;
}

export interface ExecutionEvent extends BaseAuditEvent {
    type: "EXECUTION";
    success: boolean;
    buyVenue: string;
    sellVenue: string;
    amountIn: string;
    actualProfitLamports: string;
    actualTokensOut: string;
    actualSolOut: string;
    tipPaid: string;
    executionTimeMs: number;
    bundleId: string | null;
    error: string | null;
    usedLocalSim: boolean;
}

export interface RpcFallbackEvent extends BaseAuditEvent {
    type: "RPC_FALLBACK";
    reason: string;
    localConfidence: number;
    localApproved: boolean;
}

export interface ErrorEvent extends BaseAuditEvent {
    type: "ERROR";
    stage: string;
    error: string;
    stack: string | null;
}

export interface StartupConfig {
    useLocalSimulation: boolean;
    dryRun: boolean;
    maxTradeLamports: string;
    minCandidateSpreadBps: number;
    minConfidence: number;
    minNetProfitBps: number;
    binArrayCacheEnabled: boolean;
}

export interface StartupEvent extends Omit<BaseAuditEvent, "tokenMint"> {
    type: "STARTUP";
    tokenMint: "";
    config: StartupConfig;
}

export interface RunStats {
    sessionId: string;
    startTime: number;
    endTime: number;
    durationMs: number;
    totalDetections: number;
    localSimTotal: number;
    localSimApproved: number;
    localSimRejected: number;
    localSimAvgTimeMs: number;
    localSimMaxTimeMs: number;
    rpcSimTotal: number;
    rpcSimApproved: number;
    rpcSimRejected: number;
    rpcSimAvgTimeMs: number;
    rpcSimMaxTimeMs: number;
    comparisonsTotal: number;
    agreementCount: number;
    disagreementCount: number;
    agreementRate: number;
    avgProfitDeltaBps: number;
    maxProfitDeltaBps: number;
    avgLatencyAdvantageMs: number;
    rpcFallbackCount: number;
    rpcFallbackReasons: Record<string, number>;
    byVenuePair: Record<string, {
        detections: number;
        localApproved: number;
        rpcApproved: number;
        agreements: number;
        avgProfitDeltaBps: number;
    }>;
    byConfidence: Record<string, {
        count: number;
        agreements: number;
        avgProfitDeltaBps: number;
    }>;
    errorCount: number;
    errorsByStage: Record<string, number>;
}

export interface ShutdownEvent extends Omit<BaseAuditEvent, "tokenMint"> {
    type: "SHUTDOWN";
    tokenMint: "";
    stats: RunStats;
}

export type AuditEvent =
    | DetectionEvent
    | LocalSimEvent
    | RpcSimEvent
    | ComparisonEvent
    | ExecutionEvent
    | RpcFallbackEvent
    | ErrorEvent
    | StartupEvent
    | ShutdownEvent;

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIT LOGGER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class ArbAuditLogger {
    private readonly sessionId: string;
    private readonly logDir: string;
    private readonly eventLogPath: string;
    private readonly summaryLogPath: string;
    private writeStream: fs.WriteStream | null = null;
    private startTime: number;

    // Stats accumulators
    private detections: DetectionEvent[] = [];
    private localSims: LocalSimEvent[] = [];
    private rpcSims: RpcSimEvent[] = [];
    private comparisons: ComparisonEvent[] = [];
    private executions: ExecutionEvent[] = [];
    private fallbacks: RpcFallbackEvent[] = [];
    private errors: ErrorEvent[] = [];

    constructor(logDir: string = "./logs") {
        this.startTime = Date.now();
        this.sessionId = this.generateSessionId();
        this.logDir = logDir;

        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }

        const timestamp = this.formatTimestamp(this.startTime);
        this.eventLogPath = path.join(this.logDir, `arb_audit_${timestamp}.jsonl`);
        this.summaryLogPath = path.join(this.logDir, `arb_summary_${timestamp}.json`);

        this.writeStream = fs.createWriteStream(this.eventLogPath, { flags: "a" });
    }

    // Getter to expose logDir for singleton comparison
    getLogDir(): string {
        return this.logDir;
    }

    logStartup(config: StartupConfig): void {
        const event: StartupEvent = {
            type: "STARTUP",
            timestamp: Date.now(),
            isoTime: new Date().toISOString(),
            tokenMint: "",
            sessionId: this.sessionId,
            config
        };
        this.writeEvent(event);

        console.log(`\n[AUDIT] ═══════════════════════════════════════════════════════`);
        console.log(`[AUDIT] Session: ${this.sessionId}`);
        console.log(`[AUDIT] Event log:   ${this.eventLogPath}`);
        console.log(`[AUDIT] Summary log: ${this.summaryLogPath}`);
        console.log(`[AUDIT] Mode: ${config.dryRun ? "DRY RUN" : "LIVE"}`);
        console.log(`[AUDIT] ═══════════════════════════════════════════════════════\n`);
    }

    logDetection(
        tokenMint: string,
        buyVenue: string,
        sellVenue: string,
        grossSpreadBps: number,
        estimatedNetSpreadBps: number,
        detectionLatencyMs: number
    ): void {
        const event: DetectionEvent = {
            type: "DETECTION",
            timestamp: Date.now(),
            isoTime: new Date().toISOString(),
            tokenMint,
            sessionId: this.sessionId,
            buyVenue,
            sellVenue,
            grossSpreadBps,
            estimatedNetSpreadBps,
            detectionLatencyMs
        };
        this.writeEvent(event);
        this.detections.push(event);
    }

    logLocalSim(
        tokenMint: string,
        buyVenue: string,
        sellVenue: string,
        approved: boolean,
        reason: string | null,
        optimalAmountIn: bigint,
        expectedProfitLamports: bigint,
        expectedProfitBps: number,
        expectedTokensOut: bigint,
        expectedSolOut: bigint,
        minTokensOut: bigint,
        minSolOut: bigint,
        suggestedTipLamports: bigint,
        confidence: number,
        simulationTimeMs: number,
        buyPoolLiquidity: bigint,
        sellPoolLiquidity: bigint
    ): void {
        const event: LocalSimEvent = {
            type: "LOCAL_SIM",
            timestamp: Date.now(),
            isoTime: new Date().toISOString(),
            tokenMint,
            sessionId: this.sessionId,
            approved,
            reason,
            buyVenue,
            sellVenue,
            optimalAmountIn: optimalAmountIn.toString(),
            expectedProfitLamports: expectedProfitLamports.toString(),
            expectedProfitBps,
            expectedTokensOut: expectedTokensOut.toString(),
            expectedSolOut: expectedSolOut.toString(),
            minTokensOut: minTokensOut.toString(),
            minSolOut: minSolOut.toString(),
            suggestedTipLamports: suggestedTipLamports.toString(),
            confidence,
            simulationTimeMs,
            buyPoolLiquidity: buyPoolLiquidity.toString(),
            sellPoolLiquidity: sellPoolLiquidity.toString()
        };
        this.writeEvent(event);
        this.localSims.push(event);
    }

    logRpcSim(
        tokenMint: string,
        buyVenue: string,
        sellVenue: string,
        approved: boolean,
        reason: string | null,
        profitLamports: bigint,
        profitBps: number,
        simulationTimeMs: number,
        error: string | null
    ): void {
        const event: RpcSimEvent = {
            type: "RPC_SIM",
            timestamp: Date.now(),
            isoTime: new Date().toISOString(),
            tokenMint,
            sessionId: this.sessionId,
            approved,
            reason,
            buyVenue,
            sellVenue,
            profitLamports: profitLamports.toString(),
            profitBps,
            simulationTimeMs,
            error
        };
        this.writeEvent(event);
        this.rpcSims.push(event);
    }

    logComparison(
        tokenMint: string,
        buyVenue: string,
        sellVenue: string,
        localApproved: boolean,
        rpcApproved: boolean,
        localProfitLamports: bigint,
        rpcProfitLamports: bigint,
        localSimTimeMs: number,
        rpcSimTimeMs: number,
        localConfidence: number
    ): void {
        const profitDelta = localProfitLamports - rpcProfitLamports;
        const profitDeltaBps = rpcProfitLamports > BigInt(0)
            ? Number(profitDelta * BigInt(10000) / rpcProfitLamports)
            : 0;
        const latencyAdvantage = rpcSimTimeMs - localSimTimeMs;
        const agreement = localApproved === rpcApproved;

        let divergenceReason: string | null = null;
        if (!agreement) {
            divergenceReason = localApproved ? "LOCAL_APPROVED_RPC_REJECTED" : "LOCAL_REJECTED_RPC_APPROVED";
        } else if (Math.abs(profitDeltaBps) > 50) {
            divergenceReason = `PROFIT_DELTA_${profitDeltaBps > 0 ? "OVER" : "UNDER"}_50BPS`;
        }

        const event: ComparisonEvent = {
            type: "COMPARISON",
            timestamp: Date.now(),
            isoTime: new Date().toISOString(),
            tokenMint,
            sessionId: this.sessionId,
            buyVenue,
            sellVenue,
            localApproved,
            rpcApproved,
            localProfitLamports: localProfitLamports.toString(),
            rpcProfitLamports: rpcProfitLamports.toString(),
            profitDeltaLamports: profitDelta.toString(),
            profitDeltaBps,
            localSimTimeMs,
            rpcSimTimeMs,
            latencyAdvantageMs: latencyAdvantage,
            localConfidence,
            agreement,
            divergenceReason
        };
        this.writeEvent(event);
        this.comparisons.push(event);

        if (!agreement || Math.abs(profitDeltaBps) > 20) {
            console.log(
                `[AUDIT] ⚠️ DIVERGENCE: ${tokenMint.slice(0, 8)}... | ` +
                `local=${localApproved ? "✓" : "✗"} rpc=${rpcApproved ? "✓" : "✗"} | ` +
                `delta=${profitDeltaBps}bps | latency=${latencyAdvantage.toFixed(0)}ms faster`
            );
        }
    }

    logRpcFallback(
        tokenMint: string,
        reason: string,
        localConfidence: number,
        localApproved: boolean
    ): void {
        const event: RpcFallbackEvent = {
            type: "RPC_FALLBACK",
            timestamp: Date.now(),
            isoTime: new Date().toISOString(),
            tokenMint,
            sessionId: this.sessionId,
            reason,
            localConfidence,
            localApproved
        };
        this.writeEvent(event);
        this.fallbacks.push(event);

        console.log(
            `[AUDIT] 🔄 RPC FALLBACK: ${tokenMint.slice(0, 8)}... | ` +
            `reason=${reason} | conf=${(localConfidence * 100).toFixed(0)}%`
        );
    }

    logExecution(
        tokenMint: string,
        buyVenue: string,
        sellVenue: string,
        success: boolean,
        amountIn: bigint,
        actualProfitLamports: bigint,
        actualTokensOut: bigint,
        actualSolOut: bigint,
        tipPaid: bigint,
        executionTimeMs: number,
        bundleId: string | null,
        error: string | null,
        usedLocalSim: boolean
    ): void {
        const event: ExecutionEvent = {
            type: "EXECUTION",
            timestamp: Date.now(),
            isoTime: new Date().toISOString(),
            tokenMint,
            sessionId: this.sessionId,
            success,
            buyVenue,
            sellVenue,
            amountIn: amountIn.toString(),
            actualProfitLamports: actualProfitLamports.toString(),
            actualTokensOut: actualTokensOut.toString(),
            actualSolOut: actualSolOut.toString(),
            tipPaid: tipPaid.toString(),
            executionTimeMs,
            bundleId,
            error,
            usedLocalSim
        };
        this.writeEvent(event);
        this.executions.push(event);
    }

    logError(tokenMint: string, stage: string, error: Error | string): void {
        const errorStr = error instanceof Error ? error.message : error;
        const stack = error instanceof Error ? error.stack ?? null : null;

        const event: ErrorEvent = {
            type: "ERROR",
            timestamp: Date.now(),
            isoTime: new Date().toISOString(),
            tokenMint,
            sessionId: this.sessionId,
            stage,
            error: errorStr,
            stack
        };
        this.writeEvent(event);
        this.errors.push(event);

        console.error(`[AUDIT] ❌ ERROR: ${tokenMint.slice(0, 8)}... | stage=${stage} | ${errorStr}`);
    }

    getStats(): RunStats {
        const endTime = Date.now();
        const localApproved = this.localSims.filter(e => e.approved);
        const localTimes = this.localSims.map(e => e.simulationTimeMs);
        const rpcApproved = this.rpcSims.filter(e => e.approved);
        const rpcTimes = this.rpcSims.map(e => e.simulationTimeMs);
        const agreements = this.comparisons.filter(e => e.agreement);
        const profitDeltas = this.comparisons.map(e => e.profitDeltaBps);
        const latencyAdvantages = this.comparisons.map(e => e.latencyAdvantageMs);

        const byVenuePair: Record<string, { detections: number; localApproved: number; rpcApproved: number; agreements: number; profitDeltas: number[] }> = {};
        for (const d of this.detections) {
            const key = `${d.buyVenue}→${d.sellVenue}`;
            if (!byVenuePair[key]) byVenuePair[key] = { detections: 0, localApproved: 0, rpcApproved: 0, agreements: 0, profitDeltas: [] };
            byVenuePair[key].detections++;
        }
        for (const c of this.comparisons) {
            const key = `${c.buyVenue}→${c.sellVenue}`;
            if (!byVenuePair[key]) byVenuePair[key] = { detections: 0, localApproved: 0, rpcApproved: 0, agreements: 0, profitDeltas: [] };
            if (c.localApproved) byVenuePair[key].localApproved++;
            if (c.rpcApproved) byVenuePair[key].rpcApproved++;
            if (c.agreement) byVenuePair[key].agreements++;
            byVenuePair[key].profitDeltas.push(c.profitDeltaBps);
        }

        const byConfidence: Record<string, { count: number; agreements: number; profitDeltas: number[] }> = {};
        for (const c of this.comparisons) {
            const bucket = this.getConfidenceBucket(c.localConfidence);
            if (!byConfidence[bucket]) byConfidence[bucket] = { count: 0, agreements: 0, profitDeltas: [] };
            byConfidence[bucket].count++;
            if (c.agreement) byConfidence[bucket].agreements++;
            byConfidence[bucket].profitDeltas.push(c.profitDeltaBps);
        }

        const fallbackReasons: Record<string, number> = {};
        for (const f of this.fallbacks) {
            fallbackReasons[f.reason] = (fallbackReasons[f.reason] || 0) + 1;
        }

        const errorsByStage: Record<string, number> = {};
        for (const e of this.errors) {
            errorsByStage[e.stage] = (errorsByStage[e.stage] || 0) + 1;
        }

        return {
            sessionId: this.sessionId,
            startTime: this.startTime,
            endTime,
            durationMs: endTime - this.startTime,
            totalDetections: this.detections.length,
            localSimTotal: this.localSims.length,
            localSimApproved: localApproved.length,
            localSimRejected: this.localSims.length - localApproved.length,
            localSimAvgTimeMs: this.avg(localTimes),
            localSimMaxTimeMs: localTimes.length > 0 ? Math.max(...localTimes) : 0,
            rpcSimTotal: this.rpcSims.length,
            rpcSimApproved: rpcApproved.length,
            rpcSimRejected: this.rpcSims.length - rpcApproved.length,
            rpcSimAvgTimeMs: this.avg(rpcTimes),
            rpcSimMaxTimeMs: rpcTimes.length > 0 ? Math.max(...rpcTimes) : 0,
            comparisonsTotal: this.comparisons.length,
            agreementCount: agreements.length,
            disagreementCount: this.comparisons.length - agreements.length,
            agreementRate: this.comparisons.length > 0 ? agreements.length / this.comparisons.length : 0,
            avgProfitDeltaBps: this.avg(profitDeltas),
            maxProfitDeltaBps: profitDeltas.length > 0 ? Math.max(...profitDeltas.map(Math.abs)) : 0,
            avgLatencyAdvantageMs: this.avg(latencyAdvantages),
            rpcFallbackCount: this.fallbacks.length,
            rpcFallbackReasons: fallbackReasons,
            byVenuePair: Object.fromEntries(
                Object.entries(byVenuePair).map(([k, v]) => [k, {
                    detections: v.detections,
                    localApproved: v.localApproved,
                    rpcApproved: v.rpcApproved,
                    agreements: v.agreements,
                    avgProfitDeltaBps: this.avg(v.profitDeltas)
                }])
            ),
            byConfidence: Object.fromEntries(
                Object.entries(byConfidence).map(([k, v]) => [k, {
                    count: v.count,
                    agreements: v.agreements,
                    avgProfitDeltaBps: this.avg(v.profitDeltas)
                }])
            ),
            errorCount: this.errors.length,
            errorsByStage
        };
    }

    shutdown(): RunStats {
        const stats = this.getStats();

        const event: ShutdownEvent = {
            type: "SHUTDOWN",
            timestamp: Date.now(),
            isoTime: new Date().toISOString(),
            tokenMint: "",
            sessionId: this.sessionId,
            stats
        };
        this.writeEvent(event);

        fs.writeFileSync(this.summaryLogPath, JSON.stringify(stats, null, 2));

        if (this.writeStream) {
            this.writeStream.end();
            this.writeStream = null;
        }

        this.printSummary(stats);
        return stats;
    }

    printSummary(stats?: RunStats): void {
        const s = stats || this.getStats();
        const durationMin = (s.durationMs / 60000).toFixed(1);

        console.log("\n[AUDIT] ═══════════════════════════════════════════════════════════════");
        console.log("[AUDIT]                    VALIDATION RUN SUMMARY                       ");
        console.log("[AUDIT] ═══════════════════════════════════════════════════════════════\n");
        console.log(`[AUDIT] Session:            ${s.sessionId}`);
        console.log(`[AUDIT] Duration:           ${durationMin} minutes`);
        console.log(`[AUDIT] Total detections:   ${s.totalDetections}`);
        console.log();
        console.log("[AUDIT] LOCAL SIMULATION:");
        console.log(`[AUDIT]   Total:            ${s.localSimTotal}`);
        console.log(`[AUDIT]   Approved:         ${s.localSimApproved} (${(s.localSimApproved / Math.max(s.localSimTotal, 1) * 100).toFixed(1)}%)`);
        console.log(`[AUDIT]   Avg time:         ${s.localSimAvgTimeMs.toFixed(2)} ms`);
        console.log();
        console.log("[AUDIT] LOCAL vs RPC COMPARISON:");
        console.log(`[AUDIT]   Total comparisons: ${s.comparisonsTotal}`);
        console.log(`[AUDIT]   Agreement rate:    ${(s.agreementRate * 100).toFixed(1)}%`);
        console.log(`[AUDIT]   Avg profit delta:  ${s.avgProfitDeltaBps.toFixed(1)} bps`);
        console.log(`[AUDIT]   Latency advantage: ${s.avgLatencyAdvantageMs.toFixed(1)} ms avg`);
        console.log();
        console.log(`[AUDIT] Event log:   ${this.eventLogPath}`);
        console.log(`[AUDIT] Summary log: ${this.summaryLogPath}`);
        console.log("[AUDIT] ═══════════════════════════════════════════════════════════════\n");
    }

    private writeEvent(event: AuditEvent): void {
        if (this.writeStream) {
            this.writeStream.write(JSON.stringify(event) + "\n");
        }
    }

    private generateSessionId(): string {
        const ts = Date.now().toString(36);
        const rand = Math.random().toString(36).substring(2, 8);
        return `${ts}-${rand}`;
    }

    private formatTimestamp(ts: number): string {
        const d = new Date(ts);
        return d.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    }

    private avg(arr: number[]): number {
        if (arr.length === 0) return 0;
        return arr.reduce((a, b) => a + b, 0) / arr.length;
    }

    private getConfidenceBucket(confidence: number): string {
        if (confidence >= 0.95) return "95-100%";
        if (confidence >= 0.90) return "90-95%";
        if (confidence >= 0.85) return "85-90%";
        if (confidence >= 0.80) return "80-85%";
        return "<80%";
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON - FIXED TO ACCEPT PATH CHANGES
// ═══════════════════════════════════════════════════════════════════════════════

let _auditLogger: ArbAuditLogger | null = null;

/**
 * Get or create the audit logger singleton.
 * 
 * IMPORTANT: If logDir is provided and differs from current instance,
 * the old logger is shut down and a new one is created.
 * This fixes the bug where the first caller would lock in "./logs" forever.
 */
export function getAuditLogger(logDir?: string): ArbAuditLogger {
    const targetDir = logDir ?? "./logs";

    // If we have an existing logger but logDir changed, recreate it
    if (_auditLogger && logDir && _auditLogger.getLogDir() !== logDir) {
        console.log(`[AUDIT] Recreating logger: ${_auditLogger.getLogDir()} → ${logDir}`);
        _auditLogger.shutdown();
        _auditLogger = null;
    }

    // Create new logger if needed
    if (!_auditLogger) {
        _auditLogger = new ArbAuditLogger(targetDir);
    }

    return _auditLogger;
}

export function resetAuditLogger(): void {
    if (_auditLogger) {
        _auditLogger.shutdown();
    }
    _auditLogger = null;
}

export default ArbAuditLogger;