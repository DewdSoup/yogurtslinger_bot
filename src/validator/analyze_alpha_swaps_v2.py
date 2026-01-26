#!/usr/bin/env node
/**
 * alpha_mev_edge_research_v2.cjs
 *
 * Fixes:
 *  - Stops calling getParsedTransaction per signature (was producing 0 processed due to missing/lag/rate limits)
 *  - Uses Helius Enhanced Transactions endpoint as the PRIMARY data source, in BATCH mode
 *  - Adds retry-on-missing semantics (Helius docs recommend retrying missing signatures)
 *  - Adds bounded pending buffer + backpressure so the process doesn't OOM when monitoring tip accounts
 *
 * Research-only:
 *  - Builds an "alpha surface map" keyed by (program set + mint set + type/source)
 *
 * Requirements:
 *  - Node 18+ recommended (for stable timers; this script uses built-in https, no fetch dependency)
 *  - npm i @solana/web3.js
 *
 * Env vars:
 *  HELIUS_RPC_URL (required)  - e.g. https://mainnet.helius-rpc.com/?api-key=...
 *  HELIUS_WSS_URL (required)  - e.g. wss://mainnet.helius-rpc.com/?api-key=...
 *  HELIUS_API_KEY (required for enhanced) - api key value only (NOT the full URL)
 *
 *  RUN_SECONDS=3600
 *  COMMITMENT=confirmed
 *  OUT_FILE=alpha_mev_surface_<ts>.jsonl
 *  SUMMARY_FILE=alpha_mev_surface_summary_<ts>.json
 *  SUMMARY_EVERY_SECONDS=30
 *
 *  BATCH_SIZE=100
 *  BATCH_INTERVAL_MS=500
 *  INITIAL_DELAY_MS=1500
 *  MAX_MISSING_RETRIES=6
 *  MAX_PENDING=50000
 *
 *  INGRESS_SAMPLE_PCT=1.0     # 1.0 = keep all, 0.25 keeps 25%
 *  STORE_ENHANCED=0|1         # store raw enhanced object (can be large)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const { Connection, PublicKey } = require("@solana/web3.js");

// -----------------------------
// Configuration
// -----------------------------
const HELIUS_RPC_URL = (process.env.HELIUS_RPC_URL || "").trim();
const HELIUS_WSS_URL = (process.env.HELIUS_WSS_URL || "").trim();
const HELIUS_API_KEY = (process.env.HELIUS_API_KEY || "").trim(); // key only

const COMMITMENT = (process.env.COMMITMENT || "confirmed").trim();
const RUN_SECONDS = Number(process.env.RUN_SECONDS || "3600");

const OUT_FILE =
  (process.env.OUT_FILE || "").trim() ||
  path.resolve(process.cwd(), `alpha_mev_surface_${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);

const SUMMARY_FILE =
  (process.env.SUMMARY_FILE || "").trim() ||
  path.resolve(process.cwd(), `alpha_mev_surface_summary_${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

const SUMMARY_EVERY_SECONDS = Number(process.env.SUMMARY_EVERY_SECONDS || "60");

const BATCH_SIZE = Math.max(1, Math.min(250, Number(process.env.BATCH_SIZE || "100")));
const BATCH_INTERVAL_MS = Math.max(100, Number(process.env.BATCH_INTERVAL_MS || "500"));
const INITIAL_DELAY_MS = Math.max(0, Number(process.env.INITIAL_DELAY_MS || "1500"));
const MAX_MISSING_RETRIES = Math.max(0, Number(process.env.MAX_MISSING_RETRIES || "6"));
const MAX_PENDING = Math.max(1000, Number(process.env.MAX_PENDING || "50000"));

const INGRESS_SAMPLE_PCT = Math.max(0, Math.min(1, Number(process.env.INGRESS_SAMPLE_PCT || "1.0")));
const STORE_ENHANCED = (process.env.STORE_ENHANCED || "0").trim() === "1";

if (!HELIUS_RPC_URL) {
  console.error("Missing HELIUS_RPC_URL");
  process.exit(1);
}
if (!HELIUS_WSS_URL) {
  console.error("Missing HELIUS_WSS_URL");
  process.exit(1);
}
if (!HELIUS_API_KEY) {
  console.error("Missing HELIUS_API_KEY (required for Enhanced Transactions batching).");
  process.exit(1);
}

const connection = new Connection(HELIUS_RPC_URL, {
  commitment: COMMITMENT,
  wsEndpoint: HELIUS_WSS_URL,
});

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32 });

// -----------------------------
// Jito tip accounts (mainnet) & tip payment program
// Source: Jito Foundation docs
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

const JITO_TIP_SET = new Set(JITO_TIP_ACCOUNTS);

// -----------------------------
// Noise program IDs (not useful for alpha fingerprinting)
// -----------------------------
const NOISE_PROGRAMS = new Set([
  "11111111111111111111111111111111", // System
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // ATA
  "ComputeBudget111111111111111111111111111111", // compute budget
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", // memo v1
]);

// Base mints (value-proxy deltas)
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

// -----------------------------
// Output streams
// -----------------------------
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
const outStream = fs.createWriteStream(OUT_FILE, { flags: "a" });

// -----------------------------
// Helpers
// -----------------------------
function nowMs() { return Date.now(); }

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sortUnique(arr) {
  return Array.from(new Set(arr)).sort();
}

function clampInt(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function stableRaw(usdc, usdt) {
  return usdc + usdt; // both 6 decimals on mainnet
}

// -----------------------------
// Minimal HTTPS POST JSON helper (no fetch dependency)
// -----------------------------
function postJson(urlStr, payload, { timeoutMs = 15_000 } = {}) {
  const url = new URL(urlStr);
  const body = Buffer.from(JSON.stringify(payload));

  const opts = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (url.protocol === "https:" ? 443 : 80),
    path: url.pathname + url.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": body.length,
    },
    agent: httpsAgent,
  };

  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode || 0;

        if (status === 429) {
          const err = new Error("HTTP 429 rate limited");
          err.statusCode = 429;
          err.body = raw;
          return reject(err);
        }
        if (status < 200 || status >= 300) {
          const err = new Error(`HTTP ${status}`);
          err.statusCode = status;
          err.body = raw;
          return reject(err);
        }
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          const err = new Error(`Failed to parse JSON: ${(e && e.message) || e}`);
          err.body = raw;
          return reject(err);
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("HTTP request timeout"));
    });

    req.write(body);
    req.end();
  });
}

// -----------------------------
// Enhanced Transactions batch fetch with retry/backoff
// Docs: /v0/transactions parses multiple signatures; missing txs can be retried.
// -----------------------------
async function fetchEnhancedBatch(signatures) {
  const url = `https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${encodeURIComponent(HELIUS_API_KEY)}`;
  const payload = { transactions: signatures };

  let backoff = 250;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await postJson(url, payload, { timeoutMs: 20_000 });
      if (!Array.isArray(res)) return [];
      return res;
    } catch (e) {
      const code = e && e.statusCode;
      const msg = String((e && e.message) || e);

      // backoff on 429/timeout
      if (code === 429 || msg.toLowerCase().includes("timeout")) {
        await sleep(backoff);
        backoff = Math.min(10_000, backoff * 2);
        continue;
      }
      // Other errors: don't spin forever
      throw e;
    }
  }
  return [];
}

// -----------------------------
// Pending signature buffer
// -----------------------------
/**
 * pending: sig -> { seenAtMs, hintSlot, attempts, nextAttemptAtMs, source }
 */
