// src/scripts/analyzeCapture.ts
//
// STREAMING CAPTURE ANALYZER (RAW NDJSON)
//
// Analyzes capture files without loading entirely into memory.
// Outputs raw counts and aggregates only.
//
// Usage:
//   pnpm exec ts-node src/scripts/analyzeCapture.ts ./data/capture_v2_xxxx.ndjson
//
// For legacy JSON with a top-level "transactions" array, this will auto-detect.

import * as fs from 'fs';
import { Transform } from 'stream';
import { createInterface } from 'readline';

// ============================================================================
// STREAMING JSON PARSER (legacy array format)
// ============================================================================

class TransactionExtractor extends Transform {
    private buffer = '';
    private inTransactions = false;
    private txCount = 0;

    constructor() {
        super({ objectMode: true });
    }

    _transform(chunk: Buffer, _encoding: string, callback: () => void) {
        this.buffer += chunk.toString();
        this.processBuffer();
        callback();
    }

    private processBuffer() {
        while (this.buffer.length > 0) {
            if (!this.inTransactions) {
                const txStart = this.buffer.indexOf('"transactions"');
                if (txStart === -1) {
                    if (this.buffer.length > 50) {
                        this.buffer = this.buffer.slice(-50);
                    }
                    return;
                }

                const bracketPos = this.buffer.indexOf('[', txStart);
                if (bracketPos === -1) return;

                this.buffer = this.buffer.slice(bracketPos + 1);
                this.inTransactions = true;
                continue;
            }

            let i = 0;
            while (i < this.buffer.length && /\s/.test(this.buffer[i]!)) i++;
            if (i > 0) this.buffer = this.buffer.slice(i);
            if (this.buffer.length === 0) return;

            if (this.buffer[0] === ']') {
                this.inTransactions = false;
                this.buffer = this.buffer.slice(1);
                return;
            }

            if (this.buffer[0] === ',') {
                this.buffer = this.buffer.slice(1);
                continue;
            }

            if (this.buffer[0] === '{') {
                const result = this.extractObject();
                if (result === null) return;

                try {
                    const tx = JSON.parse(result);
                    this.txCount++;
                    this.push(tx);
                } catch {
                    // Malformed JSON, skip
                }
            } else {
                this.buffer = this.buffer.slice(1);
            }
        }
    }

    private extractObject(): string | null {
        let depth = 0;
        let inString = false;
        let escape = false;

        for (let i = 0; i < this.buffer.length; i++) {
            const char = this.buffer[i]!;

            if (escape) {
                escape = false;
                continue;
            }

            if (char === '\\' && inString) {
                escape = true;
                continue;
            }

            if (char === '"') {
                inString = !inString;
                continue;
            }

            if (inString) continue;

            if (char === '{') depth++;
            if (char === '}') {
                depth--;
                if (depth === 0) {
                    const obj = this.buffer.slice(0, i + 1);
                    this.buffer = this.buffer.slice(i + 1);
                    return obj;
                }
            }
        }

        return null;
    }

    _flush(callback: () => void) {
        callback();
    }

    getCount(): number {
        return this.txCount;
    }
}

// ============================================================================
// HELPERS
// ============================================================================

function detectFormat(filepath: string): 'transactions-array' | 'ndjson' {
    const fd = fs.openSync(filepath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.slice(0, bytes).toString('utf8');
    if (head.includes('"transactions"')) return 'transactions-array';
    return 'ndjson';
}

function parseStableMints(): Set<string> {
    const raw = process.env.STABLE_MINTS ?? '';
    if (!raw.trim()) return new Set<string>();
    return new Set(raw.split(',').map((m) => m.trim()).filter(Boolean));
}

function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const k = (sorted.length - 1) * p;
    const f = Math.floor(k);
    const c = Math.ceil(k);
    if (f === c) return sorted[f]!;
    return sorted[f]! * (c - k) + sorted[c]! * (k - f);
}

function safeBigInt(v: string | number | bigint | null | undefined): bigint | null {
    if (v === null || v === undefined) return null;
    try {
        return BigInt(v);
    } catch {
        return null;
    }
}

