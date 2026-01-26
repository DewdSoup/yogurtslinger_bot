// src/scripts/helius_kpi_stream.ts

import fs from "node:fs";
import path from "node:path";
import WebSocket, { RawData } from "ws";
import { fileURLToPath } from "node:url";

// Type-only declaration so TypeScript is happy; Node 18+ provides fetch at runtime
declare function fetch(input: any, init?: any): Promise<any>;

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------

const RUN_LABEL = "[helius_kpi_stream]";

// Use your real keys as requested
const HELIUS_HTTP_API_KEY = "2bb675f2-573f-4561-b57f-d351db310e5a";
const HELIUS_WS_API_KEY = "bff504b3-c294-46e9-b7d8-dacbcb4b9e3d";

const HELIUS_HTTP_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_HTTP_API_KEY}`;
const HELIUS_WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_WS_API_KEY}`;

// Target programs (ALL pools under each, not a single pool)
const PROGRAM_IDS: Record<string, string> = {
    // Pump AMM (PumpSwap)
    pumpswap: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    // Raydium V4 AMM
    raydium_v4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    // Raydium CLMM
    raydium_clmm: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    // Meteora DLMM
    meteora_dlmm: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
};

const HEARTBEAT_INTERVAL_MS = 10_000;
const WATCHDOG_TIMEOUT_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 10_000;
const INITIAL_RECONNECT_BACKOFF_MS = 2_000;
const MAX_RECONNECT_BACKOFF_MS = 60_000;

// ----------------------------------------------------------------------------
// Rate Limiting Config (Helius $50 plan ~ 50 RPS, stay conservative)
// ----------------------------------------------------------------------------

const TARGET_RPS = 25; // Safe margin under 50 RPS limit
const REQUEST_INTERVAL_MS = Math.ceil(1000 / TARGET_RPS); // ~40ms between requests
const MAX_QUEUE_SIZE = 5000; // Drop oldest if queue gets too large
const MAX_RETRIES = 3;
const RATE_LIMIT_BACKOFF_BASE_MS = 1000; // Base backoff on 429
const RATE_LIMIT_BACKOFF_MAX_MS = 30_000;
const SIGNATURE_TTL_MS = 60_000; // Don't process signatures older than 60s

// ----------------------------------------------------------------------------
// MEV / KPI thresholds (tunable later)
// ----------------------------------------------------------------------------

const LAMPORTS_PER_SOL = 1_000_000_000;
const BIG_WIN_LAMPORTS = 1 * LAMPORTS_PER_SOL; // 1 SOL
const LARGE_TOKEN_MOVE_THRESHOLD = 10; // ui tokens (very coarse)

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

interface KpiEvent {
    runId: string;
    ts: string; // ISO timestamp when we processed the event
    slot: number;
    signature: string;

    // Program footprint
    programTags: string[];
    primaryProgramTag: string | null | undefined;
    matchedProgramIds: string[];
    allProgramIds: string[];
    comboType: string; // e.g. "PS_ONLY", "PS_MET", "TRIPLE", "OTHER"

    // Execution cost
    cuConsumed: number | null;
    feeLamports: number | null;
    feePerCu: number | null;
    feePerCuTier: string | null; // "low" | "med" | "high" | "insane" | null

    // Structural complexity
    logMessagesCount: number;
    innerInstructionCount: number;
    writableAccountCount: number;
    readOnlyAccountCount: number;
    signerCount: number;

    // Timing
    latencyMs: number | null; // recv_time - blockTime

    // Token-level footprint
    preTokenBalanceCount: number;
    postTokenBalanceCount: number;
    maxTokenBalanceChange: number | null; // max abs delta uiAmount across (mint, owner)
    tokenMintsInvolved: string[];
    isLargeTokenMove: boolean;

    // Trader-ish SOL delta (first signer if available)
    primarySignerSolDelta: number | null; // lamports delta for primary signer
    isBigWin: boolean;
    isBigLoss: boolean;

    // NEW: identity of primary signer
    primarySignerPubkey: string | null;

    // NEW: where the SOL is going in this tx
    maxSolGainerPubkey: string | null;
    maxSolGainerLamports: number | null;
    maxSolLoserPubkey: string | null;
    maxSolLoserLamports: number | null;

    // NEW: Pump-focused helpers for dynamic hot-mint detection
    primaryPumpMint: string | null; // first mint for PumpSwap trades
    isPumpLoss: boolean; // primary signer losing SOL on PumpSwap
    isPumpLossMultiVenue: boolean; // Pump loss and comboType !== PS_ONLY
}

