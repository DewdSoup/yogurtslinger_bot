#!/usr/bin/env node
/**
 * helius_comprehensive_ingest.cjs
 * 
 * DUAL-MODE INGEST:
 * 1. Enhanced REST API (/v0/addresses/{addr}/transactions?type=SWAP)
 *    - Returns PARSED data: tokenTransfers, source, type, description
 *    - Easier to analyze, pre-filtered for swaps
 * 
 * 2. Raw RPC (getTransactionsForAddress)
 *    - Returns FULL transaction data including account states
 *    - Better for balance delta verification
 * 
 * Output: Two JSON files for cross-validation
 * 
 * Usage:
 *   HELIUS_API_KEY=xxx node helius_comprehensive_ingest.cjs \
 *       --hours 12 \
 *       --out-prefix ./alpha_12h
 * 
 * Outputs:
 *   ./alpha_12h_enhanced.json  - Parsed swap data from Enhanced API
 *   ./alpha_12h_raw.ndjson     - Raw transaction data for verification
 */

const fs = require("fs");
const path = require("path");

// ============================================================================
// CONFIG
// ============================================================================

const apiKey = process.env.HELIUS_API_KEY || getArg("--api-key");
if (!apiKey) {
    console.error("Missing HELIUS_API_KEY");
    process.exit(1);
}

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
const REST_URL = `https://api-mainnet.helius-rpc.com`;

// Target DEX programs (native venues only - no aggregators)
const TARGETS = {
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA": "PumpSwap",
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium_V4",
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK": "Raydium_CLMM",
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo": "Meteora_DLMM",
};

// ============================================================================
// HELPERS
// ============================================================================

function getArg(flag, defaultValue = undefined) {
    const idx = process.argv.indexOf(flag);
    if (idx === -1) return defaultValue;
    return process.argv[idx + 1] ?? defaultValue;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function log(...args) {
    const ts = new Date().toISOString().slice(11, 19);
    console.error(`[${ts}]`, ...args);
}

// ============================================================================
// ENHANCED REST API - Returns PARSED swap data
// ============================================================================

async function fetchEnhancedTransactions(address, beforeSig = null, limit = 100) {
    let url = `${REST_URL}/v0/addresses/${address}/transactions?api-key=${apiKey}&limit=${limit}`;

    // Filter for swaps only
    url += `&type=SWAP`;

    if (beforeSig) {
        url += `&before=${beforeSig}`;
    }

    let retries = 0;
    while (retries < 5) {
        try {
            const res = await fetch(url);

            if (res.status === 429) {
                const delay = (retries + 1) * 2000;
                log(`[Enhanced] 429 rate limit, waiting ${delay}ms...`);
                await sleep(delay);
                retries++;
                continue;
            }

            if (!res.ok) {
                const text = await res.text().catch(() => "");
                throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
            }

            return await res.json();
        } catch (err) {
            retries++;
            if (retries >= 5) throw err;
            log(`[Enhanced] Retry ${retries}: ${err.message}`);
            await sleep(1000 * retries);
        }
    }
}

async function ingestEnhanced(address, venueName, maxTx, fromTime, toTime) {
    log(`[Enhanced] Starting ${venueName}...`);

    const results = [];
    let beforeSig = null;
    let totalFetched = 0;
    let page = 0;

    while (totalFetched < maxTx) {
        const batch = await fetchEnhancedTransactions(address, beforeSig, 100);

        if (!Array.isArray(batch) || batch.length === 0) {
            log(`[Enhanced] ${venueName}: No more data after ${totalFetched} txs`);
            break;
        }

        // Filter by time window
        let inWindow = 0;
        let tooOld = false;

        for (const tx of batch) {
            const ts = tx.timestamp || 0;

            if (ts < fromTime) {
                tooOld = true;
                break;
            }

            if (ts >= fromTime && ts <= toTime) {
                results.push({
                    venue: venueName,
                    program: address,
                    signature: tx.signature,
                    slot: tx.slot,
                    timestamp: ts,
                    type: tx.type,
                    source: tx.source,
                    description: tx.description,
                    fee: tx.fee,
                    feePayer: tx.feePayer,
                    nativeTransfers: tx.nativeTransfers || [],
                    tokenTransfers: tx.tokenTransfers || [],
                    accountData: tx.accountData || [],
                    events: tx.events || {},
                    instructions: tx.instructions || [],
                });
                inWindow++;
                totalFetched++;
            }
        }

        log(`[Enhanced] ${venueName} page ${page}: ${inWindow} in window, ${totalFetched} total`);

        if (tooOld) {
            log(`[Enhanced] ${venueName}: Reached time boundary`);
            break;
        }

        beforeSig = batch[batch.length - 1]?.signature;
        if (!beforeSig) break;

        page++;
        await sleep(200); // Rate limit protection
    }

    log(`[Enhanced] ${venueName}: Done - ${results.length} swaps captured`);
    return results;
}

// ============================================================================
// RAW RPC API - Returns FULL transaction data
// ============================================================================

async function fetchRawTransactions(address, paginationToken, fromTime, toTime, limit = 100) {
    const body = {
        jsonrpc: "2.0",
        id: "raw-ingest",
        method: "getTransactionsForAddress",
        params: [
            address,
            {
                transactionDetails: "full",
                sortOrder: "desc",  // Newest first for time-bounded queries
                limit: limit,
                filters: {
                    blockTime: {
                        gte: fromTime,
                        lte: toTime,
                    },
                    status: "succeeded",
                },
                ...(paginationToken ? { paginationToken } : {}),
            },
        ],
    };

    let retries = 0;
    while (retries < 5) {
        try {
            const res = await fetch(RPC_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });

            if (res.status === 429) {
                const delay = (retries + 1) * 2000;
                log(`[Raw] 429 rate limit, waiting ${delay}ms...`);
                await sleep(delay);
                retries++;
                continue;
            }

            if (!res.ok) {
                const text = await res.text().catch(() => "");
                throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
            }

            const json = await res.json();
            if (json.error) {
                throw new Error(`RPC error: ${json.error.message}`);
            }

            return json.result;
        } catch (err) {
            retries++;
            if (retries >= 5) throw err;
            log(`[Raw] Retry ${retries}: ${err.message}`);
            await sleep(1000 * retries);
        }
    }
}

