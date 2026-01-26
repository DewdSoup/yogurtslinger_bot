/**
 * ANALYZE RAW DEX CAPTURE
 * 
 * Processes raw_dex_txs_*.jsonl to find:
 * 1. FRACTURED TOKENS - mints that appear on 2+ venues
 * 2. WINNING WALLETS - signers with consistent +SOL
 * 3. ARB PATTERNS - multi-venue txs, timing, routes
 * 
 * Run: npx tsx src/scripts/analyze_raw_capture.ts [path_to_jsonl]
 * 
 * If no path given, uses most recent file in data/
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");

const LAMPORTS_PER_SOL = 1_000_000_000;

// ============================================================================
// TYPES (matching capture script)
// ============================================================================

interface SolDelta {
    pubkey: string;
    delta: number;
}

interface TokenFlow {
    mint: string;
    owner: string;
    delta: number;
}

interface RawTx {
    sig: string;
    slot: number;
    blockTime: number | null;
    ts: string;
    venues: string[];
    mints: string[];
    signer: string | null;
    signerSolDelta: number | null;
    solDeltas: SolDelta[];
    tokenFlows: TokenFlow[];
    success: boolean;
    cu: number | null;
    fee: number | null;
    isJito: boolean;
    jitoTip: number | null;
    isMultiVenue: boolean;
}

// ============================================================================
// AGGREGATION STRUCTURES
// ============================================================================

interface TokenStats {
    mint: string;
    txCount: number;
    venues: Set<string>;
    totalVolumeLamports: number;
    uniqueSigners: Set<string>;
    firstSlot: number;
    lastSlot: number;
    // NEW: Track losses/gains per venue
    venueStats: Map<string, { txCount: number; lossLamports: number; gainLamports: number }>;
}

interface WalletStats {
    wallet: string;
    txCount: number;
    totalSolDelta: number; // lamports (can be negative)
    winCount: number; // txs where signer gained SOL
    lossCount: number;
    venues: Map<string, number>;
    jitoCount: number;
    multiVenueCount: number;
    avgCU: number;
    cuSum: number;
    mints: Set<string>;
    // For arb analysis
    biggestWin: number;
    biggestLoss: number;
    slots: number[];
}

interface MultiVenueTx {
    sig: string;
    slot: number;
    venues: string[];
    signer: string | null;
    signerSolDelta: number | null;
    mints: string[];
    isJito: boolean;
    cu: number | null;
}

// ============================================================================
// ANALYSIS STATE
// ============================================================================

class Analyzer {
    // Token tracking
    tokenStats = new Map<string, TokenStats>();

    // Wallet tracking
    walletStats = new Map<string, WalletStats>();

    // Multi-venue txs (potential arbs)
    multiVenueTxs: MultiVenueTx[] = [];

    // Global stats
    totalTxs = 0;
    successfulTxs = 0;
    failedTxs = 0;
    jitoTxs = 0;

    // Venue breakdown
    venueCount = new Map<string, number>();

    // Slot range
    minSlot = Infinity;
    maxSlot = 0;

    processTx(tx: RawTx): void {
        this.totalTxs++;

        if (tx.success) {
            this.successfulTxs++;
        } else {
            this.failedTxs++;
            return; // Skip failed txs for stats
        }

        // Slot tracking
        if (tx.slot < this.minSlot) this.minSlot = tx.slot;
        if (tx.slot > this.maxSlot) this.maxSlot = tx.slot;

        // Venue counts
        for (const v of tx.venues) {
            this.venueCount.set(v, (this.venueCount.get(v) ?? 0) + 1);
        }

        if (tx.isJito) this.jitoTxs++;

        // Token stats
        for (const mint of tx.mints) {
            let ts = this.tokenStats.get(mint);
            if (!ts) {
                ts = {
                    mint,
                    txCount: 0,
                    venues: new Set(),
                    totalVolumeLamports: 0,
                    uniqueSigners: new Set(),
                    firstSlot: tx.slot,
                    lastSlot: tx.slot,
                    venueStats: new Map(),
                };
                this.tokenStats.set(mint, ts);
            }
            ts.txCount++;
            for (const v of tx.venues) {
                ts.venues.add(v);

                // Track venue-specific losses/gains for this token
                let vs = ts.venueStats.get(v);
                if (!vs) {
                    vs = { txCount: 0, lossLamports: 0, gainLamports: 0 };
                    ts.venueStats.set(v, vs);
                }
                vs.txCount++;

                // Attribute SOL delta to this venue (split if multi-venue)
                if (tx.signerSolDelta !== null) {
                    const perVenueDelta = tx.signerSolDelta / tx.venues.length;
                    if (perVenueDelta < 0) {
                        vs.lossLamports += Math.abs(perVenueDelta);
                    } else {
                        vs.gainLamports += perVenueDelta;
                    }
                }
            }
            if (tx.signer) ts.uniqueSigners.add(tx.signer);
            if (tx.slot < ts.firstSlot) ts.firstSlot = tx.slot;
            if (tx.slot > ts.lastSlot) ts.lastSlot = tx.slot;

            // Estimate volume from SOL movement
            if (tx.signerSolDelta !== null) {
                ts.totalVolumeLamports += Math.abs(tx.signerSolDelta);
            }
        }

        // Wallet stats
        if (tx.signer) {
            let ws = this.walletStats.get(tx.signer);
            if (!ws) {
                ws = {
                    wallet: tx.signer,
                    txCount: 0,
                    totalSolDelta: 0,
                    winCount: 0,
                    lossCount: 0,
                    venues: new Map(),
                    jitoCount: 0,
                    multiVenueCount: 0,
                    avgCU: 0,
                    cuSum: 0,
                    mints: new Set(),
                    biggestWin: 0,
                    biggestLoss: 0,
                    slots: [],
                };
                this.walletStats.set(tx.signer, ws);
            }

            ws.txCount++;
            ws.slots.push(tx.slot);

            if (tx.signerSolDelta !== null) {
                ws.totalSolDelta += tx.signerSolDelta;
                if (tx.signerSolDelta > 0) {
                    ws.winCount++;
                    if (tx.signerSolDelta > ws.biggestWin) {
                        ws.biggestWin = tx.signerSolDelta;
                    }
                } else if (tx.signerSolDelta < 0) {
                    ws.lossCount++;
                    if (tx.signerSolDelta < ws.biggestLoss) {
                        ws.biggestLoss = tx.signerSolDelta;
                    }
                }
            }

            for (const v of tx.venues) {
                ws.venues.set(v, (ws.venues.get(v) ?? 0) + 1);
            }

            if (tx.isJito) ws.jitoCount++;
            if (tx.isMultiVenue) ws.multiVenueCount++;
            if (tx.cu !== null) ws.cuSum += tx.cu;

            for (const m of tx.mints) ws.mints.add(m);
        }

        // Track multi-venue txs
        if (tx.isMultiVenue) {
            this.multiVenueTxs.push({
                sig: tx.sig,
                slot: tx.slot,
                venues: tx.venues,
                signer: tx.signer,
                signerSolDelta: tx.signerSolDelta,
                mints: tx.mints,
                isJito: tx.isJito,
                cu: tx.cu,
            });
        }
    }

    finalize(): void {
        // Calculate avg CU for wallets
        for (const ws of this.walletStats.values()) {
            if (ws.txCount > 0) {
                ws.avgCU = Math.round(ws.cuSum / ws.txCount);
            }
        }
    }
}

// ============================================================================
// FILE READING
// ============================================================================

async function processJsonl(filePath: string, analyzer: Analyzer): Promise<void> {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
    });

    let lineCount = 0;
    let parseErrors = 0;

    for await (const line of rl) {
        if (!line.trim()) continue;
        lineCount++;

        try {
            const tx: RawTx = JSON.parse(line);
            analyzer.processTx(tx);
        } catch {
            parseErrors++;
        }

        if (lineCount % 10000 === 0) {
            process.stdout.write(`\r   Processed ${lineCount.toLocaleString()} lines...`);
        }
    }

    console.log(`\r   Processed ${lineCount.toLocaleString()} lines (${parseErrors} parse errors)`);
}

// ============================================================================
// REPORTS
// ============================================================================

function lamToSol(l: number): number {
    return l / LAMPORTS_PER_SOL;
}

function printFracturedTokens(analyzer: Analyzer): void {
    console.log("\n" + "=".repeat(80));
    console.log("🔀 FRACTURED TOKENS (appear on 2+ venues)");
    console.log("=".repeat(80));

    const fractured = Array.from(analyzer.tokenStats.values())
        .filter(t => t.venues.size >= 2)
        .sort((a, b) => b.totalVolumeLamports - a.totalVolumeLamports);

    console.log(`\n   Found ${fractured.length} fractured tokens\n`);

    if (fractured.length === 0) {
        console.log("   No fractured tokens found in data.");
        return;
    }

    console.log("   " + "-".repeat(110));
    console.log(`   ${"Mint".padEnd(44)} ${"Venues".padEnd(30)} ${"TXs".padStart(8)} ${"Volume (SOL)".padStart(14)} ${"Signers".padStart(8)}`);
    console.log("   " + "-".repeat(110));

    for (const t of fractured.slice(0, 50)) {
        const venueStr = Array.from(t.venues).join("+");
        console.log(
            `   ${t.mint.padEnd(44)} ${venueStr.padEnd(30)} ${t.txCount.toLocaleString().padStart(8)} ` +
            `${lamToSol(t.totalVolumeLamports).toFixed(4).padStart(14)} ${t.uniqueSigners.size.toLocaleString().padStart(8)}`
        );
    }

    if (fractured.length > 50) {
        console.log(`\n   ... and ${fractured.length - 50} more`);
    }
}

function printWinningWallets(analyzer: Analyzer): void {
    console.log("\n" + "=".repeat(80));
    console.log("💰 TOP WINNING WALLETS (by total SOL profit)");
    console.log("=".repeat(80));

    const winners = Array.from(analyzer.walletStats.values())
        .filter(w => w.totalSolDelta > 0 && w.txCount >= 5) // At least 5 txs, net positive
        .sort((a, b) => b.totalSolDelta - a.totalSolDelta);

    console.log(`\n   Found ${winners.length} net-positive wallets (5+ txs)\n`);

    if (winners.length === 0) {
        console.log("   No winning wallets found.");
        return;
    }

    console.log("   " + "-".repeat(130));
    console.log(
        `   ${"Wallet".padEnd(44)} ${"Profit".padStart(12)} ${"TXs".padStart(6)} ` +
        `${"W/L".padStart(8)} ${"WinRate".padStart(8)} ${"Jito".padStart(5)} ${"Multi".padStart(6)} ${"AvgCU".padStart(8)} ${"Venues".padEnd(20)}`
    );
    console.log("   " + "-".repeat(130));

    for (const w of winners.slice(0, 30)) {
        const winRate = ((w.winCount / w.txCount) * 100).toFixed(0);
        const venueStr = Array.from(w.venues.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([v]) => v.replace("RAYDIUM_", "RAY_"))
            .slice(0, 3)
            .join("+");

        console.log(
            `   ${w.wallet.padEnd(44)} ${lamToSol(w.totalSolDelta).toFixed(4).padStart(12)} ` +
            `${w.txCount.toLocaleString().padStart(6)} ${(w.winCount + "/" + w.lossCount).padStart(8)} ` +
            `${(winRate + "%").padStart(8)} ${w.jitoCount.toString().padStart(5)} ` +
            `${w.multiVenueCount.toString().padStart(6)} ${w.avgCU.toLocaleString().padStart(8)} ${venueStr.padEnd(20)}`
        );
    }
}

function printMostFrequentWinners(analyzer: Analyzer): void {
    console.log("\n" + "=".repeat(80));
    console.log("🏆 MOST FREQUENT WINNERS (by win count)");
    console.log("=".repeat(80));

    const frequent = Array.from(analyzer.walletStats.values())
        .filter(w => w.winCount >= 10) // At least 10 wins
        .sort((a, b) => b.winCount - a.winCount);

    console.log(`\n   Found ${frequent.length} wallets with 10+ wins\n`);

    if (frequent.length === 0) {
        console.log("   No frequent winners found.");
        return;
    }

    console.log("   " + "-".repeat(130));
    console.log(
        `   ${"Wallet".padEnd(44)} ${"Wins".padStart(6)} ${"Total".padStart(6)} ` +
        `${"WinRate".padStart(8)} ${"NetSOL".padStart(12)} ${"BiggestW".padStart(12)} ${"Jito%".padStart(6)} ${"Multi%".padStart(6)}`
    );
    console.log("   " + "-".repeat(130));

    for (const w of frequent.slice(0, 30)) {
        const winRate = ((w.winCount / w.txCount) * 100).toFixed(0);
        const jitoRate = ((w.jitoCount / w.txCount) * 100).toFixed(0);
        const multiRate = ((w.multiVenueCount / w.txCount) * 100).toFixed(0);

        console.log(
            `   ${w.wallet.padEnd(44)} ${w.winCount.toString().padStart(6)} ` +
            `${w.txCount.toString().padStart(6)} ${(winRate + "%").padStart(8)} ` +
            `${lamToSol(w.totalSolDelta).toFixed(4).padStart(12)} ` +
            `${lamToSol(w.biggestWin).toFixed(4).padStart(12)} ` +
            `${(jitoRate + "%").padStart(6)} ${(multiRate + "%").padStart(6)}`
        );
    }
}

function printMultiVenueAnalysis(analyzer: Analyzer): void {
    console.log("\n" + "=".repeat(80));
    console.log("⚡ MULTI-VENUE TRANSACTIONS (potential arbs)");
    console.log("=".repeat(80));

    const multiVenue = analyzer.multiVenueTxs;
    console.log(`\n   Total multi-venue txs: ${multiVenue.length.toLocaleString()}`);

    if (multiVenue.length === 0) {
        console.log("   No multi-venue transactions found.");
        return;
    }

    // Breakdown by venue combo
    const venueCombos = new Map<string, { count: number; totalProfit: number; jitoCount: number }>();

    for (const tx of multiVenue) {
        const combo = tx.venues.sort().join("+");
        let stats = venueCombos.get(combo);
        if (!stats) {
            stats = { count: 0, totalProfit: 0, jitoCount: 0 };
            venueCombos.set(combo, stats);
        }
        stats.count++;
        if (tx.signerSolDelta !== null && tx.signerSolDelta > 0) {
            stats.totalProfit += tx.signerSolDelta;
        }
        if (tx.isJito) stats.jitoCount++;
    }

    console.log("\n   Venue Combinations:");
    console.log("   " + "-".repeat(80));
    console.log(`   ${"Combo".padEnd(50)} ${"Count".padStart(8)} ${"Profit".padStart(12)} ${"Jito%".padStart(8)}`);
    console.log("   " + "-".repeat(80));

    for (const [combo, stats] of Array.from(venueCombos.entries()).sort((a, b) => b[1].count - a[1].count).slice(0, 20)) {
        const jitoRate = ((stats.jitoCount / stats.count) * 100).toFixed(0);
        console.log(
            `   ${combo.padEnd(50)} ${stats.count.toLocaleString().padStart(8)} ` +
            `${lamToSol(stats.totalProfit).toFixed(4).padStart(12)} ${(jitoRate + "%").padStart(8)}`
        );
    }

    // Top profitable multi-venue txs
    const profitable = multiVenue
        .filter(tx => tx.signerSolDelta !== null && tx.signerSolDelta > 0)
        .sort((a, b) => (b.signerSolDelta ?? 0) - (a.signerSolDelta ?? 0));

    console.log(`\n   Top 20 Most Profitable Multi-Venue TXs:`);
    console.log("   " + "-".repeat(110));
    console.log(`   ${"Signature".padEnd(44)} ${"Profit".padStart(12)} ${"Venues".padEnd(30)} ${"Jito".padStart(5)} ${"CU".padStart(10)}`);
    console.log("   " + "-".repeat(110));

    for (const tx of profitable.slice(0, 20)) {
        console.log(
            `   ${tx.sig.padEnd(44)} ${lamToSol(tx.signerSolDelta!).toFixed(4).padStart(12)} ` +
            `${tx.venues.join("+").padEnd(30)} ${(tx.isJito ? "YES" : "NO").padStart(5)} ` +
            `${(tx.cu?.toLocaleString() ?? "?").padStart(10)}`
        );
    }
}

function printVenueBreakdown(analyzer: Analyzer): void {
    console.log("\n" + "=".repeat(80));
    console.log("🏦 VENUE BREAKDOWN");
    console.log("=".repeat(80));

    console.log("\n   " + "-".repeat(50));
    console.log(`   ${"Venue".padEnd(25)} ${"TX Count".padStart(12)} ${"% of Total".padStart(12)}`);
    console.log("   " + "-".repeat(50));

    for (const [venue, count] of Array.from(analyzer.venueCount.entries()).sort((a, b) => b[1] - a[1])) {
        const pct = ((count / analyzer.successfulTxs) * 100).toFixed(1);
        console.log(`   ${venue.padEnd(25)} ${count.toLocaleString().padStart(12)} ${(pct + "%").padStart(12)}`);
    }
}

function printFracturedTokenLosses(analyzer: Analyzer): void {
    console.log("\n" + "=".repeat(80));
    console.log("💸 PUMPSWAP LOSSES FOR FRACTURED TOKENS (Cross-Venue Opportunity)");
    console.log("=".repeat(80));

    // Get all fractured tokens (appear on 2+ venues including PumpSwap)
    const fracturedWithPumpSwap = Array.from(analyzer.tokenStats.values())
        .filter(t => t.venues.size >= 2 && t.venues.has("PUMPSWAP"));

    if (fracturedWithPumpSwap.length === 0) {
        console.log("\n   No fractured tokens with PumpSwap presence found.");
        return;
    }

    console.log(`\n   Found ${fracturedWithPumpSwap.length} fractured tokens with PumpSwap + external liquidity\n`);

    // Calculate PumpSwap losses per token
    interface LossReport {
        mint: string;
        venues: string[];
        pumpSwapLoss: number;
        pumpSwapGain: number;
        pumpSwapNet: number;
        pumpSwapTxs: number;
        externalGain: number;
        externalLoss: number;
        externalNet: number;
        totalTxs: number;
    }

    const reports: LossReport[] = [];

    for (const t of fracturedWithPumpSwap) {
        const pumpStats = t.venueStats.get("PUMPSWAP");

        let externalGain = 0;
        let externalLoss = 0;

        for (const [venue, stats] of t.venueStats) {
            if (venue !== "PUMPSWAP") {
                externalGain += stats.gainLamports;
                externalLoss += stats.lossLamports;
            }
        }

        reports.push({
            mint: t.mint,
            venues: Array.from(t.venues),
            pumpSwapLoss: pumpStats?.lossLamports ?? 0,
            pumpSwapGain: pumpStats?.gainLamports ?? 0,
            pumpSwapNet: (pumpStats?.gainLamports ?? 0) - (pumpStats?.lossLamports ?? 0),
            pumpSwapTxs: pumpStats?.txCount ?? 0,
            externalGain,
            externalLoss,
            externalNet: externalGain - externalLoss,
            totalTxs: t.txCount,
        });
    }

    // Sort by PumpSwap losses (highest first)
    reports.sort((a, b) => b.pumpSwapLoss - a.pumpSwapLoss);

    // Summary totals
    const totalPumpSwapLoss = reports.reduce((s, r) => s + r.pumpSwapLoss, 0);
    const totalPumpSwapGain = reports.reduce((s, r) => s + r.pumpSwapGain, 0);
    const totalExternalGain = reports.reduce((s, r) => s + r.externalGain, 0);
    const totalExternalLoss = reports.reduce((s, r) => s + r.externalLoss, 0);

    console.log("   ═══════════════════════════════════════════════════════════════════════════");
    console.log("   AGGREGATE SUMMARY");
    console.log("   ═══════════════════════════════════════════════════════════════════════════");
    console.log(`   PumpSwap total LOSS:     ${lamToSol(totalPumpSwapLoss).toFixed(4)} SOL  (traders paid SOL)`);
    console.log(`   PumpSwap total GAIN:     ${lamToSol(totalPumpSwapGain).toFixed(4)} SOL  (traders received SOL)`);
    console.log(`   PumpSwap NET:            ${lamToSol(totalPumpSwapGain - totalPumpSwapLoss).toFixed(4)} SOL`);
    console.log("");
    console.log(`   External total GAIN:     ${lamToSol(totalExternalGain).toFixed(4)} SOL`);
    console.log(`   External total LOSS:     ${lamToSol(totalExternalLoss).toFixed(4)} SOL`);
    console.log(`   External NET:            ${lamToSol(totalExternalGain - totalExternalLoss).toFixed(4)} SOL`);
    console.log("");
    console.log(`   🎯 ARBITRAGE OPPORTUNITY: ${lamToSol(totalPumpSwapLoss).toFixed(4)} SOL`);
    console.log(`      (PumpSwap losses that could be captured via external venues)`);

    // Per-token breakdown
    console.log("\n   ═══════════════════════════════════════════════════════════════════════════");
    console.log("   TOP 30 TOKENS BY PUMPSWAP LOSS");
    console.log("   ═══════════════════════════════════════════════════════════════════════════");
    console.log("   " + "-".repeat(115));
    console.log(
        `   ${"Mint".padEnd(44)} ${"PS Loss".padStart(12)} ${"PS Gain".padStart(12)} ` +
        `${"Ext Gain".padStart(12)} ${"PS TXs".padStart(8)} ${"Venues".padEnd(20)}`
    );
    console.log("   " + "-".repeat(115));

    for (const r of reports.slice(0, 30)) {
        const venueStr = r.venues.filter(v => v !== "PUMPSWAP").join("+");
        console.log(
            `   ${r.mint.padEnd(44)} ${lamToSol(r.pumpSwapLoss).toFixed(4).padStart(12)} ` +
            `${lamToSol(r.pumpSwapGain).toFixed(4).padStart(12)} ` +
            `${lamToSol(r.externalGain).toFixed(4).padStart(12)} ` +
            `${r.pumpSwapTxs.toLocaleString().padStart(8)} ${venueStr.padEnd(20)}`
        );
    }

    if (reports.length > 30) {
        console.log(`\n   ... and ${reports.length - 30} more fractured tokens`);
    }
}

function printGlobalStats(analyzer: Analyzer, filePath: string): void {
    console.log("\n" + "=".repeat(80));
    console.log("📊 GLOBAL STATISTICS");
    console.log("=".repeat(80));

    const stats = fs.statSync(filePath);
    const fileSizeMB = (stats.size / 1024 / 1024).toFixed(2);

    console.log(`\n   File: ${path.basename(filePath)}`);
    console.log(`   Size: ${fileSizeMB} MB`);
    console.log(`\n   Total transactions:     ${analyzer.totalTxs.toLocaleString()}`);
    console.log(`   Successful:             ${analyzer.successfulTxs.toLocaleString()}`);
    console.log(`   Failed:                 ${analyzer.failedTxs.toLocaleString()}`);
    console.log(`   Jito bundles:           ${analyzer.jitoTxs.toLocaleString()} (${((analyzer.jitoTxs / analyzer.successfulTxs) * 100).toFixed(1)}%)`);
    console.log(`\n   Unique tokens:          ${analyzer.tokenStats.size.toLocaleString()}`);
    console.log(`   Unique wallets:         ${analyzer.walletStats.size.toLocaleString()}`);
    console.log(`   Slot range:             ${analyzer.minSlot.toLocaleString()} - ${analyzer.maxSlot.toLocaleString()}`);
    console.log(`   Slot span:              ${(analyzer.maxSlot - analyzer.minSlot).toLocaleString()} slots`);
}

function saveDetailedReport(analyzer: Analyzer, inputPath: string): void {
    const outputPath = inputPath.replace(".jsonl", "_analysis.json");

    const report = {
        generated: new Date().toISOString(),
        inputFile: path.basename(inputPath),
        globalStats: {
            totalTxs: analyzer.totalTxs,
            successfulTxs: analyzer.successfulTxs,
            failedTxs: analyzer.failedTxs,
            jitoTxs: analyzer.jitoTxs,
            uniqueTokens: analyzer.tokenStats.size,
            uniqueWallets: analyzer.walletStats.size,
            slotRange: [analyzer.minSlot, analyzer.maxSlot],
        },
        venueBreakdown: Object.fromEntries(analyzer.venueCount),
        // Fractured tokens with venue-specific loss breakdown
        fracturedTokens: Array.from(analyzer.tokenStats.values())
            .filter(t => t.venues.size >= 2)
            .sort((a, b) => b.totalVolumeLamports - a.totalVolumeLamports)
            .slice(0, 200)
            .map(t => {
                const pumpStats = t.venueStats.get("PUMPSWAP");
                return {
                    mint: t.mint,
                    venues: Array.from(t.venues),
                    txCount: t.txCount,
                    volumeSOL: lamToSol(t.totalVolumeLamports),
                    uniqueSigners: t.uniqueSigners.size,
                    pumpSwapLossSOL: lamToSol(pumpStats?.lossLamports ?? 0),
                    pumpSwapGainSOL: lamToSol(pumpStats?.gainLamports ?? 0),
                    pumpSwapTxs: pumpStats?.txCount ?? 0,
                    venueBreakdown: Object.fromEntries(
                        Array.from(t.venueStats.entries()).map(([v, s]) => [
                            v,
                            { txs: s.txCount, lossSOL: lamToSol(s.lossLamports), gainSOL: lamToSol(s.gainLamports) }
                        ])
                    ),
                };
            }),
        // Aggregate PumpSwap losses for fractured tokens
        pumpSwapCrossVenueOpportunity: (() => {
            const fractured = Array.from(analyzer.tokenStats.values())
                .filter(t => t.venues.size >= 2 && t.venues.has("PUMPSWAP"));
            const totalLoss = fractured.reduce((s, t) => s + (t.venueStats.get("PUMPSWAP")?.lossLamports ?? 0), 0);
            const totalGain = fractured.reduce((s, t) => s + (t.venueStats.get("PUMPSWAP")?.gainLamports ?? 0), 0);
            return {
                fracturedTokenCount: fractured.length,
                totalPumpSwapLossSOL: lamToSol(totalLoss),
                totalPumpSwapGainSOL: lamToSol(totalGain),
                netOpportunitySOL: lamToSol(totalLoss),
            };
        })(),
        topWinners: Array.from(analyzer.walletStats.values())
            .filter(w => w.totalSolDelta > 0 && w.txCount >= 5)
            .sort((a, b) => b.totalSolDelta - a.totalSolDelta)
            .slice(0, 100)
            .map(w => ({
                wallet: w.wallet,
                profitSOL: lamToSol(w.totalSolDelta),
                txCount: w.txCount,
                winCount: w.winCount,
                winRate: (w.winCount / w.txCount * 100).toFixed(1) + "%",
                jitoCount: w.jitoCount,
                multiVenueCount: w.multiVenueCount,
                avgCU: w.avgCU,
                venues: Object.fromEntries(w.venues),
                biggestWinSOL: lamToSol(w.biggestWin),
            })),
        frequentWinners: Array.from(analyzer.walletStats.values())
            .filter(w => w.winCount >= 10)
            .sort((a, b) => b.winCount - a.winCount)
            .slice(0, 100)
            .map(w => ({
                wallet: w.wallet,
                winCount: w.winCount,
                txCount: w.txCount,
                winRate: (w.winCount / w.txCount * 100).toFixed(1) + "%",
                profitSOL: lamToSol(w.totalSolDelta),
                jitoRate: (w.jitoCount / w.txCount * 100).toFixed(1) + "%",
                multiVenueRate: (w.multiVenueCount / w.txCount * 100).toFixed(1) + "%",
            })),
        multiVenueStats: {
            total: analyzer.multiVenueTxs.length,
            profitableCount: analyzer.multiVenueTxs.filter(t => (t.signerSolDelta ?? 0) > 0).length,
            totalProfitSOL: lamToSol(
                analyzer.multiVenueTxs
                    .filter(t => (t.signerSolDelta ?? 0) > 0)
                    .reduce((sum, t) => sum + (t.signerSolDelta ?? 0), 0)
            ),
        },
    };

    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    console.log(`\n💾 Saved detailed report: ${outputPath}`);
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
    // Find input file
    let inputPath = process.argv[2];

    if (!inputPath) {
        // Find most recent raw_dex_txs file
        const files = fs.readdirSync(DATA_DIR)
            .filter(f => f.startsWith("raw_dex_txs_") && f.endsWith(".jsonl"))
            .sort()
            .reverse();

        if (files.length === 0) {
            console.error("No raw_dex_txs_*.jsonl files found in data/");
            console.error("Run raw_dex_capture.ts first.");
            process.exit(1);
        }

        const mostRecent = files[0]!;
        inputPath = path.join(DATA_DIR, mostRecent);
        console.log(`Using most recent file: ${mostRecent}`);
    }

    if (!fs.existsSync(inputPath)) {
        console.error(`File not found: ${inputPath}`);
        process.exit(1);
    }

    console.log("\n" + "=".repeat(80));
    console.log("📂 ANALYZING RAW DEX CAPTURE");
    console.log("=".repeat(80));
    console.log(`\n   Input: ${inputPath}\n`);

    const analyzer = new Analyzer();
    await processJsonl(inputPath, analyzer);
    analyzer.finalize();

    // Print reports
    printGlobalStats(analyzer, inputPath);
    printVenueBreakdown(analyzer);
    printFracturedTokens(analyzer);
    printFracturedTokenLosses(analyzer);  // NEW: Show actual PumpSwap losses for cross-venue tokens
    printWinningWallets(analyzer);
    printMostFrequentWinners(analyzer);
    printMultiVenueAnalysis(analyzer);

    // Save JSON report
    saveDetailedReport(analyzer, inputPath);

    console.log("\n" + "=".repeat(80));
    console.log("✅ ANALYSIS COMPLETE");
    console.log("=".repeat(80));
    console.log("\nNext steps:");
    console.log("  1. Review fractured tokens - these have arb potential");
    console.log("  2. Deep dive on top winners - study their patterns");
    console.log("  3. Analyze multi-venue combos - find profitable routes");
    console.log("\nTo deep dive a specific wallet:");
    console.log("  npx tsx src/scripts/wallet_deep_dive.ts <wallet_address>");
}

main().catch(console.error);