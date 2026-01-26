// src/test/dlmmRegression.ts
//
// DLMM regression test against captured on-chain swap data.
// Validates that our simulator matches actual vault deltas.

import fs from "fs";
import { decodeMeteoraLbPair, type MeteoraLbPairState } from "../decoders/meteoraLbPair";
import { decodeMeteoraBinArray, buildMeteoraBinLiquidityMap } from "../decoders/meteoraBinArray";
import { simulateMeteoraDlmmSwap, type MeteoraSwapDirection } from "../sim/meteoraDLMMSim";
import type { CanonicalSwapCase } from "../capture/canonicalTypes";

interface ValidationResult {
    signature: string;
    slot: number;
    passed: boolean;
    simAmountOut: bigint;
    actualDelta: bigint;
    error: bigint;
    errorPct: number;
    direction: MeteoraSwapDirection | null;
    details?: string;
}

function findLbPairAccount(preAccounts: Record<string, { dataBase64: string; owner: string }>): { pubkey: string; data: Buffer } | null {
    const DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
    const LBPAIR_DISC = Buffer.from("210b3162b565b10d", "hex");

    for (const [pubkey, acc] of Object.entries(preAccounts)) {
        if (acc.owner !== DLMM_PROGRAM) continue;
        const data = Buffer.from(acc.dataBase64, "base64");
        if (data.length >= 8 && data.subarray(0, 8).equals(LBPAIR_DISC)) {
            return { pubkey, data };
        }
    }
    return null;
}

function findBinArrayAccounts(preAccounts: Record<string, { dataBase64: string; owner: string }>): Buffer[] {
    const DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
    const BINARRAY_DISC = Buffer.from("5c8e5cdc059446b5", "hex");

    const results: Buffer[] = [];
    for (const [, acc] of Object.entries(preAccounts)) {
        if (acc.owner !== DLMM_PROGRAM) continue;
        const data = Buffer.from(acc.dataBase64, "base64");
        if (data.length >= 8 && data.subarray(0, 8).equals(BINARRAY_DISC)) {
            results.push(data);
        }
    }
    return results;
}

function extractVaultDeltas(tokenBalances: Record<string, {
    preAmount: string;
    postAmount: string;
    mint?: string;
}>): Map<string, bigint> {
    const deltas = new Map<string, bigint>();
    for (const [pubkey, tb] of Object.entries(tokenBalances)) {
        const pre = BigInt(tb.preAmount);
        const post = BigInt(tb.postAmount);
        const delta = post - pre;
        if (delta !== 0n) {
            deltas.set(pubkey, delta);
        }
    }
    return deltas;
}

function determineSwapDirection(
    lbPair: MeteoraLbPairState,
    vaultDeltas: Map<string, bigint>,
    _tokenBalances: Record<string, { preAmount: string; postAmount: string; mint?: string }>
): { direction: MeteoraSwapDirection; amountIn: bigint; expectedOut: bigint } | null {
    // Find which vaults changed
    // DLMM has reserveX and reserveY vaults
    // xToY: user sends X (reserveX increases), receives Y (reserveY decreases)
    // yToX: user sends Y (reserveY increases), receives X (reserveX decreases)

    const reserveXPk = lbPair.reserveX.toBase58();
    const reserveYPk = lbPair.reserveY.toBase58();

    let reserveXDelta = 0n;
    let reserveYDelta = 0n;

    for (const [pk, delta] of vaultDeltas) {
        if (pk === reserveXPk) reserveXDelta = delta;
        if (pk === reserveYPk) reserveYDelta = delta;
    }

    // Check for deltas in the token balances by looking at the actual token accounts
    // This is a fallback if we can't identify by pubkey
    if (reserveXDelta === 0n && reserveYDelta === 0n) {
        // Try to find by looking at all deltas
        const allDeltas = [...vaultDeltas.entries()];
        if (allDeltas.length >= 2) {
            // Assume the two largest magnitude deltas are the swap
            const sorted = allDeltas.sort((a, b) => {
                const absA = a[1] < 0n ? -a[1] : a[1];
                const absB = b[1] < 0n ? -b[1] : b[1];
                return Number(absB - absA);
            });
            // One should be positive (in), one negative (out)
            for (const [, delta] of sorted.slice(0, 2)) {
                if (delta > 0n) reserveXDelta = delta; // assume this is input
                if (delta < 0n) reserveYDelta = delta; // assume this is output
            }
        }
    }

    if (reserveXDelta > 0n && reserveYDelta < 0n) {
        // X increased, Y decreased -> xToY swap
        return {
            direction: "xToY",
            amountIn: reserveXDelta,
            expectedOut: -reserveYDelta, // negate to make positive
        };
    } else if (reserveYDelta > 0n && reserveXDelta < 0n) {
        // Y increased, X decreased -> yToX swap
        return {
            direction: "yToX",
            amountIn: reserveYDelta,
            expectedOut: -reserveXDelta,
        };
    }

    return null;
}