interface AccountsInfo {
    allAccountKeys: string[];
    signerCount: number;
    writableAccountCount: number;
    readOnlyAccountCount: number;
    primarySignerIndex: number | null;
    primarySignerPubkey: string | null;
}

interface TokenBalanceInfo {
    tokenMintsInvolved: string[];
    maxTokenBalanceChange: number | null;
    preTokenBalanceCount: number;
    postTokenBalanceCount: number;
}

interface ProgramInfo {
    matchedProgramIds: string[];
    matchedProgramTags: string[];
    allProgramIds: string[];
    primaryProgramTag: string | null;
}

interface QueuedSignature {
    signature: string;
    slot: number;
    enqueuedAt: number;
    retryCount: number;
}

// ----------------------------------------------------------------------------
// File + logging helpers
// ----------------------------------------------------------------------------

class JsonlWriter {
    private stream: fs.WriteStream;
    private closed = false;

    constructor(public readonly filePath: string) {
        this.stream = fs.createWriteStream(filePath, { flags: "a" });
    }

    write(obj: KpiEvent): void {
        if (this.closed) return;
        const line = JSON.stringify(obj);
        this.stream.write(line + "\n");
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.stream.end();
    }
}

function logInfo(msg: string): void {
    console.log(`${RUN_LABEL} ${msg}`);
}

function logError(msg: string, err?: unknown, extra?: string): void {
    if (err instanceof Error) {
        console.error(`${RUN_LABEL} ${msg}: ${err.message}`);
    } else {
        console.error(`${RUN_LABEL} ${msg}`);
    }
    if (extra) {
        console.error(`${RUN_LABEL} ${extra}`);
    }
}

function logDebug(_msg: string): void {
    // Uncomment for verbose debugging
    // console.log(`${RUN_LABEL} [DEBUG] ${_msg}`);
}

// ----------------------------------------------------------------------------
// Rate-Limited Request Queue
// ----------------------------------------------------------------------------

class RateLimitedQueue {
    private queue: QueuedSignature[] = [];
    private seenSignatures = new Set<string>();
    private processing = false;
    private currentBackoffMs = 0;
    private lastRequestTimeMs = 0;
    private processedCount = 0;
    private droppedCount = 0;
    private rateLimitedCount = 0;

    constructor(
        private readonly processFunc: (item: QueuedSignature) => Promise<boolean>,
        private readonly targetRps: number = TARGET_RPS
    ) { }

    enqueue(signature: string, slot: number): void {
        if (this.seenSignatures.has(signature)) {
            logDebug(`Skipping duplicate signature: ${signature.slice(0, 16)}...`);
            return;
        }

        if (this.queue.length >= MAX_QUEUE_SIZE) {
            const dropped = this.queue.shift();
            if (dropped) {
                this.seenSignatures.delete(dropped.signature);
                this.droppedCount++;
            }
        }

        this.seenSignatures.add(signature);
        this.queue.push({
            signature,
            slot,
            enqueuedAt: Date.now(),
            retryCount: 0,
        });

        if (!this.processing) {
            void this.startProcessing();
        }
    }

    requeue(item: QueuedSignature): void {
        if (item.retryCount >= MAX_RETRIES) {
            logDebug(`Max retries exceeded for ${item.signature.slice(0, 16)}...`);
            this.seenSignatures.delete(item.signature);
            return;
        }

        item.retryCount++;
        this.queue.unshift(item);
    }

    applyBackoff(): void {
        if (this.currentBackoffMs === 0) {
            this.currentBackoffMs = RATE_LIMIT_BACKOFF_BASE_MS;
        } else {
            this.currentBackoffMs = Math.min(
                this.currentBackoffMs * 2,
                RATE_LIMIT_BACKOFF_MAX_MS
            );
        }
        this.rateLimitedCount++;
        logInfo(`Rate limited, backing off for ${this.currentBackoffMs}ms`);
    }

    clearBackoff(): void {
        this.currentBackoffMs = 0;
    }

