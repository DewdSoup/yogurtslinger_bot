// src/view_markets.ts v5.1
// DIAGNOSTIC MIRROR for yogurtslinger_bot
//
// PURPOSE: Report CANDIDATE QUALITY for opportunities the bot might execute.
// This reads the snapshot written by ingest.ts and uses the EXACT SAME
// fee constants as fragmentationArb.ts / ArbBrain.
//
// v5.1 CHANGES:
//   - Auto-detect latest run directory for snapshot reading
//   - Fixed raydiumV4Pools field name consistency
//
// v5.0 CHANGES:
//   - Added Raydium CLMM support
//   - Enhanced venue pair tracking
//   - Better fee display for dynamic-fee venues
//   - Added CLMM-specific fields (tickCurrent, sqrtPriceX64)
//
// IMPORTANT: This tool tracks GROSS SPREAD and ESTIMATED NET SPREAD.
// Actual profitability is ONLY known after RPC simulation in the execution path.
// The SimGate in executionEngine.ts determines true profit with slippage.
//
// This is NOT the execution path - it's a monitoring/debugging tool.

import { promises as fs } from "node:fs";
import path from "node:path";

// ============================================================================
// FEE CONSTANTS - MUST MATCH ingest.ts AND fragmentationArb.ts / ArbBrain EXACTLY
// ============================================================================

// PumpSwap: 0.30% total (0.20% LP + 0.05% protocol + 0.05% creator)
const PUMPSWAP_FEE = 0.0030;
const PUMPSWAP_FEE_BPS = 30;

// Raydium V4: 0.25% (0.22% LP + 0.03% RAY buybacks)
const RAYDIUM_FEE = 0.0025;
const RAYDIUM_FEE_BPS = 25;

// Raydium CLMM: Dynamic via AmmConfig (0.01%, 0.05%, 0.25%, 1%)
// Using 0.25% as default until we fetch actual AmmConfig
const RAYDIUM_CLMM_FEE = 0.0025;
const RAYDIUM_CLMM_FEE_BPS = 25;

// Meteora: Dynamic - read from pool state (exactFee field in snapshot)
const METEORA_DEFAULT_FEE_BPS = 100;

// Maximum Meteora fee for tradeable pools
const MAX_METEORA_FEE = 0.05; // 5%

// Minimum spread to consider as a simulation candidate
const MIN_SPREAD_TO_SIMULATE_BPS = 55;

// Minimum estimated net spread to display
const MIN_CANDIDATE_QUALITY_BPS = 50;

// ============================================================================
// CONFIGURATION
// ============================================================================

const RUNS_DIR = path.resolve(process.cwd(), "src", "data", "runs");
const FALLBACK_SNAPSHOT_FILE = path.resolve(process.cwd(), "data", "markets_snapshot.json");
const EVENTS_FILE_NAME = "markets_events.jsonl";

const REFRESH_INTERVAL_MS = 2000;
const TERMINAL_SUMMARY_INTERVAL_MS = 10000;
const SNAPSHOT_SAVE_INTERVAL_MS = 30000;

// Current snapshot file path (updated dynamically)
let SNAPSHOT_FILE = FALLBACK_SNAPSHOT_FILE;

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface PumpSwapPool {
    pubkey: string;
    slot: string;
    firstSeenTs: number;
    lastUpdatedTs: number;
    createdSlot: string | null;
    createdTs: number | null;
    detectedDuringSync: boolean;
    index: number;
    creator: string;
    baseMint: string;
    quoteMint: string;
    lpMint: string;
    poolBaseTokenAccount: string;
    poolQuoteTokenAccount: string;
    baseVaultBalance: string | null;
    quoteVaultBalance: string | null;
    priceSolPerToken: string | null;
    quoteType: string;
    fee: number;
    lpSupply: string;
    tokenMint: string | null;
}

interface RaydiumPool {
    pubkey: string;
    slot: string;
    firstSeenTs: number;
    lastUpdatedTs: number;
    createdSlot: string | null;
    createdTs: number | null;
    detectedDuringSync: boolean;
    lpMint: string;
    baseMint: string;
    quoteMint: string;
    baseVault: string | null;
    quoteVault: string | null;
    baseVaultBalance: string | null;
    quoteVaultBalance: string | null;
    priceSolPerToken: string | null;
    quoteType: string;
    fee: number;
    status: number | null;
    openTime: number | null;
    tokenMint: string | null;
}

// NEW: Raydium CLMM pool type
interface RaydiumCLMMPool {
    pubkey: string;
    slot: string;
    firstSeenTs: number;
    lastUpdatedTs: number;
    createdSlot: string | null;
    createdTs: number | null;
    detectedDuringSync: boolean;
    tokenMint0: string;
    tokenMint1: string;
    tokenVault0: string;
    tokenVault1: string;
    vault0Balance: string | null;
    vault1Balance: string | null;
    sqrtPriceX64: string;
    tickCurrent: number;
    tickSpacing: number;
    liquidity: string;
    status: number;
    ammConfig: string;
    priceSolPerToken: string | null;
    quoteType: string;
    fee: number;  // From AmmConfig or default
    tokenMint: string | null;  // Non-SOL token
}

interface MeteoraPool {
    pubkey: string;
    slot: string;
    firstSeenTs: number;
    lastUpdatedTs: number;
    createdSlot: string | null;
    createdTs: number | null;
    detectedDuringSync: boolean;
    tokenXMint: string;
    tokenYMint: string;
    reserveX: string;
    reserveY: string;
    reserveXBalance: string | null;
    reserveYBalance: string | null;
    activeId: number;
    binStep: number;
    status: number;
    pairType: number;
    priceQuotePerToken: string;
    priceSolPerToken: string | null;
    quoteType: "SOL" | "USDC" | "USDT";
    quoteMint: string;
    baseFactor: number;
    variableFeeControl: number;
    volatilityAccumulator: number;
    protocolShare: number;
    baseFeeRate: number;
    variableFeeRate: number;
    totalFeeRate: number;
    exactFee: number;
    isTradeable: boolean;
    tokenMint: string | null;
}

