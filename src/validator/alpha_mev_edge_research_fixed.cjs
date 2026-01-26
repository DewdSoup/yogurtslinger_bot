#!/usr/bin/env node
/**
 * alpha_mev_edge_research.js
 *
 * See the TypeScript file for full comments / rationale.
 * This JS version is included so you can run it with:
 *   node alpha_mev_edge_research.js
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Connection, PublicKey } = require("@solana/web3.js");

// -----------------------------
// Configuration (env-driven)
// -----------------------------
const HELIUS_RPC_URL = (process.env.HELIUS_RPC_URL || "").trim();
const HELIUS_WSS_URL = (process.env.HELIUS_WSS_URL || "").trim();

const COMMITMENT = (process.env.COMMITMENT || "confirmed").trim();
const RUN_SECONDS = Number(process.env.RUN_SECONDS || "1800");
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || "6");
const OUT_FILE =
    (process.env.OUT_FILE || "").trim() ||
    path.resolve(process.cwd(), `alpha_mev_surface_${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
const SUMMARY_FILE =
    (process.env.SUMMARY_FILE || "").trim() ||
    path.resolve(process.cwd(), `alpha_mev_surface_summary_${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const SUMMARY_EVERY_SECONDS = Number(process.env.SUMMARY_EVERY_SECONDS || "60");

// Enhanced Transactions (optional augmentation)
const ENHANCED_MODE = (process.env.ENHANCED_MODE || "candidate").trim().toLowerCase(); // off | candidate | all
const HELIUS_API_KEY = (process.env.HELIUS_API_KEY || "").trim();

// Heuristic thresholds (research filters)
const MIN_JITO_TIP_LAMPORTS = BigInt(process.env.MIN_JITO_TIP_LAMPORTS || "1"); // default: >0
const MIN_STABLE_PROFIT_RAW = BigInt(process.env.MIN_STABLE_PROFIT_RAW || "0"); // raw 6-decimal units

if (!HELIUS_RPC_URL) {
    console.error("Missing HELIUS_RPC_URL env var.");
    process.exit(1);
}
if (!HELIUS_WSS_URL) {
    console.error("Missing HELIUS_WSS_URL env var.");
    process.exit(1);
}

const connection = new Connection(HELIUS_RPC_URL, {
    commitment: COMMITMENT,
    wsEndpoint: HELIUS_WSS_URL,
});

// -----------------------------
// Jito tip accounts (mainnet)
// -----------------------------
const JITO_TIP_ACCOUNTS = [
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
    "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
];

const JITO_TIP_PAYMENT_PROGRAM = "T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt";

// -----------------------------
// Common program IDs (noise)
// -----------------------------
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

const NOISE_PROGRAMS = new Set([
    SYSTEM_PROGRAM,
    TOKEN_PROGRAM,
    ASSOCIATED_TOKEN_PROGRAM,
    COMPUTE_BUDGET_PROGRAM,
    MEMO_PROGRAM,
]);

// -----------------------------
// Base assets (value proxy)
// -----------------------------
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

// -----------------------------
// Small utilities
// -----------------------------
function nowMs() {
    return Date.now();
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function sha256Hex(s) {
    return crypto.createHash("sha256").update(s).digest("hex");
}

function safeBigIntFromString(x) {
    if (typeof x === "bigint") return x;
    if (typeof x === "number") return BigInt(Math.trunc(x));
    if (typeof x === "string" && x.length > 0) return BigInt(x);
    return 0n;
}

function parseComputeUnitsFromLogs(logs) {
    if (!logs) return null;
    let best = null;
    for (const line of logs) {
        const m = /consumed\s+(\d+)\s+of\s+(\d+)\s+compute\s+units/i.exec(line);
        if (!m) continue;
        const used = Number(m[1]);
        if (!Number.isFinite(used)) continue;
        if (best === null || used > best) best = used;
    }
    return best;
}

function extractComputeUnitPriceMicroLamports(parsedInstructions) {
    for (const ix of parsedInstructions) {
        try {
            const programId = typeof ix?.programId === "string" ? ix.programId : ix?.programId?.toString?.();
            if (programId !== COMPUTE_BUDGET_PROGRAM) continue;
            const parsed = ix?.parsed;
            if (!parsed || typeof parsed !== "object") continue;
            const t = (parsed?.type || "").toString();
            if (t !== "setComputeUnitPrice") continue;

            const info = parsed?.info;
            const v = info?.microLamports ?? info?.micro_lamports ?? info?.microLamportsPerCU;
            if (v === undefined || v === null) continue;
            return safeBigIntFromString(v);
        } catch { }
    }
    return null;
}

function estimateBaseFeeLamports(signaturesCount) {
    return BigInt(signaturesCount) * 5000n;
}

function ceilDiv(a, b) {
    if (b === 0n) return 0n;
    return (a + b - 1n) / b;
}

// -----------------------------
// Async queue + worker pool
// -----------------------------
class AsyncQueue {
    constructor() {
        this.q = [];
        this.waiters = [];
    }
    push(item) {
        const w = this.waiters.shift();
        if (w) w(item);
        else this.q.push(item);
    }
    async pop() {
        const v = this.q.shift();
        if (v !== undefined) return v;
        return new Promise((resolve) => this.waiters.push(resolve));
    }
    size() {
        return this.q.length;
    }
}

const queue = new AsyncQueue();

// Dedup signatures with TTL to bound memory
const seenSig = new Map(); // sig -> lastSeenMs
const DEDUP_TTL_MS = 30 * 60 * 1000; // 30 min
const DEDUP_MAX = 500_000;

function rememberSignature(sig) {
    const t = nowMs();
    const prev = seenSig.get(sig);
    if (prev && t - prev < DEDUP_TTL_MS) return false;
    seenSig.set(sig, t);

    if (seenSig.size > DEDUP_MAX) {
        const cutoff = t - DEDUP_TTL_MS;
        for (const [k, v] of seenSig) {
            if (v < cutoff) seenSig.delete(k);
        }
        if (seenSig.size > DEDUP_MAX) {
            console.warn(`[dedup] hard reset from size=${seenSig.size}`);
            seenSig.clear();
        }
    }
    return true;
}

// -----------------------------
// Output streams
// -----------------------------
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
const outStream = fs.createWriteStream(OUT_FILE, { flags: "a" });

// -----------------------------
// Aggregation
// -----------------------------
const fpStats = new Map();
const programStats = new Map();

function stableRaw(usdc, usdt) {
    return usdc + usdt;
}

function toISO(ms) {
    return new Date(ms).toISOString();
}

function bumpProgram(programId, delta) {
    const s =
        programStats.get(programId) || {
            programId,
            count: 0,
            totalJitoTipLamports: 0n,
            totalTxFeeLamports: 0n,
            totalUsdcDelta: 0n,
            totalUsdtDelta: 0n,
        };
    s.count += 1;
    s.totalJitoTipLamports += delta.jitoTip;
    s.totalTxFeeLamports += delta.fee;
    s.totalUsdcDelta += delta.usdc;
    s.totalUsdtDelta += delta.usdt;
    programStats.set(programId, s);
}

function bumpFingerprint(fp, feePayer, delta, examples) {
    const t = nowMs();
    const s =
        fpStats.get(fp) || {
            fingerprint: fp,
            firstSeenMs: t,
            lastSeenMs: t,
            count: 0,
            uniqueFeePayers: new Set(),
            totalJitoTipLamports: 0n,
            totalTxFeeLamports: 0n,
            totalUsdcDelta: 0n,
            totalUsdtDelta: 0n,
            maxStableProfitRaw: 0n,
            exampleSignatures: [],
            examplePrograms: [],
            exampleMints: [],
        };
    s.lastSeenMs = t;
    s.count += 1;
    s.uniqueFeePayers.add(feePayer);
    s.totalJitoTipLamports += delta.jitoTip;
    s.totalTxFeeLamports += delta.fee;
    s.totalUsdcDelta += delta.usdc;
    s.totalUsdtDelta += delta.usdt;
    if (delta.stableProfitRaw > s.maxStableProfitRaw) s.maxStableProfitRaw = delta.stableProfitRaw;

    if (s.exampleSignatures.length < 5) s.exampleSignatures.push(examples.sig);
    if (s.examplePrograms.length === 0) s.examplePrograms = examples.programs.slice(0, 12);
    if (s.exampleMints.length === 0) s.exampleMints = examples.mints.slice(0, 12);

    fpStats.set(fp, s);
}

// -----------------------------
// Optional: Helius Enhanced Transactions API call
// -----------------------------
async function fetchEnhancedTransactions(signatures) {
    if (!HELIUS_API_KEY) return null;

    const url = `https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${encodeURIComponent(HELIUS_API_KEY)}`;
    const body = { transactions: signatures };

    let backoffMs = 250;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (res.status === 429) {
                await sleep(backoffMs);
                backoffMs *= 2;
                continue;
            }
            if (!res.ok) {
                const txt = await res.text().catch(() => "");
                throw new Error(`EnhancedTx HTTP ${res.status}: ${txt.slice(0, 200)}`);
            }
            const data = await res.json();
            return data;
        } catch (e) {
            if (attempt === 4) throw e;
            await sleep(backoffMs);
            backoffMs *= 2;
        }
    }
    return null;
}

// -----------------------------
// Core per-tx extraction
// -----------------------------
function sortUnique(arr) {
    return Array.from(new Set(arr)).sort();
}

function collectProgramIds(tx) {
    const counts = {};
    const programIds = [];

    const accountKeys = (tx?.transaction?.message?.accountKeys || [])
        .map((k) => (typeof k === "string" ? k : k?.pubkey))
        .filter(Boolean);

    const top = tx?.transaction?.message?.instructions || [];
    for (const ix of top) {
        let pid;
        if (typeof ix?.programId === "string") pid = ix.programId;
        else if (ix?.programId?.toString) pid = ix.programId.toString();
        else if (typeof ix?.programIdIndex === "number" && accountKeys[ix.programIdIndex]) pid = accountKeys[ix.programIdIndex];
        if (!pid) continue;
        counts[pid] = (counts[pid] || 0) + 1;
        programIds.push(pid);
    }

    const inner = tx?.meta?.innerInstructions || [];
    for (const innerIx of inner) {
        const ins = innerIx?.instructions || [];
        for (const ix of ins) {
            let pid;
            if (typeof ix?.programId === "string") pid = ix.programId;
            else if (ix?.programId?.toString) pid = ix.programId.toString();
            else if (typeof ix?.programIdIndex === "number" && accountKeys[ix.programIdIndex]) pid = accountKeys[ix.programIdIndex];
            if (!pid) continue;
            counts[pid] = (counts[pid] || 0) + 1;
            programIds.push(pid);
        }
    }

    return { programIds: sortUnique(programIds), counts };
}

function computeJitoTipLamports(tx) {
    const breakdown = {};
    let total = 0n;

    const keys = (tx?.transaction?.message?.accountKeys || [])
        .map((k) => (typeof k === "string" ? k : k?.pubkey))
        .filter(Boolean);

    const pre = (tx?.meta?.preBalances || []).map((x) => safeBigIntFromString(x));
    const post = (tx?.meta?.postBalances || []).map((x) => safeBigIntFromString(x));

    for (const tip of JITO_TIP_ACCOUNTS) {
        const i = keys.indexOf(tip);
        if (i < 0) continue;
        const d = (post[i] ?? 0n) - (pre[i] ?? 0n);
        if (d > 0n) {
            breakdown[tip] = d;
            total += d;
        }
    }

    return { total, breakdown };
}

function tokenBalanceKey(e) {
    return `${e?.accountIndex ?? ""}`;
}

function extractTokenDeltas(tx) {
    const accountKeys = (tx?.transaction?.message?.accountKeys || [])
        .map((k) => (typeof k === "string" ? k : k?.pubkey))
        .filter(Boolean);

    const pre = tx?.meta?.preTokenBalances || [];
    const post = tx?.meta?.postTokenBalances || [];

    const preMap = new Map();
    const postMap = new Map();
    for (const e of pre) preMap.set(tokenBalanceKey(e), e);
    for (const e of post) postMap.set(tokenBalanceKey(e), e);

    const keys = new Set([...preMap.keys(), ...postMap.keys()]);
    const tokenDeltas = [];
    const changedMints = [];
    const ownerMintDeltas = new Map();

    for (const k of keys) {
        const a = preMap.get(k);
        const b = postMap.get(k);

        const accountIndex = b?.accountIndex ?? a?.accountIndex;
        const tokenAccount = accountKeys[accountIndex] || `index:${accountIndex}`;

        const mint = b?.mint ?? a?.mint;
        if (!mint) continue;
        const owner = b?.owner ?? a?.owner ?? "unknown";

        const preAmt = safeBigIntFromString(a?.uiTokenAmount?.amount ?? "0");
        const postAmt = safeBigIntFromString(b?.uiTokenAmount?.amount ?? "0");
        const delta = postAmt - preAmt;
        const decimals = Number(b?.uiTokenAmount?.decimals ?? a?.uiTokenAmount?.decimals ?? 0);

        if (delta !== 0n) {
            tokenDeltas.push({
                tokenAccount,
                owner,
                mint,
                pre: preAmt.toString(),
                post: postAmt.toString(),
                delta: delta.toString(),
                decimals,
            });
            changedMints.push(mint);

            let om = ownerMintDeltas.get(owner);
            if (!om) {
                om = new Map();
                ownerMintDeltas.set(owner, om);
            }
            om.set(mint, (om.get(mint) ?? 0n) + delta);
        }
    }

    return { tokenDeltas, changedMints: sortUnique(changedMints), ownerMintDeltas };
}

function feePayerFromAccountKeys(tx) {
    const keys = tx?.transaction?.message?.accountKeys;
    if (!Array.isArray(keys) || keys.length === 0) return null;
    const k0 = keys[0];
    const pk = typeof k0 === "string" ? k0 : k0?.pubkey;
    return typeof pk === "string" ? pk : null;
}

function feePayerLamportsDelta(tx) {
    const pre = (tx?.meta?.preBalances || []).map((x) => safeBigIntFromString(x));
    const post = (tx?.meta?.postBalances || []).map((x) => safeBigIntFromString(x));
    if (pre.length === 0 || post.length === 0) return 0n;
    return (post[0] ?? 0n) - (pre[0] ?? 0n);
}

// -----------------------------
// Processing pipeline
// -----------------------------
let processed = 0;
let failed = 0;

async function getParsedTxWithRetry(signature) {
    let backoff = 200;
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            const tx = await connection.getParsedTransaction(signature, {
                commitment: COMMITMENT,
                maxSupportedTransactionVersion: 0,
            });
            return tx;
        } catch (e) {
            const msg = String(e?.message || e);
            if (msg.includes("429") || msg.toLowerCase().includes("rate") || msg.toLowerCase().includes("timeout")) {
                await sleep(backoff);
                backoff *= 2;
                continue;
            }
            throw e;
        }
    }
    return null;
}

async function processSignature(p) {
    const signature = p.signature;
    const tx = await getParsedTxWithRetry(signature);
    if (!tx) return;

    const feePayer = feePayerFromAccountKeys(tx);
    if (!feePayer) return;

    const err = tx?.meta?.err ?? null;

    const feeLamports = safeBigIntFromString(tx?.meta?.fee ?? "0");
    const signaturesCount = Array.isArray(tx?.transaction?.signatures) ? tx.transaction.signatures.length : 1;
    const baseFeeEst = estimateBaseFeeLamports(signaturesCount);

    const cuUsed =
        typeof tx?.meta?.computeUnitsConsumed === "number" ? tx.meta.computeUnitsConsumed : parseComputeUnitsFromLogs(tx?.meta?.logMessages);

    const cuPriceMicro = extractComputeUnitPriceMicroLamports(tx?.transaction?.message?.instructions || []);
    const priorityFromCU = cuUsed !== null && cuPriceMicro !== null ? ceilDiv(BigInt(cuUsed) * cuPriceMicro, 1_000_000n) : null;
    const priorityFromMeta = feeLamports > baseFeeEst ? feeLamports - baseFeeEst : 0n;

    const tip = computeJitoTipLamports(tx);
    const jitoTipLamports = tip.total;

    const tds = extractTokenDeltas(tx);

    const ownerMintDeltasObj = {};
    for (const [owner, m] of tds.ownerMintDeltas.entries()) {
        const inner = {};
        for (const [mint, d] of m.entries()) inner[mint] = d.toString();
        ownerMintDeltasObj[owner] = inner;
    }

    const fpLamportsDelta = feePayerLamportsDelta(tx);

    const fpWsolDelta = safeBigIntFromString(ownerMintDeltasObj[feePayer]?.[WSOL_MINT] ?? "0");
    const fpUsdcDelta = safeBigIntFromString(ownerMintDeltasObj[feePayer]?.[USDC_MINT] ?? "0");
    const fpUsdtDelta = safeBigIntFromString(ownerMintDeltasObj[feePayer]?.[USDT_MINT] ?? "0");

    let bestOwner = null;
    let bestUsdc = 0n;
    let bestUsdt = 0n;
    let bestStable = 0n;

    for (const [owner, m] of tds.ownerMintDeltas.entries()) {
        const usdc = m.get(USDC_MINT) ?? 0n;
        const usdt = m.get(USDT_MINT) ?? 0n;
        const s = stableRaw(usdc, usdt);
        if (s > bestStable) {
            bestStable = s;
            bestOwner = owner;
            bestUsdc = usdc;
            bestUsdt = usdt;
        }
    }

    const programs = collectProgramIds(tx);
    const interestingPrograms = programs.programIds.filter((pid) => !NOISE_PROGRAMS.has(pid));
    const changedMints = tds.changedMints;

    const fpPayload = JSON.stringify({
        programs: interestingPrograms.slice(0, 32),
        mints: changedMints.slice(0, 32),
    });
    const fingerprint = sha256Hex(fpPayload);

    let enhanced = undefined;
    const isCandidate = jitoTipLamports >= MIN_JITO_TIP_LAMPORTS || bestStable >= MIN_STABLE_PROFIT_RAW;
    const wantEnhanced =
        HELIUS_API_KEY && ENHANCED_MODE !== "off" && (ENHANCED_MODE === "all" || (ENHANCED_MODE === "candidate" && isCandidate));

    if (wantEnhanced) {
        try {
            const parsed = await fetchEnhancedTransactions([signature]);
            if (Array.isArray(parsed) && parsed.length > 0) enhanced = parsed[0];
        } catch (e) {
            enhanced = { error: String(e?.message || e) };
        }
    }

    const record = {
        schema: "alpha_mev_surface_v1",

        signature,
        slot: tx?.slot ?? p.hintSlot ?? -1,
        blockTime: tx?.blockTime ?? null,
        observedAtMs: p.seenAtMs,

        err,

        feePayer,
        signaturesCount,

        feeLamports: feeLamports.toString(),
        baseFeeLamportsEst: baseFeeEst.toString(),
        cuPriceMicroLamports: cuPriceMicro !== null ? cuPriceMicro.toString() : null,
        computeUnitsConsumed: cuUsed,
        priorityFeeLamportsFromCU: priorityFromCU !== null ? priorityFromCU.toString() : null,
        priorityFeeLamportsFromMeta: priorityFromMeta !== null ? priorityFromMeta.toString() : null,

        jitoTipLamports: jitoTipLamports.toString(),
        jitoTipBreakdown: Object.fromEntries(Object.entries(tip.breakdown).map(([k, v]) => [k, v.toString()])),

        programIdsAll: programs.programIds,
        programIdsInteresting: interestingPrograms,
        programInvocationCounts: programs.counts,
        fingerprint,

        changedMints,
        tokenDeltas: tds.tokenDeltas,

        ownerMintDeltas: ownerMintDeltasObj,

        feePayerLamportsDelta: fpLamportsDelta.toString(),
        feePayerWsolDeltaRaw: fpWsolDelta.toString(),
        feePayerUsdcDeltaRaw: fpUsdcDelta.toString(),
        feePayerUsdtDeltaRaw: fpUsdtDelta.toString(),

        bestStableOwner: bestOwner,
        bestUsdcDeltaRaw: bestUsdc.toString(),
        bestUsdtDeltaRaw: bestUsdt.toString(),
        bestStableDeltaRaw: bestStable.toString(),

        ...(enhanced !== undefined ? { enhanced } : {}),
    };

    if (isCandidate) {
        bumpFingerprint(
            fingerprint,
            feePayer,
            { jitoTip: jitoTipLamports, fee: feeLamports, usdc: bestUsdc, usdt: bestUsdt, stableProfitRaw: bestStable },
            { sig: signature, programs: interestingPrograms, mints: changedMints }
        );

        for (const pid of interestingPrograms) {
            bumpProgram(pid, { jitoTip: jitoTipLamports, fee: feeLamports, usdc: bestUsdc, usdt: bestUsdt });
        }
    }

    outStream.write(JSON.stringify(record) + "\n");
    processed += 1;
}

async function workerLoop(workerId, stopAtMs) {
    while (nowMs() < stopAtMs) {
        const p = await queue.pop();
        try {
            await processSignature(p);
        } catch (e) {
            failed += 1;
            const msg = String(e?.message || e);
            console.warn(`[worker ${workerId}] failed sig=${p.signature}: ${msg}`);
        }
    }
}

// -----------------------------
// Periodic summary writer
// -----------------------------
function summarizeTopK(arr, k) {
    return arr.slice(0, Math.min(k, arr.length));
}

function writeSummary() {
    const fps = Array.from(fpStats.values()).map((s) => ({
        fingerprint: s.fingerprint,
        firstSeen: toISO(s.firstSeenMs),
        lastSeen: toISO(s.lastSeenMs),
        count: s.count,
        uniqueFeePayers: s.uniqueFeePayers.size,
        totalJitoTipLamports: s.totalJitoTipLamports.toString(),
        totalTxFeeLamports: s.totalTxFeeLamports.toString(),
        totalUsdcDeltaRaw: s.totalUsdcDelta.toString(),
        totalUsdtDeltaRaw: s.totalUsdtDelta.toString(),
        maxStableProfitRaw: s.maxStableProfitRaw.toString(),
        exampleSignatures: s.exampleSignatures,
        examplePrograms: s.examplePrograms,
        exampleMints: s.exampleMints,
    }));

    fps.sort((a, b) => {
        const A = BigInt(a.maxStableProfitRaw);
        const B = BigInt(b.maxStableProfitRaw);
        if (A === B) return b.count - a.count;
        return B > A ? 1 : -1;
    });

    const progs = Array.from(programStats.values()).map((p) => ({
        programId: p.programId,
        count: p.count,
        totalJitoTipLamports: p.totalJitoTipLamports.toString(),
        totalTxFeeLamports: p.totalTxFeeLamports.toString(),
        totalUsdcDeltaRaw: p.totalUsdcDelta.toString(),
        totalUsdtDeltaRaw: p.totalUsdtDelta.toString(),
        totalStableDeltaRaw: (p.totalUsdcDelta + p.totalUsdtDelta).toString(),
    }));

    progs.sort((a, b) => {
        const A = BigInt(a.totalStableDeltaRaw);
        const B = BigInt(b.totalStableDeltaRaw);
        if (A === B) return b.count - a.count;
        return B > A ? 1 : -1;
    });

    const summary = {
        schema: "alpha_mev_surface_summary_v1",
        generatedAt: new Date().toISOString(),
        config: {
            commitment: COMMITMENT,
            runSeconds: RUN_SECONDS,
            maxConcurrency: MAX_CONCURRENCY,
            enhancedMode: ENHANCED_MODE,
            minJitoTipLamports: MIN_JITO_TIP_LAMPORTS.toString(),
            minStableProfitRaw: MIN_STABLE_PROFIT_RAW.toString(),
            outFile: OUT_FILE,
        },
        counters: {
            processed,
            failed,
            queueDepth: queue.size(),
            fingerprintsTracked: fpStats.size,
            programsTracked: programStats.size,
        },
        topFingerprintsByMaxStableProfit: summarizeTopK(fps, 50),
        topProgramsByTotalStableDelta: summarizeTopK(progs, 50),
    };

    fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));
}

// -----------------------------
// Subscriptions: logsSubscribe on tip accounts
// -----------------------------
async function startSubscriptions() {
    const subs = [];

    for (const tip of JITO_TIP_ACCOUNTS) {
        const id = connection.onLogs(new PublicKey(tip),
            (logInfo, ctx) => {
                const sig = logInfo?.signature;
                if (!sig) return;
                if (!rememberSignature(sig)) return;
                queue.push({
                    signature: sig,
                    seenAtMs: nowMs(),
                    hintSlot: ctx?.slot,
                    source: `jito_tip_account:${tip}`,
                });
            },
            COMMITMENT
        );
        subs.push(id);
    }

    const idProg = connection.onLogs(new PublicKey(JITO_TIP_PAYMENT_PROGRAM),
        (logInfo, ctx) => {
            const sig = logInfo?.signature;
            if (!sig) return;
            if (!rememberSignature(sig)) return;
            queue.push({
                signature: sig,
                seenAtMs: nowMs(),
                hintSlot: ctx?.slot,
                source: `jito_tip_program:${JITO_TIP_PAYMENT_PROGRAM}`,
            });
        },
        COMMITMENT
    );
    subs.push(idProg);

    return subs;
}

// -----------------------------
// Main
// -----------------------------
async function main() {
    console.log(`[alpha_mev_edge_research] Starting...`);
    console.log(`  RPC: ${HELIUS_RPC_URL}`);
    console.log(`  WSS: ${HELIUS_WSS_URL}`);
    console.log(`  commitment=${COMMITMENT} runSeconds=${RUN_SECONDS} concurrency=${MAX_CONCURRENCY}`);
    console.log(`  out=${OUT_FILE}`);
    console.log(`  summary=${SUMMARY_FILE} every=${SUMMARY_EVERY_SECONDS}s`);
    console.log(`  enhancedMode=${ENHANCED_MODE} enhancedKeyPresent=${Boolean(HELIUS_API_KEY)}`);

    const stopAtMs = nowMs() + RUN_SECONDS * 1000;

    const subs = await startSubscriptions();
    console.log(`[subscriptions] active=${subs.length} (tipAccounts=${JITO_TIP_ACCOUNTS.length} + tipProgram=1)`);

    const workers = [];
    for (let i = 0; i < MAX_CONCURRENCY; i++) workers.push(workerLoop(i, stopAtMs));

    const interval = setInterval(() => {
        try {
            writeSummary();
            console.log(`[summary] processed=${processed} failed=${failed} q=${queue.size()} fps=${fpStats.size} progs=${programStats.size}`);
        } catch (e) {
            console.warn(`[summary] failed: ${String(e?.message || e)}`);
        }
    }, SUMMARY_EVERY_SECONDS * 1000);

    const stop = async () => {
        clearInterval(interval);
        try {
            writeSummary();
        } catch { }
        for (const subId of subs) {
            try {
                await connection.removeOnLogsListener(subId);
            } catch { }
        }
        outStream.end();
    };

    process.on("SIGINT", async () => {
        console.log(`\n[signal] SIGINT received, shutting down...`);
        await stop();
        process.exit(0);
    });

    await Promise.all(workers);
    await stop();

    console.log(`[alpha_mev_edge_research] Done. processed=${processed} failed=${failed}`);
    console.log(`  JSONL: ${OUT_FILE}`);
    console.log(`  Summary: ${SUMMARY_FILE}`);
}

main().catch((e) => {
    console.error(`[fatal] ${String(e?.message || e)}`);
    process.exit(1);
});
