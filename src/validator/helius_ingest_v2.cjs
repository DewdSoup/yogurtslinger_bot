#!/usr/bin/env node
// helius_alpha_ingest_v2.cjs
//
// Enhanced version with:
// - Status filter (succeeded only) to reduce noise
// - Better defaults for longer captures (24-48h)
// - Progress estimation
// - Resume capability via append mode
//
// Usage:
//   HELIUS_API_KEY=xxxxx node helius_alpha_ingest_v2.cjs \
//       --hours 24 \
//       --max-tx 50000 \
//       --out ./helius_alpha_24h.ndjson
//
// For multi-day capture:
//   HELIUS_API_KEY=xxxxx node helius_alpha_ingest_v2.cjs \
//       --hours 48 \
//       --max-tx 100000 \
//       --out ./helius_alpha_48h.ndjson

const fs = require("fs");
const path = require("path");

if (typeof fetch !== "function") {
    console.error("This script requires Node 18+ (global fetch).");
    process.exit(1);
}

function getArg(flag, defaultValue = undefined) {
    const idx = process.argv.indexOf(flag);
    if (idx === -1) return defaultValue;
    const v = process.argv[idx + 1];
    return v === undefined ? defaultValue : v;
}

function parseNum(s, name) {
    const n = Number(s);
    if (!Number.isFinite(n)) {
        throw new Error(`Invalid numeric value for ${name}: ${s}`);
    }
    return n;
}

const apiKey = process.env.HELIUS_API_KEY || getArg("--api-key");
if (!apiKey) {
    console.error("Missing HELIUS_API_KEY env or --api-key flag");
    process.exit(1);
}

const rpcUrl = process.env.HELIUS_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

// Focus on native DEXes only (not Jupiter aggregator)
const defaultAddresses = [
    // Native venues where cross-venue arb is meaningful
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",  // PumpSwap
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",  // Raydium V4
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",  // Raydium CLMM
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",  // Meteora DLMM
];

// Parse arguments
const addressesArg = getArg("--addresses");
const targetAddresses = addressesArg
    ? addressesArg.split(",").map((x) => x.trim()).filter(Boolean)
    : defaultAddresses;

const outPath = getArg("--out", "./helius_alpha_validated.ndjson");
const hoursBack = parseNum(getArg("--hours", "24"), "--hours");
const maxTxPerAddress = parseNum(getArg("--max-tx", "50000"), "--max-tx");
const pageLimit = parseNum(getArg("--page-limit", "100"), "--page-limit");
const includeJupiter = getArg("--include-jupiter") !== undefined;
const appendMode = getArg("--append") !== undefined;

// Add Jupiter if requested
if (includeJupiter) {
    targetAddresses.push("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
}

const nowSec = Math.floor(Date.now() / 1000);
const fromSec = nowSec - Math.floor(hoursBack * 3600);
const toSec = nowSec;

console.error("=".repeat(60));
console.error("Helius Alpha Ingest v2 - Enhanced for Validation");
console.error("=".repeat(60));
console.error(`RPC URL: ${rpcUrl.replace(apiKey, "***")}`);
console.error(`Output: ${path.resolve(outPath)}`);
console.error(`Mode: ${appendMode ? "APPEND" : "OVERWRITE"}`);
console.error(`Time window: last ${hoursBack}h`);
console.error(`  From: ${new Date(fromSec * 1000).toISOString()}`);
console.error(`  To:   ${new Date(toSec * 1000).toISOString()}`);
console.error(`Per-address max: ${maxTxPerAddress}`);
console.error(`Filter: succeeded transactions only`);
console.error();
console.error("Target addresses:");
for (const a of targetAddresses) {
    const name = {
        "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA": "PumpSwap",
        "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium_V4",
        "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK": "Raydium_CLMM",
        "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo": "Meteora_DLMM",
        "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4": "Jupiter_V4",
    }[a] || "Custom";
    console.error(`  - ${name}: ${a}`);
}
console.error("=".repeat(60));

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function rpcGetTransactionsForAddress(address, paginationToken) {
    const body = {
        jsonrpc: "2.0",
        id: "alpha-ingest-v2",
        method: "getTransactionsForAddress",
        params: [
            address,
            {
                transactionDetails: "full",
                sortOrder: "asc",
                limit: pageLimit,
                filters: {
                    blockTime: {
                        gte: fromSec,
                        lte: toSec,
                    },
                    // KEY CHANGE: Only succeeded transactions
                    status: "succeeded",
                },
                ...(paginationToken ? { paginationToken } : {}),
            },
        ],
    };

    let retries = 0;
    const maxRetries = 5;

    while (true) {
        try {
            const res = await fetch(rpcUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });

            if (res.status === 429) {
                const retryAfter = Number(res.headers.get("retry-after")) || 2;
                console.error(`  [429] Rate limited, sleeping ${retryAfter}s...`);
                await sleep(retryAfter * 1000);
                continue;
            }

            if (!res.ok) {
                const text = await res.text().catch(() => "");
                throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
            }

            const json = await res.json();
            if (json.error) {
                throw new Error(`RPC error ${json.error.code}: ${json.error.message || ""}`);
            }

            return json.result;
        } catch (err) {
            retries++;
            if (retries >= maxRetries) {
                throw err;
            }
            console.error(`  [Retry ${retries}/${maxRetries}] ${err.message}`);
            await sleep(1000 * retries);
        }
    }
}

