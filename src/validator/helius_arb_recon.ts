/**
 * helius_arb_recon.ts
 *
 * "Maximum value" recon for Solana swap/arbitrage research using Helius RPC + WSS.
 *
 * High-level idea:
 *   - Watch live swaps across the DEX programs your repo already simulates
 *     (PumpSwap, Raydium V4, Raydium CLMM, Meteora DLMM).
 *   - Mine *realized* profitable multi-swap transactions (arbs) and capture:
 *       • net balance deltas (SOL + WSOL + stables)
 *       • execution costs (fee, priority fee estimate, Jito tip)
 *       • route fingerprint (which programs were invoked; optionally enhanced swap parse)
 *       • optional "deep snapshot" of relevant on-chain accounts for replay/regression
 *
 * Output:
 *   - Writes JSONL (one JSON object per line) to OUT_FILE.
 *
 * Usage (Node >= 18 recommended):
 *   export HELIUS_RPC_URL='https://mainnet.helius-rpc.com/?api-key=...'
 *   export HELIUS_WSS_URL='wss://mainnet.helius-rpc.com/?api-key=...'
 *   export HELIUS_API_KEY='...optional...'   # enables Enhanced Transactions parse
 *   export RUN_SECONDS=1800
 *   node --loader ts-node/esm helius_arb_recon.ts
 *
 * Notes:
 *   - This script is designed to be dependency-light (only @solana/web3.js).
 *   - It intentionally stores BigInt quantities as strings in JSON.
 */

import {
    Connection,
    PublicKey,
    type ParsedInstruction,
    type PartiallyDecodedInstruction,
    type ParsedTransactionWithMeta,
} from "@solana/web3.js";

import * as fs from "fs";
import * as path from "path";

// -----------------------------
// Program IDs (from your repo decoders)
// -----------------------------

const PROGRAMS = {
    PUMPSWAP: {
        name: "pumpswap",
        programId: new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"),
    },
    RAYDIUM_V4: {
        name: "raydium_v4",
        programId: new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),
    },
    RAYDIUM_CLMM: {
        name: "raydium_clmm",
        programId: new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"),
    },
    METEORA_DLMM: {
        name: "meteora_dlmm",
        programId: new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"),
    },
} as const;

// -----------------------------
// Common program IDs
// -----------------------------

const SYS_PROGRAM = "11111111111111111111111111111111";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// WSOL mint
const WSOL_MINT = "So11111111111111111111111111111111111111112";

// Common stables (mainnet)
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

// Jito tip accounts (mainnet) per Jito docs (keep configurable via env override)
const DEFAULT_JITO_TIP_ACCOUNTS = [
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
    "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
];

// -----------------------------
// Minimal discriminators / heuristics to snapshot relevant accounts (optional)
// -----------------------------

// PumpSwap Pool discriminator (first 8 bytes)
const PUMPSWAP_POOL_DISCRIMINATOR = Buffer.from([
    241, 154, 109, 4, 17, 177, 109, 188,
]);

// PumpSwap GlobalConfig discriminator (0x95089ccaa0fcb0d9)
const PUMPSWAP_GLOBAL_CONFIG_DISCRIMINATOR = Buffer.from(
    "95089ccaa0fcb0d9",
    "hex"
);

// Raydium CLMM Pool discriminator (0xf7ede3f5d7c3de46)
const RAYDIUM_CLMM_POOL_DISCRIMINATOR = Buffer.from(
    "f7ede3f5d7c3de46",
    "hex"
);

// Raydium CLMM AmmConfig discriminator (from your decoder: 0xdaf42168cbcb2b6f)
const RAYDIUM_AMM_CONFIG_DISCRIMINATOR = Buffer.from(
    "daf42168cbcb2b6f",
    "hex"
);

// Raydium CLMM TickArray discriminator (0xc09b55cd31f9812a)
const RAYDIUM_TICK_ARRAY_DISCRIMINATOR = Buffer.from(
    "c09b55cd31f9812a",
    "hex"
);

// Raydium V4 pool size (no discriminator)
const RAYDIUM_V4_POOL_SIZE = 752;

// Raydium V4 OpenOrders magic "serum" and size
const OPEN_ORDERS_MAGIC = Buffer.from("serum", "ascii");
const OPEN_ORDERS_SIZE = 3228;

// Meteora DLMM LbPair discriminator (0x210b3162b565b10d)
const METEORA_LB_PAIR_DISCRIMINATOR = Buffer.from(
    "210b3162b565b10d",
    "hex"
);

