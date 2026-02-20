#!/usr/bin/env tsx

import { createReadStream, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import readline from 'node:readline';

interface LatestSummary {
    files?: {
        opportunitiesJsonl?: string;
    };
}

interface OpportunityRecord {
    ts?: string;
    signatureHex?: string;
    bestNetLamports?: string;
    candidateInputLamports?: string;
    netToInputBps?: string;
    buildSuccess?: boolean;
}

function toBigInt(value: string | undefined): bigint {
    if (!value) return 0n;
    try {
        return BigInt(value);
    } catch {
        return 0n;
    }
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
    return sorted[idx]!;
}

function mean(values: number[]): number {
    if (values.length === 0) return 0;
    let sum = 0;
    for (const v of values) sum += v;
    return sum / values.length;
}

function stddevSample(values: number[]): number {
    if (values.length < 2) return 0;
    const m = mean(values);
    let sumSq = 0;
    for (const v of values) {
        const d = v - m;
        sumSq += d * d;
    }
    return Math.sqrt(sumSq / (values.length - 1));
}

function fmtSol(sol: number): string {
    return `${sol.toFixed(6)} SOL`;
}

function fmtPct(v: number): string {
    return `${v.toFixed(2)}%`;
}

async function main(): Promise<void> {
    const latestPath = resolve(process.argv[2] ?? 'data/evidence/shadow-cross-venue-latest.json');
    const latest = JSON.parse(readFileSync(latestPath, 'utf8')) as LatestSummary;

    const oppPath = resolve(latest.files?.opportunitiesJsonl ?? process.argv[3] ?? '');
    if (!oppPath) {
        throw new Error('No opportunities JSONL path found in latest summary and no argv[3] provided.');
    }

    const goalSolPerDay = Number(process.env.GOAL_SOL_PER_DAY ?? '8');
    const minDurationHours = Number(process.env.PROVE_MIN_DURATION_HOURS ?? '2');
    const minOpportunities = Number(process.env.PROVE_MIN_OPPS ?? '60');
    const maxNetToInputBps = BigInt(Math.max(1, Number(process.env.PROVE_MAX_NET_TO_INPUT_BPS ?? '20000')));
    const maxAbsNetLamports = BigInt(Math.floor(Number(process.env.PROVE_MAX_ABS_NET_SOL ?? '5') * 1e9));

    let total = 0;
    let usable = 0;
    let outliers = 0;
    let firstTsMs = Number.POSITIVE_INFINITY;
    let lastTsMs = 0;
    const netSolSamples: number[] = [];
    let totalNetSaneLamports = 0n;
    const uniqueSigs = new Set<string>();

    const reader = readline.createInterface({
        input: createReadStream(oppPath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
    });

    for await (const line of reader) {
        if (!line) continue;
        let rec: OpportunityRecord;
        try {
            rec = JSON.parse(line) as OpportunityRecord;
        } catch {
            continue;
        }

        if (!rec.buildSuccess) continue;
        total++;
        if (rec.signatureHex) uniqueSigs.add(rec.signatureHex);

        const tsMs = rec.ts ? Date.parse(rec.ts) : NaN;
        if (Number.isFinite(tsMs)) {
            if (tsMs < firstTsMs) firstTsMs = tsMs;
            if (tsMs > lastTsMs) lastTsMs = tsMs;
        }

        const input = toBigInt(rec.candidateInputLamports);
        const net = toBigInt(rec.bestNetLamports);
        const ratio = input > 0n ? (net * 10000n) / input : 0n;
        const outlier = net > maxAbsNetLamports || ratio > maxNetToInputBps;
        if (outlier) {
            outliers++;
            continue;
        }

        usable++;
        totalNetSaneLamports += net;
        netSolSamples.push(Number(net) / 1e9);
    }

    if (usable === 0 || !Number.isFinite(firstTsMs) || lastTsMs <= firstTsMs) {
        console.log('Shadow goal proof');
        console.log(`  latest: ${latestPath}`);
        console.log(`  opportunities: ${oppPath}`);
        console.log('Verdict: INSUFFICIENT_DATA');
        process.exit(0);
    }

    const durationHours = (lastTsMs - firstTsMs) / 3_600_000;
    const oppRatePerHour = usable / durationHours;
    const oppRatePerDay = oppRatePerHour * 24;
    const netSolTotal = Number(totalNetSaneLamports) / 1e9;
    const projectedRawSolPerDay = netSolTotal / durationHours * 24;

    const sorted = [...netSolSamples].sort((a, b) => a - b);
    const p10 = percentile(sorted, 0.10);
    const p50 = percentile(sorted, 0.50);
    const p90 = percentile(sorted, 0.90);
    const meanNet = mean(netSolSamples);
    const std = stddevSample(netSolSamples);
    const meanLcb95 = Math.max(0, meanNet - (1.96 * std / Math.sqrt(netSolSamples.length)));
    const projectedLcb95SolPerDay = meanLcb95 * oppRatePerDay;
    const projectedP10SolPerDay = p10 * oppRatePerDay;

    const coveragePass = durationHours >= minDurationHours;
    const samplePass = usable >= minOpportunities;
    const outlierPass = outliers === 0;
    const goalPass = projectedLcb95SolPerDay >= goalSolPerDay;
    const allPass = coveragePass && samplePass && outlierPass && goalPass;

    console.log('Shadow goal proof');
    console.log(`  latest            : ${latestPath}`);
    console.log(`  opportunities     : ${oppPath}`);
    console.log(`  duration          : ${durationHours.toFixed(2)}h`);
    console.log(`  opportunities     : usable=${usable} totalBuilt=${total} uniqueSigs=${uniqueSigs.size}`);
    console.log(`  outliers          : ${outliers}/${total} (${fmtPct(total > 0 ? (outliers * 100) / total : 0)})`);
    console.log(`  opp rate          : ${oppRatePerHour.toFixed(2)}/h (${oppRatePerDay.toFixed(0)}/day)`);
    console.log(`  net/opp (p10/p50/p90): ${fmtSol(p10)} / ${fmtSol(p50)} / ${fmtSol(p90)}`);
    console.log(`  projected/day raw : ${fmtSol(projectedRawSolPerDay)}`);
    console.log(`  projected/day p10 : ${fmtSol(projectedP10SolPerDay)}`);
    console.log(`  projected/day LCB95(mean): ${fmtSol(projectedLcb95SolPerDay)} (goal ${fmtSol(goalSolPerDay)})`);
    console.log('');
    console.log('Gates:');
    console.log(`  [${coveragePass ? 'PASS' : 'FAIL'}] duration >= ${minDurationHours}h`);
    console.log(`  [${samplePass ? 'PASS' : 'FAIL'}] usable opportunities >= ${minOpportunities}`);
    console.log(`  [${outlierPass ? 'PASS' : 'FAIL'}] zero outliers`);
    console.log(`  [${goalPass ? 'PASS' : 'FAIL'}] LCB95 daily projection >= goal`);
    console.log('');
    console.log(`Verdict: ${allPass ? 'PROVED_IN_SHADOW' : 'NOT_PROVED_IN_SHADOW'}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});

