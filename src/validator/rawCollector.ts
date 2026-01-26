// =============================================================================
// YOGURTSLINGER RAW COLLECTOR v1.0
// =============================================================================
//
// PHILOSOPHY: Collect dumb, analyze smart.
//
// COLLECTION:
//   - Capture every PumpFun buy signature + slot
//   - No live filtering, no trigger detection, no assumptions
//   - Just raw data
//
// ENRICHMENT:
//   - Batch API calls to get real data for ALL transactions
//   - Actual SOL amounts, actual fees, actual slots
//
// ANALYSIS:
//   - Offline, with complete data
//   - Find patterns without collection-time bias
//
// =============================================================================

import { Connection, PublicKey, Logs, Context } from "@solana/web3.js";
import * as fs from "fs";

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
    helius: {
        rpc: "https://mainnet.helius-rpc.com/?api-key=bff504b3-c294-46e9-b7d8-dacbcb4b9e3d",
        wss: "wss://mainnet.helius-rpc.com/?api-key=bff504b3-c294-46e9-b7d8-dacbcb4b9e3d",
        apiBase: "https://api.helius.xyz/v0",
        apiKey: "bff504b3-c294-46e9-b7d8-dacbcb4b9e3d",
    },

    programs: {
        pumpfun: new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"),
    },

    api: {
        batchSize: 100,           // Helius limit
        delayBetweenBatches: 600, // ms - stay under rate limits
    },

    output: {
        dir: "./raw_collection",
        raw: "raw_signatures.jsonl",
        enriched: "enriched_txs.jsonl",
        analysis: "analysis.json",
    },
};

// =============================================================================
// TYPES
// =============================================================================

// What we capture from WebSocket (minimal)
interface RawCapture {
    signature: string;
    slot: number;
    receivedAt: number;
}

// What we get from API (everything we need)
interface EnrichedTx {
    signature: string;
    slot: number;
    timestamp: number;
    wallet: string;
    tokenMint: string;
    solAmount: number;
    tokenAmount: number;
    fee: number;
    priorityFee: number;
    type: string;           // "buy", "sell", "unknown"
    description: string;
}

// =============================================================================
// COLLECTION (dumb capture)
// =============================================================================

async function runCollection(durationMinutes: number): Promise<void> {
    console.log("\n" + "=".repeat(70));
    console.log("RAW COLLECTOR v1.0 - Collect dumb, analyze smart");
    console.log("=".repeat(70));
    console.log(`Duration: ${durationMinutes} minutes`);
    console.log(`Output: ${CONFIG.output.dir}/${CONFIG.output.raw}`);
    console.log("=".repeat(70) + "\n");

    // Setup output
    if (!fs.existsSync(CONFIG.output.dir)) {
        fs.mkdirSync(CONFIG.output.dir, { recursive: true });
    }

    const outputPath = `${CONFIG.output.dir}/${CONFIG.output.raw}`;

    // Test connection
    const connection = new Connection(CONFIG.helius.rpc, {
        wsEndpoint: CONFIG.helius.wss,
        commitment: "confirmed",
    });

    try {
        const slot = await connection.getSlot();
        console.log(`✅ Connected. Current slot: ${slot}\n`);
    } catch (error) {
        console.error(`❌ Connection failed: ${error}`);
        return;
    }

    const seen = new Set<string>();
    let count = 0;
    let buys = 0;

    // Simple capture - just signature and slot for buys
    function capture(logs: Logs, ctx: Context): void {
        if (logs.err) return;
        if (seen.has(logs.signature)) return;
        seen.add(logs.signature);

        count++;

        // Only capture buys (minimal check)
        const text = (logs.logs || []).join(" ");
        if (!text.includes("Instruction: Buy")) return;

        buys++;

        const raw: RawCapture = {
            signature: logs.signature,
            slot: ctx.slot,
            receivedAt: Date.now(),
        };

        fs.appendFileSync(outputPath, JSON.stringify(raw) + "\n");

        // Memory cleanup
        if (seen.size > 50000) {
            const keep = Array.from(seen).slice(-25000);
            seen.clear();
            keep.forEach(s => seen.add(s));
        }
    }

    // Subscribe
    console.log("Subscribing to PumpFun...");
    const subscription = connection.onLogs(CONFIG.programs.pumpfun, capture, "confirmed");
    console.log(`✅ Subscription ID: ${subscription}`);
    console.log("\n📡 Capturing all buy signatures...\n");

    // Progress
    const startTime = Date.now();

    const progressInterval = setInterval(() => {
        const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
        console.log(`[${elapsed}m/${durationMinutes}m] Total txs: ${count} | Buys captured: ${buys}`);
    }, 30000);

    // Wait
    await new Promise<void>(resolve => setTimeout(resolve, durationMinutes * 60 * 1000));

    clearInterval(progressInterval);
    await connection.removeOnLogsListener(subscription);

    console.log("\n" + "=".repeat(70));
    console.log("COLLECTION COMPLETE");
    console.log("=".repeat(70));
    console.log(`Total transactions seen: ${count}`);
    console.log(`Buy signatures captured: ${buys}`);
    console.log(`Output: ${outputPath}`);
    console.log("\nNext: npx tsx rawCollector.ts enrich");
}

