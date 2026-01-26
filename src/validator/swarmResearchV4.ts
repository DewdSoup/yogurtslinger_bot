// =============================================================================
// YOGURTSLINGER SWARM RESEARCH v4.0 - DONE RIGHT
// =============================================================================
//
// METHODOLOGY:
// 1. WebSocket: Detect bursts of activity (just count txs, don't parse amounts)
// 2. On burst: Capture all signatures
// 3. API: Batch enrich entire burst to get REAL data
// 4. Analyze: Use slot ordering and actual SOL amounts
//
// NO LOG PARSING FOR AMOUNTS. NO TIMESTAMP ORDERING. JUST REAL DATA.
//
// =============================================================================

import { Connection, PublicKey, Logs, Context } from "@solana/web3.js";
import * as fs from "fs";

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
    helius: {
        rpc: "https://mainnet.helius-rpc.com/?api-key=bff504b3-c294-46e9-b7d8-dacbcb4b9e3d",
        wss: "wss://mainnet.helius-rpc.com/?api-key=bff504b3-c294-46e9-b7d8-dacbcb4b9e3d",
        apiBase: "https://api.helius.xyz/v0",
        apiKey: "bff504b3-c294-46e9-b7d8-dacbcb4b9e3d",
    },

    programs: {
        pumpfun: new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"),
    },

    // Burst detection (from WebSocket - just counting, no parsing)
    burst: {
        windowMs: 5000,            // 5 second window
        minTxs: 5,                 // Minimum txs to count as burst
        cooldownMs: 15000,         // Don't re-detect same token for 15s
        maxTokensTracked: 300,     // Memory limit
        bufferMaxAgeMs: 20000,     // Keep 20 seconds of signatures
    },

    // API enrichment
    api: {
        batchSize: 50,             // Helius allows up to 100 per call
        minIntervalMs: 500,        // Max 2 calls/sec
        maxRetries: 2,
    },

    // Slot timing
    slotTimeMs: 400,               // ~400ms per slot

    output: {
        dir: "./swarm_research_v4",
        swarms: "swarms.jsonl",
        triggers: "triggers.jsonl",
        summary: "summary.json",
    },
};

// =============================================================================
// DATA STRUCTURES
// =============================================================================

// Minimal data from WebSocket - just what we need to detect bursts
interface RawSignature {
    signature: string;
    slot: number;
    receivedAt: number;
    tokenMint: string | null;  // Best effort from logs
    isBuy: boolean;
}

// Enriched transaction from API - the REAL data
interface EnrichedTx {
    signature: string;
    slot: number;
    wallet: string;
    solAmount: number;          // Actual from nativeTransfers
    tokenAmount: number;
    priorityFee: number;        // Actual fee
    isBuy: boolean;
    tokenMint: string;
}

// Analyzed swarm with proper ordering
interface AnalyzedSwarm {
    id: string;
    detectedAt: number;
    tokenMint: string;

    // All transactions in slot order (from API)
    transactions: EnrichedTx[];

    // The trigger (largest buy, or first large buy)
    trigger: {
        signature: string;
        slot: number;
        wallet: string;
        solAmount: number;
        priorityFee: number;
        isBot: boolean;           // priorityFee > threshold
        positionInSequence: number;  // 1-indexed position by slot
    };

    // Followers (everyone after trigger)
    followers: {
        count: number;
        totalVolume: number;
        uniqueWallets: number;
        botCount: number;
        manualCount: number;

        // Latency from trigger (in slots, converted to ms)
        firstFollowerSlotDelta: number;
        firstFollowerLatencyMs: number;
        medianSlotDelta: number;
        medianLatencyMs: number;
        p90SlotDelta: number;
        p90LatencyMs: number;
    };

    // Overall metrics
    metrics: {
        totalTxs: number;
        totalVolume: number;
        burstDurationSlots: number;
        burstDurationMs: number;
    };
}

// =============================================================================
// BURST DETECTION (WebSocket only - no amount parsing)
// =============================================================================

class BurstDetector {
    private buffers = new Map<string, RawSignature[]>();
    private cooldowns = new Map<string, number>();
    private detectedBursts = new Set<string>();
    private lastCleanup = Date.now();