const pending = new Map();
const pendingOrder = []; // append-only, used for scanning/eviction
let evictIdx = 0;
let scanIdx = 0;

// Counters
let ingested = 0;
let sampledOut = 0;
let evicted = 0;
let processed = 0;
let droppedMissing = 0;
let enhancedMissing = 0;
let enhancedRateLimited = 0;
let enhancedOtherErrors = 0;

function tryIngestSignature(sig, hintSlot, source) {
  if (!sig) return;
  if (pending.has(sig)) return;

  // optional sampling
  if (INGRESS_SAMPLE_PCT < 1.0) {
    if (Math.random() > INGRESS_SAMPLE_PCT) {
      sampledOut += 1;
      return;
    }
  }

  // bounded buffer
  if (pending.size >= MAX_PENDING) {
    // evict oldest live entry using evictIdx
    while (evictIdx < pendingOrder.length) {
      const old = pendingOrder[evictIdx++];
      if (pending.delete(old)) {
        evicted += 1;
        break;
      }
    }
    // periodic compaction
    if (evictIdx > 50_000 && evictIdx > pendingOrder.length / 2) {
      pendingOrder.splice(0, evictIdx);
      scanIdx = Math.max(0, scanIdx - evictIdx);
      evictIdx = 0;
    }
  }

  const t = nowMs();
  pending.set(sig, {
    seenAtMs: t,
    hintSlot: hintSlot || null,
    attempts: 0,
    nextAttemptAtMs: t + INITIAL_DELAY_MS,
    source: source || null,
  });
  pendingOrder.push(sig);
  ingested += 1;
}

