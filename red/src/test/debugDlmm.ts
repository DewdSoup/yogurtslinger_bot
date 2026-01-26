// Debug script for DLMM regression
import fs from "fs";
import { decodeMeteoraLbPair } from "../decoders/meteoraLbPair";
import { decodeMeteoraBinArray, buildMeteoraBinLiquidityMap } from "../decoders/meteoraBinArray";
import { simulateMeteoraDlmmSwap } from "../sim/meteoraDLMMSim";
import type { CanonicalSwapCase } from "../capture/canonicalTypes";

const DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const LBPAIR_DISC = Buffer.from("210b3162b565b10d", "hex");
const BINARRAY_DISC = Buffer.from("5c8e5cdc059446b5", "hex");

const lines = fs.readFileSync("./data/canonical_cases.ndjson", "utf8").split("\n").filter(Boolean);
const dlmmCase = lines.map(l => JSON.parse(l) as CanonicalSwapCase).find(c => c.venue === "meteora_dlmm");

if (!dlmmCase) {
    console.log("No DLMM case found");
    process.exit(1);
}

console.log("=== DLMM Case Debug ===");
console.log("Signature:", dlmmCase.signature);
console.log("Slot:", dlmmCase.slot);
console.log("\nPreAccounts:", Object.keys(dlmmCase.preAccounts).length);

// Find LbPair
let lbPairData: Buffer | null = null;
for (const [pk, acc] of Object.entries(dlmmCase.preAccounts)) {
    if (acc.owner !== DLMM_PROGRAM) continue;
    const data = Buffer.from(acc.dataBase64, "base64");
    if (data.length >= 8 && data.subarray(0, 8).equals(LBPAIR_DISC)) {
        lbPairData = data;
        console.log("\nFound LbPair:", pk.slice(0,20) + "... (" + data.length + " bytes)");
    }
}

if (!lbPairData) {
    console.log("No LbPair found!");
    process.exit(1);
}

// Decode LbPair
const lbPair = decodeMeteoraLbPair(lbPairData);
console.log("\nLbPair decoded:");
console.log("  tokenXMint:", lbPair.tokenXMint.toBase58().slice(0,20) + "...");
console.log("  tokenYMint:", lbPair.tokenYMint.toBase58().slice(0,20) + "...");
console.log("  reserveX:", lbPair.reserveX.toBase58().slice(0,20) + "...");
console.log("  reserveY:", lbPair.reserveY.toBase58().slice(0,20) + "...");
console.log("  activeId:", lbPair.activeId);
console.log("  binStep:", lbPair.binStep);
console.log("  baseFactor:", lbPair.baseFactor);
console.log("  protocolShare:", lbPair.protocolShare);

// Find BinArrays
const binArrayBuffers: Buffer[] = [];
for (const [pk, acc] of Object.entries(dlmmCase.preAccounts)) {
    if (acc.owner !== DLMM_PROGRAM) continue;
    const data = Buffer.from(acc.dataBase64, "base64");
    if (data.length >= 8 && data.subarray(0, 8).equals(BINARRAY_DISC)) {
        binArrayBuffers.push(data);
        console.log("\nFound BinArray:", pk.slice(0,20) + "... (" + data.length + " bytes)");
    }
}

console.log("\nTotal BinArrays:", binArrayBuffers.length);

// Decode BinArrays
const binArrays = binArrayBuffers.map(buf => decodeMeteoraBinArray(buf));
console.log("\nBinArray indices:", binArrays.map(b => b.index.toString()));

// Build bin map
const bins = buildMeteoraBinLiquidityMap(binArrays);
console.log("\nBin map size:", bins.size);
console.log("Sample bins around activeId:", lbPair.activeId);

// Show bins around activeId
for (let i = lbPair.activeId - 5; i <= lbPair.activeId + 5; i++) {
    const bin = bins.get(i);
    if (bin) {
        console.log("  Bin " + i + ": X=" + bin.amountX + ", Y=" + bin.amountY);
    }
}

// Get vault deltas
console.log("\n=== Token Balance Changes ===");
const vaultDeltas = new Map<string, bigint>();
for (const [pk, tb] of Object.entries(dlmmCase.tokenBalances)) {
    const pre = BigInt(tb.preAmount);
    const post = BigInt(tb.postAmount);
    const delta = post - pre;
    if (delta !== 0n) {
        const sign = delta > 0n ? "+" : "";
        console.log("  " + pk.slice(0,20) + "... delta=" + sign + delta);
        vaultDeltas.set(pk, delta);
    }
}

// Determine swap direction
const reserveXPk = lbPair.reserveX.toBase58();
const reserveYPk = lbPair.reserveY.toBase58();
console.log("\nReserveX pubkey:", reserveXPk.slice(0,20) + "...");
console.log("ReserveY pubkey:", reserveYPk.slice(0,20) + "...");

let reserveXDelta = vaultDeltas.get(reserveXPk) ?? 0n;
let reserveYDelta = vaultDeltas.get(reserveYPk) ?? 0n;

console.log("\nReserveX delta:", reserveXDelta.toString());
console.log("ReserveY delta:", reserveYDelta.toString());

let direction: "xToY" | "yToX" | null = null;
let amountIn = 0n;
let expectedOut = 0n;

if (reserveXDelta > 0n && reserveYDelta < 0n) {
    direction = "xToY";
    amountIn = reserveXDelta;
    expectedOut = -reserveYDelta;
} else if (reserveYDelta > 0n && reserveXDelta < 0n) {
    direction = "yToX";
    amountIn = reserveYDelta;
    expectedOut = -reserveXDelta;
}

console.log("\nDirection:", direction);
console.log("AmountIn:", amountIn.toString());
console.log("ExpectedOut (actual):", expectedOut.toString());

if (!direction) {
    console.log("Could not determine swap direction!");
    process.exit(1);
}

// Run simulation
console.log("\n=== Running Simulation ===");
try {
    const simResult = simulateMeteoraDlmmSwap({
        lbPair,
        bins,
        direction,
        amountIn,
        feeMode: "output",
    });
    console.log("Simulation result:");
    console.log("  amountOut:", simResult.amountOut.toString());
    console.log("  feeTotal:", simResult.feeTotal.toString());
    console.log("  startBinId:", simResult.startBinId);
    console.log("  endBinId:", simResult.endBinId);
    console.log("\nComparison:");
    console.log("  Expected (actual):", expectedOut.toString());
    console.log("  Simulated:", simResult.amountOut.toString());
    const error = simResult.amountOut - expectedOut;
    console.log("  Error:", error.toString());
    const errorPct = Number(error) / Number(expectedOut) * 100;
    console.log("  Error %:", errorPct.toFixed(4) + "%");
} catch (err: any) {
    console.log("Simulation error:", err.message);
    console.log(err.stack);
}