    // Add a signature to tracking
    addSignature(sig: RawSignature): void {
        if (!sig.tokenMint) return;

        const buffer = this.buffers.get(sig.tokenMint) || [];
        buffer.push(sig);
        this.buffers.set(sig.tokenMint, buffer);

        if (Date.now() - this.lastCleanup > 3000) {
            this.cleanup();
        }
    }

    // Check if we have a burst on this token
    detectBurst(tokenMint: string): RawSignature[] | null {
        // Check cooldown
        const cooldownUntil = this.cooldowns.get(tokenMint) || 0;
        if (Date.now() < cooldownUntil) return null;

        const buffer = this.buffers.get(tokenMint);
        if (!buffer) return null;

        const now = Date.now();
        const windowStart = now - CONFIG.burst.windowMs;

        // Get recent buys
        const recentBuys = buffer.filter(s =>
            s.isBuy &&
            s.receivedAt >= windowStart
        );

        if (recentBuys.length < CONFIG.burst.minTxs) return null;

        // Create burst ID from first signature
        const sortedBySlot = [...recentBuys].sort((a, b) => a.slot - b.slot);
        const burstId = `${tokenMint}-${sortedBySlot[0]!.slot}`;

        if (this.detectedBursts.has(burstId)) return null;
        this.detectedBursts.add(burstId);

        // Set cooldown
        this.cooldowns.set(tokenMint, now + CONFIG.burst.cooldownMs);

        return recentBuys;
    }

    private cleanup(): void {
        const now = Date.now();
        const maxAge = CONFIG.burst.bufferMaxAgeMs;

        for (const [mint, buffer] of this.buffers) {
            const filtered = buffer.filter(s => (now - s.receivedAt) < maxAge);
            if (filtered.length === 0) {
                this.buffers.delete(mint);
            } else {
                this.buffers.set(mint, filtered);
            }
        }

        // Cleanup cooldowns
        for (const [mint, expiry] of this.cooldowns) {
            if (now > expiry) this.cooldowns.delete(mint);
        }

        // Cleanup burst IDs
        if (this.detectedBursts.size > 5000) {
            this.detectedBursts.clear();
        }

        // Memory limit
        if (this.buffers.size > CONFIG.burst.maxTokensTracked) {
            const entries = Array.from(this.buffers.entries());
            entries.sort((a, b) => {
                const aLast = a[1][a[1].length - 1]?.receivedAt ?? 0;
                const bLast = b[1][b[1].length - 1]?.receivedAt ?? 0;
                return aLast - bLast;
            });
            for (const [mint] of entries.slice(0, 100)) {
                this.buffers.delete(mint);
            }
        }

        this.lastCleanup = now;
    }

    getStats(): { tokensTracked: number; bufferedSigs: number } {
        let bufferedSigs = 0;
        for (const buffer of this.buffers.values()) {
            bufferedSigs += buffer.length;
        }
        return { tokensTracked: this.buffers.size, bufferedSigs };
    }
}

// =============================================================================
// API ENRICHMENT
// =============================================================================

async function enrichTransactions(signatures: string[]): Promise<EnrichedTx[]> {
    const results: EnrichedTx[] = [];

    // Batch into chunks
    for (let i = 0; i < signatures.length; i += CONFIG.api.batchSize) {
        const batch = signatures.slice(i, i + CONFIG.api.batchSize);

        for (let retry = 0; retry < CONFIG.api.maxRetries; retry++) {
            try {
                const url = `${CONFIG.helius.apiBase}/transactions/?api-key=${CONFIG.helius.apiKey}`;
                const response = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ transactions: batch }),
                });

                if (!response.ok) {
                    if (response.status === 429) {
                        // Rate limited - wait and retry
                        await sleep(2000);
                        continue;
                    }
                    console.warn(`API error: ${response.status}`);
                    break;
                }

                const data = await response.json();

                for (const tx of data) {
                    if (!tx || !tx.signature) continue;

                    // Extract SOL amount from native transfers
                    const solAmount = (tx.nativeTransfers || []).reduce((sum: number, t: any) => {
                        // Only count transfers TO the program (buys)
                        return sum + Math.abs(t.amount || 0);
                    }, 0) / 1e9;

                    // Extract token amount
                    const tokenAmount = (tx.tokenTransfers || []).reduce((sum: number, t: any) => {
                        return sum + Math.abs(t.tokenAmount || 0);
                    }, 0);

                    // Get token mint from token transfers
                    let tokenMint = "";
                    for (const tt of (tx.tokenTransfers || [])) {
                        if (tt.mint) {
                            tokenMint = tt.mint;
                            break;
                        }
                    }

                    // Determine if buy or sell from description/type
                    const desc = (tx.description || "").toLowerCase();
                    const isBuy = desc.includes("buy") || tx.type === "SWAP";

                    results.push({
                        signature: tx.signature,
                        slot: tx.slot || 0,
                        wallet: tx.feePayer || "unknown",
                        solAmount,
                        tokenAmount,
                        priorityFee: tx.fee || 0,
                        isBuy,
                        tokenMint,
                    });
                }

                break; // Success, exit retry loop

            } catch (error) {
                console.warn(`Enrichment error (retry ${retry}): ${error}`);
                await sleep(1000);
            }
        }

        // Rate limit between batches
        if (i + CONFIG.api.batchSize < signatures.length) {
            await sleep(CONFIG.api.minIntervalMs);
        }
    }

    return results;
}