function selectReadyBatch(now) {
  const out = [];
  const maxScan = clampInt(BATCH_SIZE * 50, 500, 20_000); // controls CPU

  let scanned = 0;
  while (out.length < BATCH_SIZE && scanned < maxScan && pendingOrder.length > 0) {
    if (scanIdx >= pendingOrder.length) scanIdx = 0;

    const sig = pendingOrder[scanIdx++];
    scanned += 1;

    const meta = pending.get(sig);
    if (!meta) continue;
    if (meta.nextAttemptAtMs > now) continue;

    out.push(sig);
  }
  return out;
}

// -----------------------------
// Extraction from Enhanced Tx object
// -----------------------------
function extractPrograms(enh) {
  const programs = [];
  const instr = Array.isArray(enh?.instructions) ? enh.instructions : [];
  for (const ix of instr) {
    if (ix?.programId) programs.push(String(ix.programId));
    const inner = Array.isArray(ix?.innerInstructions) ? ix.innerInstructions : [];
    for (const inIx of inner) {
      if (inIx?.programId) programs.push(String(inIx.programId));
    }
  }
  return sortUnique(programs);
}

function extractChangedMints(enh) {
  const mints = [];
  const accData = Array.isArray(enh?.accountData) ? enh.accountData : [];
  for (const ad of accData) {
    const tbc = Array.isArray(ad?.tokenBalanceChanges) ? ad.tokenBalanceChanges : [];
    for (const c of tbc) {
      if (c?.mint) mints.push(String(c.mint));
    }
  }
  // tokenTransfers also include mint
  const tts = Array.isArray(enh?.tokenTransfers) ? enh.tokenTransfers : [];
  for (const t of tts) {
    if (t?.mint) mints.push(String(t.mint));
  }
  // events.swap includes token inputs/outputs
  const swap = enh?.events?.swap;
  if (swap) {
    const addMint = (arr) => {
      for (const x of (Array.isArray(arr) ? arr : [])) {
        if (x?.mint) mints.push(String(x.mint));
      }
    };
    addMint(swap.tokenInputs);
    addMint(swap.tokenOutputs);
    addMint(swap.tokenFees);
    const innerSwaps = Array.isArray(swap.innerSwaps) ? swap.innerSwaps : [];
    for (const s of innerSwaps) {
      addMint(s.tokenInputs);
      addMint(s.tokenOutputs);
      addMint(s.tokenFees);
    }
  }

  return sortUnique(mints);
}