function sampleStats(values: number[]) {
    if (values.length === 0) {
        return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };
    }
    let min = values[0]!;
    let max = values[0]!;
    let sum = 0;
    for (const v of values) {
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
    }
    return {
        count: values.length,
        min,
        max,
        mean: sum / values.length,
        p50: percentile(values, 0.5),
        p95: percentile(values, 0.95),
        p99: percentile(values, 0.99),
    };
}

// ============================================================================
// METRICS ACCUMULATORS
// ============================================================================

interface ProgramMetrics {
    totalTxs: number;
    executedTxs: number;
    failedTxs: number;
    uniqueWallets: Set<string>;
    computeUnitsSum: number;
    avgComputeUnits: number;
    errors: Map<string, number>;
}

// ============================================================================
// ANALYSIS ENGINE
// ============================================================================

class CaptureAnalyzer {
    private totalTxs = 0;
    private executedTxs = 0;
    private failedTxs = 0;
    private firstSlot = Infinity;
    private lastSlot = 0;

    private uniqueSlots = new Set<number>();
    private uniqueFeePayers = new Set<string>();

    private walletTxCounts = new Map<string, number>();
    private walletExecutedCounts = new Map<string, number>();
    private walletNetSolLamports = new Map<string, bigint>();
    private walletStableLamports = new Map<string, bigint>();

    private programMetrics = new Map<string, ProgramMetrics>();
    private errorCounts = new Map<string, number>();

    private computeUnitsSamples: number[] = [];
    private feeLamportsSamples: number[] = [];

    private addressTableLookupTxs = 0;
    private returnDataTxs = 0;
    private logTxs = 0;
    private logCountSum = 0;

    private mintCounts = new Map<string, number>();

    private capturedAtMin = Infinity;
    private capturedAtMax = 0;
    private blockTimeMissing = 0;

    private instructionCountSum = 0;
    private innerInstructionCountSum = 0;

    constructor(private stableMints: Set<string>) {}