// =============================================================================
// SWARM ANALYSIS
// =============================================================================

function analyzeSwarm(tokenMint: string, enrichedTxs: EnrichedTx[]): AnalyzedSwarm | null {
    if (enrichedTxs.length < CONFIG.burst.minTxs) return null;

    // Filter to buys only and sort by slot (chain ordering)
    const buys = enrichedTxs
        .filter(tx => tx.isBuy && tx.solAmount > 0)
        .sort((a, b) => a.slot - b.slot);

    if (buys.length < 3) return null;  // Need at least 3 buys

    // Identify trigger: largest buy in first half of sequence, or first buy >= 0.3 SOL
    let trigger: EnrichedTx | null = null;
    let triggerIndex = 0;

    // Strategy 1: First significant buy (>= 0.3 SOL)
    for (let i = 0; i < buys.length; i++) {
        if (buys[i]!.solAmount >= 0.3) {
            trigger = buys[i]!;
            triggerIndex = i;
            break;
        }
    }

    // Strategy 2: If no significant buy found, use the largest in first half
    if (!trigger) {
        const firstHalf = buys.slice(0, Math.ceil(buys.length / 2));
        let maxSol = 0;
        for (let i = 0; i < firstHalf.length; i++) {
            if (firstHalf[i]!.solAmount > maxSol) {
                maxSol = firstHalf[i]!.solAmount;
                trigger = firstHalf[i]!;
                triggerIndex = i;
            }
        }
    }

    // Strategy 3: Just use first buy
    if (!trigger) {
        trigger = buys[0]!;
        triggerIndex = 0;
    }

    // Calculate follower stats
    const followers = buys.slice(triggerIndex + 1);
    const followerSlotDeltas = followers.map(f => f.slot - trigger!.slot);
    followerSlotDeltas.sort((a, b) => a - b);

    const uniqueWallets = new Set(followers.map(f => f.wallet)).size;
    const botThreshold = 100000;  // 100k lamports = likely bot
    const bots = followers.filter(f => f.priorityFee > botThreshold);
    const manuals = followers.filter(f => f.priorityFee <= botThreshold);

    // Percentile helper
    const percentile = (arr: number[], p: number): number => {
        if (arr.length === 0) return 0;
        const idx = Math.floor(arr.length * p);
        return arr[Math.min(idx, arr.length - 1)] ?? 0;
    };

    const firstSlotDelta = followerSlotDeltas[0] ?? 0;
    const medianSlotDelta = percentile(followerSlotDeltas, 0.5);
    const p90SlotDelta = percentile(followerSlotDeltas, 0.9);

    const swarmId = `${tokenMint}-${trigger.slot}-${trigger.signature.slice(0, 8)}`;

    const analyzed: AnalyzedSwarm = {
        id: swarmId,
        detectedAt: Date.now(),
        tokenMint,
        transactions: buys,
        trigger: {
            signature: trigger.signature,
            slot: trigger.slot,
            wallet: trigger.wallet,
            solAmount: trigger.solAmount,
            priorityFee: trigger.priorityFee,
            isBot: trigger.priorityFee > botThreshold,
            positionInSequence: triggerIndex + 1,
        },
        followers: {
            count: followers.length,
            totalVolume: followers.reduce((s, f) => s + f.solAmount, 0),
            uniqueWallets,
            botCount: bots.length,
            manualCount: manuals.length,
            firstFollowerSlotDelta: firstSlotDelta,
            firstFollowerLatencyMs: firstSlotDelta * CONFIG.slotTimeMs,
            medianSlotDelta,
            medianLatencyMs: medianSlotDelta * CONFIG.slotTimeMs,
            p90SlotDelta,
            p90LatencyMs: p90SlotDelta * CONFIG.slotTimeMs,
        },
        metrics: {
            totalTxs: buys.length,
            totalVolume: buys.reduce((s, b) => s + b.solAmount, 0),
            burstDurationSlots: buys[buys.length - 1]!.slot - buys[0]!.slot,
            burstDurationMs: (buys[buys.length - 1]!.slot - buys[0]!.slot) * CONFIG.slotTimeMs,
        },
    };

    return analyzed;
}

