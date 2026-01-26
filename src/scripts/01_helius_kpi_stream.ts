/**
 * PHASE 1: COMPREHENSIVE KPI Stream
 *
 * Captures EVERYTHING:
 * - ALL transactions on fractured tokens (PS + external DEX)
 * - ALL competition (fast Jito bots, slow traders, aggregators)
 * - ALL programs (DEXs, aggregators, routers, MEV)
 *
 * Competition tiers:
 * - TIER_1_UNBEATABLE: Jito bundles, sub-slot execution
 * - TIER_2_DIFFICULT: Aggregator routes, optimized
 * - TIER_3_BEATABLE: Slow/inefficient, high fees, no Jito
 *
 * Run: npx tsx src/scripts/01_helius_kpi_stream.ts
 */

import fs from "node:fs";
import path from "node:path";
import WebSocket, { RawData } from "ws";
import { fileURLToPath } from "node:url";

declare function fetch(input: any, init?: any): Promise<any>;

// ============================================================================
// CONFIG
// ============================================================================

const HELIUS_HTTP_API_KEY = "2bb675f2-573f-4561-b57f-d351db310e5a";
const HELIUS_WS_API_KEY = "bff504b3-c294-46e9-b7d8-dacbcb4b9e3d";

const HELIUS_HTTP_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_HTTP_API_KEY}`;
const HELIUS_WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_WS_API_KEY}`;

// ============================================================================
// COMPREHENSIVE PROGRAM LIST
// ============================================================================

// Core DEXs we care about
const CORE_DEX_PROGRAMS: Record<string, string> = {
    pumpswap: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    raydium_v4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    raydium_clmm: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    meteora_dlmm: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
};

// Aggregators - subscribe to these too
const AGGREGATOR_PROGRAMS: Record<string, string> = {
    jupiter_v6: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    jupiter_v4: "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB",
};

// All programs to subscribe to (core DEXs + aggregators)
const SUBSCRIBE_PROGRAMS = [
    ...Object.values(CORE_DEX_PROGRAMS),
    ...Object.values(AGGREGATOR_PROGRAMS),
];

// Programs to detect (for classification, not subscription)
const ALL_KNOWN_PROGRAMS: Record<string, { name: string; category: string }> = {
    // Core DEXs
    pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: { name: "PumpSwap", category: "dex" },
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": { name: "RaydiumV4", category: "dex" },
    CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: { name: "RaydiumCLMM", category: "dex" },
    LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: { name: "MeteoraDLMM", category: "dex" },

    // Aggregators
    JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaW7grrKgrWqK: { name: "JupiterV6", category: "aggregator" },
    JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB: { name: "JupiterV4", category: "aggregator" },
    DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M: { name: "JupiterDCA", category: "aggregator" },
    whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: { name: "OrcaWhirlpool", category: "dex" },
    routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS: { name: "RaydiumRouter", category: "router" },

    // Other DEXs that might have fractured token liquidity
    "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP": { name: "Orca", category: "dex" },
    SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ: { name: "Saber", category: "dex" },
    PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY: { name: "Phoenix", category: "orderbook" },
    opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb: { name: "Openbook", category: "orderbook" },

    // MEV / Infra
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5": { name: "JitoTip1", category: "mev" },
    HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe: { name: "JitoTip2", category: "mev" },
    Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY: { name: "JitoTip3", category: "mev" },
    ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49: { name: "JitoTip4", category: "mev" },
    DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh: { name: "JitoTip5", category: "mev" },
    ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt: { name: "JitoTip6", category: "mev" },
    DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL: { name: "JitoTip7", category: "mev" },
    "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT": { name: "JitoTip8", category: "mev" },

    // System
    ComputeBudget111111111111111111111111111111: { name: "ComputeBudget", category: "system" },
    "11111111111111111111111111111111": { name: "System", category: "system" },
    TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: { name: "Token", category: "system" },
    ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: { name: "ATA", category: "system" },
};

// Jito tip accounts for bundle detection
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

// Batch config
const BATCH_SIZE = 100;
const BATCH_INTERVAL_MS = 1000;
const MAX_QUEUE_SIZE = 100000; // Larger queue to not miss anything
const SIGNATURE_TTL_MS = 180_000; // 3 min TTL

const LAMPORTS_PER_SOL = 1_000_000_000;
const WSOL_MINT = "So11111111111111111111111111111111111111112";

// Thresholds for "beatable" classification
const BEATABLE_FEE_PER_CU_THRESHOLD = 1.0; // If competitor pays > 1 lamport/CU, they're inefficient
const BEATABLE_LATENCY_THRESHOLD_MS = 500; // If we detect them > 500ms after block, they're slow

// ============================================================================
// TYPES
// ============================================================================

interface QueuedSignature {
    signature: string;
    slot: number;
    enqueuedAt: number;
}

interface ProgramDetection {
    name: string;
    category: string;
    programId: string;
}

interface TokenVenueInfo {
    mint: string;
    venues: {
        pumpswap: boolean;
        raydium: boolean;
        meteora: boolean;
        orca: boolean;
        jupiter: boolean;
    };
    firstSeenSlot: number;
    totalTxCount: number;
    totalLossLamports: number;
    totalLossEvents: number;
    // Competition breakdown
    tier1UnbeatableLamports: number;
    tier1Events: number;
    tier2DifficultLamports: number;
    tier2Events: number;
    tier3BeatableLamports: number;
    tier3Events: number;
    // Uncaptured
    poolAbsorbedLamports: number;
    poolAbsorbedEvents: number;
}

interface CompetitorProfile {
    wallet: string;
    totalGainsLamports: number;
    eventCount: number;
    // Speed indicators
    usesJito: boolean;
    jitoTipEvents: number;
    avgJitoTipLamports: number;
    // Efficiency indicators
    avgFeePerCu: number;
    avgLatencyMs: number;
    // Strategy
    usesAggregator: boolean;
    aggregatorEvents: number;
    directArbEvents: number;
    // Tokens
    tokensTouched: Set<string>;
    // Classification
    tier: "TIER_1_UNBEATABLE" | "TIER_2_DIFFICULT" | "TIER_3_BEATABLE";
}

interface KpiEvent {
    runId: string;
    ts: string;
    slot: number;
    blockTime: number | null;
    signature: string;

    // Full program analysis
    programsDetected: ProgramDetection[];
    programCategories: string[];

    // Execution metrics
    cuConsumed: number | null;
    cuLimit: number | null;
    cuPrice: number | null;
    feeLamports: number | null;
    feePerCu: number | null;