    processTransaction(tx: any): void {
        this.totalTxs++;

        const executed = tx.executed !== false;
        const feePayer = String(tx.feePayer ?? tx.fee_payer ?? '');
        const slot = Number(tx.slot ?? 0);

        if (executed) this.executedTxs++;
        else this.failedTxs++;

        if (slot < this.firstSlot) this.firstSlot = slot;
        if (slot > this.lastSlot) this.lastSlot = slot;
        this.uniqueSlots.add(slot);

        if (feePayer) {
            this.uniqueFeePayers.add(feePayer);
            this.walletTxCounts.set(feePayer, (this.walletTxCounts.get(feePayer) ?? 0) + 1);
            if (executed) {
                this.walletExecutedCounts.set(feePayer, (this.walletExecutedCounts.get(feePayer) ?? 0) + 1);
            }
        }

        const timing = tx.timing ?? {};
        const capturedAtMs = Number(timing.capturedAtMs ?? 0);
        if (capturedAtMs > 0) {
            if (capturedAtMs < this.capturedAtMin) this.capturedAtMin = capturedAtMs;
            if (capturedAtMs > this.capturedAtMax) this.capturedAtMax = capturedAtMs;
        }
        if (timing.blockTime === null || timing.blockTime === undefined) {
            this.blockTimeMissing++;
        }

        const computeUnits = tx.computeUnitsConsumed;
        if (typeof computeUnits === 'number' && Number.isFinite(computeUnits)) {
            this.computeUnitsSamples.push(computeUnits);
        }

        const feeLamports = safeBigInt(tx.feeLamports);
        if (feeLamports !== null) {
            const feeAsNumber = Number(feeLamports);
            if (Number.isFinite(feeAsNumber)) this.feeLamportsSamples.push(feeAsNumber);
        }

        if ((tx.addressTableLookups ?? []).length > 0) this.addressTableLookupTxs++;
        if (tx.returnData) this.returnDataTxs++;

        const logMessages: string[] = tx.logMessages ?? [];
        if (logMessages.length > 0) {
            this.logTxs++;
            this.logCountSum += logMessages.length;
        }

        const errorRaw = tx.errorRaw ?? null;
        if (!executed && errorRaw) {
            this.errorCounts.set(errorRaw, (this.errorCounts.get(errorRaw) ?? 0) + 1);
        }

        const instructions: any[] = tx.instructions ?? [];
        this.instructionCountSum += instructions.length;
        for (const ix of instructions) {
            if (ix && ix.isInner) this.innerInstructionCountSum++;
        }

        // Program metrics
        const programs: string[] = tx.programsInvoked ?? [];
        for (const programId of programs) {
            if (!programId) continue;
            let metrics = this.programMetrics.get(programId);
            if (!metrics) {
                metrics = {
                    totalTxs: 0,
                    executedTxs: 0,
                    failedTxs: 0,
                    uniqueWallets: new Set<string>(),
                    computeUnitsSum: 0,
                    avgComputeUnits: 0,
                    errors: new Map<string, number>(),
                };
                this.programMetrics.set(programId, metrics);
            }
            metrics.totalTxs++;
            if (executed) metrics.executedTxs++;
            else metrics.failedTxs++;
            if (feePayer) metrics.uniqueWallets.add(feePayer);
            if (typeof computeUnits === 'number' && Number.isFinite(computeUnits)) {
                metrics.computeUnitsSum += computeUnits;
            }
            if (!executed && errorRaw) {
                metrics.errors.set(errorRaw, (metrics.errors.get(errorRaw) ?? 0) + 1);
            }
        }

        // Net SOL delta for fee payer (account index 0)
        if (feePayer) {
            const preBalances: string[] = tx.preBalances ?? [];
            const postBalances: string[] = tx.postBalances ?? [];
            const pre = safeBigInt(preBalances[0]);
            const post = safeBigInt(postBalances[0]);
            if (pre !== null && post !== null) {
                const delta = post - pre;
                this.walletNetSolLamports.set(feePayer, (this.walletNetSolLamports.get(feePayer) ?? 0n) + delta);
            }
        }

        // Token mints (raw counts)
        const preTokenBalances: any[] = tx.preTokenBalances ?? [];
        const postTokenBalances: any[] = tx.postTokenBalances ?? [];

        for (const tb of preTokenBalances) {
            const mint = tb?.mint ?? '';
            if (mint) this.mintCounts.set(mint, (this.mintCounts.get(mint) ?? 0) + 1);
        }
        for (const tb of postTokenBalances) {
            const mint = tb?.mint ?? '';
            if (mint) this.mintCounts.set(mint, (this.mintCounts.get(mint) ?? 0) + 1);
        }

        // Stablecoin deltas for fee payer (optional)
        if (feePayer && this.stableMints.size > 0) {
            const preMap = new Map<number, { mint: string; owner: string; amount: string }>();
            for (const tb of preTokenBalances) {
                const idx = tb?.accountIndex;
                if (idx === undefined) continue;
                preMap.set(Number(idx), {
                    mint: String(tb.mint ?? ''),
                    owner: String(tb.owner ?? ''),
                    amount: String(tb.amount ?? '0'),
                });
            }

            const seen = new Set<number>();
            for (const tb of postTokenBalances) {
                const idx = tb?.accountIndex;
                if (idx === undefined) continue;
                seen.add(Number(idx));

                const mint = String(tb.mint ?? '');
                const owner = String(tb.owner ?? '');
                if (!this.stableMints.has(mint) || owner !== feePayer) continue;

                const post = safeBigInt(tb.amount ?? '0') ?? 0n;
                const pre = safeBigInt(preMap.get(Number(idx))?.amount ?? '0') ?? 0n;
                const delta = post - pre;
                this.walletStableLamports.set(feePayer, (this.walletStableLamports.get(feePayer) ?? 0n) + delta);
            }

            for (const [idx, pre] of preMap) {
                if (seen.has(idx)) continue;
                if (!this.stableMints.has(pre.mint) || pre.owner !== feePayer) continue;
                const preAmt = safeBigInt(pre.amount) ?? 0n;
                const delta = 0n - preAmt;
                this.walletStableLamports.set(feePayer, (this.walletStableLamports.get(feePayer) ?? 0n) + delta);
            }
        }
    }

    finalize(): void {
        for (const [, metrics] of this.programMetrics) {
            if (metrics.totalTxs > 0) {
                metrics.avgComputeUnits = Math.round(metrics.computeUnitsSum / metrics.totalTxs);
            }
        }
    }

