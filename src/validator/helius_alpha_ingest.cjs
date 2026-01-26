#!/usr/bin/env node
// helius_alpha_ingest.cjs
//
// Pull enriched transactions for key MEV/ARB venues via Helius getTransactionsForAddress
// and write them as NDJSON for offline analysis.
//
// Focus:
//   - PumpSwap
//   - Raydium V4
//   - Raydium CLMM
//   - Meteora DLMM
//   - Jupiter v4
//
// Usage:
//   HELIUS_API_KEY=xxxxx node helius_alpha_ingest.cjs \
//       --hours 24 \
//       --max-tx 10000 \
//       --out ./helius_alpha_swaps.ndjson
//
// You can override addresses with --addresses=addr1,addr2,... if you want.

const fs = require("fs");
const path = require("path");

if (typeof fetch !== "function") {
    console.error(
        "This script requires Node 18+ (global fetch). If you're on older Node, install node-fetch and wire it in."
    );
    process.exit(1);
}

function getArg(flag, defaultValue = undefined) {
    const idx = process.argv.indexOf(flag);
    if (idx === -1) return defaultValue;
    const v = process.argv[idx + 1];
    return v === undefined ? defaultValue : v;
}

function parseIntStrict(s, name) {
    const n = Number(s);
    if (!Number.isFinite(n)) {
        throw new Error(`Invalid numeric value for ${name}: ${s}`);
    }
    return n;
}

const apiKey = process.env.HELIUS_API_KEY || getArg("--api-key");
if (!apiKey) {
    console.error(
        "Missing Helius API key. Set HELIUS_API_KEY env or pass --api-key <key>."
    );
    process.exit(1);
}

// Use the RPC endpoint you already have
const rpcUrl =
    process.env.HELIUS_RPC_URL ||
    `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

const defaultAddresses = [
    // PumpSwap
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    // Raydium V4
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    // Raydium CLMM
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    // Meteora DLMM
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    // Jupiter v4
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
];

const addressesArg = getArg("--addresses");
const targetAddresses = addressesArg
    ? addressesArg.split(",").map((x) => x.trim()).filter(Boolean)
    : defaultAddresses;

const outPath = getArg("--out", "./helius_alpha_swaps.ndjson");
const hoursBack = parseIntStrict(getArg("--hours", "24"), "--hours");
const maxTxPerAddress = parseIntStrict(
    getArg("--max-tx", "10000"),
    "--max-tx"
);
const pageLimit = parseIntStrict(getArg("--page-limit", "100"), "--page-limit");

const nowSec = Math.floor(Date.now() / 1000);
const fromSec = nowSec - Math.floor(hoursBack * 3600);
const toSec = nowSec;

console.error("Helius alpha ingest");
console.error(`RPC URL: ${rpcUrl}`);
console.error(`Output NDJSON: ${path.resolve(outPath)}`);
console.error(`Addresses:`);
for (const a of targetAddresses) console.error(`  - ${a}`);
console.error(`Window: last ${hoursBack}h (blockTime >= ${fromSec}, <= ${toSec})`);
console.error(`Per-address max tx: ${maxTxPerAddress}`);
console.error(`Per-page limit: ${pageLimit}`);
console.error("---------------------------------------------------");

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpcGetTransactionsForAddress(address, paginationToken) {
    // Helius getTransactionsForAddress uses object-style filters, not array
    // See: https://www.helius.dev/docs/rpc/gettransactionsforaddress
    const body = {
        jsonrpc: "2.0",
        id: "alpha-ingest",
        method: "getTransactionsForAddress",
        params: [
            address,
            {
                // "full" returns complete tx data; "signatures" returns only sigs (up to 1000)
                transactionDetails: "full",

                // "asc" = oldest first (chronological), "desc" = newest first
                sortOrder: "asc",

                // Max 100 for full details, max 1000 for signatures-only
                limit: pageLimit,

                // Object-style filters (NOT array)
                filters: {
                    blockTime: {
                        gte: fromSec,
                        lte: toSec,
                    },
                    // Optional: filter by status
                    // status: "succeeded"
                },

                // Pagination token from previous response (format: "slot:position")
                ...(paginationToken ? { paginationToken } : {}),
            },
        ],
    };

    while (true) {
        const res = await fetch(rpcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });

        if (res.status === 429) {
            const retryAfter = Number(res.headers.get("retry-after")) || 1;
            const delayMs = retryAfter * 1000;
            console.error(
                `[rate-limit] 429 from Helius, sleeping ${delayMs} ms then retrying...`
            );
            await sleep(delayMs);
            continue;
        }

        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(
                `HTTP ${res.status} from Helius RPC: ${text.slice(0, 500)}`
            );
        }

        const json = await res.json();
        if (json.error) {
            throw new Error(
                `RPC error ${json.error.code}: ${json.error.message || ""}`
            );
        }

        // Result shape: { data: [...], paginationToken?: string }
        return json.result;
    }
}

async function ingestForAddress(address) {
    console.error(`\n=== Ingest for address ${address} ===`);
    let paginationToken = undefined;
    let totalFetched = 0;
    let page = 0;

    while (true) {
        if (totalFetched >= maxTxPerAddress) {
            console.error(
                `[${address}] reached max-tx limit (${maxTxPerAddress}), stopping.`
            );
            break;
        }

        console.error(
            `[${address}] fetching page ${page} (paginationToken=${paginationToken || "none"})`
        );

        const result = await rpcGetTransactionsForAddress(address, paginationToken);

        // Response uses "data" array, not "transactions"
        const txs = result.data || [];
        if (!Array.isArray(txs) || txs.length === 0) {
            console.error(`[${address}] no more transactions returned, stopping.`);
            break;
        }

        for (const tx of txs) {
            if (totalFetched >= maxTxPerAddress) break;

            // Extract fields from the enhanced transaction response
            const record = {
                program: address,
                signature: tx.signature,
                slot: tx.slot,
                timestamp: tx.timestamp ?? tx.blockTime ?? null,
                source: tx.source ?? null,
                type: tx.type ?? null,
                transactionError: tx.transactionError ?? null,
                tx,
            };

            fs.appendFileSync(outPath, JSON.stringify(record) + "\n");
            totalFetched++;
        }

        console.error(
            `[${address}] page ${page} -> fetched ${txs.length} (total ${totalFetched})`
        );

        // Pagination token format: "slot:position"
        paginationToken = result.paginationToken || null;
        page++;

        if (!paginationToken) {
            console.error(
                `[${address}] paginationToken is null; no further pages available.`
            );
            break;
        }

        // Small delay to avoid spiky load / credits burst
        await sleep(200);
    }

    console.error(
        `[${address}] done. Total transactions written: ${totalFetched}`
    );
}

(async () => {
    try {
        // Ensure output file exists (append mode)
        fs.writeFileSync(outPath, "", { flag: "a" });

        for (const addr of targetAddresses) {
            await ingestForAddress(addr);
        }

        console.error("\nAll addresses processed.");
    } catch (err) {
        console.error("Fatal error in helius_alpha_ingest:", err);
        process.exit(1);
    }
})();