// =============================================================================
// ENRICHMENT (batch API)
// =============================================================================

async function runEnrichment(): Promise<void> {
    console.log("\n" + "=".repeat(70));
    console.log("ENRICHMENT - Getting real data from API");
    console.log("=".repeat(70) + "\n");

    const rawPath = `${CONFIG.output.dir}/${CONFIG.output.raw}`;
    const enrichedPath = `${CONFIG.output.dir}/${CONFIG.output.enriched}`;

    if (!fs.existsSync(rawPath)) {
        console.log("❌ No raw data found. Run: npx tsx rawCollector.ts collect 60");
        return;
    }

    // Load raw signatures
    const lines = fs.readFileSync(rawPath, "utf-8").trim().split("\n").filter(l => l);
    const rawCaptures: RawCapture[] = lines.map(l => JSON.parse(l));

    console.log(`Loaded ${rawCaptures.length} raw signatures`);

    // Check what's already enriched
    const alreadyEnriched = new Set<string>();
    if (fs.existsSync(enrichedPath)) {
        const enrichedLines = fs.readFileSync(enrichedPath, "utf-8").trim().split("\n").filter(l => l);
        for (const line of enrichedLines) {
            try {
                const tx = JSON.parse(line);
                alreadyEnriched.add(tx.signature);
            } catch { }
        }
        console.log(`Already enriched: ${alreadyEnriched.size}`);
    }

    const toEnrich = rawCaptures.filter(r => !alreadyEnriched.has(r.signature));
    console.log(`To enrich: ${toEnrich.length}\n`);

    if (toEnrich.length === 0) {
        console.log("Nothing to enrich. Run analysis.");
        return;
    }

    // Batch enrich
    const signatures = toEnrich.map(r => r.signature);
    let enriched = 0;
    let failed = 0;

    for (let i = 0; i < signatures.length; i += CONFIG.api.batchSize) {
        const batch = signatures.slice(i, i + CONFIG.api.batchSize);
        const batchNum = Math.floor(i / CONFIG.api.batchSize) + 1;
        const totalBatches = Math.ceil(signatures.length / CONFIG.api.batchSize);

        process.stdout.write(`\rBatch ${batchNum}/${totalBatches} | Enriched: ${enriched} | Failed: ${failed}`);

        try {
            const url = `${CONFIG.helius.apiBase}/transactions/?api-key=${CONFIG.helius.apiKey}`;
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ transactions: batch }),
            });

            if (response.status === 429) {
                console.log("\n⚠️ Rate limited. Waiting 30s...");
                await sleep(30000);
                i -= CONFIG.api.batchSize; // Retry this batch
                continue;
            }

            if (!response.ok) {
                failed += batch.length;
                continue;
            }

            const data = await response.json();

            for (const tx of data) {
                if (!tx || !tx.signature) {
                    failed++;
                    continue;
                }

                // Extract SOL amount from native transfers
                let solAmount = 0;
                for (const nt of (tx.nativeTransfers || [])) {
                    solAmount += Math.abs(nt.amount || 0);
                }
                solAmount = solAmount / 1e9;

                // Cap sanity check - nobody buys > 100 SOL on pumpfun
                if (solAmount > 100) solAmount = 0;

                // Extract token info
                let tokenMint = "";
                let tokenAmount = 0;
                for (const tt of (tx.tokenTransfers || [])) {
                    if (tt.mint) tokenMint = tt.mint;
                    tokenAmount += Math.abs(tt.tokenAmount || 0);
                }

                // Determine type
                const desc = (tx.description || "").toLowerCase();
                let type = "unknown";
                if (desc.includes("buy") || desc.includes("swap")) type = "buy";
                if (desc.includes("sell")) type = "sell";

                const enrichedTx: EnrichedTx = {
                    signature: tx.signature,
                    slot: tx.slot || 0,
                    timestamp: tx.timestamp || 0,
                    wallet: tx.feePayer || "unknown",
                    tokenMint,
                    tokenAmount,
                    solAmount,
                    fee: tx.fee || 0,
                    priorityFee: (tx.fee || 0) - 5000, // Base fee is 5000
                    type,
                    description: tx.description || "",
                };

                fs.appendFileSync(enrichedPath, JSON.stringify(enrichedTx) + "\n");
                enriched++;
            }

        } catch (error) {
            failed += batch.length;
        }

        await sleep(CONFIG.api.delayBetweenBatches);
    }

    console.log(`\n\n${"=".repeat(70)}`);
    console.log("ENRICHMENT COMPLETE");
    console.log("=".repeat(70));
    console.log(`Enriched: ${enriched}`);
    console.log(`Failed: ${failed}`);
    console.log(`Output: ${enrichedPath}`);
    console.log("\nNext: npx tsx rawCollector.ts analyze");
}

