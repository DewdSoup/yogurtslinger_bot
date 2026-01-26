// Hex dump LbPair to analyze struct layout
import fs from "fs";
import type { CanonicalSwapCase } from "../capture/canonicalTypes";

const DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const LBPAIR_DISC = Buffer.from("210b3162b565b10d", "hex");

const lines = fs.readFileSync("./data/canonical_cases.ndjson", "utf8").split("\n").filter(Boolean);
const dlmmCase = lines.map(l => JSON.parse(l) as CanonicalSwapCase).find(c => c.venue === "meteora_dlmm");

if (!dlmmCase) {
    console.log("No DLMM case found");
    process.exit(1);
}

// Find LbPair
let lbPairData: Buffer | null = null;
for (const [pk, acc] of Object.entries(dlmmCase.preAccounts)) {
    if (acc.owner !== DLMM_PROGRAM) continue;
    const data = Buffer.from(acc.dataBase64, "base64");
    if (data.length >= 8 && data.subarray(0, 8).equals(LBPAIR_DISC)) {
        lbPairData = data;
        console.log("Found LbPair:", pk);
        console.log("Length:", data.length, "bytes\n");
    }
}

if (!lbPairData) {
    console.log("No LbPair found!");
    process.exit(1);
}

// Hex dump first 300 bytes with offsets
console.log("=== LbPair Hex Dump (first 300 bytes) ===\n");
const bytesPerRow = 16;
for (let i = 0; i < Math.min(300, lbPairData.length); i += bytesPerRow) {
    const row = lbPairData.subarray(i, Math.min(i + bytesPerRow, lbPairData.length));
    const hex = row.toString("hex").match(/.{1,2}/g)?.join(" ") || "";
    const ascii = [...row].map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : ".").join("");
    console.log(i.toString().padStart(4, "0") + ": " + hex.padEnd(48, " ") + "  " + ascii);
}

// Try to find pubkeys by looking for 32-byte sequences that might be valid pubkeys
console.log("\n=== Looking for Pubkey patterns (32-byte sequences) ===\n");
const { PublicKey } = require("@solana/web3.js");

// Try different offsets to find where the pubkeys start
for (let offset = 0; offset <= 256; offset++) {
    try {
        const pk = new PublicKey(lbPairData.subarray(offset, offset + 32));
        const pkStr = pk.toBase58();
        // Check if this looks like a valid pubkey (not all zeros, not all ones)
        const data32 = lbPairData.subarray(offset, offset + 32);
        const isAllZeros = data32.every(b => b === 0);
        const isAllOnes = data32.every(b => b === 255);
        if (!isAllZeros && !isAllOnes) {
            // Check if any of these match our token balance pubkeys
            const matches = Object.keys(dlmmCase.tokenBalances).filter(tbPk =>
                tbPk === pkStr
            );
            if (matches.length > 0) {
                console.log("MATCH at offset", offset, ":", pkStr, "(matches tokenBalances!)");
            }
        }
    } catch (e) {
        // Invalid pubkey
    }
}

// Show what we're expecting from token balances
console.log("\n=== Token Balance Pubkeys ===\n");
for (const [pk, tb] of Object.entries(dlmmCase.tokenBalances)) {
    const pre = BigInt(tb.preAmount);
    const post = BigInt(tb.postAmount);
    const delta = post - pre;
    if (delta !== 0n) {
        const sign = delta > 0n ? "+" : "";
        console.log(pk + " delta=" + sign + delta);
    }
}

// Try to read potential numeric fields at various offsets
console.log("\n=== Potential numeric fields ===\n");
console.log("Offset 8  (u8 bump):", lbPairData.readUInt8(8));
console.log("Offset 9  (u16 binStep?):", lbPairData.readUInt16LE(9));
console.log("Offset 10 (u16 binStep?):", lbPairData.readUInt16LE(10));
console.log("Offset 11 (u16 baseFactor?):", lbPairData.readUInt16LE(11));
console.log("Offset 12 (u16 baseFactor?):", lbPairData.readUInt16LE(12));

// The discriminator is 8 bytes, then we might have the parameters struct
// Let me try offset 8 as the start of the parameters
console.log("\n=== Trying LbPairParameters starting at offset 8 ===");
let o = 8;
console.log("binStep (u16):", lbPairData.readUInt16LE(o)); o += 2;
console.log("swapCapDeactivateSlot (u64):", lbPairData.readBigUInt64LE(o).toString()); o += 8;
console.log("maxSwappedAmount (u64):", lbPairData.readBigUInt64LE(o).toString()); o += 8;
console.log("baseFactor (u16):", lbPairData.readUInt16LE(o)); o += 2;
console.log("filterPeriod (u16):", lbPairData.readUInt16LE(o)); o += 2;
console.log("decayPeriod (u16):", lbPairData.readUInt16LE(o)); o += 2;
console.log("reductionFactor (u16):", lbPairData.readUInt16LE(o)); o += 2;
console.log("variableFeeControl (u32):", lbPairData.readUInt32LE(o)); o += 4;
console.log("maxVolatilityAccumulator (u32):", lbPairData.readUInt32LE(o)); o += 4;
console.log("minBinId (i32):", lbPairData.readInt32LE(o)); o += 4;
console.log("maxBinId (i32):", lbPairData.readInt32LE(o)); o += 4;
console.log("protocolShare (u16):", lbPairData.readUInt16LE(o)); o += 2;

console.log("\n=== Current offset:", o, "===");