interface Snapshot {
    generatedAt: string;
    runId?: string;
    runDir?: string;
    stats: {
        trackedVaults: number;
        cachedVaultBalances: number;
        initialSyncComplete: boolean;
        solUsdPrice: number;
        lastSolUsdUpdate: number;
        fees?: {
            pumpSwap: number;
            raydium: number;
            raydiumClmm?: number;
            meteoraNote?: string;
        };
        meteora?: {
            totalPools: number;
            tradeablePools: number;
            highFeePools: number;
            tradeablePercent: string;
        };
        raydiumClmm?: {
            totalPools: number;
            activePools: number;
        };
    };
    pumpCurves: unknown[];
    pumpSwapPools: PumpSwapPool[];
    raydiumV4Pools: RaydiumPool[];
    raydiumClmmPools?: RaydiumCLMMPool[];
    meteoraPools: MeteoraPool[];
}

type VenueType = "pumpswap" | "raydium" | "raydiumclmm" | "meteora";

// FIXED: Added undefined to optional property types for exactOptionalPropertyTypes
interface ArbitrageCandidate {
    tokenMint: string;
    buyVenue: VenueType;
    sellVenue: VenueType;
    buyPool: string;
    sellPool: string;
    buyPrice: number;
    sellPrice: number;
    spreadBps: number;
    buyFeeBps: number;
    sellFeeBps: number;
    estimatedNetSpreadBps: number;
    candidateQuality: "high" | "medium" | "low";
    buyLastUpdatedTs: number;
    sellLastUpdatedTs: number;
    buyCreatedTs: number | null;
    sellCreatedTs: number | null;
    isNewlyCreated: boolean;
    quoteType: "SOL" | "USDC" | "USDT";
    dataAgeMs: number;
    timeSinceCreationMs: number | null;
    // New: venue-specific metadata - allow undefined for exactOptionalPropertyTypes
    clmmTick?: number | undefined;
    meteoraBinStep?: number | undefined;
}

interface RunSnapshot {
    timestamp: string;
    snapshotNumber: number;
    snapshotAgeMs: number;
    solUsdPrice: number;
    syncStatus: "LIVE" | "SYNC";
    feeConstants: {
        pumpswap: number;
        raydium: number;
        raydiumClmm: number;
        meteoraMax: number;
        minSpreadToSimulate: number;
        minCandidateQuality: number;
    };
    markets: {
        pumpSwap: number;
        raydium: number;
        raydiumClmm: number;
        raydiumClmmActive: number;
        meteora: number;
        meteoraTradeable: number;
        meteoraHighFee: number;
    };
    vaultTracking: {
        trackedVaults: number;
        cachedBalances: number;
    };
    fragments: {
        total: number;
        withPumpSwap: number;
        withRaydium: number;
        withRaydiumClmm: number;
        withMeteora: number;
    };
    candidates: {
        total: number;
        highQuality: number;
        mediumQuality: number;
        lowQuality: number;
        newlyCreated: number;
        solPairs: number;
        stablePairs: number;
    };
    topCandidates: ArbitrageCandidate[];
}

interface VenuePriceInfo {
    venue: VenueType;
    pool: string;
    price: number;
    feeBps: number;
    lastUpdatedTs: number;
    createdTs: number | null;
    isNewlyCreated: boolean;
    quoteType: "SOL" | "USDC" | "USDT";
    quoteLiquidity: number;
    // CLMM-specific
    tickCurrent?: number | undefined;
    // Meteora-specific
    binStep?: number | undefined;
}

interface MarketRoute {
    buyVenue: VenueType;
    sellVenue: VenueType;
    buyPool: string;
    sellPool: string;
    buyPrice: number;
    sellPrice: number;
    spreadBps: number;
    venueFeesBps: number;
    estimatedNetSpreadBps: number;
    isCandidate: boolean;
}

interface MarketEvent {
    ts: string;
    runId: string;
    snapshotNumber: number;
    snapshotGeneratedAt: string;
    snapshotAgeMs: number;
    tokenMint: string;
    venues: VenuePriceInfo[];
    bestRoute?: MarketRoute | undefined;
}

interface RunMetadata {
    runId: string;
    startTime: string;
    snapshotCount: number;
    lastSnapshotTime: string;
    feeConstants: {
        pumpswap: number;
        raydium: number;
        raydiumClmm: number;
    };
    bestSpreadBps: number | null;
    totalCandidatesSeen: number;
}

// ============================================================================
// GLOBAL STATE
// ============================================================================

let runId: string = "";
let runDir: string = "";
let runStartTime: string = "";
let snapshotCount = 0;
let lastTerminalPrint = 0;
let lastFileSave = 0;
let solUsdPrice = 0;

const tokenFirstSeen = new Map<string, number>();
let totalCandidatesSeen = 0;
let bestSpreadBpsEver: number | null = null;

const recentSnapshots: RunSnapshot[] = [];
const MAX_MEMORY_SNAPSHOTS = 100;

// Track which ingest run we're reading from
let currentIngestRunId: string | null = null;