    // Jito detection
    isJitoBundle: boolean;
    jitoTipLamports: number | null;
    jitoTipAccount: string | null;

    // Token info
    tokenMintsInvolved: string[];
    pumpMint: string | null;
    isTokenFractured: boolean;

    // SOL flow
    primarySignerSolDelta: number | null;
    primarySignerPubkey: string | null;
    maxSolGainerPubkey: string | null;
    maxSolGainerLamports: number | null;
    maxSolLoserPubkey: string | null;
    maxSolLoserLamports: number | null;

    // Transaction classification
    txCategory: "PUMP_LOSS" | "PUMP_GAIN" | "CROSS_VENUE_ARB" | "AGGREGATOR_ROUTE" | "OTHER_DEX" | "OTHER";
    isPumpSwapLoss: boolean;
    pumpLossLamports: number | null;

    // Competition classification
    competitorTier: "TIER_1_UNBEATABLE" | "TIER_2_DIFFICULT" | "TIER_3_BEATABLE" | "NOT_COMPETITOR";
    competitorSignals: string[];

    // Opportunity
    opportunityStatus: "CAPTURED_T1" | "CAPTURED_T2" | "CAPTURED_T3" | "POOL_ABSORBED" | "NOT_FRACTURED" | "NO_LOSS";

    // Latency (for speed analysis)
    detectionLatencyMs: number | null;
}

interface LiveMetrics {
    totalEvents: number;
    fracturedTokenEvents: number;
    pumpSwapLossEvents: number;

    // Total opportunity
    totalPumpLossLamports: number;
    totalCapturableLamports: number;

    // Competition tiers
    tier1UnbeatableLamports: number;
    tier1Events: number;
    tier2DifficultLamports: number;
    tier2Events: number;
    tier3BeatableLamports: number;
    tier3Events: number;
    poolAbsorbedLamports: number;
    poolAbsorbedEvents: number;
    notFracturedLamports: number;
    notFracturedEvents: number;

    // Program usage
    programUsage: Record<string, number>;
    categoryUsage: Record<string, number>;

    // Jito stats
    jitoTxCount: number;
    totalJitoTips: number;

    // Token registry
    tokenRegistry: Map<string, TokenVenueInfo>;

    // Competitor profiles
    competitors: Map<string, CompetitorProfile>;

    // Processing stats
    batchesProcessed: number;
    sigsReceived: number;
    sigsDropped: number;
}

// ============================================================================
// UTILITIES
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");

function ensureDataDir(): void {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

function log(msg: string): void {
    console.log(`[KPI_STREAM] ${msg}`);
}

function logError(msg: string, err?: unknown): void {
    console.error(`[KPI_STREAM] ERROR: ${msg}`, err instanceof Error ? err.message : "");
}

function lamportsToSol(lamports: number): number {
    return lamports / LAMPORTS_PER_SOL;
}

// ============================================================================
// JSONL WRITER
// ============================================================================

class JsonlWriter {
    private stream: fs.WriteStream;
    private closed = false;
    public eventCount = 0;

    constructor(filePath: string) {
        this.stream = fs.createWriteStream(filePath, { flags: "w" });
    }

    write(obj: KpiEvent): void {
        if (this.closed) return;
        this.stream.write(JSON.stringify(obj) + "\n");
        this.eventCount++;
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.stream.end();
    }
}

// ============================================================================
// SIGNATURE QUEUE
// ============================================================================

class SignatureQueue {
    private queue: QueuedSignature[] = [];
    private seen = new Set<string>();
    public dropped = 0;

    enqueue(sig: string, slot: number): void {
        if (this.seen.has(sig)) return;

        if (this.queue.length >= MAX_QUEUE_SIZE) {
            const old = this.queue.shift();
            if (old) {
                this.seen.delete(old.signature);
                this.dropped++;
            }
        }

        this.seen.add(sig);
        this.queue.push({ signature: sig, slot, enqueuedAt: Date.now() });
    }

    getBatch(size: number): QueuedSignature[] {
        const now = Date.now();
        const batch: QueuedSignature[] = [];

        while (batch.length < size && this.queue.length > 0) {
            const item = this.queue.shift()!;
            this.seen.delete(item.signature);
            if (now - item.enqueuedAt > SIGNATURE_TTL_MS) {
                this.dropped++;
                continue;
            }
            batch.push(item);
        }

        return batch;
    }

    get size(): number {
        return this.queue.length;
    }
}

// ============================================================================
// BATCH RPC FETCHER
// ============================================================================

async function fetchTransactionBatch(signatures: string[]): Promise<Map<string, any>> {
    const results = new Map<string, any>();
    if (signatures.length === 0) return results;

    const batchRequest = signatures.map((sig, i) => ({
        jsonrpc: "2.0",
        id: i,
        method: "getTransaction",
        params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
    }));

    try {
        const res = await fetch(HELIUS_HTTP_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(batchRequest),
        });

        const responses = await res.json();

        if (!Array.isArray(responses)) {
            logError("Batch response not array");
            return results;
        }

        for (const resp of responses) {
            if (resp.result && resp.id !== undefined) {
                const sig = signatures[resp.id];
                if (sig) {
                    results.set(sig, resp.result);
                }
            }
        }
    } catch (e) {
        logError("Batch fetch error", e);
    }

    return results;
}

// ============================================================================
// PROGRAM ANALYSIS
// ============================================================================

function detectPrograms(accountKeys: string[]): ProgramDetection[] {
    const detected: ProgramDetection[] = [];
    const seen = new Set<string>();

    for (const key of accountKeys) {
        if (seen.has(key)) continue;
        const info = ALL_KNOWN_PROGRAMS[key];
        if (info) {
            detected.push({ programId: key, name: info.name, category: info.category });
            seen.add(key);
        }
    }

    return detected;
}

function detectJitoBundle(
    meta: any,
    accountKeys: string[]
): { isJito: boolean; tipLamports: number; tipAccount: string | null } {
    let isJito = false;
    let tipLamports = 0;
    let tipAccount: string | null = null;

    // Check account keys for Jito tip accounts
    for (const key of accountKeys) {
        if (JITO_TIP_ACCOUNTS.has(key)) {
            isJito = true;
        }
    }

    // Check inner instructions for tip transfers
    for (const inner of meta?.innerInstructions ?? []) {
        for (const ix of inner.instructions ?? []) {
            if (ix.parsed?.type === "transfer") {
                const dest = ix.parsed.info?.destination;
                if (dest && JITO_TIP_ACCOUNTS.has(dest)) {
                    isJito = true;
                    tipLamports += ix.parsed.info?.lamports ?? 0;
                    tipAccount = dest;
                }
            }
        }
    }

    return { isJito, tipLamports, tipAccount };
}