async function ingestForAddress(address, addressName) {
    console.error();
    console.error(`>>> Ingesting ${addressName} (${address})`);

    let paginationToken = undefined;
    let totalFetched = 0;
    let page = 0;
    const startTime = Date.now();

    while (true) {
        if (totalFetched >= maxTxPerAddress) {
            console.error(`    Reached max-tx limit (${maxTxPerAddress})`);
            break;
        }

        const pageStart = Date.now();
        console.error(`    Page ${page}... `, { end: "" });

        const result = await rpcGetTransactionsForAddress(address, paginationToken);
        const txs = result.data || [];

        if (!Array.isArray(txs) || txs.length === 0) {
            console.error(`no more data`);
            break;
        }

        let written = 0;
        for (const tx of txs) {
            if (totalFetched >= maxTxPerAddress) break;

            const record = {
                program: address,
                venue: addressName,
                signature: tx.signature,
                slot: tx.slot,
                blockTime: tx.blockTime ?? null,
                tx,
            };

            fs.appendFileSync(outPath, JSON.stringify(record) + "\n");
            totalFetched++;
            written++;
        }

        const elapsed = ((Date.now() - pageStart) / 1000).toFixed(1);
        console.error(`${written} txs (${elapsed}s) | Total: ${totalFetched}`);

        paginationToken = result.paginationToken || null;
        page++;

        if (!paginationToken) {
            console.error(`    No more pages`);
            break;
        }

        // Delay between pages
        await sleep(150);
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`    Done: ${totalFetched} transactions in ${totalTime}s`);

    return totalFetched;
}

(async () => {
    try {
        // Initialize output file
        if (!appendMode) {
            fs.writeFileSync(outPath, "");
            console.error("Output file initialized (overwrite mode)");
        } else {
            fs.writeFileSync(outPath, "", { flag: "a" });
            console.error("Output file opened (append mode)");
        }

        const addressNames = {
            "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA": "PumpSwap",
            "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium_V4",
            "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK": "Raydium_CLMM",
            "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo": "Meteora_DLMM",
            "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4": "Jupiter_V4",
        };

        let grandTotal = 0;
        const startTime = Date.now();

        for (const addr of targetAddresses) {
            const name = addressNames[addr] || "Custom";
            const count = await ingestForAddress(addr, name);
            grandTotal += count;
        }

        const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

        console.error();
        console.error("=".repeat(60));
        console.error("INGEST COMPLETE");
        console.error(`Total transactions: ${grandTotal}`);
        console.error(`Total time: ${totalTime} minutes`);
        console.error(`Output: ${path.resolve(outPath)}`);
        console.error();
        console.error("Next steps:");
        console.error("  python3 validate_cross_venue.py " + outPath);
        console.error("=".repeat(60));

    } catch (err) {
        console.error("Fatal error:", err);
        process.exit(1);
    }
})();
