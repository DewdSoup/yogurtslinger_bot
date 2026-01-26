// Hex dump BinArray to analyze struct layout
import fs from "fs";
import type { CanonicalSwapCase } from "../capture/canonicalTypes";

const DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const BINARRAY_DISC = Buffer.from("5c8e5cdc059446b5", "hex");

const lines = fs.readFileSync("./data/canonical_cases.ndjson", "utf8").split("\n").filter(Boolean);
const dlmmCase = lines.map(l => JSON.parse(l) as CanonicalSwapCase).find(c => c.venue === "meteora_dlmm");

if (!dlmmCase) {
    console.log("No DLMM case found");
    process.exit(1);
}

// Find first BinArray
let binArrayData: Buffer | null = null;
for (const [pk, acc] of Object.entries(dlmmCase.preAccounts)) {
    if (acc.owner !== DLMM_PROGRAM) continue;
    const data = Buffer.from(acc.dataBase64, "base64");
    if (data.length >= 8 && data.subarray(0, 8).equals(BINARRAY_DISC)) {
        binArrayData = data;
        console.log("Found BinArray:", pk);
        console.log("Length:", data.length, "bytes\n");
        break;
    }
}

if (!binArrayData) {
    console.log("No BinArray found!");
    process.exit(1);
}

// Hex dump first 200 bytes with offsets
console.log("=== BinArray Hex Dump (first 200 bytes) ===\n");
const bytesPerRow = 16;
for (let i = 0; i < Math.min(200, binArrayData.length); i += bytesPerRow) {
    const row = binArrayData.subarray(i, Math.min(i + bytesPerRow, binArrayData.length));
    const hex = row.toString("hex").match(/.{1,2}/g)?.join(" ") || "";
    const ascii = [...row].map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : ".").join("");
    console.log(i.toString().padStart(4, "0") + ": " + hex.padEnd(48, " ") + "  " + ascii);
}

// Try to decode fields at expected offsets
console.log("\n=== Testing BinArray offsets ===\n");
const { PublicKey } = require("@solana/web3.js");

// Current decoder assumes:
// - lbPair at offset 8 (pubkey)
// - index at offset 40 (i64)

console.log("At offset 8 (lbPair):");
try {
    const pk = new PublicKey(binArrayData.subarray(8, 40));
    console.log("  Pubkey:", pk.toBase58());
} catch (e: any) {
    console.log("  Error:", e.message);
}

console.log("\nAt offset 40 (index as i64):");
const index40 = binArrayData.readBigInt64LE(40);
console.log("  Value:", index40.toString());

// The index should be a small number like -2, -1, 0, 1, 2
// Let's try other offsets
console.log("\n=== Searching for small i64 values (likely bin array index) ===\n");
for (let off = 0; off <= 56; off += 8) {
    const val = binArrayData.readBigInt64LE(off);
    if (val >= -1000n && val <= 1000n) {
        console.log("  Offset " + off + ": " + val.toString());
    }
}

// Maybe the version field changes things
console.log("\n=== First 64 bytes raw analysis ===\n");
console.log("Offset 0-7 (disc):", binArrayData.subarray(0, 8).toString("hex"));
console.log("Offset 8 (u8):", binArrayData.readUInt8(8));
console.log("Offset 9-40 (pubkey?):");
try {
    const pk = new PublicKey(binArrayData.subarray(9, 41));
    console.log("  ", pk.toBase58());
} catch (e: any) {
    console.log("  Invalid");
}

// Maybe there's a version byte at offset 8
console.log("\n=== Trying version byte + shifted layout ===\n");
console.log("Offset 8 (version byte?):", binArrayData.readUInt8(8));
console.log("Offset 9-41 (lbPair if version byte exists):");
try {
    const pk = new PublicKey(binArrayData.subarray(9, 41));
    console.log("  ", pk.toBase58());
} catch (e: any) {
    console.log("  Invalid");
}
console.log("Offset 41 (index as i64 if version byte):", binArrayData.readBigInt64LE(41).toString());

// Check if the first bytes after discriminator could be lbPair pubkey
console.log("\n=== Offset 8-39 as pubkey (standard anchor) ===");
try {
    const pk = new PublicKey(binArrayData.subarray(8, 40));
    console.log("  ", pk.toBase58());
} catch (e: any) {
    console.log("  Invalid");
}
