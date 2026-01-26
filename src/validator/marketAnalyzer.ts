// =============================================================================
// PUMPFUN MARKET ANALYZER
// =============================================================================
//
// Deep analysis of PumpFun activity:
// - Net liquidity flows
// - Wallet profiling (most active, biggest winners/losers)
// - Token analysis
// - Bot vs manual breakdown
//
// =============================================================================

import * as fs from "fs";

// =============================================================================
// TYPES
// =============================================================================

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
    type: string;
    description: string;
}

interface WalletStats {
    wallet: string;
    txCount: number;
    buyCount: number;
    sellCount: number;
    totalBuyVolume: number;
    totalSellVolume: number;
    netFlow: number;           // negative = net buyer, positive = net seller
    uniqueTokens: Set<string>;
    avgTxSize: number;
    avgPriorityFee: number;
    isLikelyBot: boolean;
    firstSeen: number;
    lastSeen: number;
}

interface TokenStats {
    mint: string;
    txCount: number;
    buyCount: number;
    sellCount: number;
    totalBuyVolume: number;
    totalSellVolume: number;
    netFlow: number;
    uniqueBuyers: Set<string>;
    uniqueSellers: Set<string>;
    firstTx: number;
    lastTx: number;
}

// =============================================================================
// ANALYSIS
// =============================================================================

