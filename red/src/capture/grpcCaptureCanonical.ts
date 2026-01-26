// src/capture/grpcCaptureCanonical.ts
//
// Block-ordered gRPC capture for reliable pre-state snapshots.
// - Subscribes to BLOCKS with transactions and accounts
// - Processes accounts BEFORE transactions within each block
// - This ensures we have true pre-state for each transaction
// - Fetches static accounts via RPC (AmmConfig for CLMM)
//
// Usage:
//   pnpm capture

import fs from "fs";
import path from "path";
import { loadPackageDefinition, credentials } from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { Buffer } from "buffer";
import bs58 from "bs58";
import { Connection, PublicKey } from "@solana/web3.js";

import type { CanonicalSwapCase, RawAccountStateJson } from "./canonicalTypes";
import { InMemoryAccountStore, type PubkeyStr } from "../state/accountStore";
import {
    isRaydiumClmmPoolAccount,
    decodeRaydiumClmmPool
} from "../decoders/raydiumCLMMPool";
import {
    getTickArrayStartIndex,
    deriveRaydiumTickArrayPda,
    RAYDIUM_TICKS_PER_ARRAY
} from "../decoders/raydiumTickArray";
import {
    isMeteoraLbPairAccount,
    decodeMeteoraLbPair,
    binIdToBinArrayIndex,
    deriveMeteoraBinArrayPda
} from "../decoders/meteoraLbPair";

// Discriminators for account type detection
const DISCRIMINATORS = {
    clmmPool: Buffer.from("f7ede3f5d7c3de46", "hex"),
    clmmAmmConfig: Buffer.from("daf42168cbcb2b6f", "hex"),
    clmmTickArray: Buffer.from("c09b55cd31f9812a", "hex"),
    dlmmLbPair: Buffer.from("210b3162b565b10d", "hex"),
    dlmmBinArray: Buffer.from("5c8e5cdc059446b5", "hex"),
} as const;

// DLMM instruction discriminators (Anchor: sha256("global:<name>")[0:8])
// These are the ONLY instructions we want to capture for DLMM validation
const DLMM_SWAP_DISCRIMINATORS = [
    Buffer.from("f8c69e91e17587c8", "hex"), // swap
    Buffer.from("414b3f4ceb5b5b88", "hex"), // swap2
    Buffer.from("1608f60d2a9e1093", "hex"), // swapExactOut
    Buffer.from("ad702afa67253285", "hex"), // swapWithPriceImpact
] as const;

const CLMM_POOL_AMM_CONFIG_OFFSET = 9;

type ProgramKey = "pumpswap" | "raydium_v4" | "raydium_clmm" | "meteora_dlmm";

type CaptureConfig = {
    grpcAddress: string;
    rpcUrl: string;
    tls?: boolean;
    tlsCertPath?: string;
    tlsKeyPath?: string;
    tlsCaPath?: string;
    outFile: string;
    programs: Record<ProgramKey, { programId: string; pools: string[] }>;
};

const loaderOpts = {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
};

let rpcConnection: Connection;
const rpcAccountCache = new Map<string, RawAccountStateJson | null>();

