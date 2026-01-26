// src/run/fractureScanner.ts
//
// PumpSwap Fracture Arbitrage Scanner Runner
//
// Connects to Yellowstone gRPC and feeds account updates to the
// FractureArbScanner for cross-DEX opportunity detection.
//
// Usage:
//   GRPC_ADDRESS=... RPC_URL=... pnpm run:fracture

import fs from "fs";
import path from "path";
import { loadPackageDefinition, credentials } from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import bs58 from "bs58";

import { InMemoryAccountStore, type PubkeyStr } from "../state/accountStore";
import { HotPathCache } from "../state/hotPathCache";
import { FractureArbScanner, type ArbOpportunity } from "../arb/fractureArbScanner";

// Program IDs
const PROGRAM_IDS = {
    pumpswap: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    raydium_v4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    raydium_clmm: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    meteora_dlmm: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
} as const;

const PROGRAMS = Object.values(PROGRAM_IDS);

interface RunConfig {
    grpcAddress: string;
    rpcUrl: string;
    minSpreadBps: number;
    probeAmountSol: number;
    scanIntervalMs: number;
}

const loaderOpts = {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
};

function loadGeyserProto() {
    const protoPath = path.join(__dirname, "..", "capture", "proto", "geyser.proto");
    if (!fs.existsSync(protoPath)) {
        throw new Error(`geyser.proto missing at ${protoPath}`);
    }
    const pkgDef = loadSync(protoPath, loaderOpts as any);
    const loaded = loadPackageDefinition(pkgDef) as any;
    const geyserSvc = loaded.geyser ?? loaded.solana?.geyser ?? loaded.agave?.geyser;
    if (!geyserSvc?.Geyser) {
        throw new Error("Unable to locate Geyser service in proto");
    }
    return geyserSvc;
}

function toBase58(v: any): string {
    if (typeof v === "string") return v;
    if (Buffer.isBuffer(v)) return bs58.encode(v);
    if (v instanceof Uint8Array) return bs58.encode(v);
    if (v?.type === "Buffer" && Array.isArray(v.data)) return bs58.encode(Buffer.from(v.data));
    return String(v);
}

