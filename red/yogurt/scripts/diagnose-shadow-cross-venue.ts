#!/usr/bin/env tsx

import { createReadStream, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import readline from 'node:readline';

type ShadowReason =
    | 'decode_failed'
    | 'no_counterpart_pool'
    | 'counterpart_snapshot_missing_bin_arrays'
    | 'no_profitable_route'
    | 'no_evaluable_counterpart'
    | string;

interface LatestSummary {
    files?: {
        jsonl?: string;
    };
    counters?: Record<string, string>;
    skipReasons?: Record<string, string>;
    pairIndex?: {
        trackedPairs: number;
        trackedPools: number;
    };
    latencyUs?: Record<string, string>;
}

interface ShadowRecord {
    signatureHex?: string;
    reason?: ShadowReason;
    pairKey?: string;
}

function toNum(v: string | undefined): number {
    if (!v) return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function topEntries(map: Map<string, number>, limit = 10): Array<[string, number]> {
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

async function main(): Promise<void> {
    const latestPath = resolve(process.argv[2] ?? 'data/evidence/shadow-cross-venue-latest.json');
    const latest = JSON.parse(readFileSync(latestPath, 'utf8')) as LatestSummary;
    const jsonlPath = resolve(latest.files?.jsonl ?? process.argv[3] ?? '');
    if (!jsonlPath) {
        throw new Error('No JSONL path found in latest summary and none provided as argv[3].');
    }

    const reasonCounts = new Map<string, number>();
    const signaturesByReason = new Map<string, Set<string>>();
    const noCounterpartPairs = new Map<string, number>();
    const missingBinPairs = new Map<string, number>();

    const lineReader = readline.createInterface({
        input: createReadStream(jsonlPath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
    });

    for await (const line of lineReader) {
        if (!line) continue;

        let rec: ShadowRecord;
        try {
            rec = JSON.parse(line) as ShadowRecord;
        } catch {
            continue;
        }

        const reason = rec.reason ?? '(none)';
        reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);

        if (rec.signatureHex) {
            if (!signaturesByReason.has(reason)) signaturesByReason.set(reason, new Set());
            signaturesByReason.get(reason)!.add(rec.signatureHex);
        }

        if (reason === 'no_counterpart_pool' && rec.pairKey) {
            noCounterpartPairs.set(rec.pairKey, (noCounterpartPairs.get(rec.pairKey) ?? 0) + 1);
        }
        if (reason === 'counterpart_snapshot_missing_bin_arrays' && rec.pairKey) {
            missingBinPairs.set(rec.pairKey, (missingBinPairs.get(rec.pairKey) ?? 0) + 1);
        }
    }

    const noProfitableSigs = signaturesByReason.get('no_profitable_route') ?? new Set<string>();
    const missingBinSigs = signaturesByReason.get('counterpart_snapshot_missing_bin_arrays') ?? new Set<string>();
    let noProfitableWithMissingBins = 0;
    for (const sig of noProfitableSigs) {
        if (missingBinSigs.has(sig)) noProfitableWithMissingBins++;
    }

    const shred = toNum(latest.counters?.shredTxsReceived);
    const swaps = toNum(latest.counters?.swapsDetected);
    const candidates = toNum(latest.counters?.candidateEvaluations);
    const routes = toNum(latest.counters?.routeEvaluations);
    const opps = toNum(latest.counters?.opportunitiesFound);

    console.log('Shadow cross-venue diagnosis');
    console.log(`  latest     : ${latestPath}`);
    console.log(`  jsonl      : ${jsonlPath}`);
    console.log(`  shred_txs  : ${shred}`);
    console.log(`  swaps      : ${swaps}`);
    console.log(`  candidates : ${candidates}`);
    console.log(`  routes     : ${routes}`);
    console.log(`  opps       : ${opps}`);
    console.log(`  pair_index : pairs=${latest.pairIndex?.trackedPairs ?? 0} pools=${latest.pairIndex?.trackedPools ?? 0}`);
    if (latest.latencyUs) {
        console.log(
            `  latency_us : decode p50=${latest.latencyUs.decodeP50 ?? '0'} p95=${latest.latencyUs.decodeP95 ?? '0'} ` +
            `routeEval p50=${latest.latencyUs.routeEvalP50 ?? '0'} p95=${latest.latencyUs.routeEvalP95 ?? '0'} ` +
            `build p50=${latest.latencyUs.bundleBuildP50 ?? '0'} p95=${latest.latencyUs.bundleBuildP95 ?? '0'}`,
        );
    }

    console.log('\nTop skip reasons:');
    for (const [reason, count] of [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
        console.log(`  ${reason}: ${count}`);
    }

    if (noProfitableSigs.size > 0) {
        const pct = (100 * noProfitableWithMissingBins) / noProfitableSigs.size;
        console.log('\nNo-profitable overlap:');
        console.log(`  no_profitable signatures        : ${noProfitableSigs.size}`);
        console.log(`  with missing-bin same signature : ${noProfitableWithMissingBins} (${pct.toFixed(2)}%)`);
    }

    console.log('\nTop no_counterpart pairs:');
    for (const [pair, count] of topEntries(noCounterpartPairs, 10)) {
        console.log(`  ${count} ${pair}`);
    }

    console.log('\nTop missing-bin pairs:');
    for (const [pair, count] of topEntries(missingBinPairs, 10)) {
        console.log(`  ${count} ${pair}`);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