function extractJitoTip(enh) {
  let total = 0n;
  const breakdown = {};
  const accData = Array.isArray(enh?.accountData) ? enh.accountData : [];
  for (const ad of accData) {
    const acct = String(ad?.account || "");
    if (!JITO_TIP_SET.has(acct)) continue;
    const change = BigInt(ad?.nativeBalanceChange || 0);
    if (change > 0n) {
      breakdown[acct] = change.toString();
      total += change;
    }
  }
  return { totalLamports: total, breakdown };
}

function extractOwnerMintDeltas(enh) {
  // ownerMintDeltas: owner -> mint -> deltaRaw (BigInt as string)
  const ownerMint = new Map();
  const accData = Array.isArray(enh?.accountData) ? enh.accountData : [];
  for (const ad of accData) {
    const tbc = Array.isArray(ad?.tokenBalanceChanges) ? ad.tokenBalanceChanges : [];
    for (const c of tbc) {
      const owner = String(c?.userAccount || "");
      const mint = String(c?.mint || "");
      const raw = c?.rawTokenAmount?.tokenAmount;
      const decimals = Number(c?.rawTokenAmount?.decimals ?? 0);
      if (!owner || !mint || raw === undefined || raw === null) continue;
      let delta = 0n;
      try { delta = BigInt(String(raw)); } catch { delta = 0n; }

      let m = ownerMint.get(owner);
      if (!m) { m = new Map(); ownerMint.set(owner, m); }
      m.set(mint, (m.get(mint) || 0n) + delta);

      // stash decimals if useful later (optional; not currently stored)
      void decimals;
    }
  }

  // Convert to plain object
  const out = {};
  for (const [owner, m] of ownerMint.entries()) {
    const inner = {};
    for (const [mint, d] of m.entries()) inner[mint] = d.toString();
    out[owner] = inner;
  }
  return out;
}

function bestStableDelta(ownerMintDeltas) {
  let bestOwner = null;
  let bestUsdc = 0n;
  let bestUsdt = 0n;
  let bestStable = 0n;

  for (const [owner, mints] of Object.entries(ownerMintDeltas)) {
    const usdc = BigInt(mints[USDC_MINT] || "0");
    const usdt = BigInt(mints[USDT_MINT] || "0");
    const s = stableRaw(usdc, usdt);
    if (s > bestStable) {
      bestStable = s;
      bestOwner = owner;
      bestUsdc = usdc;
      bestUsdt = usdt;
    }
  }

  return { bestOwner, bestUsdc, bestUsdt, bestStable };
}

// -----------------------------
// Aggregation for "alpha surface map"
// -----------------------------
const fpStats = new Map();
const programStats = new Map();

function bumpProgram(pid, delta) {
  const s = programStats.get(pid) || {
    programId: pid,
    count: 0,
    totalFeeLamports: 0n,
    totalJitoTipLamports: 0n,
    totalStableRaw: 0n,
    maxStableRaw: 0n,
  };
  s.count += 1;
  s.totalFeeLamports += delta.fee;
  s.totalJitoTipLamports += delta.tip;
  s.totalStableRaw += delta.stable;
  if (delta.stable > s.maxStableRaw) s.maxStableRaw = delta.stable;
  programStats.set(pid, s);
}

function bumpFingerprint(fp, feePayer, delta, examples) {
  const t = nowMs();
  const s = fpStats.get(fp) || {
    fingerprint: fp,
    firstSeenMs: t,
    lastSeenMs: t,
    count: 0,
    uniqueFeePayers: new Set(),
    totalFeeLamports: 0n,
    totalJitoTipLamports: 0n,
    totalStableRaw: 0n,
    maxStableRaw: 0n,
    exampleSignatures: [],
    examplePrograms: [],
    exampleMints: [],
    exampleTypeSource: examples.typeSource || null,
  };
  s.lastSeenMs = t;
  s.count += 1;
  s.uniqueFeePayers.add(feePayer);
  s.totalFeeLamports += delta.fee;
  s.totalJitoTipLamports += delta.tip;
  s.totalStableRaw += delta.stable;
  if (delta.stable > s.maxStableRaw) s.maxStableRaw = delta.stable;

  if (s.exampleSignatures.length < 5) s.exampleSignatures.push(examples.sig);
  if (s.examplePrograms.length === 0) s.examplePrograms = examples.programs.slice(0, 16);
  if (s.exampleMints.length === 0) s.exampleMints = examples.mints.slice(0, 16);

  fpStats.set(fp, s);
}