// Meteora DLMM BinArray discriminator (0x5c8e5cdc059446b5)
const METEORA_BIN_ARRAY_DISCRIMINATOR = Buffer.from(
    "5c8e5cdc059446b5",
    "hex"
);

// -----------------------------
// Types
// -----------------------------

type ReconMode = "all" | "candidate" | "off";

type TokenDelta = {
    accountIndex: number;
    account: string;
    mint: string;
    owner?: string | undefined;
    programId?: string | undefined;
    decimals: number;
    preAmount: string; // raw integer as string
    postAmount: string; // raw integer as string
    change: string; // raw integer as string (post - pre)
    uiChange?: number | undefined;
};

type SolDelta = {
    accountIndex: number;
    account: string;
    preBalance: string; // lamports
    postBalance: string; // lamports
    change: string; // lamports
};

type AccountState = {
    owner: string;
    lamports: number;
    executable: boolean;
    rentEpoch: number;
    data: string; // base64
    dataEncoding: "base64";
    dataLength: number;
    role?: string;
};

type ReconRecord = {
    collectedAt: string;

    // tx identifiers
    signature: string;
    slot: number;
    blockTime?: number | undefined;

    // status
    err: unknown | null;

    // fees / compute
    feeLamports: number;
    computeUnitsConsumed?: number | undefined;
    cuLimit?: number | undefined;
    cuPriceMicroLamports?: number | undefined;
    priorityFeeLamportsEst?: string | undefined;

    // tips
    jitoTipLamports?: number | undefined;

    // routing / programs
    feePayer: string;
    invokedDexPrograms: string[]; // subset of our DEX program IDs invoked
    invokedDexTags: string[]; // e.g. ["raydium_v4", "meteora_dlmm"]
    dexInstructionCount: number; // number of instructions (outer+inner) invoking our DEX program IDs
    routeFingerprint: string; // best-effort

    // balance deltas (fee payer)
    feePayerNativeDeltaLamports: string;
    feePayerWsolDeltaLamports: string;
    feePayerNetSolEquivalentLamports: string;
    feePayerNetUsdcRaw: string;
    feePayerNetUsdtRaw: string;

    // deltas (all token accounts in meta)
    tokenChanges: TokenDelta[];
    solChanges: SolDelta[];

    // flags
    isMultiDex: boolean;
    isLikelyArb: boolean;

    // Optional: enhanced parse + deep snapshot for replay
    enhanced?: unknown;
    accountStates?: Record<string, AccountState> | undefined;
    accountRoles?: Record<string, string> | undefined;
};

// -----------------------------
// Helpers
// -----------------------------

