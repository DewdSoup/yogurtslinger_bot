// fetch_fee_config.ts
// Usage: pnpm exec ts-node fetch_fee_config.ts

import { PublicKey, Connection } from "@solana/web3.js";

const HELIUS_RPC = "https://mainnet.helius-rpc.com/?api-key=bff504b3-c294-46e9-b7d8-dacbcb4b9e3d";
const PUMP_FEES_PROGRAM_ID = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const PUMPSWAP_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");

interface SwapCase {
    sig: string;
    slot: number;
    amountIn: bigint;
    actualOut: bigint;
    grossOut: bigint;
    reserveIn: bigint;
    reserveOut: bigint;
    impliedFeeBps: number;
}

async function main() {
    const conn = new Connection(HELIUS_RPC, "confirmed");

    // =========================================================================
    // PART 1: Decode FeeConfig account structure
    // =========================================================================
    const [feeConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("fee_config"), PUMPSWAP_PROGRAM_ID.toBuffer()],
        PUMP_FEES_PROGRAM_ID
    );

    console.log("=".repeat(80));
    console.log("PART 1: FeeConfig Account Analysis");
    console.log("=".repeat(80));
    console.log("FeeConfig PDA:", feeConfigPda.toBase58());

    const acct = await conn.getAccountInfo(feeConfigPda);
    if (!acct) {
        console.log("FeeConfig account not found");
        return;
    }

    console.log("Owner:", acct.owner.toBase58());
    console.log("Data length:", acct.data.length);

    const data = acct.data;

    console.log("\n--- HEADER ---");
    console.log("Discriminator:", data.subarray(0, 8).toString("hex"));
    console.log("Bump (u8):", data[8]);
    console.log("Admin pubkey:", new PublicKey(data.subarray(9, 41)).toBase58());

    console.log("\n--- FLAT FEES (offset 41, 3x u64) ---");
    const flatLp = data.readBigUInt64LE(41);
    const flatProt = data.readBigUInt64LE(49);
    const flatCreator = data.readBigUInt64LE(57);
    console.log(`lpFeeBps: ${flatLp}`);
    console.log(`protocolFeeBps: ${flatProt}`);
    console.log(`coinCreatorFeeBps: ${flatCreator}`);

    const tierCount = data.readUInt32LE(65);
    const tierStart = 69;

    console.log("\n--- FEE TIERS ---");
    console.log("Tier count (u32 at offset 65):", tierCount);
    console.log("Tier data starts at offset:", tierStart);
    console.log("Remaining bytes:", data.length - tierStart);
    console.log("Bytes per tier if count=" + tierCount + ":", (data.length - tierStart) / tierCount);

    console.log("\n--- RAW TIER BYTES (first 400) ---");
    const rawTierHex = data.subarray(tierStart, tierStart + 400).toString("hex");
    for (let i = 0; i < rawTierHex.length; i += 64) {
        console.log(`  ${i / 2}: ${rawTierHex.substring(i, i + 64)}`);
    }

    // Try all reasonable layouts
    console.log("\n--- LAYOUT A: 32-byte (threshold u64, lp u64, prot u64, creator u64) ---");
    for (let i = 0; i < Math.min(tierCount, 10); i++) {
        const off = tierStart + i * 32;
        const threshold = data.readBigUInt64LE(off);
        const lp = data.readBigUInt64LE(off + 8);
        const prot = data.readBigUInt64LE(off + 16);
        const creator = data.readBigUInt64LE(off + 24);
        console.log(`  Tier ${i}: threshold=${threshold} lp=${lp} prot=${prot} creator=${creator}`);
    }

    console.log("\n--- LAYOUT B: 32-byte (lp u64, prot u64, creator u64, threshold u64) ---");
    for (let i = 0; i < Math.min(tierCount, 10); i++) {
        const off = tierStart + i * 32;
        const lp = data.readBigUInt64LE(off);
        const prot = data.readBigUInt64LE(off + 8);
        const creator = data.readBigUInt64LE(off + 16);
        const threshold = data.readBigUInt64LE(off + 24);
        console.log(`  Tier ${i}: lp=${lp} prot=${prot} creator=${creator} threshold=${threshold}`);
    }

    console.log("\n--- LAYOUT C: 24-byte (threshold u64, lp u32, prot u32, creator u32, pad u32) ---");
    for (let i = 0; i < Math.min(tierCount, 10); i++) {
        const off = tierStart + i * 24;
        const threshold = data.readBigUInt64LE(off);
        const lp = data.readUInt32LE(off + 8);
        const prot = data.readUInt32LE(off + 12);
        const creator = data.readUInt32LE(off + 16);
        console.log(`  Tier ${i}: threshold=${threshold} lp=${lp} prot=${prot} creator=${creator}`);
    }

    console.log("\n--- LAYOUT D: 16-byte (threshold u64, lp u16, prot u16, creator u16, pad u16) ---");
    for (let i = 0; i < Math.min(tierCount, 10); i++) {
        const off = tierStart + i * 16;
        const threshold = data.readBigUInt64LE(off);
        const lp = data.readUInt16LE(off + 8);
        const prot = data.readUInt16LE(off + 10);
        const creator = data.readUInt16LE(off + 12);
        console.log(`  Tier ${i}: threshold=${threshold} lp=${lp} prot=${prot} creator=${creator}`);
    }

    // Based on bytes per tier = 97.72, try 98-byte layout or nested structure
    const bytesPerTier = (data.length - tierStart) / tierCount;
    console.log(`\n--- Calculated bytes per tier: ${bytesPerTier} ---`);

    if (Math.abs(bytesPerTier - 97.72) < 1) {
        console.log("\n--- LAYOUT E: 97/98-byte complex tier (likely nested Vec or extra fields) ---");
        // Dump first tier raw
        console.log("First tier raw (98 bytes):");
        console.log(data.subarray(tierStart, tierStart + 98).toString("hex"));
        console.log("Second tier raw (98 bytes):");
        console.log(data.subarray(tierStart + 98, tierStart + 196).toString("hex"));
    }

    // =========================================================================
    // PART 2: Fetch recent PumpSwap transactions for edge case analysis
    // =========================================================================
    console.log("\n" + "=".repeat(80));
    console.log("PART 2: Recent PumpSwap Swap Transactions");
    console.log("=".repeat(80));

    const sigs = await conn.getSignaturesForAddress(PUMPSWAP_PROGRAM_ID, { limit: 200 });
    console.log(`Found ${sigs.length} recent signatures`);

    const swapCases: SwapCase[] = [];

    let processed = 0;
    for (const sigInfo of sigs.slice(0, 100)) {
        if (sigInfo.err) continue;

        try {
            const tx = await conn.getTransaction(sigInfo.signature, {
                maxSupportedTransactionVersion: 0,
            });

            if (!tx || !tx.meta || tx.meta.err) continue;

            const preTokenBalances = tx.meta.preTokenBalances || [];
            const postTokenBalances = tx.meta.postTokenBalances || [];

            if (preTokenBalances.length < 2 || postTokenBalances.length < 2) continue;

            const preMap = new Map<string, { mint: string; amount: bigint }>();
            const postMap = new Map<string, { mint: string; amount: bigint }>();

            const accountKeys = tx.transaction.message.getAccountKeys().staticAccountKeys;

            for (const tb of preTokenBalances) {
                const pk = accountKeys[tb.accountIndex]?.toBase58();
                if (pk && tb.uiTokenAmount.amount) {
                    preMap.set(pk, { mint: tb.mint, amount: BigInt(tb.uiTokenAmount.amount) });
                }
            }

            for (const tb of postTokenBalances) {
                const pk = accountKeys[tb.accountIndex]?.toBase58();
                if (pk && tb.uiTokenAmount.amount) {
                    postMap.set(pk, { mint: tb.mint, amount: BigInt(tb.uiTokenAmount.amount) });
                }
            }

            const deltas: Array<{ pk: string; mint: string; delta: bigint; pre: bigint; post: bigint }> = [];

            for (const [pk, pre] of preMap) {
                const post = postMap.get(pk);
                if (!post) continue;
                const delta = post.amount - pre.amount;
                if (delta !== 0n) {
                    deltas.push({ pk, mint: pre.mint, delta, pre: pre.amount, post: post.amount });
                }
            }

            const vaultDeltas = deltas.filter(d =>
                (d.delta > 0n && deltas.some(o => o.delta < 0n && o.mint !== d.mint)) ||
                (d.delta < 0n && deltas.some(o => o.delta > 0n && o.mint !== d.mint))
            );

            if (vaultDeltas.length >= 2) {
                const inVault = vaultDeltas.find(d => d.delta > 0n);
                const outVault = vaultDeltas.find(d => d.delta < 0n);

                if (inVault && outVault) {
                    const amountIn = inVault.delta;
                    const actualOut = -outVault.delta;
                    const reserveIn = inVault.pre;
                    const reserveOut = outVault.pre;
                    const grossOut = (reserveOut * amountIn) / (reserveIn + amountIn);

                    if (grossOut > 0n && actualOut <= grossOut) {
                        const feeFraction = Number(grossOut - actualOut) / Number(grossOut);
                        const impliedFeeBps = Math.round(feeFraction * 10000);

                        swapCases.push({
                            sig: sigInfo.signature,
                            slot: tx.slot,
                            amountIn,
                            actualOut,
                            grossOut,
                            reserveIn,
                            reserveOut,
                            impliedFeeBps,
                        });

                        processed++;
                    }
                }
            }
        } catch {
            // Skip errors
        }

        if (processed % 10 === 0 && processed > 0) {
            await new Promise(r => setTimeout(r, 100));
        }
    }

    console.log(`\nProcessed ${swapCases.length} swap transactions`);

    const feeHist = new Map<number, number>();
    for (const c of swapCases) {
        feeHist.set(c.impliedFeeBps, (feeHist.get(c.impliedFeeBps) || 0) + 1);
    }

    console.log("\n--- IMPLIED FEE HISTOGRAM (bps) ---");
    const sortedFees = [...feeHist.entries()].sort((a, b) => b[1] - a[1]);
    for (const [bps, count] of sortedFees.slice(0, 20)) {
        console.log(`  ${bps} bps: ${count} cases`);
    }

    console.log("\n--- EDGE CASES (not 20, 24, 25, 26 bps) ---");
    const edgeCases = swapCases.filter(c =>
        c.impliedFeeBps !== 20 &&
        c.impliedFeeBps !== 25 &&
        c.impliedFeeBps !== 24 &&
        c.impliedFeeBps !== 26
    );
    for (const c of edgeCases.slice(0, 20)) {
        console.log(`  sig=${c.sig.slice(0, 30)}... slot=${c.slot} feeBps=${c.impliedFeeBps} grossOut=${c.grossOut} actualOut=${c.actualOut}`);
    }

    // =========================================================================
    // PART 3: Pool Creator Analysis
    // =========================================================================
    console.log("\n" + "=".repeat(80));
    console.log("PART 3: Pool Creator Analysis");
    console.log("=".repeat(80));

    const poolAccounts = await conn.getProgramAccounts(PUMPSWAP_PROGRAM_ID, {
        filters: [{ dataSize: 211 }],
        commitment: "confirmed",
    });

    console.log(`Found ${poolAccounts.length} pool accounts`);

    let nullCreator = 0;
    let nonNullCreator = 0;

    for (const pa of poolAccounts.slice(0, 100)) {
        const poolData = pa.account.data;
        const creatorBytes = poolData.subarray(169, 201);
        const isNull = creatorBytes.every(b => b === 0);
        if (isNull) nullCreator++;
        else nonNullCreator++;
    }

    console.log(`Null creator: ${nullCreator}`);
    console.log(`Non-null creator: ${nonNullCreator}`);

    console.log("\n" + "=".repeat(80));
    console.log("DONE");
    console.log("=".repeat(80));
}

main().catch(console.error);