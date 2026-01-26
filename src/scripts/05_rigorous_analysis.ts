/**
 * PHASE 5: RIGOROUS DEEP ANALYSIS
 * 
 * Problems with current analysis:
 * 1. "Pool Absorbed" shows 17,970 events but 0.17 SOL - suspicious
 * 2. Competitor detection uses maxSolGainer which could be the pool itself
 * 3. We only see PumpSwap side, not the corresponding arb transaction
 * 4. No slot-level correlation between victim tx and arb tx
 * 
 * This script:
 * 1. Validates data integrity with sampling
 * 2. Finds ACTUAL arb transactions by correlating across venues
 * 3. Measures competitor latency (slots between victim and arb)
 * 4. Identifies TRUE untapped opportunities
 * 5. Profiles competitor strategies in detail
 * 
 * Run: npx tsx src/scripts/05_rigorous_analysis.ts
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

declare function fetch(input: any, init?: any): Promise<any>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");

const HELIUS_API_KEY = "2bb675f2-573f-4561-b57f-d351db310e5a";
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const LAMPORTS_PER_SOL = 1_000_000_000;

// Known program IDs
const PROGRAMS = {
    PUMPSWAP: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    RAYDIUM_V4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    RAYDIUM_CLMM: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    METEORA_DLMM: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    JUPITER_V6: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    ORCA_WHIRLPOOL: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
};

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

// ============================================================================
// TYPES
// ============================================================================

interface KpiEvent {
    signature: string;
    slot: number;
    ts: string;
    pumpMint: string | null;
    isPumpSwapLoss: boolean;
    pumpLossLamports: number | null;
    isTokenFractured: boolean;
    opportunityStatus: string;
    competitorTier: string;
    maxSolGainerPubkey: string | null;
    maxSolGainerLamports: number | null;
    primarySignerPubkey: string | null;
    primarySignerSolDelta: number | null;
    programsDetected: Array<{ name: string; programId: string }>;
    tokenMintsInvolved: string[];
}

interface ArbCorrelation {
    victimSig: string;
    victimSlot: number;
    victimLossLamports: number;
    arbSig: string | null;
    arbSlot: number | null;
    arbVenue: string | null;
    arbProfitLamports: number | null;
    slotDelta: number | null;
    arbWallet: string | null;
    status: "CAPTURED" | "UNCAPTURED" | "SAME_BLOCK" | "UNKNOWN";
}

interface WalletProfile {
    wallet: string;
    totalProfitLamports: number;
    arbCount: number;
    avgSlotLatency: number;
    venues: Record<string, number>;
    usesJito: boolean;
    jitoTxCount: number;
    avgCU: number;
    tokensTouched: Set<string>;
    sameBlockArbs: number;
    crossBlockArbs: number;
}

// ============================================================================
// UTILITIES
// ============================================================================

function log(msg: string): void {
    console.log(`[RIGOROUS] ${msg}`);
}

function lamportsToSol(l: number): number {
    return l / LAMPORTS_PER_SOL;
}

async function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

async function fetchTx(sig: string): Promise<any | null> {
    try {
        const res = await fetch(HELIUS_RPC, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "getTransaction",
                params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
            }),
        });
        const data = await res.json();
        return data.result ?? null;
    } catch {
        return null;
    }
}

async function fetchSignaturesForAddress(
    address: string,
    limit: number = 100,
    before?: string
): Promise<Array<{ signature: string; slot: number }>> {
    try {
        const params: any = { limit };
        if (before) params.before = before;

        const res = await fetch(HELIUS_RPC, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "getSignaturesForAddress",
                params: [address, params],
            }),
        });
        const data = await res.json();
        return (data.result ?? []).map((r: any) => ({
            signature: r.signature,
            slot: r.slot,
        }));
    } catch {
        return [];
    }
}

// ============================================================================
// LOAD EXISTING DATA
// ============================================================================

function loadKpiEvents(): KpiEvent[] {
    const filePath = path.join(DATA_DIR, "helius_kpi_stream.jsonl");
    if (!fs.existsSync(filePath)) {
        throw new Error("No KPI data found. Run 01_helius_kpi_stream.ts first.");
    }

    const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line));
}

// ============================================================================
// ANALYSIS 1: DATA VALIDATION
// ============================================================================

interface ValidationResult {
    totalEvents: number;
    pumpLossEvents: number;
    fracturedLossEvents: number;

    // Pool absorbed breakdown
    poolAbsorbedEvents: number;
    poolAbsorbedTotalLamports: number;
    poolAbsorbedBySize: {
        dust: number; // < 1000 lamports
        tiny: number; // 1000 - 100000
        small: number; // 100000 - 1M
        medium: number; // 1M - 10M
        large: number; // > 10M
    };

    // Competitor detection validation
    competitorDetectionIssues: {
        gainerIsPool: number;
        gainerIsSigner: number;
        noGainer: number;
        validCompetitor: number;
    };

    // Sample transactions for manual verification
    samplePoolAbsorbed: string[];
    sampleT3Beatable: string[];
    sampleT2Difficult: string[];
}

function validateData(events: KpiEvent[]): ValidationResult {
    const result: ValidationResult = {
        totalEvents: events.length,
        pumpLossEvents: 0,
        fracturedLossEvents: 0,
        poolAbsorbedEvents: 0,
        poolAbsorbedTotalLamports: 0,
        poolAbsorbedBySize: { dust: 0, tiny: 0, small: 0, medium: 0, large: 0 },
        competitorDetectionIssues: {
            gainerIsPool: 0,
            gainerIsSigner: 0,
            noGainer: 0,
            validCompetitor: 0,
        },
        samplePoolAbsorbed: [],
        sampleT3Beatable: [],
        sampleT2Difficult: [],
    };

    // Known pool/AMM addresses that shouldn't be "competitors"
    const knownPools = new Set([
        PROGRAMS.PUMPSWAP,
        PROGRAMS.RAYDIUM_V4,
        PROGRAMS.RAYDIUM_CLMM,
        PROGRAMS.METEORA_DLMM,
    ]);

    for (const e of events) {
        if (e.isPumpSwapLoss && e.pumpLossLamports) {
            result.pumpLossEvents++;

            if (e.isTokenFractured) {
                result.fracturedLossEvents++;
            }

            if (e.opportunityStatus === "POOL_ABSORBED") {
                result.poolAbsorbedEvents++;
                result.poolAbsorbedTotalLamports += e.pumpLossLamports;

                // Categorize by size
                if (e.pumpLossLamports < 1000) {
                    result.poolAbsorbedBySize.dust++;
                } else if (e.pumpLossLamports < 100000) {
                    result.poolAbsorbedBySize.tiny++;
                } else if (e.pumpLossLamports < 1000000) {
                    result.poolAbsorbedBySize.small++;
                } else if (e.pumpLossLamports < 10000000) {
                    result.poolAbsorbedBySize.medium++;
                } else {
                    result.poolAbsorbedBySize.large++;
                }

                // Sample for manual verification
                if (result.samplePoolAbsorbed.length < 20 && e.pumpLossLamports > 100000) {
                    result.samplePoolAbsorbed.push(e.signature);
                }
            }

            // Validate competitor detection
            if (e.competitorTier !== "NOT_COMPETITOR") {
                if (!e.maxSolGainerPubkey) {
                    result.competitorDetectionIssues.noGainer++;
                } else if (knownPools.has(e.maxSolGainerPubkey)) {
                    result.competitorDetectionIssues.gainerIsPool++;
                } else if (e.maxSolGainerPubkey === e.primarySignerPubkey) {
                    result.competitorDetectionIssues.gainerIsSigner++;
                } else {
                    result.competitorDetectionIssues.validCompetitor++;
                }

                // Sample by tier
                if (e.competitorTier === "TIER_3_BEATABLE" && result.sampleT3Beatable.length < 20) {
                    result.sampleT3Beatable.push(e.signature);
                }
                if (e.competitorTier === "TIER_2_DIFFICULT" && result.sampleT2Difficult.length < 20) {
                    result.sampleT2Difficult.push(e.signature);
                }
            }
        }
    }

    return result;
}

// ============================================================================
// ANALYSIS 2: CROSS-VENUE CORRELATION
// ============================================================================

async function correlateArbsForToken(
    mint: string,
    events: KpiEvent[],
    _maxFetch: number = 50
): Promise<{
    correlations: ArbCorrelation[];
    externalActivity: Array<{ sig: string; slot: number; venue: string }>;
}> {
    // Get all PumpSwap losses for this token
    const pumpLosses = events
        .filter((e) => e.pumpMint === mint && e.isPumpSwapLoss && e.pumpLossLamports)
        .sort((a, b) => a.slot - b.slot);

    if (pumpLosses.length === 0) {
        return { correlations: [], externalActivity: [] };
    }

    // Find external venue activity for this token in the same slot range
    // We need to look at the token's activity on external venues
    const externalActivity: Array<{ sig: string; slot: number; venue: string; wallet: string; profit: number }> = [];

    // Get events that touch this mint on external venues
    const externalEvents = events.filter(
        (e) =>
            e.tokenMintsInvolved.includes(mint) &&
            e.programsDetected.some(
                (p) =>
                    p.programId === PROGRAMS.RAYDIUM_V4 ||
                    p.programId === PROGRAMS.RAYDIUM_CLMM ||
                    p.programId === PROGRAMS.METEORA_DLMM ||
                    p.programId === PROGRAMS.ORCA_WHIRLPOOL
            ) &&
            !e.programsDetected.some((p) => p.programId === PROGRAMS.PUMPSWAP)
    );

    for (const ext of externalEvents) {
        const venue = ext.programsDetected.find(
            (p) =>
                p.programId === PROGRAMS.RAYDIUM_V4 ||
                p.programId === PROGRAMS.RAYDIUM_CLMM ||
                p.programId === PROGRAMS.METEORA_DLMM
        );
        if (venue && ext.primarySignerSolDelta !== null) {
            externalActivity.push({
                sig: ext.signature,
                slot: ext.slot,
                venue: venue.name,
                wallet: ext.primarySignerPubkey ?? "unknown",
                profit: ext.primarySignerSolDelta,
            });
        }
    }

    // Correlate PumpSwap losses with external arbs
    const correlations: ArbCorrelation[] = [];

    for (const loss of pumpLosses) {
        // Look for external activity within 5 slots
        const nearbyArbs = externalActivity.filter(
            (a) => a.slot >= loss.slot && a.slot <= loss.slot + 5 && a.profit > 0
        );

        if (nearbyArbs.length > 0) {
            // Find the closest profitable arb
            const sorted = nearbyArbs.sort((a, b) => a.slot - b.slot);
            const closest = sorted[0]!; // Safe: we checked length > 0
            correlations.push({
                victimSig: loss.signature,
                victimSlot: loss.slot,
                victimLossLamports: loss.pumpLossLamports!,
                arbSig: closest.sig,
                arbSlot: closest.slot,
                arbVenue: closest.venue,
                arbProfitLamports: closest.profit,
                slotDelta: closest.slot - loss.slot,
                arbWallet: closest.wallet,
                status: closest.slot === loss.slot ? "SAME_BLOCK" : "CAPTURED",
            });
        } else {
            correlations.push({
                victimSig: loss.signature,
                victimSlot: loss.slot,
                victimLossLamports: loss.pumpLossLamports!,
                arbSig: null,
                arbSlot: null,
                arbVenue: null,
                arbProfitLamports: null,
                slotDelta: null,
                arbWallet: null,
                status: "UNCAPTURED",
            });
        }
    }

    return {
        correlations,
        externalActivity: externalActivity.map((a) => ({ sig: a.sig, slot: a.slot, venue: a.venue })),
    };
}

// ============================================================================
// ANALYSIS 3: ARBITRAGEUR PROFILING
// ============================================================================

async function profileArbitrageurs(
    events: KpiEvent[],
    topN: number = 20
): Promise<Map<string, WalletProfile>> {
    const profiles = new Map<string, WalletProfile>();

    // Find wallets that appear as gainers in competitor transactions
    for (const e of events) {
        if (
            e.competitorTier !== "NOT_COMPETITOR" &&
            e.maxSolGainerPubkey &&
            e.maxSolGainerLamports &&
            e.maxSolGainerLamports > 0
        ) {
            const wallet = e.maxSolGainerPubkey;

            if (!profiles.has(wallet)) {
                profiles.set(wallet, {
                    wallet,
                    totalProfitLamports: 0,
                    arbCount: 0,
                    avgSlotLatency: 0,
                    venues: {},
                    usesJito: false,
                    jitoTxCount: 0,
                    avgCU: 0,
                    tokensTouched: new Set(),
                    sameBlockArbs: 0,
                    crossBlockArbs: 0,
                });
            }

            const p = profiles.get(wallet)!;
            p.totalProfitLamports += e.maxSolGainerLamports;
            p.arbCount++;

            if (e.pumpMint) {
                p.tokensTouched.add(e.pumpMint);
            }

            // Track venues
            for (const prog of e.programsDetected) {
                if (
                    prog.name.includes("Raydium") ||
                    prog.name.includes("Meteora") ||
                    prog.name.includes("Orca") ||
                    prog.name.includes("Jupiter")
                ) {
                    p.venues[prog.name] = (p.venues[prog.name] ?? 0) + 1;
                }
            }
        }
    }

    // Sort by profit and take top N
    const sorted = Array.from(profiles.values())
        .sort((a, b) => b.totalProfitLamports - a.totalProfitLamports)
        .slice(0, topN);

    // Deep dive on top wallets - fetch their recent transactions
    log(`Deep diving on ${sorted.length} top arbitrageurs...`);

    for (const profile of sorted) {
        const sigs = await fetchSignaturesForAddress(profile.wallet, 50);
        await sleep(100);

        let totalCU = 0;
        let cuCount = 0;

        for (const { signature } of sigs.slice(0, 20)) {
            const tx = await fetchTx(signature);
            await sleep(50);

            if (!tx) continue;

            const meta = tx.meta;
            const message = tx.transaction?.message;
            const accountKeys =
                message?.accountKeys?.map((k: any) => (typeof k === "string" ? k : k.pubkey)) ?? [];

            // Check for Jito
            for (const key of accountKeys) {
                if (JITO_TIP_ACCOUNTS.has(key)) {
                    profile.usesJito = true;
                    profile.jitoTxCount++;
                    break;
                }
            }

            // CU tracking
            if (meta?.computeUnitsConsumed) {
                totalCU += meta.computeUnitsConsumed;
                cuCount++;
            }
        }

        if (cuCount > 0) {
            profile.avgCU = Math.round(totalCU / cuCount);
        }
    }

    return new Map(sorted.map((p) => [p.wallet, p]));
}

// ============================================================================
// ANALYSIS 4: TRUE UNTAPPED OPPORTUNITIES
// ============================================================================

interface UntappedOpportunity {
    mint: string;
    totalLossLamports: number;
    lossEventCount: number;
    externalVenues: string[];
    noArbEventCount: number;
    noArbLossLamports: number;
    avgLossPerEvent: number;
    // Why wasn't it captured?
    possibleReasons: string[];
}

function findUntappedOpportunities(
    events: KpiEvent[],
    _correlationResults: Map<string, ArbCorrelation[]>
): UntappedOpportunity[] {
    const tokenStats = new Map<
        string,
        {
            totalLoss: number;
            lossCount: number;
            venues: Set<string>;
            uncapturedLoss: number;
            uncapturedCount: number;
        }
    >();

    // Aggregate by token
    for (const e of events) {
        if (e.isPumpSwapLoss && e.pumpLossLamports && e.pumpMint && e.isTokenFractured) {
            if (!tokenStats.has(e.pumpMint)) {
                tokenStats.set(e.pumpMint, {
                    totalLoss: 0,
                    lossCount: 0,
                    venues: new Set(),
                    uncapturedLoss: 0,
                    uncapturedCount: 0,
                });
            }

            const stats = tokenStats.get(e.pumpMint)!;
            stats.totalLoss += e.pumpLossLamports;
            stats.lossCount++;

            // Track venues
            for (const prog of e.programsDetected) {
                if (
                    prog.name.includes("Raydium") ||
                    prog.name.includes("Meteora") ||
                    prog.name.includes("Orca")
                ) {
                    stats.venues.add(prog.name);
                }
            }

            // Check if this specific event was captured
            if (e.opportunityStatus === "POOL_ABSORBED") {
                stats.uncapturedLoss += e.pumpLossLamports;
                stats.uncapturedCount++;
            }
        }
    }

    // Build opportunity list
    const opportunities: UntappedOpportunity[] = [];

    for (const [mint, stats] of tokenStats) {
        if (stats.uncapturedLoss > 0) {
            const reasons: string[] = [];

            // Analyze why it wasn't captured
            const avgLoss = stats.uncapturedLoss / stats.uncapturedCount;
            if (avgLoss < 10000) {
                reasons.push("AVG_LOSS_TOO_SMALL");
            }
            if (stats.venues.size === 0) {
                reasons.push("NO_EXTERNAL_VENUE_DETECTED");
            }
            if (stats.uncapturedCount > stats.lossCount * 0.9) {
                reasons.push("CONSISTENTLY_UNCAPTURED");
            }

            opportunities.push({
                mint,
                totalLossLamports: stats.totalLoss,
                lossEventCount: stats.lossCount,
                externalVenues: Array.from(stats.venues),
                noArbEventCount: stats.uncapturedCount,
                noArbLossLamports: stats.uncapturedLoss,
                avgLossPerEvent: avgLoss,
                possibleReasons: reasons,
            });
        }
    }

    return opportunities.sort((a, b) => b.noArbLossLamports - a.noArbLossLamports);
}

// ============================================================================
// ANALYSIS 5: DETAILED TX INSPECTION
// ============================================================================

interface TxInspection {
    signature: string;
    slot: number;
    programs: string[];
    signerSolDelta: number;
    allSolDeltas: Array<{ pubkey: string; delta: number; isPool: boolean }>;
    tokenFlows: Array<{ mint: string; from: string; to: string; amount: number }>;
    isActualArb: boolean;
    arbProfit: number | null;
    arbDirection: string | null;
}

async function inspectTransaction(sig: string): Promise<TxInspection | null> {
    const tx = await fetchTx(sig);
    if (!tx) return null;

    const meta = tx.meta;
    const message = tx.transaction?.message;

    const accountKeys: string[] =
        message?.accountKeys?.map((k: any) => (typeof k === "string" ? k : k.pubkey)) ?? [];

    const preBalances: number[] = meta?.preBalances ?? [];
    const postBalances: number[] = meta?.postBalances ?? [];

    // Known pool addresses (simplified - in reality would need to decode)
    const knownPoolPrograms = new Set([
        PROGRAMS.PUMPSWAP,
        PROGRAMS.RAYDIUM_V4,
        PROGRAMS.RAYDIUM_CLMM,
        PROGRAMS.METEORA_DLMM,
    ]);

    // Calculate SOL deltas
    const solDeltas: Array<{ pubkey: string; delta: number; isPool: boolean }> = [];
    for (let i = 0; i < accountKeys.length; i++) {
        const delta = (postBalances[i] ?? 0) - (preBalances[i] ?? 0);
        const pubkey = accountKeys[i];
        if (delta !== 0 && pubkey) {
            solDeltas.push({
                pubkey,
                delta,
                isPool: knownPoolPrograms.has(pubkey),
            });
        }
    }

    // Find signer
    let signerDelta = 0;
    for (let i = 0; i < (message?.accountKeys?.length ?? 0); i++) {
        const k = message?.accountKeys?.[i];
        if (k && typeof k === "object" && k.signer) {
            signerDelta = (postBalances[i] ?? 0) - (preBalances[i] ?? 0);
            break;
        }
    }

    // Detect programs
    const programs: string[] = [];
    for (const key of accountKeys) {
        if (key === PROGRAMS.PUMPSWAP) programs.push("PumpSwap");
        if (key === PROGRAMS.RAYDIUM_V4) programs.push("RaydiumV4");
        if (key === PROGRAMS.RAYDIUM_CLMM) programs.push("RaydiumCLMM");
        if (key === PROGRAMS.METEORA_DLMM) programs.push("MeteoraDLMM");
        if (key === PROGRAMS.JUPITER_V6) programs.push("JupiterV6");
    }

    // Token flows from token balances
    const tokenFlows: Array<{ mint: string; from: string; to: string; amount: number }> = [];
    const preTokens = meta?.preTokenBalances ?? [];
    const postTokens = meta?.postTokenBalances ?? [];

    // Build balance maps
    const preMap = new Map<string, Map<string, number>>();
    for (const b of preTokens) {
        if (!preMap.has(b.mint)) preMap.set(b.mint, new Map());
        const owner = b.owner ?? accountKeys[b.accountIndex];
        preMap.get(b.mint)!.set(owner, Number(b.uiTokenAmount?.amount ?? 0));
    }

    const postMap = new Map<string, Map<string, number>>();
    for (const b of postTokens) {
        if (!postMap.has(b.mint)) postMap.set(b.mint, new Map());
        const owner = b.owner ?? accountKeys[b.accountIndex];
        postMap.get(b.mint)!.set(owner, Number(b.uiTokenAmount?.amount ?? 0));
    }

    // Determine if this is an actual arb
    const isMultiVenue = programs.filter((p) => p !== "JupiterV6").length >= 2;
    const hasProfit = signerDelta > 0;

    return {
        signature: sig,
        slot: tx.slot,
        programs,
        signerSolDelta: signerDelta,
        allSolDeltas: solDeltas.filter((d) => Math.abs(d.delta) > 1000).sort((a, b) => b.delta - a.delta),
        tokenFlows,
        isActualArb: isMultiVenue && hasProfit,
        arbProfit: hasProfit ? signerDelta : null,
        arbDirection: programs.includes("PumpSwap") ? "PS→EXT" : "EXT→PS",
    };
}

// ============================================================================
// MAIN ANALYSIS
// ============================================================================

async function main(): Promise<void> {
    log("Loading KPI data...");
    const events = loadKpiEvents();
    log(`Loaded ${events.length} events`);

    // ========================================================================
    // PHASE 1: Data Validation
    // ========================================================================
    log("\n" + "=".repeat(80));
    log("PHASE 1: DATA VALIDATION");
    log("=".repeat(80));

    const validation = validateData(events);

    console.log(`\n📊 BASIC STATS`);
    console.log(`   Total events:           ${validation.totalEvents.toLocaleString()}`);
    console.log(`   PumpSwap loss events:   ${validation.pumpLossEvents.toLocaleString()}`);
    console.log(`   Fractured loss events:  ${validation.fracturedLossEvents.toLocaleString()}`);

    console.log(`\n💎 POOL ABSORBED BREAKDOWN`);
    console.log(`   Total events:           ${validation.poolAbsorbedEvents.toLocaleString()}`);
    console.log(`   Total lamports:         ${validation.poolAbsorbedTotalLamports.toLocaleString()}`);
    console.log(`   Total SOL:              ${lamportsToSol(validation.poolAbsorbedTotalLamports).toFixed(6)}`);
    console.log(`   Avg per event:          ${(validation.poolAbsorbedTotalLamports / Math.max(validation.poolAbsorbedEvents, 1)).toFixed(2)} lamports`);
    console.log(`\n   By size:`);
    console.log(`   - Dust (<1k lam):       ${validation.poolAbsorbedBySize.dust.toLocaleString()}`);
    console.log(`   - Tiny (1k-100k):       ${validation.poolAbsorbedBySize.tiny.toLocaleString()}`);
    console.log(`   - Small (100k-1M):      ${validation.poolAbsorbedBySize.small.toLocaleString()}`);
    console.log(`   - Medium (1M-10M):      ${validation.poolAbsorbedBySize.medium.toLocaleString()}`);
    console.log(`   - Large (>10M):         ${validation.poolAbsorbedBySize.large.toLocaleString()}`);

    console.log(`\n🎯 COMPETITOR DETECTION ISSUES`);
    console.log(`   Valid competitor:       ${validation.competitorDetectionIssues.validCompetitor.toLocaleString()}`);
    console.log(`   Gainer is pool:         ${validation.competitorDetectionIssues.gainerIsPool.toLocaleString()}`);
    console.log(`   Gainer is signer:       ${validation.competitorDetectionIssues.gainerIsSigner.toLocaleString()}`);
    console.log(`   No gainer found:        ${validation.competitorDetectionIssues.noGainer.toLocaleString()}`);

    // ========================================================================
    // PHASE 2: Sample Transaction Inspection
    // ========================================================================
    log("\n" + "=".repeat(80));
    log("PHASE 2: SAMPLE TRANSACTION INSPECTION");
    log("=".repeat(80));

    console.log(`\n🔍 INSPECTING POOL ABSORBED SAMPLES (${validation.samplePoolAbsorbed.length} txs)...`);
    const poolAbsorbedInspections: TxInspection[] = [];
    for (const sig of validation.samplePoolAbsorbed.slice(0, 5)) {
        const inspection = await inspectTransaction(sig);
        if (inspection) {
            poolAbsorbedInspections.push(inspection);
            console.log(`\n   ${sig.slice(0, 20)}...`);
            console.log(`   Programs: ${inspection.programs.join(" → ")}`);
            console.log(`   Signer Δ: ${lamportsToSol(inspection.signerSolDelta).toFixed(6)} SOL`);
            console.log(`   Top gainers:`);
            for (const d of inspection.allSolDeltas.slice(0, 3)) {
                const label = d.isPool ? "[POOL]" : "";
                console.log(`     ${d.pubkey.slice(0, 16)}... ${label}: ${lamportsToSol(d.delta).toFixed(6)} SOL`);
            }
        }
        await sleep(100);
    }

    console.log(`\n🔍 INSPECTING T3 BEATABLE SAMPLES (${validation.sampleT3Beatable.length} txs)...`);
    for (const sig of validation.sampleT3Beatable.slice(0, 5)) {
        const inspection = await inspectTransaction(sig);
        if (inspection) {
            console.log(`\n   ${sig.slice(0, 20)}...`);
            console.log(`   Programs: ${inspection.programs.join(" → ")}`);
            console.log(`   Signer Δ: ${lamportsToSol(inspection.signerSolDelta).toFixed(6)} SOL`);
            console.log(`   Is actual arb: ${inspection.isActualArb}`);
            console.log(`   Top gainers:`);
            for (const d of inspection.allSolDeltas.slice(0, 3)) {
                const label = d.isPool ? "[POOL]" : "";
                console.log(`     ${d.pubkey.slice(0, 16)}... ${label}: ${lamportsToSol(d.delta).toFixed(6)} SOL`);
            }
        }
        await sleep(100);
    }

    // ========================================================================
    // PHASE 3: Top Token Correlation
    // ========================================================================
    log("\n" + "=".repeat(80));
    log("PHASE 3: CROSS-VENUE CORRELATION");
    log("=".repeat(80));

    // Get top fractured tokens by loss
    const tokenLosses = new Map<string, number>();
    for (const e of events) {
        if (e.isPumpSwapLoss && e.pumpLossLamports && e.pumpMint && e.isTokenFractured) {
            tokenLosses.set(e.pumpMint, (tokenLosses.get(e.pumpMint) ?? 0) + e.pumpLossLamports);
        }
    }
    const topTokens = Array.from(tokenLosses.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

    console.log(`\n📊 Analyzing top ${topTokens.length} tokens by loss...`);

    const allCorrelations = new Map<string, ArbCorrelation[]>();

    for (const [mint, loss] of topTokens) {
        log(`   Correlating ${mint.slice(0, 16)}... (${lamportsToSol(loss).toFixed(4)} SOL loss)`);
        const { correlations } = await correlateArbsForToken(mint, events);
        allCorrelations.set(mint, correlations);

        const captured = correlations.filter((c) => c.status === "CAPTURED" || c.status === "SAME_BLOCK");
        const uncaptured = correlations.filter((c) => c.status === "UNCAPTURED");
        const sameBlock = correlations.filter((c) => c.status === "SAME_BLOCK");

        console.log(`      Total events: ${correlations.length}`);
        console.log(`      Captured: ${captured.length} (${sameBlock.length} same-block)`);
        console.log(`      Uncaptured: ${uncaptured.length}`);

        if (captured.length > 0) {
            const avgSlotDelta =
                captured.filter((c) => c.slotDelta !== null).reduce((sum, c) => sum + c.slotDelta!, 0) /
                captured.length;
            console.log(`      Avg slot latency: ${avgSlotDelta.toFixed(2)} slots`);
        }
    }

    // ========================================================================
    // PHASE 4: Arbitrageur Profiling
    // ========================================================================
    log("\n" + "=".repeat(80));
    log("PHASE 4: ARBITRAGEUR DEEP PROFILES");
    log("=".repeat(80));

    const arbProfiles = await profileArbitrageurs(events, 15);

    console.log(`\n🏆 TOP ARBITRAGEURS`);
    console.log(
        `${"Wallet".padEnd(24)} ${"Profit".padStart(14)} ${"Arbs".padStart(6)} ${"Jito".padStart(6)} ${"AvgCU".padStart(8)} Venues`
    );
    console.log("-".repeat(90));

    for (const [wallet, profile] of arbProfiles) {
        const topVenues = Object.entries(profile.venues)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([v]) => v.replace("V4", "").replace("DLMM", "").replace("Whirlpool", ""))
            .join("+");

        console.log(
            `${wallet.slice(0, 22)}.. ` +
            `${lamportsToSol(profile.totalProfitLamports).toFixed(4).padStart(14)} ` +
            `${profile.arbCount.toString().padStart(6)} ` +
            `${(profile.usesJito ? "YES" : "NO").padStart(6)} ` +
            `${profile.avgCU.toString().padStart(8)} ` +
            `${topVenues}`
        );
    }

    // ========================================================================
    // PHASE 5: Untapped Opportunities
    // ========================================================================
    log("\n" + "=".repeat(80));
    log("PHASE 5: TRUE UNTAPPED OPPORTUNITIES");
    log("=".repeat(80));

    const untapped = findUntappedOpportunities(events, allCorrelations);

    console.log(`\n💎 TOKENS WITH UNCAPTURED LOSSES`);
    console.log(
        `${"Mint".padEnd(24)} ${"Uncaptured".padStart(12)} ${"Total".padStart(12)} ${"Events".padStart(8)} ${"AvgLoss".padStart(10)} Reasons`
    );
    console.log("-".repeat(100));

    for (const opp of untapped.slice(0, 20)) {
        console.log(
            `${opp.mint.slice(0, 22)}.. ` +
            `${lamportsToSol(opp.noArbLossLamports).toFixed(4).padStart(12)} ` +
            `${lamportsToSol(opp.totalLossLamports).toFixed(4).padStart(12)} ` +
            `${opp.noArbEventCount.toString().padStart(8)} ` +
            `${lamportsToSol(opp.avgLossPerEvent).toFixed(6).padStart(10)} ` +
            `${opp.possibleReasons.join(", ")}`
        );
    }

    // ========================================================================
    // SUMMARY
    // ========================================================================
    log("\n" + "=".repeat(80));
    log("SUMMARY: DATA INTEGRITY ASSESSMENT");
    log("=".repeat(80));

    const totalPoolAbsorbedSOL = lamportsToSol(validation.poolAbsorbedTotalLamports);
    const dustPct = (validation.poolAbsorbedBySize.dust / Math.max(validation.poolAbsorbedEvents, 1)) * 100;

    console.log(`\n⚠️ KEY FINDINGS:`);

    if (dustPct > 90) {
        console.log(`   🔴 ${dustPct.toFixed(1)}% of "pool absorbed" events are DUST (<1000 lamports)`);
        console.log(`      → These are not real opportunities, just rounding/fee artifacts`);
    }

    if (validation.competitorDetectionIssues.gainerIsPool > validation.competitorDetectionIssues.validCompetitor * 0.1) {
        console.log(`   🔴 ${validation.competitorDetectionIssues.gainerIsPool} events misidentify POOL as competitor`);
        console.log(`      → Need to filter out pool addresses from gainer detection`);
    }

    const arbsWithJito = Array.from(arbProfiles.values()).filter((p) => p.usesJito).length;
    const arbsWithoutJito = arbProfiles.size - arbsWithJito;
    console.log(`\n   📊 Of top ${arbProfiles.size} arbitrageurs: ${arbsWithJito} use Jito, ${arbsWithoutJito} don't`);

    // Calculate REAL opportunity
    const realUncaptured = untapped
        .filter((o) => o.avgLossPerEvent > 100000) // > 0.0001 SOL avg
        .reduce((sum, o) => sum + o.noArbLossLamports, 0);

    console.log(`\n💰 REVISED OPPORTUNITY ESTIMATE:`);
    console.log(`   Original "pool absorbed":    ${totalPoolAbsorbedSOL.toFixed(4)} SOL`);
    console.log(`   After filtering dust:        ${lamportsToSol(realUncaptured).toFixed(4)} SOL`);
    console.log(`   Reduction:                   ${((1 - realUncaptured / validation.poolAbsorbedTotalLamports) * 100).toFixed(1)}%`);

    // Save detailed results
    const outputPath = path.join(DATA_DIR, "rigorous_analysis.json");
    const output = {
        validation,
        topTokenCorrelations: Object.fromEntries(
            Array.from(allCorrelations.entries()).map(([k, v]) => [k, v.slice(0, 50)])
        ),
        arbitrageurProfiles: Array.from(arbProfiles.values()).map((p) => ({
            ...p,
            tokensTouched: Array.from(p.tokensTouched),
        })),
        untappedOpportunities: untapped.slice(0, 50),
        summary: {
            originalPoolAbsorbedSOL: totalPoolAbsorbedSOL,
            realUncapturedSOL: lamportsToSol(realUncaptured),
            dustEventsPercent: dustPct,
            topArbsUsingJito: arbsWithJito,
            topArbsNoJito: arbsWithoutJito,
        },
    };
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    log(`\n💾 Saved detailed analysis: ${outputPath}`);
}

main().catch(console.error);