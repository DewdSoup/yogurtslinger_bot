/**
 * PRICE DISCREPANCY DETECTOR
 * 
 * Monitors fractured tokens (PumpSwap + external venues) for price discrepancies.
 * Calculates effective price on each venue and logs arbitrage opportunities.
 * 
 * KEY METRICS:
 * - Spread % between venues
 * - Time discrepancy persists before being arbed
 * - Who captures the arb (wallet, method)
 * - Uncaptured opportunities (spread existed but no one took it)
 * 
 * HOW IT WORKS:
 * 1. Subscribes to PumpSwap, Raydium, Meteora via Helius WebSocket
 * 2. When a swap occurs, calculates effective price (SOL per token)
 * 3. Compares prices across venues for same token
 * 4. Logs opportunities when spread exceeds threshold
 * 5. Tracks if/when spread gets captured
 * 
 * OUTPUT: discrepancy_log_<timestamp>.jsonl
 * 
 * Run: npx tsx src/scripts/price_discrepancy_detector.ts
 * Stop: Ctrl+C to see summary
 */

import fs from "node:fs";
import path from "node:path";
import WebSocket, { RawData } from "ws";
import { fileURLToPath } from "node:url";

declare function fetch(input: any, init?: any): Promise<any>;

// ============================================================================
// CONFIG
// ============================================================================