function validateCase(caseData: CanonicalSwapCase): ValidationResult {
    const result: ValidationResult = {
        signature: caseData.signature,
        slot: caseData.slot,
        passed: false,
        simAmountOut: 0n,
        actualDelta: 0n,
        error: 0n,
        errorPct: 0,
        direction: null,
    };

    try {
        // Find LbPair account
        const lbPairAcc = findLbPairAccount(caseData.preAccounts);
        if (!lbPairAcc) {
            result.details = "No LbPair account found";
            return result;
        }

        // Decode LbPair
        const lbPair = decodeMeteoraLbPair(lbPairAcc.data);

        // Find and decode BinArrays
        const binArrayBuffers = findBinArrayAccounts(caseData.preAccounts);
        if (binArrayBuffers.length === 0) {
            result.details = "No BinArray accounts found";
            return result;
        }

        const binArrays = binArrayBuffers.map(buf => decodeMeteoraBinArray(buf));
        const bins = buildMeteoraBinLiquidityMap(binArrays);

        // Extract vault deltas
        const vaultDeltas = extractVaultDeltas(caseData.tokenBalances);

        // Determine swap direction
        const swapInfo = determineSwapDirection(lbPair, vaultDeltas, caseData.tokenBalances);
        if (!swapInfo) {
            result.details = "Could not determine swap direction from vault deltas";
            return result;
        }

        result.direction = swapInfo.direction;
        result.actualDelta = swapInfo.expectedOut;

        // Run simulation
        const simResult = simulateMeteoraDlmmSwap({
            lbPair,
            bins,
            direction: swapInfo.direction,
            amountIn: swapInfo.amountIn,
            feeMode: "output",
        });

        result.simAmountOut = simResult.amountOut;
        result.error = result.simAmountOut - result.actualDelta;

        // Calculate error percentage
        if (result.actualDelta !== 0n) {
            result.errorPct = Math.abs(Number(result.error) / Number(result.actualDelta)) * 100;
        }

        // Pass if error is within 0.1% (for fee rounding differences)
        result.passed = result.errorPct < 0.1;

        if (!result.passed) {
            result.details = `Error: ${result.error} (${result.errorPct.toFixed(4)}%)`;
        }

    } catch (err: any) {
        result.details = `Exception: ${err.message}`;
    }

    return result;
}

async function main() {
    const dataPath = process.argv[2] ?? "./data/canonical_cases.ndjson";
    const maxCases = parseInt(process.argv[3] ?? "0", 10);

    console.log("=".repeat(60));
    console.log("DLMM REGRESSION TEST");
    console.log("=".repeat(60));
    console.log(`Data file: ${dataPath}`);
    console.log();

    if (!fs.existsSync(dataPath)) {
        console.error(`Data file not found: ${dataPath}`);
        process.exit(1);
    }

    const lines = fs.readFileSync(dataPath, "utf8").split("\n").filter(Boolean);

    const dlmmCases = lines
        .map(line => JSON.parse(line) as CanonicalSwapCase)
        .filter(c => c.venue === "meteora_dlmm");

    const casesToTest = maxCases > 0 ? dlmmCases.slice(0, maxCases) : dlmmCases;

    console.log(`Found ${dlmmCases.length} DLMM cases, testing ${casesToTest.length}`);
    console.log();

    const results: ValidationResult[] = [];
    let passed = 0;
    let failed = 0;

    for (const caseData of casesToTest) {
        const result = validateCase(caseData);
        results.push(result);

        if (result.passed) {
            passed++;
            console.log(`[PASS] ${result.signature.slice(0, 16)}... ${result.direction} error=${result.errorPct.toFixed(4)}%`);
        } else {
            failed++;
            console.log(`[FAIL] ${result.signature.slice(0, 16)}... ${result.direction ?? "?"} ${result.details}`);
        }
    }

    console.log();
    console.log("=".repeat(60));
    console.log("RESULTS");
    console.log("=".repeat(60));
    console.log(`Total:  ${casesToTest.length}`);
    console.log(`Passed: ${passed} (${((passed / casesToTest.length) * 100).toFixed(1)}%)`);
    console.log(`Failed: ${failed} (${((failed / casesToTest.length) * 100).toFixed(1)}%)`);

    if (failed > 0) {
        console.log();
        console.log("Failed cases:");
        for (const r of results.filter(r => !r.passed)) {
            console.log(`  ${r.signature.slice(0, 24)}... ${r.details}`);
        }
    }

    // Exit with error if any failed
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error("Regression test failed:", err);
    process.exit(1);
});
