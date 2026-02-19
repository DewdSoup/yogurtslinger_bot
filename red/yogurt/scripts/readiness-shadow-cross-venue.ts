#!/usr/bin/env tsx

import { createReadStream, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import readline from 'node:readline';

interface LatestSummary {
    counters?: Record<string, string>;
    latencyUs?: Record<string, string>;
    skipReasons?: Record<string, string>;
    files?: {
        jsonl?: string;
        opportunitiesJsonl?: string;
        latest?: string;
    };
}

interface OpportunityRecord {
    ts?: string;
    signatureHex?: string;
    route?: string;
    candidateInputLamports?: string;
    bestNetLamports?: string;
    bestGrossLamports?: string;
    netToInputBps?: string;
    buildSuccess?: boolean;
    buildError?: string;
}

interface GateResult {
    name: string;
    pass: boolean;
    detail: string;
}

function toBigInt(value: string | undefined): bigint {
    if (!value) return 0n;
    try {
        return BigInt(value);
    } catch {
        return 0n;
    }
}

function toNum(value: string | undefined): number {
    if (!value) return 0;
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function formatSol(lamports: bigint): string {
    return `${(Number(lamports) / 1e9).toFixed(6)} SOL`;
}

function fmtPct(numerator: number, denominator: number): string {
    if (denominator <= 0) return '0.00%';
    return `${((numerator * 100) / denominator).toFixed(2)}%`;
}

async function main(): Promise<void> {
    const latestPath = resolve(process.argv[2] ?? 'data/evidence/shadow-cross-venue-latest.json');
    const latest = JSON.parse(readFileSync(latestPath, 'utf8')) as LatestSummary;

    const oppPath = resolve(
        latest.files?.opportunitiesJsonl ??
        process.argv[3] ??
        '',
    );
    if (!oppPath) {
        throw new Error('No opportunities JSONL path provided or present in latest summary.');
    }

    const maxNetToInputBps = BigInt(Math.max(1, Number(process.env.READINESS_MAX_NET_TO_INPUT_BPS ?? '20000')));
    const maxAbsNetLamports = BigInt(Math.floor(Number(process.env.READINESS_MAX_ABS_NET_SOL ?? '5') * 1e9));
    const maxRouteEvalP95Us = Number(process.env.READINESS_MAX_ROUTE_EVAL_P95_US ?? '10000');
    const maxBuildP95Us = Number(process.env.READINESS_MAX_BUILD_P95_US ?? '12000');
    const maxDecodeP95Us = Number(process.env.READINESS_MAX_DECODE_P95_US ?? '200');
    const minOpps = Number(process.env.READINESS_MIN_OPPS ?? '10');
    const minBuildSuccessRatePct = Number(process.env.READINESS_MIN_BUILD_SUCCESS_PCT ?? '98');

    let oppCount = 0;
    let buildSuccessCount = 0;
    let totalNetLamports = 0n;
    let saneNetLamports = 0n;
    let outlierCount = 0;
    let maxNetLamports = 0n;
    let maxNetToInputSeen = 0n;
    const outlierExamples: Array<{ ts: string; signature: string; input: bigint; net: bigint; ratioBps: bigint }> = [];

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

        oppCount++;
        if (rec.buildSuccess) buildSuccessCount++;

        const net = toBigInt(rec.bestNetLamports);
        const input = toBigInt(rec.candidateInputLamports);
        totalNetLamports += net;
        if (net > maxNetLamports) maxNetLamports = net;

        const ratioBps = input > 0n ? (net * 10000n) / input : 0n;
        if (ratioBps > maxNetToInputSeen) maxNetToInputSeen = ratioBps;

        const outlier = net > maxAbsNetLamports || ratioBps > maxNetToInputBps;
        if (outlier) {
            outlierCount++;
            if (outlierExamples.length < 5) {
                outlierExamples.push({
                    ts: rec.ts ?? '',
                    signature: rec.signatureHex ?? '',
                    input,
                    net,
                    ratioBps,
                });
            }
            continue;
        }
        saneNetLamports += net;
    }

    const counters = latest.counters ?? {};
    const lat = latest.latencyUs ?? {};
    const skip = latest.skipReasons ?? {};

    const opportunitiesFound = toNum(counters.opportunitiesFound);
    const bundlesBuilt = toNum(counters.bundlesBuilt);
    const shadowBuildFailures = toNum(counters.shadowBuildFailures);
    const routeEvalP95 = toNum(lat.routeEvalP95);
    const buildP95 = toNum(lat.bundleBuildP95);
    const decodeP95 = toNum(lat.decodeP95);
    const buildSuccessPct = oppCount > 0 ? (buildSuccessCount * 100) / oppCount : 0;

    const gates: GateResult[] = [
        {
            name: 'opportunity sample size',
            pass: opportunitiesFound >= minOpps,
            detail: `${opportunitiesFound} found (min ${minOpps})`,
        },
        {
            name: 'bundle build health',
            pass: buildSuccessPct >= minBuildSuccessRatePct && shadowBuildFailures === 0,
            detail: `buildSuccess=${buildSuccessCount}/${oppCount} (${buildSuccessPct.toFixed(2)}%), shadowBuildFailures=${shadowBuildFailures}`,
        },
        {
            name: 'route latency p95',
            pass: routeEvalP95 > 0 && routeEvalP95 <= maxRouteEvalP95Us,
            detail: `${routeEvalP95}us (max ${maxRouteEvalP95Us}us)`,
        },
        {
            name: 'bundle build latency p95',
            pass: buildP95 > 0 && buildP95 <= maxBuildP95Us,
            detail: `${buildP95}us (max ${maxBuildP95Us}us)`,
        },
        {
            name: 'decode latency p95',
            pass: decodeP95 >= 0 && decodeP95 <= maxDecodeP95Us,
            detail: `${decodeP95}us (max ${maxDecodeP95Us}us)`,
        },
        {
            name: 'profit outlier filter',
            pass: outlierCount === 0,
            detail: `outliers=${outlierCount}/${oppCount} (${fmtPct(outlierCount, oppCount)}), thresholds maxAbs=${formatSol(maxAbsNetLamports)} maxRatio=${maxNetToInputBps}bps`,
        },
    ];

    const passCount = gates.filter(g => g.pass).length;
    const ready = passCount === gates.length;

    console.log('Shadow readiness report');
    console.log(`  latest      : ${latestPath}`);
    console.log(`  opportunities: ${oppPath}`);
    console.log(`  opps/built  : found=${opportunitiesFound} built=${bundlesBuilt} oppRecords=${oppCount}`);
    console.log(`  net total   : ${formatSol(totalNetLamports)} (raw)`);
    console.log(`  net sane    : ${formatSol(saneNetLamports)} (outliers removed)`);
    console.log(`  max net     : ${formatSol(maxNetLamports)} | max net/input: ${maxNetToInputSeen}bps`);
    console.log(`  sanity skips: abs=${skip.sanity_abs_net_exceeded ?? '0'} ratio=${skip.sanity_net_to_input_exceeded ?? '0'} noSane=${skip.no_sane_profitable_route ?? '0'}`);
    console.log('');
    console.log('Gates:');
    for (const gate of gates) {
        console.log(`  [${gate.pass ? 'PASS' : 'FAIL'}] ${gate.name}: ${gate.detail}`);
    }
    console.log('');
    console.log(`Verdict: ${ready ? 'SHADOW_READY_FOR_CANARY' : 'NOT_READY_FOR_LIVE'} (${passCount}/${gates.length} gates passed)`);

    if (outlierExamples.length > 0) {
        console.log('');
        console.log('Outlier examples:');
        for (const ex of outlierExamples) {
            console.log(
                `  ts=${ex.ts} sig=${ex.signature.slice(0, 16)}... input=${formatSol(ex.input)} ` +
                `net=${formatSol(ex.net)} ratio=${ex.ratioBps}bps`,
            );
        }
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});

