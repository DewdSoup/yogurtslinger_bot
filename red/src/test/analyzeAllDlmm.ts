// Analyze all DLMM cases to find ones with good bin coverage
import fs from "fs";
import type { CanonicalSwapCase } from "../capture/canonicalTypes";
import { decodeMeteoraLbPair } from "../decoders/meteoraLbPair";
import { decodeMeteoraBinArray, buildMeteoraBinLiquidityMap } from "../decoders/meteoraBinArray";
import { simulateMeteoraDlmmSwap } from "../sim/meteoraDLMMSim";

const DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const LBPAIR_DISC = Buffer.from("210b3162b565b10d", "hex");
const BINARRAY_DISC = Buffer.from("5c8e5cdc059446b5", "hex");

interface AnalysisResult {
    signature: string;
    activeId: number;
    binStep: number;
    direction: "xToY" | "yToX" | null;
    amountIn: bigint;
    actualOut: bigint;
    simOut: bigint;
    errorPct: number;
    binArrayCount: number;
    binsWithLiquidity: number;
    issue: string;
}

const lines = fs.readFileSync("./data/canonical_cases.ndjson", "utf8").split("\n").filter(Boolean);
const dlmmCases = lines
    .map(l => JSON.parse(l) as CanonicalSwapCase)
    .filter(c => c.venue === "meteora_dlmm");

console.log("Total DLMM cases:", dlmmCases.length);
console.log("\n=== Analyzing each case ===\n");

const results: AnalysisResult[] = [];

for (const dlmmCase of dlmmCases) {
    const result: AnalysisResult = {
        signature: dlmmCase.signature.slice(0, 16),
        activeId: 0,
        binStep: 0,
        direction: null,
        amountIn: 0n,
        actualOut: 0n,
        simOut: 0n,
        errorPct: 100,
        binArrayCount: 0,
        binsWithLiquidity: 0,
        issue: "",
    };

    try {
        // Find LbPair
        let lbPairData: Buffer | null = null;
        for (const [, acc] of Object.entries(dlmmCase.preAccounts)) {
            if (acc.owner !== DLMM_PROGRAM) continue;
            const data = Buffer.from(acc.dataBase64, "base64");
            if (data.length >= 8 && data.subarray(0, 8).equals(LBPAIR_DISC)) {
                lbPairData = data;
                break;
            }
        }
        if (!lbPairData) {
            result.issue = "No LbPair";
            results.push(result);
            continue;
        }

        const lbPair = decodeMeteoraLbPair(lbPairData);
        result.activeId = lbPair.activeId;
        result.binStep = lbPair.binStep;

        // Find BinArrays
        const binArrayBuffers: Buffer[] = [];
        for (const [, acc] of Object.entries(dlmmCase.preAccounts)) {
            if (acc.owner !== DLMM_PROGRAM) continue;
            const data = Buffer.from(acc.dataBase64, "base64");
            if (data.length >= 8 && data.subarray(0, 8).equals(BINARRAY_DISC)) {
                binArrayBuffers.push(data);
            }
        }
        result.binArrayCount = binArrayBuffers.length;

        if (binArrayBuffers.length === 0) {
            result.issue = "No BinArrays";
            results.push(result);
            continue;
        }

        const binArrays = binArrayBuffers.map(buf => decodeMeteoraBinArray(buf));
        const bins = buildMeteoraBinLiquidityMap(binArrays);

        // Count bins with liquidity
        for (const [, liq] of bins) {
            if (liq.amountX > 0n || liq.amountY > 0n) {
                result.binsWithLiquidity++;
            }
        }

        // Determine swap direction from vault deltas
        const reserveXPk = lbPair.reserveX.toBase58();
        const reserveYPk = lbPair.reserveY.toBase58();

        let reserveXDelta = 0n;
        let reserveYDelta = 0n;
        for (const [pk, tb] of Object.entries(dlmmCase.tokenBalances)) {
            const delta = BigInt(tb.postAmount) - BigInt(tb.preAmount);
            if (pk === reserveXPk) reserveXDelta = delta;
            if (pk === reserveYPk) reserveYDelta = delta;
        }

        if (reserveXDelta > 0n && reserveYDelta < 0n) {
            result.direction = "xToY";
            result.amountIn = reserveXDelta;
            result.actualOut = -reserveYDelta;
        } else if (reserveYDelta > 0n && reserveXDelta < 0n) {
            result.direction = "yToX";
            result.amountIn = reserveYDelta;
            result.actualOut = -reserveXDelta;
        } else {
            result.issue = "Can't determine direction";
            results.push(result);
            continue;
        }

        // Run simulation
        const simResult = simulateMeteoraDlmmSwap({
            lbPair,
            bins,
            direction: result.direction,
            amountIn: result.amountIn,
            feeMode: "output",
        });

        result.simOut = simResult.amountOut;
        if (result.actualOut > 0n) {
            const error = Number(result.simOut - result.actualOut);
            result.errorPct = (error / Number(result.actualOut)) * 100;
        }

        if (Math.abs(result.errorPct) < 1) {
            result.issue = "PASS";
        } else if (Math.abs(result.errorPct) < 10) {
            result.issue = "Close";
        } else {
            result.issue = "Large error";
        }

    } catch (err: any) {
        result.issue = "Error: " + err.message.slice(0, 30);
    }

    results.push(result);
}

// Summary
console.log("=== Results Summary ===\n");
const passed = results.filter(r => r.issue === "PASS").length;
const close = results.filter(r => r.issue === "Close").length;
const failed = results.filter(r => r.issue.startsWith("Large")).length;
const errors = results.filter(r => r.issue.startsWith("Error") || r.issue.startsWith("No") || r.issue.startsWith("Can't")).length;

console.log("Passed (<1% error):", passed);
console.log("Close (<10% error):", close);
console.log("Large error:", failed);
console.log("Other issues:", errors);

console.log("\n=== Detailed Results ===\n");
for (const r of results.slice(0, 20)) {
    console.log(`${r.signature}... ${r.direction || "?"} binArrays=${r.binArrayCount} liqBins=${r.binsWithLiquidity} ` +
        `error=${r.errorPct.toFixed(1)}% ${r.issue}`);
}

// Show best cases
const best = results
    .filter(r => r.issue === "PASS" || r.issue === "Close")
    .sort((a, b) => Math.abs(a.errorPct) - Math.abs(b.errorPct));

if (best.length > 0) {
    console.log("\n=== Best Cases ===\n");
    for (const r of best.slice(0, 5)) {
        console.log(`${r.signature}... ${r.direction} actual=${r.actualOut} sim=${r.simOut} error=${r.errorPct.toFixed(2)}%`);
    }
}