    private async startProcessing(): Promise<void> {
        if (this.processing) return;
        this.processing = true;

        while (this.queue.length > 0) {
            if (this.currentBackoffMs > 0) {
                await this.sleep(this.currentBackoffMs);
            }

            const now = Date.now();
            const intervalMs = Math.ceil(1000 / this.targetRps);
            const elapsed = now - this.lastRequestTimeMs;
            if (elapsed < intervalMs) {
                await this.sleep(intervalMs - elapsed);
            }

            const item = this.queue.shift();
            if (!item) continue;

            if (Date.now() - item.enqueuedAt > SIGNATURE_TTL_MS) {
                logDebug(`Skipping stale signature: ${item.signature.slice(0, 16)}...`);
                this.seenSignatures.delete(item.signature);
                this.droppedCount++;
                continue;
            }

            this.lastRequestTimeMs = Date.now();

            try {
                const success = await this.processFunc(item);
                if (success) {
                    this.processedCount++;
                    this.clearBackoff();
                }
            } catch (e) {
                logError(`Queue processor error`, e);
            }

            if (this.processedCount % 1000 === 0) {
                this.pruneSeenSignatures();
            }
        }

        this.processing = false;
    }

    private pruneSeenSignatures(): void {
        const inQueue = new Set(this.queue.map((q) => q.signature));
        for (const sig of this.seenSignatures) {
            if (!inQueue.has(sig)) {
                this.seenSignatures.delete(sig);
            }
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    getStats() {
        return {
            queueSize: this.queue.length,
            processed: this.processedCount,
            dropped: this.droppedCount,
            rateLimited: this.rateLimitedCount,
            backoffMs: this.currentBackoffMs,
        };
    }
}

// ----------------------------------------------------------------------------
// Global state
// ----------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let ws: WebSocket | null = null;
let heartbeatInterval: NodeJS.Timeout | null = null;
let watchdogInterval: NodeJS.Timeout | null = null;

let lastMessageTimeMs = Date.now();
let reconnectBackoffMs = INITIAL_RECONNECT_BACKOFF_MS;

let currentRunId = "";
let currentWriter: JsonlWriter | null = null;
let requestQueue: RateLimitedQueue | null = null;

const stats = {
    totalEvents: 0,
    distinctSlots: new Set<number>(),
    successfulFetches: 0,
};

// ----------------------------------------------------------------------------
// RPC helpers
// ----------------------------------------------------------------------------

interface FetchResult {
    success: boolean;
    rateLimited: boolean;
    data: any | null;
}

async function fetchFullTransaction(signature: string): Promise<FetchResult> {
    const body = {
        jsonrpc: "2.0",
        id: "getTransaction",
        method: "getTransaction",
        params: [
            signature,
            {
                encoding: "jsonParsed",
                maxSupportedTransactionVersion: 0,
            },
        ],
    };

    try {
        const response = await fetch(HELIUS_HTTP_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        });

        const data = await response.json();

        if (data.error) {
            const errorCode = data.error.code;
            if (errorCode === -32429) {
                return { success: false, rateLimited: true, data: null };
            }
            logError(
                `getTransaction error for ${signature.slice(0, 16)}...`,
                undefined,
                JSON.stringify(data.error)
            );
            return { success: false, rateLimited: false, data: null };
        }

        return { success: true, rateLimited: false, data: data.result ?? null };
    } catch (e) {
        logError(`fetch error for ${signature.slice(0, 16)}...`, e);
        return { success: false, rateLimited: false, data: null };
    }
}

// ----------------------------------------------------------------------------
// KPI / feature helpers
// ----------------------------------------------------------------------------

function extractAccountsInfo(message: any): AccountsInfo {
    const allAccountKeys: string[] = [];
    let signerCount = 0;
    let writableAccountCount = 0;
    let readOnlyAccountCount = 0;
    let primarySignerIndex: number | null = null;
    let primarySignerPubkey: string | null = null;

    const keys = message?.accountKeys;
    if (!Array.isArray(keys)) {
        return {
            allAccountKeys,
            signerCount,
            writableAccountCount,
            readOnlyAccountCount,
            primarySignerIndex,
            primarySignerPubkey,
        };
    }

    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];

        if (typeof k === "string") {
            allAccountKeys.push(k);
            continue;
        }

