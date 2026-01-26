/**
 * PHASE 4: Opportunity Scorer (Updated for new schema)
 *
 * Combines all analysis to produce actionable strategy:
 * - Ranks tokens by beatable opportunity
 * - Recommends configuration based on competition
 * - Generates markdown strategy report
 *
 * Input:  src/scripts/data/analysis_results.json
 *         src/scripts/data/competitor_profiles.json
 * Output: src/scripts/data/opportunities.json
 *         src/scripts/data/STRATEGY_REPORT.md
 *
 * Run: npx tsx src/scripts/04_opportunity_scorer.ts
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");

// ============================================================================
// TYPES
// ============================================================================

interface AnalysisResults {
    meta: {
        totalEvents: number;
        runtimeEstimateMinutes: number;
        timeRange: { start: string; end: string };
    };
    txCategoryDistribution: Record<string, number>;
    programUsage: Record<string, number>;
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
        topWinners: Array<{ wallet: string; netSOL: number; tier: string; jitoRate: number }>;
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

interface CompetitorProfile {
    wallet: string;
    tier: string;
    txCount: number;
    jitoUsageRate: number;
    avgJitoTipSOL: number;
    avgFeeSOL: number;
    avgPriorityFeePerCu: number;
    altUsageRate: number;
    multiHopRate: number;
    avgCuConsumed: number;
    routeBreakdown: Record<string, number>;
    dexUsage: Record<string, number>;
}

interface TokenOpportunity {
    mint: string;
    venues: string[];
    score: number;
    beatableSOL: number;
    totalLossSOL: number;
    beatableShare: number;
    tier1Share: number;
    recommendation: string;
}

interface Strategy {
    generatedAt: string;

    marketOverview: {
        totalPumpLossSOL: number;
        totalCapturableSOL: number;
        beatableOpportunitySOL: number;
        hourlyBeatableSOL: number;
        dailyBeatableSOL: number;
        marketEfficiency: number;
    };

    competitionAnalysis: {
        tier1Count: number;
        tier2Count: number;
        tier3Count: number;
        jitoUsageRate: number;
        jitoTier1Correlation: number;
        avgCompetitorCU: number;
    };

    recommendedConfig: {
        useJitoBundles: boolean;
        jitoTipRange: { min: number; max: number };
        useALTs: boolean;
        targetCuConsumption: number;
        priorityFeeRange: { min: number; max: number };
        focusVenues: string[];
    };

    tokenOpportunities: TokenOpportunity[];

    actionItems: string[];

    yourAdvantages: string[];
}

// ============================================================================
// SCORING
// ============================================================================

function scoreToken(token: AnalysisResults["fracturedTokens"][0]): TokenOpportunity {
    const beatable = token.beatableSOL;
    const total = token.totalLossSOL;
    const tier1Share = total > 0 ? token.tier1SOL / total : 0;

    // Score: higher beatable + lower tier1 dominance = better opportunity
    const score = beatable * (1 - tier1Share * 0.5) * 100;

    let recommendation = "";
    if (beatable > 1 && tier1Share < 0.3) {
        recommendation = "HIGH PRIORITY - Significant uncaptured opportunity";
    } else if (beatable > 0.1 && tier1Share < 0.5) {
        recommendation = "MEDIUM PRIORITY - Some opportunity, moderate competition";
    } else if (tier1Share > 0.7) {
        recommendation = "LOW PRIORITY - Dominated by Jito bots";
    } else {
        recommendation = "MONITOR - Limited opportunity";
    }

    return {
        mint: token.mint,
        venues: token.venues,
        score,
        beatableSOL: beatable,
        totalLossSOL: total,
        beatableShare: token.beatableShare,
        tier1Share,
        recommendation,
    };
}

function buildStrategy(
    analysis: AnalysisResults,
    competitors: CompetitorProfile[]
): Strategy {
    const opp = analysis.opportunityBreakdown;
    const insights = analysis.competitiveInsights;

    // Aggregate competitor patterns
    const validComps = competitors.filter((c) => c.txCount > 0);
    const avgJitoUsage = validComps.length > 0
        ? validComps.reduce((s, c) => s + c.jitoUsageRate, 0) / validComps.length
        : analysis.jitoAnalysis.jitoUsageRate;
    const avgAltUsage = validComps.length > 0
        ? validComps.reduce((s, c) => s + c.altUsageRate, 0) / validComps.length
        : 0;
    const avgCu = validComps.length > 0
        ? validComps.reduce((s, c) => s + c.avgCuConsumed, 0) / validComps.length
        : insights.avgWinnerCuConsumed;

    // Market efficiency = captured / capturable
    const captured = opp.tier1UnbeatableSOL + opp.tier2DifficultSOL + opp.tier3BeatableSOL;
    const marketEfficiency = opp.totalCapturableSOL > 0 ? captured / opp.totalCapturableSOL : 0;

    // Score tokens
    const tokenOpportunities = analysis.fracturedTokens
        .map(scoreToken)
        .sort((a, b) => b.score - a.score)
        .slice(0, 30);

    // Determine config
    const useJito = avgJitoUsage > 0.2 || insights.jitoTier1Correlation > 0.5;
    const useALTs = avgAltUsage > 0.4;

    // Determine focus venues from top tokens
    const venueCount: Record<string, number> = {};
    for (const t of tokenOpportunities.slice(0, 10)) {
        for (const v of t.venues) {
            venueCount[v] = (venueCount[v] ?? 0) + 1;
        }
    }
    const focusVenues = Object.entries(venueCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([v]) => v);

    // Action items
    const actionItems: string[] = [];

    if (opp.poolAbsorbedSOL > opp.tier3BeatableSOL) {
        actionItems.push(`💎 ${opp.poolAbsorbedSOL.toFixed(2)} SOL pool-absorbed - First mover advantage available`);
    }

    if (useJito) {
        actionItems.push(`⚡ Implement Jito bundles - ${(avgJitoUsage * 100).toFixed(0)}% competitor usage, ${(insights.jitoTier1Correlation * 100).toFixed(0)}% T1 correlation`);
    } else {
        actionItems.push(`📤 Priority fees may suffice - Low Jito usage (${(avgJitoUsage * 100).toFixed(0)}%)`);
    }

    if (useALTs) {
        actionItems.push(`🔧 Implement Address Lookup Tables - ${(avgAltUsage * 100).toFixed(0)}% competitor usage`);
    }

    if (marketEfficiency < 0.5) {
        actionItems.push(`✅ Market ${((1 - marketEfficiency) * 100).toFixed(0)}% inefficient - Significant opportunity`);
    } else {
        actionItems.push(`⚠️ Market ${(marketEfficiency * 100).toFixed(0)}% efficient - Need speed advantage`);
    }

    actionItems.push(`🎯 Focus on ${focusVenues.join(" + ")} venue combinations`);
    actionItems.push(`📈 Target: ${opp.hourlyBeatableSOL.toFixed(2)} SOL/hr = ${(opp.hourlyBeatableSOL * 24).toFixed(2)} SOL/day`);

    const yourAdvantages = [
        "Geyser gRPC: ~50-100ms detection vs ~1000ms competitor polling",
        "512GB RAM: Full liquidity state in-memory",
        "Threadripper: Fast route simulation",
        "Custom CLMM/DLMM decoders: Sub-0.1% accuracy",
    ];

    return {
        generatedAt: new Date().toISOString(),
        marketOverview: {
            totalPumpLossSOL: opp.totalPumpLossSOL,
            totalCapturableSOL: opp.totalCapturableSOL,
            beatableOpportunitySOL: opp.beatableOpportunitySOL,
            hourlyBeatableSOL: opp.hourlyBeatableSOL,
            dailyBeatableSOL: opp.hourlyBeatableSOL * 24,
            marketEfficiency,
        },
        competitionAnalysis: {
            tier1Count: insights.tier1CompetitorCount,
            tier2Count: insights.tier2CompetitorCount,
            tier3Count: insights.tier3CompetitorCount,
            jitoUsageRate: avgJitoUsage,
            jitoTier1Correlation: insights.jitoTier1Correlation,
            avgCompetitorCU: avgCu,
        },
        recommendedConfig: {
            useJitoBundles: useJito,
            jitoTipRange: { min: 0.00001, max: 0.0005 },
            useALTs,
            targetCuConsumption: Math.round(avgCu * 0.9),
            priorityFeeRange: {
                min: insights.avgWinnerFeePerCu * 0.5,
                max: insights.avgWinnerFeePerCu * 2,
            },
            focusVenues,
        },
        tokenOpportunities,
        actionItems,
        yourAdvantages,
    };
}

function generateMarkdown(strategy: Strategy): string {
    const m = strategy.marketOverview;
    const c = strategy.competitionAnalysis;
    const cfg = strategy.recommendedConfig;

    return `# YogurtSlinger Strategy Report

Generated: ${strategy.generatedAt}

---

## 🎯 Executive Summary

${strategy.actionItems.map((item, i) => `${i + 1}. **${item}**`).join("\n")}

---

## 📊 Market Overview

| Metric | Value |
|--------|-------|
| Total Pump Loss | ${m.totalPumpLossSOL.toFixed(4)} SOL |
| Capturable (fractured) | ${m.totalCapturableSOL.toFixed(4)} SOL |
| Beatable Opportunity | ${m.beatableOpportunitySOL.toFixed(4)} SOL |
| Hourly Rate | ${m.hourlyBeatableSOL.toFixed(2)} SOL/hr |
| Daily Projection | ${m.dailyBeatableSOL.toFixed(2)} SOL/day |
| Market Efficiency | ${(m.marketEfficiency * 100).toFixed(1)}% captured |

---

## 🏆 Competition Analysis

| Tier | Count | Characteristics |
|------|-------|-----------------|
| Tier 1 (Unbeatable) | ${c.tier1Count} | Jito bundles, sub-slot execution |
| Tier 2 (Difficult) | ${c.tier2Count} | Aggregators, optimized routes |
| Tier 3 (Beatable) | ${c.tier3Count} | Slow, high fees, inefficient |

- **Jito Usage Rate**: ${(c.jitoUsageRate * 100).toFixed(0)}%
- **Jito-T1 Correlation**: ${(c.jitoTier1Correlation * 100).toFixed(0)}%
- **Avg Competitor CU**: ${c.avgCompetitorCU.toFixed(0)}

---

## 🚀 Your Advantages

${strategy.yourAdvantages.map((a) => `- ${a}`).join("\n")}

---

## ⚙️ Recommended Configuration

\`\`\`typescript
const config = {
  useJitoBundles: ${cfg.useJitoBundles},
  jitoTipRange: { min: ${cfg.jitoTipRange.min}, max: ${cfg.jitoTipRange.max} },
  useAddressLookupTables: ${cfg.useALTs},
  targetComputeUnits: ${cfg.targetCuConsumption},
  priorityFeePerCu: { min: ${cfg.priorityFeeRange.min.toFixed(4)}, max: ${cfg.priorityFeeRange.max.toFixed(4)} },
  focusVenues: ${JSON.stringify(cfg.focusVenues)},
};
\`\`\`

---

## 💰 Top Token Opportunities

| Token | Beatable | Total Loss | Beatable % | T1 % | Recommendation |
|-------|----------|------------|------------|------|----------------|
${strategy.tokenOpportunities
            .slice(0, 15)
            .map(
                (t) =>
                    `| ${t.mint.slice(0, 12)}... | ${t.beatableSOL.toFixed(4)} | ${t.totalLossSOL.toFixed(4)} | ${(t.beatableShare * 100).toFixed(0)}% | ${(t.tier1Share * 100).toFixed(0)}% | ${t.recommendation.split(" - ")[0]} |`
            )
            .join("\n")}

---

## 🛤️ Focus Venues

Priority order: **${cfg.focusVenues.join(" → ")}**

---

*Re-run this analysis daily to track market changes.*
`;
}

async function main(): Promise<void> {
    const analysisPath = path.join(DATA_DIR, "analysis_results.json");
    const competitorPath = path.join(DATA_DIR, "competitor_profiles.json");

    if (!fs.existsSync(analysisPath)) {
        console.error(`[ERROR] Analysis results not found: ${analysisPath}`);
        console.error(`[ERROR] Run 02_analyze_kpi_data.ts first`);
        process.exit(1);
    }

    const analysis: AnalysisResults = JSON.parse(fs.readFileSync(analysisPath, "utf-8"));

    let competitors: CompetitorProfile[] = [];
    if (fs.existsSync(competitorPath)) {
        competitors = JSON.parse(fs.readFileSync(competitorPath, "utf-8"));
    } else {
        console.log(`[SCORER] No competitor profiles, proceeding with analysis only`);
    }

    console.log(`[SCORER] Building strategy...`);

    const strategy = buildStrategy(analysis, competitors);

    const opportunitiesPath = path.join(DATA_DIR, "opportunities.json");
    fs.writeFileSync(opportunitiesPath, JSON.stringify(strategy, null, 2));
    console.log(`[SCORER] Saved: ${opportunitiesPath}`);

    const reportPath = path.join(DATA_DIR, "STRATEGY_REPORT.md");
    fs.writeFileSync(reportPath, generateMarkdown(strategy));
    console.log(`[SCORER] Saved: ${reportPath}`);

    console.log("\n" + "=".repeat(85));
    console.log("🎯 STRATEGY SUMMARY");
    console.log("=".repeat(85));

    console.log("\n📋 ACTION ITEMS:");
    for (const item of strategy.actionItems) {
        console.log(`   ${item}`);
    }

    console.log("\n⚙️ CONFIG:");
    console.log(`   Jito: ${strategy.recommendedConfig.useJitoBundles ? "YES" : "NO"}`);
    console.log(`   ALTs: ${strategy.recommendedConfig.useALTs ? "YES" : "NO"}`);
    console.log(`   Focus: ${strategy.recommendedConfig.focusVenues.join(" + ")}`);

    console.log("\n🏆 TOP TOKENS:");
    for (const t of strategy.tokenOpportunities.slice(0, 5)) {
        console.log(`   ${t.mint.slice(0, 16)}... | ${t.beatableSOL.toFixed(4)} SOL | ${t.recommendation.split(" - ")[0]}`);
    }

    console.log("\n" + "=".repeat(85));
    console.log(`\n✅ Pipeline complete! Open ${reportPath} for full report.`);
}

main().catch(console.error);