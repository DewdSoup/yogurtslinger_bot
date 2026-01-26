// src/scripts/dexTransactionCollectorV2.ts
//
// DEX TRANSACTION DATA COLLECTOR v2
//
// PURPOSE: Capture raw transaction data for later analysis.
// PRINCIPLE: Raw facts only. No classification. No intent inference.
//
// CAPTURES:
// - Transaction message and metadata (raw)
// - Balances (pre/post) and token balances (pre/post)
// - Instructions (outer + inner) with indices and data (base64)
// - Compute units, fees, logs, return data (raw)
// - Capture timestamps and on-chain block time (if available)
//
// DOES NOT DO:
// - Interpret strategy or intent
// - Compute profits or deltas
// - Label wallets or classify venues
//
// MEMORY: Streams transactions to disk immediately. Never accumulates in memory.
//
// Usage:
//   GRPC_ADDRESS=127.0.0.1:10000 RPC_URL=http://127.0.0.1:8899 RUN_SECONDS=1200 \
//     pnpm exec ts-node src/scripts/dexTransactionCollectorV2.ts

import fs from "fs";
import path from "path";
import { loadPackageDefinition, credentials } from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import bs58 from "bs58";

// ============================================================================
// PROGRAM CONSTANTS — COMPLETE LIST
// ============================================================================

const PROGRAMS = {
    // Target DEXes
    PUMPSWAP: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    RAYDIUM_V4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    RAYDIUM_CLMM: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    METEORA_DLMM: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    ORCA_WHIRLPOOL: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",

    // Aggregators
    JUPITER_V6: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    JUPITER_V4: "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB",
    JUPITER_V3: "JUP3c2Uh3WA4Ng34tw6kPd2G4C5BB21Xo36Je1s32Ph",
    JUPITER_V2: "JUP2jxvXaqu7NQY1GmNF4m1vodw12LVXYxbFL2uJvfo",

    // System
    SYSTEM: "11111111111111111111111111111111",
    TOKEN: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    TOKEN_2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    ASSOCIATED_TOKEN: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    COMPUTE_BUDGET: "ComputeBudget111111111111111111111111111111",
    WSOL: "So11111111111111111111111111111111111111112",
} as const;

const DEX_PROGRAMS = new Set<string>([
    PROGRAMS.PUMPSWAP,
    PROGRAMS.RAYDIUM_V4,
    PROGRAMS.RAYDIUM_CLMM,
    PROGRAMS.METEORA_DLMM,
    PROGRAMS.ORCA_WHIRLPOOL,
]);

const AGGREGATOR_PROGRAMS = new Set<string>([
    PROGRAMS.JUPITER_V6,
    PROGRAMS.JUPITER_V4,
    PROGRAMS.JUPITER_V3,
    PROGRAMS.JUPITER_V2,
]);

const CAPTURE_PROGRAMS = new Set<string>([
    ...DEX_PROGRAMS,
    ...AGGREGATOR_PROGRAMS,
]);


// ============================================================================
// RAW DATA TYPES — NO INTERPRETATION
// ============================================================================

interface TimingData {
    capturedAtMs: number;           // When we received this tx (ms since epoch)
    capturedAtMicros: number;       // Microsecond precision component
    blockTime: number | null;       // On-chain block time if available
}

interface TokenBalanceRaw {
    accountIndex: number;
    mint: string;
    owner: string;
    amount: string;                 // Raw amount (no decimals)
    decimals: number;
}

interface InstructionRaw {
    programIdIndex: number;
    programId: string;
    accountIndices: number[];
    dataBase64: string;
    isInner: boolean;
    parentIndex: number | null;
    stackHeight: number;
}

interface AddressTableLookupRaw {
    accountKey: string;
    writableIndexes: number[];
    readonlyIndexes: number[];
}

interface TransactionRaw {
    // Identity
    signature: string;
    slot: number;
    indexInSlot: number;
    signatures: string[];
    version: number | string | null;

    // Timing (raw, no interpretation)
    timing: TimingData;

    // Block context (if available)
    blockContext: {
        slot: number;
        blockTime: number | null;
        blockHeight: number | null;
        blockhash: string;
        parentSlot: number | null;
        previousBlockhash: string | null;
    } | null;

    // Execution
    executed: boolean;
    errorRaw: string | null;        // Raw error JSON
    feeLamports: string;
    computeUnitsConsumed: number | null;

