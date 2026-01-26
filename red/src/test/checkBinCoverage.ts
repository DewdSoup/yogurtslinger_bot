// Check bin coverage for DLMM swap
import fs from "fs";
import type { CanonicalSwapCase } from "../capture/canonicalTypes";
import { decodeMeteoraLbPair } from "../decoders/meteoraLbPair";
import { decodeMeteoraBinArray, buildMeteoraBinLiquidityMap, type MeteoraBinArray } from "../decoders/meteoraBinArray";

const DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const LBPAIR_DISC = Buffer.from("210b3162b565b10d", "hex");
const BINARRAY_DISC = Buffer.from("5c8e5cdc059446b5", "hex");

const lines = fs.readFileSync("./data/canonical_cases.ndjson", "utf8").split("\n").filter(Boolean);
const dlmmCase = lines.map(l => JSON.parse(l) as CanonicalSwapCase).find(c => c.venue === "meteora_dlmm");

if (!dlmmCase) {
    console.log("No DLMM case found");
    process.exit(1);
}

// Find and decode LbPair
let lbPairData: Buffer | null = null;
let lbPairPk = "";
for (const [pk, acc] of Object.entries(dlmmCase.preAccounts)) {
    if (acc.owner !== DLMM_PROGRAM) continue;
    const data = Buffer.from(acc.dataBase64, "base64");
    if (data.length >= 8 && data.subarray(0, 8).equals(LBPAIR_DISC)) {
        lbPairData = data;
        lbPairPk = pk;
    }
}

if (!lbPairData) {
    console.log("No LbPair found!");
    process.exit(1);
}

const lbPair = decodeMeteoraLbPair(lbPairData);
console.log("=== LbPair Info ===");
console.log("Address:", lbPairPk);
console.log("ActiveId:", lbPair.activeId);
console.log("BinStep:", lbPair.binStep);
console.log("MinBinId:", lbPair.minBinId);
console.log("MaxBinId:", lbPair.maxBinId);

// Find all BinArrays
const binArrays: MeteoraBinArray[] = [];
for (const [pk, acc] of Object.entries(dlmmCase.preAccounts)) {
    if (acc.owner !== DLMM_PROGRAM) continue;
    const data = Buffer.from(acc.dataBase64, "base64");
    if (data.length >= 8 && data.subarray(0, 8).equals(BINARRAY_DISC)) {
        const decoded = decodeMeteoraBinArray(data);
        console.log("\nBinArray:", pk.slice(0, 20) + "...");
        console.log("  Index:", decoded.index.toString());
        console.log("  StartBinId:", decoded.startBinId.toString());
        console.log("  EndBinId:", (Number(decoded.startBinId) + 69).toString());
        console.log("  LbPair ref:", decoded.lbPair.toBase58().slice(0, 20) + "...");
        binArrays.push(decoded);
    }
}

// Build bin map and analyze coverage
const bins = buildMeteoraBinLiquidityMap(binArrays);
console.log("\n=== Bin Coverage Analysis ===");
console.log("Total bins in map:", bins.size);

// Find bin range
let minBin = Infinity;
let maxBin = -Infinity;
let totalX = 0n;
let totalY = 0n;
for (const [binId, liq] of bins) {
    minBin = Math.min(minBin, binId);
    maxBin = Math.max(maxBin, binId);
    totalX += liq.amountX;
    totalY += liq.amountY;
}

console.log("Covered bin range:", minBin, "to", maxBin);
console.log("Total X liquidity:", totalX.toString());
console.log("Total Y liquidity:", totalY.toString());

// For yToX swap starting at activeId, we need bins BELOW activeId
// because we're consuming X liquidity and moving price down
console.log("\n=== For yToX swap (amountIn=2512090528 Y) ===");
console.log("ActiveId:", lbPair.activeId);
console.log("Lowest bin with data:", minBin);
console.log("Gap below activeId:", lbPair.activeId - minBin, "bins");

// Calculate how much X is available in bins at and below activeId
let xBelowActive = 0n;
let binsWithX = 0;
for (let i = minBin; i <= lbPair.activeId; i++) {
    const b = bins.get(i);
    if (b && b.amountX > 0n) {
        xBelowActive += b.amountX;
        binsWithX++;
    }
}
console.log("X available at/below activeId:", xBelowActive.toString());
console.log("Bins with X liquidity:", binsWithX);

// Show what bin arrays we'd need
const activeArrayIndex = Math.floor(lbPair.activeId / 70);
console.log("\n=== Required BinArrays ===");
console.log("ActiveId", lbPair.activeId, "is in array index:", activeArrayIndex);

const capturedIndices = binArrays.map(a => Number(a.index)).sort((a, b) => a - b);
console.log("Captured array indices:", capturedIndices);
console.log("Missing lower indices (for yToX):",
    Array.from({length: 5}, (_, i) => capturedIndices[0] - 1 - i).filter(i => i >= 0));