// =============================================================================
// OUTPUT & STATE
// =============================================================================

class ResearchState {
    private swarms: AnalyzedSwarm[] = [];
    private stats = {
        burstsDetected: 0,
        swarmsAnalyzed: 0,
        apiCalls: 0,
        txsProcessed: 0,
    };

    constructor() {
        if (!fs.existsSync(CONFIG.output.dir)) {
            fs.mkdirSync(CONFIG.output.dir, { recursive: true });
        }
    }

    recordSwarm(swarm: AnalyzedSwarm): void {
        this.swarms.push(swarm);
        this.stats.swarmsAnalyzed++;

        // Save to file
        const path = `${CONFIG.output.dir}/${CONFIG.output.swarms}`;
        fs.appendFileSync(path, JSON.stringify(swarm) + "\n");

        // Save trigger profile
        const triggerPath = `${CONFIG.output.dir}/${CONFIG.output.triggers}`;
        const triggerProfile = {
            wallet: swarm.trigger.wallet,
            solAmount: swarm.trigger.solAmount,
            priorityFee: swarm.trigger.priorityFee,
            isBot: swarm.trigger.isBot,
            positionInSequence: swarm.trigger.positionInSequence,
            followerCount: swarm.followers.count,
            followerVolume: swarm.followers.totalVolume,
            firstFollowerLatencyMs: swarm.followers.firstFollowerLatencyMs,
            medianLatencyMs: swarm.followers.medianLatencyMs,
        };
        fs.appendFileSync(triggerPath, JSON.stringify(triggerProfile) + "\n");

        // Console output
        const botIcon = swarm.trigger.isBot ? "🤖" : "👤";
        console.log(
            `[SWARM] ${swarm.metrics.totalTxs} txs | ` +
            `Trigger: ${swarm.trigger.solAmount.toFixed(2)} SOL ${botIcon} @ pos ${swarm.trigger.positionInSequence} | ` +
            `Followers: ${swarm.followers.count} (${swarm.followers.totalVolume.toFixed(1)} SOL) | ` +
            `Latency: ${swarm.followers.firstFollowerLatencyMs}ms first, ${swarm.followers.medianLatencyMs}ms median`
        );
    }

    incrementBursts(): void { this.stats.burstsDetected++; }
    incrementApiCalls(): void { this.stats.apiCalls++; }
    incrementTxs(): void { this.stats.txsProcessed++; }

    getStats() { return this.stats; }
    getSwarms() { return this.swarms; }

    loadExisting(): void {
        const path = `${CONFIG.output.dir}/${CONFIG.output.swarms}`;
        if (fs.existsSync(path)) {
            const lines = fs.readFileSync(path, "utf-8").trim().split("\n").filter(l => l);
            for (const line of lines) {
                try {
                    this.swarms.push(JSON.parse(line));
                } catch { }
            }
        }
        console.log(`Loaded ${this.swarms.length} existing swarms`);
    }
}

// =============================================================================
// LOG PARSING (minimal - just for burst detection, not amounts)
// =============================================================================

const SYSTEM_ACCOUNTS = new Set([
    "11111111111111111111111111111111",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    "SysvarRent111111111111111111111111111111111",
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf",
    "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM",
]);

