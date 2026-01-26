import fs from "fs";
import path from "path";
import {
    Connection,
    PublicKey,
    type ConfirmedSignatureInfo,
    type SignaturesForAddressOptions,
} from "@solana/web3.js";

import type { CanonicalSwapCase } from "./canonicalTypes";

import { PUMPSWAP_PROGRAM_ID, decodePumpSwapPool } from "../decoders/pumpswapPool";
import { isPumpSwapGlobalConfigAccount } from "../decoders/pumpswapGlobalConfig";

import {
    PUMP_FEES_PROGRAM_ID,
    deriveFeeConfigPda,
    isFeeConfigAccount,
} from "../decoders/pumpFeesFeeConfig";

import { RAYDIUM_V4_PROGRAM, V4_POOL_SIZE, decodeRaydiumV4Pool } from "../decoders/raydiumV4Pool";
import { isOpenOrdersAccount, decodeRaydiumV4OpenOrders } from "../decoders/raydiumV4OpenOrders";

type CaptureConfig = {
    rpcUrl?: string;

    // Optional but supported (your config has it)
    outFile?: string;

    pumpswapPools: string[];
    raydiumV4Pools: string[];

    // Support both names (your config uses maxSignaturesPerPool)
    maxSignaturesPerVault?: number;
    maxSignaturesPerPool?: number;

    maxCasesPerPool?: number;

    requireOpenOrdersTotalsZero?: boolean;
    requireNeedTakePnlZero?: boolean;

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

/**
 * CRITICAL: accountIndex mapping must match Solana runtime ordering.
 *
 * For v0 txs, the effective account keys are:
 *   message.accountKeys (static) + meta.loadedAddresses.writable + meta.loadedAddresses.readonly
 *
 * Some RPCs already return an expanded accountKeys list (often with `source: "lookupTable"` entries).
 * We detect that by comparing to meta.preBalances length (which always matches effective keys).
 */
function flattenAccountKeys(tx: any): string[] {
    const msgKeysRaw = tx?.transaction?.message?.accountKeys;
    let keys: string[] = [];

    if (Array.isArray(msgKeysRaw) && msgKeysRaw.length > 0) {
        const first = msgKeysRaw[0] as any;

        // jsonParsed expanded shape: [{ pubkey, signer, writable, source? }, ...]
        if (first && typeof first === "object" && typeof first.pubkey === "string") {
            keys = msgKeysRaw.map((k: any) => k.pubkey as string);
        }
        // web3.js PublicKey[]
        else if (first && typeof first.toBase58 === "function") {
            keys = msgKeysRaw.map((k: any) => (k as PublicKey).toBase58());
        }
        // string[]
        else if (typeof first === "string") {
            keys = msgKeysRaw.slice() as string[];
        }
    }

    const preBalances = tx?.meta?.preBalances;
    const preBalancesLen = Array.isArray(preBalances) ? preBalances.length : undefined;

    // If preBalances is longer, append loaded addresses in exact runtime order.
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

function collectProgramTouchedAccounts(tx: any, accountKeys: string[], programId: string): string[] {
    const out = new Set<string>();

    const addAccounts = (ix: any) => {
        const pIdx = ix?.programIdIndex as number | undefined;
        if (typeof pIdx !== "number") return;
        const pid = accountKeys[pIdx];
        if (pid !== programId) return;

        const accIdxs: number[] = Array.isArray(ix?.accounts) ? (ix.accounts as number[]) : [];
        for (const ai of accIdxs) {
            const pk = accountKeys[ai];
            if (typeof pk === "string") out.add(pk);
        }
    };

    const msgIx = tx?.transaction?.message?.instructions ?? [];
    for (const ix of msgIx) addAccounts(ix);

    const inner = tx?.meta?.innerInstructions ?? [];
    for (const group of inner) {
        const ixs = group?.instructions ?? [];
        for (const ix of ixs) addAccounts(ix);
    }

    return [...out];
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
            "Usage: pnpm exec ts-node src/capture/rpcCapturePumpswapRaydiumV4.ts <capture.config.json> [out.ndjson]"
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

    const maxSigsPerVault = cfg.maxSignaturesPerVault ?? cfg.maxSignaturesPerPool ?? 250;
    const maxCasesPerPool = cfg.maxCasesPerPool ?? 50;

    const requireOOZero = cfg.requireOpenOrdersTotalsZero ?? true;
    const requirePnlZero = cfg.requireNeedTakePnlZero ?? true;
    const includeLogs = cfg.includeLogs ?? false;

    const connection = new Connection(rpcUrl, { commitment: "confirmed" });

    const already = readExistingSignaturesNdjson(outPath);
    const out = fs.createWriteStream(outPath, { flags: "a" });

    let totalWritten = 0;

    // --------------------
    // PumpSwap pools
    // --------------------
    for (const poolStr of cfg.pumpswapPools ?? []) {
        const poolPk = new PublicKey(poolStr);

        const poolInfo = await withRetries(
            () => connection.getAccountInfo(poolPk, "confirmed"),
            `getAccountInfo(pumpswapPool=${poolStr})`
        );
        if (!poolInfo) continue;

        let poolState: ReturnType<typeof decodePumpSwapPool>;
        try {
            poolState = decodePumpSwapPool(Buffer.from(poolInfo.data), poolPk);
        } catch {
            continue;
        }

        const baseVault = poolState.poolBaseTokenAccount;
        const quoteVault = poolState.poolQuoteTokenAccount;

        const sigsBase = await fetchSignaturesForAddress(connection, baseVault, maxSigsPerVault);
        const sigsQuote = await fetchSignaturesForAddress(connection, quoteVault, maxSigsPerVault);

        const setBase = new Set(sigsBase.map((x) => x.signature));
        const candidates = sigsQuote.map((x) => x.signature).filter((sig) => setBase.has(sig));

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

            if (!txInvokesProgram(tx, accountKeys, PUMPSWAP_PROGRAM_ID.toBase58())) continue;

            const tokenBalances = buildTokenBalanceMap(tx.meta, accountKeys);
            const lamportBalances = buildLamportBalanceMap(tx.meta, accountKeys);

            const baseVaultStr = baseVault.toBase58();
            const quoteVaultStr = quoteVault.toBase58();

            if (!tokenBalances[baseVaultStr] || !tokenBalances[quoteVaultStr]) continue;

            const dBase = tokenDelta(tokenBalances, baseVaultStr);
            const dQuote = tokenDelta(tokenBalances, quoteVaultStr);
            if (dBase === null || dQuote === null) continue;

            if (!((dBase > 0n && dQuote < 0n) || (dQuote > 0n && dBase < 0n))) continue;

            const touched = collectProgramTouchedAccounts(tx, accountKeys, PUMPSWAP_PROGRAM_ID.toBase58());
            if (touched.length === 0) continue;

            const touchedSlice = touched.slice(0, 128);
            const touchedInfos = await withRetries(
                () => connection.getMultipleAccountsInfo(touchedSlice.map((s) => new PublicKey(s)), "confirmed"),
                `getMultipleAccountsInfo(pumpswapTouched=${sig})`
            );

            let globalConfigPk: string | null = null;
            for (let i = 0; i < touchedSlice.length; i++) {
                const pk = touchedSlice[i];
                const info = touchedInfos[i];
                if (typeof pk !== "string") continue;
                if (!info) continue;
                if (info.owner.toBase58() !== PUMPSWAP_PROGRAM_ID.toBase58()) continue;
                const data = Buffer.from(info.data);
                if (isPumpSwapGlobalConfigAccount(data)) {
                    globalConfigPk = pk;
                    break;
                }
            }
            if (!globalConfigPk) continue;

            const feeConfigPda = deriveFeeConfigPda(PUMPSWAP_PROGRAM_ID);
            const feeCfgInfo = await withRetries(
                () => connection.getAccountInfo(feeConfigPda, "confirmed"),
                `getAccountInfo(feeConfigPda=${feeConfigPda.toBase58()})`
            );

            const required: string[] = [poolPk.toBase58(), baseVaultStr, quoteVaultStr, globalConfigPk];

            if (feeCfgInfo && feeCfgInfo.owner.toBase58() === PUMP_FEES_PROGRAM_ID.toBase58()) {
                const b = Buffer.from(feeCfgInfo.data);
                if (isFeeConfigAccount(b)) required.push(feeConfigPda.toBase58());
            }

            const infos = await withRetries(
                () => connection.getMultipleAccountsInfo(required.map((s) => new PublicKey(s)), "confirmed"),
                `getMultipleAccountsInfo(pumpswapRequired=${sig})`
            );

            const preAccounts: Record<string, any> = {};
            let ok = true;
            for (let i = 0; i < required.length; i++) {
                const pk = required[i];
                const info = infos[i];
                if (typeof pk !== "string" || !info) {
                    ok = false;
                    break;
                }
                preAccounts[pk] = toRawAccountJson(pk, {
                    owner: info.owner,
                    lamports: info.lamports,
                    executable: info.executable,
                    rentEpoch: info.rentEpoch ?? 0,
                    data: Buffer.from(info.data),
                });
            }
            if (!ok) continue;

            const txObj: CanonicalSwapCase["tx"] = { accountKeys, err: null };
            if (includeLogs && Array.isArray(tx.meta?.logMessages)) txObj.logMessages = tx.meta.logMessages;

            const c: CanonicalSwapCase = {
                signature: sig,
                slot: tx.slot,
                venue: "pumpswap",
                programId: PUMPSWAP_PROGRAM_ID.toBase58(),
                preAccounts,
                tokenBalances,
                lamportBalances,
                tx: txObj,
            };

            // FIX: exactOptionalPropertyTypes -> only set if present
            if (typeof tx.blockTime === "number") c.blockTime = tx.blockTime;

            out.write(JSON.stringify(c) + "\n");
            already.add(sig);
            casesWritten++;
            totalWritten++;
        }

        console.log(`[capture] PumpSwap pool=${poolStr} wrote=${casesWritten}`);
    }

    // --------------------
    // Raydium V4 pools
    // --------------------
    for (const poolStr of cfg.raydiumV4Pools ?? []) {
        const poolPk = new PublicKey(poolStr);

        const poolInfo = await withRetries(
            () => connection.getAccountInfo(poolPk, "confirmed"),
            `getAccountInfo(raydiumV4Pool=${poolStr})`
        );
        if (!poolInfo) continue;

        if (poolInfo.owner.toBase58() !== RAYDIUM_V4_PROGRAM.toBase58()) continue;
        if (poolInfo.data.length !== V4_POOL_SIZE) continue;

        let pool: ReturnType<typeof decodeRaydiumV4Pool>;
        try {
            pool = decodeRaydiumV4Pool(Buffer.from(poolInfo.data), poolPk);
        } catch {
            continue;
        }

        if (requirePnlZero) {
            if (pool.baseNeedTakePnl !== 0n || pool.quoteNeedTakePnl !== 0n) {
                console.log(`[capture] RaydiumV4 pool=${poolStr} skipped (needTakePnl != 0)`);
                continue;
            }
        }

        const baseVault = pool.baseVault;
        const quoteVault = pool.quoteVault;
        const openOrdersPk = pool.openOrders;

        let includeOpenOrders = false;
        if (requireOOZero) {
            const ooInfo = await withRetries(
                () => connection.getAccountInfo(openOrdersPk, "confirmed"),
                `getAccountInfo(openOrders=${openOrdersPk.toBase58()})`
            );

            if (!ooInfo || !isOpenOrdersAccount(Buffer.from(ooInfo.data))) {
                console.log(`[capture] RaydiumV4 pool=${poolStr} skipped (openOrders missing/invalid)`);
                continue;
            }

            const oo = decodeRaydiumV4OpenOrders(Buffer.from(ooInfo.data), openOrdersPk);
            if (oo.baseTokenTotal !== 0n || oo.quoteTokenTotal !== 0n) {
                console.log(`[capture] RaydiumV4 pool=${poolStr} skipped (openOrders totals != 0)`);
                continue;
            }

            includeOpenOrders = true;
        }

        const sigsBase = await fetchSignaturesForAddress(connection, baseVault, maxSigsPerVault);
        const sigsQuote = await fetchSignaturesForAddress(connection, quoteVault, maxSigsPerVault);

        const setBase = new Set(sigsBase.map((x) => x.signature));
        const candidates = sigsQuote.map((x) => x.signature).filter((sig) => setBase.has(sig));

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

            if (!txInvokesProgram(tx, accountKeys, RAYDIUM_V4_PROGRAM.toBase58())) continue;

            const tokenBalances = buildTokenBalanceMap(tx.meta, accountKeys);
            const lamportBalances = buildLamportBalanceMap(tx.meta, accountKeys);

            const baseVaultStr = baseVault.toBase58();
            const quoteVaultStr = quoteVault.toBase58();

            if (!tokenBalances[baseVaultStr] || !tokenBalances[quoteVaultStr]) continue;

            const dBase = tokenDelta(tokenBalances, baseVaultStr);
            const dQuote = tokenDelta(tokenBalances, quoteVaultStr);
            if (dBase === null || dQuote === null) continue;

            if (!((dBase > 0n && dQuote < 0n) || (dQuote > 0n && dBase < 0n))) continue;

            const required: string[] = [poolPk.toBase58(), baseVaultStr, quoteVaultStr];
            if (includeOpenOrders) required.push(openOrdersPk.toBase58());

            const infos = await withRetries(
                () => connection.getMultipleAccountsInfo(required.map((s) => new PublicKey(s)), "confirmed"),
                `getMultipleAccountsInfo(raydiumV4Required=${sig})`
            );

            const preAccounts: Record<string, any> = {};
            let ok = true;
            for (let i = 0; i < required.length; i++) {
                const pk = required[i];
                const info = infos[i];
                if (typeof pk !== "string" || !info) {
                    ok = false;
                    break;
                }
                preAccounts[pk] = toRawAccountJson(pk, {
                    owner: info.owner,
                    lamports: info.lamports,
                    executable: info.executable,
                    rentEpoch: info.rentEpoch ?? 0,
                    data: Buffer.from(info.data),
                });
            }
            if (!ok) continue;

            const txObj: CanonicalSwapCase["tx"] = { accountKeys, err: null };
            if (includeLogs && Array.isArray(tx.meta?.logMessages)) txObj.logMessages = tx.meta.logMessages;

            const c: CanonicalSwapCase = {
                signature: sig,
                slot: tx.slot,
                venue: "raydium_v4",
                programId: RAYDIUM_V4_PROGRAM.toBase58(),
                preAccounts,
                tokenBalances,
                lamportBalances,
                tx: txObj,
            };

            // FIX: exactOptionalPropertyTypes -> only set if present
            if (typeof tx.blockTime === "number") c.blockTime = tx.blockTime;

            out.write(JSON.stringify(c) + "\n");
            already.add(sig);
            casesWritten++;
            totalWritten++;
        }

        console.log(`[capture] RaydiumV4 pool=${poolStr} wrote=${casesWritten}`);
    }

    out.end();
    console.log(`[capture] done. wrote=${totalWritten} output=${outPath}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
