// Analyze ONE BUY transaction in detail to understand the fee model

import * as fs from "fs";
import * as readline from "readline";
import { Buffer } from "buffer";

interface CanonicalSwapCase {
    signature: string;
    slot: number;
    venue: string;
    preAccounts: Record<string, { dataBase64: string; owner: string; lamports: string; executable: boolean; rentEpoch: string }>;
    tokenBalances: Record<string, { preAmount: string; postAmount: string }>;
    tx?: { err?: unknown };
}

const POOL_DISCRIMINATOR = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);

function bi(s: string): bigint {
    return BigInt(s);
}

function isPumpSwapPoolAccount(data: Buffer): boolean {
    if (data.length < 8) return false;
    return data.subarray(0, 8).equals(POOL_DISCRIMINATOR);
}

function getVaults(data: Buffer): { baseVault: string; quoteVault: string } {
    // Pool layout: 8 disc + 1 bump + 2 index + 32 creator + 32 baseMint + 32 quoteMint + 32 lpMint + 32 baseVault + 32 quoteVault
    // Offsets: baseVault at 8+1+2+32+32+32+32 = 139, quoteVault at 171
    const { PublicKey } = require("@solana/web3.js");
    const baseVault = new PublicKey(data.subarray(139, 171)).toBase58();
    const quoteVault = new PublicKey(data.subarray(171, 203)).toBase58();
    return { baseVault, quoteVault };
}

