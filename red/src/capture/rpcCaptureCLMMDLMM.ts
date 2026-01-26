// src/capture/rpcCaptureCLMMDLMM.ts
//
// RPC-based capture for Raydium CLMM and Meteora DLMM canonical test cases.
// Similar structure to rpcCapturePumpswapRaydiumV4.ts

import fs from "fs";
import path from "path";
import {
    Connection,
    PublicKey,
    type ConfirmedSignatureInfo,
    type SignaturesForAddressOptions,
} from "@solana/web3.js";

import type { CanonicalSwapCase } from "./canonicalTypes";

// Raydium CLMM
import {
    RAYDIUM_CLMM_PROGRAM_ID,
    isRaydiumClmmPoolAccount,
    decodeRaydiumClmmPool,
} from "../decoders/raydiumCLMMPool";
import {
    isRaydiumAmmConfigAccount,
} from "../decoders/raydiumAmmConfig";
import {
    isRaydiumTickArrayAccount,
    deriveRaydiumTickArrayPda,
    getTickArrayStartIndex,
    RAYDIUM_TICKS_PER_ARRAY,
} from "../decoders/raydiumTickArray";

// Meteora DLMM
import {
    METEORA_DLMM_PROGRAM_ID,
    isMeteoraLbPairAccount,
    decodeMeteoraLbPair,
    getMeteoraBinArrayWindow,
} from "../decoders/meteoraLbPair";
import { isMeteoraBinArrayAccount } from "../decoders/meteoraBinArray";

type CaptureConfig = {
    rpcUrl?: string;
    outFile?: string;

    raydiumCLMMPools?: string[];
    meteoraDLMMPairs?: string[];

    maxSignaturesPerPool?: number;
    maxCasesPerPool?: number;

    // CLMM: how many tick arrays on each side of current tick to include
    tickArrayRadius?: number;

    // DLMM: how many bin arrays on each side of activeId to include
    binArrayRadius?: number;

    includeLogs?: boolean;
};

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

async function withRetries<T>(fn: () => Promise<T>, label: string, retries = 6): Promise<T> {
    let lastErr: unknown = null;
    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (e) {
            lastErr = e;
            await sleep(250 * Math.pow(2, i));
        }
    }
    throw new Error(`RPC failed after retries (${label}): ${String((lastErr as any)?.message ?? lastErr)}`);
}

function ensureDirForFile(p: string) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
}

function readExistingSignaturesNdjson(outPath: string): Set<string> {
    const seen = new Set<string>();
    if (!fs.existsSync(outPath)) return seen;

    const data = fs.readFileSync(outPath, "utf8");
    for (const line of data.split("\n")) {
        const s = line.trim();
        if (!s) continue;
        try {
            const obj = JSON.parse(s);
            if (typeof obj?.signature === "string") seen.add(obj.signature);
        } catch {
            // ignore
        }
    }
    return seen;
}

function toRawAccountJson(
    pk: string,
    info: { owner: PublicKey; lamports: number; executable: boolean; rentEpoch: number; data: Buffer }
) {
    return {
        pubkey: pk,
        owner: info.owner.toBase58(),
        lamports: BigInt(info.lamports).toString(),
        executable: info.executable,
        rentEpoch: BigInt(info.rentEpoch ?? 0).toString(),
        dataBase64: Buffer.from(info.data).toString("base64"),
    };
}

function flattenAccountKeys(tx: any): string[] {
    const msgKeysRaw = tx?.transaction?.message?.accountKeys;
    let keys: string[] = [];

    if (Array.isArray(msgKeysRaw) && msgKeysRaw.length > 0) {
        const first = msgKeysRaw[0] as any;

        if (first && typeof first === "object" && typeof first.pubkey === "string") {
            keys = msgKeysRaw.map((k: any) => k.pubkey as string);
        } else if (first && typeof first.toBase58 === "function") {
            keys = msgKeysRaw.map((k: any) => (k as PublicKey).toBase58());
        } else if (typeof first === "string") {
            keys = msgKeysRaw.slice() as string[];
        }
    }

    const preBalances = tx?.meta?.preBalances;
    const preBalancesLen = Array.isArray(preBalances) ? preBalances.length : undefined;

    if (typeof preBalancesLen === "number" && keys.length < preBalancesLen) {
        const loaded = tx?.meta?.loadedAddresses;
        const writable: string[] = Array.isArray(loaded?.writable) ? loaded.writable : [];
        const readonly: string[] = Array.isArray(loaded?.readonly) ? loaded.readonly : [];
        keys = keys.concat(writable).concat(readonly);
    }

    return keys;
}