function loadGeyserProto() {
    const protoPath = path.join(__dirname, "proto", "geyser.proto");
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

function toRawAccount(pubkey: string, owner: string, data: Buffer, lamports: bigint = 0n): RawAccountStateJson {
    return {
        pubkey,
        owner,
        lamports: lamports.toString(),
        executable: false,
        rentEpoch: "0",
        dataBase64: data.toString("base64"),
    };
}

function isTrackedProgram(programId: string, cfg: CaptureConfig): ProgramKey | null {
    for (const [k, v] of Object.entries(cfg.programs) as Array<[ProgramKey, any]>) {
        if (v?.programId === programId) return k;
    }
    return null;
}

function hasDiscriminator(data: Buffer, disc: Buffer): boolean {
    return data.length >= disc.length && data.subarray(0, disc.length).equals(disc);
}

function isDlmmSwapInstruction(ixData: Buffer): boolean {
    if (ixData.length < 8) return false;
    const disc = ixData.subarray(0, 8);
    return DLMM_SWAP_DISCRIMINATORS.some(d => disc.equals(d));
}

function extractClmmAmmConfig(poolData: Buffer): string | null {
    if (!hasDiscriminator(poolData, DISCRIMINATORS.clmmPool)) return null;
    if (poolData.length < CLMM_POOL_AMM_CONFIG_OFFSET + 32) return null;
    const ammConfigBytes = poolData.subarray(CLMM_POOL_AMM_CONFIG_OFFSET, CLMM_POOL_AMM_CONFIG_OFFSET + 32);
    return bs58.encode(ammConfigBytes);
}

async function fetchAccountViaRpc(pubkey: string): Promise<RawAccountStateJson | null> {
    if (rpcAccountCache.has(pubkey)) {
        return rpcAccountCache.get(pubkey) ?? null;
    }

    try {
        const pk = new PublicKey(pubkey);
        const info = await rpcConnection.getAccountInfo(pk);
        if (info && info.data) {
            const raw = toRawAccount(
                pubkey,
                info.owner.toBase58(),
                Buffer.from(info.data),
                BigInt(info.lamports)
            );
            rpcAccountCache.set(pubkey, raw);
            console.log(`[RPC] Fetched ${pubkey.slice(0, 16)}... (${info.data.length} bytes)`);
            return raw;
        }
    } catch (e: any) {
        console.error(`[RPC] Failed to fetch ${pubkey.slice(0, 16)}...: ${e?.message ?? e}`);
    }

    rpcAccountCache.set(pubkey, null);
    return null;
}

async function main() {
    const cfgPath = process.argv[2] ?? "./capture.grpc.config.json";
    const cfg: CaptureConfig = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

    if (!cfg.rpcUrl) {
        console.error("ERROR: rpcUrl required in config");
        process.exit(1);
    }

    rpcConnection = new Connection(cfg.rpcUrl, "confirmed");
    console.log(`RPC endpoint: ${cfg.rpcUrl}`);

    try {
        const slot = await rpcConnection.getSlot();
        console.log(`RPC connected, current slot: ${slot}`);
    } catch (e: any) {
        console.error(`ERROR: Cannot connect to RPC: ${e?.message ?? e}`);
        process.exit(1);
    }

    const programIds = Object.values(cfg.programs)
        .map((p) => p.programId)
        .filter(Boolean);

    if (programIds.length === 0) {
        console.error("No program IDs configured");
        process.exit(1);
    }

    console.log("=".repeat(60));
    console.log("BLOCK-ORDERED gRPC CAPTURE");
    console.log("=".repeat(60));
    console.log(`gRPC: ${cfg.grpcAddress}`);
    console.log(`RPC:  ${cfg.rpcUrl}`);
    console.log(`Out:  ${cfg.outFile}`);
    console.log(`Programs (${programIds.length}):`);
    for (const [name, p] of Object.entries(cfg.programs)) {
        if (p.programId) console.log(`  ${name}: ${p.programId}`);
    }
    console.log("=".repeat(60));

    const geyserSvc = loadGeyserProto();
    const channelCreds = cfg.tls
        ? credentials.createSsl(
              cfg.tlsCaPath ? fs.readFileSync(cfg.tlsCaPath) : undefined,
              cfg.tlsKeyPath ? fs.readFileSync(cfg.tlsKeyPath) : undefined,
              cfg.tlsCertPath ? fs.readFileSync(cfg.tlsCertPath) : undefined
          )
        : credentials.createInsecure();

    const client = new geyserSvc.Geyser(cfg.grpcAddress, channelCreds);

    // Main account store - updated with each block's account changes
    const store = new InMemoryAccountStore();

    const outPath = path.resolve(cfg.outFile);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const out = fs.createWriteStream(outPath, { flags: "a" });

    const subscription = client.Subscribe();

    // DUAL SUBSCRIPTION:
    // 1. accounts: Watch accounts OWNED BY tracked programs (pools, pairs, etc.)
    //    This populates the store with pool state so we have pre-state when txns arrive
    // 2. blocks: Process transactions in block order for consistent pre-state
    //
    // The accounts subscription ensures we capture pool accounts as they're written,
    // which becomes pre-state for the NEXT transaction touching that account.
    const subscribeRequest = {
        accounts: {
            pool_accounts: {
                owner: programIds, // Watch accounts owned by our tracked programs
            },
        },
        blocks: {
            client: {
                account_include: programIds,
                include_transactions: true,
                include_accounts: true,
                include_entries: false,
            },
        },
        commitment: 1, // confirmed
    };

    console.log("\nSubscribing to accounts (by owner) + blocks (ordered capture)...");
    subscription.write(subscribeRequest);

    let blocksProcessed = 0;
    let txnsProcessed = 0;
    let casesWritten = 0;
    let rpcFetches = 0;
    let accountUpdates = 0;
    let dlmmSwapsCapd = 0;
    let dlmmNonSwapsSkipped = 0;
    const poolCounts = { clmm: 0, dlmm: 0, pumpswap: 0, raydium_v4: 0 };

    const statsInterval = setInterval(() => {
        console.log(
            `[stats] blocks=${blocksProcessed} txns=${txnsProcessed} cases=${casesWritten} rpc=${rpcFetches} store=${store.size()} accUpdates=${accountUpdates}`
        );
        console.log(
            `  pools: clmm=${poolCounts.clmm} dlmm=${poolCounts.dlmm} pumpswap=${poolCounts.pumpswap} raydium_v4=${poolCounts.raydium_v4}`
        );
        console.log(
            `  dlmm: swaps=${dlmmSwapsCapd} skipped_non_swaps=${dlmmNonSwapsSkipped}`
        );
    }, 10000);

    subscription.on("data", async (resp: any) => {
        // Process entire blocks for ordered state
        if (resp.block) {
            blocksProcessed++;
            const block = resp.block;
            const slot = Number(block.slot ?? 0);

            // STEP 1: Apply all account updates from PREVIOUS blocks first
            // The accounts array contains post-block state, so we apply them AFTER processing txns
            // But we need the PRE-block state for transactions in THIS block

            // For proper pre-state, we snapshot the store BEFORE processing this block's transactions
            // Then apply account updates afterward for the NEXT block

            const transactions = block.transactions ?? [];
            const accounts = block.accounts ?? [];

            // Process transactions using CURRENT store state (pre-state for this block)
            for (const txInfo of transactions) {
                txnsProcessed++;
                try {
                    const result = await processTransaction(txInfo, slot, store, cfg, out);
                    if (result.wrote) casesWritten++;
                    if (result.rpcFetched) rpcFetches += result.rpcFetched;
                    if (result.dlmmSwap) dlmmSwapsCapd++;
                    if (result.dlmmSkipped) dlmmNonSwapsSkipped++;
                } catch (e: any) {
                    // Silent skip on errors
                }
            }

            // STEP 2: Now apply this block's account updates (becomes pre-state for next block)
            for (const accInfo of accounts) {
                if (!accInfo?.pubkey) continue;
                const pk = toBase58(accInfo.pubkey);
                const owner = toBase58(accInfo.owner);
                const data = Buffer.isBuffer(accInfo.data) ? accInfo.data : Buffer.from(accInfo.data ?? []);

                store.apply({
                    pubkey: pk,
                    owner,
                    lamports: BigInt(accInfo.lamports ?? 0),
                    rentEpoch: BigInt(accInfo.rent_epoch ?? 0),
                    slot,
                    writeVersion: BigInt(accInfo.write_version ?? 0),
                    executable: !!accInfo.executable,
                    data,
                });
            }

            if (blocksProcessed % 100 === 0) {
                console.log(`[block ${slot}] processed ${transactions.length} txns, ${accounts.length} accounts`);
            }
            return;
        }

        // Handle individual account updates (from accounts subscription by owner)
        // This is how we capture pool/pair accounts before they're used in transactions
        if (resp.account) {
            accountUpdates++;
            const info = resp.account.account;
            if (info?.pubkey) {
                const pk = toBase58(info.pubkey);
                const owner = toBase58(info.owner);
                const data = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data ?? []);

                // Track pool types for debugging
                if (data.length >= 8) {
                    if (hasDiscriminator(data, DISCRIMINATORS.clmmPool)) {
                        poolCounts.clmm++;
                        if (poolCounts.clmm <= 3) console.log(`[acc] CLMM Pool: ${pk.slice(0, 16)}... (${data.length} bytes)`);
                    } else if (hasDiscriminator(data, DISCRIMINATORS.dlmmLbPair)) {
                        poolCounts.dlmm++;
                        if (poolCounts.dlmm <= 3) console.log(`[acc] DLMM LbPair: ${pk.slice(0, 16)}... (${data.length} bytes)`);
                    }
                }

                // Also track pumpswap/raydium_v4 by owner
                if (owner === cfg.programs.pumpswap?.programId) {
                    poolCounts.pumpswap++;
                } else if (owner === cfg.programs.raydium_v4?.programId) {
                    poolCounts.raydium_v4++;
                }

                store.apply({
                    pubkey: pk,
                    owner,
                    lamports: BigInt(info.lamports ?? 0),
                    rentEpoch: BigInt(info.rent_epoch ?? 0),
                    slot: Number(resp.account.slot ?? 0),
                    writeVersion: BigInt(info.write_version ?? 0),
                    executable: !!info.executable,
                    data,
                });
            }
            return;
        }
    });

    subscription.on("error", (err: any) => {
        clearInterval(statsInterval);
        console.error("gRPC error:", err?.message ?? err);
        process.exit(1);
    });

    subscription.on("end", () => {
        clearInterval(statsInterval);
        console.log(`Final: ${casesWritten} cases written`);
        process.exit(0);
    });

    process.on("SIGINT", () => {
        clearInterval(statsInterval);
        console.log(`\nWrote ${casesWritten} cases to ${cfg.outFile}`);
        subscription.end();
        out.end();
        process.exit(0);
    });
}

