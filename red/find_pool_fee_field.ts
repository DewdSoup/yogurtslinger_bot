// find_pool_fee_field.ts
// Compare pool accounts between 20-bps and 25-bps pools to find the fee indicator
// Usage: pnpm exec ts-node find_pool_fee_field.ts

import { PublicKey, Connection } from "@solana/web3.js";

const HELIUS_RPC = "https://mainnet.helius-rpc.com/?api-key=bff504b3-c294-46e9-b7d8-dacbcb4b9e3d";
const PUMPSWAP_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const WSOL_MINT = "So11111111111111111111111111111111111111112";

function constantProductOut(reserveIn: bigint, reserveOut: bigint, amountIn: bigint): bigint {
    if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
    return (reserveOut * amountIn) / (reserveIn + amountIn);
}

async function main() {
    const conn = new Connection(HELIUS_RPC, "confirmed");

    console.log("=".repeat(80));
    console.log("Finding fee indicator field in pool accounts");
    console.log("=".repeat(80));

    // Step 1: Get recent swaps and categorize pools by fee
    console.log("\nStep 1: Collecting swaps to categorize pools by fee...\n");

    const sigs = await conn.getSignaturesForAddress(PUMPSWAP_PROGRAM_ID, { limit: 500 });
    console.log(`Found ${sigs.length} signatures`);

    const poolFeeMap = new Map<string, { fees: number[]; baseVault: string; quoteVault: string }>();

    let processed = 0;
    for (const sigInfo of sigs) {
        if (sigInfo.err) continue;

        try {
            const tx = await conn.getTransaction(sigInfo.signature, {
                maxSupportedTransactionVersion: 0,
            });

            if (!tx || !tx.meta || tx.meta.err) continue;

            const preTokenBalances = tx.meta.preTokenBalances || [];
            const postTokenBalances = tx.meta.postTokenBalances || [];

            if (preTokenBalances.length < 2) continue;

            const accountKeys = tx.transaction.message.getAccountKeys().staticAccountKeys;

            const preMap = new Map<string, { mint: string; amount: bigint; owner: string }>();
            const postMap = new Map<string, { mint: string; amount: bigint }>();

            for (const tb of preTokenBalances) {
                const pk = accountKeys[tb.accountIndex]?.toBase58();
                if (pk && tb.uiTokenAmount.amount) {
                    preMap.set(pk, {
                        mint: tb.mint,
                        amount: BigInt(tb.uiTokenAmount.amount),
                        owner: tb.owner || ""
                    });
                }
            }

            for (const tb of postTokenBalances) {
                const pk = accountKeys[tb.accountIndex]?.toBase58();
                if (pk && tb.uiTokenAmount.amount) {
                    postMap.set(pk, { mint: tb.mint, amount: BigInt(tb.uiTokenAmount.amount) });
                }
            }

            const deltas: Array<{
                pk: string;
                mint: string;
                delta: bigint;
                pre: bigint;
                owner: string;
            }> = [];

            for (const [pk, pre] of preMap) {
                const post = postMap.get(pk);
                if (!post) continue;
                const delta = post.amount - pre.amount;
                if (delta !== 0n) {
                    deltas.push({ pk, mint: pre.mint, delta, pre: pre.amount, owner: pre.owner });
                }
            }

            const inVault = deltas.find(d => d.delta > 0n);
            const outVault = deltas.find(d => d.delta < 0n && d.mint !== inVault?.mint);

            if (!inVault || !outVault) continue;

            const amountIn = inVault.delta;
            const actualOut = -outVault.delta;
            const reserveIn = inVault.pre;
            const reserveOut = outVault.pre;

            const grossOut = constantProductOut(reserveIn, reserveOut, amountIn);
            if (grossOut <= 0n || actualOut > grossOut) continue;

            const feeFraction = Number(grossOut - actualOut) / Number(grossOut);
            const impliedFeeBps = Math.round(feeFraction * 10000);

            // Only consider clean 20 or 25 bps cases
            if (impliedFeeBps !== 20 && impliedFeeBps !== 25) continue;

            // Identify pool by vault pair
            const isWsolIn = inVault.mint === WSOL_MINT;
            const baseVault = isWsolIn ? outVault.pk : inVault.pk;
            const quoteVault = isWsolIn ? inVault.pk : outVault.pk;
            const poolKey = `${baseVault}|${quoteVault}`;

            if (!poolFeeMap.has(poolKey)) {
                poolFeeMap.set(poolKey, { fees: [], baseVault, quoteVault });
            }
            poolFeeMap.get(poolKey)!.fees.push(impliedFeeBps);

            processed++;
            if (processed % 20 === 0) {
                console.log(`Processed ${processed} valid swaps...`);
            }

        } catch {
            // Skip
        }

        await new Promise(r => setTimeout(r, 30));
    }

    console.log(`\nFound ${poolFeeMap.size} unique pools`);

    // Categorize pools by their consistent fee
    const pools20: string[] = [];
    const pools25: string[] = [];

    for (const [poolKey, info] of poolFeeMap) {
        const uniqueFees = [...new Set(info.fees)];
        if (uniqueFees.length === 1) {
            if (uniqueFees[0] === 20) pools20.push(poolKey);
            else if (uniqueFees[0] === 25) pools25.push(poolKey);
        }
    }

    console.log(`\nPools with consistent 20 bps: ${pools20.length}`);
    console.log(`Pools with consistent 25 bps: ${pools25.length}`);

    // Debug: Show sample keys
    if (pools20.length > 0) {
        console.log(`\nSample 20-bps pool key: ${pools20[0]}`);
    }
    if (pools25.length > 0) {
        console.log(`Sample 25-bps pool key: ${pools25[0]}`);
    }

    if (pools20.length === 0 || pools25.length === 0) {
        console.log("\nNeed at least one pool of each fee type to compare!");
        return;
    }

    // Step 2: Fetch pool accounts for both types
    console.log("\n" + "=".repeat(80));
    console.log("Step 2: Fetching pool account data...");
    console.log("=".repeat(80));

    // Get all pool accounts
    const allPoolAccounts = await conn.getProgramAccounts(PUMPSWAP_PROGRAM_ID, {
        filters: [{ dataSize: 211 }],
        commitment: "confirmed",
    });

    console.log(`Fetched ${allPoolAccounts.length} pool accounts`);

    // Build maps: vault -> pool (either base or quote vault can identify the pool)
    const vaultToPool = new Map<string, { pk: string; data: Buffer }>();

    for (const pa of allPoolAccounts) {
        const data = pa.account.data;
        // Layout: 8 disc + 1 bump + 2 index + 32 creator + 32 base_mint + 32 quote_mint + 
        //         32 lp_mint + 32 base_vault + 32 quote_vault + 8 lp_supply
        const baseVault = new PublicKey(data.subarray(139, 171)).toBase58();
        const quoteVault = new PublicKey(data.subarray(171, 203)).toBase58();

        // Store by BOTH vaults so we can find pool from either direction
        const poolInfo = { pk: pa.pubkey.toBase58(), data };
        vaultToPool.set(baseVault, poolInfo);
        vaultToPool.set(quoteVault, poolInfo);
    }

    console.log(`Total vault entries in map: ${vaultToPool.size}`);

    // Debug: Check if any of our vaults exist (split the key to get individual vaults)
    console.log(`\nChecking individual vault matches...`);
    for (const key of [...pools20, ...pools25].slice(0, 3)) {
        const [baseV, quoteV] = key.split("|");
        const foundBase = vaultToPool.has(baseV);
        const foundQuote = vaultToPool.has(quoteV);
        console.log(`  Base vault ${baseV.slice(0, 20)}... found: ${foundBase}`);
        console.log(`  Quote vault ${quoteV.slice(0, 20)}... found: ${foundQuote}`);
    }

    // Find pool accounts for our categorized pools (use first vault in key)
    const pool20Accounts: Array<{ pk: string; data: Buffer; key: string }> = [];
    const pool25Accounts: Array<{ pk: string; data: Buffer; key: string }> = [];

    for (const key of pools20) {
        const [baseV] = key.split("|");
        const poolInfo = vaultToPool.get(baseV);
        if (poolInfo) {
            pool20Accounts.push({ ...poolInfo, key });
        }
    }

    for (const key of pools25) {
        const [baseV] = key.split("|");
        const poolInfo = vaultToPool.get(baseV);
        if (poolInfo) {
            pool25Accounts.push({ ...poolInfo, key });
        }
    }

    console.log(`\nMatched 20-bps pool accounts: ${pool20Accounts.length}`);
    console.log(`Matched 25-bps pool accounts: ${pool25Accounts.length}`);

    if (pool20Accounts.length === 0 || pool25Accounts.length === 0) {
        console.log("\nCouldn't match pool accounts!");
        return;
    }

    // Step 3: Compare byte by byte
    console.log("\n" + "=".repeat(80));
    console.log("Step 3: Comparing pool account bytes...");
    console.log("=".repeat(80));

    // Dump first pool of each type
    const p20 = pool20Accounts[0];
    const p25 = pool25Accounts[0];

    console.log(`\n20-bps pool: ${p20.pk}`);
    console.log(`25-bps pool: ${p25.pk}`);

    console.log("\n--- RAW BYTES COMPARISON ---");
    console.log("Offset  20-bps                           25-bps                           Match?");
    console.log("-".repeat(90));

    const diffOffsets: number[] = [];

    for (let i = 0; i < 211; i += 8) {
        const chunk20 = p20.data.subarray(i, Math.min(i + 8, 211));
        const chunk25 = p25.data.subarray(i, Math.min(i + 8, 211));
        const hex20 = chunk20.toString("hex").padEnd(16, " ");
        const hex25 = chunk25.toString("hex").padEnd(16, " ");
        const match = chunk20.equals(chunk25) ? "✓" : "✗ DIFF";

        if (!chunk20.equals(chunk25)) {
            diffOffsets.push(i);
        }

        // Skip pubkeys (they'll always differ), focus on small fields
        const isLikelyPubkey = i >= 9 && i < 201 && (i - 9) % 32 < 24;
        if (!isLikelyPubkey || !chunk20.equals(chunk25)) {
            console.log(`${i.toString().padStart(3)}     ${hex20}                 ${hex25}                 ${match}`);
        }
    }

    console.log("\n--- DIFFERING OFFSETS (excluding expected pubkey diffs) ---");

    // Offsets that are NOT part of pubkeys
    // Layout: 8 disc + 1 bump + 2 index + 32 creator + 32 base_mint + 32 quote_mint + 
    //         32 lp_mint + 32 base_vault + 32 quote_vault + 8 lp_supply
    const expectedPubkeyRanges = [
        [11, 43],   // creator
        [43, 75],   // base_mint
        [75, 107],  // quote_mint
        [107, 139], // lp_mint
        [139, 171], // base_vault
        [171, 203], // quote_vault
    ];

    const unexpectedDiffs: number[] = [];
    for (const off of diffOffsets) {
        const inPubkey = expectedPubkeyRanges.some(([start, end]) => off >= start && off < end);
        if (!inPubkey) {
            unexpectedDiffs.push(off);
        }
    }

    if (unexpectedDiffs.length > 0) {
        console.log(`Unexpected differences at offsets: ${unexpectedDiffs.join(", ")}`);

        for (const off of unexpectedDiffs) {
            const v20 = p20.data.subarray(off, Math.min(off + 8, 211));
            const v25 = p25.data.subarray(off, Math.min(off + 8, 211));
            console.log(`\nOffset ${off}:`);
            console.log(`  20-bps: ${v20.toString("hex")} (u8=${v20[0]}, u64=${v20.length >= 8 ? v20.readBigUInt64LE(0) : "N/A"})`);
            console.log(`  25-bps: ${v25.toString("hex")} (u8=${v25[0]}, u64=${v25.length >= 8 ? v25.readBigUInt64LE(0) : "N/A"})`);
        }
    } else {
        console.log("No unexpected differences found in non-pubkey fields!");
    }

    // Step 4: Check bytes 203-210 specifically (lpSupply is at 203-211)
    console.log("\n--- TAIL BYTES (203-210) ---");
    console.log("lpSupply (u64) is at offset 203:");

    for (const [label, pool] of [["20-bps", p20], ["25-bps", p25]] as const) {
        const tail = pool.data.subarray(203);
        console.log(`\n${label} pool tail (${tail.length} bytes):`);
        console.log(`  hex: ${tail.toString("hex")}`);
        console.log(`  u8 values: ${[...tail].join(", ")}`);
        if (tail.length >= 8) {
            console.log(`  lpSupply (u64 @203): ${pool.data.readBigUInt64LE(203)}`);
        }
    }

    // Step 5: Analyze ALL pools to find pattern
    console.log("\n" + "=".repeat(80));
    console.log("Step 4: Analyzing ALL matched pools for patterns...");
    console.log("=".repeat(80));

    // Check each byte position for correlation with fee type
    const byteCorrelation: Map<number, { val20: number[]; val25: number[] }> = new Map();

    for (let i = 0; i < 211; i++) {
        byteCorrelation.set(i, { val20: [], val25: [] });
    }

    for (const p of pool20Accounts) {
        for (let i = 0; i < 211; i++) {
            byteCorrelation.get(i)!.val20.push(p.data[i]);
        }
    }

    for (const p of pool25Accounts) {
        for (let i = 0; i < 211; i++) {
            byteCorrelation.get(i)!.val25.push(p.data[i]);
        }
    }

    console.log("\nBytes with perfect fee correlation:");
    for (const [off, { val20, val25 }] of byteCorrelation) {
        const unique20 = [...new Set(val20)];
        const unique25 = [...new Set(val25)];

        // Perfect correlation: all 20-bps pools have one value, all 25-bps have different value
        if (unique20.length === 1 && unique25.length === 1 && unique20[0] !== unique25[0]) {
            console.log(`  Offset ${off}: 20-bps pools all have ${unique20[0]}, 25-bps pools all have ${unique25[0]}`);
        }
    }

    // Check u64 at offset 203 (lpSupply)
    console.log("\n--- LP Supply (u64 @203) by fee type ---");
    const lpSupply20: bigint[] = [];
    const lpSupply25: bigint[] = [];

    for (const p of pool20Accounts) {
        lpSupply20.push(p.data.readBigUInt64LE(203));
    }
    for (const p of pool25Accounts) {
        lpSupply25.push(p.data.readBigUInt64LE(203));
    }

    console.log(`20-bps pools: ${lpSupply20.slice(0, 5).join(", ")}...`);
    console.log(`25-bps pools: ${lpSupply25.slice(0, 5).join(", ")}...`);

    // Check index field (u16 at offset 9-10) - this might be fee tier index!
    console.log("\n--- Index field (u16 @9) by fee type ---");
    const index20 = pool20Accounts.map(p => p.data.readUInt16LE(9));
    const index25 = pool25Accounts.map(p => p.data.readUInt16LE(9));
    console.log(`20-bps pools: ${[...new Set(index20)].sort((a, b) => a - b).join(", ")}`);
    console.log(`25-bps pools: ${[...new Set(index25)].sort((a, b) => a - b).join(", ")}`);

    // Check poolBump (u8 at offset 8)
    console.log("\n--- Pool Bump (u8 @8) by fee type ---");
    const bump20 = pool20Accounts.map(p => p.data[8]);
    const bump25 = pool25Accounts.map(p => p.data[8]);
    console.log(`20-bps pools: ${[...new Set(bump20)].sort((a, b) => a - b).join(", ")}`);
    console.log(`25-bps pools: ${[...new Set(bump25)].sort((a, b) => a - b).join(", ")}`);;

    console.log("\n" + "=".repeat(80));
    console.log("DONE");
    console.log("=".repeat(80));
}

main().catch(console.error);