function extractComputeBudget(
    instructions: any[]
): { cuLimit: number | null; cuPrice: number | null } {
    let cuLimit: number | null = null;
    let cuPrice: number | null = null;

    for (const ix of instructions) {
        if (ix.programId === "ComputeBudget111111111111111111111111111111") {
            if (ix.parsed?.type === "setComputeUnitLimit") {
                cuLimit = ix.parsed.info?.units ?? null;
            }
            if (ix.parsed?.type === "setComputeUnitPrice") {
                cuPrice = ix.parsed.info?.microLamports ?? null;
            }
        }
    }

    return { cuLimit, cuPrice };
}

// ============================================================================
// TOKEN REGISTRY
// ============================================================================

function getOrCreateTokenInfo(
    registry: Map<string, TokenVenueInfo>,
    mint: string,
    slot: number
): TokenVenueInfo {
    if (!registry.has(mint)) {
        registry.set(mint, {
            mint,
            venues: {
                pumpswap: false,
                raydium: false,
                meteora: false,
                orca: false,
                jupiter: false,
            },
            firstSeenSlot: slot,
            totalTxCount: 0,
            totalLossLamports: 0,
            totalLossEvents: 0,
            tier1UnbeatableLamports: 0,
            tier1Events: 0,
            tier2DifficultLamports: 0,
            tier2Events: 0,
            tier3BeatableLamports: 0,
            tier3Events: 0,
            poolAbsorbedLamports: 0,
            poolAbsorbedEvents: 0,
        });
    }
    return registry.get(mint)!;
}

function isTokenFractured(info: TokenVenueInfo): boolean {
    return info.venues.pumpswap && (info.venues.raydium || info.venues.meteora || info.venues.orca);
}

function updateTokenVenues(
    registry: Map<string, TokenVenueInfo>,
    mint: string,
    programs: ProgramDetection[],
    slot: number
): TokenVenueInfo {
    const info = getOrCreateTokenInfo(registry, mint, slot);
    info.totalTxCount++;

    for (const prog of programs) {
        if (prog.name === "PumpSwap") info.venues.pumpswap = true;
        if (prog.name.includes("Raydium")) info.venues.raydium = true;
        if (prog.name.includes("Meteora")) info.venues.meteora = true;
        if (prog.name.includes("Orca")) info.venues.orca = true;
        if (prog.name.includes("Jupiter")) info.venues.jupiter = true;
    }

    return info;
}

// ============================================================================
// COMPETITOR CLASSIFICATION
// ============================================================================

function classifyCompetitorTier(
    isJito: boolean,
    jitoTipLamports: number,
    usesAggregator: boolean,
    feePerCu: number | null,
    latencyMs: number | null
): { tier: KpiEvent["competitorTier"]; signals: string[] } {
    const signals: string[] = [];

    // TIER 1: Jito bundle users - they get block priority, nearly unbeatable
    if (isJito && jitoTipLamports > 0) {
        signals.push(`JITO_TIP:${lamportsToSol(jitoTipLamports).toFixed(6)}SOL`);
        return { tier: "TIER_1_UNBEATABLE", signals };
    }

    // TIER 2: Aggregator users with good fees - sophisticated but beatable with speed
    if (usesAggregator) {
        signals.push("USES_AGGREGATOR");
        if (feePerCu !== null && feePerCu < BEATABLE_FEE_PER_CU_THRESHOLD) {
            signals.push(`LOW_FEE:${feePerCu.toFixed(4)}`);
            return { tier: "TIER_2_DIFFICULT", signals };
        }
    }

    // TIER 3: Slow or inefficient - beatable
    if (latencyMs !== null && latencyMs > BEATABLE_LATENCY_THRESHOLD_MS) {
        signals.push(`SLOW:${latencyMs.toFixed(0)}ms`);
    }
    if (feePerCu !== null && feePerCu > BEATABLE_FEE_PER_CU_THRESHOLD) {
        signals.push(`HIGH_FEE:${feePerCu.toFixed(4)}`);
    }

    // If not clearly T1 or T2, check if it's even a competitor (did they profit?)
    // This will be determined by caller based on SOL gains

    return { tier: "TIER_3_BEATABLE", signals };
}

// ============================================================================
// KPI EVENT BUILDER
// ============================================================================

function extractAccountKeys(message: any): string[] {
    const keys: string[] = [];
    const accountKeys = message?.accountKeys;
    if (!Array.isArray(accountKeys)) return keys;

    for (const k of accountKeys) {
        if (typeof k === "string") {
            keys.push(k);
        } else if (k && typeof k === "object") {
            const pubkey = k.pubkey ?? k.key;
            if (pubkey) keys.push(pubkey);
        }
    }
    return keys;
}

function extractSignerInfo(message: any): { index: number | null; pubkey: string | null } {
    const accountKeys = message?.accountKeys;
    if (!Array.isArray(accountKeys)) return { index: null, pubkey: null };

    for (let i = 0; i < accountKeys.length; i++) {
        const k = accountKeys[i];
        if (k && typeof k === "object" && k.signer) {
            return { index: i, pubkey: k.pubkey ?? k.key ?? null };
        }
    }
    return { index: null, pubkey: null };
}

function extractTokenMints(meta: any): string[] {
    const mints = new Set<string>();

    for (const e of meta?.preTokenBalances ?? []) {
        if (e?.mint && e.mint !== WSOL_MINT) mints.add(e.mint);
    }
    for (const e of meta?.postTokenBalances ?? []) {
        if (e?.mint && e.mint !== WSOL_MINT) mints.add(e.mint);
    }

    return Array.from(mints);
}