    // Accounts
    feePayer: string;
    messageHeader: {
        numRequiredSignatures: number;
        numReadonlySignedAccounts: number;
        numReadonlyUnsignedAccounts: number;
    } | null;
    recentBlockhash: string;
    accountKeys: string[];
    allAccounts: string[];
    loadedWritableAddresses: string[];
    loadedReadonlyAddresses: string[];

    // Programs
    programsInvoked: string[];

    // Instructions (complete)
    instructions: InstructionRaw[];

    // Balances (raw)
    preBalances: string[];
    postBalances: string[];
    preTokenBalances: TokenBalanceRaw[];
    postTokenBalances: TokenBalanceRaw[];

    // Logs (complete)
    logMessages: string[];
    returnData: { programId: string; dataBase64: string } | null;

    // Address table lookups
    addressTableLookups: AddressTableLookupRaw[];

    // Raw message/meta for full-fidelity reconstruction
    rawMessage: unknown;
    rawMeta: unknown;
}

// ============================================================================
// HELPERS — Pure functions, no side effects
// ============================================================================

function toBase58(v: any): string {
    if (typeof v === "string") return v;
    if (Buffer.isBuffer(v)) return bs58.encode(v);
    if (v instanceof Uint8Array) return bs58.encode(v);
    if (v?.type === "Buffer" && Array.isArray(v.data)) return bs58.encode(Buffer.from(v.data));
    return String(v);
}

function toBase64(v: any): string {
    if (typeof v === "string") return v;
    if (Buffer.isBuffer(v)) return v.toString("base64");
    if (v instanceof Uint8Array) return Buffer.from(v).toString("base64");
    if (v?.type === "Buffer" && Array.isArray(v.data)) return Buffer.from(v.data).toString("base64");
    return "";
}

function normalizeAccountIndices(accs: any): number[] {
    const accountIndices: number[] = [];
    if (Buffer.isBuffer(accs)) {
        for (let j = 0; j < accs.length; j++) accountIndices.push(accs[j]!);
    } else if (Array.isArray(accs)) {
        for (const a of accs) accountIndices.push(typeof a === "number" ? a : Number(a));
    }
    return accountIndices;
}

function parseTokenBalances(list: any[]): TokenBalanceRaw[] {
    const out: TokenBalanceRaw[] = [];
    for (const tb of list) {
        const accountIndex = tb.account_index ?? tb.accountIndex;
        if (accountIndex === undefined) continue;
        const amount = tb.ui_token_amount?.amount ?? tb.uiTokenAmount?.amount ?? "0";
        const decimals = tb.ui_token_amount?.decimals ?? tb.uiTokenAmount?.decimals ?? 0;
        out.push({
            accountIndex: Number(accountIndex),
            mint: tb.mint ?? "",
            owner: tb.owner ?? "",
            amount: String(amount ?? "0"),
            decimals: Number(decimals ?? 0),
        });
    }
    return out;
}

function sanitizeForJson(value: any): any {
    if (value === null || value === undefined) return value;
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (Buffer.isBuffer(value)) return value.toString('base64');
    if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
    if (Array.isArray(value)) return value.map((v) => sanitizeForJson(v));
    if (typeof value === 'object') {
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = sanitizeForJson(v);
        }
        return out;
    }
    return value;
}

function getMicrosecondTimestamp(): { ms: number; micros: number } {
    const hrTime = process.hrtime();
    const ms = Date.now();
    const micros = Math.floor(hrTime[1] / 1000) % 1000;
    return { ms, micros };
}

function hasCaptureProgram(programsInvoked: string[]): boolean {
    for (const programId of programsInvoked) {
        if (CAPTURE_PROGRAMS.has(programId)) return true;
    }
    return false;
}

// ============================================================================
// TRANSACTION PARSER — Raw extraction, no classification
// ============================================================================

