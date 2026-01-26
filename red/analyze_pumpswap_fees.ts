// analyze_pumpswap_fees.ts
// Usage: pnpm exec ts-node analyze_pumpswap_fees.ts

import { PublicKey, Connection } from "@solana/web3.js";

const HELIUS_RPC = "https://mainnet.helius-rpc.com/?api-key=bff504b3-c294-46e9-b7d8-dacbcb4b9e3d";
const PUMPSWAP_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const WSOL_MINT = "So11111111111111111111111111111111111111112";

// Pool discriminator from your decoder
const PUMPSWAP_POOL_DISCRIMINATOR = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);

interface SwapCase {
    sig: string;
    slot: number;
    side: "BUY" | "SELL";
    amountIn: bigint;
    actualOut: bigint;
    grossOut: bigint;
    impliedFeeBps: number;
    poolPk: string;
    poolIndex: number;
    poolBump: number;
    creatorIsNull: boolean;
}

function constantProductOut(reserveIn: bigint, reserveOut: bigint, amountIn: bigint): bigint {
    if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
    return (reserveOut * amountIn) / (reserveIn + amountIn);
}

function inferOutputFee(grossOut: bigint, actualOut: bigint): number | null {
    if (grossOut <= 0n || actualOut > grossOut) return null;
    const feeFraction = Number(grossOut - actualOut) / Number(grossOut);
    return Math.round(feeFraction * 10000);
}

function decodePoolBasic(data: Buffer): { index: number; bump: number; creatorIsNull: boolean } | null {
    if (data.length < 211) return null;
    if (!data.subarray(0, 8).equals(PUMPSWAP_POOL_DISCRIMINATOR)) return null;

    const bump = data.readUInt8(8);
    const index = data.readUInt16LE(9);
    const creatorBytes = data.subarray(11, 43);
    const creatorIsNull = creatorBytes.every(b => b === 0);

    return { index, bump, creatorIsNull };
}