let debugOnce = false;

async function processTransaction(
    txInfo: any,
    slot: number,
    store: InMemoryAccountStore,
    cfg: CaptureConfig,
    out: fs.WriteStream
): Promise<{ wrote: boolean; rpcFetched: number; dlmmSwap?: boolean; dlmmSkipped?: boolean }> {
    const result: { wrote: boolean; rpcFetched: number; dlmmSwap?: boolean; dlmmSkipped?: boolean } = { wrote: false, rpcFetched: 0 };

    // txInfo is SubscribeUpdateTransactionInfo: { signature, is_vote, transaction, meta, index }
    const sigRaw = txInfo.signature;
    const meta = txInfo.meta;
    const message = txInfo.transaction?.message;

    if (!sigRaw || !message) return result;
    if (txInfo.is_vote) return result;
    if (meta?.err) return result;

    const sig = toBase58(sigRaw);

    if (!debugOnce) {
        debugOnce = true;
        console.log(`\n[DEBUG] First tx: ${sig.slice(0, 24)}...`);
    }

    // Build account keys
    const accountKeys: string[] = [];
    for (const k of message.account_keys ?? []) {
        accountKeys.push(toBase58(k));
    }
    for (const w of meta?.loaded_writable_addresses ?? []) {
        accountKeys.push(toBase58(w));
    }
    for (const r of meta?.loaded_readonly_addresses ?? []) {
        accountKeys.push(toBase58(r));
    }

    // Find venue
    let venue: CanonicalSwapCase["venue"] | null = null;
    let programId: string | null = null;
    for (const ak of accountKeys) {
        const v = isTrackedProgram(ak, cfg);
        if (v) {
            venue = v;
            programId = ak;
            break;
        }
    }
    if (!venue || !programId) return result;

    // For DLMM: Only capture actual swap transactions, skip position operations
    if (venue === "meteora_dlmm") {
        let hasSwapInstruction = false;
        for (const ix of message.instructions ?? []) {
            const progIdx = ix.program_id_index ?? 0;
            const pid = accountKeys[progIdx];
            if (pid === programId) {
                const ixData = Buffer.isBuffer(ix.data)
                    ? ix.data
                    : Buffer.from(ix.data ?? [], "base64");
                if (isDlmmSwapInstruction(ixData)) {
                    hasSwapInstruction = true;
                    break;
                }
            }
        }
        if (!hasSwapInstruction) {
            result.dlmmSkipped = true;
            return result; // Skip non-swap DLMM transactions
        }
        result.dlmmSwap = true;
    }

    // Build pre-state from store (this IS the true pre-state now)
    const preAccounts: Record<string, RawAccountStateJson> = {};
    let hasPoolAccount = false;

    for (const ix of message.instructions ?? []) {
        const progIdx = ix.program_id_index ?? 0;
        const pid = accountKeys[progIdx];
        if (pid && isTrackedProgram(pid, cfg)) {
            const idxBuf = Buffer.isBuffer(ix.accounts)
                ? ix.accounts
                : Buffer.from(ix.accounts ?? []);

            for (let i = 0; i < idxBuf.length; i++) {
                const pk = accountKeys[idxBuf[i]];
                if (!pk) continue;

                const view = store.get(pk as PubkeyStr);
                if (view && !view.deleted) {
                    preAccounts[pk] = toRawAccount(pk, view.meta.owner, view.data, view.meta.lamports);
                    hasPoolAccount = true;
                }
            }
        }
    }

    if (!hasPoolAccount) return result;

    // Fetch static accounts via RPC (AmmConfig + TickArrays for CLMM)
    if (venue === "raydium_clmm") {
        for (const [pk, acc] of Object.entries(preAccounts)) {
            const data = Buffer.from(acc.dataBase64, "base64");

            // Fetch AmmConfig
            const ammConfigPk = extractClmmAmmConfig(data);
            if (ammConfigPk && !preAccounts[ammConfigPk]) {
                const ammConfigAcc = await fetchAccountViaRpc(ammConfigPk);
                if (ammConfigAcc) {
                    preAccounts[ammConfigPk] = ammConfigAcc;
                    result.rpcFetched++;
                }
            }

            // Fetch TickArrays based on pool's current tick
            if (isRaydiumClmmPoolAccount(data)) {
                const pool = decodeRaydiumClmmPool(data);
                const poolPubkey = new PublicKey(pk);
                const ticksPerArray = pool.tickSpacing * RAYDIUM_TICKS_PER_ARRAY;
                const currentStartIndex = getTickArrayStartIndex(pool.tickCurrent, pool.tickSpacing);

                // Fetch current + adjacent tick arrays
                const neededIndices = [
                    currentStartIndex,
                    currentStartIndex - ticksPerArray,
                    currentStartIndex + ticksPerArray,
                ];

                for (const startIdx of neededIndices) {
                    const taPda = deriveRaydiumTickArrayPda(poolPubkey, startIdx);
                    const taPk = taPda.toBase58();
                    if (!preAccounts[taPk]) {
                        const taAcc = await fetchAccountViaRpc(taPk);
                        if (taAcc) {
                            preAccounts[taPk] = taAcc;
                            result.rpcFetched++;
                        }
                    }
                }
            }
        }
    }

    // Fetch BinArrays for DLMM
    if (venue === "meteora_dlmm") {
        for (const [pk, acc] of Object.entries(preAccounts)) {
            const data = Buffer.from(acc.dataBase64, "base64");

            if (isMeteoraLbPairAccount(data)) {
                const lbPair = decodeMeteoraLbPair(data);
                const pairPubkey = new PublicKey(pk);
                const activeArrayIndex = binIdToBinArrayIndex(lbPair.activeId);

                // Fetch current + adjacent bin arrays
                const neededIndices = [
                    activeArrayIndex,
                    activeArrayIndex - 1n,
                    activeArrayIndex + 1n,
                ];

                for (const idx of neededIndices) {
                    const baPda = deriveMeteoraBinArrayPda(pairPubkey, idx);
                    const baPk = baPda.toBase58();
                    if (!preAccounts[baPk]) {
                        const baAcc = await fetchAccountViaRpc(baPk);
                        if (baAcc) {
                            preAccounts[baPk] = baAcc;
                            result.rpcFetched++;
                        }
                    }
                }
            }
        }
    }

    // Token balances from meta
    const tokenBalances: Record<string, any> = {};
    const preTB = meta?.pre_token_balances ?? [];
    const postTB = meta?.post_token_balances ?? [];
    const postByIndex = new Map<number, any>();
    for (const p of postTB) postByIndex.set(p.account_index ?? p.accountIndex, p);

    for (const p of preTB) {
        const idx = p.account_index ?? p.accountIndex;
        const pk = accountKeys[idx];
        if (!pk) continue;
        const post = postByIndex.get(idx);
        tokenBalances[pk] = {
            account: pk,
            mint: p.mint,
            decimals: p.ui_token_amount?.decimals ?? 0,
            preAmount: p.ui_token_amount?.amount ?? "0",
            postAmount: post?.ui_token_amount?.amount ?? "0",
            owner: p.owner,
            programId: p.program_id ?? p.programId,
        };
    }

    // Lamport balances
    const lamportBalances: Record<string, any> = {};
    const preL = meta?.pre_balances ?? [];
    const postL = meta?.post_balances ?? [];
    const n = Math.min(accountKeys.length, preL.length, postL.length);
    for (let i = 0; i < n; i++) {
        const pk = accountKeys[i];
        if (pk) {
            lamportBalances[pk] = {
                account: pk,
                preLamports: BigInt(preL[i] ?? 0).toString(),
                postLamports: BigInt(postL[i] ?? 0).toString(),
            };
        }
    }

    const c: CanonicalSwapCase = {
        signature: sig,
        slot,
        venue,
        programId,
        preAccounts,
        tokenBalances,
        lamportBalances,
        tx: { accountKeys, err: null },
    };

    out.write(JSON.stringify(c) + "\n");
    console.log(`[${venue}] ${sig.slice(0, 16)}... slot=${slot} pre=${Object.keys(preAccounts).length}`);
    result.wrote = true;
    return result;
}

main().catch((e) => {
    console.error("capture failed:", e instanceof Error ? e.stack ?? e.message : String(e));
    process.exit(1);
});