function parseTransaction(
    txData: any,
    slot: number,
    indexInSlot: number,
    timing: { ms: number; micros: number },
    blockTimeOverride: number | null,
    blockObj: any | null,
    includeRawMeta: boolean
): TransactionRaw | null {
    try {
        const tx = txData.transaction;
        const meta = txData.meta;

        if (!tx || !meta) return null;
        if (txData.is_vote) return null;

        const message = tx.message;
        if (!message) return null;

        const accountKeysRaw = message.account_keys ?? message.accountKeys ?? [];
        const accountKeys = accountKeysRaw.map((k: any) => toBase58(k));
        if (accountKeys.length === 0) return null;

        const loadedWritableAddresses = (meta.loaded_writable_addresses ?? meta.loadedWritableAddresses ?? []).map((k: any) => toBase58(k));
        const loadedReadonlyAddresses = (meta.loaded_readonly_addresses ?? meta.loadedReadonlyAddresses ?? []).map((k: any) => toBase58(k));
        const allAccounts = [...accountKeys, ...loadedWritableAddresses, ...loadedReadonlyAddresses];

        const feePayer = accountKeys[0] ?? "";
        const executed = meta.err === null || meta.err === undefined;
        const errorRaw = meta.err ? JSON.stringify(meta.err) : null;

        const signature = toBase58(txData.signature ?? tx.signatures?.[0] ?? "");
        const signatures = Array.isArray(tx.signatures) ? tx.signatures.map((s: any) => toBase58(s)) : [];
        if (signature && (signatures.length === 0 || signatures[0] !== signature)) {
            signatures.unshift(signature);
        }
        const version = txData.version ?? tx.version ?? message.version ?? null;

        const instructions: InstructionRaw[] = [];
        const programsInvoked = new Set<string>();

        const outerIxs = message.instructions ?? [];
        for (let i = 0; i < outerIxs.length; i++) {
            const ix = outerIxs[i];
            const programIdx = ix.program_id_index ?? ix.programIdIndex ?? 0;
            const programId = allAccounts[programIdx] ?? "";

            if (programId) programsInvoked.add(programId);

            const accountIndices = normalizeAccountIndices(ix.accounts ?? []);
            const dataBase64 = toBase64(ix.data ?? "");

            instructions.push({
                programIdIndex: programIdx,
                programId,
                accountIndices,
                dataBase64,
                isInner: false,
                parentIndex: null,
                stackHeight: 1,
            });
        }

        const innerIxs = meta.inner_instructions ?? meta.innerInstructions ?? [];
        for (const inner of innerIxs) {
            const parentIdx = inner.index ?? 0;
            for (const ix of inner.instructions ?? []) {
                const programIdx = ix.program_id_index ?? ix.programIdIndex ?? 0;
                const programId = allAccounts[programIdx] ?? "";
                const stackHeight = ix.stack_height ?? ix.stackHeight ?? 2;

                if (programId) programsInvoked.add(programId);

                const accountIndices = normalizeAccountIndices(ix.accounts ?? []);
                const dataBase64 = toBase64(ix.data ?? "");

                instructions.push({
                    programIdIndex: programIdx,
                    programId,
                    accountIndices,
                    dataBase64,
                    isInner: true,
                    parentIndex: parentIdx,
                    stackHeight,
                });
            }
        }

        const timingData: TimingData = {
            capturedAtMs: timing.ms,
            capturedAtMicros: timing.micros,
            blockTime: blockTimeOverride ?? txData.block_time ?? txData.blockTime ?? null,
        };

        const logMessages: string[] = meta.log_messages ?? meta.logMessages ?? [];

        let returnData: { programId: string; dataBase64: string } | null = null;
        if (meta.return_data ?? meta.returnData) {
            const rd = meta.return_data ?? meta.returnData;
            returnData = {
                programId: toBase58(rd.program_id ?? rd.programId ?? ""),
                dataBase64: toBase64(rd.data ?? ""),
            };
        }

        const computeUnitsRaw = meta.compute_units_consumed ?? meta.computeUnitsConsumed;
        const computeUnitsConsumed = computeUnitsRaw !== undefined ? Number(computeUnitsRaw) : null;

        const feeLamports = String(meta.fee ?? 0);

        const preBalances = (meta.pre_balances ?? meta.preBalances ?? []).map((b: any) => String(b ?? 0));
        const postBalances = (meta.post_balances ?? meta.postBalances ?? []).map((b: any) => String(b ?? 0));

        const preTokenBalances = parseTokenBalances(meta.pre_token_balances ?? meta.preTokenBalances ?? []);
        const postTokenBalances = parseTokenBalances(meta.post_token_balances ?? meta.postTokenBalances ?? []);

        const header = message.header ?? null;
        const messageHeader = header ? {
            numRequiredSignatures: Number(header.num_required_signatures ?? header.numRequiredSignatures ?? 0),
            numReadonlySignedAccounts: Number(header.num_readonly_signed_accounts ?? header.numReadonlySignedAccounts ?? 0),
            numReadonlyUnsignedAccounts: Number(header.num_readonly_unsigned_accounts ?? header.numReadonlyUnsignedAccounts ?? 0),
        } : null;

        const recentBlockhash = toBase58(message.recent_blockhash ?? message.recentBlockhash ?? "");

        const addressTableLookups: AddressTableLookupRaw[] = [];
        const lookups = message.address_table_lookups ?? message.addressTableLookups ?? [];
        for (const lookup of lookups) {
            addressTableLookups.push({
                accountKey: toBase58(lookup.account_key ?? lookup.accountKey ?? ""),
                writableIndexes: normalizeAccountIndices(lookup.writable_indexes ?? lookup.writableIndexes ?? []),
                readonlyIndexes: normalizeAccountIndices(lookup.readonly_indexes ?? lookup.readonlyIndexes ?? []),
            });
        }

        const blockContext = blockObj ? {
            slot: Number(blockObj.slot ?? slot),
            blockTime: typeof blockObj.block_time === "number" ? blockObj.block_time : (typeof blockObj.blockTime === "number" ? blockObj.blockTime : null),
            blockHeight: typeof blockObj.block_height === "number" ? blockObj.block_height : (typeof blockObj.blockHeight === "number" ? blockObj.blockHeight : null),
            blockhash: toBase58(blockObj.blockhash ?? blockObj.blockHash ?? ""),
            parentSlot: typeof blockObj.parent_slot === "number" ? blockObj.parent_slot : (typeof blockObj.parentSlot === "number" ? blockObj.parentSlot : null),
            previousBlockhash: blockObj.previous_blockhash ? toBase58(blockObj.previous_blockhash) : (blockObj.previousBlockhash ? toBase58(blockObj.previousBlockhash) : null),
        } : null;

        return {
            signature,
            slot,
            indexInSlot,
            signatures,
            version,
            timing: timingData,
            blockContext,
            executed,
            errorRaw,
            feeLamports,
            computeUnitsConsumed,
            feePayer,
            messageHeader,
            recentBlockhash,
            accountKeys,
            allAccounts,
            loadedWritableAddresses,
            loadedReadonlyAddresses,
            programsInvoked: Array.from(programsInvoked),
            instructions,
            preBalances,
            postBalances,
            preTokenBalances,
            postTokenBalances,
            logMessages,
            returnData,
            addressTableLookups,
            rawMessage: includeRawMeta ? sanitizeForJson(message) : null,
            rawMeta: includeRawMeta ? sanitizeForJson(meta) : null,
        };
    } catch {
        return null;
    }
}