function writeSummary() {
  const fps = Array.from(fpStats.values()).map((s) => ({
    fingerprint: s.fingerprint,
    firstSeen: new Date(s.firstSeenMs).toISOString(),
    lastSeen: new Date(s.lastSeenMs).toISOString(),
    count: s.count,
    uniqueFeePayers: s.uniqueFeePayers.size,
    totalFeeLamports: s.totalFeeLamports.toString(),
    totalJitoTipLamports: s.totalJitoTipLamports.toString(),
    totalStableRaw: s.totalStableRaw.toString(),
    maxStableRaw: s.maxStableRaw.toString(),
    exampleTypeSource: s.exampleTypeSource,
    exampleSignatures: s.exampleSignatures,
    examplePrograms: s.examplePrograms,
    exampleMints: s.exampleMints,
  }));

  fps.sort((a, b) => {
    const A = BigInt(a.maxStableRaw);
    const B = BigInt(b.maxStableRaw);
    if (A === B) return b.count - a.count;
    return B > A ? 1 : -1;
  });

  const progs = Array.from(programStats.values()).map((p) => ({
    programId: p.programId,
    count: p.count,
    totalFeeLamports: p.totalFeeLamports.toString(),
    totalJitoTipLamports: p.totalJitoTipLamports.toString(),
    totalStableRaw: p.totalStableRaw.toString(),
    maxStableRaw: p.maxStableRaw.toString(),
  }));

  progs.sort((a, b) => {
    const A = BigInt(a.totalStableRaw);
    const B = BigInt(b.totalStableRaw);
    if (A === B) return b.count - a.count;
    return B > A ? 1 : -1;
  });

  const summary = {
    schema: "alpha_mev_surface_summary_v2",
    generatedAt: new Date().toISOString(),
    config: {
      commitment: COMMITMENT,
      runSeconds: RUN_SECONDS,
      batchSize: BATCH_SIZE,
      batchIntervalMs: BATCH_INTERVAL_MS,
      initialDelayMs: INITIAL_DELAY_MS,
      maxMissingRetries: MAX_MISSING_RETRIES,
      maxPending: MAX_PENDING,
      ingressSamplePct: INGRESS_SAMPLE_PCT,
      storeEnhanced: STORE_ENHANCED,
      outFile: OUT_FILE,
    },
    counters: {
      ingested,
      sampledOut,
      evicted,
      processed,
      droppedMissing,
      enhancedMissing,
      enhancedRateLimited,
      enhancedOtherErrors,
      pending: pending.size,
    },
    topFingerprintsByMaxStable: fps.slice(0, 50),
    topProgramsByTotalStable: progs.slice(0, 50),
  };

  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));
}

// -----------------------------
// Main processing loop (batcher)
// -----------------------------
let inFlight = false;