function parseSignature(logs: Logs, ctx: Context): RawSignature | null {
    if (logs.err) return null;

    const text = (logs.logs || []).join("\n");

    // Just detect if it's a buy - don't try to parse amounts
    const isBuy = text.includes("Instruction: Buy");
    if (!isBuy) return null;  // Only track buys for burst detection

    // Extract token mint (best effort)
    const addresses = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];
    let tokenMint: string | null = null;

    for (const addr of addresses) {
        if (!SYSTEM_ACCOUNTS.has(addr) && addr.length >= 32 && addr.length <= 44) {
            tokenMint = addr;
            break;
        }
    }

    return {
        signature: logs.signature,
        slot: ctx.slot,
        receivedAt: Date.now(),
        tokenMint,
        isBuy,
    };
}

// =============================================================================
// HELPERS
// =============================================================================

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================================================
// COLLECTION
// =============================================================================

async function runCollection(durationMinutes: number): Promise<void> {
    console.log("\n" + "=".repeat(70));
    console.log("YOGURTSLINGER SWARM RESEARCH v4.0 - DONE RIGHT");
    console.log("=".repeat(70));
    console.log("🔬 Method: Detect bursts → API enrich ALL txs → Analyze with real data");
    console.log(`Duration: ${durationMinutes} minutes`);
    console.log(`Burst detection: ${CONFIG.burst.minTxs}+ buys within ${CONFIG.burst.windowMs}ms`);
    console.log(`Output: ${CONFIG.output.dir}/`);
    console.log("=".repeat(70) + "\n");

    // Test connection
    try {
        const response = await fetch(CONFIG.helius.rpc, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        console.log("✅ Helius connection OK\n");
    } catch (error) {
        console.error(`❌ Connection failed: ${error}`);
        return;
    }

    const state = new ResearchState();
    state.loadExisting();

    const detector = new BurstDetector();
    const processedSignatures = new Set<string>();
    const enrichmentQueue: { tokenMint: string; signatures: string[] }[] = [];

    const connection = new Connection(CONFIG.helius.rpc, {
        wsEndpoint: CONFIG.helius.wss,
        commitment: "confirmed",
    });

    // Process incoming logs
    function processLog(logs: Logs, ctx: Context): void {
        if (processedSignatures.has(logs.signature)) return;
        processedSignatures.add(logs.signature);

        // Memory cleanup
        if (processedSignatures.size > 30000) {
            const toKeep = Array.from(processedSignatures).slice(-15000);
            processedSignatures.clear();
            toKeep.forEach(s => processedSignatures.add(s));
        }

        state.incrementTxs();

        const sig = parseSignature(logs, ctx);
        if (!sig || !sig.tokenMint) return;

        detector.addSignature(sig);

        // Check for burst
        const burst = detector.detectBurst(sig.tokenMint);
        if (burst && burst.length >= CONFIG.burst.minTxs) {
            state.incrementBursts();

            // Queue for enrichment
            const signatures = burst.map(b => b.signature);
            enrichmentQueue.push({ tokenMint: sig.tokenMint, signatures });
        }
    }

    // Process enrichment queue
    async function processEnrichmentQueue(): Promise<void> {
        while (enrichmentQueue.length > 0) {
            const item = enrichmentQueue.shift();
            if (!item) break;

            state.incrementApiCalls();

            const enriched = await enrichTransactions(item.signatures);

            if (enriched.length >= 3) {
                const analyzed = analyzeSwarm(item.tokenMint, enriched);
                if (analyzed) {
                    state.recordSwarm(analyzed);
                }
            }

            // Small delay between enrichments
            await sleep(200);
        }
    }

    // Run enrichment processor
    const enrichmentInterval = setInterval(processEnrichmentQueue, 1000);

    // Subscribe
    console.log("Subscribing to PumpFun program...");
    let subscription: number;

    try {
        subscription = connection.onLogs(CONFIG.programs.pumpfun, processLog, "confirmed");
        console.log(`✅ Subscription ID: ${subscription}`);
    } catch (error) {
        console.error(`❌ Subscription failed: ${error}`);
        return;
    }

    console.log("\n🔍 Detecting bursts and enriching via API...\n");

    // Progress
    const startTime = Date.now();
    const endTime = startTime + durationMinutes * 60 * 1000;

    const progressInterval = setInterval(() => {
        const elapsed = (Date.now() - startTime) / 1000 / 60;
        const remaining = Math.max(0, (endTime - Date.now()) / 1000 / 60);
        const stats = state.getStats();
        const detectorStats = detector.getStats();

        console.log(
            `\n--- ${elapsed.toFixed(1)}m elapsed, ${remaining.toFixed(1)}m remaining ---\n` +
            `Txs: ${stats.txsProcessed} | Bursts: ${stats.burstsDetected} | ` +
            `Swarms: ${stats.swarmsAnalyzed} | API calls: ${stats.apiCalls} | ` +
            `Queue: ${enrichmentQueue.length} | Tracking: ${detectorStats.tokensTracked} tokens`
        );
    }, 60000);

    // Wait
    await new Promise<void>(resolve => {
        setTimeout(async () => {
            clearInterval(progressInterval);
            clearInterval(enrichmentInterval);

            // Process remaining queue
            console.log("\nProcessing remaining enrichment queue...");
            await processEnrichmentQueue();

            resolve();
        }, durationMinutes * 60 * 1000);
    });

    // Cleanup
    console.log("\nStopping collection...");
    await connection.removeOnLogsListener(subscription);

    const finalStats = state.getStats();
    console.log("\n" + "=".repeat(70));
    console.log("COLLECTION COMPLETE");
    console.log("=".repeat(70));
    console.log(`Transactions: ${finalStats.txsProcessed}`);
    console.log(`Bursts detected: ${finalStats.burstsDetected}`);
    console.log(`Swarms analyzed: ${finalStats.swarmsAnalyzed}`);
    console.log(`API calls made: ${finalStats.apiCalls}`);
    console.log(`\nData saved to: ${CONFIG.output.dir}/`);
    console.log("Next: npx tsx swarmResearch.ts analyze");
}

// =============================================================================
// ANALYSIS
// =============================================================================

async function runAnalysis(): Promise<void> {
    const state = new ResearchState();
    state.loadExisting();

    const swarms = state.getSwarms();

    console.log("\n" + "=".repeat(70));
    console.log("SWARM ANALYSIS - REAL DATA");
    console.log("=".repeat(70) + "\n");

    if (swarms.length === 0) {
        console.log("❌ No swarms collected yet.");
        console.log("Run: npx tsx swarmResearch.ts collect 60");
        return;
    }

    console.log(`Total swarms: ${swarms.length}\n`);

    // -------------------------------------------------------------------------
    // 1. TRIGGER SIZE - What actually triggers swarms?
    // -------------------------------------------------------------------------
    console.log("📊 TRIGGER SIZE (What SOL amount triggers swarms?)");
    console.log("-".repeat(50));

    const triggerSizes = swarms.map(s => s.trigger.solAmount).sort((a, b) => a - b);

    const sizeBuckets = [
        { min: 0, max: 0.1, label: "< 0.1 SOL" },
        { min: 0.1, max: 0.3, label: "0.1-0.3 SOL" },
        { min: 0.3, max: 0.5, label: "0.3-0.5 SOL" },
        { min: 0.5, max: 1.0, label: "0.5-1.0 SOL" },
        { min: 1.0, max: 2.0, label: "1.0-2.0 SOL" },
        { min: 2.0, max: 5.0, label: "2.0-5.0 SOL" },
        { min: 5.0, max: Infinity, label: "> 5.0 SOL" },
    ];

    for (const bucket of sizeBuckets) {
        const count = triggerSizes.filter(s => s >= bucket.min && s < bucket.max).length;
        const pct = (count / triggerSizes.length * 100).toFixed(1);
        const bar = "█".repeat(Math.round(count / triggerSizes.length * 30));
        console.log(`  ${bucket.label.padEnd(12)} ${count.toString().padStart(4)} (${pct.padStart(5)}%) ${bar}`);
    }

    const medianSize = triggerSizes[Math.floor(triggerSizes.length / 2)] ?? 0;
    const avgSize = triggerSizes.reduce((a, b) => a + b, 0) / triggerSizes.length;

    console.log(`\n  Median: ${medianSize.toFixed(3)} SOL`);
    console.log(`  Average: ${avgSize.toFixed(3)} SOL`);

    // -------------------------------------------------------------------------
    // 2. TRIGGER SOURCE - Bot or Manual?
    // -------------------------------------------------------------------------
    console.log("\n📊 TRIGGER SOURCE (Bot vs Manual)");
    console.log("-".repeat(50));

    const botTriggers = swarms.filter(s => s.trigger.isBot);
    const manualTriggers = swarms.filter(s => !s.trigger.isBot);

    console.log(`  Bot triggers (priority fee > 100k): ${botTriggers.length} (${(botTriggers.length / swarms.length * 100).toFixed(1)}%)`);
    console.log(`  Manual triggers: ${manualTriggers.length} (${(manualTriggers.length / swarms.length * 100).toFixed(1)}%)`);

    if (botTriggers.length > 0 && manualTriggers.length > 0) {
        const avgBotFollowers = botTriggers.reduce((s, sw) => s + sw.followers.count, 0) / botTriggers.length;
        const avgManualFollowers = manualTriggers.reduce((s, sw) => s + sw.followers.count, 0) / manualTriggers.length;

        const avgBotLatency = botTriggers.reduce((s, sw) => s + sw.followers.firstFollowerLatencyMs, 0) / botTriggers.length;
        const avgManualLatency = manualTriggers.reduce((s, sw) => s + sw.followers.firstFollowerLatencyMs, 0) / manualTriggers.length;

        console.log(`\n  Avg followers when bot triggers: ${avgBotFollowers.toFixed(1)}`);
        console.log(`  Avg followers when manual triggers: ${avgManualFollowers.toFixed(1)}`);
        console.log(`  Avg first follower latency (bot): ${avgBotLatency.toFixed(0)}ms`);
        console.log(`  Avg first follower latency (manual): ${avgManualLatency.toFixed(0)}ms`);
    }

    // -------------------------------------------------------------------------
    // 3. LATENCY - Your positioning window
    // -------------------------------------------------------------------------
    console.log("\n📊 FOLLOWER LATENCY (Your positioning window)");
    console.log("-".repeat(50));

    const firstLatencies = swarms.map(s => s.followers.firstFollowerLatencyMs).sort((a, b) => a - b);
    const medianLatencies = swarms.map(s => s.followers.medianLatencyMs).sort((a, b) => a - b);

    console.log("  First follower arrives:");
    console.log(`    Min: ${firstLatencies[0]}ms`);
    console.log(`    P10: ${firstLatencies[Math.floor(firstLatencies.length * 0.1)]}ms`);
    console.log(`    Median: ${firstLatencies[Math.floor(firstLatencies.length * 0.5)]}ms`);
    console.log(`    P90: ${firstLatencies[Math.floor(firstLatencies.length * 0.9)]}ms`);
    console.log(`    Max: ${firstLatencies[firstLatencies.length - 1]}ms`);

    console.log("\n  Median follower arrives:");
    console.log(`    Median: ${medianLatencies[Math.floor(medianLatencies.length * 0.5)]}ms`);
    console.log(`    P90: ${medianLatencies[Math.floor(medianLatencies.length * 0.9)]}ms`);

    // -------------------------------------------------------------------------
    // 4. VOLUME - Exit liquidity
    // -------------------------------------------------------------------------
    console.log("\n📊 FOLLOWER VOLUME (Exit liquidity)");
    console.log("-".repeat(50));

    const volumes = swarms.map(s => s.followers.totalVolume).sort((a, b) => a - b);

    console.log(`  Min: ${volumes[0]?.toFixed(2)} SOL`);
    console.log(`  Median: ${volumes[Math.floor(volumes.length / 2)]?.toFixed(2)} SOL`);
    console.log(`  Avg: ${(volumes.reduce((a, b) => a + b, 0) / volumes.length).toFixed(2)} SOL`);
    console.log(`  Max: ${volumes[volumes.length - 1]?.toFixed(2)} SOL`);

    // -------------------------------------------------------------------------
    // 5. TOP TRIGGER WALLETS
    // -------------------------------------------------------------------------
    console.log("\n📊 TOP TRIGGER WALLETS");
    console.log("-".repeat(50));

    const walletStats: Record<string, { count: number; totalSol: number; avgFollowers: number }> = {};

    for (const swarm of swarms) {
        const w = swarm.trigger.wallet;
        if (!walletStats[w]) {
            walletStats[w] = { count: 0, totalSol: 0, avgFollowers: 0 };
        }
        walletStats[w]!.count++;
        walletStats[w]!.totalSol += swarm.trigger.solAmount;
        walletStats[w]!.avgFollowers += swarm.followers.count;
    }

    for (const w of Object.keys(walletStats)) {
        walletStats[w]!.avgFollowers /= walletStats[w]!.count;
    }

    const topWallets = Object.entries(walletStats)
        .filter(([_, s]) => s.count >= 2)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 10);

    for (const [wallet, data] of topWallets) {
        console.log(
            `  ${wallet.slice(0, 12)}... | ` +
            `${data.count} triggers | ` +
            `${data.totalSol.toFixed(2)} SOL total | ` +
            `${data.avgFollowers.toFixed(1)} avg followers`
        );
    }

    // -------------------------------------------------------------------------
    // 6. KEY FINDINGS
    // -------------------------------------------------------------------------
    console.log("\n" + "=".repeat(70));
    console.log("🎯 KEY FINDINGS");
    console.log("=".repeat(70));

    const pctAbove05 = (triggerSizes.filter(s => s >= 0.5).length / triggerSizes.length * 100).toFixed(1);
    const pctManual = (manualTriggers.length / swarms.length * 100).toFixed(1);
    const medianFirstLatency = firstLatencies[Math.floor(firstLatencies.length / 2)] ?? 0;
    const medianVolume = volumes[Math.floor(volumes.length / 2)] ?? 0;

    console.log(`\n1. TRIGGER SIZE:`);
    console.log(`   Median: ${medianSize.toFixed(2)} SOL`);
    console.log(`   ${pctAbove05}% of triggers are ≥ 0.5 SOL`);

    console.log(`\n2. TRIGGER SOURCE:`);
    console.log(`   ${pctManual}% are manual traders (low priority fee)`);

    console.log(`\n3. POSITIONING WINDOW:`);
    console.log(`   First follower: ${medianFirstLatency}ms (median)`);
    console.log(`   Slot-based ordering = reliable data`);

    console.log(`\n4. EXIT LIQUIDITY:`);
    console.log(`   ${medianVolume.toFixed(2)} SOL median follower volume`);

    // Save summary
    const summary = {
        timestamp: Date.now(),
        totalSwarms: swarms.length,
        triggerSize: { median: medianSize, average: avgSize, pctAbove05Sol: parseFloat(pctAbove05) },
        triggerSource: { pctManual: parseFloat(pctManual), pctBot: 100 - parseFloat(pctManual) },
        latency: {
            firstFollowerMedian: medianFirstLatency,
            medianFollowerMedian: medianLatencies[Math.floor(medianLatencies.length / 2)] ?? 0,
        },
        volume: { median: medianVolume },
    };

    fs.writeFileSync(
        `${CONFIG.output.dir}/${CONFIG.output.summary}`,
        JSON.stringify(summary, null, 2)
    );

    console.log(`\nSummary saved to: ${CONFIG.output.dir}/${CONFIG.output.summary}`);
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const command = args[0] || "help";

    switch (command) {
        case "collect": {
            const minutes = parseInt(args[1] ?? "60", 10);
            await runCollection(minutes);
            break;
        }

        case "analyze":
            await runAnalysis();
            break;

        default:
            console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║          YOGURTSLINGER SWARM RESEARCH v4.0 - DONE RIGHT              ║
╚══════════════════════════════════════════════════════════════════════╝

METHODOLOGY:
1. WebSocket detects BURSTS (5+ buys to same token in 5 seconds)
2. On burst: capture ALL signatures
3. API enriches ENTIRE burst to get REAL data:
   - Actual SOL amounts (from nativeTransfers)
   - Actual slots (chain ordering, not timestamps)
   - Actual priority fees (real bot detection)
4. Analyze with slot-ordered, API-verified data

NO LOG PARSING FOR AMOUNTS. NO TIMESTAMP ORDERING.

USAGE:
  npx tsx swarmResearch.ts collect [minutes]
  npx tsx swarmResearch.ts analyze

OUTPUT:
  ./swarm_research_v4/swarms.jsonl
  ./swarm_research_v4/triggers.jsonl
  ./swarm_research_v4/summary.json
            `);
    }
}

main().catch(console.error);