async function ingestRaw(address, venueName, maxTx, fromTime, toTime, outStream) {
    log(`[Raw] Starting ${venueName}...`);

    let paginationToken = null;
    let totalFetched = 0;
    let page = 0;

    while (totalFetched < maxTx) {
        const result = await fetchRawTransactions(address, paginationToken, fromTime, toTime, 100);
        const txs = result?.data || [];

        if (!Array.isArray(txs) || txs.length === 0) {
            log(`[Raw] ${venueName}: No more data after ${totalFetched} txs`);
            break;
        }

        for (const tx of txs) {
            if (totalFetched >= maxTx) break;

            const record = {
                venue: venueName,
                program: address,
                signature: tx.signature,
                slot: tx.slot,
                blockTime: tx.blockTime,
                // Include full transaction for detailed analysis
                tx: tx,
            };

            outStream.write(JSON.stringify(record) + "\n");
            totalFetched++;
        }

        log(`[Raw] ${venueName} page ${page}: ${txs.length} fetched, ${totalFetched} total`);

        paginationToken = result.paginationToken;
        if (!paginationToken) break;

        page++;
        await sleep(200);
    }

    log(`[Raw] ${venueName}: Done - ${totalFetched} txs captured`);
    return totalFetched;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    const hoursBack = parseFloat(getArg("--hours", "12"));
    const maxTxPerVenue = parseInt(getArg("--max-tx", "100000"), 10);
    const outPrefix = getArg("--out-prefix", "./alpha_capture");
    const skipRaw = getArg("--skip-raw") !== undefined;
    const skipEnhanced = getArg("--skip-enhanced") !== undefined;

    const nowSec = Math.floor(Date.now() / 1000);
    const fromSec = nowSec - Math.floor(hoursBack * 3600);
    const toSec = nowSec;

    const enhancedOutPath = `${outPrefix}_enhanced.json`;
    const rawOutPath = `${outPrefix}_raw.ndjson`;

    log("=".repeat(70));
    log("HELIUS COMPREHENSIVE INGEST");
    log("=".repeat(70));
    log(`Time window: ${hoursBack} hours`);
    log(`  From: ${new Date(fromSec * 1000).toISOString()}`);
    log(`  To:   ${new Date(toSec * 1000).toISOString()}`);
    log(`Max per venue: ${maxTxPerVenue}`);
    log(`Enhanced output: ${enhancedOutPath}`);
    log(`Raw output: ${rawOutPath}`);
    log(`Skip raw: ${skipRaw}, Skip enhanced: ${skipEnhanced}`);
    log("=".repeat(70));
    log("Targets:");
    for (const [addr, name] of Object.entries(TARGETS)) {
        log(`  ${name}: ${addr}`);
    }
    log("=".repeat(70));

    const startTime = Date.now();

    // ========================================================================
    // PHASE 1: Enhanced API (parsed swaps)
    // ========================================================================
    let enhancedData = {
        meta: {
            captureStart: new Date().toISOString(),
            hoursBack,
            fromTimestamp: fromSec,
            toTimestamp: toSec,
            venues: Object.values(TARGETS),
        },
        swaps: [],
    };

    if (!skipEnhanced) {
        log("\n>>> PHASE 1: Enhanced REST API (parsed swaps)");

        for (const [address, venueName] of Object.entries(TARGETS)) {
            try {
                const swaps = await ingestEnhanced(address, venueName, maxTxPerVenue, fromSec, toSec);
                enhancedData.swaps.push(...swaps);
            } catch (err) {
                log(`[Enhanced] ERROR on ${venueName}: ${err.message}`);
            }
        }

        enhancedData.meta.captureEnd = new Date().toISOString();
        enhancedData.meta.totalSwaps = enhancedData.swaps.length;

        // Sort by slot for analysis
        enhancedData.swaps.sort((a, b) => a.slot - b.slot);

        // Write enhanced output
        fs.writeFileSync(enhancedOutPath, JSON.stringify(enhancedData, null, 2));
        log(`\n[Enhanced] Wrote ${enhancedData.swaps.length} swaps to ${enhancedOutPath}`);
    }

    // ========================================================================
    // PHASE 2: Raw RPC API (full transaction data)
    // ========================================================================
    let rawTotal = 0;

    if (!skipRaw) {
        log("\n>>> PHASE 2: Raw RPC API (full transactions)");

        const rawStream = fs.createWriteStream(rawOutPath, { flags: "w" });

        for (const [address, venueName] of Object.entries(TARGETS)) {
            try {
                const count = await ingestRaw(address, venueName, maxTxPerVenue, fromSec, toSec, rawStream);
                rawTotal += count;
            } catch (err) {
                log(`[Raw] ERROR on ${venueName}: ${err.message}`);
            }
        }

        rawStream.end();
        log(`\n[Raw] Wrote ${rawTotal} transactions to ${rawOutPath}`);
    }

    // ========================================================================
    // SUMMARY
    // ========================================================================
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

    log("\n" + "=".repeat(70));
    log("CAPTURE COMPLETE");
    log("=".repeat(70));
    log(`Elapsed: ${elapsed} minutes`);
    log(`Enhanced swaps: ${enhancedData.swaps.length}`);
    log(`Raw transactions: ${rawTotal}`);
    log();
    log("Output files:");
    log(`  ${path.resolve(enhancedOutPath)} (${(fs.statSync(enhancedOutPath).size / 1024 / 1024).toFixed(1)} MB)`);
    if (!skipRaw) {
        log(`  ${path.resolve(rawOutPath)} (${(fs.statSync(rawOutPath).size / 1024 / 1024).toFixed(1)} MB)`);
    }
    log();
    log("Next steps:");
    log(`  python3 analyze_enhanced.py ${enhancedOutPath}`);
    log("=".repeat(70));
}

main().catch(err => {
    log("FATAL:", err);
    process.exit(1);
});