async function main() {
    const conn = new Connection(HELIUS_RPC, "confirmed");

    console.log("=".repeat(80));
    console.log("PumpSwap Fee Analysis - Correlating pool.index with fee");
    console.log("=".repeat(80));

    // Step 1: Fetch ALL pool accounts upfront
    console.log("\nStep 1: Fetching all pool accounts...");
    const allPoolAccounts = await conn.getProgramAccounts(PUMPSWAP_PROGRAM_ID, {
        filters: [{ dataSize: 211 }],
        commitment: "confirmed",
    });
    console.log(`Found ${allPoolAccounts.length} pool accounts`);

    // Build map: vault pubkey -> pool info
    const vaultToPool = new Map<string, { pk: string; index: number; bump: number; creatorIsNull: boolean }>();

    for (const pa of allPoolAccounts) {
        const data = pa.account.data;
        const decoded = decodePoolBasic(data);
        if (!decoded) continue;

        // baseVault at offset 139, quoteVault at offset 171
        const baseVault = new PublicKey(data.subarray(139, 171)).toBase58();
        const quoteVault = new PublicKey(data.subarray(171, 203)).toBase58();

        const poolInfo = {
            pk: pa.pubkey.toBase58(),
            index: decoded.index,
            bump: decoded.bump,
            creatorIsNull: decoded.creatorIsNull,
        };

        vaultToPool.set(baseVault, poolInfo);
        vaultToPool.set(quoteVault, poolInfo);
    }
    console.log(`Built vault->pool map with ${vaultToPool.size} entries`);

    // Step 2: Fetch recent swaps
    console.log("\nStep 2: Fetching recent swaps...");
    const sigs = await conn.getSignaturesForAddress(PUMPSWAP_PROGRAM_ID, { limit: 300 });
    console.log(`Found ${sigs.length} recent signatures\n`);

    const swapCases: SwapCase[] = [];
    let processed = 0;
    let skipped = 0;
    let noPoolMatch = 0;

    for (const sigInfo of sigs) {
        if (sigInfo.err) {
            skipped++;
            continue;
        }

        try {
            const tx = await conn.getTransaction(sigInfo.signature, {
                maxSupportedTransactionVersion: 0,
            });

            if (!tx || !tx.meta || tx.meta.err) {
                skipped++;
                continue;
            }

            const preTokenBalances = tx.meta.preTokenBalances || [];
            const postTokenBalances = tx.meta.postTokenBalances || [];

            if (preTokenBalances.length < 2 || postTokenBalances.length < 2) {
                skipped++;
                continue;
            }

            const accountKeys = tx.transaction.message.getAccountKeys();
            const staticKeys = accountKeys.staticAccountKeys;

            // Build balance maps
            const preMap = new Map<string, { mint: string; amount: bigint }>();
            const postMap = new Map<string, { mint: string; amount: bigint }>();

            for (const tb of preTokenBalances) {
                const pk = staticKeys[tb.accountIndex]?.toBase58();
                if (pk && tb.uiTokenAmount.amount) {
                    preMap.set(pk, { mint: tb.mint, amount: BigInt(tb.uiTokenAmount.amount) });
                }
            }

            for (const tb of postTokenBalances) {
                const pk = staticKeys[tb.accountIndex]?.toBase58();
                if (pk && tb.uiTokenAmount.amount) {
                    postMap.set(pk, { mint: tb.mint, amount: BigInt(tb.uiTokenAmount.amount) });
                }
            }

            // Find vault deltas
            const deltas: Array<{ pk: string; mint: string; delta: bigint; pre: bigint }> = [];
            for (const [pk, pre] of preMap) {
                const post = postMap.get(pk);
                if (!post) continue;
                const delta = post.amount - pre.amount;
                if (delta !== 0n) {
                    deltas.push({ pk, mint: pre.mint, delta, pre: pre.amount });
                }
            }

            const inVault = deltas.find(d => d.delta > 0n);
            const outVault = deltas.find(d => d.delta < 0n && d.mint !== inVault?.mint);

            if (!inVault || !outVault) {
                skipped++;
                continue;
            }

            const amountIn = inVault.delta;
            const actualOut = -outVault.delta;
            const reserveIn = inVault.pre;
            const reserveOut = outVault.pre;
            const grossOut = constantProductOut(reserveIn, reserveOut, amountIn);
            const impliedFeeBps = inferOutputFee(grossOut, actualOut);

            if (impliedFeeBps === null || impliedFeeBps < 0 || impliedFeeBps > 100) {
                skipped++;
                continue;
            }

            const isWsolIn = inVault.mint === WSOL_MINT;
            const side: "BUY" | "SELL" = isWsolIn ? "BUY" : "SELL";

            // Look up pool from vault map
            const poolInfo = vaultToPool.get(inVault.pk) || vaultToPool.get(outVault.pk);
            if (!poolInfo) {
                noPoolMatch++;
                continue;
            }

            swapCases.push({
                sig: sigInfo.signature,
                slot: tx.slot,
                side,
                amountIn,
                actualOut,
                grossOut,
                impliedFeeBps,
                poolPk: poolInfo.pk,
                poolIndex: poolInfo.index,
                poolBump: poolInfo.bump,
                creatorIsNull: poolInfo.creatorIsNull,
            });

            processed++;

            if (processed % 10 === 0) {
                console.log(`Processed ${processed} swaps...`);
            }

        } catch {
            skipped++;
        }

        await new Promise(r => setTimeout(r, 30));
    }

    console.log(`\nTotal processed: ${processed}`);
    console.log(`Skipped: ${skipped}`);
    console.log(`No pool match: ${noPoolMatch}`);

    // Analyze correlation between index and fee
    console.log("\n" + "=".repeat(80));
    console.log("CORRELATION: pool.index vs implied fee");
    console.log("=".repeat(80));

    // Group by index
    const indexToFees = new Map<number, number[]>();
    for (const c of swapCases) {
        if (!indexToFees.has(c.poolIndex)) {
            indexToFees.set(c.poolIndex, []);
        }
        indexToFees.get(c.poolIndex)!.push(c.impliedFeeBps);
    }

    console.log("\nFees by pool.index:");
    const sortedIndices = [...indexToFees.keys()].sort((a, b) => a - b);
    for (const idx of sortedIndices) {
        const fees = indexToFees.get(idx)!;
        const uniqueFees = [...new Set(fees)].sort((a, b) => a - b);
        const feeHist = new Map<number, number>();
        for (const f of fees) {
            feeHist.set(f, (feeHist.get(f) || 0) + 1);
        }
        const histStr = [...feeHist.entries()].map(([f, c]) => `${f}bps:${c}`).join(", ");
        console.log(`  index=${idx}: ${fees.length} swaps, fees=[${uniqueFees.join(", ")}] bps  (${histStr})`);
    }

    // Analyze correlation between creatorIsNull and fee
    console.log("\n" + "=".repeat(80));
    console.log("CORRELATION: creatorIsNull vs implied fee");
    console.log("=".repeat(80));

    const nullCreatorFees: number[] = [];
    const nonNullCreatorFees: number[] = [];
    for (const c of swapCases) {
        if (c.creatorIsNull) {
            nullCreatorFees.push(c.impliedFeeBps);
        } else {
            nonNullCreatorFees.push(c.impliedFeeBps);
        }
    }

    console.log(`\nNull creator pools: ${nullCreatorFees.length} swaps`);
    const nullHist = new Map<number, number>();
    for (const f of nullCreatorFees) nullHist.set(f, (nullHist.get(f) || 0) + 1);
    for (const [f, c] of [...nullHist.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${f} bps: ${c} cases`);
    }

    console.log(`\nNon-null creator pools: ${nonNullCreatorFees.length} swaps`);
    const nonNullHist = new Map<number, number>();
    for (const f of nonNullCreatorFees) nonNullHist.set(f, (nonNullHist.get(f) || 0) + 1);
    for (const [f, c] of [...nonNullHist.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${f} bps: ${c} cases`);
    }

    // Show sample cases
    console.log("\n" + "=".repeat(80));
    console.log("SAMPLE CASES");
    console.log("=".repeat(80));

    const cases20 = swapCases.filter(c => c.impliedFeeBps === 20).slice(0, 5);
    const cases25 = swapCases.filter(c => c.impliedFeeBps === 25).slice(0, 5);

    console.log("\n20 bps cases:");
    for (const c of cases20) {
        console.log(`  sig=${c.sig.slice(0, 20)}... index=${c.poolIndex} creatorNull=${c.creatorIsNull} pool=${c.poolPk.slice(0, 20)}...`);
    }

    console.log("\n25 bps cases:");
    for (const c of cases25) {
        console.log(`  sig=${c.sig.slice(0, 20)}... index=${c.poolIndex} creatorNull=${c.creatorIsNull} pool=${c.poolPk.slice(0, 20)}...`);
    }

    console.log("\n" + "=".repeat(80));
    console.log("DONE");
    console.log("=".repeat(80));
}

main().catch(console.error);