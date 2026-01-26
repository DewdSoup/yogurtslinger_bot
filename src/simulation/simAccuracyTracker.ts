// src/simulation/simAccuracyTracker.ts
// ═══════════════════════════════════════════════════════════════════════════════
// SIMULATION ACCURACY TRACKER
// ═══════════════════════════════════════════════════════════════════════════════

export interface SimPrediction {
    tokenMint: string;
    buyVenue: string;
    sellVenue: string;
    predictedProfitLamports: bigint;
    predictedProfitBps: number;
    predictedTokensOut: bigint;
    predictedSolOut: bigint;
    optimalAmountIn: bigint;
    confidence: number;
    simulationTimeMs: number;
    timestamp: number;
}

export interface SimActual {
    tokenMint: string;
    actualProfitLamports: bigint;
    actualTokensOut: bigint;
    actualSolOut: bigint;
    executionTimeMs: number;
    success: boolean;
    error: string | null;
    bundleId: string | null;
    timestamp: number;
}

export interface AccuracyRecord {
    prediction: SimPrediction;
    actual: SimActual | null;
    profitErrorBps: number | null;      // (actual - predicted) / predicted * 10000
    tokensErrorPercent: number | null;  // (actual - predicted) / predicted * 100
    solErrorPercent: number | null;     // (actual - predicted) / predicted * 100
    matched: boolean;
}

export interface AccuracyStats {
    totalPredictions: number;
    totalMatched: number;
    totalUnmatched: number;
    totalSuccessful: number;
    totalFailed: number;

    // Profit accuracy
    avgProfitErrorBps: number;
    maxProfitErrorBps: number;
    minProfitErrorBps: number;
    profitWithin5Bps: number;
    profitWithin10Bps: number;
    profitWithin20Bps: number;

    // Token output accuracy
    avgTokensErrorPercent: number;
    tokensWithin1Percent: number;
    tokensWithin2Percent: number;
    tokensWithin5Percent: number;

    // SOL output accuracy
    avgSolErrorPercent: number;
    solWithin1Percent: number;
    solWithin2Percent: number;
    solWithin5Percent: number;

    // By venue
    byVenuePair: Map<string, {
        count: number;
        avgProfitErrorBps: number;
        successRate: number;
    }>;

    // By confidence bucket
    byConfidence: Map<string, {
        count: number;
        avgProfitErrorBps: number;
        successRate: number;
    }>;

    // Timing
    avgSimulationTimeMs: number;
    avgExecutionTimeMs: number;
}

const RETENTION_MS = 3600_000;  // Keep records for 1 hour
const MAX_RECORDS = 10000;      // Max records to keep

export class SimAccuracyTracker {
    private predictions = new Map<string, SimPrediction>();  // tokenMint -> prediction
    private records: AccuracyRecord[] = [];
    private lastCleanup = Date.now();

    /**
     * Record a local simulation prediction
     */
    recordPrediction(
        tokenMint: string,
        buyVenue: string,
        sellVenue: string,
        predictedProfitLamports: bigint,
        predictedProfitBps: number,
        predictedTokensOut: bigint,
        predictedSolOut: bigint,
        optimalAmountIn: bigint,
        confidence: number,
        simulationTimeMs: number
    ): void {
        const prediction: SimPrediction = {
            tokenMint,
            buyVenue,
            sellVenue,
            predictedProfitLamports,
            predictedProfitBps,
            predictedTokensOut,
            predictedSolOut,
            optimalAmountIn,
            confidence,
            simulationTimeMs,
            timestamp: Date.now()
        };

        this.predictions.set(tokenMint, prediction);
        this.maybeCleanup();
    }