const HELIUS_API_KEY = "bff504b3-c294-46e9-b7d8-dacbcb4b9e3d";
const HELIUS_WS = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=2bb675f2-573f-4561-b57f-d351db310e5a`;

// Minimum spread to log as opportunity (0.5%)
const MIN_SPREAD_PCT = 0.5;

// How long to track a discrepancy before marking it uncaptured (ms)
const DISCREPANCY_TIMEOUT_MS = 5000;

// Venues
const VENUES = {
    PUMPSWAP: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    METEORA_DLMM: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    RAYDIUM_V4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    RAYDIUM_CLMM: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
};

const VENUE_BY_ID = new Map(Object.entries(VENUES).map(([k, v]) => [v, k]));
const WSOL = "So11111111111111111111111111111111111111112";
const LAMPORTS_PER_SOL = 1_000_000_000;

// ============================================================================
// TYPES
// ============================================================================

interface SwapEvent {
    sig: string;
    slot: number;
    ts: number;
    venue: string;
    mint: string;
    solAmount: number;      // lamports
    tokenAmount: number;    // raw token amount
    direction: "BUY" | "SELL";
    effectivePrice: number; // SOL per token (normalized)
    signer: string;
}

interface PriceState {
    mint: string;
    venues: Map<string, {
        lastPrice: number;
        lastSlot: number;
        lastTs: number;
        lastSig: string;
    }>;
}

interface Discrepancy {
    id: string;
    detectedAt: number;
    detectedSlot: number;
    mint: string;
    lowVenue: string;
    lowPrice: number;
    highVenue: string;
    highPrice: number;
    spreadPct: number;
    spreadSol: number;        // Estimated profit for 1 SOL trade
    capturedAt: number | null;
    capturedBy: string | null;
    capturedSig: string | null;
    capturedSlotDelta: number | null;
    status: "OPEN" | "CAPTURED" | "EXPIRED";
}

interface BackrunOpportunity {
    sig: string;
    slot: number;
    ts: number;
    mint: string;
    venue: string;
    direction: "BUY" | "SELL";
    traderPaid: number;           // SOL paid by trader
    bestAvailablePrice: number;   // Price on best external venue
    worstPrice: number;           // Price trader got
    lossSol: number;              // How much trader overpaid
    lossPct: number;
    bestVenue: string;
    couldBackrun: boolean;        // Was there a better price available?
}

interface Stats {
    swapsProcessed: number;
    discrepanciesDetected: number;
    discrepanciesCaptured: number;
    discrepanciesExpired: number;
    totalSpreadSol: number;
    capturedSpreadSol: number;
    uncapturedSpreadSol: number;
    backrunOpportunities: number;
    totalBackrunLossSol: number;
    byMint: Map<string, {
        swaps: number;
        discrepancies: number;
        backrunLoss: number;
    }>;
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
    console.log(`[DISCREPANCY] ${msg}`);
}

function lamToSol(l: number): number {
    return l / LAMPORTS_PER_SOL;
}

// ============================================================================
// STATE
// ============================================================================

// Track latest price per token per venue
const priceStates = new Map<string, PriceState>();

// Active discrepancies waiting to be captured
const openDiscrepancies = new Map<string, Discrepancy>();

// All discrepancies (for logging)
const allDiscrepancies: Discrepancy[] = [];

// Backrun opportunities
const backrunOpportunities: BackrunOpportunity[] = [];

// Stats
const stats: Stats = {
    swapsProcessed: 0,
    discrepanciesDetected: 0,
    discrepanciesCaptured: 0,
    discrepanciesExpired: 0,
    totalSpreadSol: 0,
    capturedSpreadSol: 0,
    uncapturedSpreadSol: 0,
    backrunOpportunities: 0,
    totalBackrunLossSol: 0,
    byMint: new Map(),
};

// ============================================================================
// JSONL WRITER
// ============================================================================

let discrepancyWriter: fs.WriteStream;
let backrunWriter: fs.WriteStream;

function initWriters(timestamp: string): void {
    discrepancyWriter = fs.createWriteStream(
        path.join(DATA_DIR, `discrepancies_${timestamp}.jsonl`),
        { flags: "w" }
    );
    backrunWriter = fs.createWriteStream(
        path.join(DATA_DIR, `backrun_opportunities_${timestamp}.jsonl`),
        { flags: "w" }
    );
}

function writeDiscrepancy(d: Discrepancy): void {
    discrepancyWriter.write(JSON.stringify(d) + "\n");
}

function writeBackrun(b: BackrunOpportunity): void {
    backrunWriter.write(JSON.stringify(b) + "\n");
}

// ============================================================================
// PRICE TRACKING
// ============================================================================

function updatePrice(event: SwapEvent): void {
    let state = priceStates.get(event.mint);
    if (!state) {
        state = { mint: event.mint, venues: new Map() };
        priceStates.set(event.mint, state);
    }

    state.venues.set(event.venue, {
        lastPrice: event.effectivePrice,
        lastSlot: event.slot,
        lastTs: event.ts,
        lastSig: event.sig,
    });

    // Update mint stats
    let mintStats = stats.byMint.get(event.mint);
    if (!mintStats) {
        mintStats = { swaps: 0, discrepancies: 0, backrunLoss: 0 };
        stats.byMint.set(event.mint, mintStats);
    }
    mintStats.swaps++;
}

function checkForDiscrepancy(event: SwapEvent): void {
    const state = priceStates.get(event.mint);
    if (!state || state.venues.size < 2) return;

    // Find best and worst prices across venues
    let lowVenue = "";
    let lowPrice = Infinity;
    let highVenue = "";
    let highPrice = 0;

    for (const [venue, data] of state.venues) {
        // Only consider recent prices (within 10 seconds)
        if (Date.now() - data.lastTs > 10000) continue;

        if (data.lastPrice < lowPrice) {
            lowPrice = data.lastPrice;
            lowVenue = venue;
        }
        if (data.lastPrice > highPrice) {
            highPrice = data.lastPrice;
            highVenue = venue;
        }
    }

    if (lowVenue === highVenue || lowPrice === 0 || highPrice === 0) return;

    const spreadPct = ((highPrice - lowPrice) / lowPrice) * 100;

    if (spreadPct >= MIN_SPREAD_PCT) {
        const spreadSol = (highPrice - lowPrice) * LAMPORTS_PER_SOL; // Profit per token in lamports

        const discrepancy: Discrepancy = {
            id: `${event.mint}-${event.slot}-${Date.now()}`,
            detectedAt: Date.now(),
            detectedSlot: event.slot,
            mint: event.mint,
            lowVenue,
            lowPrice,
            highVenue,
            highPrice,
            spreadPct,
            spreadSol: lamToSol(spreadSol),
            capturedAt: null,
            capturedBy: null,
            capturedSig: null,
            capturedSlotDelta: null,
            status: "OPEN",
        };

        openDiscrepancies.set(discrepancy.id, discrepancy);
        allDiscrepancies.push(discrepancy);
        stats.discrepanciesDetected++;
        stats.totalSpreadSol += discrepancy.spreadSol;

        const mintStats = stats.byMint.get(event.mint);
        if (mintStats) mintStats.discrepancies++;

        log(
            `🎯 SPREAD DETECTED: ${event.mint.slice(0, 8)}... ` +
            `${lowVenue}→${highVenue} ${spreadPct.toFixed(2)}% (${discrepancy.spreadSol.toFixed(4)} SOL/token)`
        );
    }
}

function checkForBackrunOpportunity(event: SwapEvent): void {
    // Only check BUY transactions on PumpSwap
    if (event.venue !== "PUMPSWAP" || event.direction !== "BUY") return;

    const state = priceStates.get(event.mint);
    if (!state) return;

    // Find best available price on external venues
    let bestPrice = Infinity;
    let bestVenue = "";

    for (const [venue, data] of state.venues) {
        if (venue === "PUMPSWAP") continue;
        // Only consider recent prices (within 5 seconds)
        if (Date.now() - data.lastTs > 5000) continue;

        if (data.lastPrice < bestPrice) {
            bestPrice = data.lastPrice;
            bestVenue = venue;
        }
    }

    if (bestVenue === "" || bestPrice >= event.effectivePrice) return;

    // Calculate loss
    const priceDiff = event.effectivePrice - bestPrice;
    const lossPct = (priceDiff / bestPrice) * 100;
    const tokensBought = event.solAmount / event.effectivePrice;
    const lossSol = lamToSol(tokensBought * priceDiff);

    if (lossSol < 0.0001) return; // Ignore dust

    const backrun: BackrunOpportunity = {
        sig: event.sig,
        slot: event.slot,
        ts: event.ts,
        mint: event.mint,
        venue: event.venue,
        direction: event.direction,
        traderPaid: lamToSol(event.solAmount),
        bestAvailablePrice: bestPrice,
        worstPrice: event.effectivePrice,
        lossSol,
        lossPct,
        bestVenue,
        couldBackrun: true,
    };

    backrunOpportunities.push(backrun);
    writeBackrun(backrun);
    stats.backrunOpportunities++;
    stats.totalBackrunLossSol += lossSol;

    const mintStats = stats.byMint.get(event.mint);
    if (mintStats) mintStats.backrunLoss += lossSol;

    log(
        `💸 BACKRUN OPP: ${event.mint.slice(0, 8)}... ` +
        `Trader overpaid ${lossSol.toFixed(4)} SOL (${lossPct.toFixed(2)}%) vs ${bestVenue}`
    );
}

function checkDiscrepancyCaptured(event: SwapEvent): void {
    // Check if this event captures any open discrepancy
    for (const [id, discrepancy] of openDiscrepancies) {
        if (discrepancy.mint !== event.mint) continue;
        if (discrepancy.status !== "OPEN") continue;

        // Check if this is an arb (buying low, selling high)
        const isArbBuy = event.venue === discrepancy.lowVenue && event.direction === "BUY";
        const isArbSell = event.venue === discrepancy.highVenue && event.direction === "SELL";

        if (isArbBuy || isArbSell) {
            discrepancy.status = "CAPTURED";
            discrepancy.capturedAt = event.ts;
            discrepancy.capturedBy = event.signer;
            discrepancy.capturedSig = event.sig;
            discrepancy.capturedSlotDelta = event.slot - discrepancy.detectedSlot;

            stats.discrepanciesCaptured++;
            stats.capturedSpreadSol += discrepancy.spreadSol;
            openDiscrepancies.delete(id);

            writeDiscrepancy(discrepancy);

            log(
                `✅ CAPTURED: ${event.mint.slice(0, 8)}... by ${event.signer.slice(0, 8)}... ` +
                `in ${discrepancy.capturedSlotDelta} slots`
            );
        }
    }
}

function expireOldDiscrepancies(): void {
    const now = Date.now();
    for (const [id, discrepancy] of openDiscrepancies) {
        if (now - discrepancy.detectedAt > DISCREPANCY_TIMEOUT_MS) {
            discrepancy.status = "EXPIRED";
            stats.discrepanciesExpired++;
            stats.uncapturedSpreadSol += discrepancy.spreadSol;
            openDiscrepancies.delete(id);
            writeDiscrepancy(discrepancy);

            log(
                `⏰ EXPIRED: ${discrepancy.mint.slice(0, 8)}... ` +
                `${discrepancy.spreadPct.toFixed(2)}% spread uncaptured!`
            );
        }
    }
}

// ============================================================================
// TRANSACTION PARSING
// ============================================================================

async function fetchAndParseTx(sig: string, slot: number): Promise<SwapEvent | null> {
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
        if (data.error || !data.result) return null;

        const tx = data.result;
        const meta = tx.meta;
        const message = tx.transaction?.message;

        if (!meta || !message || meta.err !== null) return null;

        // Extract account keys
        const accountKeys: string[] = [];
        for (const k of message.accountKeys ?? []) {
            if (typeof k === "string") {
                accountKeys.push(k);
            } else if (k && typeof k === "object") {
                accountKeys.push(k.pubkey ?? k.key ?? "");
            }
        }

        // Detect venue from ACTUAL program invocations
        const invokedPrograms = new Set<string>();

        // Check top-level instructions
        for (const ix of message.instructions ?? []) {
            if (ix.programId) {
                invokedPrograms.add(ix.programId);
            }
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

        // Find first matching venue from invoked programs
        let venue = "";
        for (const programId of invokedPrograms) {
            const v = VENUE_BY_ID.get(programId);
            if (v) {
                venue = v;
                break;
            }
        }
        if (!venue) return null;

        // Find signer
        let signer = "";
        let signerIndex = -1;
        for (let i = 0; i < (message.accountKeys?.length ?? 0); i++) {
            const k = message.accountKeys?.[i];
            if (k && typeof k === "object" && k.signer) {
                signer = k.pubkey ?? k.key ?? "";
                signerIndex = i;
                break;
            }
        }

        // Calculate SOL delta
        const preBalances: number[] = meta.preBalances ?? [];
        const postBalances: number[] = meta.postBalances ?? [];
        let signerSolDelta = 0;
        if (signerIndex >= 0) {
            signerSolDelta = (postBalances[signerIndex] ?? 0) - (preBalances[signerIndex] ?? 0);
        }

        // Find token mint and amount
        const preTokens = meta.preTokenBalances ?? [];
        const postTokens = meta.postTokenBalances ?? [];

        let mint = "";
        let tokenDelta = 0;

        // Build token deltas for signer
        const tokenMap = new Map<string, number>();
        for (const b of preTokens) {
            if (b.owner === signer && b.mint && b.mint !== WSOL) {
                const key = b.mint;
                tokenMap.set(key, -(Number(b.uiTokenAmount?.amount ?? 0)));
                if (!mint) mint = b.mint;
            }
        }
        for (const b of postTokens) {
            if (b.owner === signer && b.mint && b.mint !== WSOL) {
                const key = b.mint;
                tokenMap.set(key, (tokenMap.get(key) ?? 0) + Number(b.uiTokenAmount?.amount ?? 0));
                if (!mint) mint = b.mint;
            }
        }

        for (const [m, delta] of tokenMap) {
            if (Math.abs(delta) > Math.abs(tokenDelta)) {
                tokenDelta = delta;
                mint = m;
            }
        }

        if (!mint || tokenDelta === 0) return null;

        // Determine direction
        // BUY: SOL negative (paid), tokens positive (received)
        // SELL: SOL positive (received), tokens negative (sold)
        const direction: "BUY" | "SELL" = signerSolDelta < 0 ? "BUY" : "SELL";

        // Calculate effective price (SOL per token)
        const solAmount = Math.abs(signerSolDelta);
        const tokenAmount = Math.abs(tokenDelta);
        const effectivePrice = solAmount / tokenAmount;

        return {
            sig,
            slot,
            ts: Date.now(),
            venue,
            mint,
            solAmount,
            tokenAmount,
            direction,
            effectivePrice,
            signer,
        };
    } catch {
        return null;
    }
}

// ============================================================================
// WEBSOCKET
// ============================================================================

let ws: WebSocket | null = null;
let lastMsgMs = Date.now();
let reconnectBackoff = 2000;
const pendingSigs = new Map<string, number>(); // sig -> slot
let processing = false;

function sendSubs(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    let id = 1;
    for (const pid of Object.values(VENUES)) {
        ws.send(
            JSON.stringify({
                jsonrpc: "2.0",
                id: id++,
                method: "logsSubscribe",
                params: [{ mentions: [pid] }],
            })
        );
    }
    log(`Subscribed to ${Object.keys(VENUES).length} venues`);
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
        if (typeof slot === "number" && typeof sig === "string") {
            pendingSigs.set(sig, slot);
        }
    }
}

async function processPendingSigs(): Promise<void> {
    if (processing) return;
    processing = true;

    while (pendingSigs.size > 0) {
        const batch: Array<[string, number]> = [];
        for (const [sig, slot] of pendingSigs) {
            batch.push([sig, slot]);
            if (batch.length >= 20) break;
        }

        for (const [sig] of batch) {
            pendingSigs.delete(sig);
        }

        const promises = batch.map(([sig, slot]) => fetchAndParseTx(sig, slot));
        const results = await Promise.all(promises);

        for (const event of results) {
            if (!event) continue;

            stats.swapsProcessed++;

            // Update price state
            updatePrice(event);

            // Check for discrepancies
            checkForDiscrepancy(event);

            // Check if this captures an existing discrepancy
            checkDiscrepancyCaptured(event);

            // Check for backrun opportunity
            checkForBackrunOpportunity(event);
        }

        // Expire old discrepancies
        expireOldDiscrepancies();

        await new Promise((r) => setTimeout(r, 50));
    }

    processing = false;
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
    ws.on("error", (e) => console.error("[DISCREPANCY] WS error:", e.message));
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

function printSummary(runtimeSec: number): void {
    console.log("\n" + "=".repeat(80));
    console.log("📊 PRICE DISCREPANCY SUMMARY");
    console.log("=".repeat(80));

    console.log(`\n⏱️  Runtime: ${(runtimeSec / 60).toFixed(1)} minutes`);

    console.log(`\n📈 SWAPS PROCESSED`);
    console.log(`   Total swaps:           ${stats.swapsProcessed.toLocaleString()}`);
    console.log(`   Unique tokens:         ${priceStates.size.toLocaleString()}`);

    console.log(`\n🎯 PRICE DISCREPANCIES (>${MIN_SPREAD_PCT}% spread)`);
    console.log(`   Detected:              ${stats.discrepanciesDetected.toLocaleString()}`);
    console.log(`   Captured:              ${stats.discrepanciesCaptured.toLocaleString()}`);
    console.log(`   Expired (uncaptured):  ${stats.discrepanciesExpired.toLocaleString()}`);
    console.log(`   Still open:            ${openDiscrepancies.size.toLocaleString()}`);

    const captureRate = stats.discrepanciesDetected > 0
        ? ((stats.discrepanciesCaptured / stats.discrepanciesDetected) * 100).toFixed(1)
        : "0";
    console.log(`   Capture rate:          ${captureRate}%`);

    console.log(`\n💰 SPREAD VALUE`);
    console.log(`   Total spread detected: ${stats.totalSpreadSol.toFixed(4)} SOL`);
    console.log(`   Captured by arbers:    ${stats.capturedSpreadSol.toFixed(4)} SOL`);
    console.log(`   UNCAPTURED (missed):   ${stats.uncapturedSpreadSol.toFixed(4)} SOL`);

    console.log(`\n💸 BACKRUN OPPORTUNITIES (PumpSwap users overpaying)`);
    console.log(`   Total opportunities:   ${stats.backrunOpportunities.toLocaleString()}`);
    console.log(`   Total loss by traders: ${stats.totalBackrunLossSol.toFixed(4)} SOL`);

    // Top tokens by backrun loss
    const sortedMints = Array.from(stats.byMint.entries())
        .filter(([, s]) => s.backrunLoss > 0)
        .sort((a, b) => b[1].backrunLoss - a[1].backrunLoss)
        .slice(0, 10);

    if (sortedMints.length > 0) {
        console.log(`\n🪙 TOP TOKENS BY BACKRUN LOSS`);
        console.log("   " + "-".repeat(70));
        console.log(`   ${"Mint".padEnd(44)} ${"Loss".padStart(12)} ${"Opps".padStart(8)}`);
        console.log("   " + "-".repeat(70));
        for (const [mint, s] of sortedMints) {
            console.log(
                `   ${mint.padEnd(44)} ${s.backrunLoss.toFixed(4).padStart(12)} ${s.discrepancies.toString().padStart(8)}`
            );
        }
    }

    console.log("\n" + "=".repeat(80));
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
    ensureDir();

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    initWriters(timestamp);

    log(`Output: discrepancies_${timestamp}.jsonl, backrun_opportunities_${timestamp}.jsonl`);
    log(`Min spread threshold: ${MIN_SPREAD_PCT}%`);
    log(`Discrepancy timeout: ${DISCREPANCY_TIMEOUT_MS}ms`);
    log("");
    log("Monitoring for price discrepancies...");
    log("Press Ctrl+C to stop and see summary.");
    log("");

    const startTime = Date.now();
    connect();

    // Process loop
    setInterval(() => {
        void processPendingSigs();
    }, 100);

    // Heartbeat
    setInterval(() => {
        log(
            `HEARTBEAT | swaps=${stats.swapsProcessed} | discrepancies=${stats.discrepanciesDetected} ` +
            `| captured=${stats.discrepanciesCaptured} | backruns=${stats.backrunOpportunities} ` +
            `| loss=${stats.totalBackrunLossSol.toFixed(4)} SOL`
        );
    }, 15000);

    // Watchdog
    setInterval(() => {
        if (Date.now() - lastMsgMs > 30000) {
            log("Watchdog timeout, reconnecting...");
            reconnect();
        }
    }, 10000);

    // Cleanup interval
    setInterval(expireOldDiscrepancies, 1000);

    // Shutdown
    const shutdown = () => {
        printSummary((Date.now() - startTime) / 1000);
        discrepancyWriter.end();
        backrunWriter.end();
        if (ws) { try { ws.close(); } catch { } }
        process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main().catch(console.error);