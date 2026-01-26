/**
 * WALLET DEEP DIVE
 * 
 * Analyze all transactions from a specific wallet in raw capture data.
 * Shows patterns, timing, routes, profitability per token, etc.
 * 
 * Run: npx tsx src/scripts/wallet_deep_dive.ts <wallet_address> [jsonl_file]
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
// TYPES
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

interface WalletTx extends RawTx {
    profitLamports: number;
}

// ============================================================================
// ANALYSIS
// ============================================================================

function lamToSol(l: number): number {
    return l / LAMPORTS_PER_SOL;
}

async function loadWalletTxs(filePath: string, wallet: string): Promise<WalletTx[]> {
    const txs: WalletTx[] = [];
    const walletLower = wallet.toLowerCase();

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
    });

    let lineCount = 0;
    for await (const line of rl) {
        if (!line.trim()) continue;
        lineCount++;

        if (lineCount % 50000 === 0) {
            process.stdout.write(`\r   Scanning ${lineCount.toLocaleString()} lines...`);
        }

        try {
            const tx: RawTx = JSON.parse(line);
            if (tx.signer?.toLowerCase() === walletLower) {
                txs.push({
                    ...tx,
                    profitLamports: tx.signerSolDelta ?? 0,
                });
            }
        } catch {
            // Skip parse errors
        }
    }

    console.log(`\r   Scanned ${lineCount.toLocaleString()} lines, found ${txs.length} txs for wallet`);
    return txs.sort((a, b) => a.slot - b.slot);
}

function analyzeWallet(txs: WalletTx[]): void {
    if (txs.length === 0) {
        console.log("\n   No transactions found for this wallet.");
        return;
    }

    // Basic stats
    const totalProfit = txs.reduce((s, t) => s + t.profitLamports, 0);
    const wins = txs.filter(t => t.profitLamports > 0);
    const losses = txs.filter(t => t.profitLamports < 0);
    const jitoTxs = txs.filter(t => t.isJito);
    const multiVenueTxs = txs.filter(t => t.isMultiVenue);

    console.log("\n" + "=".repeat(80));
    console.log("📊 WALLET SUMMARY");
    console.log("=".repeat(80));

    console.log(`\n   Total transactions:  ${txs.length.toLocaleString()}`);
    console.log(`   Wins:                ${wins.length.toLocaleString()} (${((wins.length / txs.length) * 100).toFixed(1)}%)`);
    console.log(`   Losses:              ${losses.length.toLocaleString()}`);
    console.log(`   Net profit:          ${lamToSol(totalProfit).toFixed(6)} SOL`);
    console.log(`   Avg profit/tx:       ${lamToSol(totalProfit / txs.length).toFixed(6)} SOL`);

    if (wins.length > 0) {
        const avgWin = wins.reduce((s, t) => s + t.profitLamports, 0) / wins.length;
        const biggestWin = Math.max(...wins.map(t => t.profitLamports));
        console.log(`   Avg win:             ${lamToSol(avgWin).toFixed(6)} SOL`);
        console.log(`   Biggest win:         ${lamToSol(biggestWin).toFixed(6)} SOL`);
    }

    if (losses.length > 0) {
        const avgLoss = losses.reduce((s, t) => s + t.profitLamports, 0) / losses.length;
        const biggestLoss = Math.min(...losses.map(t => t.profitLamports));
        console.log(`   Avg loss:            ${lamToSol(avgLoss).toFixed(6)} SOL`);
        console.log(`   Biggest loss:        ${lamToSol(biggestLoss).toFixed(6)} SOL`);
    }

    console.log(`\n   Jito bundles:        ${jitoTxs.length.toLocaleString()} (${((jitoTxs.length / txs.length) * 100).toFixed(1)}%)`);
    console.log(`   Multi-venue txs:     ${multiVenueTxs.length.toLocaleString()} (${((multiVenueTxs.length / txs.length) * 100).toFixed(1)}%)`);

    if (jitoTxs.length > 0) {
        const totalTips = jitoTxs.reduce((s, t) => s + (t.jitoTip ?? 0), 0);
        console.log(`   Total Jito tips:     ${lamToSol(totalTips).toFixed(6)} SOL`);
    }

    // CU analysis
    const txsWithCU = txs.filter(t => t.cu !== null && t.cu > 0);
    if (txsWithCU.length > 0) {
        const avgCU = txsWithCU.reduce((s, t) => s + (t.cu ?? 0), 0) / txsWithCU.length;
        const maxCU = Math.max(...txsWithCU.map(t => t.cu ?? 0));
        const minCU = Math.min(...txsWithCU.map(t => t.cu ?? 0));
        console.log(`\n   Avg CU:              ${Math.round(avgCU).toLocaleString()}`);
        console.log(`   CU range:            ${minCU.toLocaleString()} - ${maxCU.toLocaleString()}`);
    }

    // Venue breakdown
    console.log("\n" + "=".repeat(80));
    console.log("🏦 VENUE USAGE");
    console.log("=".repeat(80));

    const venueStats = new Map<string, { count: number; profit: number }>();
    for (const tx of txs) {
        for (const v of tx.venues) {
            const s = venueStats.get(v) ?? { count: 0, profit: 0 };
            s.count++;
            s.profit += tx.profitLamports / tx.venues.length; // Split profit across venues
            venueStats.set(v, s);
        }
    }

    console.log("\n   " + "-".repeat(60));
    console.log(`   ${"Venue".padEnd(25)} ${"TXs".padStart(8)} ${"Profit".padStart(14)} ${"Avg".padStart(12)}`);
    console.log("   " + "-".repeat(60));

    for (const [v, s] of Array.from(venueStats.entries()).sort((a, b) => b[1].count - a[1].count)) {
        console.log(
            `   ${v.padEnd(25)} ${s.count.toLocaleString().padStart(8)} ` +
            `${lamToSol(s.profit).toFixed(6).padStart(14)} ${lamToSol(s.profit / s.count).toFixed(6).padStart(12)}`
        );
    }

    // Venue combos for multi-venue
    if (multiVenueTxs.length > 0) {
        console.log("\n   Multi-venue combinations:");
        const combos = new Map<string, { count: number; profit: number }>();
        for (const tx of multiVenueTxs) {
            const combo = tx.venues.sort().join("+");
            const s = combos.get(combo) ?? { count: 0, profit: 0 };
            s.count++;
            s.profit += tx.profitLamports;
            combos.set(combo, s);
        }

        console.log("   " + "-".repeat(70));
        console.log(`   ${"Combo".padEnd(40)} ${"TXs".padStart(8)} ${"Profit".padStart(14)}`);
        console.log("   " + "-".repeat(70));

        for (const [combo, s] of Array.from(combos.entries()).sort((a, b) => b[1].count - a[1].count)) {
            console.log(
                `   ${combo.padEnd(40)} ${s.count.toLocaleString().padStart(8)} ${lamToSol(s.profit).toFixed(6).padStart(14)}`
            );
        }
    }

    // Token breakdown
    console.log("\n" + "=".repeat(80));
    console.log("🪙 TOP TOKENS TRADED");
    console.log("=".repeat(80));

    const tokenStats = new Map<string, { count: number; profit: number; wins: number }>();
    for (const tx of txs) {
        for (const mint of tx.mints) {
            const s = tokenStats.get(mint) ?? { count: 0, profit: 0, wins: 0 };
            s.count++;
            s.profit += tx.profitLamports / Math.max(tx.mints.length, 1);
            if (tx.profitLamports > 0) s.wins++;
            tokenStats.set(mint, s);
        }
    }

    const sortedTokens = Array.from(tokenStats.entries())
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 30);

    console.log("\n   By transaction count:");
    console.log("   " + "-".repeat(90));
    console.log(`   ${"Mint".padEnd(44)} ${"TXs".padStart(8)} ${"Profit".padStart(14)} ${"WinRate".padStart(10)}`);
    console.log("   " + "-".repeat(90));

    for (const [mint, s] of sortedTokens) {
        const winRate = ((s.wins / s.count) * 100).toFixed(0);
        console.log(
            `   ${mint.padEnd(44)} ${s.count.toLocaleString().padStart(8)} ` +
            `${lamToSol(s.profit).toFixed(6).padStart(14)} ${(winRate + "%").padStart(10)}`
        );
    }

    // Most profitable tokens
    const profitableTokens = Array.from(tokenStats.entries())
        .filter(([, s]) => s.profit > 0)
        .sort((a, b) => b[1].profit - a[1].profit)
        .slice(0, 20);

    if (profitableTokens.length > 0) {
        console.log("\n   Most profitable tokens:");
        console.log("   " + "-".repeat(90));

        for (const [mint, s] of profitableTokens) {
            const winRate = ((s.wins / s.count) * 100).toFixed(0);
            console.log(
                `   ${mint.padEnd(44)} ${s.count.toLocaleString().padStart(8)} ` +
                `${lamToSol(s.profit).toFixed(6).padStart(14)} ${(winRate + "%").padStart(10)}`
            );
        }
    }

    // Timing analysis
    console.log("\n" + "=".repeat(80));
    console.log("⏱️ TIMING ANALYSIS");
    console.log("=".repeat(80));

    const firstTx = txs[0];
    const lastTx = txs[txs.length - 1];

    if (firstTx && lastTx) {
        const slotSpan = lastTx.slot - firstTx.slot;
        const slotsPerTx = slotSpan / txs.length;
        console.log(`\n   Slot range:          ${firstTx.slot.toLocaleString()} - ${lastTx.slot.toLocaleString()}`);
        console.log(`   Slot span:           ${slotSpan.toLocaleString()} slots`);
        console.log(`   Avg slots between:   ${slotsPerTx.toFixed(1)} slots/tx`);

        // Find bursts (multiple txs in same slot or adjacent)
        let burstCount = 0;
        let maxBurst = 0;
        let currentBurst = 1;
        let prevSlot = firstTx.slot;

        for (let i = 1; i < txs.length; i++) {
            const tx = txs[i];
            if (!tx) continue;
            if (tx.slot - prevSlot <= 1) {
                currentBurst++;
            } else {
                if (currentBurst > 1) burstCount++;
                if (currentBurst > maxBurst) maxBurst = currentBurst;
                currentBurst = 1;
            }
            prevSlot = tx.slot;
        }
        if (currentBurst > 1) burstCount++;
        if (currentBurst > maxBurst) maxBurst = currentBurst;

        console.log(`   Burst sequences:     ${burstCount} (txs within 1 slot of each other)`);
        console.log(`   Max burst size:      ${maxBurst} txs`);
    }

    // Top 20 most profitable transactions
    console.log("\n" + "=".repeat(80));
    console.log("💰 TOP 20 MOST PROFITABLE TRANSACTIONS");
    console.log("=".repeat(80));

    const topProfitable = [...txs].sort((a, b) => b.profitLamports - a.profitLamports).slice(0, 20);

    console.log("\n   " + "-".repeat(110));
    console.log(
        `   ${"Signature".padEnd(44)} ${"Profit".padStart(12)} ${"Venues".padEnd(25)} ` +
        `${"Jito".padStart(5)} ${"CU".padStart(10)}`
    );
    console.log("   " + "-".repeat(110));

    for (const tx of topProfitable) {
        console.log(
            `   ${tx.sig.padEnd(44)} ${lamToSol(tx.profitLamports).toFixed(6).padStart(12)} ` +
            `${tx.venues.join("+").padEnd(25)} ${(tx.isJito ? "YES" : "NO").padStart(5)} ` +
            `${(tx.cu?.toLocaleString() ?? "?").padStart(10)}`
        );
    }

    // Recent activity
    console.log("\n" + "=".repeat(80));
    console.log("🕐 LAST 20 TRANSACTIONS");
    console.log("=".repeat(80));

    const recent = txs.slice(-20);

    console.log("\n   " + "-".repeat(110));
    console.log(
        `   ${"Signature".padEnd(44)} ${"Slot".padStart(12)} ${"Profit".padStart(12)} ` +
        `${"Venues".padEnd(20)} ${"Tokens".padStart(3)}`
    );
    console.log("   " + "-".repeat(110));

    for (const tx of recent) {
        console.log(
            `   ${tx.sig.padEnd(44)} ${tx.slot.toLocaleString().padStart(12)} ` +
            `${lamToSol(tx.profitLamports).toFixed(6).padStart(12)} ` +
            `${tx.venues.join("+").padEnd(20)} ${tx.mints.length.toString().padStart(3)}`
        );
    }
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
    const wallet = process.argv[2];
    let inputPath = process.argv[3];

    if (!wallet) {
        console.error("Usage: npx tsx wallet_deep_dive.ts <wallet_address> [jsonl_file]");
        process.exit(1);
    }

    if (!inputPath) {
        const files = fs.readdirSync(DATA_DIR)
            .filter(f => f.startsWith("raw_dex_txs_") && f.endsWith(".jsonl"))
            .sort()
            .reverse();

        if (files.length === 0) {
            console.error("No raw_dex_txs_*.jsonl files found.");
            process.exit(1);
        }

        const mostRecent = files[0]!;
        inputPath = path.join(DATA_DIR, mostRecent);
    }

    console.log("\n" + "=".repeat(80));
    console.log("🔍 WALLET DEEP DIVE");
    console.log("=".repeat(80));
    console.log(`\n   Wallet: ${wallet}`);
    console.log(`   File:   ${inputPath}\n`);

    const txs = await loadWalletTxs(inputPath, wallet);
    analyzeWallet(txs);

    console.log("\n" + "=".repeat(80));
}

main().catch(console.error);