    /**
     * Record actual execution result and match with prediction
     */
    recordActual(
        tokenMint: string,
        actualProfitLamports: bigint,
        actualTokensOut: bigint,
        actualSolOut: bigint,
        executionTimeMs: number,
        success: boolean,
        error: string | null = null,
        bundleId: string | null = null
    ): AccuracyRecord | null {
        const prediction = this.predictions.get(tokenMint);

        const actual: SimActual = {
            tokenMint,
            actualProfitLamports,
            actualTokensOut,
            actualSolOut,
            executionTimeMs,
            success,
            error,
            bundleId,
            timestamp: Date.now()
        };

        if (!prediction) {
            // No prediction found - record as unmatched
            const record: AccuracyRecord = {
                prediction: {
                    tokenMint,
                    buyVenue: "unknown",
                    sellVenue: "unknown",
                    predictedProfitLamports: 0n,
                    predictedProfitBps: 0,
                    predictedTokensOut: 0n,
                    predictedSolOut: 0n,
                    optimalAmountIn: 0n,
                    confidence: 0,
                    simulationTimeMs: 0,
                    timestamp: 0
                },
                actual,
                profitErrorBps: null,
                tokensErrorPercent: null,
                solErrorPercent: null,
                matched: false
            };
            this.records.push(record);
            return record;
        }

        // Calculate errors
        let profitErrorBps: number | null = null;
        let tokensErrorPercent: number | null = null;
        let solErrorPercent: number | null = null;

        if (prediction.predictedProfitLamports > 0n) {
            profitErrorBps = Number(
                (actualProfitLamports - prediction.predictedProfitLamports) * 10000n /
                prediction.predictedProfitLamports
            );
        }

        if (prediction.predictedTokensOut > 0n) {
            tokensErrorPercent = Number(
                (actualTokensOut - prediction.predictedTokensOut) * 100n /
                prediction.predictedTokensOut
            );
        }

        if (prediction.predictedSolOut > 0n) {
            solErrorPercent = Number(
                (actualSolOut - prediction.predictedSolOut) * 100n /
                prediction.predictedSolOut
            );
        }

        const record: AccuracyRecord = {
            prediction,
            actual,
            profitErrorBps,
            tokensErrorPercent,
            solErrorPercent,
            matched: true
        };

        this.records.push(record);
        this.predictions.delete(tokenMint);

        return record;
    }

    /**
     * Record a failed execution (no actual values)
     */
    recordFailure(
        tokenMint: string,
        error: string,
        executionTimeMs: number
    ): AccuracyRecord | null {
        return this.recordActual(
            tokenMint,
            0n, 0n, 0n,
            executionTimeMs,
            false,
            error,
            null
        );
    }

