/**
 * PHASE 2: Analyze KPI Stream Data (Updated for new schema)
 *
 * Processes helius_kpi_stream.jsonl and produces:
 * - Fractured token deep analysis
 * - Competitor tier breakdown
 * - Opportunity quantification
 * - Wallet performance rankings
 *
 * Input:  src/scripts/data/helius_kpi_stream.jsonl
 * Output: src/scripts/data/analysis_results.json
 *
 * Run: npx tsx src/scripts/02_analyze_kpi_data.ts
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");

const LAMPORTS_TO_SOL = 1_000_000_000;

// ============================================================================
// TYPES (matching new 01 schema)
// ============================================================================

interface ProgramDetection {
    name: string;
    category: string;
    programId: string;
}

interface KpiEvent {
    runId: string;
    ts: string;
    slot: number;
    blockTime: number | null;
    signature: string;

    programsDetected: ProgramDetection[];
    programCategories: string[];

    cuConsumed: number | null;
    cuLimit: number | null;
    cuPrice: number | null;
    feeLamports: number | null;
    feePerCu: number | null;

    isJitoBundle: boolean;
    jitoTipLamports: number | null;
    jitoTipAccount: string | null;

    tokenMintsInvolved: string[];
    pumpMint: string | null;
    isTokenFractured: boolean;

    primarySignerSolDelta: number | null;
    primarySignerPubkey: string | null;
    maxSolGainerPubkey: string | null;
    maxSolGainerLamports: number | null;
    maxSolLoserPubkey: string | null;
    maxSolLoserLamports: number | null;

    txCategory: string;
    isPumpSwapLoss: boolean;
    pumpLossLamports: number | null;

    competitorTier: string;
    competitorSignals: string[];

    opportunityStatus: string;
    detectionLatencyMs: number | null;
}

interface WalletStats {
    wallet: string;
    netLamports: number;
    netSOL: number;
    winEvents: number;
    lossEvents: number;
    totalEvents: number;
    tier1Captures: number;
    tier2Captures: number;
    tier3Captures: number;
    jitoEvents: number;
    aggregatorEvents: number;
    avgFeePerCu: number;
    feePerCuValues: number[];
    avgCuConsumed: number;
    cuValues: number[];
    signatures: string[];
}

interface TokenStats {
    mint: string;
    venues: Set<string>;
    totalTxCount: number;
    totalLossLamports: number;
    totalLossEvents: number;
    tier1Lamports: number;
    tier1Events: number;
    tier2Lamports: number;
    tier2Events: number;
    tier3Lamports: number;
    tier3Events: number;
    poolAbsorbedLamports: number;
    poolAbsorbedEvents: number;
    signatures: string[];
}

interface AnalysisResults {
    meta: {
        inputFile: string;
        totalEvents: number;
        distinctSlots: number;
        timeRange: { start: string; end: string };
        analyzedAt: string;
        runtimeEstimateMinutes: number;
    };

    txCategoryDistribution: Record<string, number>;
    programUsage: Record<string, number>;
    categoryUsage: Record<string, number>;

    opportunityBreakdown: {
        totalPumpLossSOL: number;
        totalCapturableSOL: number;
        tier1UnbeatableSOL: number;
        tier1Events: number;
        tier2DifficultSOL: number;
        tier2Events: number;
        tier3BeatableSOL: number;
        tier3Events: number;
        poolAbsorbedSOL: number;
        poolAbsorbedEvents: number;
        notFracturedSOL: number;
        notFracturedEvents: number;
        beatableOpportunitySOL: number;
        hourlyBeatableSOL: number;
    };

    jitoAnalysis: {
        totalJitoTxs: number;
        totalJitoTipsSOL: number;
        avgTipSOL: number;
        jitoUsageRate: number;
    };

    fracturedTokens: Array<{
        mint: string;
        venues: string[];
        totalTxCount: number;
        totalLossSOL: number;
        tier1SOL: number;
        tier2SOL: number;
        tier3SOL: number;
        poolAbsorbedSOL: number;
        beatableSOL: number;
        beatableShare: number;
    }>;

    walletPnL: {
        totalProfitSOL: number;
        totalLossSOL: number;
        profitableWallets: number;
        losingWallets: number;
        topWinners: Array<{
            wallet: string;
            netSOL: number;
            winEvents: number;
            tier: string;
            jitoRate: number;
        }>;
        topLosers: Array<{
            wallet: string;
            netSOL: number;
            lossEvents: number;
        }>;
    };

    competitiveInsights: {
        tier1CompetitorCount: number;
        tier2CompetitorCount: number;
        tier3CompetitorCount: number;
        avgWinnerFeePerCu: number;
        avgWinnerCuConsumed: number;
        jitoTier1Correlation: number;
    };
}

// ============================================================================
// ANALYSIS ENGINE
// ============================================================================

async function analyzeKpiStream(inputPath: string): Promise<AnalysisResults> {
    console.log(`[ANALYZE] Reading ${inputPath}...`);

    const walletStats = new Map<string, WalletStats>();
    const tokenStats = new Map<string, TokenStats>();
    const txCategoryDistribution: Record<string, number> = {};
    const programUsage: Record<string, number> = {};
    const categoryUsage: Record<string, number> = {};
    const slots = new Set<number>();

    let totalEvents = 0;
    let firstTs = "";
    let lastTs = "";

    let totalPumpLossLamports = 0;
    let totalCapturableLamports = 0;
    let tier1Lamports = 0;
    let tier1Events = 0;
    let tier2Lamports = 0;
    let tier2Events = 0;
    let tier3Lamports = 0;
    let tier3Events = 0;
    let poolAbsorbedLamports = 0;
    let poolAbsorbedEvents = 0;
    let notFracturedLamports = 0;
    let notFracturedEvents = 0;

    let jitoTxCount = 0;
    let totalJitoTips = 0;

    const rl = readline.createInterface({
        input: fs.createReadStream(inputPath),
        crlfDelay: Infinity,
    });

    for await (const line of rl) {
        if (!line.trim()) continue;

        let event: KpiEvent;
        try {
            event = JSON.parse(line);
        } catch {
            continue;
        }

        totalEvents++;
        slots.add(event.slot);

        if (!firstTs || event.ts < firstTs) firstTs = event.ts;
        if (!lastTs || event.ts > lastTs) lastTs = event.ts;

        txCategoryDistribution[event.txCategory] = (txCategoryDistribution[event.txCategory] ?? 0) + 1;

        for (const prog of event.programsDetected) {
            programUsage[prog.name] = (programUsage[prog.name] ?? 0) + 1;
            categoryUsage[prog.category] = (categoryUsage[prog.category] ?? 0) + 1;
        }

        if (event.isJitoBundle) {
            jitoTxCount++;
            if (event.jitoTipLamports) totalJitoTips += event.jitoTipLamports;
        }

        if (event.pumpMint) {
            if (!tokenStats.has(event.pumpMint)) {
                tokenStats.set(event.pumpMint, {
                    mint: event.pumpMint,
                    venues: new Set(),
                    totalTxCount: 0,
                    totalLossLamports: 0,
                    totalLossEvents: 0,
                    tier1Lamports: 0,
                    tier1Events: 0,
                    tier2Lamports: 0,
                    tier2Events: 0,
                    tier3Lamports: 0,
                    tier3Events: 0,
                    poolAbsorbedLamports: 0,
                    poolAbsorbedEvents: 0,
                    signatures: [],
                });
            }
            const ts = tokenStats.get(event.pumpMint)!;
            ts.totalTxCount++;

            for (const prog of event.programsDetected) {
                if (prog.name === "PumpSwap") ts.venues.add("pumpswap");
                if (prog.name.includes("Raydium")) ts.venues.add("raydium");
                if (prog.name.includes("Meteora")) ts.venues.add("meteora");
                if (prog.name.includes("Orca")) ts.venues.add("orca");
            }

            if (ts.signatures.length < 20) ts.signatures.push(event.signature);
        }

        if (event.isPumpSwapLoss && event.pumpLossLamports) {
            totalPumpLossLamports += event.pumpLossLamports;
            if (event.isTokenFractured) totalCapturableLamports += event.pumpLossLamports;

            if (event.pumpMint) {
                const ts = tokenStats.get(event.pumpMint);
                if (ts) {
                    ts.totalLossLamports += event.pumpLossLamports;
                    ts.totalLossEvents++;
                }
            }

            switch (event.opportunityStatus) {
                case "CAPTURED_T1":
                    tier1Lamports += event.pumpLossLamports;
                    tier1Events++;
                    if (event.pumpMint) {
                        const ts = tokenStats.get(event.pumpMint);
                        if (ts) { ts.tier1Lamports += event.pumpLossLamports; ts.tier1Events++; }
                    }
                    break;
                case "CAPTURED_T2":
                    tier2Lamports += event.pumpLossLamports;
                    tier2Events++;
                    if (event.pumpMint) {
                        const ts = tokenStats.get(event.pumpMint);
                        if (ts) { ts.tier2Lamports += event.pumpLossLamports; ts.tier2Events++; }
                    }
                    break;
                case "CAPTURED_T3":
                    tier3Lamports += event.pumpLossLamports;
                    tier3Events++;
                    if (event.pumpMint) {
                        const ts = tokenStats.get(event.pumpMint);
                        if (ts) { ts.tier3Lamports += event.pumpLossLamports; ts.tier3Events++; }
                    }
                    break;
                case "POOL_ABSORBED":
                    poolAbsorbedLamports += event.pumpLossLamports;
                    poolAbsorbedEvents++;
                    if (event.pumpMint) {
                        const ts = tokenStats.get(event.pumpMint);
                        if (ts) { ts.poolAbsorbedLamports += event.pumpLossLamports; ts.poolAbsorbedEvents++; }
                    }
                    break;
                case "NOT_FRACTURED":
                    notFracturedLamports += event.pumpLossLamports;
                    notFracturedEvents++;
                    break;
            }
        }

        const updateWallet = (wallet: string, delta: number, isWin: boolean, ev: KpiEvent) => {
            if (!walletStats.has(wallet)) {
                walletStats.set(wallet, {
                    wallet,
                    netLamports: 0,
                    netSOL: 0,
                    winEvents: 0,
                    lossEvents: 0,
                    totalEvents: 0,
                    tier1Captures: 0,
                    tier2Captures: 0,
                    tier3Captures: 0,
                    jitoEvents: 0,
                    aggregatorEvents: 0,
                    avgFeePerCu: 0,
                    feePerCuValues: [],
                    avgCuConsumed: 0,
                    cuValues: [],
                    signatures: [],
                });
            }
            const ws = walletStats.get(wallet)!;
            ws.netLamports += delta;
            ws.totalEvents++;
            if (isWin) ws.winEvents++;
            else ws.lossEvents++;

            if (isWin && ev.competitorTier === "TIER_1_UNBEATABLE") ws.tier1Captures++;
            if (isWin && ev.competitorTier === "TIER_2_DIFFICULT") ws.tier2Captures++;
            if (isWin && ev.competitorTier === "TIER_3_BEATABLE") ws.tier3Captures++;

            if (ev.isJitoBundle) ws.jitoEvents++;
            if (ev.programCategories.includes("aggregator")) ws.aggregatorEvents++;

            if (ev.feePerCu !== null) ws.feePerCuValues.push(ev.feePerCu);
            if (ev.cuConsumed !== null) ws.cuValues.push(ev.cuConsumed);

            if (ws.signatures.length < 50) ws.signatures.push(ev.signature);
        };

        if (event.maxSolGainerPubkey && event.maxSolGainerLamports) {
            updateWallet(event.maxSolGainerPubkey, event.maxSolGainerLamports, true, event);
        }
        if (event.maxSolLoserPubkey && event.maxSolLoserLamports) {
            updateWallet(event.maxSolLoserPubkey, event.maxSolLoserLamports, false, event);
        }
    }

    console.log(`[ANALYZE] Processed ${totalEvents} events`);

    for (const ws of walletStats.values()) {
        ws.netSOL = ws.netLamports / LAMPORTS_TO_SOL;
        if (ws.feePerCuValues.length > 0) {
            ws.avgFeePerCu = ws.feePerCuValues.reduce((a, b) => a + b, 0) / ws.feePerCuValues.length;
        }
        if (ws.cuValues.length > 0) {
            ws.avgCuConsumed = ws.cuValues.reduce((a, b) => a + b, 0) / ws.cuValues.length;
        }
    }

    const startTime = new Date(firstTs).getTime();
    const endTime = new Date(lastTs).getTime();
    const runtimeMs = endTime - startTime;
    const runtimeMinutes = runtimeMs / 1000 / 60;
    const runtimeSeconds = runtimeMs / 1000;

    const beatableLamports = tier3Lamports + poolAbsorbedLamports;
    const hourlyBeatable = runtimeSeconds > 0 ? (beatableLamports / runtimeSeconds) * 3600 : 0;

    const fracturedTokens: AnalysisResults["fracturedTokens"] = [];
    for (const ts of tokenStats.values()) {
        if (ts.venues.has("pumpswap") && (ts.venues.has("raydium") || ts.venues.has("meteora") || ts.venues.has("orca"))) {
            const beatableSOL = (ts.tier3Lamports + ts.poolAbsorbedLamports) / LAMPORTS_TO_SOL;
            const totalLossSOL = ts.totalLossLamports / LAMPORTS_TO_SOL;
            fracturedTokens.push({
                mint: ts.mint,
                venues: Array.from(ts.venues),
                totalTxCount: ts.totalTxCount,
                totalLossSOL,
                tier1SOL: ts.tier1Lamports / LAMPORTS_TO_SOL,
                tier2SOL: ts.tier2Lamports / LAMPORTS_TO_SOL,
                tier3SOL: ts.tier3Lamports / LAMPORTS_TO_SOL,
                poolAbsorbedSOL: ts.poolAbsorbedLamports / LAMPORTS_TO_SOL,
                beatableSOL,
                beatableShare: totalLossSOL > 0 ? beatableSOL / totalLossSOL : 0,
            });
        }
    }
    fracturedTokens.sort((a, b) => b.beatableSOL - a.beatableSOL);

    const sortedWallets = Array.from(walletStats.values()).sort((a, b) => b.netLamports - a.netLamports);
    const profitableWallets = sortedWallets.filter((w) => w.netLamports > 0);
    const losingWallets = sortedWallets.filter((w) => w.netLamports < 0);

    const totalProfitLamports = profitableWallets.reduce((sum, w) => sum + w.netLamports, 0);
    const totalLossLamportsWallets = losingWallets.reduce((sum, w) => sum + w.netLamports, 0);

    const tier1Competitors = profitableWallets.filter((w) => w.tier1Captures > 0);
    const tier2Competitors = profitableWallets.filter((w) => w.tier2Captures > 0 && w.tier1Captures === 0);
    const tier3Competitors = profitableWallets.filter((w) => w.tier3Captures > 0 && w.tier1Captures === 0 && w.tier2Captures === 0);

    const topWinners = profitableWallets.slice(0, 20).map((w) => {
        let tier = "UNKNOWN";
        if (w.tier1Captures > 0) tier = "TIER_1";
        else if (w.tier2Captures > 0) tier = "TIER_2";
        else if (w.tier3Captures > 0) tier = "TIER_3";
        return {
            wallet: w.wallet,
            netSOL: w.netSOL,
            winEvents: w.winEvents,
            tier,
            jitoRate: w.totalEvents > 0 ? w.jitoEvents / w.totalEvents : 0,
        };
    });

    const topLosers = losingWallets.slice(-20).reverse().map((w) => ({
        wallet: w.wallet,
        netSOL: w.netSOL,
        lossEvents: w.lossEvents,
    }));

    const top10Winners = profitableWallets.slice(0, 10);
    let avgWinnerFeePerCu = 0;
    let avgWinnerCuConsumed = 0;
    if (top10Winners.length > 0) {
        avgWinnerFeePerCu = top10Winners.reduce((sum, w) => sum + w.avgFeePerCu, 0) / top10Winners.length;
        avgWinnerCuConsumed = top10Winners.reduce((sum, w) => sum + w.avgCuConsumed, 0) / top10Winners.length;
    }

    const tier1JitoRate = tier1Competitors.length > 0
        ? tier1Competitors.reduce((sum, w) => sum + (w.jitoEvents / Math.max(w.totalEvents, 1)), 0) / tier1Competitors.length
        : 0;

    const results: AnalysisResults = {
        meta: {
            inputFile: inputPath,
            totalEvents,
            distinctSlots: slots.size,
            timeRange: { start: firstTs, end: lastTs },
            analyzedAt: new Date().toISOString(),
            runtimeEstimateMinutes: runtimeMinutes,
        },
        txCategoryDistribution,
        programUsage,
        categoryUsage,
        opportunityBreakdown: {
            totalPumpLossSOL: totalPumpLossLamports / LAMPORTS_TO_SOL,
            totalCapturableSOL: totalCapturableLamports / LAMPORTS_TO_SOL,
            tier1UnbeatableSOL: tier1Lamports / LAMPORTS_TO_SOL,
            tier1Events,
            tier2DifficultSOL: tier2Lamports / LAMPORTS_TO_SOL,
            tier2Events,
            tier3BeatableSOL: tier3Lamports / LAMPORTS_TO_SOL,
            tier3Events,
            poolAbsorbedSOL: poolAbsorbedLamports / LAMPORTS_TO_SOL,
            poolAbsorbedEvents,
            notFracturedSOL: notFracturedLamports / LAMPORTS_TO_SOL,
            notFracturedEvents,
            beatableOpportunitySOL: beatableLamports / LAMPORTS_TO_SOL,
            hourlyBeatableSOL: hourlyBeatable / LAMPORTS_TO_SOL,
        },
        jitoAnalysis: {
            totalJitoTxs: jitoTxCount,
            totalJitoTipsSOL: totalJitoTips / LAMPORTS_TO_SOL,
            avgTipSOL: jitoTxCount > 0 ? totalJitoTips / jitoTxCount / LAMPORTS_TO_SOL : 0,
            jitoUsageRate: totalEvents > 0 ? jitoTxCount / totalEvents : 0,
        },
        fracturedTokens: fracturedTokens.slice(0, 100),
        walletPnL: {
            totalProfitSOL: totalProfitLamports / LAMPORTS_TO_SOL,
            totalLossSOL: totalLossLamportsWallets / LAMPORTS_TO_SOL,
            profitableWallets: profitableWallets.length,
            losingWallets: losingWallets.length,
            topWinners,
            topLosers,
        },
        competitiveInsights: {
            tier1CompetitorCount: tier1Competitors.length,
            tier2CompetitorCount: tier2Competitors.length,
            tier3CompetitorCount: tier3Competitors.length,
            avgWinnerFeePerCu,
            avgWinnerCuConsumed,
            jitoTier1Correlation: tier1JitoRate,
        },
    };

    return results;
}

function printReport(results: AnalysisResults): void {
    const opp = results.opportunityBreakdown;

    console.log("\n" + "=".repeat(85));
    console.log("📊 KPI STREAM ANALYSIS REPORT");
    console.log("=".repeat(85));

    console.log(`\n📁 META`);
    console.log(`   Total Events:     ${results.meta.totalEvents.toLocaleString()}`);
    console.log(`   Distinct Slots:   ${results.meta.distinctSlots.toLocaleString()}`);
    console.log(`   Runtime:          ${results.meta.runtimeEstimateMinutes.toFixed(1)} minutes`);

    console.log(`\n📈 TRANSACTION CATEGORIES`);
    const sortedCat = Object.entries(results.txCategoryDistribution).sort((a, b) => b[1] - a[1]);
    for (const [cat, count] of sortedCat) {
        const pct = ((count / results.meta.totalEvents) * 100).toFixed(1);
        console.log(`   ${cat.padEnd(20)} ${count.toLocaleString().padStart(8)} (${pct}%)`);
    }

    console.log(`\n⚡ JITO BUNDLE ANALYSIS`);
    console.log(`   Jito Transactions: ${results.jitoAnalysis.totalJitoTxs.toLocaleString()}`);
    console.log(`   Avg Tip:           ${results.jitoAnalysis.avgTipSOL.toFixed(6)} SOL`);
    console.log(`   Usage Rate:        ${(results.jitoAnalysis.jitoUsageRate * 100).toFixed(1)}%`);

    console.log(`\n🎯 OPPORTUNITY BREAKDOWN`);
    console.log(`   Total Pump Loss:     ${opp.totalPumpLossSOL.toFixed(4)} SOL`);
    console.log(`   Capturable:          ${opp.totalCapturableSOL.toFixed(4)} SOL`);
    console.log(`   🔴 T1 Unbeatable:    ${opp.tier1UnbeatableSOL.toFixed(4)} SOL (${opp.tier1Events} events)`);
    console.log(`   🟡 T2 Difficult:     ${opp.tier2DifficultSOL.toFixed(4)} SOL (${opp.tier2Events} events)`);
    console.log(`   🟢 T3 Beatable:      ${opp.tier3BeatableSOL.toFixed(4)} SOL (${opp.tier3Events} events)`);
    console.log(`   💎 Pool Absorbed:    ${opp.poolAbsorbedSOL.toFixed(4)} SOL (${opp.poolAbsorbedEvents} events)`);
    console.log(`   ❌ Not Fractured:    ${opp.notFracturedSOL.toFixed(4)} SOL (${opp.notFracturedEvents} events)`);
    console.log(`   ✅ YOUR OPPORTUNITY: ${opp.beatableOpportunitySOL.toFixed(4)} SOL`);
    console.log(`   📈 Hourly:           ${opp.hourlyBeatableSOL.toFixed(2)} SOL/hr`);
    console.log(`   📈 Daily:            ${(opp.hourlyBeatableSOL * 24).toFixed(2)} SOL/day`);

    console.log(`\n🏆 TOP WINNERS`);
    for (const w of results.walletPnL.topWinners.slice(0, 5)) {
        console.log(`   ${w.wallet.slice(0, 16)}... | +${w.netSOL.toFixed(4)} SOL | ${w.tier} | ${(w.jitoRate * 100).toFixed(0)}% Jito`);
    }

    console.log(`\n🔗 TOP FRACTURED TOKENS`);
    for (const t of results.fracturedTokens.slice(0, 5)) {
        console.log(`   ${t.mint.slice(0, 16)}... | ${t.beatableSOL.toFixed(4)} beatable | ${t.venues.join("+")}`);
    }

    console.log("\n" + "=".repeat(85));
}

async function main(): Promise<void> {
    const inputPath = path.join(DATA_DIR, "helius_kpi_stream.jsonl");

    if (!fs.existsSync(inputPath)) {
        console.error(`[ERROR] Input file not found: ${inputPath}`);
        console.error(`[ERROR] Run 01_helius_kpi_stream.ts first`);
        process.exit(1);
    }

    const results = await analyzeKpiStream(inputPath);

    const resultsPath = path.join(DATA_DIR, "analysis_results.json");
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
    console.log(`[ANALYZE] Saved: ${resultsPath}`);

    printReport(results);

    console.log(`\n✅ Next: npx tsx src/scripts/03_competitor_deep_dive.ts`);
}

main().catch(console.error);