async function analyze(): Promise<void> {
    // Accept path from command line or default
    const dataDir = process.argv[2] || "./raw_collection";
    const enrichedPath = `${dataDir}/enriched_txs.jsonl`;

    if (!fs.existsSync(enrichedPath)) {
        console.log("❌ No enriched data found. Run collection first.");
        return;
    }

    // Load data
    console.log("\n" + "=".repeat(70));
    console.log("PUMPFUN MARKET ANALYZER");
    console.log("=".repeat(70) + "\n");

    const lines = fs.readFileSync(enrichedPath, "utf-8").trim().split("\n").filter(l => l);
    const txs: EnrichedTx[] = [];

    for (const line of lines) {
        try {
            const tx = JSON.parse(line);
            if (tx.wallet && tx.wallet !== "unknown") {
                txs.push(tx);
            }
        } catch { }
    }

    console.log(`Loaded ${txs.length} transactions\n`);

    // Determine transaction types from description
    for (const tx of txs) {
        const desc = (tx.description || "").toLowerCase();
        if (desc.includes("sold") || desc.includes("sell")) {
            tx.type = "sell";
        } else if (desc.includes("bought") || desc.includes("buy") || desc.includes("swap")) {
            tx.type = "buy";
        }
    }

    const buys = txs.filter(t => t.type === "buy");
    const sells = txs.filter(t => t.type === "sell");
    const unknown = txs.filter(t => t.type !== "buy" && t.type !== "sell");

    console.log("📊 TRANSACTION BREAKDOWN");
    console.log("-".repeat(50));
    console.log(`  Buys:    ${buys.length} (${(buys.length / txs.length * 100).toFixed(1)}%)`);
    console.log(`  Sells:   ${sells.length} (${(sells.length / txs.length * 100).toFixed(1)}%)`);
    console.log(`  Unknown: ${unknown.length} (${(unknown.length / txs.length * 100).toFixed(1)}%)`);

    if (sells.length === 0) {
        console.log("\n⚠️  NO SELLS CAPTURED - Collection only grabbed buys!");
        console.log("   P&L analysis will be limited. Re-run collection to capture all tx types.\n");
    }

    // =========================================================================
    // LIQUIDITY ANALYSIS
    // =========================================================================

    console.log("\n📊 NET LIQUIDITY FLOW");
    console.log("-".repeat(50));

    const totalBuyVolume = buys.reduce((s, t) => s + t.solAmount, 0);
    const totalSellVolume = sells.reduce((s, t) => s + t.solAmount, 0);
    const netFlow = totalSellVolume - totalBuyVolume;

    console.log(`  Total buy volume:  ${totalBuyVolume.toFixed(2)} SOL`);
    console.log(`  Total sell volume: ${totalSellVolume.toFixed(2)} SOL`);
    console.log(`  Net flow: ${netFlow >= 0 ? "+" : ""}${netFlow.toFixed(2)} SOL ${netFlow >= 0 ? "(extraction)" : "(injection)"}`);

    // Per-minute rate
    const slots = txs.map(t => t.slot).sort((a, b) => a - b);
    const slotRange = slots[slots.length - 1]! - slots[0]!;
    const minutesObserved = (slotRange * 0.4) / 60; // ~400ms per slot

    console.log(`\n  Observation period: ~${minutesObserved.toFixed(1)} minutes`);
    console.log(`  Buy rate: ${(totalBuyVolume / minutesObserved).toFixed(2)} SOL/min`);
    console.log(`  Sell rate: ${(totalSellVolume / minutesObserved).toFixed(2)} SOL/min`);

    // =========================================================================
    // WALLET ANALYSIS
    // =========================================================================

    console.log("\n📊 WALLET ANALYSIS");
    console.log("-".repeat(50));

    const walletMap = new Map<string, WalletStats>();

    for (const tx of txs) {
        let stats = walletMap.get(tx.wallet);
        if (!stats) {
            stats = {
                wallet: tx.wallet,
                txCount: 0,
                buyCount: 0,
                sellCount: 0,
                totalBuyVolume: 0,
                totalSellVolume: 0,
                netFlow: 0,
                uniqueTokens: new Set(),
                avgTxSize: 0,
                avgPriorityFee: 0,
                isLikelyBot: false,
                firstSeen: tx.slot,
                lastSeen: tx.slot,
            };
            walletMap.set(tx.wallet, stats);
        }

        stats.txCount++;
        if (tx.type === "buy") {
            stats.buyCount++;
            stats.totalBuyVolume += tx.solAmount;
        } else if (tx.type === "sell") {
            stats.sellCount++;
            stats.totalSellVolume += tx.solAmount;
        }

        if (tx.tokenMint) stats.uniqueTokens.add(tx.tokenMint);
        stats.avgPriorityFee += tx.priorityFee;
        stats.firstSeen = Math.min(stats.firstSeen, tx.slot);
        stats.lastSeen = Math.max(stats.lastSeen, tx.slot);
    }

    // Finalize stats
    for (const stats of walletMap.values()) {
        stats.netFlow = stats.totalSellVolume - stats.totalBuyVolume;
        stats.avgTxSize = (stats.totalBuyVolume + stats.totalSellVolume) / stats.txCount;
        stats.avgPriorityFee = stats.avgPriorityFee / stats.txCount;
        stats.isLikelyBot = stats.avgPriorityFee > 50000; // 50k lamports avg = bot
    }

    const wallets = Array.from(walletMap.values());

    console.log(`  Unique wallets: ${wallets.length}`);

    const bots = wallets.filter(w => w.isLikelyBot);
    const manuals = wallets.filter(w => !w.isLikelyBot);

    console.log(`  Likely bots: ${bots.length} (${(bots.length / wallets.length * 100).toFixed(1)}%)`);
    console.log(`  Likely manual: ${manuals.length} (${(manuals.length / wallets.length * 100).toFixed(1)}%)`);

    // Bot volume vs manual volume
    const botBuyVol = bots.reduce((s, w) => s + w.totalBuyVolume, 0);
    const manualBuyVol = manuals.reduce((s, w) => s + w.totalBuyVolume, 0);

    console.log(`\n  Bot buy volume: ${botBuyVol.toFixed(2)} SOL (${(botBuyVol / totalBuyVolume * 100).toFixed(1)}%)`);
    console.log(`  Manual buy volume: ${manualBuyVol.toFixed(2)} SOL (${(manualBuyVol / totalBuyVolume * 100).toFixed(1)}%)`);

    // =========================================================================
    // TOP WALLETS BY TX COUNT
    // =========================================================================

    console.log("\n📊 MOST ACTIVE WALLETS (by tx count)");
    console.log("-".repeat(50));

    const byTxCount = [...wallets].sort((a, b) => b.txCount - a.txCount).slice(0, 15);

    console.log("  Wallet                                       Txs    Buy Vol   Sell Vol   Net       Bot?");
    console.log("  " + "-".repeat(95));

    for (const w of byTxCount) {
        const botFlag = w.isLikelyBot ? "🤖" : "👤";
        console.log(
            `  ${w.wallet.slice(0, 44)} ` +
            `${w.txCount.toString().padStart(4)} ` +
            `${w.totalBuyVolume.toFixed(2).padStart(9)} ` +
            `${w.totalSellVolume.toFixed(2).padStart(9)} ` +
            `${(w.netFlow >= 0 ? "+" : "") + w.netFlow.toFixed(2).padStart(8)} ` +
            `${botFlag}`
        );
    }

    // =========================================================================
    // TOP WALLETS BY VOLUME
    // =========================================================================

    console.log("\n📊 BIGGEST BUYERS (by SOL volume)");
    console.log("-".repeat(50));

    const byBuyVol = [...wallets].sort((a, b) => b.totalBuyVolume - a.totalBuyVolume).slice(0, 15);

    console.log("  Wallet                                       Buy Vol   Txs   Tokens  Avg Size  Bot?");
    console.log("  " + "-".repeat(90));

    for (const w of byBuyVol) {
        const botFlag = w.isLikelyBot ? "🤖" : "👤";
        console.log(
            `  ${w.wallet.slice(0, 44)} ` +
            `${w.totalBuyVolume.toFixed(2).padStart(8)} ` +
            `${w.txCount.toString().padStart(4)} ` +
            `${w.uniqueTokens.size.toString().padStart(6)} ` +
            `${w.avgTxSize.toFixed(3).padStart(9)} ` +
            `${botFlag}`
        );
    }

    // =========================================================================
    // NET WINNERS (if we have sells)
    // =========================================================================

    if (sells.length > 0) {
        console.log("\n📊 NET WINNERS (sold more than bought)");
        console.log("-".repeat(50));

        const winners = [...wallets]
            .filter(w => w.netFlow > 0 && w.sellCount > 0)
            .sort((a, b) => b.netFlow - a.netFlow)
            .slice(0, 15);

        if (winners.length > 0) {
            console.log("  Wallet                                       Net Gain  Buys  Sells  Bot?");
            console.log("  " + "-".repeat(75));

            for (const w of winners) {
                const botFlag = w.isLikelyBot ? "🤖" : "👤";
                console.log(
                    `  ${w.wallet.slice(0, 44)} ` +
                    `+${w.netFlow.toFixed(2).padStart(8)} ` +
                    `${w.buyCount.toString().padStart(5)} ` +
                    `${w.sellCount.toString().padStart(5)} ` +
                    `${botFlag}`
                );
            }
        } else {
            console.log("  No net winners found in this dataset");
        }

        console.log("\n📊 NET LOSERS (bought more than sold)");
        console.log("-".repeat(50));

        const losers = [...wallets]
            .filter(w => w.netFlow < 0 && w.buyCount > 0)
            .sort((a, b) => a.netFlow - b.netFlow)
            .slice(0, 15);

        if (losers.length > 0) {
            console.log("  Wallet                                       Net Loss  Buys  Sells  Bot?");
            console.log("  " + "-".repeat(75));

            for (const w of losers) {
                const botFlag = w.isLikelyBot ? "🤖" : "👤";
                console.log(
                    `  ${w.wallet.slice(0, 44)} ` +
                    `${w.netFlow.toFixed(2).padStart(9)} ` +
                    `${w.buyCount.toString().padStart(5)} ` +
                    `${w.sellCount.toString().padStart(5)} ` +
                    `${botFlag}`
                );
            }
        }
    }

    // =========================================================================
    // TOKEN ANALYSIS
    // =========================================================================

    console.log("\n📊 TOKEN ANALYSIS");
    console.log("-".repeat(50));

    const tokenMap = new Map<string, TokenStats>();

    for (const tx of txs) {
        if (!tx.tokenMint) continue;

        let stats = tokenMap.get(tx.tokenMint);
        if (!stats) {
            stats = {
                mint: tx.tokenMint,
                txCount: 0,
                buyCount: 0,
                sellCount: 0,
                totalBuyVolume: 0,
                totalSellVolume: 0,
                netFlow: 0,
                uniqueBuyers: new Set(),
                uniqueSellers: new Set(),
                firstTx: tx.slot,
                lastTx: tx.slot,
            };
            tokenMap.set(tx.tokenMint, stats);
        }

        stats.txCount++;
        if (tx.type === "buy") {
            stats.buyCount++;
            stats.totalBuyVolume += tx.solAmount;
            stats.uniqueBuyers.add(tx.wallet);
        } else if (tx.type === "sell") {
            stats.sellCount++;
            stats.totalSellVolume += tx.solAmount;
            stats.uniqueSellers.add(tx.wallet);
        }

        stats.firstTx = Math.min(stats.firstTx, tx.slot);
        stats.lastTx = Math.max(stats.lastTx, tx.slot);
    }

    for (const stats of tokenMap.values()) {
        stats.netFlow = stats.totalSellVolume - stats.totalBuyVolume;
    }

    const tokens = Array.from(tokenMap.values());

    console.log(`  Unique tokens: ${tokens.length}`);

    // Tokens by activity
    const hotTokens = [...tokens].sort((a, b) => b.txCount - a.txCount).slice(0, 10);

    console.log("\n  Hottest tokens (by tx count):");
    console.log("  Mint                                         Txs   Buy Vol  Buyers");
    console.log("  " + "-".repeat(65));

    for (const t of hotTokens) {
        console.log(
            `  ${t.mint.slice(0, 44)} ` +
            `${t.txCount.toString().padStart(4)} ` +
            `${t.totalBuyVolume.toFixed(2).padStart(8)} ` +
            `${t.uniqueBuyers.size.toString().padStart(6)}`
        );
    }

    // Tokens by volume
    const bigTokens = [...tokens].sort((a, b) => b.totalBuyVolume - a.totalBuyVolume).slice(0, 10);

    console.log("\n  Biggest tokens (by buy volume):");
    console.log("  Mint                                         Buy Vol   Txs  Buyers");
    console.log("  " + "-".repeat(65));

    for (const t of bigTokens) {
        console.log(
            `  ${t.mint.slice(0, 44)} ` +
            `${t.totalBuyVolume.toFixed(2).padStart(8)} ` +
            `${t.txCount.toString().padStart(4)} ` +
            `${t.uniqueBuyers.size.toString().padStart(6)}`
        );
    }

    // =========================================================================
    // TRANSACTION SIZE DISTRIBUTION
    // =========================================================================

    console.log("\n📊 BUY SIZE DISTRIBUTION");
    console.log("-".repeat(50));

    const buySizes = buys.map(t => t.solAmount).filter(s => s > 0).sort((a, b) => a - b);

    const sizeBuckets = [
        { min: 0, max: 0.05, label: "< 0.05 SOL (dust)" },
        { min: 0.05, max: 0.1, label: "0.05-0.1 SOL" },
        { min: 0.1, max: 0.3, label: "0.1-0.3 SOL" },
        { min: 0.3, max: 0.5, label: "0.3-0.5 SOL" },
        { min: 0.5, max: 1.0, label: "0.5-1.0 SOL" },
        { min: 1.0, max: 2.0, label: "1.0-2.0 SOL" },
        { min: 2.0, max: 5.0, label: "2.0-5.0 SOL" },
        { min: 5.0, max: 10.0, label: "5.0-10.0 SOL" },
        { min: 10.0, max: Infinity, label: "> 10.0 SOL (whale)" },
    ];

    for (const bucket of sizeBuckets) {
        const inBucket = buySizes.filter(s => s >= bucket.min && s < bucket.max);
        const count = inBucket.length;
        const vol = inBucket.reduce((a, b) => a + b, 0);
        const pct = (count / buySizes.length * 100).toFixed(1);
        const volPct = (vol / totalBuyVolume * 100).toFixed(1);

        console.log(
            `  ${bucket.label.padEnd(22)} ` +
            `${count.toString().padStart(5)} txs (${pct.padStart(5)}%) | ` +
            `${vol.toFixed(1).padStart(7)} SOL (${volPct.padStart(5)}%)`
        );
    }

    // =========================================================================
    // TIMING ANALYSIS
    // =========================================================================

    console.log("\n📊 TIMING PATTERNS");
    console.log("-".repeat(50));

    // Transactions per slot bucket
    const slotCounts = new Map<number, number>();
    for (const tx of txs) {
        const bucket = Math.floor(tx.slot / 100) * 100; // Group by 100 slots (~40s)
        slotCounts.set(bucket, (slotCounts.get(bucket) || 0) + 1);
    }

    const countsArray = Array.from(slotCounts.values()).sort((a, b) => a - b);
    const avgPerBucket = countsArray.reduce((a, b) => a + b, 0) / countsArray.length;
    const maxBucket = countsArray[countsArray.length - 1] || 0;
    const minBucket = countsArray[0] || 0;

    console.log(`  Avg txs per ~40s window: ${avgPerBucket.toFixed(1)}`);
    console.log(`  Peak activity: ${maxBucket} txs in one window`);
    console.log(`  Lowest activity: ${minBucket} txs`);

    // =========================================================================
    // SUMMARY
    // =========================================================================

    console.log("\n" + "=".repeat(70));
    console.log("📋 SUMMARY");
    console.log("=".repeat(70));

    console.log(`
MARKET SNAPSHOT (${minutesObserved.toFixed(0)} minutes observed):
  - Total transactions: ${txs.length}
  - Buy volume: ${totalBuyVolume.toFixed(2)} SOL (${(totalBuyVolume / minutesObserved).toFixed(2)} SOL/min)
  - Sell volume: ${totalSellVolume.toFixed(2)} SOL
  - Unique wallets: ${wallets.length}
  - Unique tokens: ${tokens.length}

PARTICIPANT BREAKDOWN:
  - Bots: ${bots.length} wallets, ${botBuyVol.toFixed(2)} SOL volume (${(botBuyVol / totalBuyVolume * 100).toFixed(1)}%)
  - Manual: ${manuals.length} wallets, ${manualBuyVol.toFixed(2)} SOL volume (${(manualBuyVol / totalBuyVolume * 100).toFixed(1)}%)

EXTRAPOLATED DAILY VOLUME:
  - Buy volume: ${(totalBuyVolume / minutesObserved * 60 * 24).toFixed(0)} SOL/day
  - At $200/SOL: $${((totalBuyVolume / minutesObserved * 60 * 24) * 200 / 1000000).toFixed(2)}M/day
`);

    if (sells.length === 0) {
        console.log(`
⚠️  LIMITATION: Only buys were captured.
    For complete P&L analysis, re-run collection without the buy filter.
    Run: npx tsx rawCollectorFull.ts collect 30
`);
    }

    // Save detailed analysis
    const output = {
        timestamp: Date.now(),
        observationMinutes: minutesObserved,
        transactions: {
            total: txs.length,
            buys: buys.length,
            sells: sells.length,
        },
        volume: {
            totalBuy: totalBuyVolume,
            totalSell: totalSellVolume,
            netFlow,
            buyRatePerMin: totalBuyVolume / minutesObserved,
        },
        wallets: {
            total: wallets.length,
            bots: bots.length,
            manuals: manuals.length,
            botVolumeShare: botBuyVol / totalBuyVolume,
        },
        tokens: {
            total: tokens.length,
        },
        topBuyers: byBuyVol.slice(0, 20).map(w => ({
            wallet: w.wallet,
            buyVolume: w.totalBuyVolume,
            txCount: w.txCount,
            isBot: w.isLikelyBot,
        })),
    };

    fs.writeFileSync(`${dataDir}/market_analysis.json`, JSON.stringify(output, null, 2));
    console.log(`Detailed analysis saved to: ${dataDir}/market_analysis.json`);
}

// =============================================================================
// MAIN
// =============================================================================

analyze().catch(console.error);