    /**
     * Get accuracy statistics
     */
    getStats(): AccuracyStats {
        const matched = this.records.filter(r => r.matched && r.actual?.success);
        const failed = this.records.filter(r => r.actual && !r.actual.success);

        // Profit errors
        const profitErrors = matched
            .map(r => r.profitErrorBps)
            .filter((e): e is number => e !== null);

        // Token errors
        const tokenErrors = matched
            .map(r => r.tokensErrorPercent)
            .filter((e): e is number => e !== null);

        // SOL errors
        const solErrors = matched
            .map(r => r.solErrorPercent)
            .filter((e): e is number => e !== null);

        // By venue pair
        const byVenuePair = new Map<string, { count: number; errors: number[]; successes: number }>();
        for (const record of this.records) {
            if (!record.matched) continue;
            const key = `${record.prediction.buyVenue}→${record.prediction.sellVenue}`;
            const entry = byVenuePair.get(key) || { count: 0, errors: [], successes: 0 };
            entry.count++;
            if (record.profitErrorBps !== null) entry.errors.push(record.profitErrorBps);
            if (record.actual?.success) entry.successes++;
            byVenuePair.set(key, entry);
        }

        // By confidence bucket
        const byConfidence = new Map<string, { count: number; errors: number[]; successes: number }>();
        for (const record of this.records) {
            if (!record.matched) continue;
            const bucket = this.getConfidenceBucket(record.prediction.confidence);
            const entry = byConfidence.get(bucket) || { count: 0, errors: [], successes: 0 };
            entry.count++;
            if (record.profitErrorBps !== null) entry.errors.push(record.profitErrorBps);
            if (record.actual?.success) entry.successes++;
            byConfidence.set(bucket, entry);
        }

        // Timing
        const simTimes = this.records.filter(r => r.matched).map(r => r.prediction.simulationTimeMs);
        const execTimes = this.records.filter(r => r.actual).map(r => r.actual!.executionTimeMs);

        return {
            totalPredictions: this.records.length,
            totalMatched: matched.length + failed.length,
            totalUnmatched: this.records.filter(r => !r.matched).length,
            totalSuccessful: matched.length,
            totalFailed: failed.length,

            avgProfitErrorBps: this.avg(profitErrors),
            maxProfitErrorBps: profitErrors.length > 0 ? Math.max(...profitErrors) : 0,
            minProfitErrorBps: profitErrors.length > 0 ? Math.min(...profitErrors) : 0,
            profitWithin5Bps: this.countWithin(profitErrors, 5),
            profitWithin10Bps: this.countWithin(profitErrors, 10),
            profitWithin20Bps: this.countWithin(profitErrors, 20),

            avgTokensErrorPercent: this.avg(tokenErrors),
            tokensWithin1Percent: this.countWithin(tokenErrors, 1),
            tokensWithin2Percent: this.countWithin(tokenErrors, 2),
            tokensWithin5Percent: this.countWithin(tokenErrors, 5),

            avgSolErrorPercent: this.avg(solErrors),
            solWithin1Percent: this.countWithin(solErrors, 1),
            solWithin2Percent: this.countWithin(solErrors, 2),
            solWithin5Percent: this.countWithin(solErrors, 5),

            byVenuePair: new Map(
                Array.from(byVenuePair.entries()).map(([k, v]) => [
                    k,
                    {
                        count: v.count,
                        avgProfitErrorBps: this.avg(v.errors),
                        successRate: v.count > 0 ? v.successes / v.count : 0
                    }
                ])
            ),

            byConfidence: new Map(
                Array.from(byConfidence.entries()).map(([k, v]) => [
                    k,
                    {
                        count: v.count,
                        avgProfitErrorBps: this.avg(v.errors),
                        successRate: v.count > 0 ? v.successes / v.count : 0
                    }
                ])
            ),

            avgSimulationTimeMs: this.avg(simTimes),
            avgExecutionTimeMs: this.avg(execTimes)
        };
    }