// =============================================================================
// ANALYSIS (smart, offline)
// =============================================================================

async function runAnalysis(): Promise<void> {
    console.log("\n" + "=".repeat(70));
    console.log("ANALYSIS - Finding patterns in real data");
    console.log("=".repeat(70) + "\n");

    const enrichedPath = `${CONFIG.output.dir}/${CONFIG.output.enriched}`;

    if (!fs.existsSync(enrichedPath)) {
        console.log("❌ No enriched data. Run: npx tsx rawCollector.ts enrich");
        return;
    }

    // Load enriched transactions
    const lines = fs.readFileSync(enrichedPath, "utf-8").trim().split("\n").filter(l => l);
    const txs: EnrichedTx[] = lines.map(l => JSON.parse(l)).filter(t => t.tokenMint && t.solAmount > 0);

    console.log(`Loaded ${txs.length} enriched transactions with valid data\n`);

    if (txs.length === 0) {
        console.log("No valid transactions to analyze.");
        return;
    }

    // =========================================================================
    // GROUP BY TOKEN
    // =========================================================================

    const byToken = new Map<string, EnrichedTx[]>();
    for (const tx of txs) {
        const existing = byToken.get(tx.tokenMint) || [];
        existing.push(tx);
        byToken.set(tx.tokenMint, existing);
    }

    // Sort each token's txs by slot
    for (const [mint, tokenTxs] of byToken) {
        tokenTxs.sort((a, b) => a.slot - b.slot);
        byToken.set(mint, tokenTxs);
    }

    console.log(`Tokens with activity: ${byToken.size}\n`);

    // =========================================================================
    // FIND SWARMS (now with real data)
    // =========================================================================

    console.log("📊 IDENTIFYING SWARMS (5+ buys within 12 slots / ~5 seconds)");
    console.log("-".repeat(50));

    interface Swarm {
        tokenMint: string;
        transactions: EnrichedTx[];
        trigger: EnrichedTx;
        triggerPosition: number;
        followers: EnrichedTx[];
        firstFollowerGapSlots: number;
        totalVolume: number;
    }

    const swarms: Swarm[] = [];

    for (const [mint, tokenTxs] of byToken) {
        if (tokenTxs.length < 5) continue;

        // Sliding window: find clusters of 5+ txs within 12 slots
        for (let i = 0; i < tokenTxs.length - 4; i++) {
            const windowStart = tokenTxs[i]!.slot;
            const windowEnd = windowStart + 12; // ~5 seconds

            const inWindow = tokenTxs.filter(t => t.slot >= windowStart && t.slot <= windowEnd);

            if (inWindow.length >= 5) {
                // Find the trigger: first tx with >= 0.3 SOL that has followers AFTER it
                let trigger: EnrichedTx | null = null;
                let triggerIdx = 0;

                for (let j = 0; j < inWindow.length - 1; j++) {
                    const candidate = inWindow[j]!;
                    const nextTx = inWindow[j + 1]!;

                    // Must have gap to next tx (at least 1 slot)
                    if (nextTx.slot > candidate.slot && candidate.solAmount >= 0.3) {
                        trigger = candidate;
                        triggerIdx = j;
                        break;
                    }
                }

                // Fallback: largest tx in first half with a gap after
                if (!trigger) {
                    const firstHalf = inWindow.slice(0, Math.ceil(inWindow.length / 2));
                    let maxSol = 0;
                    for (let j = 0; j < firstHalf.length; j++) {
                        const candidate = firstHalf[j]!;
                        const nextTx = inWindow[j + 1];
                        if (nextTx && nextTx.slot > candidate.slot && candidate.solAmount > maxSol) {
                            maxSol = candidate.solAmount;
                            trigger = candidate;
                            triggerIdx = j;
                        }
                    }
                }

                if (!trigger) continue;

                const followers = inWindow.slice(triggerIdx + 1);
                if (followers.length < 2) continue;

                const firstFollowerGap = followers[0]!.slot - trigger.slot;

                // CRITICAL: Skip if no gap (same-slot = bundled, not caused)
                if (firstFollowerGap === 0) continue;

                swarms.push({
                    tokenMint: mint,
                    transactions: inWindow,
                    trigger,
                    triggerPosition: triggerIdx + 1,
                    followers,
                    firstFollowerGapSlots: firstFollowerGap,
                    totalVolume: inWindow.reduce((s, t) => s + t.solAmount, 0),
                });

                // Skip past this window
                i += inWindow.length - 1;
                break;
            }
        }
    }

    console.log(`Found ${swarms.length} swarms with slot gaps (filtered out same-slot bundles)\n`);

    if (swarms.length === 0) {
        console.log("No valid swarms found. This could mean:");
        console.log("- Most activity is bundled snipers (same slot)");
        console.log("- Need more data collection time");
        console.log("- Threshold adjustments needed");
        return;
    }

    // =========================================================================
    // ANALYZE TRIGGERS
    // =========================================================================

    console.log("📊 TRIGGER CHARACTERISTICS");
    console.log("-".repeat(50));

    const triggerSols = swarms.map(s => s.trigger.solAmount).sort((a, b) => a - b);

    const percentile = (arr: number[], p: number) => arr[Math.floor(arr.length * p)] ?? 0;

    console.log("SOL Amount:");
    console.log(`  Min:    ${triggerSols[0]?.toFixed(3)} SOL`);
    console.log(`  P25:    ${percentile(triggerSols, 0.25).toFixed(3)} SOL`);
    console.log(`  Median: ${percentile(triggerSols, 0.5).toFixed(3)} SOL`);
    console.log(`  P75:    ${percentile(triggerSols, 0.75).toFixed(3)} SOL`);
    console.log(`  Max:    ${triggerSols[triggerSols.length - 1]?.toFixed(3)} SOL`);

    const botThreshold = 50000; // 50k lamports priority fee = bot
    const bots = swarms.filter(s => s.trigger.priorityFee > botThreshold);
    const manuals = swarms.filter(s => s.trigger.priorityFee <= botThreshold);

    console.log(`\nTrigger Source:`);
    console.log(`  Manual (low fee): ${manuals.length} (${(manuals.length / swarms.length * 100).toFixed(1)}%)`);
    console.log(`  Bot (high fee):   ${bots.length} (${(bots.length / swarms.length * 100).toFixed(1)}%)`);

    // =========================================================================
    // ANALYZE LATENCY (slots → ms)
    // =========================================================================

    console.log("\n📊 POSITIONING WINDOW (slot gaps × 400ms)");
    console.log("-".repeat(50));

    const gapSlots = swarms.map(s => s.firstFollowerGapSlots).sort((a, b) => a - b);
    const gapMs = gapSlots.map(g => g * 400);

    console.log("First follower arrives after trigger:");
    console.log(`  Min:    ${gapSlots[0]} slots (${gapMs[0]}ms)`);
    console.log(`  Median: ${percentile(gapSlots, 0.5)} slots (${percentile(gapMs, 0.5)}ms)`);
    console.log(`  P90:    ${percentile(gapSlots, 0.9)} slots (${percentile(gapMs, 0.9)}ms)`);
    console.log(`  Max:    ${gapSlots[gapSlots.length - 1]} slots (${gapMs[gapMs.length - 1]}ms)`);

    // =========================================================================
    // ANALYZE FOLLOWER VOLUME (exit liquidity)
    // =========================================================================

    console.log("\n📊 FOLLOWER VOLUME (exit liquidity)");
    console.log("-".repeat(50));

    const followerVols = swarms.map(s => s.followers.reduce((sum, f) => sum + f.solAmount, 0)).sort((a, b) => a - b);

    console.log(`  Min:    ${followerVols[0]?.toFixed(2)} SOL`);
    console.log(`  Median: ${percentile(followerVols, 0.5).toFixed(2)} SOL`);
    console.log(`  P75:    ${percentile(followerVols, 0.75).toFixed(2)} SOL`);
    console.log(`  Max:    ${followerVols[followerVols.length - 1]?.toFixed(2)} SOL`);

    // =========================================================================
    // MANUAL TRIGGER DEEP DIVE
    // =========================================================================

    if (manuals.length > 0) {
        console.log("\n📊 MANUAL TRIGGER DEEP DIVE (your target)");
        console.log("-".repeat(50));

        const manualSols = manuals.map(s => s.trigger.solAmount).sort((a, b) => a - b);
        const manualGaps = manuals.map(s => s.firstFollowerGapSlots).sort((a, b) => a - b);
        const manualVols = manuals.map(s => s.followers.reduce((sum, f) => sum + f.solAmount, 0)).sort((a, b) => a - b);

        console.log(`Manual triggers: ${manuals.length}`);
        console.log(`\nTrigger size:`);
        console.log(`  Median: ${percentile(manualSols, 0.5).toFixed(3)} SOL`);
        console.log(`\nPositioning window:`);
        console.log(`  Median: ${percentile(manualGaps, 0.5)} slots (${percentile(manualGaps, 0.5) * 400}ms)`);
        console.log(`\nExit liquidity:`);
        console.log(`  Median: ${percentile(manualVols, 0.5).toFixed(2)} SOL`);

        // Show some examples
        console.log(`\nExample manual triggers:`);
        for (const s of manuals.slice(0, 5)) {
            console.log(
                `  ${s.trigger.solAmount.toFixed(2)} SOL → ` +
                `${s.followers.length} followers (${s.followers.reduce((sum, f) => sum + f.solAmount, 0).toFixed(1)} SOL) | ` +
                `${s.firstFollowerGapSlots} slot gap (${s.firstFollowerGapSlots * 400}ms)`
            );
        }
    }

    // =========================================================================
    // KEY FINDINGS
    // =========================================================================

    console.log("\n" + "=".repeat(70));
    console.log("🎯 KEY FINDINGS");
    console.log("=".repeat(70));

    const medianTriggerSol = percentile(triggerSols, 0.5);
    const medianGapMs = percentile(gapMs, 0.5);
    const medianFollowerVol = percentile(followerVols, 0.5);
    const pctManual = (manuals.length / swarms.length * 100).toFixed(1);

    console.log(`
1. VALID SWARMS: ${swarms.length} (filtered out same-slot bundles)

2. TRIGGER CHARACTERISTICS:
   - Median size: ${medianTriggerSol.toFixed(2)} SOL
   - ${pctManual}% from manual traders

3. POSITIONING WINDOW:
   - Median: ${medianGapMs}ms between trigger and first follower
   - This is your window to get in

4. EXIT LIQUIDITY:
   - Median: ${medianFollowerVol.toFixed(2)} SOL follows the trigger
   - This is what you sell into
`);

    // Viability assessment
    console.log("VIABILITY ASSESSMENT:");
    if (medianGapMs >= 400 && medianFollowerVol >= 1.0 && parseFloat(pctManual) >= 20) {
        console.log("✅ POTENTIALLY VIABLE");
        console.log(`   - ${medianGapMs}ms window is enough for ShredStream + fast execution`);
        console.log(`   - ${medianFollowerVol.toFixed(1)} SOL exit liquidity covers position + slippage`);
        console.log(`   - ${pctManual}% manual triggers = exploitable signal`);
    } else {
        console.log("⚠️ CONCERNS:");
        if (medianGapMs < 400) console.log(`   - ${medianGapMs}ms window may be too tight`);
        if (medianFollowerVol < 1.0) console.log(`   - ${medianFollowerVol.toFixed(1)} SOL exit liquidity is thin`);
        if (parseFloat(pctManual) < 20) console.log(`   - Only ${pctManual}% manual triggers`);
    }

    // Save analysis
    const analysis = {
        timestamp: Date.now(),
        totalTxs: txs.length,
        tokensWithActivity: byToken.size,
        validSwarms: swarms.length,
        triggerStats: {
            medianSol: medianTriggerSol,
            pctManual: parseFloat(pctManual),
        },
        latencyStats: {
            medianGapSlots: percentile(gapSlots, 0.5),
            medianGapMs,
        },
        volumeStats: {
            medianFollowerVolume: medianFollowerVol,
        },
    };

    fs.writeFileSync(`${CONFIG.output.dir}/${CONFIG.output.analysis}`, JSON.stringify(analysis, null, 2));
    console.log(`\nAnalysis saved to: ${CONFIG.output.dir}/${CONFIG.output.analysis}`);
}