function buildKpiEvent(
    runId: string,
    slotWs: number,
    sig: string,
    recvMs: number,
    tx: any,
    tokenRegistry: Map<string, TokenVenueInfo>
): KpiEvent {
    const slot = tx.slot ?? slotWs;
    const blockTime: number | null = tx.blockTime ?? null;
    const meta = tx.meta ?? null;
    const message = tx.transaction?.message ?? null;

    // Latency calculation
    const detectionLatencyMs = blockTime ? recvMs - blockTime * 1000 : null;

    // Basic metrics
    const cuConsumed = meta?.computeUnitsConsumed ?? null;
    const feeLamports = meta?.fee ?? null;
    const feePerCu = cuConsumed && feeLamports ? feeLamports / cuConsumed : null;

    const preBalances: number[] = meta?.preBalances ?? [];
    const postBalances: number[] = meta?.postBalances ?? [];

    const accountKeys = extractAccountKeys(message);
    const signerInfo = extractSignerInfo(message);
    const tokenMints = extractTokenMints(meta);

    // Program detection
    const programsDetected = detectPrograms(accountKeys);
    const programCategories = [...new Set(programsDetected.map((p) => p.category))];

    // Compute budget
    const instructions = message?.instructions ?? [];
    const { cuLimit, cuPrice } = extractComputeBudget(instructions);

    // Jito detection
    const { isJito, tipLamports, tipAccount } = detectJitoBundle(meta, accountKeys);

    // Update token registry
    for (const mint of tokenMints) {
        updateTokenVenues(tokenRegistry, mint, programsDetected, slot);
    }

    // Primary signer SOL delta
    let primarySignerSolDelta: number | null = null;
    if (signerInfo.index !== null && preBalances[signerInfo.index] !== undefined) {
        primarySignerSolDelta =
            (postBalances[signerInfo.index] ?? 0) - (preBalances[signerInfo.index] ?? 0);
    }

    // Max gainer/loser
    let maxSolGainerPubkey: string | null = null;
    let maxSolGainerLamports: number | null = null;
    let maxSolLoserPubkey: string | null = null;
    let maxSolLoserLamports: number | null = null;

    const len = Math.min(preBalances.length, postBalances.length, accountKeys.length);
    for (let i = 0; i < len; i++) {
        const delta = (postBalances[i] ?? 0) - (preBalances[i] ?? 0);
        const key = accountKeys[i] ?? null;
        if (delta > 0 && (maxSolGainerLamports === null || delta > maxSolGainerLamports)) {
            maxSolGainerLamports = delta;
            maxSolGainerPubkey = key;
        }
        if (delta < 0 && (maxSolLoserLamports === null || delta < maxSolLoserLamports)) {
            maxSolLoserLamports = delta;
            maxSolLoserPubkey = key;
        }
    }

    // Program presence checks
    const hasPumpSwap = programsDetected.some((p) => p.name === "PumpSwap");
    const hasAggregator = programsDetected.some((p) => p.category === "aggregator");
    const hasOtherDex = programsDetected.some((p) => p.category === "dex" && p.name !== "PumpSwap");

    // PumpSwap loss detection
    const isPumpSwapLoss = hasPumpSwap && primarySignerSolDelta !== null && primarySignerSolDelta < 0;
    let pumpLossLamports: number | null = null;
    let pumpMint: string | null = null;

    if (isPumpSwapLoss) {
        pumpLossLamports = Math.abs(primarySignerSolDelta!);
        pumpMint = tokenMints[0] ?? null;
    }

    // Token fractured status
    let isTokenFracturedFlag = false;
    if (pumpMint) {
        const tokenInfo = tokenRegistry.get(pumpMint);
        if (tokenInfo) {
            isTokenFracturedFlag = isTokenFractured(tokenInfo);
        }
    }

    // Transaction category
    let txCategory: KpiEvent["txCategory"] = "OTHER";
    if (hasPumpSwap) {
        if (isPumpSwapLoss) {
            txCategory = "PUMP_LOSS";
        } else if (primarySignerSolDelta !== null && primarySignerSolDelta > 0) {
            txCategory = "PUMP_GAIN";
        }
        if (hasAggregator) {
            txCategory = "AGGREGATOR_ROUTE";
        } else if (hasOtherDex) {
            txCategory = "CROSS_VENUE_ARB";
        }
    } else if (hasOtherDex) {
        txCategory = "OTHER_DEX";
    }

    // Competitor classification
    let competitorTier: KpiEvent["competitorTier"] = "NOT_COMPETITOR";
    let competitorSignals: string[] = [];

    // Someone is a competitor if they profited and this involves a PumpSwap loss
    const isCompetitor = isPumpSwapLoss && maxSolGainerLamports !== null && maxSolGainerLamports > 0;

    if (isCompetitor) {
        const classification = classifyCompetitorTier(
            isJito,
            tipLamports,
            hasAggregator,
            feePerCu,
            detectionLatencyMs
        );
        competitorTier = classification.tier;
        competitorSignals = classification.signals;
    }

    // Opportunity status
    let opportunityStatus: KpiEvent["opportunityStatus"] = "NO_LOSS";

    if (isPumpSwapLoss && pumpLossLamports && pumpLossLamports > 0) {
        if (!isTokenFracturedFlag) {
            opportunityStatus = "NOT_FRACTURED";
        } else if (competitorTier === "TIER_1_UNBEATABLE") {
            opportunityStatus = "CAPTURED_T1";
        } else if (competitorTier === "TIER_2_DIFFICULT") {
            opportunityStatus = "CAPTURED_T2";
        } else if (competitorTier === "TIER_3_BEATABLE") {
            opportunityStatus = "CAPTURED_T3";
        } else {
            opportunityStatus = "POOL_ABSORBED";
        }
    }

    return {
        runId,
        ts: new Date(recvMs).toISOString(),
        slot,
        blockTime,
        signature: sig,
        programsDetected,
        programCategories,
        cuConsumed,
        cuLimit,
        cuPrice,
        feeLamports,
        feePerCu,
        isJitoBundle: isJito,
        jitoTipLamports: tipLamports > 0 ? tipLamports : null,
        jitoTipAccount: tipAccount,
        tokenMintsInvolved: tokenMints,
        pumpMint,
        isTokenFractured: isTokenFracturedFlag,
        primarySignerSolDelta,
        primarySignerPubkey: signerInfo.pubkey,
        maxSolGainerPubkey,
        maxSolGainerLamports,
        maxSolLoserPubkey,
        maxSolLoserLamports,
        txCategory,
        isPumpSwapLoss,
        pumpLossLamports,
        competitorTier,
        competitorSignals,
        opportunityStatus,
        detectionLatencyMs,
    };
}

// ============================================================================
// LIVE METRICS
// ============================================================================