    generateReport(): string {
        const lines: string[] = [];
        const hr = '='.repeat(80);
        const hr2 = '-'.repeat(80);

        lines.push(hr);
        lines.push('CAPTURE ANALYSIS REPORT');
        lines.push(hr);
        lines.push('');

        lines.push('## OVERVIEW');
        lines.push(hr2);
        lines.push(`Total Transactions:    ${this.totalTxs.toLocaleString()}`);
        lines.push(`  Executed:            ${this.executedTxs.toLocaleString()} (${(this.executedTxs / this.totalTxs * 100).toFixed(2)}%)`);
        lines.push(`  Failed:              ${this.failedTxs.toLocaleString()} (${(this.failedTxs / this.totalTxs * 100).toFixed(2)}%)`);
        lines.push(`Slot Range:            ${this.firstSlot} - ${this.lastSlot} (${this.lastSlot - this.firstSlot + 1} slots)`);
        lines.push(`Unique Slots:          ${this.uniqueSlots.size.toLocaleString()}`);
        lines.push(`Unique Fee Payers:     ${this.uniqueFeePayers.size.toLocaleString()}`);
        lines.push('');

        lines.push('## TIMING FIELDS');
        lines.push(hr2);
        lines.push(`CapturedAtMs Range:    ${this.capturedAtMin} - ${this.capturedAtMax}`);
        lines.push(`Missing blockTime:     ${this.blockTimeMissing.toLocaleString()} (${(this.blockTimeMissing / this.totalTxs * 100).toFixed(2)}%)`);
        lines.push('');

        lines.push('## COMPUTE + FEES');
        lines.push(hr2);
        const cuStats = sampleStats(this.computeUnitsSamples);
        if (cuStats.count > 0) {
            lines.push(`Compute Units (p50/p95/p99): ${cuStats.p50.toFixed(0)} / ${cuStats.p95.toFixed(0)} / ${cuStats.p99.toFixed(0)}`);
            lines.push(`Compute Units (min/max): ${cuStats.min} / ${cuStats.max}`);
        }
        const feeStats = sampleStats(this.feeLamportsSamples);
        if (feeStats.count > 0) {
            lines.push(`Fee Lamports (p50/p95/p99): ${feeStats.p50.toFixed(0)} / ${feeStats.p95.toFixed(0)} / ${feeStats.p99.toFixed(0)}`);
            lines.push(`Fee Lamports (min/max): ${feeStats.min} / ${feeStats.max}`);
        }
        lines.push('');

        lines.push('## INSTRUCTIONS + LOOKUPS');
        lines.push(hr2);
        const avgIxs = this.totalTxs > 0 ? (this.instructionCountSum / this.totalTxs).toFixed(2) : '0.00';
        const avgInner = this.totalTxs > 0 ? (this.innerInstructionCountSum / this.totalTxs).toFixed(2) : '0.00';
        lines.push(`Avg instructions/tx:   ${avgIxs}`);
        lines.push(`Avg inner/tx:          ${avgInner}`);
        lines.push(`Address table txs:     ${this.addressTableLookupTxs.toLocaleString()} (${(this.addressTableLookupTxs / this.totalTxs * 100).toFixed(2)}%)`);
        lines.push(`Return data txs:       ${this.returnDataTxs.toLocaleString()} (${(this.returnDataTxs / this.totalTxs * 100).toFixed(2)}%)`);
        lines.push(`Log txs:               ${this.logTxs.toLocaleString()} (${(this.logTxs / this.totalTxs * 100).toFixed(2)}%)`);
        if (this.logTxs > 0) {
            lines.push(`Avg logs/tx (with logs): ${(this.logCountSum / this.logTxs).toFixed(2)}`);
        }
        lines.push('');

        lines.push('## PROGRAMS (TOP 20)');
        lines.push(hr2);
        const sortedPrograms = [...this.programMetrics.entries()]
            .sort((a, b) => b[1].totalTxs - a[1].totalTxs)
            .slice(0, 20);
        for (const [programId, metrics] of sortedPrograms) {
            const execRate = metrics.totalTxs > 0 ? (metrics.executedTxs / metrics.totalTxs * 100).toFixed(2) : '0.00';
            lines.push(`  ${programId}: ${metrics.totalTxs.toLocaleString()} txs, exec ${execRate}%`);
        }
        lines.push('');

        lines.push('## TOKEN MINTS (TOP 20)');
        lines.push(hr2);
        const sortedMints = [...this.mintCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20);
        for (const [mint, count] of sortedMints) {
            lines.push(`  ${mint}: ${count.toLocaleString()}`);
        }
        lines.push('');

        lines.push('## FEE PAYER ACTIVITY (TOP 30)');
        lines.push(hr2);
        const topWallets = [...this.walletTxCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 30);
        for (const [wallet, txCount] of topWallets) {
            const executed = this.walletExecutedCounts.get(wallet) ?? 0;
            const execRate = (executed / txCount * 100).toFixed(1);
            const netSol = this.walletNetSolLamports.get(wallet) ?? 0n;
            lines.push(`  ${wallet}: ${txCount.toLocaleString()} txs, exec ${execRate}%, net SOL Δ ${(Number(netSol) / 1e9).toFixed(6)}`);
        }
        lines.push('');

        if (this.stableMints.size > 0) {
            lines.push('## FEE PAYER STABLE DELTAS (TOP 20)');
            lines.push(hr2);
            const topStable = [...this.walletStableLamports.entries()]
                .sort((a, b) => (b[1] > a[1] ? 1 : -1))
                .slice(0, 20);
            for (const [wallet, delta] of topStable) {
                lines.push(`  ${wallet}: ${delta.toString()}`);
            }
            lines.push('');
        }

        lines.push('## ERRORS (TOP 20)');
        lines.push(hr2);
        const sortedErrors = [...this.errorCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20);
        for (const [err, count] of sortedErrors) {
            lines.push(`  ${err}: ${count.toLocaleString()}`);
        }
        lines.push('');

        lines.push(hr);
        lines.push('END OF REPORT');
        lines.push(hr);

        return lines.join('\n');
    }