// =============================================================================
// HELPERS
// =============================================================================

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const command = args[0] || "help";

    switch (command) {
        case "collect": {
            const minutes = parseInt(args[1] ?? "60", 10);
            await runCollection(minutes);
            break;
        }

        case "enrich":
            await runEnrichment();
            break;

        case "analyze":
            await runAnalysis();
            break;

        default:
            console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║              RAW COLLECTOR v1.0 - Collect dumb, analyze smart        ║
╚══════════════════════════════════════════════════════════════════════╝

WORKFLOW:
  1. COLLECT - Capture all PumpFun buy signatures (no filtering)
  2. ENRICH  - Batch API to get real data for everything  
  3. ANALYZE - Find patterns offline with complete data

COMMANDS:
  npx tsx rawCollector.ts collect [minutes]   # Default: 60
  npx tsx rawCollector.ts enrich              # Batch API enrichment
  npx tsx rawCollector.ts analyze             # Offline analysis

OUTPUT:
  ./raw_collection/raw_signatures.jsonl       # Step 1 output
  ./raw_collection/enriched_txs.jsonl         # Step 2 output
  ./raw_collection/analysis.json              # Step 3 output

EXAMPLE:
  npx tsx rawCollector.ts collect 30
  npx tsx rawCollector.ts enrich
  npx tsx rawCollector.ts analyze
            `);
    }
}

main().catch(console.error);