async function batcherTick(stopAtMs) {
  if (inFlight) return;
  if (pending.size === 0) return;

  const now = nowMs();
  if (now >= stopAtMs) return;

  const sigs = selectReadyBatch(now);
  if (sigs.length === 0) return;

  inFlight = true;

  try {
    const enhanced = await fetchEnhancedBatch(sigs);

    // Map response by signature
    const bySig = new Map();
    for (const tx of enhanced) {
      if (tx?.signature) bySig.set(String(tx.signature), tx);
    }

    // For each requested sig:
    for (const sig of sigs) {
      const meta = pending.get(sig);
      if (!meta) continue;

      const enh = bySig.get(sig);
      if (!enh) {
        // Missing from enhanced response; retry with backoff
        enhancedMissing += 1;

        meta.attempts += 1;
        if (meta.attempts > MAX_MISSING_RETRIES) {
          pending.delete(sig);
          droppedMissing += 1;
          continue;
        }
        // exponential-ish retry scheduling
        const backoff = Math.min(20_000, 500 * Math.pow(2, meta.attempts));
        meta.nextAttemptAtMs = nowMs() + backoff;
        pending.set(sig, meta);
        continue;
      }

      // Process & emit record
      const feeLamports = BigInt(enh?.fee || 0);
      const feePayer = String(enh?.feePayer || "");
      const slot = Number(enh?.slot ?? meta.hintSlot ?? -1);
      const timestamp = enh?.timestamp ?? null;

      const tip = extractJitoTip(enh);
      const programsAll = extractPrograms(enh);
      const programsInteresting = programsAll.filter((p) => !NOISE_PROGRAMS.has(p));
      const changedMints = extractChangedMints(enh);

      const ownerMintDeltas = extractOwnerMintDeltas(enh);
      const best = bestStableDelta(ownerMintDeltas);

      const type = String(enh?.type || "");
      const source = String(enh?.source || "");
      const typeSource = `${type}:${source}`;

      const fpPayload = JSON.stringify({
        type,
        source,
        programs: programsInteresting.slice(0, 32),
        mints: changedMints.slice(0, 32),
      });
      const fingerprint = sha256Hex(fpPayload);

      // Update aggregates only if there's evidence of value or tip
      const stable = best.bestStable;
      if (stable > 0n || tip.totalLamports > 0n) {
        bumpFingerprint(
          fingerprint,
          feePayer,
          { fee: feeLamports, tip: tip.totalLamports, stable },
          { sig, programs: programsInteresting, mints: changedMints, typeSource }
        );
        for (const pid of programsInteresting) {
          bumpProgram(pid, { fee: feeLamports, tip: tip.totalLamports, stable });
        }
      }

      const record = {
        schema: "alpha_mev_surface_v2",
        signature: sig,
        slot,
        timestamp, // unix seconds (block time) per Helius
        observedAtMs: meta.seenAtMs,
        source: meta.source,

        // Enhanced tx metadata
        type,
        sourceCategory: source,
        description: enh?.description ?? null,
        feeLamports: feeLamports.toString(),
        feePayer,

        // Jito tip inferred from accountData nativeBalanceChange on tip accounts
        jitoTipLamports: tip.totalLamports.toString(),
        jitoTipBreakdown: tip.breakdown,

        // Alpha surface fingerprinting
        programIdsInteresting: programsInteresting,
        changedMints,
        fingerprint,

        // Value proxies
        ownerMintDeltas,
        bestStableOwner: best.bestOwner,
        bestUsdcDeltaRaw: best.bestUsdc.toString(),
        bestUsdtDeltaRaw: best.bestUsdt.toString(),
        bestStableDeltaRaw: best.bestStable.toString(),

        // convenience: fee payer deltas for base mints if present
        feePayerWsolDeltaRaw: (ownerMintDeltas[feePayer]?.[WSOL_MINT] ?? "0"),
        feePayerUsdcDeltaRaw: (ownerMintDeltas[feePayer]?.[USDC_MINT] ?? "0"),
        feePayerUsdtDeltaRaw: (ownerMintDeltas[feePayer]?.[USDT_MINT] ?? "0"),

        // Optional raw enhanced payload (can be large)
        ...(STORE_ENHANCED ? { enhanced: enh } : {}),
      };

      outStream.write(JSON.stringify(record) + "\n");
      processed += 1;

      // Remove from pending
      pending.delete(sig);
    }
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (String(e && e.statusCode) === "429" || msg.includes("429")) {
      enhancedRateLimited += 1;
    } else {
      enhancedOtherErrors += 1;
      console.warn(`[enhanced] error: ${msg}`);
    }

    // On failure, reschedule all selected sigs with a small delay
    const delay = 1000;
    const t = nowMs() + delay;
    for (const sig of sigs) {
      const meta = pending.get(sig);
      if (!meta) continue;
      meta.nextAttemptAtMs = Math.max(meta.nextAttemptAtMs, t);
      pending.set(sig, meta);
    }
  } finally {
    inFlight = false;
  }
}