    exportRawMetrics(): object {
        const cuStats = sampleStats(this.computeUnitsSamples);
        const feeStats = sampleStats(this.feeLamportsSamples);
        return {
            summary: {
                totalTxs: this.totalTxs,
                executedTxs: this.executedTxs,
                failedTxs: this.failedTxs,
                executionRate: this.totalTxs > 0 ? this.executedTxs / this.totalTxs : 0,
                slotRange: [this.firstSlot, this.lastSlot],
                uniqueSlots: this.uniqueSlots.size,
                uniqueFeePayers: this.uniqueFeePayers.size,
                capturedAtMsRange: [this.capturedAtMin, this.capturedAtMax],
                missingBlockTime: this.blockTimeMissing,
                addressTableLookupTxs: this.addressTableLookupTxs,
                returnDataTxs: this.returnDataTxs,
                logTxs: this.logTxs,
            },
            computeUnitsStats: cuStats,
            feeLamportsStats: feeStats,
            programs: Object.fromEntries(
                [...this.programMetrics.entries()].map(([k, v]) => [k, {
                    totalTxs: v.totalTxs,
                    executedTxs: v.executedTxs,
                    failedTxs: v.failedTxs,
                    executionRate: v.totalTxs > 0 ? v.executedTxs / v.totalTxs : 0,
                    uniqueWallets: v.uniqueWallets.size,
                    avgComputeUnits: v.avgComputeUnits,
                    errors: Object.fromEntries(v.errors),
                }])
            ),
            topWallets: [...this.walletTxCounts.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 100)
                .map(([wallet, count]) => ({
                    wallet,
                    txCount: count,
                    executed: this.walletExecutedCounts.get(wallet) ?? 0,
                    executionRate: count > 0 ? (this.walletExecutedCounts.get(wallet) ?? 0) / count : 0,
                    netSolLamports: (this.walletNetSolLamports.get(wallet) ?? 0n).toString(),
                })),
            mintCounts: Object.fromEntries(this.mintCounts),
            errorCounts: Object.fromEntries(this.errorCounts),
            stableMints: [...this.stableMints],
            walletStableDeltas: Object.fromEntries(
                [...this.walletStableLamports.entries()].map(([k, v]) => [k, v.toString()])
            ),
        };
    }
}