function txInvokesProgram(tx: any, accountKeys: string[], programId: string): boolean {
    const msgIx = tx?.transaction?.message?.instructions ?? [];
    for (const ix of msgIx) {
        const pIdx = ix?.programIdIndex as number | undefined;
        if (typeof pIdx !== "number") continue;
        const pid = accountKeys[pIdx];
        if (pid === programId) return true;
    }

    const inner = tx?.meta?.innerInstructions ?? [];
    for (const group of inner) {
        const ixs = group?.instructions ?? [];
        for (const ix of ixs) {
            const pIdx = ix?.programIdIndex as number | undefined;
            if (typeof pIdx !== "number") continue;
            const pid = accountKeys[pIdx];
            if (pid === programId) return true;
        }
    }

    return false;
}

function buildTokenBalanceMap(meta: any, accountKeys: string[]): Record<string, any> {
    const out: Record<string, any> = {};
    const pre = meta?.preTokenBalances ?? [];
    const post = meta?.postTokenBalances ?? [];

    const postByIndex = new Map<number, any>();
    for (const p of post) postByIndex.set(p.accountIndex, p);

    const seen = new Set<number>();

    for (const p of pre) {
        const idx: number = p.accountIndex;
        const pk = accountKeys[idx];
        if (typeof pk !== "string") continue;

        const postRec = postByIndex.get(idx);
        const preAmt = p.uiTokenAmount?.amount ?? "0";
        const postAmt = postRec?.uiTokenAmount?.amount ?? preAmt;

        out[pk] = {
            account: pk,
            mint: p.mint,
            decimals: p.uiTokenAmount?.decimals ?? 0,
            preAmount: preAmt,
            postAmount: postAmt,
            owner: p.owner,
            programId: p.programId,
        };

        seen.add(idx);
    }

    for (const p of post) {
        const idx: number = p.accountIndex;
        if (seen.has(idx)) continue;
        const pk = accountKeys[idx];
        if (typeof pk !== "string") continue;

        const amt = p.uiTokenAmount?.amount ?? "0";
        out[pk] = {
            account: pk,
            mint: p.mint,
            decimals: p.uiTokenAmount?.decimals ?? 0,
            preAmount: amt,
            postAmount: amt,
            owner: p.owner,
            programId: p.programId,
        };
    }

    return out;
}

function buildLamportBalanceMap(meta: any, accountKeys: string[]): Record<string, any> {
    const out: Record<string, any> = {};
    const pre: number[] = Array.isArray(meta?.preBalances) ? meta.preBalances : [];
    const post: number[] = Array.isArray(meta?.postBalances) ? meta.postBalances : [];

    const n = Math.min(accountKeys.length, pre.length, post.length);

    for (let i = 0; i < n; i++) {
        const pk = accountKeys[i];
        const preBal = pre[i];
        const postBal = post[i];

        if (typeof pk !== "string") continue;
        if (typeof preBal !== "number") continue;
        if (typeof postBal !== "number") continue;

        out[pk] = {
            account: pk,
            preLamports: BigInt(preBal).toString(),
            postLamports: BigInt(postBal).toString(),
        };
    }

    return out;
}

function tokenDelta(tokenBalances: Record<string, any>, acct: string): bigint | null {
    const tb = tokenBalances[acct];
    if (!tb) return null;
    return BigInt(tb.postAmount) - BigInt(tb.preAmount);
}

async function fetchSignaturesForAddress(
    connection: Connection,
    address: PublicKey,
    max: number
): Promise<ConfirmedSignatureInfo[]> {
    const out: ConfirmedSignatureInfo[] = [];
    let before: string | undefined = undefined;

    while (out.length < max) {
        const limit = Math.min(1000, max - out.length);

        const opts: SignaturesForAddressOptions = { limit };
        if (typeof before === "string") opts.before = before;

        const batch = await withRetries(
            () => connection.getSignaturesForAddress(address, opts, "confirmed"),
            `getSignaturesForAddress(${address.toBase58()})`
        );

        if (batch.length === 0) break;

        out.push(...batch);
        const last = batch[batch.length - 1];
        before = last?.signature;
        if (typeof before !== "string") break;
    }

    return out;
}