// -----------------------------
// WebSocket subscriptions
// -----------------------------
async function startSubscriptions() {
  const subs = [];

  for (const tip of JITO_TIP_ACCOUNTS) {
    const id = connection.onLogs(
      new PublicKey(tip),
      (logInfo, ctx) => {
        const sig = logInfo?.signature;
        if (!sig) return;
        tryIngestSignature(sig, ctx?.slot, `jito_tip_account:${tip}`);
      },
      COMMITMENT
    );
    subs.push(id);
  }

  // Tip payment program (captures some bundled variants)
  const idProg = connection.onLogs(
    new PublicKey(JITO_TIP_PAYMENT_PROGRAM),
    (logInfo, ctx) => {
      const sig = logInfo?.signature;
      if (!sig) return;
      tryIngestSignature(sig, ctx?.slot, `jito_tip_program:${JITO_TIP_PAYMENT_PROGRAM}`);
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
  console.log(`[alpha_mev_edge_research_v2] Starting...`);
  console.log(`  RPC: ${HELIUS_RPC_URL}`);
  console.log(`  WSS: ${HELIUS_WSS_URL}`);
  console.log(`  commitment=${COMMITMENT} runSeconds=${RUN_SECONDS}`);
  console.log(`  batchSize=${BATCH_SIZE} batchIntervalMs=${BATCH_INTERVAL_MS} initialDelayMs=${INITIAL_DELAY_MS}`);
  console.log(`  maxPending=${MAX_PENDING} ingressSamplePct=${INGRESS_SAMPLE_PCT}`);
  console.log(`  out=${OUT_FILE}`);
  console.log(`  summary=${SUMMARY_FILE} every=${SUMMARY_EVERY_SECONDS}s`);
  console.log(`  storeEnhanced=${STORE_ENHANCED}`);

  const stopAtMs = nowMs() + RUN_SECONDS * 1000;

  const subs = await startSubscriptions();
  console.log(`[subscriptions] active=${subs.length} (tipAccounts=${JITO_TIP_ACCOUNTS.length} + tipProgram=1)`);

  // Summary interval
  const summaryInterval = setInterval(() => {
    try {
      writeSummary();
      console.log(
        `[summary] ingested=${ingested} processed=${processed} pending=${pending.size} evicted=${evicted} missingRetry=${enhancedMissing} droppedMissing=${droppedMissing} rateLimited=${enhancedRateLimited}`
      );
    } catch (e) {
      console.warn(`[summary] failed: ${String((e && e.message) || e)}`);
    }
  }, SUMMARY_EVERY_SECONDS * 1000);

  // Batcher interval
  const batchInterval = setInterval(() => {
    batcherTick(stopAtMs).catch((e) => console.warn(`[batcher] ${String((e && e.message) || e)}`));
  }, BATCH_INTERVAL_MS);

  const stop = async () => {
    clearInterval(summaryInterval);
    clearInterval(batchInterval);

    try { writeSummary(); } catch {}

    for (const id of subs) {
      try { await connection.removeOnLogsListener(id); } catch {}
    }
    outStream.end();
  };

  process.on("SIGINT", async () => {
    console.log(`\n[signal] SIGINT received, shutting down...`);
    await stop();
    process.exit(0);
  });

  // run until stopAtMs
  while (nowMs() < stopAtMs) {
    await sleep(250);
  }

  await stop();

  console.log(`[alpha_mev_edge_research_v2] Done.`);
  console.log(`  JSONL: ${OUT_FILE}`);
  console.log(`  Summary: ${SUMMARY_FILE}`);
}

main().catch((e) => {
  console.error(`[fatal] ${String((e && e.message) || e)}`);
  process.exit(1);
});
