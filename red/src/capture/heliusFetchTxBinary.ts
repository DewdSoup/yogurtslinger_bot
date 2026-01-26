// src/capture/heliusFetchTxBinary.ts
//
// Fetch full transaction payloads (including raw binary) for a set of signatures via a JSON-RPC
// endpoint (Helius or any Solana RPC).
//
// This is intended for offline debugging of on-chain parity issues:
// - obtain raw versioned transaction bytes (base64)
// - capture meta.logMessages, innerInstructions, pre/post token balances
// - optionally emit a convenience-decoded view of outer instructions
//
// Usage:
//   pnpm exec ts-node src/capture/heliusFetchTxBinary.ts ./txdump.config.json
//
// Config:
// {
//   "rpcUrl": "https://mainnet.helius-rpc.com/?api-key=...",
//   "outFile": "./debug/txdump.ndjson",
//   "signatures": ["...", "..."],
//   "signaturesFile": "./debug/sigs.txt",
//   "includeJsonParsed": true
// }

import fs from "fs";
import path from "path";

import { PublicKey, VersionedTransaction } from "@solana/web3.js";

type TxDumpConfig = {
    rpcUrl: string;
    outFile: string;
    signatures?: string[];
    signaturesFile?: string;
    includeJsonParsed?: boolean;
    maxSupportedTransactionVersion?: number;
};

type JsonRpcResponse<T> = {
    jsonrpc: "2.0";
    id: number;
    result?: T;
    error?: { code: number; message: string; data?: unknown };
};

async function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[], label: string): Promise<T> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 7; attempt++) {
        try {
            const res = await fetch(rpcUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
            });
            const txt = await res.text();
            if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${txt}`);
            const parsed = JSON.parse(txt) as JsonRpcResponse<T>;
            if (parsed.error) {
                throw new Error(`RPC error ${parsed.error.code}: ${parsed.error.message}`);
            }
            if (parsed.result === undefined) throw new Error("RPC result missing");
            return parsed.result;
        } catch (e) {
            lastErr = e;
            // Exponential backoff with jitter-ish component.
            const delay = Math.min(10_000, 250 * Math.pow(2, attempt));
            await sleep(delay);
        }
    }
    throw new Error(`RPC failed (${label}): ${String((lastErr as any)?.message ?? lastErr)}`);
}

function readSignatures(cfg: TxDumpConfig): string[] {
    const sigs: string[] = [];
    if (cfg.signatures && cfg.signatures.length > 0) sigs.push(...cfg.signatures);

    if (cfg.signaturesFile) {
        const raw = fs.readFileSync(cfg.signaturesFile, "utf8");
        for (const line of raw.split(/\r?\n/)) {
            const s = line.trim();
            if (s.length > 0) sigs.push(s);
        }
    }

    // De-duplicate while preserving order.
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of sigs) {
        if (!seen.has(s)) {
            seen.add(s);
            out.push(s);
        }
    }
    return out;
}

function ensureParentDir(filePath: string): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
}

function decodeOuterInstructions(txBase64: string, loadedAddresses?: { writable: string[]; readonly: string[] }): {
    accountKeys: string[];
    instructions: Array<{
        programId: string;
        accounts: string[];
        dataBase64: string;
    }>;
} {
    const raw = Buffer.from(txBase64, "base64");
    const tx = VersionedTransaction.deserialize(raw);

    // Account key ordering for v0 messages is:
    //   staticAccountKeys + loadedAddresses.writable + loadedAddresses.readonly
    // Legacy messages embed the full accountKeys array directly.
    const msg: any = tx.message as any;
    let accountKeys: string[];
    if (Array.isArray(msg.accountKeys)) {
        accountKeys = (msg.accountKeys as PublicKey[]).map((k) => k.toBase58());
    } else if (Array.isArray(msg.staticAccountKeys)) {
        const staticKeys = (msg.staticAccountKeys as PublicKey[]).map((k) => k.toBase58());
        const writable = loadedAddresses?.writable ?? [];
        const readonly = loadedAddresses?.readonly ?? [];
        accountKeys = staticKeys.concat(writable, readonly);
    } else {
        // Extremely defensive; should not happen for supported transaction versions.
        accountKeys = [];
    }

    const compiled = (tx.message as any).compiledInstructions as Array<{
        programIdIndex: number;
        accountKeyIndexes: number[];
        data: Uint8Array;
    }>;

    const instructions = compiled.map((ix) => {
        const programId = accountKeys[ix.programIdIndex] ?? "";
        const accounts = ix.accountKeyIndexes.map((i) => accountKeys[i] ?? "");
        const dataBase64 = Buffer.from(ix.data).toString("base64");
        return { programId, accounts, dataBase64 };
    });

    return { accountKeys, instructions };
}

async function main(): Promise<void> {
    const configPath = process.argv[2];
    if (!configPath) {
        console.error("usage: pnpm exec ts-node src/capture/heliusFetchTxBinary.ts ./txdump.config.json");
        process.exit(1);
    }

    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8")) as TxDumpConfig;
    if (!cfg.rpcUrl || !cfg.outFile) {
        throw new Error("txdump.config.json must include rpcUrl and outFile");
    }

    const sigs = readSignatures(cfg);
    if (sigs.length === 0) throw new Error("no signatures provided (signatures or signaturesFile)");

    ensureParentDir(cfg.outFile);
    const out = fs.createWriteStream(cfg.outFile, { flags: "w" });

    const maxVer = cfg.maxSupportedTransactionVersion ?? 0;
    const includeJsonParsed = cfg.includeJsonParsed ?? true;

    let ok = 0;
    let miss = 0;
    let i = 0;
    for (const sig of sigs) {
        i++;

        // 1) Raw/base64 tx (binary)
        const base64Res = await rpcCall<any>(
            cfg.rpcUrl,
            "getTransaction",
            [sig, { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: maxVer }],
            `getTransaction(base64) ${sig}`
        );

        if (!base64Res) {
            miss++;
            out.write(JSON.stringify({ sig, missing: true }) + "\n");
            continue;
        }

        const txField = base64Res.transaction;
        const txBase64 = Array.isArray(txField) && typeof txField[0] === "string" ? (txField[0] as string) : null;
        if (!txBase64) {
            miss++;
            out.write(JSON.stringify({ sig, missing: true, reason: "transaction field not base64" }) + "\n");
            continue;
        }

        const decoded = decodeOuterInstructions(txBase64, base64Res.meta?.loadedAddresses);

        // 2) Optional jsonParsed tx for human-readable inner instructions and token transfers.
        let jsonParsedRes: any | undefined = undefined;
        if (includeJsonParsed) {
            jsonParsedRes = await rpcCall<any>(
                cfg.rpcUrl,
                "getTransaction",
                [sig, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: maxVer }],
                `getTransaction(jsonParsed) ${sig}`
            );
        }

        const record = {
            sig,
            index: i,
            slot: base64Res.slot,
            blockTime: base64Res.blockTime ?? null,
            err: base64Res.meta?.err ?? null,
            txBase64,
            meta: base64Res.meta ?? null,
            decodedOuter: decoded,
            jsonParsed: jsonParsedRes ?? null,
        };

        out.write(JSON.stringify(record) + "\n");
        ok++;

        if (i % 25 === 0) {
            // Keep the console output minimal.
            console.log(`Fetched ${ok}/${i} (missing ${miss})`);
        }
    }

    out.end();
    console.log(`Done. ok=${ok} missing=${miss} outFile=${cfg.outFile}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