        if (k && typeof k === "object") {
            const pubkey: string | undefined =
                typeof (k as any).pubkey === "string"
                    ? (k as any).pubkey
                    : typeof (k as any).key === "string"
                        ? (k as any).key
                        : undefined;
            if (pubkey) {
                allAccountKeys.push(pubkey);
            }

            const isSigner = !!(k as any).signer;
            const isWritable = !!(k as any).writable;

            if (isSigner) {
                signerCount++;
                if (primarySignerIndex === null) {
                    primarySignerIndex = i;
                    primarySignerPubkey = pubkey ?? null;
                }
            }

            if (isWritable) {
                writableAccountCount++;
            } else {
                readOnlyAccountCount++;
            }
        }
    }

    return {
        allAccountKeys,
        signerCount,
        writableAccountCount,
        readOnlyAccountCount,
        primarySignerIndex,
        primarySignerPubkey,
    };
}

function extractTokenBalanceInfo(meta: any): TokenBalanceInfo {
    const tokenMintsSet = new Set<string>();
    let maxChange = 0;
    let preCount = 0;
    let postCount = 0;

    const preMap = new Map<string, { mint: string; owner: string; amount: number }>();
    const postMap = new Map<string, { mint: string; owner: string; amount: number }>();

    const preArr: any[] = Array.isArray(meta?.preTokenBalances)
        ? meta.preTokenBalances
        : [];
    const postArr: any[] = Array.isArray(meta?.postTokenBalances)
        ? meta.postTokenBalances
        : [];

    preCount = preArr.length;
    postCount = postArr.length;

    for (const entry of preArr) {
        if (!entry) continue;
        const mint = typeof entry.mint === "string" ? entry.mint : "";
        const owner = typeof entry.owner === "string" ? entry.owner : "";
        if (!mint || !owner) continue;

        let uiAmount = 0;
        if (entry.uiTokenAmount) {
            if (typeof entry.uiTokenAmount.uiAmount === "number") {
                uiAmount = entry.uiTokenAmount.uiAmount;
            } else if (typeof entry.uiTokenAmount.uiAmountString === "string") {
                const parsed = Number(entry.uiTokenAmount.uiAmountString);
                uiAmount = Number.isFinite(parsed) ? parsed : 0;
            }
        }

        const key = `${mint}:${owner}`;
        preMap.set(key, { mint, owner, amount: uiAmount });
    }

    for (const entry of postArr) {
        if (!entry) continue;
        const mint = typeof entry.mint === "string" ? entry.mint : "";
        const owner = typeof entry.owner === "string" ? entry.owner : "";
        if (!mint || !owner) continue;

        let uiAmount = 0;
        if (entry.uiTokenAmount) {
            if (typeof entry.uiTokenAmount.uiAmount === "number") {
                uiAmount = entry.uiTokenAmount.uiAmount;
            } else if (typeof entry.uiTokenAmount.uiAmountString === "string") {
                const parsed = Number(entry.uiTokenAmount.uiAmountString);
                uiAmount = Number.isFinite(parsed) ? parsed : 0;
            }
        }

        const key = `${mint}:${owner}`;
        postMap.set(key, { mint, owner, amount: uiAmount });
    }

    for (const [key, post] of postMap.entries()) {
        const pre = preMap.get(key);
        const delta = post.amount - (pre ? pre.amount : 0);
        const absDelta = Math.abs(delta);
        if (absDelta > maxChange) maxChange = absDelta;
        tokenMintsSet.add(post.mint);
    }

    for (const [key, pre] of preMap.entries()) {
        if (!postMap.has(key)) {
            const absDelta = Math.abs(pre.amount);
            if (absDelta > maxChange) maxChange = absDelta;
            tokenMintsSet.add(pre.mint);
        }
    }

    return {
        tokenMintsInvolved: Array.from(tokenMintsSet),
        maxTokenBalanceChange: maxChange === 0 ? null : maxChange,
        preTokenBalanceCount: preCount,
        postTokenBalanceCount: postCount,
    };
}

function extractProgramInfo(allAccountKeys: string[]): ProgramInfo {
    const matchedProgramIds: string[] = [];
    const matchedProgramTags: string[] = [];

    for (const [tag, programId] of Object.entries(PROGRAM_IDS)) {
        if (allAccountKeys.includes(programId)) {
            matchedProgramIds.push(programId);
            matchedProgramTags.push(tag);
        }
    }

    const primaryProgramTag: string | null =
        matchedProgramTags.length > 0 ? matchedProgramTags[0]! : null;
    const allProgramIds = matchedProgramIds.slice();

    return { matchedProgramIds, matchedProgramTags, allProgramIds, primaryProgramTag };
}