function nowIso(): string {
    return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function bigIntFromMaybeString(x: unknown): bigint {
    if (typeof x === "bigint") return x;
    if (typeof x === "number") return BigInt(Math.trunc(x));
    if (typeof x === "string") {
        if (x.trim() === "") return 0n;
        return BigInt(x);
    }
    return 0n;
}

function safeToStringPk(pk: unknown): string {
    if (!pk) return "";
    // PublicKey has toBase58 and toString
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyPk = pk as any;
    if (typeof anyPk === "string") return anyPk;
    if (typeof anyPk.toBase58 === "function") return anyPk.toBase58();
    if (typeof anyPk.toString === "function") return anyPk.toString();
    return String(pk);
}

function isParsedIx(ix: ParsedInstruction | PartiallyDecodedInstruction): ix is ParsedInstruction {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (ix as any).parsed !== undefined;
}

function allIxs(tx: ParsedTransactionWithMeta): Array<{ ix: ParsedInstruction | PartiallyDecodedInstruction; inner: boolean }> {
    const out: Array<{ ix: ParsedInstruction | PartiallyDecodedInstruction; inner: boolean }> = [];

    for (const ix of tx.transaction.message.instructions) {
        out.push({ ix, inner: false });
    }

    if (tx.meta?.innerInstructions) {
        for (const ii of tx.meta.innerInstructions) {
            for (const ix of ii.instructions) {
                out.push({ ix, inner: true });
            }
        }
    }

    return out;
}

function extractComputeBudget(tx: ParsedTransactionWithMeta): { cuLimit?: number; cuPriceMicroLamports?: number } {
    let cuLimit: number | undefined;
    let cuPrice: number | undefined;

    for (const { ix } of allIxs(tx)) {
        const programId = safeToStringPk((ix as any).programId);

        if (programId !== COMPUTE_BUDGET_PROGRAM) continue;

        if (isParsedIx(ix)) {
            const parsed = (ix as any).parsed;
            const t = parsed?.type;
            const info = parsed?.info;

            if (t === "setComputeUnitLimit") {
                const units = Number(info?.units);
                if (Number.isFinite(units)) cuLimit = units;
            }

            if (t === "setComputeUnitPrice") {
                // Some RPCs return microLamports, some return micro_lamports
                const ml = Number(info?.microLamports ?? info?.micro_lamports);
                if (Number.isFinite(ml)) cuPrice = ml;
            }
        }
    }

    const result: { cuLimit?: number; cuPriceMicroLamports?: number } = {};
    if (cuLimit !== undefined) result.cuLimit = cuLimit;
    if (cuPrice !== undefined) result.cuPriceMicroLamports = cuPrice;
    return result;
}

function estimatePriorityFeeLamports(computeUnits: number | undefined, cuPriceMicroLamports: number | undefined): bigint | undefined {
    if (!computeUnits || !cuPriceMicroLamports) return undefined;
    if (computeUnits <= 0 || cuPriceMicroLamports <= 0) return undefined;

    const microLamportsTotal = BigInt(computeUnits) * BigInt(Math.trunc(cuPriceMicroLamports));
    // microLamports -> lamports: divide by 1_000_000 (ceil)
    const denom = 1_000_000n;
    return (microLamportsTotal + denom - 1n) / denom;
}

function extractJitoTipsLamports(tx: ParsedTransactionWithMeta, tipAccounts: Set<string>): number {
    let total = 0;

    for (const { ix } of allIxs(tx)) {
        const programId = safeToStringPk((ix as any).programId);
        if (programId !== SYS_PROGRAM) continue;

        if (!isParsedIx(ix)) continue;

        const parsed = (ix as any).parsed;
        if (parsed?.type !== "transfer") continue;

        const info = parsed?.info;
        const destination = String(info?.destination ?? "");
        const lamports = Number(info?.lamports ?? 0);

        if (tipAccounts.has(destination) && Number.isFinite(lamports) && lamports > 0) {
            total += lamports;
        }
    }

    return total;
}

function computeTokenChanges(tx: ParsedTransactionWithMeta): TokenDelta[] {
    const meta = tx.meta;
    if (!meta) return [];

    const pre = meta.preTokenBalances ?? [];
    const post = meta.postTokenBalances ?? [];

    // Key: accountIndex + mint
    const key = (accountIndex: number, mint: string) => `${accountIndex}:${mint}`;

    const preMap = new Map<string, any>();
    for (const b of pre) {
        preMap.set(key(b.accountIndex, b.mint), b);
    }

    const postMap = new Map<string, any>();
    for (const b of post) {
        postMap.set(key(b.accountIndex, b.mint), b);
    }

    const allKeys = new Set<string>([...preMap.keys(), ...postMap.keys()]);

    // accountKeys mapping
    const accountKeys = tx.transaction.message.accountKeys.map((k) => safeToStringPk((k as any).pubkey ?? k));

    const out: TokenDelta[] = [];

    for (const kStr of allKeys) {
        const [idxStr, mint = ""] = kStr.split(":");
        const accountIndex = Number(idxStr);

        const preB = preMap.get(kStr);
        const postB = postMap.get(kStr);

        const decimals = Number((postB ?? preB)?.uiTokenAmount?.decimals ?? 0);

        const preAmountStr = String(preB?.uiTokenAmount?.amount ?? "0");
        const postAmountStr = String(postB?.uiTokenAmount?.amount ?? "0");

        const preAmount = bigIntFromMaybeString(preAmountStr);
        const postAmount = bigIntFromMaybeString(postAmountStr);
        const delta = postAmount - preAmount;

        const owner = (postB ?? preB)?.owner;
        const programId = (postB ?? preB)?.programId;

        const uiChange = (() => {
            const uiPre = Number(preB?.uiTokenAmount?.uiAmount ?? preB?.uiTokenAmount?.uiAmountString);
            const uiPost = Number(postB?.uiTokenAmount?.uiAmount ?? postB?.uiTokenAmount?.uiAmountString);
            if (Number.isFinite(uiPre) && Number.isFinite(uiPost)) return uiPost - uiPre;
            return undefined;
        })();

        out.push({
            accountIndex,
            account: accountKeys[accountIndex] ?? "",
            mint,
            owner: owner ? String(owner) : undefined,
            programId: programId ? String(programId) : undefined,
            decimals: Number.isFinite(decimals) ? decimals : 0,
            preAmount: preAmount.toString(),
            postAmount: postAmount.toString(),
            change: delta.toString(),
            uiChange,
        });
    }

    return out;
}

function computeSolChanges(tx: ParsedTransactionWithMeta): SolDelta[] {
    const meta = tx.meta;
    if (!meta) return [];

    const pre = meta.preBalances ?? [];
    const post = meta.postBalances ?? [];

    const accountKeys = tx.transaction.message.accountKeys.map((k) => safeToStringPk((k as any).pubkey ?? k));

    const out: SolDelta[] = [];

    const n = Math.max(pre.length, post.length, accountKeys.length);
    for (let i = 0; i < n; i++) {
        const preLamports = BigInt(pre[i] ?? 0);
        const postLamports = BigInt(post[i] ?? 0);
        const delta = postLamports - preLamports;

        if (delta === 0n) continue;

        out.push({
            accountIndex: i,
            account: accountKeys[i] ?? "",
            preBalance: preLamports.toString(),
            postBalance: postLamports.toString(),
            change: delta.toString(),
        });
    }

    return out;
}

function feePayerFromTx(tx: ParsedTransactionWithMeta): { feePayer: string; feePayerIndex: number } {
    const keys = tx.transaction.message.accountKeys;
    // In Solana, fee payer is typically accountKeys[0]
    const feePayerIndex = 0;
    const feePayer = safeToStringPk((keys[0] as any).pubkey ?? keys[0]);
    return { feePayer, feePayerIndex };
}

function invokedPrograms(tx: ParsedTransactionWithMeta): Set<string> {
    const set = new Set<string>();
    for (const { ix } of allIxs(tx)) {
        const programId = safeToStringPk((ix as any).programId);
        if (programId) set.add(programId);
    }
    return set;
}

function dexProgramsInvoked(programSet: Set<string>): { ids: string[]; tags: string[] } {
    const ids: string[] = [];
    const tags: string[] = [];

    for (const p of Object.values(PROGRAMS)) {
        const id = p.programId.toBase58();
        if (programSet.has(id)) {
            ids.push(id);
            tags.push(p.name);
        }
    }

    return { ids, tags };
}

function countDexInstructions(tx: ParsedTransactionWithMeta): number {
    const dexIds = new Set<string>([
        PROGRAMS.PUMPSWAP.programId.toBase58(),
        PROGRAMS.RAYDIUM_V4.programId.toBase58(),
        PROGRAMS.RAYDIUM_CLMM.programId.toBase58(),
        PROGRAMS.METEORA_DLMM.programId.toBase58(),
    ]);

    let count = 0;
    for (const { ix } of allIxs(tx)) {
        const pid = safeToStringPk((ix as any).programId);
        if (dexIds.has(pid)) count += 1;
    }
    return count;
}

function routeFingerprintFromEnhanced(enhanced: any): string | undefined {
    try {
        const inner = enhanced?.events?.swap?.innerSwaps;
        if (Array.isArray(inner) && inner.length > 0) {
            const parts: string[] = [];
            for (const s of inner) {
                const p = s?.programInfo?.programName ?? s?.programInfo?.source;
                if (p) parts.push(String(p));
            }
            if (parts.length > 0) return parts.join(" -> ");
        }
    } catch {
        // ignore
    }
    return undefined;
}

function routeFingerprintFallback(invokedDexTags: string[]): string {
    return invokedDexTags.length > 0 ? invokedDexTags.join("+") : "unknown";
}

function isLikelyArbHeuristic(params: {
    dexInstructionCount: number;
    netSolEqLamports: bigint;
    netUsdc: bigint;
    netUsdt: bigint;
    minProfitLamports: bigint;
    minProfitStableRaw: bigint;
}): boolean {
    // Heuristic: at least 2 invocations of the monitored DEX programs.
    // This catches multi-DEX arbs *and* same-program multi-hop (e.g., 2 Raydium CLMM swaps).
    if (params.dexInstructionCount < 2) return false;

    // Profit in SOL-equivalent (native + WSOL) OR in stablecoins.
    // Heuristic thresholds are configurable.
    if (params.netSolEqLamports >= params.minProfitLamports) return true;
    if (params.netUsdc >= params.minProfitStableRaw) return true;
    if (params.netUsdt >= params.minProfitStableRaw) return true;
    return false;
}

async function fetchEnhancedTx(signature: string, apiKey: string, commitment: "confirmed" | "finalized"): Promise<any | undefined> {
    const url = new URL("https://api-mainnet.helius-rpc.com/v0/transactions");
    url.searchParams.set("api-key", apiKey);
    url.searchParams.set("commitment", commitment);

    const resp = await fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactions: [signature] }),
    });

    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Enhanced tx fetch failed (${resp.status}): ${text.slice(0, 300)}`);
    }

    const data = await resp.json();
    if (Array.isArray(data) && data.length > 0) return data[0];
    return undefined;
}

function classifyAccountRole(owner: string, data: Buffer): string | undefined {
    // PumpSwap
    if (data.length >= 8 && data.subarray(0, 8).equals(PUMPSWAP_POOL_DISCRIMINATOR)) return "pumpswap:pool";
    if (data.length >= 8 && data.subarray(0, 8).equals(PUMPSWAP_GLOBAL_CONFIG_DISCRIMINATOR)) return "pumpswap:global_config";

    // Raydium V4 pool: owner match + size
    if (owner === PROGRAMS.RAYDIUM_V4.programId.toBase58() && data.length === RAYDIUM_V4_POOL_SIZE) return "raydium_v4:pool";

    // Raydium V4 OpenOrders
    if (data.length === OPEN_ORDERS_SIZE && data.subarray(0, 5).equals(OPEN_ORDERS_MAGIC)) return "raydium_v4:open_orders";

    // Raydium CLMM
    if (data.length >= 8 && data.subarray(0, 8).equals(RAYDIUM_CLMM_POOL_DISCRIMINATOR)) return "raydium_clmm:pool";
    if (data.length >= 8 && data.subarray(0, 8).equals(RAYDIUM_AMM_CONFIG_DISCRIMINATOR)) return "raydium_clmm:amm_config";
    if (data.length >= 8 && data.subarray(0, 8).equals(RAYDIUM_TICK_ARRAY_DISCRIMINATOR)) return "raydium_clmm:tick_array";

    // Meteora DLMM
    if (data.length >= 8 && data.subarray(0, 8).equals(METEORA_LB_PAIR_DISCRIMINATOR)) return "meteora_dlmm:lb_pair";
    if (data.length >= 8 && data.subarray(0, 8).equals(METEORA_BIN_ARRAY_DISCRIMINATOR)) return "meteora_dlmm:bin_array";

    // SPL token accounts
    if (owner === TOKEN_PROGRAM) return "spl:token_account";
    if (owner === TOKEN_2022_PROGRAM) return "spl:token2022_account";

    return undefined;
}

async function snapshotRelevantAccounts(params: {
    connection: Connection;
    tx: ParsedTransactionWithMeta;
    commitment: "confirmed" | "finalized";
}): Promise<{ accountStates: Record<string, AccountState>; accountRoles: Record<string, string> } | undefined> {
    const { connection, tx, commitment } = params;

    const slot = tx.slot;
    const keys = tx.transaction.message.accountKeys.map((k) => safeToStringPk((k as any).pubkey ?? k));

    // Fetch in chunks (RPC has limits)
    const CHUNK = 90;
    const accountStates: Record<string, AccountState> = {};
    const accountRoles: Record<string, string> = {};

    for (let i = 0; i < keys.length; i += CHUNK) {
        const slice = keys.slice(i, i + CHUNK).map((k) => new PublicKey(k));

        const infos = await connection.getMultipleAccountsInfo(slice, {
            commitment,
            minContextSlot: slot,
        });

        for (let j = 0; j < slice.length; j++) {
            const key = slice[j];
            if (!key) continue;
            const pk = key.toBase58();
            const info = infos[j];
            if (!info) continue;

            const owner = info.owner.toBase58();
            const dataBuf = Buffer.from(info.data);
            const role = classifyAccountRole(owner, dataBuf);

            // Only store accounts we know how to label.
            if (!role) continue;

            accountRoles[pk] = role;
            accountStates[pk] = {
                owner,
                lamports: info.lamports,
                executable: info.executable,
                rentEpoch: info.rentEpoch ?? 0,
                data: dataBuf.toString("base64"),
                dataEncoding: "base64",
                dataLength: dataBuf.length,
                role,
            };
        }
    }

    if (Object.keys(accountStates).length === 0) return undefined;
    return { accountStates, accountRoles };
}

// -----------------------------
// Main
// -----------------------------

async function main(): Promise<void> {
    const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL ?? process.env.SOLANA_RPC_URL;
    const HELIUS_WSS_URL = process.env.HELIUS_WSS_URL ?? process.env.SOLANA_WSS_URL;

    if (!HELIUS_RPC_URL) {
        throw new Error(
            "Missing HELIUS_RPC_URL (or SOLANA_RPC_URL). Provide your Helius https RPC URL via env var."
        );
    }

    const commitmentEnv = (process.env.COMMITMENT ?? "confirmed").toLowerCase();
    const commitment: "confirmed" | "finalized" = commitmentEnv === "finalized" ? "finalized" : "confirmed";

    const runSeconds = Number(process.env.RUN_SECONDS ?? "1800");
    const maxConcurrency = Math.max(1, Number(process.env.MAX_CONCURRENCY ?? "6"));

    const enhancedMode = (process.env.ENHANCED_MODE ?? "candidate") as ReconMode;
    const heliusApiKey = process.env.HELIUS_API_KEY;

    const minProfitLamports = BigInt(process.env.MIN_PROFIT_LAMPORTS ?? "0");
    // Stablecoin threshold is in raw units (USDC/USDT are 6 decimals on mainnet)
    const minProfitStableRaw = BigInt(process.env.MIN_PROFIT_STABLE_RAW ?? "0");

    const deepSnapshot = (process.env.DEEP_SNAPSHOT ?? "1") !== "0";

    const outDir = process.env.OUT_DIR ?? process.cwd();
    const outFile = process.env.OUT_FILE ?? `arb_recon_${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
    const outPath = path.isAbsolute(outFile) ? outFile : path.join(outDir, outFile);

    const tipAccounts = new Set<string>(
        (process.env.JITO_TIP_ACCOUNTS?.split(",").map((s) => s.trim()).filter(Boolean) ?? DEFAULT_JITO_TIP_ACCOUNTS)
    );

    const connection = new Connection(HELIUS_RPC_URL, {
        commitment,
        ...(HELIUS_WSS_URL && { wsEndpoint: HELIUS_WSS_URL }),
        confirmTransactionInitialTimeout: 60_000,
    });

    // Output stream
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const out = fs.createWriteStream(outPath, { flags: "a" });

    // Lightweight in-memory route stats (printed periodically)
    const routeStats = new Map<
        string,
        { count: number; likelyArb: number; netSolEqLamportsSum: bigint; tipSum: bigint; prioritySum: bigint }
    >();

    // Signature dedup with TTL
    const seen = new Map<string, number>();
    const SEEN_TTL_MS = 30 * 60_000;

    function markSeen(sig: string): boolean {
        const now = Date.now();
        const prev = seen.get(sig);
        if (prev && now - prev < SEEN_TTL_MS) return true;
        seen.set(sig, now);
        return false;
    }

    setInterval(() => {
        const now = Date.now();
        for (const [sig, t] of seen.entries()) {
            if (now - t > SEEN_TTL_MS) seen.delete(sig);
        }
    }, 60_000).unref();

    // Simple async queue
    const queue: string[] = [];
    let inFlight = 0;

    async function processSignature(signature: string): Promise<void> {
        // Retry getParsedTransaction a few times (logs can arrive before tx is available)
        let tx: ParsedTransactionWithMeta | null = null;
        for (let attempt = 0; attempt < 6; attempt++) {
            tx = await connection.getParsedTransaction(signature, {
                commitment,
                maxSupportedTransactionVersion: 0,
            });
            if (tx) break;
            await sleep(250 * (attempt + 1));
        }

        if (!tx) {
            // write a minimal record for traceability
            const rec = {
                collectedAt: nowIso(),
                signature,
                error: "transaction_not_found",
            };
            out.write(JSON.stringify(rec) + "\n");
            return;
        }

        const { feePayer, feePayerIndex } = feePayerFromTx(tx);

        const feeLamports = Number(tx.meta?.fee ?? 0);
        const computeUnitsConsumed = tx.meta?.computeUnitsConsumed;

        const { cuLimit, cuPriceMicroLamports } = extractComputeBudget(tx);
        const priorityFeeLamportsEst = estimatePriorityFeeLamports(computeUnitsConsumed, cuPriceMicroLamports);

        const jitoTipLamports = extractJitoTipsLamports(tx, tipAccounts);

        const programSet = invokedPrograms(tx);
        const { ids: invokedDexPrograms, tags: invokedDexTags } = dexProgramsInvoked(programSet);
        const dexInstructionCount = countDexInstructions(tx);

        // Token + SOL deltas
        const tokenChanges = computeTokenChanges(tx);
        const solChanges = computeSolChanges(tx);

        // Fee payer deltas
        const preLamports = BigInt(tx.meta?.preBalances?.[feePayerIndex] ?? 0);
        const postLamports = BigInt(tx.meta?.postBalances?.[feePayerIndex] ?? 0);
        const feePayerNativeDeltaLamports = postLamports - preLamports;

        // Sum fee payer WSOL delta (treat as lamports-equivalent)
        let feePayerWsolDeltaLamports = 0n;
        let feePayerNetUsdcRaw = 0n;
        let feePayerNetUsdtRaw = 0n;

        for (const ch of tokenChanges) {
            if (!ch.owner || ch.owner !== feePayer) continue;

            const delta = BigInt(ch.change);
            if (ch.mint === WSOL_MINT) {
                // WSOL raw units == lamports
                feePayerWsolDeltaLamports += delta;
            } else if (ch.mint === USDC_MINT) {
                feePayerNetUsdcRaw += delta;
            } else if (ch.mint === USDT_MINT) {
                feePayerNetUsdtRaw += delta;
            }
        }

        const feePayerNetSolEquivalentLamports = feePayerNativeDeltaLamports + feePayerWsolDeltaLamports;

        // Flags
        const isMultiDex = invokedDexPrograms.length >= 2;
        const isLikelyArb = isLikelyArbHeuristic({
            dexInstructionCount,
            netSolEqLamports: feePayerNetSolEquivalentLamports,
            netUsdc: feePayerNetUsdcRaw,
            netUsdt: feePayerNetUsdtRaw,
            minProfitLamports,
            minProfitStableRaw,
        });

        // Enhanced Transactions parse (optional)
        let enhanced: any | undefined;
        if (enhancedMode !== "off" && heliusApiKey) {
            const should = enhancedMode === "all" || (enhancedMode === "candidate" && isLikelyArb);
            if (should) {
                try {
                    enhanced = await fetchEnhancedTx(signature, heliusApiKey, commitment);
                } catch (e) {
                    enhanced = { error: String((e as Error).message ?? e) };
                }
            }
        }

        // Deep snapshot (optional, and only when it matters)
        let accountStates: Record<string, AccountState> | undefined;
        let accountRoles: Record<string, string> | undefined;

        if (deepSnapshot && isLikelyArb) {
            try {
                const snap = await snapshotRelevantAccounts({ connection, tx, commitment });
                if (snap) {
                    accountStates = snap.accountStates;
                    accountRoles = snap.accountRoles;
                }
            } catch (e) {
                // Keep going; snapshot is best-effort
            }
        }

        const routeFingerprint = routeFingerprintFromEnhanced(enhanced) ?? routeFingerprintFallback(invokedDexTags);

        const rec: ReconRecord = {
            collectedAt: nowIso(),

            signature,
            slot: tx.slot,
            blockTime: tx.blockTime ?? undefined,

            err: tx.meta?.err ?? null,

            feeLamports,
            computeUnitsConsumed: computeUnitsConsumed ?? undefined,
            cuLimit,
            cuPriceMicroLamports,
            priorityFeeLamportsEst: priorityFeeLamportsEst?.toString(),

            jitoTipLamports: jitoTipLamports > 0 ? jitoTipLamports : undefined,

            feePayer,
            invokedDexPrograms,
            invokedDexTags,
            dexInstructionCount,
            routeFingerprint,

            feePayerNativeDeltaLamports: feePayerNativeDeltaLamports.toString(),
            feePayerWsolDeltaLamports: feePayerWsolDeltaLamports.toString(),
            feePayerNetSolEquivalentLamports: feePayerNetSolEquivalentLamports.toString(),
            feePayerNetUsdcRaw: feePayerNetUsdcRaw.toString(),
            feePayerNetUsdtRaw: feePayerNetUsdtRaw.toString(),

            tokenChanges,
            solChanges,

            isMultiDex,
            isLikelyArb,

            enhanced,
            accountStates,
            accountRoles,
        };

        // Persist
        out.write(JSON.stringify(rec) + "\n");

        // Update routeStats
        const key = routeFingerprint;
        const stat = routeStats.get(key) ?? {
            count: 0,
            likelyArb: 0,
            netSolEqLamportsSum: 0n,
            tipSum: 0n,
            prioritySum: 0n,
        };

        stat.count += 1;
        if (isLikelyArb) stat.likelyArb += 1;

        stat.netSolEqLamportsSum += feePayerNetSolEquivalentLamports;
        stat.tipSum += BigInt(jitoTipLamports);
        stat.prioritySum += priorityFeeLamportsEst ?? 0n;

        routeStats.set(key, stat);
    }

    async function pumpQueue(): Promise<void> {
        while (queue.length > 0 && inFlight < maxConcurrency) {
            const sig = queue.shift()!;
            inFlight += 1;

            processSignature(sig)
                .catch(() => {
                    // swallow per-item errors
                })
                .finally(() => {
                    inFlight -= 1;
                });
        }
    }

    function enqueue(sig: string): void {
        if (markSeen(sig)) return;
        queue.push(sig);
        void pumpQueue();
    }

    // Subscriptions
    const subIds: number[] = [];

    function addProgramSub(programId: PublicKey, tag: string): void {
        const id = connection.onLogs(
            programId,
            (ev) => {
                // ev has: signature, err, logs
                if (!ev?.signature) return;
                enqueue(ev.signature);
            },
            commitment
        );
        subIds.push(id);
        // eslint-disable-next-line no-console
        console.log(`[arb_recon] subscribed to ${tag}: ${programId.toBase58()} (subId=${id})`);
    }

    addProgramSub(PROGRAMS.PUMPSWAP.programId, PROGRAMS.PUMPSWAP.name);
    addProgramSub(PROGRAMS.RAYDIUM_V4.programId, PROGRAMS.RAYDIUM_V4.name);
    addProgramSub(PROGRAMS.RAYDIUM_CLMM.programId, PROGRAMS.RAYDIUM_CLMM.name);
    addProgramSub(PROGRAMS.METEORA_DLMM.programId, PROGRAMS.METEORA_DLMM.name);

    // Periodic stats logging
    const statsInterval = setInterval(() => {
        // Print top routes by (likelyArb count, then netSolEqLamportsSum)
        const rows = [...routeStats.entries()].map(([route, s]) => ({ route, ...s }));

        rows.sort((a, b) => {
            if (b.likelyArb !== a.likelyArb) return b.likelyArb - a.likelyArb;
            // BigInt compare
            if (b.netSolEqLamportsSum > a.netSolEqLamportsSum) return 1;
            if (b.netSolEqLamportsSum < a.netSolEqLamportsSum) return -1;
            return 0;
        });

        // eslint-disable-next-line no-console
        console.log(`\n[arb_recon] ${nowIso()} queue=${queue.length} inFlight=${inFlight} routes=${rows.length} out=${outPath}`);

        for (const r of rows.slice(0, 8)) {
            const avgNet = r.count > 0 ? r.netSolEqLamportsSum / BigInt(r.count) : 0n;
            const avgTip = r.count > 0 ? r.tipSum / BigInt(r.count) : 0n;
            const avgPrio = r.count > 0 ? r.prioritySum / BigInt(r.count) : 0n;

            // eslint-disable-next-line no-console
            console.log(
                `  route=${r.route} count=${r.count} likelyArb=${r.likelyArb} avgNetSolEqLamports=${avgNet} avgTipLamports=${avgTip} avgPriorityLamports=${avgPrio}`
            );
        }
    }, 30_000);

    // Stop after runSeconds
    const stopAt = Date.now() + Math.max(1, runSeconds) * 1000;

    // eslint-disable-next-line no-console
    console.log(`[arb_recon] running for ~${runSeconds}s commitment=${commitment} enhancedMode=${enhancedMode} deepSnapshot=${deepSnapshot ? "on" : "off"}`);

    while (Date.now() < stopAt) {
        await sleep(500);
        await pumpQueue();
    }

    // Cleanup
    clearInterval(statsInterval);

    for (const id of subIds) {
        try {
            await connection.removeOnLogsListener(id);
        } catch {
            // ignore
        }
    }

    // Wait for inflight to drain (bounded)
    const drainStart = Date.now();
    while (inFlight > 0 && Date.now() - drainStart < 30_000) {
        await sleep(250);
    }

    out.end();

    // eslint-disable-next-line no-console
    console.log(`[arb_recon] done. wrote ${outPath}`);
}

main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(`[arb_recon] fatal:`, e);
    process.exit(1);
});