// ============================================================================
// STREAMING COLLECTOR - Writes to disk immediately, never accumulates
// ============================================================================

class StreamingCollector {
    private txStream: fs.WriteStream;
    private txCount = 0;
    private executedCount = 0;
    private failedCount = 0;
    private firstSlot = Infinity;
    private lastSlot = 0;
    private slots = new Set<number>();

    constructor(
        private txFilePath: string,
        private captureStartMs: number,
        private grpcAddress: string,
        private rpcUrl: string
    ) {
        const dir = path.dirname(txFilePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        // Open stream immediately - data starts flowing to disk right away
        this.txStream = fs.createWriteStream(txFilePath, { flags: "w" });
    }

    addTransaction(tx: TransactionRaw): void {
        // Write immediately to disk as NDJSON
        this.txStream.write(JSON.stringify(tx) + "\n");

        // Update lightweight counters only
        this.txCount++;
        if (tx.executed) this.executedCount++;
        else this.failedCount++;

        if (tx.slot < this.firstSlot) this.firstSlot = tx.slot;
        if (tx.slot > this.lastSlot) this.lastSlot = tx.slot;
        this.slots.add(tx.slot);

    }

    getStats(): { txCount: number; slotCount: number; executedCount: number; failedCount: number } {
        return {
            txCount: this.txCount,
            slotCount: this.slots.size,
            executedCount: this.executedCount,
            failedCount: this.failedCount,
        };
    }

    async finalize(captureEndMs: number): Promise<string> {
        // Close transaction stream
        await new Promise<void>((resolve) => this.txStream.end(resolve));

        // Build summary metadata
        const summary = {
            version: "2.0.0-raw",
            captureStartMs: this.captureStartMs,
            captureEndMs,
            durationSeconds: (captureEndMs - this.captureStartMs) / 1000,
            grpcAddress: this.grpcAddress,
            rpcUrl: this.rpcUrl,
            firstSlot: this.firstSlot === Infinity ? 0 : this.firstSlot,
            lastSlot: this.lastSlot,
            slotCount: this.slots.size,
            totalTransactions: this.txCount,
            executedTransactions: this.executedCount,
            failedTransactions: this.failedCount,
            transactionsFile: this.txFilePath,
        };

        // Write summary to separate file
        const summaryPath = this.txFilePath.replace(".ndjson", "_summary.json");
        fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

        return summaryPath;
    }

}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
    const grpcAddress = process.env.GRPC_ADDRESS ?? "127.0.0.1:10000";
    const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8899";
    const runSeconds = Number(process.env.RUN_SECONDS ?? "1200");
    const outputFile = process.env.OUTPUT_FILE ?? `./data/capture_v2_${Date.now()}.ndjson`;
    const maxMsgMb = Number(process.env.GRPC_MAX_MESSAGE_MB ?? "64");
    const maxMsgBytes = Math.max(4, maxMsgMb) * 1024 * 1024;
    const blockTimeBackfill = (process.env.BLOCKTIME_BACKFILL ?? "0") === "1";
    const includeRawMeta = (process.env.CAPTURE_RAW_META ?? "1") !== "0";