async function main() {
    const ndjsonPath = process.argv[2] || "./data/canonical_cases.ndjson";

    const rl = readline.createInterface({
        input: fs.createReadStream(ndjsonPath, { encoding: "utf8" }),
        crlfDelay: Infinity,
    });

    let buyCount = 0;
    let sellCount = 0;
    let totalPumpswap = 0;
    const maxBuys = 5; // Analyze first 5 BUY transactions

    for await (const line of rl) {
        const s = line.trim();
        if (!s) continue;

        let c: CanonicalSwapCase;
        try {
            c = JSON.parse(s);
        } catch {
            continue;
        }

        if (c.venue !== "pumpswap" || c.tx?.err) continue;
        totalPumpswap++;

        // Find pool
        let poolData: Buffer | null = null;
        for (const [, a] of Object.entries(c.preAccounts)) {
            const buf = Buffer.from(a.dataBase64, "base64");
            if (isPumpSwapPoolAccount(buf)) {
                poolData = buf;
                break;
            }
        }

        if (!poolData) {
            if (totalPumpswap <= 3) {
                console.log(`DEBUG: No pool found for sig=${c.signature.slice(0, 20)}`);
            }
            continue;
        }

        const { baseVault, quoteVault } = getVaults(poolData);

        const tbBase = c.tokenBalances[baseVault];
        const tbQuote = c.tokenBalances[quoteVault];
        if (!tbBase || !tbQuote) {
            // Debug: show what we're looking for vs what's available
            if (totalPumpswap <= 3) {
                console.log(`DEBUG: sig=${c.signature.slice(0, 20)} baseVault=${baseVault} quoteVault=${quoteVault}`);
                console.log(`  tokenBalances keys: ${Object.keys(c.tokenBalances).join(", ")}`);
            }
            continue;
        }

        const dBase = bi(tbBase.postAmount) - bi(tbBase.preAmount);
        const dQuote = bi(tbQuote.postAmount) - bi(tbQuote.preAmount);

        // BUY = quote in (positive), base out (negative)
        if (!(dQuote > 0n && dBase < 0n)) {
            // This is a SELL transaction
            sellCount++;
            continue;
        }

        buyCount++;
        if (buyCount > maxBuys) break;

        const quoteIn = dQuote;  // vault received this much quote
        const baseOut = -dBase; // vault sent this much base
        const baseReserve = bi(tbBase.preAmount);
        const quoteReserve = bi(tbQuote.preAmount);

        console.log("=".repeat(80));
        console.log(`BUY #${buyCount}: sig=${c.signature.slice(0, 20)}...`);
        console.log(`  quoteIn (vault delta): ${quoteIn}`);
        console.log(`  baseOut (vault delta): ${baseOut}`);
        console.log(`  baseReserve (pre):     ${baseReserve}`);
        console.log(`  quoteReserve (pre):    ${quoteReserve}`);
        console.log();

        // What the program should do:
        // 1. User sends totalQuote
        // 2. Program computes: internalQuote = totalQuote - fees
        //    OR: fees are computed FROM internalQuote, and totalQuote = internalQuote + fees
        //
        // The CP formula: baseOut = baseReserve * internalQuote / (quoteReserve + internalQuote)
        //
        // We can solve for internalQuote:
        // baseOut * (quoteReserve + internalQuote) = baseReserve * internalQuote
        // baseOut * quoteReserve + baseOut * internalQuote = baseReserve * internalQuote
        // baseOut * quoteReserve = internalQuote * (baseReserve - baseOut)
        // internalQuote = baseOut * quoteReserve / (baseReserve - baseOut)

        const internalQuote = (baseOut * quoteReserve) / (baseReserve - baseOut);
        const impliedFee = quoteIn - internalQuote;
        const impliedFeeBps = (impliedFee * 10000n) / internalQuote;

        console.log(`  REVERSE ENGINEERING FROM CP FORMULA:`);
        console.log(`  internalQuote (solved): ${internalQuote}`);
        console.log(`  impliedFee = quoteIn - internalQuote: ${impliedFee}`);
        console.log(`  impliedFeeBps = fee * 10000 / internal: ${impliedFeeBps}`);
        console.log();

        // Verify: does CP with internalQuote give baseOut?
        const verifyBaseOut = (baseReserve * internalQuote) / (quoteReserve + internalQuote);
        console.log(`  VERIFICATION:`);
        console.log(`  CP(internalQuote) = ${verifyBaseOut}`);
        console.log(`  Actual baseOut    = ${baseOut}`);
        console.log(`  Match: ${verifyBaseOut === baseOut}`);
        console.log();

        // Now test different fee models
        console.log(`  FEE MODEL TESTS:`);

        // Model A: fee = quoteIn * feeBps / 10000 (subtraction)
        // internalQuote = quoteIn - fee = quoteIn * (1 - feeBps/10000)
        for (const feeBps of [20n, 25n]) {
            const netIn_sub = (quoteIn * (10000n - feeBps)) / 10000n;
            const baseOut_sub = (baseReserve * netIn_sub) / (quoteReserve + netIn_sub);
            const diff_sub = baseOut > baseOut_sub ? baseOut - baseOut_sub : baseOut_sub - baseOut;
            console.log(`  Model A (subtract ${feeBps}bps): netIn=${netIn_sub}, baseOut=${baseOut_sub}, diff=${diff_sub}`);
        }

        // Model B: quoteIn = internalQuote + ceil(internalQuote * feeBps / 10000) (division)
        // internalQuote = quoteIn * 10000 / (10000 + feeBps)
        for (const feeBps of [20n, 25n]) {
            const netIn_div = (quoteIn * 10000n) / (10000n + feeBps);
            const baseOut_div = (baseReserve * netIn_div) / (quoteReserve + netIn_div);
            const diff_div = baseOut > baseOut_div ? baseOut - baseOut_div : baseOut_div - baseOut;
            console.log(`  Model B (divide ${feeBps}bps):   netIn=${netIn_div}, baseOut=${baseOut_div}, diff=${diff_div}`);
        }

        // Model C: Try the exact impliedFeeBps we computed
        {
            const netIn_exact = internalQuote;
            const baseOut_exact = (baseReserve * netIn_exact) / (quoteReserve + netIn_exact);
            const diff_exact = baseOut > baseOut_exact ? baseOut - baseOut_exact : baseOut_exact - baseOut;
            console.log(`  Model C (exact ${impliedFeeBps}bps): netIn=${netIn_exact}, baseOut=${baseOut_exact}, diff=${diff_exact}`);
        }

        console.log();
    }

    console.log(`\nSummary: Found ${totalPumpswap} pumpswap txs, ${sellCount} SELL, ${buyCount} BUY analyzed`);
}

main().catch(console.error);