// ============================================================================
// MAIN
// ============================================================================

async function processNdjson(inputFile: string, analyzer: CaptureAnalyzer): Promise<number> {
    const stream = fs.createReadStream(inputFile, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    let processed = 0;
    let lastLog = Date.now();
    const startTime = Date.now();

    for await (const line of rl) {
        if (!line.trim()) continue;
        try {
            const tx = JSON.parse(line);
            analyzer.processTransaction(tx);
            processed++;
        } catch {
            // Skip malformed line
        }

        const now = Date.now();
        if (now - lastLog > 5000) {
            const elapsed = (now - startTime) / 1000;
            const rate = Math.round(processed / elapsed);
            console.log(`  Processed: ${processed.toLocaleString()} txs (${rate}/s)`);
            lastLog = now;
        }
    }

    return processed;
}

async function processLegacyArray(inputFile: string, analyzer: CaptureAnalyzer): Promise<number> {
    const extractor = new TransactionExtractor();
    const readStream = fs.createReadStream(inputFile, { highWaterMark: 64 * 1024 });

    let processed = 0;
    let lastLog = Date.now();
    const startTime = Date.now();

    await new Promise<void>((resolve, reject) => {
        readStream
            .pipe(extractor)
            .on('data', (tx: any) => {
                analyzer.processTransaction(tx);
                processed++;

                const now = Date.now();
                if (now - lastLog > 5000) {
                    const elapsed = (now - startTime) / 1000;
                    const rate = Math.round(processed / elapsed);
                    console.log(`  Processed: ${processed.toLocaleString()} txs (${rate}/s)`);
                    lastLog = now;
                }
            })
            .on('end', () => resolve())
            .on('error', (err) => reject(err));
    });

    return processed;
}

async function main(): Promise<void> {
    const inputFile = process.argv[2];

    if (!inputFile) {
        console.error('Usage: pnpm exec ts-node src/scripts/analyzeCapture.ts <capture-file.ndjson>');
        process.exit(1);
    }

    if (!fs.existsSync(inputFile)) {
        console.error(`File not found: ${inputFile}`);
        process.exit(1);
    }

    const fileStats = fs.statSync(inputFile);
    console.log('='.repeat(70));
    console.log('STREAMING CAPTURE ANALYZER');
    console.log('='.repeat(70));
    console.log(`Input:     ${inputFile}`);
    console.log(`File size: ${(fileStats.size / 1024 / 1024 / 1024).toFixed(2)} GB`);
    console.log('');
    console.log('Processing (streaming, low memory)...');

    const analyzer = new CaptureAnalyzer(parseStableMints());
    const format = detectFormat(inputFile);

    const startTime = Date.now();
    const processed = format === 'transactions-array'
        ? await processLegacyArray(inputFile, analyzer)
        : await processNdjson(inputFile, analyzer);

    const elapsed = (Date.now() - startTime) / 1000;
    console.log(`\nProcessed ${processed.toLocaleString()} transactions in ${elapsed.toFixed(1)}s`);

    analyzer.finalize();

    const base = inputFile.replace(/\.(ndjson|json)$/i, '');

    const report = analyzer.generateReport();
    const reportFile = `${base}_analysis.txt`;
    fs.writeFileSync(reportFile, report);
    console.log(`\nText report: ${reportFile}`);

    const metrics = analyzer.exportRawMetrics();
    const metricsFile = `${base}_metrics.json`;
    fs.writeFileSync(metricsFile, JSON.stringify(metrics, null, 2));
    console.log(`JSON metrics: ${metricsFile}`);

    console.log('\n' + '='.repeat(70));
    console.log('QUICK SUMMARY');
    console.log('='.repeat(70));
    const summary = (metrics as any).summary;
    console.log(`Total txs:       ${summary.totalTxs.toLocaleString()}`);
    console.log(`Execution rate:  ${(summary.executionRate * 100).toFixed(2)}%`);
    console.log(`Unique slots:    ${summary.uniqueSlots.toLocaleString()}`);
    console.log(`Unique wallets:  ${summary.uniqueFeePayers.toLocaleString()}`);
    console.log(`Missing blockTime: ${summary.missingBlockTime.toLocaleString()}`);
    console.log('');
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
