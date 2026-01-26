// brute_force_tier_decoder.ts
// Usage: pnpm exec ts-node brute_force_tier_decoder.ts

import { PublicKey, Connection } from "@solana/web3.js";

const HELIUS_RPC = "https://mainnet.helius-rpc.com/?api-key=bff504b3-c294-46e9-b7d8-dacbcb4b9e3d";
const PUMP_FEES_PROGRAM_ID = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const PUMPSWAP_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");

async function main() {
    const conn = new Connection(HELIUS_RPC, "confirmed");

    const [feeConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("fee_config"), PUMPSWAP_PROGRAM_ID.toBuffer()],
        PUMP_FEES_PROGRAM_ID
    );

    console.log("Fetching FeeConfig account...");
    const acct = await conn.getAccountInfo(feeConfigPda);
    if (!acct) {
        console.log("Account not found");
        return;
    }

    const data = acct.data;
    const tierCount = data.readUInt32LE(65);
    const tierStart = 69;
    const tierDataLen = data.length - tierStart;
    const bytesPerTier = tierDataLen / tierCount;

    console.log(`Data length: ${data.length}`);
    console.log(`Tier count: ${tierCount}`);
    console.log(`Tier data length: ${tierDataLen}`);
    console.log(`Bytes per tier: ${bytesPerTier.toFixed(2)}`);

    // Dump raw bytes for analysis
    console.log("\n=== RAW TIER DATA (first 500 bytes, 16 per line) ===");
    for (let i = 0; i < Math.min(500, tierDataLen); i += 16) {
        const hex = data.subarray(tierStart + i, tierStart + i + 16).toString("hex");
        const formatted = hex.match(/.{1,2}/g)?.join(" ") || hex;
        console.log(`${(i).toString().padStart(4)}: ${formatted}`);
    }

    // Check for inner Vec length at various offsets
    console.log("\n=== CHECKING FOR NESTED VEC ===");
    for (let baseSize = 24; baseSize <= 48; baseSize += 8) {
        const vecLenOffset = tierStart + baseSize;
        if (vecLenOffset + 4 <= data.length) {
            const innerVecLen = data.readUInt32LE(vecLenOffset);
            if (innerVecLen > 0 && innerVecLen <= 20) {
                console.log(`Base size ${baseSize}: inner Vec length = ${innerVecLen}`);
            }
        }
    }

    // Brute force: find all positions where we see valid fee-like triplets
    console.log("\n=== BRUTE FORCE PATTERN SEARCH ===");
    console.log("Looking for u64 triplets where all values <= 100 and sum of first two is 15-35...\n");

    for (let off = 0; off < Math.min(300, tierDataLen); off += 8) {
        if (off + 24 <= tierDataLen) {
            const v1 = Number(data.readBigUInt64LE(tierStart + off));
            const v2 = Number(data.readBigUInt64LE(tierStart + off + 8));
            const v3 = Number(data.readBigUInt64LE(tierStart + off + 16));

            if (v1 <= 100 && v2 <= 100 && v3 <= 100) {
                const sum = v1 + v2;
                if (sum >= 15 && sum <= 35) {
                    console.log(`offset ${off}: [${v1}, ${v2}, ${v3}] sum=${sum}`);
                }
            }
        }
    }

    // Look for u16 triplets too
    console.log("\n=== U16 TRIPLET SEARCH ===");
    for (let off = 0; off < Math.min(300, tierDataLen); off += 2) {
        if (off + 6 <= tierDataLen) {
            const v1 = data.readUInt16LE(tierStart + off);
            const v2 = data.readUInt16LE(tierStart + off + 2);
            const v3 = data.readUInt16LE(tierStart + off + 4);

            if (v1 <= 100 && v2 <= 100 && v3 <= 100) {
                const sum = v1 + v2;
                if (sum >= 15 && sum <= 35) {
                    console.log(`offset ${off}: [${v1}, ${v2}, ${v3}] sum=${sum}`);
                }
            }
        }
    }

    // Find repeating patterns with ascending thresholds
    console.log("\n=== LOOKING FOR REPEATING STRUCTURE ===");
    for (let stride = 32; stride <= 128; stride += 4) {
        let matchCount = 0;

        for (let i = 0; i < Math.min(5, Math.floor(tierDataLen / stride) - 1); i++) {
            const off1 = tierStart + i * stride;
            const off2 = tierStart + (i + 1) * stride;

            const thresh1 = data.readBigUInt64LE(off1);
            const thresh2 = data.readBigUInt64LE(off2);

            if (thresh2 > thresh1 || (thresh1 === 0n && thresh2 >= 0n)) {
                matchCount++;
            }
        }

        if (matchCount >= 3) {
            console.log(`\nStride ${stride}: ${matchCount} ascending threshold matches`);
            console.log(`Decoding first 5 tiers with stride ${stride}:`);

            for (let i = 0; i < 5; i++) {
                const off = tierStart + i * stride;
                const threshold = data.readBigUInt64LE(off);
                console.log(`  Tier ${i}: threshold=${threshold}`);

                for (let feeOff = 8; feeOff <= stride - 24; feeOff += 8) {
                    const lp = Number(data.readBigUInt64LE(off + feeOff));
                    const prot = Number(data.readBigUInt64LE(off + feeOff + 8));
                    const creator = Number(data.readBigUInt64LE(off + feeOff + 16));

                    if (lp <= 100 && prot <= 100 && creator <= 100) {
                        const sum = lp + prot;
                        if (sum >= 15 && sum <= 35) {
                            console.log(`    @+${feeOff}: lp=${lp} prot=${prot} creator=${creator} (sum=${sum})`);
                        }
                    }
                }
            }
        }
    }

    // Direct byte pattern search
    console.log("\n=== DIRECT BYTE PATTERN ANALYSIS ===");
    console.log("Looking for fee values 20 (0x14), 25 (0x19), 5 (0x05), etc...\n");

    const searchBytes = [
        { val: 20, byte: 0x14 },
        { val: 25, byte: 0x19 },
        { val: 5, byte: 0x05 },
        { val: 93, byte: 0x5d },
        { val: 95, byte: 0x5f },
        { val: 90, byte: 0x5a },
        { val: 85, byte: 0x55 },
    ];

    for (const { val, byte } of searchBytes) {
        const positions: number[] = [];
        for (let i = 0; i < Math.min(300, tierDataLen); i++) {
            if (data[tierStart + i] === byte && (i + 1 >= tierDataLen || data[tierStart + i + 1] === 0)) {
                positions.push(i);
            }
        }
        if (positions.length > 0) {
            console.log(`Value ${val} (0x${byte.toString(16).padStart(2, "0")}): offsets ${positions.slice(0, 15).join(", ")}${positions.length > 15 ? "..." : ""}`);
        }
    }

    // Try 98-byte stride decode
    console.log("\n=== 98-BYTE STRIDE DECODE ===");
    for (let tierIdx = 0; tierIdx < Math.min(10, tierCount); tierIdx++) {
        const tierBase = tierStart + tierIdx * 98;
        if (tierBase + 40 > data.length) break;

        const threshold = data.readBigUInt64LE(tierBase);
        console.log(`\nTier ${tierIdx} (offset ${tierIdx * 98}):`);
        console.log(`  threshold (u64 @0) = ${threshold}`);

        const tierHex = data.subarray(tierBase, tierBase + 50).toString("hex");
        console.log(`  raw (first 50): ${tierHex}`);

        // Print all u64 values
        for (let scanOff = 8; scanOff <= 40; scanOff += 8) {
            const v = data.readBigUInt64LE(tierBase + scanOff);
            console.log(`  u64 @${scanOff} = ${v}`);
        }
    }

    // Try to find the structure by looking at differences between tiers
    console.log("\n=== TIER BOUNDARY DETECTION ===");
    console.log("Looking for where next threshold starts...\n");

    // We know tier 0 threshold = 0, find where next threshold might be
    // Scan for small values followed by large value (next threshold)
    for (let off = 16; off < 150; off += 8) {
        const val = data.readBigUInt64LE(tierStart + off);
        // Large threshold values are in SOL * 1e9 range
        if (val > 1_000_000_000n && val < 1_000_000_000_000_000n) {
            console.log(`Possible threshold at offset ${off}: ${val} (${Number(val) / 1e9} SOL)`);
        }
    }

    console.log("\n=== DONE ===");
}

main().catch(console.error);