// Whether we're using an ingest directory (true) or our own standalone directory (false)
let usingIngestDir = false;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function formatAge(ms: number): string {
    if (ms < 0) return "?";
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m${remainingSeconds}s` : `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h${remainingMinutes}m` : `${hours}h`;
}

function formatPrice(price: number): string {
    if (price >= 0.01) return price.toFixed(6);
    if (price >= 0.0001) return price.toFixed(8);
    return price.toExponential(4);
}

function formatBps(bps: number): string {
    const pct = bps / 100;
    if (Math.abs(pct) >= 1) return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
    return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

function getQualityIcon(quality: string): string {
    if (quality === "high") return "🟢";
    if (quality === "medium") return "🟡";
    return "🔴";
}

function getSpreadIcon(estimatedNetSpreadBps: number): string {
    if (estimatedNetSpreadBps >= 200) return "🚀";
    if (estimatedNetSpreadBps >= 100) return "🔥";
    if (estimatedNetSpreadBps >= 50) return "✅";
    if (estimatedNetSpreadBps >= 0) return "⚡";
    return "❌";
}

function getAgeIcon(isNew: boolean, ageMs: number | null): string {
    if (isNew && ageMs !== null && ageMs < 60000) return "🆕";
    if (isNew && ageMs !== null && ageMs < 300000) return "⏰";
    return "📦";
}

function getVenueShort(venue: VenueType): string {
    switch (venue) {
        case "pumpswap": return "PS";
        case "raydium": return "Ray";
        case "raydiumclmm": return "CLMM";
        case "meteora": return "Met";
    }
}

// ============================================================================
// SNAPSHOT FILE DISCOVERY
// ============================================================================

async function getLatestSnapshotFile(): Promise<string> {
    try {
        const dirs = await fs.readdir(RUNS_DIR);
        // Filter out hidden files and sort reverse chronologically
        const sorted = dirs.filter(d => !d.startsWith(".")).sort().reverse();

        for (const dir of sorted) {
            const snapshotPath = path.join(RUNS_DIR, dir, "markets_snapshot.json");
            try {
                await fs.access(snapshotPath);
                // Found a valid snapshot
                if (currentIngestRunId !== dir) {
                    currentIngestRunId = dir;
                    console.log(`[view_markets] 📂 Reading from ingest run: ${dir}`);
                    
                    // Also use this directory for our output files (unified run directory)
                    runId = dir;
                    runDir = path.join(RUNS_DIR, dir);
                    usingIngestDir = true;
                }
                return snapshotPath;
            } catch {
                // Snapshot doesn't exist in this dir, try next
                continue;
            }
        }
    } catch {
        // RUNS_DIR doesn't exist
    }

    // Fallback to old location
    return FALLBACK_SNAPSHOT_FILE;
}

// ============================================================================
// FILE OPERATIONS
// ============================================================================

async function initializeRun(): Promise<void> {
    // First check if we already detected an ingest directory
    await getLatestSnapshotFile();
    
    if (usingIngestDir && runDir) {
        // Use the existing ingest run directory - don't create a new one
        runStartTime = new Date().toISOString();
        console.log(`[view_markets] ✅ Using ingest run directory: ${runDir}`);
        // Don't create metadata.json - let ingest own the directory
        return;
    }
    
    // Standalone mode - no ingest running, create our own directory
    console.log(`[view_markets] ⚠️ No ingest run found, creating standalone directory`);
    runId = new Date().toISOString().replace(/[:.]/g, "-");
    runDir = path.join(RUNS_DIR, runId);
    runStartTime = new Date().toISOString();

    await fs.mkdir(runDir, { recursive: true });

    const metadata: RunMetadata = {
        runId,
        startTime: runStartTime,
        snapshotCount: 0,
        lastSnapshotTime: runStartTime,
        feeConstants: {
            pumpswap: PUMPSWAP_FEE_BPS,
            raydium: RAYDIUM_FEE_BPS,
            raydiumClmm: RAYDIUM_CLMM_FEE_BPS
        },
        bestSpreadBps: null,
        totalCandidatesSeen: 0
    };

    await fs.writeFile(
        path.join(runDir, "metadata.json"),
        JSON.stringify(metadata, null, 2)
    );

    console.log(`[view_markets] Run initialized: ${runId}`);
    console.log(`[view_markets] Data directory: ${runDir}`);
}

async function saveRunSnapshot(
    snapshot: RunSnapshot,
    marketEvents: MarketEvent[]
): Promise<void> {
    try {
        await fs.writeFile(
            path.join(runDir, "latest.json"),
            JSON.stringify(snapshot, null, 2)
        );

        if (marketEvents.length > 0) {
            const eventsPath = path.join(runDir, EVENTS_FILE_NAME);
            const lines = marketEvents
                .map((e) => JSON.stringify(e))
                .join("\n") + "\n";
            await fs.appendFile(eventsPath, lines, "utf-8");
        }

        const metadata: RunMetadata = {
            runId,
            startTime: runStartTime,
            snapshotCount: snapshot.snapshotNumber,
            lastSnapshotTime: snapshot.timestamp,
            feeConstants: {
                pumpswap: PUMPSWAP_FEE_BPS,
                raydium: RAYDIUM_FEE_BPS,
                raydiumClmm: RAYDIUM_CLMM_FEE_BPS
            },
            bestSpreadBps: bestSpreadBpsEver,
            totalCandidatesSeen
        };
        await fs.writeFile(
            path.join(runDir, "metadata.json"),
            JSON.stringify(metadata, null, 2)
        );
    } catch (err) {
        console.error("[view_markets] Failed to save snapshot:", err);
    }
}

// ============================================================================
// SNAPSHOT PROCESSING
// ============================================================================

async function loadSnapshot(): Promise<Snapshot | null> {
    try {
        // Always check for latest run directory
        SNAPSHOT_FILE = await getLatestSnapshotFile();
        const data = await fs.readFile(SNAPSHOT_FILE, "utf-8");
        return JSON.parse(data) as Snapshot;
    } catch {
        return null;
    }
}

function getVenueFeeBps(
    venue: VenueType,
    meteoraExactFee?: number,
    clmmFee?: number
): number {
    if (venue === "pumpswap") return PUMPSWAP_FEE_BPS;
    if (venue === "raydium") return RAYDIUM_FEE_BPS;
    if (venue === "raydiumclmm") {
        return clmmFee !== undefined ? Math.round(clmmFee * 10000) : RAYDIUM_CLMM_FEE_BPS;
    }
    if (venue === "meteora" && meteoraExactFee !== undefined) {
        return Math.round(meteoraExactFee * 10000);
    }
    return METEORA_DEFAULT_FEE_BPS;
}

function findArbitrageCandidates(snapshot: Snapshot): ArbitrageCandidate[] {
    const now = Date.now();
    solUsdPrice = snapshot.stats.solUsdPrice || 0;

    interface VenueInfo {
        pumpSwap?: PumpSwapPool;
        raydium?: RaydiumPool;
        raydiumClmm?: RaydiumCLMMPool;
        meteora?: MeteoraPool;
    }

    const tokenVenues = new Map<string, VenueInfo>();

    // Index PumpSwap pools
    for (const pool of snapshot.pumpSwapPools) {
        if (!pool.tokenMint || !pool.priceSolPerToken) continue;
        const price = parseFloat(pool.priceSolPerToken);
        if (price <= 0) continue;

        const existing = tokenVenues.get(pool.tokenMint) || {};
        existing.pumpSwap = pool;
        tokenVenues.set(pool.tokenMint, existing);
    }

    // Index Raydium V4 pools
    for (const pool of snapshot.raydiumV4Pools) {
        if (!pool.tokenMint || !pool.priceSolPerToken) continue;
        const price = parseFloat(pool.priceSolPerToken);
        if (price <= 0) continue;

        const existing = tokenVenues.get(pool.tokenMint) || {};
        existing.raydium = pool;
        tokenVenues.set(pool.tokenMint, existing);
    }

    // Index Raydium CLMM pools (NEW)
    if (snapshot.raydiumClmmPools) {
        for (const pool of snapshot.raydiumClmmPools) {
            if (!pool.tokenMint || !pool.priceSolPerToken) continue;
            // CLMM status=0 means active
            if (pool.status !== 0) continue;
            const price = parseFloat(pool.priceSolPerToken);
            if (price <= 0) continue;

            const existing = tokenVenues.get(pool.tokenMint) || {};
            existing.raydiumClmm = pool;
            tokenVenues.set(pool.tokenMint, existing);
        }
    }

    // Index Meteora pools
    for (const pool of snapshot.meteoraPools) {
        if (!pool.tokenMint || !pool.priceSolPerToken) continue;
        if (!pool.isTradeable) continue;
        const price = parseFloat(pool.priceSolPerToken);
        if (price <= 0 || price > 1000 || price < 1e-12) continue;

        const existing = tokenVenues.get(pool.tokenMint) || {};
        existing.meteora = pool;
        tokenVenues.set(pool.tokenMint, existing);
    }

    const candidates: ArbitrageCandidate[] = [];

    for (const [tokenMint, venues] of tokenVenues) {
        const venueCount =
            (venues.pumpSwap ? 1 : 0) +
            (venues.raydium ? 1 : 0) +
            (venues.raydiumClmm ? 1 : 0) +
            (venues.meteora ? 1 : 0);

        if (venueCount < 2) continue;

        if (!tokenFirstSeen.has(tokenMint)) {
            tokenFirstSeen.set(tokenMint, now);
            totalCandidatesSeen++;
        }

        interface PriceInfo {
            venue: VenueType;
            pool: string;
            price: number;
            feeBps: number;
            lastUpdatedTs: number;
            createdTs: number | null;
            isNewlyCreated: boolean;
            quoteType: "SOL" | "USDC" | "USDT";
            tickCurrent?: number;
            binStep?: number;
        }

        const prices: PriceInfo[] = [];

        if (venues.pumpSwap) {
            const price = parseFloat(venues.pumpSwap.priceSolPerToken!);
            const quoteBalance = venues.pumpSwap.quoteVaultBalance
                ? parseFloat(venues.pumpSwap.quoteVaultBalance)
                : 0;
            if (quoteBalance > 0.1 * 1e9) {
                prices.push({
                    venue: "pumpswap",
                    pool: venues.pumpSwap.pubkey,
                    price,
                    feeBps: PUMPSWAP_FEE_BPS,
                    lastUpdatedTs: venues.pumpSwap.lastUpdatedTs,
                    createdTs: venues.pumpSwap.createdTs,
                    isNewlyCreated: !venues.pumpSwap.detectedDuringSync,
                    quoteType: "SOL"
                });
            }
        }

        if (venues.raydium) {
            const price = parseFloat(venues.raydium.priceSolPerToken!);
            const quoteBalance = venues.raydium.quoteVaultBalance
                ? parseFloat(venues.raydium.quoteVaultBalance)
                : 0;
            if (quoteBalance > 0.1 * 1e9) {
                prices.push({
                    venue: "raydium",
                    pool: venues.raydium.pubkey,
                    price,
                    feeBps: RAYDIUM_FEE_BPS,
                    lastUpdatedTs: venues.raydium.lastUpdatedTs,
                    createdTs: venues.raydium.createdTs,
                    isNewlyCreated: !venues.raydium.detectedDuringSync,
                    quoteType: "SOL"
                });
            }
        }

        // NEW: Raydium CLMM
        if (venues.raydiumClmm) {
            const price = parseFloat(venues.raydiumClmm.priceSolPerToken!);
            const vault0Bal = venues.raydiumClmm.vault0Balance
                ? parseFloat(venues.raydiumClmm.vault0Balance)
                : 0;
            const vault1Bal = venues.raydiumClmm.vault1Balance
                ? parseFloat(venues.raydiumClmm.vault1Balance)
                : 0;
            const hasLiquidity = vault0Bal > 0.1 * 1e9 || vault1Bal > 0.1 * 1e9;

            if (hasLiquidity) {
                prices.push({
                    venue: "raydiumclmm",
                    pool: venues.raydiumClmm.pubkey,
                    price,
                    feeBps: getVenueFeeBps("raydiumclmm", undefined, venues.raydiumClmm.fee),
                    lastUpdatedTs: venues.raydiumClmm.lastUpdatedTs,
                    createdTs: venues.raydiumClmm.createdTs,
                    isNewlyCreated: !venues.raydiumClmm.detectedDuringSync,
                    quoteType: "SOL",
                    tickCurrent: venues.raydiumClmm.tickCurrent
                });
            }
        }

        if (venues.meteora) {
            const price = parseFloat(venues.meteora.priceSolPerToken!);
            const exactFeeBps = getVenueFeeBps("meteora", venues.meteora.exactFee);

            const reserveXBal = venues.meteora.reserveXBalance
                ? parseFloat(venues.meteora.reserveXBalance)
                : 0;
            const reserveYBal = venues.meteora.reserveYBalance
                ? parseFloat(venues.meteora.reserveYBalance)
                : 0;
            const hasLiquidity = reserveXBal > 0.1 * 1e9 || reserveYBal > 0.1 * 1e9;

            if (hasLiquidity) {
                prices.push({
                    venue: "meteora",
                    pool: venues.meteora.pubkey,
                    price,
                    feeBps: exactFeeBps,
                    lastUpdatedTs: venues.meteora.lastUpdatedTs,
                    createdTs: venues.meteora.createdTs,
                    isNewlyCreated: !venues.meteora.detectedDuringSync,
                    quoteType: venues.meteora.quoteType,
                    binStep: venues.meteora.binStep
                });
            }
        }

        if (prices.length < 2) continue;

        const sorted = prices.slice().sort((a, b) => a.price - b.price);
        const cheapest = sorted[0]!;
        const mostExpensive = sorted[sorted.length - 1]!;

        if (cheapest.venue === mostExpensive.venue) continue;

        const spread = mostExpensive.price - cheapest.price;
        const spreadBps = Math.round((spread / cheapest.price) * 10000);

        if (bestSpreadBpsEver === null || spreadBps > bestSpreadBpsEver) {
            bestSpreadBpsEver = spreadBps;
        }

        const venueFeesBps = cheapest.feeBps + mostExpensive.feeBps;
        const estimatedNetSpreadBps = spreadBps - venueFeesBps;

        if (spreadBps < MIN_SPREAD_TO_SIMULATE_BPS) continue;
        if (estimatedNetSpreadBps < MIN_CANDIDATE_QUALITY_BPS) continue;

        const dataAgeMs =
            now - Math.max(cheapest.lastUpdatedTs, mostExpensive.lastUpdatedTs);

        const newerCreatedTs =
            cheapest.createdTs !== null && mostExpensive.createdTs !== null
                ? Math.max(cheapest.createdTs, mostExpensive.createdTs)
                : (cheapest.createdTs ?? mostExpensive.createdTs);

        const timeSinceCreationMs =
            newerCreatedTs !== null ? now - newerCreatedTs : null;

        let candidateQuality: "high" | "medium" | "low";
        if (estimatedNetSpreadBps > 200) {
            candidateQuality = "high";
        } else if (estimatedNetSpreadBps > 100) {
            candidateQuality = "medium";
        } else {
            candidateQuality = "low";
        }

        // FIXED: Build candidate object carefully for exactOptionalPropertyTypes
        const candidate: ArbitrageCandidate = {
            tokenMint,
            buyVenue: cheapest.venue,
            sellVenue: mostExpensive.venue,
            buyPool: cheapest.pool,
            sellPool: mostExpensive.pool,
            buyPrice: cheapest.price,
            sellPrice: mostExpensive.price,
            spreadBps,
            buyFeeBps: cheapest.feeBps,
            sellFeeBps: mostExpensive.feeBps,
            estimatedNetSpreadBps,
            candidateQuality,
            buyLastUpdatedTs: cheapest.lastUpdatedTs,
            sellLastUpdatedTs: mostExpensive.lastUpdatedTs,
            buyCreatedTs: cheapest.createdTs,
            sellCreatedTs: mostExpensive.createdTs,
            isNewlyCreated:
                cheapest.isNewlyCreated || mostExpensive.isNewlyCreated,
            quoteType: mostExpensive.quoteType,
            dataAgeMs,
            timeSinceCreationMs
        };

        // Only add optional properties if they have values
        const clmmTick = cheapest.tickCurrent ?? mostExpensive.tickCurrent;
        if (clmmTick !== undefined) {
            candidate.clmmTick = clmmTick;
        }

        const meteoraBinStep = cheapest.binStep ?? mostExpensive.binStep;
        if (meteoraBinStep !== undefined) {
            candidate.meteoraBinStep = meteoraBinStep;
        }

        candidates.push(candidate);
    }

    candidates.sort((a, b) => b.estimatedNetSpreadBps - a.estimatedNetSpreadBps);
    return candidates.slice(0, 50);
}

function buildMarketEvents(
    snapshot: Snapshot,
    snapshotNumber: number,
    snapshotAgeMs: number
): MarketEvent[] {
    interface VenueInfo {
        pumpSwap?: PumpSwapPool;
        raydium?: RaydiumPool;
        raydiumClmm?: RaydiumCLMMPool;
        meteora?: MeteoraPool;
    }

    const tokenVenues = new Map<string, VenueInfo>();

    for (const pool of snapshot.pumpSwapPools) {
        if (!pool.tokenMint || !pool.priceSolPerToken) continue;
        const price = parseFloat(pool.priceSolPerToken);
        if (price <= 0) continue;
        const existing = tokenVenues.get(pool.tokenMint) || {};
        existing.pumpSwap = pool;
        tokenVenues.set(pool.tokenMint, existing);
    }

    for (const pool of snapshot.raydiumV4Pools) {
        if (!pool.tokenMint || !pool.priceSolPerToken) continue;
        const price = parseFloat(pool.priceSolPerToken);
        if (price <= 0) continue;
        const existing = tokenVenues.get(pool.tokenMint) || {};
        existing.raydium = pool;
        tokenVenues.set(pool.tokenMint, existing);
    }

    if (snapshot.raydiumClmmPools) {
        for (const pool of snapshot.raydiumClmmPools) {
            if (!pool.tokenMint || !pool.priceSolPerToken) continue;
            if (pool.status !== 0) continue;
            const price = parseFloat(pool.priceSolPerToken);
            if (price <= 0) continue;
            const existing = tokenVenues.get(pool.tokenMint) || {};
            existing.raydiumClmm = pool;
            tokenVenues.set(pool.tokenMint, existing);
        }
    }

    for (const pool of snapshot.meteoraPools) {
        if (!pool.tokenMint || !pool.priceSolPerToken) continue;
        if (!pool.isTradeable) continue;
        const price = parseFloat(pool.priceSolPerToken);
        if (price <= 0 || price > 1000 || price < 1e-12) continue;
        const existing = tokenVenues.get(pool.tokenMint) || {};
        existing.meteora = pool;
        tokenVenues.set(pool.tokenMint, existing);
    }

    const events: MarketEvent[] = [];

    for (const [tokenMint, venues] of tokenVenues) {
        const venueCount =
            (venues.pumpSwap ? 1 : 0) +
            (venues.raydium ? 1 : 0) +
            (venues.raydiumClmm ? 1 : 0) +
            (venues.meteora ? 1 : 0);

        const allVenues: VenuePriceInfo[] = [];

        if (venues.pumpSwap?.priceSolPerToken) {
            const p = venues.pumpSwap;
            const price = parseFloat(p.priceSolPerToken!);
            if (price > 0) {
                const quoteBal = p.quoteVaultBalance
                    ? parseFloat(p.quoteVaultBalance)
                    : 0;
                allVenues.push({
                    venue: "pumpswap",
                    pool: p.pubkey,
                    price,
                    feeBps: PUMPSWAP_FEE_BPS,
                    lastUpdatedTs: p.lastUpdatedTs,
                    createdTs: p.createdTs,
                    isNewlyCreated: !p.detectedDuringSync,
                    quoteType: "SOL",
                    quoteLiquidity: quoteBal
                });
            }
        }

        if (venues.raydium?.priceSolPerToken) {
            const p = venues.raydium;
            const price = parseFloat(p.priceSolPerToken!);
            if (price > 0) {
                const quoteBal = p.quoteVaultBalance
                    ? parseFloat(p.quoteVaultBalance)
                    : 0;
                allVenues.push({
                    venue: "raydium",
                    pool: p.pubkey,
                    price,
                    feeBps: RAYDIUM_FEE_BPS,
                    lastUpdatedTs: p.lastUpdatedTs,
                    createdTs: p.createdTs,
                    isNewlyCreated: !p.detectedDuringSync,
                    quoteType: "SOL",
                    quoteLiquidity: quoteBal
                });
            }
        }

        if (venues.raydiumClmm?.priceSolPerToken) {
            const p = venues.raydiumClmm;
            const price = parseFloat(p.priceSolPerToken!);
            if (price > 0) {
                const vault0Bal = p.vault0Balance ? parseFloat(p.vault0Balance) : 0;
                const vault1Bal = p.vault1Balance ? parseFloat(p.vault1Balance) : 0;
                const venueInfo: VenuePriceInfo = {
                    venue: "raydiumclmm",
                    pool: p.pubkey,
                    price,
                    feeBps: getVenueFeeBps("raydiumclmm", undefined, p.fee),
                    lastUpdatedTs: p.lastUpdatedTs,
                    createdTs: p.createdTs,
                    isNewlyCreated: !p.detectedDuringSync,
                    quoteType: "SOL",
                    quoteLiquidity: vault0Bal + vault1Bal
                };
                if (p.tickCurrent !== undefined) {
                    venueInfo.tickCurrent = p.tickCurrent;
                }
                allVenues.push(venueInfo);
            }
        }

        if (venues.meteora?.priceSolPerToken) {
            const p = venues.meteora;
            const price = parseFloat(p.priceSolPerToken!);
            if (price > 0 && price <= 1000 && price >= 1e-12) {
                const exactFeeBps = getVenueFeeBps("meteora", p.exactFee);
                const reserveXBal = p.reserveXBalance
                    ? parseFloat(p.reserveXBalance)
                    : 0;
                const reserveYBal = p.reserveYBalance
                    ? parseFloat(p.reserveYBalance)
                    : 0;
                const venueInfo: VenuePriceInfo = {
                    venue: "meteora",
                    pool: p.pubkey,
                    price,
                    feeBps: exactFeeBps,
                    lastUpdatedTs: p.lastUpdatedTs,
                    createdTs: p.createdTs,
                    isNewlyCreated: !p.detectedDuringSync,
                    quoteType: p.quoteType,
                    quoteLiquidity: reserveXBal + reserveYBal
                };
                if (p.binStep !== undefined) {
                    venueInfo.binStep = p.binStep;
                }
                allVenues.push(venueInfo);
            }
        }

        if (allVenues.length === 0) continue;

        let bestRoute: MarketRoute | undefined = undefined;

        if (venueCount >= 2 && allVenues.length >= 2) {
            const sorted = allVenues.slice().sort((a, b) => a.price - b.price);
            const cheapest = sorted[0]!;
            const mostExpensive = sorted[sorted.length - 1]!;

            if (cheapest.venue !== mostExpensive.venue) {
                const spread = mostExpensive.price - cheapest.price;
                const spreadBps = Math.round((spread / cheapest.price) * 10000);
                const venueFeesBps = cheapest.feeBps + mostExpensive.feeBps;
                const estimatedNetSpreadBps = spreadBps - venueFeesBps;

                bestRoute = {
                    buyVenue: cheapest.venue,
                    sellVenue: mostExpensive.venue,
                    buyPool: cheapest.pool,
                    sellPool: mostExpensive.pool,
                    buyPrice: cheapest.price,
                    sellPrice: mostExpensive.price,
                    spreadBps,
                    venueFeesBps,
                    estimatedNetSpreadBps,
                    isCandidate: spreadBps >= MIN_SPREAD_TO_SIMULATE_BPS &&
                        estimatedNetSpreadBps >= MIN_CANDIDATE_QUALITY_BPS
                };
            }
        }

        const event: MarketEvent = {
            ts: new Date().toISOString(),
            runId,
            snapshotNumber,
            snapshotGeneratedAt: snapshot.generatedAt,
            snapshotAgeMs,
            tokenMint,
            venues: allVenues
        };

        if (bestRoute !== undefined) {
            event.bestRoute = bestRoute;
        }

        events.push(event);
    }

    return events;
}

// ============================================================================
// DISPLAY
// ============================================================================

function renderTerminalSummary(
    snapshot: Snapshot,
    candidates: ArbitrageCandidate[]
): void {
    const now = new Date();
    const timeStr = now.toTimeString().slice(0, 8);
    const snapshotTs = new Date(snapshot.generatedAt).getTime();
    const snapshotAgeMs = now.getTime() - snapshotTs;
    const solPriceStr = solUsdPrice > 0 ? `$${solUsdPrice.toFixed(2)}` : "N/A";

    const highQuality = candidates.filter(c => c.candidateQuality === "high").length;
    const medQuality = candidates.filter(c => c.candidateQuality === "medium").length;
    const lowQuality = candidates.filter(c => c.candidateQuality === "low").length;
    const solPairs = candidates.filter(c => c.quoteType === "SOL").length;
    const stablePairs = candidates.filter(c => c.quoteType !== "SOL").length;
    const newlyCreated = candidates.filter(c => c.isNewlyCreated).length;

    const syncStatus = snapshot.stats.initialSyncComplete ? "LIVE" : "SYNC";
    const meteoraStats = snapshot.stats.meteora;
    const clmmStats = snapshot.stats.raydiumClmm;
    const clmmPoolCount = snapshot.raydiumClmmPools?.length ?? 0;

    console.clear();
    console.log(
        `🥛 YOGURTSLINGER DIAGNOSTIC MIRROR v5.1 │ ${timeStr} │ SOL: ${solPriceStr} │ [${syncStatus}]`
    );
    console.log("━".repeat(120));

    console.log(
        `📋 Fees: PS=${(PUMPSWAP_FEE * 100).toFixed(2)}% Ray=${(RAYDIUM_FEE * 100).toFixed(2)}% CLMM=${(RAYDIUM_CLMM_FEE * 100).toFixed(2)}% Met=dynamic │ ` +
        `MinSpread=${MIN_SPREAD_TO_SIMULATE_BPS}bps MinQuality=${MIN_CANDIDATE_QUALITY_BPS}bps`
    );

    const metInfo = meteoraStats
        ? `Met=${snapshot.meteoraPools.length} (${meteoraStats.tradeablePools} tradeable)`
        : `Met=${snapshot.meteoraPools.length}`;
    const clmmInfo = clmmStats
        ? `CLMM=${clmmPoolCount} (${clmmStats.activePools} active)`
        : `CLMM=${clmmPoolCount}`;
    console.log(
        `📊 Markets: PS=${snapshot.pumpSwapPools.length} Ray=${snapshot.raydiumV4Pools.length} ${clmmInfo} ${metInfo}`
    );

    console.log(
        `🔗 Vaults: ${snapshot.stats.trackedVaults} tracked │ ${snapshot.stats.cachedVaultBalances} cached │ Snapshot age: ${formatAge(snapshotAgeMs)}`
    );

    // Venue pair breakdown
    const venuePairs = new Map<string, number>();
    for (const c of candidates) {
        const pair = `${getVenueShort(c.buyVenue)}→${getVenueShort(c.sellVenue)}`;
        venuePairs.set(pair, (venuePairs.get(pair) ?? 0) + 1);
    }
    const pairStr = [...venuePairs.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([p, c]) => `${p}:${c}`)
        .join(" ");

    console.log(
        `🎯 Candidates: ${candidates.length} │ ${highQuality}🟢 ${medQuality}🟡 ${lowQuality}🔴 │ SOL:${solPairs} Stable:${stablePairs} │ New:${newlyCreated} │ ${pairStr}`
    );
    console.log("━".repeat(120));
    console.log(
        `⚠️  Est.Net = Gross - Fees (slippage NOT included). SimGate validates actual profit.`
    );
    console.log("━".repeat(120));

    const top10 = candidates.slice(0, 10);
    if (top10.length === 0) {
        console.log("  ⏳ No simulation candidates detected");
        console.log("  • Waiting for price fragmentation across venues (PS/Ray/CLMM/Met)");
        console.log(
            `  • Minimum gross spread required: ${MIN_SPREAD_TO_SIMULATE_BPS}bps`
        );
    } else {
        console.log(
            "  #  Est.Net   Spread    Route              Buy Price        Sell Price       Fees    Age     Quote  Qual"
        );
        console.log("  " + "─".repeat(116));

        for (let i = 0; i < top10.length; i++) {
            const c = top10[i]!;
            const spreadIcon = getSpreadIcon(c.estimatedNetSpreadBps);
            const qualityIcon = getQualityIcon(c.candidateQuality);
            const ageIcon = getAgeIcon(c.isNewlyCreated, c.timeSinceCreationMs);

            const route = `${c.buyVenue}→${c.sellVenue}`;
            const ageStr = c.timeSinceCreationMs !== null
                ? formatAge(c.timeSinceCreationMs)
                : formatAge(c.dataAgeMs);
            const feesStr = `${c.buyFeeBps}+${c.sellFeeBps}`;

            console.log(
                `  ${(i + 1).toString().padStart(2)}. ` +
                `${formatBps(c.estimatedNetSpreadBps).padStart(7)} │ ` +
                `${formatBps(c.spreadBps).padStart(7)} │ ` +
                `${route.padEnd(18)} │ ` +
                `${formatPrice(c.buyPrice).padStart(14)} │ ` +
                `${formatPrice(c.sellPrice).padStart(14)} │ ` +
                `${feesStr.padStart(6)} │ ` +
                `${ageIcon} ${ageStr.padEnd(5)} │ ` +
                `${c.quoteType.padEnd(4)} │ ` +
                `${spreadIcon}${qualityIcon}`
            );

            // Token mint + extra info
            let extraInfo = "";
            if (c.clmmTick !== undefined) extraInfo += ` tick=${c.clmmTick}`;
            if (c.meteoraBinStep !== undefined) extraInfo += ` bin=${c.meteoraBinStep}`;
            console.log(
                `       └─ ${c.tokenMint.slice(0, 8)}...${c.tokenMint.slice(-4)}${extraInfo}`
            );
        }
    }

    console.log("━".repeat(120));
    // Show which ingest run we're reading from
    const ingestInfo = currentIngestRunId ? `📥 Ingest: ${currentIngestRunId}` : "";
    console.log(`📁 ${runDir} ${ingestInfo}`);
    console.log(
        `🔄 Snapshot #${snapshotCount} │ Best: ${bestSpreadBpsEver !== null ? formatBps(bestSpreadBpsEver) : "N/A"} │ ` +
        `Seen: ${totalCandidatesSeen} │ Ctrl+C to exit`
    );
}

