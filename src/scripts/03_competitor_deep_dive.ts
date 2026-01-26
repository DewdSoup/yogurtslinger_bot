/**
 * PHASE 3: Competitor Deep Dive (Updated for new schema)
 *
 * Fetches and analyzes recent transactions from top competitors
 * to understand their exact strategies, timing, and execution.
 *
 * Input:  src/scripts/data/analysis_results.json
 * Output: src/scripts/data/competitor_profiles.json
 *
 * Run: npx tsx src/scripts/03_competitor_deep_dive.ts
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");

// ============================================================================
// CONFIG
// ============================================================================

const HELIUS_API_KEY = "bff504b3-c294-46e9-b7d8-dacbcb4b9e3d";
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const JITO_TIP_ACCOUNTS = new Set([
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
    "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
    "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
]);

const DEX_PROGRAMS: Record<string, string> = {
    pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "PumpSwap",
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "RaydiumV4",
    CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "RaydiumCLMM",
    LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "MeteoraDLMM",
    JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "JupiterV6",
    JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB: "JupiterV4",
    whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "OrcaWhirlpool",
};

const SIGNATURES_PER_WALLET = 30;
const TXS_TO_ANALYZE = 20;
const RATE_LIMIT_MS = 100;

// ============================================================================
// TYPES
// ============================================================================

interface TxAnalysis {
    signature: string;
    slot: number;
    blockTime: number | null;
    fee: number;
    cuConsumed: number;
    cuLimit: number | null;
    cuPrice: number | null;
    isJitoBundle: boolean;
    jitoTipLamports: number;
    usesALT: boolean;
    altCount: number;
    dexRoute: string[];
    isMultiHop: boolean;
    instructionCount: number;
    innerInstructionCount: number;
}

interface CompetitorProfile {
    wallet: string;
    tier: string;
    analyzedAt: string;
    txCount: number;

    jitoUsageRate: number;
    avgJitoTipSOL: number;
    avgFeeSOL: number;
    avgPriorityFeePerCu: number;

    altUsageRate: number;
    multiHopRate: number;
    avgInstructions: number;
    avgCuConsumed: number;

    routeBreakdown: Record<string, number>;
    dexUsage: Record<string, number>;

    sampleSignatures: string[];
    transactions: TxAnalysis[];
}

interface AnalysisResults {
    walletPnL: {
        topWinners: Array<{ wallet: string; netSOL: number; tier: string; jitoRate: number }>;
    };
}

// ============================================================================
// TRANSACTION ANALYSIS
// ============================================================================

async function fetchWalletSignatures(
    connection: Connection,
    wallet: string,
    limit: number
): Promise<string[]> {
    try {
        const pubkey = new PublicKey(wallet);
        const sigs = await connection.getSignaturesForAddress(pubkey, { limit });
        return sigs.map((s) => s.signature);
    } catch (e) {
        console.error(`[DEEP_DIVE] Error fetching sigs for ${wallet.slice(0, 12)}:`, e);
        return [];
    }
}

async function analyzeTransaction(
    connection: Connection,
    signature: string
): Promise<TxAnalysis | null> {
    try {
        const tx = await connection.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0,
        });

        if (!tx) return null;

        const result: TxAnalysis = {
            signature,
            slot: tx.slot,
            blockTime: tx.blockTime ?? null,
            fee: tx.meta?.fee ?? 0,
            cuConsumed: (tx.meta as any)?.computeUnitsConsumed ?? 0,
            cuLimit: null,
            cuPrice: null,
            isJitoBundle: false,
            jitoTipLamports: 0,
            usesALT: false,
            altCount: 0,
            dexRoute: [],
            isMultiHop: false,
            instructionCount: 0,
            innerInstructionCount: 0,
        };

        const message = tx.transaction.message as any;

        if (message.addressTableLookups?.length > 0) {
            result.usesALT = true;
            result.altCount = message.addressTableLookups.length;
        }

        const instructions = message.instructions ?? [];
        result.instructionCount = instructions.length;

        const dexSet = new Set<string>();

        for (const ix of instructions) {
            const programId = ix.programId?.toString?.() ?? "";

            if (programId === "ComputeBudget111111111111111111111111111111") {
                if (ix.parsed?.type === "setComputeUnitLimit") {
                    result.cuLimit = ix.parsed.info.units;
                }
                if (ix.parsed?.type === "setComputeUnitPrice") {
                    result.cuPrice = ix.parsed.info.microLamports;
                }
            }

            if (DEX_PROGRAMS[programId]) {
                dexSet.add(DEX_PROGRAMS[programId]);
            }
        }

        for (const inner of tx.meta?.innerInstructions ?? []) {
            result.innerInstructionCount += inner.instructions?.length ?? 0;

            for (const ix of inner.instructions ?? []) {
                const programId = (ix as any).programId?.toString?.() ?? "";

                if (DEX_PROGRAMS[programId]) {
                    dexSet.add(DEX_PROGRAMS[programId]);
                }

                if ((ix as any).parsed?.type === "transfer") {
                    const dest = (ix as any).parsed.info.destination;
                    if (JITO_TIP_ACCOUNTS.has(dest)) {
                        result.isJitoBundle = true;
                        result.jitoTipLamports += (ix as any).parsed.info.lamports ?? 0;
                    }
                }
            }
        }

        result.dexRoute = Array.from(dexSet);
        result.isMultiHop = dexSet.size >= 2;

        return result;
    } catch (e) {
        console.error(`[DEEP_DIVE] Error analyzing ${signature.slice(0, 16)}:`, e);
        return null;
    }
}

function buildProfile(wallet: string, tier: string, transactions: TxAnalysis[]): CompetitorProfile {
    const dexTxs = transactions.filter((t) => t.dexRoute.length > 0);
    const txCount = dexTxs.length;

    if (txCount === 0) {
        return {
            wallet,
            tier,
            analyzedAt: new Date().toISOString(),
            txCount: 0,
            jitoUsageRate: 0,
            avgJitoTipSOL: 0,
            avgFeeSOL: 0,
            avgPriorityFeePerCu: 0,
            altUsageRate: 0,
            multiHopRate: 0,
            avgInstructions: 0,
            avgCuConsumed: 0,
            routeBreakdown: {},
            dexUsage: {},
            sampleSignatures: [],
            transactions: [],
        };
    }

    const jitoTxs = dexTxs.filter((t) => t.isJitoBundle);
    const altTxs = dexTxs.filter((t) => t.usesALT);
    const multiHopTxs = dexTxs.filter((t) => t.isMultiHop);

    const avgJitoTip = jitoTxs.length > 0
        ? jitoTxs.reduce((sum, t) => sum + t.jitoTipLamports, 0) / jitoTxs.length / 1e9
        : 0;

    const avgFee = dexTxs.reduce((sum, t) => sum + t.fee, 0) / txCount / 1e9;
    const avgCu = dexTxs.reduce((sum, t) => sum + t.cuConsumed, 0) / txCount;
    const avgInstr = dexTxs.reduce((sum, t) => sum + t.instructionCount, 0) / txCount;

    let avgPriorityFee = 0;
    const txsWithPrice = dexTxs.filter((t) => t.cuPrice !== null);
    if (txsWithPrice.length > 0) {
        avgPriorityFee = txsWithPrice.reduce((sum, t) => sum + (t.cuPrice ?? 0), 0) / txsWithPrice.length / 1e6;
    }

    const routeBreakdown: Record<string, number> = {};
    const dexUsage: Record<string, number> = {};

    for (const t of dexTxs) {
        const route = t.dexRoute.sort().join(" → ");
        routeBreakdown[route] = (routeBreakdown[route] ?? 0) + 1;
        for (const dex of t.dexRoute) {
            dexUsage[dex] = (dexUsage[dex] ?? 0) + 1;
        }
    }

    return {
        wallet,
        tier,
        analyzedAt: new Date().toISOString(),
        txCount,
        jitoUsageRate: jitoTxs.length / txCount,
        avgJitoTipSOL: avgJitoTip,
        avgFeeSOL: avgFee,
        avgPriorityFeePerCu: avgPriorityFee,
        altUsageRate: altTxs.length / txCount,
        multiHopRate: multiHopTxs.length / txCount,
        avgInstructions: avgInstr,
        avgCuConsumed: avgCu,
        routeBreakdown,
        dexUsage,
        sampleSignatures: dexTxs.slice(0, 5).map((t) => t.signature),
        transactions: dexTxs,
    };
}

function printReport(profiles: CompetitorProfile[]): void {
    console.log("\n" + "=".repeat(85));
    console.log("🎯 COMPETITOR DEEP DIVE REPORT");
    console.log("=".repeat(85));

    for (const p of profiles) {
        if (p.txCount === 0) {
            console.log(`\n❌ ${p.wallet.slice(0, 16)}... - No DEX txs found`);
            continue;
        }

        console.log(`\n${"─".repeat(85)}`);
        console.log(`🏆 ${p.wallet} [${p.tier}]`);
        console.log(`${"─".repeat(85)}`);

        console.log(`   📊 DEX TXs Analyzed: ${p.txCount}`);
        console.log(`   ⚡ Jito Rate:        ${(p.jitoUsageRate * 100).toFixed(0)}%`);
        console.log(`   💰 Avg Jito Tip:     ${p.avgJitoTipSOL.toFixed(6)} SOL`);
        console.log(`   🔧 ALT Rate:         ${(p.altUsageRate * 100).toFixed(0)}%`);
        console.log(`   🔀 Multi-Hop Rate:   ${(p.multiHopRate * 100).toFixed(0)}%`);
        console.log(`   📐 Avg CU:           ${p.avgCuConsumed.toFixed(0)}`);

        console.log(`   🛤️  Routes:`);
        const routes = Object.entries(p.routeBreakdown).sort((a, b) => b[1] - a[1]).slice(0, 3);
        for (const [route, count] of routes) {
            console.log(`      ${route}: ${count}`);
        }
    }

    const withData = profiles.filter((p) => p.txCount > 0);
    if (withData.length === 0) return;

    console.log("\n" + "=".repeat(85));
    console.log("💡 SUMMARY INSIGHTS");
    console.log("=".repeat(85));

    const avgJito = withData.reduce((s, p) => s + p.jitoUsageRate, 0) / withData.length;
    const avgAlt = withData.reduce((s, p) => s + p.altUsageRate, 0) / withData.length;
    const avgMultiHop = withData.reduce((s, p) => s + p.multiHopRate, 0) / withData.length;

    console.log(`   Avg Jito Usage:     ${(avgJito * 100).toFixed(0)}%`);
    console.log(`   Avg ALT Usage:      ${(avgAlt * 100).toFixed(0)}%`);
    console.log(`   Avg Multi-Hop:      ${(avgMultiHop * 100).toFixed(0)}%`);

    if (avgJito > 0.3) {
        console.log(`   ⚡ HIGH Jito usage → Implement Jito bundles`);
    } else {
        console.log(`   📤 LOW Jito usage → Priority fees may suffice`);
    }

    if (avgAlt > 0.5) {
        console.log(`   🔧 HIGH ALT usage → Optimize with ALTs`);
    }

    if (avgMultiHop > 0.3) {
        console.log(`   🔀 Complex routes common → Need multi-hop`);
    } else {
        console.log(`   ➡️  Simple routes dominant → Focus on 2-venue arbs`);
    }

    console.log("\n" + "=".repeat(85));
}

async function main(): Promise<void> {
    const analysisPath = path.join(DATA_DIR, "analysis_results.json");

    if (!fs.existsSync(analysisPath)) {
        console.error(`[ERROR] Analysis results not found: ${analysisPath}`);
        console.error(`[ERROR] Run 02_analyze_kpi_data.ts first`);
        process.exit(1);
    }

    const results: AnalysisResults = JSON.parse(fs.readFileSync(analysisPath, "utf-8"));

    const walletsToAnalyze: Array<{ wallet: string; tier: string }> = [];
    for (const w of results.walletPnL.topWinners.slice(0, 10)) {
        walletsToAnalyze.push({ wallet: w.wallet, tier: w.tier });
    }

    console.log(`[DEEP_DIVE] Analyzing ${walletsToAnalyze.length} top wallets...`);

    const connection = new Connection(HELIUS_RPC, "confirmed");
    const profiles: CompetitorProfile[] = [];

    for (const { wallet, tier } of walletsToAnalyze) {
        console.log(`[DEEP_DIVE] Fetching ${wallet.slice(0, 12)}... [${tier}]`);

        const signatures = await fetchWalletSignatures(connection, wallet, SIGNATURES_PER_WALLET);
        await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));

        if (signatures.length === 0) {
            profiles.push(buildProfile(wallet, tier, []));
            continue;
        }

        console.log(`[DEEP_DIVE] Analyzing ${Math.min(signatures.length, TXS_TO_ANALYZE)} txs...`);

        const transactions: TxAnalysis[] = [];
        for (const sig of signatures.slice(0, TXS_TO_ANALYZE)) {
            const analysis = await analyzeTransaction(connection, sig);
            if (analysis) transactions.push(analysis);
            await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
        }

        profiles.push(buildProfile(wallet, tier, transactions));
    }

    const profilesPath = path.join(DATA_DIR, "competitor_profiles.json");
    fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2));
    console.log(`[DEEP_DIVE] Saved: ${profilesPath}`);

    printReport(profiles);

    console.log(`\n✅ Next: npx tsx src/scripts/04_opportunity_scorer.ts`);
}

main().catch(console.error);