    console.log("=".repeat(70));
    console.log("DEX TRANSACTION COLLECTOR v2");
    console.log("=".repeat(70));
    console.log(`gRPC:      ${grpcAddress}`);
    console.log(`RPC:       ${rpcUrl}`);
    console.log(`Duration:  ${runSeconds}s`);
    console.log(`Output:    ${outputFile}`);
    console.log(`Max msg:   ${maxMsgMb} MB`);
    console.log(`BlockTime: ${blockTimeBackfill ? "rpc-backfill" : "stream-only"}`);
    console.log(`Raw meta:  ${includeRawMeta ? "enabled" : "disabled"}`);
    console.log("");
    console.log("STREAMING: Writes to disk immediately. Memory-safe for any duration.");
    console.log("=".repeat(70));

    const protoPath = path.join(__dirname, "..", "capture", "proto", "geyser.proto");
    if (!fs.existsSync(protoPath)) {
        throw new Error(`geyser.proto not found at ${protoPath}`);
    }

    const loaderOpts = { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true };
    const pkgDef = loadSync(protoPath, loaderOpts as any);
    const loaded = loadPackageDefinition(pkgDef) as any;
    const geyserSvc = loaded.geyser ?? loaded.solana?.geyser ?? loaded.agave?.geyser;

    if (!geyserSvc?.Geyser) {
        throw new Error("Unable to locate Geyser service in proto");
    }

    const client = new geyserSvc.Geyser(
        grpcAddress,
        credentials.createInsecure(),
        {
            'grpc.max_receive_message_length': maxMsgBytes,
            'grpc.max_send_message_length': maxMsgBytes,
        }
    );
    const subscription = client.Subscribe();

    const captureStartMs = Date.now();
    const collector = new StreamingCollector(outputFile, captureStartMs, grpcAddress, rpcUrl);

    const blockTimeCache = new Map<number, number | null>();
    const blockTimeInFlight = new Map<number, Promise<number | null>>();

