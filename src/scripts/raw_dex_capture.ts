/**
 * RAW DEX TRANSACTION CAPTURE
 * 
 * Strategy: Capture EVERYTHING. Analyze later.
 * 
 * Venues: PumpSwap, Meteora DLMM, Raydium V4, Raydium CLMM
 * 
 * For each transaction, log:
 * - Signature, slot, timestamp
 * - Venue(s) touched
 * - ALL token mints involved
 * - Signer wallet + SOL delta
 * - ALL wallets with SOL deltas
 * - CU, fees, Jito detection
 * 
 * Output: raw_dex_txs.jsonl (one JSON per line)
 * 
 * Post-processing (separate script) will:
 * 1. Find fractured tokens (appear on 2+ venues)
 * 2. Find winning wallets (consistent +SOL)
 * 3. Deep dive on patterns
 * 
 * Run: npx tsx src/scripts/raw_dex_capture.ts
 * Stop: Ctrl+C (will show summary)
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

const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_HTTP_API_KEY}`;
const HELIUS_WS = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_WS_API_KEY}`;

// ============================================================================
// TARGET VENUES
// ============================================================================

const VENUES: Record<string, string> = {
    PUMPSWAP: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    METEORA_DLMM: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    RAYDIUM_V4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    RAYDIUM_CLMM: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
};

const VENUE_BY_ID = new Map(Object.entries(VENUES).map(([k, v]) => [v, k]));

const SUBSCRIBE_PROGRAMS = Object.values(VENUES);

// Jito tip accounts
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

// Config
const CONCURRENT_FETCHES = 25;
const FETCH_DELAY_MS = 40;
const BATCH_INTERVAL_MS = 400;
const BATCH_SIZE = 60;
const MAX_QUEUE = 150000;
const SIG_TTL_MS = 180_000;

const WSOL = "So11111111111111111111111111111111111111112";

// ============================================================================
// TYPES
// ============================================================================

interface SolDelta {
    pubkey: string;
    delta: number; // lamports, can be negative
}

interface TokenFlow {
    mint: string;
    owner: string;
    delta: number; // token amount change
}

interface RawTx {
    sig: string;
    slot: number;
    blockTime: number | null;
    ts: string; // ISO timestamp when we processed it

    // Venues touched
    venues: string[]; // ["PUMPSWAP", "RAYDIUM_V4", etc]

    // Tokens
    mints: string[]; // All non-WSOL mints in the tx

    // Signer
    signer: string | null;
    signerSolDelta: number | null;

    // All SOL movements (excluding tiny dust)
    solDeltas: SolDelta[];

    // Token movements
    tokenFlows: TokenFlow[];

    // Execution
    success: boolean;
    cu: number | null;
    fee: number | null;

    // Jito
    isJito: boolean;
    jitoTip: number | null;

    // Multi-venue in single tx
    isMultiVenue: boolean;
}

interface QueuedSig {
    sig: string;
    slot: number;
    enqueuedAt: number;
}

interface Stats {
    sigsReceived: number;
    txsFetched: number;
    txsWritten: number;
    fetchErrors: number;
    byVenue: Record<string, number>;
    uniqueMints: Set<string>;
    uniqueSigners: Set<string>;
    multiVenueTxs: number;
    jitoTxs: number;
}

// ============================================================================
// UTILS
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");

function ensureDir(): void {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

function log(msg: string): void {
    console.log(`[CAPTURE] ${msg}`);
}

// ============================================================================
// JSONL WRITER
// ============================================================================

class JsonlWriter {
    private stream: fs.WriteStream;
    private closed = false;
    public count = 0;

    constructor(filePath: string) {
        this.stream = fs.createWriteStream(filePath, { flags: "w" });
    }

    write(obj: RawTx): void {
        if (this.closed) return;
        this.stream.write(JSON.stringify(obj) + "\n");
        this.count++;
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

class SigQueue {
    private queue: QueuedSig[] = [];
    private seen = new Set<string>();
    public dropped = 0;

    enqueue(sig: string, slot: number): void {
        if (this.seen.has(sig)) return;
        if (this.queue.length >= MAX_QUEUE) {
            const old = this.queue.shift();
            if (old) {
                this.seen.delete(old.sig);
                this.dropped++;
            }
        }
        this.seen.add(sig);
        this.queue.push({ sig, slot, enqueuedAt: Date.now() });
    }

    getBatch(size: number): QueuedSig[] {
        const now = Date.now();
        const batch: QueuedSig[] = [];
        while (batch.length < size && this.queue.length > 0) {
            const item = this.queue.shift()!;
            this.seen.delete(item.sig);
            if (now - item.enqueuedAt > SIG_TTL_MS) {
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
// TRANSACTION FETCHER
// ============================================================================

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
        if (!res.ok) return null;
        const data = await res.json();
        if (data.error) return null;
        return data.result ?? null;
    } catch {
        return null;
    }
}

async function fetchBatch(sigs: string[]): Promise<Map<string, any>> {
    const results = new Map<string, any>();
    if (sigs.length === 0) return results;

    for (let i = 0; i < sigs.length; i += CONCURRENT_FETCHES) {
        const chunk = sigs.slice(i, i + CONCURRENT_FETCHES);
        const promises = chunk.map((s) => fetchTx(s));
        const chunkResults = await Promise.all(promises);

        for (let j = 0; j < chunk.length; j++) {
            const sig = chunk[j];
            const result = chunkResults[j];
            if (sig && result) {
                results.set(sig, result);
            }
        }

        if (i + CONCURRENT_FETCHES < sigs.length) {
            await new Promise((r) => setTimeout(r, FETCH_DELAY_MS));
        }
    }

    return results;
}

// ============================================================================
// TRANSACTION PARSER
// ============================================================================

function parseTx(sig: string, slot: number, tx: any): RawTx | null {
    const meta = tx.meta;
    const message = tx.transaction?.message;

    if (!meta || !message) return null;

    // Check success
    const success = meta.err === null;

    // Extract account keys
    const accountKeys: string[] = [];
    for (const k of message.accountKeys ?? []) {
        if (typeof k === "string") {
            accountKeys.push(k);
        } else if (k && typeof k === "object") {
            accountKeys.push(k.pubkey ?? k.key ?? "");
        }
    }

    // Detect venues from ACTUAL program invocations (not just accountKeys)
    // This prevents false positives from Jupiter preloading multiple DEX program IDs
    const invokedPrograms = new Set<string>();

    // Check top-level instructions
    for (const ix of message.instructions ?? []) {
        // For parsed instructions
        if (ix.programId) {
            invokedPrograms.add(ix.programId);
        }
        // For raw instructions, programIdIndex points to accountKeys
        if (typeof ix.programIdIndex === "number" && accountKeys[ix.programIdIndex]) {
            invokedPrograms.add(accountKeys[ix.programIdIndex]!);
        }
    }

    // Check inner instructions (CPIs)
    for (const inner of meta.innerInstructions ?? []) {
        for (const ix of inner.instructions ?? []) {
            if (ix.programId) {
                invokedPrograms.add(ix.programId);
            }
            if (typeof ix.programIdIndex === "number" && accountKeys[ix.programIdIndex]) {
                invokedPrograms.add(accountKeys[ix.programIdIndex]!);
            }
        }
    }

    // Now check which of our target venues were actually invoked
    const venues: string[] = [];
    for (const programId of invokedPrograms) {
        const venue = VENUE_BY_ID.get(programId);
        if (venue && !venues.includes(venue)) {
            venues.push(venue);
        }
    }

    if (venues.length === 0) return null; // Not a target venue tx

    // Find signer
    let signer: string | null = null;
    let signerIndex: number | null = null;
    for (let i = 0; i < (message.accountKeys?.length ?? 0); i++) {
        const k = message.accountKeys?.[i];
        if (k && typeof k === "object" && k.signer) {
            signer = k.pubkey ?? k.key ?? null;
            signerIndex = i;
            break;
        }
    }

    // SOL deltas
    const preBalances: number[] = meta.preBalances ?? [];
    const postBalances: number[] = meta.postBalances ?? [];
    const solDeltas: SolDelta[] = [];
    let signerSolDelta: number | null = null;

    for (let i = 0; i < Math.min(preBalances.length, postBalances.length, accountKeys.length); i++) {
        const delta = (postBalances[i] ?? 0) - (preBalances[i] ?? 0);
        const pubkey = accountKeys[i];
        if (!pubkey) continue;

        if (i === signerIndex) {
            signerSolDelta = delta;
        }

        // Only log non-dust deltas (>= 1000 lamports = 0.000001 SOL)
        if (Math.abs(delta) >= 1000) {
            solDeltas.push({ pubkey, delta });
        }
    }

    // Token flows
    const preTokens = meta.preTokenBalances ?? [];
    const postTokens = meta.postTokenBalances ?? [];
    const tokenFlows: TokenFlow[] = [];
    const mints = new Set<string>();

    // Build pre/post maps
    const preMap = new Map<string, number>(); // key: `${mint}:${owner}` -> amount
    const postMap = new Map<string, number>();

    for (const b of preTokens) {
        if (!b.mint || b.mint === WSOL) continue;
        const owner = b.owner ?? accountKeys[b.accountIndex] ?? "unknown";
        const key = `${b.mint}:${owner}`;
        preMap.set(key, Number(b.uiTokenAmount?.amount ?? 0));
        mints.add(b.mint);
    }

    for (const b of postTokens) {
        if (!b.mint || b.mint === WSOL) continue;
        const owner = b.owner ?? accountKeys[b.accountIndex] ?? "unknown";
        const key = `${b.mint}:${owner}`;
        postMap.set(key, Number(b.uiTokenAmount?.amount ?? 0));
        mints.add(b.mint);
    }

    // Calculate deltas
    const allKeys = new Set([...preMap.keys(), ...postMap.keys()]);
    for (const key of allKeys) {
        const pre = preMap.get(key) ?? 0;
        const post = postMap.get(key) ?? 0;
        const delta = post - pre;
        if (delta !== 0) {
            const parts = key.split(":");
            const mint = parts[0] ?? "unknown";
            const owner = parts[1] ?? "unknown";
            tokenFlows.push({ mint, owner, delta });
        }
    }

    // Jito detection
    let isJito = false;
    let jitoTip: number | null = null;

    for (const key of accountKeys) {
        if (JITO_TIP_ACCOUNTS.has(key)) {
            isJito = true;
        }
    }

    // Check inner instructions for tip amount
    for (const inner of meta.innerInstructions ?? []) {
        for (const ix of inner.instructions ?? []) {
            if (ix.parsed?.type === "transfer") {
                const dest = ix.parsed.info?.destination;
                if (dest && JITO_TIP_ACCOUNTS.has(dest)) {
                    jitoTip = (jitoTip ?? 0) + (ix.parsed.info?.lamports ?? 0);
                }
            }
        }
    }

    return {
        sig,
        slot,
        blockTime: tx.blockTime ?? null,
        ts: new Date().toISOString(),
        venues,
        mints: Array.from(mints),
        signer,
        signerSolDelta,
        solDeltas: solDeltas.sort((a, b) => b.delta - a.delta), // Biggest gainers first
        tokenFlows,
        success,
        cu: meta.computeUnitsConsumed ?? null,
        fee: meta.fee ?? null,
        isJito,
        jitoTip,
        isMultiVenue: venues.length > 1,
    };
}

// ============================================================================
// PROCESSOR
// ============================================================================

class Processor {
    private queue = new SigQueue();
    private writer: JsonlWriter;
    private stats: Stats;
    private processing = false;
    private startTime: number;

    constructor(writer: JsonlWriter) {
        this.writer = writer;
        this.stats = {
            sigsReceived: 0,
            txsFetched: 0,
            txsWritten: 0,
            fetchErrors: 0,
            byVenue: {},
            uniqueMints: new Set(),
            uniqueSigners: new Set(),
            multiVenueTxs: 0,
            jitoTxs: 0,
        };
        this.startTime = Date.now();
    }

    enqueue(sig: string, slot: number): void {
        this.stats.sigsReceived++;
        this.queue.enqueue(sig, slot);
    }

    async start(): Promise<void> {
        if (this.processing) return;
        this.processing = true;

        while (this.processing) {
            const batch = this.queue.getBatch(BATCH_SIZE);

            if (batch.length === 0) {
                await new Promise((r) => setTimeout(r, 100));
                continue;
            }

            const sigs = batch.map((b) => b.sig);
            const slotMap = new Map(batch.map((b) => [b.sig, b.slot]));

            const txMap = await fetchBatch(sigs);
            this.stats.fetchErrors += sigs.length - txMap.size;
            this.stats.txsFetched += txMap.size;

            for (const [sig, tx] of txMap) {
                const slot = slotMap.get(sig) ?? 0;
                const parsed = parseTx(sig, slot, tx);

                if (parsed) {
                    this.writer.write(parsed);
                    this.stats.txsWritten++;

                    // Update stats
                    for (const v of parsed.venues) {
                        this.stats.byVenue[v] = (this.stats.byVenue[v] ?? 0) + 1;
                    }
                    for (const m of parsed.mints) {
                        this.stats.uniqueMints.add(m);
                    }
                    if (parsed.signer) {
                        this.stats.uniqueSigners.add(parsed.signer);
                    }
                    if (parsed.isMultiVenue) {
                        this.stats.multiVenueTxs++;
                    }
                    if (parsed.isJito) {
                        this.stats.jitoTxs++;
                    }
                }
            }

            await new Promise((r) => setTimeout(r, BATCH_INTERVAL_MS));
        }
    }

    stop(): void {
        this.processing = false;
    }

    getStats(): Stats {
        return this.stats;
    }

    getRuntimeSec(): number {
        return (Date.now() - this.startTime) / 1000;
    }

    getQueueSize(): number {
        return this.queue.size;
    }

    getDropped(): number {
        return this.queue.dropped;
    }
}

// ============================================================================
// WEBSOCKET
// ============================================================================

let ws: WebSocket | null = null;
let processor: Processor | null = null;
let lastMsgMs = Date.now();
let reconnectBackoff = 2000;

function sendSubs(): void {
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
    log(`Subscribed to ${SUBSCRIBE_PROGRAMS.length} venues`);
}

function handleMsg(data: RawData): void {
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
    ws = new WebSocket(HELIUS_WS);
    ws.on("open", () => {
        log("WebSocket open");
        lastMsgMs = Date.now();
        reconnectBackoff = 2000;
        sendSubs();
    });
    ws.on("message", handleMsg);
    ws.on("error", (e) => console.error("[CAPTURE] WS error:", e.message));
    ws.on("close", reconnect);
}

function reconnect(): void {
    if (ws) {
        ws.removeAllListeners();
        try { ws.close(); } catch { }
        ws = null;
    }
    log(`Reconnecting in ${reconnectBackoff}ms...`);
    setTimeout(() => {
        reconnectBackoff = Math.min(reconnectBackoff * 2, 60000);
        connect();
    }, reconnectBackoff);
}

// ============================================================================
// SUMMARY
// ============================================================================

function printSummary(stats: Stats, runtimeSec: number, outputPath: string): void {
    const captureRate = ((stats.txsWritten / Math.max(stats.sigsReceived, 1)) * 100).toFixed(1);
    const txPerSec = (stats.txsWritten / runtimeSec).toFixed(1);

    console.log("\n" + "=".repeat(80));
    console.log("📊 RAW CAPTURE SUMMARY");
    console.log("=".repeat(80));

    console.log(`\n⏱️  Runtime: ${(runtimeSec / 60).toFixed(1)} minutes`);

    console.log(`\n📥 THROUGHPUT`);
    console.log(`   Signatures received:   ${stats.sigsReceived.toLocaleString()}`);
    console.log(`   Transactions fetched:  ${stats.txsFetched.toLocaleString()}`);
    console.log(`   Transactions written:  ${stats.txsWritten.toLocaleString()}`);
    console.log(`   Fetch errors:          ${stats.fetchErrors.toLocaleString()}`);
    console.log(`   Capture rate:          ${captureRate}%`);
    console.log(`   Tx/sec:                ${txPerSec}`);

    console.log(`\n🏦 BY VENUE`);
    for (const [venue, count] of Object.entries(stats.byVenue).sort((a, b) => b[1] - a[1])) {
        const pct = ((count / stats.txsWritten) * 100).toFixed(1);
        console.log(`   ${venue.padEnd(20)} ${count.toLocaleString().padStart(10)} (${pct}%)`);
    }

    console.log(`\n📈 UNIQUE ENTITIES`);
    console.log(`   Unique token mints:    ${stats.uniqueMints.size.toLocaleString()}`);
    console.log(`   Unique signers:        ${stats.uniqueSigners.size.toLocaleString()}`);

    console.log(`\n⚡ SPECIAL TRANSACTIONS`);
    console.log(`   Multi-venue (arb?):    ${stats.multiVenueTxs.toLocaleString()}`);
    console.log(`   Jito bundles:          ${stats.jitoTxs.toLocaleString()}`);

    console.log(`\n💾 Output: ${outputPath}`);
    console.log(`   File size: ~${((stats.txsWritten * 500) / 1024 / 1024).toFixed(1)} MB estimated`);

    console.log("\n" + "=".repeat(80));
    console.log("✅ Next: npx tsx src/scripts/analyze_raw_capture.ts");
    console.log("=".repeat(80));
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
    ensureDir();

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outputPath = path.join(DATA_DIR, `raw_dex_txs_${timestamp}.jsonl`);

    const writer = new JsonlWriter(outputPath);
    processor = new Processor(writer);

    log(`Output: ${outputPath}`);
    log(`Venues: ${Object.keys(VENUES).join(", ")}`);
    log(`Batch: ${BATCH_SIZE} sigs | Concurrent: ${CONCURRENT_FETCHES} | Interval: ${BATCH_INTERVAL_MS}ms`);
    log("");
    log("Capturing ALL transactions. No filtering. Raw data.");
    log("Press Ctrl+C to stop and see summary.");
    log("");

    connect();
    void processor.start();

    // Heartbeat
    setInterval(() => {
        if (!processor) return;
        const s = processor.getStats();
        const rate = ((s.txsWritten / Math.max(s.sigsReceived, 1)) * 100).toFixed(1);
        log(
            `HEARTBEAT | written=${s.txsWritten} | queue=${processor.getQueueSize()} | ` +
            `rate=${rate}% | mints=${s.uniqueMints.size} | multi=${s.multiVenueTxs} | jito=${s.jitoTxs}`
        );
    }, 10000);

    // Watchdog
    setInterval(() => {
        if (Date.now() - lastMsgMs > 30000) {
            log("Watchdog timeout, reconnecting...");
            reconnect();
        }
    }, 10000);

    // Shutdown
    const shutdown = () => {
        if (!processor) return;
        processor.stop();
        printSummary(processor.getStats(), processor.getRuntimeSec(), outputPath);
        writer.close();
        if (ws) { try { ws.close(); } catch { } }
        process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main().catch(console.error);