// ============================================================================
// MAIN LOOP
// ============================================================================

async function processSnapshot(): Promise<void> {
    const snapshot = await loadSnapshot();
    if (!snapshot) return;

    const candidates = findArbitrageCandidates(snapshot);
    const now = Date.now();
    const snapshotTs = new Date(snapshot.generatedAt).getTime();
    const snapshotAgeMs = now - snapshotTs;

    if (now - lastTerminalPrint >= TERMINAL_SUMMARY_INTERVAL_MS) {
        renderTerminalSummary(snapshot, candidates);
        lastTerminalPrint = now;
    }

    if (now - lastFileSave >= SNAPSHOT_SAVE_INTERVAL_MS) {
        snapshotCount++;

        const meteoraStats = snapshot.stats.meteora;
        const clmmStats = snapshot.stats.raydiumClmm;
        const clmmPoolCount = snapshot.raydiumClmmPools?.length ?? 0;

        const runSnapshot: RunSnapshot = {
            timestamp: new Date().toISOString(),
            snapshotNumber: snapshotCount,
            snapshotAgeMs,
            solUsdPrice,
            syncStatus: snapshot.stats.initialSyncComplete ? "LIVE" : "SYNC",
            feeConstants: {
                pumpswap: PUMPSWAP_FEE_BPS,
                raydium: RAYDIUM_FEE_BPS,
                raydiumClmm: RAYDIUM_CLMM_FEE_BPS,
                meteoraMax: MAX_METEORA_FEE,
                minSpreadToSimulate: MIN_SPREAD_TO_SIMULATE_BPS,
                minCandidateQuality: MIN_CANDIDATE_QUALITY_BPS
            },
            markets: {
                pumpSwap: snapshot.pumpSwapPools.length,
                raydium: snapshot.raydiumV4Pools.length,
                raydiumClmm: clmmPoolCount,
                raydiumClmmActive: clmmStats?.activePools ?? 0,
                meteora: snapshot.meteoraPools.length,
                meteoraTradeable: meteoraStats?.tradeablePools ?? 0,
                meteoraHighFee: meteoraStats?.highFeePools ?? 0
            },
            vaultTracking: {
                trackedVaults: snapshot.stats.trackedVaults,
                cachedBalances: snapshot.stats.cachedVaultBalances
            },
            fragments: {
                total: candidates.length,
                withPumpSwap: candidates.filter(c => c.buyVenue === "pumpswap" || c.sellVenue === "pumpswap").length,
                withRaydium: candidates.filter(c => c.buyVenue === "raydium" || c.sellVenue === "raydium").length,
                withRaydiumClmm: candidates.filter(c => c.buyVenue === "raydiumclmm" || c.sellVenue === "raydiumclmm").length,
                withMeteora: candidates.filter(c => c.buyVenue === "meteora" || c.sellVenue === "meteora").length
            },
            candidates: {
                total: candidates.length,
                highQuality: candidates.filter(c => c.candidateQuality === "high").length,
                mediumQuality: candidates.filter(c => c.candidateQuality === "medium").length,
                lowQuality: candidates.filter(c => c.candidateQuality === "low").length,
                newlyCreated: candidates.filter(c => c.isNewlyCreated).length,
                solPairs: candidates.filter(c => c.quoteType === "SOL").length,
                stablePairs: candidates.filter(c => c.quoteType !== "SOL").length
            },
            topCandidates: candidates.slice(0, 20)
        };

        recentSnapshots.push(runSnapshot);
        while (recentSnapshots.length > MAX_MEMORY_SNAPSHOTS) {
            recentSnapshots.shift();
        }

        const marketEvents = buildMarketEvents(snapshot, snapshotCount, snapshotAgeMs);
        await saveRunSnapshot(runSnapshot, marketEvents);
        lastFileSave = now;
    }
}