async function main() {
    // Configuration from environment or defaults
    const config: RunConfig = {
        grpcAddress: process.env.GRPC_ADDRESS ?? "127.0.0.1:10000",
        rpcUrl: process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com",
        minSpreadBps: Number(process.env.MIN_SPREAD_BPS ?? "50"),
        probeAmountSol: Number(process.env.PROBE_AMOUNT_SOL ?? "0.1"),
        scanIntervalMs: Number(process.env.SCAN_INTERVAL_MS ?? "100"),
    };

    console.log("=".repeat(60));
    console.log("PUMPSWAP FRACTURE ARBITRAGE SCANNER");
    console.log("=".repeat(60));
    console.log(`gRPC:          ${config.grpcAddress}`);
    console.log(`RPC:           ${config.rpcUrl}`);
    console.log(`Min spread:    ${config.minSpreadBps} bps`);
    console.log(`Probe amount:  ${config.probeAmountSol} SOL`);
    console.log(`Scan interval: ${config.scanIntervalMs}ms`);
    console.log(`Programs:      ${PROGRAMS.length}`);
    for (const [name, pid] of Object.entries(PROGRAM_IDS)) {
        console.log(`  ${name}: ${pid}`);
    }
    console.log("=".repeat(60));

    // Initialize state
    const store = new InMemoryAccountStore();
    const cache = new HotPathCache(store);

    // Initialize scanner
    const scanner = new FractureArbScanner(store, cache, {
        minSpreadBps: config.minSpreadBps,
        probeAmountLamports: BigInt(Math.floor(config.probeAmountSol * 1e9)),
        scanIntervalMs: config.scanIntervalMs,
    });

    // Wire up events
    scanner.on("fracture", (event: { mint: string; venue: string; pool: any }) => {
        console.log(`\n[FRACTURE] ${event.mint.slice(0, 12)}... appeared on ${event.venue}`);
    });

    scanner.on("opportunity", (opp: ArbOpportunity) => {
        console.log(`\n${"=".repeat(50)}`);
        console.log(`[OPPORTUNITY] ${opp.spreadBps.toFixed(1)} bps spread!`);
        console.log(`  Mint:   ${opp.mint.slice(0, 16)}...`);
        console.log(`  Buy:    ${opp.buyVenue} @ ${opp.buyPrice.toFixed(9)} SOL`);
        console.log(`  Sell:   ${opp.sellVenue} @ ${opp.sellPrice.toFixed(9)} SOL`);
        console.log(`  Input:  ${Number(opp.optimalInputLamports) / 1e9} SOL`);
        console.log(`  Profit: ${Number(opp.expectedProfitLamports) / 1e9} SOL`);
        console.log(`${"=".repeat(50)}\n`);

        // TODO: Build and submit Jito bundle
    });

    // Connect to gRPC
    const geyserSvc = loadGeyserProto();
    const channelCreds = credentials.createInsecure();
    const client = new geyserSvc.Geyser(config.grpcAddress, channelCreds);

    const subscription = client.Subscribe();

    // Subscribe to accounts owned by our target programs
    const subscribeRequest = {
        accounts: {
            pool_accounts: {
                owner: PROGRAMS,
            },
        },
        commitment: 1, // confirmed
    };

    console.log("\nConnecting to gRPC...");
    subscription.write(subscribeRequest);

    // Stats
    let accountUpdates = 0;
    let lastStatsTime = Date.now();
    const poolCounts: Record<string, number> = {
        pumpswap: 0,
        raydium_v4: 0,
        raydium_clmm: 0,
        meteora_dlmm: 0,
    };

    // Stats logging
    const statsInterval = setInterval(() => {
        const stats = scanner.getStats();
        const elapsed = (Date.now() - lastStatsTime) / 1000;
        const rate = accountUpdates / elapsed;

        console.log(
            `[stats] updates=${accountUpdates} (${rate.toFixed(0)}/s) ` +
            `pools=${stats.poolsTracked} fractures=${stats.fracturesDetected} ` +
            `opps=${stats.opportunitiesFound} scan=${stats.lastScanMs.toFixed(1)}ms`
        );
        console.log(
            `  pools: pumpswap=${poolCounts.pumpswap} raydium_v4=${poolCounts.raydium_v4} ` +
            `clmm=${poolCounts.raydium_clmm} dlmm=${poolCounts.meteora_dlmm}`
        );

        accountUpdates = 0;
        lastStatsTime = Date.now();
    }, 10000);

    subscription.on("data", (resp: any) => {
        if (resp.account) {
            accountUpdates++;
            const info = resp.account.account;
            if (!info?.pubkey) return;

            const pk = toBase58(info.pubkey) as PubkeyStr;
            const owner = toBase58(info.owner) as PubkeyStr;
            const data = Buffer.isBuffer(info.data)
                ? info.data
                : Buffer.from(info.data ?? []);
            const slot = Number(resp.account.slot ?? 0);

            // Track pool counts by program
            if (owner === PROGRAM_IDS.pumpswap) poolCounts.pumpswap++;
            else if (owner === PROGRAM_IDS.raydium_v4) poolCounts.raydium_v4++;
            else if (owner === PROGRAM_IDS.raydium_clmm) poolCounts.raydium_clmm++;
            else if (owner === PROGRAM_IDS.meteora_dlmm) poolCounts.meteora_dlmm++;

            // Update store
            store.apply({
                pubkey: pk,
                owner,
                lamports: BigInt(info.lamports ?? 0),
                rentEpoch: BigInt(info.rent_epoch ?? 0),
                slot,
                writeVersion: BigInt(info.write_version ?? 0),
                executable: !!info.executable,
                data,
            });

            // Feed to scanner
            scanner.onAccountUpdate(pk, owner, data, slot);
        }
    });

    subscription.on("error", (err: any) => {
        clearInterval(statsInterval);
        console.error("gRPC error:", err?.message ?? err);
        process.exit(1);
    });

    subscription.on("end", () => {
        clearInterval(statsInterval);
        const stats = scanner.getStats();
        console.log(`\nStream ended. Final stats:`);
        console.log(`  Pools tracked:    ${stats.poolsTracked}`);
        console.log(`  Fractures found:  ${stats.fracturesDetected}`);
        console.log(`  Opportunities:    ${stats.opportunitiesFound}`);
        process.exit(0);
    });

    // Start scanner
    scanner.start();
    console.log("\nScanner started. Waiting for data...\n");

    // Graceful shutdown
    process.on("SIGINT", () => {
        clearInterval(statsInterval);
        scanner.stop();
        subscription.end();

        const stats = scanner.getStats();
        console.log(`\nShutdown. Final stats:`);
        console.log(`  Pools tracked:    ${stats.poolsTracked}`);
        console.log(`  Fractures found:  ${stats.fracturesDetected}`);
        console.log(`  Opportunities:    ${stats.opportunitiesFound}`);
        process.exit(0);
    });
}

main().catch((e) => {
    console.error("Failed:", e instanceof Error ? e.stack ?? e.message : String(e));
    process.exit(1);
});