function createMetrics(): LiveMetrics {
    return {
        totalEvents: 0,
        fracturedTokenEvents: 0,
        pumpSwapLossEvents: 0,
        totalPumpLossLamports: 0,
        totalCapturableLamports: 0,
        tier1UnbeatableLamports: 0,
        tier1Events: 0,
        tier2DifficultLamports: 0,
        tier2Events: 0,
        tier3BeatableLamports: 0,
        tier3Events: 0,
        poolAbsorbedLamports: 0,
        poolAbsorbedEvents: 0,
        notFracturedLamports: 0,
        notFracturedEvents: 0,
        programUsage: {},
        categoryUsage: {},
        jitoTxCount: 0,
        totalJitoTips: 0,
        tokenRegistry: new Map(),
        competitors: new Map(),
        batchesProcessed: 0,
        sigsReceived: 0,
        sigsDropped: 0,
    };
}

function updateMetrics(metrics: LiveMetrics, event: KpiEvent): void {
    metrics.totalEvents++;

    // Program/category usage
    for (const prog of event.programsDetected) {
        metrics.programUsage[prog.name] = (metrics.programUsage[prog.name] ?? 0) + 1;
        metrics.categoryUsage[prog.category] = (metrics.categoryUsage[prog.category] ?? 0) + 1;
    }

    // Jito tracking
    if (event.isJitoBundle) {
        metrics.jitoTxCount++;
        if (event.jitoTipLamports) {
            metrics.totalJitoTips += event.jitoTipLamports;
        }
    }

    // Fractured token events
    if (event.isTokenFractured) {
        metrics.fracturedTokenEvents++;
    }

    // PumpSwap loss tracking
    if (event.isPumpSwapLoss && event.pumpLossLamports) {
        metrics.pumpSwapLossEvents++;
        metrics.totalPumpLossLamports += event.pumpLossLamports;

        if (event.isTokenFractured) {
            metrics.totalCapturableLamports += event.pumpLossLamports;
        }

        switch (event.opportunityStatus) {
            case "CAPTURED_T1":
                metrics.tier1UnbeatableLamports += event.pumpLossLamports;
                metrics.tier1Events++;
                break;
            case "CAPTURED_T2":
                metrics.tier2DifficultLamports += event.pumpLossLamports;
                metrics.tier2Events++;
                break;
            case "CAPTURED_T3":
                metrics.tier3BeatableLamports += event.pumpLossLamports;
                metrics.tier3Events++;
                break;
            case "POOL_ABSORBED":
                metrics.poolAbsorbedLamports += event.pumpLossLamports;
                metrics.poolAbsorbedEvents++;
                break;
            case "NOT_FRACTURED":
                metrics.notFracturedLamports += event.pumpLossLamports;
                metrics.notFracturedEvents++;
                break;
        }

        // Update token-level stats
        if (event.pumpMint) {
            const tokenInfo = metrics.tokenRegistry.get(event.pumpMint);
            if (tokenInfo) {
                tokenInfo.totalLossLamports += event.pumpLossLamports;
                tokenInfo.totalLossEvents++;

                switch (event.opportunityStatus) {
                    case "CAPTURED_T1":
                        tokenInfo.tier1UnbeatableLamports += event.pumpLossLamports;
                        tokenInfo.tier1Events++;
                        break;
                    case "CAPTURED_T2":
                        tokenInfo.tier2DifficultLamports += event.pumpLossLamports;
                        tokenInfo.tier2Events++;
                        break;
                    case "CAPTURED_T3":
                        tokenInfo.tier3BeatableLamports += event.pumpLossLamports;
                        tokenInfo.tier3Events++;
                        break;
                    case "POOL_ABSORBED":
                        tokenInfo.poolAbsorbedLamports += event.pumpLossLamports;
                        tokenInfo.poolAbsorbedEvents++;
                        break;
                }
            }
        }

        // Competitor tracking
        if (event.competitorTier !== "NOT_COMPETITOR" && event.maxSolGainerPubkey && event.maxSolGainerLamports) {
            if (!metrics.competitors.has(event.maxSolGainerPubkey)) {
                metrics.competitors.set(event.maxSolGainerPubkey, {
                    wallet: event.maxSolGainerPubkey,
                    totalGainsLamports: 0,
                    eventCount: 0,
                    usesJito: false,
                    jitoTipEvents: 0,
                    avgJitoTipLamports: 0,
                    avgFeePerCu: 0,
                    avgLatencyMs: 0,
                    usesAggregator: false,
                    aggregatorEvents: 0,
                    directArbEvents: 0,
                    tokensTouched: new Set(),
                    tier: event.competitorTier,
                });
            }

            const comp = metrics.competitors.get(event.maxSolGainerPubkey)!;
            comp.totalGainsLamports += event.maxSolGainerLamports;
            comp.eventCount++;

            if (event.isJitoBundle) {
                comp.usesJito = true;
                comp.jitoTipEvents++;
            }

            if (event.programCategories.includes("aggregator")) {
                comp.usesAggregator = true;
                comp.aggregatorEvents++;
            } else {
                comp.directArbEvents++;
            }

            if (event.pumpMint) {
                comp.tokensTouched.add(event.pumpMint);
            }

            // Update tier to worst (most unbeatable) seen
            if (event.competitorTier === "TIER_1_UNBEATABLE") {
                comp.tier = "TIER_1_UNBEATABLE";
            } else if (event.competitorTier === "TIER_2_DIFFICULT" && comp.tier !== "TIER_1_UNBEATABLE") {
                comp.tier = "TIER_2_DIFFICULT";
            }
        }
    }
}