function deriveComboType(programTags: string[]): string {
    const hasPS = programTags.includes("pumpswap");
    const hasRayV4 = programTags.includes("raydium_v4");
    const hasRayCLMM = programTags.includes("raydium_clmm");
    const hasRay = hasRayV4 || hasRayCLMM;
    const hasMet = programTags.includes("meteora_dlmm");

    if (hasPS && !hasRay && !hasMet) return "PS_ONLY";
    if (!hasPS && hasRay && !hasMet) return "RAY_ONLY";
    if (!hasPS && !hasRay && hasMet) return "MET_ONLY";
    if (hasPS && hasMet && !hasRay) return "PS_MET";
    if (hasPS && hasRay && !hasMet) return "PS_RAY";
    if (!hasPS && hasRay && hasMet) return "MET_RAY";
    if (hasPS && hasRay && hasMet) return "TRIPLE";
    return "OTHER";
}

function classifyFeePerCu(feePerCu: number | null): string | null {
    if (feePerCu === null) return null;
    if (feePerCu < 0.1) return "low";
    if (feePerCu < 1) return "med";
    if (feePerCu < 10) return "high";
    return "insane";
}

function buildKpiEvent(
    runId: string,
    slotFromWs: number,
    signature: string,
    recvTimeMs: number,
    tx: any
): KpiEvent {
    const slot: number = typeof tx.slot === "number" ? tx.slot : slotFromWs;
    const blockTimeSec: number | null =
        typeof tx.blockTime === "number" ? tx.blockTime : null;
    const latencyMs: number | null =
        blockTimeSec !== null ? recvTimeMs - blockTimeSec * 1000 : null;

    const meta: any = tx.meta ?? null;
    const message: any = tx.transaction?.message ?? null;

    let cuConsumed: number | null = null;
    let feeLamports: number | null = null;
    let logMessagesCount = 0;
    let innerInstructionCount = 0;
    let preBalances: number[] | null = null;
    let postBalances: number[] | null = null;

    if (meta) {
        if (typeof meta.computeUnitsConsumed === "number") {
            cuConsumed = meta.computeUnitsConsumed;
        }
        if (typeof meta.fee === "number") {
            feeLamports = meta.fee;
        }
        if (Array.isArray(meta.logMessages)) {
            logMessagesCount = meta.logMessages.length;
        }
        if (Array.isArray(meta.innerInstructions)) {
            for (const entry of meta.innerInstructions) {
                if (Array.isArray(entry?.instructions)) {
                    innerInstructionCount += entry.instructions.length;
                }
            }
        }
        if (Array.isArray(meta.preBalances)) {
            preBalances = meta.preBalances as number[];
        }
        if (Array.isArray(meta.postBalances)) {
            postBalances = meta.postBalances as number[];
        }
    }

    const feePerCu: number | null =
        cuConsumed && feeLamports ? feeLamports / cuConsumed : null;
    const feePerCuTier = classifyFeePerCu(feePerCu);

    const accountsInfo = extractAccountsInfo(message);
    const {
        allAccountKeys,
        signerCount,
        writableAccountCount,
        readOnlyAccountCount,
        primarySignerIndex,
        primarySignerPubkey,
    } = accountsInfo;

    let primarySignerSolDelta: number | null = null;
    if (
        primarySignerIndex !== null &&
        preBalances !== null &&
        postBalances !== null &&
        primarySignerIndex < preBalances.length &&
        primarySignerIndex < postBalances.length
    ) {
        const preVal = preBalances[primarySignerIndex];
        const postVal = postBalances[primarySignerIndex];
        if (preVal !== undefined && postVal !== undefined) {
            primarySignerSolDelta = postVal - preVal;
        }
    }

    let maxSolGainerPubkey: string | null = null;
    let maxSolGainerLamports: number | null = null;
    let maxSolLoserPubkey: string | null = null;
    let maxSolLoserLamports: number | null = null;

    if (
        preBalances !== null &&
        postBalances !== null &&
        preBalances.length > 0 &&
        postBalances.length > 0
    ) {
        const len = Math.min(
            preBalances.length,
            postBalances.length,
            allAccountKeys.length
        );
        for (let i = 0; i < len; i++) {
            const preVal = preBalances[i] ?? 0;
            const postVal = postBalances[i] ?? 0;
            const delta = postVal - preVal;
            const key = allAccountKeys[i] ?? null;

            if (delta > 0) {
                if (maxSolGainerLamports === null || delta > maxSolGainerLamports) {
                    maxSolGainerLamports = delta;
                    maxSolGainerPubkey = key;
                }
            } else if (delta < 0) {
                if (maxSolLoserLamports === null || delta < maxSolLoserLamports) {
                    maxSolLoserLamports = delta;
                    maxSolLoserPubkey = key;
                }
            }
        }
    }

    const tokenInfo = extractTokenBalanceInfo(meta);
    const {
        tokenMintsInvolved,
        maxTokenBalanceChange,
        preTokenBalanceCount,
        postTokenBalanceCount,
    } = tokenInfo;

    const programInfo = extractProgramInfo(allAccountKeys);
    const {
        matchedProgramIds,
        matchedProgramTags,
        allProgramIds,
        primaryProgramTag,
    } = programInfo;

    const comboType = deriveComboType(matchedProgramTags);

    const isBigWin =
        primarySignerSolDelta !== null &&
        primarySignerSolDelta > BIG_WIN_LAMPORTS;
    const isBigLoss =
        primarySignerSolDelta !== null &&
        primarySignerSolDelta < -BIG_WIN_LAMPORTS;

    const isLargeTokenMove =
        maxTokenBalanceChange !== null &&
        maxTokenBalanceChange > LARGE_TOKEN_MOVE_THRESHOLD;

    let primaryPumpMint: string | null = null;
    if (primaryProgramTag === "pumpswap" && tokenMintsInvolved.length > 0) {
        primaryPumpMint = tokenMintsInvolved[0] ?? null;
    }

    const isPumpLoss =
        primaryProgramTag === "pumpswap" &&
        primarySignerSolDelta !== null &&
        primarySignerSolDelta < 0;

    const isPumpLossMultiVenue =
        isPumpLoss && comboType !== "PS_ONLY";

    const event: KpiEvent = {
        runId,
        ts: new Date(recvTimeMs).toISOString(),
        slot,
        signature,

        programTags: matchedProgramTags,
        primaryProgramTag: primaryProgramTag ?? null,
        matchedProgramIds,
        allProgramIds,
        comboType,

        cuConsumed,
        feeLamports,
        feePerCu,
        feePerCuTier,

        logMessagesCount,
        innerInstructionCount,
        writableAccountCount,
        readOnlyAccountCount,
        signerCount,

        latencyMs,

        preTokenBalanceCount,
        postTokenBalanceCount,
        maxTokenBalanceChange,
        tokenMintsInvolved,
        isLargeTokenMove,

        primarySignerSolDelta,
        isBigWin,
        isBigLoss,

        primarySignerPubkey,

        maxSolGainerPubkey,
        maxSolGainerLamports,
        maxSolLoserPubkey,
        maxSolLoserLamports,

        primaryPumpMint,
        isPumpLoss,
        isPumpLossMultiVenue,
    };

    return event;
}