async function main(): Promise<void> {
    console.log("[view_markets] Starting Yogurtslinger Diagnostic Mirror v5.1...");
    console.log("[view_markets] PURPOSE: Track CANDIDATE QUALITY (spread before simulation)");
    console.log("[view_markets] NOW WITH: Auto-detect latest ingest run directory");

    // Show initial snapshot location
    const initialSnapshotPath = await getLatestSnapshotFile();
    console.log(`[view_markets] Reading from: ${initialSnapshotPath}`);
    console.log();
    console.log("[view_markets] Fee Constants:");
    console.log(`  • PumpSwap:     ${(PUMPSWAP_FEE * 100).toFixed(2)}% (${PUMPSWAP_FEE_BPS} bps)`);
    console.log(`  • Raydium V4:   ${(RAYDIUM_FEE * 100).toFixed(2)}% (${RAYDIUM_FEE_BPS} bps)`);
    console.log(`  • Raydium CLMM: ${(RAYDIUM_CLMM_FEE * 100).toFixed(2)}% (${RAYDIUM_CLMM_FEE_BPS} bps, varies by AmmConfig)`);
    console.log(`  • Meteora:      Dynamic (max ${(MAX_METEORA_FEE * 100).toFixed(0)}% for arb)`);
    console.log();

    await initializeRun();

    lastTerminalPrint = Date.now() - TERMINAL_SUMMARY_INTERVAL_MS;
    lastFileSave = Date.now() - SNAPSHOT_SAVE_INTERVAL_MS;

    process.on("SIGINT", async () => {
        console.log("\n[view_markets] Shutting down...");
        console.log(`[view_markets] Saved ${snapshotCount} snapshots to ${runDir}`);
        console.log(`[view_markets] Best spread: ${bestSpreadBpsEver !== null ? formatBps(bestSpreadBpsEver) : "N/A"}`);
        console.log(`[view_markets] Total candidates seen: ${totalCandidatesSeen}`);
        process.exit(0);
    });

    const poll = async () => {
        try {
            await processSnapshot();
        } catch (err) {
            console.error("[view_markets] Error processing snapshot:", err);
        }
    };

    await poll();
    setInterval(() => { void poll(); }, REFRESH_INTERVAL_MS);
}

main().catch((err) => {
    console.error("[view_markets] Fatal error:", err);
    process.exit(1);
});