    async function fetchBlockTime(slot: number): Promise<number | null> {
        const payload = {
            jsonrpc: "2.0",
            id: 1,
            method: "getBlockTime",
            params: [slot],
        };
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 2000);
            const res = await fetch(rpcUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
            clearTimeout(timeout);
            const json = await res.json() as { result?: number | null };
            if (json.result === null || json.result === undefined) return null;
            return Number(json.result);
        } catch {
            return null;
        }
    }

    async function resolveBlockTime(slot: number, blockObj: any | null): Promise<number | null> {
        const fromStream = blockObj?.block_time ?? blockObj?.blockTime ?? null;
        if (typeof fromStream === "number") {
            blockTimeCache.set(slot, fromStream);
            return fromStream;
        }
        if (blockTimeCache.has(slot)) return blockTimeCache.get(slot)!;
        if (!blockTimeBackfill) return null;
        if (blockTimeInFlight.has(slot)) return blockTimeInFlight.get(slot)!;

        const p = fetchBlockTime(slot).then((v) => {
            blockTimeCache.set(slot, v);
            blockTimeInFlight.delete(slot);
            return v;
        });
        blockTimeInFlight.set(slot, p);
        return p;
    }

    const capturePrograms = Array.from(CAPTURE_PROGRAMS);
    const subscribeRequest = {
        blocks: {
            client: {
                account_include: capturePrograms,
                include_transactions: true,
                include_accounts: false,
                include_entries: false,
            },
        },
        commitment: 1,
    };

    console.log("\n[CAPTURE] Connecting to gRPC...");
    console.log("[CAPTURE] File created - streaming data to disk immediately");
    subscription.write(subscribeRequest);

    let currentSlot = 0;

    const logInterval = setInterval(() => {
        const elapsed = (Date.now() - captureStartMs) / 1000;
        const stats = collector.getStats();
        const txRate = Math.round(stats.txCount / elapsed);
        const memUsage = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        console.log(`  [${elapsed.toFixed(0)}s] txs=${stats.txCount} slots=${stats.slotCount} rate=${txRate}/s mem=${memUsage}MB`);
    }, 10000);

    const handleData = async (resp: any) => {
        const timing = getMicrosecondTimestamp();

        if (resp.block) {
            const block = resp.block;
            const slot = Number(block.slot ?? 0);
            currentSlot = slot;
            const blockTime = await resolveBlockTime(slot, block);

            const blockTxs = block.transactions ?? [];
            for (let i = 0; i < blockTxs.length; i++) {
                const txInfo = blockTxs[i];
                const tx = parseTransaction(txInfo, slot, i, timing, blockTime, block, includeRawMeta);

                if (tx && hasCaptureProgram(tx.programsInvoked)) {
                    collector.addTransaction(tx);
                }
            }
        }

        if (resp.transaction) {
            const txInfo = resp.transaction;
            const slot = Number(txInfo.slot ?? currentSlot);
            const blockTime = await resolveBlockTime(slot, null);
            const tx = parseTransaction(txInfo, slot, 0, timing, blockTime, null, includeRawMeta);

            if (tx && hasCaptureProgram(tx.programsInvoked)) {
                collector.addTransaction(tx);
            }
        }
    };

    subscription.on("data", (resp: any) => {
        void handleData(resp);
    });

    subscription.on("error", (err: any) => {
        console.error("\n[ERROR] gRPC error:", err?.message ?? err);
    });

    // Wait for capture duration
    await new Promise<void>((resolve) => {
        setTimeout(() => {
            clearInterval(logInterval);
            subscription.end();
            resolve();
        }, runSeconds * 1000);
    });

    const captureEndMs = Date.now();
    const stats = collector.getStats();

    console.log("\n" + "=".repeat(70));
    console.log("[CAPTURE] FINALIZING...");
    console.log("=".repeat(70));

    const summaryPath = await collector.finalize(captureEndMs);

    console.log(`  Duration:     ${((captureEndMs - captureStartMs) / 1000).toFixed(1)} seconds`);
    console.log(`  Transactions: ${stats.txCount}`);
    console.log(`    Executed:   ${stats.executedCount}`);
    console.log(`    Failed:     ${stats.failedCount}`);
    console.log(`  Slots:        ${stats.slotCount}`);

    const txFileStats = fs.statSync(outputFile);
    const summaryStats = fs.statSync(summaryPath);

    console.log("\n" + "=".repeat(70));
    console.log("OUTPUT FILES");
    console.log("=".repeat(70));
    console.log(`  Transactions: ${outputFile}`);
    console.log(`    Size: ${(txFileStats.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Summary:      ${summaryPath}`);
    console.log(`    Size: ${(summaryStats.size / 1024).toFixed(2)} KB`);

    console.log("\n" + "=".repeat(70));
    console.log("RAW DATA CAPTURE COMPLETE");
    console.log("=".repeat(70));
    console.log("\nData captured (NDJSON format - one transaction per line):");
    console.log("  - Transaction message + metadata (raw)");
    console.log("  - Instructions (outer + inner) with indices and data (base64)");
    console.log("  - Balances (pre/post) and token balances (pre/post)");
    console.log("  - Logs, return data, compute units, fees");
    console.log("  - Address table lookups");
    console.log("\nTo analyze: pnpm exec ts-node src/scripts/analyzeCapture.ts " + outputFile);

    process.exit(0);
}

main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
});