function printMetricsSummary(metrics: LiveMetrics, runtimeSec: number): void {
    const totalLoss = lamportsToSol(metrics.totalPumpLossLamports);
    const totalCapturable = lamportsToSol(metrics.totalCapturableLamports);
    const tier1 = lamportsToSol(metrics.tier1UnbeatableLamports);
    const tier2 = lamportsToSol(metrics.tier2DifficultLamports);
    const tier3 = lamportsToSol(metrics.tier3BeatableLamports);
    const poolAbsorbed = lamportsToSol(metrics.poolAbsorbedLamports);
    const notFractured = lamportsToSol(metrics.notFracturedLamports);

    const beatableOpportunity = tier3 + poolAbsorbed;
    const hourlyBeatable = runtimeSec > 0 ? (beatableOpportunity / runtimeSec) * 3600 : 0;
    const hourlyTotal = runtimeSec > 0 ? (totalCapturable / runtimeSec) * 3600 : 0;

    const fracturedTokens = Array.from(metrics.tokenRegistry.values()).filter(isTokenFractured);
    const avgJitoTip = metrics.jitoTxCount > 0 ? lamportsToSol(metrics.totalJitoTips / metrics.jitoTxCount) : 0;

    console.log("\n" + "=".repeat(90));
    console.log("📊 COMPREHENSIVE MARKET ANALYSIS");
    console.log("=".repeat(90));

    console.log(`\n⏱️  RUNTIME: ${runtimeSec.toFixed(0)} seconds`);

    console.log(`\n📥 THROUGHPUT`);
    console.log(`   Signatures received:    ${metrics.sigsReceived.toLocaleString()}`);
    console.log(`   Events processed:       ${metrics.totalEvents.toLocaleString()}`);
    console.log(`   Capture rate:           ${((metrics.totalEvents / Math.max(metrics.sigsReceived, 1)) * 100).toFixed(1)}%`);
    console.log(`   Fractured token events: ${metrics.fracturedTokenEvents.toLocaleString()}`);

    console.log(`\n🔧 PROGRAM USAGE (Top 15)`);
    const progSorted = Object.entries(metrics.programUsage).sort((a, b) => b[1] - a[1]).slice(0, 15);
    for (const [prog, count] of progSorted) {
        const pct = ((count / metrics.totalEvents) * 100).toFixed(1);
        console.log(`   ${prog.padEnd(20)} ${count.toString().padStart(8)} (${pct}%)`);
    }

    console.log(`\n⚡ JITO BUNDLE ANALYSIS`);
    console.log(`   Jito transactions:      ${metrics.jitoTxCount.toLocaleString()}`);
    console.log(`   Total tips paid:        ${lamportsToSol(metrics.totalJitoTips).toFixed(6)} SOL`);
    console.log(`   Avg tip per tx:         ${avgJitoTip.toFixed(6)} SOL`);
    console.log(`   Jito usage rate:        ${((metrics.jitoTxCount / Math.max(metrics.totalEvents, 1)) * 100).toFixed(1)}%`);

    console.log(`\n💰 PUMPSWAP LOSS FLOW`);
    console.log(`   Loss events:            ${metrics.pumpSwapLossEvents.toLocaleString()}`);
    console.log(`   Total loss volume:      ${totalLoss.toFixed(4)} SOL`);
    console.log(`   Capturable (fractured): ${totalCapturable.toFixed(4)} SOL`);
    console.log(`   Not capturable:         ${notFractured.toFixed(4)} SOL (no external pool)`);

    console.log(`\n🎯 COMPETITION BREAKDOWN`);
    console.log(`   ┌────────────────────────────────────────────────────────────────────────────────┐`);
    console.log(`   │ TOTAL CAPTURABLE MARKET: ${totalCapturable.toFixed(4).padStart(12)} SOL (${hourlyTotal.toFixed(2)} SOL/hr)              │`);
    console.log(`   ├────────────────────────────────────────────────────────────────────────────────┤`);
    console.log(`   │ 🔴 TIER 1 - UNBEATABLE (Jito bundles, sub-slot execution)                      │`);
    console.log(`   │    Captured:           ${tier1.toFixed(4).padStart(12)} SOL (${metrics.tier1Events} events)                       │`);
    console.log(`   │    Competition level:  IMPOSSIBLE to beat without Jito                        │`);
    console.log(`   ├────────────────────────────────────────────────────────────────────────────────┤`);
    console.log(`   │ 🟡 TIER 2 - DIFFICULT (Aggregators, optimized routes)                          │`);
    console.log(`   │    Captured:           ${tier2.toFixed(4).padStart(12)} SOL (${metrics.tier2Events} events)                       │`);
    console.log(`   │    Competition level:  Requires speed + route optimization                    │`);
    console.log(`   ├────────────────────────────────────────────────────────────────────────────────┤`);
    console.log(`   │ 🟢 TIER 3 - BEATABLE (Slow, high fees, inefficient)                            │`);
    console.log(`   │    Captured:           ${tier3.toFixed(4).padStart(12)} SOL (${metrics.tier3Events} events)                       │`);
    console.log(`   │    YOUR OPPORTUNITY:   Beat them with Geyser speed                            │`);
    console.log(`   ├────────────────────────────────────────────────────────────────────────────────┤`);
    console.log(`   │ 💎 POOL ABSORBED (No one captured - pure opportunity)                          │`);
    console.log(`   │    Available:          ${poolAbsorbed.toFixed(4).padStart(12)} SOL (${metrics.poolAbsorbedEvents} events)                       │`);
    console.log(`   │    YOUR OPPORTUNITY:   First mover advantage                                  │`);
    console.log(`   └────────────────────────────────────────────────────────────────────────────────┘`);

    console.log(`\n📈 YOUR OPPORTUNITY SUMMARY`);
    console.log(`   Beatable opportunity:   ${beatableOpportunity.toFixed(4)} SOL (Tier 3 + Pool Absorbed)`);
    console.log(`   Hourly potential:       ${hourlyBeatable.toFixed(2)} SOL/hr`);
    console.log(`   Daily potential:        ${(hourlyBeatable * 24).toFixed(2)} SOL/day`);
    console.log(`   Market share target:    ${((beatableOpportunity / Math.max(totalCapturable, 0.001)) * 100).toFixed(1)}% of capturable`);

    // Competitor analysis
    const allCompetitors = Array.from(metrics.competitors.values());
    const tier1Competitors = allCompetitors.filter((c) => c.tier === "TIER_1_UNBEATABLE");
    const tier2Competitors = allCompetitors.filter((c) => c.tier === "TIER_2_DIFFICULT");
    const tier3Competitors = allCompetitors.filter((c) => c.tier === "TIER_3_BEATABLE");

    console.log(`\n🏆 COMPETITOR ANALYSIS`);
    console.log(`   Total competitors:      ${allCompetitors.length}`);
    console.log(`   Tier 1 (Unbeatable):    ${tier1Competitors.length}`);
    console.log(`   Tier 2 (Difficult):     ${tier2Competitors.length}`);
    console.log(`   Tier 3 (Beatable):      ${tier3Competitors.length}`);

    if (tier3Competitors.length > 0) {
        console.log(`\n   🎯 BEATABLE COMPETITORS (Your targets)`);
        const topBeatable = tier3Competitors.sort((a, b) => b.totalGainsLamports - a.totalGainsLamports).slice(0, 10);
        console.log(`   ${"Wallet".padEnd(24)} ${"Gains".padStart(12)} ${"Events".padStart(8)} ${"Agg".padStart(5)} ${"Direct".padStart(7)}`);
        console.log(`   ${"-".repeat(60)}`);
        for (const c of topBeatable) {
            console.log(
                `   ${c.wallet.slice(0, 22)}.. ${lamportsToSol(c.totalGainsLamports).toFixed(4).padStart(12)} ${c.eventCount.toString().padStart(8)} ${c.aggregatorEvents.toString().padStart(5)} ${c.directArbEvents.toString().padStart(7)}`
            );
        }
    }

    if (tier1Competitors.length > 0) {
        console.log(`\n   ⚠️ UNBEATABLE COMPETITORS (For reference)`);
        const topUnbeatable = tier1Competitors.sort((a, b) => b.totalGainsLamports - a.totalGainsLamports).slice(0, 5);
        for (const c of topUnbeatable) {
            console.log(
                `   ${c.wallet.slice(0, 22)}.. ${lamportsToSol(c.totalGainsLamports).toFixed(4)} SOL | ${c.jitoTipEvents} Jito txs`
            );
        }
    }

    // Fractured tokens
    console.log(`\n🔗 FRACTURED TOKEN REGISTRY`);
    console.log(`   Tokens with external pools: ${fracturedTokens.length}`);

    const topOpportunity = fracturedTokens
        .filter((t) => t.poolAbsorbedLamports + t.tier3BeatableLamports > 0)
        .sort((a, b) => (b.poolAbsorbedLamports + b.tier3BeatableLamports) - (a.poolAbsorbedLamports + a.tier3BeatableLamports))
        .slice(0, 15);

    if (topOpportunity.length > 0) {
        console.log(`\n   TOP TOKENS BY BEATABLE OPPORTUNITY:`);
        console.log(`   ${"Mint".padEnd(24)} ${"Beatable".padStart(12)} ${"Pool".padStart(10)} ${"T3".padStart(10)} ${"Venues"}`);
        console.log(`   ${"-".repeat(75)}`);
        for (const t of topOpportunity) {
            const venues = [
                t.venues.pumpswap ? "PS" : "",
                t.venues.raydium ? "RAY" : "",
                t.venues.meteora ? "MET" : "",
                t.venues.orca ? "ORC" : "",
            ].filter(Boolean).join("+");
            const beatable = lamportsToSol(t.poolAbsorbedLamports + t.tier3BeatableLamports).toFixed(4);
            const pool = lamportsToSol(t.poolAbsorbedLamports).toFixed(4);
            const t3 = lamportsToSol(t.tier3BeatableLamports).toFixed(4);
            console.log(
                `   ${t.mint.slice(0, 22)}.. ${beatable.padStart(12)} ${pool.padStart(10)} ${t3.padStart(10)} ${venues}`
            );
        }
    }

    console.log(`\n📋 KEY INSIGHTS`);

    if (beatableOpportunity > tier1 + tier2) {
        console.log(`   ✅ MORE BEATABLE THAN UNBEATABLE - Market is inefficient!`);
        console.log(`      ${((beatableOpportunity / totalCapturable) * 100).toFixed(0)}% of market is beatable`);
    } else {
        console.log(`   ⚠️ Strong competition - ${(((tier1 + tier2) / totalCapturable) * 100).toFixed(0)}% captured by T1/T2`);
    }

    if (metrics.jitoTxCount > metrics.totalEvents * 0.2) {
        console.log(`   ⚠️ High Jito usage (${((metrics.jitoTxCount / metrics.totalEvents) * 100).toFixed(0)}%) - Consider Jito bundle submission`);
    } else {
        console.log(`   ✅ Low Jito usage (${((metrics.jitoTxCount / metrics.totalEvents) * 100).toFixed(0)}%) - Priority fees may suffice`);
    }

    if (poolAbsorbed > tier3) {
        console.log(`   ✅ Large pool-absorbed opportunity - First mover advantage available`);
    }

    console.log("\n" + "=".repeat(90));

    // Save data files
    const fracturedPath = path.join(DATA_DIR, "fractured_tokens.json");
    const fracturedExport = fracturedTokens.map((t) => ({
        mint: t.mint,
        venues: t.venues,
        beatableSOL: lamportsToSol(t.poolAbsorbedLamports + t.tier3BeatableLamports),
        poolAbsorbedSOL: lamportsToSol(t.poolAbsorbedLamports),
        tier3SOL: lamportsToSol(t.tier3BeatableLamports),
        tier2SOL: lamportsToSol(t.tier2DifficultLamports),
        tier1SOL: lamportsToSol(t.tier1UnbeatableLamports),
        totalLossSOL: lamportsToSol(t.totalLossLamports),
        totalTxCount: t.totalTxCount,
    })).sort((a, b) => b.beatableSOL - a.beatableSOL);
    fs.writeFileSync(fracturedPath, JSON.stringify(fracturedExport, null, 2));

    const competitorPath = path.join(DATA_DIR, "competitors.json");
    const competitorExport = allCompetitors.map((c) => ({
        wallet: c.wallet,
        tier: c.tier,
        totalGainsSOL: lamportsToSol(c.totalGainsLamports),
        eventCount: c.eventCount,
        usesJito: c.usesJito,
        jitoTipEvents: c.jitoTipEvents,
        usesAggregator: c.usesAggregator,
        aggregatorEvents: c.aggregatorEvents,
        directArbEvents: c.directArbEvents,
        tokensCount: c.tokensTouched.size,
    })).sort((a, b) => b.totalGainsSOL - a.totalGainsSOL);
    fs.writeFileSync(competitorPath, JSON.stringify(competitorExport, null, 2));

    const summaryPath = path.join(DATA_DIR, "opportunity_summary.json");
    const summary = {
        runtimeSeconds: runtimeSec,
        totalEvents: metrics.totalEvents,
        fracturedTokens: fracturedTokens.length,
        totalPumpLossSOL: totalLoss,
        totalCapturableSOL: totalCapturable,
        tier1UnbeatableSOL: tier1,
        tier2DifficultSOL: tier2,
        tier3BeatableSOL: tier3,
        poolAbsorbedSOL: poolAbsorbed,
        beatableOpportunitySOL: beatableOpportunity,
        hourlyBeatableSOL: hourlyBeatable,
        dailyBeatableSOL: hourlyBeatable * 24,
        jitoUsageRate: metrics.jitoTxCount / Math.max(metrics.totalEvents, 1),
        avgJitoTipSOL: avgJitoTip,
    };
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

    console.log(`\n💾 Data saved:`);
    console.log(`   ${fracturedPath}`);
    console.log(`   ${competitorPath}`);
    console.log(`   ${summaryPath}`);
}