async function main() {
    const cfgPath = process.argv[2];
    const outPathArg = process.argv[3];

    if (!cfgPath) {
        console.error(
            "Usage: pnpm exec ts-node src/capture/rpcCaptureCLMMDLMM.ts <capture.config.json> [out.ndjson]"
        );
        process.exit(1);
    }

    const cfg: CaptureConfig = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

    const rpcUrl = cfg.rpcUrl || process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL;
    if (!rpcUrl) {
        throw new Error("Missing rpcUrl in config or env HELIUS_RPC_URL / SOLANA_RPC_URL");
    }

    const outPath = outPathArg || cfg.outFile || "./data/canonical_cases.ndjson";
    ensureDirForFile(outPath);

    const maxSigsPerPool = cfg.maxSignaturesPerPool ?? 250;
    const maxCasesPerPool = cfg.maxCasesPerPool ?? 25;
    const tickArrayRadius = cfg.tickArrayRadius ?? 3;
    const binArrayRadius = cfg.binArrayRadius ?? 3;
    const includeLogs = cfg.includeLogs ?? false;

    const connection = new Connection(rpcUrl, { commitment: "confirmed" });

    const already = readExistingSignaturesNdjson(outPath);
    const out = fs.createWriteStream(outPath, { flags: "a" });

    let totalWritten = 0;

    // --------------------
    // Raydium CLMM pools
    // --------------------
    for (const poolStr of cfg.raydiumCLMMPools ?? []) {
        const poolPk = new PublicKey(poolStr);

        const poolInfo = await withRetries(
            () => connection.getAccountInfo(poolPk, "confirmed"),
            `getAccountInfo(clmmPool=${poolStr})`
        );
        if (!poolInfo) {
            console.log(`[capture] CLMM pool=${poolStr} not found`);
            continue;
        }

        if (!isRaydiumClmmPoolAccount(Buffer.from(poolInfo.data))) {
            console.log(`[capture] CLMM pool=${poolStr} invalid discriminator`);
            continue;
        }

        let pool: ReturnType<typeof decodeRaydiumClmmPool>;
        try {
            pool = decodeRaydiumClmmPool(Buffer.from(poolInfo.data), poolPk);
        } catch (e) {
            console.log(`[capture] CLMM pool=${poolStr} decode error: ${e}`);
            continue;
        }

        const vault0 = pool.tokenVault0;
        const vault1 = pool.tokenVault1;

        const sigs0 = await fetchSignaturesForAddress(connection, vault0, maxSigsPerPool);
        const sigs1 = await fetchSignaturesForAddress(connection, vault1, maxSigsPerPool);

        const set0 = new Set(sigs0.map((x) => x.signature));
        const candidates = sigs1.map((x) => x.signature).filter((sig) => set0.has(sig));

        let casesWritten = 0;

        for (const sig of candidates) {
            if (casesWritten >= maxCasesPerPool) break;
            if (already.has(sig)) continue;

            const tx = await withRetries(
                () =>
                    connection.getTransaction(sig, {
                        commitment: "confirmed",
                        maxSupportedTransactionVersion: 0,
                    }),
                `getTransaction(${sig})`
            );
            if (!tx) continue;
            if (tx.meta?.err) continue;

            const accountKeys = flattenAccountKeys(tx);
            if (accountKeys.length === 0) continue;

            if (!txInvokesProgram(tx, accountKeys, RAYDIUM_CLMM_PROGRAM_ID.toBase58())) continue;

            const tokenBalances = buildTokenBalanceMap(tx.meta, accountKeys);
            const lamportBalances = buildLamportBalanceMap(tx.meta, accountKeys);

            const vault0Str = vault0.toBase58();
            const vault1Str = vault1.toBase58();

            if (!tokenBalances[vault0Str] || !tokenBalances[vault1Str]) continue;

            const d0 = tokenDelta(tokenBalances, vault0Str);
            const d1 = tokenDelta(tokenBalances, vault1Str);
            if (d0 === null || d1 === null) continue;

            if (!((d0 > 0n && d1 < 0n) || (d1 > 0n && d0 < 0n))) continue;

            // Fetch required accounts: pool, ammConfig, tick arrays
            const ammConfigPk = pool.ammConfig.toBase58();

            // Derive tick array PDAs around current tick
            const tickSpacing = pool.tickSpacing;
            const currentTick = pool.tickCurrent;
            const tickArrayPdas: PublicKey[] = [];

            for (let offset = -tickArrayRadius; offset <= tickArrayRadius; offset++) {
                const startIdx = getTickArrayStartIndex(currentTick, tickSpacing) +
                    offset * tickSpacing * RAYDIUM_TICKS_PER_ARRAY;
                tickArrayPdas.push(deriveRaydiumTickArrayPda(poolPk, startIdx));
            }

            const required: string[] = [poolStr, vault0Str, vault1Str, ammConfigPk];
            for (const taPda of tickArrayPdas) {
                required.push(taPda.toBase58());
            }

            const infos = await withRetries(
                () => connection.getMultipleAccountsInfo(required.map((s) => new PublicKey(s)), "confirmed"),
                `getMultipleAccountsInfo(clmmRequired=${sig})`
            );

            const preAccounts: Record<string, any> = {};
            let ok = true;
            let hasAmmConfig = false;
            let hasTickArrays = false;

            for (let i = 0; i < required.length; i++) {
                const pk = required[i];
                const info = infos[i];
                if (typeof pk !== "string") {
                    ok = false;
                    break;
                }

                // Pool, vault0, vault1 must exist
                if (i < 3 && !info) {
                    ok = false;
                    break;
                }

                // ammConfig must exist and be valid
                if (i === 3) {
                    if (!info) {
                        ok = false;
                        break;
                    }
                    if (!isRaydiumAmmConfigAccount(Buffer.from(info.data))) {
                        console.log(`[capture] CLMM sig=${sig.slice(0,16)} ammConfig invalid`);
                        ok = false;
                        break;
                    }
                    hasAmmConfig = true;
                }

                // Tick arrays are optional (some may not exist)
                if (i > 3 && info) {
                    if (isRaydiumTickArrayAccount(Buffer.from(info.data))) {
                        hasTickArrays = true;
                    }
                }

                if (info) {
                    preAccounts[pk] = toRawAccountJson(pk, {
                        owner: info.owner,
                        lamports: info.lamports,
                        executable: info.executable,
                        rentEpoch: info.rentEpoch ?? 0,
                        data: Buffer.from(info.data),
                    });
                }
            }

            if (!ok || !hasAmmConfig) continue;

            // Need at least one tick array
            if (!hasTickArrays) {
                console.log(`[capture] CLMM sig=${sig.slice(0,16)} no tick arrays found`);
                continue;
            }

            const txObj: CanonicalSwapCase["tx"] = { accountKeys, err: null };
            if (includeLogs && Array.isArray(tx.meta?.logMessages)) txObj.logMessages = tx.meta.logMessages;

            const c: CanonicalSwapCase = {
                signature: sig,
                slot: tx.slot,
                venue: "raydium_clmm",
                programId: RAYDIUM_CLMM_PROGRAM_ID.toBase58(),
                preAccounts,
                tokenBalances,
                lamportBalances,
                tx: txObj,
            };

            if (typeof tx.blockTime === "number") c.blockTime = tx.blockTime;

            out.write(JSON.stringify(c) + "\n");
            already.add(sig);
            casesWritten++;
            totalWritten++;
        }

        console.log(`[capture] CLMM pool=${poolStr} wrote=${casesWritten}`);
    }

    // --------------------
    // Meteora DLMM pairs
    // --------------------
    for (const pairStr of cfg.meteoraDLMMPairs ?? []) {
        const pairPk = new PublicKey(pairStr);

        const pairInfo = await withRetries(
            () => connection.getAccountInfo(pairPk, "confirmed"),
            `getAccountInfo(dlmmPair=${pairStr})`
        );
        if (!pairInfo) {
            console.log(`[capture] DLMM pair=${pairStr} not found`);
            continue;
        }

        if (!isMeteoraLbPairAccount(Buffer.from(pairInfo.data))) {
            console.log(`[capture] DLMM pair=${pairStr} invalid discriminator`);
            continue;
        }

        let lbPair: ReturnType<typeof decodeMeteoraLbPair>;
        try {
            lbPair = decodeMeteoraLbPair(Buffer.from(pairInfo.data), pairPk);
        } catch (e) {
            console.log(`[capture] DLMM pair=${pairStr} decode error: ${e}`);
            continue;
        }

        const reserveX = lbPair.reserveX;
        const reserveY = lbPair.reserveY;

        const sigsX = await fetchSignaturesForAddress(connection, reserveX, maxSigsPerPool);
        const sigsY = await fetchSignaturesForAddress(connection, reserveY, maxSigsPerPool);

        const setX = new Set(sigsX.map((x) => x.signature));
        const candidates = sigsY.map((x) => x.signature).filter((sig) => setX.has(sig));

        let casesWritten = 0;

        for (const sig of candidates) {
            if (casesWritten >= maxCasesPerPool) break;
            if (already.has(sig)) continue;

            const tx = await withRetries(
                () =>
                    connection.getTransaction(sig, {
                        commitment: "confirmed",
                        maxSupportedTransactionVersion: 0,
                    }),
                `getTransaction(${sig})`
            );
            if (!tx) continue;
            if (tx.meta?.err) continue;

            const accountKeys = flattenAccountKeys(tx);
            if (accountKeys.length === 0) continue;

            if (!txInvokesProgram(tx, accountKeys, METEORA_DLMM_PROGRAM_ID.toBase58())) continue;

            const tokenBalances = buildTokenBalanceMap(tx.meta, accountKeys);
            const lamportBalances = buildLamportBalanceMap(tx.meta, accountKeys);

            const reserveXStr = reserveX.toBase58();
            const reserveYStr = reserveY.toBase58();

            if (!tokenBalances[reserveXStr] || !tokenBalances[reserveYStr]) continue;

            const dX = tokenDelta(tokenBalances, reserveXStr);
            const dY = tokenDelta(tokenBalances, reserveYStr);
            if (dX === null || dY === null) continue;

            if (!((dX > 0n && dY < 0n) || (dY > 0n && dX < 0n))) continue;

            // Derive bin array PDAs around activeId
            const binArrayPdas = getMeteoraBinArrayWindow(pairPk, lbPair.activeId, binArrayRadius);

            const required: string[] = [pairStr, reserveXStr, reserveYStr];
            for (const baPda of binArrayPdas) {
                required.push(baPda.toBase58());
            }

            const infos = await withRetries(
                () => connection.getMultipleAccountsInfo(required.map((s) => new PublicKey(s)), "confirmed"),
                `getMultipleAccountsInfo(dlmmRequired=${sig})`
            );

            const preAccounts: Record<string, any> = {};
            let ok = true;
            let hasBinArrays = false;

            for (let i = 0; i < required.length; i++) {
                const pk = required[i];
                const info = infos[i];
                if (typeof pk !== "string") {
                    ok = false;
                    break;
                }

                // Pair, reserveX, reserveY must exist
                if (i < 3 && !info) {
                    ok = false;
                    break;
                }

                // Bin arrays are optional (some may not exist)
                if (i >= 3 && info) {
                    if (isMeteoraBinArrayAccount(Buffer.from(info.data))) {
                        hasBinArrays = true;
                    }
                }

                if (info) {
                    preAccounts[pk] = toRawAccountJson(pk, {
                        owner: info.owner,
                        lamports: info.lamports,
                        executable: info.executable,
                        rentEpoch: info.rentEpoch ?? 0,
                        data: Buffer.from(info.data),
                    });
                }
            }

            if (!ok) continue;

            // Need at least one bin array
            if (!hasBinArrays) {
                console.log(`[capture] DLMM sig=${sig.slice(0,16)} no bin arrays found`);
                continue;
            }

            const txObj: CanonicalSwapCase["tx"] = { accountKeys, err: null };
            if (includeLogs && Array.isArray(tx.meta?.logMessages)) txObj.logMessages = tx.meta.logMessages;

            const c: CanonicalSwapCase = {
                signature: sig,
                slot: tx.slot,
                venue: "meteora_dlmm",
                programId: METEORA_DLMM_PROGRAM_ID.toBase58(),
                preAccounts,
                tokenBalances,
                lamportBalances,
                tx: txObj,
            };

            if (typeof tx.blockTime === "number") c.blockTime = tx.blockTime;

            out.write(JSON.stringify(c) + "\n");
            already.add(sig);
            casesWritten++;
            totalWritten++;
        }

        console.log(`[capture] DLMM pair=${pairStr} wrote=${casesWritten}`);
    }

    out.end();
    console.log(`[capture] done. wrote=${totalWritten} output=${outPath}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