// ----------------------------------------------------------------------------
// Queue processor function
// ----------------------------------------------------------------------------

async function processQueuedSignature(item: QueuedSignature): Promise<boolean> {
    if (!currentWriter || !currentRunId || !requestQueue) return false;

    const recvTimeMs = Date.now();
    const result = await fetchFullTransaction(item.signature);

    if (result.rateLimited) {
        requestQueue.applyBackoff();
        requestQueue.requeue(item);
        return false;
    }

    if (!result.success || !result.data) {
        if (item.retryCount < MAX_RETRIES) {
            requestQueue.requeue(item);
        }
        return false;
    }

    const event = buildKpiEvent(
        currentRunId,
        item.slot,
        item.signature,
        recvTimeMs,
        result.data
    );
    currentWriter.write(event);
    stats.successfulFetches++;

    return true;
}

// ----------------------------------------------------------------------------
// WebSocket handling (Standard WS + logsSubscribe)
// ----------------------------------------------------------------------------

function sendSubscriptions(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    let idCounter = 1;
    for (const programId of Object.values(PROGRAM_IDS)) {
        const request = {
            jsonrpc: "2.0",
            id: idCounter++,
            method: "logsSubscribe",
            params: [
                {
                    mentions: [programId],
                },
            ],
        };

        logInfo(
            `Sending logsSubscribe for program ${programId}: ${JSON.stringify(
                request
            )}`
        );
        ws.send(JSON.stringify(request));
    }
}