// ============================================================================
// BATCH PROCESSOR
// ============================================================================

class BatchProcessor {
    private queue: SignatureQueue;
    private writer: JsonlWriter;
    private metrics: LiveMetrics;
    private runId: string;
    private processing = false;
    private startTime: number;

    constructor(writer: JsonlWriter, runId: string) {
        this.queue = new SignatureQueue();
        this.writer = writer;
        this.metrics = createMetrics();
        this.runId = runId;
        this.startTime = Date.now();
    }

    enqueue(sig: string, slot: number): void {
        this.metrics.sigsReceived++;
        this.queue.enqueue(sig, slot);
    }

    async startProcessing(): Promise<void> {
        if (this.processing) return;
        this.processing = true;

        while (this.processing) {
            const batch = this.queue.getBatch(BATCH_SIZE);

            if (batch.length === 0) {
                await this.sleep(100);
                continue;
            }

            const signatures = batch.map((b) => b.signature);
            const slotMap = new Map(batch.map((b) => [b.signature, b.slot]));

            const recvMs = Date.now();
            const txMap = await fetchTransactionBatch(signatures);

            for (const [sig, tx] of txMap) {
                const slot = slotMap.get(sig) ?? 0;
                const event = buildKpiEvent(this.runId, slot, sig, recvMs, tx, this.metrics.tokenRegistry);
                this.writer.write(event);
                updateMetrics(this.metrics, event);
            }

            this.metrics.batchesProcessed++;
            this.metrics.sigsDropped = this.queue.dropped;

            await this.sleep(BATCH_INTERVAL_MS);
        }
    }