    /**
     * Print formatted accuracy report
     */
    printReport(): void {
        const stats = this.getStats();

        console.log("\n═══════════════════════════════════════════════════════════════");
        console.log("                   SIMULATION ACCURACY REPORT                   ");
        console.log("═══════════════════════════════════════════════════════════════\n");

        console.log("OVERVIEW:");
        console.log(`  Total predictions:   ${stats.totalPredictions}`);
        console.log(`  Matched & executed:  ${stats.totalSuccessful}`);
        console.log(`  Failed executions:   ${stats.totalFailed}`);
        console.log(`  Unmatched:           ${stats.totalUnmatched}`);
        console.log();

        console.log("PROFIT ACCURACY (predicted vs actual):");
        console.log(`  Average error:       ${stats.avgProfitErrorBps.toFixed(1)} bps`);
        console.log(`  Error range:         ${stats.minProfitErrorBps.toFixed(1)} to ${stats.maxProfitErrorBps.toFixed(1)} bps`);
        console.log(`  Within ±5 bps:       ${(stats.profitWithin5Bps * 100).toFixed(1)}%`);
        console.log(`  Within ±10 bps:      ${(stats.profitWithin10Bps * 100).toFixed(1)}%`);
        console.log(`  Within ±20 bps:      ${(stats.profitWithin20Bps * 100).toFixed(1)}%`);
        console.log();

        console.log("TOKEN OUTPUT ACCURACY:");
        console.log(`  Average error:       ${stats.avgTokensErrorPercent.toFixed(2)}%`);
        console.log(`  Within ±1%:          ${(stats.tokensWithin1Percent * 100).toFixed(1)}%`);
        console.log(`  Within ±2%:          ${(stats.tokensWithin2Percent * 100).toFixed(1)}%`);
        console.log(`  Within ±5%:          ${(stats.tokensWithin5Percent * 100).toFixed(1)}%`);
        console.log();

        console.log("SOL OUTPUT ACCURACY:");
        console.log(`  Average error:       ${stats.avgSolErrorPercent.toFixed(2)}%`);
        console.log(`  Within ±1%:          ${(stats.solWithin1Percent * 100).toFixed(1)}%`);
        console.log(`  Within ±2%:          ${(stats.solWithin2Percent * 100).toFixed(1)}%`);
        console.log(`  Within ±5%:          ${(stats.solWithin5Percent * 100).toFixed(1)}%`);
        console.log();

        console.log("BY VENUE PAIR:");
        for (const [pair, data] of stats.byVenuePair) {
            console.log(`  ${pair.padEnd(25)} n=${data.count.toString().padStart(4)} | err=${data.avgProfitErrorBps.toFixed(1).padStart(6)} bps | success=${(data.successRate * 100).toFixed(0)}%`);
        }
        console.log();

        console.log("BY CONFIDENCE LEVEL:");
        for (const [bucket, data] of stats.byConfidence) {
            console.log(`  ${bucket.padEnd(12)} n=${data.count.toString().padStart(4)} | err=${data.avgProfitErrorBps.toFixed(1).padStart(6)} bps | success=${(data.successRate * 100).toFixed(0)}%`);
        }
        console.log();

        console.log("TIMING:");
        console.log(`  Avg simulation:      ${stats.avgSimulationTimeMs.toFixed(2)} ms`);
        console.log(`  Avg execution:       ${stats.avgExecutionTimeMs.toFixed(2)} ms`);
        console.log();

        console.log("═══════════════════════════════════════════════════════════════\n");
    }

    /**
     * Get recent records for inspection
     */
    getRecentRecords(n: number = 10): AccuracyRecord[] {
        return this.records.slice(-n);
    }

    /**
     * Clear all records
     */
    clear(): void {
        this.predictions.clear();
        this.records = [];
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PRIVATE HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    private avg(arr: number[]): number {
        if (arr.length === 0) return 0;
        return arr.reduce((a, b) => a + b, 0) / arr.length;
    }

    private countWithin(arr: number[], threshold: number): number {
        if (arr.length === 0) return 0;
        const within = arr.filter(e => Math.abs(e) <= threshold).length;
        return within / arr.length;
    }

    private getConfidenceBucket(confidence: number): string {
        if (confidence >= 0.95) return "95-100%";
        if (confidence >= 0.90) return "90-95%";
        if (confidence >= 0.85) return "85-90%";
        if (confidence >= 0.80) return "80-85%";
        return "<80%";
    }

    private maybeCleanup(): void {
        const now = Date.now();
        if (now - this.lastCleanup < 60_000) return;  // Cleanup at most once per minute

        this.lastCleanup = now;
        const cutoff = now - RETENTION_MS;

        // Clean old predictions
        for (const [key, pred] of this.predictions) {
            if (pred.timestamp < cutoff) {
                this.predictions.delete(key);
            }
        }

        // Clean old records
        this.records = this.records.filter(r => r.prediction.timestamp > cutoff);

        // Enforce max records
        if (this.records.length > MAX_RECORDS) {
            this.records = this.records.slice(-MAX_RECORDS);
        }
    }
}

// Singleton instance
export const simAccuracyTracker = new SimAccuracyTracker();

export default simAccuracyTracker;