async function handleWsMessage(data: RawData): Promise<void> {
    lastMessageTimeMs = Date.now();
    const messageStr = data.toString("utf8");

    let obj: any;
    try {
        obj = JSON.parse(messageStr);
    } catch (e) {
        logError("Failed to parse WS JSON", e, messageStr.slice(0, 200));
        return;
    }

    if (obj.error) {
        logError("WebSocket RPC error", undefined, JSON.stringify(obj.error));
        return;
    }

    if (obj.result !== undefined && !obj.method) {
        logInfo(`Subscription confirmed with id=${obj.result}`);
        return;
    }

    if (obj.method === "logsNotification") {
        const result = obj.params?.result;
        const slot = result?.context?.slot;
        const signature = result?.value?.signature;

        if (typeof slot !== "number" || typeof signature !== "string") {
            logError(
                "Unexpected logsNotification shape",
                undefined,
                messageStr.slice(0, 200)
            );
            return;
        }

        stats.totalEvents++;
        stats.distinctSlots.add(slot);

        if (requestQueue) {
            requestQueue.enqueue(signature, slot);
        }
    }
}

function connectWebSocket(): void {
    logInfo("Connecting to Helius WebSocket...");
    ws = new WebSocket(HELIUS_WS_URL);

    ws.on("open", () => {
        logInfo("WebSocket open, subscribing...");
        lastMessageTimeMs = Date.now();
        reconnectBackoffMs = INITIAL_RECONNECT_BACKOFF_MS;
        sendSubscriptions();
    });

    ws.on("message", (data: RawData) => {
        void handleWsMessage(data);
    });

    ws.on("error", (err: Error) => {
        logError("WebSocket error", err);
    });

    ws.on("close", () => {
        logInfo("WebSocket closed.");
        reconnectWithBackoff();
    });
}

function reconnectWithBackoff(): void {
    if (ws) {
        try {
            ws.removeAllListeners();
            ws.close();
        } catch {
            // ignore
        }
        ws = null;
    }

    const delay = reconnectBackoffMs;
    logInfo(`Reconnecting in ${delay} ms...`);
    setTimeout(() => {
        reconnectBackoffMs = Math.min(
            reconnectBackoffMs * 2,
            MAX_RECONNECT_BACKOFF_MS
        );
        connectWebSocket();
    }, delay);
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
    const now = new Date();
    currentRunId = `run_${now.toISOString().replace(/[:.]/g, "-")}`;

    const dataDir = path.join(__dirname, "data");
    fs.mkdirSync(dataDir, { recursive: true });

    const outPath = path.join(dataDir, "helius_kpi_stream.jsonl");
    currentWriter = new JsonlWriter(outPath);

    requestQueue = new RateLimitedQueue(processQueuedSignature, TARGET_RPS);

    logInfo(`${currentRunId} writing JSONL to: ${outPath}`);
    logInfo(`Starting KPI stream runId=${currentRunId}...`);
    logInfo(
        `Rate limit config: ${TARGET_RPS} RPS, ${REQUEST_INTERVAL_MS}ms between requests`
    );

    connectWebSocket();

    heartbeatInterval = setInterval(() => {
        const queueStats = requestQueue?.getStats() ?? {
            queueSize: 0,
            processed: 0,
            dropped: 0,
            rateLimited: 0,
            backoffMs: 0,
        };

        logInfo(
            `HEARTBEAT runId=${currentRunId} ` +
            `wsEvents=${stats.totalEvents} ` +
            `distinctSlots=${stats.distinctSlots.size} ` +
            `fetched=${stats.successfulFetches} ` +
            `queue=${queueStats.queueSize} ` +
            `dropped=${queueStats.dropped} ` +
            `rateLimits=${queueStats.rateLimited} ` +
            `backoff=${queueStats.backoffMs}ms`
        );
    }, HEARTBEAT_INTERVAL_MS);

    watchdogInterval = setInterval(() => {
        const nowMs = Date.now();
        if (nowMs - lastMessageTimeMs > WATCHDOG_TIMEOUT_MS) {
            logInfo("Watchdog: no messages for 30s, restarting socket...");
            reconnectWithBackoff();
        }
    }, WATCHDOG_INTERVAL_MS);

    const handleExit = () => {
        logInfo("Caught SIGINT, flushing and exiting...");
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (watchdogInterval) clearInterval(watchdogInterval);
        if (ws) {
            try {
                ws.close();
            } catch {
                // ignore
            }
        }
        if (currentWriter) {
            currentWriter.close();
        }
        process.exit(0);
    };

    process.on("SIGINT", handleExit);
    process.on("SIGTERM", handleExit);
}

void main();