    stop(): void {
        this.processing = false;
    }

    getMetrics(): LiveMetrics {
        return this.metrics;
    }

    getRuntimeSec(): number {
        return (Date.now() - this.startTime) / 1000;
    }

    getQueueStats(): { size: number; dropped: number } {
        return { size: this.queue.size, dropped: this.queue.dropped };
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((r) => setTimeout(r, ms));
    }
}

// ============================================================================
// WEBSOCKET
// ============================================================================

let ws: WebSocket | null = null;
let processor: BatchProcessor | null = null;
let lastMsgMs = Date.now();
let reconnectBackoff = 2000;

function sendSubscriptions(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    let id = 1;
    for (const pid of SUBSCRIBE_PROGRAMS) {
        ws.send(
            JSON.stringify({
                jsonrpc: "2.0",
                id: id++,
                method: "logsSubscribe",
                params: [{ mentions: [pid] }],
            })
        );
    }
    log(`Subscriptions sent for ${SUBSCRIBE_PROGRAMS.length} programs`);
}

function handleMessage(data: RawData): void {
    lastMsgMs = Date.now();
    let obj: any;
    try {
        obj = JSON.parse(data.toString("utf8"));
    } catch {
        return;
    }

    if (obj.method === "logsNotification") {
        const slot = obj.params?.result?.context?.slot;
        const sig = obj.params?.result?.value?.signature;

        if (typeof slot === "number" && typeof sig === "string" && processor) {
            processor.enqueue(sig, slot);
        }
    }
}

function connect(): void {
    log("Connecting WebSocket...");
    ws = new WebSocket(HELIUS_WS_URL);
    ws.on("open", () => {
        log("WebSocket open");
        lastMsgMs = Date.now();
        reconnectBackoff = 2000;
        sendSubscriptions();
    });
    ws.on("message", handleMessage);
    ws.on("error", (e) => logError("WS error", e));
    ws.on("close", reconnect);
}

function reconnect(): void {
    if (ws) {
        ws.removeAllListeners();
        try {
            ws.close();
        } catch { }
        ws = null;
    }
    log(`Reconnecting in ${reconnectBackoff}ms...`);
    setTimeout(() => {
        reconnectBackoff = Math.min(reconnectBackoff * 2, 60000);
        connect();
    }, reconnectBackoff);
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
    ensureDataDir();
    const runId = `run_${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const outPath = path.join(DATA_DIR, "helius_kpi_stream.jsonl");

    const writer = new JsonlWriter(outPath);
    processor = new BatchProcessor(writer, runId);

    log(`Run ID: ${runId}`);
    log(`Output: ${outPath}`);
    log(`Batch size: ${BATCH_SIZE} | Interval: ${BATCH_INTERVAL_MS}ms`);
    log(`Queue capacity: ${MAX_QUEUE_SIZE} signatures`);
    log("");
    log("Subscribed programs:");
    log("  Core DEXs: PumpSwap, Raydium V4/CLMM, Meteora DLMM");
    log("  Aggregators: Jupiter V4/V6");
    log("");
    log("Detecting (all activity):");
    log("  Additional DEXs: Orca, Phoenix, Openbook");
    log("  MEV: Jito tip accounts (8 known)");
    log("  Routers: Raydium Router");
    log("");
    log("Competition tiers:");
    log("  🔴 TIER 1 = Jito bundles (unbeatable)");
    log("  🟡 TIER 2 = Aggregators (difficult)");
    log("  🟢 TIER 3 = Slow/inefficient (beatable)");
    log("  💎 POOL ABSORBED = No one captured (your opportunity)");
    log("");
    log("Starting... (Ctrl+C for comprehensive analysis)");

    connect();
    void processor.startProcessing();

    // Heartbeat
    setInterval(() => {
        if (!processor) return;
        const stats = processor.getQueueStats();
        const m = processor.getMetrics();
        const beatable = lamportsToSol(m.tier3BeatableLamports + m.poolAbsorbedLamports).toFixed(4);
        const captured = lamportsToSol(m.tier1UnbeatableLamports + m.tier2DifficultLamports).toFixed(4);
        const fractured = Array.from(m.tokenRegistry.values()).filter(isTokenFractured).length;

        log(
            `HEARTBEAT | events=${m.totalEvents} | queue=${stats.size} | ` +
            `beatable=${beatable} | hardCapture=${captured} | fractured=${fractured} | jito=${m.jitoTxCount}`
        );
    }, 10000);

    // Watchdog
    setInterval(() => {
        if (Date.now() - lastMsgMs > 30000) {
            log("Watchdog timeout, reconnecting...");
            reconnect();
        }
    }, 10000);

    // Graceful shutdown
    const shutdown = () => {
        if (!processor) return;
        processor.stop();
        printMetricsSummary(processor.getMetrics(), processor.getRuntimeSec());
        writer.close();
        if (ws) {
            try {
                ws.close();
            } catch { }
        }
        process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main().catch(console.error);